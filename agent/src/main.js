/**
 * main.js
 * ───────
 * The agent proper, started by index.js once the environment is settled.
 *
 *   ssv-agent.exe                run continuously, at the interval set in ERPNext
 *                                (else SYNC_INTERVAL_MINUTES), with "Sync now" from ERPNext
 *   ssv-agent.exe --once         one sync, print the report, exit
 *   ssv-agent.exe --probe        check the Tally assumptions (read-only, no upload)
 *   ssv-agent.exe --probe-sweep  check 5: back-dated edits and deletions (run twice)
 *   ssv-agent.exe --version
 *
 * The local API listens on 127.0.0.1 only and needs LOCAL_API_TOKEN as a bearer
 * token. The old middleware listened on every interface with open CORS, so any
 * web page or LAN machine could reconfigure it.
 */

import crypto from "crypto";
import express from "express";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { runSync, status } from "./sync.js";
import { pingTally, fetchCompanies, openCompanyNames } from "./tally/client.js";
import { currentSettings, readEnv, validate, changedOnly, testConnection, writeEnv, RESTART_EXIT_CODE } from "./setup.js";
import { SETUP_PAGE } from "./setup-page.js";
import { openDb } from "./db.js";
import { AGENT_VERSION } from "./upload.js";
import { runProbe, runSweep } from "./probe.js";
import { effectiveIntervalMinutes, intervalSource, fetchRemoteConfig, pendingSyncRequest, markSyncRequestHandled, approvedUpdate } from "./control.js";
import { wanted, stage, UPDATE_EXIT_CODE } from "./update.js";

async function once() {
  const report = await runSync({ trigger: "cli" });
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.error ? 1 : 0);
}

function scheduler() {
  let timer = null;
  let nextRunAt = null;
  let interval = null;
  const schedule = () => {
    clearTimeout(timer);
    interval = effectiveIntervalMinutes();
    const ms = interval * 60_000;
    nextRunAt = new Date(Date.now() + ms);
    timer = setTimeout(async () => {
      await runSync({ trigger: "schedule" });
      schedule();
    }, ms);
  };
  return {
    start: schedule,
    reschedule: schedule,
    nextRunAt: () => nextRunAt,
    intervalChanged: () => interval !== null && interval !== effectiveIntervalMinutes(),
  };
}

/** Install the approved agent version (service only), between syncs, never during one. */
async function maybeUpdate() {
  const update = approvedUpdate();
  if (!wanted(update, AGENT_VERSION) || status().running) return;
  if (await stage(update)) {
    logger.info(`Restarting so the service installs agent ${update.version}`);
    process.exit(UPDATE_EXIT_CODE);
  }
}

/**
 * Every CONTROL_POLL_SECONDS: ask ERPNext for a changed interval or a "Sync now"
 * request. A request that arrives while a sync is running stays pending and is
 * handled on the next poll, so the data it asked for is always read after it.
 */
function controlLoop(sched) {
  let failing = false;
  const tick = async () => {
    try {
      await fetchRemoteConfig();
      if (failing) logger.info("ERPNext reachable again for agent settings");
      failing = false;
    } catch (err) {
      if (!failing) logger.warn(`Could not check ERPNext for agent settings (${err.message}); will keep trying`);
      failing = true;
    }
    if (sched.intervalChanged()) {
      sched.reschedule();
      logger.info(`Next sync in ${effectiveIntervalMinutes()} min`);
    }
    const request = pendingSyncRequest();
    if (request) {
      logger.info("Sync requested from ERPNext");
      const report = await runSync({ trigger: "erpnext" });
      if (!report.skipped) {
        markSyncRequestHandled(request);
        sched.reschedule();
      }
    }
    await maybeUpdate();
    setTimeout(tick, config.sync.controlPollSeconds * 1000);
  };
  setTimeout(tick, config.sync.controlPollSeconds * 1000);
}

function requireToken(req, res, next) {
  const expected = config.local.token;
  const got = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const ok = expected && got.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
  if (!ok) return res.status(401).json({ error: "unauthorised" });
  next();
}

/** Restart so every module reads the new .env: at once under the service, after any sync in progress. */
function restartWhenIdle() {
  const check = () => {
    if (status().running) return setTimeout(check, 1000);
    logger.info("Settings changed on the setup page; restarting to apply them");
    process.exit(RESTART_EXIT_CODE);
  };
  setTimeout(check, 500);
}

