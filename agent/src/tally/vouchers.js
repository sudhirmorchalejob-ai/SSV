/**
 * vouchers.js
 * â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
 * Voucher extraction for secondary-sales visibility.
 *
 * Reads follow Biz Analyst's connector: one day at a time for the first sync,
 * bounded AlterID windows ($AlterID > a AND $AlterID <= b) afterwards, and
 * MasterID ranges for the fallback deleted-voucher check.
 *
 * Changes from the Tally-ERPNext Middleware parser:
 *   • Quantity and amount keep their meaning: zero stays zero, and each line
 *     carries a stock direction (in/out), so credit notes net off sales.
 *   • Every godown/batch allocation is kept, not just the first.
 *   • MASTERID is kept. It never changes for a voucher, even when the voucher
 *     number is edited, so it is a safer identity than the voucher number.
 */

import { exportCollection } from "./client.js";
import { val, list, yes, parseSigned, parseQty, parseNumber, parseUnit, tallyDateToISO } from "./xml.js";

const VOUCHER_FETCH = [
  "GUID,MASTERID,ALTERID,DATE,VOUCHERNUMBER,VOUCHERTYPENAME,PARTYLEDGERNAME,REFERENCE",
  "ISCANCELLED,ISOPTIONAL,ISDELETED,ISINVOICE,ISPOSTDATED",
  "ALLLEDGERENTRIES.LIST,LEDGERENTRIES.LIST",
  "ALLINVENTORYENTRIES.LIST,ALLINVENTORYENTRIES.LIST.BATCHALLOCATIONS.LIST",
  "INVENTORYENTRIES.LIST,INVENTORYENTRIES.LIST.BATCHALLOCATIONS.LIST",
  "INVENTORYENTRIESIN.LIST,INVENTORYENTRIESIN.LIST.BATCHALLOCATIONS.LIST",
  "INVENTORYENTRIESOUT.LIST,INVENTORYENTRIESOUT.LIST.BATCHALLOCATIONS.LIST",
].join(",");

/**
 * Stock direction of an inventory entry.
 * Tally marks the debit side ISDEEMEDPOSITIVE=Yes: goods coming in (purchase,
 * credit note / sales return). Credit side = goods going out (sale, debit note).
 * Stock journals put the sides in separate IN/OUT lists.
 */
function direction(entry, listName) {
  if (listName === "INVENTORYENTRIESIN.LIST") return "in";
  if (listName === "INVENTORYENTRIESOUT.LIST") return "out";
  const flag = val(entry.ISDEEMEDPOSITIVE);
  if (flag === "Yes") return "in";
  if (flag === "No") return "out";
  // No flag: Tally writes debit amounts as negative numbers.
  return parseSigned(val(entry.AMOUNT)) < 0 ? "in" : "out";
}

/**
 * Tally's tracking number links an invoice line to the delivery note (or receipt
 * note) that already moved the stock. Such a line is a sale for reporting but not
 * a second stock movement. "Not Applicable" means untracked.
 */
function trackingOf(a) {
  const t = val(a.TRACKINGNUMBER);
  return t && t.toLowerCase() !== "not applicable" ? t : null;
}

function parseAllocation(a) {
  return {
    godown: val(a.GODOWNNAME) || null,
    batch: val(a.BATCHNAME) || null,
    qty: parseQty(val(a.ACTUALQTY) ?? val(a.BILLEDQTY)),
    billedQty: parseQty(val(a.BILLEDQTY) ?? val(a.ACTUALQTY)),
    amount: Math.abs(parseSigned(val(a.AMOUNT))),
    mfgDate: tallyDateToISO(val(a.MFDON)),
    expiry: val(a.EXPIRYPERIOD) || null,
    trackingNumber: trackingOf(a),
  };
}

function parseInventoryEntry(ie, listName) {
  const item = val(ie.STOCKITEMNAME) || val(ie.NAME);
  if (!item) return null;

  const actualRaw = val(ie.ACTUALQTY);
  const billedRaw = val(ie.BILLEDQTY);
  const qty = parseQty(actualRaw ?? billedRaw);
  const billedQty = parseQty(billedRaw ?? actualRaw);
  const amount = Math.abs(parseSigned(val(ie.AMOUNT)));
  const rate = Math.abs(parseNumber(val(ie.RATE)) ?? (billedQty ? amount / billedQty : 0));
  const allocations = list(ie["BATCHALLOCATIONS.LIST"]).map(parseAllocation);

  return {
    item,
    direction: direction(ie, listName),
    qty,             // physical movement, e.g. includes free goods
    billedQty,       // quantity charged on the bill
    unit: parseUnit(actualRaw ?? billedRaw),
    rate,
    amount,
    discountPct: parseNumber(val(ie.DISCOUNT)) ?? 0,
    // True when the stock already moved on a delivery / receipt note.
    tracked: allocations.some((a) => a.trackingNumber),
    // One line can span several godowns / batches; keep them all.
    allocations: allocations.length
      ? allocations
      : [{ godown: val(ie.GODOWNNAME) || null, batch: val(ie.BATCHNAME) || null, qty, billedQty, amount, mfgDate: null, expiry: null, trackingNumber: null }],
  };
}

