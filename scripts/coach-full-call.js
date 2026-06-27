"use strict";

// Replays the full sample call: at each substantive PROSPECT turn, sends the whole
// transcript-so-far to the riff coach (full reference, 0 thinking) and prints the
// coaching. ⚠️ one claude -p Haiku spawn per fired turn.

const fs = require("fs");
const path = require("path");
const { createClaudeAgentRunner } = require("./claudeAgentRunner");
const { buildRiffRequest, parseRiff } = require("../packages/shared-services/src/coachRiff");
const { buildRiffLibrarySystem } = require("../packages/shared-services/src/coachReferenceLibrary");

const os = require("os");
const SYSTEM = buildRiffLibrarySystem();
const MODEL = process.env.COACH_MODEL || "haiku";
const FAST = process.env.COACH_FAST === "1"; // Opus fast mode (--settings fastMode:true)
let EXTRA = [];
if (FAST) {
  const p = path.join(os.tmpdir(), "coach-fast-settings.json");
  fs.writeFileSync(p, JSON.stringify({ fastMode: true }));
  EXTRA = ["--settings", p];
}

function loadTurns() {
  const md = fs.readFileSync(path.join(__dirname, "..", "docs", "SAMPLE_CALL_TRANSCRIPT.md"), "utf8");
  const turns = [];
  for (const line of md.split(/\r?\n/)) {
    const m = line.match(/^\*\*(Agent|Prospect):\*\*\s*(.+)$/);
    if (m) turns.push({ role: m[1].toLowerCase(), text: m[2].trim() });
  }
  return turns;
}

function substantive(turn) {
  if (turn.role !== "prospect") return false;
  return turn.text.split(/\s+/).filter(Boolean).length >= 4;
}

async function main() {
  const turns = loadTurns();
  const run = createClaudeAgentRunner({ model: MODEL, maxThinkingTokens: 0, extraArgs: EXTRA, timeoutMs: 90000 });
  console.log(`Full call (model=${MODEL}${FAST ? " FAST" : ""}, 0 thinking): ${turns.length} turns, ${turns.filter(substantive).length} coachable prospect turns. (ref ${SYSTEM.length} chars)\n`);

  const lags = [];
  for (let i = 0; i < turns.length; i += 1) {
    if (!substantive(turns[i])) continue;
    const soFar = turns.slice(0, i + 1).map((t) => (t.role === "agent" ? "Agent" : "Prospect") + ": " + t.text).join("\n");
    const req = buildRiffRequest({ transcript: soFar });
    req.system = SYSTEM;
    const t0 = Date.now();
    const res = await run(req);
    const lag = Date.now() - t0;
    lags.push(lag);
    const g = parseRiff(res) || {};
    console.log("════════════════════════════════════════════════════════════");
    console.log(`turn ${i}  (${lag}ms${res.ok ? "" : " ERROR:" + res.error})`);
    console.log("  PROSPECT: " + turns[i].text);
    console.log("  STEER: " + (g.steer || "(none)"));
    if (g.try) console.log("  TRY  : " + g.try);
    console.log("");
  }
  const avg = lags.length ? Math.round(lags.reduce((a, b) => a + b, 0) / lags.length) : 0;
  console.log(`=== ${MODEL} | turns: ${lags.length} | avg: ${avg}ms | min: ${Math.min(...lags)}ms | max: ${Math.max(...lags)}ms ===`);
}

main().catch((e) => { console.error("full-call failed:", (e && e.stack) || e); process.exit(1); });
