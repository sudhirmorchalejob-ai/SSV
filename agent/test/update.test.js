import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ssv-update-"));
process.chdir(tmp); // the service runs the agent with the config folder as its working directory
process.env.DATA_DIR = path.join(tmp, "data");
const { compareVersions, wanted, stage, updateDir } = await import("../src/update.js");

const exe = Buffer.from("pretend this is ssv-agent.exe 0.5.0");
const sha = crypto.createHash("sha256").update(exe).digest("hex");
const server = http.createServer((req, res) => {
  res.end(req.url === "/tampered.exe" ? Buffer.concat([exe, Buffer.from("!")]) : exe);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

test("versions compare as numbers, not text", () => {
  assert.ok(compareVersions("0.10.0", "0.9.9") > 0);
  assert.equal(compareVersions("0.4.1", "0.4.1"), 0);
  assert.ok(compareVersions("0.4", "0.4.1") < 0);
});

test("an update is wanted only if newer, complete, not marked bad, and running as the service", () => {
  const u = { version: "0.5.0", url: `${base}/ssv-agent.exe`, sha256: sha };
  assert.equal(wanted(u, "0.4.1", { service: true }), true);
  assert.equal(wanted(u, "0.5.0", { service: true }), false, "same version");
  assert.equal(wanted({ ...u, sha256: "" }, "0.4.1", { service: true }), false, "no checksum, no update");
  assert.equal(wanted(u, "0.4.1", { service: false }), false, "run by hand: only a log line");
  fs.mkdirSync(updateDir(), { recursive: true });
  fs.writeFileSync(path.join(updateDir(), "bad-0.5.0"), "rolled back");
  assert.equal(wanted(u, "0.4.1", { service: true }), false, "rolled back once: never again");
  fs.rmSync(path.join(updateDir(), "bad-0.5.0"));
});

test("a download is staged only when its checksum matches", async () => {
  assert.equal(await stage({ version: "0.5.0", url: `${base}/tampered.exe`, sha256: sha }), false);
  assert.equal(fs.existsSync(path.join(updateDir(), "update.json")), false);
  assert.equal(wanted({ version: "0.5.0", url: `${base}/ssv-agent.exe`, sha256: sha }, "0.4.1", { service: true }), false,
    "a failed download is not retried at once");

  assert.equal(await stage({ version: "0.5.1", url: `${base}/ssv-agent.exe`, sha256: sha }), true);
  assert.deepEqual(fs.readFileSync(path.join(updateDir(), "ssv-agent.exe")), exe);
  assert.equal(JSON.parse(fs.readFileSync(path.join(updateDir(), "update.json"), "utf8")).version, "0.5.1");
});
