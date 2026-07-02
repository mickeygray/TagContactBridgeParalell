#!/usr/bin/env node
"use strict";

// alpha-mirror — continuously appends the active in-scope runtime logs to an APPEND-ONLY
// archive under runtime/alpha-log-archive/. The live logs get TRUNCATED on a service
// restart (a restart mid-dial-run wiped a whole run on 2026-06-30), which erased the bulk
// rail's cx.alpha.* dial traces before they could be graded. This mirror reads each log's
// new bytes every few seconds and appends them to a durable archive that is NEVER truncated,
// so a restart can no longer destroy a run's history. Pure append; safe to leave running.

const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const ARCHIVE = path.join(ROOT, "runtime", "alpha-log-archive");
fs.mkdirSync(ARCHIVE, { recursive: true });

// The bulk rail's dial traces (cx.alpha.publish.batch / disposition.transport / session.*)
// log in the CONTROL-PLANE process (5001), not the ringcx log — that is "the right thing".
const MAP = {
  "control-plane": "runtime/logs/control-plane.local.out.log",
  ringcx: "runtime/logs/ringcentral-cx.local.out.log",
  web: "runtime/logs/vite-3001.out.log",
  inbound: "runtime/logs/inbound-gateway.local.out.log",
  "ai-bus": "runtime/alpha-cutover/ai-bus-7000-safe.out.log",
};
const POLL_MS = 3000;

const offsets = {};
for (const rel of Object.values(MAP)) {
  try { offsets[rel] = fs.statSync(path.join(ROOT, rel)).size; } catch { offsets[rel] = 0; }
}

function tick() {
  for (const [id, rel] of Object.entries(MAP)) {
    const live = path.join(ROOT, rel);
    const archive = path.join(ARCHIVE, `${id}.log`);
    let size;
    try { size = fs.statSync(live).size; } catch { continue; }
    let from = offsets[rel] || 0;
    if (size < from) {
      // truncation/restart: mark it in the archive, then resume from the new file's start
      try { fs.appendFileSync(archive, `\n# --- ${new Date().toISOString()} ${rel} truncated/restarted; mirror resuming from 0 ---\n`); } catch {}
      from = 0;
    }
    if (size > from) {
      try {
        const fd = fs.openSync(live, "r");
        try {
          const buf = Buffer.allocUnsafe(size - from);
          fs.readSync(fd, buf, 0, size - from, from);
          fs.appendFileSync(archive, buf);
        } finally { fs.closeSync(fd); }
      } catch { /* transient; retry next tick */ }
    }
    offsets[rel] = size;
  }
  setTimeout(tick, POLL_MS);
}

console.log(`[alpha-mirror] mirroring ${Object.keys(MAP).length} live logs -> ${ARCHIVE} every ${POLL_MS / 1000}s (append-only, survives restarts)`);
setTimeout(tick, POLL_MS);
