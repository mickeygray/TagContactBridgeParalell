"use strict";

// Prospect-only live coach harness.
//
// This deliberately removes RingEX/RingCX, STT, diarization, and semantic
// speaker splitting from the test loop. Type only what the prospect/client
// says; the coach responds with what the agent should say next.
//
// Examples:
//   node scripts/prospect-coach-repl.js
//   node scripts/prospect-coach-repl.js --model claude-sonnet-4-6
//   node scripts/prospect-coach-repl.js --provider openai --model gpt-5.4-mini --service-tier priority
//   node scripts/prospect-coach-repl.js --once "I got a CP504 and I am scared they will levy my bank"

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const readline = require("readline/promises");

require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const {
  createAnthropicClient,
} = require("../packages/shared-integrations/src/anthropicClient");

const DEFAULT_MODEL = process.env.LIVE_PROSPECT_COACH_MODEL
  || process.env.LIVE_CALL_MONITOR_COACH_MODEL
  || process.env.SALES_TRAINER_COACH_MODEL
  || "claude-sonnet-4-6";

const PHASE_KEYS = ["opening", "discovery", "pain", "qualification", "solution", "objection", "close", "wrap"];
const CLASSIFICATIONS = [
  "prospect_actionable",
  "prospect_low_signal",
  "system_or_noise",
];

function readFlag(argv, name, fallback = "") {
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const idx = argv.indexOf(name);
  if (idx >= 0 && idx < argv.length - 1) return argv[idx + 1];
  return fallback;
}

function hasFlag(argv, name) {
  return argv.includes(name);
}

function cleanText(value, maxLength = 6000) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(number, min), max);
}

