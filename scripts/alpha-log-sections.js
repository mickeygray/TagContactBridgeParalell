#!/usr/bin/env node
"use strict";

// alpha-log-sections — the DETERMINISTIC backbone of the alpha-test agent fleet.
//
// It does NOT grade. It carves the live runtime logs into per-SECTION deltas (only
// the lines new since the last run, capped) so a grader agent can Read a small file
// instead of tailing a 140MB ndjson. Each section maps to a block of the rubric
// (docs/CX_0_2_ALPHA_TEST_OBSERVABILITY_RUBRIC_2026-06-29.md). A cheap pattern
// pre-scan flags candidate STOP/WATCH lines so a fast tripwire exists between agent
// ticks and so the grader gets pointed at the suspicious lines.
//
// Output (under runtime/alpha-log-sections/ by default):
//   <id>.delta.txt     the new lines for that section this tick (capped)
//   _manifest.json     [{ id, title, rubric, files, newLines, newBytes, truncated,
//                         candidateHits:[{severity,pattern,line}], deltaPath }]
//   _state.json        per-file byte offsets (so the next run reads only newer bytes)
//
// Usage:
//   node scripts/alpha-log-sections.js                 # one tick
//   node scripts/alpha-log-sections.js --reset         # forget offsets (re-seed tails)
//   node scripts/alpha-log-sections.js --seed-lines 0  # on first sight, take 0 backlog (pure new-only)
//   node scripts/alpha-log-sections.js --out-dir <dir> # override output dir
//
// Never throws on a missing/locked/rotated file — a down section is reported, not fatal.

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const MAX_LINES = 1500; // hard cap on lines handed to an agent per section per tick
const MAX_BYTES = 220 * 1024; // and a byte cap (whichever bites first)
const SEED_BYTES = 64 * 1024; // on first sight of a file, how much tail to seed from

// severity: "stop" = rubric §12 stop-the-test class; "watch" = thumbs-down / recurrence.
function rx(severity, re) {
  return { severity, re };
}

// SECTION MAP — each section owns one or more log files + the rubric block it grades against
// + a cheap candidate-pattern set drawn from that block's thumbs-down / stop language.
const SECTIONS = [
  {
    id: "control-plane",
    title: "App / Bulk runtime / Buttons / Drain / DNC+Logics",
    rubric: "§2,3,5,6,8,9 + cx.alpha.* trace",
    files: ["runtime/logs/control-plane.local.out.log"],
    patterns: [
      rx("stop", /\b(E11000|duplicate key)\b/i),
      rx("stop", /cross[-_ ]?agent|wrong[-_ ]?(agent|uii|case)/i),
      rx("watch", /\bphantom|phantomSuspected\b/i),
      rx("watch", /double[-_ ]?(count|increment|reserve)|counted twice|already[-_ ]?counted/i),
      rx("watch", /stale|stuck|orphan/i),
      rx("watch", /\b5\d\d\b|unhandled|uncaught|UnhandledPromiseRejection|TypeError|ReferenceError/i),
      rx("watch", /\b(error|failed|exception|throw)\b/i),
      rx("watch", /cx\.alpha\.(disposition|publish|session)\.[a-z.]+/i),
    ],
  },
  {
    id: "ringcx",
    title: "RingCX upload / active-call watcher / refill / 429",
    rubric: "§4,5,7",
    files: ["runtime/logs/ringcentral-cx.local.out.log"],
    patterns: [
      rx("stop", /\b429\b|rate[-_ ]?limit/i),
      rx("stop", /invalid phone|400\b.*phone|route[-_ ]?lock/i),
      rx("watch", /reject|not accepted|no accepted|leadsInserted/i),
      rx("watch", /\b(error|failed|exception|timeout|ECONNRESET|ETIMEDOUT)\b/i),
      rx("watch", /active[-_ ]?call|uii|dequeue/i),
    ],
  },
  {
    id: "web",
    title: "Web client (vite) — workspace load",
    rubric: "§2",
    files: ["runtime/logs/vite-3001.out.log", "runtime/logs/vite-3001.err.log"],
    patterns: [
      rx("watch", /\b5\d\d\b|error|failed|ERR_/i),
      rx("watch", /workspace|runtime/i),
    ],
  },
  {
    id: "inbound",
    title: "Inbound gateway / first-contact forward",
    rubric: "§11",
    files: ["runtime/logs/inbound-gateway.local.out.log"],
    patterns: [
      rx("watch", /forward|duplicate|first[-_ ]?contact/i),
      rx("watch", /\b(error|failed|5\d\d)\b/i),
    ],
  },
  {
    id: "ai-bus",
    title: "AI bus (7000) — coach providers / health",
    rubric: "§10 coach",
    files: ["runtime/alpha-cutover/ai-bus-7000-safe.out.log", "runtime/alpha-cutover/ai-bus-7000-safe.err.log"],
    patterns: [
      rx("watch", /kill_switch|coach\.kill_switch\.active/i),
      rx("watch", /stt\.realtime\.(error|connect_error)|connect_error/i),
      rx("watch", /\b(error|failed|credit|insufficient|401|403|429)\b/i),
    ],
  },
  {
    id: "grpc-bridge",
    title: "gRPC bridge (3344) — transport",
    rubric: "§10 transport",
    files: ["runtime/alpha-cutover/grpc-bridge-3344.out.log", "runtime/alpha-cutover/grpc-bridge-3344.err.log"],
    patterns: [
      rx("watch", /stream\.start|stream\.end|dialogInit|segmentStart/i),
      rx("watch", /\b(error|failed|abort|reset|UNAVAILABLE|INTERNAL)\b/i),
    ],
  },
  {
    id: "grpc-events",
    title: "gRPC events.ndjson — stream/dialog/media",
    rubric: "§10 transport",
    files: ["runtime/live-coach-grpc-bridge/events.ndjson"],
    jsonl: true,
    patterns: [
      rx("watch", /stream\.start|stream\.end|dialogInit|segmentStart|kill_switch|stt\.realtime\.(error|connect_error)/i),
    ],
  },
];

