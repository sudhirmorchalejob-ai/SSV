/**
 * hub.js — the SSV middleware: one agent per distributor, many manufacturers.
 *
 * A distributor's Tally holds several manufacturers' items. Its one agent splits
 * every bill per manufacturer on the PC (only that manufacturer's lines, never
 * the bill total) and sends each part here, marked with the manufacturer's code.
 * The hub:
 *
 *   GET  /agent/v1/config     asks each linked manufacturer's ERPNext for its
 *                             rules and merges them; 503 if any cannot be
 *                             reached, so the agent keeps its cached full set
 *   POST /agent/v1/batches    routes the batch to its manufacturer's site only,
 *                             re-signed as this distributor on that site, and
 *                             relays the answer (202, 409 duplicate, 422 refused)
 *   POST /agent/v1/heartbeat  passes the run report to every linked site
 *   GET  /health
 *
 * Every agent request is checked: known and enabled distributor, HMAC-SHA256
 * signature over "<timestamp>.<body>", timestamp within 5 minutes. The hub stores
 * nothing about the data it routes: idempotency and storage stay with each
 * manufacturer's ERPNext, and retries with the agent's own queue (a 5xx or 502
 * here means "try again later" to the agent).
 */

import http from "node:http";
import crypto from "node:crypto";
import { loadRegistry, distributor, DEFAULT_PATHS } from "./registry.js";

const MAX_BODY = 6 * 1024 * 1024;
const SKEW_SECONDS = 300;
const UPSTREAM_TIMEOUT_MS = 120_000;

