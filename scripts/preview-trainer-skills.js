"use strict";

// Launcher for the LOCAL trainer draft preview: the packet API plus the web
// client pointed at it.
//
// This exists instead of a shell one-liner because it has to set two env vars
// consistently and kill both children together. Nested quoting through npm ->
// concurrently -> cmd.exe/sh is the kind of thing that works on one machine and
// silently breaks on the next, and the Linux target makes that a real risk.
//
// The two vars must agree, which is the whole point:
//   TRAINER_SKILL_PREVIEW_PORT  where the draft API listens
//   WEB_CLIENT_API_TARGET       where vite proxies /api
// Default 5099 — deliberately NOT 5001, so the preview can never squat the
// control plane's port. Both remain overridable.

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const PORT = String(process.env.TRAINER_SKILL_PREVIEW_PORT || 5099);
const TARGET = process.env.WEB_CLIENT_API_TARGET || `http://127.0.0.1:${PORT}`;
const isWindows = process.platform === "win32";

const env = { ...process.env, TRAINER_SKILL_PREVIEW_PORT: PORT, WEB_CLIENT_API_TARGET: TARGET };

console.log(`[preview] trainer draft API on ${PORT}; web client proxying /api → ${TARGET}`);
if (!TARGET.includes(`:${PORT}`)) {
  console.warn(`[preview] WARNING: proxy target ${TARGET} does not point at port ${PORT} — the UI will not reach this API.`);
}

const children = [];
function launch(name, command, args, cwd = undefined) {
  const child = spawn(command, args, { stdio: "inherit", env, shell: false, cwd });
  child.on("exit", (code, signal) => {
    console.log(`[preview] ${name} exited (${signal || code}) — stopping the other half.`);
    shutdown(typeof code === "number" ? code : 1);
  });
  child.on("error", (error) => {
    console.error(`[preview] ${name} failed to start: ${error.message}`);
    shutdown(1);
  });
  children.push({ name, child });
  return child;
}

let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { child } of children) {
    if (!child.killed) {
      try { child.kill(); } catch { /* already gone */ }
    }
  }
  // Give children a moment to die before taking the process down with us.
  setTimeout(() => process.exit(code), 300);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    console.log(`\n[preview] ${signal} — shutting both down.`);
    shutdown(0);
  });
}

const REPO = path.resolve(__dirname, "..");
// Run vite's JS entry directly with this node binary rather than going through
// npm. Since Node 20.12 / 18.20, spawning a .cmd shim on Windows without a
// shell throws EINVAL, and `shell: true` would mean quoting user-supplied paths
// into a command line. Spawning the .js avoids both problems on both platforms.
const VITE = path.join(REPO, "apps", "web-client", "node_modules", "vite", "bin", "vite.js");
if (!fs.existsSync(VITE)) {
  console.error(`[preview] vite not found at ${VITE} — run npm install first.`);
  process.exit(1);
}

launch("trainer-api", process.execPath,
  [path.join(REPO, "scripts", "trainer-skill-preview-api.js")]);
launch("trainer-web", process.execPath,
  [VITE, "--host", "127.0.0.1"], path.join(REPO, "apps", "web-client"));
