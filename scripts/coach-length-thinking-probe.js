"use strict";

// Probe: how does Haiku's response latency scale with PROMPT LENGTH (no thinking),
// and is THINKING + a SHORT prompt better than NO-THINKING + a LONG prompt?
//
// Length ladder built from real objection-bank content (so quality is observable,
// not just latency). All on the same coaching moment. ⚠️ spawns ~7 claude -p Haiku
// calls on Max — run on a box with `claude` logged in.

const { createClaudeAgentRunner } = require("./claudeAgentRunner");
const { RIFF_SYSTEM, buildRiffRequest, parseRiff } = require("../packages/shared-services/src/coachRiff");
const { OBJECTION_PLAYBOOK, formatObjectionPlaybookForPrompt } = require("../packages/shared-services/src/liveCoachObjectionBank");

// keys minus DNC (the DNC formatter short-circuits to a terminal block alone)
const KEYS = OBJECTION_PLAYBOOK.filter((e) => e.family !== "compliance_dnc").map((e) => e.key);

const TRANSCRIPT = [
  "Agent: Hi Linda, this is Marcus with Wynn Tax. Can I ask a few quick questions?",
  "Prospect: Sure. Its federal, around thirty-two thousand, didnt file 2021 or 2022, and theyre garnishing my wages.",
  "Agent: We file a Power of Attorney, Form 2848, to get you represented. The flat legal fee is eighteen hundred.",
  "Prospect: Eighteen hundred is a lot, I cant pay that all at once.",
].join("\n");
const CASE = "Federal ~32k, 2 unfiled years (2021,2022), wage garnishment active, W-2, tight on cash.";

function sizedSystem(nObjections, doubled) {
  if (!nObjections) return RIFF_SYSTEM;
  let block = formatObjectionPlaybookForPrompt(KEYS.slice(0, nObjections), { maxEntries: nObjections });
  if (doubled) block = block + "\n\n" + block;
  return RIFF_SYSTEM + "\n\nOBJECTION PLAYBOOKS (reference):\n" + block;
}

async function run(label, system, thinking) {
  const runner = createClaudeAgentRunner({ model: "haiku", maxThinkingTokens: thinking, timeoutMs: 120000 });
  const req = buildRiffRequest({ transcript: TRANSCRIPT, caseContext: CASE });
  req.system = system;
  const t = Date.now();
  const res = await runner(req);
  const lag = Date.now() - t;
  const u = res.usage || {};
  const inTok = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  const g = parseRiff(res) || {};
  console.log(`\n[${label}]  lag=${lag}ms  sysChars=${system.length}  inTok=${inTok}  outTok=${u.output_tokens}  thinking=${thinking}`);
  console.log("  STEER:", g.steer || "(none)");
  if (g.try) console.log("  TRY  :", g.try);
  return { label, lag, sysChars: system.length, inTok, outTok: u.output_tokens };
}

async function main() {
  const rows = [];
  console.log("=== LADDER: prompt length vs latency, NO THINKING ===");
  rows.push(await run("L0 riff (short)", sizedSystem(0), 0));
  rows.push(await run("L1 +3 obj", sizedSystem(3), 0));
  rows.push(await run("L2 +8 obj", sizedSystem(8), 0));
  rows.push(await run("L3 +all obj (~full bank)", sizedSystem(KEYS.length), 0));
  rows.push(await run("L4 +all obj x2 (oversized)", sizedSystem(KEYS.length, true), 0));

  console.log("\n=== THINKING vs LENGTH (quality weigh) ===");
  rows.push(await run("T1 short + think 1024", sizedSystem(0), 1024));
  rows.push(await run("T2 short + think 4096", sizedSystem(0), 4096));

  console.log("\n=== SUMMARY (lag vs input tokens) ===");
  for (const r of rows) console.log(`  ${r.label.padEnd(28)} lag=${String(r.lag).padStart(6)}ms  inTok=${String(r.inTok).padStart(6)}  outTok=${r.outTok}`);
}

main().catch((e) => { console.error("probe failed:", (e && e.stack) || e); process.exit(1); });
