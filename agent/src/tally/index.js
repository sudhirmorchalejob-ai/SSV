// Everything the sync needs from Tally, in one place so tests can swap in a fake.
export { pingTally, fetchCompanies, fetchVoucherStatistics } from "./client.js";
export { fetchVouchersByAlterIdWindow, fetchVouchersByDay, fetchVoucherIdsByMasterIdRange } from "./vouchers.js";
export { fetchStockGroups, fetchStockItems, fetchStockItemsByMasterIds, fetchVoucherTypes, fetchPartyLedgers } from "./masters.js";
