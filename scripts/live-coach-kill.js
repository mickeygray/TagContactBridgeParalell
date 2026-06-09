#!/usr/bin/env node
"use strict";

// Live-coach gRPC KILL SWITCH. Short-circuits coaching on the live box WITHOUT
// tearing down the gRPC bridge: RingCX keeps connecting (no floor-side error), the
// bridge just stops STT + coaching for new streams. Takes effect on the NEXT call
// with NO restart (the bridge re-checks the kill file per stream).
//
//   node scripts/live-coach-kill.js on       # disable coaching now (touch kill file)
//   node scripts/live-coach-kill.js off      # re-enable coaching (remove kill file)
//   node scripts/live-coach-kill.js status    # show current state
//
// Honors LIVE_COACH_KILL_FILE (must match the bridge); defaults to runtime/live-coach.killed.
// Note: LIVE_COACH_BRIDGE_DISABLED=1 in .env disables at boot (env wins; clears only on restart).

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const KILL_FILE = process.env.LIVE_COACH_KILL_FILE
  || path.resolve(__dirname, "..", "runtime", "live-coach.killed");
const ENV_DISABLED = /^(1|true|yes|on)$/i.test(String(process.env.LIVE_COACH_BRIDGE_DISABLED || "").trim());

function fileExists() {
  try { return fs.existsSync(KILL_FILE); } catch { return false; }
}
function report() {
  const killed = ENV_DISABLED || fileExists();
  const via = ENV_DISABLED ? "env (LIVE_COACH_BRIDGE_DISABLED)" : fileExists() ? "kill-file" : "none";
  console.log(`live-coach: ${killed ? "DISABLED (coaching off)" : "ENABLED (coaching on)"}`);
  console.log(`  via:       ${via}`);
  console.log(`  kill file: ${KILL_FILE} ${fileExists() ? "(present)" : "(absent)"}`);
  if (ENV_DISABLED) console.log("  NOTE: env flag forces disabled regardless of the kill file; clear it + restart to re-enable.");
}

const cmd = String(process.argv[2] || "status").trim().toLowerCase();
if (cmd === "on" || cmd === "kill" || cmd === "disable") {
  fs.mkdirSync(path.dirname(KILL_FILE), { recursive: true });
  fs.writeFileSync(KILL_FILE, `disabled at ${new Date().toISOString()}\n`);
  console.log("KILL SWITCH ON -> coaching disabled for new streams (no restart needed).");
  report();
} else if (cmd === "off" || cmd === "restore" || cmd === "enable") {
  try { fs.rmSync(KILL_FILE, { force: true }); } catch {}
  console.log("KILL SWITCH OFF -> coaching re-enabled for new streams.");
  if (ENV_DISABLED) console.log("WARNING: LIVE_COACH_BRIDGE_DISABLED is still set in env -> still disabled until you clear it and restart.");
  report();
} else if (cmd === "status") {
  report();
} else {
  console.error(`unknown command: ${cmd}\nusage: node scripts/live-coach-kill.js on|off|status`);
  process.exit(1);
}
