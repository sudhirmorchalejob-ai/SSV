# SSV Platform — prompt pack for the build AI

Paste **Prompt 0** at the start of every new AI session in this repo. Then paste the
numbered prompt for whatever step you are on. Do them in order; each one ends with
something to report back, and the next prompt assumes the previous one passed.

Status of this file: written 24 Sep 2026 from the working tree at `Downloads\ssv-platform`.
Update the "Where the project stands" list as steps complete.

---

## Prompt 0 — context (paste first, every session)

```
You are a senior engineer continuing an existing project. Read before you write:
README.md at the repo root, erpnext-app/ssv_channel/README.md, and the architecture
blueprint at https://claude.ai/artifact/8DTd36pnAmGoqsc5MVsYki (sections C, D, F, G
and the Build status section).

WHAT THE PRODUCT IS
Sales & Stock Visibility for FMCG-style manufacturers. Distributors run TallyPrime.
A connector agent on each distributor PC reads their Tally and sends the principal
(manufacturer) only that principal's items: secondary sales to retailers, daily
closing stock, retailers, and later outstanding. The principal sees it in ERPNext.
Scope is visibility only. Ordering, invoicing and payments are Phase 2, not now.

THE THREE PARTS
1. agent/ — Node 22 connector on the distributor PC (v0.2). Reads Tally XML on
   port 9000, stages in SQLite, uploads HMAC-signed batches. Built as ssv-agent.exe.
2. erpnext-app/ssv_channel/ — Frappe v15 app (v0.1). Non-accounting DocTypes, a
   signed ingest API, three reports. The agent currently posts straight to it.
3. middleware/ — multi-tenant server between many agents and many ERPNext sites.
   Not started. Needed when one distributor serves two manufacturers.

DECISIONS THAT MUST NOT BE BROKEN
- Nothing in ssv_channel posts to the GL or the stock ledger. Distributor data lives
  in the app's own DocTypes. Never model it as Sales Invoice, Stock Entry or Warehouse.
- Per-principal filtering happens on the distributor's PC. One principal's data must
  never leave the machine towards another principal, not even transiently.
- Idempotency: a voucher is keyed on (tally company guid, voucher guid); a newer copy
  is one with a higher (sync_epoch, alterId). Older copies are ignored, not applied.
- HTTP contract, unchanged: X-SSV-Distributor, X-SSV-Timestamp,
  X-SSV-Signature = hex(HMAC-SHA256(agent_secret, timestamp + "." + raw body)).
  202 applied · 409 duplicate · 401 bad signature (agent retries) · 422 refused (agent
  marks rows rejected) · 503 site not set up (agent retries).
- The agent's batch format is also the middleware's contract. Changing it means
  changing both sides and re-issuing the exe, so treat it as frozen unless I agree.
- ERPNext is v15. The principal keeps their own ERP; ERPNext here is the visibility
  system (Mode A in the blueprint).

WHERE THE PROJECT STANDS (24 Sep 2026)
- Agent: written, 28 tests pass against a fake Tally. NEVER run against a real Tally.
- ssv_channel: written, exercised against an in-memory stand-in for Frappe's database.
  NEVER installed on a real bench.
- No dummy Tally dataset. No godown-level stock (item level only). No aggregates:
  reports query the line tables. 3 of ~12 reports exist. Alerts are shown in reports
  but not sent. No Windows service installer. No ERPNext-to-Tally push (Phase 2).
- Blocker: the ERPNext site was only reachable over an ngrok tunnel that is down.

HOW TO WORK
- Do not invent requirements. If something is not in the README or the blueprint, ask.
- Prefer small, reviewable changes. Run the existing tests after each change:
  `cd agent && npm test`, and on the bench `bench --site <site> run-tests --app ssv_channel`.
- When a real system contradicts an assumption in the code, fix the code and write the
  real behaviour into the README, so the next session does not re-learn it.
- Tell me plainly when something cannot be verified from here; do not simulate a pass.

Acknowledge with a 5-line summary of the current state and what you believe the next
step is. Do not change any file yet.
```

---

## Prompt 1 — make the ERPNext site reachable at a fixed URL

