/**
 * vouchers.js (sync)
 * ──────────────────
 * Voucher sync, following Biz Analyst's connector step by step:
 *
 *  First sync ─ one Tally request per day, from the sync-from / company start
 *    date to the last voucher date. The last finished day is saved, so an
 *    interrupted first sync resumes there. If Tally ignores the date and returns
 *    other days, it switches to AlterID windows from 0 instead.
 *
 *  Incremental ─ AlterID windows of 250, both ends bounded, from the saved
 *    watermark up to the company's ALTVCHID. The watermark is saved after each
 *    window.
 *
 *  Guards ─
 *    • ALTVCHID missing              → error, company skipped this run
 *    • ALTVCHID negative             → company blocked: Tally data needs a rewrite
 *    • ALTVCHID 0                    → empty company, nothing to read
 *    • watermark missing after the
 *      first sync                    → company reset and fully resynced
 *    • ALTVCHID below the watermark,
 *      or another voucher now at the
 *      AlterID read last (backup
 *      restored)                     → step back 5,000 AlterIDs and re-read, and
 *                                      run the deleted-voucher check straight away
 */

import crypto from "crypto";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { getCompany, upsertCompany, resetCompany, kvGet, kvSet } from "../db.js";
import { applyVouchers } from "./store.js";

// The last voucher read, to recognise a restore after which as many vouchers were
// entered again as were lost: ALTVCHID is then no lower than before (field test 29-Sep).
const LAST_READ = "lastReadVoucher";
// Only fields a new parser version would not change, so an upgrade is not taken for a restore.
const fingerprint = (v) => crypto.createHash("sha256").update(JSON.stringify([
  v.guid, v.masterId, v.date, v.voucherType, v.voucherNumber, v.partyLedger,
  (v.lines || []).map((l) => [l.item, l.billedQty, l.amount]),
])).digest("hex").slice(0, 32);

function rememberLastRead(companyGuid, vouchers) {
  const last = vouchers.reduce((a, v) => ((v.alterId ?? 0) > (a?.alterId ?? 0) ? v : a), null);
  if (last) kvSet(companyGuid, LAST_READ, { alterId: last.alterId, sig: fingerprint(last) });
}

/** The AlterID read last now holds a different voucher: only a restore does that. */
async function lastReadReplaced(tally, company) {
  const last = kvGet(company.guid, LAST_READ);
  if (!(last?.alterId > 0)) return null;
  const now = (await tally.fetchVouchersByAlterIdWindow(company, last.alterId - 1, last.alterId))
    .find((v) => v.alterId === last.alterId);
  return now && fingerprint(now) !== last.sig ? last.alterId : null;
}

const today = () => new Date().toISOString().slice(0, 10);
export const addDays = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

export class CompanyBlocked extends Error {}

/**
 * @param tally     Tally access (real module or a test fake)
 * @param company   company as read from Tally this run
 * @param ctx       { baseTypeOf, onProgress? }
 * @returns {{ touchedItems: Set<string>, firstSyncCompleted: boolean, windows: number, days: number }}
 */
export async function syncVouchers(tally, company, ctx) {
  const touchedItems = new Set();
  const result = { touchedItems, firstSyncCompleted: false, windows: 0, days: 0, resynced: false };
  const collect = (r) => r.touchedItems.forEach((i) => touchedItems.add(i));

  // ── Guards ──────────────────────────────────────────────────────────────────
  if (company.altVchId === null || company.altVchId === undefined) {
    throw new Error(`AlterID not found for company "${company.name}"`);
  }
  if (company.altVchId < 0) {
    const reason = `Tally's change counter for "${company.name}" is invalid (ALTVCHID ${company.altVchId}). ` +
      "Repair (rewrite) the company data in Tally and sync again.";
    upsertCompany(company.guid, { blocked_reason: reason });
    throw new CompanyBlocked(reason);
  }

  let row = getCompany(company.guid);
  if (row.blocked_reason) row = upsertCompany(company.guid, { blocked_reason: null });
  // A company with no vouchers yet has ALTVCHID 0: nothing to read. (Biz blocks
  // on 0 too, which would block every brand-new company.) After a backup is
  // restored we may hold more vouchers than ALTVCHID; that is handled by the
  // step-back below and the deleted-voucher check, not by blocking.
  if (company.altVchId === 0) return result;

  // ── First sync ──────────────────────────────────────────────────────────────
  if (row.first_sync) {
    await firstSync(tally, company, row, ctx, result, collect);
    return result;
  }

  // ── Incremental ─────────────────────────────────────────────────────────────
  if (row.watermark === null || row.watermark === undefined) {
    logger.error(`"${company.name}": start AlterID not found; resyncing the company from scratch`);
    resetCompany(company.guid);
    upsertCompany(company.guid, { name: company.name, first_sync: 1, last_delete_sync_at: new Date().toISOString() });
    result.resynced = true;
    return result;
  }

  let w = row.watermark;
  const dropped = company.altVchId < w;
  const replacedAt = dropped ? null : await lastReadReplaced(tally, company);
  if (dropped || replacedAt) {
    const stepped = Math.max(0, Math.min(company.altVchId, w) - config.sync.restoreStepBack);
    logger.error(`"${company.name}": ` + (dropped
      ? `Tally ALTVCHID ${company.altVchId} is below our watermark ${w}`
      : `AlterID ${replacedAt} now holds a different voucher than when it was read`) +
      ` (backup restored?). Stepping back to ${stepped} to re-read recent vouchers.`);
    result.restoreDetected = true;
    w = stepped;
    // Vouchers entered after the backup no longer exist in Tally. Biz skips the
    // deleted-voucher check here ("current AlterID below last"), which leaves
    // them in the principal's data; force the check to run in this pass instead.
    // A restore also makes AlterIDs (and MasterIDs/GUIDs) repeat, so a voucher
    // entered now can reuse the GUID of one that was lost, with a lower AlterID.
    // Batches carry sync_epoch; the middleware orders by (epoch, AlterID).
    upsertCompany(company.guid, {
      watermark: w, last_deleted_alter_id: null, last_delete_sync_at: null, epoch: (row.epoch || 0) + 1,
    });
  }

  await readWindows(tally, company, w, company.altVchId, ctx, result, collect);
  return result;
}

