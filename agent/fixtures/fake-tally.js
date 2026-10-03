/**
 * In-memory TallyPrime for sync tests. Behaves like Tally where it matters:
 * every create / edit / delete raises ALTVCHID, edits give the voucher a new
 * AlterID, MasterIDs never change, deleted vouchers simply disappear, and the
 * Statistics report counts vouchers per type excluding cancelled/optional.
 */

const clone = (o) => JSON.parse(JSON.stringify(o));
let companySeq = 0;

export const ITEMS = [
  { masterId: 1, name: "Dant Kanti 100g", group: "Patanjali Oral Care", category: null, baseUnit: "Nos", openingQty: 500 },
  { masterId: 2, name: "Dant Kanti Sample 20g", group: "Unbranded", category: "Patanjali Samples", baseUnit: "Nos", openingQty: 100 },
  { masterId: 3, name: "Colgate Strong Teeth 200g", group: "Colgate Palmolive", category: null, baseUnit: "Nos", openingQty: 300 },
  { masterId: 4, name: "Loose Rice 1kg", group: "Unbranded", category: null, baseUnit: "Kg", openingQty: 1000 },
];

export function line(item, qty, rate, direction = "out") {
  return {
    item, direction, qty, billedQty: qty, unit: "Nos", rate, amount: qty * rate, discountPct: 0,
    allocations: [{ godown: "Main Location", batch: null, qty, billedQty: qty, amount: qty * rate, mfgDate: null, expiry: null }],
  };
}

export class FakeTally {
  constructor({ startingFrom = "2026-09-01" } = {}) {
    companySeq++;
    this.company = { name: `Test Distributor ${companySeq}`, guid: `co-guid-${companySeq}-${Date.now()}`, startingFrom, booksFrom: startingFrom };
    this.alt = 0;
    this.mst = 10;
    this.nextMasterId = 1000;
    this.vouchers = new Map();
    this.calls = {};
    this.windows = [];
    this.itemIdRequests = [];
    this.ignoreDateFilter = false;
    this.statsFail = false;
    this.failOnDay = null;
    this.stockGroups = [
      { name: "Patanjali", parent: "Primary" },
      { name: "Patanjali Oral Care", parent: "Patanjali" },
      { name: "Colgate Palmolive", parent: "Primary" },
      { name: "Unbranded", parent: "Primary" },
    ];
    this.voucherTypes = [
      { name: "Sales", parent: "Sales" },
      { name: "GST Sales", parent: "Sales" },
      { name: "Credit Note", parent: "Credit Note" },
      { name: "Payment", parent: "Payment" },
      { name: "Sales Order", parent: "Sales Order" },
      { name: "Stock Journal", parent: "Stock Journal" },
    ];
    this.parties = [
      { name: "Sharma Kirana Store", guid: "p1", group: "Sundry Debtors", gstin: "27ABCDE1234F1Z5", phone: "9876543210", state: "Maharashtra", pincode: "411001" },
      { name: "Gupta General Store", guid: "p2", group: "Sundry Debtors", gstin: null, phone: null, state: "Maharashtra", pincode: "411002" },
    ];
  }

  _count(n) { this.calls[n] = (this.calls[n] || 0) + 1; }

  // ── changes a user makes in Tally ───────────────────────────────────────────
  add({ date, type = "GST Sales", lines, party = "Sharma Kirana Store", isCancelled = false, isOptional = false }) {
    const masterId = this.nextMasterId++;
    const v = {
      guid: `vch-${this.company.guid}-${masterId}`, masterId, alterId: ++this.alt, date, voucherType: type,
      voucherNumber: String(masterId), reference: null, partyLedger: party, partyAmount: null,
      isCancelled, isOptional, isDeleted: false, isPostDated: false, isInvoice: true, lines,
    };
    this.vouchers.set(masterId, v);
    return v;
  }
  edit(masterId, patch) {
    Object.assign(this.vouchers.get(masterId), patch, { alterId: ++this.alt });
  }
  remove(masterId) {
    this.vouchers.delete(masterId);
    this.alt++;
  }
  backup() {
    return { vouchers: clone([...this.vouchers]), alt: this.alt, next: this.nextMasterId };
  }
  restore(b) {
    this.vouchers = new Map(clone(b.vouchers));
    this.alt = b.alt;
    this.nextMasterId = b.next;
  }

