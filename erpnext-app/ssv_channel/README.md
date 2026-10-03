# SSV Channel (Frappe / ERPNext v15 app)

Receives distributor secondary sales and stock from the SSV connector agent and
reports on it the way the "TallyPrime for Sales & Stock Visibility" deck shows.
Nothing here posts to the GL or stock ledger.

## Install on your bench

Copy this `ssv_channel` folder to the bench machine (or push it to a git repo), then:

```bash
cd ~/frappe-bench
# from a git repo:
bench get-app https://github.com/<you>/ssv_channel
# or from a copied folder:
cp -r /path/to/ssv_channel apps/ && ./env/bin/pip install -e apps/ssv_channel && echo ssv_channel >> sites/apps.txt

bench --site <your-site> install-app ssv_channel      # also adds the classification fields to Item
bench restart        # production; with `bench start`, just restart it
bench --site <your-site> set-config allow_tests true
bench --site <your-site> run-tests --app ssv_channel
```

Upgrading an installed copy: replace the folder, then `bench --site <your-site> migrate && bench restart`.

The pure report arithmetic can also be tested without a bench, from this folder:
`python -m unittest discover -s ssv_channel/tests -p "test_analytics*.py" -t .`

## Set up (in ERPNext, as System Manager)

1. **SSV Settings** → Principal Code, e.g. `PATANJALI`. Optionally the alert e-mail list and
   the margin switch (below).
2. **Items**: fill **Channel Classification** on the principal's items — Product Line,
   Channel Category, Sub-Category, Pack Size, Size Group, Size Sort Order, Product Class —
   plus the standard **Brand**. Every deck report groups by these.
3. **SSV Distributor** → New: Distributor ID (e.g. `DIST-001`), name, territory (city;
   its parents give state and zone). Under *Which Tally items belong to this principal*,
   add rules with names exactly as in that distributor's Tally, e.g. Stock Group =
   `Patanjali` (sub-groups are included). Save; an agent secret is generated.
4. On the distributor: **Actions → Show Agent Secret**. It shows five lines; paste
   them into the agent's `.env` next to `ssv-agent.exe`.
5. Run `ssv-agent.exe --once` on the distributor PC, then open **SSV Channel** workspace →
   *SSV Sync Log*.

**Running the agent from here** (agent 0.4.0+), on the distributor's *Agent* section:
- **Sync Every (Minutes):** 5 to 1440. A running agent picks up a change within about 2 minutes.
  Blank = the agent's own `SYNC_INTERVAL_MINUTES`.
- **Sync Now** button: a running agent starts a sync within about 2 minutes.
- A line at the top of the form shows the agent version, last contact, whether the last run
  worked and, if not, why, e.g. "TallyPrime is not reachable". The same fields are below:
  Last Run, Last Run Status, Last Run Problem, Last Successful Run and Last Data Received.

`tools/erpnext-setup.mjs` in the project does steps 1–4 over the API for a pilot.

## What arrives

| DocType | From |
|---|---|
| SSV Tally Company | each Tally company the agent reads |
| SSV Channel Item | Tally items of this principal; auto-mapped to an Item with the same code or name, otherwise *Unmapped* — set **Item** to map. Mapping applies to past vouchers too. |
| SSV Stock Snapshot | Tally's closing stock per item per day, with the split per godown (*Closing Stock per Godown*) from agent 0.3.0 |
| SSV Retailer | Tally party ledgers used in vouchers |
| SSV Secondary Voucher | sales, credit notes, purchases, notes, journals — principal's lines only, one row per godown/batch; lines against a delivery / receipt note are flagged *Against Delivery / Receipt Note* |
| SSV Ingest Log | every batch, applied or refused |

## Reports (SSV Channel workspace)

