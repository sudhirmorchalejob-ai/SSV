/**
 * client.js
 * ─────────
 * HTTP connection to TallyPrime's XML server (default port 9000).
 *
 * Request handling follows Biz Analyst's connector:
 *   • Requests are sent as UTF-16LE with "text/xml;charset=utf-16", so company,
 *     item and party names in Hindi or other scripts survive the round trip.
 *   • Dates go as <SVFROMDATE TYPE="Date">01-Apr-2026</SVFROMDATE>.
 *   • Every request pings Tally first and is retried up to 5 times, waiting
 *     10 s, 20 s, 30 s, 40 s between attempts.
 *   • One request at a time (Tally has a single "active company").
 */

import axios from "axios";
import Agent from "agentkeepalive";
import { config } from "../config.js";
import { logger } from "../logger.js";
import {
  escapeXml, parseXml, collectionItems, masterName, val, list, tallyDateToISO, parseNumber, formatTallyDate, decodeTallyBody,
} from "./xml.js";

const http = axios.create({
  baseURL: config.tally.url,
  timeout: config.tally.timeoutMs,
  proxy: false, // Tally is local; never route it through a proxy
  httpAgent: new Agent({ maxSockets: 2, maxFreeSockets: 1, timeout: config.tally.timeoutMs, freeSocketTimeout: 30_000 }),
  responseType: "arraybuffer",
  transformResponse: [(d) => d],
});

// ── one request at a time ─────────────────────────────────────────────────────
let busy = false;
const waiters = [];
async function lock() {
  if (!busy) { busy = true; return; }
  await new Promise((resolve) => waiters.push(resolve));
}
function unlock() {
  const next = waiters.shift();
  if (next) next(); else busy = false;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Call fn; on failure wait delayMs × attempt and try again, up to `attempts` times in total. */
export async function withRetry(fn, { attempts = config.tally.retries, delayMs = config.tally.retryDelayMs, label = "tally" } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < attempts) {
        logger.warn(`${label} failed (${err.message}); retry ${attempt}/${attempts - 1} in ${(delayMs * attempt) / 1000}s`);
        await sleep(delayMs * attempt);
      }
    }
  }
  throw lastErr;
}

/** Plain-language reason for a failed Tally request. */
export function explainTallyError(err) {
  if (err.code === "ECONNREFUSED") {
    return `TallyPrime is not reachable on ${config.tally.url}. In TallyPrime: F1 Help → Settings → Connectivity → set "TallyPrime acts as" to Both or Server, port 9000.`;
  }
  if (err.code === "ECONNABORTED" || /timeout/i.test(err.message || "")) {
    return "TallyPrime accepted the connection but did not answer. This usually means a dialog (an error or a question) " +
      "is open in TallyPrime and it is waiting for someone to close it. Switch to TallyPrime, close the dialog, and try again.";
  }
  return err.message;
}

/** Tally answers a plain GET with "TallyPrime Server is Running". */
async function pingOnce() {
  let res;
  try {
    res = await axios.get(config.tally.url, { timeout: 10_000, responseType: "arraybuffer", proxy: false });
  } catch (err) {
    throw Object.assign(new Error(explainTallyError(err)), { code: err.code });
  }
  const body = decodeTallyBody(Buffer.from(res.data)).toLowerCase();
  if (!body.includes("tally")) throw new Error(`Port ${config.tally.url} answered, but not as Tally`);
}

export class TallyUnavailable extends Error {}

export async function pingTally() {
  const start = Date.now();
  try {
    await pingOnce();
    return { connected: true, latencyMs: Date.now() - start, url: config.tally.url };
  } catch (err) {
    return { connected: false, url: config.tally.url, error: err.message };
  }
}

/** POST one XML request (ping + retries + lock). Returns decoded response text. */
export async function postXml(xml, label = "tally request") {
  await lock();
  try {
    return await withRetry(async () => {
      await pingOnce();
      const res = await http.post("", Buffer.from(xml, "utf16le"), {
        headers: { "Content-Type": "text/xml;charset=utf-16" },
      });
      const text = decodeTallyBody(Buffer.from(res.data));
      if (!text) throw new Error("Empty response from Tally");
      return text;
    }, { label });
  } finally {
    unlock();
  }
}

