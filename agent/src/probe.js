/**
 * probe.js — checks, against the real TallyPrime, the assumptions the agent's
 * read strategy rests on. Read-only towards Tally; never uploads anything.
 *
 *   ssv-agent.exe --probe [--company "Name"]
 *     1  collection FILTERS honour $AlterID, $MasterID, and SVFROMDATE/SVTODATE
 *     2  Company exports ALTVCHID, ALTMSTID, LASTVOUCHERDATE, ISAGGREGATE
 *     3  Statistics report layout, and whether it counts optional / cancelled vouchers
 *     4  Stock item CLOSINGBALANCE follows SVTODATE
 *     6  (exploratory) godown detail on stock item opening allocations
 *
 *   ssv-agent.exe --probe-sweep [--company "Name"]      (check 5, run twice)
 *     Runs the agent's real sync into the probe folder and lists what changed
 *     since the previous sweep. Edit an old voucher and delete another in Tally
 *     between the two runs; both must show up.
 *
 * Output goes to the probe folder (%APPDATA%\SSVConnector\probe): a JSON report
 * and every raw Tally response the verdicts are based on.
 */

import fs from "fs";
import path from "path";
import { config } from "./config.js";
import { pingTally, postXml, buildCollectionXml, buildStatisticsXml, parseStatistics, loadCompany } from "./tally/client.js";
import { parseXml, collectionItems, masterName, val, list, parseNumber, tallyDateToISO } from "./tally/xml.js";
import { fetchVoucherIds } from "./tally/vouchers.js";
import { fetchStockItems, fetchVoucherTypes, voucherBaseTypes } from "./tally/masters.js";
import { MOVEMENT_BASE_TYPES } from "./principals.js";

