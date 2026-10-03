import dotenv from "dotenv";
import os from "os";
import path from "path";

// .env in the current folder first, then next to the .exe (installed agent).
dotenv.config();
dotenv.config({ path: path.join(path.dirname(process.execPath), ".env") });

const env = process.env;
const int = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};

export const config = {
  tally: {
    url: env.TALLY_URL || "http://localhost:9000",
    // Optional: the company to read. If TallyPrime runs as a server with no
    // company selected, the agent asks Tally to load this one by name.
    company: env.TALLY_COMPANY || "",
    timeoutMs: int(env.TALLY_TIMEOUT_MS, 600_000), // large exports can take minutes
    // Every Tally request: ping first, then up to this many attempts,
    // waiting retryDelayMs × attempt between them (10 s, 20 s, 30 s, 40 s).
    retries: int(env.TALLY_RETRIES, 5),
    retryDelayMs: int(env.TALLY_RETRY_DELAY_MS, 10_000),
  },

  middleware: {
    url: (env.MIDDLEWARE_URL || "").replace(/\/+$/, ""),
    // Defaults are the SSV middleware's routes. For ERPNext with the ssv_channel app:
    // /api/method/ssv_channel.api.batches and /api/method/ssv_channel.api.config
    batchesPath: env.MIDDLEWARE_BATCHES_PATH || "/agent/v1/batches",
    configPath: env.MIDDLEWARE_CONFIG_PATH || "/agent/v1/config",
    // Run reports after each sync. Default: the batches path with its last word
    // "batches" replaced by "heartbeat", so an existing .env needs no new line.
    heartbeatPath: env.MIDDLEWARE_HEARTBEAT_PATH ||
      (env.MIDDLEWARE_BATCHES_PATH || "/agent/v1/batches").replace(/batches$/, "heartbeat"),
    distributorId: env.DISTRIBUTOR_ID || "",
    // Shared secret issued by the middleware at registration. Signs every batch.
    agentSecret: env.AGENT_SECRET || "",
    timeoutMs: 120_000,
    // System proxies (HTTP(S)_PROXY) are ignored unless this is 1, so a proxy
    // configured on the PC cannot silently intercept distributor data.
    useProxy: env.USE_PROXY === "1",
  },

  // Local status/control API: loopback only, bearer token required.
  local: {
    host: "127.0.0.1",
    port: int(env.LOCAL_PORT, 4100),
    token: env.LOCAL_API_TOKEN || "",
  },

  sync: {
    // Minutes between runs, 5 to 1440. The interval set on the SSV Distributor in
    // ERPNext takes precedence; this is the fallback until the agent has seen it.
    intervalMinutes: Math.min(1440, Math.max(5, int(env.SYNC_INTERVAL_MINUTES, 5))),
    // How often a continuously running agent asks ERPNext for a changed interval
    // or a "Sync now" request (a light signed GET).
    controlPollSeconds: Math.max(30, int(env.CONTROL_POLL_SECONDS, 120)),
    // Optional first-sync start date (YYYY-MM-DD). Default: company STARTINGFROM.
    syncFrom: env.SYNC_FROM || null,
    // Vouchers are read in AlterID windows of this size, both ends bounded.
    alterIdWindow: int(env.ALTER_ID_WINDOW, 250),
    // After the first sync, the watermark is set this far below the AlterID
    // seen when the first sync started, so edits made meanwhile are re-read.
    firstSyncOverlap: 250,
    // When Tally's ALTVCHID falls below our watermark (backup restored), step back this far.
    restoreStepBack: 5000,
    // Deleted-voucher check: at most this often, and only when ALTVCHID moved.
    deletedCheckIntervalMinutes: int(env.DELETED_CHECK_INTERVAL_MINUTES, 60),
    // Fallback deleted-voucher check (MasterID ranges) looks back this many days.
    deletedFallbackDays: int(env.DELETED_FALLBACK_DAYS, 45),
    // Stock items per closing-balance request.
    stockItemsPerRequest: 50,
  },

  upload: {
    pageSize: int(env.UPLOAD_PAGE_SIZE, 1000),       // pending vouchers read per page
    maxBytes: int(env.UPLOAD_MAX_BYTES, 5 * 1024 * 1024), // per HTTP request
    // The distributor's choice: "false" keeps retailers' phone, address and PIN code
    // on this PC. Name, GSTIN, state and price level are still sent.
    retailerContacts: env.SHARE_RETAILER_CONTACTS !== "false",
    // How often each principal gets per-month totals of what was delivered, to
    // compare with what it holds (0 = every run). Also sent after a restore or resync.
    reconcileEveryHours: Math.max(0, int(env.RECONCILE_EVERY_HOURS, 24)),
  },

  dataDir: env.DATA_DIR || path.join(os.homedir(), "AppData", "Roaming", "SSVConnector", "data"),
};
