// Starts the SSV hub. Behind nginx / Cloudflare in production; listens on loopback by default.
import { createHub } from "./hub.js";
import { registryPath } from "./registry.js";

const port = Number(process.env.HUB_PORT || 4200);
const host = process.env.HUB_HOST || "127.0.0.1";
createHub().listen(port, host, () => {
  console.log(`${new Date().toISOString()} SSV hub listening on http://${host}:${port} (registry ${registryPath()})`);
});
