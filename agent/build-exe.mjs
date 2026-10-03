/**
 * build-exe.mjs — builds dist/ssv-agent.exe (Windows, no Node install needed).
 *
 * Uses Node's Single Executable Applications feature:
 *   1. esbuild bundles src/index.js and its dependencies into one CommonJS file
 *   2. node --experimental-sea-config turns it into a blob
 *   3. postject injects the blob into a copy of this node.exe
 *
 * Run with the same Node version the exe should carry (22.13+): npm run build:exe
 */

import { build } from "esbuild";
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// fileURLToPath decodes %20 etc., so the build works from a folder with spaces in its name.
const root = path.dirname(fileURLToPath(import.meta.url));
// SSV_BUILD_OUT builds elsewhere, e.g. while dist\ssv-agent.exe is running and locked.
const out = process.env.SSV_BUILD_OUT ? path.resolve(process.env.SSV_BUILD_OUT) : path.join(root, "dist");
const work = path.join(root, "build");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

// Replace only what this script produces. dist/ may also hold a configured .env
// and packaged zips, which must survive a rebuild.
fs.mkdirSync(out, { recursive: true });
const WIN = ["SSVAgentService.exe", "install.cmd", "install.ps1", "uninstall.cmd", "uninstall.ps1"];
for (const f of ["ssv-agent.exe", "README.txt", ".env.example", "START-HERE.txt", ...WIN]) fs.rmSync(path.join(out, f), { force: true });
fs.mkdirSync(work, { recursive: true });

const bundle = path.join(work, "agent.cjs");
console.log("1/4 bundling");
await build({
  entryPoints: [path.join(root, "src", "index.js")],
  outfile: bundle,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["node:sqlite"],
  logLevel: "warning",
  // import.meta.url is only read when `require` is missing, which never happens in the bundle.
  logOverride: { "empty-import-meta": "silent" },
});

console.log("2/4 creating executable blob");
const blob = path.join(work, "sea-prep.blob");
const seaConfig = path.join(work, "sea-config.json");
fs.writeFileSync(seaConfig, JSON.stringify({
  main: bundle,
  output: blob,
  disableExperimentalSEAWarning: true,
  useCodeCache: false,
}));
execFileSync(process.execPath, ["--experimental-sea-config", seaConfig], { stdio: "inherit" });

console.log("3/4 copying node.exe");
const exe = path.join(out, "ssv-agent.exe");
fs.copyFileSync(process.execPath, exe);

console.log("4/4 injecting");
const postject = path.join(root, "node_modules", "postject", "dist", "cli.js");
execFileSync(process.execPath, [
  postject, exe, "NODE_SEA_BLOB", blob,
  "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
], { stdio: "inherit" });

fs.copyFileSync(path.join(root, ".env.example"), path.join(out, ".env.example"));
fs.writeFileSync(path.join(out, "README.txt"), [
  `SSV Connector Agent ${pkg.version}`,
  "",
  "Start with START-HERE.txt. In short:",
  "1. In TallyPrime: F1 Help > Settings > Connectivity > TallyPrime acts as = Both (port 9000).",
  "2. Double-click install.cmd (asks for admin rights). It installs the Windows service, shows the",
  "   setup password, and opens the setup page (http://127.0.0.1:4100, desktop shortcut",
  "   \"SSV Agent Setup\"): paste the lines from the site's Show Agent Secret, pick the Tally company.",
  "   Settings live in C:\\ProgramData\\SSVConnector (closed to other users).",
  "   Log: C:\\ProgramData\\SSVConnector\\logs\\agent.log      Remove: uninstall.cmd",
  "",
  "Support commands: ssv-agent.exe --once (one sync), --probe (checks Tally, uploads nothing), --help.",
  "Running by hand instead of the service: ssv-agent.exe with a .env in this folder.",
  "",
].join("\r\n"));
// Step-by-step guide for a test PC (kept in packaging/ so rebuilds never lose it)
fs.writeFileSync(path.join(out, "START-HERE.txt"),
  fs.readFileSync(path.join(root, "packaging", "START-HERE.txt"), "utf8").replace(/\r?\n/g, "\r\n"));

// Windows service wrapper, compiled with the C# compiler that ships with .NET Framework 4
// (no download), plus the install / uninstall scripts.
const win = path.join(root, "packaging", "windows");
const csc = ["Framework64", "Framework"].map((f) => path.join(process.env.WINDIR || "C:\\Windows", "Microsoft.NET", f, "v4.0.30319", "csc.exe"))
  .find((p) => fs.existsSync(p));
if (csc) {
  execFileSync(csc, ["/nologo", "/optimize", "/target:exe", `/out:${path.join(out, "SSVAgentService.exe")}`,
    "/reference:System.ServiceProcess.dll", path.join(win, "SSVAgentService.cs")], { stdio: "inherit" });
  for (const f of WIN.slice(1)) {
    fs.writeFileSync(path.join(out, f), fs.readFileSync(path.join(win, f), "utf8").replace(/\r?\n/g, "\r\n"));
  }
  console.log("service wrapper and installer added");
} else {
  console.log("csc.exe not found: service wrapper not built (the exe still runs on its own)");
}

const mb = (fs.statSync(exe).size / 1024 / 1024).toFixed(1);
console.log(`done: ${exe} (${mb} MB)`);
