import { test } from "node:test";
import assert from "node:assert/strict";
import os from "os";
import path from "path";

process.env.DATA_DIR = path.join(os.tmpdir(), `ssv-probe-test-${process.pid}`);
const { filterVerdict, statisticsVerdict, closingVerdict } = await import("../src/probe.js");

const ids = (...m) => m.map((masterId) => ({ masterId }));

test("filter verdict: exact match passes; everything returned means the filter was ignored", () => {
  assert.equal(filterVerdict(ids(2, 3), ids(3, 2), 6).verdict, "PASS");
  const ignored = filterVerdict(ids(2, 3), ids(1, 2, 3, 4, 5, 6), 6);
  assert.equal(ignored.verdict, "FAIL");
  assert.match(ignored.reason, /filter ignored/);
  const off = filterVerdict(ids(2, 3), ids(3, 4), 6);
  assert.deepEqual([off.verdict, off.missing, off.extra], ["FAIL", [2], [4]]);
});

test("statistics verdict tells which counting rule Tally uses", () => {
  const v = (voucherType, extra = {}) => ({ voucherType, isOptional: false, isCancelled: false, ...extra });
  const month = [v("Sales"), v("Sales"), v("Sales", { isOptional: true }), v("Credit Note"), v("Sales", { isCancelled: true })];
  const types = ["Sales", "Credit Note"];

  const pass = statisticsVerdict({ Sales: 2, "Credit Note": 1 }, month, types);
  assert.equal(pass.verdict, "PASS");
  assert.equal(pass.optionalPresent, true);
  assert.match(pass.reason, /optional vouchers are excluded/);

  const withOptional = statisticsVerdict({ Sales: 3, "Credit Note": 1 }, month, types);
  assert.equal(withOptional.verdict, "FAIL");
  assert.match(withOptional.reason, /counts optional/);

  const withCancelled = statisticsVerdict({ Sales: 3, "Credit Note": 1 }, month.filter((x) => !x.isOptional), types);
  assert.match(withCancelled.reason, /counts cancelled/);
});

test("one-day reads: a quiet day is picked away from the 1st, 2nd and 31st, and Educational mode is recognised", async () => {
  const { quietDay, dayFilterVerdict } = await import("../src/probe.js");
  assert.equal(quietDay("2026-04-01", { "2026-04-01": 4 }), "2026-04-15");
  assert.equal(quietDay("2026-05-31", { "2026-05-15": 1, "2026-05-16": 1 }), "2026-05-17");
  assert.equal(quietDay("2026-01-10", { "2026-01-15": 1, "2026-01-16": 1, "2026-01-17": 1, "2026-01-18": 1, "2026-01-19": 1, "2026-01-20": 1,
    "2026-01-21": 1, "2026-01-22": 1, "2026-01-23": 1, "2026-01-24": 1, "2026-01-25": 1, "2026-01-26": 1, "2026-01-27": 1, "2026-01-28": 1,
    "2026-01-29": 1, "2026-01-30": 1 }), "2026-02-03");

  const all = [1, 2, 3, 4].map((masterId) => ({ masterId, date: "2026-04-01" })).concat({ masterId: 5, date: "2026-04-20" });
  const ok = dayFilterVerdict(all, [{ day: "2026-04-01", got: all.slice(0, 4) }, { day: "2026-04-15", got: [] }]);
  assert.equal(ok.verdict, "PASS");

  // The real Educational-mode TallyPrime: the 1st is honoured, the 15th returns everything.
  const edu = dayFilterVerdict(all, [{ day: "2026-04-01", got: all.slice(0, 4) }, { day: "2026-04-15", got: all }]);
  assert.equal(edu.verdict, "WARN");
  assert.equal(edu.educationalSuspected, true);
  assert.match(edu.reason, /2026-04-15.*Educational mode/);

  const broken = dayFilterVerdict(all, [{ day: "2026-04-01", got: all }, { day: "2026-04-15", got: all }]);
  assert.equal(broken.verdict, "WARN");
  assert.equal(broken.educationalSuspected, false);
});

test("closing verdict: figures must move between two dates when vouchers fall in between", () => {
  const early = [{ name: "A", openingQty: 10, closingQty: 10 }, { name: "B", openingQty: 5, closingQty: 5 }];
  assert.equal(closingVerdict(early, [{ name: "A", closingQty: 7 }, { name: "B", closingQty: 5 }], 3).verdict, "PASS");
  assert.equal(closingVerdict(early, [{ name: "A", closingQty: 10 }, { name: "B", closingQty: 5 }], 3).verdict, "FAIL");
  assert.equal(closingVerdict(early, early, 0).verdict, "SKIP");
});