/**
 * Inline-TDL collection export.
 * @param {object}   o
 * @param {string}   o.name      collection id
 * @param {string}   o.type      Tally object type, e.g. "Stock Item"
 * @param {string}   o.fetch     comma-separated FETCH list
 * @param {string}   [o.company] SVCURRENTCOMPANY
 * @param {string}   [o.fromDate] ISO date
 * @param {string}   [o.toDate]   ISO date
 * @param {string[]} [o.filters] TDL formulae; each must be true
 * @param {string[]} [o.childOf] parent object names: the collection becomes the union
 *                               of one CHILDOF sub-collection per parent (e.g. the
 *                               batches of several stock items in one request)
 */
export function buildCollectionXml({ name, type, fetch, company, fromDate, toDate, filters = [], childOf }) {
  const statics = [
    company ? `<SVCURRENTCOMPANY>${escapeXml(company)}</SVCURRENTCOMPANY>` : "",
    fromDate ? `<SVFROMDATE TYPE="Date">${formatTallyDate(fromDate)}</SVFROMDATE>` : "",
    toDate ? `<SVTODATE TYPE="Date">${formatTallyDate(toDate)}</SVTODATE>` : "",
    "<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>",
  ].filter(Boolean).join("");

  const names = filters.map((_, i) => `SSVFilter${i}`);
  const filterTag = names.length ? `<FILTERS>${names.join(",")}</FILTERS>` : "";
  const formulae = filters.map((f, i) => `<SYSTEM TYPE="Formulae" NAME="${names[i]}">${escapeXml(f)}</SYSTEM>`).join("");

  const coll = (n, extra = "") =>
    `<COLLECTION NAME="${escapeXml(n)}" ISMODIFY="No"><TYPE>${escapeXml(type)}</TYPE>${extra}<FETCH>${fetch}</FETCH>${filterTag}</COLLECTION>`;
  let collections;
  if (childOf) {
    // A TDL string literal cannot hold a double quote; callers leave such names out.
    if (childOf.some((p) => p.includes('"'))) throw new Error('childOf names cannot contain a double quote (")');
    const parts = childOf.map((_, i) => `${name}${i}`);
    collections = `<COLLECTION NAME="${escapeXml(name)}" ISMODIFY="No"><COLLECTION>${parts.join(",")}</COLLECTION></COLLECTION>` +
      childOf.map((p, i) => coll(parts[i], `<CHILDOF>${escapeXml(`"${p}"`)}</CHILDOF>`)).join("");
  } else {
    collections = coll(name);
  }

  return `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>${escapeXml(name)}</ID></HEADER>` +
    `<BODY><DESC><STATICVARIABLES>${statics}</STATICVARIABLES><TDL><TDLMESSAGE>` +
    `${collections}${formulae}</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
}

function throwOnTallyError(raw) {
  const lineError = raw.match(/<LINEERROR>([^<]*)<\/LINEERROR>/);
  if (lineError) throw new Error(`Tally: ${lineError[1]}`);
}

export async function exportCollection(opts, ...tags) {
  const raw = await postXml(buildCollectionXml(opts), `export ${opts.name}`);
  throwOnTallyError(raw);
  return collectionItems(await parseXml(raw), ...tags);
}

// ── Companies ─────────────────────────────────────────────────────────────────

/**
 * Loaded companies with Tally's change counters. ALTVCHID / ALTMSTID rise on
 * every voucher / master create, alter or delete. Group (aggregate) companies
 * are dropped, as Biz does.
 */
export async function fetchCompanies() {
  const want = config.tally.company;
  let rows = await readCompanies();
  if (want && !rows.some((c) => c.name === want)) {
    await loadCompany(want);
    rows = await readCompanies();
    if (!rows.some((c) => c.name === want)) {
      throw new Error(`Company "${want}" (TALLY_COMPANY in .env) is not open in TallyPrime and could not be loaded by name. ` +
        "Open it in TallyPrime (Alt+F3 → Select Company), or correct the name in .env.");
    }
  }
  return want ? rows.filter((c) => c.name === want) : rows;
}

/** Names of every company open in TallyPrime now (for the setup page's picker). */
export async function openCompanyNames() {
  return (await readCompanies()).map((c) => c.name);
}

/**
 * Ask Tally to load a company by name. When TallyPrime runs as a server with no
 * company selected, naming it in SVCURRENTCOMPANY makes Tally open it.
 */
export async function loadCompany(name) {
  try {
    await exportCollection({ name: "SSVLoadCompany", type: "Company", fetch: "NAME", company: name }, "COMPANY");
  } catch { /* the caller checks whether it is now loaded */ }
}

async function readCompanies() {
  const rows = await exportCollection(
    {
      name: "SSVCompanies",
      type: "Company",
      fetch: "NAME,GUID,STARTINGFROM,BOOKSFROM,ENDINGAT,LASTVOUCHERDATE,STATENAME,GSTIN,CMPVCHID,ALTVCHID,ALTMSTID,ISAGGREGATE",
    },
    "COMPANY",
  );
  return rows
    .map((c) => ({
      name: masterName(c),
      guid: val(c.GUID),
      startingFrom: tallyDateToISO(val(c.STARTINGFROM)),
      booksFrom: tallyDateToISO(val(c.BOOKSFROM)),
      endingAt: tallyDateToISO(val(c.ENDINGAT)),
      lastVoucherDate: tallyDateToISO(val(c.LASTVOUCHERDATE)),
      state: val(c.STATENAME),
      gstin: val(c.GSTIN),
      altVchId: parseNumber(val(c.ALTVCHID)),
      altMstId: parseNumber(val(c.ALTMSTID)),
      isAggregate: val(c.ISAGGREGATE) === "Yes",
    }))
    .filter((c) => c.name && c.guid && !c.isAggregate);
}

// ── Voucher statistics (counts per voucher type per period) ─────────────────

/**
 * Tally's "Statistics" report for several periods in one request (REPEATSET per
 * period). The response is a flat list of STATNAME (one per voucher type) and
 * STATVALUE (one per type × period, type-major). Count = STATDIRECT minus the
 * number in STATCANCELLED, as Biz does.
 *
 * @param {string} company
 * @param {{from: string, to: string}[]} periods ISO dates
 * @returns {Array<Record<string, number>>} one {voucherType: count} per period
 */
export function buildStatisticsXml(company, periods) {
  const sets = periods
    .map((p) => `<REPEATSET><SVFROMDATE>${formatTallyDate(p.from)}</SVFROMDATE><SVTODATE>${formatTallyDate(p.to)}</SVTODATE></REPEATSET>`)
    .join("");
  return `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>Statistics</ID></HEADER>` +
    `<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT><SVCURRENTCOMPANY>${escapeXml(company)}</SVCURRENTCOMPANY></STATICVARIABLES>` +
    `<REPEATVARIABLES>${sets}</REPEATVARIABLES></DESC></BODY></ENVELOPE>`;
}

export async function fetchVoucherStatistics(company, periods) {
  const raw = await postXml(buildStatisticsXml(company, periods), "voucher statistics");
  throwOnTallyError(raw);
  return parseStatistics(await parseXml(raw), periods.length);
}

/** Pure parser, exported for tests. */
export function parseStatistics(parsed, periodCount) {
  const env = parsed?.ENVELOPE;
  if (!env) throw new Error("Statistics: no ENVELOPE in Tally response");
  const names = list(env.STATNAME).map((n) => val(n));
  const values = list(env.STATVALUE).map((v) => {
    const direct = parseNumber(val(v?.STATDIRECT)) ?? 0;
    const cancelled = parseNumber(String(val(v?.STATCANCELLED) ?? "").match(/\d+/)?.[0]) ?? 0;
    return direct - cancelled;
  });
  if (names.length === 0) return Array.from({ length: periodCount }, () => ({}));
  if (values.length !== names.length * periodCount) {
    throw new Error(`Statistics: ${values.length} values for ${names.length} types × ${periodCount} periods`);
  }
  const out = Array.from({ length: periodCount }, () => ({}));
  names.forEach((name, n) => {
    for (let p = 0; p < periodCount; p++) {
      const count = values[n * periodCount + p];
      if (count > 0) out[p][name] = count;
    }
  });
  return out;
}
