"use strict";

// One-off RingEX live monitor -> transcript -> agent advice bridge.
//
// This intentionally runs outside the main Parallel/NSSM stack so we can
// iterate without restarting nginx, ngrok, control-plane, or live dialer
// services. It registers the AI Monitor RingEX device as a headless
// softphone, optionally asks RingEX supervision to listen to an agent's
// active call, chunks incoming PCMU/8000 audio, transcribes each chunk with
// the trainer STT path, and asks Claude for compact live advice.
//
// Examples:
//   node scripts/rc-ex-live-trainer-oneoff.js --supervisor-ext 987
//   node scripts/rc-ex-live-trainer-oneoff.js --supervise --agent-ext 101 --supervisor-ext 987
//   node scripts/rc-ex-live-trainer-oneoff.js --supervise --agent-ext 101 --session-id sales-trainer:demo
//
// Local dashboard:
//   http://127.0.0.1:7331/
//
// Optional public dashboard for a short test window:
//   ngrok http 7331

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");

require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const Softphone = require("ringcentral-softphone");
const {
  transcribeSalesTrainerAudio,
} = require("../packages/shared-services/src/taxResolutionSalesTrainerService");
const {
  createAnthropicClient,
} = require("../packages/shared-integrations/src/anthropicClient");
const {
  createRingcxVoiceClient,
} = require("../packages/shared-integrations/src/ringcxVoiceClient");
const { getSharedConfig } = require("../packages/shared-config/src");
const {
  connectMongo,
  disconnectMongo,
} = require("../packages/event-core/src");
const EventRecord = require("../packages/event-core/src/models/EventRecord");
const WorkflowRecord = require("../packages/shared-models/src/WorkflowRecord");

const RC_BASE = (process.env.RING_CENTRAL_SERVER_URL || "https://platform.ringcentral.com").replace(/\/$/, "");
const PHASE_KEYS = ["opening", "discovery", "pain", "qualification", "solution", "objection", "close", "wrap"];
const SPEAKER_KEYS = ["agent", "prospect", "system", "unknown"];
const HUMAN_SPEAKER_KEYS = ["agent", "prospect"];
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

function env(name, fallback = "") {
  const value = process.env[name];
  return value === undefined || value === null || value === "" ? fallback : value;
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

function monitorCredentialPrefixForExt(extensionNumber) {
  const byExtension = {
    987: "PHIL",
    1101: "SEAN",
    1102: "BRUCE",
    1103: "ANTHONY",
    1104: "CHRIS",
    1105: "JAMES",
    1106: "BRAD",
  };
  return byExtension[String(extensionNumber || "").trim()] || "";
}

function namedMonitorCredential(prefix, suffix) {
  return prefix ? env(`${prefix}_RING_CENTRAL_MONITOR_${suffix}`, "") : "";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timestampForFile(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJsonLine(file, event) {
  fs.appendFileSync(file, `${JSON.stringify(event)}\n`);
}

const rcTokenMemoryCache = new Map();
const RC_TOKEN_CACHE_SKEW_MS = Math.max(
  30_000,
  Number(process.env.EX_LIVE_MONITOR_TOKEN_CACHE_SKEW_MS || 120_000) || 120_000,
);

function isMonitorTokenCacheEnabled() {
  return String(process.env.EX_LIVE_MONITOR_TOKEN_CACHE || "false").trim().toLowerCase() === "true";
}

function rcCredentialCacheKey({ jwtToken, clientId, clientSecret }) {
  return crypto
    .createHash("sha256")
    .update([RC_BASE, clientId, clientSecret ? "secret-present" : "", jwtToken].join("\n"))
    .digest("hex");
}

function rcTokenCacheDir() {
  return path.resolve(process.env.EX_LIVE_MONITOR_TOKEN_CACHE_DIR || path.join(__dirname, "..", "runtime", "ex-live-monitor-token-cache"));
}

function rcTokenCachePaths(cacheKey) {
  const dir = rcTokenCacheDir();
  return {
    dir,
    tokenPath: path.join(dir, `${cacheKey}.json`),
    lockPath: path.join(dir, `${cacheKey}.lock`),
  };
}

function cachedTokenIsFresh(entry, skewMs = RC_TOKEN_CACHE_SKEW_MS) {
  return Boolean(
    entry?.accessToken &&
    Number.isFinite(Number(entry.expiresAt)) &&
    Number(entry.expiresAt) > Date.now() + skewMs
  );
}

function cachedTokenIsUsable(entry) {
  return Boolean(
    entry?.accessToken &&
    Number.isFinite(Number(entry.expiresAt)) &&
    Number(entry.expiresAt) > Date.now()
  );
}

function hasCachedRefreshToken(entry) {
  return Boolean(entry?.refreshToken && typeof entry.refreshToken === "string");
}

function readCachedRcToken(cacheKey, { allowNearExpiry = false } = {}) {
  if (!isMonitorTokenCacheEnabled()) return null;
  const memory = rcTokenMemoryCache.get(cacheKey);
  if ((allowNearExpiry ? cachedTokenIsUsable(memory) : cachedTokenIsFresh(memory))) return memory;

  const { tokenPath } = rcTokenCachePaths(cacheKey);
  try {
    const entry = JSON.parse(fs.readFileSync(tokenPath, "utf8"));
    if (allowNearExpiry ? cachedTokenIsUsable(entry) : cachedTokenIsFresh(entry)) {
      rcTokenMemoryCache.set(cacheKey, entry);
      return entry;
    }
    return entry;
  } catch {
    return null;
  }
}

function writeCachedRcToken(cacheKey, entry) {
  if (!isMonitorTokenCacheEnabled()) return;
  const { dir, tokenPath } = rcTokenCachePaths(cacheKey);
  ensureDir(dir);
  const tempPath = `${tokenPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(entry));
  fs.renameSync(tempPath, tokenPath);
  rcTokenMemoryCache.set(cacheKey, entry);
}

async function requestRcOauthToken({ basic, body }) {
  const response = await fetch(`${RC_BASE}/restapi/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return { response, text, json };
}

function tokenEntryFromOauthJson(json, previous = {}) {
  const expiresInMs = Math.max(60_000, Number(json?.expires_in || 3600) * 1000);
  const refreshExpiresInMs = Number(json?.refresh_token_expires_in || 0) > 0
    ? Number(json.refresh_token_expires_in) * 1000
    : 0;
  const entry = {
    accessToken: json?.access_token,
    refreshToken: json?.refresh_token || previous.refreshToken || null,
    tokenType: json?.token_type || previous.tokenType || "bearer",
    scope: json?.scope || previous.scope || null,
    ownerId: json?.owner_id || previous.ownerId || null,
    expiresAt: Date.now() + expiresInMs,
    refreshExpiresAt: refreshExpiresInMs ? Date.now() + refreshExpiresInMs : previous.refreshExpiresAt || null,
    cachedAt: Date.now(),
  };
  if (!entry.accessToken) throw new Error("RC OAuth response did not include access_token");
  return entry;
}

async function acquireRcTokenCacheLock(cacheKey) {
  if (!isMonitorTokenCacheEnabled()) return null;
  const { dir, lockPath } = rcTokenCachePaths(cacheKey);
  ensureDir(dir);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      return {
        release() {
          try { fs.closeSync(fd); } catch {}
          try { fs.unlinkSync(lockPath); } catch {}
        },
      };
    } catch (error) {
      if (error.code !== "EEXIST") return null;
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > 45_000) fs.unlinkSync(lockPath);
      } catch {}
      const cached = readCachedRcToken(cacheKey);
      if (cached) return { cached, release() {} };
      await sleep(500);
    }
  }
  return null;
}

function maskPhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  return `${"*".repeat(Math.max(digits.length - 4, 0))}${digits.slice(-4)}`;
}

function cleanText(value, maxLength = 6000) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
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

function inferAudioMimeType(filePath) {
  const ext = path.extname(String(filePath || "")).toLowerCase();
  if (ext === ".wav") return "audio/wav";
  if (ext === ".mp3") return "audio/mpeg";
  if (ext === ".m4a") return "audio/mp4";
  if (ext === ".webm") return "audio/webm";
  if (ext === ".ogg") return "audio/ogg";
  return "audio/wav";
}

function audioFileDataUrl(filePath) {
  const resolved = path.resolve(filePath);
  const encoded = fs.readFileSync(resolved).toString("base64");
  return `data:${inferAudioMimeType(resolved)};base64,${encoded}`;
}

function readRepeatedFlag(argv, name) {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith(`${name}=`)) {
      values.push(arg.slice(name.length + 1));
    } else if (arg === name && index < argv.length - 1) {
      values.push(argv[index + 1]);
      index += 1;
    }
  }
  return values;
}

function parseKnownSpeakerReferences(argv) {
  const specs = readRepeatedFlag(argv, "--known-speaker");
  const names = [];
  const references = [];
  for (const spec of specs.slice(0, 4)) {
    const raw = String(spec || "").trim();
    const splitAt = raw.indexOf("=");
    if (splitAt <= 0) continue;
    const name = cleanText(raw.slice(0, splitAt), 40);
    const filePath = raw.slice(splitAt + 1).trim();
    if (!name || !filePath) continue;
    names.push(name);
    references.push(audioFileDataUrl(filePath));
  }
  return { names, references };
}

function normalizeCallFlow(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return ["outbound", "inbound", "mixed"].includes(normalized) ? normalized : "outbound";
}

function normalizeInitialHumanSpeaker(value, callFlow = "outbound") {
  const normalized = String(value || "").trim().toLowerCase();
  if (HUMAN_SPEAKER_KEYS.includes(normalized)) return normalized;
  return callFlow === "outbound" ? "prospect" : "agent";
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

function normalizeCoachPanel(input = {}) {
  const phaseInput = input.phase && typeof input.phase === "object" ? input.phase : {};
  const rawKey = String(phaseInput.key || "").trim().toLowerCase();
  const key = PHASE_KEYS.includes(rawKey) ? rawKey : "discovery";
  return {
    phase: {
      key,
      label: cleanText(phaseInput.label || key.replace(/^\w/, (char) => char.toUpperCase()), 48),
      reason: cleanText(phaseInput.reason, 220),
    },
    confidence: clampNumber(input.confidence, 0, 1, 0.55),
    oneSentenceFocus: cleanText(input.oneSentenceFocus, 220),
    tips: clampStringList(input.tips, 4, 180),
    suggestedMoves: clampStringList(input.suggestedMoves, 4, 180),
    listenFor: clampStringList(input.listenFor, 4, 180),
    riskFlags: clampStringList(input.riskFlags, 4, 160),
    nextBestQuestion: cleanText(input.nextBestQuestion, 180),
    provider: cleanText(input.provider, 40) || undefined,
    model: cleanText(input.model, 80) || undefined,
  };
}

function normalizeSpeakerSegments(input = {}, fallbackText = "") {
  const rawSegments = Array.isArray(input.segments) ? input.segments : [];
  const segments = rawSegments
    .map((segment) => {
      const rawSpeaker = String(segment?.speaker || "").trim().toLowerCase();
      const speaker = SPEAKER_KEYS.includes(rawSpeaker) ? rawSpeaker : "unknown";
      const text = cleanText(segment?.text || "", 1000);
      if (!text) return null;
      return {
        speaker,
        text,
        confidence: clampNumber(segment?.confidence, 0, 1, 0.45),
        reason: cleanText(segment?.reason || "", 160),
      };
    })
    .filter(Boolean)
    .slice(0, 8);
  if (segments.length) return segments;
  const text = cleanText(fallbackText, 1000);
  return text
    ? [{ speaker: "unknown", text, confidence: 0.35, reason: "fallback unlabeled transcript" }]
    : [];
}

function getLastHumanSpeaker(recentSegments = []) {
  for (let index = recentSegments.length - 1; index >= 0; index -= 1) {
    const speaker = String(recentSegments[index]?.speaker || "").trim().toLowerCase();
    if (HUMAN_SPEAKER_KEYS.includes(speaker)) return speaker;
  }
  return "";
}

function speakerCueForText(text, { callFlow = "outbound", lastHumanSpeaker = "" } = {}) {
  const clean = normalizeForDedupe(text);
  if (!clean) return "";
  if (/\bplease continue( to hold)?\b/.test(clean) || /\byour call is important\b/.test(clean)) {
    return "system";
  }

  const companyCue = /\b(tax advocate|tax group|wynn tax|wynn tax solutions|with (the )?(tax advocate group|tax group|group|wynn tax|wynn)|responding to your (query|inquiry|request))\b/;
  if (
    callFlow === "outbound"
    && !lastHumanSpeaker
    && /^(hello|hello there|hi|yeah hi|yes hello|this is|speaking)\b/.test(clean)
    && !companyCue.test(clean)
  ) {
    return "prospect";
  }

  const prospectProblemPatterns = [
    /\bwhat happened was\b/,
    /\bowe money\b/,
    /\bi (owe|owed|didn't file|did not file|haven't filed|have not filed|need|got|received|was wondering|have)\b/,
    /\bto the irs\b.*\bi\b/,
    /\bi\b.*\bto the irs\b/,
    /\bmy (tax|taxes|irs|state)\b/,
  ];
  if (prospectProblemPatterns.some((pattern) => pattern.test(clean))) return "prospect";

  if (
    callFlow === "outbound"
    && lastHumanSpeaker === "agent"
    && wordTokens(clean).length <= 4
    && /^(sorry|yeah|yes|yep|okay|ok|right)\b/.test(clean)
  ) {
    return "prospect";
  }

  const agentPatterns = [
    /\btax advocate\b/,
    /\btax group\b/,
    /\bwynn tax\b/,
    /\bwintax\b/,
    /\bwe('re| are)\b/,
    /\bwe help\b/,
    /\bwhat we do\b/,
    /\btax resolution\b/,
    /\bwith (the )?(tax advocate group|tax group|group|wynn tax|wynn)\b/,
    /\bresponding to your (query|inquiry|request)\b/,
    /\bhow can i help\b/,
    /\bhow can i assist\b/,
    /\bhow are you doing\b/,
    /\bhow are you today\b/,
    /\bhow much do you owe\b/,
    /\bdo you owe\b/,
    /\banything unfiled\b/,
    /\bcalling (from|about)\b/,
    /\bmy name is\b/,
    /\blet me\b/,
    /\bconsultant can review\b/,
    /\breview the basics\b/,
    /\bbasics with you by phone\b/,
  ];
  if (agentPatterns.some((pattern) => pattern.test(clean))) return "agent";

  if (callFlow === "outbound" && lastHumanSpeaker === "prospect" && /\bhi this is\b/.test(clean)) {
    return "agent";
  }

  const prospectPatterns = [
    /^(hello|hello there|hi|yeah hi|yes hello|speaking)\b/,
    /\bwho is this\b/,
    /\bnot so bad\b/,
    /\bi'?m (good|okay|ok|fine|alright)\b/,
    /\bi was wondering\b/,
    /\bwhat kind of\b/,
    /\bdo you guys\b/,
    /\bcan you help\b/,
    /\b(kind of )?breaking up\b/,
    /\bcan'?t hear\b/,
    /\bi need\b/,
    /\bi owe\b/,
    /\bi got\b/,
    /\bi have\b/,
    /\bi received\b/,
    /\bletter from (the )?(irs|state)\b/,
  ];
  if (prospectPatterns.some((pattern) => pattern.test(clean))) return "prospect";

  return "";
}

function buildLiveSttPrompt({ baseContext = "", recentTranscripts = [] } = {}) {
  const context = cleanText(baseContext, 700);
  const recent = (Array.isArray(recentTranscripts) ? recentTranscripts : [])
    .map((entry) => cleanText(entry?.text || "", 180))
    .filter(Boolean)
    .slice(-3)
    .join(" ");
  return [
    context,
    recent ? `Previous transcript: ${recent}` : "",
  ].filter(Boolean).join(" ").trim();
}

function splitOutboundMixedSegment(segment) {
  const text = cleanText(segment?.text || "", 1000);
  if (!text) return [];
  const match = text.match(/^(.*?\b(?:responding to your (?:query|inquiry|request)|with (?:the )?(?:tax advocate group|tax group|group|wynn tax|wynn tax solutions))\.?)\s+((?:hi|hello|yeah|yes)\b.*)$/i);
  if (!match) return [segment];
  return [
    {
      ...segment,
      speaker: "agent",
      text: cleanText(match[1], 1000),
      confidence: Math.max(Number(segment.confidence || 0), 0.82),
      reason: cleanText(`${segment.reason || ""} split mixed outbound agent intro`, 160),
    },
    {
      ...segment,
      speaker: "prospect",
      text: cleanText(match[2], 1000),
      confidence: Math.max(Number(segment.confidence || 0), 0.78),
      reason: cleanText(`${segment.reason || ""} split mixed outbound prospect reply`, 160),
    },
  ].filter((part) => part.text);
}

function stabilizeSpeakerSegments(segments, { recentSegments = [], metadata = {} } = {}) {
  const callFlow = normalizeCallFlow(metadata.callFlow);
  const initialHumanSpeaker = normalizeInitialHumanSpeaker(metadata.initialHumanSpeaker, callFlow);
  let lastHumanSpeaker = getLastHumanSpeaker(recentSegments);
  let hasHumanSpeaker = Boolean(lastHumanSpeaker);

  return (segments || []).flatMap((rawSegment) => splitOutboundMixedSegment(rawSegment)).map((segment) => {
    if (!segment || !segment.text) return segment;
    const next = { ...segment };
    const cue = speakerCueForText(next.text, { callFlow, lastHumanSpeaker });

    if (cue) {
      next.speaker = cue;
      next.confidence = Math.max(Number(next.confidence || 0), 0.85);
      next.reason = cleanText(`${next.reason || ""} speaker cue: ${cue}`, 160);
    } else if (!hasHumanSpeaker && HUMAN_SPEAKER_KEYS.includes(next.speaker)) {
      next.speaker = initialHumanSpeaker;
      next.confidence = Math.max(Number(next.confidence || 0), 0.8);
      next.reason = cleanText(`${next.reason || ""} outbound initial-human heuristic`, 160);
    } else if (
      hasHumanSpeaker
      && HUMAN_SPEAKER_KEYS.includes(next.speaker)
      && next.speaker !== lastHumanSpeaker
      && Number(next.confidence || 0) < 0.9
    ) {
      next.speaker = lastHumanSpeaker;
      next.confidence = Math.max(Number(next.confidence || 0), 0.75);
      next.reason = cleanText(`${next.reason || ""} kept prior speaker for short ambiguous fragment`, 160);
    }

    if (HUMAN_SPEAKER_KEYS.includes(next.speaker)) {
      lastHumanSpeaker = next.speaker;
      hasHumanSpeaker = true;
    }
    return next;
  });
}

function oppositeHumanSpeaker(speaker) {
  return speaker === "agent" ? "prospect" : "agent";
}

function assignedNativeHumans(nativeSpeakerAssignments) {
  return new Set(
    [...(nativeSpeakerAssignments?.values?.() || [])]
      .filter((speaker) => HUMAN_SPEAKER_KEYS.includes(speaker)),
  );
}

function normalizeNativeDiarizeRawSegments(rawSegments = []) {
  return (Array.isArray(rawSegments) ? rawSegments : [])
    .map((segment) => {
      const text = cleanText(segment?.text || "", 1000);
      if (!text) return null;
      return {
        id: segment?.id ?? null,
        type: segment?.type ?? null,
        nativeSpeaker: cleanText(segment?.nativeSpeaker || segment?.speaker || "", 40),
        text,
        start: typeof segment?.start === "number" ? segment.start : null,
        end: typeof segment?.end === "number" ? segment.end : null,
      };
    })
    .filter(Boolean)
    .slice(0, 32);
}

function stabilizeNativeDiarizeSegments(segments, {
  recentSegments = [],
  metadata = {},
  nativeSpeakerAssignments = null,
} = {}) {
  if (!nativeSpeakerAssignments) {
    return stabilizeSpeakerSegments(segments, { recentSegments, metadata });
  }

  const callFlow = normalizeCallFlow(metadata.callFlow);
  const initialHumanSpeaker = normalizeInitialHumanSpeaker(metadata.initialHumanSpeaker, callFlow);
  let lastHumanSpeaker = getLastHumanSpeaker(recentSegments);

  return (segments || []).map((segment) => {
    if (!segment || !segment.text) return segment;
    const next = { ...segment };
    const nativeSpeaker = cleanText(next.nativeSpeaker || "", 40);
    const cue = speakerCueForText(next.text, { callFlow, lastHumanSpeaker });

    if (cue === "system") {
      next.speaker = "system";
      next.confidence = Math.max(Number(next.confidence || 0), 0.9);
      next.reason = cleanText(`${next.reason || ""} text cue: system`, 180);
      return next;
    }

    if (cue && HUMAN_SPEAKER_KEYS.includes(cue)) {
      next.speaker = cue;
      next.confidence = Math.max(Number(next.confidence || 0), 0.9);
      next.reason = cleanText(`${next.reason || ""} text cue: ${cue}`, 180);
      if (nativeSpeaker && !nativeSpeakerAssignments.has(nativeSpeaker)) {
        nativeSpeakerAssignments.set(nativeSpeaker, cue);
      }
    } else if (nativeSpeaker && nativeSpeakerAssignments.has(nativeSpeaker)) {
      next.speaker = nativeSpeakerAssignments.get(nativeSpeaker);
      next.confidence = Math.max(Number(next.confidence || 0), 0.88);
      next.reason = cleanText(`${next.reason || ""} mapped native speaker`, 180);
    } else if (nativeSpeaker) {
      const assignedHumans = assignedNativeHumans(nativeSpeakerAssignments);
      let assigned = "";
      if (assignedHumans.size === 0) {
        assigned = initialHumanSpeaker;
      } else if (assignedHumans.size === 1) {
        assigned = oppositeHumanSpeaker([...assignedHumans][0]);
      }
      if (assigned) {
        nativeSpeakerAssignments.set(nativeSpeaker, assigned);
        next.speaker = assigned;
        next.confidence = Math.max(Number(next.confidence || 0), 0.78);
        next.reason = cleanText(`${next.reason || ""} native speaker assignment`, 180);
      }
    } else {
      const stabilized = stabilizeSpeakerSegments([next], {
        recentSegments,
        metadata,
      })[0] || next;
      Object.assign(next, stabilized);
    }

    if (HUMAN_SPEAKER_KEYS.includes(next.speaker)) lastHumanSpeaker = next.speaker;
    return next;
  });
}

function speakerSegmentsFromNativeDiarize(rawSegments = [], fallbackText = "", {
  recentSegments = [],
  metadata = {},
  nativeSpeakerAssignments = null,
} = {}) {
  const nativeSegments = normalizeNativeDiarizeRawSegments(rawSegments)
    .map((segment) => {
      const nativeSpeaker = cleanText(segment?.nativeSpeaker || segment?.speaker || "", 20);
      return {
        speaker: "unknown",
        nativeSpeaker,
        text: segment.text,
        confidence: nativeSpeaker ? 0.82 : 0.7,
        reason: nativeSpeaker ? `native diarize speaker ${nativeSpeaker}` : "native diarize segment",
      };
    })
    .filter(Boolean)
    .slice(0, 8);
  const segments = nativeSegments.length
    ? nativeSegments
    : normalizeSpeakerSegments({}, fallbackText);
  return nativeSegments.length
    ? stabilizeNativeDiarizeSegments(segments, {
      recentSegments,
      metadata,
      nativeSpeakerAssignments,
    })
    : stabilizeSpeakerSegments(segments, { recentSegments, metadata });
}

function ulawByteToPcm16(byte) {
  const value = (~byte) & 0xff;
  const sign = value & 0x80;
  const exponent = (value >> 4) & 0x07;
  const mantissa = value & 0x0f;
  let sample = ((mantissa << 3) + 0x84) << exponent;
  sample -= 0x84;
  return sign ? -sample : sample;
}

function measurePcmuActivity(pcmuBuffer) {
  let active = 0;
  let totalAbs = 0;
  let maxAbs = 0;
  for (const byte of pcmuBuffer) {
    const abs = Math.abs(ulawByteToPcm16(byte));
    totalAbs += abs;
    if (abs > maxAbs) maxAbs = abs;
    if (abs > 500) active += 1;
  }
  const samples = pcmuBuffer.length;
  return {
    samples,
    durationSec: samples / 8000,
    meanAbs: samples ? Number((totalAbs / samples).toFixed(2)) : 0,
    maxAbs,
    activePctOver500: samples ? Number(((active / samples) * 100).toFixed(3)) : 0,
  };
}

function buildPcm16WavFromPcmu(pcmuBuffer, sampleRate = 8000) {
  const dataSize = pcmuBuffer.length * 2;
  const wav = Buffer.alloc(44 + dataSize);

  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < pcmuBuffer.length; i += 1) {
    wav.writeInt16LE(ulawByteToPcm16(pcmuBuffer[i]), 44 + i * 2);
  }
  return wav;
}

function buildPcm16_24kFromPcmu8k(pcmuBuffer) {
  const out = Buffer.alloc(pcmuBuffer.length * 2 * 3);
  for (let i = 0; i < pcmuBuffer.length; i += 1) {
    const sample = ulawByteToPcm16(pcmuBuffer[i]);
    const offset = i * 6;
    out.writeInt16LE(sample, offset);
    out.writeInt16LE(sample, offset + 2);
    out.writeInt16LE(sample, offset + 4);
  }
  return out;
}

class OpenAiRealtimeTranscriber {
  constructor({
    apiKey,
    model = "gpt-realtime-whisper",
    language = "en",
    delay = "xhigh",
    safetyIdentifier = "tagcontactbridge-ex-live-monitor",
  } = {}) {
    if (!apiKey) throw new Error("OPENAI_API_KEY is missing");
    this.apiKey = apiKey;
    this.model = model || "gpt-realtime-whisper";
    this.language = language || "en";
    this.delay = delay || "";
    this.safetyIdentifier = safetyIdentifier || "tagcontactbridge-ex-live-monitor";
    this.ws = null;
    this.readyPromise = null;
    this.readyResolve = null;
    this.readyReject = null;
    this.pending = null;
    this.sessionId = null;
  }

  connect() {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
      const protocols = [
        "realtime",
        `openai-insecure-api-key.${this.apiKey}`,
      ];
      const project = process.env.OPENAI_PROJECT_ID || process.env.OPENAI_PROJECT || "";
      const org = process.env.OPENAI_ORG_ID || process.env.OPENAI_ORGANIZATION || "";
      if (project) protocols.push(`openai-project.${project}`);
      if (org) protocols.push(`openai-organization.${org}`);
      this.ws = new WebSocket("wss://api.openai.com/v1/realtime?intent=transcription", protocols);
      this.ws.addEventListener("open", () => {
        this.send({
          type: "session.update",
          session: {
            type: "transcription",
            audio: {
              input: {
                format: {
                  type: "audio/pcm",
                  rate: 24000,
                },
                transcription: {
                  model: this.model,
                  language: this.language,
                  ...(this.delay ? { delay: this.delay } : {}),
                },
                turn_detection: null,
              },
            },
          },
        });
      });
      this.ws.addEventListener("message", (event) => this.handleMessage(event.data));
      this.ws.addEventListener("error", () => {
        const error = new Error("OpenAI realtime transcription websocket error");
        if (this.pending) this.rejectPending(error);
        if (this.readyReject) this.readyReject(error);
      });
      this.ws.addEventListener("close", (event) => {
        const reason = event.reason ? `: ${event.reason}` : "";
        const error = new Error(`OpenAI realtime transcription websocket closed ${event.code}${reason}`);
        if (this.pending) this.rejectPending(error);
        if (this.readyReject) this.readyReject(error);
        this.readyPromise = null;
        this.readyResolve = null;
        this.readyReject = null;
        this.ws = null;
      });
    });
    return this.readyPromise;
  }

  send(payload) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("OpenAI realtime transcription websocket is not open");
    }
    this.ws.send(JSON.stringify(payload));
  }

  handleMessage(raw) {
    let event = null;
    try {
      event = typeof raw === "string" ? JSON.parse(raw) : JSON.parse(String(raw || ""));
    } catch {
      return;
    }
    if (event.type === "session.created" || event.type === "session.updated") {
      this.sessionId = event.session?.id || this.sessionId;
      if (event.type === "session.updated" && this.readyResolve) {
        this.readyResolve(event.session || {});
        this.readyResolve = null;
        this.readyReject = null;
      }
      return;
    }
    if (event.type === "conversation.item.input_audio_transcription.delta") {
      if (this.pending) {
        this.pending.deltas.push(String(event.delta || ""));
        this.pending.itemId = event.item_id || this.pending.itemId || null;
      }
      return;
    }
    if (event.type === "conversation.item.input_audio_transcription.completed") {
      if (!this.pending) return;
      const pending = this.pending;
      this.pending = null;
      clearTimeout(pending.timeoutHandle);
      pending.resolve({
        text: cleanText(event.transcript || pending.deltas.join(""), 4000),
        model: this.model,
        responseFormat: "realtime_json",
        provider: "openai-realtime",
        itemId: event.item_id || pending.itemId || null,
        sessionId: this.sessionId,
        delay: this.delay || null,
      });
      return;
    }
    if (event.type === "error") {
      const message = event.error?.message || "OpenAI realtime transcription error";
      const code = event.error?.code ? ` (${event.error.code})` : "";
      const error = new Error(`${message}${code}`);
      if (this.pending) this.rejectPending(error);
      else if (this.readyReject) this.readyReject(error);
    }
  }

  rejectPending(error) {
    if (!this.pending) return;
    const pending = this.pending;
    this.pending = null;
    clearTimeout(pending.timeoutHandle);
    pending.reject(error);
  }

  async transcribePcmu({ pcmuBuffer, timeoutMs = 30000 } = {}) {
    await this.connect();
    if (this.pending) throw new Error("OpenAI realtime transcription already has a pending commit");
    const pcm24 = buildPcm16_24kFromPcmu8k(pcmuBuffer);
    return new Promise((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this.rejectPending(new Error(`OpenAI realtime transcription timed out after ${timeoutMs}ms`));
      }, Math.max(Number(timeoutMs) || 30000, 1000));
      this.pending = {
        resolve,
        reject,
        timeoutHandle,
        deltas: [],
        itemId: null,
      };
      try {
        this.send({
          type: "input_audio_buffer.append",
          audio: pcm24.toString("base64"),
        });
        this.send({ type: "input_audio_buffer.commit" });
      } catch (error) {
        this.rejectPending(error);
      }
    });
  }

  close() {
    if (this.pending) this.rejectPending(new Error("OpenAI realtime transcription closed"));
    if (this.ws) {
      try {
        this.ws.close(1000, "done");
      } catch {
        // no-op
      }
    }
  }
}

function parseRealtimeDirectCoachOutput(text) {
  const clean = cleanText(text, 1200);
  if (!clean) return { acceptInput: null, mode: "", heard: "", say: "", signal: "", topic: "", direction: "", raw: "" };
  const normalizeCoachOutputMode = (value) => {
    const mode = cleanText(value || "", 40).toLowerCase();
    if (["agent", "agent_feedback", "feedback", "adjust", "adjust_current_talk"].includes(mode)) return "agent_feedback";
    if (["prospect", "client", "customer", "coach", "response", "prospect_response", "proposed_response"].includes(mode)) return "prospect_response";
    if (["hold", "system", "hold_system"].includes(mode)) return "hold";
    if (["wait", "none", "no_action"].includes(mode)) return "wait";
    return mode;
  };
  const parseAcceptInput = (value) => {
    if (value === true || value === false) return value;
    const cleanValue = cleanText(value, 24).toLowerCase();
    if (["false", "no", "0", "off", "stop", "hold", "pause"].includes(cleanValue)) return false;
    if (["true", "yes", "1", "on", "continue", "accept"].includes(cleanValue)) return true;
    return null;
  };
  try {
    const json = JSON.parse(clean);
    const mode = normalizeCoachOutputMode(json.mode || json.status || "");
    let say = cleanText(json.say || json.response || json.coach || "", 600);
    if (/^wait\.?$/i.test(say)) say = "";
    return {
      acceptInput: parseAcceptInput(
        json.acceptInput ?? json.accept_input ?? json.accept ?? json.continueInput ?? json.continue_input,
      ),
      mode,
      heard: cleanText(json.heard || "", 600),
      say,
      signal: cleanText(json.signal || json.basedOn || json.evidence || "", 220),
      topic: cleanText(json.topic || "", 80),
      direction: cleanText(json.direction || json.note || json.why || "", 220),
      raw: clean,
    };
  } catch {
    // fall through to compact label parsing
  }
  const readField = (label) => {
    const pattern = new RegExp(`(?:^|\\n|\\s)\\s*${label}\\s*[:=]\\s*([\\s\\S]*?)(?=(?:\\n|\\s)\\s*(?:MODE|HEARD|SAY|SIGNAL|TOPIC|DIRECTION)\\s*[:=]|$)`, "i");
    return cleanText(clean.match(pattern)?.[1] || "", label === "SAY" ? 600 : 220);
  };
  const mode = normalizeCoachOutputMode(readField("MODE"));
  const acceptInput = parseAcceptInput(
    readField("ACCEPT_INPUT") || readField("ACCEPTINPUT") || readField("ACCEPT") || readField("INPUT"),
  );
  const heard = cleanText(readField("HEARD"), 600);
  let say = cleanText(readField("SAY") || clean, 600);
  const signal = cleanText(readField("SIGNAL"), 220);
  const topic = cleanText(readField("TOPIC"), 80);
  const direction = cleanText(readField("DIRECTION"), 220);
  if (mode) {
    say = cleanText(say.replace(/MODE\s*[:=]\s*[a-z_ -]+/i, ""), 600);
  }
  if (/^wait\.?$/i.test(say)) say = "";
  return { acceptInput, mode, heard, say, signal, topic, direction, raw: clean };
}

function extractRealtimeResponseText(response = {}) {
  const output = Array.isArray(response.output) ? response.output : [];
  const parts = [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      const text = part?.text || part?.transcript || part?.audio?.transcript || "";
      if (text) parts.push(text);
    }
  }
  return cleanText(parts.join(" "), 1600);
}