| Report / page | Deck slides | What it shows |
|---|---|---|
| **SSV Dashboard** (page) | 14–15 | Quarter-wise, zone, state, this FY vs last FY by month, top 10 categories and brands, this month, last 15 days, last quarter, last month — net sale qty |
| **SSV Stock Summary** | 16, 19, 20, 21 | Opening, purchase, net sale, other, closing (qty and value) and stock turn for any period; by distributor, item, category, product line or zone › state › city |
| **SSV Sales Analysis** | 17, 18, 22–26, 28, 29 | Pivot: rows (item, distributor, product line › brand › category, sub-category, pack size, retailer, month, location) × columns (distributor, month, product line, brand, category, pack size, zone, state); net qty and/or value |
| **SSV Stock Penetration** | 30, 31 | Distributor › product class › brand › item: outlets billed, billed qty and value |
| **SSV Retailer Performance** | 27 | Distributor › retailer › item: rate, qty, value; cost and margin when allowed |
| **SSV Bill Register** | 32 | Every voucher line with document number |
| **SSV Sync Log** | 33 | Records received per distributor per day of the month, open date, last batch |
| SSV Secondary Sales, SSV Distributor Stock, SSV Sync Health | — | The first three reports, kept. **SSV Distributor Stock** has a *Godown-wise* option: one row per godown, plus *Unallocated* if the godowns do not add up to Tally's item total, or *(not reported)* for snapshots from an agent before 0.3.0 |

Every report has:
- the deck's period presets (current FY, quarter, month, week, last week, last month, last quarter,
  last 15 days, custom); weeks run Sunday to Saturday;
- distributor, territory and item filters;
- sub-totals as an expandable tree;
- ERPNext's own print and Excel export.

Sales Analysis, Stock Summary, Stock Penetration, Retailer Performance, Distributor Stock and Sync
Health also draw a chart (0.4.1) from the same rows as their table: largest first, months as lines.

### Compared with the deck's screenshots (0.5.1–0.5.2, 28-Sep-2026)

Each report was checked against the screenshot on its slide. Four gaps were closed:
- **Grand Total row first**, as in the deck:
  - applies to Sales Analysis, Stock Summary, Stock Penetration, Retailer Performance and Bill Register;
  - outlets in the total are counted once, not summed;
  - the margin shows in the total only if every distributor in it shares cost.
- **Slide 21:** Stock Summary → *Columns: Zone*, with State › City rows and one block of opening, net sale
  and closing per zone.
- **Slide 28:** SSV Secondary Sales → *Month on Month (Retailer × Item)*. One flat row per retailer, item
  and distributor, with Category, Brand, Size Group, Size Sort, Pack Size and Product Line, then
  quantity and value per month.
- **Slide 30:** Stock Penetration adds billed value and quantity per month after the totals.

**Fix, 0.5.2:** Tally stamps a delivery or receipt note's own lines with the note's tracking number. The
app took that as "invoice against a note" and ignored the note's stock movement. So stock on past dates,
including opening, was short by the notes' quantity (closing was right, since it comes from Tally's
snapshots). A note now always moves stock. The reconciliation of the two volume companies checks
opening stock as well: 200 of 200 checks match.

### Rollout helpers (0.6.x)

- **Coverage on the dashboard:** "Data up to date from X of Y distributors", naming those behind,
  by Sync Health's rules. The figures are only as complete as the connected distributors.
- **Conversion Factor** on SSV Channel Item: your Item's units per Tally unit (cases vs pieces).
  Quantities in every report use it, past ones included; values are unchanged.
- **Mapping suggestions**
  - An unmapped Tally item gets the closest Item, scored on words, sizes and part number. A
    different size is never suggested.
  - Accept one with *Use Suggestion* on the form, or many from the list with *Actions → Accept
    Suggested Items*. *Refresh Suggestions* re-scores after adding Items.
  - Nothing is mapped without a person.
- **Agent updates:** SSV Settings holds the approved version, download URL and SHA-256. SSV
  Distributor has *Update Agent Automatically* (on by default).

### Speed at volume (0.5.0)

**SSV Monthly Summary** keeps sales, returns, purchases and net stock movement per distributor,
item and month. Ingest rebuilds exactly the distributor-months each batch touches, with one GROUP BY
per month and the same rules as the reports, so it cannot drift. After an upgrade, `migrate` builds
any missing months. Reports use it like this:
- whole months inside the period come from the summary;
- part-months at either end come from the vouchers;
- anything by retailer reads the vouchers;
- stock on a date loads only the movements between that date and each distributor's nearest
  Tally snapshot.

Load test on the test bench (4 CPU, 12 GB, MariaDB defaults), with 50 distributors in 21 cities over
18 months: 160,613 vouchers and 364,331 lines, ingested through the real ingest path at about 93
vouchers/s.

