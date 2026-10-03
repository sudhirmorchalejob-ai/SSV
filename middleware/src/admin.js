/**
 * admin.js — manage the hub's registry.
 *
 *   node src/admin.js add-distributor RL-001 "Rajlaxmi Solutions"
 *       creates the distributor with a new hub secret and writes the agent's .env lines
 *       to RL-001.agent.env (readable by you only); send that file to the distributor
 *   HUB_LINK_SECRET=<secret from that site's Show Agent Secret> \
 *   node src/admin.js link RL-001 CEAT https://ceat.example.com DIST-001
 *       routes RL-001's CEAT data to that site, as distributor DIST-001 there
 *   node src/admin.js unlink RL-001 CEAT
 *   node src/admin.js disable RL-001 | enable RL-001
 *   node src/admin.js list
 *
 * Secrets never go on the command line (visible in process lists and shell history):
 * the link secret comes from HUB_LINK_SECRET, the hub secret is generated here.
 */

import fs from "fs";
import crypto from "crypto";
import { loadRegistry, saveRegistry, registryPath, DEFAULT_PATHS } from "./registry.js";

const [cmd, ...args] = process.argv.slice(2);
const data = loadRegistry();
data.distributors ||= {};
const need = (n, usage) => {
  if (args.length < n) {
    console.error(`usage: node src/admin.js ${usage}`);
    process.exit(2);
  }
};

switch (cmd) {
  case "add-distributor": {
    need(2, 'add-distributor <ID> "<Name>"');
    const [id, name] = args;
    if (data.distributors[id]) throw new Error(`${id} exists`);
    const secret = crypto.randomBytes(32).toString("base64url");
    data.distributors[id] = { name, enabled: true, secret, links: [] };
    saveRegistry(data);
    const file = `${id}.agent.env`;
    fs.writeFileSync(file, [
      `MIDDLEWARE_URL=${process.env.HUB_PUBLIC_URL || "https://<hub address>"}`,
      "MIDDLEWARE_BATCHES_PATH=/agent/v1/batches",
      "MIDDLEWARE_CONFIG_PATH=/agent/v1/config",
      `DISTRIBUTOR_ID=${id}`,
      `AGENT_SECRET=${secret}`,
      "",
    ].join("\n"), { mode: 0o600 });
    console.log(`added ${id} (${name}); agent settings written to ${file}`);
    break;
  }
  case "link": {
    need(4, "link <ID> <PRINCIPAL> <site URL> <distributor ID on that site>   (HUB_LINK_SECRET=...)");
    const [id, principal, url, siteId] = args;
    const d = data.distributors[id];
    if (!d) throw new Error(`no distributor ${id}`);
    const secret = process.env.HUB_LINK_SECRET;
    if (!secret) throw new Error("set HUB_LINK_SECRET to that site's agent secret for this distributor");
    d.links = (d.links || []).filter((l) => l.principal !== principal);
    d.links.push({ principal, url: url.replace(/\/+$/, ""), ...DEFAULT_PATHS, distributorId: siteId, secret });
    saveRegistry(data);
    console.log(`${id}: ${principal} data goes to ${url} as ${siteId}`);
    break;
  }
  case "unlink": {
    need(2, "unlink <ID> <PRINCIPAL>");
    const d = data.distributors[args[0]];
    if (!d) throw new Error(`no distributor ${args[0]}`);
    d.links = d.links.filter((l) => l.principal !== args[1]);
    saveRegistry(data);
    console.log(`${args[0]}: ${args[1]} unlinked`);
    break;
  }
  case "share":
  case "unshare": {
    // A dealer's items for both the manufacturer and the distributor supplying them.
    need(3, `${cmd} <ID> <PRINCIPAL> <PRINCIPAL>`);
    const [id, a, b] = args;
    const d = data.distributors[id];
    if (!d) throw new Error(`no distributor ${id}`);
    const linked = new Set((d.links || []).map((l) => l.principal));
    if (cmd === "share" && !(linked.has(a) && linked.has(b))) throw new Error(`link ${id} to both ${a} and ${b} first`);
    const same = (s) => s.includes(a) && s.includes(b);
    d.shares = (d.shares || []).filter((s) => !same(s));
    if (cmd === "share") d.shares.push([a, b]);
    saveRegistry(data);
    console.log(`${id}: items matching both ${a} and ${b} ${cmd === "share" ? "now go to both" : "go to one only again"}`);
    break;
  }
  case "disable":
  case "enable": {
    need(1, `${cmd} <ID>`);
    const d = data.distributors[args[0]];
    if (!d) throw new Error(`no distributor ${args[0]}`);
    d.enabled = cmd === "enable";
    saveRegistry(data);
    console.log(`${args[0]} ${cmd}d`);
    break;
  }
  case "list":
    for (const [id, d] of Object.entries(data.distributors)) {
      console.log(`${id}  ${d.enabled === false ? "(disabled) " : ""}${d.name}`);
      for (const l of d.links || []) console.log(`    ${l.principal.padEnd(10)} → ${l.url} as ${l.distributorId}`);
      for (const s of d.shares || []) console.log(`    shared: ${s.join(" + ")}`);
    }
    console.log(`registry: ${registryPath()}`);
    break;
  default:
    console.error("commands: add-distributor, link, unlink, share, unshare, disable, enable, list");
    process.exit(2);
}
