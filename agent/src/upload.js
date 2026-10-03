/**
 * upload.js
 * ─────────
 * Sends pending rows from the local SQLite store to the middleware, Biz-style:
 *   • read pending vouchers 1,000 at a time, oldest AlterID first
 *   • split each page per principal (only that principal's lines leave the PC)
 *   • cut each principal's share into requests of at most 5 MB
 *   • flip up_to_date to 1 only after every principal that needs the voucher
 *     has accepted it
 *
 * Every request is signed: HMAC-SHA256 over "<timestamp>.<body>" with the
 * agent secret. The middleware must treat (voucher guid, alterId) as
 * idempotent, because a partly-sent page is resent whole.
 */

import crypto from "crypto";
import axios from "axios";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { openDb, tx, getCompany, PENDING, DONE, REJECTED } from "./db.js";
import { splitByPrincipal } from "./principals.js";
import { partiesByName } from "./sync/store.js";

export const AGENT_VERSION = "0.6.1";

export function sign(body, timestamp, secret = config.middleware.agentSecret) {
  return crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

export function isConfigured() {
  const m = config.middleware;
  return Boolean(m.url && m.agentSecret && m.distributorId);
}

/** Principals an item goes to: several only where the hub approved a shared pair. */
const codesOf = (ctx, name) => (ctx.principalsOf ? ctx.principalsOf(name) : [ctx.principalOf(name)].filter(Boolean));

class Rejected extends Error {}
class Unreachable extends Error {}

async function send(batch) {
  const body = JSON.stringify(batch);
  const ts = Math.floor(Date.now() / 1000).toString();
  try {
    await axios.post(`${config.middleware.url}${config.middleware.batchesPath}`, body, {
      timeout: config.middleware.timeoutMs,
      maxBodyLength: Infinity,
      ...(config.middleware.useProxy ? {} : { proxy: false }),
      headers: {
        "Content-Type": "application/json",
        "X-SSV-Distributor": config.middleware.distributorId,
        "X-SSV-Timestamp": ts,
        "X-SSV-Signature": sign(body, ts),
      },
    });
  } catch (err) {
    const status = err.response?.status;
    if (status === 409) return; // batch already received
    if (status >= 400 && status < 500 && ![401, 403, 408, 429].includes(status)) {
      throw new Rejected(`HTTP ${status} ${JSON.stringify(err.response?.data ?? "").slice(0, 300)}`);
    }
    // e.g. 503 "data is held until the Data Sharing Consent Date is recorded"
    const said = err.response?.data?.message?.error || err.response?.data?.error;
    throw new Unreachable(status ? `HTTP ${status}${said ? `: ${String(said).slice(0, 200)}` : ""}` : err.message);
  }
}

function envelope(kind, principal, company, payload) {
  return {
    batch_id: crypto.randomUUID(),
    schema: 2,
    kind,
    principal,
    distributor_id: config.middleware.distributorId,
    tally_company: { guid: company.guid, name: company.name },
    // Goes up by one each time a Tally backup restore is detected. Within a
    // company, newer = higher (sync_epoch, alterId), not higher alterId alone.
    sync_epoch: getCompany(company.guid)?.epoch ?? 0,
    agent_version: AGENT_VERSION,
    created_at: new Date().toISOString(),
    ...payload,
  };
}

/**
 * Greedy split of records into requests no larger than maxBytes.
 * @param {object[]} records
 * @param {(part: object[]) => object} build  records → full request body
 */
export function chunkBySize(records, build, maxBytes = config.upload.maxBytes) {
  const size = (o) => Buffer.byteLength(JSON.stringify(o));
  const overhead = size(build([]));
  const chunks = [];
  let cur = [];
  let curBytes = overhead;
  for (const r of records) {
    const b = size(r) + 1;
    if (cur.length && curBytes + b > maxBytes) {
      chunks.push(cur);
      cur = [];
      curBytes = overhead;
    }
    cur.push(r);
    curBytes += b;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

/**
 * Upload everything pending for one company.
 * @param company   { guid, name }
 * @param ctx       { principalOf, baseTypeOf, groupPathOf }
 */
export async function uploadCompany(company, ctx) {
  const report = { items: 0, vouchers: 0, tombstones: 0, requests: 0, rejected: 0 };
  if (!isConfigured()) {
    report.error = "middleware not configured (MIDDLEWARE_URL, DISTRIBUTOR_ID, AGENT_SECRET)";
    return report;
  }
  try {
    await uploadItems(company, ctx, report);
    await uploadVouchers(company, ctx, report);
  } catch (err) {
    if (!(err instanceof Unreachable)) throw err;
    report.error = err.message;
    logger.warn(`Upload for "${company.name}" paused: ${err.message}`);
  }
  return report;
}

async function uploadItems(company, ctx, report) {
  const db = openDb();
  const rows = db.prepare(`SELECT master_id, data FROM stock_item WHERE company_guid = ? AND up_to_date = ${PENDING}`).all(company.guid);
  if (!rows.length) return;

  const byPrincipal = new Map();
  const noPrincipal = [];
  const needs = new Map(); // masterId → principals that must accept the item
  for (const r of rows) {
    const it = JSON.parse(r.data);
    const codes = codesOf(ctx, it.name);
    if (!codes.length) { noPrincipal.push(r.master_id); continue; }
    needs.set(it.masterId, new Set(codes));
    for (const code of codes) {
      if (!byPrincipal.has(code)) byPrincipal.set(code, []);
      byPrincipal.get(code).push({ ...it, groupPath: ctx.groupPathOf(it.group) });
    }
  }
  setItems(company.guid, noPrincipal, DONE);

  // An item is done only when every principal it goes to has it, so one site being
  // down does not leave the other one without it.
  const accepted = new Map([...needs.keys()].map((m) => [m, new Set()]));
  const finish = () => setItems(company.guid,
    [...needs].filter(([m, want]) => [...want].every((c) => accepted.get(m).has(c))).map(([m]) => m), DONE);
  const asOf = new Date().toISOString().slice(0, 10);
  try {
    for (const [code, items] of byPrincipal) {
      const build = (part) => envelope("items", code, company, { as_of_date: asOf, items: part });
      for (const part of chunkBySize(items, build)) {
        try {
          await send(build(part));
          part.forEach((i) => accepted.get(i.masterId).add(code));
          report.items += part.length;
        } catch (err) {
          if (!(err instanceof Rejected)) throw err;
          logger.error(`Middleware rejected items for ${code}: ${err.message}`);
          setItems(company.guid, part.map((i) => i.masterId), REJECTED);
          part.forEach((i) => needs.delete(i.masterId));
          report.rejected += part.length;
        }
        report.requests++;
      }
    }
  } finally {
    finish();
  }
}

function setItems(companyGuid, ids, state) {
  if (!ids.length) return;
  tx((d) => {
    const q = d.prepare("UPDATE stock_item SET up_to_date = ? WHERE company_guid = ? AND master_id = ?");
    for (const id of ids) q.run(state, companyGuid, id);
  });
}

async function uploadVouchers(company, ctx, report) {
  const db = openDb();
  const pageQ = db.prepare(`SELECT master_id, guid, is_deleted, data FROM voucher
    WHERE company_guid = ? AND up_to_date = ${PENDING} ORDER BY alter_id LIMIT ?`);
  const prevQ = db.prepare("SELECT principal FROM voucher_principal WHERE company_guid = ? AND master_id = ?");

  for (;;) {
    const rows = pageQ.all(company.guid, config.upload.pageSize);
    if (!rows.length) return;

    const byGuid = new Map();
    const vouchers = rows.map((r) => {
      const v = JSON.parse(r.data);
      byGuid.set(v.guid, r.master_id);
      // A deleted voucher has no lines, so every principal holding it gets a tombstone.
      return r.is_deleted ? { ...v, lines: [], isOptional: false } : v;
    });
    const previous = new Map(rows.map((r) => [r.master_id, prevQ.all(company.guid, r.master_id).map((p) => p.principal)]));
    const deletedGuids = new Set(rows.filter((r) => r.is_deleted).map((r) => JSON.parse(r.data).guid));

    const { perPrincipal, sentTo } = splitByPrincipal(vouchers, {
      principalOf: ctx.principalOf,
      principalsOf: ctx.principalsOf,
      baseTypeOf: ctx.baseTypeOf,
      previouslySentTo: (guid) => previous.get(byGuid.get(guid)) || [],
    });

    // What each voucher needs: current principals plus principals to withdraw from.
    const needs = new Map([...sentTo].map(([guid, codes]) => [guid, new Set(codes)]));
    for (const [code, share] of perPrincipal) {
      for (const t of share.tombstones) needs.get(t.guid)?.add(code);
    }
    const accepted = new Map([...needs.keys()].map((g) => [g, new Set()]));
    const rejected = new Set();

    for (const [code, share] of perPrincipal) {
      const records = [
        ...share.vouchers.map((v) => ({ type: "voucher", v })),
        ...share.tombstones.map((t) => ({ type: "tombstone", t: { ...t, reason: deletedGuids.has(t.guid) ? "deleted" : t.reason } })),
      ];
      const build = (part) => {
        const vs = part.filter((r) => r.type === "voucher").map((r) => r.v);
        const parties = partiesByName(company.guid, [...new Set(vs.map((v) => v.partyLedger).filter(Boolean))]);
        return envelope("vouchers", code, company, {
          vouchers: vs,
          tombstones: part.filter((r) => r.type === "tombstone").map((r) => r.t),
          parties: parties.map(partyForUpload),
          // Tells the receiver to drop any contacts it already holds for this distributor.
          party_contacts: config.upload.retailerContacts,
        });
      };
      for (const part of chunkBySize(records, build)) {
        const guids = part.map((r) => (r.type === "voucher" ? r.v.guid : r.t.guid));
        try {
          await send(build(part));
          guids.forEach((g) => accepted.get(g)?.add(code));
          report.vouchers += part.filter((r) => r.type === "voucher").length;
          report.tombstones += part.filter((r) => r.type === "tombstone").length;
        } catch (err) {
          if (!(err instanceof Rejected)) {
            finishPage(company.guid, rows, byGuid, needs, accepted, rejected, sentTo);
            throw err;
          }
          logger.error(`Middleware rejected vouchers for ${code}: ${err.message}`);
          guids.forEach((g) => rejected.add(g));
          report.rejected += guids.length;
        }
        report.requests++;
      }
    }
    finishPage(company.guid, rows, byGuid, needs, accepted, rejected, sentTo);
  }
}

/** A party as sent: contacts only when the distributor shares them (SHARE_RETAILER_CONTACTS). */
export function partyForUpload(p, shareContacts = config.upload.retailerContacts) {
  const contacts = shareContacts ? { phone: p.phone, pincode: p.pincode, address: p.address } : {};
  return { name: p.name, guid: p.guid, group: p.group, gstin: p.gstin, state: p.state, priceLevel: p.priceLevel, ...contacts };
}

/** Mark vouchers done where every principal that needed them accepted them. */
function finishPage(companyGuid, rows, byGuid, needs, accepted, rejected, sentTo) {
  tx((d) => {
    const setState = d.prepare("UPDATE voucher SET up_to_date = ? WHERE company_guid = ? AND master_id = ?");
    const clear = d.prepare("DELETE FROM voucher_principal WHERE company_guid = ? AND master_id = ?");
    const add = d.prepare("INSERT OR IGNORE INTO voucher_principal (company_guid, master_id, principal) VALUES (?, ?, ?)");
    for (const [guid, need] of needs) {
      const masterId = byGuid.get(guid);
      if (rejected.has(guid)) { setState.run(REJECTED, companyGuid, masterId); continue; }
      const got = accepted.get(guid);
      if ([...need].every((c) => got.has(c))) {
        setState.run(DONE, companyGuid, masterId);
        clear.run(companyGuid, masterId);
        for (const c of sentTo.get(guid) || []) add.run(companyGuid, masterId, c);
      }
    }
  });
}

// ── reconciliation totals ────────────────────────────────────────────────────

const round = (n, dp) => Math.round(n * 10 ** dp) / 10 ** dp;

/**
 * Per principal, per month: the live bills every principal accepted, and qty and
 * amount summed over the rows the receiver stores for them: one per godown/batch
 * allocation, with the receiver's own fallbacks, so both sides add up alike.
 */
export function controlTotals(companyGuid, principalsOf) {
  const rows = openDb().prepare(`SELECT v.data, vp.principal FROM voucher v
    JOIN voucher_principal vp ON vp.company_guid = v.company_guid AND vp.master_id = v.master_id
    WHERE v.company_guid = ? AND v.is_deleted = 0 AND v.up_to_date = ${DONE}`).all(companyGuid);
  const out = new Map();
  for (const r of rows) {
    const v = JSON.parse(r.data);
    const month = (v.date || "").slice(0, 7);
    if (!month) continue;
    if (!out.has(r.principal)) out.set(r.principal, new Map());
    const byMonth = out.get(r.principal);
    const t = byMonth.get(month) || { month, vouchers: 0, qty: 0, amount: 0 };
    t.vouchers++;
    for (const line of v.lines || []) {
      if (!principalsOf(line.item).includes(r.principal)) continue;
      for (const a of line.allocations?.length ? line.allocations : [{}]) {
        t.qty += Number("qty" in a ? a.qty : line.qty) || 0;
        t.amount += Number("amount" in a ? a.amount : line.amount) || 0;
      }
    }
    byMonth.set(month, t);
  }
  return out;
}

/** Bills refused earlier, per principal whose items they carry: missing at that principal. */
function refusedByPrincipal(companyGuid, principalsOf) {
  const out = new Map();
  const rows = openDb().prepare(`SELECT data FROM voucher WHERE company_guid = ? AND is_deleted = 0 AND up_to_date = ${REJECTED}`)
    .all(companyGuid);
  for (const r of rows) {
    const codes = new Set((JSON.parse(r.data).lines || []).flatMap((l) => principalsOf(l.item)));
    codes.forEach((c) => out.set(c, (out.get(c) || 0) + 1));
  }
  return out;
}

/**
 * Send each principal its totals (kind "control"). Only when nothing is waiting
 * to go, so both sides should agree. Throws Unreachable if the receiver is down.
 * @param ctx { principalOf, principals: codes from the rules }
 */
export async function uploadControlTotals(company, ctx) {
  if (!isConfigured()) return { skipped: "middleware not configured" };
  const pending = openDb().prepare(`SELECT COUNT(*) AS n FROM voucher WHERE company_guid = ? AND up_to_date = ${PENDING}`)
    .get(company.guid).n;
  if (pending) return { skipped: `${pending} bill(s) still to send` };

  const all = (name) => codesOf(ctx, name);
  const totals = controlTotals(company.guid, all);
  const refused = refusedByPrincipal(company.guid, all);
  const out = { principals: 0 };
  for (const code of new Set([...(ctx.principals || []), ...totals.keys()])) {
    const months = [...(totals.get(code)?.values() || [])]
      .map((t) => ({ ...t, qty: round(t.qty, 3), amount: round(t.amount, 2) }));
    try {
      await send(envelope("control", code, company, { months, rejected: refused.get(code) || 0 }));
      out.principals++;
    } catch (err) {
      if (!(err instanceof Rejected)) throw err;
      logger.warn(`Reconciliation totals refused by ${code} (its ERPNext app may predate 0.6.3): ${err.message}`);
    }
  }
  return out;
}

export function pendingCounts() {
  const d = openDb();
  const q = (sql) => d.prepare(sql).get().n;
  return {
    vouchersPending: q(`SELECT COUNT(*) AS n FROM voucher WHERE up_to_date = ${PENDING}`),
    vouchersRejected: q(`SELECT COUNT(*) AS n FROM voucher WHERE up_to_date = ${REJECTED}`),
    itemsPending: q(`SELECT COUNT(*) AS n FROM stock_item WHERE up_to_date = ${PENDING}`),
  };
}
