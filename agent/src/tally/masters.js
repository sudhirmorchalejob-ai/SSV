/**
 * masters.js
 * ──────────
 * Only the masters the visibility platform needs: stock groups, stock
 * categories, stock items, godowns, voucher types, account groups and party
 * ledgers (retailers). GSTIN / state / pincode lookups are carried over from
 * the Tally-ERPNext Middleware, where they were tuned against several
 * TallyPrime builds.
 */

import { exportCollection } from "./client.js";
import { logger } from "../logger.js";
import { val, list, masterName, parseNumber, cleanVal } from "./xml.js";

// Tally's 28 predefined account groups and 24 voucher types are their own parents.
const PRIMARY = "Primary";

function alterId(node) {
  return parseNumber(val(node.ALTERID));
}

export async function fetchStockGroups(company) {
  const rows = await exportCollection(
    { name: "SSVStockGroups", type: "Stock Group", fetch: "NAME,GUID,PARENT,ALTERID", company },
    "STOCKGROUP", "STOCK-GROUP",
  );
  return rows.map((g) => ({
    name: masterName(g),
    guid: val(g.GUID),
    parent: val(g.PARENT) || PRIMARY,
    alterId: alterId(g),
  })).filter((g) => g.name);
}

export async function fetchStockCategories(company) {
  const rows = await exportCollection(
    { name: "SSVStockCategories", type: "Stock Category", fetch: "NAME,GUID,PARENT", company },
    "STOCKCATEGORY", "STOCK-CATEGORY",
  );
  return rows.map((c) => ({ name: masterName(c), guid: val(c.GUID), parent: val(c.PARENT) || PRIMARY }))
    .filter((c) => c.name);
}

/**
 * Stock items. Opening/closing figures are for the SVFROMDATE–SVTODATE period,
 * so passing asOfDate as toDate gives the closing position on that date.
 */
const STOCK_ITEM_FETCH = [
  "NAME,GUID,MASTERID,ALTERID,PARENT,CATEGORY,BASEUNITS,PARTNO",
  "HSNDETAILS.LIST.HSNCODE,HSNDETAILS.LIST.GSTRATE",
  "OPENINGBALANCE,OPENINGVALUE,CLOSINGBALANCE,CLOSINGVALUE",
].join(",");

export async function fetchStockItems(company, { fromDate, asOfDate } = {}) {
  const rows = await exportCollection(
    { name: "SSVStockItems", type: "Stock Item", fetch: STOCK_ITEM_FETCH, company, fromDate, toDate: asOfDate },
    "STOCKITEM", "STOCK-ITEM",
  );
  return withGodowns(company, rows.map(parseStockItem).filter((s) => s.name), { fromDate, asOfDate });
}

/** Only the given items (by MASTERID); callers send ≤ 50 ids per request, as Biz does. */
export async function fetchStockItemsByMasterIds(company, masterIds, { fromDate, asOfDate } = {}) {
  if (!masterIds.length) return [];
  const rows = await exportCollection(
    {
      name: "SSVStockItemsById",
      type: "Stock Item",
      fetch: STOCK_ITEM_FETCH,
      company,
      fromDate,
      toDate: asOfDate,
      filters: [masterIds.map((id) => `$MasterID = ${Math.floor(id)}`).join(" OR ")],
    },
    "STOCKITEM", "STOCK-ITEM",
  );
  return withGodowns(company, rows.map(parseStockItem).filter((s) => s.name), { fromDate, asOfDate });
}

// ── Closing stock per godown ──────────────────────────────────────────────────
//
// Tally's own figure, not a calculation: the Batch collection of a stock item
// (CHILDOF the item) has one object per batch and godown, with closing figures
// for the SVFROMDATE–SVTODATE period. Items without batch tracking still have
// one "Primary Batch" per godown. Up to 50 items per request (a union of one
// CHILDOF collection per item), as for closing stock by MasterID.

const GODOWN_ITEMS_PER_REQUEST = 50;
let godownReadFailed = false;

