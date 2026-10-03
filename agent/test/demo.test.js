import { test } from "node:test";
import assert from "node:assert/strict";
import os from "os";
import path from "path";

process.env.DATA_DIR = path.join(os.tmpdir(), `ssv-demo-test-${process.pid}`);
const { buildDemoVouchers, expectedTotals, voucherXml, mastersXml, DAYS } = await import("../src/demo.js");
const { parseXml, collectionItems } = await import("../src/tally/xml.js");
const { parseVoucher } = await import("../src/tally/vouchers.js");

test("demo data is deterministic, Educational-mode dated, and includes the planted cases", () => {
  const a = buildDemoVouchers();
  assert.deepEqual(a, buildDemoVouchers(), "same data every load");
  assert.ok(a.every((v) => DAYS.includes(v.date)), "only 1st, 2nd, 31st");
  assert.ok(a.filter((v) => v.type === "Sales").length >= 25);
  assert.ok(a.some((v) => v.type === "Sales" && v.lines.some((l) => l.item.startsWith("Colgate")) && v.lines.some((l) => !l.item.startsWith("Colgate"))), "mixed-brand bills");
  const t = expectedTotals(a);
  assert.equal(t["Aloe Vera Gel 150ml"].closing, -20, "negative stock");
  assert.equal(t["Dant Kanti 100g"].returned, 2);
});

test("demo vouchers round-trip through the agent's own parser with correct directions", async () => {
  const vouchers = buildDemoVouchers();
  const pick = (type) => vouchers.find((v) => v.type === type);
  const xml = `<ENVELOPE><BODY><DATA><COLLECTION>${["Sales", "Purchase", "Credit Note"].map((t) => voucherXml(pick(t)).replace("<VOUCHER ", '<VOUCHER REMOTEID="x" ').replace("<DATE>", "<GUID>g</GUID><MASTERID>1</MASTERID><ALTERID>1</ALTERID><DATE>")).join("")}</COLLECTION></DATA></BODY></ENVELOPE>`;
  const [sale, purchase, credit] = collectionItems(await parseXml(xml), "VOUCHER").map(parseVoucher);
  assert.ok(sale.lines.every((l) => l.direction === "out"));
  assert.ok(purchase.lines.every((l) => l.direction === "in"));
  assert.ok(credit.lines.every((l) => l.direction === "in"));
  const s = pick("Sales");
  assert.equal(sale.lines[0].qty, s.lines[0].qty);
  assert.equal(sale.lines[0].amount, s.lines[0].qty * s.lines[0].rate);
  assert.equal(sale.partyAmount, -s.lines.reduce((x, l) => x + l.qty * l.rate, 0));
});

test("masters import names the Patanjali group and escapes names", () => {
  const xml = mastersXml("A & B Traders");
  assert.match(xml, /<SVCURRENTCOMPANY>A &amp; B Traders<\/SVCURRENTCOMPANY>/);
  assert.match(xml, /<STOCKGROUP NAME="Patanjali" ACTION="Create">/);
  assert.match(xml, /<STOCKGROUP NAME="Patanjali Oral Care" ACTION="Create">.*<PARENT>Patanjali<\/PARENT>/);
});
