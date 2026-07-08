"use strict";

// FLOOR WATCH — the "logs that watch everything" station (Sean pilot, 2026-07-08).
// One terminal, one file, the whole floor-facing surface of the bulk rail:
//
//   * EVERY bulk session (all agents, not just the newest) — per-call journeys
//     DIAL → ANSWER → TERMINAL → DRAIN → CARD → RESOLVE with stall warnings,
//     exactly like cx-answer-progression.js but fleet-wide.
//   * A live tail of the NSSM service logs (control-plane out+err by default,
//     --all for every parallel-*.log) filtered to the markers that matter:
//     cx.alpha blocks, [cx][wipe], errors, publish rejects, unknown tokens.
//   * Everything it prints is ALSO appended to logs/floor-rollout/watch-<stamp>.log
//     so the evidence survives NSSM's 10MB rotation and terminal scrollback.
//
// Read-only everywhere except its own sink file. Ctrl+C any time.
//
// Usage:
//   node scripts/cx-floor-watch.js                       -> all agents, default tails
//   node scripts/cx-floor-watch.js --agent slucas@...    -> one agent's sessions only
//   node scripts/cx-floor-watch.js --all                 -> tail every parallel-* log
//   node scripts/cx-floor-watch.js --logs-dir <dir>      -> NSSM dir (default C:\tools\logs)

const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const { getSharedConfig } = require("../packages/shared-config/src");
const {
  CxBulkLoadSession,
  CxTerminalOutbox,
  CxCallWrapCard,
} = require("../packages/shared-models/src");

const args = { agent: null, all: false, logsDir: "C:\\tools\\logs" };
for (let i = 2; i < process.argv.length; i += 1) {
  const a = process.argv[i];
  if (a === "--agent") args.agent = String(process.argv[++i] || "").trim().toLowerCase();
  else if (a === "--all") args.all = true;
  else if (a === "--logs-dir") args.logsDir = process.argv[++i] || args.logsDir;
}

const POLL_MS = 2000;
const STALL_TERMINAL_MS = 90_000;
const STALL_DRAIN_MS = 60_000;
const STALL_CARD_MS = 45_000;

// ---- the sink: everything printed is also filed ----
const sinkDir = path.join(__dirname, "..", "logs", "floor-rollout");
fs.mkdirSync(sinkDir, { recursive: true });
const sinkPath = path.join(
  sinkDir,
  `watch-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}.log`,
);
const sink = fs.createWriteStream(sinkPath, { flags: "a" });

