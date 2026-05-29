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
const PROSPECT_COACH_BASE_SECTIONS = [
  "Output Contract",
  "Call Philosophy",
  "Universal Coaching Formula",
  "Human Tone and Emotional Listening",
  "Hard Guardrails",
];
const PROSPECT_COACH_SALES_SECTION_KEYWORDS = [
  {
    title: "Opening and Legitimacy",
    keywords: ["who are you", "why are you calling", "scam", "irs", "sales call", "not interested", "busy", "public records", "company", "legit", "legitimate"],
  },
  {
    title: "Discovery and Pain",
    keywords: ["owe", "owed", "balance", "federal", "state", "filed", "unfiled", "years", "letter", "notice", "payment plan", "accountant", "tax firm", "stress", "affecting"],
  },
  {
    title: "Notice and Enforcement Framing",
    keywords: ["cp501", "cp503", "cp504", "lt11", "1058", "levy", "bank levy", "garnish", "garnishment", "lien", "revenue officer", "final notice", "take money", "freeze", "paycheck", "collections"],
  },
  {
    title: "Expert Guidance",
    keywords: ["what does", "what means", "options", "program", "qualify", "settlement", "compromise", "hardship", "penalty", "help me understand", "can you tell me"],
  },
  {
    title: "Representation Pitch",
    keywords: ["represent", "representation", "attorney", "poa", "power of attorney", "transcript", "authorization", "form 2848", "8821", "start", "next step", "protect"],
  },
  {
    title: "Financial Snapshot and Qualification",
    keywords: ["income", "job", "work", "self-employed", "expense", "rent", "mortgage", "car", "childcare", "asset", "bank account", "retirement", "home", "property", "afford"],
  },
  {
    title: "Closing and Payment Terms",
    keywords: ["cost", "fee", "price", "pay", "payment", "card", "credit card", "debit", "expensive", "high", "spouse", "think about", "monthly", "today"],
  },
  {
    title: "Information Collection",
    keywords: ["ssn", "social security", "date of birth", "dob", "address", "email", "phone", "docusign", "documents", "sign"],
  },
  {
    title: "Objection Patterns",
    keywords: ["not interested", "busy", "scam", "already", "fixed", "taken care", "spouse", "think", "card", "expensive", "how did you get", "bad experience"],
  },
];
const PROSPECT_COACH_TAX_KNOWLEDGE_KEYWORDS = [
  {
    title: "Tax Knowledge: 1099 and Self-Employment",
    keywords: ["1099", "1099-nec", "contractor", "independent contractor", "self-employed", "self employment", "gig", "uber", "doordash", "schedule c", "schedule se", "estimated tax", "quarterly", "no withholding"],
  },
  {
    title: "Tax Knowledge: Payroll and Business Taxes",
    keywords: ["payroll", "941", "940", "employment tax", "trust fund", "tfrp", "responsible person", "employee withholding", "withholding", "fica", "medicare", "business tax", "employees"],
  },
  {
    title: "Tax Knowledge: State, Local, and Mixed Balances",
    keywords: ["state tax", "state", "ftb", "edd", "sales tax", "franchise tax", "unemployment tax", "state garnishment", "state lien", "both federal and state", "california"],
  },
  {
    title: "Tax Knowledge: Audits, Exams, and Adjustments",
    keywords: ["audit", "audited", "exam", "examination", "cp2000", "underreporter", "missing income", "adjustment", "proposed assessment", "receipts", "documentation"],
  },
  {
    title: "Tax Knowledge: Penalties, Interest, and Amendments",
    keywords: ["penalty", "penalties", "interest", "abatement", "first time abatement", "reasonable cause", "amended", "amend", "amendment", "wrong return", "mistake"],
  },
  {
    title: "Tax Knowledge: Joint, Spouse, and Identity Issues",
    keywords: ["spouse", "ex spouse", "ex-spouse", "divorce", "joint", "jointly", "innocent spouse", "injured spouse", "identity theft", "stolen identity", "ssn", "social security"],
  },
  {
    title: "Tax Knowledge: Unfiled Returns and Substitute Returns",
    keywords: ["unfiled", "haven't filed", "hasn't filed", "didn't file", "missing return", "sfr", "substitute for return", "w-2", "w2", "old returns", "wage and income"],
  },
  {
    title: "Tax Knowledge: Collection and Resolution Paths",
    keywords: ["payment plan", "installment", "installment agreement", "offer in compromise", "oic", "settle", "settlement", "currently not collectible", "cnc", "hardship", "levy release", "lien release", "garnishment", "bank levy"],
  },
];
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

