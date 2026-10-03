/**
 * The hub between one distributor's agent and two manufacturers' sites.
 * Two mock ERPNext sites check signatures exactly like ssv_channel does; the last
 * test runs the real agent (on the fake Tally) through the hub.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ssv-hub-"));
process.env.HUB_REGISTRY = path.join(tmp, "registry.json");
process.env.HUB_QUIET = "1";
const { createHub, sign, mergeConfigs } = await import("../src/hub.js");
const { saveRegistry } = await import("../src/registry.js");

const listen = (server) => new Promise((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${server.address().port}`)));

/** A manufacturer's ERPNext, as far as the hub can tell. */
function mockSite({ code, distributorId, secret, stockGroups, agent }) {
  const site = { code, batches: [], heartbeats: [], seen: new Set(), down: false, agent };
  site.server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const send = (status, obj) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
      if (site.down) return send(503, { ok: false });
      const ok = req.headers["x-ssv-distributor"] === distributorId &&
        sign(body, req.headers["x-ssv-timestamp"], secret) === req.headers["x-ssv-signature"];
      if (!ok) return send(401, { ok: false, error: "bad signature" });
      if (req.url.endsWith(".config")) return send(200, { message: { principals: [{ code, stockGroups }], agent: site.agent } });
      const b = JSON.parse(body);
      if (req.url.endsWith(".heartbeat")) { site.heartbeats.push(b); return send(200, { message: { ok: true } }); }
      if (b.distributor_id !== distributorId) return send(422, { error: "distributor mismatch" });
      if (site.seen.has(b.batch_id)) return send(409, { ok: true, duplicate: true });
      site.seen.add(b.batch_id);
      site.batches.push(b);
      return send(202, { message: { ok: true } });
    });
  });
  return site;
}

const pat = mockSite({ code: "PATANJALI", distributorId: "P-DIST-7", secret: "pat-secret", stockGroups: ["Patanjali"],
  agent: { syncIntervalMinutes: 30, syncRequestedAt: "2026-09-28 10:00:00" } });
const col = mockSite({ code: "COLGATE", distributorId: "C-DIST-3", secret: "col-secret", stockGroups: ["Colgate Palmolive"],
  agent: { syncIntervalMinutes: 15, syncRequestedAt: null } });
const patUrl = await listen(pat.server);
const colUrl = await listen(col.server);
const HUB_SECRET = "hub-secret-for-HUB-1";
saveRegistry({ distributors: { "HUB-1": { name: "Multi-brand Distributor", enabled: true, secret: HUB_SECRET, links: [
  { principal: "PATANJALI", url: patUrl, distributorId: "P-DIST-7", secret: "pat-secret",
    batchesPath: "/api/method/ssv_channel.api.batches", configPath: "/api/method/ssv_channel.api.config", heartbeatPath: "/api/method/ssv_channel.api.heartbeat" },
  { principal: "COLGATE", url: colUrl, distributorId: "C-DIST-3", secret: "col-secret",
    batchesPath: "/api/method/ssv_channel.api.batches", configPath: "/api/method/ssv_channel.api.config", heartbeatPath: "/api/method/ssv_channel.api.heartbeat" },
] } } });
const hub = createHub();
const hubUrl = await listen(hub);

after(() => { hub.close(); pat.server.close(); col.server.close(); });

async function agentCall(method, p, body = "", { id = "HUB-1", secret = HUB_SECRET, ts = Math.floor(Date.now() / 1000) } = {}) {
  const res = await fetch(`${hubUrl}${p}`, {
    method,
    headers: { "X-SSV-Distributor": id, "X-SSV-Timestamp": String(ts), "X-SSV-Signature": sign(body, String(ts), secret), "Content-Type": "application/json" },
    body: method === "POST" ? body : undefined,
  });
  return { status: res.status, json: await res.json() };
}

const batch = (principal, extra = {}) => ({ batch_id: crypto.randomUUID(), kind: "vouchers", principal, distributor_id: "HUB-1",
  tally_company: { guid: "g", name: "Multi-brand Co" }, vouchers: [], ...extra });

test("config merges both manufacturers' rules; shortest interval; one Sync Now token", async () => {
  const r = await agentCall("GET", "/agent/v1/config");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.principals.map((p) => p.code).sort(), ["COLGATE", "PATANJALI"]);
  assert.equal(r.json.agent.syncIntervalMinutes, 15);
  assert.equal(r.json.agent.syncRequestedAt, "PATANJALI=2026-09-28 10:00:00");
});

test("agent update: the lowest version all manufacturers approve", () => {
  const u = (version) => ({ version, url: `https://x/${version}.exe`, sha256: "a".repeat(64) });
  const m = mergeConfigs([
    { link: { principal: "A" }, config: { principals: [], agent: { update: u("0.10.0") } } },
    { link: { principal: "B" }, config: { principals: [], agent: { update: u("0.9.2") } } },
    { link: { principal: "C" }, config: { principals: [], agent: {} } },
  ]);
  assert.equal(m.agent.update.version, "0.9.2");
  assert.equal(mergeConfigs([{ link: { principal: "A" }, config: { principals: [], agent: {} } }]).agent.update, undefined);
});

