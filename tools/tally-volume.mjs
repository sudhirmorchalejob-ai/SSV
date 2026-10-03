/**
 * tally-volume.mjs — fills an EMPTY TallyPrime company with 18 months of tyre
 * distributor books, through Tally's own XML import, for end-to-end testing.
 *
 *   node tools/tally-volume.mjs --company "Shree Tyres Nagpur (Distributor)" --seed 11 [--bills-per-day 45] [--dry-run]
 *
 * Run from agent\dist (so the agent's .env gives the Tally URL). Refuses any
 * company that has ever had a voucher. Items come from the catalogue shared with
 * the ERPNext load test (erpnext-app/ssv_channel/ssv_channel/tools/catalogue.json).
 *
 * What goes in, on the 1st, 2nd and 31st of each month only (TallyPrime's
 * Educational mode accepts no other dates), Apr 2025 → today:
 *   purchases from CEAT, JK and MRF on each 1st; sales bills mixing the three
 *   brands; credit notes; a quarterly purchase return (debit note) to CEAT;
 *   delivery notes invoiced on the next allowed day (tracked lines); a transfer
 *   to the branch godown on each 1st; one CEAT item oversold into negative stock;
 *   one CEAT item that has no ERPNext Item (it must arrive Unmapped); bills with
 *   no CEAT line at all (they must never reach the CEAT site).
 * Expected CEAT figures are written to tally-volume-<company>.json for the
 * month-end reconciliation.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { pingTally, postXml, exportCollection } = await import("../agent/src/tally/client.js");
const { escapeXml, masterName, val, parseNumber } = await import("../agent/src/tally/xml.js");
const CATALOGUE = JSON.parse(fs.readFileSync(path.join(here, "../erpnext-app/ssv_channel/ssv_channel/tools/catalogue.json"), "utf8"));

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const COMPANY = arg("--company");
const SEED = parseInt(arg("--seed", "11"), 10);
const BILLS_PER_DAY = parseInt(arg("--bills-per-day", "45"), 10);
const DRY = process.argv.includes("--dry-run");
const FROM = arg("--from", "2025-04-01");
const TO = arg("--to", new Date().toISOString().slice(0, 10));

const SALES = "Sales Account (SSV test)";
const PURCHASE = "Purchase Account (SSV test)";
const SUPPLIER = { "Ceat Tyre": "CEAT Ltd", "JK Tyre": "JK Tyre & Industries Ltd", "MRF Tyres": "MRF Ltd" };
const BRANCH = "Branch Godown";
const MARK = "SSV volume test data";
const OVERSOLD = "CEAT – Czar – 235/65 R17 – SUV Tyre"; // bought once, sold on: closing goes negative

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Educational-mode days (1st, 2nd, 31st) between two ISO dates. */
export function allowedDays(from, to) {
  const out = [];
  const d = new Date(`${from}T00:00:00Z`);
  while (d.toISOString().slice(0, 10) <= to) {
    if ([1, 2, 31].includes(d.getUTCDate())) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

const principalItem = (name) => CATALOGUE.items.some((i) => i.tally_name === name);
const topGroup = (it) => (it.group.startsWith("Ceat") ? "Ceat Tyre" : it.group);

/** The books as plain data: {type, number, date, party, lines:[{item, qty, rate, godown, tracking?}]} */
export function buildBooks(seed = SEED, billsPerDay = BILLS_PER_DAY, from = FROM, to = TO) {
  const r = rng(seed);
  const all = [...CATALOGUE.items, ...CATALOGUE.other_items];
  const weights = all.map((i) => i.weight);
  const pick = () => {
    let x = r() * weights.reduce((s, w) => s + w, 0);
    for (let k = 0; k < all.length; k++) { x -= weights[k]; if (x <= 0) return all[k]; }
    return all[all.length - 1];
  };
  const retailers = [];
  const A = ["Sai", "Shree", "Om", "Balaji", "Ganesh", "Laxmi", "Royal", "City", "Highway", "Star", "Maruti", "Metro", "Kumar", "Patel"];
  const B = ["Tyres", "Auto Parts", "Tyre House", "Motors", "Wheel Care", "Tyre Point", "Auto Centre"];
  while (retailers.length < 40) {
    const n = `${A[Math.floor(r() * A.length)]} ${B[Math.floor(r() * B.length)]} ${1 + Math.floor(r() * 90)}`;
    if (!retailers.includes(n)) retailers.push(n);
  }
  const days = allowedDays(from, to);
  const stock = new Map(); // `${item}|${godown}` -> qty
  const move = (item, godown, q) => stock.set(`${item}|${godown}`, (stock.get(`${item}|${godown}`) || 0) + q);
  const have = (item) => (stock.get(`${item}|Main Location`) || 0) + (stock.get(`${item}|${BRANCH}`) || 0);
  const vouchers = [];
  let n = 0;
  const no = (p) => `${p}/${String(++n).padStart(5, "0")}`;
  let pendingDn = [];

  days.forEach((day, di) => {
    const first = day.endsWith("-01");
    // Purchases: on each 1st, top every item up to ~2 months of sales (the oversold item only once).
    if (first) {
      for (const group of Object.keys(SUPPLIER)) {
        const lines = [];
        for (const it of all.filter((i) => topGroup(i) === group)) {
          if (it.tally_name === OVERSOLD && di > 0) continue;
          const target = Math.round(it.weight * billsPerDay * 0.9);
          const q = Math.max(0, Math.ceil((target - have(it.tally_name)) / 5) * 5);
          if (q) { lines.push({ item: it.tally_name, qty: q, rate: it.buy, godown: "Main Location" }); move(it.tally_name, "Main Location", q); }
        }
        if (lines.length) vouchers.push({ type: "Purchase", number: no("PUR"), date: day, party: SUPPLIER[group], lines });
      }
      // Transfer a fifth of Main Location to the branch.
      const lines = [];
      for (const it of all) {
        const q = Math.floor((stock.get(`${it.tally_name}|Main Location`) || 0) * 0.2);
        if (q > 0) { lines.push({ item: it.tally_name, qty: q }); move(it.tally_name, "Main Location", -q); move(it.tally_name, BRANCH, q); }
      }
      if (lines.length) vouchers.push({ type: "Stock Journal", number: no("SJ"), date: day, party: null, lines });
    }
    // Invoices for delivery notes made on the previous allowed day (tracked: stock already moved).
    for (const dn of pendingDn) {
      vouchers.push({ type: "Sales", number: no("INV"), date: day, party: dn.party,
        lines: dn.lines.map((l) => ({ ...l, tracking: dn.number })) });
    }
    pendingDn = [];
    // Sales bills.
    const count = Math.max(1, Math.round(billsPerDay * (0.7 + r() * 0.6)));
    for (let b = 0; b < count; b++) {
      const party = retailers[Math.floor(Math.pow(r(), 1.6) * retailers.length)];
      const items = [];
      for (let k = 0, m = 1 + Math.floor(r() * 4); k < m; k++) { const it = pick(); if (!items.includes(it)) items.push(it); }
      const disc = [0, 0, 0, 0.02, 0.03, 0.05][Math.floor(r() * 6)];
      const lines = items.map((it) => {
        const q = it.category === "Truck Tyre" || /Truck|JETSTEEL/.test(it.tally_name) ? 1 + Math.floor(r() * 3) : 2 + Math.floor(r() * 10);
        const godown = (stock.get(`${it.tally_name}|Main Location`) || 0) >= q || r() < 0.6 ? "Main Location" : BRANCH;
        move(it.tally_name, godown, -q);
        return { item: it.tally_name, qty: q, rate: Math.round(it.sell * (1 - disc) * 100) / 100, godown };
      });
      if (r() < 0.06 && di < days.length - 1) {
        const number = no("DN");
        vouchers.push({ type: "Delivery Note", number, date: day, party, lines: lines.map((l) => ({ ...l, tracking: number })) });
        pendingDn.push({ number, party, lines });
        continue;
      }
      vouchers.push({ type: "Sales", number: no("INV"), date: day, party, lines });
      if (r() < 0.04) {
        const l = lines[0];
        const q = Math.max(1, Math.floor(l.qty / 3));
        move(l.item, "Main Location", q);
        vouchers.push({ type: "Credit Note", number: no("CN"), date: day, party, lines: [{ ...l, qty: q, godown: "Main Location" }] });
      }
    }
    // Quarterly purchase return to CEAT (1st of Jul, Oct, Jan, Apr after the first).
    if (first && di > 0 && ["-01-01", "-04-01", "-07-01", "-10-01"].some((s) => day.endsWith(s))) {
      const it = CATALOGUE.items[0];
      move(it.tally_name, "Main Location", -4);
      vouchers.push({ type: "Debit Note", number: no("DBN"), date: day, party: SUPPLIER["Ceat Tyre"],
        lines: [{ item: it.tally_name, qty: 4, rate: it.buy, godown: "Main Location" }] });
    }
  });
  return { vouchers, retailers, stock, days };
}

/** What the CEAT site must show: per item and month, net sales; per item, closing total and per godown. */
export function expected(books) {
  const perItem = {};
  const perMonth = {};
  const outlets = new Set();
  let billsWithoutCeat = 0;
  for (const v of books.vouchers) {
    const ceat = v.lines.filter((l) => principalItem(l.item));
    if (v.type === "Sales" && !ceat.length) billsWithoutCeat++;
    for (const l of ceat) {
      const e = (perItem[l.item] ||= { purchased: 0, purchaseReturned: 0, sold: 0, returned: 0, netSaleValue: 0 });
      const month = v.date.slice(0, 7);
      const m = (perMonth[month] ||= { netSaleQty: 0, netSaleValue: 0 });
      const value = Math.round(l.qty * l.rate * 100) / 100;
      if (v.type === "Purchase") e.purchased += l.qty;
      if (v.type === "Debit Note") e.purchaseReturned += l.qty;
      if (v.type === "Sales") { e.sold += l.qty; e.netSaleValue += value; m.netSaleQty += l.qty; m.netSaleValue += value; outlets.add(v.party); }
      if (v.type === "Credit Note") { e.returned += l.qty; e.netSaleValue -= value; m.netSaleQty -= l.qty; m.netSaleValue -= value; }
    }
  }
  const closing = {};
  for (const it of CATALOGUE.items) {
    const main = books.stock.get(`${it.tally_name}|Main Location`) || 0;
    const branch = books.stock.get(`${it.tally_name}|${BRANCH}`) || 0;
    if (main || branch || perItem[it.tally_name]) closing[it.tally_name] = { total: main + branch, "Main Location": main, [BRANCH]: branch };
  }
  const round = (o) => JSON.parse(JSON.stringify(o, (_k, x) => (typeof x === "number" ? Math.round(x * 100) / 100 : x)));
  return round({ perItem, perMonth, closing, outlets: outlets.size, billsWithoutCeat });
}

// ── Tally import XML ──────────────────────────────────────────────────────────

const e = escapeXml;
const amt = (x) => x.toFixed(2);
const tdate = (iso) => iso.replace(/-/g, "");

function envelope(company, id, messages) {
  return `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Import</TALLYREQUEST><TYPE>Data</TYPE><ID>${id}</ID></HEADER>` +
    `<BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>${e(company)}</SVCURRENTCOMPANY></STATICVARIABLES></DESC>` +
    `<DATA>${messages.map((m) => `<TALLYMESSAGE xmlns:UDF="TallyUDF">${m}</TALLYMESSAGE>`).join("")}</DATA></BODY></ENVELOPE>`;
}

export function mastersXml(company, retailers) {
  const msgs = [`<UNIT NAME="Nos" ACTION="Create"><NAME>Nos</NAME><ISSIMPLEUNIT>Yes</ISSIMPLEUNIT><DECIMALPLACES>0</DECIMALPLACES></UNIT>`,
    `<GODOWN NAME="${BRANCH}" ACTION="Create"><NAME.LIST><NAME>${BRANCH}</NAME></NAME.LIST><PARENT></PARENT></GODOWN>`];
  for (const [name, parent] of CATALOGUE.groups) {
    msgs.push(`<STOCKGROUP NAME="${e(name)}" ACTION="Create"><NAME.LIST><NAME>${e(name)}</NAME></NAME.LIST><PARENT>${e(parent)}</PARENT><ISADDABLE>Yes</ISADDABLE></STOCKGROUP>`);
  }
  for (const it of [...CATALOGUE.items, ...CATALOGUE.other_items]) {
    msgs.push(`<STOCKITEM NAME="${e(it.tally_name)}" ACTION="Create"><NAME.LIST><NAME>${e(it.tally_name)}</NAME></NAME.LIST><PARENT>${e(it.group)}</PARENT><BASEUNITS>Nos</BASEUNITS></STOCKITEM>`);
  }
  const ledger = (name, parent) => `<LEDGER NAME="${e(name)}" ACTION="Create"><NAME.LIST><NAME>${e(name)}</NAME></NAME.LIST><PARENT>${e(parent)}</PARENT><ISBILLWISEON>No</ISBILLWISEON></LEDGER>`;
  msgs.push(ledger(SALES, "Sales Accounts"), ledger(PURCHASE, "Purchase Accounts"));
  for (const r of retailers) msgs.push(ledger(r, "Sundry Debtors"));
  for (const s of Object.values(SUPPLIER)) msgs.push(ledger(s, "Sundry Creditors"));
  return envelope(company, "All Masters", msgs);
}

const STOCK_OUT = new Set(["Sales", "Debit Note", "Delivery Note"]);

/**
 * Tally signs: debit = negative amount with ISDEEMEDPOSITIVE Yes; credit = positive with No.
 *   Sales, Debit Note:        party Dr, stock out (Cr)
 *   Purchase, Credit Note:    stock in (Dr), party Cr
 *   Delivery Note:            stock out only (no ledger posting)
 *   Stock Journal:            OUT list from Main Location, IN list to the branch
 */
export function voucherXml(v) {
  if (v.type === "Stock Journal") {
    const entry = (tag, godown, dp) => v.lines.map((l) => `<${tag}><STOCKITEMNAME>${e(l.item)}</STOCKITEMNAME><ISDEEMEDPOSITIVE>${dp}</ISDEEMEDPOSITIVE>` +
      `<ACTUALQTY> ${l.qty} Nos</ACTUALQTY><BILLEDQTY> ${l.qty} Nos</BILLEDQTY><AMOUNT>0</AMOUNT>` +
      `<BATCHALLOCATIONS.LIST><GODOWNNAME>${e(godown)}</GODOWNNAME><BATCHNAME>Primary Batch</BATCHNAME><AMOUNT>0</AMOUNT>` +
      `<ACTUALQTY> ${l.qty} Nos</ACTUALQTY><BILLEDQTY> ${l.qty} Nos</BILLEDQTY></BATCHALLOCATIONS.LIST></${tag}>`).join("");
    return `<VOUCHER VCHTYPE="Stock Journal" ACTION="Create"><DATE>${tdate(v.date)}</DATE><VOUCHERTYPENAME>Stock Journal</VOUCHERTYPENAME>` +
      `<VOUCHERNUMBER>${e(v.number)}</VOUCHERNUMBER><NARRATION>${MARK}</NARRATION>` +
      `${entry("INVENTORYENTRIESOUT.LIST", "Main Location", "No")}${entry("INVENTORYENTRIESIN.LIST", BRANCH, "Yes")}</VOUCHER>`;
  }
  const out = STOCK_OUT.has(v.type);
  const accounting = v.type !== "Delivery Note";
  const ledger = v.type === "Purchase" || v.type === "Debit Note" ? PURCHASE : SALES;
  const total = v.lines.reduce((s, l) => s + Math.round(l.qty * l.rate * 100) / 100, 0);
  const dp = out ? "No" : "Yes";
  const inv = v.lines.map((l) => {
    const a = Math.round(l.qty * l.rate * 100) / 100;
    const signed = out ? amt(a) : amt(-a);
    const tracking = l.tracking ? `<TRACKINGNUMBER>${e(l.tracking)}</TRACKINGNUMBER>` : "";
    return `<ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>${e(l.item)}</STOCKITEMNAME><ISDEEMEDPOSITIVE>${dp}</ISDEEMEDPOSITIVE>` +
      `<RATE>${amt(l.rate)}/Nos</RATE><AMOUNT>${signed}</AMOUNT><ACTUALQTY> ${l.qty} Nos</ACTUALQTY><BILLEDQTY> ${l.qty} Nos</BILLEDQTY>` +
      `<BATCHALLOCATIONS.LIST><GODOWNNAME>${e(l.godown)}</GODOWNNAME><BATCHNAME>Primary Batch</BATCHNAME>${tracking}<AMOUNT>${signed}</AMOUNT>` +
      `<ACTUALQTY> ${l.qty} Nos</ACTUALQTY><BILLEDQTY> ${l.qty} Nos</BILLEDQTY></BATCHALLOCATIONS.LIST>` +
      (accounting ? `<ACCOUNTINGALLOCATIONS.LIST><LEDGERNAME>${e(ledger)}</LEDGERNAME><ISDEEMEDPOSITIVE>${dp}</ISDEEMEDPOSITIVE><AMOUNT>${signed}</AMOUNT></ACCOUNTINGALLOCATIONS.LIST>` : "") +
      `</ALLINVENTORYENTRIES.LIST>`;
  }).join("");
  const partyDr = v.type === "Sales" || v.type === "Debit Note";
  const party = accounting
    ? `<LEDGERENTRIES.LIST><LEDGERNAME>${e(v.party)}</LEDGERNAME><ISDEEMEDPOSITIVE>${partyDr ? "Yes" : "No"}</ISDEEMEDPOSITIVE>` +
      `<ISPARTYLEDGER>Yes</ISPARTYLEDGER><AMOUNT>${partyDr ? amt(-total) : amt(total)}</AMOUNT></LEDGERENTRIES.LIST>`
    : "";
  return `<VOUCHER VCHTYPE="${e(v.type)}" ACTION="Create" OBJVIEW="Invoice Voucher View">` +
    `<DATE>${tdate(v.date)}</DATE><EFFECTIVEDATE>${tdate(v.date)}</EFFECTIVEDATE><VOUCHERTYPENAME>${e(v.type)}</VOUCHERTYPENAME>` +
    `<VOUCHERNUMBER>${e(v.number)}</VOUCHERNUMBER><PARTYLEDGERNAME>${e(v.party)}</PARTYLEDGERNAME>` +
    `<PERSISTEDVIEW>Invoice Voucher View</PERSISTEDVIEW><ISINVOICE>${accounting ? "Yes" : "No"}</ISINVOICE><NARRATION>${MARK}</NARRATION>` +
    `${party}${inv}</VOUCHER>`;
}

function importResult(raw) {
  const n = (tag) => parseInt((raw.match(new RegExp(`<${tag}>(\\d+)</${tag}>`)) || [])[1] || "0", 10);
  const errors = [...raw.matchAll(/<LINEERROR>([^<]*)<\/LINEERROR>/g)].map((m) => m[1]);
  return { created: n("CREATED"), errors: n("ERRORS") + n("EXCEPTIONS"), messages: errors };
}

// ── command ──────────────────────────────────────────────────────────────────

async function main() {
  const books = buildBooks();
  const exp = expected(books);
  const byType = books.vouchers.reduce((m, v) => ({ ...m, [v.type]: (m[v.type] || 0) + 1 }), {});
  console.log(`${books.vouchers.length} vouchers on ${books.days.length} days (${books.days[0]} → ${books.days.at(-1)}):`, byType);
  console.log(`CEAT: ${Object.keys(exp.perItem).length} items sold, ${exp.outlets} outlets; ${exp.billsWithoutCeat} bills have no CEAT line`);
  if (DRY || !COMPANY) {
    if (!COMPANY) console.log('Dry run. To load: --company "Exact Company Name" (an EMPTY company, open in TallyPrime)');
    return 0;
  }
  const ping = await pingTally();
  if (!ping.connected) { console.log(ping.error); return 1; }
  const rows = await exportCollection({ name: "SSVVolCompanies", type: "Company", fetch: "NAME,ALTVCHID,BOOKSFROM" }, "COMPANY");
  const found = rows.map((c) => ({ name: masterName(c), altVchId: parseNumber(val(c.ALTVCHID)), booksFrom: val(c.BOOKSFROM) })).find((c) => c.name === COMPANY);
  if (!found) { console.log(`Company "${COMPANY}" is not open in TallyPrime.`); return 1; }
  if ((found.altVchId ?? 0) > 0) { console.log(`Refused: "${COMPANY}" has (or had) vouchers. Volume data only goes into an empty company.`); return 1; }

  let m = importResult(await postXml(mastersXml(COMPANY, books.retailers), "volume masters"));
  console.log(`masters created ${m.created}, errors ${m.errors}`);
  m.messages.slice(0, 5).forEach((x) => console.log(`  ! ${x}`));

  let created = 0;
  const problems = [];
  const t0 = Date.now();
  for (let i = 0; i < books.vouchers.length; i += 25) {
    const part = books.vouchers.slice(i, i + 25);
    const res = importResult(await postXml(envelope(COMPANY, "Vouchers", part.map(voucherXml)), "volume vouchers"));
    created += res.created;
    if (res.errors) problems.push(...res.messages.map((msg) => `${part[0].number} (${part[0].type}, ${part[0].date})…: ${msg}`));
    if ((i / 25) % 20 === 0) process.stdout.write(`  ${created}/${books.vouchers.length} vouchers, ${Math.round((Date.now() - t0) / 1000)}s\r`);
  }
  console.log(`\nvouchers created ${created} of ${books.vouchers.length} in ${Math.round((Date.now() - t0) / 1000)}s`);
  problems.slice(0, 15).forEach((x) => console.log(`  ! ${x}`));

  const file = path.resolve(`tally-volume-${COMPANY.replace(/[^\w]+/g, "-")}.json`);
  fs.writeFileSync(file, JSON.stringify({ company: COMPANY, seed: SEED, vouchers: books.vouchers.length, byType, expected: exp }, null, 2));
  console.log(`Expected CEAT figures: ${file}`);
  return created === books.vouchers.length ? 0 : 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}
