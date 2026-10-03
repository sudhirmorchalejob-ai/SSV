/**
 * End-to-end sync scenarios on a fake Tally and a mock middleware:
 * first sync day by day (and resume), bounded AlterID windows, back-dated
 * edits, backup restore, deleted vouchers (count comparison and fallback),
 * closing stock for touched items only, 5 MB-style request cap, retry after
 * the middleware is down, and per-principal privacy.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

const SECRET = "test-secret";
const MAX_BYTES = 20_000;
const RULES = [
  { code: "PATANJALI", stockGroups: ["Patanjali"], stockCategories: ["Patanjali Samples"] },
  { code: "COLGATE", stockGroups: ["Colgate Palmolive"] },
];

const received = [];
const heartbeats = [];
let rules = RULES; // what the mock site hands out; a test may swap it
let agentSettings; // the `agent` part of the config reply, as set on the SSV Distributor
let respond = () => 202;

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const expected = crypto.createHmac("sha256", SECRET).update(`${req.headers["x-ssv-timestamp"]}.${body}`).digest("hex");
    if (expected !== req.headers["x-ssv-signature"]) { res.statusCode = 401; return res.end("{}"); }
    if (req.method === "GET" && req.url === "/agent/v1/config") {
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ principals: rules, ...(agentSettings ? { agent: agentSettings } : {}) }));
    }
    if (req.method === "POST" && req.url === "/agent/v1/heartbeat") {
      heartbeats.push(JSON.parse(body));
      return res.end("{}");
    }
    const batch = JSON.parse(body);
    const status = respond(batch);
    if (status < 300) received.push({ bytes: Buffer.byteLength(body), batch });
    res.statusCode = status;
    res.end("{}");
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));

Object.assign(process.env, {
  DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "ssv-sync-")),
  MIDDLEWARE_URL: `http://127.0.0.1:${server.address().port}`,
  DISTRIBUTOR_ID: "DIST-001",
  AGENT_SECRET: SECRET,
  DELETED_CHECK_INTERVAL_MINUTES: "0",
  UPLOAD_MAX_BYTES: String(MAX_BYTES),
});

const { runSync } = await import("../src/sync.js");
const { partyForUpload } = await import("../src/upload.js");
const { getCompany, closeDb } = await import("../src/db.js");
const { FakeTally, line, ITEMS } = await import("../fixtures/fake-tally.js");

const today = new Date().toISOString().slice(0, 10);
const daysAgo = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
const startDate = daysAgo(20);

function batchesOf(fake, kind) {
  return received.filter((r) => r.batch.tally_company.guid === fake.company.guid && (!kind || r.batch.kind === kind)).map((r) => r.batch);
}
function sentVouchers(fake, principal) {
  return batchesOf(fake, "vouchers").filter((b) => b.principal === principal).flatMap((b) => b.vouchers);
}
function sentTombstones(fake, principal) {
  return batchesOf(fake, "vouchers").filter((b) => b.principal === principal).flatMap((b) => b.tombstones);
}
async function run(fake) {
  const r = await runSync({ trigger: "test", tally: fake });
  assert.equal(r.error, undefined, r.error);
  return r.companies.find((c) => c.company === fake.company.name);
}
function seed(fake) {
  fake.add({ date: daysAgo(18), lines: [line("Dant Kanti 100g", 10, 55), line("Colgate Strong Teeth 200g", 5, 102)] });
  fake.add({ date: daysAgo(10), lines: [line("Dant Kanti 100g", 4, 55)], party: "Gupta General Store" });
  fake.add({ date: daysAgo(3), type: "Credit Note", lines: [line("Dant Kanti 100g", 2, 55, "in")] });
  fake.add({ date: daysAgo(3), type: "Payment", lines: [] });
}

after(() => { server.close(); closeDb(); });

test("first sync reads one day at a time, then uploads per principal", async () => {
  const fake = new FakeTally({ startingFrom: startDate });
  seed(fake);
  const out = await run(fake);

  assert.equal(out.firstSyncCompleted, true);
  assert.equal(fake.calls.fetchVouchersByDay, 21, "one request per day from start to today");
  assert.equal(fake.calls.fetchVouchersByAlterIdWindow ?? 0, 0);
  const row = getCompany(fake.company.guid);
  assert.equal(row.first_sync, 0);
  assert.equal(row.watermark, 0, "ALTVCHID at start (4) − 250 overlap, floored at 0");

  const pat = sentVouchers(fake, "PATANJALI");
  const col = sentVouchers(fake, "COLGATE");
  assert.equal(pat.length, 3, "two sales + one credit note; the payment is not a stock voucher");
  assert.equal(col.length, 1);
  assert.ok(pat.every((v) => v.lines.every((l) => l.item.startsWith("Dant Kanti"))), "Colgate lines never reach Patanjali");
  assert.ok(batchesOf(fake, "items").some((b) => b.principal === "COLGATE"));
});

test("an interrupted first sync resumes from the last finished day", async () => {
  const fake = new FakeTally({ startingFrom: startDate });
  seed(fake);
  fake.failOnDay = daysAgo(10);
  const first = await runSync({ trigger: "test", tally: fake });
  assert.match(first.companies[0].error, /stopped responding/);
  assert.equal(getCompany(fake.company.guid).first_sync_date, daysAgo(11));
  assert.equal(batchesOf(fake).length, 0, "nothing uploaded until the first sync completes");

  fake.failOnDay = null;
  fake.daysRead = [];
  await run(fake);
  assert.equal(fake.daysRead[0], daysAgo(10), "resumes at the failed day, not at the start");
  assert.equal(fake.daysRead.length, 11);
  assert.equal(sentVouchers(fake, "PATANJALI").length, 3);
});

test("incremental sync reads bounded AlterID windows of 250", async () => {
  const fake = new FakeTally({ startingFrom: startDate });
  seed(fake);
  await run(fake);
  for (let i = 0; i < 600; i++) fake.add({ date: daysAgo(i % 5), lines: [line("Colgate Strong Teeth 200g", 1, 102)] });

  const out = await run(fake);
  assert.deepEqual(fake.windows, [[0, 250], [250, 500], [500, 604]]);
  assert.ok(fake.windows.every(([s, e]) => e - s <= 250));
  assert.equal(out.windowsRead, 3);
  assert.equal(getCompany(fake.company.guid).watermark, 604);
  assert.equal(sentVouchers(fake, "COLGATE").length, 601);
});

test("each upload request stays under the byte cap", async () => {
  const sizes = received.map((r) => r.bytes);
  assert.ok(sizes.length > 0);
  assert.ok(Math.max(...sizes) <= MAX_BYTES, `largest request ${Math.max(...sizes)} bytes`);
});

test("a back-dated edit is picked up by its new AlterID", async () => {
  const fake = new FakeTally({ startingFrom: startDate });
  const old = fake.add({ date: daysAgo(19), lines: [line("Dant Kanti 100g", 10, 55)] });
  await run(fake);
  fake.edit(old.masterId, { lines: [line("Dant Kanti 100g", 7, 55)] });
  await run(fake);
  const versions = sentVouchers(fake, "PATANJALI").filter((v) => v.guid === old.guid);
  assert.deepEqual(versions.map((v) => v.lines[0].qty), [10, 7]);
});

test("restoring a Tally backup steps the watermark back and re-reads", async () => {
  const fake = new FakeTally({ startingFrom: startDate });
  seed(fake);
  await run(fake);
  const snap = fake.backup();
  for (let i = 0; i < 20; i++) fake.add({ date: daysAgo(1), lines: [line("Colgate Strong Teeth 200g", 1, 102)] });
  await run(fake);
  assert.equal(getCompany(fake.company.guid).watermark, 24);

  fake.restore(snap); // ALTVCHID back to 4, MasterID counter back too
  const afterRestore = fake.add({ date: today, lines: [line("Colgate Strong Teeth 200g", 3, 102)] }); // AlterID 5
  const out = await run(fake);
  assert.equal(getCompany(fake.company.guid).watermark, 5);
  assert.equal(out.deletedCheck.method, "counts", "deleted check runs in the same pass as the restore");

  // Like real Tally, the new voucher reuses the MasterID (and so the GUID) of the
  // first voucher lost with the restore: it replaces that one at the principal...
  const lastCopy = batchesOf(fake, "vouchers").filter((b) => b.vouchers.some((v) => v.guid === afterRestore.guid)).at(-1);
  assert.equal(lastCopy.vouchers.find((v) => v.guid === afterRestore.guid).lines[0].qty, 3);
  assert.equal(lastCopy.sync_epoch, 1, "epoch rises so the lower AlterID is not taken as stale");
  // ...and the other 19 lost vouchers are withdrawn.
  const withdrawn = sentTombstones(fake, "COLGATE");
  assert.equal(withdrawn.length, 19);
  assert.ok(!withdrawn.some((t) => t.guid === afterRestore.guid));
});

test("after a restore, a new voucher with the lost one's MasterID, GUID and AlterID on the same day is sent (field test 29-Sep)", async () => {
  const fake = new FakeTally({ startingFrom: startDate });
  seed(fake);
  await run(fake);
  const snap = fake.backup();
  const c = fake.add({ date: today, lines: [line("Dant Kanti 100g", 5, 55)] });
  const d = fake.add({ date: today, lines: [line("Dant Kanti 100g", 6, 55)] });
  await run(fake);

  fake.restore(snap);
  const e = fake.add({ date: today, lines: [line("Dant Kanti 100g", 4, 55)] });
  assert.deepEqual([e.masterId, e.guid, e.alterId], [c.masterId, c.guid, c.alterId], "Tally repeats all three after a restore");
  await run(fake);

  const lastCopy = batchesOf(fake, "vouchers").filter((b) => b.vouchers.some((v) => v.guid === e.guid)).at(-1);
  assert.equal(lastCopy.vouchers.find((v) => v.guid === e.guid).lines[0].qty, 4, "E replaces C at the principal");
  assert.equal(lastCopy.sync_epoch, getCompany(fake.company.guid).epoch);
  assert.ok(sentTombstones(fake, "PATANJALI").some((t) => t.guid === d.guid), "D, lost with the restore, is withdrawn");
});

test("a restore is found even when as many vouchers were entered again as were lost", async () => {
  const fake = new FakeTally({ startingFrom: startDate });
  seed(fake);
  await run(fake);
  fake.add({ date: daysAgo(2), lines: [line("Dant Kanti 100g", 1, 55)] });
  await run(fake); // incremental: remembers the last voucher read
  const snap = fake.backup();
  const lost = [5, 6].map((q) => fake.add({ date: daysAgo(1), lines: [line("Dant Kanti 100g", q, 55)] }));
  await run(fake);

  fake.restore(snap);
  // Two new vouchers on another day: ALTVCHID ends where it was, so it gives nothing away.
  const again = [7, 8].map((q) => fake.add({ date: today, lines: [line("Dant Kanti 100g", q, 55)] }));
  const out = await run(fake);

  assert.equal(out.restoreDetected, true);
  assert.equal(getCompany(fake.company.guid).epoch, 1);
  const latest = (guid) => sentVouchers(fake, "PATANJALI").filter((v) => v.guid === guid).at(-1);
  assert.deepEqual(again.map((v) => [latest(v.guid).date, latest(v.guid).lines[0].qty]), [[today, 7], [today, 8]],
    "the re-entered vouchers replace the lost ones (same GUIDs) with their own content");
  assert.deepEqual(lost.map((v) => v.guid), again.map((v) => v.guid));
});

test("a reused MasterID with a different GUID withdraws the old voucher", async () => {
  const fake = new FakeTally({ startingFrom: startDate });
  const v = fake.add({ date: daysAgo(5), lines: [line("Dant Kanti 100g", 1, 55)] });
  const oldGuid = v.guid;
  await run(fake);
  fake.edit(v.masterId, { guid: "some-other-guid", lines: [line("Dant Kanti 100g", 2, 55)] });
  await run(fake);
  assert.deepEqual(sentTombstones(fake, "PATANJALI").map((t) => t.guid), [oldGuid]);
  assert.ok(sentVouchers(fake, "PATANJALI").some((x) => x.guid === "some-other-guid"));
});

test("deleted vouchers are found by comparing counts, re-reading only the affected day", async () => {
  const fake = new FakeTally({ startingFrom: startDate });
  seed(fake);
  const extra = fake.add({ date: daysAgo(6), lines: [line("Colgate Strong Teeth 200g", 2, 102)] });
  await run(fake);
  await run(fake); // settle: first deleted-check baseline

  fake.remove(extra.masterId);
  fake.daysRead = [];
  const statsBefore = fake.calls.fetchVoucherStatistics;
  const out = await run(fake);
  assert.equal(out.deletedCheck.method, "counts");
  assert.equal(out.deletedCheck.daysReread, 1);
  assert.deepEqual(fake.daysRead, [daysAgo(6)]);
  assert.equal(fake.calls.fetchVoucherStatistics - statsBefore, 2, "months in one request, then that month's days");
  assert.deepEqual(sentTombstones(fake, "COLGATE").map((t) => [t.guid, t.reason]), [[extra.guid, "deleted"]]);
});

test("a day re-read before is re-read again when a voucher added later is deleted (field test 26-Sep)", async () => {
  const fake = new FakeTally({ startingFrom: startDate });
  seed(fake);
  const first = fake.add({ date: daysAgo(6), lines: [line("Colgate Strong Teeth 200g", 2, 102)] });
  await run(fake);
  await run(fake);
  fake.remove(first.masterId);
  await run(fake); // day re-read; Tally's counts for it are now remembered as verified

  const second = fake.add({ date: daysAgo(6), lines: [line("Colgate Strong Teeth 200g", 3, 102)] });
  await run(fake);
  fake.remove(second.masterId); // Tally's counts for the day are back to the remembered ones
  const out = await run(fake);
  assert.equal(out.deletedCheck.daysReread, 1);
  assert.deepEqual(sentTombstones(fake, "COLGATE").map((t) => t.guid), [first.guid, second.guid]);
});

test("if the Statistics report fails, MasterID ranges find the deletion", async () => {
  const fake = new FakeTally({ startingFrom: startDate });
  seed(fake);
  const extra = fake.add({ date: daysAgo(2), lines: [line("Dant Kanti 100g", 1, 55)] });
  await run(fake);
  fake.statsFail = true;
  fake.remove(extra.masterId);
  const out = await run(fake);
  assert.equal(out.deletedCheck.method, "masterid-ranges");
  assert.ok(fake.calls.fetchVoucherIdsByMasterIdRange >= 1);
  assert.deepEqual(sentTombstones(fake, "PATANJALI").map((t) => t.guid), [extra.guid]);
});

test("closing stock is re-read only for items in changed vouchers", async () => {
  const fake = new FakeTally({ startingFrom: startDate });
  seed(fake);
  await run(fake);
  await run(fake);
  const fullReads = fake.calls.fetchStockItems;
  fake.itemIdRequests = [];

  fake.add({ date: today, lines: [line("Colgate Strong Teeth 200g", 6, 102)] });
  const out = await run(fake);
  assert.equal(out.stock, "touched");
  assert.deepEqual(fake.itemIdRequests, [[3]], "only the Colgate item, by MasterID");
  assert.equal(fake.calls.fetchStockItems, fullReads, "no full stock read");
  const colgateItems = batchesOf(fake, "items").filter((b) => b.principal === "COLGATE").flatMap((b) => b.items);
  assert.equal(colgateItems.at(-1).closingQty, 300 - 5 - 6);
});

test("a godown transfer re-sends the item with its closing stock per godown", async () => {
  const fake = new FakeTally({ startingFrom: startDate });
  seed(fake);
  await run(fake);
  const colgate = () => batchesOf(fake, "items").filter((b) => b.principal === "COLGATE").flatMap((b) => b.items).at(-1);
  assert.deepEqual(colgate().godowns, [{ godown: "Main Location", qty: 295, value: 2950 }]);

  const move = (direction, godown) => ({
    ...line("Colgate Strong Teeth 200g", 50, 0, direction),
    allocations: [{ godown, batch: null, qty: 50, billedQty: 50, amount: 0, mfgDate: null, expiry: null }],
  });
  fake.add({ date: today, type: "Stock Journal", party: null, lines: [move("out", "Main Location"), move("in", "Godown B")] });
  const out = await run(fake);
  assert.equal(out.stock, "touched");
  const item = colgate();
  assert.equal(item.closingQty, 295, "a transfer leaves the total unchanged");
  assert.deepEqual(item.godowns, [{ godown: "Godown B", qty: 50, value: 500 }, { godown: "Main Location", qty: 245, value: 2450 }]);
});

test("the first run after an agent upgrade sends a full closing-stock snapshot", async () => {
  const { kvSet } = await import("../src/db.js");
  const fake = new FakeTally({ startingFrom: startDate });
  seed(fake);
  await run(fake);
  assert.equal((await run(fake)).stock, "none", "same day, nothing changed");
  kvSet(fake.company.guid, "snapshotAgentVersion", "0.2.1");
  assert.equal((await run(fake)).stock, "full");
  assert.equal((await run(fake)).stock, "none");
});

test("when the middleware is down, rows stay pending and go on the next run", async () => {
  const fake = new FakeTally({ startingFrom: startDate });
  seed(fake);
  respond = () => 503;
  const out = await run(fake);
  assert.match(out.upload.error, /HTTP 503/);
  assert.equal(sentVouchers(fake, "PATANJALI").length, 0);

  respond = () => 202;
  await run(fake);
  assert.equal(sentVouchers(fake, "PATANJALI").length, 3);
});

test("a first sync switches to AlterID windows if Tally ignores the date", async () => {
  const fake = new FakeTally({ startingFrom: startDate });
  seed(fake);
  fake.ignoreDateFilter = true;
  const out = await run(fake);
  assert.equal(out.firstSyncCompleted, true);
  assert.equal(fake.calls.fetchVouchersByDay, 1, "stops day-by-day after the first bad day");
  assert.deepEqual(fake.windows, [[0, 4]]);
  assert.equal(getCompany(fake.company.guid).first_sync_mode, "alterid");
});

test("a negative change counter blocks the company with a clear message", async () => {
  const fake = new FakeTally({ startingFrom: startDate });
  seed(fake);
  fake.alt = -1;
  const r = await runSync({ trigger: "test", tally: fake });
  assert.match(r.companies[0].blocked, /Repair \(rewrite\) the company data/);
});

test("every run reports to ERPNext; a failed run says why", async () => {
  const fake = new FakeTally({ startingFrom: startDate });
  seed(fake);
  heartbeats.length = 0;
  await run(fake);
  assert.equal(heartbeats.length, 1);
  assert.equal(heartbeats[0].distributor_id, "DIST-001");
  assert.equal(heartbeats[0].run.ok, true);
  assert.equal(heartbeats[0].run.problem, null);

  fake.pingTally = async () => ({ connected: false, error: "TallyPrime is not reachable on http://localhost:9000" });
  await runSync({ trigger: "test", tally: fake });
  assert.equal(heartbeats[1].run.ok, false);
  assert.match(heartbeats[1].run.problem, /TallyPrime is not reachable/);
});

test("the sync interval and 'Sync now' come from ERPNext", async () => {
  const control = await import("../src/control.js");
  const fake = new FakeTally({ startingFrom: startDate });
  seed(fake);
  // An old request seen on first contact is not replayed.
  agentSettings = { syncIntervalMinutes: 60, syncRequestedAt: "2026-09-28 10:00:00.000000" };
  await run(fake);
  assert.equal(control.effectiveIntervalMinutes(), 60);
  assert.equal(control.intervalSource(), "ERPNext");
  assert.equal(control.pendingSyncRequest(), null);

  // "Sync now" pressed: pending until a run has handled it.
  agentSettings = { syncIntervalMinutes: 60, syncRequestedAt: "2026-09-28 10:05:00.000000" };
  await control.fetchRemoteConfig();
  assert.equal(control.pendingSyncRequest(), "2026-09-28 10:05:00.000000");
  control.markSyncRequestHandled("2026-09-28 10:05:00.000000");
  assert.equal(control.pendingSyncRequest(), null);
  await run(fake);
  assert.equal(heartbeats.at(-1).handled_sync_request, "2026-09-28 10:05:00.000000");

  // Kept within 5 min – 1 day; cleared in ERPNext → back to SYNC_INTERVAL_MINUTES.
  agentSettings = { syncIntervalMinutes: 2 };
  await control.fetchRemoteConfig();
  assert.equal(control.effectiveIntervalMinutes(), 5);
  agentSettings = { syncIntervalMinutes: 10_000 };
  await control.fetchRemoteConfig();
  assert.equal(control.effectiveIntervalMinutes(), 1440);
  agentSettings = { syncIntervalMinutes: null };
  await control.fetchRemoteConfig();
  assert.equal(control.intervalSource(), ".env");

  // An ERPNext app without agent settings changes nothing.
  agentSettings = { syncIntervalMinutes: 30 };
  await control.fetchRemoteConfig();
  agentSettings = undefined;
  await control.fetchRemoteConfig();
  assert.equal(control.effectiveIntervalMinutes(), 30);
});

test("each principal gets per-month totals of what it received, once a day", async () => {
  const fake = new FakeTally({ startingFrom: startDate });
  seed(fake);
  fake.add({ date: daysAgo(2), lines: [line("Dant Kanti 100g", 3, 55), line("Colgate Strong Teeth 200g", 2, 102)] });
  const out = await run(fake);
  assert.deepEqual(out.reconcile, { principals: 2 });

  const control = Object.fromEntries(batchesOf(fake, "control").map((b) => [b.principal, b]));
  for (const code of ["PATANJALI", "COLGATE"]) {
    const expected = {};
    for (const v of sentVouchers(fake, code)) {
      const t = (expected[v.date.slice(0, 7)] ||= { month: v.date.slice(0, 7), vouchers: 0, qty: 0, amount: 0 });
      t.vouchers++;
      v.lines.forEach((l) => { t.qty += l.qty; t.amount += l.amount; });
    }
    const byMonth = (ms) => [...ms].sort((a, b) => a.month.localeCompare(b.month));
    assert.deepEqual(byMonth(control[code].months), byMonth(Object.values(expected)), `${code}: only its own lines, as delivered`);
    assert.equal(control[code].rejected, 0);
  }

  await run(fake);
  assert.equal(batchesOf(fake, "control").length, 2, "not again within the day");
});

test("every item's group path runs from the top group down (field data showed every second one flipped)", async () => {
  ITEMS.push({ masterId: 5, name: "Dant Kanti 200g", group: "Patanjali Oral Care", category: null, baseUnit: "Nos", openingQty: 50 });
  try {
    const fake = new FakeTally({ startingFrom: startDate });
    seed(fake); // a company with no vouchers never finishes its first sync, so nothing is uploaded
    await run(fake);
    const items = batchesOf(fake, "items").filter((b) => b.principal === "PATANJALI").flatMap((b) => b.items);
    const paths = Object.fromEntries(items.map((i) => [i.name, i.groupPath]));
    assert.deepEqual(paths["Dant Kanti 100g"], ["Patanjali", "Patanjali Oral Care"]);
    assert.deepEqual(paths["Dant Kanti 200g"], ["Patanjali", "Patanjali Oral Care"]);
  } finally {
    ITEMS.pop();
  }
});

test("a dealer's brand goes to the manufacturer and its distributor only when the hub approved the pair", async () => {
  // Dealer's Tally: Patanjali and Colgate. RAJ supplies the dealer with Patanjali.
  rules = [
    { code: "PATANJALI", stockGroups: ["Patanjali"], stockCategories: ["Patanjali Samples"], sharesWith: ["RAJ"] },
    { code: "RAJ", stockGroups: ["Patanjali"], sharesWith: ["PATANJALI"] },
    { code: "COLGATE", stockGroups: ["Colgate Palmolive"] },
    { code: "SNOOP", stockGroups: ["Colgate Palmolive"] }, // an overlap nobody approved
  ];
  try {
    const fake = new FakeTally({ startingFrom: startDate });
    seed(fake);
    const r = await runSync({ trigger: "test", tally: fake });
    const lines = (code) => sentVouchers(fake, code).flatMap((v) => v.lines.map((l) => l.item));
    assert.ok(lines("RAJ").length && lines("RAJ").every((i) => i.startsWith("Dant Kanti")), "the distributor gets the shared brand only");
    assert.deepEqual(lines("RAJ").sort(), lines("PATANJALI").sort(), "and exactly what the manufacturer gets");
    assert.ok(batchesOf(fake, "items").some((b) => b.principal === "RAJ"), "items and stock too");
    assert.equal(lines("SNOOP").length, 0, "an unapproved overlap still goes to the first principal only");
    assert.ok(r.warnings.some((w) => w.includes("COLGATE, SNOOP")), "and is reported");
    const totals = Object.fromEntries(batchesOf(fake, "control").map((b) => [b.principal, b.months]));
    assert.deepEqual(totals.RAJ, totals.PATANJALI, "reconciliation totals match what each received");
  } finally {
    rules = RULES;
  }
});

test("retailer contacts leave the PC only if the distributor shares them", () => {
  const vb = received.map((r) => r.batch).filter((b) => b.kind === "vouchers");
  assert.ok(vb.length && vb.every((b) => b.party_contacts === true), "default: shared, and every batch says so");

  const p = { name: "Sharma Kirana", guid: "g1", group: "Sundry Debtors", gstin: "27ABCDE1234F1Z5", phone: "98220 00000",
    state: "Maharashtra", pincode: "411001", address: "Shop 4, MG Road", priceLevel: "Retail" };
  assert.deepEqual(partyForUpload(p, true), p);
  const kept = partyForUpload(p, false);
  assert.deepEqual(kept, { name: "Sharma Kirana", guid: "g1", group: "Sundry Debtors", gstin: "27ABCDE1234F1Z5", state: "Maharashtra", priceLevel: "Retail" });
  assert.ok(!("phone" in kept) && !("address" in kept) && !("pincode" in kept));
});
