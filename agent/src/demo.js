/**
 * demo.js — fills an EMPTY Tally company with a quarter of demo distributor data
 * (the dummy dataset the meeting asked for), through Tally's own XML import.
 *
 *   ssv-agent.exe --load-demo --company "Sharma Distributors"
 *
 * Safety: refuses unless the named company is open (or can be loaded) and has
 * never had a voucher (ALTVCHID 0), so it cannot touch real books.
 *
 * Data: two principals (Patanjali, with a sub-group; Colgate Palmolive), five
 * retailers, two suppliers, purchases, ~30 mixed-brand sales bills, two credit
 * notes, and one item sold into negative stock. Dates are only the 1st, 2nd and
 * 31st of Jul–Sep 2026, which TallyPrime's Educational mode accepts.
 * Expected totals are printed and saved for the reconciliation check.
 */

import fs from "fs";
import path from "path";
import { config } from "./config.js";
import { pingTally, postXml, exportCollection, loadCompany } from "./tally/client.js";
import { escapeXml, masterName, val, parseNumber } from "./tally/xml.js";

const SALES_LEDGER = "Sales (SSV demo)";
const PURCHASE_LEDGER = "Purchase (SSV demo)";

export const GROUPS = [
  ["Patanjali", ""],
  ["Patanjali Oral Care", "Patanjali"],
  ["Colgate Palmolive", ""],
];
// name, group, purchase rate, sale rate
export const ITEMS = [
  ["Dant Kanti 100g", "Patanjali Oral Care", 40, 55],
  ["Dant Kanti 200g", "Patanjali Oral Care", 70, 95],
  ["Kesh Kanti Shampoo 200ml", "Patanjali", 85, 110],
  ["Cow Ghee 1L", "Patanjali", 520, 650],
  ["Aloe Vera Gel 150ml", "Patanjali", 60, 80],
  ["Colgate Strong Teeth 200g", "Colgate Palmolive", 90, 102],
  ["Colgate MaxFresh 150g", "Colgate Palmolive", 80, 95],
];
const RETAILERS = ["Sharma Kirana Store", "Gupta General Store", "Om Sai Traders", "Jai Mata Di Stores", "Balaji Provision Store"];
const SUPPLIERS = { Patanjali: "Patanjali Ayurved Ltd", Colgate: "Colgate-Palmolive (India) Ltd" };
export const DAYS = ["2026-07-01", "2026-07-02", "2026-07-31", "2026-08-01", "2026-08-02", "2026-08-31", "2026-09-01", "2026-09-02"];

// Small deterministic PRNG so every load produces the same data.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rate = (name, kind) => ITEMS.find((i) => i[0] === name)[kind === "buy" ? 2 : 3];
const principalOf = (name) => (ITEMS.find((i) => i[0] === name)[1].startsWith("Colgate") ? "Colgate" : "Patanjali");