/** Batch rows → per item, per godown totals (batches summed; empty godowns dropped). */
export function godownTotals(batchRows) {
  const byItem = new Map();
  for (const b of batchRows) {
    const item = val(b.PARENT);
    if (!item) continue;
    const godown = val(b.GODOWNNAME) || PRIMARY_GODOWN;
    if (!byItem.has(item)) byItem.set(item, new Map());
    const g = byItem.get(item);
    const cur = g.get(godown) || { godown, qty: 0, value: 0 };
    cur.qty += parseNumber(val(b.CLOSINGBALANCE)) ?? 0;
    cur.value += parseNumber(val(b.CLOSINGVALUE)) ?? 0;
    g.set(godown, cur);
  }
  const out = new Map();
  for (const [item, g] of byItem) {
    out.set(item, [...g.values()]
      .filter((x) => x.qty !== 0 || x.value !== 0)
      .map((x) => ({ godown: x.godown, qty: round(x.qty), value: round(x.value) }))
      .sort((a, b) => a.godown.localeCompare(b.godown)));
  }
  return out;
}
const PRIMARY_GODOWN = "Main Location";
const round = (n) => Math.round(n * 1000) / 1000;

export async function fetchGodownClosings(company, itemNames, { fromDate, asOfDate } = {}) {
  const names = itemNames.filter((n) => !n.includes('"'));
  const out = new Map(names.map((n) => [n, []]));
  for (let i = 0; i < names.length; i += GODOWN_ITEMS_PER_REQUEST) {
    const rows = await exportCollection({
      name: "SSVGodownStock", type: "Batch", company, fromDate, toDate: asOfDate,
      fetch: "NAME,PARENT,GODOWNNAME,CLOSINGBALANCE,CLOSINGVALUE",
      childOf: names.slice(i, i + GODOWN_ITEMS_PER_REQUEST),
    }, "BATCH");
    for (const [item, godowns] of godownTotals(rows)) if (out.has(item)) out.set(item, godowns);
  }
  return out;
}

/**
 * Add `godowns` to each item. An item whose godown split could not be read
 * (a name with a double quote, or a Tally that refuses the request) is sent
 * without the field, and the middleware keeps showing its total only.
 */
async function withGodowns(company, items, period) {
  if (!items.length) return items;
  let byItem;
  try {
    byItem = await fetchGodownClosings(company, items.map((i) => i.name), period);
  } catch (err) {
    if (!godownReadFailed) logger.warn(`Godown-wise closing stock not available: ${err.message}. Totals are still sent.`);
    godownReadFailed = true;
    return items;
  }
  return items.map((it) => (byItem.has(it.name) ? { ...it, godowns: byItem.get(it.name) } : it));
}

function parseStockItem(s) {
  const hsn = list(s["HSNDETAILS.LIST"])[0] || {};
  return {
    name: masterName(s),
    guid: val(s.GUID),
    masterId: parseNumber(val(s.MASTERID)),
    alterId: alterId(s),
    group: val(s.PARENT) || PRIMARY,
    category: val(s.CATEGORY) || null,
    baseUnit: val(s.BASEUNITS) || null,
    partNo: val(s.PARTNO) || null,
    hsnCode: val(hsn.HSNCODE) || val(s.HSNCODE) || null,
    gstRate: parseNumber(val(hsn.GSTRATE)),
    // Signed: Tally reports negative closing stock (seen in the deck, s20), keep it.
    openingQty: parseNumber(val(s.OPENINGBALANCE)) ?? 0,
    openingValue: parseNumber(val(s.OPENINGVALUE)) ?? 0,
    closingQty: parseNumber(val(s.CLOSINGBALANCE)) ?? 0,
    closingValue: parseNumber(val(s.CLOSINGVALUE)) ?? 0,
  };
}

export async function fetchGodowns(company) {
  const rows = await exportCollection(
    { name: "SSVGodowns", type: "Godown", fetch: "NAME,GUID,PARENT,ALTERID", company },
    "GODOWN",
  );
  return rows.map((g) => ({ name: masterName(g), guid: val(g.GUID), parent: val(g.PARENT) || PRIMARY, alterId: alterId(g) }))
    .filter((g) => g.name);
}

export async function fetchVoucherTypes(company) {
  const rows = await exportCollection(
    { name: "SSVVoucherTypes", type: "Voucher Type", fetch: "NAME,GUID,PARENT,ISOPTIONAL", company },
    "VOUCHERTYPE", "VOUCHER-TYPE",
  );
  return rows.map((v) => ({ name: masterName(v), guid: val(v.GUID), parent: val(v.PARENT) || null, isOptional: val(v.ISOPTIONAL) === "Yes" }))
    .filter((v) => v.name);
}

export async function fetchAccountGroups(company) {
  const rows = await exportCollection(
    { name: "SSVGroups", type: "Group", fetch: "NAME,GUID,PARENT", company },
    "GROUP",
  );
  return rows.map((g) => ({ name: masterName(g), guid: val(g.GUID), parent: val(g.PARENT) || PRIMARY }))
    .filter((g) => g.name);
}