const today = () => new Date().toISOString().slice(0, 10);
const addDays = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const monthOf = (iso) => {
  const [y, m] = iso.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${iso.slice(0, 7)}-01`, to: `${iso.slice(0, 7)}-${String(last).padStart(2, "0")}` };
};

function outDir() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  return config.dataDir;
}
function save(name, content) {
  const file = path.join(outDir(), name);
  fs.writeFileSync(file, content);
  return file;
}

// ── pure verdict helpers (unit-tested) ────────────────────────────────────────

/** Compare a filtered read with what the unfiltered list says it should return. */
export function filterVerdict(expected, got, total) {
  const exp = new Set(expected.map((v) => v.masterId));
  const gotIds = new Set(got.map((v) => v.masterId));
  const missing = [...exp].filter((id) => !gotIds.has(id));
  const extra = [...gotIds].filter((id) => !exp.has(id));
  if (!missing.length && !extra.length) return { verdict: "PASS", expected: exp.size, got: gotIds.size };
  if (gotIds.size === total && total > exp.size) {
    return { verdict: "FAIL", expected: exp.size, got: gotIds.size, reason: "filter ignored: Tally returned every voucher" };
  }
  return { verdict: "FAIL", expected: exp.size, got: gotIds.size, missing: missing.slice(0, 20), extra: extra.slice(0, 20), reason: "filtered result differs" };
}

/**
 * Compare Tally's Statistics counts with counts from the voucher list, under two
 * rules: the agent's (excluding cancelled and optional) and including optional.
 */
export function statisticsVerdict(tallyCounts, ids, types) {
  const count = (pred) => {
    const out = {};
    for (const v of ids) if (pred(v)) out[v.voucherType] = (out[v.voucherType] || 0) + 1;
    return out;
  };
  const agentRule = count((v) => !v.isCancelled && !v.isOptional);
  const withOptional = count((v) => !v.isCancelled);
  const withCancelled = count((v) => !v.isOptional);
  const rows = types.map((t) => ({
    type: t,
    tally: tallyCounts[t] || 0,
    agentRule: agentRule[t] || 0,
    withOptional: withOptional[t] || 0,
    withCancelled: withCancelled[t] || 0,
  })).filter((r) => r.tally || r.agentRule || r.withOptional || r.withCancelled);

  const matches = (k) => rows.every((r) => r.tally === r[k]);
  const optionalPresent = ids.some((v) => v.isOptional && types.includes(v.voucherType));
  const cancelledPresent = ids.some((v) => v.isCancelled && types.includes(v.voucherType));
  let verdict, reason;
  if (!rows.length) { verdict = "SKIP"; reason = "no stock vouchers in the chosen month"; }
  else if (matches("agentRule")) {
    verdict = "PASS";
    reason = optionalPresent ? "counts match; optional vouchers are excluded, as the agent assumes"
      : "counts match; no optional voucher in this month, so their exclusion is not proven";
  } else if (matches("withOptional")) { verdict = "FAIL"; reason = "Tally counts optional vouchers; the agent must count them too"; }
  else if (matches("withCancelled")) { verdict = "FAIL"; reason = "Tally counts cancelled vouchers; the agent must count them too"; }
  else { verdict = "FAIL"; reason = "counts differ under every rule"; }
  return { verdict, reason, optionalPresent, cancelledPresent, rows };
}

/** A day with no vouchers near `busyDay`, avoiding the 1st, 2nd and 31st (see dayFilterVerdict). */
export function quietDay(busyDay, perDay) {
  let day = `${busyDay.slice(0, 7)}-15`;
  for (let i = 0; i < 400; i++, day = addDays(day, 1)) {
    if (!perDay[day] && !EDUCATIONAL_DAYS.has(Number(day.slice(8)))) return day;
  }
  return day;
}

// TallyPrime in Educational mode accepts only these days of the month as dates;
// any other SVFROMDATE/SVTODATE is dropped and the whole period is returned.
const EDUCATIONAL_DAYS = new Set([1, 2, 31]);

/** One-day reads: each must return exactly the vouchers dated that day. */
export function dayFilterVerdict(ids, reads) {
  const rows = reads.map(({ day, got }) => ({ day, ...filterVerdict(ids.filter((v) => v.date === day), got, ids.length) }));
  const days = rows.map((r) => `${r.day}: expected ${r.expected}, got ${r.got}`);
  const bad = rows.filter((r) => r.verdict !== "PASS");
  if (!bad.length) return { verdict: "PASS", days };
  const educational = bad.every((r) => !EDUCATIONAL_DAYS.has(Number(r.day.slice(8))))
    && rows.filter((r) => EDUCATIONAL_DAYS.has(Number(r.day.slice(8)))).every((r) => r.verdict === "PASS");
  return {
    verdict: "WARN",
    reason: `Tally ignored the date filter for ${bad.map((r) => r.day).join(", ")}`
      + (educational ? " — TallyPrime looks to be in Educational mode, which accepts only the 1st, 2nd and 31st as dates" : "")
      + ". The agent notices this and falls back to AlterID windows, so data stays correct; first sync and deletion checks read more.",
    educationalSuspected: educational,
    days,
  };
}

/** Closing figures read at two dates must differ for items that moved in between. */
export function closingVerdict(itemsEarly, itemsNow, vouchersBetween) {
  const early = new Map(itemsEarly.map((i) => [i.name, i]));
  const changed = itemsNow.filter((i) => early.has(i.name) && early.get(i.name).closingQty !== i.closingQty);
  const openingMatches = itemsEarly.filter((i) => i.closingQty === i.openingQty).length;
  if (!vouchersBetween) return { verdict: "SKIP", reason: "no vouchers between the two dates", changed: 0 };
  if (changed.length) {
    return {
      verdict: "PASS", changed: changed.length, openingMatches, items: itemsEarly.length,
      sample: changed.slice(0, 5).map((i) => ({ item: i.name, early: early.get(i.name).closingQty, now: i.closingQty })),
    };
  }
  return { verdict: "FAIL", reason: "closing stock is identical at both dates: SVTODATE appears to be ignored", changed: 0, items: itemsEarly.length };
}

// ── the probe ────────────────────────────────────────────────────────────────

export async function runProbe({ companyName } = {}) {
  const report = { tallyUrl: config.tally.url, started: new Date().toISOString(), checks: [] };
  const add = (id, title, result) => { report.checks.push({ id, title, ...result }); printCheck(id, title, result); };

  const ping = await pingTally();
  if (!ping.connected) {
    console.log(`\nCannot reach TallyPrime: ${ping.error}`);
    return finish(report, 1);
  }
  console.log(`TallyPrime reachable at ${config.tally.url} (${ping.latencyMs} ms)\n`);

  // TallyPrime running as a server may have no company selected; load it by name.
  companyName = companyName || config.tally.company || undefined;
  if (companyName) await loadCompany(companyName);

  // Check 2: company fields (raw, so we can tell a missing tag from an empty one)
  const FIELDS = ["NAME", "GUID", "STARTINGFROM", "BOOKSFROM", "ENDINGAT", "LASTVOUCHERDATE", "CMPVCHID", "ALTVCHID", "ALTMSTID", "ISAGGREGATE"];
  const rawCo = await postXml(buildCollectionXml({ name: "SSVProbeCompanies", type: "Company", fetch: FIELDS.join(",") }), "probe companies");
  const coFile = save("probe-company.xml", rawCo);
  const coRows = collectionItems(await parseXml(rawCo), "COMPANY");
  const companies = coRows.map((c) => {
    const present = Object.fromEntries(FIELDS.filter((f) => f !== "NAME").map((f) => [f, c[f] !== undefined]));
    return {
      name: masterName(c), guid: val(c.GUID), present,
      startingFrom: tallyDateToISO(val(c.STARTINGFROM)), booksFrom: tallyDateToISO(val(c.BOOKSFROM)),
      lastVoucherDate: tallyDateToISO(val(c.LASTVOUCHERDATE)),
      altVchId: parseNumber(val(c.ALTVCHID)), altMstId: parseNumber(val(c.ALTMSTID)),
      isAggregate: val(c.ISAGGREGATE),
    };
  }).filter((c) => c.name); // an empty collection comes back as <COMPANY>0</COMPANY>
  if (!companies.length) {
    console.log("No company is open in TallyPrime. Open the company (Alt+F3 → Select Company), or run\n" +
      '  ssv-agent.exe --probe --company "Exact Company Name"\nso the agent can load it by name.');
    return finish(report, 1);
  }
  const needed = ["ALTVCHID", "ALTMSTID", "LASTVOUCHERDATE", "ISAGGREGATE"];
  const missingTags = companies.flatMap((c) => needed.filter((f) => !c.present[f]).map((f) => `${c.name}: ${f}`));
  const badCounters = companies.filter((c) => c.isAggregate !== "Yes" && (c.altVchId === null || c.altMstId === null));
  add(2, "Company exports ALTVCHID, ALTMSTID, LASTVOUCHERDATE, ISAGGREGATE", {
    verdict: !companies.length ? "SKIP" : missingTags.length || badCounters.length ? "FAIL" : "PASS",
    reason: !companies.length ? "no company loaded in Tally"
      : missingTags.length ? `tags missing: ${missingTags.join("; ")}`
      : badCounters.length ? `counters not numeric for: ${badCounters.map((c) => c.name).join(", ")}` : undefined,
    companies: companies.map(({ present, ...c }) => c),
    evidence: coFile,
  });

  const pick = companies.find((c) => (companyName ? c.name === companyName : c.isAggregate !== "Yes" && (c.altVchId ?? 0) > 0));
  if (!pick) {
    console.log(companyName ? `\nCompany "${companyName}" is not loaded in Tally.` : "\nNo loaded company has vouchers; load one and re-run.");
    return finish(report, 1);
  }
  const company = {
    name: pick.name, guid: pick.guid,
    fromDate: pick.startingFrom || pick.booksFrom,
    toDate: [pick.lastVoucherDate, addDays(today(), 365)].filter(Boolean).sort().pop(),
  };
  report.company = company.name;
  console.log(`\nUsing company "${company.name}" (${company.fromDate} → ${company.toDate})\n`);

  const ids = await fetchVoucherIds(company);
  save("probe-voucher-ids.json", JSON.stringify(ids, null, 1));
  report.voucherCount = ids.length;
  if (ids.length < 3) {
    console.log(`Only ${ids.length} voucher(s) in "${company.name}". Enter a few sales and a credit note, then re-run.`);
    return finish(report, 1);
  }

  // Check 1a: $AlterID window
  const alters = ids.map((v) => v.alterId).sort((a, b) => a - b);
  const [a, b] = [alters[Math.floor(alters.length / 3)], alters[Math.floor((2 * alters.length) / 3)]];
  const byAlter = await fetchVoucherIds(company, { filters: [`$AlterID > ${a} AND $AlterID <= ${b}`] });
  add("1a", `FILTERS honour $AlterID (window ${a} < AlterID ≤ ${b})`,
    filterVerdict(ids.filter((v) => v.alterId > a && v.alterId <= b), byAlter, ids.length));

  // Check 1b: $MasterID range
  const masters = ids.map((v) => v.masterId).sort((x, y) => x - y);
  const [m1, m2] = [masters[Math.floor(masters.length / 3)], masters[Math.floor((2 * masters.length) / 3)]];
  const byMaster = await fetchVoucherIds(company, { filters: [`$MasterID >= ${m1} AND $MasterID <= ${m2}`] });
  add("1b", `FILTERS honour $MasterID (range ${m1}–${m2})`,
    filterVerdict(ids.filter((v) => v.masterId >= m1 && v.masterId <= m2), byMaster, ids.length));

  // Check 1c: one-day read (the first sync reads day by day). A busy day alone can
  // pass by luck, so a quiet mid-month day (expected: no vouchers) is read too.
  const perDay = {};
  for (const v of ids) perDay[v.date] = (perDay[v.date] || 0) + 1;
  const busiest = Object.entries(perDay).sort((x, y) => y[1] - x[1])[0][0];
  const quiet = quietDay(busiest, perDay);
  const reads = [];
  for (const day of [busiest, quiet]) reads.push({ day, got: await fetchVoucherIds(company, { fromDate: day, toDate: day }) });
  add("1c", `SVFROMDATE = SVTODATE returns one day (${busiest}, and quiet day ${quiet})`, dayFilterVerdict(ids, reads));

  // Check 3: Statistics report
  const month = monthOf(busiest);
  const types = await fetchVoucherTypes(company.name);
  const base = voucherBaseTypes(types);
  const movementTypes = types.filter((t) => MOVEMENT_BASE_TYPES.has(base.get(t.name))).map((t) => t.name);
  const rawStats = await postXml(buildStatisticsXml(company.name, [month]), "probe statistics");
  const statsFile = save("probe-statistics.xml", rawStats);
  const layout = ["STATNAME", "STATVALUE", "STATDIRECT"].filter((t) => !rawStats.includes(`<${t}`));
  if (layout.length) {
    add(3, `Statistics report layout and counts (${month.from} → ${month.to})`, {
      verdict: "FAIL", reason: `tags not found in the response: ${layout.join(", ")}`, evidence: statsFile,
    });
  } else {
    let parsed;
    try { parsed = parseStatistics(await parseXml(rawStats), 1)[0]; } catch (e) { parsed = e; }
    if (parsed instanceof Error) {
      add(3, `Statistics report layout and counts (${month.from} → ${month.to})`, { verdict: "FAIL", reason: parsed.message, evidence: statsFile });
    } else {
      const monthIds = ids.filter((v) => v.date >= month.from && v.date <= month.to);
      add(3, `Statistics report layout and counts (${month.from} → ${month.to})`, {
        ...statisticsVerdict(parsed, monthIds, movementTypes),
        hasCancelledTag: rawStats.includes("<STATCANCELLED"), evidence: statsFile,
      });
    }
  }

  // Check 4: closing stock follows SVTODATE. The early date is the day before the
  // first voucher, even when that is before the books start: Tally then reports the
  // opening stock, but only if SVFROMDATE is not after SVTODATE (it ignores the
  // to-date otherwise), so the early read starts on the early date itself.
  const firstVoucher = ids.map((v) => v.date).sort()[0];
  const earlyDate = addDays(firstVoucher, -1);
  const itemsEarly = await fetchStockItems(company.name, {
    fromDate: earlyDate < company.fromDate ? earlyDate : company.fromDate, asOfDate: earlyDate,
  });
  const itemsNow = await fetchStockItems(company.name, { fromDate: company.fromDate, asOfDate: today() });
  save("probe-stock-items.json", JSON.stringify({ earlyDate, itemsEarly, itemsNow }, null, 1));
  add(4, `Stock item CLOSINGBALANCE follows SVTODATE (${earlyDate} vs ${today()})`,
    closingVerdict(itemsEarly, itemsNow, ids.filter((v) => v.date > earlyDate && v.date <= today()).length));

  // Check 6 (exploratory): godown detail in stock item opening allocations
  const rawGd = await postXml(buildCollectionXml({
    name: "SSVProbeGodowns", type: "Stock Item", company: company.name,
    fetch: "NAME,OPENINGBALANCE,BATCHALLOCATIONS.LIST",
  }), "probe godowns");
  const gdFile = save("probe-godown-openings.xml", rawGd);
  const gdItems = collectionItems(await parseXml(rawGd), "STOCKITEM", "STOCK-ITEM");
  const withGodown = gdItems.map((s) => ({
    item: masterName(s),
    allocations: list(s["BATCHALLOCATIONS.LIST"]).map((b) => ({
      godown: val(b.GODOWNNAME), batch: val(b.BATCHNAME), openingQty: parseNumber(val(b.OPENINGBALANCE)),
    })).filter((x) => x.godown),
  })).filter((x) => x.allocations.length);
  add(6, "Exploratory: opening stock per godown on stock items", {
    verdict: "INFO",
    reason: withGodown.length
      ? `${withGodown.length} of ${gdItems.length} items expose godown-wise opening allocations`
      : `none of ${gdItems.length} items expose godown-wise opening allocations`,
    sample: withGodown.slice(0, 5), evidence: gdFile,
  });

  console.log("\nCheck 5 (back-dated edits and deletions) is interactive: run  ssv-agent.exe --probe-sweep");
  return finish(report, report.checks.some((c) => c.verdict === "FAIL") ? 2 : 0);
}

function printCheck(id, title, r) {
  console.log(`[${String(r.verdict).padEnd(4)}] ${id}  ${title}`);
  if (r.reason) console.log(`        ${r.reason}`);
  if (r.expected !== undefined) console.log(`        expected ${r.expected}, got ${r.got}`);
  if (r.days) for (const d of r.days) console.log(`        ${d}`);
  if (r.rows) for (const row of r.rows) {
    console.log(`        ${row.type.padEnd(22)} tally ${String(row.tally).padStart(5)} | agent rule ${String(row.agentRule).padStart(5)} | +optional ${String(row.withOptional).padStart(5)} | +cancelled ${String(row.withCancelled).padStart(5)}`);
  }
  if (r.sample) for (const s of r.sample) console.log(`        ${JSON.stringify(s)}`);
  if (r.evidence) console.log(`        raw: ${r.evidence}`);
}

function finish(report, code) {
  report.finished = new Date().toISOString();
  const file = save(`probe-report-${report.finished.replace(/[:.]/g, "-")}.json`, JSON.stringify(report, null, 2));
  console.log(`\nReport: ${file}`);
  return code;
}

// ── check 5: sweep ───────────────────────────────────────────────────────────

export async function runSweep({ companyName } = {}) {
  const { runSync } = await import("./sync.js");
  const { openDb } = await import("./db.js");
  const db = openDb();
  const snapshot = () => new Map(db.prepare("SELECT company_guid, master_id, alter_id, is_deleted, date, voucher_type, data FROM voucher").all()
    .map((r) => [`${r.company_guid}|${r.master_id}`, r]));

  const before = snapshot();
  const firstRun = before.size === 0;
  if (firstRun) {
    console.log("First sweep: reading the company into the probe store (day by day from the start date).");
    console.log("Set SYNC_FROM=YYYY-MM-DD in .env to start later if the company is large.\n");
  }
  const report = await runSync({ trigger: "probe-sweep", only: companyName ? [companyName] : undefined });
  if (report.error) {
    console.log(`Sync failed: ${report.error}`);
    return 1;
  }
  const after = snapshot();

  const label = (r) => {
    const v = JSON.parse(r.data);
    return `${r.voucher_type} ${v.voucherNumber || "?"} dated ${r.date} (MasterID ${String(r.master_id)}, AlterID ${r.alter_id})`;
  };
  const added = [], changed = [], deleted = [];
  for (const [k, r] of after) {
    const p = before.get(k);
    if (!p) added.push(r);
    else if (!p.is_deleted && r.is_deleted) deleted.push(r);
    else if (p.alter_id !== r.alter_id) changed.push(r);
  }

  for (const c of report.companies) {
    console.log(`Company "${c.company}": ${c.error || c.blocked || "ok"}`);
    if (c.firstSyncCompleted) console.log(`  first sync done: ${c.daysRead} day(s) read`);
    if (c.windowsRead) console.log(`  AlterID windows read: ${c.windowsRead}`);
    if (c.deletedCheck) console.log(`  deleted-voucher check: ${c.deletedCheck.method}, ${c.deletedCheck.daysReread} day(s) re-read`);
  }
  if (firstRun) {
    console.log(`\nStored ${after.size} stock voucher(s). Now, in TallyPrime:`);
    console.log("  1. Alter a sales voucher dated at least a month back: change a quantity. Save.");
    console.log("  2. Delete a different sales voucher.");
    console.log("  3. Run  ssv-agent.exe --probe-sweep  again.");
    console.log("Expected on the second run: 1 changed, 1 deleted.");
  } else {
    console.log(`\nSince the previous sweep: ${added.length} new, ${changed.length} changed, ${deleted.length} deleted`);
    for (const r of changed) console.log(`  changed  ${label(r)}`);
    for (const r of deleted) console.log(`  deleted  ${label(r)}`);
    for (const r of added.slice(0, 20)) console.log(`  new      ${label(r)}`);
  }
  save(`probe-sweep-${Date.now()}.json`, JSON.stringify({ report, added: added.length, changed: changed.map(label), deleted: deleted.map(label) }, null, 2));
  return 0;
}
