"use strict";

// Eval: run the STRATEGIST prompt on annotated fixture(s) at each checkpoint, print SAID / EXPECTED /
// GOT (full) or a --compact scorecard. Real Sonnet via the Anthropic API (key from .env) or claude -p.
//
//   node scripts/coach-eval/run.js                    # fixture-tax-call-01, full
//   node scripts/coach-eval/run.js <fixture>          # a specific fixture module
//   node scripts/coach-eval/run.js --all              # every fixture-*.js in this dir (full)
//   node scripts/coach-eval/run.js --all --compact    # scorecard sweep across all fixtures
//   (--claude-p forces the Max claude -p runner instead of the API)

const fs = require("fs");
const path = require("path");
const { buildStrategistRequest } = require("../../packages/shared-services/src/coachTwoStationPrompts");
const { buildReferenceBody } = require("../../packages/shared-services/src/coachReferenceLibrary");
const { createClaudeAgentRunner } = require("../claudeAgentRunner");
const { createApiRunner, loadEnvKey } = require("./apiRunner");

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith("--"));
const positional = args.filter((a) => !a.startsWith("--"));
const RUN_ALL = flags.includes("--all");
const COMPACT = flags.includes("--compact");
// --dump=<path> writes the FULL per-checkpoint outputs (expect + got) as JSON, for offline grading.
const DUMP = (flags.find((f) => f.startsWith("--dump=")) || "").split("=").slice(1).join("=") || null;
const dumpRecords = [];

function fixtureNames() {
  if (RUN_ALL) {
    return fs
      .readdirSync(__dirname)
      .filter((f) => /^fixture-.*\.js$/.test(f))
      .map((f) => f.replace(/\.js$/, ""))
      .sort();
  }
  return [positional[0] || "fixture-tax-call-01"];
}

function renderTranscript(turns) {
  return turns.map((t) => `${t.speaker}: ${t.text}`).join("\n");
}
function bullets(arr, indent = "      ") {
  if (!Array.isArray(arr) || !arr.length) return `${indent}(none)`;
  return arr.map((x) => `${indent}- ${x}`).join("\n");
}
function renderSays(says) {
  if (!Array.isArray(says) || !says.length) return "      (none)";
  return says
    .map((s) => `      ${s && s.rec ? "★" : "·"} [${(s && s.type) || "?"}] ${(s && s.tag) || ""}: ${(s && s.text) || ""}`)
    .join("\n");
}
function bestSay(says) {
  const arr = Array.isArray(says) ? says : [];
  const rec = arr.find((s) => s && s.rec) || arr[0];
  return rec ? `[${rec.type || "?"}] ${rec.text || ""}` : "(none)";
}

