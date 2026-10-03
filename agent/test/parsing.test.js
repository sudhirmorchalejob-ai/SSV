import { test } from "node:test";
import assert from "node:assert/strict";
import os from "os";
import path from "path";

process.env.DATA_DIR = path.join(os.tmpdir(), `ssv-agent-test-${process.pid}`);

const { parseNumber, parseQty, parseUnit, parseXml, collectionItems, decodeTallyBody, masterName, val } = await import("../src/tally/xml.js");
const { parseVoucher } = await import("../src/tally/vouchers.js");
const { voucherBaseTypes } = await import("../src/tally/masters.js");
const { buildCollectionXml, parseStatistics, withRetry } = await import("../src/tally/client.js");
const { SALES_MIXED, CREDIT_NOTE, VOUCHER_TYPES } = await import("../fixtures/tally-samples.js");

async function vouchersOf(xml) {
  return collectionItems(await parseXml(xml), "VOUCHER").map(parseVoucher);
}

test("numbers keep sign and zero (old parseTallyQty turned 0 into 1)", () => {
  assert.equal(parseNumber("1,250.50"), 1250.5);
  assert.equal(parseNumber("-72 Nos"), -72);
  assert.equal(parseNumber("(-)12.00"), -12);
  assert.equal(parseNumber("79.00/Nos"), 79);
  assert.equal(parseNumber(""), null);
  assert.equal(parseQty(" 0 Nos"), 0);
  assert.equal(parseQty(undefined), 0);
  assert.equal(parseUnit(" 22 Nos"), "Nos");
  assert.equal(parseUnit("55.00/Nos"), "Nos");
});

test("sales voucher: lines, directions, all godown allocations, no double count", async () => {
  const [v] = await vouchersOf(SALES_MIXED);
  assert.equal(v.guid, "guid-sale-1");
  assert.equal(v.alterId, 5001);
  assert.equal(v.masterId, 101);
  assert.equal(v.date, "2026-09-15");
  assert.equal(v.partyAmount, -1610);

  // INVENTORYENTRIES repeats the first line; it must not be counted twice.
  assert.equal(v.lines.length, 3);
  const dk = v.lines.find((l) => l.item === "Dant Kanti 100g");
  assert.equal(dk.direction, "out");
  assert.equal(dk.qty, 22);
  assert.equal(dk.billedQty, 20);
  assert.equal(dk.rate, 55);
  assert.equal(dk.amount, 1100);
  assert.deepEqual(dk.allocations.map((a) => [a.godown, a.batch, a.qty]), [
    ["Main Location", "B-0926", 14],
    ["Godown 2", "B-0826", 8],
  ]);

  const sample = v.lines.find((l) => l.item === "Dant Kanti Sample 20g");
  assert.equal(sample.qty, 0, "zero quantity must stay zero");
  assert.equal(sample.amount, 0);
});

test("an invoice line made against a delivery note is marked tracked", async () => {
  const xml = `<ENVELOPE><BODY><DATA><COLLECTION><VOUCHER REMOTEID="t1"><GUID>t1</GUID><MASTERID>9</MASTERID><ALTERID>9</ALTERID><DATE>20260915</DATE>
    <VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>
    <ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>A</STOCKITEMNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>100</AMOUNT><ACTUALQTY>2 Nos</ACTUALQTY>
      <BATCHALLOCATIONS.LIST><GODOWNNAME>Main</GODOWNNAME><TRACKINGNUMBER>DN/7</TRACKINGNUMBER><ACTUALQTY>2 Nos</ACTUALQTY><AMOUNT>100</AMOUNT></BATCHALLOCATIONS.LIST>
    </ALLINVENTORYENTRIES.LIST>
    <ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>B</STOCKITEMNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>50</AMOUNT><ACTUALQTY>1 Nos</ACTUALQTY>
      <BATCHALLOCATIONS.LIST><GODOWNNAME>Main</GODOWNNAME><TRACKINGNUMBER>Not Applicable</TRACKINGNUMBER><ACTUALQTY>1 Nos</ACTUALQTY><AMOUNT>50</AMOUNT></BATCHALLOCATIONS.LIST>
    </ALLINVENTORYENTRIES.LIST>
  </VOUCHER></COLLECTION></DATA></BODY></ENVELOPE>`;
  const [v] = await vouchersOf(xml);
  assert.deepEqual(v.lines.map((l) => [l.item, l.tracked, l.allocations[0].trackingNumber]), [["A", true, "DN/7"], ["B", false, null]]);
});