// ── Party ledgers ─────────────────────────────────────────────────────────────

function firstGstin(l) {
  const direct = val(l.PARTYGSTIN);
  if (direct && direct.length > 5) return direct;
  for (const reg of list(l["LEDGSTREGDETAILS.LIST"])) {
    for (const li of [...list(reg?.LIST), reg]) {
      const v = val(li?.GSTIN) || val(li?.GSTREGISTRATIONNUMBER);
      if (v && v.length > 5) return v;
    }
  }
  return null;
}

function firstFromMailing(l, ...keys) {
  const candidates = keys.map((k) => val(l[k]));
  for (const m of list(l["MAILINGDETAILS.LIST"] || l.MAILINGDETAILS)) {
    if (m && typeof m === "object") candidates.push(...keys.map((k) => val(m[k])));
  }
  for (const c of candidates) {
    const clean = cleanVal(String(c || "")).replace(/[♦◆⊗*]/g, "").trim();
    if (clean && clean.length > 1 && clean.toLowerCase() !== "not applicable") return clean;
  }
  return null;
}

function address(l) {
  const lines = [];
  for (const m of list(l["MAILINGDETAILS.LIST"] || l.MAILINGDETAILS)) {
    for (const a of list(m?.["ADDRESS.LIST"]?.ADDRESS ?? m?.ADDRESS)) lines.push(val(a));
  }
  for (const a of list(l["ADDRESS.LIST"]?.ADDRESS ?? l["ADDRESS.LIST"])) lines.push(val(a));
  return lines.filter(Boolean).join(", ") || null;
}

function phone(l) {
  const raw = [val(l.LEDGERMOBILE), val(l.LEDGERPHONE)].filter(Boolean).join(" ");
  const m = raw.match(/\b[6-9]\d{9}\b/);
  return m ? m[0] : null;
}

/** All ledgers with the fields a retailer record needs. Filter by group with isUnderGroup(). */
export async function fetchPartyLedgers(company) {
  const rows = await exportCollection(
    {
      name: "SSVLedgers",
      type: "Ledger",
      fetch: [
        "NAME,GUID,MASTERID,ALTERID,PARENT",
        "PARTYGSTIN,LEDGSTREGDETAILS.LIST,LEDGERMOBILE,LEDGERPHONE,STATENAME,LEDSTATENAME,PINCODE",
        "MAILINGDETAILS.LIST,ADDRESS.LIST,PRICELEVEL",
      ].join(","),
      company,
    },
    "LEDGER",
  );
  return rows.map((l) => ({
    name: masterName(l),
    guid: val(l.GUID),
    masterId: parseNumber(val(l.MASTERID)),
    alterId: alterId(l),
    group: val(l.PARENT) || null,
    gstin: firstGstin(l),
    phone: phone(l),
    state: firstFromMailing(l, "STATENAME", "LEDSTATENAME", "STATE"),
    pincode: firstFromMailing(l, "PINCODE"),
    address: address(l),
    priceLevel: val(l.PRICELEVEL) || null,
  })).filter((l) => l.name);
}

// ── Tree helpers ──────────────────────────────────────────────────────────────

/** Map of name → [name, parent, grandparent, …] up to (not including) Primary. */
export function ancestryIndex(nodes) {
  const parentOf = new Map(nodes.map((n) => [n.name, n.parent]));
  const cache = new Map();
  const chain = (name) => {
    if (cache.has(name)) return cache.get(name);
    const out = [];
    const seen = new Set();
    let cur = name;
    while (cur && cur !== PRIMARY && !seen.has(cur)) {
      out.push(cur);
      seen.add(cur);
      cur = parentOf.get(cur);
    }
    cache.set(name, out);
    return out;
  };
  return { chain };
}

export function isUnderGroup(index, name, group) {
  return index.chain(name).includes(group);
}

/**
 * Resolve each voucher type to its predefined base type (Sales, Credit Note, …).
 * Custom types such as "GST Sales" chain up through PARENT to a predefined one,
 * which is its own parent.
 */
export function voucherBaseTypes(types) {
  const parentOf = new Map(types.map((t) => [t.name, t.parent]));
  const base = new Map();
  for (const t of types) {
    let cur = t.name;
    const seen = new Set();
    while (parentOf.get(cur) && parentOf.get(cur) !== cur && !seen.has(cur)) {
      seen.add(cur);
      cur = parentOf.get(cur);
    }
    base.set(t.name, cur);
  }
  return base;
}
