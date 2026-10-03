import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import os from "os";
import path from "path";

// Mock TallyPrime: GET → "TallyPrime Server is Running"; POST expects UTF-16LE XML.
const seen = { gets: 0, posts: 0, contentTypes: [], bodies: [] };
let failNextPosts = 0;

const COMPANIES_XML = `<ENVELOPE><BODY><DATA><COLLECTION>
<COMPANY NAME="पतंजलि वितरक"><GUID>abc-123</GUID><STARTINGFROM>20260401</STARTINGFROM><ALTVCHID> 812</ALTVCHID><ALTMSTID> 95</ALTMSTID><ISAGGREGATE>No</ISAGGREGATE></COMPANY>
<COMPANY NAME="Group Co"><GUID>grp-1</GUID><ISAGGREGATE>Yes</ISAGGREGATE></COMPANY>
</COLLECTION></DATA></BODY></ENVELOPE>`;

const server = http.createServer((req, res) => {
  if (req.method === "GET") {
    seen.gets++;
    return res.end("<RESPONSE>TallyPrime Server is Running</RESPONSE>");
  }
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    seen.posts++;
    seen.contentTypes.push(req.headers["content-type"]);
    seen.bodies.push(Buffer.concat(chunks).toString("utf16le"));
    if (failNextPosts > 0) { failNextPosts--; res.statusCode = 500; return res.end(); }
    res.end(Buffer.from(COMPANIES_XML, "utf16le"));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));

Object.assign(process.env, {
  TALLY_URL: `http://127.0.0.1:${server.address().port}`,
  TALLY_RETRY_DELAY_MS: "10",
  DATA_DIR: path.join(os.tmpdir(), `ssv-http-${process.pid}`),
});
const { fetchCompanies } = await import("../src/tally/client.js");

after(() => server.close());

test("requests go out as UTF-16 and Hindi names come back intact; group companies are dropped", async () => {
  const companies = await fetchCompanies();
  assert.equal(seen.contentTypes[0], "text/xml;charset=utf-16");
  assert.match(seen.bodies[0], /<TYPE>Company<\/TYPE>/);
  assert.deepEqual(companies.map((c) => [c.name, c.altVchId, c.altMstId, c.startingFrom]), [["पतंजलि वितरक", 812, 95, "2026-04-01"]]);
});

test("each attempt pings Tally first and failures are retried", async () => {
  const before = { ...seen };
  failNextPosts = 2;
  const companies = await fetchCompanies();
  assert.equal(companies.length, 1);
  assert.equal(seen.posts - before.posts, 3, "two failures, then success");
  assert.equal(seen.gets - before.gets, 3, "a ping before every attempt");
});