function buildRealtimeDirectCoachInstructions({ metadata, playbook, summary, coachOnly = false }) {
  const shared = [
    "You are a real-time tax-resolution sales call coach.",
    "You receive mixed mono monitor audio from a live RingEX supervision leg. It may contain the agent, prospect/client, system prompts, hold audio, voicemail, or overlapping speech.",
    "Your job is to discern what is probably party A (the sales agent), party B (the prospect/client), and system/noise, then provide tax-resolution-grounded feedback as a dialogue option for the sales agent.",
    coachOnly
      ? "If the newest useful content is party B/prospect, provide a line the sales agent can say. If it is party A/agent, provide private coaching feedback for the agent. Only if you hear the exact words 'please continue to hold', return acceptInput=false, mode=HOLD, say=WAIT, and signal='please continue to hold'."
      : "If the newest useful content is mostly party A talking, system audio, filler, silence, voicemail, hold music, or unclear mixed speech, return SAY: WAIT.",
    "Before answering, apply this gate in order:",
    "1. If you hear the exact words 'please continue to hold', return acceptInput=false, mode=HOLD, say=WAIT, and signal='please continue to hold'. For any other hold/system/noise/voicemail/silence, keep acceptInput=true and return mode=WAIT, say=WAIT. Never coach the agent about how to manage hold music or hold prompts.",
    "2. If the newest useful speech is probably the agent, return AGENT_FEEDBACK only when the agent needs course correction, empathy, pacing, compliance/safety correction, or a sharper next move. This means: guidance for how to adjust what the agent is currently saying. If the agent is already following a good suggestion, return WAIT.",
    "3. If the newest useful speech is probably the prospect/client, return PROSPECT_RESPONSE only after a complete sentence or clear question that raises pain, urgency, objection, confusion, willingness, resistance, next-step friction, money pressure, trust concern, buying signal, or a tax issue. This means: proposed response based on what the prospect just said.",
    "4. If the prospect is rambling without a complete, response-worthy thought, return WAIT.",
    "Start streaming the SAY line as soon as those gates pass. Do not wait for a full paragraph or long silence once the actionable thought is clear.",
    "You do not need to transcribe. You should explain the cue behind your advice in SIGNAL: either a very short phrase you heard, such as based on words like 'I have a problem', or a call dynamic, such as 'agent is explaining while prospect is unresponsive'. For the exact hold phrase, signal must be exactly 'please continue to hold'.",
    "DIRECTION should explain the move, such as 'shift from explaining to a short question' or 'acknowledge stress, then ask for the notice date'.",
    "Keep context of the whole conversation using the session history and the background summary. Prefer the newest prospect/client issue, but do not forget already-learned facts.",
    "Be warm, human, concise, and sales-useful. Acknowledge real stress briefly when present, then ask one useful next question or give a safe bridge.",
    "This is a service-sales coach, not a self-help tax advisor. The best response usually sells the value of professional review, representation, organization, communication, and taking the next step with the firm.",
    "Sound like a skilled human on a call: calm, conversational, empathetic, direct, and not scripted. Avoid robotic tax labels when a human phrase would work.",
    "Focus on what the firm can help them do next: understand the notice, get the facts organized, review transcripts/documents, communicate with the agency, and choose the right path after review.",
    "Do not give DIY instructions as the main answer. Do not make 'the thing to do is...' recommendations. Frame as 'let's look at this correctly so we know what option fits.'",
    "When there is emotion, briefly meet the emotion first, then move to a practical next fact. One human sentence is enough.",
    "This is usually an outbound sales call. Do not say generic inbound greetings like 'thanks for calling', 'how can I help you today', or 'this is the sales team' unless the prospect literally just initiated a fresh inbound greeting.",
    "If the newest useful audio is only greeting/setup, the best SAY line should introduce the firm and ask one opening discovery question, not pretend the prospect called in.",
    "If the prospect mentions a tax problem, notice, balance, levy, lien, unfiled returns, garnishment, payroll, 1099, state issue, or fear, respond to that specific problem immediately.",
    "Do not promise outcomes, exact programs, timelines, fees, tax/legal results, or guaranteed savings.",
    "Do not prescribe a payment plan, installment agreement, partial payment, hold request, levy release, settlement, OIC, CNC, penalty relief, or any specific resolution path until the agent has basic qualification facts.",
    "For CP504/LT11/levy-style urgency, triage first: notice date/deadline, tax years, balance, whether later notices arrived, whether levy/garnishment/bank freeze is active, and whether all required returns are filed.",
    "Never say 'pay what you can' as live advice. Partial payment may not stop enforcement and can be strategically wrong before review.",
    "When the prospect asks 'what should I do' early, answer with a safe process bridge: review the notice, confirm compliance, identify urgency, then decide which option fits. Ask one next question.",
    "For AGENT_FEEDBACK, be private, direct, and brief: tell the agent how to adjust what they are currently saying, not what the prospect said. Examples: 'Slow down, acknowledge the fear first, then ask for the notice date.' or 'Do not promise a plan yet; qualify filing compliance first.'",
    "For AGENT_FEEDBACK, SAY should be an instruction to the agent, not words to say verbatim. For PROSPECT_RESPONSE, SAY should be a line the agent can say verbatim or very close to verbatim.",
    "Prefer one question over a multi-step checklist. Keep SAY under 30 words unless the prospect directly asks for an explanation.",
    "Do not identify speaker labels in the SAY line. Do not use markdown.",
    coachOnly
      ? "Do not output a transcript, paraphrase, heard text, analysis, explanation, or speaker labels. You may internally understand the audio, but only output the compact JSON control result."
      : "Return exactly this format:",
    coachOnly ? "Return exactly one JSON object with these keys and no markdown:" : "HEARD: <brief cleaned version of the newest useful prospect/client content, or blank>",
    coachOnly ? '{"acceptInput":true|false,"mode":"PROSPECT_RESPONSE|AGENT_FEEDBACK|WAIT|HOLD","say":"... or WAIT","signal":"...","topic":"...","direction":"..."}' : "SAY: <agent-sayable response, or WAIT>",
    coachOnly ? "acceptInput=false is a hard stop signal for the script. Use it only when you hear the exact words 'please continue to hold'. Do not use acceptInput=false for generic hold music, queue prompts, voicemail prompts, system prompts, silence, or any other wait loop." : "",
    coachOnly ? "If acceptInput=false, mode must be HOLD, say must be WAIT, and signal must be exactly 'please continue to hold'. Do not give hold-management advice." : "",
    coachOnly ? "If acceptInput=true, mode must be exactly one of PROSPECT_RESPONSE, AGENT_FEEDBACK, or WAIT." : "",
    coachOnly ? "Keep say under 28 words and direction under 16 words. Do not include transcript, alternatives, or speaker labels." : "",
    "",
    "Helpful tax anchors:",
    "- CP504, LT11/Letter 1058, levy, bank levy, wage garnishment, lien, and revenue officer contact are urgent collection signals.",
    "- Unfiled returns require compliance discovery: years, income type, IRS substitute returns, and available records.",
    "- Balance due questions need tax type, years, notice/source, income, assets, and ability to pay before suggesting a path.",
    "- State problems should be acknowledged, then screen for broader IRS/federal symptoms.",
    "",
    "Focused reference context:",
    playbook || "(none)",
    "",
    "Background summary:",
    summary || "(none yet)",
    "",
    `Monitor metadata: ${JSON.stringify(metadata || {})}`,
  ];
  return shared.filter((line) => line !== "").join("\n");
}

function buildRealtimeDirectCoachTextContext({
  chunkId,
  stats,
  flushReason,
} = {}) {
  return [
    "Latest audio chunk context. Use cached session instructions and prior call memory already in this realtime conversation.",
    "The latest committed audio is the source of truth. Classify it as prospect response, agent feedback, wait, or hold. Do not output a transcript.",
    `Chunk: ${chunkId || "unknown"}`,
    `Flush reason: ${flushReason || "unknown"}`,
    `Audio stats: ${JSON.stringify(stats || {})}`,
  ].join("\n");
}

function buildRealtimeDirectCoachMemoryContext({
  summary,
  metadata,
} = {}) {
  const compactSummary = cleanText(summary, 1800);
  if (!compactSummary) return "";
  return [
    "Background call memory update. Use this memory for future audio chunks, but do not answer this update by itself.",
    "",
    "Compact call summary:",
    compactSummary,
    "",
    `Stable monitor metadata: ${JSON.stringify(metadata || {})}`,
  ].join("\n");
}

class OpenAiRealtimeDirectCoach {
  constructor({
    apiKey,
    model = "gpt-realtime-2",
    instructions = "",
    safetyIdentifier = "tagcontactbridge-ex-live-direct-coach",
    timeoutMs = 20000,
    reasoningEffort = "",
  } = {}) {
    if (!apiKey) throw new Error("OPENAI_API_KEY is missing");
    this.apiKey = apiKey;
    this.model = model || "gpt-realtime-2";
    this.instructions = instructions || "";
    this.safetyIdentifier = safetyIdentifier || "tagcontactbridge-ex-live-direct-coach";
    this.timeoutMs = Math.max(Number(timeoutMs) || 20000, 1000);
    this.reasoningEffort = reasoningEffort || "";
    this.ws = null;
    this.readyPromise = null;
    this.readyResolve = null;
    this.readyReject = null;
    this.pending = null;
    this.sessionId = null;
  }

  connect() {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
      const protocols = [
        "realtime",
        `openai-insecure-api-key.${this.apiKey}`,
      ];
      const project = process.env.OPENAI_PROJECT_ID || process.env.OPENAI_PROJECT || "";
      const org = process.env.OPENAI_ORG_ID || process.env.OPENAI_ORGANIZATION || "";
      if (project) protocols.push(`openai-project.${project}`);
      if (org) protocols.push(`openai-organization.${org}`);
      this.ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(this.model)}`, protocols);
      this.ws.addEventListener("open", () => {
        this.send({
          type: "session.update",
          session: {
            type: "realtime",
            instructions: this.instructions,
            audio: {
              input: {
                format: {
                  type: "audio/pcm",
                  rate: 24000,
                },
                turn_detection: null,
              },
            },
            ...(this.reasoningEffort ? { reasoning: { effort: this.reasoningEffort } } : {}),
          },
        });
      });
      this.ws.addEventListener("message", (event) => this.handleMessage(event.data));
      this.ws.addEventListener("error", () => {
        const error = new Error("OpenAI realtime direct coach websocket error");
        if (this.pending) this.rejectPending(error);
        if (this.readyReject) this.readyReject(error);
      });
      this.ws.addEventListener("close", (event) => {
        const reason = event.reason ? `: ${event.reason}` : "";
        const error = new Error(`OpenAI realtime direct coach websocket closed ${event.code}${reason}`);
        if (this.pending) this.rejectPending(error);
        if (this.readyReject) this.readyReject(error);
        this.readyPromise = null;
        this.readyResolve = null;
        this.readyReject = null;
        this.ws = null;
      });
    });
    return this.readyPromise;
  }

  send(payload) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("OpenAI realtime direct coach websocket is not open");
    }
    this.ws.send(JSON.stringify(payload));
  }

  handleMessage(raw) {
    let event = null;
    try {
      event = typeof raw === "string" ? JSON.parse(raw) : JSON.parse(String(raw || ""));
    } catch {
      return;
    }
    if (event.type === "session.created" || event.type === "session.updated") {
      this.sessionId = event.session?.id || this.sessionId;
      if (event.type === "session.updated" && this.readyResolve) {
        this.readyResolve(event.session || {});
        this.readyResolve = null;
        this.readyReject = null;
      }
      return;
    }
    if (event.type === "response.text.delta" || event.type === "response.output_text.delta") {
      if (this.pending) {
        const delta = String(event.delta || "");
        this.pending.output += delta;
        this.pending.onDelta?.(delta, this.pending.output);
      }
      return;
    }
    if (event.type === "response.audio_transcript.delta" || event.type === "response.output_audio_transcript.delta") {
      if (this.pending) {
        const delta = String(event.delta || "");
        this.pending.output += delta;
        this.pending.onDelta?.(delta, this.pending.output);
      }
      return;
    }
    if (event.type === "response.text.done" || event.type === "response.output_text.done") {
      if (!this.pending) return;
      const pending = this.pending;
      pending.finalText = cleanText(event.text || event.transcript || pending.output, 1600);
      pending.onDelta?.("", pending.finalText || pending.output);
      if (!pending.doneGraceHandle) {
        pending.doneGraceHandle = setTimeout(() => {
          if (this.pending !== pending) return;
          this.pending = null;
          clearTimeout(pending.timeoutHandle);
          pending.resolve({
            ...parseRealtimeDirectCoachOutput(pending.finalText || pending.output),
            model: this.model,
            provider: "openai-realtime",
            sessionId: this.sessionId,
            usage: null,
          });
        }, 2000);
      }
      return;
    }
    if (event.type === "response.done") {
      if (!this.pending) return;
      const pending = this.pending;
      this.pending = null;
      clearTimeout(pending.timeoutHandle);
      if (pending.doneGraceHandle) clearTimeout(pending.doneGraceHandle);
      const finalText = cleanText(
        event.text || event.transcript || extractRealtimeResponseText(event.response) || pending.finalText || pending.output,
        1600,
      );
      pending.resolve({
        ...parseRealtimeDirectCoachOutput(finalText || pending.output),
        model: this.model,
        provider: "openai-realtime",
        sessionId: this.sessionId,
        usage: event.response?.usage || null,
      });
      return;
    }
    if (event.type === "error") {
      const message = event.error?.message || "OpenAI realtime direct coach error";
      const code = event.error?.code ? ` (${event.error.code})` : "";
      const error = new Error(`${message}${code}`);
      if (this.pending) this.rejectPending(error);
      else if (this.readyReject) this.readyReject(error);
    }
  }

  rejectPending(error) {
    if (!this.pending) return;
    const pending = this.pending;
    this.pending = null;
    clearTimeout(pending.timeoutHandle);
    if (pending.doneGraceHandle) clearTimeout(pending.doneGraceHandle);
    pending.reject(error);
  }

  async coachPcmu({ pcmuBuffer, timeoutMs, onDelta, instructions, textContext } = {}) {
    await this.connect();
    if (this.pending) throw new Error("OpenAI realtime direct coach already has a pending response");
    const pcm24 = buildPcm16_24kFromPcmu8k(pcmuBuffer);
    return new Promise((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this.rejectPending(new Error(`OpenAI realtime direct coach timed out after ${timeoutMs || this.timeoutMs}ms`));
      }, Math.max(Number(timeoutMs) || this.timeoutMs, 1000));
      this.pending = {
        resolve,
        reject,
        timeoutHandle,
        doneGraceHandle: null,
        output: "",
        finalText: "",
        onDelta,
      };
      try {
        this.send({
          type: "input_audio_buffer.append",
          audio: pcm24.toString("base64"),
        });
        this.send({ type: "input_audio_buffer.commit" });
        if (textContext) {
          this.send({
            type: "conversation.item.create",
            item: {
              type: "message",
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: cleanText(textContext, 12000),
                },
              ],
            },
          });
        }
        this.send({
          type: "response.create",
          response: {
            output_modalities: ["text"],
            instructions: instructions || "Use the latest committed audio item and latest text context item together. Return only HEARD/SAY in the required format.",
          },
        });
      } catch (error) {
        this.rejectPending(error);
      }
    });
  }

  async addTextContext(text) {
    await this.connect();
    const clean = cleanText(text, 12000);
    if (!clean) return false;
    this.send({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: clean,
          },
        ],
      },
    });
    return true;
  }

  close() {
    if (this.pending) this.rejectPending(new Error("OpenAI realtime direct coach closed"));
    if (this.ws) {
      try {
        this.ws.close(1000, "done");
      } catch {
        // no-op
      }
    }
  }
}

function pickProxy(sipInfo, region = "NA") {
  const proxies = Array.isArray(sipInfo?.outboundProxies) ? sipInfo.outboundProxies : [];
  const desired = String(region || "NA").trim().toUpperCase();
  const hit = proxies.find((proxy) => String(proxy.region || "").toUpperCase() === desired && proxy.proxyTLS)
    || proxies.find((proxy) => proxy.proxyTLS)
    || null;
  return hit?.proxyTLS || "sip10.ringcentral.com:5096";
}

function summarizeDevice(device = {}) {
  return {
    id: String(device.id || ""),
    type: device.type || null,
    name: device.name || null,
    status: device.status || null,
    lines: Array.isArray(device.phoneLines)
      ? device.phoneLines.map((line) => ({
        lineType: line.lineType || null,
        phoneNumber: maskPhone(line.phoneInfo?.phoneNumber),
        usageType: line.phoneInfo?.usageType || null,
      }))
      : [],
  };
}

function pickSupervisorDevice(devices, requestedId = "") {
  if (requestedId) {
    return devices.find((device) => String(device.id) === String(requestedId)) || null;
  }
  return devices.find((device) => device.status === "Online" && device.type === "HardPhone")
    || devices.find((device) => device.status === "Online")
    || devices.find((device) => /hard|sip|phone/i.test(String(device.type || "")))
    || devices[0]
    || null;
}

function pickActiveCall(records, mode = "newest") {
  const candidates = records.filter((record) => record.telephonySessionId);
  const source = candidates.length ? candidates : records;
  const inProgress = source.filter((record) => String(record.result || "").toLowerCase() === "in progress");
  const pool = inProgress.length ? inProgress : source;
  if (mode === "first") {
    return pool[0]
      || null;
  }
  return [...pool].sort((a, b) => {
    const bt = Date.parse(b.startTime || b.creationTime || b.enqueueTime || "") || 0;
    const at = Date.parse(a.startTime || a.creationTime || a.enqueueTime || "") || 0;
    return bt - at;
  })[0] || null;
}

function orderActiveCallCandidates(records, mode = "newest") {
  const candidates = records.filter((record) => record.telephonySessionId);
  const source = candidates.length ? candidates : records;
  const inProgress = source.filter((record) => String(record.result || "").toLowerCase() === "in progress");
  const pool = inProgress.length ? inProgress : source;
  if (mode === "first") return pool;
  return [...pool].sort((a, b) => {
    const bt = Date.parse(b.startTime || b.creationTime || b.enqueueTime || "") || 0;
    const at = Date.parse(a.startTime || a.creationTime || a.enqueueTime || "") || 0;
    return bt - at;
  });
}

function isRetryableSuperviseError(error) {
  const message = String(error?.message || "");
  return /No (active|live) agent telephonySessionId|Request rate exceeded|CMN-301|HTTP 429|MBW-005|Your call cannot be connected|TAS-10[2]|TAS-120|WrongState|Incorrect State|CMN-10[12]|agentExtensionId/i
    .test(message);
}

function pickParty(session, agentExtensionId, mode = "session") {
  const parties = Array.isArray(session?.parties) ? session.parties : [];
  const active = parties.filter((party) => {
    const code = String(party.status?.code || party.status || "").toLowerCase();
    return code && !["disconnected", "gone"].includes(code);
  });
  const agentId = String(agentExtensionId || "");
  if (mode === "agent") {
    return active.find((party) => String(party.extensionId || party.owner?.extensionId || "") === agentId)
      || active.find((party) => String(party.from?.extensionId || "") === agentId)
      || active.find((party) => String(party.to?.extensionId || "") === agentId)
      || null;
  }
  if (mode === "remote" || mode === "client" || mode === "customer") {
    return active.find((party) => String(party.extensionId || party.owner?.extensionId || "") !== agentId)
      || active.find((party) => String(party.from?.extensionId || "") !== agentId)
      || active[0]
      || null;
  }
  if (mode && mode !== "session" && mode !== "mixed") {
    return active.find((party) => String(party.id || "") === String(mode)) || null;
  }
  return null;
}

function partyHasExtensionId(party = {}, extensionId = "") {
  const wanted = String(extensionId || "");
  if (!wanted) return false;
  return [
    party.extensionId,
    party.owner?.extensionId,
    party.from?.extensionId,
    party.to?.extensionId,
  ].some((value) => String(value || "") === wanted);
}

function isLiveParty(party = {}) {
  const code = String(party.status?.code || party.status || "").toLowerCase();
  return Boolean(code && !["disconnected", "gone"].includes(code));
}

function summarizePartyForLog(party = {}) {
  return {
    id: party.id || null,
    status: party.status?.code || party.status || null,
    direction: party.direction || null,
    extensionId: party.extensionId || party.owner?.extensionId || null,
    from: {
      name: party.from?.name || null,
      phoneNumber: maskPhone(party.from?.phoneNumber),
      extensionId: party.from?.extensionId || null,
    },
    to: {
      name: party.to?.name || null,
      phoneNumber: maskPhone(party.to?.phoneNumber),
      extensionId: party.to?.extensionId || null,
    },
  };
}

async function rcAccessToken({
  jwtToken = process.env.RING_CENTRAL_JWT_TOKEN,
  clientId = process.env.RING_CENTRAL_CLIENT_ID,
  clientSecret = process.env.RING_CENTRAL_CLIENT_SECRET,
} = {}) {
  if (!jwtToken || !clientId || !clientSecret) {
    throw new Error("Missing RingCentral JWT/client credentials");
  }

  const cacheKey = rcCredentialCacheKey({ jwtToken, clientId, clientSecret });
  const cached = readCachedRcToken(cacheKey);
  if (cached) return cached.accessToken;

  const lock = await acquireRcTokenCacheLock(cacheKey);
  if (lock?.cached) return lock.cached.accessToken;

  try {
    const refreshed = readCachedRcToken(cacheKey);
    if (refreshed) return refreshed.accessToken;

    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

    const stale = readCachedRcToken(cacheKey, { allowNearExpiry: true });
    const canTryRefresh =
      String(process.env.EX_LIVE_MONITOR_REFRESH_TOKEN_CACHE || "true").trim().toLowerCase() !== "false" &&
      hasCachedRefreshToken(stale);
    if (canTryRefresh) {
      const refreshBody = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: stale.refreshToken,
      });
      let refreshLastText = "";
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const { response, text, json } = await requestRcOauthToken({ basic, body: refreshBody });
        refreshLastText = text;
        if (response.ok) {
          const entry = tokenEntryFromOauthJson(json, stale);
          entry.refreshedWith = "refresh_token";
          writeCachedRcToken(cacheKey, entry);
          return entry.accessToken;
        }
        if (response.status !== 429) break;
        const nearExpiry = readCachedRcToken(cacheKey, { allowNearExpiry: true });
        if (nearExpiry) return nearExpiry.accessToken;
        const retryAfter = Number(response.headers.get("retry-after"));
        const delayMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : 5000 + attempt * 5000;
        await sleep(delayMs);
      }
      if (/invalid[_ -]?grant|refresh token/i.test(refreshLastText)) {
        // Rotated/revoked refresh token. Fall back to the JWT assertion below
        // while still keeping this path single-process via the cache lock.
      }
    }

    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwtToken,
    });
    let lastText = "";
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const { response, text, json } = await requestRcOauthToken({ basic, body });
      lastText = text;
      if (response.ok) {
        const entry = tokenEntryFromOauthJson(json);
        entry.refreshedWith = "jwt";
        writeCachedRcToken(cacheKey, entry);
        return entry.accessToken;
      }
      if (response.status !== 429 || attempt >= 3) {
        throw new Error(`RC OAuth failed: ${response.status} ${text.slice(0, 300)}`);
      }
      const nearExpiry = readCachedRcToken(cacheKey, { allowNearExpiry: true });
      if (nearExpiry) return nearExpiry.accessToken;
      const retryAfter = Number(response.headers.get("retry-after"));
      const delayMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : 3000 + attempt * 3000;
      await sleep(delayMs);
    }
    throw new Error(`RC OAuth failed after retry: ${lastText.slice(0, 300)}`);
  } finally {
    lock?.release?.();
  }
}

async function rcRequest(token, method, endpoint, body) {
  const response = await fetch(`${RC_BASE}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "TagContactBridgeParallel-ex-live-monitor-oneoff/0.1",
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  if (!response.ok) {
    throw new Error(`${method} ${endpoint} failed: ${response.status} ${text.slice(0, 500)}`);
  }
  return json;
}

async function resolveExtension(token, extensionNumber) {
  for (let page = 1; page <= 20; page += 1) {
    const data = await rcRequest(token, "GET", `/restapi/v1.0/account/~/extension?perPage=200&page=${page}`);
    const records = Array.isArray(data?.records) ? data.records : [];
    const hit = records.find((record) => String(record.extensionNumber || "") === String(extensionNumber));
    if (hit) return hit;
    if (records.length < 200) break;
  }
  return null;
}

async function cleanupSupervisorParties({
  token,
  telephonySessionId,
  session,
  supervisorExtensionId,
}) {
  if (!supervisorExtensionId || !session?.parties?.length) return [];
  const staleParties = session.parties
    .filter((party) => party?.id && isLiveParty(party) && partyHasExtensionId(party, supervisorExtensionId));
  const cleaned = [];
  for (const party of staleParties) {
    const endpoint = `/restapi/v1.0/account/~/telephony/sessions/${encodeURIComponent(telephonySessionId)}/parties/${encodeURIComponent(party.id)}`;
    try {
      await rcRequest(token, "DELETE", endpoint);
      cleaned.push({ ...summarizePartyForLog(party), cleanupStatus: "deleted" });
    } catch (error) {
      cleaned.push({ ...summarizePartyForLog(party), cleanupStatus: "error", error: cleanText(error.message, 240) });
    }
  }
  return cleaned;
}

async function superviseActiveCall({
  lookupToken,
  superviseToken,
  agentExtensionId,
  supervisorExtensionId,
  supervisorDeviceId,
  partyMode = "session",
  callPickMode = "newest",
  callStartAfterMs = 0,
}) {
  const active = await rcRequest(
    lookupToken,
    "GET",
    `/restapi/v1.0/account/~/extension/${agentExtensionId}/active-calls?view=Detailed`,
  );
  const records = Array.isArray(active?.records) ? active.records : [];
  const orderedCalls = orderActiveCallCandidates(records, callPickMode);
  const skippedCalls = [];
  let call = null;
  let session = null;
  for (const candidate of orderedCalls) {
    if (!candidate?.telephonySessionId) continue;
    const candidateTime = Date.parse(candidate.startTime || candidate.creationTime || candidate.enqueueTime || "") || 0;
    if (callStartAfterMs && candidateTime && candidateTime < callStartAfterMs) {
      skippedCalls.push({
        telephonySessionId: candidate.telephonySessionId,
        result: candidate.result || null,
        startTime: candidate.startTime || candidate.creationTime || null,
        reason: "started before this monitor attempt",
      });
      continue;
    }
    const candidateSession = await rcRequest(
      lookupToken,
      "GET",
      `/restapi/v1.0/account/~/telephony/sessions/${encodeURIComponent(candidate.telephonySessionId)}`,
    );
    const liveParties = Array.isArray(candidateSession?.parties)
      ? candidateSession.parties.filter(isLiveParty)
      : [];
    if (liveParties.length) {
      call = candidate;
      session = candidateSession;
      break;
    }
    skippedCalls.push({
      telephonySessionId: candidate.telephonySessionId,
      result: candidate.result || null,
      startTime: candidate.startTime || candidate.creationTime || null,
      reason: "all parties disconnected",
    });
  }
  if (!call?.telephonySessionId) {
    const skippedText = skippedCalls.length ? `; skipped stale sessions: ${JSON.stringify(skippedCalls).slice(0, 400)}` : "";
    throw new Error(`No live agent telephonySessionId found. Start a live call/hold session first${skippedText}.`);
  }

  let endpoint = `/restapi/v1.0/account/~/telephony/sessions/${encodeURIComponent(call.telephonySessionId)}/supervise`;
  let pickedParty = null;
  let cleanedSupervisorParties = [];
  if (supervisorExtensionId) {
    cleanedSupervisorParties = await cleanupSupervisorParties({
      token: superviseToken,
      telephonySessionId: call.telephonySessionId,
      session,
      supervisorExtensionId,
    });
    if (cleanedSupervisorParties.some((item) => item.cleanupStatus === "deleted")) {
      await sleep(1000);
      session = await rcRequest(
        lookupToken,
        "GET",
        `/restapi/v1.0/account/~/telephony/sessions/${encodeURIComponent(call.telephonySessionId)}`,
      );
    }
  }
  if (partyMode && partyMode !== "session" && partyMode !== "mixed") {
    session = session || await rcRequest(
      lookupToken,
      "GET",
      `/restapi/v1.0/account/~/telephony/sessions/${encodeURIComponent(call.telephonySessionId)}`,
    );
    pickedParty = pickParty(session, agentExtensionId, partyMode);
    if (!pickedParty?.id) {
      throw new Error(`No ${partyMode} party found on telephonySessionId ${call.telephonySessionId}`);
    }
    endpoint = `/restapi/v1.0/account/~/telephony/sessions/${encodeURIComponent(call.telephonySessionId)}/parties/${encodeURIComponent(pickedParty.id)}/supervise`;
  }

  const body = {
    mode: "Listen",
    supervisorDeviceId: String(supervisorDeviceId),
    agentExtensionId: String(agentExtensionId),
  };
  let usedBody = body;
  let response;
  try {
    response = await rcRequest(superviseToken, "POST", endpoint, body);
  } catch (error) {
    const agentExtensionRejected = /agentExtensionId|CMN-10[12]/i.test(String(error?.message || ""));
    if (!agentExtensionRejected) throw error;
    usedBody = {
      mode: "Listen",
      supervisorDeviceId: String(supervisorDeviceId),
    };
    try {
      response = await rcRequest(superviseToken, "POST", endpoint, usedBody);
    } catch (fallbackError) {
      const sessionEndpointRejected = !pickedParty && /agentExtensionId|CMN-10[12]/i.test(String(fallbackError?.message || ""));
      if (!sessionEndpointRejected) throw fallbackError;
      const session = await rcRequest(
        lookupToken,
        "GET",
        `/restapi/v1.0/account/~/telephony/sessions/${encodeURIComponent(call.telephonySessionId)}`,
      );
      pickedParty = pickParty(session, agentExtensionId, "agent");
      if (!pickedParty?.id) throw fallbackError;
      endpoint = `/restapi/v1.0/account/~/telephony/sessions/${encodeURIComponent(call.telephonySessionId)}/parties/${encodeURIComponent(pickedParty.id)}/supervise`;
      response = await rcRequest(superviseToken, "POST", endpoint, usedBody);
    }
  }

  return {
    telephonySessionId: call.telephonySessionId,
    pickedCall: {
      id: call.id || null,
      startTime: call.startTime || call.creationTime || null,
      result: call.result || null,
      direction: call.direction || null,
    },
    skippedCalls,
    partyMode,
    pickedParty: pickedParty ? summarizePartyForLog(pickedParty) : null,
    cleanedSupervisorParties,
    request: usedBody,
    response,
  };
}

const LIVE_AGENT_ADVICE_TOOL = {
  name: "submit_live_agent_advice",
  description: "Submit compact live call advice for the agent UI.",
  input_schema: {
    type: "object",
    required: [
      "phase",
      "confidence",
      "oneSentenceFocus",
      "tips",
      "suggestedMoves",
      "listenFor",
      "riskFlags",
      "nextBestQuestion",
      "suggestedDraft",
    ],
    properties: {
      phase: {
        type: "object",
        required: ["key", "label", "reason"],
        properties: {
          key: { type: "string", enum: PHASE_KEYS },
          label: { type: "string" },
          reason: { type: "string" },
        },
      },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      oneSentenceFocus: { type: "string" },
      tips: {
        type: "array",
        minItems: 2,
        maxItems: 4,
        items: { type: "string" },
      },
      suggestedMoves: {
        type: "array",
        minItems: 2,
        maxItems: 4,
        items: { type: "string" },
      },
      listenFor: {
        type: "array",
        minItems: 2,
        maxItems: 4,
        items: { type: "string" },
      },
      riskFlags: {
        type: "array",
        maxItems: 4,
        items: { type: "string" },
      },
      nextBestQuestion: { type: "string" },
      suggestedDraft: {
        type: "string",
        description: "One short line the agent could say next. Leave empty when not enough signal.",
      },
    },
  },
};

const LIVE_SPEAKER_LABEL_TOOL = {
  name: "submit_speaker_labels",
  description: "Label a short mixed call-transcript chunk by likely speaker.",
  input_schema: {
    type: "object",
    required: ["segments"],
    properties: {
      segments: {
        type: "array",
        minItems: 1,
        maxItems: 8,
        items: {
          type: "object",
          required: ["speaker", "text", "confidence", "reason"],
          properties: {
            speaker: { type: "string", enum: SPEAKER_KEYS },
            text: { type: "string" },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            reason: { type: "string" },
          },
        },
      },
    },
  },
};

const LIVE_SEMANTIC_GLUE_TOOL = {
  name: "submit_semantic_glue_decision",
  description: "Decide whether a newly published transcript turn should be merged into the previous displayed turn.",
  input_schema: {
    type: "object",
    required: ["action", "confidence", "reason", "revisedPreviousText"],
    properties: {
      action: { type: "string", enum: ["keep_separate", "append_previous"] },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      reason: { type: "string" },
      revisedPreviousText: {
        type: "string",
        description: "If action=append_previous, return the previous turn plus the new continuation as one cleaned thought. Otherwise return the original previous text.",
      },
    },
  },
};

const LIVE_SEMANTIC_TURNS_TOOL = {
  name: "submit_semantic_turns",
  description: "Convert raw streaming STT fragments into complete display turns and compact call memory.",
  input_schema: {
    type: "object",
    required: ["completeTurns", "remainingText", "callMemory", "reason"],
    properties: {
      completeTurns: {
        type: "array",
        maxItems: 4,
        items: {
          type: "object",
          required: ["speaker", "text", "confidence", "reason"],
          properties: {
            speaker: { type: "string", enum: SPEAKER_KEYS },
            text: { type: "string" },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            reason: { type: "string" },
          },
        },
      },
      remainingText: {
        type: "string",
        description: "Unpublished tail that is not yet a complete thought. Keep only what is needed to finish the next turn.",
      },
      revisePrevious: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["none", "replace_previous", "append_previous"] },
          text: { type: "string" },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          reason: { type: "string" },
        },
      },
      callMemory: {
        type: "string",
        description: "Compact rolling call memory for advice. Keep it factual and under the requested character budget.",
      },
      reason: { type: "string" },
    },
  },
};

function buildSpeakerLabelPrompt({ chunkText, recentSegments, metadata }) {
  const prior = (recentSegments || [])
    .slice(-20)
    .map((segment) => `${segment.speaker}: ${segment.text}`)
    .join("\n");
  const callFlow = normalizeCallFlow(metadata?.callFlow);
  const initialHumanSpeaker = normalizeInitialHumanSpeaker(metadata?.initialHumanSpeaker, callFlow);
  return [
    "You are labeling speaker turns in a live tax-resolution sales call transcript.",
    "The audio source is a single RingEX supervision leg, so the transcript may be mixed mono and may include the agent, the prospect/client, hold prompts, voicemail prompts, or system audio.",
    "Do not invent precision. Split the chunk only when the words clearly change speaker.",
    `Call flow: ${callFlow}. For outbound calls, the first non-system human voice after hold/connection is usually the prospect answering.`,
    `Initial human speaker bias: ${initialHumanSpeaker}. Keep speaker inertia across short fragments; switch speakers only when the words clearly prove a turn change.`,
    "Prefer complete sentence-level speaker turns. If a chunk is just a stutter or half-sentence, keep it with the previous human speaker unless a greeting, company intro, or question clearly starts a new turn.",
    "Use speaker=agent for the Tax Advocate Group/Wynn representative.",
    "Use speaker=prospect for the person being called on the cell/client side.",
    "Use speaker=system for RingCentral/CX prompts, hold messages, voicemail greetings, beep instructions, or automated call audio.",
    "Use speaker=unknown when there is not enough evidence.",
    "Short fragments are okay. Keep the original wording, lightly cleaned.",
    "",
    `Metadata: ${JSON.stringify(metadata || {})}`,
    "",
    "Recent labeled context:",
    prior || "(none)",
    "",
    "New raw transcript chunk:",
    chunkText,
  ].join("\n");
}

async function labelSpeakerSegments({ chunkText, recentSegments, metadata, model, timeoutMs }) {
  const client = createAnthropicClient();
  const prompt = buildSpeakerLabelPrompt({ chunkText, recentSegments, metadata });
  const raw = await client.createMessage({
    system: "Output strictly via submit_speaker_labels. No free text.",
    messages: [{ role: "user", content: prompt }],
    model,
    maxTokens: 700,
    temperature: 0,
    tools: [LIVE_SPEAKER_LABEL_TOOL],
    toolChoice: { type: "tool", name: "submit_speaker_labels" },
    timeoutMs,
  });
  const toolUse = client.extractToolUse(raw, "submit_speaker_labels");
  if (!toolUse?.input) {
    throw new Error("Claude did not return submit_speaker_labels");
  }
  const segments = stabilizeSpeakerSegments(
    normalizeSpeakerSegments(toolUse.input, chunkText),
    { recentSegments, metadata },
  );
  return {
    segments,
    model: raw?.model || model,
    usage: raw?.usage || null,
  };
}

function normalizeSemanticGlueDecision(input = {}, previousText = "") {
  const action = input.action === "append_previous" ? "append_previous" : "keep_separate";
  return {
    action,
    confidence: clampNumber(input.confidence, 0, 1, 0),
    reason: cleanText(input.reason, 220),
    revisedPreviousText: cleanText(input.revisedPreviousText || previousText, 3000),
  };
}

function labeledEntryText(entry = {}) {
  if (Array.isArray(entry.speakerSegments) && entry.speakerSegments.length) {
    return entry.speakerSegments
      .map((segment) => `${segment.speaker}: ${segment.text}`)
      .join(" | ");
  }
  return cleanText(entry.text, 2000);
}

