"use strict";

// ONE Opus-fast call that works through ALL active calls at once. 7 distinct ~20-turn
// conversations go in a single prompt; the coach returns real-time guidance per call.
// Tests whether one call/tick can cover the whole floor instead of one call per seat.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { createClaudeAgentRunner } = require("./claudeAgentRunner");
const { buildReferenceBody } = require("../packages/shared-services/src/coachReferenceLibrary");

const sp = path.join(os.tmpdir(), "coach-fast-settings.json");
fs.writeFileSync(sp, JSON.stringify({ fastMode: true }));

// 7 distinct ~20-turn calls (A = agent, P = prospect), each ending mid-objection.
const CALLS = [
  // 1: price / payment structure
  `A: Hi Linda, Marcus with The Tax Group — your name came up in public tax records. Sound fair to ask a couple quick questions?
P: I guess, what's this about.
A: You'd shown up with a possible tax balance. Roughly how much do you owe?
P: Federal, around thirty-two thousand I think.
A: Any years you haven't filed?
P: 2021 and 2022, things fell apart after my divorce.
A: Understood. Are they garnishing you or sending notices?
P: They're taking part of my paycheck now.
A: That's the urgent piece. W-2 or self-employed?
P: W-2, I work at a warehouse.
A: Here's what we see — three things matter: what's owed, what's filed, where you stand on record. First step is getting represented so we deal with the IRS for you, via a Power of Attorney, Form 2848.
P: Okay, and what's that cost.
A: The flat legal fee for representation is eighteen hundred dollars.
P: Eighteen hundred is a lot, I can't pay that all at once.`,

  // 2: scam / trust
  `A: Hi, this is Dave with The Tax Group, following up on a tax matter under your name.
P: How did you get my number.
A: Public tax records or a help site you used. Do you owe the IRS?
P: Maybe, I got some letters.
A: What did the letters say — a balance, a deadline, a levy?
P: One said final notice or something.
A: That's a CP504 or LT11 — intent to levy. How much roughly?
P: Like eighteen grand.
A: Okay. The fix is getting represented so we can pull your file and respond before they levy.
P: Yeah, I've heard this before. Honestly the last company felt like a total scam.
A: Fair. We file a Power of Attorney, pull transcripts, and show you the facts.
P: Everyone says that. How is this not just another rip-off, prove it.`,

  // 3: divorce / emotional + unfiled
  `A: Hi Sandra, Marcus with The Tax Group. Did I catch you okay?
P: I suppose. I don't even know where to start with all this.
A: That's normal. Do you know roughly what you owe?
P: Maybe sixty thousand? It got bad after the business closed.
A: Sorry to hear that. Are there unfiled years in there?
P: Three or four, I lost track honestly.
A: Okay — totally common when a business goes under. Any notices or garnishments yet?
P: Not garnished but the letters keep coming and I can't sleep over it.
A: We can stop the guessing — get represented, pull the real file, and see exactly what's there.
P: Honestly this whole thing is wrecking my marriage and I don't know where to start.`,

  // 4: garnishment panic
  `A: Hi Marcus with The Tax Group, your name came up on a tax balance.
P: Oh thank god, can you actually help me?
A: That's what we do. What's going on?
P: They started taking money out of my check last week and I can barely make rent.
A: Okay, an active garnishment — that's priority one. How much do you owe, roughly?
P: I don't even know, maybe twenty-five or thirty thousand.
A: Any unfiled years?
P: Just last year I think.
A: Good. Once we file the Power of Attorney we can request a release of that garnishment.
P: How fast could you actually get them off my back?`,

  // 5: stall / think it over
  `A: Hi Tom, Marcus with The Tax Group following up on a tax matter.
P: Okay, what about it.
A: You'd come up with a balance. Do you know how much?
P: Around fifteen thousand, state and federal.
A: Any unfiled years?
P: One, maybe two.
A: Have they started collections?
P: I got a levy notice last month.
A: That's time-sensitive. Getting represented today stops the clock — we file the POA and pull your file.
P: This is a lot to take in. Let me think about it and maybe call you back.`,

  // 6: already have a CPA
  `A: Hi, Dave with The Tax Group, reaching out about a tax balance under your name.
P: I have an accountant who does my taxes.
A: Good — does the balance you owe still stand, or is it resolved?
P: I owe about forty thousand, three years I didn't file.
A: Has your accountant filed those three years and handled the collection side?
P: He just does my returns I think.
A: That's the gap — preparing returns isn't the same as representing you with the IRS on collections.
P: I already have an accountant, why would I need you.`,

  // 7: hostility -> softening
  `A: Hi, this is Marcus with The Tax Group calling about a tax matter.
P: Stop f-ing calling me, I'm sick of you people.
A: Understood, not trying to bother you — you did come up in federal tax records for a balance.
P: How did you even get this number.
A: Public records or a tax-help site. That balance is fixable — do you owe the IRS, or not?
P: ...Yeah, fine, I owe like twenty grand. So what.
A: So we can actually help with that. Any unfiled years?
P: One. And they sent some threatening letter.
A: That letter has a clock on it. Getting represented lets us deal with them instead of you.
P: And how do I know you're not just going to take my money and disappear.`,
];