test("a site may only give rules for its own manufacturer", () => {
  const m = mergeConfigs([{ link: { principal: "COLGATE" }, config: { principals: [{ code: "PATANJALI", stockGroups: ["X"] }] } }]);
  assert.deepEqual(m.principals, []);
});

test("only the hub's registry lets two sites receive the same items; a site cannot grant it", () => {
  const parts = [
    { link: { principal: "CEAT" }, config: { principals: [{ code: "CEAT", stockGroups: ["Ceat Tyre"], sharesWith: ["EVERYONE"] }] } },
    { link: { principal: "RAJLAXMI" }, config: { principals: [{ code: "RAJLAXMI", stockGroups: ["Ceat Tyre"] }] } },
  ];
  assert.deepEqual(mergeConfigs(parts).principals.map((p) => p.sharesWith), [undefined, undefined], "a site's own claim is dropped");
  const shared = mergeConfigs(parts, [["CEAT", "RAJLAXMI"]]).principals;
  assert.deepEqual(shared.map((p) => [p.code, p.sharesWith]), [["CEAT", ["RAJLAXMI"]], ["RAJLAXMI", ["CEAT"]]]);
});

test("config is 503 when one manufacturer's site is down, so the agent keeps its cached full rules", async () => {
  col.down = true;
  const r = await agentCall("GET", "/agent/v1/config");
  col.down = false;
  assert.equal(r.status, 503);
});

test("a batch goes to its manufacturer only, re-signed as the distributor on that site", async () => {
  const b = batch("COLGATE");
  const r = await agentCall("POST", "/agent/v1/batches", JSON.stringify(b));
  assert.equal(r.status, 202);
  assert.equal(col.batches.at(-1).batch_id, b.batch_id);
  assert.equal(col.batches.at(-1).distributor_id, "C-DIST-3");
  assert.ok(!pat.batches.some((x) => x.batch_id === b.batch_id), "never sent to the other manufacturer");
  // The same batch again: the site's 409 (already delivered) is passed back.
  assert.equal((await agentCall("POST", "/agent/v1/batches", JSON.stringify(b))).status, 409);
});

test("refusals and retries are passed back so the agent knows what to do", async () => {
  assert.equal((await agentCall("POST", "/agent/v1/batches", JSON.stringify(batch("MRF")))).status, 422, "not linked: refused");
  pat.down = true;
  assert.equal((await agentCall("POST", "/agent/v1/batches", JSON.stringify(batch("PATANJALI")))).status, 503, "site down: retry later");
  pat.down = false;
});

test("unknown distributor, bad signature or an old timestamp are refused", async () => {
  const body = JSON.stringify(batch("COLGATE"));
  assert.equal((await agentCall("POST", "/agent/v1/batches", body, { id: "NOPE" })).status, 401);
  assert.equal((await agentCall("POST", "/agent/v1/batches", body, { secret: "wrong" })).status, 401);
  assert.equal((await agentCall("POST", "/agent/v1/batches", body, { ts: Math.floor(Date.now() / 1000) - 3600 })).status, 401);
});

test("the real agent, through the hub, feeds both manufacturers with only their own lines", async () => {
  Object.assign(process.env, {
    DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "ssv-hub-agent-")),
    MIDDLEWARE_URL: hubUrl, DISTRIBUTOR_ID: "HUB-1", AGENT_SECRET: HUB_SECRET,
    DELETED_CHECK_INTERVAL_MINUTES: "0",
  });
  const { runSync } = await import("../../agent/src/sync.js");
  const { FakeTally, line } = await import("../../agent/fixtures/fake-tally.js");
  const d = (n) => { const x = new Date(); x.setUTCDate(x.getUTCDate() - n); return x.toISOString().slice(0, 10); };
  const fake = new FakeTally({ startingFrom: d(10) });
  fake.add({ date: d(5), lines: [line("Dant Kanti 100g", 10, 55), line("Colgate Strong Teeth 200g", 5, 102)] });
  fake.add({ date: d(3), lines: [line("Colgate Strong Teeth 200g", 4, 102)] });
  const before = { pat: pat.batches.length, col: col.batches.length, hb: pat.heartbeats.length + col.heartbeats.length };

  const report = await runSync({ trigger: "test", tally: fake });
  assert.equal(report.error, undefined, report.error);
  const up = report.companies[0].upload;
  assert.equal(up.rejected, 0);

  const items = (site, from) => site.batches.slice(from).flatMap((b) => (b.vouchers || []).flatMap((v) => v.lines.map((l) => l.item)));
  assert.deepEqual([...new Set(items(pat, before.pat))], ["Dant Kanti 100g"]);
  assert.deepEqual([...new Set(items(col, before.col))], ["Colgate Strong Teeth 200g"]);
  assert.equal(pat.heartbeats.length + col.heartbeats.length - before.hb, 2, "run report reaches both manufacturers");
});