/** Pure parser for one VOUCHER node (explicitArray:false). Exported for tests. */
export function parseVoucher(v) {
  const guid = v.$?.REMOTEID || val(v.GUID);
  const partyLedger = val(v.PARTYLEDGERNAME) || null;

  const ledgerEntries = [...list(v["ALLLEDGERENTRIES.LIST"]), ...list(v["LEDGERENTRIES.LIST"])];
  const partyEntry = partyLedger ? ledgerEntries.find((e) => val(e?.LEDGERNAME) === partyLedger) : null;

  // Tally exports the same lines in several lists; merging them double-counts.
  // Use ALLINVENTORYENTRIES when present, otherwise INVENTORYENTRIES, and the
  // separate IN/OUT lists only when neither has lines. TallyPrime puts a stock
  // journal's lines in ALLINVENTORYENTRIES (direction by ISDEEMEDPOSITIVE) and
  // again in the IN/OUT lists (seen on a real stock transfer, 26-Sep).
  const has = (name) => list(v[name]).some((ie) => ie && typeof ie === "object");
  const listNames = has("ALLINVENTORYENTRIES.LIST") ? ["ALLINVENTORYENTRIES.LIST"]
    : has("INVENTORYENTRIES.LIST") ? ["INVENTORYENTRIES.LIST"]
    : ["INVENTORYENTRIESIN.LIST", "INVENTORYENTRIESOUT.LIST"];
  const lines = [];
  for (const listName of listNames) {
    for (const ie of list(v[listName])) {
      if (ie && typeof ie === "object") {
        const line = parseInventoryEntry(ie, listName);
        if (line) lines.push(line);
      }
    }
  }

  return {
    guid,
    masterId: parseNumber(val(v.MASTERID)),
    alterId: parseNumber(val(v.ALTERID)),
    date: tallyDateToISO(val(v.DATE)),
    voucherType: val(v.VOUCHERTYPENAME) || v.$?.VCHTYPE || null,
    voucherNumber: val(v.VOUCHERNUMBER) || null,
    reference: val(v.REFERENCE) || null,
    partyLedger,
    // Signed, as Tally stores it: negative = party debited (a sale on credit).
    partyAmount: partyEntry ? parseSigned(val(partyEntry.AMOUNT)) : null,
    isCancelled: yes(v.ISCANCELLED),
    isOptional: yes(v.ISOPTIONAL),
    isDeleted: yes(v.ISDELETED),
    isPostDated: yes(v.ISPOSTDATED),
    isInvoice: yes(v.ISINVOICE),
    lines,
  };
}

/** Company period used on every voucher request, so Tally searches all dates. */
function period(company) {
  return { fromDate: company.fromDate, toDate: company.toDate };
}

/**
 * Vouchers with start < AlterID <= end. Both ends are bounded so each response
 * stays small however large the backlog (Biz reads windows of 250).
 * @param {{name: string, fromDate: string, toDate: string}} company
 */
export async function fetchVouchersByAlterIdWindow(company, start, end) {
  const rows = await exportCollection(
    {
      name: "SSVVouchersByAlterId",
      type: "Voucher",
      fetch: VOUCHER_FETCH,
      company: company.name,
      ...period(company),
      filters: [`$AlterID > ${Math.floor(start)} AND $AlterID <= ${Math.floor(end)}`],
    },
    "VOUCHER",
  );
  return rows.map(parseVoucher);
}

/** All vouchers dated `day` (ISO). Used by the first sync and by deleted-voucher re-reads. */
export async function fetchVouchersByDay(company, day) {
  const rows = await exportCollection(
    { name: "SSVVouchersByDay", type: "Voucher", fetch: VOUCHER_FETCH, company: company.name, fromDate: day, toDate: day },
    "VOUCHER",
  );
  return rows.map(parseVoucher);
}

/**
 * Voucher identities only (no lines), optionally filtered by TDL formulae and
 * dates. Cheap enough to list a whole company; used by the deleted-voucher
 * fallback and by --probe.
 */
export async function fetchVoucherIds(company, { filters = [], fromDate, toDate } = {}) {
  const rows = await exportCollection(
    {
      name: "SSVVoucherIds",
      type: "Voucher",
      fetch: "MASTERID,ALTERID,DATE,VOUCHERTYPENAME,VOUCHERNUMBER,ISOPTIONAL,ISCANCELLED",
      company: company.name,
      fromDate: fromDate ?? company.fromDate,
      toDate: toDate ?? company.toDate,
      filters,
    },
    "VOUCHER",
  );
  return rows.map((v) => ({
    masterId: parseNumber(val(v.MASTERID)),
    alterId: parseNumber(val(v.ALTERID)),
    date: tallyDateToISO(val(v.DATE)),
    voucherType: val(v.VOUCHERTYPENAME) || v.$?.VCHTYPE || null,
    voucherNumber: val(v.VOUCHERNUMBER) || null,
    isOptional: yes(v.ISOPTIONAL),
    isCancelled: yes(v.ISCANCELLED),
  })).filter((v) => v.masterId !== null);
}

/** Identities of vouchers with from <= MasterID <= to (fallback deleted-voucher check). */
export async function fetchVoucherIdsByMasterIdRange(company, from, to) {
  return fetchVoucherIds(company, { filters: [`$MasterID >= ${Math.floor(from)} AND $MasterID <= ${Math.floor(to)}`] });
}

