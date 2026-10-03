/**
 * update.js — install the agent version the manufacturer approved.
 *
 * The config carries `agent.update: { version, url, sha256 }` (SSV Settings on the
 * manufacturer's site; the hub passes the lowest version all of a distributor's
 * manufacturers approve). When that version is newer than this one and the agent
 * runs as the Windows service, the agent:
 *
 *   1. downloads the exe into <config dir>\update\ssv-agent.exe
 *   2. checks its SHA-256 against the approved checksum (deletes it if different)
 *   3. writes update.json and exits with code 75
 *
 * The service wrapper then swaps the exe, keeping the old one, and restarts the
 * agent. If the new version keeps failing, the wrapper puts the old one back and
 * leaves a bad-<version> marker, which stops this module downloading it again.
 * Run by hand (not as the service), the agent only logs that an update exists.
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import axios from "axios";
import { config } from "./config.js";
import { logger } from "./logger.js";

export const UPDATE_EXIT_CODE = 75;

export function compareVersions(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

export const updateDir = () => path.join(process.cwd(), "update");
const failedChecks = new Map(); // version -> time of a failed download, so it is not hammered

/** Is `update` something this agent should install now? */
export function wanted(update, current, { service = process.env.SSV_SERVICE === "1" } = {}) {
  if (!update?.version || !update.url || !update.sha256) return false;
  if (compareVersions(update.version, current) <= 0) return false;
  if (fs.existsSync(path.join(updateDir(), `bad-${update.version}`))) return false;
  const failed = failedChecks.get(update.version);
  if (failed && Date.now() - failed < 6 * 3600_000) return false;
  if (!service) {
    logger.info(`Agent ${update.version} is approved; install it with the new package (auto-update runs only as the Windows service).`);
    return false;
  }
  return true;
}

/** Download and verify. Returns true when staged for the service to install. */
export async function stage(update) {
  const dir = updateDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "ssv-agent.exe");
  logger.info(`Downloading agent ${update.version} …`);
  try {
    const res = await axios.get(update.url, {
      responseType: "arraybuffer", timeout: 300_000, maxContentLength: 300 * 1024 * 1024,
      ...(config.middleware.useProxy ? {} : { proxy: false }),
    });
    const data = Buffer.from(res.data);
    const got = crypto.createHash("sha256").update(data).digest("hex");
    if (got !== update.sha256.toLowerCase()) {
      failedChecks.set(update.version, Date.now());
      logger.warn(`Agent ${update.version} download does not match the approved checksum; not installed.`);
      return false;
    }
    fs.writeFileSync(file, data);
    fs.writeFileSync(path.join(dir, "update.json"), JSON.stringify({ version: update.version, sha256: got }));
    logger.info(`Agent ${update.version} downloaded and verified; the service installs it now.`);
    return true;
  } catch (err) {
    failedChecks.set(update.version, Date.now());
    logger.warn(`Could not download agent ${update.version}: ${err.message}`);
    return false;
  }
}
