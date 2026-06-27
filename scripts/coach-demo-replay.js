"use strict";

// coach-demo-replay — slice A of the local coach demo.
//
// Wires the REAL `claude -p` Haiku runner into the warm orchestrator and replays a
// transcript script, printing each turn's CoachState (mode + the rendered feedback
// item) and the per-spawn latency. This is the first run where real coach output
// flows end-to-end on the Max subscription — and it doubles as the lag/feasibility
// probe the whole Max-brain plan hinges on.
//
//   node scripts/coach-demo-replay.js [path/to/script.json]
//
// The script file is a JSON array of { role: "agent"|"prospect", text }. With no
// arg it replays a built-in WYNN sample. ⚠️ Requires a box with `claude` logged
// into Max (it spawns the binary). Sequential, one spawn at a time — no 429 storm.

const fs = require("node:fs");
const { createCoachOrchestrator } = require("../packages/shared-services/src/coachOrchestrator");
const { createClaudeAgentRunner } = require("./claudeAgentRunner");

const SAMPLE = [
  { role: "agent", text: "Hi Linda, this is Marcus calling from Wynn Tax — am I speaking with Linda?" },
  { role: "prospect", text: "Yeah this is Linda. What's this about?" },
  { role: "agent", text: "Can I ask a few quick questions to see where things stand?" },
  { role: "prospect", text: "It's federal, around thirty-two thousand. I didn't file 2021 or 2022, and they're garnishing my wages now." },
  { role: "prospect", text: "I'm a W-2 employee and honestly money's tight, I can't pay all that at once." },
  { role: "agent", text: "Here's what we typically see in cases like yours — it comes down to what's owed, what's filed, and where you stand on record." },
  { role: "agent", text: "The first step is getting you represented — we file a Power of Attorney, Form 2848, so we can deal with the IRS for you." },
  { role: "agent", text: "The flat legal fee for representation is eighteen hundred dollars." },
  { role: "prospect", text: "Eighteen hundred? That's a lot of money, I'm really not sure I can swing that right now." },
  { role: "prospect", text: "Honestly just take me off your list and stop calling me." },
];

function loadScript(argPath) {
  if (!argPath) return SAMPLE;
  const raw = fs.readFileSync(argPath, "utf8");
  const arr = JSON.parse(raw);
  if (!Array.isArray(arr)) throw new Error("script must be a JSON array of { role, text }");
  return arr;
}

function fmtItem(item) {
  if (!item) return "(no item)";
  const t = item.try ? ` | TRY: ${item.try}` : "";
  return `[${item.kind}/${item.severity}] READ: ${item.read} | STEER: ${item.steer}${t}`;
}

async function main() {
  const script = loadScript(process.argv[2]);
  const runner = createClaudeAgentRunner({ model: "haiku" });
  const orch = createCoachOrchestrator({ runner, now: () => Date.now() });

  const lags = [];
  let spawns = 0;
  console.log(`\n=== coach demo replay — ${script.length} turns (Haiku composer on Max) ===\n`);

  for (let i = 0; i < script.length; i += 1) {
    const turn = script[i];
    const t0 = Date.now();
    const r = await orch.ingestTurn(turn);
    const ms = Date.now() - t0;
    if (r.spawned) {
      spawns += 1;
      lags.push(ms);
    }
    const who = String(turn.role).toUpperCase().padEnd(8);
    console.log(`${String(i).padStart(2)}  ${who} ${turn.text}`);
    console.log(`    -> phase=${orch.phase}  mode=${r.mode}  ${r.spawned ? `(spawned ${ms}ms)` : "(no spawn)"}`);
    if (r.mode !== "quiet") console.log(`    -> ${fmtItem(r.item || (r.state.feedback[r.state.feedback.length - 1]))}`);
    console.log("");
  }

  const avg = lags.length ? Math.round(lags.reduce((a, b) => a + b, 0) / lags.length) : 0;
  const max = lags.length ? Math.max(...lags) : 0;
  console.log("=== summary ===");
  console.log(`turns: ${script.length}  composer spawns: ${spawns}  avg lag: ${avg}ms  max lag: ${max}ms`);
  console.log(`final phase: ${orch.phase}  final mode: ${orch.snapshot().mode}`);
}

main().catch((e) => {
  console.error("replay failed:", (e && e.stack) || e);
  process.exit(1);
});
