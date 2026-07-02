"use strict";

// Measure the REACTOR (small, fast lane) cost — the piece I hadn't measured. The DEFAULT production coach
// (coachFloorLoop) runs REACTOR every 4s + DEEP every 60s + SUMMARY every 120s, NOT the big prompt every
// 10s (that's the default-off solo collapse). This measures reactor per-agent so the real 3-lane baseline
// can be computed. N=1 (one changed agent) and N=7 (whole floor changed) on Sonnet + Haiku.

const fs = require("fs");
const path = require("path");
const { buildBatchGuidanceRequest, REACTOR } = require("../../packages/shared-services/src/coachBatchRunner");
const { buildReferenceBody } = require("../../packages/shared-services/src/coachReferenceLibrary");
const { createApiRunner, loadEnvKey } = require("./apiRunner");

const UPTO = 14;
const RATES = { "claude-sonnet-5": { in: 2, cacheR: 0.2, cacheW: 2.5, out: 10 }, "claude-haiku-4-5": { in: 1, cacheR: 0.1, cacheW: 1.25, out: 5 } };
const usd = (m, u = {}) => {
  const r = RATES[m];
  return ((u.input_tokens || 0) * r.in + (u.cache_creation_input_tokens || 0) * r.cacheW + (u.cache_read_input_tokens || 0) * r.cacheR + (u.output_tokens || 0) * r.out) / 1e6;
};
const conv = (fx, name) => ({
  sessionId: name,
  call: { uii: "uii-" + name, domain: "WYNN", contactName: (fx.title || "").slice(0, 24) },
  agent: { email: name.replace("fixture-", "") + "@wynn" },
  status: "active",
  latest: { provisionalTranscript: { text: fx.turns[UPTO] ? fx.turns[UPTO].text : "" } },
  arrays: { transcript: fx.turns.slice(0, UPTO).map((t) => ({ role: t.speaker, text: t.text })) },
});

(async () => {
  const apiKey = loadEnvKey(path.join(__dirname, "..", "..", ".env"));
  const reference = buildReferenceBody();
  const names = fs.readdirSync(__dirname).filter((f) => /^fixture-.*\.js$/.test(f)).map((f) => f.replace(/\.js$/, "")).sort();
  const convs = names.map((n) => conv(require(path.join(__dirname, n)), n));

  for (const model of ["claude-sonnet-5", "claude-haiku-4-5"]) {
    const run = createApiRunner({ apiKey, model, maxTokens: 3000 });
    console.log(`\n== REACTOR (${model}) ==`);
    for (const N of [1, 7]) {
      const changedConversations = convs.slice(0, N);
      const req = buildBatchGuidanceRequest({ changedConversations, conversations: changedConversations }, { tier: REACTOR, reference });
      const res = await run({ system: req.system, prompt: req.prompt });
      const u = res.usage || {};
      const cost = usd(model, u);
      console.log(`  N=${N}: 1 reactor call $${cost.toFixed(5)} -> $${(cost / N).toFixed(5)}/agent  [out ${u.output_tokens}, in ${u.input_tokens}, cacheR ${u.cache_read_input_tokens}]`);
    }
  }
})().catch((e) => { console.error(e); process.exit(1); });
