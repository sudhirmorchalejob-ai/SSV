import fs from "fs";
import path from "path";
import { config } from "./config.js";

const LOG_DIR = path.join(config.dataDir, "..", "logs");
const MAX_MEMORY = 500;
const recent = [];

function write(level, message, meta) {
  const entry = { ts: new Date().toISOString(), level, message, ...(meta ? { meta } : {}) };
  recent.unshift(entry);
  if (recent.length > MAX_MEMORY) recent.length = MAX_MEMORY;

  const line = `${entry.ts} ${level.toUpperCase().padEnd(5)} ${message}${meta ? " " + JSON.stringify(meta) : ""}`;
  (level === "error" ? console.error : console.log)(line);

  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOG_DIR, `agent-${entry.ts.slice(0, 10)}.log`), line + "\n");
  } catch { /* logging must never break a sync */ }
}

export const logger = {
  info: (m, meta) => write("info", m, meta),
  warn: (m, meta) => write("warn", m, meta),
  error: (m, meta) => write("error", m, meta),
  recent: (limit = 200) => recent.slice(0, limit),
};