```
Step 1. The ERPNext site must be reachable at an address that survives a restart;
a free ngrok URL changes every time and breaks the agent's .env.

Do this:
1. Check what is running: bench directory, site name, `bench version`, whether it is
   `bench start` (dev) or supervisor/nginx (production), and what port it serves.
2. Give me the three options with their trade-offs for a pilot: reserved ngrok domain,
   Cloudflare Tunnel, or a small VPS with a real domain. Recommend one for a pilot that
   a manufacturer will see, and say what it costs and what I have to do.
3. Once the URL is fixed, verify from outside: the site loads over HTTPS, and
   `GET /api/method/ping` answers.
4. Note in the README how the site is exposed and the exact base URL.

The ingest endpoints are open to guests and authenticated by signature alone, so the
site must be HTTPS and should be rate-limited. Tell me if it is not.

Report: bench path, site name, Frappe/ERPNext versions, the final URL, and the ping output.
```

---

## Prompt 2 — install ssv_channel on the real bench

```
Step 2. Install the app on the bench and make its own tests pass on real Frappe/MariaDB.

1. Install: copy erpnext-app/ssv_channel to apps/, pip install -e, add to sites/apps.txt,
   `bench --site <site> install-app ssv_channel`, `bench restart`.
2. Run `bench --site <site> run-tests --app ssv_channel`.
3. Fix whatever real Frappe disagrees with. Expect trouble in: DocType JSON fields that
   the generator produced but Frappe validates differently (naming, link options,
   permissions, child-table parent fields), the Single DocType SSV Settings, the
   whitelisted guest endpoints, and reading the raw request body.
4. Confirm the SSV Channel workspace and all three reports open without error on an
   empty site.
5. Re-run the tests until green. Do not weaken a test to make it pass; if a test was
   wrong about Frappe, say so explicitly in your report.

Do not change the HTTP contract or the DocType field names the agent sends. If a field
must be renamed, flag it to me first — it means rebuilding the exe.

Report: install output, test output, every file you changed and why.
```

---

## Prompt 3 — end-to-end on the real bench with the fake Tally

```
Step 3. Prove the whole chain on real ERPNext before involving a real Tally.

1. In ERPNext: set SSV Settings principal code; create one SSV Distributor with a
   stock-group rule; take the agent secret.
2. Point the agent at the real site (.env) and run it against the repo's fake Tally
   fixture, not a real one.
3. Verify in ERPNext: SSV Tally Company, SSV Channel Item (mapped and unmapped),
   SSV Retailer, SSV Stock Snapshot, SSV Secondary Voucher with its items, SSV Ingest Log.
4. Verify the edge cases deliberately: replay the same batch (expect 409, no duplicate
   rows); send a voucher with a lower (sync_epoch, alterId) than one already stored
   (expect it ignored); send a bad signature (expect 401); send a batch before SSV
   Settings is filled (expect 503).
5. Open the three reports and check the numbers against the fixture by hand.

Report: what each check produced, and a screenshot or table of the three reports.
```

---

## Prompt 4 — verify the agent against a real TallyPrime

```
Step 4. This is the largest unknown in the project. The agent's Tally behaviour was
written against a fake server and five assumptions have never been confirmed.

Write a standalone probe script (agent/tools/probe-tally.mjs) that talks to a real
TallyPrime on port 9000 and prints, for the loaded company, whether each of these holds:
1. A collection with FILTERS on $AlterID and on $MasterID actually filters, rather than
   returning everything.
2. The company exports ALTVCHID, ALTMSTID, LASTVOUCHERDATE and ISAGGREGATE.
3. The Statistics report layout: STATNAME / STATVALUE / STATDIRECT / STATCANCELLED, and
   whether optional vouchers are excluded from the counts.
4. Stock item CLOSINGBALANCE follows SVTODATE (ask for two different dates and compare).
5. Whether godown-wise closing stock can be pulled in the same request shape.
Also print the TallyPrime version and whether requests must be UTF-16LE.

Then run the real agent against that Tally with `--once` and fix what breaks. Record the
actual behaviour in README.md under "Needs checking on a real TallyPrime", replacing the
question with the answer.

Report: the probe output verbatim, the agent's --once report, and every fix you made.
```