  get lastVoucherDate() {
    return [...this.vouchers.values()].map((v) => v.date).sort().pop() || null;
  }

  // ── the Tally interface used by sync.js ─────────────────────────────────────
  async pingTally() { return { connected: true }; }

  async fetchCompanies() {
    this._count("fetchCompanies");
    return [{ ...this.company, lastVoucherDate: this.lastVoucherDate, altVchId: this.alt, altMstId: this.mst, isAggregate: false }];
  }

  async fetchVouchersByAlterIdWindow(company, start, end) {
    this._count("fetchVouchersByAlterIdWindow");
    this.windows.push([start, end]);
    return [...this.vouchers.values()].filter((v) => v.alterId > start && v.alterId <= end).map(clone);
  }

  async fetchVouchersByDay(company, day) {
    this._count("fetchVouchersByDay");
    (this.daysRead ||= []).push(day);
    if (this.failOnDay === day) throw new Error(`Tally stopped responding on ${day}`);
    const all = [...this.vouchers.values()];
    return (this.ignoreDateFilter ? all : all.filter((v) => v.date === day)).map(clone);
  }

  async fetchVoucherIdsByMasterIdRange(company, from, to) {
    this._count("fetchVoucherIdsByMasterIdRange");
    return [...this.vouchers.values()].filter((v) => v.masterId >= from && v.masterId <= to)
      .map((v) => ({ masterId: v.masterId, alterId: v.alterId, date: v.date }));
  }

  async fetchVoucherStatistics(companyName, periods) {
    this._count("fetchVoucherStatistics");
    if (this.statsFail) throw new Error("Statistics: 3 values for 2 types × 1 periods");
    return periods.map((p) => {
      const out = {};
      for (const v of this.vouchers.values()) {
        if (v.date < p.from || v.date > p.to || v.isCancelled || v.isOptional) continue;
        out[v.voucherType] = (out[v.voucherType] || 0) + 1;
      }
      return out;
    });
  }

  async fetchStockGroups() { this._count("fetchStockGroups"); return clone(this.stockGroups); }
  async fetchVoucherTypes() { this._count("fetchVoucherTypes"); return clone(this.voucherTypes); }
  async fetchPartyLedgers() { this._count("fetchPartyLedgers"); return clone(this.parties); }

  _itemsWithClosing() {
    return ITEMS.map((it) => {
      // Opening stock sits in Main Location; each allocation moves stock in its godown.
      const byGodown = new Map([["Main Location", it.openingQty]]);
      for (const v of this.vouchers.values()) {
        if (v.isOptional || v.isCancelled) continue;
        for (const l of v.lines) {
          if (l.item !== it.name) continue;
          const sign = l.direction === "in" ? 1 : -1;
          for (const a of l.allocations || [{ godown: "Main Location", qty: l.qty }]) {
            byGodown.set(a.godown, (byGodown.get(a.godown) || 0) + sign * a.qty);
          }
        }
      }
      const qty = [...byGodown.values()].reduce((s, q) => s + q, 0);
      const godowns = [...byGodown].filter(([, q]) => q !== 0).sort(([a], [b]) => a.localeCompare(b))
        .map(([godown, q]) => ({ godown, qty: q, value: q * 10 }));
      return {
        ...it, guid: `item-${it.masterId}`, alterId: 1, partNo: null, hsnCode: null, gstRate: null,
        openingValue: 0, closingQty: qty, closingValue: qty * 10, godowns,
      };
    });
  }
  async fetchStockItems() { this._count("fetchStockItems"); return this._itemsWithClosing(); }
  async fetchStockItemsByMasterIds(companyName, ids) {
    this._count("fetchStockItemsByMasterIds");
    this.itemIdRequests.push([...ids]);
    return this._itemsWithClosing().filter((i) => ids.includes(i.masterId));
  }
}
