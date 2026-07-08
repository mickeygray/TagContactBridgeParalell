"use strict";

// FLOOR PILOT SESSION REPORT (user-by-user rollout, 2026-07-08). One shot, read-only
// Mongo; the ONLY writes are report/extract files under logs/floor-rollout/ when
// --archive is passed. Run it at the end of a pilot agent's observation window:
//
//   node scripts/cx-floor-pilot-report.js --agent slucas@taxadvocategroup.com --archive
//
// It prints the day's scoreboard (sessions, dials, outcomes, sysdispo labels, drain
// health, wrap cards minted/resolved) with PASS/WATCH/FAIL verdicts, then (with
// --archive) snapshots the control-plane log lines that mention cx.alpha / the agent /
// the day's session ids into logs/floor-rollout/<agent>-<yyyymmdd>/ so the evidence
// survives NSSM's 10MB rotation.
//
// Flags:
//   --agent <email>   REQUIRED. The pilot agent.
//   --since <ISO>     window start (default: today 00:00 local)
//   --archive         write the report + log extracts to logs/floor-rollout/
//   --logs-dir <dir>  NSSM log dir (default C:\tools\logs)

const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const { getSharedConfig } = require("../packages/shared-config/src");
const {
  CxBulkLoadSession,
  CxTerminalOutbox,
  CxCallWrapCard,
} = require("../packages/shared-models/src");

const args = { agent: null, since: null, archive: false, logsDir: "C:\\tools\\logs" };
for (let i = 2; i < process.argv.length; i += 1) {
  const a = process.argv[i];
  if (a === "--agent") args.agent = String(process.argv[++i] || "").trim().toLowerCase();
  else if (a === "--since") args.since = process.argv[++i] || null;
  else if (a === "--archive") args.archive = true;
  else if (a === "--logs-dir") args.logsDir = process.argv[++i] || args.logsDir;
}

if (!args.agent || !args.agent.includes("@")) {
  console.error("Usage: node scripts/cx-floor-pilot-report.js --agent <email> [--since <ISO>] [--archive]");
  process.exit(2);
}

const out = [];
function say(msg) {
  out.push(msg);
  console.log(msg);
}
function mask(phone) {
  const s = String(phone || "");
  return s.length > 4 ? `***${s.slice(-4)}` : s || "-";
}
function verdict(ok, label, detail) {
  say(`  ${ok === true ? "PASS " : ok === false ? "FAIL " : "WATCH"}  ${label}${detail ? ` — ${detail}` : ""}`);
  return ok;
}

