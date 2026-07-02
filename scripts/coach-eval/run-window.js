"use strict";

// A/COACH (small prompt) cost harness — the companion to run.js (which measures B/STRATEGIST).
// For each fixture: run B ONCE to crystalize a cockpit (the play sheet), then tick the small A prompt
// forward N turns (a growth-gated simulation of the 10s live loop), carrying A's guidance+summary
// tick-to-tick. A reads only {section, says-menu, prior guidance, running summary, last turn} — NO
// reference — so it is cheap. Measures cost per A tick on Sonnet AND Haiku (the "Haiku-able" target).
//
//   node scripts/coach-eval/run-window.js            # all fixtures, 5 A ticks each, Sonnet + Haiku

const fs = require("fs");
const path = require("path");
const { buildStrategistRequest, buildCoachRequest } = require("../../packages/shared-services/src/coachTwoStationPrompts");
const { buildReferenceBody } = require("../../packages/shared-services/src/coachReferenceLibrary");
const { createApiRunner, loadEnvKey } = require("./apiRunner");

// $/MTok. Sonnet 5 intro: in 2 / cacheR 0.2 / cacheW 2.5 / out 10. Haiku 4.5: in 1 / cacheR 0.1 / cacheW 1.25 / out 5.
const RATES = {
  "claude-sonnet-5": { in: 2, cacheR: 0.2, cacheW: 2.5, out: 10 },
  "claude-haiku-4-5": { in: 1, cacheR: 0.1, cacheW: 1.25, out: 5 },
};
function usd(model, u = {}) {
  const r = RATES[model] || RATES["claude-sonnet-5"];
  return (
    ((u.input_tokens || 0) * r.in +
      (u.cache_creation_input_tokens || 0) * r.cacheW +
      (u.cache_read_input_tokens || 0) * r.cacheR +
      (u.output_tokens || 0) * r.out) /
    1e6
  );
}

const N_TICKS = 5;
const A_MODELS = ["claude-sonnet-5", "claude-haiku-4-5"];
// Ground B at an early turn so >= N_TICKS turns remain to advance A over.
const START = {
  "fixture-hostile-dnc": 7,
  "fixture-hard-no": 8,
  "fixture-noise-heavy": 8,
  "fixture-fast-yes": 8,
  "fixture-complex-tax": 10,
  "fixture-rambling": 8,
  "fixture-tax-call-01": 8,
};

(async () => {
  const apiKey = loadEnvKey(path.join(__dirname, "..", "..", ".env"));
  const reference = buildReferenceBody();
  const bRun = createApiRunner({ apiKey, model: "claude-sonnet-5" });
  const aRun = Object.fromEntries(A_MODELS.map((m) => [m, createApiRunner({ apiKey, model: m, maxTokens: 800 })]));

  const fixtures = fs
    .readdirSync(__dirname)
    .filter((f) => /^fixture-.*\.js$/.test(f))
    .map((f) => f.replace(/\.js$/, ""))
    .sort();

  const aCosts = Object.fromEntries(A_MODELS.map((m) => [m, []]));
  let bTotal = 0, bN = 0;

  for (const name of fixtures) {
    const fx = require(path.join(__dirname, name));
    const start = START[name] || Math.min(8, fx.turns.length - N_TICKS - 1);

    // B once — crystalize the cockpit.
    const transcript = fx.turns.slice(0, start).map((t) => `${t.speaker}: ${t.text}`).join("\n");
    const bReq = buildStrategistRequest({ reference, transcript, priorSummaryText: "" });
    const bRes = await bRun({ system: bReq.system, prompt: bReq.prompt });
    const bCost = bRes.cost || 0;
    bTotal += bCost; bN += 1;
    const cockpit = (bRes.json && Array.isArray(bRes.json.guidance) && bRes.json.guidance[0]) || {};
    const says = Array.isArray(cockpit.says) ? cockpit.says : [];
    const section = cockpit.currentSection || "";
    const recSay = (says.find((s) => s && s.rec) || says[0] || {}).text || "";
    const baseSummary = (typeof bRes.json?.summary === "string" ? bRes.json.summary : "") || "";

    // A ticks forward, per model, carrying guidance + summary.
    for (const model of A_MODELS) {
      let guidance = recSay, summary = baseSummary, ok = 0;
      for (let i = 1; i <= N_TICKS; i++) {
        const turn = fx.turns[start + i];
        if (!turn) break;
        const aReq = buildCoachRequest({
          currentSection: section,
          says,
          priorGuidance: guidance,
          summaryText: summary,
          lastTurns: `${turn.speaker}: ${turn.text}`,
        });
        const aRes = await aRun[model]({ system: aReq.system, prompt: aReq.prompt });
        aCosts[model].push(usd(model, aRes.usage || {}));
        if (aRes.json) { guidance = aRes.json.guidance || guidance; summary = aRes.json.summary || summary; ok += 1; }
      }
      console.log(`  ${name} A(${model}): ${ok}/${N_TICKS} parsed`);
    }
    console.log(`${name}: B=$${bCost.toFixed(4)} @turn${start} §${section}  says=${says.length}`);
  }

  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  console.log(`\n██ B (strategist, big prompt) mean: $${(bTotal / bN).toFixed(4)} over ${bN} runs`);
  for (const m of A_MODELS) {
    const a = aCosts[m];
    console.log(`\n██ A (coach, small prompt) — ${m} — ${a.length} ticks`);
    console.log(`   per tick: mean $${mean(a).toFixed(5)}  min $${Math.min(...a).toFixed(5)}  max $${Math.max(...a).toFixed(5)}`);
    console.log(`   $/min live talk:  @6 ticks/min $${(mean(a) * 6).toFixed(4)}   @4/min $${(mean(a) * 4).toFixed(4)}   @3/min $${(mean(a) * 3).toFixed(4)}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
