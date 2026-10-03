/**
 * erpnext-setup.mjs — prepares an ERPNext site for the SSV pilot, over the REST API.
 *
 *   node tools/erpnext-setup.mjs --dry-run      show what would be created (reads only)
 *   node tools/erpnext-setup.mjs                create what is missing, print the agent .env
 *
 * Needs Node 18+. Reads ERPNEXT_URL, ERPNEXT_API_KEY, ERPNEXT_API_SECRET from the
 * environment (an admin API key; it is never given to distributors).
 *
 * Idempotent: anything that already exists is left alone. An existing distributor's
 * agent secret is only replaced with --rotate-secret.
 *
 * Options (defaults in brackets):
 *   --principal-code  [PATANJALI]          --principal-name   [Patanjali Ayurved]
 *   --distributor-id  [DIST-001]           --distributor-name [Sharma Distributors]
 *   --stock-group     [Patanjali]  stock group name in the distributor's Tally
 *   --zone [West Zone]  --state [Maharashtra]  --city [Pune]
 *   --no-items        skip the sample principal items
 *   --reclassify      set product line / category / pack size on existing sample items too
 */

import crypto from "crypto";

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : d;
};

const URL_ = (process.env.ERPNEXT_URL || "").replace(/\/+$/, "");
const KEY = process.env.ERPNEXT_API_KEY;
const SECRET = process.env.ERPNEXT_API_SECRET;
if (!URL_ || !KEY || !SECRET) {
  console.error("Set ERPNEXT_URL, ERPNEXT_API_KEY and ERPNEXT_API_SECRET first.");
  process.exit(2);
}

const DRY = flag("dry-run");
const P = {
  code: opt("principal-code", "PATANJALI"),
  name: opt("principal-name", "Patanjali Ayurved"),
  distId: opt("distributor-id", "DIST-001"),
  distName: opt("distributor-name", "Sharma Distributors"),
  stockGroup: opt("stock-group", "Patanjali"),
  zone: opt("zone", "West Zone"),
  state: opt("state", "Maharashtra"),
  city: opt("city", "Pune"),
};

// Sample principal items for the dummy pilot. item_name matches the Tally item
// name in the dummy dataset, so the app auto-maps them. The classification
// (product line, category, pack size, size group, sort) drives the deck reports.
// Last column: HSN code (India Compliance makes one mandatory on every Item).
const ITEMS = [
  ["PAT-DK-100", "Dant Kanti 100g", "Oral Care", "Paste", "100Gm", "Pst", 4, "33061020"],
  ["PAT-DK-200", "Dant Kanti 200g", "Oral Care", "Paste", "200Gm", "Pst", 6, "33061020"],
  ["PAT-KS-200", "Kesh Kanti Shampoo 200ml", "Hair Care", "Shampoo", "200ml", "Shm", 6, "33051090"],
  ["PAT-GH-1L", "Cow Ghee 1L", "Foods", "Ghee", "1L", "Ghe", 8, "04059020"],
  ["PAT-AV-150", "Aloe Vera Gel 150ml", "Skin Care", "Gel", "150ml", "Gel", 5, "33049990"],
];

