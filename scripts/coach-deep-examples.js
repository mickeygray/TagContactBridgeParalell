"use strict";

// Shows what the over-fleshed (~51K) reference buys: hard scenarios that exercise the
// DEEP tactics layer (hostility resilience, tactical empathy / labels, accusation
// audit, the pain funnel, mirror-to-open, the specific objection plays). Opus fast,
// 0 thinking. ⚠️ one claude -p Opus spawn per scenario.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { createClaudeAgentRunner } = require("./claudeAgentRunner");
const { buildRiffRequest, parseRiff } = require("../packages/shared-services/src/coachRiff");
const { buildRiffLibrarySystem } = require("../packages/shared-services/src/coachReferenceLibrary");

const sp = path.join(os.tmpdir(), "coach-fast-settings.json");
fs.writeFileSync(sp, JSON.stringify({ fastMode: true }));
const SYSTEM = buildRiffLibrarySystem();

const SCENARIOS = [
  { label: "HOSTILITY", case: "Federal ~25k, unknown years, cold outbound.",
    line: "Stop f-ing calling me, I'm sick of you people. How did you even get this number?" },
  { label: "RAW EMOTION / PAIN", case: "Owes ~60k, self-employed, behind several years.",
    line: "Honestly I can't sleep over this. It's wrecking my marriage and I don't even know where to start." },
  { label: "PROVE-IT SKEPTIC", case: "Has a CP504, ~18k, burned before.",
    line: "Everyone says they can help. How is this not just another rip-off? Prove it." },
  { label: "DO-IT-MYSELF", case: "~12k federal, one unfiled year.",
    line: "Why would I pay you? I can just call the IRS myself and set up a payment plan." },
  { label: "VAGUE HOOK (mirror)", case: "Unknown — early in the call.",
    line: "It's just been a nightmare since the business went under." },
  { label: "SOFT BUYING SIGNAL", case: "Wage garnishment active, ~30k.",
    line: "I mean... how fast could you actually get them off my back?" },
];

async function main() {
  const run = createClaudeAgentRunner({ model: "opus", maxThinkingTokens: 0, extraArgs: ["--settings", sp], timeoutMs: 90000 });
  console.log(`(over-fleshed reference: ${SYSTEM.length} chars, Opus fast, 0 thinking)\n`);
  for (const s of SCENARIOS) {
    const transcript = "Agent: [tax-resolution agent on the line]\nProspect: " + s.line;
    const req = buildRiffRequest({ transcript, caseContext: s.case });
    req.system = SYSTEM;
    const t = Date.now();
    const res = await run(req);
    const g = parseRiff(res) || {};
    console.log("════════════════════════════════════════════════════════════");
    console.log(`▶ ${s.label}   (${Date.now() - t}ms)`);
    console.log("  PROSPECT: " + s.line);
    console.log("  READ : " + (g.read || "(none)"));
    console.log("  STEER: " + (g.steer || "(none)"));
    if (g.try) console.log("  TRY  : " + g.try);
    console.log("");
  }
}

main().catch((e) => { console.error("failed:", (e && e.stack) || e); process.exit(1); });
