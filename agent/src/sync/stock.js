/**
 * stock.js (sync)
 * ───────────────
 * Masters and closing stock.
 *
 *  Masters are re-read only when Tally's ALTMSTID moved: stock groups, voucher
 *  types and party ledgers go to the local cache, and every stock item is read
 *  with its closing figures.
 *
 *  Closing stock after voucher changes follows Biz: re-read only the items used
 *  in the changed vouchers, 50 per request, by MASTERID. If an item is not
 *  known locally, re-read all items.
 *
 *  Once a day every item is queued again, so the middleware gets a full
 *  closing-stock snapshot per day.
 */

import { config } from "../config.js";
import { logger } from "../logger.js";
import { upsertCompany, kvGet, kvSet } from "../db.js";
import { applyStockItems, applyParties, stockItemIdsByName } from "./store.js";

const today = () => new Date().toISOString().slice(0, 10);

function stockPeriod(company) {
  return { fromDate: company.startingFrom || company.booksFrom, asOfDate: today() };
}

/** @returns {{ changed: boolean, stockGroups: object[], voucherTypes: object[], items: object[]|null }} */
export async function refreshMasters(tally, company, row) {
  const cachedGroups = kvGet(company.guid, "stockGroups");
  const cachedTypes = kvGet(company.guid, "voucherTypes");
  if (row.masters_alt_mst_id === company.altMstId && cachedGroups && cachedTypes) {
    return { changed: false, stockGroups: cachedGroups, voucherTypes: cachedTypes, items: null, changedParties: [] };
  }

  const stockGroups = await tally.fetchStockGroups(company.name);
  const voucherTypes = await tally.fetchVoucherTypes(company.name);
  const parties = await tally.fetchPartyLedgers(company.name);
  const items = await tally.fetchStockItems(company.name, stockPeriod(company));

  kvSet(company.guid, "stockGroups", stockGroups);
  kvSet(company.guid, "voucherTypes", voucherTypes);
  const changedParties = applyParties(company.guid, parties);
  const changedItems = applyStockItems(company.guid, items);
  upsertCompany(company.guid, { masters_alt_mst_id: company.altMstId });
  logger.info(`"${company.name}": masters refreshed (${items.length} items, ${changedItems} changed, ${parties.length} ledgers)`);
  return { changed: true, stockGroups, voucherTypes, items, changedParties };
}

/**
 * Refresh closing stock.
 * @param {Set<string>} touchedItems  item names in vouchers changed this run
 * @param {object} o
 * @param {boolean} o.fullSnapshot    queue every item (first run of the day)
 * @param {object[]|null} o.freshItems all items, if refreshMasters read them after the vouchers
 */
export async function refreshStock(tally, company, touchedItems, { fullSnapshot = false, freshItems = null } = {}) {
  const period = stockPeriod(company);

  if (fullSnapshot) {
    const items = freshItems || (await tally.fetchStockItems(company.name, period));
    applyStockItems(company.guid, items, { forcePending: true });
    upsertCompany(company.guid, { last_full_snapshot: today() });
    return { mode: "full" };
  }

  if (!touchedItems.size) return { mode: "none" };

  const { ids, missing } = stockItemIdsByName(company.guid, [...touchedItems]);
  if (missing.length) {
    logger.info(`"${company.name}": ${missing.length} item(s) not known locally; re-reading closing stock for all items`);
    applyStockItems(company.guid, await tally.fetchStockItems(company.name, period));
    return { mode: "all-items" };
  }
  for (let i = 0; i < ids.length; i += config.sync.stockItemsPerRequest) {
    const batch = ids.slice(i, i + config.sync.stockItemsPerRequest);
    applyStockItems(company.guid, await tally.fetchStockItemsByMasterIds(company.name, batch, period));
  }
  return { mode: "touched", items: ids.length };
}