function readOptionalTextFile(filePath, maxChars = 12000) {
  const raw = String(filePath || "").trim();
  if (!raw) return "";
  const absolute = path.resolve(raw);
  if (!fs.existsSync(absolute)) return "";
  return fs.readFileSync(absolute, "utf8")
    .replace(/\r\n/g, "\n")
    .trim()
    .slice(0, maxChars);
}

function normalizePlaybookHeading(value) {
  return cleanText(String(value || "").replace(/^#+\s*/, ""), 120);
}

function parseProspectCoachPlaybook(playbookText) {
  const text = String(playbookText || "").replace(/\r\n/g, "\n");
  const sections = [];
  let current = null;
  for (const line of text.split("\n")) {
    const match = line.match(/^#{2,3}\s+(.+?)\s*$/);
    if (match) {
      if (current && current.body.join("\n").trim()) {
        sections.push({
          title: current.title,
          body: current.body.join("\n").trim(),
        });
      }
      current = { title: normalizePlaybookHeading(match[1]), body: [] };
    } else if (current) {
      current.body.push(line);
    }
  }
  if (current && current.body.join("\n").trim()) {
    sections.push({
      title: current.title,
      body: current.body.join("\n").trim(),
    });
  }
  return sections;
}

function countKeywordHits(text, keywords = []) {
  const haystack = String(text || "").toLowerCase();
  let score = 0;
  for (const keyword of keywords) {
    const needle = String(keyword || "").trim().toLowerCase();
    if (!needle) continue;
    let index = haystack.indexOf(needle);
    while (index >= 0) {
      score += needle.includes(" ") ? 3 : 1;
      index = haystack.indexOf(needle, index + needle.length);
    }
  }
  return score;
}

function scoreProspectCoachRoutes(routes, routeText, byTitle) {
  return routes
    .map((route) => ({
      title: route.title,
      score: countKeywordHits(routeText, route.keywords),
    }))
    .filter((row) => row.score > 0 && byTitle.has(row.title))
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
}

function classifyTaxJurisdiction({ prospectText, memory = "" } = {}) {
  const prospectMemory = String(memory || "")
    .split("\n")
    .filter((line) => /^Prospect:/i.test(line.trim()))
    .join("\n");
  const text = `${prospectText || ""}\n${prospectMemory}`.toLowerCase();
  const hasState = [
    /\bstate\s+(tax|balance|notice|debt|agency|levy|lien|garnish|garnishment|collections?)\b/,
    /\bstate\b.{0,30}\b(tax|balance|notice|debt|agency|levy|lien|garnish|garnishing|garnishment|collect|collection|owe|owed)\b/,
    /\b(ftb|edd|cdtfa)\b/,
    /franchise tax board/,
    /employment development department/,
    /\bsales tax\b/,
    /\bstate payroll\b/,
    /\bunemployment tax\b/,
    /\bcalifornia\b/,
  ].some((pattern) => pattern.test(text));
  const hasExplicitIrs = [
    /\birs\b/,
    /\bfederal\b/,
    /\bcp\s*(?:50\d|2000)\b/,
    /\blt\s*11\b/,
    /\bletter\s*1058\b/,
    /\bform\s*(?:1040|941|940|2848|8821)\b/,
    /\b1099\b/,
    /\bw-?2\b/,
    /\bsfr\b/,
    /substitute for return/,
    /trust fund/,
    /revenue officer/,
  ].some((pattern) => pattern.test(text));
  const hasTaxishDefault = [
    /\btax(?:es)?\b/,
    /\bbalance\b/,
    /\bowe\b/,
    /\bhaven'?t\s+filed\b/,
    /\bhasn'?t\s+filed\b/,
    /\bdidn'?t\s+file\b/,
    /\bnot\s+filed\b/,
    /\bmissing\s+(?:returns?|years?)\b/,
    /\bfiled?\s+(?:late|missing)\b/,
    /\bunfiled\b/,
    /\blevy\b/,
    /\blien\b/,
    /\bgarnish(?:ing|ment)?\b/,
    /\bwage\b/,
    /\bpaycheck\b/,
    /\bmoney\s+(?:is\s+)?(?:being\s+)?taken\b/,
    /\bcollections?\b/,
    /\bpayroll\b/,
    /\bpenalt(?:y|ies)\b/,
    /\binterest\b/,
  ].some((pattern) => pattern.test(text));
  const hasOnlyVagueAgencySignal = !hasExplicitIrs && !hasState && [
    /\bnotice\b/,
    /\bletter\b/,
    /\bthey\b/,
    /\bgovernment\b/,
    /\bcollections?\b/,
  ].some((pattern) => pattern.test(text));

  if (hasState && hasExplicitIrs) {
    return { value: "mixed", confidence: "high", reason: "clear IRS/federal and state signals" };
  }
  if (hasState) {
    return { value: "state", confidence: "high", reason: "clear state agency or state tax signal" };
  }
  if (hasExplicitIrs) {
    return { value: "irs", confidence: "high", reason: "clear IRS/federal notice or form signal" };
  }
  if (hasOnlyVagueAgencySignal) {
    return { value: "ambiguous", confidence: "vague", reason: "agency language is vague" };
  }
  if (hasTaxishDefault) {
    return { value: "irs", confidence: "default", reason: "tax issue with no clear state signal" };
  }
  return { value: "ambiguous", confidence: "low", reason: "no clear agency or tax signal" };
}

function selectProspectCoachPlaybookContext({
  playbookText,
  prospectText,
  memory = "",
  maxChars = 7000,
} = {}) {
  const text = String(playbookText || "").trim();
  const limit = Math.max(1000, Number(maxChars) || 7000);
  const sections = parseProspectCoachPlaybook(text);
  if (!sections.length) {
    return {
      context: text.slice(0, limit),
      sections: text ? ["full-playbook"] : [],
    };
  }

  const byTitle = new Map(sections.map((section) => [section.title, section]));
  const selected = [];
  const selectedTitles = new Set();
  const pushTitle = (title) => {
    const section = byTitle.get(title);
    if (!section || selectedTitles.has(title)) return;
    selected.push(section);
    selectedTitles.add(title);
  };

  for (const title of PROSPECT_COACH_BASE_SECTIONS) pushTitle(title);

  const prospectMemory = String(memory || "")
    .split("\n")
    .filter((line) => /^Prospect:/i.test(line.trim()))
    .join("\n");
  const salesRouteText = `${prospectText || ""}\n${memory || ""}`;
  const taxRouteText = `${prospectText || ""}\n${prospectMemory}`;
  const salesScored = scoreProspectCoachRoutes(PROSPECT_COACH_SALES_SECTION_KEYWORDS, salesRouteText, byTitle);
  const taxScored = scoreProspectCoachRoutes(PROSPECT_COACH_TAX_KNOWLEDGE_KEYWORDS, taxRouteText, byTitle);

  if (!salesScored.length) {
    pushTitle("Discovery and Pain");
    pushTitle("Expert Guidance");
  } else {
    for (const row of salesScored.slice(0, 4)) pushTitle(row.title);
    if (
      !selectedTitles.has("Objection Patterns")
      && /think|spouse|scam|busy|not interested|already|card|fee|cost|expensive/i.test(salesRouteText)
    ) {
      pushTitle("Objection Patterns");
    }
  }
  for (const row of taxScored.slice(0, 4)) pushTitle(row.title);

  const parts = [];
  for (const section of selected) {
    const block = `## ${section.title}\n${section.body}`.trim();
    if (parts.join("\n\n").length + block.length > limit && parts.length > 0) break;
    parts.push(block);
  }
  return {
    context: parts.join("\n\n"),
    sections: selected.map((section) => section.title),
    salesSections: salesScored.slice(0, 4).map((row) => row.title),
    taxSections: taxScored.slice(0, 4).map((row) => row.title),
  };
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

function buildCoachPrompt({ prospectText, memory, turns, mode = "balanced", playbook = "", taxJurisdiction }) {
  const recent = turns
    .slice(-10)
    .map((turn, index) => [
      `${index + 1}. Prospect: ${turn.prospect}`,
      turn.sayNext ? `   Agent suggestion: ${turn.sayNext}` : "",
    ].filter(Boolean).join("\n"))
    .join("\n");
  const jurisdiction = taxJurisdiction || { value: "ambiguous", confidence: "low", reason: "" };
  return [
    "You are a real-time sales coach for a tax-resolution consultation.",
    "Assume the newest transcript is ONLY the prospect/client speaking. There is no need to identify the speaker.",
    "Your job is to tell the agent exactly what to say next, fast.",
    "",
    "Style rules:",
    "- One short, agent-sayable response, usually 1-2 sentences.",
    "- Be specific to what the prospect just said. Avoid generic cheerleading.",
    "- Sound human, not like a form response.",
    "- If the prospect mentions fear, family, paycheck, business pressure, shame, confusion, or a bad prior experience, briefly acknowledge the human impact before the tactical question.",
    "- Vary acknowledgements; do not mechanically start every answer with 'I understand' or 'That makes sense'.",
    "- Prefer calm discovery and clarification before pitching.",
    "- Keep the agent compliant: no guarantees, no exact tax/legal advice, no exact program fit, no fees or timelines.",
    "- If the prospect mentions a levy, garnishment, final notice, LT11/1058, CP504, revenue officer, or bank issue, acknowledge urgency and ask the next fact needed.",
    "- If the prospect mentions unfiled returns, steer to compliance: years missing, income type, and whether IRS filed substitutes.",
    "- If the prospect mentions balance due, ask tax type, years, notice/source, and whether they can afford payments.",
    "- If the prospect mentions fear/confusion, validate briefly, then ask one useful question.",
    "- Do not wait solely because the newest input is a sentence fragment. If it contains a tax issue, fear, objection, or useful fact, provide a short bridge response or question.",
    "- If the newest input is just filler, noise, or a fragment with no usable intent, leave sayNext empty and set classification=prospect_low_signal.",
    "- Follow the local tax jurisdiction exactly. If jurisdiction=irs, do not ask whether it is IRS/state/both unless the prospect's agency language is genuinely vague; ask the next IRS-specific fact. If jurisdiction=state, briefly acknowledge state, then screen for broader IRS/federal symptoms such as IRS balance, federal notices, unfiled years, 1099/self-employment, payroll/941, or missing returns. If jurisdiction=mixed, split IRS and state facts. If jurisdiction=ambiguous or agency language is only 'they/the government/collections/a letter', ask: 'Is this coming from the IRS or the state?'",
    "",
    "Tax knowledge anchors:",
    "- Collection risk escalates around CP504, LT11/Letter 1058, levy, lien, garnishment, bank levy, and revenue officer contact.",
    "- Resolution paths often depend on compliance, financials, tax years, income, assets, deadlines, and ability to pay.",
    "- Common paths include installment agreement, penalty abatement, currently not collectible, offer in compromise, lien/levy release work, and filing missing returns, but do not promise fit.",
    "",
    "Focused sales and tax reference context:",
    playbook || "(none)",
    "",
    `Local tax jurisdiction: ${jurisdiction.value} (${jurisdiction.confidence}${jurisdiction.reason ? `; ${jurisdiction.reason}` : ""})`,
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
  --playbook-file PATH        Static prompt block
  --playbook-max-chars 7000   Max focused playbook context per coach call
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
  if (result.taxJurisdiction) {
    console.log(`Jurisdiction: ${result.taxJurisdiction} (${result.taxJurisdictionConfidence || "unknown"})`);
  }
  if (Array.isArray(result.playbookSections) && result.playbookSections.length) {
    console.log(`Sections: ${result.playbookSections.join(" | ")}`);
  }
  if (Array.isArray(result.taxKnowledgeSections) && result.taxKnowledgeSections.length) {
    console.log(`Tax KB: ${result.taxKnowledgeSections.join(" | ")}`);
  }
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

async function runTurn({ prospectText, state, provider, model, serviceTier, timeoutMs, mode, playbook, playbookMaxChars, logFile }) {
  const clean = cleanText(prospectText, 1600);
  if (!clean) return null;
  const playbookSelection = selectProspectCoachPlaybookContext({
    playbookText: playbook,
    prospectText: clean,
    memory: state.memory,
    maxChars: playbookMaxChars,
  });
  const taxJurisdiction = classifyTaxJurisdiction({
    prospectText: clean,
    memory: state.memory,
  });
  const prompt = buildCoachPrompt({
    prospectText: clean,
    memory: state.memory,
    turns: state.turns,
    mode,
    playbook: playbookSelection.context,
    taxJurisdiction,
  });
  const started = Date.now();
  const result = provider === "openai"
    ? await callOpenAiCoach({ prompt, model, serviceTier, timeoutMs })
    : await callAnthropicCoach({ prompt, model, timeoutMs });
  const elapsedMs = Date.now() - started;
  result.playbookSections = playbookSelection.sections;
  result.salesSections = playbookSelection.salesSections;
  result.taxKnowledgeSections = playbookSelection.taxSections;
  result.taxJurisdiction = taxJurisdiction.value;
  result.taxJurisdictionConfidence = taxJurisdiction.confidence;
  result.taxJurisdictionReason = taxJurisdiction.reason;
  result.playbookChars = playbookSelection.context.length;
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
    playbookSections: playbookSelection.sections,
    salesSections: playbookSelection.salesSections,
    taxKnowledgeSections: playbookSelection.taxSections,
    taxJurisdiction,
    playbookChars: playbookSelection.context.length,
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
  const playbookFile = readFlag(argv, "--playbook-file", process.env.LIVE_PROSPECT_COACH_PLAYBOOK_FILE || path.join("docs", "LIVE_PROSPECT_COACH_PLAYBOOK.md"));
  const playbook = readOptionalTextFile(playbookFile, 32000);
  const playbookMaxChars = Math.max(
    2000,
    Number(readFlag(argv, "--playbook-max-chars", process.env.LIVE_PROSPECT_COACH_PLAYBOOK_MAX_CHARS || "7000")) || 7000,
  );
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
  console.log(`Playbook: ${playbook ? `${path.resolve(playbookFile)} (${playbook.length} chars, focused<=${playbookMaxChars})` : "off"}`);
  console.log("Type only what the prospect says. Commands: .reset .memory .quit");
  if (logFile) console.log(`Log: ${logFile}`);
  console.log("");

  if (once) {
    await runTurn({ prospectText: once, state, provider, model, serviceTier, timeoutMs, mode, playbook, playbookMaxChars, logFile });
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
      await runTurn({ prospectText: clean, state, provider, model, serviceTier, timeoutMs, mode, playbook, playbookMaxChars, logFile });
    }
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  console.error(`fatal: ${error.message}`);
  process.exit(1);
});