| Report (current FY) | Before | With summary |
|---|---|---|
| Sales Analysis, Distributor › Item | 4.2 s | 1.2 s |
| Sales Analysis, Product Line › Brand › Category › Item | 9.8 s | 2.1 s |
| Stock Summary, Distributor › Item | 10.4 s | 2.4 s |
| SSV Dashboard | 12.0 s | 1.9 s |

Month and week reports (Retailer Performance, Bill Register, Penetration) were already under 1 s.
The load-test run compares the summary path with the voucher path row by row: the results are
identical. Net sales also match the generator for all 50 distributors.

Load-test tools, for test sites only (`allow_tests`); every record belongs to a `LOAD-` distributor:

```bash
bench --site <site> execute ssv_channel.tools.load_test.setup_catalogue
bench --site <site> execute ssv_channel.tools.load_test.generate --kwargs "{'distributors': 50, 'months': 18}"
bench --site <site> execute ssv_channel.tools.load_test.timings
bench --site <site> execute ssv_channel.tools.load_test.cleanup
```

### How the numbers are made

- **Net sale** = Sales goods out − Credit Note goods in. Deleted and cancelled vouchers are excluded.
- **Purchase** = Purchase goods in (not against a receipt note) + Receipt Note goods in − Debit Note goods out.
- **Stock on a date** = Tally's nearest closing-stock snapshot, moved forwards or backwards by the
  synced vouchers in between. Invoice lines against a delivery / receipt note do not move stock
  again; Physical Stock vouchers are ignored. Tally's snapshot always wins where it exists.
- **Other** (Stock Summary) balances opening + purchase − net sale + other = closing: journals,
  delivery notes not yet invoiced, and any gap between Tally's count and the vouchers.
- **Values** of opening and closing use the valuation rate of the nearest snapshot.
- **Cost and margin** (Retailer Performance) are estimated as quantity × the distributor's
  valuation rate — nothing extra is taken from the distributor. Shown only when
  **SSV Settings → Show Cost And Margin** is on *and* the distributor has **Shares Cost Price** ticked.

## Retailers (0.8.0)

Manufacturer → Distributor → Retailer → Bill. A retailer is a party ledger in the distributor's
Tally. The agent already sends the parties on each bill, so **SSV Retailer** records fill in by
themselves; this version adds the screens and fields to manage and monitor them.

- **SSV Retailer** gains a *Retailer ID* (RET-00001…, given automatically), *Status*
  (Active/Inactive), *Contact Person*, *Mobile*, *Email*, *City*, *Zone*, *Data Sharing Consent* and
  *Consent Date*, plus *Distributor Name*, *Manufacturer* (this site's principal code) and *Added From*.
  - The sync never writes these. It keeps writing the Tally fields (name, GSTIN, address, state, PIN
    code, phone, price level), which lock on the form once Tally has sent the retailer.
  - A retailer stays under the distributor it was created for: *Distributor* is set once, and its
    Tally company must be that distributor's.
  - **Add by hand** (System Manager): type the name exactly as the ledger in the distributor's Tally.
    Its first bill links to that record instead of creating a second one. One ledger name per
    distributor and Tally company; a second is refused.
  - **Deactivate** with *Status = Inactive*. A retailer with bills cannot be deleted.
  - The form shows its **Activity**: transactions, bills, returns, active and cancelled, items, net
    quantity, net sales value, last transaction, last sync, the latest bills and 12 months of sales.
- **SSV Distributor** shows a **Retailers** section: totals, last activity, last sync and a table of
  its retailers, each opening its record.
- **SSV Retailers** report: every retailer with its distributor, manufacturer, place, status,
  transactions, bills, cancelled, items, net quantity and value, last activity and last sync. Search by
  Retailer ID or name; filter by distributor, manufacturer, state, city, zone, status and bill dates.
  *No Bills For (Days)* lists active retailers that have gone quiet.
- **SSV Retailer Dashboard** page: total, active, inactive, billed and quiet retailers; retailers by
  distributor, state and city; the busiest retailers; activity by month; last sync per distributor;
  and the active retailers with no recent bills. Same filters, plus a date range.

What counts as a retailer: a party billed at least once (Sales or Credit Note), or one added by hand.
Suppliers on purchase bills and cash ledgers never appear. Only retailers that bought this
principal's items reach the site, as the agent filters every bill on the distributor's PC.

Figures: net = sales out − returns in, without cancelled or deleted bills and items marked Ignored,
as in *SSV Retailer Performance*. Quantities are in the distributor's Tally units.

Access is unchanged: System Manager edits; Sales Manager and Sales User read. Every list and figure
goes through Frappe's permission checks, so User Permissions on SSV Distributor limit a user to those
distributors' retailers, on the new screens and the SSV Retailer list alike. (The older reports read
the data directly and do not apply User Permissions.)