---

## Prompt 5 — dummy distributor dataset and the MVP exit test

```
Step 5. Build the pilot dataset and run the acceptance test from the blueprint.

1. Generate three multi-brand distributor companies for TallyPrime, modelled on the
   report screenshots in the source deck: one principal's items under one stock group,
   plus at least one other brand's items that must never be sent; retailers with and
   without GSTIN; one quarter of sales vouchers and credit notes; purchases from the
   principal. Deliver it as Tally-importable XML plus the Excel behind it.
2. Plant the awkward cases on purpose: a back-dated edit, a deleted voucher, a voucher
   re-entered with the same MasterID but a new GUID, an item that goes negative in stock,
   and a company restored from an older backup.
3. Import, run the agent, then run the exit test: for one full month, the totals in
   ERPNext must match Tally to the rupee — item-wise, retailer-wise and distributor-wise,
   after the edits and deletions. Write the comparison as a repeatable script.
4. Confirm the other principal's items appear nowhere in ERPNext and never left the PC.

Report: the comparison output, and anything that did not match with the reason.
```

---

## Prompt 6 — finish the MVP reporting

```
Step 6. The app has 3 of the ~12 reports in the deck. Add the rest on top of aggregate
tables rather than querying the line tables directly.

1. Add aggregate DocTypes (Channel Sales Daily, Channel Stock Daily) refreshed by a
   background job when a batch is applied, rebuilding only the affected date and
   distributor. Existing reports move onto them.
2. Add: Sales & Stock Summary with stock-turn; Item-wise Sales; Brand-wise; Stock
   Summary with opening/purchase/sale/closing; Location-wise (state, city, zone);
   Sub-category; Pack-size; Distributor-wise Retailer Performance; Monthly Comparison;
   Stock Penetration with distinct outlets billed per week. Each keeps the deck's
   period selector, sub-totals, filters and Excel export.
3. Add the alerts: stale sync, negative stock, stock-equation break. Frappe Notification
   where it fits; say plainly what needs an SMS or WhatsApp provider and which.
4. Check performance with the dataset from step 5 scaled up ten times, and report the
   slowest report.

Keep to what the deck asks for. Do not add reports nobody requested.
```

---

## Prompt 7 — make it installable at a distributor

```
Step 7. A distributor must be able to install this without us.

1. Package the agent as an auto-starting Windows service (survives reboot, restarts on
   crash, logs where support can find them), with a signed or at least documented installer.
2. First-run setup: paste the five .env lines, test the Tally connection, test the site
   connection, show the first sync's progress.
3. A one-page installation guide for the distributor's own IT person, in plain English,
   covering enabling Tally's connectivity on port 9000.
4. Uninstall that leaves no service behind and keeps the local SQLite for support.

Report: the installer, the guide, and what you tested it on.
```

---

## Prompt 8 — the Tally Middleware (only when a second principal appears)

```
Step 8. Today one agent serves one ERPNext site. Build the multi-tenant middleware so
one distributor can serve several manufacturers.

Follow section G of the blueprint. It must: verify the agent signature; hold the
principal-to-distributor links and each principal's item rules; fan one agent's batches
out to several ERPNext sites; keep the raw payloads; be idempotent on the same keys as
the app; retry with backoff and a dead-letter queue; expose the outbox the agent polls;
and serve GET /agent/v1/config in the shape the agent already expects.

The agent must need only a URL change in .env — no new build. Prove that with a test
where one agent feeds two ERPNext sites and neither sees the other's items.
```

---

## Prompt 9 — Phase 2, only after the pilot is accepted

```
Step 9. Two-way. Do not start this until a pilot principal has accepted the visibility
MVP. Follow sections E3, E4, E5 of the blueprint: push principal masters and price lists
into distributor Tally; principal sales invoice becomes the distributor's purchase
voucher, idempotent on the ERPNext invoice name stored as a Tally reference; debit note
and credit note matching; distributor outstanding and payment reconciliation.
```