/** The demo vouchers as plain data: {type, number, date, party, lines:[{item, qty, rate}]} */
export function buildDemoVouchers() {
  const r = rng(20260701);
  const vouchers = [];
  let s = 0;
  // Opening purchases on 1 Jul, a top-up on 1 Aug. Aloe Vera is under-bought on purpose (negative stock).
  const buy = (date, n, party, lines) => vouchers.push({ type: "Purchase", number: `DEMO/P/${n}`, date, party, lines });
  buy("2026-07-01", 1, SUPPLIERS.Patanjali, [["Dant Kanti 100g", 400], ["Dant Kanti 200g", 200], ["Kesh Kanti Shampoo 200ml", 150], ["Cow Ghee 1L", 60], ["Aloe Vera Gel 150ml", 40]]);
  buy("2026-07-01", 2, SUPPLIERS.Colgate, [["Colgate Strong Teeth 200g", 250], ["Colgate MaxFresh 150g", 150]]);
  buy("2026-08-01", 3, SUPPLIERS.Patanjali, [["Dant Kanti 100g", 200], ["Cow Ghee 1L", 40]]);

  for (const day of DAYS) {
    for (const party of RETAILERS) {
      if (r() < 0.3) continue;
      const lines = [];
      for (const [name] of ITEMS) {
        if (name === "Aloe Vera Gel 150ml") continue; // sold on its own schedule below
        if (r() < 0.45) lines.push([name, 2 + Math.floor(r() * 12)]);
      }
      if (!lines.length) lines.push(["Dant Kanti 100g", 5]);
      vouchers.push({ type: "Sales", number: `DEMO/S/${String(++s).padStart(3, "0")}`, date: day, party, lines });
    }
  }
  // Aloe Vera: 10 a day on six days = 60 sold against 40 bought → closing −20.
  for (const day of DAYS.slice(0, 6)) {
    vouchers.push({ type: "Sales", number: `DEMO/S/${String(++s).padStart(3, "0")}`, date: day, party: RETAILERS[4], lines: [["Aloe Vera Gel 150ml", 10]] });
  }
  vouchers.push({ type: "Credit Note", number: "DEMO/CN/1", date: "2026-08-02", party: RETAILERS[0], lines: [["Dant Kanti 100g", 2]] });
  vouchers.push({ type: "Credit Note", number: "DEMO/CN/2", date: "2026-09-02", party: RETAILERS[2], lines: [["Cow Ghee 1L", 1]] });

  return vouchers.map((v) => ({
    ...v,
    lines: v.lines.map(([item, qty]) => ({ item, qty, rate: rate(item, v.type === "Purchase" ? "buy" : "sell") })),
  }));
}

/** Expected per-item totals: purchased, sold, returned, closing, net sale value. */
export function expectedTotals(vouchers) {
  const t = Object.fromEntries(ITEMS.map(([name]) => [name, { principal: principalOf(name), purchased: 0, sold: 0, returned: 0, saleValue: 0, returnValue: 0 }]));
  for (const v of vouchers) {
    for (const l of v.lines) {
      const e = t[l.item];
      if (v.type === "Purchase") e.purchased += l.qty;
      if (v.type === "Sales") { e.sold += l.qty; e.saleValue += l.qty * l.rate; }
      if (v.type === "Credit Note") { e.returned += l.qty; e.returnValue += l.qty * l.rate; }
    }
  }
  for (const e of Object.values(t)) {
    e.closing = e.purchased - e.sold + e.returned;
    e.netSaleQty = e.sold - e.returned;
    e.netSaleValue = e.saleValue - e.returnValue;
  }
  return t;
}

// ── Tally import XML ──────────────────────────────────────────────────────────

const amt = (n) => n.toFixed(2);
const tdate = (iso) => iso.replace(/-/g, "");

function envelope(company, id, messages) {
  return `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Import</TALLYREQUEST><TYPE>Data</TYPE><ID>${id}</ID></HEADER>` +
    `<BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>${escapeXml(company)}</SVCURRENTCOMPANY></STATICVARIABLES></DESC>` +
    `<DATA>${messages.map((m) => `<TALLYMESSAGE xmlns:UDF="TallyUDF">${m}</TALLYMESSAGE>`).join("")}</DATA></BODY></ENVELOPE>`;
}