0.8.1: the retailer screens read the distributors' *Last Data Received* directly. Frappe's list query
drops every field whose name contains `_seen` (it clears its optional `_seen` column), so `get_list`
never returned `last_seen_at`, and a distributor without run reports showed as *Silent*. Found by the
bench tests after installing 0.8.0 on ssv-test (03-Oct).

Upgrade: `bench --site <site> migrate` adds the fields and an index on the bill's retailer, and the
patch `v0_8.retailer_ids` gives existing retailers their ID, status, manufacturer and distributor name.

## Alerts

Daily, to **SSV Settings → Send Alerts To**:
- distributors whose agent reports that its last run **failed**, with the reason;
- distributors with no successful run and no data for more than *Distributor Is Stale After
  (hours)* (default 24), or twice their sync interval if that is longer;
- items whose latest closing stock is negative (switch: *Alert On Negative Stock*).

Nothing is sent when the lists are empty or all is well. Uses the site's outgoing e-mail
account.

**SSV Sync Health** uses the same rules. Statuses:
- **Errors:** batches refused in the period.
- **Failing:** the last run failed.
- **Stale / Silent:** no successful run or data within the limit / three times the limit.
- **Mismatch:** the agent's latest daily totals differ from what this site holds (0.6.3).
- **OK:** otherwise.

**Reconciliation (0.6.3, agent 0.5.3+)**
- **What arrives:** once a day, a `control` batch per Tally company. It gives, per month, the bills the
  agent delivered here and their quantity and value.
- **What the site does:** compares them with its own live bills and item rows. It stores *Reconciled*
  (OK / Mismatch), *Reconciled At* and *Differences* on the SSV Tally Company.
- **Where it shows:** Sync Health shows a *Reconciled* column, and the daily alert lists mismatches.
- **Tolerance:** bills must match exactly; quantity and value allow 0.01 and ₹1 of rounding per month.
- **Refused bills:** bills this site refused earlier also count as a mismatch, because they are missing.

**Delete Channel Data (0.6.4):** on a disabled SSV Distributor, *Actions → Delete Channel Data*
deletes every voucher, stock snapshot, monthly summary row, channel item, retailer, Tally company and
ingest log of that distributor. It replaces the agent secret and adds an audit comment.

**Send Test Alert (0.6.4):** a button on SSV Settings that sends today's alert at once, to check
recipients and the outgoing e-mail account.

**Security (0.6.4):** ingest escapes `<` and `>` in everything an agent sends. Frappe renders Data
values in reports as HTML, and `db.set_value` updates skip its save-time sanitising.

**Hold data until consent (0.6.3):** tick *SSV Settings → Hold Data Until Consent Is Recorded* and
batches from a distributor without a *Data Sharing Consent Date* get 503. The agent keeps them and
retries, so nothing is lost when the date is entered.

Agents before 0.4.0 send no run reports; for them only data received counts.

## API

| | |
|---|---|
| `POST /api/method/ssv_channel.api.batches` | one batch, signed |
| `GET /api/method/ssv_channel.api.config` | this distributor's rules, plus `agent: { syncIntervalMinutes, syncRequestedAt }`; records the contact |
| `POST /api/method/ssv_channel.api.heartbeat` | run report after every sync, signed: `run.ok`, `run.problem` (0.4.0+) |

Signature: `X-SSV-Signature = hex(HMAC-SHA256(agent_secret, X-SSV-Timestamp + "." + raw body))`,
with `X-SSV-Distributor` = Distributor ID; timestamps outside the clock skew (default 300 s)
are refused. Responses: 202 applied · 409 duplicate batch (treated as delivered) · 401 bad
signature (agent retries) · 422 refused (agent marks rows rejected) · 503 site not set up
(agent retries).

Newer copy of a voucher = higher `(sync_epoch, alterId)`; older copies are ignored.

Voucher lines may carry `tracked: true` and each allocation a `trackingNumber` (Tally's link to
the delivery / receipt note). Both are optional: batches from older agents are accepted and
treated as untracked.