function buildSemanticGluePrompt({ previousEntry, currentEntry, recentEntries, metadata }) {
  const recent = (recentEntries || [])
    .slice(-6)
    .map((entry) => `[${entry.at || ""}] ${labeledEntryText(entry)}`)
    .join("\n");
  return [
    "You are cleaning a live transcript display for a tax-resolution sales call.",
    "The UI publishes quickly after short pauses. Sometimes a speaker pauses to think, then continues the same thought, so the second row should be appended back into the prior row.",
    "Your job is only to decide whether the newest row belongs appended to the immediately previous displayed row.",
    "",
    "Append only when the newest row is clearly the same speaker continuing the same idea after a pause.",
    "Examples to append:",
    "- previous: I owe a lot for 2026. / newest: I think my business was the problem.",
    "- previous: I got behind after switching jobs. / newest: Then the IRS sent another notice.",
    "- previous: We review the balance and filing status. / newest: Then we look at what options fit.",
    "",
    "Keep separate for normal back-and-forth, greetings, answers to questions, new questions, company intros, objections, yes/no replies, or likely speaker changes.",
    "Do not rewrite meaning. Light punctuation cleanup is fine. Do not add words that were not said.",
    "",
    `Metadata: ${JSON.stringify(metadata || {})}`,
    "",
    "Recent context, oldest first:",
    recent || "(none)",
    "",
    "Previous displayed row:",
    previousEntry?.text || "",
    "",
    "Newest displayed row:",
    currentEntry?.text || "",
  ].join("\n");
}

async function runSemanticGlueDecision({ previousEntry, currentEntry, recentEntries, metadata, model, timeoutMs }) {
  const client = createAnthropicClient();
  const prompt = buildSemanticGluePrompt({ previousEntry, currentEntry, recentEntries, metadata });
  const raw = await client.createMessage({
    system: "Output strictly via submit_semantic_glue_decision. No free text.",
    messages: [{ role: "user", content: prompt }],
    model,
    maxTokens: 500,
    temperature: 0,
    tools: [LIVE_SEMANTIC_GLUE_TOOL],
    toolChoice: { type: "tool", name: "submit_semantic_glue_decision" },
    timeoutMs,
  });
  const toolUse = client.extractToolUse(raw, "submit_semantic_glue_decision");
  if (!toolUse?.input) {
    throw new Error("Claude did not return submit_semantic_glue_decision");
  }
  return {
    ...normalizeSemanticGlueDecision(toolUse.input, previousEntry?.text || ""),
    model: raw?.model || model,
    usage: raw?.usage || null,
  };
}

function normalizeSemanticTurnDecision(input = {}, fallbackMemory = "", maxMemoryChars = 2400) {
  const completeTurns = (Array.isArray(input.completeTurns) ? input.completeTurns : [])
    .map((turn) => {
      const rawSpeaker = String(turn?.speaker || "").trim().toLowerCase();
      const speaker = SPEAKER_KEYS.includes(rawSpeaker) ? rawSpeaker : "unknown";
      const text = cleanText(turn?.text || "", 1400);
      if (!text) return null;
      return {
        speaker,
        text,
        confidence: clampNumber(turn?.confidence, 0, 1, 0.45),
        reason: cleanText(turn?.reason || "", 180),
      };
    })
    .filter(Boolean)
    .slice(0, 4);
  const reviseRaw = input.revisePrevious && typeof input.revisePrevious === "object"
    ? input.revisePrevious
    : {};
  const reviseAction = ["replace_previous", "append_previous"].includes(reviseRaw.action)
    ? reviseRaw.action
    : "none";
  return {
    completeTurns,
    remainingText: cleanText(input.remainingText || "", 2200),
    revisePrevious: {
      action: reviseAction,
      text: cleanText(reviseRaw.text || "", 2400),
      confidence: clampNumber(reviseRaw.confidence, 0, 1, 0),
      reason: cleanText(reviseRaw.reason || "", 220),
    },
    callMemory: cleanText(input.callMemory || fallbackMemory, maxMemoryChars),
    reason: cleanText(input.reason || "", 220),
  };
}

function parseJsonLoose(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

function extractOpenAiResponsesText(payload) {
  if (typeof payload?.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }
  const chunks = [];
  const output = Array.isArray(payload?.output) ? payload.output : [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const block of content) {
      if (typeof block?.text === "string") chunks.push(block.text);
      if (typeof block?.output_text === "string") chunks.push(block.output_text);
    }
  }
  return chunks.join("\n").trim();
}

function isLikelyDanglingSemanticTurn(text) {
  const clean = cleanText(text, 500);
  if (!clean) return true;
  if (/[.?!]["')\]]*$/.test(clean)) {
    if (/\.\.\.["')\]]*$/.test(clean)) return true;
    return false;
  }
  if (/[,;:\-]$/.test(clean)) return true;
  if (/\.\.\.["')\]]*$/.test(clean)) return true;
  const lastWord = clean
    .toLowerCase()
    .replace(/[^a-z0-9']+$/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .pop();
  return new Set([
    "a",
    "an",
    "and",
    "are",
    "as",
    "at",
    "because",
    "but",
    "by",
    "for",
    "from",
    "if",
    "in",
    "into",
    "is",
    "of",
    "on",
    "or",
    "so",
    "that",
    "the",
    "to",
    "was",
    "we",
    "were",
    "with",
    "your",
  ]).has(lastWord);
}

function trimFromLeft(text, maxChars) {
  const clean = cleanText(text, Math.max(maxChars * 2, maxChars));
  if (!clean || clean.length <= maxChars) return clean;
  return clean.slice(clean.length - maxChars).replace(/^\S+\s+/, "").trim();
}

function buildSemanticTurnsPrompt({
  bufferText,
  newText,
  recentEntries,
  callMemory,
  metadata,
  flushReason,
  maxBufferChars,
  maxMemoryChars,
}) {
  const recent = (recentEntries || [])
    .slice(-10)
    .map((entry) => `[${entry.at || ""}] ${labeledEntryText(entry)}`)
    .join("\n");
  return [
    "You are a live semantic transcript assembler for a tax-resolution sales call.",
    "Raw STT arrives every couple seconds and is often partial, duplicated, or split in the middle of a thought.",
    "Your job is to decide what should be shown to the agent UI now.",
    "",
    "Rules:",
    "- Publish completeTurns only for complete thoughts, sentence-like units, or short standalone replies that are useful in a live call transcript.",
    "- Keep incomplete fragments in remainingText. The next raw chunk will include that tail again.",
    "- Do not publish hold prompts, voicemail boilerplate, music, silence, or RingCentral system audio as human call content. Keep brief system notes only when operationally useful.",
    "- If the newest raw words obviously complete or correct the immediately previous displayed row, use revisePrevious instead of creating a separate row.",
    "- Do not invent words. Light punctuation and duplicate cleanup are okay.",
    "- Prefer snappy completion over perfect grammar, but do not emit dangling fragments.",
    "- Prefer fewer, more coherent rows over many tiny rows. When multiple fragments belong to the same speaker and idea, combine them into one complete turn.",
    "- Do not publish tiny backchannels like 'right', 'okay', 'yeah', or 'mm-hmm' as their own row unless they are the meaningful answer to a question or mark a clear speaker handoff.",
    "- Never publish text ending with ellipses, a trailing article/preposition/conjunction, or an obviously unfinished phrase. Keep it in remainingText.",
    "- Keep callMemory current and compact. It should summarize consumed useful call facts for coaching, not repeat the full transcript.",
    `- Keep remainingText under ${maxBufferChars} characters and callMemory under ${maxMemoryChars} characters.`,
    "",
    `Metadata: ${JSON.stringify(metadata || {})}`,
    `Flush reason: ${flushReason || "interval"}`,
    "",
    "Rolling call memory:",
    callMemory || "(none yet)",
    "",
    "Recent displayed transcript:",
    recent || "(none yet)",
    "",
    "Previously unpublished buffer:",
    bufferText || "(empty)",
    "",
    "New raw STT chunk:",
    newText,
  ].join("\n");
}

async function runSemanticTurnDecision({
  bufferText,
  newText,
  recentEntries,
  callMemory,
  metadata,
  flushReason,
  provider = "anthropic",
  model,
  serviceTier = "",
  timeoutMs,
  maxBufferChars,
  maxMemoryChars,
}) {
  const prompt = buildSemanticTurnsPrompt({
    bufferText,
    newText,
    recentEntries,
    callMemory,
    metadata,
    flushReason,
    maxBufferChars,
    maxMemoryChars,
  });
  if (provider === "openai") {
    const apiKey = process.env.OPENAI_API_KEY || "";
    if (!apiKey) throw new Error("OPENAI_API_KEY is missing");
    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => abortController.abort(), Math.max(Number(timeoutMs) || 12000, 1000));
    let response;
    try {
      const body = {
        model,
        instructions: [
          "Return only valid JSON matching this schema:",
          JSON.stringify(LIVE_SEMANTIC_TURNS_TOOL.input_schema),
          "No markdown. No prose outside the JSON object.",
        ].join("\n"),
        input: [{ role: "user", content: prompt }],
        max_output_tokens: 1000,
        temperature: 0,
      };
      if (serviceTier) body.service_tier = serviceTier;
      response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: abortController.signal,
      });
    } finally {
      clearTimeout(timeoutHandle);
    }
    const rawText = await response.text();
    const payload = parseJsonLoose(rawText) || { rawText };
    if (!response.ok) {
      throw new Error(`OpenAI semantic turn failed: ${response.status} ${rawText.slice(0, 500)}`);
    }
    const outputText = extractOpenAiResponsesText(payload);
    const parsed = parseJsonLoose(outputText);
    if (!parsed) {
      throw new Error(`OpenAI semantic turn returned non-JSON: ${outputText.slice(0, 300)}`);
    }
    return {
      ...normalizeSemanticTurnDecision(parsed, callMemory, maxMemoryChars),
      provider: "openai",
      model: payload?.model || model,
      serviceTier: payload?.service_tier || serviceTier || null,
      usage: payload?.usage || null,
    };
  }

  const client = createAnthropicClient();
  const raw = await client.createMessage({
    system: "Output strictly via submit_semantic_turns. No free text.",
    messages: [{ role: "user", content: prompt }],
    model,
    maxTokens: 1200,
    temperature: 0,
    tools: [LIVE_SEMANTIC_TURNS_TOOL],
    toolChoice: { type: "tool", name: "submit_semantic_turns" },
    timeoutMs,
  });
  const toolUse = client.extractToolUse(raw, "submit_semantic_turns");
  if (!toolUse?.input) {
    throw new Error("Claude did not return submit_semantic_turns");
  }
  return {
    ...normalizeSemanticTurnDecision(toolUse.input, callMemory, maxMemoryChars),
    provider: "anthropic",
    model: raw?.model || model,
    serviceTier: null,
    usage: raw?.usage || null,
  };
}

function buildAdvicePrompt({ transcripts, metadata }) {
  const recent = transcripts.slice(-16);
  const memory = cleanText(metadata?.conversationSummary || metadata?.semanticCallMemory || "", 3000);
  const transcriptText = recent
    .map((entry) => {
      const labeled = Array.isArray(entry.speakerSegments) && entry.speakerSegments.length
        ? entry.speakerSegments.map((segment) => `${segment.speaker}: ${segment.text}`).join(" | ")
        : entry.text;
      return `[${entry.at}] ${labeled}`;
    })
    .join("\n");
  return [
    "You are the live agent-advice brain for a tax-resolution sales call.",
    "The audio comes through a RingEX supervision leg. It may be mono/mixed and may contain the agent, the prospect, hold prompts, or both speakers in the same chunk.",
    "Infer cautiously. Do not pretend to know speaker labels when the transcript does not prove them.",
    "Do the semantic check yourself: decide whether the newest useful content is from the prospect, the agent, system audio, or ambiguous mixed speech.",
    "Only put words in suggestedDraft when the newest actionable content is a prospect/client concern, answer, objection, confusion, or buying signal.",
    "If the newest content is the agent talking, a greeting/setup line, voicemail, hold audio, silence, or unclear mixed audio, leave suggestedDraft empty and give a compact listening/focus note instead.",
    "Your output goes to a tiny side panel beside the call. Keep it short, tactical, and useful while the agent is talking.",
    "Focus on discovery, pain, qualification, trust, next question, and objection handling.",
    "Do not give tax/legal advice, exact program recommendations, fees, timelines, guarantees, or anything the agent should not say.",
    "If the transcript is mostly hold music/system prompts/no real conversation, say to keep listening and leave suggestedDraft empty.",
    "",
    `Monitor metadata: ${JSON.stringify(metadata || {})}`,
    "",
    "Compact call memory:",
    memory || "(none yet)",
    "",
    "Recent transcript, oldest first:",
    transcriptText || "(no usable transcript yet)",
  ].join("\n");
}

function formatTranscriptForCoachMemory(transcripts = [], maxChars = 12000) {
  const rows = (Array.isArray(transcripts) ? transcripts : [])
    .map((entry) => {
      const label = Array.isArray(entry?.speakerSegments) && entry.speakerSegments.length
        ? entry.speakerSegments
          .map((segment) => `${segment.speaker || "unknown"}: ${cleanText(segment.text || "", 900)}`)
          .join(" | ")
        : `unknown: ${cleanText(entry?.text || "", 900)}`;
      return `[${entry?.at || entry?.endedAt || ""}] ${label}`;
    })
    .filter((line) => cleanText(line, 1200));
  return trimFromLeft(rows.join("\n"), maxChars);
}

function buildConversationSummaryPrompt({ transcripts, previousSummary, metadata, maxTranscriptChars }) {
  const transcriptText = formatTranscriptForCoachMemory(transcripts, maxTranscriptChars);
  return [
    "Summarize the live tax-resolution sales call for a real-time coach.",
    "This is background memory only. Be compact, factual, and useful for the next response.",
    "Track the client's IRS/state issue, notices, tax years, balances, unfiled returns, business/payroll/1099 clues, emotional tone, objections, buying signals, and unanswered next questions.",
    "Do not invent facts. Preserve uncertainty when speaker labels or details are unclear.",
    "Keep it under 12 short bullets or 900 words, whichever is shorter.",
    "",
    `Monitor metadata: ${JSON.stringify(metadata || {})}`,
    "",
    "Previous summary:",
    cleanText(previousSummary || "", 2500) || "(none yet)",
    "",
    "Transcript so far, oldest first:",
    transcriptText || "(no usable transcript yet)",
  ].join("\n");
}

async function runConversationSummary({
  transcripts,
  previousSummary,
  metadata,
  provider = "anthropic",
  model,
  serviceTier = "",
  timeoutMs,
  maxTranscriptChars,
  maxSummaryChars,
}) {
  const prompt = buildConversationSummaryPrompt({
    transcripts,
    previousSummary,
    metadata,
    maxTranscriptChars,
  });
  if (provider === "openai") {
    const apiKey = process.env.OPENAI_API_KEY || "";
    if (!apiKey) throw new Error("OPENAI_API_KEY is missing");
    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => abortController.abort(), Math.max(Number(timeoutMs) || 25000, 1000));
    let response;
    try {
      const body = {
        model,
        instructions: "Return only a compact call-memory summary. No preamble.",
        input: [{ role: "user", content: prompt }],
        max_output_tokens: 1200,
        temperature: 0.1,
      };
      if (serviceTier) body.service_tier = serviceTier;
      response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: abortController.signal,
      });
    } finally {
      clearTimeout(timeoutHandle);
    }
    const rawText = await response.text();
    const payload = parseJsonLoose(rawText) || { rawText };
    if (!response.ok) {
      throw new Error(`OpenAI summary failed: ${response.status} ${rawText.slice(0, 500)}`);
    }
    return {
      summary: cleanText(extractOpenAiResponsesText(payload), maxSummaryChars),
      provider: "openai",
      model: payload?.model || model,
      serviceTier: payload?.service_tier || serviceTier || null,
      usage: payload?.usage || null,
    };
  }

  const client = createAnthropicClient();
  const raw = await client.createMessage({
    system: "Return only a compact call-memory summary. No preamble.",
    messages: [{ role: "user", content: prompt }],
    model,
    maxTokens: 1200,
    temperature: 0.1,
    timeoutMs,
  });
  return {
    summary: cleanText(client.extractTextBlocks(raw), maxSummaryChars),
    provider: "anthropic",
    model: raw?.model || model,
    serviceTier: null,
    usage: raw?.usage || null,
  };
}

async function runLiveAdvice({ transcripts, metadata, model, timeoutMs }) {
  const client = createAnthropicClient();
  const prompt = buildAdvicePrompt({ transcripts, metadata });
  const raw = await client.createMessage({
    system: "Output strictly via submit_live_agent_advice. No free text.",
    messages: [{ role: "user", content: prompt }],
    model,
    maxTokens: 900,
    temperature: 0.2,
    tools: [LIVE_AGENT_ADVICE_TOOL],
    toolChoice: { type: "tool", name: "submit_live_agent_advice" },
    timeoutMs,
  });
  const toolUse = client.extractToolUse(raw, "submit_live_agent_advice");
  if (!toolUse?.input) {
    throw new Error("Claude did not return submit_live_agent_advice");
  }
  const coach = normalizeCoachPanel({
    ...toolUse.input,
    provider: "anthropic",
    model: raw?.model || model,
  });
  return {
    coach,
    suggestedDraft: cleanText(toolUse.input.suggestedDraft || "", 240),
    usage: raw?.usage || null,
    model: raw?.model || model,
  };
}

function buildProspectOnlyCoachPrompt({
  prospectText,
  recentTranscripts,
  memory,
  conversationSummary,
  metadata,
  playbook,
  taxJurisdiction,
}) {
  const recent = (recentTranscripts || [])
    .slice(-8)
    .map((entry) => `Prospect: ${cleanText(entry.text, 360)}`)
    .join("\n");
  const jurisdiction = taxJurisdiction || { value: "ambiguous", confidence: "low", reason: "" };
  return [
    "You are a real-time coach for a tax-resolution sales consultation.",
    "The transcript below is assumed to be ONLY the prospect/client speaking. Do not spend tokens identifying the speaker.",
    "Return only the exact short thing the agent should say next. No labels, no JSON, no markdown.",
    "",
    "Rules:",
    "- Keep it to 1-2 agent-sayable sentences.",
    "- Respond to the newest prospect turn, not a generic sales script.",
    "- Be calm, practical, and specific, but sound human.",
    "- If the prospect mentions fear, family, paycheck, business pressure, shame, confusion, or a bad prior experience, briefly acknowledge the human impact before the tactical question.",
    "- Vary acknowledgements; do not mechanically start every answer with 'I understand' or 'That makes sense'.",
    "- Ask one useful next question when discovery is needed.",
    "- Never promise an outcome, program fit, deadline, fee, or tax/legal result.",
    "- Do not wait solely because the transcript is grammatically incomplete. If it contains a tax issue, fear, objection, or useful fact, give a short bridge response or question.",
    "- Return exactly WAIT only for true filler, silence, system noise, or a fragment with no usable intent.",
    "- Follow the local tax jurisdiction exactly. If jurisdiction=irs, do not ask whether it is IRS/state/both unless the prospect's agency language is genuinely vague; ask the next IRS-specific fact. If jurisdiction=state, briefly acknowledge state, then screen for broader IRS/federal symptoms such as IRS balance, federal notices, unfiled years, 1099/self-employment, payroll/941, or missing returns. If jurisdiction=mixed, split IRS and state facts. If jurisdiction=ambiguous or agency language is only 'they/the government/collections/a letter', ask: 'Is this coming from the IRS or the state?'",
    "",
    "Tax anchors:",
    "- CP504, LT11/Letter 1058, levy, bank levy, wage garnishment, lien, and revenue officer contact are urgent collection signals.",
    "- Unfiled returns mean compliance questions matter: which years, income type, IRS substitute returns, and available records.",
    "- Balance due questions need tax type, years, notice/source, income, assets, and ability to pay before suggesting a path.",
    "- Possible resolution paths include filing missing returns, installment agreement, penalty abatement, currently not collectible, offer in compromise, and lien/levy release work, but do not claim fit yet.",
    "",
    "Focused sales and tax reference context:",
    playbook || "(none)",
    "",
    `Local tax jurisdiction: ${jurisdiction.value} (${jurisdiction.confidence}${jurisdiction.reason ? `; ${jurisdiction.reason}` : ""})`,
    "",
    `Monitor metadata: ${JSON.stringify(metadata || {})}`,
    "",
    "Rolling memory:",
    memory || "(none yet)",
    "",
    "Background call summary:",
    conversationSummary || "(none yet)",
    "",
    "Recent prospect-only turns:",
    recent || "(none yet)",
    "",
    "Newest prospect turn:",
    prospectText,
  ].join("\n");
}

async function streamAnthropicText({ prompt, model, maxTokens = 180, temperature = 0.15, timeoutMs = 15000, onDelta }) {
  const client = createAnthropicClient();
  if (!client.config.apiKey) {
    throw new Error("ANTHROPIC_API_KEY is missing");
  }
  const abortController = new AbortController();
  const timeoutHandle = setTimeout(() => abortController.abort(), Math.max(timeoutMs, 1000));
  let response;
  try {
    response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": client.config.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        temperature,
        stream: true,
        system: "Return only the next agent line. No preamble.",
        messages: [{ role: "user", content: prompt }],
      }),
      signal: abortController.signal,
    });
  } catch (error) {
    clearTimeout(timeoutHandle);
    if (error?.name === "AbortError") throw new Error(`streaming coach timed out after ${timeoutMs}ms`);
    throw error;
  }
  clearTimeout(timeoutHandle);

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`streaming coach failed: ${response.status} ${text.slice(0, 300)}`);
  }
  if (!response.body) throw new Error("streaming coach response had no body");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let output = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      if (data && data !== "[DONE]") {
        let event = null;
        try { event = JSON.parse(data); } catch {}
        const delta = event?.type === "content_block_delta" && event?.delta?.type === "text_delta"
          ? String(event.delta.text || "")
          : "";
        if (delta) {
          output += delta;
          onDelta?.(delta, output);
        }
      }
      boundary = buffer.indexOf("\n\n");
    }
  }
  return cleanText(output, 1000);
}