export function mastersXml(company) {
  const e = escapeXml;
  const msgs = [`<UNIT NAME="Nos" ACTION="Create"><NAME>Nos</NAME><ISSIMPLEUNIT>Yes</ISSIMPLEUNIT><DECIMALPLACES>0</DECIMALPLACES></UNIT>`];
  for (const [name, parent] of GROUPS) {
    msgs.push(`<STOCKGROUP NAME="${e(name)}" ACTION="Create"><NAME.LIST><NAME>${e(name)}</NAME></NAME.LIST><PARENT>${e(parent)}</PARENT><ISADDABLE>Yes</ISADDABLE></STOCKGROUP>`);
  }
  for (const [name, group] of ITEMS) {
    msgs.push(`<STOCKITEM NAME="${e(name)}" ACTION="Create"><NAME.LIST><NAME>${e(name)}</NAME></NAME.LIST><PARENT>${e(group)}</PARENT><BASEUNITS>Nos</BASEUNITS></STOCKITEM>`);
  }
  const ledger = (name, parent) => `<LEDGER NAME="${e(name)}" ACTION="Create"><NAME.LIST><NAME>${e(name)}</NAME></NAME.LIST><PARENT>${e(parent)}</PARENT><ISBILLWISEON>No</ISBILLWISEON></LEDGER>`;
  msgs.push(ledger(SALES_LEDGER, "Sales Accounts"), ledger(PURCHASE_LEDGER, "Purchase Accounts"));
  for (const r of RETAILERS) msgs.push(ledger(r, "Sundry Debtors"));
  for (const s of Object.values(SUPPLIERS)) msgs.push(ledger(s, "Sundry Creditors"));
  return envelope(company, "All Masters", msgs);
}

/**
 * One voucher in invoice mode. Tally signs: debit = negative amount with
 * ISDEEMEDPOSITIVE Yes; credit = positive with No.
 *   Sales:        party Dr, stock out (Cr), Sales ledger Cr
 *   Purchase:     stock in (Dr), Purchase ledger Dr, party Cr
 *   Credit Note:  stock in (Dr), Sales ledger Dr, party Cr
 */
export function voucherXml(v) {
  const e = escapeXml;
  const out = v.type === "Sales";
  const ledger = v.type === "Purchase" ? PURCHASE_LEDGER : SALES_LEDGER;
  const total = v.lines.reduce((s, l) => s + l.qty * l.rate, 0);
  const inv = v.lines.map((l) => {
    const a = l.qty * l.rate;
    const signed = out ? amt(a) : amt(-a);
    const dp = out ? "No" : "Yes";
    return `<ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>${e(l.item)}</STOCKITEMNAME><ISDEEMEDPOSITIVE>${dp}</ISDEEMEDPOSITIVE>` +
      `<RATE>${amt(l.rate)}/Nos</RATE><AMOUNT>${signed}</AMOUNT><ACTUALQTY> ${l.qty} Nos</ACTUALQTY><BILLEDQTY> ${l.qty} Nos</BILLEDQTY>` +
      `<BATCHALLOCATIONS.LIST><GODOWNNAME>Main Location</GODOWNNAME><BATCHNAME>Primary Batch</BATCHNAME><AMOUNT>${signed}</AMOUNT>` +
      `<ACTUALQTY> ${l.qty} Nos</ACTUALQTY><BILLEDQTY> ${l.qty} Nos</BILLEDQTY></BATCHALLOCATIONS.LIST>` +
      `<ACCOUNTINGALLOCATIONS.LIST><LEDGERNAME>${e(ledger)}</LEDGERNAME><ISDEEMEDPOSITIVE>${dp}</ISDEEMEDPOSITIVE><AMOUNT>${signed}</AMOUNT></ACCOUNTINGALLOCATIONS.LIST>` +
      `</ALLINVENTORYENTRIES.LIST>`;
  }).join("");
  const party = `<LEDGERENTRIES.LIST><LEDGERNAME>${e(v.party)}</LEDGERNAME><ISDEEMEDPOSITIVE>${out ? "Yes" : "No"}</ISDEEMEDPOSITIVE>` +
    `<ISPARTYLEDGER>Yes</ISPARTYLEDGER><AMOUNT>${out ? amt(-total) : amt(total)}</AMOUNT></LEDGERENTRIES.LIST>`;
  return `<VOUCHER VCHTYPE="${e(v.type)}" ACTION="Create" OBJVIEW="Invoice Voucher View">` +
    `<DATE>${tdate(v.date)}</DATE><EFFECTIVEDATE>${tdate(v.date)}</EFFECTIVEDATE><VOUCHERTYPENAME>${e(v.type)}</VOUCHERTYPENAME>` +
    `<VOUCHERNUMBER>${e(v.number)}</VOUCHERNUMBER><PARTYLEDGERNAME>${e(v.party)}</PARTYLEDGERNAME>` +
    `<PERSISTEDVIEW>Invoice Voucher View</PERSISTEDVIEW><ISINVOICE>Yes</ISINVOICE><NARRATION>SSV demo data</NARRATION>` +
    `${party}${inv}</VOUCHER>`;
}

