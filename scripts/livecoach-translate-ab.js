"use strict";

// Offline A/B harness: lean regex (normalizeTaxTerms) vs the model ("make this
// make sense") on tax-call STT lines. Produces the evidence to decide whether the
// model earns a slot — extra fixes beyond regex, false-correction risk, WARM
// per-line latency, and WHICH provider handled each line. No live-floor risk; it
// just reads lines and runs the `liveCoach.translate` bus task.
//
// The translate task is OpenAI-first (cost-split) with Claude as failover, and is
// DEFAULT-OFF. To exercise real calls you must enable it AND supply a key:
//   AI_TASK_LIVECOACH_TRANSLATE_ENABLED=true \
//   OPENAI_API_KEY=...       # primary (the cost-split lane)
//   ANTHROPIC_API_KEY=...    # failover (set both to watch failover kick in)
//   node scripts/livecoach-translate-ab.js [path/to/transcript.ndjson]
//   (ndjson rows: {"text": "...", "role": "prospect"} — uses .text/.transcript/.finalText)
//
// With the task disabled or no key, every line FELL BACK to regex — that's the
// "set the env" signal, not a failure of the harness.
//
// Latency is measured WARM: a throwaway call warms the connection + prompt cache
// before timing, so the numbers reflect the real per-utterance floor, not cold start.

const fs = require("fs");
const { normalizeTaxTerms } = require("../packages/shared-services/src/liveCoachSanitizedPipeline");
const { createTranscriptTranslator, TRANSLATOR_TASK } = require("../packages/shared-services/src/liveCoachTranscriptTranslator");

const SAMPLE = [
  { role: "prospect", text: "i got an offer and compromise letter from the irs" },
  { role: "prospect", text: "they put a lean on my house last month" },
  { role: "prospect", text: "the see pee five oh four says final intent to levy" },
  { role: "rep", text: "we could look at an installment agreement or currently not collectible" },
  { role: "prospect", text: "i havent filed in like five years and i owe a bunch" },
  { role: "prospect", text: "they garnished my wages out of nowhere" },
  { role: "rep", text: "did you get a letter ten fifty eight from them" },
  { role: "rep", text: "i just need a power of attorney form twenty eight forty eight signed" },
  { role: "prospect", text: "its a trust fund recovery penalty on the nine forty one payroll" },
  { role: "prospect", text: "the f t b is also coming after me for state taxes" },
  { role: "rep", text: "so its offer in compromise versus partial pay installment basically" },
  { role: "prospect", text: "i think it was a cp fourteen or something like that" },
];

function loadLines(filePath) {
  if (!filePath) return SAMPLE;
  const rows = [];
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed);
      const text = row.text || row.transcript || row.finalText;
      if (text && String(text).trim()) rows.push({ role: row.role || row.speaker || "unknown", text: String(text) });
    } catch {
      /* skip non-JSON lines */
    }
  }
  return rows.length ? rows : SAMPLE;
}

function pct(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function main() {
  const lines = loadLines(process.argv[2]);
  const translator = createTranscriptTranslator();
  const enabled = String(process.env.AI_TASK_LIVECOACH_TRANSLATE_ENABLED || "").toLowerCase() === "true";
  console.log(`task: ${TRANSLATOR_TASK}  |  enabled: ${enabled}  |  lines: ${lines.length}`);
  console.log(`keys: OPENAI_API_KEY=${process.env.OPENAI_API_KEY ? "set" : "missing"}  ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY ? "set" : "missing"}\n`);

  // Warm the connection + prompt cache so timings reflect steady-state.
  process.stdout.write("warming… ");
  await translator.translate("we can set up an installment agreement", { role: "rep" });
  console.log("done\n");

  const latencies = [];
  let modelBeyondRegex = 0;
  let fallbacks = 0;
  const byProvider = {}; // provider -> count of lines it actually handled

  for (const row of lines) {
    const regex = normalizeTaxTerms(row.text);
    const result = await translator.translate(row.text, { role: row.role });
    if (result.usedModel && !result.fellBack) latencies.push(result.ms);
    if (result.fellBack) fallbacks += 1;
    if (result.provider) byProvider[result.provider] = (byProvider[result.provider] || 0) + 1;
    const beyond = result.text !== regex;
    if (beyond) modelBeyondRegex += 1;

    const who = result.fellBack ? "FELL BACK" : result.provider || (result.usedModel ? "model" : "regex-only");
    console.log(`[${row.role}] ${result.ms}ms  <${who}>${beyond ? "  *model changed beyond regex*" : ""}`);
    console.log(`  raw:   ${row.text}`);
    if (regex !== row.text) console.log(`  regex: ${regex}`);
    console.log(`  model: ${result.text}`);
    if (result.corrections && result.corrections.length) console.log(`  fixes: ${result.corrections.join(" | ")}`);
    console.log("");
  }

  const sorted = latencies.slice().sort((a, b) => a - b);
  const avg = sorted.length ? Math.round(sorted.reduce((s, x) => s + x, 0) / sorted.length) : 0;
  const providerTally = Object.keys(byProvider).length
    ? Object.entries(byProvider).map(([p, n]) => `${p}:${n}`).join("  ")
    : "none (all regex/fell back)";
  console.log("──────── summary ────────");
  console.log(`lines:                 ${lines.length}`);
  console.log(`handled by provider:   ${providerTally}  (OpenAI = cost-split lane; anthropic = failover fired)`);
  console.log(`model changed > regex: ${modelBeyondRegex}  (extra fixes the lean regex missed — eyeball these for FALSE corrections)`);
  console.log(`fell back (err/timeout/off): ${fallbacks}${fallbacks === lines.length ? "  ← all fell back: set AI_TASK_LIVECOACH_TRANSLATE_ENABLED=true + a key" : ""}`);
  console.log(`warm latency ms:       avg ${avg}  p50 ${pct(sorted, 50)}  p95 ${pct(sorted, 95)}  (target: sub-700ms)`);
}

main().catch((err) => {
  console.error("harness failed:", err && err.message ? err.message : err);
  process.exit(1);
});
