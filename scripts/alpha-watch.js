#!/usr/bin/env node
"use strict";

// Event-driven silent watcher for the CX alpha test. Polls the in-scope runtime logs and
// EXITS (which re-invokes the main agent to grade) only when a MEANINGFUL line appears — a
// dial, a real lead assignment, an error/crash, a RingCX publish result, or an alpha-trace
// event. Routine queue housekeeping (cx_queue.swept, cx_cadence.batch, assigned:0,
// assigned_nonfresh, hourly.tick, status_updated, presence poll) is IGNORED so the operator
// is never pinged for noise. A long heartbeat forces a periodic grade even when quiet.

const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");

const FILES = {
  "control-plane": "runtime/logs/control-plane.local.out.log",
  ringcx: "runtime/logs/ringcentral-cx.local.out.log",
  web: "runtime/logs/vite-3001.out.log",
  inbound: "runtime/logs/inbound-gateway.local.out.log",
  "ai-bus": "runtime/alpha-cutover/ai-bus-7000-safe.out.log",
};

// MEANINGFUL -> wake the agent. Anything not matched (housekeeping) is silently consumed.
const MEANINGFUL = [
  /dialExecution|\.capture\.|capturedUii|activeCall|active-call/i,   // dial / watcher / UII capture (legacy + bulk)
  /markCandidateServing|markAdoptedCandidateServing|cxBulkLoad|reserveFromFamily/i, // BULK rail serving/reserve
  /publishResult|leadsInserted|"rejected/i,                         // RingCX publish outcomes
  // NOTE: routine cx_queue.assigned is intentionally NOT a wake trigger — it fires every cycle
  // once the agent is off-hook; the DIAL (dialExecution/publish) is the real progression event.
  /cx\.alpha\./i,                                                    // alpha-trace events
  /"level":"error"/i,                                               // any error-level log
  /uncaught|unhandledRejection|TypeError|ReferenceError|E11000|ECONNREFUSED|STATUS_STACK_BUFFER_OVERRUN|3221226505/i,
  /"status":\s*(429|5\d\d)/,                                         // real HTTP 429 / 5xx (not digit-substring)
];

const POLL_MS = 15000;
const HEARTBEAT_MS = Number(process.env.ALPHA_WATCH_HEARTBEAT_MS || 900000); // 15 min periodic grade

const offsets = {};
for (const rel of Object.values(FILES)) {
  try { offsets[rel] = fs.statSync(path.join(ROOT, rel)).size; } catch { offsets[rel] = 0; }
}
const startedAt = Date.now();

function readNew(rel) {
  const file = path.join(ROOT, rel);
  let size;
  try { size = fs.statSync(file).size; } catch { return ""; }
  let from = offsets[rel] || 0;
  if (size < from) from = 0; // rotation/truncation
  if (size <= from) { offsets[rel] = size; return ""; }
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.allocUnsafe(size - from);
    fs.readSync(fd, buf, 0, size - from, from);
    offsets[rel] = size;
    return buf.toString("utf8");
  } finally { fs.closeSync(fd); }
}

function poll() {
  try {
    for (const [id, rel] of Object.entries(FILES)) {
      const text = readNew(rel);
      if (!text) continue;
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        for (const re of MEANINGFUL) {
          if (re.test(line)) {
            console.log(`[alpha-watch] MEANINGFUL in ${id}: ${line.slice(0, 260)}`);
            console.log("[alpha-monitor] grade now -> ALPHA_COACH_INTENT=off node scripts/alpha-log-sections.js + fleet (scriptPath C:/code/tagcontactbridgeparalell/scripts/alpha-fleet.workflow.js), surface stop/flag, then restart scripts/alpha-watch.js in background.");
            process.exit(0);
          }
        }
      }
    }
  } catch (_e) { /* never die on a transient read error */ }
  if (Date.now() - startedAt >= HEARTBEAT_MS) {
    console.log(`[alpha-watch] heartbeat ${Math.round((Date.now() - startedAt) / 60000)}m quiet -> periodic grade, then restart scripts/alpha-watch.js.`);
    process.exit(0);
  }
  setTimeout(poll, POLL_MS);
}

console.log(`[alpha-watch] armed; watching ${Object.keys(FILES).join(", ")} for meaningful events (poll ${POLL_MS / 1000}s, heartbeat ${HEARTBEAT_MS / 60000}m).`);
setTimeout(poll, POLL_MS);