function importResult(raw) {
  const n = (tag) => parseInt((raw.match(new RegExp(`<${tag}>(\\d+)</${tag}>`)) || [])[1] || "0", 10);
  const errors = [...raw.matchAll(/<LINEERROR>([^<]*)<\/LINEERROR>/g)].map((m) => m[1]);
  return { created: n("CREATED"), altered: n("ALTERED"), errors: n("ERRORS") + n("EXCEPTIONS"), messages: errors };
}

// ── command ──────────────────────────────────────────────────────────────────

export async function loadDemo({ companyName } = {}) {
  const company = companyName || config.tally.company;
  if (!company) {
    console.log('Name the EMPTY company to fill:  ssv-agent.exe --load-demo --company "Sharma Distributors"');
    return 2;
  }
  const ping = await pingTally();
  if (!ping.connected) { console.log(ping.error); return 1; }

  await loadCompany(company);
  const rows = await exportCollection({ name: "SSVDemoCompanies", type: "Company", fetch: "NAME,ALTVCHID" }, "COMPANY");
  const found = rows.map((c) => ({ name: masterName(c), altVchId: parseNumber(val(c.ALTVCHID)) })).find((c) => c.name === company);
  if (!found) {
    console.log(`Company "${company}" is not open in TallyPrime. Create it (Alt+K → Create), open it, and run this again.`);
    return 1;
  }
  if ((found.altVchId ?? 0) > 0) {
    console.log(`Refused: "${company}" has (or had) vouchers. Demo data only goes into a brand-new, empty company.`);
    return 1;
  }

  console.log(`Loading demo masters into "${company}" ...`);
  const m = importResult(await postXml(mastersXml(company), "demo masters"));
  console.log(`  masters created ${m.created}, altered ${m.altered}, errors ${m.errors}`);
  m.messages.slice(0, 5).forEach((x) => console.log(`  ! ${x}`));

  const vouchers = buildDemoVouchers();
  let created = 0;
  const problems = [];
  for (let i = 0; i < vouchers.length; i += 10) {
    const part = vouchers.slice(i, i + 10);
    const res = importResult(await postXml(envelope(company, "Vouchers", part.map(voucherXml)), "demo vouchers"));
    created += res.created;
    if (res.errors) problems.push(...res.messages.map((msg) => `${part[0].number}…: ${msg}`));
  }
  console.log(`  vouchers created ${created} of ${vouchers.length}`);
  problems.slice(0, 10).forEach((x) => console.log(`  ! ${x}`));

  const totals = expectedTotals(vouchers);
  console.log("\nExpected in Tally after loading (and in ERPNext for the Patanjali items):");
  console.log("  item                         principal  bought  sold  returned  closing  net sale value");
  for (const [name, t] of Object.entries(totals)) {
    console.log(`  ${name.padEnd(28)} ${t.principal.padEnd(10)} ${String(t.purchased).padStart(6)} ${String(t.sold).padStart(5)} ${String(t.returned).padStart(9)} ${String(t.closing).padStart(8)} ${t.netSaleValue.toFixed(2).padStart(15)}`);
  }
  const dir = config.dataDir;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "demo-expected-totals.json");
  fs.writeFileSync(file, JSON.stringify({ company, vouchers: vouchers.length, totals }, null, 2));
  console.log(`\nSaved: ${file}`);
  console.log('Next:  ssv-agent.exe --probe   then   ssv-agent.exe --once');
  return created === vouchers.length ? 0 : 2;
}
