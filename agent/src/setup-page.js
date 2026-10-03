// The local setup page, served by the agent at http://127.0.0.1:4100/.
// Self-contained (no outside scripts, styles or fonts): it runs on the distributor's PC.
export const SETUP_PAGE = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SSV Agent Setup</title>
<style>
:root{--ink:#1b2430;--soft:#5b6675;--line:#d8dde3;--bg:#f3f5f7;--card:#fff;--accent:#0d6e6e;--accent-bg:#e3f1f0;--ok:#237a3b;--ok-bg:#e5f3e8;--bad:#b3261e;--bad-bg:#fbe9e7;--warn:#8a5a00;--warn-bg:#fdf1dc;
  font:15px/1.5 "Segoe UI",system-ui,sans-serif;color:var(--ink);background:var(--bg)}
*{box-sizing:border-box}body{margin:0}
header{background:var(--ink);color:#fff;padding:14px 24px;display:flex;align-items:baseline;gap:14px;flex-wrap:wrap}
header h1{font-size:19px;margin:0;font-weight:600}header .v{color:#b8c2cc;font-size:13px}
main{max-width:860px;margin:0 auto;padding:20px 16px 60px}
nav{display:flex;gap:4px;border-bottom:2px solid var(--line);margin-bottom:18px;flex-wrap:wrap}
nav button{background:none;border:0;padding:10px 16px;font:inherit;color:var(--soft);cursor:pointer;border-bottom:3px solid transparent;margin-bottom:-2px}
nav button[aria-selected=true]{color:var(--ink);border-bottom-color:var(--accent);font-weight:600}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:18px 20px;margin-bottom:16px}
h2{font-size:16px;margin:0 0 12px}
label{display:block;font-weight:600;font-size:13px;margin:12px 0 4px}
.help{font-weight:400;color:var(--soft);font-size:12.5px}
input[type=text],input[type=password],input[type=number],input[type=date],textarea,select{width:100%;padding:8px 10px;border:1px solid var(--line);border-radius:6px;font:inherit;background:#fff}
textarea{font-family:Consolas,monospace;font-size:13px;min-height:110px}
input:focus,textarea:focus,select:focus,button:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.row{display:grid;grid-template-columns:1fr 1fr;gap:0 16px}@media(max-width:640px){.row{grid-template-columns:1fr}}
.btns{display:flex;gap:10px;flex-wrap:wrap;margin-top:16px}
button.b{padding:8px 16px;border-radius:6px;border:1px solid var(--accent);background:var(--accent);color:#fff;font:inherit;font-weight:600;cursor:pointer}
button.b.sec{background:#fff;color:var(--accent)}button.b:disabled{opacity:.5;cursor:default}
.msg{padding:10px 14px;border-radius:6px;margin-top:14px;white-space:pre-wrap}
.msg.ok{background:var(--ok-bg);color:var(--ok)}.msg.bad{background:var(--bad-bg);color:var(--bad)}.msg.info{background:var(--accent-bg);color:var(--accent)}
.err{color:var(--bad);font-size:12.5px}
dl{display:grid;grid-template-columns:200px 1fr;gap:6px 16px;margin:0}dt{color:var(--soft)}dd{margin:0}
@media(max-width:640px){dl{grid-template-columns:1fr}}
.pill{display:inline-block;padding:1px 10px;border-radius:10px;font-size:12.5px;font-weight:600}
.pill.ok{background:var(--ok-bg);color:var(--ok)}.pill.bad{background:var(--bad-bg);color:var(--bad)}.pill.warn{background:var(--warn-bg);color:var(--warn)}
pre.log{background:#101820;color:#d6dde4;padding:12px;border-radius:6px;font-size:12px;max-height:480px;overflow:auto;white-space:pre-wrap;margin:0}
.co{display:flex;align-items:center;gap:8px;margin:6px 0;font-weight:400}
.toggle{display:flex;align-items:center;gap:10px;font-weight:400;margin-top:12px}
[hidden]{display:none!important}
</style></head><body>
<header><h1>SSV Agent Setup</h1><span class="v" id="ver"></span></header>
<main>
<section id="signin" class="card" hidden>
  <h2>Sign in</h2>
  <p class="help">Enter the setup password. It was shown when the agent was installed, and is <code>LOCAL_API_TOKEN</code> in the agent's settings file (open it as an administrator).</p>
  <form id="signinForm"><label for="pw">Setup password</label><input type="password" id="pw" autocomplete="current-password" required>
  <div class="btns"><button class="b" type="submit">Sign in</button></div><div id="signinMsg"></div></form>
</section>

<div id="app" hidden>
<nav role="tablist">
  <button role="tab" data-tab="status" aria-selected="true">Status</button>
  <button role="tab" data-tab="connection">Connection</button>
  <button role="tab" data-tab="tally">Tally</button>
  <button role="tab" data-tab="options">Options</button>
  <button role="tab" data-tab="log">Log</button>
</nav>

<section data-panel="status">
  <div class="card"><h2>Now</h2><dl id="statusList"></dl>
  <div class="btns"><button class="b" id="syncNow">Sync now</button></div><div id="syncMsg"></div></div>
</section>

<section data-panel="connection" hidden>
  <div class="card"><h2>Paste the settings</h2>
    <p class="help">In the site (ERPNext): open this distributor or dealer, then <b>Actions → Show Agent Secret</b>. Copy the lines shown and paste them here.</p>
    <textarea id="paste" placeholder="MIDDLEWARE_URL=https://…&#10;MIDDLEWARE_BATCHES_PATH=…&#10;MIDDLEWARE_CONFIG_PATH=…&#10;DISTRIBUTOR_ID=…&#10;AGENT_SECRET=…"></textarea>
    <div class="btns"><button class="b sec" id="fillFromPaste">Fill in below</button></div>
  </div>
  <div class="card"><h2>Where the data goes</h2>
    <label for="MIDDLEWARE_URL">Site address</label><input type="text" id="MIDDLEWARE_URL" data-key="MIDDLEWARE_URL"><div class="err" data-err="MIDDLEWARE_URL"></div>
    <div class="row">
      <div><label for="MIDDLEWARE_BATCHES_PATH">Batches path</label><input type="text" id="MIDDLEWARE_BATCHES_PATH" data-key="MIDDLEWARE_BATCHES_PATH"><div class="err" data-err="MIDDLEWARE_BATCHES_PATH"></div></div>
      <div><label for="MIDDLEWARE_CONFIG_PATH">Settings path</label><input type="text" id="MIDDLEWARE_CONFIG_PATH" data-key="MIDDLEWARE_CONFIG_PATH"><div class="err" data-err="MIDDLEWARE_CONFIG_PATH"></div></div>
    </div>
    <div class="row">
      <div><label for="DISTRIBUTOR_ID">ID at the site</label><input type="text" id="DISTRIBUTOR_ID" data-key="DISTRIBUTOR_ID"><div class="err" data-err="DISTRIBUTOR_ID"></div></div>
      <div><label for="AGENT_SECRET">Agent secret <span class="help" id="secretState"></span></label><input type="password" id="AGENT_SECRET" data-key="AGENT_SECRET" autocomplete="off"><div class="err" data-err="AGENT_SECRET"></div></div>
    </div>
    <div class="btns"><button class="b sec" id="testConn">Test connection</button><button class="b" data-save="connection">Save and restart</button></div>
    <div id="connMsg"></div>
  </div>
</section>

<section data-panel="tally" hidden>
  <div class="card"><h2>TallyPrime on this PC</h2>
    <label for="TALLY_URL">Tally address <span class="help">TallyPrime: F1 Help → Settings → Connectivity → TallyPrime acts as Both or Server, port 9000</span></label>
    <input type="text" id="TALLY_URL" data-key="TALLY_URL" placeholder="http://localhost:9000"><div class="err" data-err="TALLY_URL"></div>
    <div class="btns"><button class="b sec" id="checkTally">Check Tally and list companies</button></div>
    <div id="tallyMsg"></div>
    <label>Company to read</label>
    <div id="companies"><p class="help">Press "Check Tally" to list the companies open in TallyPrime.</p></div>
    <input type="hidden" id="TALLY_COMPANY" data-key="TALLY_COMPANY">
    <div class="btns"><button class="b" data-save="tally">Save and restart</button></div><div id="tallyMsg2"></div>
  </div>
</section>

<section data-panel="options" hidden>
  <div class="card"><h2>Options</h2>
    <div class="row">
      <div><label for="SYNC_INTERVAL_MINUTES">Sync every (minutes) <span class="help">used until the site sets it</span></label><input type="number" min="5" max="1440" id="SYNC_INTERVAL_MINUTES" data-key="SYNC_INTERVAL_MINUTES"><div class="err" data-err="SYNC_INTERVAL_MINUTES"></div></div>
      <div><label for="SYNC_FROM">First sync starts on <span class="help">blank = company's start date</span></label><input type="date" id="SYNC_FROM" data-key="SYNC_FROM"><div class="err" data-err="SYNC_FROM"></div></div>
    </div>
    <div class="row">
      <div><label for="RECONCILE_EVERY_HOURS">Send reconciliation totals every (hours)</label><input type="number" min="0" max="168" id="RECONCILE_EVERY_HOURS" data-key="RECONCILE_EVERY_HOURS"><div class="err" data-err="RECONCILE_EVERY_HOURS"></div></div>
      <div></div>
    </div>
    <label class="toggle"><input type="checkbox" id="SHARE_RETAILER_CONTACTS" data-key="SHARE_RETAILER_CONTACTS" data-bool="true,false" data-default="true"> Send retailers' phone, address and PIN code <span class="help">(off keeps them on this PC)</span></label>
    <label class="toggle"><input type="checkbox" id="USE_PROXY" data-key="USE_PROXY" data-bool="1,0" data-default="0"> Use this PC's proxy for uploads <span class="help">(only if the network requires it)</span></label>
    <div class="btns"><button class="b" data-save="options">Save and restart</button></div><div id="optMsg"></div>
  </div>
</section>

<section data-panel="log" hidden>
  <div class="card"><h2>Recent log</h2><pre class="log" id="logBox"></pre>
  <div class="btns"><button class="b sec" id="refreshLog">Refresh</button></div></div>
</section>
</div>
</main>
<script>
(() => {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  let token = "";
  try { token = sessionStorage.getItem("ssvSetupToken") || ""; } catch (e) {}
  let setup = null, service = false;

  async function api(method, url, body) {
    const res = await fetch(url, { method, headers: { Authorization: "Bearer " + token, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { showSignin("Wrong password, or the session ended."); throw new Error("unauthorised"); }
    return { status: res.status, data };
  }
  function msg(el, kind, text) { $(el).innerHTML = text ? '<div class="msg ' + kind + '">' + esc(text) + "</div>" : ""; }
  function showSignin(text) { $("#app").hidden = true; $("#signin").hidden = false; msg("#signinMsg", "bad", text || ""); }

  $("#signinForm").addEventListener("submit", async (e) => {
    e.preventDefault(); token = $("#pw").value.trim();
    try { await load(); try { sessionStorage.setItem("ssvSetupToken", token); } catch (e2) {} } catch (err) {}
  });

  async function load() {
    const { data } = await api("GET", "/api/setup");
    setup = data; service = data.service;
    $("#ver").textContent = "agent " + data.version + (service ? " · running as the Windows service" : " · started by hand");
    for (const el of $$("[data-key]")) {
      const v = data.values[el.dataset.key];
      if (el.dataset.bool) el.checked = (v || el.dataset.default) === el.dataset.bool.split(",")[0];
      else if (el.type !== "password") el.value = v ?? "";
    }
    $("#secretState").textContent = data.secretSet ? "(set; leave blank to keep it)" : "(not set yet)";
    $("#AGENT_SECRET").value = "";
    renderCompanies(null);
    $("#signin").hidden = true; $("#app").hidden = false;
    refreshStatus();
  }

  // tabs
  for (const b of $$("nav button")) b.addEventListener("click", () => {
    for (const x of $$("nav button")) x.setAttribute("aria-selected", x === b);
    for (const p of $$("[data-panel]")) p.hidden = p.dataset.panel !== b.dataset.tab;
    if (b.dataset.tab === "log") refreshLog();
    if (b.dataset.tab === "status") refreshStatus();
  });

  const when = (t) => t ? new Date(t).toLocaleString() : "—";
  async function refreshStatus() {
    if ($("#app").hidden) return;
    try {
      const { data: s } = await api("GET", "/api/status");
      const last = s.lastRun;
      const problem = last && (last.error || (last.companies || []).map((c) => c.error || c.blocked || (c.upload && c.upload.error)).filter(Boolean).join("; "));
      const result = !last ? '<span class="pill warn">no run yet</span>' : problem ? '<span class="pill bad">problem</span> ' + esc(problem) : '<span class="pill ok">OK</span>';
      const counts = s;
      $("#statusList").innerHTML =
        "<dt>Last run</dt><dd>" + esc(when(last && last.finished)) + "</dd>" +
        "<dt>Result</dt><dd>" + result + "</dd>" +
        "<dt>Next run</dt><dd>" + esc(s.running ? "running now" : when(s.nextRunAt)) + "</dd>" +
        "<dt>Syncs every</dt><dd>" + esc(s.intervalMinutes + " min (set in " + s.intervalSetIn + ")") + "</dd>" +
        "<dt>Waiting to send</dt><dd>" + esc((counts.vouchersPending ?? 0) + " bills, " + (counts.itemsPending ?? 0) + " items") + "</dd>" +
        "<dt>Refused by the site</dt><dd>" + esc(counts.vouchersRejected ?? 0) + "</dd>" +
        "<dt>Companies</dt><dd>" + esc((last && last.companies || []).map((c) => c.company).join(", ") || "—") + "</dd>";
    } catch (e) {}
  }
  setInterval(refreshStatus, 10000);

  $("#syncNow").addEventListener("click", async () => {
    $("#syncNow").disabled = true; msg("#syncMsg", "info", "Syncing… this can take a few minutes on a first sync.");
    try {
      const { status } = await api("POST", "/api/sync-now");
      msg("#syncMsg", status === 409 ? "info" : "ok", status === 409 ? "A sync is already running." : "Sync finished.");
    } catch (e) { msg("#syncMsg", "bad", "Sync could not start."); }
    $("#syncNow").disabled = false; refreshStatus();
  });

  $("#fillFromPaste").addEventListener("click", () => {
    let n = 0;
    for (const line of $("#paste").value.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/); if (!m) continue;
      const el = document.getElementById(m[1]); if (el && el.dataset.key) { el.value = m[2]; n++; }
    }
    msg("#connMsg", n ? "info" : "bad", n ? n + " settings filled in. Test the connection, then save." : "No settings found in the pasted text.");
  });

  function formValues(panel) {
    const out = {};
    for (const el of $$('[data-panel="' + panel + '"] [data-key]')) {
      out[el.dataset.key] = el.dataset.bool ? el.dataset.bool.split(",")[el.checked ? 0 : 1] : el.value;
    }
    return out;
  }
  function showErrors(errors) {
    for (const el of $$("[data-err]")) el.textContent = (errors || {})[el.dataset.err] || "";
  }

  $("#testConn").addEventListener("click", async () => {
    msg("#connMsg", "info", "Testing…"); showErrors({});
    const { data } = await api("POST", "/api/setup/test-connection", { values: formValues("connection") });
    if (data.errors) { showErrors(data.errors); msg("#connMsg", "bad", "Fix the marked fields."); return; }
    if (!data.ok) { msg("#connMsg", "bad", data.error); return; }
    const lines = data.principals.map((p) => "• " + p.code + ": stock groups " + (p.stockGroups.join(", ") || "none") + (p.stockCategories.length ? "; categories " + p.stockCategories.join(", ") : "") + (p.items ? "; " + p.items + " named items" : ""));
    msg("#connMsg", "ok", "Connected. The site will receive only:\n" + (lines.join("\n") || "(no rules yet: ask the site to add a stock group rule)"));
  });

  function renderCompanies(names) {
    const current = $("#TALLY_COMPANY").value;
    if (!names) {
      $("#companies").innerHTML = current ? '<p>Reading <b>' + esc(current) + '</b>. Press "Check Tally" to change it.</p>' : '<p class="help">Reading every open company. Press "Check Tally" to pick one.</p>';
      return;
    }
    const opts = [["", "Every open company"], ...names.map((n) => [n, n])];
    $("#companies").innerHTML = opts.map(([v, label], i) =>
      '<label class="co"><input type="radio" name="co" value="' + esc(v) + '"' + (v === current ? " checked" : "") + '> ' + esc(label) + "</label>").join("");
    for (const r of $$('input[name="co"]')) r.addEventListener("change", () => { $("#TALLY_COMPANY").value = r.value; });
  }
  $("#checkTally").addEventListener("click", async () => {
    msg("#tallyMsg", "info", "Checking…");
    const { data } = await api("GET", "/api/setup/tally");
    if (!data.connected) { msg("#tallyMsg", "bad", data.error || "TallyPrime is not reachable."); renderCompanies(null); return; }
    msg("#tallyMsg", "ok", "TallyPrime answered in " + data.latencyMs + " ms. " + data.companies.length + " company(ies) open.");
    renderCompanies(data.companies);
  });

  for (const b of $$("[data-save]")) b.addEventListener("click", async () => {
    const panel = b.dataset.save, box = { connection: "#connMsg", tally: "#tallyMsg2", options: "#optMsg" }[panel];
    showErrors({}); b.disabled = true;
    const { status, data } = await api("POST", "/api/setup/save", { values: formValues(panel) });
    b.disabled = false;
    if (status !== 200) { showErrors(data.errors); msg(box, "bad", data.error || "Fix the marked fields."); return; }
    if (!data.saved.length) { msg(box, "info", "Nothing changed."); return; }
    if (!data.restarting) { msg(box, "ok", "Saved. Close the agent window and start it again to use the new settings."); return; }
    msg(box, "info", "Saved. The agent is restarting with the new settings…");
    const t0 = Date.now();
    const wait = setInterval(async () => {
      try { const r = await fetch("/api/status", { headers: { Authorization: "Bearer " + token } }); if (r.ok) { clearInterval(wait); msg(box, "ok", "Saved, and the agent is running with the new settings."); load(); } } catch (e) {}
      if (Date.now() - t0 > 120000) { clearInterval(wait); msg(box, "bad", "The agent has not come back after 2 minutes. Check the Windows service 'SSV Tally Connector'."); }
    }, 2000);
  });

  async function refreshLog() {
    try {
      const { data } = await api("GET", "/api/logs?limit=200");
      $("#logBox").textContent = (data || []).slice().reverse()
        .map((l) => l.ts + " " + String(l.level).toUpperCase().padEnd(5) + " " + l.message + (l.meta ? " " + JSON.stringify(l.meta) : "")).join("\n") || "(nothing logged yet)";
    } catch (e) {}
  }
  $("#refreshLog").addEventListener("click", refreshLog);

  if (token) load().catch(() => {}); else showSignin();
})();
</script></body></html>`;
