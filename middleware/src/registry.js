/**
 * registry.js — who may talk to the hub, and where their data goes.
 *
 * One JSON file (HUB_REGISTRY, default ./data/registry.json), readable by the
 * hub's user only. It holds secrets:
 *
 *   {
 *     "distributors": {
 *       "RL-001": {
 *         "name": "Rajlaxmi Solutions",
 *         "enabled": true,
 *         "secret": "<the agent's secret for the hub>",
 *         "links": [
 *           { "principal": "CEAT", "url": "https://ceat.example.com",
 *             "batchesPath": "/api/method/ssv_channel.api.batches",
 *             "configPath": "/api/method/ssv_channel.api.config",
 *             "heartbeatPath": "/api/method/ssv_channel.api.heartbeat",
 *             "distributorId": "DIST-001",          // this distributor's ID on that manufacturer's site
 *             "secret": "<its agent secret there>" }
 *         ]
 *       }
 *     }
 *   }
 *
 * The file is re-read when it changes, so the admin CLI takes effect without a restart.
 */

import fs from "fs";
import path from "path";

export const DEFAULT_PATHS = {
  batchesPath: "/api/method/ssv_channel.api.batches",
  configPath: "/api/method/ssv_channel.api.config",
  heartbeatPath: "/api/method/ssv_channel.api.heartbeat",
};

export function registryPath() {
  return path.resolve(process.env.HUB_REGISTRY || "data/registry.json");
}

let cache = { mtime: 0, data: { distributors: {} } };

export function loadRegistry(file = registryPath()) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return { distributors: {} };
  }
  if (stat.mtimeMs !== cache.mtime || cache.file !== file) {
    cache = { file, mtime: stat.mtimeMs, data: JSON.parse(fs.readFileSync(file, "utf8")) };
  }
  return cache.data;
}

export function saveRegistry(data, file = registryPath()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function distributor(id, data = loadRegistry()) {
  const d = data.distributors?.[id];
  return d && d.enabled !== false ? d : null;
}
