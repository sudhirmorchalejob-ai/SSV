/**
 * setup.js
 * ────────
 * The settings behind the local setup page (http://127.0.0.1:4100). Reads and
 * writes the agent's .env, keeping its comments and any line it does not manage,
 * and tests a connection before anything is saved.
 *
 * The agent secret is write-only: the page learns whether one is set, never its
 * value. Saving restarts the agent (exit code 76) so every module sees the new
 * settings; the Windows service starts it again at once.
 */

import fs from "fs";
import path from "path";
import axios from "axios";
import { sign } from "./upload.js";

export const RESTART_EXIT_CODE = 76;

/** The .env the running agent read: the working folder's (the service uses C:\ProgramData\SSVConnector), else next to the exe. */
export function envFilePath() {
  const here = path.resolve(".env");
  if (fs.existsSync(here)) return here;
  const byExe = path.join(path.dirname(process.execPath), ".env");
  return fs.existsSync(byExe) ? byExe : here;
}

const isUrl = (v) => /^https:\/\/[^\s/]+(\/[^\s]*)?$/i.test(v) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/[^\s]*)?$/i.test(v);
const isPath = (v) => /^\/[^\s]*$/.test(v);

/** What the page may change, with the check each value must pass ("" clears an optional one). */
export const FIELDS = {
  MIDDLEWARE_URL: { required: true, check: isUrl, hint: "https://… (the manufacturer's or distributor's site)" },
  MIDDLEWARE_BATCHES_PATH: { check: isPath, hint: "starts with /" },
  MIDDLEWARE_CONFIG_PATH: { check: isPath, hint: "starts with /" },
  DISTRIBUTOR_ID: { required: true, check: (v) => /^[\w.-]{1,64}$/.test(v), hint: "letters, digits, - . _" },
  AGENT_SECRET: { secret: true, check: (v) => v.length >= 16 && !/\s/.test(v), hint: "at least 16 characters, no spaces" },
  TALLY_URL: { check: (v) => /^http:\/\/[^\s/]+(:\d+)?\/?$/i.test(v), hint: "e.g. http://localhost:9000" },
  TALLY_COMPANY: { check: (v) => v.length <= 200 && !/[\r\n]/.test(v), hint: "exact company name in TallyPrime" },
  SYNC_INTERVAL_MINUTES: { check: (v) => /^\d+$/.test(v) && +v >= 5 && +v <= 1440, hint: "5 to 1440" },
  SYNC_FROM: { check: (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v)), hint: "YYYY-MM-DD" },
  SHARE_RETAILER_CONTACTS: { default: "true", check: (v) => v === "true" || v === "false", hint: "true or false" },
  RECONCILE_EVERY_HOURS: { default: "24", check: (v) => /^\d+$/.test(v) && +v <= 168, hint: "0 to 168" },
  USE_PROXY: { default: "0", check: (v) => v === "0" || v === "1", hint: "0 or 1" },
};

/** Only what differs from the file (a missing key counts as its default), so saving a tab rewrites nothing needlessly. */
export function changedOnly(updates, saved) {
  return Object.fromEntries(Object.entries(updates).filter(([k, v]) => (saved[k] ?? FIELDS[k]?.default ?? "") !== v));
}

// ── .env reading and writing ────────────────────────────────────────────────

function parseLine(line) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (!m) return null;
  let v = m[2];
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  return [m[1], v];
}

export function readEnv(file = envFilePath()) {
  const values = {};
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const kv = parseLine(line);
      if (kv) values[kv[0]] = kv[1];
    }
  }
  return values;
}

