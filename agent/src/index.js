/**
 * index.js
 * ────────
 * Bootstrap. Probe runs must be isolated from the real agent: their own data
 * folder, no upload, and deleted-voucher checks on every run. The environment
 * has to be set before config.js reads it, so the agent is loaded afterwards.
 */

import os from "os";
import path from "path";

const argv = process.argv.slice(2);

if (argv.includes("--probe") || argv.includes("--probe-sweep")) {
  process.env.DATA_DIR = process.env.PROBE_DIR || path.join(os.homedir(), "AppData", "Roaming", "SSVConnector", "probe");
  process.env.MIDDLEWARE_URL = ""; // probes never upload; .env cannot override a key that is set
  process.env.DELETED_CHECK_INTERVAL_MINUTES = "0";
}

import("./main.js")
  .then((m) => m.start(argv))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
