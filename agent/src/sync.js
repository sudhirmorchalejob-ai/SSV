/**
 * sync.js
 * ───────
 * One run, for every loaded (non-group) Tally company:
 *
 *   1. Masters      — only if ALTMSTID moved: stock groups, voucher types,
 *                     ledgers, all stock items with closing stock.
 *   2. Vouchers     — first sync day by day (resumable), then AlterID windows
 *                     of 250 with the restore / corruption guards.
 *   3. Deleted      — count comparison over the whole period, per-day re-read
 *                     of days that differ (at most hourly, only if ALTVCHID moved).
 *   4. Stock        — closing stock (total and per godown) for items in changed
 *                     vouchers only; all items once a day and after an upgrade.
 *   5. Upload       — pending rows to the middleware, per principal, ≤ 5 MB each.
 *   6. Run report   — a signed heartbeat: ok, or what went wrong (control.js).
 *
 * Tally access is passed in, so tests can run the whole cycle on a fake Tally.
 */

import * as realTally from "./tally/index.js";
import { logger } from "./logger.js";
import { getCompany, upsertCompany, kvGet, kvSet } from "./db.js";
import { voucherBaseTypes, ancestryIndex } from "./tally/masters.js";
import { buildItemClassifier, MOVEMENT_BASE_TYPES } from "./principals.js";
import { loadRules } from "./rules.js";
import { sendHeartbeat } from "./control.js";
import { syncVouchers, CompanyBlocked } from "./sync/vouchers.js";
import { shouldCheckDeleted, checkDeletedVouchers } from "./sync/deleted.js";
import { refreshMasters, refreshStock } from "./sync/stock.js";
import { allStockItems } from "./sync/store.js";
import { uploadCompany, uploadControlTotals, pendingCounts, AGENT_VERSION } from "./upload.js";
import { config } from "./config.js";

const today = () => new Date().toISOString().slice(0, 10);

let running = false;
let lastRun = null;
const progress = {};

export function status() {
  return { running, progress, lastRun, ...pendingCounts() };
}

export async function runSync({ trigger = "schedule", tally = realTally, only } = {}) {
  if (running) return { skipped: true, reason: "a sync is already running" };
  running = true;
  const report = { trigger, started: new Date().toISOString(), companies: [], warnings: [] };

  try {
    const ping = await tally.pingTally();
    if (!ping.connected) throw new Error(ping.error);

    const { rules, source } = await loadRules();
    report.rulesSource = source;
    if (!rules.length) report.warnings.push("No principal rules configured: data is read but nothing is uploaded.");

    let companies = await tally.fetchCompanies();
    if (only?.length) companies = companies.filter((c) => only.includes(c.name));
    if (!companies.length) {
      throw new Error("No company is open in TallyPrime. Open the distributor's company (Alt+F3 → Select Company), " +
        "or put its exact name in TALLY_COMPANY in .env so the agent can load it.");
    }

    for (const company of companies) {
      try {
        report.companies.push(await syncCompany(tally, company, rules, report.warnings));
      } catch (err) {
        const blocked = err instanceof CompanyBlocked;
        (blocked ? logger.warn : logger.error)(`"${company.name}": ${err.message}`);
        report.companies.push({ company: company.name, [blocked ? "blocked" : "error"]: err.message });
      }
    }
  } catch (err) {
    report.error = err.message;
    logger.error(`Sync aborted: ${err.message}`);
  } finally {
    report.finished = new Date().toISOString();
    lastRun = report;
    running = false;
  }
  await sendHeartbeat(report);
  return report;
}