async function runFixture(runner, reference, fixtureName) {
  const fixture = require(path.join(__dirname, fixtureName));
  console.log(`\n${COMPACT ? "■" : "██"} ${fixtureName} — ${fixture.title}`);

  let priorSummary = "";
  let prevAfter = 0;
  let fixtureCost = 0;
  let totalMs = 0;

  for (const cp of fixture.checkpoints) {
    const turns = fixture.turns.slice(0, cp.afterTurn);
    const transcript = renderTranscript(turns);
    const req = buildStrategistRequest({ reference, transcript, priorSummaryText: priorSummary });

    const t0 = Date.now();
    const res = await runner({ system: req.system, prompt: req.prompt });
    const ms = Date.now() - t0;
    totalMs += ms;
    const cost = (res && (res.cost != null ? res.cost : res.raw && res.raw.total_cost_usd)) || 0;
    fixtureCost += cost;
    const u = (res && res.usage) || {};
    const usageStr =
      u.input_tokens != null
        ? `in ${u.input_tokens} +cacheR ${u.cache_read_input_tokens || 0} → out ${u.output_tokens}`
        : "";

    const json = (res && res.json) || {};
    const cockpit = Array.isArray(json.guidance) ? json.guidance[0] || {} : {};
    const summary = typeof json.summary === "string" ? json.summary : (json.summary && json.summary.summaryText) || "";
    const parseFail = !res || res.ok === false || (!json.guidance && !json.summary);

    if (DUMP) {
      dumpRecords.push({
        fixture: fixtureName,
        label: cp.label,
        afterTurn: cp.afterTurn,
        transcriptSoFar: turns.map((t) => `${t.n}. ${t.speaker}: ${t.text}`).join("\n"),
        expect: cp.expect,
        parseFail,
        got: {
          currentSection: cockpit.currentSection || null,
          says: Array.isArray(cockpit.says) ? cockpit.says : [],
          reasoning: cockpit.reasoning || "",
          remember: Array.isArray(cockpit.remember) ? cockpit.remember : [],
          beats: Array.isArray(cockpit.beats) ? cockpit.beats : [],
          priorFlags: Array.isArray(cockpit.priorFlags) ? cockpit.priorFlags : [],
          summary,
        },
        ms,
        cost,
        rawTextOnFail: parseFail ? String((res && res.text) || "").slice(0, 1200) : undefined,
      });
    }

    if (COMPACT) {
      const e = cp.expect || {};
      console.log(`  ▸ ${cp.label} (t${cp.afterTurn}) §${cockpit.currentSection || "?"} [${ms}ms $${cost.toFixed(4)}]${parseFail ? "  !!PARSE/ERR" : ""}`);
      console.log(`      expect  obj[${(e.objections || []).length}] opp[${(e.opportunities || []).length}] filter[${(e.filter || []).length}]`);
      console.log(`      say     ${bestSay(cockpit.says)}`);
      console.log(`      why     ${(cockpit.reasoning || "").slice(0, 240)}`);
      console.log(`      flags[${(cockpit.priorFlags || []).length}]  summary  ${(summary || "").slice(0, 200)}`);
      if (parseFail && res && res.error) console.log(`      err     ${res.error}`);
    } else {
      console.log(`\n════════════════════════════════════════════════════════════════════`);
      console.log(`CHECKPOINT: ${cp.label}   (after turn ${cp.afterTurn})   [${ms}ms  $${cost.toFixed(4)}${usageStr ? "  " + usageStr : ""}]`);
      console.log(`════════════════════════════════════════════════════════════════════`);
      console.log(`— SAID (turns ${prevAfter + 1}–${cp.afterTurn}) —`);
      for (const t of fixture.turns.slice(prevAfter, cp.afterTurn)) console.log(`   ${t.n}. ${t.speaker}: ${t.text}`);
      console.log(`\n— EXPECTED —`);
      console.log(`   context:`); console.log(bullets(cp.expect.context));
      console.log(`   objections:`); console.log(bullets(cp.expect.objections));
      console.log(`   opportunities:`); console.log(bullets(cp.expect.opportunities));
      console.log(`   filter:`); console.log(bullets(cp.expect.filter));
      console.log(`\n— GOT (strategist) —`);
      if (parseFail) {
        console.log(`   !! ${res && res.error ? "error: " + res.error : "could not parse JSON"}`);
        if (res && res.text) console.log(`   raw: ${String(res.text).slice(0, 600)}`);
      } else {
        console.log(`   section: ${cockpit.currentSection || "?"}`);
        console.log(`   says (best ★ / other ·):`);
        console.log(renderSays(cockpit.says));
        console.log(`   reasoning: ${cockpit.reasoning || "(none)"}`);
        console.log(`   remember: ${JSON.stringify((cockpit.remember || []).map((r) => r && r.text))}`);
        console.log(`   priorFlags: ${JSON.stringify(cockpit.priorFlags || [])}`);
        console.log(`   summary: ${summary || "(none)"}`);
      }
    }

    priorSummary = summary || priorSummary;
    prevAfter = cp.afterTurn;
  }
  console.log(`  └ ${fixtureName}: ${fixture.checkpoints.length} cp, ${(totalMs / 1000).toFixed(0)}s, $${fixtureCost.toFixed(4)}`);
  return fixtureCost;
}

(async () => {
  const reference = buildReferenceBody();
  const apiKey = loadEnvKey(path.join(__dirname, "..", "..", ".env"));
  const useApi = Boolean(apiKey) && !flags.includes("--claude-p");
  const runner = useApi
    ? createApiRunner({ apiKey, model: "claude-sonnet-5" })
    : createClaudeAgentRunner({ model: "claude-sonnet-5", maxThinkingTokens: 0, effort: "medium", timeoutMs: 180000 });

  const names = fixtureNames();
  console.log(`\n██ COACH STRATEGIST EVAL — ${names.length} fixture(s)   runner: ${useApi ? "Anthropic API (thinking off, cached ref)" : "claude -p (Max)"}   ref chars: ${reference.length}${COMPACT ? "   [compact]" : ""}`);

  let grand = 0;
  for (const name of names) {
    try {
      grand += await runFixture(runner, reference, name);
    } catch (e) {
      console.log(`  !! ${name} threw: ${(e && e.message) || e}`);
    }
  }
  console.log(`\n██ TOTAL across ${names.length} fixture(s): $${grand.toFixed(4)}\n`);
  if (DUMP) {
    fs.writeFileSync(DUMP, JSON.stringify(dumpRecords, null, 2), "utf8");
    const fails = dumpRecords.filter((r) => r.parseFail).length;
    console.log(`   dumped ${dumpRecords.length} checkpoint records -> ${DUMP}  (parse failures: ${fails})\n`);
  }
})().catch((e) => {
  console.error("EVAL THREW", (e && e.stack) || e);
  process.exit(1);
});