async function readWindows(tally, company, from, to, ctx, result, collect) {
  let w = from;
  let warnedIgnored = false;
  while (w < to) {
    const end = Math.min(w + config.sync.alterIdWindow, to);
    const vouchers = await tally.fetchVouchersByAlterIdWindow(company, w, end);
    const inWindow = vouchers.filter((v) => (v.alterId ?? 0) > w && (v.alterId ?? 0) <= end);
    if (inWindow.length !== vouchers.length && !warnedIgnored) {
      warnedIgnored = true;
      logger.warn(`"${company.name}": Tally returned vouchers outside AlterID ${w}–${end}; filtering locally (slower).`);
    }
    collect(applyVouchers(company.guid, inWindow, { baseTypeOf: ctx.baseTypeOf }));
    rememberLastRead(company.guid, inWindow);
    w = end;
    upsertCompany(company.guid, { watermark: w });
    result.windows++;
  }
}

async function firstSync(tally, company, row, ctx, result, collect) {
  // AlterID when the first sync began: anything changed after this is re-read
  // by the first incremental run (Biz uses ALTVCHID − 250 at the end instead,
  // which can miss edits made during a long first sync).
  const startAlter = row.first_sync_start_alter ?? company.altVchId;
  if (row.first_sync_start_alter === null || row.first_sync_start_alter === undefined) {
    upsertCompany(company.guid, { first_sync_start_alter: startAlter });
  }

  if (row.first_sync_mode === "alterid") {
    await readWindows(tally, company, row.watermark ?? 0, startAlter, ctx, result, collect);
    upsertCompany(company.guid, { first_sync: 0, watermark: startAlter });
    result.firstSyncCompleted = true;
    return;
  }

  const start = config.sync.syncFrom || company.startingFrom || company.booksFrom;
  if (!start) throw new Error(`"${company.name}": no starting date in Tally`);
  const last = [company.lastVoucherDate, today()].filter(Boolean).sort().pop();
  let day = row.first_sync_date ? addDays(row.first_sync_date, 1) : start;
  const totalDays = Math.max(1, dayDiff(start, last) + 1);

  while (day <= last) {
    const vouchers = await tally.fetchVouchersByDay(company, day);
    const otherDays = vouchers.filter((v) => v.date && v.date !== day);
    if (otherDays.length) {
      // This Tally build ignores SVFROMDATE/SVTODATE on collections. Reading
      // day by day would re-read the whole book every day; switch to windows.
      logger.warn(`"${company.name}": Tally ignored the date filter; first sync switches to AlterID windows.`);
      upsertCompany(company.guid, { first_sync_mode: "alterid", watermark: 0 });
      await readWindows(tally, company, 0, startAlter, ctx, result, collect);
      upsertCompany(company.guid, { first_sync: 0, watermark: startAlter });
      result.firstSyncCompleted = true;
      return;
    }
    collect(applyVouchers(company.guid, vouchers, { baseTypeOf: ctx.baseTypeOf, replaceDay: day }));
    upsertCompany(company.guid, { first_sync_date: day });
    result.days++;
    ctx.onProgress?.(company, Math.round(((dayDiff(start, day) + 1) / totalDays) * 80));
    day = addDays(day, 1);
  }

  upsertCompany(company.guid, {
    first_sync: 0,
    watermark: Math.max(0, startAlter - config.sync.firstSyncOverlap),
  });
  result.firstSyncCompleted = true;
  logger.info(`"${company.name}": first sync finished (${result.days} days read)`);
}

function dayDiff(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}