const RICH = process.env.COACH_RICH === "1"; // full per-call {guidance + spine + packets}

const ASK = RICH
  ? "Output ONLY JSON {calls:[{call, read, steer, try, accomplished:[...], next:[...], packets:[{cue, steer}]}]} — one per call: real-time guidance + the accomplished/next spine + 3 anticipated bubbles each."
  : "Output ONLY JSON {calls:[{call:<number>, read, steer, try, next}]} — one entry per call, same order, terse (each field one short sentence).";

const SYSTEM = [
  "You are the live sales-call coach for The Tax Group. Below are MULTIPLE live calls in progress at once.",
  "For EACH call, coach the agent focused on the LAST FEW turns, following the method + tactics + objections reference below.",
  ASK,
  "Never promise outcomes.",
  "",
  "=== REFERENCE ===",
  buildReferenceBody(),
].join("\n");

const ITEM_PROPS = RICH
  ? { call: { type: "number" }, read: { type: "string" }, steer: { type: "string" }, try: { type: "string" },
      accomplished: { type: "array", items: { type: "string" } }, next: { type: "array", items: { type: "string" } },
      packets: { type: "array", items: { type: "object", additionalProperties: false, properties: { cue: { type: "string" }, steer: { type: "string" } } } } }
  : { call: { type: "number" }, read: { type: "string" }, steer: { type: "string" }, try: { type: "string" }, next: { type: "string" } };

const SCHEMA = {
  type: "object", additionalProperties: false, required: ["calls"],
  properties: { calls: { type: "array", items: {
    type: "object", additionalProperties: false, required: ["call", "steer"], properties: ITEM_PROPS,
  } } },
};

async function main() {
  const run = createClaudeAgentRunner({ model: "opus", maxThinkingTokens: 0, extraArgs: ["--settings", sp], timeoutMs: 180000 });
  const prompt = CALLS.map((c, i) => `--- CALL ${i + 1} ---\n${c}`).join("\n\n") + "\n\nReturn JSON {calls:[{call, read, steer, try, next}]}, one per call.";
  const sysTok = Math.round(SYSTEM.length / 4), promptTok = Math.round(prompt.length / 4);
  console.log(`one call, ${CALLS.length} transcripts | system ~${sysTok} tok, transcripts ~${promptTok} tok`);
  const t = Date.now();
  const res = await run({ system: SYSTEM, prompt, schema: SCHEMA });
  const lag = Date.now() - t;
  const u = res.usage || {};
  console.log(`\n=== ONE call worked through ${CALLS.length} transcripts: ${lag}ms | out=${u.output_tokens} tok | ok=${res.ok} ===\n`);
  const out = (res.json && res.json.calls) || [];
  if (!res.ok) console.log("error:", res.error, "| text:", String(res.text || "").slice(0, 300));
  for (const c of out) {
    console.log(`▶ CALL ${c.call}`);
    console.log("  STEER:", c.steer);
    if (c.try) console.log("  TRY  :", c.try);
    console.log("");
  }
}

if (require.main === module) {
  main().catch((e) => { console.error("batch failed:", (e && e.stack) || e); process.exit(1); });
}

module.exports = { CALLS };
