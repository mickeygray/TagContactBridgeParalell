"use strict";

// Lean batch, same 7 transcripts, Sonnet vs Opus-fast — side by side.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { CALLS } = require("./coach-batch");
const { buildReferenceBody } = require("../packages/shared-services/src/coachReferenceLibrary");
const { createClaudeAgentRunner } = require("./claudeAgentRunner");

const sp = path.join(os.tmpdir(), "coach-fast-settings.json");
fs.writeFileSync(sp, JSON.stringify({ fastMode: true }));

const SYSTEM = [
  "You are the live sales-call coach for The Tax Group. Below are MULTIPLE live calls in progress at once.",
  "For EACH call, coach the agent focused on the LAST FEW turns, following the method + tactics + objections reference below.",
  "Output ONLY JSON {calls:[{call:<number>, steer, try}]} — one entry per call, same order, terse (one short sentence each). Never promise outcomes.",
  "",
  "=== REFERENCE ===",
  buildReferenceBody(),
].join("\n");

const SCHEMA = {
  type: "object", additionalProperties: false, required: ["calls"],
  properties: { calls: { type: "array", items: {
    type: "object", additionalProperties: false, required: ["call", "steer"],
    properties: { call: { type: "number" }, steer: { type: "string" }, try: { type: "string" } },
  } } },
};

const PROMPT = CALLS.map((c, i) => `--- CALL ${i + 1} ---\n${c}`).join("\n\n") + "\n\nReturn JSON {calls:[{call, steer, try}]}, one per call.";

async function runModel(model, extraArgs) {
  const run = createClaudeAgentRunner({ model, maxThinkingTokens: 0, extraArgs, timeoutMs: 120000 });
  const t = Date.now();
  const res = await run({ system: SYSTEM, prompt: PROMPT, schema: SCHEMA });
  return { lag: Date.now() - t, out: (res.usage || {}).output_tokens, ok: res.ok, err: res.error, calls: (res.json && res.json.calls) || [] };
}

const LAST = (c) => (c.split("\n").filter(Boolean).pop() || "").replace(/^P:\s*/, "");

async function main() {
  const sonnet = await runModel("sonnet", []);
  const opus = await runModel("opus", ["--settings", sp]);
  console.log(`SONNET lean: ${sonnet.lag}ms / ${sonnet.out} tok  ${sonnet.ok ? "" : "ERR:" + sonnet.err}`);
  console.log(`OPUS-fast lean: ${opus.lag}ms / ${opus.out} tok  ${opus.ok ? "" : "ERR:" + opus.err}\n`);
  for (let i = 1; i <= CALLS.length; i += 1) {
    const s = sonnet.calls.find((c) => c.call === i) || {};
    const o = opus.calls.find((c) => c.call === i) || {};
    console.log("════ CALL " + i + ": " + LAST(CALLS[i - 1]).slice(0, 70));
    console.log("  SONNET: " + (s.steer || "(none)"));
    if (s.try) console.log("          try: " + s.try);
    console.log("  OPUS  : " + (o.steer || "(none)"));
    if (o.try) console.log("          try: " + o.try);
    console.log("");
  }
}

main().catch((e) => { console.error("compare failed:", (e && e.stack) || e); process.exit(1); });
