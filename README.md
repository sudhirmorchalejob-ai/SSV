# SSV Platform — Sales & Stock Visibility

Manufacturer (principal) ↔ distributor visibility on ERPNext, TallyPrime and our own middleware.
Design: [architecture blueprint](https://claude.ai/artifact/8DTd36pnAmGoqsc5MVsYki).

**Scope decisions (2026-09-23):** multi-tenant product sold to many principals · ERPNext is the
principal's visibility system only (Mode A) · MVP is one-way visibility, orders in Phase 2 ·
sync interval configurable per distributor (5 min to daily) plus "Sync now".

| Folder | What | Status |
|---|---|---|
| `agent/` | Connector agent on the distributor PC. Reads TallyPrime, stages in SQLite, sends each principal only its own items. | v0.6.2, 62 tests pass. Local **setup page** (http://127.0.0.1:4100). Windows service (`SSVAgentService.exe`, built from source with the .NET Framework compiler) and `install.cmd` / `uninstall.cmd`, **installed for real on the test PC** (29-Sep) and **auto-updated five times** there (0.5.0 → 0.6.1). **Run against a real TallyPrime** (Educational mode): figures match the Sales Register to the rupee; edits, deletions, a CEAT line removed from a mixed bill, a godown transfer and an ERPNext outage all followed through correctly |
| `erpnext-app/ssv_channel/` | Frappe v15 app: non-accounting DocTypes, signed ingest API, item classification, the deck's reports (slides 14–33) with charts, godown-wise distributor stock, per-distributor sync interval and Sync Now, agent run reports, daily alerts, SSV Monthly Summary for speed, and (0.8.0) the retailer layer: retailer master with IDs, status, contacts and consent, a Retailers section on each distributor, the SSV Retailers report and the SSV Retailer Dashboard. The agent can post to it directly. | v0.6.6, **installed on the test bench** (ssv-test, principal CEAT); 48 bench tests pass; security-reviewed 29-Sep. **Load-tested** at 160,613 vouchers / 364,331 lines from 50 distributors: every report ≤ 2.5 s, figures identical to the voucher path and to the generator. **0.8.1 (retailer layer) installed on ssv-test 03-Oct**, 61 bench tests pass; 0.7.0 backed up first (`~/ssv-backup-before-0.8.0`, `~/ssv_channel-0.7.0-saved` on the server) |
| `middleware/` | The hub: one agent per distributor feeds every manufacturer it sells for. It routes each manufacturer's lines to that manufacturer's ERPNext only, merges their rules, and passes run reports and approved updates. Same batch contract, so agents need only a URL change. | v0.1.0, 8 tests pass (including the real agent feeding two manufacturers). Running on the test server behind the tunnel at `/agent/v1/`. See its README |

## Agent

Needs Node 22.13+ (built-in `node:sqlite`, no native modules).

```bash
cd agent
npm install
npm test
cp .env.example .env    # then fill in
npm run sync-once
```

### How it reads Tally (same method as the Biz Analyst connector)

| Step | Behaviour |
|---|---|
| First sync | One request per day from `SYNC_FROM` / company start to the last voucher date. Last finished day saved → resumes after a crash. If Tally ignores the date filter, switches to AlterID windows. |
| Incremental | `$AlterID > a AND $AlterID <= b` windows of 250 up to company ALTVCHID; watermark saved per window. Back-dated edits are caught by their new AlterID. |
| Backup restored (ALTVCHID < watermark) | Step back 5,000 AlterIDs, re-read, raise `sync_epoch`, and run the deleted-voucher check in the same pass. |
| Bad counter | ALTVCHID missing → error; negative → company blocked with "repair the company data"; 0 → empty company. |
| Deleted vouchers | Tally Statistics counts per voucher type per month (12 months per request) vs local; differing months → daily counts → re-read only differing days. A day is skipped only while both Tally's counts and the local counts after its last re-read are unchanged. Fallback: MasterID ranges over the last 45 days. At most hourly, only when ALTVCHID moved. |
| Closing stock | Only items in changed vouchers, 50 per request by MasterID; all items once a day and on the first run after an agent upgrade. |
| Closing stock per godown | Tally's own figure: the `Batch` collection `CHILDOF` each item (one object per batch and godown), 50 items per request as a union of CHILDOF collections, read with the item closing. Batches are summed per godown; empty godowns dropped. Not our calculation. |
| Stock journals | Lines from `ALLINVENTORYENTRIES` (direction by `ISDEEMEDPOSITIVE`); the IN/OUT lists only when that list is absent, since TallyPrime exports the lines in both. |
| Masters | Re-read only when ALTMSTID moves. |
| Tally requests | UTF-16LE (`text/xml;charset=utf-16`), dates as `TYPE="Date"` `01-Apr-2026`, ping before each attempt, 5 attempts with 10/20/30/40 s waits, one request at a time, group companies skipped. |
| Staging | SQLite with `up_to_date` flags; a row is done only when every principal that needs it has accepted it. |
| Upload | 1,000 pending vouchers per page, split per principal, ≤ 5 MB per request, HMAC-signed. 4xx → row marked rejected; network/5xx → stays pending. |

Kept from our design, not Biz: per-principal filtering on the PC (whole-bill amounts never sent),
signed batches to our own middleware, local API on 127.0.0.1 with a token, no analytics SDKs.

Beyond Biz: first-sync overlap taken from the AlterID when the first sync *started*; deleted check
forced after a restore (Biz skips it); reused MasterID with a new GUID withdraws the old voucher;
`sync_epoch` so the middleware does not drop a post-restore voucher as stale.

### Contract the middleware must honour

- Verify `X-SSV-Signature` = HMAC-SHA256(secret, `<X-SSV-Timestamp>.<body>`).
- Idempotent on `(tally_company.guid, voucher guid)`; newer = higher `(sync_epoch, alterId)`.
- Batch kinds: `items` (item master + closing as of `as_of_date`), `vouchers` (vouchers, tombstones, referenced parties).
- Voucher lines carry `tracked` (true when the invoice line is against a delivery / receipt note,
  so the stock already moved on the note) and each allocation a `trackingNumber`. Both optional;
  absent = untracked. Added 25-Sep-2026 in the agent and the app together.
- Items carry `godowns: [{ godown, qty, value }]`, the closing stock per godown as of `as_of_date`
  (agent 0.3.0+). Optional: absent = split not read (older agent, an item name containing `"`, or a
  Tally that refused the request); the app then keeps any split it already has for that day.
  Tally's item `closingQty` stays authoritative; a gap is shown as "Unallocated". Added 26-Sep-2026
  in the agent and the app together.
- `GET /agent/v1/config` returns `{ principals: [{ code, stockGroups, stockCategories, items }] }`, and
  optionally `agent: { syncIntervalMinutes, syncRequestedAt }` (0.4.0+), set on the SSV Distributor.
  - `syncIntervalMinutes` (5–1440) replaces the agent's `SYNC_INTERVAL_MINUTES`; `null` means use the
    agent's own setting.
  - `syncRequestedAt` is an opaque token. A value the agent has not handled yet means "Sync now".
  - A continuously running agent polls config every `CONTROL_POLL_SECONDS` (120).
- `POST /agent/v1/heartbeat` (0.4.0+) is signed like a batch and sent after every run:
  - body: `{ distributor_id, agent_version, sent_at, interval_minutes, handled_sync_request,
    run: { trigger, started, finished, ok, problem, companies: [{ company, upload }] } }`;
  - `problem` is the reason in plain words, e.g. TallyPrime not reachable;
  - the path defaults to the batches path with `batches` replaced by `heartbeat`;
  - a 4xx other than 401/403/408/429 means an older app, and the agent stops sending.
  Added 28-Sep-2026 in the agent and the app together.

Before the middleware exists, rules can go in `<DATA_DIR>/principals.json`.

### Commands (v0.4.0)

`ssv-agent.exe --help` lists them: run continuously (no flag), `--once`, `--probe`, `--probe-sweep`,
`--load-demo --company "Name"` (fills an **empty** Tally company with a quarter of demo distributor
data — two principals, mixed-brand bills, returns, negative stock — and prints the expected totals;
refuses any company that has ever had a voucher), `--version`. Unknown options stop with an error.

Settings added in 0.2.1: `TALLY_COMPANY` (read only this company; loaded by name if TallyPrime runs
as a server with none open) and `USE_PROXY` (system proxies are ignored unless `1`, so a proxy on the
distributor PC cannot silently read the data).

Field fixes in 0.2.1 (first run on a real TallyPrime): Tally's bare `&` and `&#4;` in master exports
no longer crash the parser; a Tally blocked by an open dialog is reported as such; "no company open"
is reported clearly.

New in 0.5.0: **automatic updates**.
- **Approval:** SSV Settings holds the approved version, its download URL and its SHA-256.
  Distributors can opt out with *Update Agent Automatically*.
- **Agent:** running as the service, the agent downloads the approved version between syncs and
  refuses a checksum mismatch. It stages the file and exits with code 75.
- **Service:** the wrapper checks the checksum again, swaps the exe (the old one is kept as
  `ssv-agent.exe.old`) and restarts the agent.
- **Rollback:** if the new version fails within 2 minutes three times in a row, the wrapper puts the
  old exe back and writes `bad-<version>`, so that version is never downloaded again.
- **Tested end to end** on the real wrapper with stand-in agents: staged, installed, three failures,
  rolled back. Run by hand, the agent only logs that an update exists.
- **Done for real on 29-Sep:** the test PC's service went 0.5.0 → 0.5.1 → 0.5.2, about a minute after
  each approval. The exe was served from the site's public files.

New in 0.5.1: `SHARE_RETAILER_CONTACTS=false` keeps retailers' phone, address and PIN code on the PC.
Name, GSTIN, state and price level are still sent. The site (app 0.6.2) then deletes the contacts it
already holds for that distributor and ticks *Retailer Contacts Withheld*.

Fixes in 0.5.2, from the backup-restore field test (29-Sep):
- **A re-entered bill was ignored.** After a restore, Tally gave a new bill the lost bill's MasterID,
  GUID *and* AlterID. The agent took it for the old bill, unchanged, so the principal kept the lost
  bill's figures. A bill is now skipped only if its content is identical too.
- **A restore could go unnoticed.** It was detected only when Tally's ALTVCHID fell below the last
  AlterID read. If as many bills were entered again as were lost before the next sync, the restore was
  missed. Each run now also checks that the last bill read is still the same bill at that AlterID, at
  the cost of one small request.
- The field test then ended with ERPNext matching Tally: the new bill replaced the lost one, and the
  other lost bill was withdrawn.

New in 0.5.3 (with app 0.6.3): **daily reconciliation**, the blueprint's checksum manifest.
- **What the agent sends:** once a day, and straight after a restore or resync, it sends each principal
  a `control` batch. The batch gives, per month, the bills that principal accepted and their quantity
  and value, summed over the same rows the site stores.
- **When:** only when nothing is waiting to go. Set `RECONCILE_EVERY_HOURS` to change the interval.
- **Refused bills:** the batch also counts bills the site refused earlier.
- **What the site does:** compares the totals with what it holds. It records *Reconciled* OK or Mismatch
  and the differing months on the SSV Tally Company. SSV Sync Health shows a *Reconciled* column and a
  *Mismatch* status, and the daily alert lists mismatches.
- **First run (29-Sep):** all three test distributors reconciled OK, 13 months in all.
- **Also new:** *SSV Settings → Hold Data Until Consent Is Recorded* answers 503 to a distributor with no
  consent date. Its agent keeps the data and retries, and shows the reason as its run problem.

App 0.6.4, security review before production (29-Sep):
- **Access checks:** every whitelisted method checks roles or permissions. Every report and the
  dashboard is limited to System Manager, Sales Manager and Sales User. Agent endpoints check an HMAC
  in constant time, and a replayed batch is answered 409.
- **Fixed, stored cross-site scripting:** Frappe renders Data values in reports and lists as HTML. Its
  save-time sanitising does not run for `db.set_value`, which ingest uses to update items, parties and
  run reports. A distributor could therefore have planted markup in, say, an item name that would run
  in a manager's browser. Ingest now escapes `<` and `>` in everything an agent sends, batches and run
  reports alike. Stored data was checked: nothing needed cleaning.
- **New: *Delete Channel Data*** on a disabled SSV Distributor, for consent withdrawal. It deletes
  every record received from that distributor, replaces its agent secret, and leaves an audit
  comment.
- **New: *Send Test Alert*** on SSV Settings. It sends today's alert at once, or says what's missing
  (recipients, outgoing e-mail account).

**Dealer layer (29-Sep):** a distributor sees its dealers' sales and stock, the way the manufacturer
sees distributors. It is the same product one level down: each distributor gets its own small site
with this app, and its dealers run the same agent.
- **Agent 0.6.0, setup page:** a local web page at `http://127.0.0.1:4100` (desktop shortcut
  *SSV Agent Setup*), signed in with the setup password `install.cmd` creates.
  - **Connection:** paste the site's *Show Agent Secret* lines; *Test connection* shows exactly which
    stock groups the site will receive.
  - **Tally:** pick the company. **Options:** interval, first-sync date, retailer contacts,
    reconciliation. **Status**, **Log**, and **Sync now**.
  - **Saving** writes the `.env` in place and restarts the agent. The service now treats exit 76 as a
    deliberate restart.
  - **Access:** only from this PC. Requests for another host are refused, which also stops DNS
    rebinding. The secret is write-only.
- **Agent 0.6.1:** fixes the stock-group path. Every second item in a group was sent reversed,
  because a cached array was reversed in place.
- **Agent 0.6.2 (03-Oct), retailer contacts fix, found by adding retailers with full details to the test
  companies:**
  - **The bug:** since 0.5.1, the first retailer in every vouchers batch arrived without phone,
    address and PIN code. `parties.map(partyForUpload)` passed each party's index as the "share
    contacts" argument, and index 0 counts as "no". Worse, a retailer whose contacts the site
    already held lost them again whenever it came first in a later batch.
  - **Retailer edits now reach the site:** a party ledger changed in Tally (address, phone, GSTIN …)
    is re-sent to each principal that already holds one of its bills, in a vouchers batch without
    vouchers. A principal never receives a party it has no bill of.
  - **Repair:** the first run after the upgrade re-sends every party once, which restores the lost
    contacts. On the test PC: 3, 45 and 43 retailers re-sent, all contacts correct in ERPNext. A
    changed mobile number reached ERPNext on the next sync, with no new bill.
  - **Build:** `build-exe.mjs` works from a folder whose name has spaces.
- **App 0.6.5, *Apply Wording*** on SSV Settings. It writes site translations so every label says
  Dealer and Customer instead of Distributor and Retailer. Nothing else changes.
- **App 0.6.6, *Create Items from Selected*** on SSV Channel Item. It creates Items named as in Tally,
  in Tally's stock-group tree, with the HSN code from Tally. It maps every sender's item of that
  name and refreshes suggestions.
- **`tools/new-distributor-site.sh`:** sets up a distributor's site after `bench new-site`.
  - Server: multi-site mode, once, with nginx backed up and checked.
  - Site: ERPNext and this app, the first-run setup, the distributor as principal, the consent hold,
    and the Dealer/Customer wording.
  - Address: tunnel route and DNS.
- **Dealer consent letter:** `docs/dealer-consent-template.html`.

**MVP exit test passed (28-Sep-2026).**
- **Data:** two empty TallyPrime companies (Educational mode), Shree Tyres Nagpur and Kaveri Tyres
  Bengaluru, were filled by `tools/tally-volume.mjs` with Apr–Sep 2026 books: 2,164 and 2,002
  vouchers mixing CEAT, JK and MRF.
- **Tally holds what was intended:** `tools/tally-verify.mjs` confirmed Tally's own closing stock
  matches the generator for every CEAT item, in total and per godown, and the voucher counts per type
  match.
- **Sync:** agents 0.4.1 for DIST-002 and DIST-003 ran a first sync each, sending 1,833 and 1,680
  vouchers with 0 rejected.
- **Reconciliation, 176 of 176 checks match, then 200 of 200 once opening stock was added after the 0.5.2
  delivery-note fix:**
  - net sale qty and value per month and per item;
  - purchases per item;
  - closing stock per item, in total and per godown, including negative stock (−588 and −444);
  - outlets billed;
  - no JK or MRF item or line in ERPNext;
  - the CEAT item without an ERPNext Item arrived as Unmapped.

New in 0.4.1: **Windows service.** `install.cmd` (asks for admin rights once) installs the *SSV Tally
Connector* service:
- It starts with Windows (delayed start) and is restarted by Windows if it fails.
- The wrapper also restarts the agent itself, waiting 10 s, doubling up to 5 min.
- The agent's output goes to `C:\ProgramData\SSVConnector\logs\agent.log`, rotated at 10 MB.
- The settings (`.env`, which holds the agent secret) live in `C:\ProgramData\SSVConnector`, open to
  Administrators and SYSTEM only.
- The store of an agent that was run by hand is moved across, so Tally is not read from scratch again.

The wrapper is about 20 lines of C#, compiled at build time by the `csc.exe` that ships with
.NET Framework 4, so no third-party service wrapper is downloaded. `SSVAgentService.exe --console 60`
runs it for a minute in a window, for testing. Tested: start, crash and restart, clean stop. A code-signed
installer waits for a certificate.

Test tools (`tools/`):
- `tally-volume.mjs --company "…" --seed N` fills an empty TallyPrime company with 18 months of tyre
  distributor books on Educational-mode dates, about 2,300 vouchers. The mix: CEAT, JK and MRF lines on
  the same bills, purchases, credit and debit notes, delivery notes invoiced later, godown transfers,
  one item oversold into negative stock, and one CEAT item missing from ERPNext.
- It writes the expected CEAT figures to `tally-volume-<company>.json` for the month-end
  reconciliation. `--dry-run` shows the counts without touching Tally.

New in 0.4.0 (verified live 28-Sep-2026):
- **Sync Every** on the SSV Distributor in ERPNext sets the agent's interval. A running agent picked
  up 15 → 5 min within 30 s (test poll).
- **Sync Now** in ERPNext started a run 24 s after the button was pressed.
- After every run the agent sends a run report. A run with TallyPrime unreachable showed in ERPNext
  as *Failed* with the agent's message, Sync Health said *Failing*, and the daily alert listed it.
  The next good run cleared it.

New in 0.3.0: closing stock per godown (above). Fixed after acceptance tests on a real TallyPrime
(26-Sep-2026):
- A stock journal's lines were counted twice.
- A voucher added and later deleted on a day the deletion check had already re-read was never
  withdrawn, because the check remembered only Tally's counts for that day.

### Needs checking on a real TallyPrime — `ssv-agent.exe --probe`

The read strategy rests on five unverified assumptions. The probe checks them against the
real Tally, read-only and without uploading, using the agent's own Tally client. Output
(verdicts, JSON report and every raw Tally response) goes to `%APPDATA%\SSVConnector\probe`,
separate from the real agent's store.

| Check | Assumption | How the probe tests it |
|---|---|---|
| 1a / 1b | Collection `FILTERS` honour `$AlterID` / `$MasterID` | Filtered read of the middle third of the company's AlterIDs / MasterIDs vs the unfiltered list |
| 1c | `SVFROMDATE` = `SVTODATE` returns one day (first sync) | Read of the busiest day and of a quiet mid-month day (expects 0) vs the unfiltered list. WARN, not FAIL: the agent falls back to AlterID windows when a day read returns other days |
| 2 | Company exports `ALTVCHID`, `ALTMSTID`, `LASTVOUCHERDATE`, `ISAGGREGATE` | Raw company export: tag present and counters numeric |
| 3 | Statistics layout (`STATNAME` / `STATVALUE` / `STATDIRECT` / `STATCANCELLED`), optional vouchers excluded | Busiest month's counts per stock voucher type vs the voucher list under three counting rules |
| 4 | Stock item `CLOSINGBALANCE` follows `SVTODATE` | Closing read the day before the first voucher (from = to = that day, so it works before the books start too) and today; must differ for moved items |
| 5 | Back-dated edits and deletions are caught | `--probe-sweep` twice: runs the real sync into the probe store; edit an old sales voucher and delete another in between; expect 1 changed, 1 deleted |
| 6 | (exploratory) godown detail | Whether stock items expose opening stock per godown in `BATCHALLOCATIONS.LIST` |

`--company "Name"` picks the company; otherwise the first loaded non-group company with vouchers.
Exit code 0 = no FAIL (WARN allowed), 2 = at least one FAIL, 1 = could not run.

Findings on a real TallyPrime (26-Sep-2026, Educational mode, company "Rajlaxmi Solutions Pvt Ltd
(Distributor)"):

- 1a, 1b, 2, 3 and 4 pass.
- 1c warns. Educational mode accepts only the 1st, 2nd and 31st of a month as dates. Any other
  `SVFROMDATE`/`SVTODATE` is dropped silently and the whole period comes back. The agent's
  first sync detected this and switched to AlterID windows, and the ERPNext figures matched the
  Sales Register exactly.
- Tally also ignores an `SVTODATE` earlier than `SVFROMDATE`, so an as-of read before the books
  start must use that date for both.
- Check 5 passes. Test bills were imported into Tally, edited and deleted, and ERPNext followed
  each step to the rupee. They were then removed.
- A Stock Journal transfer of 25 Zoom tyres to a test godown showed in ERPNext as 975 / 25 under
  the report's Godown-wise option. It was then removed.
- In the Educational-mode Tally, the deletion check re-reads about a month of days, because
  day-level Statistics come back for the whole period. On a licensed Tally, only changed days are
  re-read.
- Known limitation: this Tally's voucher exports (collection and Day Book) do not include
  `GODOWNNAME` on batch allocations, so voucher lines arrive without a godown. Godown-wise
  closing stock does not depend on it.

Godown-wise closing stock is built on Tally's own batch-by-godown closing figures, not on
movements the agent adds up. Check 6 (opening stock per godown) is kept as a diagnostic.

Not carried over yet: ERPNext → Tally voucher import (`createPurchaseVoucher` etc.), needed for Phase 2.
