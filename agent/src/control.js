/**
 * control.js
 * ──────────
 * What the principal controls from ERPNext (SSV Distributor → Agent), and what
 * the agent reports back.
 *
 *  In   The config response carries `agent: { syncIntervalMinutes, syncRequestedAt }`.
 *       The interval (5–1440 min) replaces SYNC_INTERVAL_MINUTES. A syncRequestedAt
 *       value the agent has not handled yet is a "Sync now" request; it is an
 *       opaque token, only compared for equality, so clocks and time zones do not
 *       matter. Kept on disk, so a restart without network keeps the interval.
 *
 *  Out  A signed heartbeat after every run: when it ran, whether it worked and,
 *       if not, why (e.g. TallyPrime not reachable). The principal then sees a
 *       broken agent the same day instead of only noticing missing data.
 */

import fs from "fs";
import path from "path";
import axios from "axios";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { sign, AGENT_VERSION } from "./upload.js";

const file = () => path.join(config.dataDir, "control.json");
let state = null;
let heartbeatUnsupported = false;

function load() {
  if (state) return state;
  try {
    state = JSON.parse(fs.readFileSync(file(), "utf8"));
  } catch {
    state = { firstContact: true };
  }
  return state;
}

function save() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(state, null, 2));
}

/** Interval from ERPNext → whole minutes in 5–1440, or null when not set. */
export function clampInterval(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v) || v <= 0) return null;
  return Math.min(1440, Math.max(5, v));
}

/** Apply the `agent` part of a config response. Absent (older ERPNext app): nothing changes. */
export function applyAgentSettings(agent) {
  if (!agent || typeof agent !== "object") return;
  const s = load();
  const interval = clampInterval(agent.syncIntervalMinutes);
  const request = agent.syncRequestedAt ? String(agent.syncRequestedAt) : null;
  s.update = agent.update && typeof agent.update === "object" ? agent.update : null;
  if (s.firstContact) {
    // A request made before this agent was installed is not replayed: the agent
    // syncs at startup anyway.
    s.handledSyncRequest = request;
    delete s.firstContact;
  }
  if (interval === s.intervalMinutes && request === s.syncRequestedAt) return save();
  if (interval !== s.intervalMinutes) {
    logger.info(interval
      ? `Sync interval set in ERPNext: every ${interval} min`
      : `No sync interval set in ERPNext; using SYNC_INTERVAL_MINUTES (${config.sync.intervalMinutes} min)`);
  }
  s.intervalMinutes = interval;
  s.syncRequestedAt = request;
  save();
}

export function effectiveIntervalMinutes() {
  return load().intervalMinutes ?? config.sync.intervalMinutes;
}

export function intervalSource() {
  return load().intervalMinutes ? "ERPNext" : ".env";
}

/** The agent version the manufacturer approved, if any: { version, url, sha256 }. */
export function approvedUpdate() {
  return load().update || null;
}

/** The "Sync now" token not yet handled, or null. */
export function pendingSyncRequest() {
  const s = load();
  return s.syncRequestedAt && s.syncRequestedAt !== s.handledSyncRequest ? s.syncRequestedAt : null;
}

export function markSyncRequestHandled(token) {
  load().handledSyncRequest = token;
  save();
}

function signedHeaders(body, extra = {}) {
  const ts = Math.floor(Date.now() / 1000).toString();
  return {
    "X-SSV-Distributor": config.middleware.distributorId,
    "X-SSV-Timestamp": ts,
    "X-SSV-Signature": sign(body, ts),
    ...extra,
  };
}

function configured() {
  const { url, distributorId, agentSecret } = config.middleware;
  return Boolean(url && distributorId && agentSecret);
}

const httpOptions = () => ({ timeout: 30_000, ...(config.middleware.useProxy ? {} : { proxy: false }) });

/** Signed GET of the config (rules + agent settings). Throws when unreachable or not configured. */
export async function fetchRemoteConfig() {
  if (!configured()) throw new Error("MIDDLEWARE_URL, DISTRIBUTOR_ID or AGENT_SECRET not set");
  const res = await axios.get(`${config.middleware.url}${config.middleware.configPath}`, {
    ...httpOptions(),
    headers: signedHeaders(""),
  });
  // Frappe wraps whitelisted method results as { message: ... }.
  const data = res.data?.message ?? res.data;
  applyAgentSettings(data?.agent);
  return data;
}

/** One line for the principal: what went wrong in this run, or null. */
export function runProblem(report) {
  const problems = [];
  if (report.error) problems.push(report.error);
  for (const c of report.companies || []) {
    if (c.error) problems.push(`${c.company}: ${c.error}`);
    if (c.blocked) problems.push(`${c.company}: ${c.blocked}`);
    if (c.upload?.error) problems.push(`${c.company}: upload paused: ${c.upload.error}`);
    if (c.upload?.rejected) problems.push(`${c.company}: ${c.upload.rejected} record(s) refused by ERPNext`);
  }
  return problems.length ? problems.join(" | ").slice(0, 1000) : null;
}

export function heartbeatBody(report) {
  const problem = runProblem(report);
  return {
    distributor_id: config.middleware.distributorId,
    agent_version: AGENT_VERSION,
    sent_at: new Date().toISOString(),
    interval_minutes: effectiveIntervalMinutes(),
    handled_sync_request: load().handledSyncRequest ?? null,
    run: {
      trigger: report.trigger,
      started: report.started,
      finished: report.finished,
      ok: !problem,
      problem,
      companies: (report.companies || []).map((c) => ({
        company: c.company,
        upload: c.upload ? { items: c.upload.items, vouchers: c.upload.vouchers, tombstones: c.upload.tombstones } : null,
      })),
    },
  };
}

/** Report a finished run. Never throws: a missing heartbeat must not fail a sync. */
export async function sendHeartbeat(report) {
  if (!configured() || heartbeatUnsupported || report.skipped) return;
  const body = JSON.stringify(heartbeatBody(report));
  try {
    await axios.post(`${config.middleware.url}${config.middleware.heartbeatPath}`, body, {
      ...httpOptions(),
      headers: signedHeaders(body, { "Content-Type": "application/json" }),
    });
  } catch (err) {
    const status = err.response?.status;
    // An app without the endpoint answers 404 (or Frappe's 417 for an unknown method).
    if (status >= 400 && status < 500 && ![401, 403, 408, 429].includes(status)) {
      heartbeatUnsupported = true;
      logger.info("ERPNext does not take run reports yet (ssv_channel before 0.4.0); skipping them.");
    } else {
      logger.warn(`Could not send the run report: ${err.message}`);
    }
  }
}

/** For tests: forget the in-memory state. */
export function resetControlState() {
  state = null;
  heartbeatUnsupported = false;
}