/** dotenv cuts an unquoted value at " #", so quote values that need it. */
const quote = (v) => (/[#"']|^\s|\s$/.test(v) ? (v.includes('"') ? `'${v}'` : `"${v}"`) : v);

/** Set keys in place (comments and other lines kept), append new ones, write atomically. */
export function writeEnv(updates, file = envFilePath()) {
  const lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split(/\r?\n/) : [];
  const pending = new Map(Object.entries(updates));
  const out = lines.map((line) => {
    const kv = parseLine(line);
    if (!kv || !pending.has(kv[0])) return line;
    const v = pending.get(kv[0]);
    pending.delete(kv[0]);
    return `${kv[0]}=${quote(v)}`;
  });
  while (out.length && out[out.length - 1] === "") out.pop();
  for (const [k, v] of pending) out.push(`${k}=${quote(v)}`);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, out.join("\r\n") + "\r\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// ── what the page sees and sends ────────────────────────────────────────────

/** Current settings for the page. The secret is reported as set or not, never shown. */
export function currentSettings(file = envFilePath()) {
  const env = readEnv(file);
  const values = {};
  for (const [k, f] of Object.entries(FIELDS)) values[k] = f.secret ? undefined : env[k] ?? "";
  return { file, values, secretSet: Boolean(env.AGENT_SECRET) };
}

/**
 * Lines pasted from ERPNext's "Show Agent Secret" (or a hub's .agent.env):
 * KEY=VALUE per line; anything else is ignored.
 */
export function parsePasted(text) {
  const out = {};
  for (const line of String(text || "").split(/\r?\n/)) {
    const kv = parseLine(line);
    if (kv && kv[0] in FIELDS) out[kv[0]] = kv[1];
  }
  return out;
}

/**
 * Check what the page wants to save. Returns { updates, errors }: only known keys,
 * trimmed; an empty secret means "keep the current one".
 */
export function validate(values, { secretSet = false } = {}) {
  const updates = {};
  const errors = {};
  for (const [k, raw] of Object.entries(values || {})) {
    const f = FIELDS[k];
    if (!f) continue;
    const v = String(raw ?? "").trim();
    if (f.secret && v === "") continue;
    if (v === "") {
      if (f.required) errors[k] = "required";
      else updates[k] = "";
      continue;
    }
    if (/[\r\n]/.test(v) || !f.check(v)) errors[k] = f.hint;
    else updates[k] = v;
  }
  if (!secretSet && !updates.AGENT_SECRET && ("DISTRIBUTOR_ID" in (values || {}))) errors.AGENT_SECRET = "required";
  return { updates, errors };
}

/**
 * Ask the site for this distributor's rules with the given (unsaved) settings,
 * signed the way the agent signs. Returns { ok, principals } or { ok: false, error }.
 */
export async function testConnection(s) {
  const url = `${s.MIDDLEWARE_URL.replace(/\/+$/, "")}${s.MIDDLEWARE_CONFIG_PATH || "/agent/v1/config"}`;
  const ts = Math.floor(Date.now() / 1000).toString();
  try {
    const res = await axios.get(url, {
      timeout: 20_000,
      proxy: false,
      headers: { "X-SSV-Distributor": s.DISTRIBUTOR_ID, "X-SSV-Timestamp": ts, "X-SSV-Signature": sign("", ts, s.AGENT_SECRET) },
    });
    const data = res.data?.message ?? res.data;
    const principals = (data?.principals || []).map((p) => ({
      code: p.code, stockGroups: p.stockGroups || [], stockCategories: p.stockCategories || [], items: (p.items || []).length,
    }));
    return { ok: true, principals };
  } catch (err) {
    const status = err.response?.status;
    const said = err.response?.data?.message?.error || err.response?.data?.error || err.response?.data?.exc_type;
    const error = status === 401 || status === 403
      ? "The site refused the ID or secret. Paste the lines again from Show Agent Secret, and check that this PC's clock is right."
      : status === 404 ? "The site answered, but not at that path. Check the two paths."
      : status ? `The site answered HTTP ${status}${said ? `: ${said}` : ""}.`
      : `Could not reach ${url} (${err.code || err.message}). Check the address and the internet connection.`;
    return { ok: false, error };
  }
}
