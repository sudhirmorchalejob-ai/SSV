# SSV hub (middleware)

One distributor, one agent, many manufacturers. A distributor's Tally holds CEAT, JK, MRF…
items. Its agent splits every bill per manufacturer on the PC and sends each part to the hub,
which routes it to that manufacturer's ERPNext only.

```
distributor PC ── agent ──► hub ──► CEAT ERPNext  (CEAT lines only)
                              └───► JK ERPNext    (JK lines only)
```

The agent needs no change: point `MIDDLEWARE_URL` at the hub and leave the paths at their
defaults (`/agent/v1/…`).

## What it does

- **Config**
  - `GET /agent/v1/config` asks every linked manufacturer's site for its rules and merges them.
  - A site may speak only for its own manufacturer code.
  - The shortest sync interval wins, and Sync Now on any site triggers a run.
  - The approved agent update is the lowest version that all the manufacturers approve.
  - If any site can't be reached the hub answers 503, and the agent keeps its cached full rules.
- **Batches:** `POST /agent/v1/batches` routes each batch to its manufacturer only, re-signed as the
  distributor's ID on that site, and passes the answer back: 202, 409 duplicate, 422 refused,
  503/502 retry.
- **Heartbeat:** `POST /agent/v1/heartbeat` passes the run report to every linked site.
- **Checks:** every agent request is checked: known and enabled distributor, HMAC-SHA256 signature,
  time within 5 minutes.
- **Storage:** the hub stores nothing it routes. Duplicates and storage stay with each ERPNext;
  retries stay with the agent's queue.

No dependencies beyond Node (18+). Tests: `npm test`, including the real agent feeding two mock
manufacturers through the hub.

## Run and manage

```bash
HUB_REGISTRY=data/registry.json HUB_PORT=4200 node src/server.js
HUB_PUBLIC_URL=https://hub.example.com node src/admin.js add-distributor RL-001 "Rajlaxmi Solutions"   # writes RL-001.agent.env
read -rs -p "Agent secret from that site: " HUB_LINK_SECRET; export HUB_LINK_SECRET   # kept out of shell history
node src/admin.js link RL-001 CEAT https://ceat.example.com DIST-001
unset HUB_LINK_SECRET
node src/admin.js list
```

On the test server it runs under supervisor (`ssv-hub`). The Cloudflare tunnel sends
`https://ssv-test.rajlaxmiworld.in/agent/v1/…` to it, and everything else goes to ERPNext as
before. The registry (`~/ssv-hub/data/registry.json`, mode 600) holds secrets and is never
committed.