async function syncCompany(tally, company, rules, warnings) {
  const period = {
    fromDate: company.startingFrom || company.booksFrom,
    // Include post-dated vouchers.
    toDate: [company.lastVoucherDate, addYear(today())].filter(Boolean).sort().pop(),
  };
  const c = { ...company, ...period };

  let row = getCompany(c.guid);
  if (!row) {
    // Like Biz, start the deleted-voucher timer now so the first check waits one interval.
    row = upsertCompany(c.guid, { name: c.name, first_sync: 1, last_delete_sync_at: new Date().toISOString() });
  } else if (row.name !== c.name) {
    row = upsertCompany(c.guid, { name: c.name });
  }
  const out = { company: c.name };

  // 1. Masters
  const masters = await refreshMasters(tally, c, row);
  const baseTypes = voucherBaseTypes(masters.voucherTypes);
  const baseTypeOf = (t) => baseTypes.get(t);
  const movementTypes = masters.voucherTypes
    .filter((t) => MOVEMENT_BASE_TYPES.has(baseTypes.get(t.name)))
    .map((t) => t.name);
  out.mastersRefreshed = masters.changed;

  // 2. Vouchers
  const v = await syncVouchers(tally, c, {
    baseTypeOf,
    onProgress: (co, pct) => { progress[co.name] = pct; },
  });
  const touched = new Set(v.touchedItems);
  Object.assign(out, { firstSyncCompleted: v.firstSyncCompleted, daysRead: v.days, windowsRead: v.windows, resynced: v.resynced,
    ...(v.restoreDetected ? { restoreDetected: true } : {}) });
  if (v.firstSyncCompleted) progress[c.name] = 80;

  // 3. Deleted vouchers
  row = getCompany(c.guid);
  if (shouldCheckDeleted(row, c)) {
    const d = await checkDeletedVouchers(tally, c, { baseTypeOf, movementTypes });
    d.touchedItems.forEach((i) => touched.add(i));
    out.deletedCheck = { method: d.method, daysReread: d.daysReread };
  }

  // 4. Stock
  // A new agent version may send new item fields (0.3.0: godowns), so its first
  // run sends a full snapshot rather than waiting for tomorrow's.
  row = getCompany(c.guid);
  const upgraded = kvGet(c.guid, "snapshotAgentVersion") !== AGENT_VERSION;
  const fullSnapshot = row.last_full_snapshot !== today() || v.firstSyncCompleted || upgraded;
  const stock = await refreshStock(tally, c, touched, {
    fullSnapshot,
    freshItems: touched.size ? null : masters.items,
  });
  if (fullSnapshot) kvSet(c.guid, "snapshotAgentVersion", AGENT_VERSION);
  out.stock = stock.mode;

  upsertCompany(c.guid, { alt_vch_id: c.altVchId, alt_mst_id: c.altMstId });

  // 5. Upload (skipped while the first sync is still running, as Biz does)
  row = getCompany(c.guid);
  if (row.first_sync) {
    out.upload = { skipped: "first sync in progress" };
    return out;
  }
  const items = allStockItems(c.guid);
  const { principalOf, principalsOf, conflicts } = buildItemClassifier(rules, items, masters.stockGroups);
  for (const k of conflicts) warnings.push(`${c.name}: item "${k.item}" matches ${k.principals.join(", ")}; sent to ${k.chosen} only.`);
  const groups = ancestryIndex(masters.stockGroups);
  // Top group first. Copy before reversing: chain() returns a cached array, and
  // reversing it in place flipped every second path (seen as "Ceat Truck Tyre > Ceat Tyre").
  out.upload = await uploadCompany(c, { principalOf, principalsOf, baseTypeOf, groupPathOf: (g) => [...groups.chain(g)].reverse() });

  // 6. Reconciliation totals: once a day, and straight after a restore or resync
  const lastTotals = kvGet(c.guid, "controlTotalsSentAt");
  const due = v.firstSyncCompleted || v.resynced || v.restoreDetected || !lastTotals ||
    Date.now() - Date.parse(lastTotals) >= config.upload.reconcileEveryHours * 3600e3;
  if (due && !out.upload.error) {
    try {
      out.reconcile = await uploadControlTotals(c, { principalOf, principalsOf, principals: rules.map((r) => r.code) });
      if (!out.reconcile.skipped) kvSet(c.guid, "controlTotalsSentAt", new Date().toISOString());
    } catch (err) {
      out.reconcile = { error: err.message };
    }
  }
  if (v.firstSyncCompleted) progress[c.name] = 100;
  return out;
}

function addYear(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d.toISOString().slice(0, 10);
}
