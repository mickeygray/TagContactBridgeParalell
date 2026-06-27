"use strict";

// Runs a batch of diverse prospect moments through the riff + full-reference coach
// (0 thinking) and prints the dialog sent + the coaching returned. ⚠️ spawns one
// claude -p Haiku per scenario on Max.

const { createClaudeAgentRunner } = require("./claudeAgentRunner");
const { buildRiffRequest, parseRiff } = require("../packages/shared-services/src/coachRiff");
const { buildRiffLibrarySystem } = require("../packages/shared-services/src/coachReferenceLibrary");

const SYSTEM = buildRiffLibrarySystem();

const SCENARIOS = [
  {
    label: "PRICE / can't pay all at once",
    caseContext: "Federal ~32k, 2 unfiled years, wage garnishment active, W-2, tight on cash.",
    transcript: [
      "Agent: We file a Power of Attorney, Form 2848, to get you represented. The flat legal fee is eighteen hundred.",
      "Prospect: Eighteen hundred is a lot, I cant pay that all at once.",
    ],
  },
  {
    label: "STALL / I need to think about it",
    caseContext: "State + federal ~15k, got a levy notice, self-employed.",
    transcript: [
      "Agent: Based on what you told me, getting represented today stops the clock on that levy notice.",
      "Prospect: I dont know, this is a lot to take in. Let me think about it and maybe call you back.",
    ],
  },
  {
    label: "ALREADY HAVE A CPA",
    caseContext: "Federal ~40k, 3 unfiled years, has a bookkeeper.",
    transcript: [
      "Agent: The first step is getting your unfiled returns done and a Power of Attorney on file.",
      "Prospect: I already have an accountant who does my taxes, why would I need you?",
    ],
  },
  {
    label: "BUYING SIGNAL / how long does it take",
    caseContext: "Federal ~22k, 1 unfiled year, CP504 received, motivated.",
    transcript: [
      "Agent: Once we are representing you, we deal with the IRS directly so you stop getting these letters.",
      "Prospect: Okay, and how long does this whole thing usually take?",
    ],
  },
  {
    label: "DECISION MAKER / talk to my spouse",
    caseContext: "Joint return, ~50k owed, both spouses on the hook, garnishment threatened.",
    transcript: [
      "Agent: The sooner we file the POA the sooner we can request a hold on collections.",
      "Prospect: This sounds okay but I really need to talk to my husband before I do anything.",
    ],
  },
  {
    label: "DISCOVERY / prospect reveals the situation",
    caseContext: "Unknown — early in the call.",
    transcript: [
      "Agent: Can I ask a few quick questions to see where things stand?",
      "Prospect: Yeah. I owe somewhere around twelve grand, I think I missed filing last year, and I just got some letter saying final notice.",
    ],
  },
];

async function main() {
  const run = createClaudeAgentRunner({ model: "haiku", maxThinkingTokens: 0, timeoutMs: 60000 });
  console.log(`(reference library: ${SYSTEM.length} chars, 0 thinking)\n`);
  for (const s of SCENARIOS) {
    const req = buildRiffRequest({ transcript: s.transcript.join("\n"), caseContext: s.caseContext });
    req.system = SYSTEM;
    const t = Date.now();
    const res = await run(req);
    const lag = Date.now() - t;
    const g = parseRiff(res) || {};
    console.log("════════════════════════════════════════════════════════════");
    console.log(`▶ ${s.label}   (${lag}ms)`);
    console.log(`  case: ${s.caseContext}`);
    for (const line of s.transcript) console.log("  " + line);
    console.log("  ── coach ──");
    console.log("  READ : " + (g.read || "(none)"));
    console.log("  STEER: " + (g.steer || "(none)"));
    if (g.try) console.log("  TRY  : " + g.try);
    console.log("");
  }
}

main().catch((e) => { console.error("examples failed:", (e && e.stack) || e); process.exit(1); });
