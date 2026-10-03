/**
 * The setup page's settings: .env read/write that keeps comments, validation,
 * pasted "Show Agent Secret" lines, and the signed connection test.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

const { readEnv, writeEnv, currentSettings, parsePasted, validate, testConnection } = await import("../src/setup.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ssv-setup-"));
const file = path.join(dir, ".env");
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test("saving changes values in place and keeps comments and other lines", () => {
  fs.writeFileSync(file, "# Tally\nTALLY_URL=http://localhost:9000\nTALLY_COMPANY=\n\n# secret below\nAGENT_SECRET=old-secret-value-123\nLOCAL_API_TOKEN=keep-me\n");
  writeEnv({ TALLY_COMPANY: "Shop #1 (Distributor)", SYNC_INTERVAL_MINUTES: "15" }, file);
  const text = fs.readFileSync(file, "utf8");
  assert.match(text, /^# Tally\r\nTALLY_URL=http:\/\/localhost:9000\r\nTALLY_COMPANY="Shop #1 \(Distributor\)"\r\n\r\n# secret below\r\n/);
  assert.match(text, /LOCAL_API_TOKEN=keep-me\r\nSYNC_INTERVAL_MINUTES=15\r\n$/, "new keys are appended at the end");
  const env = readEnv(file);
  assert.equal(env.TALLY_COMPANY, "Shop #1 (Distributor)", "a # inside a value survives");
  assert.equal(env.AGENT_SECRET, "old-secret-value-123");
});

test("the page never receives the secret, only whether one is set", () => {
  const s = currentSettings(file);
  assert.equal(s.values.AGENT_SECRET, undefined);
  assert.equal(s.secretSet, true);
  assert.equal(s.values.TALLY_COMPANY, "Shop #1 (Distributor)");
  assert.equal("LOCAL_API_TOKEN" in s.values, false, "the setup password is not a page setting");
});

test("pasted Show Agent Secret lines fill the connection fields", () => {
  const got = parsePasted("Some text\nMIDDLEWARE_URL=https://ceat.example.com\r\nDISTRIBUTOR_ID=DIST-009\nAGENT_SECRET=abcdefghijklmnopqrstu\nLOCAL_API_TOKEN=nope\n");
  assert.deepEqual(got, { MIDDLEWARE_URL: "https://ceat.example.com", DISTRIBUTOR_ID: "DIST-009", AGENT_SECRET: "abcdefghijklmnopqrstu" });
});

test("validation refuses bad values and anything that could add lines", () => {
  const { updates, errors } = validate({
    MIDDLEWARE_URL: "http://evil.example.com", DISTRIBUTOR_ID: "DIST 1", SYNC_INTERVAL_MINUTES: "2",
    TALLY_COMPANY: "A\nLOCAL_API_TOKEN=x", SHARE_RETAILER_CONTACTS: "maybe", LOCAL_API_TOKEN: "x", UNKNOWN: "y",
  }, { secretSet: true });
  assert.deepEqual(Object.keys(errors).sort(), ["DISTRIBUTOR_ID", "MIDDLEWARE_URL", "SHARE_RETAILER_CONTACTS", "SYNC_INTERVAL_MINUTES", "TALLY_COMPANY"]);
  assert.deepEqual(updates, {}, "unknown keys and the setup password are ignored");

  const ok = validate({ MIDDLEWARE_URL: "https://ceat.example.com", DISTRIBUTOR_ID: "DIST-009", AGENT_SECRET: "", SYNC_FROM: "" }, { secretSet: true });
  assert.deepEqual(ok, { updates: { MIDDLEWARE_URL: "https://ceat.example.com", DISTRIBUTOR_ID: "DIST-009", SYNC_FROM: "" }, errors: {} },
    "a blank secret keeps the current one; a blank optional value clears it");
  assert.equal(validate({ DISTRIBUTOR_ID: "DIST-009" }, { secretSet: false }).errors.AGENT_SECRET, "required");
});

test("saving a tab writes only what changed; a missing key counts as its default", async () => {
  const { changedOnly } = await import("../src/setup.js");
  const saved = { TALLY_COMPANY: "Kaveri", USE_PROXY: "0" };
  assert.deepEqual(changedOnly({ SYNC_FROM: "", SYNC_INTERVAL_MINUTES: "", SHARE_RETAILER_CONTACTS: "true", USE_PROXY: "0",
    RECONCILE_EVERY_HOURS: "24", TALLY_COMPANY: "Kaveri" }, saved), {}, "blank or default values change nothing");
  assert.deepEqual(changedOnly({ RECONCILE_EVERY_HOURS: "6", SHARE_RETAILER_CONTACTS: "false", TALLY_COMPANY: "" }, saved),
    { RECONCILE_EVERY_HOURS: "6", SHARE_RETAILER_CONTACTS: "false", TALLY_COMPANY: "" });
});

test("the connection test signs like the agent and explains a refusal", async () => {
  const secret = "right-secret-0123456789";
  const server = http.createServer((req, res) => {
    const want = crypto.createHmac("sha256", secret).update(`${req.headers["x-ssv-timestamp"]}.`).digest("hex");
    if (req.url !== "/api/method/ssv_channel.api.config") { res.statusCode = 404; return res.end("{}"); }
    if (want !== req.headers["x-ssv-signature"] || req.headers["x-ssv-distributor"] !== "DIST-009") { res.statusCode = 401; return res.end("{}"); }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ message: { principals: [{ code: "CEAT", stockGroups: ["Ceat Tyre"], stockCategories: [], items: [] }] } }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = { MIDDLEWARE_URL: `http://127.0.0.1:${server.address().port}`, MIDDLEWARE_CONFIG_PATH: "/api/method/ssv_channel.api.config", DISTRIBUTOR_ID: "DIST-009" };
  try {
    assert.deepEqual(await testConnection({ ...base, AGENT_SECRET: secret }),
      { ok: true, principals: [{ code: "CEAT", stockGroups: ["Ceat Tyre"], stockCategories: [], items: 0 }] });
    const bad = await testConnection({ ...base, AGENT_SECRET: "wrong-secret-0123456789" });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /refused the ID or secret/);
    const lost = await testConnection({ ...base, MIDDLEWARE_CONFIG_PATH: "/nowhere", AGENT_SECRET: secret });
    assert.match(lost.error, /not at that path/);
  } finally {
    server.close();
  }
});