function clampStringList(input, maxItems = 4, maxChars = 180) {
  return (Array.isArray(input) ? input : [])
    .map((item) => cleanText(item, maxChars))
    .filter(Boolean)
    .slice(0, maxItems);
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function extractOpenAiText(payload) {
  if (typeof payload?.output_text === "string") return payload.output_text;
  const blocks = [];
  for (const item of Array.isArray(payload?.output) ? payload.output : []) {
    for (const content of Array.isArray(item?.content) ? item.content : []) {
      if (typeof content?.text === "string") blocks.push(content.text);
      if (typeof content?.output_text === "string") blocks.push(content.output_text);
    }
  }
  return blocks.join("\n").trim();
}

function normalizeCoachResult(input = {}) {
  const phaseInput = input.phase && typeof input.phase === "object" ? input.phase : {};
  const phaseKey = PHASE_KEYS.includes(String(phaseInput.key || "").toLowerCase())
    ? String(phaseInput.key).toLowerCase()
    : "discovery";
  const classification = CLASSIFICATIONS.includes(String(input.classification || ""))
    ? String(input.classification)
    : cleanText(input.sayNext, 20)
      ? "prospect_actionable"
      : "prospect_low_signal";
  return {
    classification,
    confidence: clampNumber(input.confidence, 0, 1, 0.55),
    phase: {
      key: phaseKey,
      label: cleanText(phaseInput.label || phaseKey, 48),
      reason: cleanText(phaseInput.reason, 220),
    },
    sayNext: cleanText(input.sayNext, 360),
    coachingNote: cleanText(input.coachingNote, 260),
    why: cleanText(input.why, 260),
    followUpQuestion: cleanText(input.followUpQuestion, 220),
    riskFlags: clampStringList(input.riskFlags, 3, 160),
    knowledgeUsed: clampStringList(input.knowledgeUsed, 3, 160),
    updatedMemory: cleanText(input.updatedMemory, 1200),
  };
}

const PROSPECT_COACH_TOOL = {
  name: "submit_prospect_coach",
  description: "Return the next best agent response to a clean prospect/client speech turn.",
  input_schema: {
    type: "object",
    required: [
      "classification",
      "confidence",
      "phase",
      "sayNext",
      "coachingNote",
      "why",
      "followUpQuestion",
      "riskFlags",
      "knowledgeUsed",
      "updatedMemory",
    ],
    properties: {
      classification: { type: "string", enum: CLASSIFICATIONS },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      phase: {
        type: "object",
        required: ["key", "label", "reason"],
        properties: {
          key: { type: "string", enum: PHASE_KEYS },
          label: { type: "string" },
          reason: { type: "string" },
        },
      },
      sayNext: {
        type: "string",
        description: "The exact short line the agent should say next. Empty if the turn is low-signal/noise.",
      },
      coachingNote: { type: "string" },
      why: { type: "string" },
      followUpQuestion: { type: "string" },
      riskFlags: {
        type: "array",
        maxItems: 3,
        items: { type: "string" },
      },
      knowledgeUsed: {
        type: "array",
        maxItems: 3,
        items: { type: "string" },
      },
      updatedMemory: {
        type: "string",
        description: "Compact rolling memory of client facts, tax issue, notices, risk, and next thread.",
      },
    },
  },
};

function buildCoachPrompt({ prospectText, memory, turns, mode = "balanced" }) {
  const recent = turns
    .slice(-10)
    .map((turn, index) => [
      `${index + 1}. Prospect: ${turn.prospect}`,
      turn.sayNext ? `   Agent suggestion: ${turn.sayNext}` : "",
    ].filter(Boolean).join("\n"))
    .join("\n");
  return [
    "You are a real-time sales coach for a tax-resolution consultation.",
    "Assume the newest transcript is ONLY the prospect/client speaking. There is no need to identify the speaker.",
    "Your job is to tell the agent exactly what to say next, fast.",
    "",
    "Style rules:",
    "- One short, agent-sayable response, usually 1-2 sentences.",
    "- Be specific to what the prospect just said. Avoid generic cheerleading.",
    "- Prefer calm discovery and clarification before pitching.",
    "- Keep the agent compliant: no guarantees, no exact tax/legal advice, no exact program fit, no fees or timelines.",
    "- If the prospect mentions a levy, garnishment, final notice, LT11/1058, CP504, revenue officer, or bank issue, acknowledge urgency and ask the next fact needed.",
    "- If the prospect mentions unfiled returns, steer to compliance: years missing, income type, and whether IRS filed substitutes.",
    "- If the prospect mentions balance due, ask tax type, years, notice/source, and whether they can afford payments.",
    "- If the prospect mentions fear/confusion, validate briefly, then ask one useful question.",
    "- If the newest input is just filler, noise, or too little to act on, leave sayNext empty and set classification=prospect_low_signal.",
    "",
    "Tax knowledge anchors:",
    "- Collection risk escalates around CP504, LT11/Letter 1058, levy, lien, garnishment, bank levy, and revenue officer contact.",
    "- Resolution paths often depend on compliance, financials, tax years, income, assets, deadlines, and ability to pay.",
    "- Common paths include installment agreement, penalty abatement, currently not collectible, offer in compromise, lien/levy release work, and filing missing returns, but do not promise fit.",
    "",
    `Mode: ${mode}`,
    "",
    "Rolling memory:",
    memory || "(none yet)",
    "",
    "Recent test turns:",
    recent || "(none yet)",
    "",
    "Newest prospect/client turn:",
    prospectText,
  ].join("\n");
}

async function callAnthropicCoach({ prompt, model, timeoutMs }) {
  const client = createAnthropicClient();
  const raw = await client.createMessage({
    system: "Output strictly via submit_prospect_coach. No free text.",
    messages: [{ role: "user", content: prompt }],
    model,
    maxTokens: 650,
    temperature: 0.15,
    tools: [PROSPECT_COACH_TOOL],
    toolChoice: { type: "tool", name: "submit_prospect_coach" },
    timeoutMs,
  });
  const toolUse = client.extractToolUse(raw, "submit_prospect_coach");
  if (!toolUse?.input) throw new Error("Claude did not return submit_prospect_coach");
  return {
    ...normalizeCoachResult(toolUse.input),
    provider: "anthropic",
    model: raw?.model || model,
    usage: raw?.usage || null,
  };
}

async function callOpenAiCoach({ prompt, model, serviceTier, timeoutMs }) {
  const apiKey = process.env.OPENAI_API_KEY || "";
  if (!apiKey) throw new Error("OPENAI_API_KEY is missing");
  const abortController = new AbortController();
  const timeoutHandle = setTimeout(() => abortController.abort(), Math.max(timeoutMs, 1000));
  let response;
  try {
    response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        ...(serviceTier ? { service_tier: serviceTier } : {}),
        instructions: [
          "Return only JSON. No markdown.",
          "Shape: { classification, confidence, phase:{key,label,reason}, sayNext, coachingNote, why, followUpQuestion, riskFlags, knowledgeUsed, updatedMemory }.",
          `classification must be one of: ${CLASSIFICATIONS.join(", ")}.`,
          `phase.key must be one of: ${PHASE_KEYS.join(", ")}.`,
        ].join(" "),
        input: [{ role: "user", content: prompt }],
        max_output_tokens: 650,
      }),
      signal: abortController.signal,
    });
  } finally {
    clearTimeout(timeoutHandle);
  }
  const rawText = await response.text();
  const payload = safeJsonParse(rawText) || {};
  if (!response.ok) {
    throw new Error(`OpenAI coach failed: ${response.status} ${rawText.slice(0, 300)}`);
  }
  const outputText = extractOpenAiText(payload);
  const parsed = safeJsonParse(outputText);
  if (!parsed) {
    throw new Error(`OpenAI coach returned non-JSON: ${outputText.slice(0, 300)}`);
  }
  return {
    ...normalizeCoachResult(parsed),
    provider: "openai",
    model: payload?.model || model,
    serviceTier: serviceTier || null,
    usage: payload?.usage || null,
  };
}