async function main() {
  const config = getSharedConfig();
  await mongoose.connect(config.mongoUri, { dbName: config.parallelDbName });

  const since = args.since
    ? new Date(args.since)
    : (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; })();
  if (Number.isNaN(since.getTime())) throw new Error(`bad --since: ${args.since}`);

  say(`FLOOR PILOT REPORT  agent=${args.agent}  window=${since.toISOString()} .. ${new Date().toISOString()}`);

  // ---- sessions ----
  const sessions = await CxBulkLoadSession.find({
    agentEmail: args.agent,
    createdAt: { $gte: since },
  }).sort({ createdAt: 1 }).lean();
  const sessionIds = sessions.map((s) => s.sessionId);
  say(`\nSESSIONS (${sessions.length})`);
  for (const s of sessions) {
    const served = (s.completed || []).length + (s.current ? 1 : 0);
    say(`  ${s.sessionId}  status=${s.status} phase=${s.phase}  served=${served} buffered=${(s.acceptedBuffer || []).length}  started=${String(s.createdAt).slice(0, 24)}`);
    const stash = Array.isArray(s.sysDispoRetries) ? s.sysDispoRetries : [];
    if (stash.length) say(`    ⚠ sysDispoRetries still stashed: ${stash.length} (should drain to empty)`);
  }

  // ---- terminal outbox ----
  const rows = sessionIds.length
    ? await CxTerminalOutbox.find({ sessionId: { $in: sessionIds } }).lean()
    : [];
  const byOutcome = new Map();
  const byStatus = new Map();
  const sysLabels = new Map();
  for (const row of rows) {
    const outcome = row.payload?.outcome || row.outcome || "unknown";
    byOutcome.set(outcome, (byOutcome.get(outcome) || 0) + 1);
    byStatus.set(row.status, (byStatus.get(row.status) || 0) + 1);
    const sys = row.payload?.systemDisposition;
    if (sys) sysLabels.set(sys, (sysLabels.get(sys) || 0) + 1);
  }
  say(`\nTERMINALS (${rows.length} outbox rows)`);
  for (const [k, v] of byOutcome) say(`  outcome ${k}: ${v}`);
  for (const [k, v] of sysLabels) say(`  sys=${k}: ${v}`);

  // ---- wrap cards ----
  const cards = await CxCallWrapCard.find({
    agentEmail: args.agent,
    createdAt: { $gte: since },
  }).lean();
  const cardsByStatus = new Map();
  for (const c of cards) cardsByStatus.set(c.status, (cardsByStatus.get(c.status) || 0) + 1);
  say(`\nWRAP CARDS (${cards.length})`);
  for (const [k, v] of cardsByStatus) say(`  ${k}: ${v}`);
  for (const c of cards) {
    say(`  "${c.name}" ${mask(c.phone)} sys=${c.systemDisposition || "none"} -> ${c.status}${c.resolvedBy ? ` by ${c.resolvedBy}` : ""}`);
  }

  // ---- log extract (unknown tokens, wipes, lane noise live in the logs, not Mongo) ----
  const logFiles = ["parallel-parallelcontrolplane.out.log", "parallel-parallelcontrolplane.err.log"]
    .map((f) => path.join(args.logsDir, f))
    .filter((f) => fs.existsSync(f));
  // The alpha markers print as multi-line object dumps ("cx.alpha.x {" ... "at: '<ISO>'"
  // then "}" at column 0), so the extract walks UNITS (block or single line), windows
  // them by any parseable timestamp, and keeps a unit when it is in-window AND (it is an
  // alpha block OR it mentions the agent/session). Unreadable timestamps fail OPEN —
  // better a noisy archive than a missing one.
  const extracts = [];
  let unknownTokens = 0;
  let wipeLines = 0;
  const needles = [args.agent, ...sessionIds].map((s) => String(s).toLowerCase()).filter(Boolean);
  const TS_RE = /['"](\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[^'"]*)['"]/;
  for (const file of logFiles) {
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      let unit;
      if (/^cx\.alpha\./.test(lines[i]) && lines[i].endsWith("{")) {
        const start = i;
        while (i < lines.length - 1 && lines[i] !== "}") i += 1;
        unit = { text: lines.slice(start, i + 1).join("\n"), alpha: true };
      } else {
        unit = { text: lines[i], alpha: lines[i].includes("cx.alpha") };
      }
      const low = unit.text.toLowerCase();
      if (!unit.alpha && !needles.some((n) => low.includes(n))) continue;
      const ts = TS_RE.exec(unit.text)?.[1];
      if (ts && new Date(ts).getTime() < since.getTime()) continue; // pre-window history
      extracts.push(unit.text);
      if (low.includes("sysdispo.unknown_token")) unknownTokens += 1;
      if (low.includes("[cx][wipe]")) wipeLines += 1;
    }
  }
  say(`\nLOG EXTRACT  files=${logFiles.length} matched-lines=${extracts.length} (dir ${args.logsDir})`);

  // ---- the verdict block (fail-closed: anything not provably clean is WATCH) ----
  say(`\nVERDICTS`);
  verdict(sessions.length > 0 ? true : null, "session ran", `${sessions.length} session(s)`);
  const pending = byStatus.get("pending") || 0;
  verdict(rows.length === 0 ? null : pending === 0, "drain ledger clean", `${pending} outbox row(s) still pending`);
  const answered = byOutcome.get("answered") || 0;
  verdict(
    answered === 0 ? null : cards.length >= answered ? true : false,
    "every ANSWERED minted a card",
    `${answered} answered vs ${cards.length} card(s)`,
  );
  const unresolved = cardsByStatus.get("pending") || 0;
  verdict(cards.length === 0 ? null : unresolved === 0, "all cards resolved", `${unresolved} still pending`);
  verdict(unknownTokens === 0, "no unknown sysdispo tokens", `${unknownTokens} unknown_token line(s)`);
  verdict(wipeLines === 0, "no [cx][wipe] lines", `${wipeLines} found`);
  const retriesLeft = sessions.reduce((n, s) => n + ((s.sysDispoRetries || []).length), 0);
  verdict(retriesLeft === 0, "sysdispo retry stash empty", `${retriesLeft} stashed`);

  // ---- archive ----
  if (args.archive) {
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const dir = path.join(__dirname, "..", "logs", "floor-rollout", `${args.agent.split("@")[0]}-${day}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "report.txt"), out.join("\n") + "\n", "utf8");
    fs.writeFileSync(path.join(dir, "log-extract.txt"), extracts.join("\n") + "\n", "utf8");
    say(`\nARCHIVED -> ${dir}`);
  } else {
    say(`\n(no --archive: nothing written)`);
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(`pilot report failed: ${err.message}`);
  process.exit(1);
});