function parseArgs(argv) {
  const out = { reset: false, seedLines: null, outDir: path.join(ROOT, "runtime", "alpha-log-sections") };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--reset") out.reset = true;
    else if (a === "--seed-lines") out.seedLines = Number.parseInt(argv[++i], 10);
    else if (a === "--out-dir") out.outDir = path.resolve(argv[++i]);
  }
  return out;
}

function readState(stateFile) {
  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return {};
  }
}

// Read the tail of a (possibly huge) file: at most maxBytes from the end, starting at `from`.
function readRange(file, from, to) {
  const length = to - from;
  if (length <= 0) return "";
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.allocUnsafe(length);
    fs.readSync(fd, buf, 0, length, from);
    return buf.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

// Compact a JSONL gRPC event line to the few fields that matter (keeps the delta small).
function compactJsonlLine(line) {
  try {
    const e = JSON.parse(line);
    const o = {
      type: e.type || e.kind || null,
      at: e.at || e.startedAt || e.endedAt || null,
      streamId: e.streamId || null,
      sessionId: e.sessionId || null,
    };
    const uii = e.dialog?.attributes?.uii || e.dialogIdentity?.uii;
    if (uii) o.uii = String(uii);
    if (e.role) o.role = e.role;
    if (e.mediaBytes != null) o.mediaBytes = e.mediaBytes;
    if (e.error) o.error = String(e.error);
    if (e.reason) o.reason = String(e.reason);
    return JSON.stringify(o);
  } catch {
    return line; // not JSON — keep raw
  }
}

function scan(lines, patterns) {
  const hits = [];
  for (const line of lines) {
    for (const { severity, re } of patterns) {
      if (re.test(line)) {
        hits.push({ severity, pattern: re.source.slice(0, 60), line: line.slice(0, 400) });
        break; // one hit per line is enough to flag it
      }
    }
    if (hits.length >= 200) break;
  }
  return hits;
}

function processSection(section, state, opts) {
  const result = {
    id: section.id,
    title: section.title,
    rubric: section.rubric,
    files: section.files,
    newLines: 0,
    newBytes: 0,
    truncated: false,
    candidateHits: [],
    stopHits: 0,
    watchHits: 0,
    deltaPath: path.join(opts.outDir, `${section.id}.delta.txt`),
    note: null,
  };
  let collected = "";

  for (const rel of section.files) {
    const file = path.join(ROOT, rel);
    let size;
    try {
      size = fs.statSync(file).size;
    } catch {
      continue; // file not present yet (down section) — silent; manifest shows 0 newLines
    }
    const key = rel;
    const prior = opts.reset ? undefined : state[key];
    let from;
    if (prior && typeof prior.offset === "number") {
      from = size < prior.offset ? 0 : prior.offset; // rotation/truncation -> re-read from 0
    } else {
      // first sight: seed a bounded tail unless --seed-lines 0
      from = opts.seedLines === 0 ? size : Math.max(0, size - SEED_BYTES);
    }
    let to = size;
    if (to - from > MAX_BYTES) {
      from = to - MAX_BYTES;
      result.truncated = true;
    }
    if (to > from) {
      collected += readRange(file, from, to);
      result.newBytes += to - from;
    }
    state[key] = { offset: size, size };
  }

  const fresh = Boolean(collected);
  let lines = [];
  if (collected) {
    lines = collected.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (section.jsonl) lines = lines.map(compactJsonlLine);
    if (lines.length > MAX_LINES) {
      lines = lines.slice(-MAX_LINES);
      result.truncated = true;
    }
  }
  result.fresh = fresh;
  result.newLines = lines.length;
  const hits = scan(lines, section.patterns);
  result.candidateHits = hits.slice(0, 60);
  result.stopHits = hits.filter((h) => h.severity === "stop").length;
  result.watchHits = hits.filter((h) => h.severity === "watch").length;

  // ALWAYS write a stamped delta (even when quiet) so a grader reading the fixed path knows the
  // current tick, freshness, and intended coach state without any args plumbing.
  const header =
    `# section: ${section.id} (${section.title})\n` +
    `# rubric: ${section.rubric}\n` +
    `# tick: ${opts.tick}  fresh: ${fresh}  newLines: ${result.newLines}  stopHits: ${result.stopHits}  watchHits: ${result.watchHits}  truncated: ${result.truncated}\n` +
    `# coach_intent: ${opts.coachIntent}\n\n`;
  fs.writeFileSync(result.deltaPath, header + lines.join("\n") + (lines.length ? "\n" : ""));
  return result;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  fs.mkdirSync(opts.outDir, { recursive: true });
  const stateFile = path.join(opts.outDir, "_state.json");
  const state = opts.reset ? {} : readState(stateFile);

  const tick = (Number(state._tick) || 0) + 1;
  opts.tick = tick;
  opts.coachIntent = (process.env.ALPHA_COACH_INTENT || "unknown").trim().toLowerCase();

  const sections = SECTIONS.map((s) => processSection(s, state, opts));
  state._tick = tick;
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));

  const changed = sections.filter((s) => s.newLines > 0);
  const totalStop = sections.reduce((n, s) => n + s.stopHits, 0);
  const totalWatch = sections.reduce((n, s) => n + s.watchHits, 0);
  const at = new Date().toISOString();
  const manifest = {
    at,
    tick,
    outDir: opts.outDir,
    changedSections: changed.map((s) => s.id),
    totalStopHits: totalStop,
    totalWatchHits: totalWatch,
    sections,
  };
  fs.writeFileSync(path.join(opts.outDir, "_manifest.json"), JSON.stringify(manifest, null, 2));

  // Ready-to-launch Workflow args for the grader fleet (the loop just reads this file).
  const workflowArgs = {
    tick,
    at,
    intent: { coach: (process.env.ALPHA_COACH_INTENT || "unknown").trim().toLowerCase() },
    changed: changed.map((s) => ({
      id: s.id,
      title: s.title,
      rubric: s.rubric,
      deltaPath: path.resolve(s.deltaPath).replace(/\\/g, "/"),
      newLines: s.newLines,
      stopHits: s.stopHits,
      watchHits: s.watchHits,
    })),
  };
  fs.writeFileSync(path.join(opts.outDir, "_workflow-args.json"), JSON.stringify(workflowArgs, null, 2));

  // One compact console line so a human (or the loop) sees tick health at a glance.
  const changedDesc = changed.length
    ? changed.map((s) => `${s.id}:${s.newLines}${s.stopHits ? `!${s.stopHits}` : ""}`).join(" ")
    : "(no new lines)";
  console.log(`[alpha-sections] ${manifest.at} changed=[${changedDesc}] stop=${totalStop} watch=${totalWatch}`);
}

main();