function stamp() { return new Date().toISOString().slice(11, 19); }
function say(msg) {
  const line = `${stamp()}  ${msg}`;
  console.log(line);
  sink.write(line + "\n");
}
function mask(phone) {
  const s = String(phone || "");
  return s.length > 4 ? `***${s.slice(-4)}` : s || "-";
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---- per-call journeys, keyed sessionId:queueItemId (fleet-wide) ----
const journeys = new Map();
function journey(key) {
  if (!journeys.get(key)) journeys.set(key, { hops: {}, warned: {}, name: null, agent: null });
  return journeys.get(key);
}
function hop(j, name, msg) {
  if (j.hops[name]) return false;
  j.hops[name] = Date.now();
  say(msg);
  return true;
}
function warnOnce(j, key, msg) {
  if (j.warned[key]) return;
  j.warned[key] = true;
  say(`⚠⚠ ${msg}`);
}

// ---- the log tails: positional, rotation-aware ----
const RED_FLAGS = [
  ["sysdispo.unknown_token", "UNKNOWN SYSDISPO TOKEN"],
  ["[cx][wipe]", "CASE-PANEL WIPE"],
  ["drain.row.failed", "DRAIN ROW FAILED"],
  ["drain.scan", "DRAIN SCAN PROBLEM"],
  ["publish", null], // narrated below with reject detection
];
function tailTargets() {
  const base = ["parallel-parallelcontrolplane.out.log", "parallel-parallelcontrolplane.err.log"];
  const files = args.all
    ? fs.readdirSync(args.logsDir).filter((f) => /^parallel-.*\.(out|err)\.log$/.test(f))
    : base;
  return files.map((f) => path.join(args.logsDir, f)).filter((f) => fs.existsSync(f));
}
const tailState = new Map(); // file -> offset

function pumpTails() {
  for (const file of tailTargets()) {
    try {
      const size = fs.statSync(file).size;
      let offset = tailState.has(file) ? tailState.get(file) : size; // start at NOW, not history
      if (size < offset) offset = 0; // rotation: file shrank, restart from top
      if (size === offset) { tailState.set(file, offset); continue; }
      const fd = fs.openSync(file, "r");
      const buf = Buffer.alloc(Math.min(size - offset, 512 * 1024)); // 512KB per pump max
      const read = fs.readSync(fd, buf, 0, buf.length, offset);
      fs.closeSync(fd);
      tailState.set(file, offset + read);
      const text = buf.slice(0, read).toString("utf8");
      const short = path.basename(file).replace("parallel-parallel", "").replace(".log", "");
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const low = line.toLowerCase();
        const isAlpha = low.includes("cx.alpha");
        const isErrFile = file.endsWith(".err.log");
        const flag = RED_FLAGS.find(([needle]) => needle && low.includes(needle));
        if (flag && flag[1]) {
          say(`🚩 [${short}] ${flag[1]}: ${line.slice(0, 300)}`);
        } else if (low.includes("rejected") && (low.includes("publish") || low.includes("cx"))) {
          say(`🚩 [${short}] PUBLISH/REJECT: ${line.slice(0, 300)}`);
        } else if (isErrFile && /error|exception|unhandled|econn|timeout/i.test(line)) {
          say(`🚩 [${short}] ERR: ${line.slice(0, 300)}`);
        } else if (isAlpha) {
          // alpha header lines only (the payload block lands in the archive via
          // cx-floor-pilot-report.js; here we want the heartbeat, not the flood) —
          // and the every-tick poller chatter is muted entirely.
          if (
            /^cx\.alpha\./.test(line) &&
            !line.startsWith("cx.alpha.watch.match_diagnostic") &&
            !line.startsWith("cx.alpha.watch.session.projected")
          ) {
            say(`· [${short}] ${line.replace(/\s*\{$/, "")}`);
          }
        }
      }
    } catch (err) {
      // fail-soft: a rotating file mid-read is not an emergency
    }
  }
}

// ---- the Mongo fleet poll ----
const startedAt = new Date();
const knownSessions = new Map(); // sessionId -> lastPhase