async function streamOpenAiText({ prompt, model, serviceTier = "", maxTokens = 180, timeoutMs = 15000, onDelta }) {
  const apiKey = process.env.OPENAI_API_KEY || "";
  if (!apiKey) throw new Error("OPENAI_API_KEY is missing");

  const abortController = new AbortController();
  const timeoutHandle = setTimeout(() => abortController.abort(), Math.max(timeoutMs, 1000));
  let response;
  try {
    const body = {
      model,
      instructions: "Return only the next agent line. No preamble.",
      input: [{ role: "user", content: prompt }],
      max_output_tokens: maxTokens,
      stream: true,
    };
    if (serviceTier) body.service_tier = serviceTier;
    response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: abortController.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`OpenAI streaming coach failed: ${response.status} ${text.slice(0, 300)}`);
    }
    if (!response.body) throw new Error("OpenAI streaming coach response had no body");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let output = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const eventName = block
          .split("\n")
          .find((line) => line.startsWith("event:"))
          ?.slice(6)
          .trim();
        const data = block
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n");
        if (data && data !== "[DONE]") {
          let event = null;
          try { event = JSON.parse(data); } catch {}
          if (event?.error) {
            throw new Error(`OpenAI streaming coach error: ${event.error.message || JSON.stringify(event.error).slice(0, 240)}`);
          }
          if (event?.type === "response.failed") {
            throw new Error(`OpenAI streaming coach failed: ${event.response?.error?.message || "response.failed"}`);
          }
          const type = event?.type || eventName || "";
          const delta = type === "response.output_text.delta" || eventName === "response.output_text.delta"
            ? String(event?.delta || "")
            : "";
          if (delta) {
            output += delta;
            onDelta?.(delta, output);
          }
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
    return cleanText(output, 1000);
  } catch (error) {
    if (error?.name === "AbortError") throw new Error(`OpenAI streaming coach timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timeoutHandle);
  }
}

function isLowSignalTranscript(text) {
  const clean = cleanText(text, 240).toLowerCase();
  if (!clean) return true;
  if (isPrimerHallucination(text)) return true;
  if (isSystemOnlyTranscript(text)) return true;
  return [
    /^thank you[.!]?$/,
    /^thanks for watching[.!]?$/,
    /^you$/,
    /^uh+$/,
    /^um+$/,
    /^music$/,
    /^silence$/,
  ].some((pattern) => pattern.test(clean));
}

function isSystemOnlyTranscript(text) {
  const clean = normalizeForDedupe(text);
  if (!clean) return false;
  if (isHoldPromptTranscript(clean)) return true;
  return [
    /^please continue( to)? hold$/,
    /^please continue to hold$/,
    /^please continue$/,
    /^continue to hold$/,
    /^your call is important to us$/,
    /^please continue( to hold)? your call is important to us$/,
    /^hold$/,
  ].some((pattern) => pattern.test(clean));
}

function isHoldPromptTranscript(text) {
  const clean = normalizeForDedupe(text);
  if (!clean) return false;
  return [
    /\bplease continue( to)? hold\b/,
    /\bcontinue to hold\b/,
    /\byour call is important( to us)?\b/,
    /\bthank you for holding\b/,
    /\bwe appreciate your patience\b/,
  ].some((pattern) => pattern.test(clean));
}

function hasExactContinueHoldPhrase(text) {
  const clean = normalizeForDedupe(text);
  if (!clean) return false;
  return /\bplease continue to hold\b/.test(clean);
}

function looksLikeIncompleteRealtimeHeard(text) {
  const cleaned = cleanText(text, 1000);
  if (!cleaned) return false;
  if (isHoldPromptTranscript(cleaned)) return false;
  if (/[.!?]\s*$/.test(cleaned)) return false;
  if (/\.\.\.\s*$/.test(cleaned)) return true;
  if (endsWithDanglingWord(cleaned)) return true;
  const tokens = wordTokens(cleaned);
  if (tokens.length <= 5) return true;
  if (tokens.length <= 10 && startsLikeContinuation(cleaned)) return true;
  return false;
}

function isPrimerHallucination(text) {
  const clean = normalizeForDedupe(text);
  if (!clean) return false;
  const primerTerms = [
    "cp14",
    "cp501",
    "cp503",
    "cp504",
    "lt11",
    "letter 1058",
    "offer in compromise",
    "installment agreement",
    "currently not collectible",
    "notice of federal tax lien",
    "trust fund recovery penalty",
    "form 433",
    "form 2848",
    "irc 6672",
    "nys dtf",
    "cdtfa",
  ];
  const hits = primerTerms.filter((term) => clean.includes(term)).length;
  return hits >= 4 || (/tax group.*cp14.*offer in compromise/.test(clean) && wordTokens(clean).length > 20);
}

function mergeTranscriptFragments(parts) {
  const cleanedParts = (parts || [])
    .map((part) => cleanText(part, 1000))
    .filter(Boolean);
  let merged = "";
  for (const part of cleanedParts) {
    if (!merged) {
      merged = part;
      continue;
    }
    const leftTokens = wordTokens(merged);
    const rightTokens = wordTokens(part);
    const overlap = overlapSuffixPrefix(leftTokens, rightTokens, 8);
    const partWords = part.split(/\s+/).filter(Boolean);
    merged = [merged, partWords.slice(overlap).join(" ")].filter(Boolean).join(" ");
  }
  return merged
    .replace(/\s+([?.!,])/g, "$1")
    .replace(/\s+\.\.\./g, "...")
    .replace(/\.\.\.\s+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isStandaloneShortUtterance(text) {
  const clean = normalizeForDedupe(text);
  return [
    /^hello$/,
    /^hello there$/,
    /^hi$/,
    /^yes$/,
    /^yeah$/,
    /^yep$/,
    /^sorry$/,
    /^no$/,
    /^nope$/,
    /^speaking$/,
    /^who is this$/,
    /^how can i help you$/,
    /^hi [a-z]+$/,
    /^hello [a-z]+$/,
    /^this is [a-z]+$/,
  ].some((pattern) => pattern.test(clean));
}

function endsWithDanglingWord(text) {
  const tokens = wordTokens(text);
  if (!tokens.length) return true;
  const last = tokens[tokens.length - 1];
  return [
    "a",
    "an",
    "and",
    "are",
    "as",
    "because",
    "but",
    "for",
    "if",
    "is",
    "of",
    "or",
    "so",
    "that",
    "the",
    "to",
    "uh",
    "um",
    "we",
    "what",
    "with",
  ].includes(last);
}

function isLikelyCompleteUtterance(text) {
  const cleaned = cleanText(text, 1000);
  if (!cleaned) return false;
  if (isPrimerHallucination(cleaned)) return false;
  if (isStandaloneShortUtterance(cleaned)) return true;
  if (/\.\.\.\s*$/.test(cleaned)) return false;
  if (endsWithDanglingWord(cleaned)) return false;

  const tokens = wordTokens(cleaned);
  if (/[?]\s*$/.test(cleaned)) return tokens.length >= 2;
  if (/[.!]\s*$/.test(cleaned)) return tokens.length >= 4;
  return tokens.length >= 14;
}

function isPublishableSentenceUnit(text) {
  const cleaned = cleanText(text, 1000);
  if (!cleaned) return false;
  if (isLikelyCompleteUtterance(cleaned)) return true;
  if (isStandaloneShortUtterance(cleaned)) return true;
  if (!/[.!?]\s*$/.test(cleaned)) return false;
  if (/\.\.\.\s*$/.test(cleaned)) return false;
  if (endsWithDanglingWord(cleaned)) return false;
  return wordTokens(cleaned).length >= 2;
}

function coalesceShortSentenceUnits(units) {
  const result = [];
  for (let index = 0; index < units.length; index += 1) {
    const unit = cleanText(units[index], 1000);
    if (!unit) continue;
    if (wordTokens(unit).length <= 2 && index + 1 < units.length) {
      const next = cleanText(units[index + 1], 1000);
      if (next) {
        result.push(`${unit} ${next}`);
        index += 1;
        continue;
      }
    }
    result.push(unit);
  }
  return result;
}

function splitCompleteTranscriptUnits(text) {
  const cleaned = cleanText(text, 2000);
  if (!cleaned) return { sentences: [], tail: "" };

  const rawUnits = [];
  let start = 0;
  for (let index = 0; index < cleaned.length; index += 1) {
    const char = cleaned[index];
    if (char !== "." && char !== "?" && char !== "!") continue;
    if (char === "." && cleaned.slice(index, index + 3) === "...") {
      index += 2;
      continue;
    }
    const next = cleaned[index + 1] || "";
    if (next && !/\s/.test(next)) continue;
    const unit = cleanText(cleaned.slice(start, index + 1), 1000);
    if (unit) rawUnits.push(unit);
    start = index + 1;
  }

  const trailingTail = cleanText(cleaned.slice(start), 1000);
  const sentences = [];
  const blockedTail = [];
  for (const unit of coalesceShortSentenceUnits(rawUnits)) {
    if (!blockedTail.length && isPublishableSentenceUnit(unit)) {
      sentences.push(unit);
    } else {
      blockedTail.push(unit);
    }
  }

  return {
    sentences,
    tail: cleanText([...blockedTail, trailingTail].filter(Boolean).join(" "), 1000),
  };
}

function shouldPublishIncompleteTranscript(text, holdExpired) {
  const cleaned = cleanText(text, 1000);
  if (!cleaned || isPrimerHallucination(cleaned)) return false;
  if (/\.\.\.\s*$/.test(cleaned)) return false;
  if (endsWithDanglingWord(cleaned)) return false;
  const tokens = wordTokens(cleaned);
  return tokens.length >= 22 || (holdExpired && tokens.length >= 6);
}

function startsLikeContinuation(text) {
  const clean = normalizeForDedupe(text);
  if (!clean) return false;
  return [
    /^(and|but|because|that|which|while|although|though)\b/,
    /^(to|for|from|with|about|into|onto|through|under|over|at|by|as|than)\b/,
    /^(the|a|an) (irs|state|letter|notice|payment|balance|levy|lien|garnishment)\b/,
  ].some((pattern) => pattern.test(clean));
}

function hasNewTurnOpening(text) {
  const clean = normalizeForDedupe(text);
  if (!clean) return false;
  return [
    /^(hello|hi|hey|yes|yeah|no|nope|okay|ok|sorry|speaking)\b/,
    /^(what|why|how|when|where|who|can|could|do|does|did|is|are|will|would|should)\b/,
    /^(this is|my name is|all right|alright|so what happened|what happened was)\b/,
    /^i (owe|need|got|have|received|was wondering|wanted|called|think|know|didn't|did not|haven't|have not|can't|cannot)\b/,
    /^we (are|help|can|do|need|work)\b/,
  ].some((pattern) => pattern.test(clean));
}

function looksLikeStrayTranscriptFragment(text) {
  const cleaned = cleanText(text, 1000);
  if (!cleaned || isStandaloneShortUtterance(cleaned) || hasNewTurnOpening(cleaned)) return false;
  const tokens = wordTokens(cleaned);
  if (startsLikeContinuation(cleaned)) return true;
  if (tokens.length <= 5 && !/[?]\s*$/.test(cleaned)) return true;
  return tokens.length <= 8 && endsWithDanglingWord(cleaned);
}

function joinTranscriptContinuation(previousText, continuationText) {
  const left = cleanText(previousText, 1600).replace(/[.!?]\s*$/, "");
  const right = cleanText(continuationText, 1000);
  return cleanText(`${left} ${right}`, 2000);
}

function shouldRepairIntoPrevious(displayTranscript, previousEntry, now = Date.now()) {
  if (!previousEntry || !displayTranscript?.text) return false;
  if (isPrimerHallucination(displayTranscript.text)) return false;
  if (isSystemOnlyTranscript(displayTranscript.text)) return false;
  const previousEndedAt = Date.parse(previousEntry.endedAt || previousEntry.at || "") || 0;
  if (previousEndedAt && now - previousEndedAt > 15_000) return false;
  if (!looksLikeStrayTranscriptFragment(displayTranscript.text)) return false;
  const combinedTokens = wordTokens(`${previousEntry.text || ""} ${displayTranscript.text}`);
  if (combinedTokens.length > 35) return false;
  return true;
}

function wordTokens(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9']+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function normalizeForDedupe(text) {
  return wordTokens(text).join(" ");
}

function removeRepeatedPhraseLoops(text, maxPhraseWords = 6) {
  const tokens = wordTokens(text);
  if (tokens.length < 4) return cleanText(text, 2000);

  for (let size = 1; size <= Math.min(maxPhraseWords, Math.floor(tokens.length / 2)); size += 1) {
    const first = tokens.slice(0, size).join(" ");
    if (!first) continue;
    let index = 0;
    let repeats = 0;
    while (tokens.slice(index, index + size).join(" ") === first) {
      repeats += 1;
      index += size;
    }
    if (repeats >= 3 && index >= tokens.length * 0.65) {
      return first;
    }
  }

  return cleanText(text, 2000);
}

function overlapSuffixPrefix(leftTokens, rightTokens, maxWords = 18) {
  const limit = Math.min(maxWords, leftTokens.length, rightTokens.length);
  for (let size = limit; size >= 2; size -= 1) {
    const left = leftTokens.slice(leftTokens.length - size).join(" ");
    const right = rightTokens.slice(0, size).join(" ");
    if (left && left === right) return size;
  }
  return 0;
}

function removePriorTranscriptEcho(text, priorTexts) {
  let cleaned = cleanText(removeRepeatedPhraseLoops(text), 2000);
  if (!cleaned) return "";

  const normalized = normalizeForDedupe(cleaned);
  const priorNormalized = priorTexts.map(normalizeForDedupe).filter(Boolean);
  if (priorNormalized.includes(normalized)) return "";

  const lastPrior = priorNormalized[priorNormalized.length - 1] || "";
  if (!lastPrior) return cleaned;

  const overlap = overlapSuffixPrefix(lastPrior.split(" "), normalized.split(" "));
  if (overlap > 0) {
    const originalWords = cleaned.split(/\s+/).filter(Boolean);
    cleaned = originalWords.slice(overlap).join(" ");
  }
  return cleanText(cleaned, 2000);
}

function longestCommonTokenRun(leftTokens, rightTokens) {
  const left = Array.isArray(leftTokens) ? leftTokens : [];
  const right = Array.isArray(rightTokens) ? rightTokens : [];
  if (!left.length || !right.length) return 0;
  let best = 0;
  const previous = new Array(right.length + 1).fill(0);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let northWest = 0;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const savedNorth = previous[rightIndex];
      previous[rightIndex] = left[leftIndex - 1] === right[rightIndex - 1]
        ? northWest + 1
        : 0;
      if (previous[rightIndex] > best) best = previous[rightIndex];
      northWest = savedNorth;
    }
  }
  return best;
}

function tokenSetOverlapScore(leftTokens, rightTokens) {
  const left = new Set(leftTokens || []);
  const right = new Set(rightTokens || []);
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }
  return intersection / Math.max(left.size, right.size);
}

function semanticTurnTextRelationship(candidateText, existingText) {
  const candidateTokens = wordTokens(candidateText);
  const existingTokens = wordTokens(existingText);
  if (!candidateTokens.length || !existingTokens.length) return null;

  const candidateNorm = candidateTokens.join(" ");
  const existingNorm = existingTokens.join(" ");
  if (candidateNorm === existingNorm) {
    return { action: "skip", confidence: 1, reason: "exact duplicate semantic turn" };
  }

  const candidateContainsExisting = findTokenSubsequence(candidateTokens, existingTokens) >= 0;
  const existingContainsCandidate = findTokenSubsequence(existingTokens, candidateTokens) >= 0;
  const candidateIsMeaningfullyLonger = candidateTokens.length >= existingTokens.length + 3;
  const existingIsAtLeastAsLong = existingTokens.length >= candidateTokens.length;

  if (candidateContainsExisting && candidateIsMeaningfullyLonger) {
    return { action: "revise", confidence: 0.98, reason: "new semantic turn extends a recent row" };
  }
  if (existingContainsCandidate && existingIsAtLeastAsLong) {
    return { action: "skip", confidence: 0.98, reason: "recent row already contains this semantic turn" };
  }

  const shortest = Math.min(candidateTokens.length, existingTokens.length);
  const longestRun = longestCommonTokenRun(candidateTokens, existingTokens);
  const runCoverage = shortest ? longestRun / shortest : 0;
  const setOverlap = tokenSetOverlapScore(candidateTokens, existingTokens);
  const highOverlap = shortest >= 5 && (runCoverage >= 0.86 || setOverlap >= 0.9);
  if (!highOverlap) return null;

  if (candidateIsMeaningfullyLonger) {
    return { action: "revise", confidence: Math.max(runCoverage, setOverlap), reason: "near-duplicate semantic turn with more complete text" };
  }
  return { action: "skip", confidence: Math.max(runCoverage, setOverlap), reason: "near-duplicate semantic turn" };
}

function findTokenSubsequence(haystackTokens, needleTokens) {
  if (!haystackTokens.length || !needleTokens.length || needleTokens.length > haystackTokens.length) return -1;
  for (let index = 0; index <= haystackTokens.length - needleTokens.length; index += 1) {
    let matched = true;
    for (let offset = 0; offset < needleTokens.length; offset += 1) {
      if (haystackTokens[index + offset] !== needleTokens[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return index;
  }
  return -1;
}

function splitTextByWordCount(text, wordCount) {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean);
  const count = Math.max(0, Number(wordCount) || 0);
  if (!words.length) return { head: "", tail: "" };
  if (count <= 0) return { head: "", tail: cleanText(text, 1000) };
  if (count >= words.length) return { head: cleanText(text, 1000), tail: "" };
  return {
    head: cleanText(words.slice(0, count).join(" "), 1000),
    tail: cleanText(words.slice(count).join(" "), 1000),
  };
}

function splitNativeSegmentByWordCount(segment, wordCount) {
  const { head, tail } = splitTextByWordCount(segment?.text || "", wordCount);
  return {
    head: head ? { ...segment, text: head } : null,
    tail: tail ? { ...segment, text: tail } : null,
  };
}

function sliceNativeSegmentsByWords(nativeSegments, startWord, wordCount = Number.POSITIVE_INFINITY) {
  const output = [];
  let wordsToDrop = Math.max(0, Number(startWord) || 0);
  let wordsToTake = Number.isFinite(Number(wordCount))
    ? Math.max(0, Number(wordCount) || 0)
    : Number.POSITIVE_INFINITY;

  for (const rawSegment of normalizeNativeDiarizeRawSegments(nativeSegments)) {
    if (wordsToTake <= 0) break;
    const segmentWordCount = wordTokens(rawSegment.text).length;
    if (!segmentWordCount) continue;

    let segment = rawSegment;
    let availableWords = segmentWordCount;
    if (wordsToDrop >= availableWords) {
      wordsToDrop -= availableWords;
      continue;
    }
    if (wordsToDrop > 0) {
      const split = splitNativeSegmentByWordCount(segment, wordsToDrop);
      segment = split.tail;
      wordsToDrop = 0;
      if (!segment?.text) continue;
      availableWords = wordTokens(segment.text).length;
    }

    if (Number.isFinite(wordsToTake) && availableWords > wordsToTake) {
      const split = splitNativeSegmentByWordCount(segment, wordsToTake);
      if (split.head?.text) output.push(split.head);
      break;
    }

    output.push(segment);
    wordsToTake -= availableWords;
  }

  return output;
}

function alignNativeSegmentsToTranscriptText(rawSegments, transcriptText) {
  const segments = normalizeNativeDiarizeRawSegments(rawSegments);
  const targetTokens = wordTokens(transcriptText);
  if (!segments.length || !targetTokens.length) return [];

  const combinedTokens = wordTokens(segments.map((segment) => segment.text).join(" "));
  if (!combinedTokens.length) return [];
  if (combinedTokens.length === targetTokens.length) return segments;

  const exactStart = findTokenSubsequence(combinedTokens, targetTokens);
  if (exactStart >= 0) {
    return sliceNativeSegmentsByWords(segments, exactStart, targetTokens.length);
  }

  const targetNormalized = targetTokens.join(" ");
  const combinedNormalized = combinedTokens.join(" ");
  if (combinedNormalized.endsWith(targetNormalized)) {
    return sliceNativeSegmentsByWords(segments, combinedTokens.length - targetTokens.length, targetTokens.length);
  }

  return sliceNativeSegmentsByWords(segments, 0, targetTokens.length);
}

function consumeNativeSegmentsForText(nativeSegments, targetText) {
  const segments = normalizeNativeDiarizeRawSegments(nativeSegments);
  const targetWordCount = wordTokens(targetText).length;
  if (!segments.length || !targetWordCount) {
    return { segments: [], remaining: segments };
  }
  return {
    segments: sliceNativeSegmentsByWords(segments, 0, targetWordCount),
    remaining: sliceNativeSegmentsByWords(segments, targetWordCount),
  };
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function createDashboardHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>EX Live Monitor One-Off</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, Segoe UI, Arial, sans-serif; background: #0d1117; color: #e6edf3; }
    body { margin: 0; }
    header { position: sticky; top: 0; z-index: 2; background: #161b22; border-bottom: 1px solid #30363d; padding: 14px 18px; display: flex; justify-content: space-between; gap: 12px; align-items: center; }
    h1 { font-size: 16px; margin: 0; letter-spacing: 0; }
    .title { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
    .status { font-size: 12px; color: #9da7b3; }
    .toolbar { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; align-items: center; }
    button { border: 1px solid #3b4754; border-radius: 7px; background: #1f6feb; color: #fff; font: inherit; font-size: 12px; font-weight: 600; padding: 8px 11px; cursor: pointer; }
    button.secondary { background: #21262d; color: #e6edf3; }
    button:disabled { opacity: 0.45; cursor: not-allowed; }
    main { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 14px; padding: 14px; }
    section { border: 1px solid #30363d; border-radius: 8px; background: #0f141b; min-height: 180px; }
    h2 { font-size: 13px; margin: 0; padding: 12px 12px 0; color: #9da7b3; font-weight: 600; }
    .list { padding: 10px 12px 14px; display: flex; flex-direction: column; gap: 10px; }
    .row { border: 1px solid #26313d; border-radius: 7px; padding: 10px; background: #111923; }
    .meta { color: #7d8590; font-size: 11px; margin-bottom: 5px; }
    .text { white-space: pre-wrap; line-height: 1.42; font-size: 14px; }
    .focus { font-size: 16px; line-height: 1.35; }
    .pill { display: inline-block; border: 1px solid #3b4754; border-radius: 999px; padding: 2px 8px; color: #9da7b3; font-size: 11px; margin-right: 6px; }
    .chat-pair { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; align-items: start; }
    .bubble { border: 1px solid #303b46; border-radius: 8px; padding: 10px 12px; min-height: 70px; background: #111923; }
    .bubble .label { color: #9da7b3; font-size: 11px; font-weight: 700; letter-spacing: 0; margin-bottom: 6px; text-transform: uppercase; }
    .bubble .body { white-space: pre-wrap; line-height: 1.42; font-size: 15px; }
    .bubble.heard, .bubble.prospect { background: #111d26; border-color: #27445a; }
    .bubble.say, .bubble.agent { background: #182111; border-color: #3b5324; }
    .bubble.feedback { background: #211b12; border-color: #5a4724; }
    .bubble.system, .bubble.unknown, .bubble.empty { background: #151922; border-color: #30363d; color: #9da7b3; }
    .live-card { border-width: 1px 1px 1px 7px; padding: 0; overflow: hidden; background: #101820; }
    .live-card.mode-prospect_response, .history-card.mode-prospect_response { border-left-color: #2f8f4e; }
    .live-card.mode-agent_feedback, .history-card.mode-agent_feedback { border-left-color: #d29922; }
    .live-card.mode-hold, .history-card.mode-hold { border-left-color: #8957e5; }
    .live-card.mode-wait, .live-card.waiting, .history-card.mode-wait { border-left-color: #57606a; }
    .guidance-head { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; padding: 12px 14px 10px; border-bottom: 1px solid #27313c; background: #151c25; }
    .guidance-title { font-size: 12px; font-weight: 800; letter-spacing: 0; text-transform: uppercase; color: #e6edf3; }
    .guidance-help { color: #9da7b3; font-size: 13px; line-height: 1.35; margin-top: 3px; max-width: 720px; }
    .guidance-meta { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; min-width: 140px; }
    .guidance-body { font-size: 26px; line-height: 1.3; padding: 22px 22px 24px; color: #f0f6fc; max-width: 980px; }
    .side-panel { min-height: 120px; }
    .guidance-details { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 8px; padding: 10px 14px 12px; border-top: 1px solid #27313c; background: #0f141b; }
    .guidance-detail { border: 1px solid #27313c; border-radius: 7px; padding: 9px 10px; background: #111923; min-height: 54px; }
    .guidance-detail-label { color: #7d8590; font-size: 10px; font-weight: 800; letter-spacing: 0; text-transform: uppercase; margin-bottom: 5px; }
    .guidance-detail-body { color: #c9d1d9; font-size: 13px; line-height: 1.35; }
    .live-card.mode-prospect_response .guidance-body { background: #101c12; }
    .live-card.mode-agent_feedback .guidance-body { background: #211a10; }
    .live-card.mode-hold .guidance-body { background: #191526; color: #c9d1d9; }
    .live-card.mode-wait .guidance-body, .live-card.waiting .guidance-body { background: #111923; color: #9da7b3; }
    .detail-line { color: #9da7b3; font-size: 12px; line-height: 1.4; padding: 9px 14px 11px; border-top: 1px solid #27313c; background: #0f141b; }
    .history-card { border-left-width: 5px; }
    .turn-meta { color: #7d8590; font-size: 11px; display: flex; flex-wrap: wrap; gap: 7px; margin-bottom: 8px; }
    .coach-feed { gap: 12px; }
    ul { margin: 8px 0 0 18px; padding: 0; }
    li { margin: 5px 0; }
    code { color: #a5d6ff; }
    @media (max-width: 900px) { main { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <header>
    <div class="title">
      <h1>EX Live Monitor One-Off</h1>
      <div class="status" id="gateStatus">coach gate unknown</div>
    </div>
    <div class="toolbar">
      <button id="attachMonitor" class="secondary" type="button">Attach monitor</button>
      <button id="startCoach" type="button" disabled>Start coaching</button>
      <button id="stopCoach" class="secondary" type="button" disabled>Stop coaching</button>
      <div class="status" id="status">connecting...</div>
    </div>
  </header>
  <main>
    <section>
      <h2>Live Guidance</h2>
      <div class="list" id="transcripts"></div>
    </section>
    <section class="side-panel">
      <h2>Events</h2>
      <div class="list" id="events"></div>
    </section>
  </main>
  <script>
    const statusEl = document.getElementById("status");
    const gateStatusEl = document.getElementById("gateStatus");
    const attachMonitorBtn = document.getElementById("attachMonitor");
    const startCoachBtn = document.getElementById("startCoach");
    const stopCoachBtn = document.getElementById("stopCoach");
    const transcriptsEl = document.getElementById("transcripts");
    const eventsEl = document.getElementById("events");
    const esc = (v) => String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    function bubble(kind, label, body) {
      const cleanBody = String(body || "").trim();
      return \`<div class="bubble \${esc(kind || "unknown")}">
        <div class="label">\${esc(label)}</div>
        <div class="body">\${cleanBody ? esc(cleanBody) : '<span class="meta">No usable speech</span>'}</div>
      </div>\`;
    }
    function turnMeta(parts) {
      return \`<div class="turn-meta">\${parts.filter(Boolean).map((part) => \`<span>\${esc(part)}</span>\`).join("")}</div>\`;
    }
    function modeLabel(mode) {
      const clean = String(mode || "").toLowerCase();
      if (clean === "agent_feedback") return "Adjust Current Talk";
      if (clean === "prospect_response" || clean === "coach") return "Proposed Response";
      if (clean === "hold") return "Hold/System";
      return "Waiting";
    }
    function modeHelp(mode) {
      const clean = String(mode || "").toLowerCase();
      if (clean === "agent_feedback") return "Guidance for how to adjust what you are currently saying.";
      if (clean === "prospect_response" || clean === "coach") return "Proposed response based on what the prospect just said to you.";
      if (clean === "hold") return "System or hold audio detected.";
      return "Waiting for a complete, useful thought.";
    }
    function modeBubbleKind(mode, hasText) {
      const clean = String(mode || "").toLowerCase();
      if (!hasText) return "empty";
      if (clean === "agent_feedback") return "feedback";
      if (clean === "hold") return "system";
      return "say";
    }
    function modeClass(mode) {
      const clean = String(mode || "").toLowerCase();
      if (clean === "agent_feedback") return "agent_feedback";
      if (clean === "prospect_response" || clean === "coach") return "prospect_response";
      if (clean === "hold") return "hold";
      return "wait";
    }
    function pill(text) {
      return text ? \`<span class="pill">\${esc(text)}</span>\` : "";
    }
    function guidanceDetails(items) {
      const rows = items
        .filter((item) => item && item.body)
        .map((item) => \`<div class="guidance-detail">
          <div class="guidance-detail-label">\${esc(item.label)}</div>
          <div class="guidance-detail-body">\${esc(item.body)}</div>
        </div>\`);
      return rows.length ? \`<div class="guidance-details">\${rows.join("")}</div>\` : "";
    }
    function renderCoachTurn(turn) {
      const coachOnly = turn.outputMode === "coach-only";
      const label = modeLabel(turn.mode);
      const details = guidanceDetails([
        { label: "Signal", body: turn.signal },
        { label: "Direction", body: turn.direction || modeHelp(turn.mode) },
        { label: "Topic", body: turn.topic },
      ]);
      return \`<div class="row history-card mode-\${modeClass(turn.mode)}">
        \${turnMeta([
          turn.at || "",
          turn.elapsedMs ? \`\${turn.elapsedMs}ms\` : "",
          turn.durationSec ? \`\${turn.durationSec}s\` : "",
          turn.activePctOver500 !== undefined ? \`active \${turn.activePctOver500}%\` : "",
          turn.model || "",
          turn.mode ? \`mode \${turn.mode}\` : "",
          turn.usage?.total_tokens ? \`\${turn.usage.total_tokens} tokens\` : "",
        ])}
        \${coachOnly
          ? \`\${bubble(modeBubbleKind(turn.mode, turn.say), label, turn.say || "WAIT")}\${details}\`
          : \`<div class="chat-pair">
              \${bubble("heard", "Heard", turn.heard)}
              \${bubble(turn.say ? "say" : "empty", "Say Next", turn.say || "WAIT")}
            </div>\`}
      </div>\`;
    }
    function renderLiveSuggestion(live) {
      if (!live?.enabled) return "";
      const sleeping = live.status === "sleeping";
      const hold = live.status === "hold";
      const inputPaused = live.acceptInput === false || hold || sleeping;
      const text = live.text
        || live.finalText
        || (sleeping
          ? "Input paused until the scheduled check."
          : hold
            ? "Exact hold phrase heard. Pausing before the next check."
            : inputPaused
              ? "Input paused."
              : live.status === "streaming"
                ? "Thinking..."
                : "Waiting for useful speech...");
      const mode = hold ? "hold" : live.mode || (text && !/^wait$/i.test(text) ? "prospect_response" : "wait");
      const details = guidanceDetails([
        { label: "Signal", body: live.signal },
        { label: "Direction", body: live.direction || modeHelp(mode) },
        { label: "Topic", body: live.topic },
      ]);
      const status = [
        live.status || "idle",
        live.elapsedMs ? \`\${live.elapsedMs}ms\` : "",
        live.usage?.total_tokens ? \`\${live.usage.total_tokens} tokens\` : "",
      ].filter(Boolean);
      const waiting = !live.text && !live.finalText;
      return \`<div class="row live-card mode-\${modeClass(mode)} \${waiting ? "waiting" : ""}">
        <div class="guidance-head">
          <div>
            <div class="guidance-title">\${esc(modeLabel(mode))}</div>
            <div class="guidance-help">\${esc(modeHelp(mode))}</div>
          </div>
          <div class="guidance-meta">\${status.map(pill).join("")}</div>
        </div>
        <div class="guidance-body">\${esc(text)}</div>
        \${details}
      </div>\`;
    }
    function renderTranscriptEntry(item) {
      const segments = (item.speakerSegments || []).length
        ? item.speakerSegments
        : [{ speaker: "unknown", text: item.text, confidence: 0 }];
      return \`<div class="row">
        \${turnMeta([
          item.at || "",
          item.durationSec ? \`\${item.durationSec}s\` : "",
          item.activePctOver500 !== undefined ? \`active \${item.activePctOver500}%\` : "",
          item.model || "",
          item.responseFormat || "",
          item.speakerStatus || "",
        ])}
        <div class="list coach-feed">\${segments.map((segment) => {
          const speaker = String(segment.speaker || "unknown").toLowerCase();
          const label = [segment.speaker || "unknown", segment.nativeSpeaker].filter(Boolean).join("/") + (segment.confidence ? \` \${Math.round((segment.confidence || 0) * 100)}%\` : "");
          return bubble(speaker, label, segment.text);
        }).join("")}</div>
      </div>\`;
    }
    async function coachGate(path) {
      startCoachBtn.disabled = true;
      stopCoachBtn.disabled = true;
      try {
        const response = await fetch(path, { method: "POST" });
        const result = await response.json().catch(() => ({}));
        if (!response.ok || result.ok === false) {
          gateStatusEl.textContent = result.error || \`gate request failed (\${response.status})\`;
          return;
        }
        const state = await fetch("/api/state").then((r) => r.json());
        render(state);
      } catch (error) {
        gateStatusEl.textContent = error.message || "gate request failed";
      }
    }
    startCoachBtn.addEventListener("click", () => coachGate("/api/coach/start?durationSec=2700&manual=1"));
    stopCoachBtn.addEventListener("click", () => coachGate("/api/coach/stop?reason=manual-coach-stop"));
    attachMonitorBtn.addEventListener("click", () => coachGate("/api/supervise/attach"));
    function render(state) {
      const gate = state.cxGate || {};
      const gateEnabled = Boolean(gate.enabled);
      const gateParts = gateEnabled
        ? [
            \`coach \${gate.active ? "live" : "idle"}\`,
            gate.mode || "",
            gate.currentUii ? \`uii \${gate.currentUii}\` : "",
            gate.lastReason || "",
          ].filter(Boolean)
        : ["coach gate off"];
      if (state.realtimeDirectSleepUntil) {
        gateParts.push(\`sleeping until \${new Date(state.realtimeDirectSleepUntil).toLocaleTimeString()}\`);
        if (state.realtimeDirectSleepReason) gateParts.push(state.realtimeDirectSleepReason);
      }
      gateStatusEl.textContent = gateParts.join(" | ");
      startCoachBtn.disabled = !gateEnabled;
      stopCoachBtn.disabled = !gateEnabled || !gate.active;
      statusEl.textContent = [
        state.status || "unknown",
        state.packetCount ? \`\${state.packetCount} packets\` : "",
        state.byteCount ? \`\${state.byteCount} bytes\` : "",
        state.outputPath ? \`writing \${state.outputPath.split(/[\\\\/]/).pop()}\` : "",
      ].filter(Boolean).join(" | ");
      const live = state.liveSuggestion || {};
      const transcripts = state.transcripts || [];
      const coachTurns = state.realtimeDirectTurns || [];
      const liveHtml = renderLiveSuggestion(live);
      const historyHtml = coachTurns.length
        ? coachTurns.slice(-80).reverse().map(renderCoachTurn).join("")
        : transcripts.length
          ? transcripts.slice(-80).reverse().map(renderTranscriptEntry).join("")
          : '<div class="row"><div class="text">Waiting for usable audio...</div></div>';
      transcriptsEl.innerHTML = liveHtml + historyHtml;
      eventsEl.innerHTML = (state.events || []).slice(-18).reverse().map((item) => \`
        <div class="row"><div class="meta">\${esc(item.at || "")}</div><div class="text">\${esc(item.message || item.type || "")}</div></div>\`).join("");
    }
    fetch("/api/state").then((r) => r.json()).then(render).catch(() => {});
    const events = new EventSource("/events");
    events.onopen = () => { statusEl.textContent = "connected"; };
    events.onerror = () => { statusEl.textContent = "dashboard reconnecting..."; };
    events.addEventListener("state", (event) => render(JSON.parse(event.data)));
  </script>
</body>
</html>`;
}

function createDashboardServer({ port, state, logger }) {
  const clients = new Set();

  function snapshot() {
    return {
      ...state.public,
      transcripts: state.transcripts.slice(-100),
      realtimeDirectTurns: state.realtimeDirectTurns.slice(-100),
      events: state.events.slice(-50),
      advice: state.advice,
    };
  }

  function send(client, event, payload) {
    client.write(`event: ${event}\n`);
    client.write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  const server = http.createServer((req, res) => {
    const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    if (requestUrl.pathname === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      clients.add(res);
      send(res, "state", snapshot());
      req.on("close", () => clients.delete(res));
      return;
    }
    if (requestUrl.pathname === "/api/fake-call/start" || requestUrl.pathname === "/api/coach/start") {
      Promise.resolve(state.actions?.coachStart
        ? state.actions.coachStart({
          durationSec: Number(requestUrl.searchParams.get("durationSec") || requestUrl.searchParams.get("seconds") || 0) || null,
          caseId: requestUrl.searchParams.get("caseId") || null,
          queueItemId: requestUrl.searchParams.get("queueItemId") || null,
          manual: requestUrl.searchParams.get("manual") === "1" || requestUrl.searchParams.get("manual") === "true",
        })
        : { ok: false, error: "coach start action is not available" })
        .then((result) => {
          res.writeHead(result.ok === false ? 409 : 200, { "content-type": "application/json" });
          res.end(JSON.stringify(result));
        })
        .catch((error) => {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: error.message }));
        });
      return;
    }
    if (requestUrl.pathname === "/api/fake-call/stop" || requestUrl.pathname === "/api/coach/stop") {
      const result = state.actions?.fakeCallStop
        ? state.actions.fakeCallStop({ reason: requestUrl.searchParams.get("reason") || "manual-fake-stop" })
        : { ok: false, error: "fake call action is not available" };
      res.writeHead(result.ok === false ? 409 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify(result));
      return;
    }
    if (requestUrl.pathname === "/api/supervise/attach") {
      Promise.resolve(state.actions?.superviseAttachOnce ? state.actions.superviseAttachOnce() : { ok: false, error: "supervise attach action is not available" })
        .then((result) => {
          res.writeHead(result.ok === false ? 409 : 200, { "content-type": "application/json" });
          res.end(JSON.stringify(result));
        })
        .catch((error) => {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: error.message }));
        });
      return;
    }
    if (requestUrl.pathname === "/api/state" || requestUrl.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(snapshot()));
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(createDashboardHtml());
  });

  server.listen(port, "127.0.0.1", () => {
    logger(`dashboard listening on http://127.0.0.1:${port}/`);
  });

  return {
    server,
    broadcast() {
      const payload = snapshot();
      for (const client of clients) send(client, "state", payload);
    },
  };
}

async function publishUiState({ sessionId, controlPlaneUrl, internalSecret, advice, metadata, eventLog }) {
  if (!sessionId) return null;
  if (!internalSecret) {
    writeJsonLine(eventLog, {
      type: "ui_state.skip",
      at: new Date().toISOString(),
      reason: "missing internal secret",
      sessionId,
    });
    return null;
  }
  const url = `${controlPlaneUrl.replace(/\/$/, "")}/api/sales-trainer/session/${encodeURIComponent(sessionId)}/ui-state`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-internal-secret": internalSecret,
    },
    body: JSON.stringify({
      source: "ex-live-monitor-oneoff",
      coach: advice.coach,
      suggestedDraft: advice.suggestedDraft || "",
      metadata,
    }),
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  if (!response.ok) {
    throw new Error(`ui-state publish failed: ${response.status} ${text.slice(0, 300)}`);
  }
  return json?.result || json;
}

function addEvent(state, eventLog, type, message, extra = {}) {
  const event = {
    type,
    message,
    at: new Date().toISOString(),
    ...extra,
  };
  state.events.push(event);
  if (state.events.length > 200) state.events.splice(0, state.events.length - 200);
  writeJsonLine(eventLog, event);
  console.log(`[${type}] ${message}`);
  return event;
}

function coerceRingcxActiveCallList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.records)) return payload.records;
  if (Array.isArray(payload?.content)) return payload.content;
  if (Array.isArray(payload?.activeCalls)) return payload.activeCalls;
  if (Array.isArray(payload?.items)) return payload.items;
  return [];
}

function extractRingcxActiveCallUii(call = null) {
  return cleanText(
    call?.uii
      || call?.UII
      || call?.callId
      || call?.callID
      || call?.activeCallId
      || call?.interactionId
      || call?.id
      || "",
    120,
  ) || null;
}

function collectScalarStrings(value, output = [], depth = 0) {
  if (output.length >= 180 || depth > 5 || value === null || value === undefined) return output;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    output.push(String(value));
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 30)) collectScalarStrings(item, output, depth + 1);
    return output;
  }
  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value).slice(0, 90)) {
      output.push(String(key));
      collectScalarStrings(child, output, depth + 1);
      if (output.length >= 180) break;
    }
  }
  return output;
}

function activeCallContainsText(call, value) {
  const needle = String(value || "").trim().toLowerCase();
  if (!needle) return false;
  return collectScalarStrings(call)
    .some((candidate) => String(candidate || "").toLowerCase().includes(needle));
}

