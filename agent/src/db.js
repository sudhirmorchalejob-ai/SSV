/**
 * db.js
 * ─────
 * Local SQLite staging store (Node's built-in node:sqlite, no native build).
 * Same idea as Biz Analyst's per-company sqlite: everything read from Tally is
 * written here first with up_to_date = 0, and the uploader flips it to 1 only
 * after the middleware accepts it.
 *
 *   company            one row per Tally company: watermark, first-sync progress, guards
 *   voucher            stock-moving vouchers, keyed by Tally MASTERID
 *   voucher_principal  which principals currently hold a copy of each voucher
 *   stock_item         item masters with closing stock as of the last read
 *   party              ledgers (retailers) referenced by vouchers
 *   kv                 per-company cache: stock groups, voucher types, verified stats
 */

import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { config } from "./config.js";

// node:sqlite prints an ExperimentalWarning on load; keep the console clean.
const origEmit = process.emitWarning;
process.emitWarning = (w, ...rest) => {
  if (String(w?.message ?? w).includes("SQLite is an experimental feature")) return;
  return origEmit.call(process, w, ...rest);
};
// Loaded with require (not a static import) so the warning filter above is in
// place first. `require` exists in the bundled .exe; plain ESM builds one.
const load = typeof require === "function" ? require : createRequire(import.meta.url);
const { DatabaseSync } = load("node:sqlite");

// up_to_date values
export const PENDING = 0;
export const DONE = 1;
export const REJECTED = 2; // middleware refused it (4xx); kept for support, not retried

const SCHEMA = `
CREATE TABLE IF NOT EXISTS company (
  guid                   TEXT PRIMARY KEY,
  name                   TEXT,
  alt_vch_id             INTEGER,
  alt_mst_id             INTEGER,
  watermark              INTEGER,
  first_sync             INTEGER NOT NULL DEFAULT 1,
  first_sync_date        TEXT,
  first_sync_start_alter INTEGER,
  first_sync_mode        TEXT,
  masters_alt_mst_id     INTEGER,
  last_delete_sync_at    TEXT,
  last_deleted_alter_id  INTEGER,
  last_full_snapshot     TEXT,
  blocked_reason         TEXT,
  epoch                  INTEGER NOT NULL DEFAULT 0,
  updated_at             TEXT
);
CREATE TABLE IF NOT EXISTS voucher (
  company_guid TEXT NOT NULL,
  master_id    INTEGER NOT NULL,
  guid         TEXT,
  alter_id     INTEGER,
  date         TEXT,
  voucher_type TEXT,
  is_cancelled INTEGER NOT NULL DEFAULT 0,
  is_optional  INTEGER NOT NULL DEFAULT 0,
  is_deleted   INTEGER NOT NULL DEFAULT 0,
  data         TEXT NOT NULL,
  up_to_date   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (company_guid, master_id)
);
CREATE INDEX IF NOT EXISTS voucher_pending ON voucher (company_guid, up_to_date, alter_id);
CREATE INDEX IF NOT EXISTS voucher_date    ON voucher (company_guid, date);
CREATE TABLE IF NOT EXISTS voucher_principal (
  company_guid TEXT NOT NULL,
  master_id    INTEGER NOT NULL,
  principal    TEXT NOT NULL,
  PRIMARY KEY (company_guid, master_id, principal)
);
CREATE TABLE IF NOT EXISTS stock_item (
  company_guid  TEXT NOT NULL,
  master_id     INTEGER NOT NULL,
  name          TEXT NOT NULL,
  data          TEXT NOT NULL,
  closing_qty   REAL,
  closing_value REAL,
  up_to_date    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (company_guid, master_id)
);
CREATE INDEX IF NOT EXISTS stock_item_name ON stock_item (company_guid, name);
CREATE TABLE IF NOT EXISTS party (
  company_guid TEXT NOT NULL,
  name         TEXT NOT NULL,
  data         TEXT NOT NULL,
  PRIMARY KEY (company_guid, name)
);
CREATE TABLE IF NOT EXISTS kv (
  company_guid TEXT NOT NULL,
  key          TEXT NOT NULL,
  value        TEXT,
  PRIMARY KEY (company_guid, key)
);
`;

let db = null;

export function openDb(file = path.join(config.dataDir, "agent.db")) {
  if (db) return db;
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = OFF;");
  db.exec(SCHEMA);
  return db;
}

export function closeDb() {
  if (db) { db.close(); db = null; }
}

export function tx(fn) {
  const d = openDb();
  d.exec("BEGIN");
  try {
    const r = fn(d);
    d.exec("COMMIT");
    return r;
  } catch (err) {
    d.exec("ROLLBACK");
    throw err;
  }
}

// ── company ───────────────────────────────────────────────────────────────────

export function getCompany(guid) {
  return openDb().prepare("SELECT * FROM company WHERE guid = ?").get(guid) || null;
}

export function upsertCompany(guid, fields) {
  const d = openDb();
  const existing = getCompany(guid);
  const row = { ...(existing || { guid, first_sync: 1 }), ...fields, updated_at: new Date().toISOString() };
  const cols = Object.keys(row);
  d.prepare(
    `INSERT INTO company (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})
     ON CONFLICT(guid) DO UPDATE SET ${cols.filter((c) => c !== "guid").map((c) => `${c} = excluded.${c}`).join(",")}`,
  ).run(...cols.map((c) => row[c] ?? null));
  return getCompany(guid);
}

/** Wipe everything held for a company so the next run is a fresh first sync. */
export function resetCompany(guid) {
  tx((d) => {
    for (const t of ["voucher", "voucher_principal", "stock_item", "party", "kv"]) {
      d.prepare(`DELETE FROM ${t} WHERE company_guid = ?`).run(guid);
    }
    d.prepare("DELETE FROM company WHERE guid = ?").run(guid);
  });
}

// ── kv ────────────────────────────────────────────────────────────────────────

export function kvGet(companyGuid, key) {
  const r = openDb().prepare("SELECT value FROM kv WHERE company_guid = ? AND key = ?").get(companyGuid, key);
  return r ? JSON.parse(r.value) : null;
}

export function kvSet(companyGuid, key, value) {
  openDb().prepare(
    "INSERT INTO kv (company_guid, key, value) VALUES (?, ?, ?) ON CONFLICT(company_guid, key) DO UPDATE SET value = excluded.value",
  ).run(companyGuid, key, JSON.stringify(value));
}