async function pumpSessions() {
  const query = {
    createdAt: { $gte: new Date(Date.now() - 12 * 60 * 60 * 1000) },
    ...(args.agent ? { agentEmail: args.agent } : {}),
  };
  const sessions = await CxBulkLoadSession.find(query).sort({ createdAt: 1 }).lean();
  for (const s of sessions) {
    const prev = knownSessions.get(s.sessionId);
    if (prev === undefined) {
      say(`■ SESSION ${s.sessionId} agent=${s.agentEmail} status=${s.status} phase=${s.phase} buffered=${(s.acceptedBuffer || []).length}`);
    } else if (prev !== `${s.status}:${s.phase}`) {
      say(`■ SESSION ${s.sessionId} (${s.agentEmail}) -> status=${s.status} phase=${s.phase}`);
    }
    knownSessions.set(s.sessionId, `${s.status}:${s.phase}`);

    const current = s.current;
    if (current?.queueItemId) {
      const j = journey(`${s.sessionId}:${current.queueItemId}`);
      j.name = current.name || j.name;
      j.agent = s.agentEmail;
      hop(j, "dial", `DIAL [${s.agentEmail}] "${current.name}" ${mask(current.phone)}`);
      if (current.connectedAt) hop(j, "answer", `ANSWER [${s.agentEmail}] "${current.name}"`);
      if (current.wrap?.at) hop(j, "wrap", `WRAP-HOLD [${s.agentEmail}] "${current.name}" (waiting on the click)`);
    }

    const stash = Array.isArray(s.sysDispoRetries) ? s.sysDispoRetries : [];
    for (const entry of stash) {
      const j = journey(`${s.sessionId}:${entry.queueItemId}`);
      hop(j, "retry-defer", `RETRY-QUEUE [${s.agentEmail}] "${j.name || entry.queueItemId}" label deferred (${entry.lastReason})`);
    }
  }

  const sessionIds = sessions.map((s) => s.sessionId);
  if (!sessionIds.length) return;

  const rows = await CxTerminalOutbox.find({
    sessionId: { $in: sessionIds },
    createdAt: { $gte: startedAt },
  }).lean();
  for (const row of rows) {
    const key = `${row.sessionId}:${row.queueItemId || row.payload?.queueItemId || row.idemKey}`;
    const j = journey(key);
    j.name = j.name || row.payload?.name || null;
    hop(j, "terminal", `TERMINAL [${j.agent || row.sessionId}] "${j.name || "?"}" outcome=${row.payload?.outcome || row.outcome} sys=${row.payload?.systemDisposition || "none"}`);
    if (row.status === "drained") {
      hop(j, "drain", `DRAIN [${j.agent || ""}] "${j.name || "?"}" replayed`);
    } else if (j.hops.terminal && Date.now() - j.hops.terminal > STALL_DRAIN_MS) {
      warnOnce(j, "drain-stall", `"${j.name}" terminal still ${row.status} after ${Math.round((Date.now() - j.hops.terminal) / 1000)}s — drain ticking? (attempts=${row.attempts})`);
    }
  }

  const cards = await CxCallWrapCard.find({
    createdAt: { $gte: startedAt },
    ...(args.agent ? { agentEmail: args.agent } : {}),
  }).lean();
  for (const card of cards) {
    // cards key by queueItemId; find the journey from any session
    const jKey = [...journeys.keys()].find((k) => k.endsWith(`:${card.queueItemId}`)) || `card:${card.idemKey}`;
    const j = journey(jKey);
    hop(j, "card", `CARD [${card.agentEmail}] "${card.name}" minted sys=${card.systemDisposition || "none"}`);
    if (card.status !== "pending") {
      hop(j, "resolve", `RESOLVE [${card.agentEmail}] "${card.name}" -> ${card.status}${card.resolvedBy ? ` by ${card.resolvedBy}` : ""} ✔ full progression`);
    }
  }

  // stall sweeps
  for (const [key, j] of journeys) {
    if (j.hops.answer && !j.hops.terminal && !j.hops.wrap && Date.now() - j.hops.answer > STALL_TERMINAL_MS) {
      warnOnce(j, "terminal-stall", `[${j.agent || key}] "${j.name}" answered ${Math.round((Date.now() - j.hops.answer) / 1000)}s ago — no terminal, no wrap hold. Did the click land?`);
    }
    if (j.hops.drain && !j.hops.card && Date.now() - j.hops.drain > STALL_CARD_MS && !j.warned["no-card-noted"]) {
      j.warned["no-card-noted"] = true; // answered-only cards; note once, quietly
    }
  }
}

async function main() {
  const config = getSharedConfig();
  await mongoose.connect(config.mongoUri, { dbName: config.parallelDbName });
  say(`FLOOR WATCH armed (read-only). agents=${args.agent || "ALL"} tails=${tailTargets().map((f) => path.basename(f)).join(", ") || "none found"}`);
  say(`sink -> ${sinkPath}`);
  for (;;) {
    try {
      pumpTails();
      await pumpSessions();
    } catch (err) {
      say(`(pump error, retrying: ${err.message})`);
    }
    await sleep(POLL_MS);
  }
}

main().catch((err) => {
  console.error(`floor watch failed: ${err.message}`);
  process.exit(1);
});
