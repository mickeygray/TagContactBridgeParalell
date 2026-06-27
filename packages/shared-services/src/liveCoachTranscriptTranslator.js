"use strict";

// Live-coach transcript translator — "make this STT line make sense".
//
// Two layers, in order:
//   1. LEAN regex fast-path (normalizeTaxTerms) — <10ms, deterministic, catches
//      the known canonical tax terms (CP###, IRS, 1099, ...). Kept intentionally
//      small; the model handles everything regex shouldn't grow to cover.
//   2. Model cleanup via the AI bus task `liveCoach.translate` — provider-NEUTRAL:
//      OpenAI-first (cheap, splits cost off the Claude budget), Claude as the
//      automatic failover. Pin/flip with AI_TASK_LIVECOACH_TRANSLATE_PROVIDER.
//
// FAIL-OPEN by construction: timeout / error / task-disabled / bad output -> the
// regex-normalized text. The caller must never block guidance on this; run it
// async (correct-the-record), not in the synchronous compose path.
//
// The runner is injectable so this tests with zero network.

const { env } = require("../../shared-config/src");
const { createAnthropicClient, createOpenAiClient } = require("../../shared-integrations/src");
const { createAiProviders } = require("./aiProviders");
const { createAiTaskRunner } = require("./aiTaskRunner");
const { normalizeTaxTerms } = require("./liveCoachSanitizedPipeline");

const TRANSLATOR_TASK = "liveCoach.translate";
const TRANSLATOR_TIMEOUT_MS = Number(env("LIVECOACH_TRANSLATOR_TIMEOUT_MS", 700));
const MIN_WORDS_FOR_MODEL = 2;

// The structured output the model returns (Anthropic tool input_schema / OpenAI
// json target — the runner adapts per provider).
const CLEAN_SCHEMA = {
  type: "object",
  properties: {
    text: {
      type: "string",
      description:
        "The corrected line. Same speaker, same meaning, similar length — only mis-heard words fixed. If it already reads fine, return it unchanged.",
    },
    changed: { type: "boolean", description: "True only if you actually changed a word." },
    corrections: {
      type: "array",
      items: { type: "string" },
      description: "Each fix as 'heard -> meant'. Empty when nothing changed.",
    },
  },
  required: ["text", "changed", "corrections"],
};

const SYSTEM_PROMPT = [
  "You clean live speech-to-text from a tax-resolution sales call (a tax-relief firm; rep + prospect).",
  "Your ONLY job: fix obvious speech-recognition errors so the line reads as the speaker actually meant it.",
  "",
  "Fix, in priority order:",
  "  1. Mis-heard TAX terms. Examples: 'offer and compromise'/'offer of compromise' -> 'Offer in Compromise'; 'lean'/'leen' -> 'lien'; 'see pee five oh one' -> 'CP501'; 'letter ten fifty eight' -> 'Letter 1058'; 'currently not collectible'; 'trust fund recovery'; 'installment agreement'; 'wage garnishment'; 'Form 433'/'433-A'; 'power of attorney'/'2848'; 'levy'; 'substitute for return'; 'FTB'/'EDD'.",
  "  2. Obvious homophone / word-boundary / filler garble that makes the sentence incoherent.",
  "",
  "Hard rules:",
  "  - Recognition-fixing ONLY. Do NOT rephrase, summarize, answer, translate, add, or remove meaning.",
  "  - Same sentence: same speaker, same intent, similar length.",
  "  - When unsure, LEAVE THE WORD AS-IS. Never invent a tax term that wasn't plausibly spoken. A wrong 'correction' is worse than leaving it.",
  "  - If the line already reads fine, return it unchanged with changed=false.",
  "  - Return only the structured result.",
].join("\n");

function wordCount(text) {
  return String(text || "").split(/\s+/).filter(Boolean).length;
}

function buildUserBlock(text, opts = {}) {
  const lines = [];
  const recent = String(opts.recentContext || "").trim();
  if (recent) lines.push(`Prior line (context only — do NOT clean or echo it): ${recent}`);
  lines.push(`Speaker: ${opts.role || "unknown"}`);
  lines.push("Clean this line:");
  lines.push(String(text || ""));
  return lines.join("\n");
}

// Lazy default in-process runner wired with BOTH providers, so failover works
// (OpenAI -> Claude) without an HTTP hop to the bus service.
let _runner = null;
function defaultRunner() {
  if (_runner) return _runner;
  const providers = createAiProviders({ anthropic: createAnthropicClient(), openai: createOpenAiClient() });
  _runner = createAiTaskRunner({ providers });
  return _runner;
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`translator-timeout-${ms}ms`)), Math.max(Number(ms) || 0, 1));
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function fallback(fast, raw, started, extra = {}) {
  return { text: fast, changed: fast !== raw, corrections: [], usedModel: true, fellBack: true, ms: Date.now() - started, ...extra };
}

function createTranscriptTranslator(deps = {}) {
  const runner = deps.runner || defaultRunner();
  const timeoutMs = deps.timeoutMs || TRANSLATOR_TIMEOUT_MS;
  const runOptions = { label: "livecoach.translate", ...(deps.runOptions || {}) };

  // Translate one transcript line. Always resolves (never throws) — on any
  // failure it returns the deterministic regex text so the caller proceeds.
  async function translate(rawText, opts = {}) {
    const started = Date.now();
    const raw = String(rawText || "");
    const fast = normalizeTaxTerms(raw); // lean regex fast-path FIRST

    // Too short to be worth a model round-trip ("yeah", "okay", "mm-hm").
    if (wordCount(fast) < MIN_WORDS_FOR_MODEL) {
      return { text: fast, changed: fast !== raw, corrections: [], usedModel: false, fellBack: false, ms: Date.now() - started };
    }

    const payload = { system: SYSTEM_PROMPT, user: buildUserBlock(fast, opts), schema: CLEAN_SCHEMA };
    let res;
    try {
      res = await withTimeout(runner.runAiTask(TRANSLATOR_TASK, payload, runOptions), timeoutMs);
    } catch (error) {
      return fallback(fast, raw, started, { error: String(error && error.message ? error.message : error) });
    }

    const result = res && res.result;
    if (!res || res.ok === false || !result || typeof result.text !== "string" || !result.text.trim()) {
      return fallback(fast, raw, started, { provider: res && res.provider, code: res && res.code });
    }

    const out = String(result.text).trim();
    return {
      text: out,
      changed: Boolean(result.changed) && out !== fast,
      corrections: Array.isArray(result.corrections) ? result.corrections.map((c) => String(c)).slice(0, 12) : [],
      provider: res.provider || null,
      model: res.model || null,
      usedModel: true,
      fellBack: false,
      ms: Date.now() - started,
    };
  }

  return { translate };
}

module.exports = {
  createTranscriptTranslator,
  buildUserBlock,
  CLEAN_SCHEMA,
  SYSTEM_PROMPT,
  TRANSLATOR_TASK,
};
