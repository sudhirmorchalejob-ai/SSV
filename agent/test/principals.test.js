import { test } from "node:test";
import assert from "node:assert/strict";
import os from "os";
import path from "path";

process.env.DATA_DIR = path.join(os.tmpdir(), `ssv-agent-test-${process.pid}`);

const { parseXml, collectionItems } = await import("../src/tally/xml.js");
const { parseVoucher } = await import("../src/tally/vouchers.js");
const { voucherBaseTypes } = await import("../src/tally/masters.js");
const { buildItemClassifier, splitByPrincipal } = await import("../src/principals.js");
const F = await import("../fixtures/tally-samples.js");

const classifier = () => buildItemClassifier(F.RULES, F.STOCK_ITEMS, F.STOCK_GROUPS);
const baseTypes = voucherBaseTypes(F.VOUCHER_TYPES);
const baseTypeOf = (t) => baseTypes.get(t);

async function vouchersOf(xml) {
  return collectionItems(await parseXml(xml), "VOUCHER").map(parseVoucher);
}

test("items map to principals through parent groups, categories and item names", () => {
  const { principalOf, conflicts } = classifier();
  assert.equal(principalOf("Dant Kanti 100g"), "PATANJALI"); // grandchild group
  assert.equal(principalOf("Dant Kanti Sample 20g"), "PATANJALI"); // by category
  assert.equal(principalOf("Colgate Strong Teeth 200g"), "COLGATE");
  assert.equal(principalOf("Loose Rice 1kg"), null);
  assert.deepEqual(conflicts, []);
});

test("explicit item rule wins; overlapping group rules are reported", () => {
  const rules = [
    { code: "A", stockGroups: ["Patanjali"] },
    { code: "B", stockGroups: ["Patanjali Oral Care"] },
    { code: "C", items: ["Colgate Strong Teeth 200g"], stockGroups: [] },
    { code: "D", stockGroups: ["Colgate Palmolive"] },
  ];
  const { principalOf, conflicts } = buildItemClassifier(rules, F.STOCK_ITEMS, F.STOCK_GROUPS);
  assert.equal(principalOf("Colgate Strong Teeth 200g"), "C");
  assert.equal(principalOf("Dant Kanti 100g"), "A");
  assert.deepEqual(conflicts.map((c) => c.item), ["Dant Kanti 100g"]);
});

test("a mixed-brand bill is split; each principal sees only its own lines", async () => {
  const vouchers = await vouchersOf(F.SALES_MIXED);
  const { perPrincipal, sentTo } = splitByPrincipal(vouchers, { principalOf: classifier().principalOf, baseTypeOf });

  const pat = perPrincipal.get("PATANJALI").vouchers[0];
  const col = perPrincipal.get("COLGATE").vouchers[0];
  assert.deepEqual(pat.lines.map((l) => l.item).sort(), ["Dant Kanti 100g", "Dant Kanti Sample 20g"]);
  assert.deepEqual(col.lines.map((l) => l.item), ["Colgate Strong Teeth 200g"]);
  assert.equal(pat.baseType, "Sales");
  assert.equal("partyAmount" in pat, false, "whole-bill amount would leak other brands' value");
  assert.deepEqual(sentTo.get("guid-sale-1").sort(), ["COLGATE", "PATANJALI"]);
});

test("voucher edited to drop a principal's items produces a tombstone for it", async () => {
  const [v] = await vouchersOf(F.SALES_MIXED);
  v.lines = v.lines.filter((l) => l.item !== "Colgate Strong Teeth 200g");
  const { perPrincipal } = splitByPrincipal([v], {
    principalOf: classifier().principalOf,
    baseTypeOf,
    previouslySentTo: () => ["PATANJALI", "COLGATE"],
  });
  assert.equal(perPrincipal.get("COLGATE").vouchers.length, 0);
  assert.deepEqual(perPrincipal.get("COLGATE").tombstones.map((t) => t.guid), ["guid-sale-1"]);
  assert.equal(perPrincipal.get("PATANJALI").tombstones.length, 0);
});

test("orders and optional vouchers are not stock movements and are not sent", async () => {
  const [v] = await vouchersOf(F.SALES_MIXED);
  const order = { ...v, guid: "o1", voucherType: "Sales Order" };
  const optional = { ...v, guid: "o2", isOptional: true };
  const { perPrincipal } = splitByPrincipal([order, optional], { principalOf: classifier().principalOf, baseTypeOf });
  assert.equal(perPrincipal.size, 0);
});
