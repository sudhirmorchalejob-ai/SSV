/**
 * tally-verify.mjs — read-only: does Tally hold what tally-volume.mjs meant to load?
 *
 *   node tools/tally-verify.mjs --company "Shree Tyres Nagpur (Distributor)"   (run from agent\dist)
 *
 * Compares Tally's own closing stock per CEAT item, in total and per godown, and
 * its voucher counts per type, with tally-volume-<company>.json.
 */

import fs from "fs";
import path from "path";

const { exportCollection } = await import("../agent/src/tally/client.js");
const { fetchStockItems } = await import("../agent/src/tally/masters.js");
const { val } = await import("../agent/src/tally/xml.js");

const i = process.argv.indexOf("--company");
const company = i >= 0 ? process.argv[i + 1] : null;
if (!company) { console.log('usage: --company "Exact Company Name"'); process.exit(2); }
const file = path.resolve(`tally-volume-${company.replace(/[^\w]+/g, "-")}.json`);
const exp = JSON.parse(fs.readFileSync(file, "utf8"));

const items = await fetchStockItems(company, { fromDate: "2026-04-01", asOfDate: new Date().toISOString().slice(0, 10) });
let bad = 0;
for (const [name, want] of Object.entries(exp.expected.closing)) {
  const it = items.find((x) => x.name === name);
  const got = { total: it?.closingQty ?? null };
  for (const g of it?.godowns || []) got[g.godown] = g.qty;
  const ok = got.total === want.total && ["Main Location", "Branch Godown"].every((g) => (got[g] || 0) === (want[g] || 0));
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "DIFF"} ${name.padEnd(46)} Tally ${String(got.total).padStart(6)} (Main ${got["Main Location"] || 0}, Branch ${got["Branch Godown"] || 0})` +
    `   expected ${String(want.total).padStart(6)} (Main ${want["Main Location"]}, Branch ${want["Branch Godown"]})`);
}
const rows = await exportCollection({ name: "SSVVerifyTypes", type: "Voucher", fetch: "VOUCHERTYPENAME", company, fromDate: "2026-04-01", toDate: "2027-03-31" }, "VOUCHER");
const byType = {};
for (const r of rows) byType[val(r.VOUCHERTYPENAME)] = (byType[val(r.VOUCHERTYPENAME)] || 0) + 1;
console.log("voucher counts in Tally:", byType, "\nexpected:              ", exp.byType);
console.log(bad ? `${bad} CEAT item(s) differ` : "Tally's closing stock matches the generator for every CEAT item, in total and per godown");