function serve(sched) {
  const app = express();
  const port = config.local.port;
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  // Only requests addressed to this PC: a web page that points its own domain at
  // 127.0.0.1 (DNS rebinding) sends another Host and is refused.
  app.use((req, res, next) => {
    if (!hosts.has(String(req.headers.host || "").toLowerCase())) return res.status(421).end();
    res.set({
      "X-Frame-Options": "DENY",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
        "connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    });
    next();
  });
  app.use(express.json({ limit: "32kb" }));
  app.get("/", (_req, res) => res.type("html").send(SETUP_PAGE));
  app.use("/api", requireToken);

  app.get("/api/setup", (_req, res) => {
    res.json({ version: AGENT_VERSION, service: process.env.SSV_SERVICE === "1", ...currentSettings() });
  });
  app.post("/api/setup/test-connection", async (req, res) => {
    const saved = readEnv();
    const { updates, errors } = validate(req.body?.values, { secretSet: Boolean(saved.AGENT_SECRET) });
    if (Object.keys(errors).length) return res.status(400).json({ errors });
    const s = { ...saved, ...updates };
    res.json(await testConnection(s));
  });
  app.get("/api/setup/tally", async (_req, res) => {
    const ping = await pingTally();
    res.json({ ...ping, companies: ping.connected ? await openCompanyNames().catch(() => []) : [] });
  });
  app.post("/api/setup/save", (req, res) => {
    const saved = readEnv();
    const { updates, errors } = validate(req.body?.values, { secretSet: Boolean(saved.AGENT_SECRET) });
    if (Object.keys(errors).length) return res.status(400).json({ errors });
    const changes = changedOnly(updates, saved);
    if (!Object.keys(changes).length) return res.json({ saved: [], restarting: false });
    try {
      writeEnv(changes);
    } catch (err) {
      return res.status(500).json({ error: `Could not write the settings file: ${err.message}` });
    }
    logger.info(`Settings saved on the setup page: ${Object.keys(changes).join(", ")}`);
    const restarting = process.env.SSV_SERVICE === "1";
    res.json({ saved: Object.keys(changes), restarting });
    if (restarting) restartWhenIdle();
  });

  app.get("/api/status", (_req, res) => {
    res.json({ ...status(), intervalMinutes: effectiveIntervalMinutes(), intervalSetIn: intervalSource(), nextRunAt: sched.nextRunAt() });
  });
  app.get("/api/tally", async (_req, res) => {
    const ping = await pingTally();
    res.json({ ...ping, companies: ping.connected ? await fetchCompanies() : [] });
  });
  app.post("/api/sync-now", async (_req, res) => {
    const report = await runSync({ trigger: "manual" });
    sched.reschedule();
    res.status(report.skipped ? 409 : 200).json(report);
  });
  app.get("/api/logs", (req, res) => res.json(logger.recent(parseInt(req.query.limit, 10) || 200)));

  app.listen(config.local.port, config.local.host, () => {
    logger.info(`Setup page and control API on http://${config.local.host}:${config.local.port}`);
  });
}

function argValue(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

const USAGE = `ssv-agent ${AGENT_VERSION} — sends a distributor's TallyPrime sales and stock to the principal's ERPNext

Usage: ssv-agent.exe [command] [--company "Name"]

  (no command)        run continuously, at the interval set in ERPNext (else SYNC_INTERVAL_MINUTES);
                      "Sync now" in ERPNext is picked up within CONTROL_POLL_SECONDS (120)
  --once              one sync, print the report, exit
  --probe             check how this TallyPrime behaves (read-only, uploads nothing)
  --probe-sweep       check that edits and deletions are caught (run twice)
  --load-demo         fill an EMPTY Tally company with demo distributor data
                      (needs --company "Name"; refuses a company that has vouchers)
  --version           print the version
  --help              this text

  --company "Name"    the Tally company to use (else TALLY_COMPANY in .env, else all open companies)

Settings are read from .env next to the exe. While the agent runs, they can also be changed on
the setup page, http://127.0.0.1:4100 (password: LOCAL_API_TOKEN). See START-HERE.txt.`;

const COMMANDS = new Set(["--once", "--probe", "--probe-sweep", "--load-demo", "--version", "--help", "-h", "--company"]);

function warnAboutProxy() {
  const set = ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "all_proxy"].filter((k) => process.env[k]);
  if (!set.length) return;
  logger.warn(config.middleware.useProxy
    ? `Uploads go through the proxy in ${set.join(", ")} (USE_PROXY=1). Anyone controlling that proxy can read them.`
    : `A proxy is configured on this PC (${set.join(", ")}). The agent ignores it and connects directly; set USE_PROXY=1 only if your network requires it.`);
}

export async function start(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    process.exit(0);
  }
  const unknown = argv.filter((a, i) => a.startsWith("-") && !COMMANDS.has(a) && argv[i - 1] !== "--company");
  if (unknown.length) {
    console.error(`Unknown option: ${unknown.join(" ")}\n\n${USAGE}`);
    process.exit(2);
  }
  if (argv.includes("--version")) {
    console.log(`ssv-agent ${AGENT_VERSION}`);
    process.exit(0);
  }
  warnAboutProxy();
  const companyName = argValue(argv, "--company");
  if (argv.includes("--load-demo")) {
    const { loadDemo } = await import("./demo.js");
    process.exit(await loadDemo({ companyName }));
  }
  if (argv.includes("--probe")) process.exit(await runProbe({ companyName }));
  if (argv.includes("--probe-sweep")) process.exit(await runSweep({ companyName }));

  openDb();
  if (argv.includes("--once")) return once();

  if (!config.local.token) {
    logger.warn("LOCAL_API_TOKEN is not set: the local control API is disabled.");
  }
  const sched = scheduler();
  if (config.local.token) serve(sched);
  // The startup run fetches the config, so the interval set in ERPNext is known
  // before the first one is scheduled.
  runSync({ trigger: "startup" }).finally(async () => {
    sched.start();
    logger.info(`Syncing every ${effectiveIntervalMinutes()} min (set in ${intervalSource()})`);
    if (config.middleware.url) {
      await maybeUpdate();
      controlLoop(sched);
    }
  });
}