function printHelp() {
  console.log(`Prospect-only coach REPL

Usage:
  node scripts/prospect-coach-repl.js [options]

Options:
  --provider anthropic        anthropic | openai
  --model MODEL               default: ${DEFAULT_MODEL}
  --service-tier priority     OpenAI only
  --mode balanced             balanced | fast | strict
  --timeout-ms 12000
  --once "prospect text"      Run one turn and exit
  --no-log                    Do not write runtime NDJSON

Commands in REPL:
  .reset   clear memory/history
  .memory  show rolling memory
  .quit    exit
`);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJsonLine(file, event) {
  fs.appendFileSync(file, `${JSON.stringify(event)}\n`);
}

function printResult(result, elapsedMs) {
  const confidence = Math.round((result.confidence || 0) * 100);
  console.log("");
  console.log(`[${(elapsedMs / 1000).toFixed(2)}s ${result.provider}:${result.model}] ${result.classification} ${confidence}%`);
  if (result.sayNext) {
    console.log(`Say: ${result.sayNext}`);
  } else {
    console.log("Say: (wait)");
  }
  if (result.coachingNote) console.log(`Note: ${result.coachingNote}`);
  if (result.followUpQuestion) console.log(`Question thread: ${result.followUpQuestion}`);
  if (result.knowledgeUsed.length) console.log(`Used: ${result.knowledgeUsed.join(" | ")}`);
  if (result.riskFlags.length) console.log(`Risk: ${result.riskFlags.join(" | ")}`);
  console.log("");
}

async function runTurn({ prospectText, state, provider, model, serviceTier, timeoutMs, mode, logFile }) {
  const clean = cleanText(prospectText, 1600);
  if (!clean) return null;
  const prompt = buildCoachPrompt({
    prospectText: clean,
    memory: state.memory,
    turns: state.turns,
    mode,
  });
  const started = Date.now();
  const result = provider === "openai"
    ? await callOpenAiCoach({ prompt, model, serviceTier, timeoutMs })
    : await callAnthropicCoach({ prompt, model, timeoutMs });
  const elapsedMs = Date.now() - started;
  if (result.updatedMemory) state.memory = result.updatedMemory;
  state.turns.push({
    at: new Date().toISOString(),
    prospect: clean,
    sayNext: result.sayNext,
    classification: result.classification,
    confidence: result.confidence,
  });
  if (state.turns.length > 40) state.turns.splice(0, state.turns.length - 40);
  const event = {
    at: new Date().toISOString(),
    elapsedMs,
    prospect: clean,
    result,
    memory: state.memory,
  };
  if (logFile) writeJsonLine(logFile, event);
  printResult(result, elapsedMs);
  return event;
}

async function main() {
  const argv = process.argv.slice(2);
  if (hasFlag(argv, "--help") || hasFlag(argv, "-h")) {
    printHelp();
    return;
  }

  const provider = String(readFlag(argv, "--provider", process.env.LIVE_PROSPECT_COACH_PROVIDER || "anthropic")).toLowerCase();
  if (!["anthropic", "openai"].includes(provider)) throw new Error("--provider must be anthropic or openai");
  const model = readFlag(
    argv,
    "--model",
    provider === "openai"
      ? process.env.LIVE_PROSPECT_COACH_OPENAI_MODEL || "gpt-5.4-mini"
      : DEFAULT_MODEL,
  );
  const serviceTier = readFlag(argv, "--service-tier", process.env.LIVE_PROSPECT_COACH_SERVICE_TIER || "");
  const mode = readFlag(argv, "--mode", process.env.LIVE_PROSPECT_COACH_MODE || "balanced");
  const timeoutMs = Math.max(1000, Number(readFlag(argv, "--timeout-ms", process.env.LIVE_PROSPECT_COACH_TIMEOUT_MS || "12000")) || 12000);
  const once = readFlag(argv, "--once", "");
  const logEnabled = !hasFlag(argv, "--no-log");
  const state = {
    memory: "",
    turns: [],
  };

  const runId = `prospect-coach-${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomBytes(3).toString("hex")}`;
  const logDir = path.resolve("runtime", "prospect-coach-repl");
  const logFile = logEnabled ? path.join(logDir, `${runId}.ndjson`) : "";
  if (logFile) ensureDir(logDir);

  console.log(`Prospect-only coach ready (${provider}:${model}${serviceTier ? ` tier=${serviceTier}` : ""}).`);
  console.log("Type only what the prospect says. Commands: .reset .memory .quit");
  if (logFile) console.log(`Log: ${logFile}`);
  console.log("");

  if (once) {
    await runTurn({ prospectText: once, state, provider, model, serviceTier, timeoutMs, mode, logFile });
    return;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });
  try {
    for (;;) {
      const line = await rl.question("Prospect> ");
      const clean = cleanText(line, 2000);
      if (!clean) continue;
      if ([".q", ".quit", "quit", "exit"].includes(clean.toLowerCase())) break;
      if (clean.toLowerCase() === ".reset") {
        state.memory = "";
        state.turns = [];
        console.log("Memory/history cleared.\n");
        continue;
      }
      if (clean.toLowerCase() === ".memory") {
        console.log(state.memory || "(empty)");
        console.log("");
        continue;
      }
      await runTurn({ prospectText: clean, state, provider, model, serviceTier, timeoutMs, mode, logFile });
    }
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  console.error(`fatal: ${error.message}`);
  process.exit(1);
});