test("stock journal: lines exported in ALLINVENTORYENTRIES and again in IN/OUT are counted once (real TallyPrime, 26-Sep)", async () => {
  const entry = (list, deemed) => `<${list}><STOCKITEMNAME>Zoom</STOCKITEMNAME><ISDEEMEDPOSITIVE>${deemed}</ISDEEMEDPOSITIVE>
    <AMOUNT></AMOUNT><ACTUALQTY> 25 Nos</ACTUALQTY><BILLEDQTY> 25 Nos</BILLEDQTY>
    <BATCHALLOCATIONS.LIST><BATCHNAME>Primary Batch</BATCHNAME><ACTUALQTY> 25 Nos</ACTUALQTY></BATCHALLOCATIONS.LIST></${list}>`;
  const voucher = (lists) => `<ENVELOPE><BODY><DATA><COLLECTION><VOUCHER><GUID>sj</GUID><MASTERID>13</MASTERID><ALTERID>18</ALTERID><DATE>20260402</DATE>
    <VOUCHERTYPENAME>Stock Journal</VOUCHERTYPENAME>${lists}</VOUCHER></COLLECTION></DATA></BODY></ENVELOPE>`;
  const [both] = await vouchersOf(voucher(entry("INVENTORYENTRIESIN.LIST", "Yes") + entry("INVENTORYENTRIESOUT.LIST", "No") +
    entry("ALLINVENTORYENTRIES.LIST", "Yes") + entry("ALLINVENTORYENTRIES.LIST", "No")));
  assert.deepEqual(both.lines.map((l) => [l.direction, l.qty]), [["in", 25], ["out", 25]]);

  // Older exports with only the IN/OUT lists still work.
  const [inOutOnly] = await vouchersOf(voucher(entry("INVENTORYENTRIESIN.LIST", "Yes") + entry("INVENTORYENTRIESOUT.LIST", "No")));
  assert.deepEqual(inOutOnly.lines.map((l) => [l.direction, l.qty]), [["in", 25], ["out", 25]]);
});

test("credit note line is inward stock, so it nets off sales", async () => {
  const [v] = await vouchersOf(CREDIT_NOTE);
  assert.equal(v.lines[0].direction, "in");
  assert.equal(v.lines[0].qty, 2);
  assert.equal(v.lines[0].amount, 110);
});

test("custom voucher types resolve to their predefined base type", () => {
  const base = voucherBaseTypes(VOUCHER_TYPES);
  assert.equal(base.get("GST Sales"), "Sales");
  assert.equal(base.get("Credit Note"), "Credit Note");
});

test("bounded AlterID window is one escaped TDL formula; dates in Tally's DD-MMM-YYYY form", () => {
  const xml = buildCollectionXml({
    name: "X", type: "Voucher", fetch: "GUID", company: "A&B", fromDate: "2026-04-01", toDate: "2027-03-31",
    filters: ["$AlterID > 5000 AND $AlterID <= 5250"],
  });
  assert.match(xml, /<SVCURRENTCOMPANY>A&amp;B<\/SVCURRENTCOMPANY>/);
  assert.match(xml, /<SVFROMDATE TYPE="Date">01-Apr-2026<\/SVFROMDATE>/);
  assert.match(xml, /<SVTODATE TYPE="Date">31-Mar-2027<\/SVTODATE>/);
  assert.match(xml, /<FILTERS>SSVFilter0<\/FILTERS>/);
  assert.match(xml, /<SYSTEM TYPE="Formulae" NAME="SSVFilter0">\$AlterID &gt; 5000 AND \$AlterID &lt;= 5250<\/SYSTEM>/);
});

test("Tally's bare & and invalid character references no longer break parsing (field report #1)", async () => {
  // As exported by a real TallyPrime master collection: bare & in names, &#4; before reserved names, a raw EOT byte.
  const raw = `<ENVELOPE><BODY><DATA><COLLECTION>
    <STOCKGROUP NAME="Fixed Asset 3rt & 4rt"><PARENT>&#4; Primary</PARENT></STOCKGROUP>
    <LEDGER NAME="AJIT TIWARI (F&B-REST)"><PARENT>Sundry Debtors\u0004</PARENT></LEDGER>
    <LEDGER NAME="Projector Sound &amp; Light"><PARENT>Sales &#38; Services</PARENT></LEDGER>
    <LEDGER NAME="R&amp;D &lt;test&gt; &#x41;"><PARENT>x</PARENT></LEDGER>
  </COLLECTION></DATA></BODY></ENVELOPE>`;
  const parsed = await parseXml(raw);
  const groups = collectionItems(parsed, "STOCKGROUP");
  const ledgers = collectionItems(parsed, "LEDGER");
  assert.equal(masterName(groups[0]), "Fixed Asset 3rt & 4rt");
  assert.equal(val(groups[0].PARENT), "Primary");
  assert.deepEqual(ledgers.map((l) => masterName(l)), ["AJIT TIWARI (F&B-REST)", "Projector Sound & Light", "R&D <test> A"]);
  assert.equal(val(ledgers[0].PARENT), "Sundry Debtors");
  assert.equal(val(ledgers[1].PARENT), "Sales & Services");
});

