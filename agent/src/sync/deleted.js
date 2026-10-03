/**
 * deleted.js
 * ──────────
 * Finds vouchers deleted in Tally. Tally does not export deleted vouchers, so
 * absence has to be detected. Same two methods as Biz Analyst:
 *
 *  Count comparison (primary)
 *    1. Ask Tally's Statistics report for voucher counts per type for every
 *       month of the company (12 months per request).
 *    2. Compare with local counts. For each month that differs, ask for that
 *       month's daily counts in one request.
 *    3. Re-read every day that differs, replacing that day locally; vouchers
 *       Tally no longer returns are marked deleted.
 *    A day whose Tally and local counts both match those seen at its last
 *    re-read is not re-read again, so a counting difference cannot cause a loop.
 *
 *  MasterID ranges (fallback, if the Statistics report fails)
 *    Local vouchers from the last N days, 200 at a time: ask Tally which
 *    MasterIDs exist in that range; missing ones are deleted.
 *
 * Runs at most every deletedCheckIntervalMinutes, and only when ALTVCHID moved.
 */

import { config } from "../config.js";
import { logger } from "../logger.js";
import { openDb, upsertCompany, kvGet, kvSet } from "../db.js";
import { applyVouchers, localCounts, markVouchersDeleted, maxLocalDate } from "./store.js";
import { addDays } from "./vouchers.js";

const today = () => new Date().toISOString().slice(0, 10);

export function monthsBetween(from, to) {
  const out = [];
  let [y, m] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    const first = `${y}-${String(m).padStart(2, "0")}-01`;
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    out.push({ from: first < from ? from : first, to: `${y}-${String(m).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}` });
    m++;
    if (m > 12) { m = 1; y++; }
  }
  if (out.length) out[out.length - 1].to = out[out.length - 1].to > to ? to : out[out.length - 1].to;
  return out;
}

function daysOf(period) {
  const out = [];
  for (let d = period.from; d <= period.to; d = addDays(d, 1)) out.push({ from: d, to: d });
  return out;
}

function differs(tallyStats, local, types) {
  return types.some((t) => (tallyStats[t] || 0) !== (local[t] || 0));
}

export function shouldCheckDeleted(row, company, now = Date.now()) {
  if (row.first_sync) return false;
  if (row.last_deleted_alter_id === company.altVchId) return false;
  if (row.last_deleted_alter_id !== null && row.last_deleted_alter_id !== undefined && company.altVchId < row.last_deleted_alter_id) {
    logger.warn(`"${company.name}": ALTVCHID below the last deleted-voucher check; skipping this time`);
    return false;
  }
  const last = row.last_delete_sync_at ? Date.parse(row.last_delete_sync_at) : 0;
  return now - last >= config.sync.deletedCheckIntervalMinutes * 60_000;
}

/**
 * @param ctx { baseTypeOf, movementTypes: string[] } movementTypes = voucher type
 *            names whose base type moves stock (only those are compared).
 * @returns {{ touchedItems: Set<string>, method: string, daysReread: number }}
 */
export async function checkDeletedVouchers(tally, company, ctx) {
  const touchedItems = new Set();
  const result = { touchedItems, method: "counts", daysReread: 0 };
  try {
    await byCounts(tally, company, ctx, result);
  } catch (err) {
    logger.warn(`"${company.name}": count comparison failed (${err.message}); using MasterID ranges`);
    result.method = "masterid-ranges";
    await byMasterIdRanges(tally, company, result);
  }
  upsertCompany(company.guid, { last_delete_sync_at: new Date().toISOString(), last_deleted_alter_id: company.altVchId });
  return result;
}

async function byCounts(tally, company, ctx, result) {
  const start = company.startingFrom || company.booksFrom;
  const end = [today(), maxLocalDate(company.guid)].filter(Boolean).sort().pop();
  const months = monthsBetween(start, end);
  const types = ctx.movementTypes;

  const mismatchedMonths = [];
  for (let i = 0; i < months.length; i += 12) {
    const group = months.slice(i, i + 12);
    const tallyStats = await tally.fetchVoucherStatistics(company.name, group);
    const local = localCounts(company.guid, group);
    group.forEach((m, k) => { if (differs(tallyStats[k], local[k], types)) mismatchedMonths.push(m); });
  }

  for (const month of mismatchedMonths) {
    const days = daysOf(month);
    const tallyStats = await tally.fetchVoucherStatistics(company.name, days);
    const local = localCounts(company.guid, days);
    for (let k = 0; k < days.length; k++) {
      if (!differs(tallyStats[k], local[k], types)) continue;
      const day = days[k].from;
      // The remembered state is Tally's counts AND the local counts right after the
      // re-read. With Tally's counts alone, a voucher added and later deleted on an
      // already re-read day brings Tally back to the remembered counts, and the
      // stale local copy would never be re-checked (found in the field, 26-Sep).
      const signature = (localDay) => JSON.stringify(types.map((t) => [tallyStats[k][t] || 0, localDay[t] || 0]));
      if (kvGet(company.guid, `verified:${day}`) === signature(local[k])) continue;

      const vouchers = await tally.fetchVouchersByDay(company, day);
      const r = applyVouchers(company.guid, vouchers.filter((v) => v.date === day), { baseTypeOf: ctx.baseTypeOf, replaceDay: day });
      r.touchedItems.forEach((i) => result.touchedItems.add(i));
      kvSet(company.guid, `verified:${day}`, signature(localCounts(company.guid, [days[k]])[0]));
      result.daysReread++;
    }
  }
}

async function byMasterIdRanges(tally, company, result) {
  const since = addDays(today(), -config.sync.deletedFallbackDays);
  const local = openDb().prepare(
    "SELECT master_id FROM voucher WHERE company_guid = ? AND date >= ? AND is_deleted = 0 ORDER BY master_id",
  ).all(company.guid, since).map((r) => r.master_id);

  for (let i = 0; i < local.length; i += 200) {
    const chunk = local.slice(i, i + 200);
    const present = new Set((await tally.fetchVoucherIdsByMasterIdRange(company, chunk[0], chunk[chunk.length - 1])).map((v) => v.masterId));
    const gone = chunk.filter((id) => !present.has(id));
    if (gone.length) logger.info(`"${company.name}": ${gone.length} voucher(s) deleted in Tally`);
    markVouchersDeleted(company.guid, gone).forEach((it) => result.touchedItems.add(it));
  }
}
