/**
 * rules.js
 * ────────
 * Principal rules for this distributor. Source, in order:
 *   1. The middleware: GET /agent/v1/config (signed like batches). Cached to disk.
 *      The same response carries the agent settings set in ERPNext (control.js).
 *   2. The cached copy, when the middleware is unreachable.
 *   3. <dataDir>/principals.json, for development before the middleware exists.
 */

import fs from "fs";
import path from "path";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { fetchRemoteConfig } from "./control.js";

const CACHE = path.join(config.dataDir, "principals.cache.json");
const LOCAL = path.join(config.dataDir, "principals.json");

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function validate(rules) {
  if (!Array.isArray(rules)) throw new Error("principal rules must be an array");
  for (const r of rules) {
    if (!r.code || typeof r.code !== "string") throw new Error("every principal rule needs a code");
  }
  return rules;
}

export async function loadRules() {
  const { url, distributorId, agentSecret } = config.middleware;
  if (url && distributorId && agentSecret) {
    try {
      const rules = validate((await fetchRemoteConfig())?.principals);
      fs.mkdirSync(config.dataDir, { recursive: true });
      fs.writeFileSync(CACHE, JSON.stringify(rules, null, 2));
      return { rules, source: "middleware" };
    } catch (err) {
      logger.warn(`Could not load principal rules from middleware (${err.message}); using cached copy`);
    }
  }
  const cached = readJson(CACHE);
  if (cached) return { rules: validate(cached), source: "cache" };
  const local = readJson(LOCAL);
  if (local) return { rules: validate(local), source: "local file" };
  return { rules: [], source: "none" };
}