test("godown closing: one CHILDOF collection per item; batches summed per godown, empty godowns dropped", async () => {
  const { godownTotals } = await import("../src/tally/masters.js");
  const xml = buildCollectionXml({ name: "SSVGodownStock", type: "Batch", fetch: "NAME,PARENT", childOf: ["CEAT – Zoom", "A & B"] });
  assert.match(xml, /<COLLECTION NAME="SSVGodownStock" ISMODIFY="No"><COLLECTION>SSVGodownStock0,SSVGodownStock1<\/COLLECTION><\/COLLECTION>/);
  assert.match(xml, /<CHILDOF>&quot;CEAT – Zoom&quot;<\/CHILDOF>/);
  assert.match(xml, /<CHILDOF>&quot;A &amp; B&quot;<\/CHILDOF>/);
  assert.throws(() => buildCollectionXml({ name: "X", type: "Batch", fetch: "NAME", childOf: ['Pipe 10" long'] }), /double quote/);

  const parsed = await parseXml(`<ENVELOPE><BODY><DATA><COLLECTION>
    <BATCH NAME="B1"><PARENT>Zoom</PARENT><GODOWNNAME>Main Location</GODOWNNAME><CLOSINGBALANCE> 900 Nos</CLOSINGBALANCE><CLOSINGVALUE>-3600000.00</CLOSINGVALUE></BATCH>
    <BATCH NAME="B2"><PARENT>Zoom</PARENT><GODOWNNAME>Main Location</GODOWNNAME><CLOSINGBALANCE> 88 Nos</CLOSINGBALANCE><CLOSINGVALUE>-352000.00</CLOSINGVALUE></BATCH>
    <BATCH NAME="Primary Batch"><PARENT>Zoom</PARENT><GODOWNNAME>Pune Depot</GODOWNNAME><CLOSINGBALANCE>(-)2 Nos</CLOSINGBALANCE><CLOSINGVALUE>8000.00</CLOSINGVALUE></BATCH>
    <BATCH NAME="Primary Batch"><PARENT>Zoom</PARENT><GODOWNNAME>Old Shop</GODOWNNAME><CLOSINGBALANCE> 0 Nos</CLOSINGBALANCE><CLOSINGVALUE>0.00</CLOSINGVALUE></BATCH>
    <BATCH NAME="Primary Batch"><PARENT>Milaze</PARENT><GODOWNNAME>Main Location</GODOWNNAME><CLOSINGBALANCE> 850 Nos</CLOSINGBALANCE><CLOSINGVALUE>0</CLOSINGVALUE></BATCH>
  </COLLECTION></DATA></BODY></ENVELOPE>`);
  const totals = godownTotals(collectionItems(parsed, "BATCH"));
  assert.deepEqual(totals.get("Zoom"), [
    { godown: "Main Location", qty: 988, value: -3952000 },
    { godown: "Pune Depot", qty: -2, value: 8000 },
  ]);
  assert.deepEqual(totals.get("Milaze"), [{ godown: "Main Location", qty: 850, value: 0 }]);
});

test("Tally responses decode from UTF-16 (with or without BOM) and UTF-8", () => {
  const text = "<ENVELOPE>पतंजलि</ENVELOPE>";
  assert.equal(decodeTallyBody(Buffer.from(text, "utf16le")), text);
  assert.equal(decodeTallyBody(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")])), text);
  assert.equal(decodeTallyBody(Buffer.from(text, "utf8")), text);
});

test("Statistics report: type-major values, cancelled subtracted, per period", async () => {
  // 2 voucher types × 3 periods. Tally lists every STATNAME, then STATVALUEs type by type.
  const xml = `<ENVELOPE>
    <STATNAME>GST Sales</STATNAME><STATNAME>Credit Note</STATNAME>
    <STATVALUE><STATDIRECT>12</STATDIRECT><STATCANCELLED>(2 Cancelled)</STATCANCELLED></STATVALUE>
    <STATVALUE><STATDIRECT>0</STATDIRECT></STATVALUE>
    <STATVALUE><STATDIRECT>5</STATDIRECT></STATVALUE>
    <STATVALUE><STATDIRECT>1</STATDIRECT></STATVALUE>
    <STATVALUE><STATDIRECT>0</STATDIRECT></STATVALUE>
    <STATVALUE><STATDIRECT>3</STATDIRECT></STATVALUE>
  </ENVELOPE>`;
  const stats = parseStatistics(await parseXml(xml), 3);
  assert.deepEqual(stats, [{ "GST Sales": 10, "Credit Note": 1 }, {}, { "GST Sales": 5, "Credit Note": 3 }]);
  await assert.rejects(async () => parseStatistics(await parseXml(xml), 2), /6 values for 2 types × 2 periods/);
});

test("Tally calls retry with growing waits (10 s, 20 s, … scaled down here)", async () => {
  let calls = 0;
  const started = Date.now();
  const r = await withRetry(async () => { if (++calls < 3) throw new Error("busy"); return "ok"; }, { attempts: 5, delayMs: 20 });
  assert.equal(r, "ok");
  assert.equal(calls, 3);
  assert.ok(Date.now() - started >= 20 + 40 - 5);
  await assert.rejects(withRetry(async () => { throw new Error("down"); }, { attempts: 2, delayMs: 1 }), /down/);
});