async function api(method, path, body) {
  const res = await fetch(`${URL_}${path}`, {
    method,
    headers: { Authorization: `token ${KEY}:${SECRET}`, Accept: "application/json", "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 300) }; }
  if (!res.ok) {
    const msg = data?.exception || data?._server_messages || data?.raw || res.statusText;
    throw new Error(`${method} ${path} → ${res.status}: ${String(msg).slice(0, 300)}`);
  }
  return data;
}
const enc = encodeURIComponent;
const exists = async (dt, name) => {
  try { await api("GET", `/api/resource/${enc(dt)}/${enc(name)}`); return true; } catch (e) { if (/→ 404/.test(e.message)) return false; throw e; }
};
const plan = [];
async function ensure(dt, name, doc) {
  if (await exists(dt, name)) { plan.push(`= ${dt} "${name}" exists`); return false; }
  plan.push(`+ ${dt} "${name}"`);
  if (!DRY) await api("POST", `/api/resource/${enc(dt)}`, doc);
  return true;
}

async function main() {
  const v = (await api("GET", "/api/method/frappe.utils.change_log.get_versions")).message;
  console.log(`Site ${URL_}: frappe ${v.frappe?.version}, erpnext ${v.erpnext?.version}${v.ssv_channel ? `, ssv_channel ${v.ssv_channel.version}` : ""}`);
  const appInstalled = Boolean(v.ssv_channel);

  // ── Masters ────────────────────────────────────────────────────────────────
  await ensure("Brand", P.name, { brand: P.name });
  await ensure("Item Group", `${P.name} Products`, { item_group_name: `${P.name} Products`, parent_item_group: "All Item Groups", is_group: 0 });

  const india = (await exists("Territory", "India")) ? "India" : "All Territories";
  await ensure("Territory", P.zone, { territory_name: P.zone, parent_territory: india, is_group: 1 });
  await ensure("Territory", P.state, { territory_name: P.state, parent_territory: P.zone, is_group: 1 });
  await ensure("Territory", P.city, { territory_name: P.city, parent_territory: P.state, is_group: 0 });

  await ensure("Customer Group", "Distributor", { customer_group_name: "Distributor", parent_customer_group: "All Customer Groups", is_group: 0 });
  await ensure("Customer", P.distName, { customer_name: P.distName, customer_type: "Company", customer_group: "Distributor", territory: P.city });

  if (!flag("no-items")) {
    // Sites where the setup wizard has not run lack the "Nos" unit.
    await ensure("UOM", "Nos", { uom_name: "Nos" });
    const indiaCompliance = Boolean(v.india_compliance);
    for (const [code, name, line, category, size, sizeGroup, sizeSort, hsn] of ITEMS) {
      if (indiaCompliance) await ensure("GST HSN Code", hsn, { hsn_code: hsn, description: `${category} (${line})` });
      const created = await ensure("Item", code, {
        item_code: code, item_name: name, item_group: `${P.name} Products`, brand: P.name,
        stock_uom: "Nos", is_stock_item: 0, include_item_in_manufacturing: 0,
        ...(indiaCompliance ? { gst_hsn_code: hsn } : {}),
      });
      // Classification fields exist only once ssv_channel is installed.
      if (appInstalled && (created || flag("reclassify"))) {
        plan.push(`~ Item "${code}" classification ${line} / ${category} / ${size}`);
        if (!DRY) {
          await api("PUT", `/api/resource/Item/${enc(code)}`, {
            ssv_product_line: line, ssv_category: category, ssv_size: size, ssv_size_group: sizeGroup, ssv_size_sort: sizeSort,
          });
        }
      }
    }
  }

  // ── SSV configuration (needs the ssv_channel app) ───────────────────────────
  let envBlock = null;
  if (!appInstalled) {
    plan.push("! ssv_channel app not installed on this site: install it (guide step 2), then run this again");
  } else {
    const settings = (await api("GET", "/api/resource/SSV Settings/SSV Settings")).data;
    if (settings.principal_code === P.code) plan.push(`= SSV Settings principal_code ${P.code}`);
    else {
      plan.push(`~ SSV Settings principal_code ${settings.principal_code || "(empty)"} → ${P.code}`);
      if (!DRY) await api("PUT", "/api/resource/SSV Settings/SSV Settings", { principal_code: P.code, principal_name: P.name });
    }

    const distExists = await exists("SSV Distributor", P.distId);
    const secret = crypto.randomBytes(32).toString("base64url");
    if (!distExists) {
      plan.push(`+ SSV Distributor "${P.distId}" with rule Stock Group = ${P.stockGroup}`);
      if (!DRY) {
        await api("POST", "/api/resource/SSV Distributor", {
          distributor_id: P.distId, distributor_name: P.distName, enabled: 1,
          customer: P.distName, territory: P.city, agent_secret: secret,
          rules: [{ rule_type: "Stock Group", tally_value: P.stockGroup }],
        });
        envBlock = secret;
      }
    } else if (flag("rotate-secret")) {
      plan.push(`~ SSV Distributor "${P.distId}": new agent secret`);
      if (!DRY) { await api("PUT", `/api/resource/SSV Distributor/${enc(P.distId)}`, { agent_secret: secret }); envBlock = secret; }
    } else {
      plan.push(`= SSV Distributor "${P.distId}" exists (secret unchanged; use --rotate-secret or Actions → Show Agent Secret)`);
    }

    if (envBlock) {
      console.log(`\nAgent .env for ${P.distName} (keep it secret):\n`);
      console.log([
        `MIDDLEWARE_URL=${URL_}`,
        "MIDDLEWARE_BATCHES_PATH=/api/method/ssv_channel.api.batches",
        "MIDDLEWARE_CONFIG_PATH=/api/method/ssv_channel.api.config",
        `DISTRIBUTOR_ID=${P.distId}`,
        `AGENT_SECRET=${envBlock}`,
      ].join("\n"));
    }
  }

  console.log(`\n${DRY ? "Plan (dry run, nothing changed)" : "Done"}:`);
  for (const line of plan) console.log(`  ${line}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