function activeCallContainsAllWords(call, value) {
  const words = String(value || "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 1);
  if (!words.length) return false;
  const haystack = collectScalarStrings(call).join(" ").toLowerCase();
  return words.every((word) => haystack.includes(word));
}

function summarizeRingcxActiveCall(call = null) {
  if (!call || typeof call !== "object") return null;
  const summary = {};
  for (const key of [
    "uii",
    "UII",
    "callId",
    "callID",
    "activeCallId",
    "id",
    "state",
    "status",
    "callState",
    "agentId",
    "agentFirstName",
    "agentLastName",
    "username",
    "agentEmail",
    "campaignId",
    "dialGroupId",
    "externId",
    "externalId",
    "leadPhone",
    "phone",
    "destination",
    "callerId",
    "ani",
    "dnis",
    "dnisE164",
    "destinationName",
  ]) {
    const value = call[key];
    if (value !== undefined && value !== null && value !== "") summary[key] = value;
  }
  summary.uii = summary.uii || extractRingcxActiveCallUii(call);
  summary.rawKeys = Object.keys(call).slice(0, 80);
  return summary;
}

function isRingcxCallTerminal(call = null) {
  const state = String(call?.state || call?.callState || call?.status || call?.dialState || "")
    .trim()
    .toLowerCase();
  if (!state) return false;
  return /(complete|completed|disconnected|disposed|hangup|hung|ended|terminated|abandoned|cancelled|canceled|failed|rejected|voicemail|no.answer|busy)/i
    .test(state);
}

function scoreRingcxGateCall(call, criteria = {}) {
  if (!call || typeof call !== "object" || !extractRingcxActiveCallUii(call) || isRingcxCallTerminal(call)) {
    return { score: 0, reasons: [] };
  }
  const reasons = [];
  let score = 1;
  for (const [label, value, weight] of [
    ["agentCxAgentId", criteria.agentCxAgentId, 10],
    ["agentName", criteria.agentName, 9],
    ["agentEmail", criteria.agentEmail, 8],
    ["agentExtId", criteria.agentExtId, 6],
    ["campaignId", criteria.campaignId, 4],
    ["dialGroupId", criteria.dialGroupId, 3],
  ]) {
    const matched = label === "agentName"
      ? activeCallContainsAllWords(call, value)
      : activeCallContainsText(call, value);
    if (value && matched) {
      score += weight;
      reasons.push(label);
    }
  }
  const state = String(call.state || call.callState || call.status || call.dialState || "").toLowerCase();
  if (state && /(outdial|dial|ring|connect|active|call|preview|talk|answered)/.test(state)) {
    score += 2;
    reasons.push("activeState");
  }
  return { score, reasons };
}

function printHelp() {
  console.log(`RingEX live trainer one-off

Usage:
  node scripts/rc-ex-live-trainer-oneoff.js [options]

Core options:
  --supervisor-ext 987       AI Monitor extension number (default: env or 987)
  --supervisor-device-id ID  Optional specific RingEX device id
  --agent-ext 101            Agent extension number to supervise
  --supervise                Attach to the agent's active call automatically
  --party session            session | remote | agent | mixed | party id
  --call-flow outbound       outbound | inbound | mixed speaker bias
  --event-gated              Keep monitor attached, but run STT only inside our app's cx.call.placed window
  --event-gate-active-sec N  Safety close if no disposition-hangup arrives (default 2700)
  --fake-event-gate          Test mode: open the same gate from an in-memory fake call event
  --cx-gated                 Keep monitor attached, but run STT only while RingCX shows an active CX call
  --cx-agent-id ID           RingCX agent id for activeCalls/list product=AGENT
  --cx-campaign-id ID        Optional campaign id match for ACCOUNT-scope CX gate fallback
  --dashboard-port 7331      Local dashboard port
  --session-id ID            Optional trainer UI session id to publish advice into
  --supervise-wait-sec 120   When --supervise is set, wait for an active call

Audio/AI options:
  --chunk-sec 2              Seconds of PCMU per transcription chunk
  --split-on-silence         Flush a transcription chunk after a speech pause
  --silence-split-ms 3000    Silence duration used by --split-on-silence
  --stage-until-silence      Transcribe max chunks internally, publish merged turn after silence
  --no-max-chunk             With --split-on-silence, publish only after silence
  --speech-packet-active-pct 1.0
                             Packet activity threshold for speech detection
  --coach-every-sec 10       Minimum seconds between Claude advice calls
  --min-active-pct 0.35      Skip chunks quieter than this active-sample percent
  --sentence-hold-ms 4000    Hold fragments briefly for complete sentences
  --language en              STT language hint
  --stt-model MODEL          OpenAI STT model
  --stt-response-format FMT  json | diarized_json
  --chunking-strategy auto   Diarize chunking strategy
  --stt-context TEXT         Prompt/context for non-diarize STT
  --no-stt-domain-primer     Disable tax vocabulary prompt for non-diarize STT
  --stt-realtime             Use OpenAI Realtime transcription instead of file STT
  --realtime-stt-delay LEVEL minimal | low | medium | high | xhigh
  --realtime-direct-coach    Science lane: send monitor audio straight to gpt-realtime-2 for HEARD/SAY
  --realtime-direct-coach-only
                             Realtime direct returns MODE/SAY only, no transcript text
  --realtime-direct-model M  Model for --realtime-direct-coach (default gpt-realtime-2)
  --realtime-direct-start-delay-sec N
                             Sleep before first realtime coach probe after a call gate opens
  --realtime-direct-hold-recheck-sec N
                             After exact "please continue to hold", sleep before the next probe (default 120)
  --realtime-direct-min-chunk-sec N
                             Minimum audio seconds before realtime-direct sends a coach request (default 6)
  --realtime-direct-incomplete-hold-ms N
                             Hold incomplete realtime HEARD fragments briefly before showing them
  Exact "please continue to hold" pauses input and checks again after the hold recheck delay
  --known-speaker name=wav   Diarize-only speaker reference, repeat up to four
  --coach-model MODEL        Claude model for live advice
  --no-coach                 Disable live advice calls for transcript-only model tests
  --prospect-only-coach      Treat STT as prospect-only speech and stream next agent line
  --prospect-coach-provider PROVIDER
                             anthropic | openai
  --prospect-coach-model MODEL
                             Model for --prospect-only-coach
  --prospect-coach-service-tier TIER
                             OpenAI Responses service_tier, e.g. priority
  --prospect-coach-playbook-file PATH
                             Static prompt block for next-line coach
  --prospect-coach-playbook-max-chars N
                             Max focused playbook context per coach call
  --prospect-coach-min-speaker-confidence N
                             With speaker labels/semantic turns, only coach prospect turns above this confidence
  --summary-every-sec N      Refresh compact call memory for the streaming coach
  --summary-provider PROVIDER anthropic | openai
  --summary-model MODEL      Model for compact call memory, prefix provider:model allowed
  --summary-service-tier TIER OpenAI Responses service_tier, e.g. priority
  --no-summary               Disable background compact call memory
  --speaker-model MODEL      Claude model for speaker labels (default Haiku)
  --speaker-labels           Force Haiku labels even with native diarize
  --no-speaker-labels        Skip logical speaker separation
  --semantic-turns           Let one Claude model assemble raw STT into complete UI turns
  --semantic-turn-provider PROVIDER  anthropic | openai
  --semantic-turn-model MODEL  Model for --semantic-turns, e.g. Sonnet vs Haiku
  --semantic-turn-service-tier TIER
                             OpenAI Responses service_tier, e.g. priority
  --semantic-turn-batch-ms N Batch raw STT for N ms before semantic publish decisions
  --semantic-glue            Let a fast model merge a new displayed row into the prior row when it is one continued thought
  --timeout-sec 3600         Max process runtime

Notes:
  EX path does not require ngrok. If you want a temporary public dashboard,
  run "ngrok http 7331" separately.
`);
}

async function main() {
  const argv = process.argv.slice(2);
  if (hasFlag(argv, "--help") || hasFlag(argv, "-h")) {
    printHelp();
    return;
  }

  const supervisorExtNumber = readFlag(argv, "--supervisor-ext", env("EX_LIVE_MONITOR_SUPERVISOR_EXT", "987"));
  const agentExtNumber = readFlag(argv, "--agent-ext", env("EX_LIVE_MONITOR_AGENT_EXT", ""));
  if (String(supervisorExtNumber || "").trim() === String(agentExtNumber || "").trim()) {
    throw new Error("--supervisor-ext must be different from --agent-ext; self-monitoring loops on the monitor leg");
  }
  const requestedDeviceId = readFlag(argv, "--supervisor-device-id", env("EX_LIVE_MONITOR_SUPERVISOR_DEVICE_ID", ""));
  const proxyRegion = readFlag(argv, "--proxy-region", "NA");
  const doSupervise = hasFlag(argv, "--supervise");
  const partyMode = readFlag(argv, "--party", env("EX_LIVE_MONITOR_PARTY", "session"));
  const callPickMode = readFlag(argv, "--call", "newest");
  const callFlow = normalizeCallFlow(readFlag(argv, "--call-flow", env("EX_LIVE_MONITOR_CALL_FLOW", "outbound")));
  const initialHumanSpeaker = normalizeInitialHumanSpeaker(
    readFlag(argv, "--initial-human-speaker", env("EX_LIVE_MONITOR_INITIAL_HUMAN_SPEAKER", "")),
    callFlow,
  );
  const superviseWaitSec = Math.max(0, Number(readFlag(argv, "--supervise-wait-sec", env("EX_LIVE_MONITOR_SUPERVISE_WAIT_SECONDS", "120"))) || 0);
  const supervisePollMs = Math.max(2000, Number(readFlag(argv, "--supervise-poll-ms", env("EX_LIVE_MONITOR_SUPERVISE_POLL_MS", "6000"))) || 6000);
  const onlyNewCalls = hasFlag(argv, "--only-new-calls")
    || env("EX_LIVE_MONITOR_ONLY_NEW_CALLS", "").toLowerCase() === "true";
  const fakeEventGate = hasFlag(argv, "--fake-event-gate")
    || env("EX_LIVE_MONITOR_FAKE_EVENT_GATE", "").toLowerCase() === "true";
  const fakeEventAfterSec = Math.max(0, Number(readFlag(argv, "--fake-event-after-sec", env("EX_LIVE_MONITOR_FAKE_EVENT_AFTER_SECONDS", "0"))) || 0);
  const eventGated = fakeEventGate
    || hasFlag(argv, "--event-gated")
    || env("EX_LIVE_MONITOR_EVENT_GATED", "").toLowerCase() === "true"
    || env("EX_LIVE_MONITOR_APP_EVENT_GATED", "").toLowerCase() === "true";
  const eventGatePollMs = Math.max(1000, Number(readFlag(argv, "--event-gate-poll-ms", env("EX_LIVE_MONITOR_EVENT_GATE_POLL_MS", "2000"))) || 2000);
  const eventGateLookbackSec = Math.max(0, Number(readFlag(argv, "--event-gate-lookback-sec", env("EX_LIVE_MONITOR_EVENT_GATE_LOOKBACK_SECONDS", "180"))) || 0);
  const eventGateActiveSec = Math.max(30, Number(readFlag(argv, "--event-gate-active-sec", env("EX_LIVE_MONITOR_EVENT_GATE_ACTIVE_SECONDS", "2700"))) || 2700);
  const eventGateAgentEmailFlag = readFlag(argv, "--event-gate-agent-email", env("EX_LIVE_MONITOR_EVENT_GATE_AGENT_EMAIL", ""));
  const eventGateSourceService = readFlag(argv, "--event-gate-source-service", env("EX_LIVE_MONITOR_EVENT_GATE_SOURCE_SERVICE", "ringcentral-cx"));
  const eventGateLookbackLimit = Math.max(10, Math.min(500, Number(readFlag(argv, "--event-gate-lookback-limit", env("EX_LIVE_MONITOR_EVENT_GATE_LOOKBACK_LIMIT", "160"))) || 160));
  const cxGated = !eventGated && (
    hasFlag(argv, "--cx-gated")
    || env("EX_LIVE_MONITOR_CX_GATED", "").toLowerCase() === "true"
  );
  const cxGatePollMs = Math.max(1000, Number(readFlag(argv, "--cx-gate-poll-ms", env("EX_LIVE_MONITOR_CX_GATE_POLL_MS", "5000"))) || 5000);
  const cxGateAgentIdFlag = readFlag(argv, "--cx-agent-id", env("EX_LIVE_MONITOR_CX_AGENT_ID", ""));
  const cxGateAgentEmailFlag = readFlag(argv, "--cx-agent-email", env("EX_LIVE_MONITOR_CX_AGENT_EMAIL", env("RINGCX_VOICE_AGENT_EMAIL", "")));
  const cxGateCampaignIdFlag = readFlag(argv, "--cx-campaign-id", env("EX_LIVE_MONITOR_CX_CAMPAIGN_ID", env("RINGCX_VOICE_DEFAULT_CAMPAIGN_ID", "")));
  const cxGateDialGroupIdFlag = readFlag(argv, "--cx-dial-group-id", env("EX_LIVE_MONITOR_CX_DIAL_GROUP_ID", env("RINGCX_VOICE_DEFAULT_DIAL_GROUP_ID", "")));
  const callGateEnabled = cxGated || eventGated;
  const callGateMode = eventGated ? "app-event" : cxGated ? "ringcx-active-calls" : "off";
  const callGatePollMs = eventGated ? eventGatePollMs : cxGatePollMs;
  const dashboardPort = Number(readFlag(argv, "--dashboard-port", env("EX_LIVE_MONITOR_DASHBOARD_PORT", "7331"))) || 7331;
  const timeoutSec = Math.max(10, Number(readFlag(argv, "--timeout-sec", env("EX_LIVE_MONITOR_TIMEOUT_SECONDS", "3600"))) || 3600);
  const chunkSec = Math.max(1, Math.min(20, Number(readFlag(argv, "--chunk-sec", env("EX_LIVE_MONITOR_CHUNK_SECONDS", "2"))) || 2));
  const splitOnSilence = hasFlag(argv, "--split-on-silence")
    || env("EX_LIVE_MONITOR_SPLIT_ON_SILENCE", "").toLowerCase() === "true";
  const silenceSplitMs = Math.max(250, Number(readFlag(argv, "--silence-split-ms", env("EX_LIVE_MONITOR_SILENCE_SPLIT_MS", "3000"))) || 3000);
  const stageUntilSilence = hasFlag(argv, "--stage-until-silence")
    || env("EX_LIVE_MONITOR_STAGE_UNTIL_SILENCE", "").toLowerCase() === "true";
  const noMaxChunk = hasFlag(argv, "--no-max-chunk")
    || env("EX_LIVE_MONITOR_NO_MAX_CHUNK", "").toLowerCase() === "true";
  const speechPacketActivePct = Math.max(0, Number(readFlag(argv, "--speech-packet-active-pct", env("EX_LIVE_MONITOR_SPEECH_PACKET_ACTIVE_PCT", "1.0"))) || 1.0);
  const speechPacketMaxAbs = Math.max(0, Number(readFlag(argv, "--speech-packet-max-abs", env("EX_LIVE_MONITOR_SPEECH_PACKET_MAX_ABS", "1200"))) || 1200);
  const coachEverySec = Math.max(5, Number(readFlag(argv, "--coach-every-sec", env("EX_LIVE_MONITOR_COACH_EVERY_SECONDS", "10"))) || 10);
  const coachEnabled = !hasFlag(argv, "--no-coach")
    && env("EX_LIVE_MONITOR_NO_COACH", "").toLowerCase() !== "true";
  const prospectOnlyCoachEnabled = hasFlag(argv, "--prospect-only-coach")
    || env("EX_LIVE_MONITOR_PROSPECT_ONLY_COACH", "").toLowerCase() === "true";
  const prospectCoachModelRaw = readFlag(
    argv,
    "--prospect-coach-model",
    env("LIVE_PROSPECT_COACH_MODEL", env("LIVE_CALL_MONITOR_COACH_MODEL", env("SALES_TRAINER_COACH_MODEL", "claude-sonnet-4-6"))),
  );
  const prospectCoachProviderRaw = readFlag(
    argv,
    "--prospect-coach-provider",
    env("LIVE_PROSPECT_COACH_PROVIDER", ""),
  );
  const prospectCoachModelParts = String(prospectCoachModelRaw || "").split(":");
  const prospectCoachProvider = (() => {
    const explicit = String(prospectCoachProviderRaw || "").trim().toLowerCase();
    if (["anthropic", "openai"].includes(explicit)) return explicit;
    if (prospectCoachModelParts.length > 1 && ["anthropic", "openai"].includes(prospectCoachModelParts[0])) {
      return prospectCoachModelParts[0];
    }
    return /^gpt-|^o[0-9]/i.test(String(prospectCoachModelRaw || "")) ? "openai" : "anthropic";
  })();
  const prospectCoachModel = prospectCoachModelParts.length > 1 && ["anthropic", "openai"].includes(prospectCoachModelParts[0])
    ? prospectCoachModelParts.slice(1).join(":")
    : prospectCoachModelRaw;
  const prospectCoachServiceTier = readFlag(
    argv,
    "--prospect-coach-service-tier",
    env("LIVE_PROSPECT_COACH_SERVICE_TIER", env("LIVE_PROSPECT_COACH_OPENAI_SERVICE_TIER", "")),
  ).trim();
  const prospectCoachPlaybookFile = readFlag(
    argv,
    "--prospect-coach-playbook-file",
    env("LIVE_PROSPECT_COACH_PLAYBOOK_FILE", path.join("docs", "LIVE_PROSPECT_COACH_PLAYBOOK.md")),
  );
  const prospectCoachPlaybook = readOptionalTextFile(prospectCoachPlaybookFile, 32000);
  const prospectCoachPlaybookMaxChars = Math.max(
    2000,
    Number(readFlag(
      argv,
      "--prospect-coach-playbook-max-chars",
      env("LIVE_PROSPECT_COACH_PLAYBOOK_MAX_CHARS", "7000"),
    )) || 7000,
  );
  const prospectCoachTimeoutMs = Math.max(
    3000,
    Number(readFlag(argv, "--prospect-coach-timeout-ms", env("LIVE_PROSPECT_COACH_TIMEOUT_MS", "15000"))) || 15000,
  );
  const prospectCoachMinSpeakerConfidence = clampNumber(
    readFlag(argv, "--prospect-coach-min-speaker-confidence", env("LIVE_PROSPECT_COACH_MIN_SPEAKER_CONFIDENCE", "0.65")),
    0,
    1,
    0.65,
  );
  const minActivePct = Math.max(0, Number(readFlag(argv, "--min-active-pct", env("EX_LIVE_MONITOR_MIN_ACTIVE_PCT", "0.35"))) || 0);
  const sentenceHoldMs = Math.max(0, Number(readFlag(argv, "--sentence-hold-ms", env("EX_LIVE_MONITOR_SENTENCE_HOLD_MS", "4000"))) || 0);
  const language = readFlag(argv, "--language", env("EX_LIVE_MONITOR_LANGUAGE", "en"));
  const sttModel = readFlag(
    argv,
    "--stt-model",
    env("EX_LIVE_MONITOR_STT_MODEL", env("SALES_TRAINER_STT_MODEL", "gpt-4o-mini-transcribe")),
  );
  const sttRealtimeEnabled = hasFlag(argv, "--stt-realtime")
    || env("EX_LIVE_MONITOR_STT_REALTIME", "").toLowerCase() === "true";
  const realtimeSttDelay = readFlag(
    argv,
    "--realtime-stt-delay",
    env("EX_LIVE_MONITOR_REALTIME_STT_DELAY", "xhigh"),
  ).trim();
  const realtimeDirectCoachEnabled = hasFlag(argv, "--realtime-direct-coach")
    || env("EX_LIVE_MONITOR_REALTIME_DIRECT_COACH", "").toLowerCase() === "true";
  const realtimeDirectModel = readFlag(
    argv,
    "--realtime-direct-model",
    env("EX_LIVE_MONITOR_REALTIME_DIRECT_MODEL", "gpt-realtime-2"),
  ).trim() || "gpt-realtime-2";
  const realtimeDirectTimeoutMs = Math.max(
    3000,
    Number(readFlag(argv, "--realtime-direct-timeout-ms", env("EX_LIVE_MONITOR_REALTIME_DIRECT_TIMEOUT_MS", "20000"))) || 20000,
  );
  const realtimeDirectReasoningEffort = readFlag(
    argv,
    "--realtime-direct-reasoning-effort",
    env("EX_LIVE_MONITOR_REALTIME_DIRECT_REASONING_EFFORT", ""),
  ).trim();
  const realtimeDirectStartDelaySec = Math.max(
    0,
    Number(readFlag(argv, "--realtime-direct-start-delay-sec", env("EX_LIVE_MONITOR_REALTIME_DIRECT_START_DELAY_SECONDS", "0"))) || 0,
  );
  const realtimeDirectHoldRecheckSec = Math.max(
    0,
    Number(readFlag(argv, "--realtime-direct-hold-recheck-sec", env("EX_LIVE_MONITOR_REALTIME_DIRECT_HOLD_RECHECK_SECONDS", "120"))) || 120,
  );
  const realtimeDirectMinChunkSec = Math.max(
    0,
    Number(readFlag(argv, "--realtime-direct-min-chunk-sec", env("EX_LIVE_MONITOR_REALTIME_DIRECT_MIN_CHUNK_SECONDS", "3"))) || 0,
  );
  const realtimeDirectIncompleteHoldMs = Math.max(
    0,
    Number(readFlag(argv, "--realtime-direct-incomplete-hold-ms", env("EX_LIVE_MONITOR_REALTIME_DIRECT_INCOMPLETE_HOLD_MS", "6000"))) || 0,
  );
  const realtimeDirectCoachOnly = hasFlag(argv, "--realtime-direct-coach-only")
    || env("EX_LIVE_MONITOR_REALTIME_DIRECT_COACH_ONLY", "").toLowerCase() === "true";
  const nextLineCoachUiEnabled = prospectOnlyCoachEnabled || realtimeDirectCoachEnabled;
  const sttResponseFormat = readFlag(
    argv,
    "--stt-response-format",
    env("EX_LIVE_MONITOR_STT_RESPONSE_FORMAT", /diarize/i.test(sttModel) ? "diarized_json" : "json"),
  );
  const nativeDiarizeEnabled = !sttRealtimeEnabled
    && !hasFlag(argv, "--no-native-diarize")
    && (/diarize/i.test(sttModel) || String(sttResponseFormat).toLowerCase() === "diarized_json");
  const sttChunkingStrategy = readFlag(
    argv,
    "--chunking-strategy",
    env("EX_LIVE_MONITOR_CHUNKING_STRATEGY", nativeDiarizeEnabled ? "auto" : ""),
  );
  const sttContext = readFlag(
    argv,
    "--stt-context",
    env(
      "EX_LIVE_MONITOR_STT_CONTEXT",
      "This is a live tax-relief sales call. Expect names and terms like Tax Advocate Group, Wynn Tax Solutions, WinTax Solutions, RingCentral CX, IRS, CP14, CP504, LT11, 1099, OIC, CNC, levy, lien, garnishment, unfiled returns, installment agreement, payment plan, revenue officer, and tax resolution.",
    ),
  );
  const includeSttDomainPrimer = !sttRealtimeEnabled && !hasFlag(argv, "--no-stt-domain-primer") && !nativeDiarizeEnabled;
  const knownSpeakers = parseKnownSpeakerReferences(argv);
  const sessionId = readFlag(argv, "--session-id", env("EX_LIVE_MONITOR_SESSION_ID", ""));
  const controlPlaneUrl = readFlag(argv, "--control-plane-url", env("EX_LIVE_MONITOR_CONTROL_PLANE_URL", "http://127.0.0.1:5001"));
  const internalSecret = readFlag(
    argv,
    "--internal-secret",
    env("SALES_TRAINER_BRIDGE_SECRET", env("INTERNAL_SERVICE_SECRET", "")),
  );
  const coachModel = readFlag(
    argv,
    "--coach-model",
    env("LIVE_CALL_MONITOR_COACH_MODEL", env("SALES_TRAINER_COACH_MODEL", "claude-sonnet-4-6")),
  );
  const conversationSummaryEnabled = !hasFlag(argv, "--no-summary")
    && env("EX_LIVE_MONITOR_NO_SUMMARY", "").toLowerCase() !== "true";
  const conversationSummaryEverySec = Math.max(
    30,
    Number(readFlag(argv, "--summary-every-sec", env("EX_LIVE_MONITOR_SUMMARY_EVERY_SECONDS", "120"))) || 120,
  );
  const conversationSummaryModelRaw = readFlag(
    argv,
    "--summary-model",
    env("LIVE_CALL_MONITOR_SUMMARY_MODEL", env("LIVE_CALL_MONITOR_SPEAKER_MODEL", "claude-haiku-4-5")),
  );
  const conversationSummaryProviderRaw = readFlag(
    argv,
    "--summary-provider",
    env("LIVE_CALL_MONITOR_SUMMARY_PROVIDER", ""),
  );
  const conversationSummaryModelParts = String(conversationSummaryModelRaw || "").split(":");
  const conversationSummaryProvider = (() => {
    const explicit = String(conversationSummaryProviderRaw || "").trim().toLowerCase();
    if (["anthropic", "openai"].includes(explicit)) return explicit;
    if (conversationSummaryModelParts.length > 1 && ["anthropic", "openai"].includes(conversationSummaryModelParts[0])) {
      return conversationSummaryModelParts[0];
    }
    return /^gpt-|^o[0-9]/i.test(String(conversationSummaryModelRaw || "")) ? "openai" : "anthropic";
  })();
  const conversationSummaryModel = conversationSummaryModelParts.length > 1 && ["anthropic", "openai"].includes(conversationSummaryModelParts[0])
    ? conversationSummaryModelParts.slice(1).join(":")
    : conversationSummaryModelRaw;
  const conversationSummaryServiceTier = readFlag(
    argv,
    "--summary-service-tier",
    env("LIVE_CALL_MONITOR_SUMMARY_SERVICE_TIER", ""),
  ).trim();
  const conversationSummaryTimeoutMs = Math.max(
    5000,
    Number(readFlag(argv, "--summary-timeout-ms", env("EX_LIVE_MONITOR_SUMMARY_TIMEOUT_MS", "25000"))) || 25000,
  );
  const conversationSummaryMaxTranscriptChars = Math.max(
    3000,
    Number(readFlag(argv, "--summary-max-transcript-chars", env("EX_LIVE_MONITOR_SUMMARY_MAX_TRANSCRIPT_CHARS", "14000"))) || 14000,
  );
  const conversationSummaryMaxChars = Math.max(
    800,
    Number(readFlag(argv, "--summary-max-chars", env("EX_LIVE_MONITOR_SUMMARY_MAX_CHARS", "3200"))) || 3200,
  );
  const speakerModel = readFlag(
    argv,
    "--speaker-model",
    env("LIVE_CALL_MONITOR_SPEAKER_MODEL", "claude-haiku-4-5"),
  );
  const semanticTurnsEnabled = hasFlag(argv, "--semantic-turns")
    || env("EX_LIVE_MONITOR_SEMANTIC_TURNS", "").toLowerCase() === "true";
  const semanticTurnModelRaw = readFlag(
    argv,
    "--semantic-turn-model",
    env("LIVE_CALL_MONITOR_SEMANTIC_TURN_MODEL", env("LIVE_CALL_MONITOR_COACH_MODEL", "claude-sonnet-4-6")),
  );
  const semanticTurnProviderRaw = readFlag(
    argv,
    "--semantic-turn-provider",
    env("LIVE_CALL_MONITOR_SEMANTIC_TURN_PROVIDER", ""),
  );
  const semanticTurnModelParts = String(semanticTurnModelRaw || "").split(":");
  const semanticTurnProvider = (() => {
    const explicit = String(semanticTurnProviderRaw || "").trim().toLowerCase();
    if (["anthropic", "openai"].includes(explicit)) return explicit;
    if (semanticTurnModelParts.length > 1 && ["anthropic", "openai"].includes(semanticTurnModelParts[0])) {
      return semanticTurnModelParts[0];
    }
    return /^gpt-|^o[0-9]/i.test(String(semanticTurnModelRaw || "")) ? "openai" : "anthropic";
  })();
  const semanticTurnModel = semanticTurnModelParts.length > 1 && ["anthropic", "openai"].includes(semanticTurnModelParts[0])
    ? semanticTurnModelParts.slice(1).join(":")
    : semanticTurnModelRaw;
  const semanticTurnServiceTier = readFlag(
    argv,
    "--semantic-turn-service-tier",
    env("EX_LIVE_MONITOR_SEMANTIC_TURN_SERVICE_TIER", ""),
  ).trim();
  const semanticTurnTimeoutMs = Math.max(
    3000,
    Number(readFlag(argv, "--semantic-turn-timeout-ms", env("EX_LIVE_MONITOR_SEMANTIC_TURN_TIMEOUT_MS", "12000"))) || 12000,
  );
  const semanticTurnMaxBufferChars = Math.max(
    300,
    Number(readFlag(argv, "--semantic-turn-max-buffer-chars", env("EX_LIVE_MONITOR_SEMANTIC_TURN_MAX_BUFFER_CHARS", "1400"))) || 1400,
  );
  const semanticTurnMemoryChars = Math.max(
    600,
    Number(readFlag(argv, "--semantic-turn-memory-chars", env("EX_LIVE_MONITOR_SEMANTIC_TURN_MEMORY_CHARS", "2400"))) || 2400,
  );
  const semanticTurnBatchMs = Math.max(
    0,
    Number(readFlag(argv, "--semantic-turn-batch-ms", env("EX_LIVE_MONITOR_SEMANTIC_TURN_BATCH_MS", "0"))) || 0,
  );
  const semanticTurnBatchMaxChars = Math.max(
    400,
    Number(readFlag(argv, "--semantic-turn-batch-max-chars", env("EX_LIVE_MONITOR_SEMANTIC_TURN_BATCH_MAX_CHARS", "1200"))) || 1200,
  );
  const semanticTurnRevisionMinConfidence = clampNumber(
    readFlag(argv, "--semantic-turn-revision-min-confidence", env("EX_LIVE_MONITOR_SEMANTIC_TURN_REVISION_MIN_CONFIDENCE", "0.72")),
    0,
    1,
    0.72,
  );
  const speakerLabelsEnabled = !hasFlag(argv, "--no-speaker-labels")
    && !semanticTurnsEnabled
    && (!nativeDiarizeEnabled || hasFlag(argv, "--speaker-labels"));
  const semanticGlueEnabled = hasFlag(argv, "--semantic-glue")
    || env("EX_LIVE_MONITOR_SEMANTIC_GLUE", "").toLowerCase() === "true";
  const semanticGlueModel = readFlag(
    argv,
    "--semantic-glue-model",
    env("LIVE_CALL_MONITOR_SEMANTIC_GLUE_MODEL", speakerModel),
  );
  const semanticGlueWindowMs = Math.max(
    0,
    Number(readFlag(argv, "--semantic-glue-window-ms", env("EX_LIVE_MONITOR_SEMANTIC_GLUE_WINDOW_MS", "45000"))) || 0,
  );
  const semanticGlueMinConfidence = clampNumber(
    readFlag(argv, "--semantic-glue-min-confidence", env("EX_LIVE_MONITOR_SEMANTIC_GLUE_MIN_CONFIDENCE", "0.72")),
    0,
    1,
    0.72,
  );
  const debug = hasFlag(argv, "--debug");
  const writeWavChunks = hasFlag(argv, "--write-wav-chunks");
  const outDir = path.resolve(readFlag(argv, "--out-dir", path.join("runtime", "ex-live-monitor-oneoff")));
  ensureDir(outDir);

  if (doSupervise && !agentExtNumber) {
    throw new Error("Pass --agent-ext <extensionNumber> with --supervise");
  }

  const runId = `ex-live-${timestampForFile()}-${crypto.randomBytes(4).toString("hex")}`;
  const runDir = path.join(outDir, runId);
  ensureDir(runDir);
  const eventLog = path.join(runDir, "events.ndjson");

  const state = {
    public: {
      runId,
      status: "starting",
      startedAt: new Date().toISOString(),
      supervisorExtNumber,
      agentExtNumber,
      sessionId: sessionId || null,
      outputPath: null,
      packetCount: 0,
      byteCount: 0,
      chunkSec,
      splitOnSilence,
      silenceSplitMs,
      stageUntilSilence,
      noMaxChunk,
      coachEverySec,
      coachEnabled,
      conversationSummaryEnabled,
      conversationSummaryEverySec,
      conversationSummaryProvider,
      conversationSummaryModel,
      conversationSummaryServiceTier: conversationSummaryServiceTier || null,
      conversationSummaryChars: 0,
      conversationSummaryUpdatedAt: null,
      conversationSummaryStatus: conversationSummaryEnabled ? "idle" : "off",
      prospectOnlyCoachEnabled,
      realtimeDirectCoachEnabled,
      realtimeDirectModel,
      realtimeDirectTimeoutMs,
      realtimeDirectReasoningEffort: realtimeDirectReasoningEffort || null,
      realtimeDirectStartDelaySec,
      realtimeDirectHoldRecheckSec,
      realtimeDirectMinChunkSec,
      realtimeDirectIncompleteHoldMs,
      realtimeDirectHoldDormantUntilNextEvent: false,
      realtimeDirectSleepUntil: null,
      realtimeDirectSleepReason: null,
      realtimeDirectSleepLastHeard: null,
      realtimeDirectDormantUntilNextEvent: false,
      realtimeDirectDormantGateId: null,
      realtimeDirectDormantReason: null,
      realtimeDirectCoachOnly,
      prospectCoachProvider,
      prospectCoachModel,
      prospectCoachServiceTier: prospectCoachServiceTier || null,
      prospectCoachMinSpeakerConfidence,
      prospectCoachPlaybookFile: prospectCoachPlaybook ? path.resolve(prospectCoachPlaybookFile) : null,
      prospectCoachPlaybookChars: prospectCoachPlaybook.length,
      prospectCoachPlaybookMaxChars,
      minActivePct,
      callFlow,
      initialHumanSpeaker,
      sentenceHoldMs,
      sttModel,
      sttResponseFormat,
      nativeDiarizeEnabled,
      semanticTurnsEnabled,
      semanticTurnProvider,
      semanticTurnModel,
      semanticTurnServiceTier: semanticTurnServiceTier || null,
      semanticTurnMaxBufferChars,
      semanticTurnMemoryChars,
      semanticTurnBatchMs,
      semanticTurnBatchMaxChars,
      semanticTurnBatchChars: 0,
      semanticTurnBatchParts: 0,
      semanticTurnBufferChars: 0,
      semanticCallMemory: "",
      speakerLabelsEnabled,
      speakerModel,
      semanticGlueEnabled,
      semanticGlueModel,
      semanticGlueWindowMs,
      semanticGlueMinConfidence,
      cxGate: {
        enabled: callGateEnabled,
        mode: callGateMode,
        active: !callGateEnabled,
        pollMs: callGatePollMs,
        agentId: cleanText(cxGateAgentIdFlag, 80) || null,
        agentEmail: cleanText(cxGateAgentEmailFlag, 160) || null,
        campaignId: cleanText(cxGateCampaignIdFlag, 80) || null,
        dialGroupId: cleanText(cxGateDialGroupIdFlag, 80) || null,
        eventSourceService: eventGated ? eventGateSourceService : null,
      },
      liveSuggestion: {
        enabled: nextLineCoachUiEnabled,
        status: nextLineCoachUiEnabled ? "idle" : "off",
        text: "",
        finalText: "",
        provider: realtimeDirectCoachEnabled ? "openai-realtime" : prospectCoachProvider,
        model: realtimeDirectCoachEnabled ? realtimeDirectModel : prospectCoachModel || null,
        outputMode: realtimeDirectCoachOnly ? "coach-only" : "heard-say",
        serviceTier: prospectCoachServiceTier || null,
        playbookChars: prospectCoachPlaybook.length,
        playbookMaxChars: prospectCoachPlaybookMaxChars,
        playbookSections: [],
        taxKnowledgeSections: [],
        taxJurisdiction: null,
        taxJurisdictionConfidence: null,
        taxJurisdictionReason: null,
        sequence: 0,
        prospectText: "",
        acceptInput: null,
        mode: "wait",
        signal: "",
        topic: "",
        direction: "",
      },
    },
    transcripts: [],
    realtimeDirectTurns: [],
    events: [],
    advice: null,
  };

  const dashboard = createDashboardServer({
    port: dashboardPort,
    state,
    logger: (message) => addEvent(state, eventLog, "dashboard", message),
  });
  const broadcast = () => dashboard.broadcast();

  addEvent(state, eventLog, "start", "RingEX live trainer one-off starting", {
    runDir,
    dashboard: `http://127.0.0.1:${dashboardPort}/`,
    doSupervise,
    partyMode,
    callFlow,
    initialHumanSpeaker,
  });

  const lookupToken = await rcAccessToken();
  const monitorCredentialPrefix = monitorCredentialPrefixForExt(supervisorExtNumber);
  const monitorToken = await rcAccessToken({
    jwtToken:
      env("RING_CENTRAL_MONITOR_JWT_TOKEN", "")
      || namedMonitorCredential(monitorCredentialPrefix, "JWT_TOKEN")
      || process.env.RING_CENTRAL_JWT_TOKEN,
    clientId:
      env("RING_CENTRAL_MONITOR_CLIENT_ID", "")
      || namedMonitorCredential(monitorCredentialPrefix, "CLIENT_ID")
      || process.env.RING_CENTRAL_CLIENT_ID,
    clientSecret:
      env("RING_CENTRAL_MONITOR_CLIENT_SECRET", "")
      || namedMonitorCredential(monitorCredentialPrefix, "CLIENT_SECRET")
      || process.env.RING_CENTRAL_CLIENT_SECRET,
  });

  const supervisorExt = await resolveExtension(lookupToken, supervisorExtNumber);
  if (!supervisorExt) throw new Error(`Could not resolve supervisor extension ${supervisorExtNumber}`);
  const agentExt = agentExtNumber ? await resolveExtension(lookupToken, agentExtNumber) : null;
  if (agentExtNumber && !agentExt) throw new Error(`Could not resolve agent extension ${agentExtNumber}`);
  const cxGateAgentId =
    cleanText(cxGateAgentIdFlag, 80)
    || (agentExt?.id ? cleanText(env(`EX_LIVE_MONITOR_CX_AGENT_ID_${agentExt.id}`, ""), 80) : "")
    || (agentExt?.id ? cleanText(env(`RINGCX_AGENT_ROUTE_${agentExt.id}_AGENT_ID`, ""), 80) : "")
    || "";
  const cxGateAgentEmail = cleanText(cxGateAgentEmailFlag, 160);
  const cxGateCampaignId =
    cleanText(cxGateCampaignIdFlag, 80)
    || (agentExt?.id ? cleanText(env(`RINGCX_AGENT_ROUTE_${agentExt.id}_CAMPAIGN_ID`, ""), 80) : "")
    || "";
  const cxGateDialGroupId =
    cleanText(cxGateDialGroupIdFlag, 80)
    || (agentExt?.id ? cleanText(env(`RINGCX_AGENT_ROUTE_${agentExt.id}_DIAL_GROUP_ID`, ""), 80) : "")
    || "";
  const eventGateAgentEmail = cleanText(eventGateAgentEmailFlag || cxGateAgentEmail, 160);
  const eventGateAgentExtensionId = agentExt?.id ? String(agentExt.id) : "";
  const cxGateClient = cxGated ? createRingcxVoiceClient() : null;

  const devices = await rcRequest(lookupToken, "GET", `/restapi/v1.0/account/~/extension/${supervisorExt.id}/device`);
  const deviceRows = Array.isArray(devices?.records) ? devices.records : [];
  const device = pickSupervisorDevice(deviceRows, requestedDeviceId);
  if (!device?.id) throw new Error(`No supervisor device found for extension ${supervisorExtNumber}`);

  const sipInfo = await rcRequest(lookupToken, "GET", `/restapi/v1.0/account/~/device/${device.id}/sip-info`);
  const outboundProxy = pickProxy(sipInfo, proxyRegion);
  const softphone = new Softphone({
    domain: sipInfo.domain,
    outboundProxy,
    username: sipInfo.userName,
    password: sipInfo.password,
    authorizationId: sipInfo.authorizationId,
    codec: "PCMU/8000",
  });
  if (debug) softphone.enableDebugMode();

  state.public.supervisor = {
    id: String(supervisorExt.id),
    name: supervisorExt.name,
    extensionNumber: supervisorExt.extensionNumber,
  };
  state.public.agent = agentExt
    ? {
      id: String(agentExt.id),
      name: agentExt.name,
      extensionNumber: agentExt.extensionNumber,
    }
    : null;
  state.public.device = summarizeDevice(device);
  state.public.cxGate = {
    ...(state.public.cxGate || {}),
    enabled: callGateEnabled,
    mode: callGateMode,
    active: !callGateEnabled,
    pollMs: callGatePollMs,
    agentId: cxGateAgentId || null,
    agentEmail: cxGateAgentEmail || cleanText(eventGateAgentEmailFlag, 160) || null,
    campaignId: cxGateCampaignId || null,
    dialGroupId: cxGateDialGroupId || null,
    eventSourceService: eventGated ? eventGateSourceService : null,
    fake: fakeEventGate,
  };
  state.public.status = "registering";
  broadcast();

  let activeSession = null;
  let fullAudioStream = null;
  let outputPath = "";
  let packetCount = 0;
  let byteCount = 0;
  let pendingChunks = [];
  let pendingBytes = 0;
  let pendingStartedAt = 0;
  let pendingSpeechSeen = false;
  let pendingLastSpeechAt = 0;
  let chunkSequence = 0;
  let transcriptionQueue = Promise.resolve();
  let pendingTranscript = null;
  let stagedDisplayTranscripts = [];
  let stagedTurnSequence = 0;
  let semanticTurnBuffer = "";
  let semanticCallMemory = "";
  let semanticTurnSequence = 0;
  let semanticTurnBatchItems = [];
  let semanticTurnBatchStartedAt = 0;
  let semanticTurnBatchSequence = 0;
  let semanticTurnBatchFlushQueued = false;
  let lastAdviceAt = 0;
  let adviceInFlight = false;
  const realtimeTranscriber = sttRealtimeEnabled
    ? new OpenAiRealtimeTranscriber({
      apiKey: process.env.OPENAI_API_KEY || "",
      model: sttModel || "gpt-realtime-whisper",
      language,
      delay: realtimeSttDelay,
      safetyIdentifier: `tagcontactbridge-ex-live-monitor-${agentExtNumber || "unknown"}`,
    })
    : null;
  const nativeSpeakerAssignments = new Map();
  let monitorMetadata = {
    runId,
    supervisorExtNumber,
    agentExtNumber: agentExtNumber || null,
    partyMode,
    callFlow,
    initialHumanSpeaker,
    sessionId: sessionId || null,
    semanticCallMemory: "",
  };
  const realtimeDirectCoach = realtimeDirectCoachEnabled
    ? new OpenAiRealtimeDirectCoach({
      apiKey: process.env.OPENAI_API_KEY || "",
      model: realtimeDirectModel,
      instructions: buildRealtimeDirectCoachInstructions({
        metadata: monitorMetadata,
        playbook: cleanText(prospectCoachPlaybook, prospectCoachPlaybookMaxChars),
        summary: "",
        coachOnly: realtimeDirectCoachOnly,
      }),
      timeoutMs: realtimeDirectTimeoutMs,
      reasoningEffort: realtimeDirectReasoningEffort,
      safetyIdentifier: `tagcontactbridge-ex-live-realtime-direct-${agentExtNumber || "unknown"}`,
    })
    : null;
  let prospectCoachInFlight = false;
  let prospectCoachPendingEntry = null;
  let prospectCoachSequence = 0;
  let prospectCoachMemory = "";
  let conversationSummary = "";
  let conversationSummaryInFlight = false;
  let conversationSummaryLastAt = 0;
  let conversationSummaryTranscriptCount = 0;
  let realtimeDirectLastMemoryContext = "";
  let realtimeDirectSleepUntilMs = 0;
  let realtimeDirectSleepReason = "";
  let realtimeDirectSleepLastHeard = "";
  let realtimeDirectLastSleepDropLogAt = 0;
  let realtimeDirectDormantGateId = "";
  let realtimeDirectDormantReason = "";
  let realtimeDirectDormantLastHeard = "";
  let realtimeDirectHeldFragment = null;

  function publishRealtimeDirectSleepState() {
    state.public.realtimeDirectSleepUntil = realtimeDirectSleepUntilMs
      ? new Date(realtimeDirectSleepUntilMs).toISOString()
      : null;
    state.public.realtimeDirectSleepReason = realtimeDirectSleepReason || null;
    state.public.realtimeDirectSleepLastHeard = realtimeDirectSleepLastHeard || null;
  }

  function publishRealtimeDirectDormantState() {
    state.public.realtimeDirectDormantUntilNextEvent = Boolean(realtimeDirectDormantGateId);
    state.public.realtimeDirectDormantGateId = realtimeDirectDormantGateId || null;
    state.public.realtimeDirectDormantReason = realtimeDirectDormantReason || null;
    state.public.realtimeDirectSleepLastHeard = realtimeDirectDormantLastHeard || realtimeDirectSleepLastHeard || null;
  }

  function setRealtimeDirectSleep(seconds, reason, heard = "") {
    const sec = Math.max(0, Number(seconds) || 0);
    if (!realtimeDirectCoachEnabled || !sec) return false;
    const until = Date.now() + sec * 1000;
    if (until <= realtimeDirectSleepUntilMs) return false;
    realtimeDirectSleepUntilMs = until;
    realtimeDirectSleepReason = cleanText(reason, 120);
    realtimeDirectSleepLastHeard = cleanText(heard, 240);
    publishRealtimeDirectSleepState();
    addEvent(state, eventLog, "realtime_direct.sleep", `sleeping realtime coach for ${sec}s (${realtimeDirectSleepReason})`, {
      until: state.public.realtimeDirectSleepUntil,
      reason: realtimeDirectSleepReason,
      heard: realtimeDirectSleepLastHeard || null,
    });
    setLiveSuggestion({
      status: "sleeping",
      text: "",
      finalText: "",
      prospectText: "",
      mode: "wait",
      acceptInput: false,
      signal: realtimeDirectSleepLastHeard || "",
      topic: realtimeDirectSleepReason === "hold-prompt-recheck" ? "hold prompt" : "call delay",
      direction: realtimeDirectSleepReason === "hold-prompt-recheck"
        ? `Exact hold phrase heard. Rechecking in ${sec}s.`
        : `Waiting ${sec}s after the call event before checking audio.`,
      error: null,
    });
    broadcast();
    return true;
  }

  function clearRealtimeDirectSleep(reason = "clear") {
    if (!realtimeDirectSleepUntilMs) return;
    realtimeDirectSleepUntilMs = 0;
    realtimeDirectSleepReason = "";
    realtimeDirectSleepLastHeard = "";
    publishRealtimeDirectSleepState();
    addEvent(state, eventLog, "realtime_direct.wake", `realtime coach awake (${reason})`);
    if (cxGateState.active && reason !== "call-gate-idle") {
      setLiveSuggestion({
        status: "listening",
        text: "",
        finalText: "",
        prospectText: "",
        mode: "wait",
        acceptInput: true,
        signal: "",
        topic: "",
        direction: "Listening for a complete, response-worthy sentence.",
        error: null,
      });
    }
    broadcast();
  }

  function clearRealtimeDirectDormant(reason = "new-event") {
    if (!realtimeDirectDormantGateId) return;
    realtimeDirectDormantGateId = "";
    realtimeDirectDormantReason = "";
    realtimeDirectDormantLastHeard = "";
    publishRealtimeDirectDormantState();
    addEvent(state, eventLog, "realtime_direct.dormant_clear", `realtime coach dormant cleared (${reason})`);
    broadcast();
  }

  function isRealtimeDirectDormantMatch(match) {
    return Boolean(realtimeDirectDormantGateId && gateMatchId(match) === realtimeDirectDormantGateId);
  }

  function setRealtimeDirectDormantUntilNextEvent(reason, heard = "") {
    if (!realtimeDirectCoachEnabled) return false;
    const gateId = cxGateState.currentUii || `dormant-${Date.now()}`;
    realtimeDirectDormantGateId = gateId;
    realtimeDirectDormantReason = cleanText(reason, 120);
    realtimeDirectDormantLastHeard = cleanText(heard, 240);
    publishRealtimeDirectDormantState();
    addEvent(state, eventLog, "realtime_direct.dormant", `realtime coach dormant until next event (${realtimeDirectDormantReason})`, {
      gateId,
      heard: realtimeDirectDormantLastHeard || null,
    });
    deactivateCxGate(realtimeDirectDormantReason || "realtime-direct-dormant");
    return true;
  }

  function getRealtimeDirectSleepRemainingMs() {
    if (!realtimeDirectSleepUntilMs) return 0;
    const remaining = realtimeDirectSleepUntilMs - Date.now();
    if (remaining <= 0) {
      clearRealtimeDirectSleep("cooldown-expired");
      return 0;
    }
    return remaining;
  }

  function setLiveSuggestion(patch = {}) {
    state.public.liveSuggestion = {
      ...(state.public.liveSuggestion || {}),
      enabled: nextLineCoachUiEnabled,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    broadcast();
  }

  async function maybeRefreshConversationSummary(reason = "transcript", { force = false } = {}) {
    if (!conversationSummaryEnabled) return;
    if (!state.transcripts.length) return;
    const now = Date.now();
    if (conversationSummaryInFlight) return;
    if (!force) {
      if (state.transcripts.length === conversationSummaryTranscriptCount) return;
      if (now - conversationSummaryLastAt < conversationSummaryEverySec * 1000) return;
    }
    conversationSummaryInFlight = true;
    conversationSummaryLastAt = now;
    state.public.conversationSummaryStatus = "refreshing";
    broadcast();
    try {
      addEvent(state, eventLog, "summary.start", "refreshing compact call memory", {
        reason,
        transcripts: state.transcripts.length,
      });
      const started = Date.now();
      const result = await runConversationSummary({
        transcripts: state.transcripts,
        previousSummary: conversationSummary,
        metadata: monitorMetadata,
        provider: conversationSummaryProvider,
        model: conversationSummaryModel,
        serviceTier: conversationSummaryProvider === "openai" ? conversationSummaryServiceTier : "",
        timeoutMs: conversationSummaryTimeoutMs,
        maxTranscriptChars: conversationSummaryMaxTranscriptChars,
        maxSummaryChars: conversationSummaryMaxChars,
      });
      if (result.summary) {
        conversationSummary = result.summary;
        conversationSummaryTranscriptCount = state.transcripts.length;
        monitorMetadata = {
          ...monitorMetadata,
          conversationSummary,
        };
        state.public.conversationSummary = conversationSummary;
        state.public.conversationSummaryChars = conversationSummary.length;
        state.public.conversationSummaryUpdatedAt = new Date().toISOString();
        state.public.conversationSummaryStatus = "ready";
        writeJsonLine(path.join(runDir, "conversation-summary.ndjson"), {
          at: state.public.conversationSummaryUpdatedAt,
          reason,
          summary: conversationSummary,
          transcripts: state.transcripts.length,
          elapsedMs: Date.now() - started,
          provider: result.provider,
          model: result.model,
          serviceTier: result.serviceTier || null,
          usage: result.usage || null,
        });
        addEvent(state, eventLog, "summary.done", `compact memory updated (${conversationSummary.length} chars)`, {
          reason,
          elapsedMs: Date.now() - started,
          provider: result.provider,
          model: result.model,
          serviceTier: result.serviceTier || null,
        });
      } else {
        state.public.conversationSummaryStatus = "empty";
        addEvent(state, eventLog, "summary.empty", "compact memory returned empty", { reason });
      }
    } catch (error) {
      state.public.conversationSummaryStatus = "error";
      state.public.conversationSummaryError = error.message;
      addEvent(state, eventLog, "summary.error", error.message, { reason });
    } finally {
      conversationSummaryInFlight = false;
      broadcast();
    }
  }

  async function maybeSendRealtimeDirectMemoryUpdate(reason = "chunk") {
    if (!realtimeDirectCoach || !conversationSummary) return 0;
    const context = buildRealtimeDirectCoachMemoryContext({
      summary: conversationSummary,
      metadata: monitorMetadata,
    });
    if (!context || context === realtimeDirectLastMemoryContext) return 0;
    await realtimeDirectCoach.addTextContext(context);
    realtimeDirectLastMemoryContext = context;
    addEvent(state, eventLog, "realtime_direct.memory", `sent compact memory update (${context.length} chars)`, {
      reason,
      summaryChars: conversationSummary.length,
      memoryContextChars: context.length,
    });
    return context.length;
  }

  async function runProspectOnlyCoach(entry) {
    if (!prospectOnlyCoachEnabled || !entry?.text) return;
    if (prospectCoachInFlight) {
      prospectCoachPendingEntry = entry;
      return;
    }
    prospectCoachInFlight = true;
    prospectCoachSequence += 1;
    const sequence = prospectCoachSequence;
    const started = Date.now();
    const prospectText = cleanText(entry.text, 900);
    const coachMemoryForContext = cleanText([
      conversationSummary ? `Summary: ${conversationSummary}` : "",
      prospectCoachMemory,
    ].filter(Boolean).join("\n"), 4200);
    const playbookSelection = selectProspectCoachPlaybookContext({
      playbookText: prospectCoachPlaybook,
      prospectText,
      memory: coachMemoryForContext,
      maxChars: prospectCoachPlaybookMaxChars,
    });
    const taxJurisdiction = classifyTaxJurisdiction({
      prospectText,
      memory: coachMemoryForContext,
    });
    setLiveSuggestion({
      status: "streaming",
      sequence,
      text: "",
      finalText: "",
      prospectText,
      startedAt: new Date(started).toISOString(),
      elapsedMs: null,
      provider: prospectCoachProvider,
      model: prospectCoachModel,
      serviceTier: prospectCoachServiceTier || null,
      playbookSections: playbookSelection.sections,
      salesSections: playbookSelection.salesSections,
      taxKnowledgeSections: playbookSelection.taxSections,
      taxJurisdiction: taxJurisdiction.value,
      taxJurisdictionConfidence: taxJurisdiction.confidence,
      taxJurisdictionReason: taxJurisdiction.reason,
      playbookChars: playbookSelection.context.length,
      playbookMaxChars: prospectCoachPlaybookMaxChars,
      error: null,
    });
    addEvent(state, eventLog, "prospect_coach.start", prospectText, {
      entryId: entry.id,
      sequence,
      provider: prospectCoachProvider,
      model: prospectCoachModel,
      serviceTier: prospectCoachServiceTier || null,
      playbookSections: playbookSelection.sections,
      salesSections: playbookSelection.salesSections,
      taxKnowledgeSections: playbookSelection.taxSections,
      taxJurisdiction: taxJurisdiction.value,
      taxJurisdictionConfidence: taxJurisdiction.confidence,
      taxJurisdictionReason: taxJurisdiction.reason,
      playbookChars: playbookSelection.context.length,
    });
    try {
      const prompt = buildProspectOnlyCoachPrompt({
        prospectText,
        recentTranscripts: state.transcripts,
        memory: prospectCoachMemory,
        conversationSummary,
        metadata: monitorMetadata,
        playbook: playbookSelection.context,
        taxJurisdiction,
      });
      let lastBroadcastAt = 0;
      const onDelta = (_delta, output) => {
        const now = Date.now();
        if (now - lastBroadcastAt < 80 && output.length < 16) return;
        lastBroadcastAt = now;
        if ((state.public.liveSuggestion || {}).sequence !== sequence) return;
        setLiveSuggestion({
          status: "streaming",
          text: output,
          elapsedMs: now - started,
        });
      };
      const finalText = prospectCoachProvider === "openai"
        ? await streamOpenAiText({
          prompt,
          model: prospectCoachModel,
          serviceTier: prospectCoachServiceTier,
          timeoutMs: prospectCoachTimeoutMs,
          onDelta,
        })
        : await streamAnthropicText({
          prompt,
          model: prospectCoachModel,
          timeoutMs: prospectCoachTimeoutMs,
          onDelta,
        });
      const cleaned = /^wait\.?$/i.test(finalText) ? "" : finalText;
      prospectCoachMemory = cleanText([
        prospectCoachMemory,
        `Prospect: ${prospectText}`,
        cleaned ? `Coach: ${cleaned}` : "Coach: WAIT",
      ].filter(Boolean).join("\n"), 2000);
      setLiveSuggestion({
        status: cleaned ? "done" : "wait",
        text: cleaned,
        finalText: cleaned,
        elapsedMs: Date.now() - started,
      });
      writeJsonLine(path.join(runDir, "prospect-coach.ndjson"), {
        at: new Date().toISOString(),
        sequence,
        entryId: entry.id,
        prospectText,
        suggestion: cleaned,
        rawSuggestion: finalText,
        elapsedMs: Date.now() - started,
        provider: prospectCoachProvider,
        model: prospectCoachModel,
        serviceTier: prospectCoachServiceTier || null,
        playbookSections: playbookSelection.sections,
        salesSections: playbookSelection.salesSections,
        taxKnowledgeSections: playbookSelection.taxSections,
        taxJurisdiction: taxJurisdiction.value,
        taxJurisdictionConfidence: taxJurisdiction.confidence,
        taxJurisdictionReason: taxJurisdiction.reason,
        playbookChars: playbookSelection.context.length,
      });
      addEvent(state, eventLog, cleaned ? "prospect_coach.done" : "prospect_coach.wait", cleaned || "WAIT", {
        entryId: entry.id,
        sequence,
        elapsedMs: Date.now() - started,
        provider: prospectCoachProvider,
        model: prospectCoachModel,
        serviceTier: prospectCoachServiceTier || null,
        playbookSections: playbookSelection.sections,
        salesSections: playbookSelection.salesSections,
        taxKnowledgeSections: playbookSelection.taxSections,
        taxJurisdiction: taxJurisdiction.value,
        taxJurisdictionConfidence: taxJurisdiction.confidence,
        taxJurisdictionReason: taxJurisdiction.reason,
        playbookChars: playbookSelection.context.length,
      });
    } catch (error) {
      setLiveSuggestion({
        status: "error",
        error: error.message,
        text: "",
        finalText: "",
        elapsedMs: Date.now() - started,
      });
      addEvent(state, eventLog, "prospect_coach.error", error.message, {
        entryId: entry.id,
        sequence,
      });
    } finally {
      prospectCoachInFlight = false;
      const pending = prospectCoachPendingEntry;
      prospectCoachPendingEntry = null;
      if (pending && pending !== entry) {
        void runProspectOnlyCoach(pending);
      }
    }
  }

  async function maybeRefreshAdvice(reason = "transcript") {
    if (prospectOnlyCoachEnabled) return;
    if (!coachEnabled) return;
    const now = Date.now();
    if (adviceInFlight) return;
    if (state.transcripts.length === 0) return;
    if (now - lastAdviceAt < coachEverySec * 1000 && reason !== "forced") return;
    adviceInFlight = true;
    lastAdviceAt = now;
    try {
      addEvent(state, eventLog, "coach.start", "requesting live advice", {
        transcripts: state.transcripts.length,
      });
      const started = Date.now();
      const advice = await runLiveAdvice({
        transcripts: state.transcripts,
        metadata: monitorMetadata,
        model: coachModel,
        timeoutMs: 25_000,
      });
      state.advice = {
        ...advice,
        at: new Date().toISOString(),
        elapsedMs: Date.now() - started,
      };
      addEvent(state, eventLog, "coach.done", state.advice.coach.oneSentenceFocus || "advice updated", {
        elapsedMs: state.advice.elapsedMs,
        model: state.advice.model,
      });
      if (sessionId) {
        try {
          const published = await publishUiState({
            sessionId,
            controlPlaneUrl,
            internalSecret,
            advice: state.advice,
            metadata: monitorMetadata,
            eventLog,
          });
          addEvent(state, eventLog, "ui_state.done", "published advice to trainer UI", {
            version: published?.version || null,
          });
        } catch (error) {
          addEvent(state, eventLog, "ui_state.error", error.message);
        }
      }
      broadcast();
    } catch (error) {
      addEvent(state, eventLog, "coach.error", error.message);
      broadcast();
    } finally {
      adviceInFlight = false;
    }
  }

  function takeDisplayTranscripts({ text, chunkId, startedAt, endedAt, nativeSegments = [] }) {
    const now = Date.now();
    if (!pendingTranscript) {
      pendingTranscript = {
        text: "",
        chunkIds: [],
        nativeSegments: [],
        startedAt,
        startedMs: now,
      };
    }

    pendingTranscript.text = mergeTranscriptFragments([pendingTranscript.text, text]);
    if (!pendingTranscript.chunkIds.includes(chunkId)) pendingTranscript.chunkIds.push(chunkId);
    pendingTranscript.nativeSegments = [
      ...(pendingTranscript.nativeSegments || []),
      ...normalizeNativeDiarizeRawSegments(nativeSegments),
    ];
    const combined = pendingTranscript.text;
    const holdMs = now - pendingTranscript.startedMs;
    const { sentences, tail } = splitCompleteTranscriptUnits(combined);
    const holdExpired = sentenceHoldMs > 0 && holdMs >= sentenceHoldMs;
    let remainingNativeSegments = pendingTranscript.nativeSegments || [];
    const results = sentences.map((sentence) => {
      const consumed = consumeNativeSegmentsForText(remainingNativeSegments, sentence);
      remainingNativeSegments = consumed.remaining;
      return {
        text: sentence,
        startedAt: pendingTranscript.startedAt,
        endedAt,
        heldChunkIds: [...pendingTranscript.chunkIds],
        holdMs,
        complete: true,
        nativeSegments: consumed.segments,
      };
    });

    if (results.length) {
      pendingTranscript = tail
        ? {
          text: tail,
          chunkIds: [chunkId],
          nativeSegments: remainingNativeSegments,
          startedAt,
          startedMs: now,
        }
        : null;
      return results;
    }

    const tailText = tail || combined;
    if (shouldPublishIncompleteTranscript(tailText, holdExpired)) {
      const consumed = consumeNativeSegmentsForText(pendingTranscript.nativeSegments, tailText);
      const result = {
        text: tailText,
        startedAt: pendingTranscript.startedAt,
        endedAt,
        heldChunkIds: [...pendingTranscript.chunkIds],
        holdMs,
        complete: false,
        nativeSegments: consumed.segments.length ? consumed.segments : pendingTranscript.nativeSegments,
      };
      pendingTranscript = null;
      return [result];
    }

    pendingTranscript.text = tailText;
    pendingTranscript.nativeSegments = remainingNativeSegments;
    return [];
  }

  function enqueueSpeakerLabel(entry, chunkText, entryId) {
    if (!speakerLabelsEnabled) return;
    const expectedRevision = entry.revision || 0;
    entry.speakerStatus = "pending";
    void (async () => {
      const speakerStarted = Date.now();
      try {
        const recentSegments = state.transcripts
          .filter((item) => item.id !== entryId)
          .flatMap((item) => item.speakerSegments || []);
        const labeled = await labelSpeakerSegments({
          chunkText,
          recentSegments,
          metadata: monitorMetadata,
          model: speakerModel,
          timeoutMs: 12_000,
        });
        if (!state.transcripts.includes(entry)) return;
        if ((entry.revision || 0) !== expectedRevision) return;
        entry.speakerSegments = labeled.segments;
        entry.speakerModel = labeled.model;
        entry.speakerElapsedMs = Date.now() - speakerStarted;
        entry.speakerStatus = "done";
        writeJsonLine(path.join(runDir, "speaker-labels.ndjson"), {
          id: entryId,
          at: new Date().toISOString(),
          revision: entry.revision || 0,
          speakerSegments: entry.speakerSegments,
          model: entry.speakerModel,
          elapsedMs: entry.speakerElapsedMs,
        });
        addEvent(state, eventLog, "speaker.done", entry.speakerSegments.map((segment) => `${segment.speaker}: ${segment.text}`).join(" | "), {
          chunkId: entryId,
          revision: entry.revision || 0,
          elapsedMs: entry.speakerElapsedMs,
          model: entry.speakerModel,
        });
        broadcast();
        void maybeRefreshAdvice("speaker-labels");
      } catch (error) {
        if ((entry.revision || 0) !== expectedRevision) return;
        entry.speakerStatus = "error";
        entry.speakerElapsedMs = Date.now() - speakerStarted;
        addEvent(state, eventLog, "speaker.error", error.message, {
          chunkId: entryId,
          revision: entry.revision || 0,
          elapsedMs: entry.speakerElapsedMs,
        });
        broadcast();
      }
    })();
  }

  function isSemanticGlueCandidate(previousEntry, currentEntry, now = Date.now()) {
    if (!semanticGlueEnabled || !previousEntry || !currentEntry) return false;
    if (!previousEntry.text || !currentEntry.text) return false;
    if (previousEntry.mergedInto || currentEntry.mergedInto) return false;
    if (isPrimerHallucination(previousEntry.text) || isPrimerHallucination(currentEntry.text)) return false;
    if (isSystemOnlyTranscript(previousEntry.text) || isSystemOnlyTranscript(currentEntry.text)) return false;

    const previousEndedAt = Date.parse(previousEntry.endedAt || previousEntry.at || "") || 0;
    const currentStartedAt = Date.parse(currentEntry.startedAt || currentEntry.at || "") || 0;
    if (semanticGlueWindowMs > 0 && previousEndedAt && currentStartedAt) {
      const gapMs = currentStartedAt - previousEndedAt;
      if (gapMs > semanticGlueWindowMs || gapMs < -1000) return false;
    }

    const currentClean = normalizeForDedupe(currentEntry.text);
    if (!currentClean) return false;
    if (/^(hello|hi|hey|yes|yeah|yep|no|nope|okay|ok|sorry|speaking|thank you|thanks)\b/.test(currentClean)) {
      return false;
    }
    if (/^(what|why|how|when|where|who|can|could|do|does|did|is|are|will|would|should)\b/.test(currentClean)) {
      return false;
    }
    if (/\?\s*$/.test(currentEntry.text)) return false;

    const combinedTokens = wordTokens(`${previousEntry.text} ${currentEntry.text}`);
    if (combinedTokens.length > 150) return false;
    return wordTokens(currentEntry.text).length >= 3;
  }

  function applySemanticGlueDecision(previousEntry, currentEntry, decision) {
    const currentIndex = state.transcripts.findIndex((item) => item.id === currentEntry.id);
    if (currentIndex <= 0) return false;
    const livePreviousEntry = state.transcripts[currentIndex - 1];
    if (!livePreviousEntry || livePreviousEntry.id !== previousEntry.id) return false;

    const revisedText = cleanText(decision.revisedPreviousText, 3000);
    const mergedText = revisedText && normalizeForDedupe(revisedText).includes(normalizeForDedupe(currentEntry.text).slice(0, 20))
      ? revisedText
      : joinTranscriptContinuation(livePreviousEntry.text, currentEntry.text);

    livePreviousEntry.revision = (livePreviousEntry.revision || 0) + 1;
    livePreviousEntry.text = mergedText;
    livePreviousEntry.endedAt = currentEntry.endedAt || livePreviousEntry.endedAt;
    livePreviousEntry.at = currentEntry.at || livePreviousEntry.at;
    livePreviousEntry.durationSec = Number((Number(livePreviousEntry.durationSec || 0) + Number(currentEntry.durationSec || 0)).toFixed(2));
    livePreviousEntry.byteLength = Number(livePreviousEntry.byteLength || 0) + Number(currentEntry.byteLength || 0);
    livePreviousEntry.activePctOver500 = Math.max(Number(livePreviousEntry.activePctOver500 || 0), Number(currentEntry.activePctOver500 || 0));
    livePreviousEntry.elapsedMs = Number(livePreviousEntry.elapsedMs || 0) + Number(currentEntry.elapsedMs || 0);
    livePreviousEntry.heldChunkIds = [...new Set([...(livePreviousEntry.heldChunkIds || []), ...(currentEntry.heldChunkIds || [])])];
    livePreviousEntry.stagedSourceChunkIds = [...new Set([...(livePreviousEntry.stagedSourceChunkIds || []), ...(currentEntry.stagedSourceChunkIds || [])])];
    livePreviousEntry.sentenceHoldMs = Math.max(Number(livePreviousEntry.sentenceHoldMs || 0), Number(currentEntry.sentenceHoldMs || 0));
    livePreviousEntry.sentenceComplete = Boolean(livePreviousEntry.sentenceComplete && currentEntry.sentenceComplete);
    livePreviousEntry.nativeDiarizeSegments = [
      ...(livePreviousEntry.nativeDiarizeSegments || []),
      ...(currentEntry.nativeDiarizeSegments || []),
    ];
    livePreviousEntry.semanticGluedFragments = [
      ...(livePreviousEntry.semanticGluedFragments || []),
      {
        id: currentEntry.id,
        text: currentEntry.text,
        at: currentEntry.at,
        confidence: decision.confidence,
        reason: decision.reason,
        model: decision.model,
      },
    ];
    livePreviousEntry.semanticGlueStatus = "appended";
    livePreviousEntry.semanticGlueModel = decision.model;
    livePreviousEntry.semanticGlueReason = decision.reason;
    livePreviousEntry.speakerSegments = nativeDiarizeEnabled
      ? speakerSegmentsFromNativeDiarize(livePreviousEntry.nativeDiarizeSegments, livePreviousEntry.text, {
        recentSegments: state.transcripts
          .filter((item) => item.id !== livePreviousEntry.id && item.id !== currentEntry.id)
          .flatMap((item) => item.speakerSegments || []),
        metadata: monitorMetadata,
        nativeSpeakerAssignments,
      })
      : normalizeSpeakerSegments({}, livePreviousEntry.text);
    livePreviousEntry.speakerModel = null;
    livePreviousEntry.speakerElapsedMs = null;
    livePreviousEntry.speakerStatus = nativeDiarizeEnabled ? "native-diarize-glued" : speakerLabelsEnabled ? "pending" : "off";

    currentEntry.mergedInto = livePreviousEntry.id;
    currentEntry.semanticGlueStatus = "merged";
    state.transcripts.splice(currentIndex, 1);

    writeJsonLine(path.join(runDir, "transcript-revisions.ndjson"), {
      id: livePreviousEntry.id,
      at: new Date().toISOString(),
      revision: livePreviousEntry.revision,
      semanticGlue: true,
      appendedFrom: currentEntry.id,
      confidence: decision.confidence,
      reason: decision.reason,
      model: decision.model,
      appendedText: currentEntry.text,
      text: livePreviousEntry.text,
    });
    addEvent(state, eventLog, "semantic_glue.append", `merged newest row into prior thought: ${currentEntry.text}`, {
      targetId: livePreviousEntry.id,
      appendedFrom: currentEntry.id,
      confidence: decision.confidence,
      reason: decision.reason,
      model: decision.model,
    });
    broadcast();
    void maybeRefreshConversationSummary("semantic-glue");
    void maybeRefreshAdvice("semantic-glue");
    enqueueSpeakerLabel(livePreviousEntry, livePreviousEntry.text, livePreviousEntry.id);
    return true;
  }

  function enqueueSemanticGlue(entry, entryId) {
    if (!semanticGlueEnabled) return;
    const currentIndex = state.transcripts.findIndex((item) => item.id === entryId);
    if (currentIndex <= 0) return;
    const previousEntry = state.transcripts[currentIndex - 1];
    if (!isSemanticGlueCandidate(previousEntry, entry)) return;
    const expectedRevision = entry.revision || 0;
    entry.semanticGlueStatus = "pending";
    broadcast();

    void (async () => {
      const glueStarted = Date.now();
      try {
        const liveIndex = state.transcripts.findIndex((item) => item.id === entryId);
        if (liveIndex <= 0) return;
        const liveEntry = state.transcripts[liveIndex];
        const livePrevious = state.transcripts[liveIndex - 1];
        if (!liveEntry || !livePrevious || (liveEntry.revision || 0) !== expectedRevision) return;
        if (!isSemanticGlueCandidate(livePrevious, liveEntry)) return;

        const decision = await runSemanticGlueDecision({
          previousEntry: livePrevious,
          currentEntry: liveEntry,
          recentEntries: state.transcripts.slice(Math.max(0, liveIndex - 5), liveIndex + 1),
          metadata: monitorMetadata,
          model: semanticGlueModel,
          timeoutMs: 8_000,
        });

        const stillIndex = state.transcripts.findIndex((item) => item.id === entryId);
        if (stillIndex <= 0) return;
        const stillEntry = state.transcripts[stillIndex];
        const stillPrevious = state.transcripts[stillIndex - 1];
        if (!stillEntry || !stillPrevious || (stillEntry.revision || 0) !== expectedRevision) return;

        stillEntry.semanticGlueStatus = decision.action === "append_previous" ? "append-candidate" : "separate";
        stillEntry.semanticGlueDecision = {
          action: decision.action,
          confidence: decision.confidence,
          reason: decision.reason,
          model: decision.model,
          elapsedMs: Date.now() - glueStarted,
        };
        writeJsonLine(path.join(runDir, "semantic-glue.ndjson"), {
          id: entryId,
          at: new Date().toISOString(),
          previousId: stillPrevious.id,
          decision: stillEntry.semanticGlueDecision,
          previousText: stillPrevious.text,
          currentText: stillEntry.text,
          revisedPreviousText: decision.revisedPreviousText,
        });

        if (decision.action === "append_previous" && decision.confidence >= semanticGlueMinConfidence) {
          applySemanticGlueDecision(stillPrevious, stillEntry, decision);
          return;
        }

        addEvent(state, eventLog, "semantic_glue.keep", decision.reason || "kept newest row separate", {
          chunkId: entryId,
          confidence: decision.confidence,
          model: decision.model,
          elapsedMs: Date.now() - glueStarted,
        });
        broadcast();
      } catch (error) {
        if (!state.transcripts.includes(entry)) return;
        entry.semanticGlueStatus = "error";
        addEvent(state, eventLog, "semantic_glue.error", error.message, {
          chunkId: entryId,
          elapsedMs: Date.now() - glueStarted,
        });
        broadcast();
      }
    })();
  }

  function stageDisplayTranscript(displayTranscript, meta = {}) {
    stagedDisplayTranscripts.push({
      ...displayTranscript,
      model: meta.model || null,
      responseFormat: meta.responseFormat || null,
      byteLength: Number(meta.byteLength || 0),
      durationSec: Number(meta.durationSec || 0),
      activePctOver500: Number(meta.activePctOver500 || 0),
      elapsedMs: Number(meta.elapsedMs || 0),
      sourceChunkId: meta.chunkId || "",
    });
    writeJsonLine(path.join(runDir, "transcript-stage.ndjson"), {
      at: new Date().toISOString(),
      sourceChunkId: meta.chunkId || "",
      text: displayTranscript.text,
      reason: meta.flushReason || "stage",
    });
  }

  function publishStagedTurn(reason = "silence") {
    if (!stagedDisplayTranscripts.length) return false;
    const staged = stagedDisplayTranscripts;
    stagedDisplayTranscripts = [];
    const text = mergeTranscriptFragments(staged.map((item) => item.text));
    if (!text || isLowSignalTranscript(text)) {
      addEvent(state, eventLog, "stt.stage.skip", `staged turn skipped: ${text || "(empty)"}`, {
        reason,
        stagedParts: staged.length,
      });
      broadcast();
      return false;
    }
    stagedTurnSequence += 1;
    const entryId = `${runId}-turn-${String(stagedTurnSequence).padStart(4, "0")}`;
    const nativeSegments = staged.flatMap((item) => item.nativeSegments || []);
    const entry = {
      id: entryId,
      at: new Date(staged[staged.length - 1].endedAt).toISOString(),
      startedAt: new Date(staged[0].startedAt).toISOString(),
      endedAt: new Date(staged[staged.length - 1].endedAt).toISOString(),
      text,
      speakerSegments: nativeDiarizeEnabled
        ? speakerSegmentsFromNativeDiarize(nativeSegments, text, {
          recentSegments: state.transcripts.flatMap((item) => item.speakerSegments || []),
          metadata: monitorMetadata,
          nativeSpeakerAssignments,
        })
        : normalizeSpeakerSegments({}, text),
      speakerModel: null,
      speakerElapsedMs: null,
      speakerStatus: nativeDiarizeEnabled ? "native-diarize-staged" : speakerLabelsEnabled ? "pending" : "off",
      model: staged.find((item) => item.model)?.model || sttModel,
      responseFormat: staged.find((item) => item.responseFormat)?.responseFormat || sttResponseFormat || null,
      byteLength: staged.reduce((sum, item) => sum + Number(item.byteLength || 0), 0),
      durationSec: Number(staged.reduce((sum, item) => sum + Number(item.durationSec || 0), 0).toFixed(2)),
      activePctOver500: Math.max(...staged.map((item) => Number(item.activePctOver500 || 0))),
      elapsedMs: staged.reduce((sum, item) => sum + Number(item.elapsedMs || 0), 0),
      heldChunkIds: [...new Set(staged.flatMap((item) => item.heldChunkIds || []))],
      stagedSourceChunkIds: [...new Set(staged.map((item) => item.sourceChunkId).filter(Boolean))],
      sentenceHoldMs: Math.max(...staged.map((item) => Number(item.holdMs || 0))),
      sentenceComplete: staged.every((item) => item.complete !== false),
      nativeDiarizeSegments: nativeDiarizeEnabled ? nativeSegments : undefined,
      stageReason: reason,
      revision: 0,
    };
    state.transcripts.push(entry);
    if (state.transcripts.length > 300) state.transcripts.splice(0, state.transcripts.length - 300);
    writeJsonLine(path.join(runDir, "transcripts.ndjson"), entry);
    addEvent(state, eventLog, "stt.stage.publish", text, {
      chunkId: entryId,
      reason,
      stagedParts: staged.length,
      sourceChunkIds: entry.stagedSourceChunkIds,
    });
    broadcast();
    void maybeRefreshConversationSummary("transcript-stage");
    enqueueProspectCoach(entry, "transcript-stage");
    void maybeRefreshAdvice("transcript-stage");
    enqueueSemanticGlue(entry, entryId);
    enqueueSpeakerLabel(entry, text, entryId);
    return true;
  }

  function transcriptEntrySpeaker(entry = {}) {
    const raw = String(entry.speakerSegments?.[0]?.speaker || "").trim().toLowerCase();
    return SPEAKER_KEYS.includes(raw) ? raw : "unknown";
  }

  function transcriptEntrySpeakerConfidence(entry = {}) {
    return clampNumber(entry.speakerSegments?.[0]?.confidence, 0, 1, 0);
  }

  function shouldRunProspectCoachForEntry(entry = {}) {
    if (!prospectOnlyCoachEnabled || !entry?.text) return false;
    const speaker = transcriptEntrySpeaker(entry);
    if (speaker === "prospect") {
      return transcriptEntrySpeakerConfidence(entry) >= prospectCoachMinSpeakerConfidence;
    }
    if (!semanticTurnsEnabled && !nativeDiarizeEnabled && !speakerLabelsEnabled) {
      return speaker === "unknown";
    }
    return false;
  }

  function enqueueProspectCoach(entry, reason = "transcript") {
    if (shouldRunProspectCoachForEntry(entry)) {
      void runProspectOnlyCoach(entry);
      return true;
    }
    if (prospectOnlyCoachEnabled && entry?.text) {
      addEvent(state, eventLog, "prospect_coach.skip", `not prospect turn (${transcriptEntrySpeaker(entry)})`, {
        entryId: entry.id || null,
        reason,
        speaker: transcriptEntrySpeaker(entry),
        confidence: transcriptEntrySpeakerConfidence(entry),
      });
    }
    return false;
  }

  function findRecentSemanticTurnDuplicate(turn, meta = {}) {
    const speaker = String(turn?.speaker || "unknown").trim().toLowerCase();
    const candidateAt = Date.parse(meta.endedAt || meta.startedAt || "") || Date.now();
    const recent = state.transcripts
      .slice(-18)
      .map((entry, index) => ({ entry, index }))
      .reverse();

    for (const { entry } of recent) {
      if (!entry || entry.stageReason !== "semantic-turn") continue;
      if (speaker !== transcriptEntrySpeaker(entry)) continue;
      const entryAt = Date.parse(entry.endedAt || entry.at || "") || 0;
      if (entryAt && Math.abs(candidateAt - entryAt) > 75_000) continue;
      const relationship = semanticTurnTextRelationship(turn.text, entry.text);
      if (relationship) return { entry, relationship };
    }
    return null;
  }

  function reviseSemanticDuplicateEntry(entry, turn, meta = {}, relationship = {}) {
    const originalText = entry.text || "";
    const revisedText = cleanText(turn.text, 3000);
    if (!revisedText || normalizeForDedupe(revisedText) === normalizeForDedupe(originalText)) return entry;

    entry.revision = (entry.revision || 0) + 1;
    entry.text = revisedText;
    entry.endedAt = new Date(meta.endedAt || Date.now()).toISOString();
    entry.at = entry.endedAt;
    entry.durationSec = Math.max(Number(entry.durationSec || 0), Number(meta.durationSec || 0));
    entry.byteLength = Math.max(Number(entry.byteLength || 0), Number(meta.byteLength || 0));
    entry.activePctOver500 = Math.max(Number(entry.activePctOver500 || 0), Number(meta.activePctOver500 || 0));
    entry.elapsedMs = Math.max(Number(entry.elapsedMs || 0), Number(meta.elapsedMs || 0));
    entry.heldChunkIds = [...new Set([
      ...(entry.heldChunkIds || []),
      ...(Array.isArray(meta.chunkIds) && meta.chunkIds.length ? meta.chunkIds : meta.chunkId ? [meta.chunkId] : []),
    ])];
    entry.speakerSegments = [{
      speaker: turn.speaker || "unknown",
      text: revisedText,
      confidence: turn.confidence,
      reason: turn.reason || relationship.reason || "semantic duplicate revision",
    }];
    entry.semanticTurnRevision = {
      ...(entry.semanticTurnRevision || {}),
      dedupe: true,
      confidence: relationship.confidence || null,
      reason: relationship.reason || "",
      model: meta.semanticModel || null,
      serviceTier: meta.semanticServiceTier || null,
      previousText: originalText,
      at: new Date().toISOString(),
    };
    writeJsonLine(path.join(runDir, "transcript-revisions.ndjson"), {
      id: entry.id,
      at: new Date().toISOString(),
      revision: entry.revision,
      semanticTurnDedupe: true,
      action: "revise",
      confidence: relationship.confidence || null,
      reason: relationship.reason || "",
      model: meta.semanticModel || null,
      serviceTier: meta.semanticServiceTier || null,
      previousText: originalText,
      text: entry.text,
    });
    addEvent(state, eventLog, "semantic_turn.dedupe_revise", `revised duplicate semantic row: ${entry.text}`, {
      targetId: entry.id,
      revision: entry.revision,
      confidence: relationship.confidence || null,
      reason: relationship.reason || "",
      serviceTier: meta.semanticServiceTier || null,
    });
    return entry;
  }

  function publishSemanticTurn(turn, meta = {}) {
    if (!turn?.text || (turn.speaker === "system" && isSystemOnlyTranscript(turn.text))) {
      addEvent(state, eventLog, "semantic_turn.skip", `semantic turn skipped: ${turn?.text || "(empty)"}`, {
        reason: turn?.reason || "",
      });
      return null;
    }
    if (isLikelyDanglingSemanticTurn(turn.text)) {
      addEvent(state, eventLog, "semantic_turn.dangling_skip", `semantic turn held as dangling: ${turn.text}`, {
        reason: turn.reason || "",
      });
      return null;
    }
    const duplicate = findRecentSemanticTurnDuplicate(turn, meta);
    if (duplicate?.relationship?.action === "skip") {
      writeJsonLine(path.join(runDir, "semantic-turn-skips.ndjson"), {
        at: new Date().toISOString(),
        action: "skip",
        reason: duplicate.relationship.reason || "",
        confidence: duplicate.relationship.confidence || null,
        existingId: duplicate.entry.id,
        existingText: duplicate.entry.text,
        text: turn.text,
        chunkId: meta.chunkId || null,
      });
      addEvent(state, eventLog, "semantic_turn.dedupe_skip", `duplicate semantic turn skipped: ${turn.text}`, {
        chunkId: meta.chunkId || null,
        existingId: duplicate.entry.id,
        confidence: duplicate.relationship.confidence || null,
        reason: duplicate.relationship.reason || "",
      });
      return null;
    }
    if (duplicate?.relationship?.action === "revise") {
      return reviseSemanticDuplicateEntry(duplicate.entry, turn, meta, duplicate.relationship);
    }
    semanticTurnSequence += 1;
    const entryId = `${runId}-semantic-${String(semanticTurnSequence).padStart(4, "0")}`;
    const entry = {
      id: entryId,
      at: new Date(meta.endedAt || Date.now()).toISOString(),
      startedAt: new Date(meta.startedAt || Date.now()).toISOString(),
      endedAt: new Date(meta.endedAt || Date.now()).toISOString(),
      text: turn.text,
      speakerSegments: [{
        speaker: turn.speaker || "unknown",
        text: turn.text,
        confidence: turn.confidence,
        reason: turn.reason || "semantic turn assembler",
      }],
      speakerModel: meta.semanticModel || null,
      speakerElapsedMs: meta.elapsedMs || null,
      speakerStatus: "semantic-turn",
      model: meta.sttModel || sttModel,
      responseFormat: meta.responseFormat || null,
      semanticProvider: meta.semanticProvider || null,
      semanticModel: meta.semanticModel || null,
      semanticServiceTier: meta.semanticServiceTier || null,
      semanticReason: turn.reason || "",
      byteLength: Number(meta.byteLength || 0),
      durationSec: Number(meta.durationSec || 0),
      activePctOver500: Number(meta.activePctOver500 || 0),
      elapsedMs: Number(meta.elapsedMs || 0),
      heldChunkIds: Array.isArray(meta.chunkIds) && meta.chunkIds.length
        ? meta.chunkIds
        : meta.chunkId ? [meta.chunkId] : [],
      sentenceHoldMs: 0,
      sentenceComplete: true,
      stageReason: "semantic-turn",
      revision: 0,
    };
    state.transcripts.push(entry);
    if (state.transcripts.length > 300) state.transcripts.splice(0, state.transcripts.length - 300);
    writeJsonLine(path.join(runDir, "transcripts.ndjson"), entry);
    addEvent(state, eventLog, "semantic_turn.publish", turn.text, {
      chunkId: meta.chunkId || null,
      entryId,
      speaker: turn.speaker,
      confidence: turn.confidence,
      provider: meta.semanticProvider || null,
      model: meta.semanticModel || null,
      serviceTier: meta.semanticServiceTier || null,
      elapsedMs: meta.elapsedMs || null,
    });
    return entry;
  }

  function applySemanticPreviousRevision(revisePrevious, meta = {}) {
    if (!revisePrevious || revisePrevious.action === "none") return false;
    if (revisePrevious.confidence < semanticTurnRevisionMinConfidence) return false;
    const previousEntry = state.transcripts[state.transcripts.length - 1] || null;
    if (!previousEntry || !revisePrevious.text) return false;
    const originalText = previousEntry.text || "";
    previousEntry.revision = (previousEntry.revision || 0) + 1;
    previousEntry.text = revisePrevious.text;
    previousEntry.endedAt = new Date(meta.endedAt || Date.now()).toISOString();
    previousEntry.at = previousEntry.endedAt;
    previousEntry.semanticTurnRevision = {
      action: revisePrevious.action,
      confidence: revisePrevious.confidence,
      reason: revisePrevious.reason,
      model: meta.semanticModel || null,
      serviceTier: meta.semanticServiceTier || null,
      at: new Date().toISOString(),
      previousText: originalText,
    };
    previousEntry.speakerSegments = normalizeSpeakerSegments({
      segments: (previousEntry.speakerSegments || []).map((segment, index) => ({
        ...segment,
        text: index === 0 ? revisePrevious.text : segment.text,
      })),
    }, revisePrevious.text);
    writeJsonLine(path.join(runDir, "transcript-revisions.ndjson"), {
      id: previousEntry.id,
      at: new Date().toISOString(),
      revision: previousEntry.revision,
      semanticTurnRevision: true,
      action: revisePrevious.action,
      confidence: revisePrevious.confidence,
      reason: revisePrevious.reason,
      model: meta.semanticModel || null,
      serviceTier: meta.semanticServiceTier || null,
      previousText: originalText,
      text: previousEntry.text,
    });
    addEvent(state, eventLog, "semantic_turn.revise", `revised previous row: ${previousEntry.text}`, {
      targetId: previousEntry.id,
      revision: previousEntry.revision,
      action: revisePrevious.action,
      confidence: revisePrevious.confidence,
      serviceTier: meta.semanticServiceTier || null,
    });
    return true;
  }

  async function processSemanticTurnText({
    text,
    chunkId,
    chunkIds,
    startedAt,
    endedAt,
    transcript,
    stats,
    sttStarted,
    pcmuBuffer,
    flushReason,
  }) {
    const previousBuffer = semanticTurnBuffer;
    const semanticStarted = Date.now();
    let decision;
    try {
      decision = await runSemanticTurnDecision({
        bufferText: previousBuffer,
        newText: text,
        recentEntries: state.transcripts,
        callMemory: semanticCallMemory,
        metadata: monitorMetadata,
        flushReason,
        provider: semanticTurnProvider,
        model: semanticTurnModel,
        serviceTier: semanticTurnProvider === "openai" ? semanticTurnServiceTier : "",
        timeoutMs: semanticTurnTimeoutMs,
        maxBufferChars: semanticTurnMaxBufferChars,
        maxMemoryChars: semanticTurnMemoryChars,
      });
    } catch (error) {
      semanticTurnBuffer = trimFromLeft(mergeTranscriptFragments([previousBuffer, text]), semanticTurnMaxBufferChars);
      state.public.semanticTurnBufferChars = semanticTurnBuffer.length;
      addEvent(state, eventLog, "semantic_turn.error", error.message, {
        chunkId,
        bufferChars: semanticTurnBuffer.length,
      });
      broadcast();
      return;
    }

    semanticTurnBuffer = trimFromLeft(decision.remainingText, semanticTurnMaxBufferChars);
    semanticCallMemory = cleanText(decision.callMemory, semanticTurnMemoryChars);
    monitorMetadata = {
      ...monitorMetadata,
      semanticCallMemory,
    };
    state.public.semanticTurnBufferChars = semanticTurnBuffer.length;
    state.public.semanticCallMemory = semanticCallMemory;
    writeJsonLine(path.join(runDir, "semantic-turns.ndjson"), {
      at: new Date().toISOString(),
      chunkId,
      provider: decision.provider,
      model: decision.model,
      serviceTier: decision.serviceTier || null,
      rawText: text,
      previousBuffer,
      remainingText: semanticTurnBuffer,
      completeTurns: decision.completeTurns,
      revisePrevious: decision.revisePrevious,
      callMemory: semanticCallMemory,
      reason: decision.reason,
      elapsedMs: Date.now() - semanticStarted,
      usage: decision.usage || null,
    });
    writeJsonLine(path.join(runDir, "semantic-memory.ndjson"), {
      at: new Date().toISOString(),
      chunkId,
      callMemory: semanticCallMemory,
    });

    const danglingTurns = decision.completeTurns.filter((turn) => isLikelyDanglingSemanticTurn(turn.text));
    const publishableTurns = decision.completeTurns.filter((turn) => !isLikelyDanglingSemanticTurn(turn.text));
    if (danglingTurns.length) {
      semanticTurnBuffer = trimFromLeft(
        mergeTranscriptFragments([
          ...danglingTurns.map((turn) => turn.text),
          semanticTurnBuffer,
        ]),
        semanticTurnMaxBufferChars,
      );
      state.public.semanticTurnBufferChars = semanticTurnBuffer.length;
      addEvent(state, eventLog, "semantic_turn.rehold", `held dangling turn(s): ${danglingTurns.map((turn) => turn.text).join(" | ")}`, {
        chunkId,
        provider: decision.provider,
        model: decision.model,
        serviceTier: decision.serviceTier || null,
        bufferChars: semanticTurnBuffer.length,
      });
    }

    const revised = applySemanticPreviousRevision(decision.revisePrevious, {
      endedAt,
      semanticModel: decision.model,
      semanticServiceTier: decision.serviceTier || null,
    });
    const published = publishableTurns
      .map((turn) => publishSemanticTurn(turn, {
        chunkId,
        chunkIds,
        startedAt,
        endedAt,
        sttModel: transcript.model,
        responseFormat: transcript.responseFormat || null,
        semanticProvider: decision.provider,
        semanticModel: decision.model,
        semanticServiceTier: decision.serviceTier || null,
        byteLength: pcmuBuffer.length,
        durationSec: Number(stats.durationSec.toFixed(2)),
        activePctOver500: stats.activePctOver500,
        elapsedMs: Date.now() - sttStarted,
      }))
      .filter(Boolean);

    if (!published.length && !revised) {
      addEvent(state, eventLog, "semantic_turn.hold", `semantic buffer held: ${semanticTurnBuffer || text}`, {
        chunkId,
        provider: decision.provider,
        model: decision.model,
        serviceTier: decision.serviceTier || null,
        bufferChars: semanticTurnBuffer.length,
        reason: decision.reason,
        elapsedMs: Date.now() - semanticStarted,
      });
    }

    if (published.length || revised) {
      broadcast();
      void maybeRefreshConversationSummary("semantic-turn");
      published.forEach((entry) => enqueueProspectCoach(entry, "semantic-turn"));
      void maybeRefreshAdvice("semantic-turn");
    } else {
      broadcast();
    }
  }

  function updateSemanticTurnBatchPublic() {
    const text = mergeTranscriptFragments(semanticTurnBatchItems.map((item) => item.text));
    state.public.semanticTurnBatchChars = text.length;
    state.public.semanticTurnBatchParts = semanticTurnBatchItems.length;
    return text;
  }

  async function flushSemanticTurnBatch(reason = "timer") {
    if (!semanticTurnBatchItems.length) return false;
    const items = semanticTurnBatchItems;
    semanticTurnBatchItems = [];
    semanticTurnBatchStartedAt = 0;
    updateSemanticTurnBatchPublic();

    const text = mergeTranscriptFragments(items.map((item) => item.text));
    semanticTurnBatchSequence += 1;
    const batchId = `${runId}-semantic-batch-${String(semanticTurnBatchSequence).padStart(4, "0")}`;
    const first = items[0];
    const last = items[items.length - 1];
    const chunkIds = [...new Set(items.map((item) => item.chunkId).filter(Boolean))];
    const pcmuBuffer = Buffer.concat(items.map((item) => item.pcmuBuffer).filter(Boolean));
    const durationSec = items.reduce((sum, item) => sum + Number(item.stats?.durationSec || 0), 0);
    const activePctOver500 = Math.max(...items.map((item) => Number(item.stats?.activePctOver500 || 0)));
    writeJsonLine(path.join(runDir, "semantic-turn-batches.ndjson"), {
      at: new Date().toISOString(),
      batchId,
      reason,
      sourceChunkIds: chunkIds,
      text,
      parts: items.length,
      durationSec: Number(durationSec.toFixed(2)),
      activePctOver500,
    });
    addEvent(state, eventLog, "semantic_turn.batch_flush", `semantic batch ${batchId} (${items.length} chunks)`, {
      batchId,
      reason,
      sourceChunkIds: chunkIds,
      chars: text.length,
    });
    if (!text || isLowSignalTranscript(text)) {
      addEvent(state, eventLog, "semantic_turn.batch_skip", `semantic batch skipped: ${text || "(empty)"}`, {
        batchId,
        reason,
      });
      broadcast();
      return false;
    }
    await processSemanticTurnText({
      text,
      chunkId: batchId,
      chunkIds,
      startedAt: first.startedAt,
      endedAt: last.endedAt,
      transcript: {
        model: last.transcript?.model || sttModel,
        responseFormat: last.transcript?.responseFormat || sttResponseFormat || null,
      },
      stats: {
        durationSec,
        activePctOver500,
      },
      sttStarted: Math.min(...items.map((item) => Number(item.sttStarted || Date.now()))),
      pcmuBuffer,
      flushReason: `semantic-batch:${reason}`,
    });
    return true;
  }

  function enqueueSemanticTurnBatchFlush(reason = "timer") {
    if (!semanticTurnsEnabled || semanticTurnBatchMs <= 0 || !semanticTurnBatchItems.length || semanticTurnBatchFlushQueued) return;
    semanticTurnBatchFlushQueued = true;
    transcriptionQueue = transcriptionQueue
      .then(async () => {
        semanticTurnBatchFlushQueued = false;
        await flushSemanticTurnBatch(reason);
      })
      .catch((error) => {
        semanticTurnBatchFlushQueued = false;
        addEvent(state, eventLog, "semantic_turn.batch_error", error.message);
        broadcast();
      });
  }

  async function stageSemanticTurnText(args) {
    if (semanticTurnBatchMs <= 0) {
      await processSemanticTurnText(args);
      return;
    }
    if (!semanticTurnBatchStartedAt) semanticTurnBatchStartedAt = Date.now();
    semanticTurnBatchItems.push(args);
    const text = updateSemanticTurnBatchPublic();
    writeJsonLine(path.join(runDir, "semantic-turn-batch-stage.ndjson"), {
      at: new Date().toISOString(),
      chunkId: args.chunkId,
      flushReason: args.flushReason,
      text: args.text,
      batchChars: text.length,
      batchParts: semanticTurnBatchItems.length,
    });
    const ageMs = Date.now() - semanticTurnBatchStartedAt;
    const forceFlush = ["silence", "call-disposed", "shutdown"].includes(args.flushReason);
    if (forceFlush || ageMs >= semanticTurnBatchMs || text.length >= semanticTurnBatchMaxChars) {
      await flushSemanticTurnBatch(forceFlush ? args.flushReason : text.length >= semanticTurnBatchMaxChars ? "max-chars" : "timer");
      return;
    }
    addEvent(state, eventLog, "semantic_turn.batch_hold", `semantic batch holding ${semanticTurnBatchItems.length} chunk(s)`, {
      chunkId: args.chunkId,
      chars: text.length,
      ageMs,
      targetMs: semanticTurnBatchMs,
    });
    broadcast();
  }

  let cxGateLastPollAt = 0;
  let cxGateLastPollPromise = null;
  let appEventGateLastPollAt = 0;
  let appEventGateLastPollPromise = null;
  let appEventMongoReady = false;
  let fakeGateEvent = null;
  const cxGateState = {
    enabled: callGateEnabled,
    mode: callGateMode,
    active: !callGateEnabled,
    currentUii: null,
    sessionSequence: 0,
    lastReason: callGateEnabled ? "not-polled" : "disabled",
    lastError: null,
    lastPollAt: null,
    lastMatch: null,
  };

  function publishCxGateState() {
    state.public.cxGate = {
      enabled: cxGateState.enabled,
      mode: cxGateState.mode,
      active: cxGateState.active,
      currentUii: cxGateState.currentUii,
      sessionSequence: cxGateState.sessionSequence,
      lastReason: cxGateState.lastReason,
      lastError: cxGateState.lastError,
      lastPollAt: cxGateState.lastPollAt,
      lastMatch: cxGateState.lastMatch,
      pollMs: callGatePollMs,
      agentId: cxGateAgentId || null,
      agentEmail: eventGateAgentEmail || cxGateAgentEmail || null,
      campaignId: cxGateCampaignId || null,
      dialGroupId: cxGateDialGroupId || null,
      eventSourceService: eventGated ? eventGateSourceService : null,
      eventAgentExtensionId: eventGated ? eventGateAgentExtensionId || null : null,
      fake: fakeEventGate,
    };
  }

  function resetLogicalTranscriptState() {
    state.transcripts = [];
    state.advice = null;
    pendingTranscript = null;
    stagedDisplayTranscripts = [];
    semanticTurnBuffer = "";
    semanticCallMemory = "";
    prospectCoachMemory = "";
    prospectCoachPendingEntry = null;
    realtimeDirectHeldFragment = null;
    nativeSpeakerAssignments.clear();
    lastAdviceAt = 0;
    monitorMetadata = {
      ...monitorMetadata,
      semanticCallMemory: "",
    };
    state.public.semanticTurnBufferChars = 0;
    state.public.semanticCallMemory = "";
    setLiveSuggestion({
      status: prospectOnlyCoachEnabled ? "idle" : "off",
      text: "",
      finalText: "",
      prospectText: "",
      acceptInput: null,
      mode: "wait",
      signal: "",
      topic: "",
      direction: "",
      elapsedMs: null,
      error: null,
    });
  }

  function summarizeGateEvent(event = null) {
    if (!event) return null;
    return {
      id: event.id || null,
      createdAt: event.createdAt || null,
      source: event.source || null,
      eventType: event.eventType || null,
      queueItemId: event.queueItemId || null,
      caseId: event.caseId || null,
      extensionId: event.extensionId || null,
      agentName: event.agentName || null,
      agentEmail: event.agentEmail || null,
      uii: event.uii || null,
      callSessionId: event.callSessionId || null,
      confirmedCall: event.confirmedCall,
      fake: Boolean(event.fake),
    };
  }

  function gateMatchId(match) {
    return cleanText(
      match?.event?.uii
        || match?.event?.callSessionId
        || match?.event?.id
        || extractRingcxActiveCallUii(match?.call)
        || "",
      160,
    ) || `gate-${Date.now()}`;
  }

  function activateCxGate(match) {
    const uii = gateMatchId(match);
    if (realtimeDirectDormantGateId && realtimeDirectDormantGateId !== uii) {
      clearRealtimeDirectDormant("next-call-event");
    }
    if (realtimeDirectDormantGateId && realtimeDirectDormantGateId === uii) {
      deactivateCxGate("dormant-until-next-call-event");
      return;
    }
    if (cxGateState.active && cxGateState.currentUii === uii) return;
    if (cxGateState.currentUii !== uii) {
      cxGateState.sessionSequence += 1;
      resetPending();
      resetLogicalTranscriptState();
      clearRealtimeDirectSleep("new-call");
      setRealtimeDirectSleep(realtimeDirectStartDelaySec, "call-start-delay");
      monitorMetadata = {
        ...monitorMetadata,
        cxUii: uii,
        cxGateSession: cxGateState.sessionSequence,
        cxGateMatchReasons: match?.reasons || [],
        cxGateQueryScope: match?.queryScope || null,
        appEventId: match?.event?.id || null,
        queueItemId: match?.event?.queueItemId || null,
        caseId: match?.event?.caseId || null,
        agentEmail: match?.event?.agentEmail || eventGateAgentEmail || null,
      };
    }
    cxGateState.active = true;
    cxGateState.currentUii = uii;
    cxGateState.lastReason = `${callGateMode}-active`;
    cxGateState.lastError = null;
    cxGateState.lastMatch = {
      uii,
      reasons: match?.reasons || [],
      queryScope: match?.queryScope || null,
      summary: match?.event ? summarizeGateEvent(match.event) : summarizeRingcxActiveCall(match?.call),
    };
    publishCxGateState();
    addEvent(state, eventLog, "cx_gate.active", `call gate active: ${uii}`, {
      uii,
      sessionSequence: cxGateState.sessionSequence,
      reasons: match?.reasons || [],
      queryScope: match?.queryScope || null,
      mode: callGateMode,
      summary: match?.event ? summarizeGateEvent(match.event) : summarizeRingcxActiveCall(match?.call),
    });
    broadcast();
  }

  function deactivateCxGate(reason = "no-active-call") {
    if (cxGateState.active && cxGateState.currentUii && stagedDisplayTranscripts.length) {
      publishStagedTurn("cx-ended");
    }
    if (cxGateState.active || cxGateState.currentUii) {
      addEvent(state, eventLog, "cx_gate.idle", `CX gate idle: ${reason}`, {
        previousUii: cxGateState.currentUii,
      });
    }
    cxGateState.active = false;
    cxGateState.currentUii = null;
    cxGateState.lastReason = reason;
    cxGateState.lastMatch = null;
    clearRealtimeDirectSleep("call-gate-idle");
    monitorMetadata = {
      ...monitorMetadata,
      cxUii: null,
      cxGateMatchReasons: [],
      cxGateQueryScope: null,
      appEventId: null,
      queueItemId: null,
      caseId: null,
    };
    resetPending();
    publishCxGateState();
    broadcast();
  }

  function normalizeAppGateEvent(record, source = "mongo") {
    const payload = record?.payload || record || {};
    const createdAt = record?.createdAt || payload.createdAt || payload.placedAt || new Date();
    const id = record?._id ? String(record._id) : payload.id || `fake-${Date.now()}`;
    return {
      id,
      source,
      eventType: record?.eventType || payload.eventType || "cx.call.placed",
      createdAt: new Date(createdAt).toISOString(),
      createdAtMs: Date.parse(createdAt) || Date.now(),
      expiresAtMs: Number(payload.expiresAtMs || 0) || null,
      queueItemId: cleanText(payload.queueItemId || record?.aggregateId || "", 120),
      caseId: payload.caseId || record?.aggregateId || null,
      extensionId: cleanText(payload.extensionId || "", 80),
      agentName: cleanText(payload.agentName || "", 120),
      agentEmail: cleanText(payload.agentEmail || "", 180),
      uii: cleanText(payload.uii || "", 120),
      callSessionId: cleanText(payload.callSessionId || "", 160),
      confirmedCall: payload.confirmedCall,
      fake: source === "fake",
    };
  }

  function appGateEventMatchesAgent(event) {
    if (!event) return false;
    const eventExtId = String(event.extensionId || "").trim();
    const eventEmail = String(event.agentEmail || "").trim().toLowerCase();
    if (eventGateAgentExtensionId && eventExtId === String(eventGateAgentExtensionId)) return true;
    if (eventGateAgentEmail && eventEmail === String(eventGateAgentEmail).toLowerCase()) return true;
    return !eventGateAgentExtensionId && !eventGateAgentEmail;
  }

  function createFakeGateEvent({ durationSec = null, caseId = null, queueItemId = null } = {}) {
    const now = Date.now();
    const seconds = Math.max(5, Number(durationSec || eventGateActiveSec) || eventGateActiveSec);
    const fakeId = `fake-${timestampForFile()}-${crypto.randomBytes(3).toString("hex")}`;
    return normalizeAppGateEvent({
      payload: {
        id: fakeId,
        eventType: "cx.call.placed",
        placedAt: new Date(now).toISOString(),
        expiresAtMs: now + seconds * 1000,
        queueItemId: queueItemId || `fake-queue-${fakeId}`,
        caseId: caseId || "fake-case",
        extensionId: eventGateAgentExtensionId,
        agentName: agentExt?.name || null,
        agentEmail: eventGateAgentEmail || null,
        callSessionId: `fake-call-${fakeId}`,
        confirmedCall: true,
      },
    }, "fake");
  }

  state.actions = {
    async superviseAttachOnce() {
      if (!agentExt?.id) return { ok: false, error: "agent extension is not resolved" };
      if (!device?.id) return { ok: false, error: "supervisor device is not resolved" };
      try {
        const result = await superviseActiveCall({
          lookupToken,
          superviseToken: monitorToken,
          agentExtensionId: agentExt.id,
          supervisorExtensionId: supervisorExt.id,
          supervisorDeviceId: device.id,
          partyMode,
          callPickMode,
          callStartAfterMs: 0,
        });
        monitorMetadata = {
          ...monitorMetadata,
          telephonySessionId: result.telephonySessionId,
          pickedCall: result.pickedCall,
          pickedParty: result.pickedParty,
        };
        addEvent(state, eventLog, "supervise", `manual attach requested on telephonySessionId=${result.telephonySessionId}`, {
          result,
        });
        broadcast();
        return { ok: true, result };
      } catch (error) {
        addEvent(state, eventLog, "supervise.attach_error", error.message);
        broadcast();
        return { ok: false, error: error.message };
      }
    },
    async coachStart({ durationSec = null, caseId = null, queueItemId = null, manual = false } = {}) {
      if (!eventGated) return { ok: false, error: "start this monitor with --event-gated or --fake-event-gate" };
      if (cxGateState.active) {
        if (realtimeDirectDormantGateId && realtimeDirectDormantGateId === cxGateState.currentUii) {
          return { ok: false, error: "coach is dormant for this call after hold prompt; waiting for the next call event" };
        }
        addEvent(state, eventLog, "cx_gate.manual_start", "manual coaching start requested", {
          currentUii: cxGateState.currentUii,
          delayActive: Boolean(realtimeDirectSleepUntilMs),
        });
        broadcast();
        return { ok: true, gate: state.public.cxGate };
      }

      if (!fakeEventGate) {
        const gate = await refreshAppEventGate(true);
        if (gate.active) {
          addEvent(state, eventLog, "cx_gate.manual_start", "manual coaching start requested after event refresh", {
            currentUii: gate.currentUii,
            delayActive: Boolean(realtimeDirectSleepUntilMs),
          });
          broadcast();
          return { ok: true, gate: state.public.cxGate };
        }
        return { ok: false, error: `no active call event found (${gate.lastReason || "idle"})` };
      }

      fakeGateEvent = createFakeGateEvent({ durationSec, caseId, queueItemId });
      activateCxGate({
        event: fakeGateEvent,
        reasons: ["fake-event"],
        queryScope: "memory",
      });
      return { ok: true, gate: state.public.cxGate, event: summarizeGateEvent(fakeGateEvent) };
    },
    fakeCallStop({ reason = "manual-fake-stop" } = {}) {
      fakeGateEvent = null;
      deactivateCxGate(reason);
      return { ok: true, gate: state.public.cxGate };
    },
  };

  async function ensureAppEventMongo() {
    if (appEventMongoReady) return;
    await connectMongo(getSharedConfig());
    appEventMongoReady = true;
  }

  async function latestMatchingAppGateEvent() {
    await ensureAppEventMongo();
    const cutoffMs = eventGateLookbackSec > 0 ? Date.now() - eventGateLookbackSec * 1000 : 0;
    const rows = await EventRecord.find({
      eventType: "cx.call.placed",
      sourceService: eventGateSourceService,
    })
      .sort({ _id: -1 })
      .limit(eventGateLookbackLimit)
      .lean();
    return rows
      .map((record) => normalizeAppGateEvent(record, "mongo"))
      .find((event) => event.createdAtMs >= cutoffMs && appGateEventMatchesAgent(event)) || null;
  }

  async function isAppGateClosed(event) {
    if (!event?.queueItemId || event.fake) return false;
    await ensureAppEventMongo();
    const close = await WorkflowRecord.findOne({
      family: "cx",
      subtype: "disposition-hangup",
      stage: "completed",
      aggregateType: "dial-request",
      aggregateId: String(event.queueItemId),
    })
      .sort({ _id: -1 })
      .lean();
    if (!close) return false;
    const closeMs = Date.parse(close.happenedAt || close.createdAt || "") || 0;
    return closeMs >= event.createdAtMs - 2000;
  }

  async function refreshAppEventGate(force = false) {
    if (!eventGated) return cxGateState;
    const now = Date.now();
    if (!force && now - appEventGateLastPollAt < eventGatePollMs) return cxGateState;
    if (appEventGateLastPollPromise) return appEventGateLastPollPromise;
    appEventGateLastPollAt = now;
    appEventGateLastPollPromise = (async () => {
      cxGateState.lastPollAt = new Date().toISOString();
      try {
        if (fakeGateEvent) {
          if (fakeGateEvent.expiresAtMs && fakeGateEvent.expiresAtMs <= Date.now()) {
            fakeGateEvent = null;
            deactivateCxGate("fake-event-expired");
            return cxGateState;
          }
          activateCxGate({ event: fakeGateEvent, reasons: ["fake-event"], queryScope: "memory" });
          return cxGateState;
        }

        if (fakeEventGate) {
          deactivateCxGate("waiting-for-fake-event");
          return cxGateState;
        }

        const event = await latestMatchingAppGateEvent();
        if (!event) {
          deactivateCxGate("no-app-call-event");
          return cxGateState;
        }
        const ageMs = Date.now() - event.createdAtMs;
        if (ageMs > eventGateActiveSec * 1000) {
          deactivateCxGate("app-call-event-expired");
          return cxGateState;
        }
        if (await isAppGateClosed(event)) {
          deactivateCxGate("app-disposition-hangup");
          return cxGateState;
        }
        activateCxGate({
          event,
          reasons: ["app-cx-call-placed"],
          queryScope: "event-core",
        });
        return cxGateState;
      } catch (error) {
        cxGateState.lastError = error.message;
        cxGateState.lastReason = "event-poll-error";
        publishCxGateState();
        addEvent(state, eventLog, "cx_gate.error", error.message);
        broadcast();
        return cxGateState;
      } finally {
        appEventGateLastPollPromise = null;
      }
    })();
    return appEventGateLastPollPromise;
  }

  function findCxGateMatch(activePayload, { queryScope = "ACCOUNT", scopedToAgent = false } = {}) {
    const calls = coerceRingcxActiveCallList(activePayload);
    const scored = calls
      .map((call) => ({
        call,
        queryScope,
        ...scoreRingcxGateCall(call, {
          agentCxAgentId: cxGateAgentId,
          agentEmail: cxGateAgentEmail,
          agentExtId: agentExt?.id,
          campaignId: cxGateCampaignId,
          dialGroupId: cxGateDialGroupId,
        }),
      }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score);
    if (scopedToAgent && scored.length === 1 && extractRingcxActiveCallUii(scored[0].call)) {
      scored[0].reasons = [...new Set([...(scored[0].reasons || []), "single-agent-active-call"])];
      return scored[0];
    }
    const top = scored[0];
    if (!top) return null;
    const hasSpecificMatch = (top.reasons || []).some((reason) =>
      ["agentCxAgentId", "agentEmail", "agentExtId", "campaignId", "dialGroupId"].includes(reason),
    );
    if (!scopedToAgent && !hasSpecificMatch) return null;
    return top;
  }

  async function refreshCxGate(force = false) {
    if (!cxGated) return cxGateState;
    const now = Date.now();
    if (!force && now - cxGateLastPollAt < cxGatePollMs) return cxGateState;
    if (cxGateLastPollPromise) return cxGateLastPollPromise;
    cxGateLastPollAt = now;
    cxGateLastPollPromise = (async () => {
      cxGateState.lastPollAt = new Date().toISOString();
      try {
        const querySpecs = [];
        if (cxGateAgentId) {
          querySpecs.push({ product: "AGENT", productId: cxGateAgentId, scopedToAgent: true });
        }
        if (
          !cxGateAgentId
          || hasFlag(argv, "--cx-gate-account-fallback")
          || cxGateCampaignId
          || cxGateDialGroupId
        ) {
          querySpecs.push({ product: "ACCOUNT", productId: cxGateClient.config?.accountId, scopedToAgent: false });
        }

        let sawUnavailableScope = false;
        let sawSuccessfulScope = false;
        for (const spec of querySpecs) {
          let payload = null;
          try {
            payload = await cxGateClient.listActiveCalls({
              product: spec.product,
              productId: spec.productId,
            });
            sawSuccessfulScope = true;
          } catch (error) {
            if (/activeCalls\/list failed: 500/i.test(String(error?.message || ""))) {
              sawUnavailableScope = true;
              continue;
            }
            throw error;
          }
          const calls = coerceRingcxActiveCallList(payload);
          if (calls.length) {
            addEvent(state, eventLog, "cx_gate.seen", `${spec.product} activeCalls=${calls.length}`, {
              product: spec.product,
              calls: calls.slice(0, 5).map(summarizeRingcxActiveCall),
            });
          }
          const match = findCxGateMatch(payload, {
            queryScope: spec.product,
            scopedToAgent: spec.scopedToAgent,
          });
          if (match) {
            activateCxGate(match);
            return cxGateState;
          }
        }
        deactivateCxGate(
          sawSuccessfulScope
            ? "no-active-cx-call"
            : sawUnavailableScope
              ? "active-call-list-empty-or-unavailable"
              : "no-active-cx-call",
        );
        return cxGateState;
      } catch (error) {
        if (/activeCalls\/list failed: 500/i.test(String(error?.message || ""))) {
          deactivateCxGate("active-call-list-empty-or-unavailable");
          return cxGateState;
        }
        cxGateState.lastError = error.message;
        cxGateState.lastReason = "poll-error";
        publishCxGateState();
        addEvent(state, eventLog, "cx_gate.error", error.message);
        broadcast();
        return cxGateState;
      } finally {
        cxGateLastPollPromise = null;
      }
    })();
    return cxGateLastPollPromise;
  }

  async function refreshCallGate(force = false) {
    if (eventGated) return refreshAppEventGate(force);
    if (cxGated) return refreshCxGate(force);
    return cxGateState;
  }

  async function runRealtimeDirectCoachChunk({ pcmuBuffer, chunkId, startedAt, endedAt, stats, flushReason = "interval" }) {
    if (!realtimeDirectCoach) return false;
    if (Number(stats.durationSec || 0) < realtimeDirectMinChunkSec && flushReason !== "shutdown" && flushReason !== "call-disposed") {
      addEvent(state, eventLog, "realtime_direct.hold_chunk", `holding short realtime chunk (${Number(stats.durationSec || 0).toFixed(2)}s < ${realtimeDirectMinChunkSec}s)`, {
        chunkId,
        durationSec: stats.durationSec,
        flushReason,
      });
      return false;
    }
    const started = Date.now();
    const sequence = prospectCoachSequence + 1;
    prospectCoachSequence = sequence;
    const playbookContext = cleanText(prospectCoachPlaybook, prospectCoachPlaybookMaxChars);
    let memoryUpdateChars = 0;
    try {
      memoryUpdateChars = await maybeSendRealtimeDirectMemoryUpdate("realtime-direct");
    } catch (error) {
      addEvent(state, eventLog, "realtime_direct.memory_error", error.message, { sequence });
    }
    const textContext = buildRealtimeDirectCoachTextContext({
      chunkId,
      stats,
      flushReason,
    });
    setLiveSuggestion({
      status: "streaming",
      sequence,
      text: "",
      finalText: "",
      prospectText: "",
      startedAt: new Date(started).toISOString(),
      elapsedMs: null,
      provider: "openai-realtime",
      model: realtimeDirectModel,
      serviceTier: null,
      playbookSections: prospectCoachPlaybook ? ["direct-realtime-playbook"] : [],
      taxKnowledgeSections: prospectCoachPlaybook ? ["direct-realtime-tax-context"] : [],
      taxJurisdiction: "mixed-audio",
      taxJurisdictionConfidence: "model-inferred",
      taxJurisdictionReason: "gpt-realtime-2 hears mixed party audio directly",
      playbookChars: playbookContext.length,
      playbookMaxChars: prospectCoachPlaybookMaxChars,
      outputMode: realtimeDirectCoachOnly ? "coach-only" : "heard-say",
      mode: "wait",
      acceptInput: null,
      signal: "",
      topic: "",
      direction: "",
      error: null,
    });
    addEvent(state, eventLog, "realtime_direct.start", `coaching ${chunkId} with ${realtimeDirectModel}`, {
      chunkId,
      sequence,
      durationSec: stats.durationSec,
      activePctOver500: stats.activePctOver500,
      flushReason,
      playbookChars: playbookContext.length,
      summaryChars: conversationSummary.length,
      memoryUpdateChars,
      textContextChars: textContext.length,
    });

    let lastBroadcastAt = 0;
    const result = await realtimeDirectCoach.coachPcmu({
      pcmuBuffer,
      timeoutMs: realtimeDirectTimeoutMs,
      instructions: realtimeDirectCoachOnly
        ? "Use the latest committed audio item and latest text context item together. Do not output a transcript. Stream only one compact JSON object with acceptInput/mode/say/signal/topic/direction. Only if you hear the exact words 'please continue to hold', set acceptInput=false, mode=HOLD, say=WAIT, signal='please continue to hold'. For all other hold/system/silence/noise, set acceptInput=true, mode=WAIT, say=WAIT. If the newest useful content is party B/prospect, make say the exact next line the sales agent should say. If it is party A/agent, make say private coaching feedback."
        : "Use the latest committed audio item and latest text context item together. Stream only HEARD/SAY in the required format. If the newest useful content is party B/prospect, make SAY the exact next line the sales agent should say.",
      textContext,
      onDelta: (_delta, output) => {
        const now = Date.now();
        if (now - lastBroadcastAt < 80 && output.length < 16) return;
        lastBroadcastAt = now;
        if ((state.public.liveSuggestion || {}).sequence !== sequence) return;
        const parsed = parseRealtimeDirectCoachOutput(output);
        const partialExactHold = hasExactContinueHoldPhrase([
          output,
          parsed.signal,
          parsed.topic,
          parsed.direction,
          parsed.say,
        ].filter(Boolean).join(" "));
        setLiveSuggestion({
          status: parsed.acceptInput === false && partialExactHold ? "hold" : "streaming",
          text: parsed.acceptInput === false && partialExactHold ? "" : parsed.say || parsed.raw || output,
          prospectText: realtimeDirectCoachOnly ? "" : parsed.heard || "",
          mode: parsed.acceptInput === false && partialExactHold ? "hold" : parsed.mode || "wait",
          acceptInput: parsed.acceptInput,
          signal: parsed.signal || "",
          topic: parsed.topic || "",
          direction: parsed.direction || "",
          outputMode: realtimeDirectCoachOnly ? "coach-only" : "heard-say",
          elapsedMs: now - started,
        });
      },
    });
    const heard = cleanText(result.heard || "", 1200);
    const rawResultMode = cleanText(result.mode || "", 40).toLowerCase();
    const resultMode = rawResultMode === "coach" ? "prospect_response" : rawResultMode;
    const acceptInput = result.acceptInput;
    const resultSignal = cleanText(result.signal || "", 220);
    const resultTopic = cleanText(result.topic || "", 80);
    const resultDirection = cleanText(result.direction || "", 220);
    const resultSay = cleanText(result.say || "", 900);
    const rawText = cleanText(result.raw || "", 1200);
    const rawHoldModeDetected = /\bMODE\s*[:=]\s*HOLD\b/i.test(rawText);
    const exactHoldPhraseHeard = hasExactContinueHoldPhrase([
      heard,
      rawText,
      resultSignal,
      resultTopic,
      resultDirection,
      resultSay,
    ].filter(Boolean).join(" "));
    const holdControlRequested = resultMode === "hold" || acceptInput === false || rawHoldModeDetected;
    const heardIsHoldPrompt = exactHoldPhraseHeard;
    if (holdControlRequested && !exactHoldPhraseHeard) {
      addEvent(state, eventLog, "realtime_direct.strict_hold_ignored", "hold control ignored because exact phrase was not returned", {
        chunkId,
        sequence,
        mode: resultMode || null,
        acceptInput,
        signal: resultSignal || null,
        topic: resultTopic || null,
      });
    }
    const heardLooksIncomplete = !heardIsHoldPrompt && looksLikeIncompleteRealtimeHeard(heard);
    if (heardLooksIncomplete && realtimeDirectIncompleteHoldMs > 0) {
      realtimeDirectHeldFragment = {
        chunkId,
        heard,
        raw: result.raw || "",
        at: Date.now(),
      };
      setLiveSuggestion({
        status: "holding",
        text: "",
        finalText: "",
        prospectText: heard,
        elapsedMs: Date.now() - started,
        usage: result.usage || null,
        mode: resultMode || "wait",
        acceptInput,
        signal: resultSignal,
        topic: resultTopic,
        direction: resultDirection,
      });
      addEvent(state, eventLog, "realtime_direct.fragment_hold", `holding incomplete realtime fragment: ${heard}`, {
        chunkId,
        sequence,
        holdMs: realtimeDirectIncompleteHoldMs,
        usage: result.usage || null,
      });
      broadcast();
      return true;
    }
    const priorHeld = realtimeDirectHeldFragment;
    realtimeDirectHeldFragment = null;
    const combinedHeard = cleanText([
      priorHeld?.heard && heard ? joinTranscriptContinuation(priorHeld.heard, heard) : priorHeld?.heard || "",
      priorHeld?.heard && heard ? "" : heard,
    ].filter(Boolean).join(" "), 1200);
    const effectiveHeard = realtimeDirectCoachOnly ? "" : combinedHeard || heard;
    const say = heardIsHoldPrompt || resultMode === "wait" ? "" : resultSay;
    const finishedAt = Date.now();
    const outputModeValue = heardIsHoldPrompt ? "hold" : (resultMode || (say ? "prospect_response" : "wait"));
    if (effectiveHeard && !heardIsHoldPrompt) {
      const entry = {
        id: `${chunkId}-realtime2`,
        at: new Date(endedAt).toISOString(),
        startedAt: new Date(startedAt).toISOString(),
        endedAt: new Date(endedAt).toISOString(),
        text: effectiveHeard,
        speakerSegments: [{
          speaker: "prospect",
          text: effectiveHeard,
          confidence: say ? 0.78 : 0.55,
          reason: "gpt-realtime-2 direct mixed-audio interpretation",
        }],
        speakerModel: realtimeDirectModel,
        speakerElapsedMs: finishedAt - started,
        speakerStatus: "openai-realtime-direct",
        model: realtimeDirectModel,
        responseFormat: "realtime-direct-heard-say",
        byteLength: pcmuBuffer.length,
        durationSec: Number(stats.durationSec.toFixed(2)),
        activePctOver500: stats.activePctOver500,
        elapsedMs: finishedAt - started,
        stageReason: "realtime-direct",
        revision: 0,
      };
      state.transcripts.push(entry);
      if (state.transcripts.length > 300) state.transcripts.splice(0, state.transcripts.length - 300);
      writeJsonLine(path.join(runDir, "transcripts.ndjson"), entry);
      void maybeRefreshConversationSummary("realtime-direct");
    }
    prospectCoachMemory = cleanText([
      prospectCoachMemory,
      effectiveHeard && !heardIsHoldPrompt ? `Prospect: ${effectiveHeard}` : "",
      heardIsHoldPrompt ? `System: ${effectiveHeard || "hold prompt"}` : "",
      resultMode ? `Coach mode: ${resultMode}` : "",
      resultSignal ? `Signal: ${resultSignal}` : "",
      resultTopic ? `Topic: ${resultTopic}` : "",
      resultDirection ? `Direction: ${resultDirection}` : "",
      say ? `Coach: ${say}` : "Coach: WAIT",
    ].filter(Boolean).join("\n"), 2000);
    setLiveSuggestion({
      status: heardIsHoldPrompt ? "hold" : say ? "done" : "wait",
      text: say,
      finalText: say,
      prospectText: effectiveHeard,
      elapsedMs: finishedAt - started,
      usage: result.usage || null,
      mode: outputModeValue,
      acceptInput,
      signal: resultSignal,
      topic: resultTopic,
      direction: resultDirection,
      outputMode: realtimeDirectCoachOnly ? "coach-only" : "heard-say",
    });
    const realtimeTurn = {
      at: new Date().toISOString(),
      sequence,
      chunkId,
      heard: effectiveHeard,
      say,
      mode: outputModeValue,
      acceptInput,
      signal: resultSignal,
      topic: resultTopic,
      direction: resultDirection,
      outputMode: realtimeDirectCoachOnly ? "coach-only" : "heard-say",
      raw: result.raw || "",
      elapsedMs: finishedAt - started,
      model: result.model,
      provider: result.provider,
      sessionId: result.sessionId || null,
      usage: result.usage || null,
      stats,
      durationSec: Number(stats.durationSec?.toFixed ? stats.durationSec.toFixed(2) : stats.durationSec || 0),
      activePctOver500: stats.activePctOver500,
    };
    state.realtimeDirectTurns.push(realtimeTurn);
    if (state.realtimeDirectTurns.length > 200) {
      state.realtimeDirectTurns.splice(0, state.realtimeDirectTurns.length - 200);
    }
    writeJsonLine(path.join(runDir, "realtime-direct-coach.ndjson"), realtimeTurn);
    addEvent(state, eventLog, heardIsHoldPrompt ? "realtime_direct.hold" : say ? "realtime_direct.done" : "realtime_direct.wait", say || (heardIsHoldPrompt ? "HOLD" : "WAIT"), {
      chunkId,
      sequence,
      heard: effectiveHeard,
      elapsedMs: finishedAt - started,
      usage: result.usage || null,
    });
    if (heardIsHoldPrompt) {
      setRealtimeDirectSleep(realtimeDirectHoldRecheckSec, "hold-prompt-recheck", "please continue to hold");
    }
    broadcast();
    return true;
  }

  async function processAudioChunk({ pcmuBuffer, chunkId, startedAt, endedAt, stats, flushReason = "interval" }) {
    const gate = await refreshCallGate(false);
    if (callGateEnabled && !gate.active) {
      addEvent(state, eventLog, "cx_gate.drop", `chunk dropped while CX gate idle (${gate.lastReason})`, {
        chunkId,
        stats,
      });
      broadcast();
      return;
    }

    if (realtimeDirectCoachEnabled) {
      const sleepRemainingMs = getRealtimeDirectSleepRemainingMs();
      if (sleepRemainingMs > 0) {
        const now = Date.now();
        if (now - realtimeDirectLastSleepDropLogAt > 15_000) {
          realtimeDirectLastSleepDropLogAt = now;
          addEvent(state, eventLog, "realtime_direct.sleep_drop", `chunk dropped while realtime coach sleeps (${Math.ceil(sleepRemainingMs / 1000)}s left)`, {
            chunkId,
            reason: realtimeDirectSleepReason || null,
            until: state.public.realtimeDirectSleepUntil,
            stats,
          });
          broadcast();
        }
        return;
      }
    }

    const activePct = Number(stats.activePctOver500 || 0);
    if (activePct < minActivePct) {
      addEvent(state, eventLog, "chunk.skip", `quiet chunk skipped (${activePct}% active)`, {
        chunkId,
        stats,
      });
      broadcast();
      return;
    }

    if (realtimeDirectCoachEnabled) {
      try {
        await runRealtimeDirectCoachChunk({ pcmuBuffer, chunkId, startedAt, endedAt, stats, flushReason });
      } catch (error) {
        setLiveSuggestion({
          status: "error",
          error: error.message,
          elapsedMs: null,
        });
        addEvent(state, eventLog, "realtime_direct.error", error.message, { chunkId });
        broadcast();
      }
      return;
    }

    const wav = sttRealtimeEnabled ? null : buildPcm16WavFromPcmu(pcmuBuffer);
    const wavPath = path.join(runDir, `${chunkId}.wav`);
    if (writeWavChunks && wav) fs.writeFileSync(wavPath, wav);

    addEvent(state, eventLog, "stt.start", `transcribing ${chunkId}`, {
      chunkId,
      durationSec: stats.durationSec,
      activePctOver500: stats.activePctOver500,
      realtime: sttRealtimeEnabled,
      realtimeDelay: sttRealtimeEnabled ? realtimeSttDelay : null,
    });
    const sttStarted = Date.now();
    const liveSttPrompt = buildLiveSttPrompt({
      baseContext: sttContext,
      recentTranscripts: [
        ...state.transcripts,
        ...stagedDisplayTranscripts.map((item) => ({ text: item.text })),
      ],
    });
    const transcript = sttRealtimeEnabled
      ? await realtimeTranscriber.transcribePcmu({
        pcmuBuffer,
        timeoutMs: 45_000,
      })
      : await transcribeSalesTrainerAudio({
        buffer: wav,
        mimeType: "audio/wav",
        filename: `${chunkId}.wav`,
        language,
        model: sttModel,
        responseFormat: sttResponseFormat,
        prompt: liveSttPrompt,
        includeDomainPrimer: includeSttDomainPrimer,
        chunkingStrategy: sttChunkingStrategy,
        knownSpeakerNames: knownSpeakers.names,
        knownSpeakerReferences: knownSpeakers.references,
        timeoutMs: 20_000,
      });
    const priorTexts = [
      ...state.transcripts.slice(-8).map((entry) => entry.text),
      ...stagedDisplayTranscripts.slice(-4).map((entry) => entry.text),
    ];
    const text = removePriorTranscriptEcho(transcript.text || "", priorTexts);
    const alignedNativeSegments = nativeDiarizeEnabled
      ? alignNativeSegmentsToTranscriptText(transcript.segments || [], text)
      : [];
    if (isLowSignalTranscript(text)) {
      addEvent(state, eventLog, "stt.skip", `low-signal transcript skipped: ${text || "(empty)"}`, {
        chunkId,
        elapsedMs: Date.now() - sttStarted,
        rawText: cleanText(transcript.text || "", 500),
      });
      broadcast();
      return;
    }

    if (semanticTurnsEnabled) {
      await stageSemanticTurnText({
        text,
        chunkId,
        startedAt,
        endedAt,
        transcript,
        stats,
        sttStarted,
        pcmuBuffer,
        flushReason,
      });
      return;
    }

    const displayTranscripts = takeDisplayTranscripts({
      text,
      chunkId,
      startedAt,
      endedAt,
      nativeSegments: alignedNativeSegments,
    });
    if (!displayTranscripts.length) {
      addEvent(state, eventLog, "stt.hold", `holding fragment for sentence completion: ${text}`, {
        chunkId,
        elapsedMs: Date.now() - sttStarted,
      });
      broadcast();
      return;
    }

    if (stageUntilSilence) {
      displayTranscripts.forEach((displayTranscript) => {
        stageDisplayTranscript(displayTranscript, {
          chunkId,
          flushReason,
          model: transcript.model,
          responseFormat: transcript.responseFormat || null,
          byteLength: pcmuBuffer.length,
          durationSec: Number(stats.durationSec.toFixed(2)),
          activePctOver500: stats.activePctOver500,
          elapsedMs: Date.now() - sttStarted,
        });
      });
      addEvent(state, eventLog, "stt.stage", `staged ${displayTranscripts.length} transcript part(s) from ${chunkId}`, {
        chunkId,
        reason: flushReason,
        stagedParts: stagedDisplayTranscripts.length,
      });
      if (["silence", "call-disposed", "shutdown"].includes(flushReason)) {
        publishStagedTurn(flushReason);
      } else {
        broadcast();
      }
      return;
    }

    displayTranscripts.forEach((displayTranscript, index) => {
      const entryId = displayTranscripts.length === 1 ? chunkId : `${chunkId}-s${index + 1}`;
      const recentSegments = state.transcripts
        .filter((item) => item.id !== entryId)
        .flatMap((item) => item.speakerSegments || []);
      const nativeSpeakerSegments = nativeDiarizeEnabled
        ? speakerSegmentsFromNativeDiarize(displayTranscript.nativeSegments, displayTranscript.text, {
          recentSegments,
          metadata: monitorMetadata,
          nativeSpeakerAssignments,
        })
        : null;
      const entry = {
        id: entryId,
        at: new Date(displayTranscript.endedAt).toISOString(),
        startedAt: new Date(displayTranscript.startedAt).toISOString(),
        endedAt: new Date(displayTranscript.endedAt).toISOString(),
        text: displayTranscript.text,
        speakerSegments: nativeSpeakerSegments || normalizeSpeakerSegments({}, displayTranscript.text),
        speakerModel: null,
        speakerElapsedMs: null,
        speakerStatus: nativeSpeakerSegments ? "native-diarize" : speakerLabelsEnabled ? "pending" : "off",
        model: transcript.model,
        responseFormat: transcript.responseFormat || null,
        byteLength: pcmuBuffer.length,
        durationSec: Number(stats.durationSec.toFixed(2)),
        activePctOver500: stats.activePctOver500,
        elapsedMs: Date.now() - sttStarted,
        heldChunkIds: displayTranscript.heldChunkIds,
        sentenceHoldMs: displayTranscript.holdMs,
        sentenceComplete: displayTranscript.complete,
        nativeDiarizeSegments: nativeDiarizeEnabled ? displayTranscript.nativeSegments || [] : undefined,
        revision: 0,
      };
      const previousEntry = state.transcripts[state.transcripts.length - 1] || null;
      if (shouldRepairIntoPrevious(displayTranscript, previousEntry, Date.now())) {
        previousEntry.revision = (previousEntry.revision || 0) + 1;
        previousEntry.text = joinTranscriptContinuation(previousEntry.text, displayTranscript.text);
        previousEntry.endedAt = entry.endedAt;
        previousEntry.at = entry.at;
        previousEntry.durationSec = Number((Number(previousEntry.durationSec || 0) + Number(entry.durationSec || 0)).toFixed(2));
        previousEntry.byteLength = Number(previousEntry.byteLength || 0) + Number(entry.byteLength || 0);
        previousEntry.activePctOver500 = Math.max(Number(previousEntry.activePctOver500 || 0), Number(entry.activePctOver500 || 0));
        previousEntry.elapsedMs = Number(previousEntry.elapsedMs || 0) + Number(entry.elapsedMs || 0);
        previousEntry.heldChunkIds = [...new Set([...(previousEntry.heldChunkIds || []), ...(entry.heldChunkIds || [])])];
        previousEntry.sentenceHoldMs = Math.max(Number(previousEntry.sentenceHoldMs || 0), Number(entry.sentenceHoldMs || 0));
        previousEntry.sentenceComplete = Boolean(previousEntry.sentenceComplete && entry.sentenceComplete);
        previousEntry.repairedFragments = [
          ...(previousEntry.repairedFragments || []),
          {
            id: entryId,
            text: displayTranscript.text,
            at: entry.at,
            reason: "semantic continuation repair",
          },
        ];
        previousEntry.nativeDiarizeSegments = [
          ...(previousEntry.nativeDiarizeSegments || []),
          ...(entry.nativeDiarizeSegments || []),
        ];
        previousEntry.speakerSegments = nativeDiarizeEnabled
          ? speakerSegmentsFromNativeDiarize(previousEntry.nativeDiarizeSegments, previousEntry.text, {
            recentSegments: state.transcripts
              .filter((item) => item.id !== previousEntry.id)
              .flatMap((item) => item.speakerSegments || []),
            metadata: monitorMetadata,
            nativeSpeakerAssignments,
          })
          : normalizeSpeakerSegments({}, previousEntry.text);
        previousEntry.speakerModel = null;
        previousEntry.speakerElapsedMs = null;
        previousEntry.speakerStatus = nativeDiarizeEnabled ? "native-diarize-repair" : speakerLabelsEnabled ? "pending" : "off";
        writeJsonLine(path.join(runDir, "transcript-revisions.ndjson"), {
          id: previousEntry.id,
          at: new Date().toISOString(),
          revision: previousEntry.revision,
          appendedFrom: entryId,
          appendedText: displayTranscript.text,
          text: previousEntry.text,
        });
        addEvent(state, eventLog, "stt.repair", `patched fragment into prior row: ${displayTranscript.text}`, {
          chunkId: entryId,
          targetId: previousEntry.id,
          revision: previousEntry.revision,
        });
        broadcast();
        void maybeRefreshConversationSummary("transcript-repair");
        enqueueProspectCoach(previousEntry, "transcript-repair");
        void maybeRefreshAdvice("transcript-repair");
        enqueueSpeakerLabel(previousEntry, previousEntry.text, previousEntry.id);
        return;
      }
      state.transcripts.push(entry);
      if (state.transcripts.length > 300) state.transcripts.splice(0, state.transcripts.length - 300);
      writeJsonLine(path.join(runDir, "transcripts.ndjson"), entry);
      addEvent(state, eventLog, "stt.done", displayTranscript.text, {
        chunkId: entryId,
        elapsedMs: entry.elapsedMs,
        model: entry.model,
      });
      broadcast();
      void maybeRefreshConversationSummary("transcript");
      enqueueProspectCoach(entry, "transcript");
      void maybeRefreshAdvice("transcript");

      enqueueSemanticGlue(entry, entryId);
      enqueueSpeakerLabel(entry, displayTranscript.text, entryId);
    });
  }

  function resetPending() {
    pendingChunks = [];
    pendingBytes = 0;
    pendingStartedAt = 0;
    pendingSpeechSeen = false;
    pendingLastSpeechAt = 0;
  }

  function dropPending(reason = "drop") {
    if (!pendingBytes) return;
    const stats = measurePcmuActivity(Buffer.concat(pendingChunks, pendingBytes));
    writeJsonLine(eventLog, {
      type: "chunk.drop",
      at: new Date().toISOString(),
      reason,
      bytes: pendingBytes,
      stats,
    });
    resetPending();
    if (stageUntilSilence && reason === "silence-only") {
      transcriptionQueue = transcriptionQueue
        .then(() => {
          publishStagedTurn(reason);
        })
        .catch((error) => {
          addEvent(state, eventLog, "stt.stage.error", error.message);
          broadcast();
        });
    }
    if (semanticTurnsEnabled && semanticTurnBatchMs > 0 && reason === "silence-only") {
      enqueueSemanticTurnBatchFlush(reason);
    }
  }

  function notePendingAudio(payload, now = Date.now()) {
    if (!pendingStartedAt) pendingStartedAt = now;
    pendingChunks.push(payload);
    pendingBytes += payload.length;

    if (!splitOnSilence) return;
    const packetStats = measurePcmuActivity(payload);
    const packetHasSpeech =
      packetStats.activePctOver500 >= speechPacketActivePct ||
      packetStats.maxAbs >= speechPacketMaxAbs;
    if (packetHasSpeech) {
      pendingSpeechSeen = true;
      pendingLastSpeechAt = now;
    }
  }

  function maybeFlushPendingByPolicy(reason = "timer") {
    if (!pendingBytes || !pendingStartedAt) return;
    const now = Date.now();
    const ageMs = now - pendingStartedAt;
    if (callGateEnabled && !cxGateState.active) {
      const inactiveDropMs = splitOnSilence ? silenceSplitMs : chunkSec * 1000;
      if (ageMs >= inactiveDropMs) dropPending("cx-gate-inactive");
      return;
    }
    if (!splitOnSilence) {
      if (ageMs >= chunkSec * 1000) flushPending(reason);
      return;
    }

    if (!pendingSpeechSeen) {
      if (ageMs >= silenceSplitMs) dropPending("silence-only");
      return;
    }
    const silenceMs = now - pendingLastSpeechAt;
    if (silenceMs >= silenceSplitMs) {
      flushPending("silence");
      return;
    }
    const maxChunkMs = realtimeDirectCoachEnabled
      ? Math.max(chunkSec * 1000, realtimeDirectMinChunkSec * 1000)
      : chunkSec * 1000;
    if (!noMaxChunk && ageMs >= maxChunkMs) {
      flushPending("max-window");
    }
  }

  function flushPending(reason = "interval") {
    if (!pendingBytes) return;
    if (callGateEnabled && !cxGateState.active) {
      dropPending("cx-gate-inactive");
      return;
    }
    const pcmuBuffer = Buffer.concat(pendingChunks, pendingBytes);
    const startedAt = pendingStartedAt || Date.now();
    const endedAt = Date.now();
    const stats = measurePcmuActivity(pcmuBuffer);
    resetPending();
    chunkSequence += 1;
    const chunkId = `${runId}-chunk-${String(chunkSequence).padStart(4, "0")}`;
    const pcmuChunkPath = path.join(runDir, `${chunkId}.pcmu`);
    fs.writeFileSync(pcmuChunkPath, pcmuBuffer);
    writeJsonLine(eventLog, {
      type: "chunk.flush",
      at: new Date().toISOString(),
      reason,
      chunkId,
      pcmuChunkPath,
      bytes: pcmuBuffer.length,
      stats,
    });
    transcriptionQueue = transcriptionQueue
      .then(() => processAudioChunk({ pcmuBuffer, chunkId, startedAt, endedAt, stats, flushReason: reason }))
      .catch((error) => {
        addEvent(state, eventLog, "stt.error", error.message, { chunkId });
        broadcast();
      });
  }

  function closeOutput() {
    if (fullAudioStream) {
      fullAudioStream.end();
      fullAudioStream = null;
    }
  }

  softphone.on("registrationError", (error) => {
    addEvent(state, eventLog, "registration.error", error.message);
    broadcast();
  });

  softphone.on("invite", async (inviteMessage) => {
    try {
      const callId = inviteMessage.getHeader("Call-ID") || crypto.randomBytes(6).toString("hex");
      addEvent(state, eventLog, "invite", `inbound monitor call ${callId}`);
      state.public.status = "answering";
      broadcast();
      activeSession = await softphone.answer(inviteMessage);
      outputPath = path.join(runDir, `full-call-${timestampForFile()}-${activeSession.callId.replace(/[^a-z0-9-]/gi, "_")}.pcmu`);
      state.public.outputPath = outputPath;
      fullAudioStream = fs.createWriteStream(outputPath, { flags: "a" });
      state.public.status = "capturing";
      addEvent(state, eventLog, "answer", `capturing PCMU/8000 audio to ${outputPath}`);
      broadcast();

      activeSession.on("audioPacket", (rtpPacket) => {
        const payload = Buffer.from(rtpPacket.payload || []);
        if (!payload.length) return;
        packetCount += 1;
        byteCount += payload.length;
        state.public.packetCount = packetCount;
        state.public.byteCount = byteCount;
        if (fullAudioStream) fullAudioStream.write(payload);
        const aiProcessingAllowed = !callGateEnabled || cxGateState.active;
        if (aiProcessingAllowed) {
          notePendingAudio(payload);
          maybeFlushPendingByPolicy("interval");
        }
        if (packetCount % 250 === 0) {
          addEvent(state, eventLog, "audio", `packets=${packetCount} bytes=${byteCount}`);
          broadcast();
        }
      });

      activeSession.once("disposed", () => {
        flushPending("call-disposed");
        state.public.status = "call disposed";
        addEvent(state, eventLog, "done", `call disposed packets=${packetCount} bytes=${byteCount}`);
        closeOutput();
        broadcast();
      });
    } catch (error) {
      addEvent(state, eventLog, "invite.error", error.message);
      broadcast();
    }
  });

  console.log("RingEX live trainer one-off");
  console.log(`  dashboard:  http://127.0.0.1:${dashboardPort}/`);
  console.log(`  run dir:    ${runDir}`);
  console.log(`  supervisor: ${supervisorExt.name} ext=${supervisorExt.extensionNumber} id=${supervisorExt.id}`);
  if (agentExt) console.log(`  agent:      ${agentExt.name} ext=${agentExt.extensionNumber} id=${agentExt.id}`);
  console.log(`  device:     ${JSON.stringify(summarizeDevice(device))}`);
  console.log(`  sip proxy:  ${outboundProxy}`);
  console.log(`  chunk:      ${splitOnSilence ? `silence ${silenceSplitMs}ms, max ${noMaxChunk ? "off" : `${chunkSec}s`}` : `${chunkSec}s`}, active>=${minActivePct}%`);
  if (stageUntilSilence) console.log("  publish:    stage STT chunks, send merged turn after silence");
  console.log(`  call flow:  ${callFlow}, initial human=${initialHumanSpeaker}`);
  console.log(`  sentences:  hold fragments up to ${sentenceHoldMs}ms`);
  console.log(`  stt:        ${sttRealtimeEnabled ? `realtime:${sttModel}, delay=${realtimeSttDelay || "default"}` : `${sttModel}, format=${sttResponseFormat}${sttChunkingStrategy ? `, chunking=${sttChunkingStrategy}` : ""}`}`);
  console.log(`  stt prompt: ${includeSttDomainPrimer ? "domain primer + live context" : nativeDiarizeEnabled ? "off (diarize does not support prompts)" : "live context only"}`);
  if (realtimeDirectCoachEnabled) console.log(`  realtime2:  direct mixed-audio coach, model=${realtimeDirectModel}, timeout=${realtimeDirectTimeoutMs}ms`);
  if (knownSpeakers.names.length) console.log(`  speakers ref: ${knownSpeakers.names.join(", ")}`);
  console.log(`  semantic:   ${semanticTurnsEnabled ? `${semanticTurnProvider}:${semanticTurnModel}${semanticTurnServiceTier ? ` tier=${semanticTurnServiceTier}` : ""}, batch=${semanticTurnBatchMs ? `${semanticTurnBatchMs}ms` : "off"}, buffer<=${semanticTurnMaxBufferChars}, memory<=${semanticTurnMemoryChars}` : "off"}`);
  console.log(`  coach:      ${coachEnabled ? `every ${coachEverySec}s, model=${coachModel}` : "off"}`);
  console.log(`  summary:    ${conversationSummaryEnabled ? `every ${conversationSummaryEverySec}s, ${conversationSummaryProvider}:${conversationSummaryModel}${conversationSummaryServiceTier ? ` tier=${conversationSummaryServiceTier}` : ""}` : "off"}`);
  if (prospectOnlyCoachEnabled) {
    console.log(`  next-line:  streaming prospect-only coach, ${prospectCoachProvider}:${prospectCoachModel}${prospectCoachServiceTier ? ` tier=${prospectCoachServiceTier}` : ""}, playbook=${prospectCoachPlaybook.length ? `${prospectCoachPlaybook.length} chars, focused<=${prospectCoachPlaybookMaxChars}` : "off"}`);
  }
  console.log(`  speakers:   ${nativeDiarizeEnabled ? "native diarize" : speakerLabelsEnabled ? speakerModel : "off"}`);
  console.log(`  call gate:  ${callGateEnabled ? `${callGateMode}, poll=${callGatePollMs}ms, agentExtId=${eventGateAgentExtensionId || "none"}, agentEmail=${eventGateAgentEmail || cxGateAgentEmail || "none"}` : "off"}`);
  console.log(`  ui bridge:  ${sessionId ? `session=${sessionId}` : "off"}`);

  await softphone.register();
  state.public.status = "registered";
  addEvent(state, eventLog, "register", "headless AI Monitor phone registered");
  broadcast();

  let conversationSummaryTimer = null;
  if (conversationSummaryEnabled) {
    conversationSummaryTimer = setInterval(() => {
      void maybeRefreshConversationSummary("timer");
    }, conversationSummaryEverySec * 1000);
  }

  let cxGateTimer = null;
  if (callGateEnabled) {
    publishCxGateState();
    void refreshCallGate(true);
    cxGateTimer = setInterval(() => {
      void refreshCallGate(false);
    }, callGatePollMs);
    if (fakeEventGate) {
      setTimeout(() => {
        if (!fakeGateEvent && !cxGateState.active) {
          state.actions.coachStart({ durationSec: eventGateActiveSec });
        }
      }, fakeEventAfterSec * 1000);
    }
  }

  if (doSupervise) {
    const startedWaiting = Date.now();
    const callStartAfterMs = onlyNewCalls ? startedWaiting - 1000 : 0;
    let result = null;
    let lastSuperviseError = null;
    while (!result && Date.now() - startedWaiting <= superviseWaitSec * 1000) {
      try {
        result = await superviseActiveCall({
          lookupToken,
          superviseToken: monitorToken,
          agentExtensionId: agentExt.id,
          supervisorExtensionId: supervisorExt.id,
          supervisorDeviceId: device.id,
          partyMode,
          callPickMode,
          callStartAfterMs,
        });
      } catch (error) {
        lastSuperviseError = error;
        if (!isRetryableSuperviseError(error)) {
          throw error;
        }
        addEvent(state, eventLog, "supervise.wait", `waiting for supervisable call on agent ext ${agentExtNumber}`, {
          error: cleanText(error.message, 240),
        });
        broadcast();
        await sleep(supervisePollMs);
      }
    }
    if (!result) {
      throw lastSuperviseError || new Error(`Timed out waiting ${superviseWaitSec}s for active call`);
    }
    monitorMetadata = {
      ...monitorMetadata,
      telephonySessionId: result.telephonySessionId,
      pickedCall: result.pickedCall,
      pickedParty: result.pickedParty,
    };
    addEvent(state, eventLog, "supervise", `requested listen on telephonySessionId=${result.telephonySessionId}`, {
      result,
    });
    broadcast();
  } else {
    addEvent(state, eventLog, "wait", "waiting for a supervisor call/invite; pass --supervise to attach automatically");
    broadcast();
  }

  const flushTimer = setInterval(() => {
    maybeFlushPendingByPolicy("timer");
    if (
      semanticTurnsEnabled &&
      semanticTurnBatchMs > 0 &&
      semanticTurnBatchItems.length &&
      semanticTurnBatchStartedAt &&
      Date.now() - semanticTurnBatchStartedAt >= semanticTurnBatchMs
    ) {
      enqueueSemanticTurnBatchFlush("timer");
    }
  }, 500);
  const stopAt = Date.now() + timeoutSec * 1000;

  try {
    while (Date.now() < stopAt) {
      await sleep(1000);
      if (activeSession?.disposed && !doSupervise) break;
    }
  } finally {
    clearInterval(flushTimer);
    if (conversationSummaryTimer) clearInterval(conversationSummaryTimer);
    if (cxGateTimer) clearInterval(cxGateTimer);
    flushPending("shutdown");
    await transcriptionQueue.catch(() => {});
    await flushSemanticTurnBatch("shutdown").catch((error) => addEvent(state, eventLog, "semantic_turn.batch_error", error.message));
    if (stageUntilSilence) publishStagedTurn("shutdown");
    if (state.transcripts.length) await maybeRefreshConversationSummary("shutdown", { force: true });
    if (state.transcripts.length) await maybeRefreshAdvice("forced");
    if (activeSession && !activeSession.disposed) {
      addEvent(state, eventLog, "timeout", "hanging up active monitor call");
      await activeSession.hangup().catch((error) => addEvent(state, eventLog, "hangup.error", error.message));
    }
    if (realtimeTranscriber) realtimeTranscriber.close();
    if (realtimeDirectCoach) realtimeDirectCoach.close();
    closeOutput();
    softphone.revoke();
    if (appEventMongoReady) {
      await disconnectMongo().catch((error) => addEvent(state, eventLog, "mongo.disconnect.error", error.message));
    }
    state.public.status = "stopped";
    addEvent(state, eventLog, "stop", "monitor stopped", {
      outputPath: outputPath || null,
      transcripts: state.transcripts.length,
      eventLog,
    });
    broadcast();
    dashboard.server.close();
  }
}

main().catch((error) => {
  console.error(`fatal: ${error.message}`);
  process.exit(1);
});