export function sign(body, timestamp, secret) {
  return crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

function log(...args) {
  if (process.env.HUB_QUIET !== "1") console.log(new Date().toISOString(), ...args);
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, "body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** The agent's signature: returns the distributor's registry entry. */
function authenticate(req, body) {
  const id = req.headers["x-ssv-distributor"];
  const ts = req.headers["x-ssv-timestamp"];
  const sig = String(req.headers["x-ssv-signature"] || "");
  const d = id && distributor(id, loadRegistry());
  if (!d || !ts) throw new HttpError(401, "unknown distributor or missing signature headers");
  if (Math.abs(Date.now() / 1000 - Number(ts)) > SKEW_SECONDS) {
    throw new HttpError(401, "request time outside the allowed skew; check the PC clock");
  }
  const want = Buffer.from(sign(body, ts, d.secret));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) throw new HttpError(401, "bad signature");
  return { id, ...d };
}

/** Call a manufacturer's site as this distributor. */
async function upstream(link, method, pathKey, body = "") {
  const ts = Math.floor(Date.now() / 1000).toString();
  const res = await fetch(`${link.url.replace(/\/+$/, "")}${link[pathKey] || DEFAULT_PATHS[pathKey]}`, {
    method,
    headers: {
      "X-SSV-Distributor": link.distributorId,
      "X-SSV-Timestamp": ts,
      "X-SSV-Signature": sign(body, ts, link.secret),
      ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
    },
    body: method === "POST" ? body : undefined,
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  return { status: res.status, text: await res.text() };
}

const unwrap = (text) => {
  const j = JSON.parse(text);
  return j && typeof j === "object" && "message" in j ? j.message : j;
};

export function compareVersions(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/**
 * Merge the manufacturers' configs. Each site may only speak for its own
 * principal code. Interval: the shortest any of them asks for. "Sync now":
 * one opaque token made of all of theirs, so a request on any site changes it.
 */
/**
 * @param shares pairs of principal codes the hub operator approved to receive the same
 *   items from this sender, e.g. a dealer's CEAT lines for both CEAT and the distributor
 *   supplying them: [["CEAT", "RAJLAXMI"]]. Only the registry decides this, never a site.
 */
export function mergeConfigs(parts, shares = []) {
  const principals = [];
  const intervals = [];
  const tokens = [];
  const updates = [];
  const partners = (code) => [...new Set(shares.filter((s) => s.includes(code)).flat().filter((c) => c !== code))];
  for (const { link, config } of parts) {
    for (const p of config?.principals || []) {
      if (p.code !== link.principal) {
        log(`ignored rules for "${p.code}" from the ${link.principal} site`);
        continue;
      }
      const { sharesWith: _fromSite, ...rules } = p;
      const withs = partners(p.code);
      principals.push(withs.length ? { ...rules, sharesWith: withs } : rules);
    }
    const a = config?.agent;
    if (a?.syncIntervalMinutes) intervals.push(Number(a.syncIntervalMinutes));
    if (a?.syncRequestedAt) tokens.push(`${link.principal}=${a.syncRequestedAt}`);
    if (a?.update?.version) updates.push(a.update);
  }
  // The agent belongs to the distributor, not to one manufacturer: when several
  // approve a version, the lowest of them is the one they all accept.
  updates.sort((x, y) => compareVersions(x.version, y.version));
  return {
    principals,
    agent: {
      syncIntervalMinutes: intervals.length ? Math.min(...intervals) : null,
      syncRequestedAt: tokens.length ? tokens.sort().join("|") : null,
      ...(updates.length ? { update: updates[0] } : {}),
    },
  };
}

async function handleConfig(d) {
  const parts = await Promise.all(d.links.map(async (link) => {
    let r;
    try {
      r = await upstream(link, "GET", "configPath");
    } catch (err) {
      throw new HttpError(503, `${link.principal} site unreachable: ${err.message}`);
    }
    if (r.status !== 200) throw new HttpError(503, `${link.principal} site answered ${r.status}`);
    return { link, config: unwrap(r.text) };
  }));
  return { status: 200, body: mergeConfigs(parts, d.shares || []) };
}

async function handleBatch(d, body) {
  let batch;
  try {
    batch = JSON.parse(body);
  } catch {
    throw new HttpError(422, "body is not JSON");
  }
  const link = d.links.find((l) => l.principal === batch.principal);
  if (!link) throw new HttpError(422, `principal ${batch.principal} is not linked to distributor ${d.id}`);
  const out = JSON.stringify({ ...batch, distributor_id: link.distributorId });
  let r;
  try {
    r = await upstream(link, "POST", "batchesPath", out);
  } catch (err) {
    throw new HttpError(502, `${link.principal} site unreachable: ${err.message}`);
  }
  log(`${d.id} → ${link.principal}: ${batch.kind} batch ${batch.batch_id} → ${r.status}`);
  return { status: r.status, raw: r.text };
}

async function handleHeartbeat(d, body) {
  let hb;
  try {
    hb = JSON.parse(body);
  } catch {
    throw new HttpError(422, "body is not JSON");
  }
  const results = await Promise.all(d.links.map(async (link) => {
    try {
      const r = await upstream(link, "POST", "heartbeatPath", JSON.stringify({ ...hb, distributor_id: link.distributorId }));
      return { principal: link.principal, status: r.status };
    } catch (err) {
      return { principal: link.principal, error: err.message };
    }
  }));
  const delivered = results.filter((r) => r.status && r.status < 300).length;
  return { status: delivered ? 200 : 502, body: { ok: delivered > 0, delivered, results } };
}

export function createHub() {
  return http.createServer(async (req, res) => {
    const reply = (status, payload, raw) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(raw ?? JSON.stringify(payload));
    };
    try {
      const url = new URL(req.url, "http://hub");
      if (req.method === "GET" && url.pathname === "/health") return reply(200, { ok: true });
      const body = await readBody(req);
      const d = authenticate(req, body);
      let out;
      if (req.method === "GET" && url.pathname === "/agent/v1/config") out = await handleConfig(d);
      else if (req.method === "POST" && url.pathname === "/agent/v1/batches") out = await handleBatch(d, body);
      else if (req.method === "POST" && url.pathname === "/agent/v1/heartbeat") out = await handleHeartbeat(d, body);
      else throw new HttpError(404, "not found");
      return reply(out.status, out.body, out.raw);
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) log(`error ${status}: ${err.message}`);
      return reply(status, { ok: false, error: err.message });
    }
  });
}
