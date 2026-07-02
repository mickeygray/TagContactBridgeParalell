"use strict";

// Batch-scaling harness: measure the REAL production batch path (coachBatchRunner.buildBatchGuidanceRequest,
// DEEP tier) with N concurrent conversations in ONE call → array of N cockpits. Answers "does doing all 7
// agents at once cost ~1x or ~7x?" by comparing one batched call at N=1/3/5/7 to N× a single-agent call.

const fs = require("fs");
const path = require("path");
const { buildBatchGuidanceRequest, DEEP_PULL } = require("../../packages/shared-services/src/coachBatchRunner");
const { createApiRunner, loadEnvKey } = require("./apiRunner");

const UPTO = 14; // each conversation = its call through ~turn 14 (mid-call, pitch/objection territory)

function convFromFixture(fx, name) {
  return {
    sessionId: name,
    call: { uii: "uii-" + name, domain: "WYNN", contactName: (fx.title || "").slice(0, 24) },
    agent: { email: name.replace("fixture-", "") + "@wynn" },
    status: "active",
    callSummary: "",
    arrays: { transcript: fx.turns.slice(0, UPTO).map((t) => ({ role: t.speaker, text: t.text })) },
  };
}

(async () => {
  const apiKey = loadEnvKey(path.join(__dirname, "..", "..", ".env"));
  const run = createApiRunner({ apiKey, model: "claude-sonnet-5", maxTokens: 12000 });

  const names = fs
    .readdirSync(__dirname)
    .filter((f) => /^fixture-.*\.js$/.test(f))
    .map((f) => f.replace(/\.js$/, ""))
    .sort();
  const convs = names.map((n) => convFromFixture(require(path.join(__dirname, n)), n));

  console.log(`Batched DEEP call — cost vs concurrent conversations (N), one call returns N cockpits:\n`);
  const rows = [];
  for (const N of [1, 3, 5, 7]) {
    const batch = convs.slice(0, N);
    const req = buildBatchGuidanceRequest({ conversations: batch }, { tier: DEEP_PULL });
    const res = await run({ system: req.system, prompt: req.prompt });
    const u = res.usage || {};
    const cockpits = res.json && Array.isArray(res.json.guidance) ? res.json.guidance.length : (res.json && Array.isArray(res.json) ? res.json.length : "?");
    const cost = res.cost || 0;
    rows.push({ N, cost, perAgent: cost / N, out: u.output_tokens, cacheR: u.cache_read_input_tokens, inp: u.input_tokens, cockpits });
    console.log(
      `N=${N}: 1 batched call = $${cost.toFixed(4)}  ->  $${(cost / N).toFixed(4)}/agent   ` +
        `[out ${u.output_tokens}, in ${u.input_tokens}, cacheR ${u.cache_read_input_tokens}, cockpits ${cockpits}]`,
    );
  }

  const single = 0.0173; // measured single-agent B reground (run-window.js)
  console.log(`\nvs per-agent (7 separate single calls): 7 x $${single} = $${(single * 7).toFixed(4)}`);
  const n7 = rows.find((r) => r.N === 7);
  if (n7) {
    const save = 1 - n7.cost / (single * 7);
    console.log(`batched N=7 = $${n7.cost.toFixed(4)}  ->  ${(save * 100).toFixed(0)}% cheaper than 7 separate calls`);
    console.log(`per-agent inside the batch: $${n7.perAgent.toFixed(4)} (vs $${single} solo)`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
