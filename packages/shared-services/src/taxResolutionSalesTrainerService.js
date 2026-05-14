"use strict";

const crypto = require("crypto");
const { env } = require("../../shared-config/src");
const {
  ExternalServiceError,
  ValidationError,
} = require("../../shared-errors/src");
const {
  TAX_RESOLUTION_SALES_TRAINER_PROMPT,
  TAX_RESOLUTION_SALES_TRAINER_LIVE_TURN_PROMPT,
} = require("./taxResolutionSalesTrainerPrompt");
const {
  createAnthropicClient,
  extractTextBlocks: extractAnthropicTextBlocks,
} = require("../../shared-integrations/src/anthropicClient");
const {
  KIND_TRAINING,
  appendTrainingSessionEntry,
  archiveRecordingSafe,
  isDriveArchiveConfigured,
  writeRecordingBuffer,
} = require("./recordingStorageService");

const DEFAULT_MODEL = "gpt-5-mini";
// Default to Haiku for live in-character turns. The v2 prompt doc
// recommends Sonnet 4.6 for "richer characterization," but in practice:
//
//   - In-character turns are 1-3 sentences (enforced by the session
//     header's VOICE LENGTH CONSTRAINT). At that length there's almost
//     no quality gap between Haiku and Sonnet for roleplay dialogue.
//   - Sonnet 4.6 turns take ~2-3s to first token even with prompt
//     caching warm; Haiku 4.5 is ~600-1200ms. On a voice call that
//     1+ second is the difference between "snappy phone conversation"
//     and "uncomfortable lag."
//   - The phase-transition / scorecard / coach panel callbacks still
//     benefit from Sonnet's deeper reasoning — those run on separate
//     calls (CALLER_PROFILE_TOOL uses SALES_TRAINER_PROFILE_MODEL,
//     coaching panel can use SALES_TRAINER_COACH_MODEL).
//
// Override for high-fidelity drill sessions:
//   SALES_TRAINER_ANTHROPIC_MODEL=claude-sonnet-4-6  (slower, richer)
//   SALES_TRAINER_ANTHROPIC_MODEL=claude-opus-4-6    (slowest, eval)
const DEFAULT_ANTHROPIC_MODEL = "claude-haiku-4-5";
const DEFAULT_PROVIDER = "anthropic";
const DEFAULT_TTS_MODEL = "gpt-4o-mini-tts";
const DEFAULT_TTS_VOICE = "cedar";
const DEFAULT_TTS_FORMAT = "mp3";
const DEFAULT_TTS_SPEED = 1.35;
const DEFAULT_INTERNAL_DOMAINS = "taxadvocategroup.com";
const DEFAULT_INTERNAL_ROLES = "admin,internal-agent";
const SUPPORTED_PROVIDERS = new Set(["anthropic", "openai"]);
const MAX_MESSAGES = 30;
const MAX_INPUT_CHARS = 24_000;
const MAX_MESSAGE_CHARS = 6_000;
const MAX_TTS_INPUT_CHARS = 4_000;
const MAX_TTS_PERSONALITY_CHARS = 700;
const SALES_TRAINER_UI_STATE_TTL_MS = 2 * 60 * 60 * 1000;
const SALES_TRAINER_TTS_VOICES = Object.freeze([
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "fable",
  "marin",
  "nova",
  "onyx",
  "sage",
  "shimmer",
  "verse",
  "cedar",
]);
const SALES_TRAINER_TTS_FORMATS = Object.freeze([
  "mp3",
  "opus",
  "aac",
  "flac",
  "wav",
  "pcm",
]);
const SALES_TRAINER_TTS_PERSONAS = Object.freeze([
  "neutral",
  "anxious",
  "skeptical",
  "embarrassed",
  "frustrated",
  "rushed",
  "confused",
  "talkative",
  "professional",
  "coach",
]);
const COACHING_PHASE_KEYS = Object.freeze([
  "opening",
  "discovery",
  "pain",
  "qualification",
  "solution",
  "objection",
  "close",
  "wrap",
]);
const salesTrainerUiState = new Map();

function normalizeProvider(value) {
  const v = String(value || "").trim().toLowerCase();
  if (SUPPORTED_PROVIDERS.has(v)) return v;
  return DEFAULT_PROVIDER;
}

function getSalesTrainerConfig() {
  return {
    // OpenAI (Responses API) — codex's original path
    apiKey: env("OPENAI_API_KEY", ""),
    model: env("SALES_TRAINER_MODEL", DEFAULT_MODEL),
    // Anthropic (Messages API) — alternative provider, default.
    //
    // Three-tier model split for the trainer:
    //   - anthropicModel (this one): live in-character turns. Haiku
    //     default for speed — phone-call-pace replies are 1-3
    //     sentences and Haiku does them in ~600-1200ms vs Sonnet's
    //     ~2-3s.
    //   - profileModel (SALES_TRAINER_PROFILE_MODEL, Sonnet default):
    //     generates the caller profile via tool-use at session start.
    //     This is the "build a realistic person" step — Sonnet's
    //     richer reasoning pays off here even though it costs ~2-3s.
    //   - coachModel (SALES_TRAINER_COACH_MODEL, Sonnet default):
    //     runs the coaching panel that scores rep behavior and renders
    //     scorecard insights. Strict-schema tool-use, not user-facing
    //     latency — Sonnet's better synthesis matters more than speed.
    //
    // Result: snappy live conversation (Haiku), thoughtful caller
    // setup (Sonnet), accurate coaching feedback (Sonnet).
    anthropicApiKey: env("ANTHROPIC_API_KEY", ""),
    anthropicModel: env("SALES_TRAINER_ANTHROPIC_MODEL", DEFAULT_ANTHROPIC_MODEL),
    coachModel: env("SALES_TRAINER_COACH_MODEL", "claude-sonnet-4-6"),
    // Provider selection — env override falls back to anthropic
    provider: normalizeProvider(env("SALES_TRAINER_PROVIDER", DEFAULT_PROVIDER)),
    // Shared output controls
    maxOutputTokens: Number(env("SALES_TRAINER_MAX_OUTPUT_TOKENS", 1200)) || 1200,
    // Bug fix: previously used Number("") which returns 0, so the
    // env-unset path silently produced temperature=0 instead of the
    // intended 0.7. That made the v2 simulator deterministic to the
    // point of feeling scripted. Use parseFloat to get NaN when unset.
    temperature: (() => {
      const raw = env("SALES_TRAINER_TEMPERATURE", "");
      const parsed = parseFloat(raw);
      return Number.isFinite(parsed) ? parsed : 0.8;
    })(),
    timeoutMs: Number(env("SALES_TRAINER_TIMEOUT_MS", 30_000)) || 30_000,
    ttsModel: env("SALES_TRAINER_TTS_MODEL", DEFAULT_TTS_MODEL),
    ttsVoice: env("SALES_TRAINER_TTS_VOICE", DEFAULT_TTS_VOICE),
    ttsFormat: env("SALES_TRAINER_TTS_FORMAT", DEFAULT_TTS_FORMAT),
    // gpt-4o-mini-tts is rendering unusually slow in this trainer, and
    // client-side 2x playback is still lagging. Generate the audio fast
    // at source so the roleplay feels like a live phone call.
    ttsSpeed: Number(env("SALES_TRAINER_TTS_SPEED", DEFAULT_TTS_SPEED)) || DEFAULT_TTS_SPEED,
    // STT for trainer mic input. Defaulting to gpt-4o-mini-transcribe:
    //   - ~20-30% faster than whisper-1 on typical 5-15s mic clips
    //   - Better on technical vocabulary (CP504, OIC, etc.) — the
    //     domain primer we send works as well or better
    //   - ~Same cost ballpark
    //   - Drop-in replacement on the /v1/audio/transcriptions endpoint
    //   - Caveat: only supports response_format=json|text (not the
    //     verbose_json that whisper-1 accepts). Handled below by
    //     selecting format per-model.
    // Env override: set SALES_TRAINER_STT_MODEL=whisper-1 to revert,
    // or =gpt-4o-transcribe for the larger (slower but slightly more
    // accurate) sibling.
    sttModel: env("SALES_TRAINER_STT_MODEL", "gpt-4o-mini-transcribe"),
    sttLanguage: env("SALES_TRAINER_STT_LANGUAGE", "en"),
    // Auth allowlist (provider-agnostic)
    allowedEmails: parseList(env("SALES_TRAINER_ALLOWED_EMAILS", "")),
    allowedDomains: parseList(env("SALES_TRAINER_ALLOWED_DOMAINS", "")),
    internalDomains: parseList(env("SALES_TRAINER_INTERNAL_DOMAINS", DEFAULT_INTERNAL_DOMAINS)),
    internalRoles: parseList(env("SALES_TRAINER_INTERNAL_ROLES", DEFAULT_INTERNAL_ROLES)),
    tokenTtlHours: Number(env("SALES_TRAINER_TOKEN_TTL_HOURS", 12)) || 12,
    tokenSecret: env("SALES_TRAINER_TOKEN_SECRET", ""),
  };
}

function isOpenAiConfigured() {
  return Boolean(getSalesTrainerConfig().apiKey);
}

function isAnthropicConfigured() {
  return Boolean(getSalesTrainerConfig().anthropicApiKey);
}

function isConfigured() {
  return isOpenAiConfigured() || isAnthropicConfigured();
}

function listConfiguredProviders() {
  const providers = [];
  if (isAnthropicConfigured()) providers.push("anthropic");
  if (isOpenAiConfigured()) providers.push("openai");
  return providers;
}

function parseList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function emailDomain(email) {
  const normalized = normalizeEmail(email);
  if (!normalized || !normalized.includes("@")) return "";
  return normalized.split("@").pop() || "";
}

function accountEmails(account) {
  if (!account || typeof account !== "object") return [];
  const raw = [
    account.email,
    account.tagEmail,
    account.wynnEmail,
    account.cxAuth?.rcUserEmail,
    account.cxSession?.rcxAgentEmail,
  ];
  if (Array.isArray(account.exShells)) {
    for (const shell of account.exShells) raw.push(shell?.email);
  }
  return Array.from(new Set(raw.map(normalizeEmail).filter(Boolean)));
}

function isEmailAllowedForSalesTrainer(email) {
  const normalized = normalizeEmail(email);
  if (!normalized || !normalized.includes("@")) return false;

  const config = getSalesTrainerConfig();
  if (config.allowedEmails.includes(normalized)) return true;

  const [, domain = ""] = normalized.split("@");
  if (!domain) return false;

  if (config.allowedDomains.includes(domain)) return true;
  if (config.allowedDomains.includes(`@${domain}`)) return true;
  if (config.allowedEmails.includes(`*@${domain}`)) return true;
  return false;
}

function isTaxAdvocateGroupSalesTrainerAccount(account) {
  if (!account || typeof account !== "object") return false;
  if (String(account.status || "active").toLowerCase() !== "active") return false;

  const config = getSalesTrainerConfig();
  const role = String(account.role || "").trim().toLowerCase();
  if (!config.internalRoles.includes(role)) return false;

  return accountEmails(account).some((email) => config.internalDomains.includes(emailDomain(email)));
}

function isSalesTrainerAccountAllowed(account, email = "") {
  if (isEmailAllowedForSalesTrainer(email || account?.email)) return true;
  return isTaxAdvocateGroupSalesTrainerAccount(account);
}

function buildSalesTrainerAccount(email) {
  const normalized = normalizeEmail(email);
  return {
    id: `sales-trainer:${normalized}`,
    email: normalized,
    name: normalized,
    role: "sales-trainer",
    audience: "sales-trainer",
    workspace: "sales-trainer",
    company: "TAG",
    status: "active",
  };
}

function salesTrainerTokenSecret(config = {}) {
  const trainerConfig = getSalesTrainerConfig();
  const secret = trainerConfig.tokenSecret || config.jwtSecret || process.env.JWT_SECRET || "";
  if (!secret) {
    throw new Error("JWT_SECRET or SALES_TRAINER_TOKEN_SECRET is required for sales trainer tokens");
  }
  return crypto
    .createHash("sha256")
    .update(`${secret}:sales-trainer-token`)
    .digest("hex");
}

function signTrainerPayload(payload, config = {}) {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = crypto
    .createHmac("sha256", salesTrainerTokenSecret(config))
    .update(encoded)
    .digest("base64url");
  return `${encoded}.${sig}`;
}

function issueSalesTrainerToken(config = {}, email, account = null) {
  const normalized = normalizeEmail(email);
  const allowlisted = isEmailAllowedForSalesTrainer(normalized);
  const accountAllowed = isTaxAdvocateGroupSalesTrainerAccount(account);
  if (!allowlisted && !accountAllowed) {
    throw new ValidationError("Email is not allowed for the sales trainer");
  }

  const issuedAt = Date.now();
  const ttlHours = getSalesTrainerConfig().tokenTtlHours;
  const expiresAt = issuedAt + ttlHours * 60 * 60 * 1000;
  return {
    token: signTrainerPayload({
      scope: "sales-trainer",
      email: normalized,
      access: accountAllowed ? "account" : "allowlist",
      accountId: accountAllowed ? account.id || null : null,
      role: accountAllowed ? account.role || null : null,
      issuedAt,
      expiresAt,
    }, config),
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

function verifySalesTrainerToken(config = {}, token) {
  if (!token || !String(token).includes(".")) {
    throw new Error("Invalid sales trainer token");
  }
  const [encoded, sig] = String(token).split(".");
  const expected = crypto
    .createHmac("sha256", salesTrainerTokenSecret(config))
    .update(encoded)
    .digest("base64url");
  const providedBuffer = Buffer.from(sig || "", "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  if (
    providedBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(providedBuffer, expectedBuffer)
  ) {
    throw new Error("Bad sales trainer token signature");
  }

  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  if (payload.scope !== "sales-trainer") {
    throw new Error("Invalid sales trainer token scope");
  }
  const access = payload.access || "allowlist";
  if (!payload.email || (access !== "account" && !isEmailAllowedForSalesTrainer(payload.email))) {
    throw new Error("Sales trainer token email is not allowed");
  }
  if (Number(payload.expiresAt || 0) < Date.now()) {
    throw new Error("Sales trainer token expired");
  }
  return {
    email: normalizeEmail(payload.email),
    scope: payload.scope,
    access,
    accountId: payload.accountId || null,
    role: payload.role || null,
    issuedAt: payload.issuedAt || null,
    expiresAt: payload.expiresAt || null,
  };
}

function cleanText(value, maxLength = MAX_MESSAGE_CHARS) {
  return String(value || "")
    .replace(/\u0000/g, "")
    .trim()
    .slice(0, maxLength);
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(number, min), max);
}

function normalizeTtsVoice(value) {
  const voice = String(value || "").trim().toLowerCase();
  if (SALES_TRAINER_TTS_VOICES.includes(voice)) return voice;
  const fallback = String(getSalesTrainerConfig().ttsVoice || DEFAULT_TTS_VOICE).toLowerCase();
  return SALES_TRAINER_TTS_VOICES.includes(fallback) ? fallback : DEFAULT_TTS_VOICE;
}

function normalizeTtsFormat(value) {
  const format = String(value || "").trim().toLowerCase();
  if (SALES_TRAINER_TTS_FORMATS.includes(format)) return format;
  const fallback = String(getSalesTrainerConfig().ttsFormat || DEFAULT_TTS_FORMAT).toLowerCase();
  return SALES_TRAINER_TTS_FORMATS.includes(fallback) ? fallback : DEFAULT_TTS_FORMAT;
}

function audioMimeType(format) {
  switch (format) {
    case "aac":
      return "audio/aac";
    case "flac":
      return "audio/flac";
    case "opus":
      return "audio/ogg; codecs=opus";
    case "pcm":
      return "audio/L16";
    case "wav":
      return "audio/wav";
    case "mp3":
    default:
      return "audio/mpeg";
  }
}

// Used when persisting TTS audio to disk — strip anything that isn't a
// filename-safe lowercase extension. Allowlisted to the formats OpenAI
// actually emits.
function sanitizeAudioExt(format) {
  const lowered = String(format || "").trim().toLowerCase();
  return SALES_TRAINER_TTS_FORMATS.includes(lowered) ? lowered : "";
}

// The v2 prompt has Claude emit UI payloads inline in the response text
// as <UI_HEALTH>{...}</UI_HEALTH>, <UI_PAYLOAD>{...}</UI_PAYLOAD>, and
// <UI_SCORECARD>{...}</UI_SCORECARD> tagged blocks. The UI parses those
// blocks out for its side-panel rendering — but we MUST strip them from
// any text we hand to TTS, or the prospect will read JSON aloud.
//
// We also strip leftover code fences (the briefing block uses triple
// backticks) and squash double-blank-lines so the spoken output flows.
function stripTrainerUiTags(text) {
  return String(text || "")
    .replace(/<UI_(HEALTH|PAYLOAD|SCORECARD)>[\s\S]*?<\/UI_\1>/g, "")
    // Strip stage directions and tone labels that would otherwise be
    // read aloud verbatim by the TTS:
    //   *rustles papers*  → ""
    //   **takes a breath** → ""
    //   (sounding tired)  → ""
    //   [door slams]      → ""
    //   [long pause]      → ""
    // The prompt explicitly bans these, but Haiku slips through often
    // enough that belt-and-suspenders is worth the regex. We strip
    // ONLY paired delimiters around 1-60 non-newline chars so we don't
    // accidentally nuke real parentheticals like "(I'm 67, by the way)"
    // — those tend to be longer and contain natural dialogue cues.
    .replace(/\*{1,2}[^*\n]{1,60}\*{1,2}/g, "")
    .replace(/\[[^\]\n]{1,60}\]/g, "")
    // Parenthetical asides shorter than ~25 chars are almost always
    // stage directions ("(quietly)", "(in disbelief)", "(pausing)").
    // Longer parentheticals tend to be real dialogue. Tune cautiously.
    .replace(/\([^)\n]{1,25}\)/g, "")
    // Box-drawing chars from the briefing block — these don't TTS.
    .replace(/^[═─━]{3,}.*$/gm, "")
    // Collapse the whitespace left behind by all the stripping.
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s+([,.!?;:])/g, "$1")
    .trim();
}

function ttsModelSupportsInstructions(model) {
  return String(model || "").toLowerCase().startsWith("gpt-4o-mini-tts");
}

function normalizePersona(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function normalizeKnownPersona(value) {
  const persona = normalizePersona(value);
  switch (persona) {
    case "scared":
      return "anxious";
    case "price-shopper":
    case "guarded":
      return "skeptical";
    case "hostile":
      return "frustrated";
    case "impatient":
      return "rushed";
    case "business-owner":
      return "professional";
    default:
      return SALES_TRAINER_TTS_PERSONAS.includes(persona) ? persona : "neutral";
  }
}

function personaSpeechNotes(persona) {
  // Every branch now explicitly demands BRISK delivery. The model
  // interprets "normal pace" as audiobook-narrator slow; we have to
  // push it. The speed param tightens timing further.
  // Emotion comes through word choice and intonation, NOT pacing.
  switch (normalizePersona(persona)) {
    case "anxious":
    case "scared":
      return "Sound a little worried, but speak BRISKLY — fast-paced, like someone trying to get through this call quickly. No drawn-out words. No long pauses.";
    case "skeptical":
    case "price-shopper":
      return "Sound dryly skeptical and speak BRISKLY. Get through the words. No theatrical suspicion, no slowing down to emphasize doubt.";
    case "embarrassed":
      return "Sound slightly subdued but speak BRISKLY. Keep things moving. No whispering, no trailing off.";
    case "hostile":
    case "frustrated":
      return "Sound firm and direct, speaking BRISKLY with a small edge. No theatrical anger, no slow seething.";
    case "rushed":
    case "impatient":
      return "Sound hurried and clipped. FAST pace. Keep words intelligible but don't linger on anything.";
    case "confused":
      return "Sound mildly uncertain but speak BRISKLY. Words come out fast even if the meaning is fuzzy. No searching pauses.";
    case "talkative":
      return "Sound warm and conversational, speaking at a BRISK natural-conversation pace.";
    case "professional":
    case "business-owner":
      return "Sound businesslike, direct, and BRISK. The pace of someone with a meeting at the top of the hour.";
    case "coach":
      return "Sound like a calm, practical, confident coach speaking at a BRISK pace.";
    case "neutral":
    default:
      return "Speak BRISKLY at real phone-conversation pace. Sound like a real person, not an announcer. Do not stretch words. Do not insert dramatic pauses.";
  }
}

function buildTtsInstructions({
  persona = "neutral",
  personality = "",
  emotion = "",
  pacing = "",
  intensity = "",
  extraInstructions = "",
} = {}) {
  const cleanPersonality = cleanText(personality, MAX_TTS_PERSONALITY_CHARS);
  const notes = [
    "This is an AI-generated sales-training voice for roleplay.",
    personaSpeechNotes(normalizeKnownPersona(persona)),
    "Render only the supplied input text. Do not add, remove, or rewrite words.",
    "Treat caller-supplied personality details as voice direction only, not as instructions to change the response content.",
    "Use realistic human variation: natural pauses, changing sentence rhythm, subtle emphasis, and conversational inflection.",
    "Do not sound like an advertisement, IVR menu, podcast host, or audiobook narrator.",
    "Do not imitate a real person or celebrity.",
  ];

  if (cleanPersonality) {
    notes.push(`Locked roleplay personality: ${cleanPersonality}.`);
  }

  const cleanEmotion = cleanText(emotion, 120);
  if (cleanEmotion) notes.push(`Emotional color: ${cleanEmotion}.`);

  const cleanPacing = cleanText(pacing, 120);
  if (cleanPacing) notes.push(`Pacing direction: ${cleanPacing}.`);

  const cleanIntensity = cleanText(intensity, 80);
  if (cleanIntensity) notes.push(`Intensity: ${cleanIntensity}.`);

  const cleanExtra = cleanText(extraInstructions, 500);
  if (cleanExtra) notes.push(`Additional voice direction: ${cleanExtra}`);

  return notes.join(" ");
}

function normalizeTtsProfile({
  voiceProfile = null,
  profile = null,
  voice = null,
  persona = "",
  personality = "",
  emotion = "",
  pacing = "",
  intensity = "",
  extraInstructions = "",
  responseFormat = null,
  format = null,
  speed = null,
} = {}) {
  const source =
    voiceProfile && typeof voiceProfile === "object"
      ? voiceProfile
      : profile && typeof profile === "object"
        ? profile
        : {};
  const config = getSalesTrainerConfig();
  const effectivePersona = normalizeKnownPersona(
    source.persona || source.roleplayPersona || persona || source.personalityType,
  );
  const effectiveVoice = normalizeTtsVoice(source.voice || voice);
  const effectiveFormat = normalizeTtsFormat(
    source.responseFormat || source.format || responseFormat || format,
  );
  const requestedSpeed = speed === "" || speed == null ? source.speed : speed;
  const effectiveSpeed = clampNumber(
    requestedSpeed,
    0.25,
    4,
    clampNumber(config.ttsSpeed, 0.25, 4, 1),
  );
  const normalized = {
    model: config.ttsModel,
    voice: effectiveVoice,
    persona: effectivePersona,
    personality: cleanText(source.personality || source.style || personality, MAX_TTS_PERSONALITY_CHARS),
    emotion: cleanText(source.emotion || emotion, 120),
    pacing: cleanText(source.pacing || pacing, 120),
    intensity: cleanText(source.intensity || intensity, 80),
    extraInstructions: cleanText(source.extraInstructions || source.voiceNotes || extraInstructions, 500),
    responseFormat: effectiveFormat,
    speed: effectiveSpeed,
    locked: true,
  };
  const profileHash = crypto
    .createHash("sha256")
    .update(JSON.stringify(normalized))
    .digest("hex")
    .slice(0, 16);
  return {
    profileId: `tts_${profileHash}`,
    ...normalized,
  };
}

function normalizeRole(role) {
  const value = String(role || "").trim().toLowerCase();
  if (value === "assistant") return "assistant";
  if (value === "developer" || value === "system") return "user";
  return "user";
}

function normalizeMessages(messages) {
  const raw = Array.isArray(messages) ? messages : [];
  return raw
    .slice(-MAX_MESSAGES)
    .map((message) => ({
      role: normalizeRole(message?.role),
      content: cleanText(message?.content),
    }))
    .filter((message) => message.content);
}

function buildSessionHeader({ mode, scenario, user, profile, playbook = null } = {}) {
  // Adapter between the v2 prompt's launch protocol and our actual flow.
  //
  // v2's <call_initiation_protocol> says the simulator's first chat
  // message is the long briefing block, then it waits for the agent's
  // mode/difficulty pick, then it silently generates a profile, then it
  // delivers the opening per <call_modes>.
  //
  // We collapse that into pre-flight server work:
  //   - The briefing is shown statically in the UI (not emitted by Claude)
  //   - Mode + difficulty are picked in the UI, sent on /session/start
  //   - startSalesTrainerSession() generates the profile via a separate
  //     tool-use call (CALLER_PROFILE_TOOL on Sonnet)
  //   - The profile is pinned into this header on every subsequent /respond
  //
  // Claude's job in the conversational session is therefore: skip the
  // briefing, skip the mode/difficulty/profile-generation steps, and go
  // straight to in-character delivery per <call_modes> for the given
  // mode + locked profile.
  const normalizedMode = String(mode || "auto").toLowerCase();
  // Surface key identity fields for the character anchor (below). These
  // pull from the locked profile if present so the model has a
  // first-name reminder of WHO it is on every turn — critical for
  // preventing Haiku from drifting into the agent's voice mid-call.
  const callerFirstName = cleanText(profile?.callerFirstName || profile?.firstName || "the caller", 60);
  const callerLastName = cleanText(profile?.callerLastName || profile?.lastName || "", 60);
  const callerFullName = `${callerFirstName}${callerLastName ? ` ${callerLastName}` : ""}`.trim();

  const parts = [
    "═══════════════════════════════════════════════════════════════",
    "CRITICAL ROLE ANCHOR — READ THIS FIRST, RE-CHECK BEFORE EVERY TURN:",
    "═══════════════════════════════════════════════════════════════",
    "",
    `YOU ARE: ${callerFullName} — the PROSPECT calling Tax Advocate Group / Wynn Tax. You are NOT the agent. You are NOT the salesperson. You are the person on the OTHER END of the call — the one with a tax problem looking for help.`,
    "",
    "WHO IS WHO IN THE MESSAGE HISTORY:",
    "  - role: \"user\"      = the SALES AGENT speaking (the trainee). They are the one PITCHING you.",
    "  - role: \"assistant\" = YOU, the prospect — every previous assistant turn is something YOU already said. Stay consistent with it.",
    "",
    "BEFORE GENERATING EACH TURN, INTERNALLY CHECK:",
    "  1. \"Am I the prospect? YES.\"",
    "  2. \"Is this the agent's pitch or the prospect's reply that's about to come out?\" If you're writing a pitch, you've drifted — STOP and write as the prospect instead.",
    "  3. \"Does the next line sound like something the agent would say (asking for info, explaining services, quoting fees, handling objections)? If YES, you're in the WRONG character — flip back to the prospect.\"",
    "",
    "PROSPECT TURNS sound like: questions, hesitations, objections, emotional reactions, story fragments, plain confusion. They do NOT pitch, never explain services, never quote prices, never ask the prospect (themselves) for ID info.",
    "",
    "NO META-COMMENTARY. EVER. The response is what the character LITERALLY SAYS into the phone — first-person dialogue, period. You do NOT:",
    "  - describe the character ('Mary would feel anxious here', 'as Mary, I...')",
    "  - narrate your reasoning ('Considering what you said...', 'Let me think about that...')",
    "  - reference the playbook, profile, trust score, phase, simulator, or training context",
    "  - prefix with stage directions, mood labels, or thought captions",
    "  - quote yourself ('Mary says: \"...\"') — just SPEAK as the character",
    "Bad (meta): 'As a 67-year-old anxious retiree, I would respond...'  Good: 'I don't know — that letter scared me half to death.'",
    "Bad (meta): '*pauses* Hmm, let me think.'                            Good: 'Hold on a minute, I... I'm trying to remember.'",
    "Bad (meta): 'In this phase the prospect would push back on...'      Good: 'How much is this going to cost me?'",
    "The TTS will literally read your words aloud to the rep. Anything that isn't the character's actual phone dialogue is wrong.",
    "",
    "If at any point in the conversation history you notice you previously DRIFTED out of character, get back into character immediately — don't acknowledge the drift, just resume as the prospect.",
    "",
    "═══════════════════════════════════════════════════════════════",
    "SESSION BOOT — overrides the launch protocol in <call_initiation_protocol>:",
    "═══════════════════════════════════════════════════════════════",
    "",
    "1. The simulator briefing block from <call_initiation_protocol> has ALREADY been shown to the trainee as static UI. DO NOT emit it. DO NOT recap it.",
    "2. Mode and difficulty have ALREADY been chosen. DO NOT prompt for them.",
    "3. The caller profile has ALREADY been generated and is pinned below. Use it. DO NOT generate a different caller. DO NOT contradict any locked trait.",
    "4. Skip directly to in-character delivery per <call_modes> for the locked mode.",
    "   - INBOUND: The trainee's first chat message represents the agent answering the call (e.g., 'Tax Group' or 'Wynn Tax'). Respond with the caller's opening line per the INBOUND opening patterns and the locked profile.",
    "   - OUTBOUND: The prospect's pickup (one or two words matching archetype + mood) has ALREADY been pre-synthesized and played to the trainee from `profile.openingLine` — treat it as if you already said it. The trainee's first chat message is their introduction. Respond per the OUTBOUND opening patterns based on the locked profile (memory-of-opt-in, mood, archetype).",
    "5. All other rules from the v2 prompt apply normally: phase tracking, health bar, UI payload emission at boundaries, coaching, end-of-call protocol.",
    "",
    "VOICE LENGTH CONSTRAINT (this is a voice call, not a chat): Keep each in-character turn to ONE TO THREE short sentences. Real prospects on the phone speak in bursts, not monologues. No long paragraphs — but say what the moment actually calls for. The TTS renders sentences in parallel so length isn't a latency cost, only realism is.",
    "UI payload blocks (<UI_HEALTH>, <UI_PAYLOAD>, <UI_SCORECARD>) do NOT count toward this constraint — they're processed silently.",
    "",
    `Locked mode: ${cleanText(normalizedMode, 80) || "auto"}`,
    `Scenario request: ${cleanText(scenario || "use the locked profile below", 600)}`,
  ];
  if (user?.email) {
    parts.push(`Trainee: ${cleanText(user.name || user.email, 120)}`);
  }
  if (profile && typeof profile === "object") {
    // Pin the caller profile into the system context. Claude must use
    // these traits consistently throughout the call — no inventing new
    // facts, no contradicting these traits mid-conversation. The
    // profile is rolled once at /session/start and passed back on
    // every /respond from the client (stateless server-side).
    parts.push("");
    parts.push("LOCKED CALLER PROFILE (immutable for this session — use these traits consistently, do not invent new ones):");
    parts.push(JSON.stringify(profile, null, 2));
  }

  // Pre-generated story playbook from Sonnet. This is the live model's
  // "map" — reference material describing who this character is, what
  // they know, what they hide, and how they react.
  //
  // CRITICAL: this is NOT a script to recite. The model must actually
  // engage with what the agent just said and respond authentically.
  // The playbook is context/reference — verbatim lines are STYLE
  // GUIDES for tone and word choice, not lines to read aloud regardless
  // of what was asked.
  if (playbook && typeof playbook === "object") {
    parts.push("");
    parts.push("═══════════════════════════════════════════════════════════════");
    parts.push(
      "STORY PLAYBOOK — reference material for THIS caller. NOT a script.",
    );
    parts.push("═══════════════════════════════════════════════════════════════");
    parts.push("");
    parts.push("HOW TO USE THIS PLAYBOOK:");
    parts.push("");
    parts.push(
      "Every turn, you must FIRST consider what the agent actually said in their last message, THEN respond as your character. The playbook is reference material to keep you anchored — it is NOT a script you read line by line.",
    );
    parts.push("");
    parts.push("Specifically:");
    parts.push(
      "  - `callerSummary` is your identity recap. Re-read it each turn to anchor who you are.",
    );
    parts.push(
      "  - `objectionQueue` is a LIST of objections this character WOULD raise during the call. Each entry's `verbatim` field shows the EXACT TONE and WORD CHOICE this character uses — use it as a style sample. If the agent's last move matches a `trigger` and we're in the right `phase`, this is the kind of objection to raise. Match the style/length/register of the verbatim line, but ANSWER WHAT THE AGENT ACTUALLY SAID. If they asked something unexpected, respond to that, not to a pre-written objection.",
    );
    parts.push(
      "  - `hiddenFacts` are truths about this character. The character KNOWS these facts but won't volunteer them. When the agent's question matches a `revealsWhen` trigger, surface that fact in your response — using the `revealLine` as a style/tone reference. Don't recite revealLine if the agent's question wasn't actually asking about it.",
    );
    parts.push(
      "  - `tellLines` are emotional-beat references for KEY MOMENTS: earned vulnerability (one time, only when trust crosses 7 AND the agent's response invited it), close accept (only when ALL close conditions met AND agent just made a close-able move), close decline (soft exit when conditions aren't met), hangup (catastrophic mistake or health=0). Match the EMOTION and REGISTER of these lines; don't recite them verbatim unless the moment naturally calls for them.",
    );
    parts.push(
      "  - Track your internal trust against `trustArc`. Apply the `triggers` deltas when the named agent behaviors actually fire. Stay within minTrust/maxTrust bounds. Trust shapes your tone — high trust = warmer, lower trust = guarded.",
    );
    parts.push(
      "  - `phaseGuidance[phaseN]` is your directive for energy/posture in each phase. What you should volunteer vs. hold back. Use it as the lens through which you read the agent's turn.",
    );
    parts.push(
      "  - If `uncloseableReason` is set, this caller does NOT close on this call no matter how strong the agent's handling — keep that constraint in mind and steer toward closeDecline when the close is attempted. Don't manufacture a hangup just to enforce this — let the call play out naturally with no-close.",
    );
    parts.push("");
    parts.push(
      "TURN-BY-TURN MENTAL MODEL: Read the agent's last user-turn message. Ask: 'What did they just say to me?' Then: 'Given who I am (callerSummary + profile + current trust + current phase), how would I respond?' Use the playbook's verbatim samples for VOICE — vocabulary, hedge words, sentence rhythm. Use the hidden facts and trust arc as TRUTH about the character. But generate a response that genuinely engages with what was asked.",
    );
    parts.push("");
    parts.push("Playbook content:");
    parts.push(JSON.stringify(playbook, null, 2));
  }

  // Tail anchor: last thing the model reads before processing the
  // conversation history. Repeats the role anchor in compact form
  // because long contexts + faster (cheaper) models tend to lose the
  // top-of-prompt instructions by the time they get to generation.
  parts.push("");
  parts.push("═══════════════════════════════════════════════════════════════");
  parts.push(
    `FINAL REMINDER BEFORE YOU RESPOND: You are ${callerFullName}, the PROSPECT. The next user turn is the SALES AGENT speaking to you. Your response is what ${callerFirstName} LITERALLY SAYS into the phone — first-person dialogue only, no meta, no narration, no stage directions, no playbook references. 1-3 short sentences. Stay in character.`,
  );
  parts.push("═══════════════════════════════════════════════════════════════");

  return parts.join("\n");
}

function buildInput({ messages, mode, scenario, user, profile, playbook = null }) {
  const normalized = normalizeMessages(messages);
  if (normalized.length === 0) {
    throw new ValidationError("At least one trainer message is required");
  }

  const input = [
    {
      role: "developer",
      content: buildSessionHeader({ mode, scenario, user, profile, playbook }),
    },
    ...normalized,
  ];

  let total = 0;
  for (const item of input) {
    total += item.content.length;
  }
  if (total > MAX_INPUT_CHARS) {
    throw new ValidationError(`Trainer input is too large; keep the last ${MAX_INPUT_CHARS} characters or less`);
  }

  return input;
}

function extractOutputText(payload) {
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

function safeJsonParse(text) {
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
    return null;
  }
}

async function callOpenAiResponses({ input, model, maxOutputTokens, timeoutMs }) {
  const config = getSalesTrainerConfig();
  if (!config.apiKey) {
    throw new ExternalServiceError("openai", "OPENAI_API_KEY is missing", {
      status: 500,
      retryable: false,
    });
  }

  const effectiveTimeoutMs = Math.max(Number(timeoutMs) || config.timeoutMs, 1000);
  const abortController = new AbortController();
  const timeoutHandle = setTimeout(() => abortController.abort(), effectiveTimeoutMs);

  let response;
  try {
    response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: model || config.model,
        instructions: TAX_RESOLUTION_SALES_TRAINER_PROMPT,
        input,
        max_output_tokens: maxOutputTokens || config.maxOutputTokens,
      }),
      signal: abortController.signal,
    });
  } catch (error) {
    clearTimeout(timeoutHandle);
    const isAbort = error?.name === "AbortError";
    throw new ExternalServiceError(
      "openai",
      isAbort
        ? `OpenAI trainer request timed out after ${effectiveTimeoutMs}ms`
        : `OpenAI trainer request failed: ${error.message}`,
      {
        status: isAbort ? 504 : 502,
        retryable: true,
        details: {
          timeoutMs: effectiveTimeoutMs,
          reason: isAbort ? "timeout" : "network",
        },
      },
    );
  }
  clearTimeout(timeoutHandle);

  const rawText = await response.text();
  let payload = null;
  try {
    payload = rawText ? JSON.parse(rawText) : null;
  } catch {
    payload = { rawText };
  }

  if (!response.ok) {
    throw new ExternalServiceError(
      "openai",
      `OpenAI trainer request failed: ${response.status}`,
      {
        status: response.status >= 500 || response.status === 429 ? 502 : 400,
        retryable: response.status >= 500 || response.status === 429,
        details: {
          responseStatus: response.status,
          responseBody: payload,
        },
      },
    );
  }

  const outputText = extractOutputText(payload);
  if (!outputText) {
    throw new ExternalServiceError("openai", "OpenAI trainer returned no text", {
      status: 502,
      retryable: true,
      details: { responseBody: payload },
    });
  }

  return {
    text: outputText,
    model: payload?.model || model || config.model,
    responseId: payload?.id || null,
    usage: payload?.usage || null,
  };
}

// ── Anthropic provider ──────────────────────────────────────────────
//
// Maps the codex-shaped `input` array (containing a `developer` session
// header + alternating user/assistant turns) into Claude's Messages API:
//
//   - The `developer` header gets concatenated onto the bottom of the
//     system prompt (Claude has no separate "developer" role).
//   - The remaining turns become Claude's `messages` array directly.
//
// Claude requires the first message in `messages` to be from `user`.
// buildInput already enforces "at least one trainer message," and the
// developer header is stripped here, so the surviving first message
// will be the trainee's most recent user turn.

async function synthesizeSalesTrainerSpeech({
  text,
  voiceProfile = null,
  profile = null,
  voice = null,
  persona = "neutral",
  personality = "",
  emotion = "",
  pacing = "",
  intensity = "",
  extraInstructions = "",
  responseFormat = null,
  format = null,
  speed = null,
  timeoutMs = null,
} = {}) {
  const config = getSalesTrainerConfig();
  if (!config.apiKey) {
    throw new ExternalServiceError("openai", "OPENAI_API_KEY is missing", {
      status: 500,
      retryable: false,
    });
  }

  const input = cleanText(text, MAX_TTS_INPUT_CHARS);
  if (!input) {
    throw new ValidationError("Text is required for trainer speech");
  }

  const normalizedProfile = normalizeTtsProfile({
    voiceProfile,
    profile,
    voice,
    persona,
    personality,
    emotion,
    pacing,
    intensity,
    extraInstructions,
    responseFormat,
    format,
    speed,
  });
  const instructions = buildTtsInstructions(normalizedProfile);
  const speechPayload = {
    model: config.ttsModel,
    voice: normalizedProfile.voice,
    input,
    response_format: normalizedProfile.responseFormat,
    speed: normalizedProfile.speed,
  };
  if (ttsModelSupportsInstructions(config.ttsModel)) {
    speechPayload.instructions = instructions;
  }
  const effectiveTimeoutMs = Math.max(Number(timeoutMs) || config.timeoutMs, 1000);
  const abortController = new AbortController();
  const timeoutHandle = setTimeout(() => abortController.abort(), effectiveTimeoutMs);

  let response;
  try {
    response = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(speechPayload),
      signal: abortController.signal,
    });
  } catch (error) {
    clearTimeout(timeoutHandle);
    const isAbort = error?.name === "AbortError";
    throw new ExternalServiceError(
      "openai",
      isAbort
        ? `OpenAI speech request timed out after ${effectiveTimeoutMs}ms`
        : `OpenAI speech request failed: ${error.message}`,
      {
        status: isAbort ? 504 : 502,
        retryable: true,
        details: {
          timeoutMs: effectiveTimeoutMs,
          reason: isAbort ? "timeout" : "network",
        },
      },
    );
  }
  clearTimeout(timeoutHandle);

  if (!response.ok) {
    const rawText = await response.text();
    let payload = rawText;
    try {
      payload = rawText ? JSON.parse(rawText) : null;
    } catch {
      // Keep the raw error body if it is not JSON.
    }
    throw new ExternalServiceError(
      "openai",
      `OpenAI speech request failed: ${response.status}`,
      {
        status: response.status >= 500 || response.status === 429 ? 502 : 400,
        retryable: response.status >= 500 || response.status === 429,
        details: {
          responseStatus: response.status,
          responseBody: payload,
        },
      },
    );
  }

  const audioBuffer = Buffer.from(await response.arrayBuffer());
  return {
    audioBase64: audioBuffer.toString("base64"),
    byteLength: audioBuffer.length,
    mimeType: audioMimeType(normalizedProfile.responseFormat),
    format: normalizedProfile.responseFormat,
    model: config.ttsModel,
    voice: normalizedProfile.voice,
    speed: normalizedProfile.speed,
    instructionsSupported: ttsModelSupportsInstructions(config.ttsModel),
    voiceProfile: normalizedProfile,
    disclosure: "ai-generated-voice",
  };
}

// ── Sentence-chunked parallel TTS ──────────────────────────────────
//
// Why this exists:
//   The single-blob TTS render takes ~1.5-3.5s for a 2-3-sentence
//   prospect turn — proportional to text length. That's the dominant
//   chunk of the user-perceived "lag between sending and hearing the
//   prospect respond."
//
//   Trick: TTS renders are independent per chunk. If we split the
//   response into sentences and fire N OpenAI TTS calls in parallel,
//   the total wall-clock cost is roughly max(individual render times),
//   not the sum. For 3 short sentences that's ~600-900ms instead of
//   ~2-3s — a ~3x speedup without changing voice, model, or speed.
//
//   The client gets back an ordered array of audio chunks instead of
//   one big blob, and plays them sequentially (chunk N+1 starts when
//   chunk N ends). To the user it sounds like one continuous prospect
//   utterance with natural sentence-break breathing.

// Splits a response into sentence-sized chunks suitable for parallel
// TTS. Real-world test prioritites:
//   - Don't break on decimal points ("$2,500.00")
//   - Don't break on common abbreviations ("Mr.", "St.", "Dr.")
//   - Don't break on ellipses inside a sentence ("I... I don't know.")
//   - DO break on terminal . ! ? followed by space + capital
//   - Group very short chunks (<= 12 chars) with the next/previous to
//     avoid microscopic TTS calls
function splitIntoSpeechChunks(text) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return [];

  // Pre-mask things we don't want to split on with sentinels.
  const ABBR = /(\b(?:Mr|Mrs|Ms|Dr|Sr|Jr|St|Ave|Blvd|Rd|Inc|Ltd|Co|U\.S|U\.K|vs|etc|i\.e|e\.g))\./gi;
  let masked = clean.replace(ABBR, "$1§");
  // Decimal numbers: "$2,500.00" → "$2,500§00"
  masked = masked.replace(/(\d)\.(\d)/g, "$1§$2");
  // Ellipses: keep as a single unit
  masked = masked.replace(/\.{2,}/g, "§§§");

  // Split on terminal punctuation followed by whitespace, capturing the
  // punctuation so we can re-attach it. Also split on the standalone
  // `…` glyph if present.
  const raw = masked
    .split(/(?<=[.!?])\s+(?=[A-Z"'(])/g)
    .map((piece) => piece.trim())
    .filter(Boolean);

  // Restore the masked tokens.
  const restored = raw.map((piece) =>
    piece.replace(/§§§/g, "...").replace(/§/g, "."),
  );

  // Combine micro-chunks. Anything <= 12 chars is too short to TTS on
  // its own (the model output sounds clipped). Glue to neighbor.
  const merged = [];
  for (const piece of restored) {
    if (merged.length > 0 && piece.length <= 12) {
      merged[merged.length - 1] = `${merged[merged.length - 1]} ${piece}`;
    } else if (merged.length > 0 && merged[merged.length - 1].length <= 12) {
      merged[merged.length - 1] = `${merged[merged.length - 1]} ${piece}`;
    } else {
      merged.push(piece);
    }
  }

  // Hard cap: if for some reason the splitter produced 8+ chunks for a
  // normal-length response, glue the tail together. We never want to
  // fire 10 parallel TTS calls — that's API-budget waste and adds
  // network overhead.
  while (merged.length > 6) {
    const tail = merged.pop();
    merged[merged.length - 1] = `${merged[merged.length - 1]} ${tail}`;
  }
  return merged;
}

// Render an array of text chunks as TTS in parallel. Returns an
// ordered array of audio results (preserving the split order so the
// client plays them in sequence).
//
// All chunks share the same voice profile — we just slice the text,
// not the voice config. Each chunk gets its own audio response with
// audioBase64 + mimeType + format so the UI can build a playlist of
// data URLs or feed them into a single MediaSource queue.
async function synthesizeSalesTrainerSpeechChunks(opts = {}) {
  const text = String(opts.text || "");
  const chunks = splitIntoSpeechChunks(text);

  // If the splitter found zero or one chunk, there's no parallelism
  // benefit — just do the regular single-blob render.
  if (chunks.length === 0) {
    throw new ValidationError("Text is required for trainer speech");
  }
  if (chunks.length === 1) {
    const single = await synthesizeSalesTrainerSpeech({ ...opts, text: chunks[0] });
    return {
      chunks: [{ index: 0, text: chunks[0], ...single }],
      // Replicate the single-blob shape on the top level so older
      // callers that read .audioBase64 keep working.
      ...single,
    };
  }

  // Parallel render. Each TTS call hits OpenAI independently; there's
  // no rate-limit risk at the 3-6 chunks per turn we expect here.
  const settled = await Promise.allSettled(
    chunks.map((chunkText) =>
      synthesizeSalesTrainerSpeech({ ...opts, text: chunkText }),
    ),
  );

  // Collect successes + errors. If ANY chunk failed, we still return
  // the successful ones in order; the UI plays what we have.
  const audioChunks = [];
  const errors = [];
  for (let i = 0; i < settled.length; i += 1) {
    const result = settled[i];
    if (result.status === "fulfilled") {
      audioChunks.push({ index: i, text: chunks[i], ...result.value });
    } else {
      errors.push({
        index: i,
        text: chunks[i],
        message: result.reason?.message || String(result.reason),
        status: result.reason?.status || null,
      });
    }
  }

  if (audioChunks.length === 0) {
    // Everything failed — bubble up the first error so the route's
    // existing error handling can render it.
    const first = errors[0];
    throw new ExternalServiceError(
      "openai",
      `All TTS chunks failed: ${first?.message || "unknown"}`,
      { status: first?.status || 502, retryable: true, details: { errors } },
    );
  }

  // For backwards-compat: expose the first chunk's audioBase64/mimeType
  // at the top level so legacy callers that play one blob still work.
  // The new client should iterate `chunks` and play them in order.
  const first = audioChunks[0];
  return {
    chunks: audioChunks,
    errors,
    // legacy shape mirrored from first chunk
    audioBase64: first.audioBase64,
    byteLength: first.byteLength,
    mimeType: first.mimeType,
    format: first.format,
    model: first.model,
    voice: first.voice,
    speed: first.speed,
    voiceProfile: first.voiceProfile,
    instructionsSupported: first.instructionsSupported,
    disclosure: first.disclosure,
  };
}

// Domain vocabulary biasing for Whisper. Whisper treats the `prompt`
// param as "this is what was just spoken — keep going from here," so
// listing terms in the exact form we want them transcribed nudges the
// model toward those spellings over phonetic guesses. Without this,
// reps hear "CP504" come back as "see pee five oh four," "OIC" as "OIC"
// or "oh i see," "TFRP" as "TFR P," and firm names get mangled into
// generic words.
//
// 1000-char hard cap from OpenAI. We're well under that. Keep this
// list focused: the highest-leverage additions are firm names, IRS
// notice codes, and the resolution-vocabulary the rep will actually
// say on calls. Common English words don't need to be listed.
const STT_DOMAIN_PRIMER = [
  // Firm names — biggest source of mistranscription
  "Tax Group, Tax Advocate Group, Wynn Tax, Wynn Tax Solutions.",
  // IRS notice codes — Whisper consistently mangles these without help
  "CP14, CP501, CP503, CP504, LT11, Letter 1058, CP2000, 1099-C, 1099-NEC, 1099-R, W-2G.",
  // Resolution vocabulary the rep uses constantly
  "Offer in Compromise, OIC, installment agreement, Currently Not Collectible, CNC, partial pay installment agreement, PPIA, Power of Attorney, POA, Collection Statute Expiration Date, CSED.",
  // Enforcement vocabulary
  "Notice of Federal Tax Lien, NFTL, levy, garnishment, Substitute for Return, SFR, Trust Fund Recovery Penalty, TFRP, Revenue Officer, RO.",
  // Forms and references
  "Form 433-A, Form 433-F, Form 2848, Form 8821, Form 8857 Innocent Spouse, IRC 6672, IRC 7122, IRC 6159.",
  // State authorities
  "FTB, NYS DTF, BOE, CDTFA.",
].join(" ");

// In-memory Whisper transcription for the trainer mic loop. The hourly
// hygiene path (transcriptionScoringService) writes recordings to disk
// first; here the audio comes straight from a browser MediaRecorder
// upload, so we keep it in a Buffer and skip the filesystem.
//
// Returns { text, language, durationSec, model } — flat shape so the
// route can pass it straight to the client and so `runSalesTrainerTurn`
// can drop `text` into the next user message without extra plumbing.
async function transcribeSalesTrainerAudio({
  buffer,
  mimeType = "audio/webm",
  filename = "trainer-mic.webm",
  language = null,
  prompt = "",
  timeoutMs = null,
} = {}) {
  const config = getSalesTrainerConfig();
  if (!config.apiKey) {
    throw new ExternalServiceError("openai", "OPENAI_API_KEY is missing", {
      status: 500,
      retryable: false,
    });
  }
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new ValidationError("Audio buffer is required for transcription");
  }
  // Whisper API caps single uploads at 25 MB. Anything bigger almost
  // certainly means the client buffered a whole session — reject fast
  // instead of timing out 30s later on the OpenAI side.
  if (buffer.length > 24 * 1024 * 1024) {
    throw new ValidationError("Audio upload exceeds 24 MB; chunk per turn", {
      details: { byteLength: buffer.length },
    });
  }

  const blob = new Blob([buffer], { type: mimeType });
  const form = new FormData();
  form.append("file", blob, filename);
  form.append("model", config.sttModel);
  // Response format depends on model:
  //   - whisper-1 supports json | text | srt | verbose_json | vtt
  //   - gpt-4o-mini-transcribe / gpt-4o-transcribe support json | text
  // We only need the `text` field either way, so request `json` which
  // both families support. Using verbose_json on a gpt-4o-*-transcribe
  // model returns a 400 — so the format selection is required, not
  // cosmetic.
  const modelName = String(config.sttModel || "").toLowerCase();
  const supportsVerboseJson = modelName === "whisper-1";
  form.append("response_format", supportsVerboseJson ? "verbose_json" : "json");
  const effectiveLanguage = language || config.sttLanguage || "";
  if (effectiveLanguage) form.append("language", effectiveLanguage);

  // Build the biasing prompt: domain primer first (always), then any
  // per-call context the caller supplied (e.g., the prior assistant
  // turn so the rep's "yeah okay so on that..." continues coherently).
  // OpenAI hard-caps the prompt at 224 tokens (~1000 chars). We give
  // the primer the lion's share since it's the highest-leverage signal.
  const callerPrompt = String(prompt || "").trim();
  const PRIMER_BUDGET = 800;
  const CALLER_BUDGET = 200;
  const promptParts = [STT_DOMAIN_PRIMER.slice(0, PRIMER_BUDGET)];
  if (callerPrompt) promptParts.push(callerPrompt.slice(-CALLER_BUDGET));
  form.append("prompt", promptParts.join(" "));

  // Temperature 0 = take the model's top hypothesis. Default is also 0
  // for Whisper but being explicit prevents future env-driven drift.
  form.append("temperature", "0");

  const effectiveTimeoutMs = Math.max(Number(timeoutMs) || config.timeoutMs, 1000);
  const abortController = new AbortController();
  const timeoutHandle = setTimeout(() => abortController.abort(), effectiveTimeoutMs);

  let response;
  try {
    response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiKey}` },
      body: form,
      signal: abortController.signal,
    });
  } catch (error) {
    clearTimeout(timeoutHandle);
    const isAbort = error?.name === "AbortError";
    throw new ExternalServiceError(
      "openai",
      isAbort
        ? `OpenAI transcription request timed out after ${effectiveTimeoutMs}ms`
        : `OpenAI transcription request failed: ${error.message}`,
      {
        status: isAbort ? 504 : 502,
        retryable: true,
        details: { timeoutMs: effectiveTimeoutMs, reason: isAbort ? "timeout" : "network" },
      },
    );
  }
  clearTimeout(timeoutHandle);

  if (!response.ok) {
    const rawText = await response.text();
    let payload = rawText;
    try {
      payload = rawText ? JSON.parse(rawText) : null;
    } catch {
      // keep raw
    }
    throw new ExternalServiceError(
      "openai",
      `OpenAI transcription request failed: ${response.status}`,
      {
        status: response.status >= 500 || response.status === 429 ? 502 : 400,
        retryable: response.status >= 500 || response.status === 429,
        details: { responseStatus: response.status, responseBody: payload },
      },
    );
  }

  const data = await response.json();
  // Prefer the concatenated segments since whisper-1's `text` field is
  // sometimes lightly punctuated while segments retain the natural pauses.
  let text = "";
  if (Array.isArray(data.segments) && data.segments.length > 0) {
    text = data.segments.map((s) => String(s.text || "").trim()).join(" ").trim();
  }
  if (!text) text = String(data.text || "").trim();

  return {
    text,
    language: data.language || effectiveLanguage || null,
    durationSec: typeof data.duration === "number" ? data.duration : null,
    model: config.sttModel,
    byteLength: buffer.length,
  };
}

function adaptInputForAnthropic(input, opts = {}) {
  // opts.promptVariant: "slim" (default for live turns) | "full"
  //   - "slim" uses TAX_RESOLUTION_SALES_TRAINER_LIVE_TURN_PROMPT (~2.3k tokens)
  //   - "full" uses TAX_RESOLUTION_SALES_TRAINER_PROMPT (~27.5k tokens) —
  //     reserved for "break character" recovery turns or eval runs
  const promptVariant = opts.promptVariant === "full" ? "full" : "slim";
  const systemPromptText =
    promptVariant === "full"
      ? TAX_RESOLUTION_SALES_TRAINER_PROMPT
      : TAX_RESOLUTION_SALES_TRAINER_LIVE_TURN_PROMPT;
  const developerEntries = [];
  const turns = [];
  for (const item of input) {
    if (item?.role === "developer") {
      developerEntries.push(item.content);
      continue;
    }
    // Claude only accepts "user" and "assistant" roles in messages.
    // normalizeRole already collapses other roles to "user", but we
    // double-check here so a future schema drift doesn't slip through.
    const role = item?.role === "assistant" ? "assistant" : "user";
    turns.push({ role, content: item.content });
  }
  // Drop leading assistant turns — Anthropic rejects messages whose
  // first entry is assistant. In practice we never construct one that
  // starts with assistant, but the guard costs nothing.
  while (turns.length > 0 && turns[0].role !== "user") turns.shift();

  // Anthropic prompt caching:
  //   The v2 prompt is ~26k tokens and identical for every trainer turn
  //   across every session. Wrapping it in a system block with
  //   `cache_control: { type: "ephemeral" }` tells Anthropic to cache
  //   that exact prefix for ~5 minutes. Subsequent calls within the
  //   window read from the cache at ~10% of the input-token cost AND
  //   significantly lower latency (the model skips re-processing the
  //   prefix). This is the single biggest TTFB win available for the
  //   "play as soon as ready" UX.
  //
  //   The session header is per-session (caller profile, mode), so it
  //   must NOT live in the cached block — otherwise cache misses on
  //   every new session. We prepend it to the first user message
  //   instead. The model sees the same context either way; only the
  //   cache key differs.
  // TWO cache breakpoints, two scopes:
  //
  //   1) v2 system prompt — globally cached across every session. The
  //      same ~26k tokens for every trainee, every call.
  //
  //   2) session header — cached for THIS session only. ~3-5k tokens
  //      of profile + playbook + role anchors that are stable for the
  //      whole call but vary per-session. Without this cache, that
  //      content re-encoded on every turn — a non-trivial chunk of
  //      the ~10s end-to-end latency.
  //
  // Anthropic supports up to 4 cache_control breakpoints per request.
  // Each marks the END of a cacheable prefix; cache hit means Anthropic
  // skips re-processing everything up to that mark.
  //
  // Result: first turn of a new session primes both caches (cache MISS
  // on session header, HIT on v2 prompt). Every subsequent turn within
  // ~5 min hits BOTH caches and only processes the actual user message.
  const systemBlocks = [
    {
      type: "text",
      text: systemPromptText,
      cache_control: { type: "ephemeral" },
    },
  ];

  if (developerEntries.length > 0) {
    systemBlocks.push({
      type: "text",
      text: `Session context for this turn:\n${developerEntries.join("\n\n")}`,
      cache_control: { type: "ephemeral" },
    });
  }

  return { systemBlocks, messages: turns, promptVariant };
}

async function callAnthropicMessages({ input, model, maxOutputTokens, timeoutMs, promptVariant }) {
  const config = getSalesTrainerConfig();
  if (!config.anthropicApiKey) {
    throw new ExternalServiceError("anthropic", "ANTHROPIC_API_KEY is missing", {
      status: 500,
      retryable: false,
    });
  }

  const { systemBlocks, messages } = adaptInputForAnthropic(input, { promptVariant });
  if (messages.length === 0) {
    throw new ValidationError("No user messages after adapting input for Claude");
  }

  const client = createAnthropicClient();
  let raw;
  try {
    raw = await client.createMessage({
      // Pass the cache-controlled system blocks straight through. The
      // shared Anthropic client serializes whatever it gets — arrays
      // and strings both pass to /v1/messages cleanly.
      system: systemBlocks,
      messages,
      model: model || config.anthropicModel,
      maxTokens: maxOutputTokens || config.maxOutputTokens,
      temperature: config.temperature,
      timeoutMs: timeoutMs || config.timeoutMs,
    });
  } catch (error) {
    // anthropicClient already wraps errors in ExternalServiceError —
    // just re-throw. If anything else escapes, normalize it.
    if (error instanceof ExternalServiceError) throw error;
    throw new ExternalServiceError("anthropic", `Claude trainer request failed: ${error.message}`, {
      status: 502,
      retryable: true,
      details: { reason: error.name || "unknown" },
    });
  }

  const text = extractAnthropicTextBlocks(raw);
  if (!text) {
    throw new ExternalServiceError("anthropic", "Claude returned no text", {
      status: 502,
      retryable: true,
      details: { responseBody: raw },
    });
  }

  return {
    text,
    model: raw?.model || model || config.anthropicModel,
    responseId: raw?.id || null,
    usage: raw?.usage || null,
    provider: "anthropic",
  };
}

// ── Session bootstrap: roll a caller profile + pick a voice ─────────
//
// Called once when the trainee hits "Start practice." Generates a
// concrete prospect (age/sex/state/employment/etc.) via Claude
// tool-use, maps that to an OpenAI TTS voice slot + tone instructions
// so the prospect sounds appropriate (older male → onyx + gravelly,
// younger Hispanic woman from Texas → coral + soft Spanish-inflected,
// etc.). Optionally pre-synthesizes the prospect's opening line so
// the agent hears the prospect "answer the phone" the instant they
// say "Tax Group."
//
// The full profile is returned to the client and passed back on every
// /respond turn — keeps the server stateless while ensuring Claude
// stays in character throughout the call.

const CALLER_PROFILE_TOOL = {
  name: "submit_caller_profile",
  description:
    "Submit the rolled caller profile for this practice call. Generate a SPECIFIC, REALISTIC prospect with consistent demographics and a coherent tax-debt situation. All fields required. Be concrete (real city + state, real-sounding name, plausible employment).",
  input_schema: {
    type: "object",
    required: [
      "callerFirstName",
      "callerLastName",
      "callbackNumber",
      "age",
      "sex",
      "ethnicity",
      "state",
      "city",
      "education",
      "affluency",
      "employment",
      "spouseStatus",
      "mood",
      "leadSource",
      "difficulty",
      "tempermentRoll",
      "taxIssues",
      "painPoints",
      "openingLine",
      "voiceHints",
      "practiceMode",
      "scenarioArchetype",
    ],
    properties: {
      callerFirstName: { type: "string" },
      callerLastName: { type: "string" },
      callbackNumber: {
        type: "string",
        description: "US phone number, format like 555-867-5309",
      },
      age: { type: "integer", minimum: 22, maximum: 88 },
      sex: { type: "string", enum: ["male", "female"] },
      ethnicity: {
        type: "string",
        description:
          "e.g. 'White (non-Hispanic)', 'Black', 'Hispanic/Latino', 'Asian American', 'Native American'. Be realistic to the chosen state's demographics.",
      },
      state: { type: "string", description: "Full US state name" },
      city: { type: "string" },
      education: {
        type: "string",
        enum: [
          "did not finish high school",
          "high school",
          "some college",
          "trade school",
          "associate's",
          "bachelor's",
          "graduate degree",
        ],
      },
      affluency: {
        type: "string",
        enum: [
          "working class",
          "lower middle",
          "middle class",
          "upper middle",
          "comfortable",
        ],
      },
      employment: {
        type: "string",
        description:
          "Realistic, specific job + tenure. Common: sole proprietor, truck driver, doctor/dentist/lawyer in rural area, farmer, retired (specify pension/SS/savings), small business owner.",
      },
      spouseStatus: {
        type: "string",
        enum: [
          "single",
          "married",
          "divorced",
          "widowed",
          "separated",
          "living with partner",
        ],
      },
      mood: {
        type: "string",
        description:
          "One-line read of how they feel right now (e.g. 'exhausted and skeptical', 'anxious but hopeful', 'angry, just wants this over with', 'distracted, driving')",
      },
      leadSource: {
        type: "string",
        enum: ["MAIL", "BCD"],
        description:
          "MAIL = responding to a marketing letter about a public tax lien, doesn't know who we are. BCD = returning a call/voicemail we left, more skeptical.",
      },
      difficulty: {
        type: "string",
        enum: ["easy", "hard"],
        description:
          "Easy ≈ 50% close potential, 2-3 objections per phase, generally cooperative. Hard ≈ 25% close potential, 5-10 objections per phase, suspicious throughout.",
      },
      practiceMode: {
        type: "string",
        enum: ["inbound", "outbound"],
        description:
          "Inbound means the agent says Tax Group before the prospect speaks. Outbound means the prospect answers the call and speaks first.",
      },
      scenarioArchetype: {
        type: "string",
        description:
          "Short scenario label such as trucker, retired, small_business, payroll, divorced, farmer, or random.",
      },
      tempermentRoll: {
        type: "string",
        description:
          "Specific behavioral notes — distracted, interrupts, asks rambling questions, gives short answers, gets emotional about money, etc. Be concrete.",
      },
      taxIssues: {
        type: "array",
        minItems: 3,
        items: { type: "string" },
        description:
          "Pick AT LEAST 3 from: unfiled returns, unpaid taxes, federal tax lien, state tax lien, bank levy, wage garnishment, Social Security garnishment, collection notices, revenue officer assigned, audit, payroll tax (941), sales tax, bad bookkeeping, S-corp/LLC structure issues, gambling winnings, inheritance, lawsuit settlement, lottery winnings, recent divorce, recent death in family, recent business sale.",
      },
      painPoints: {
        type: "array",
        minItems: 1,
        items: { type: "string" },
        description:
          "What's actually keeping them up at night. At least one personal AND one tax-debt-related pain point.",
      },
      approxDebtUsd: {
        type: "integer",
        description:
          "Realistic total tax debt. Federal liens trigger at $10k+. State at $5k+. Distribute realistically: most cases $15k-$60k, some $60k-$150k, occasional $250k+.",
      },
      openingLine: {
        type: "string",
        description:
          "Exactly what the prospect says first, after the agent says 'Tax Group.' Should sound like a real person answering an unknown call: confused, suspicious, or hopeful depending on lead source + mood. 1-3 sentences. No greeting cliches like 'How may I help you'.",
      },
      voiceHints: {
        type: "object",
        required: ["accent", "speakingPace", "energy", "tone"],
        properties: {
          accent: {
            type: "string",
            description:
              "Regional accent appropriate to state + demographics. e.g. 'flat Midwestern', 'Texas drawl', 'New York', 'Boston', 'Southern (Alabama)', 'Hispanic-inflected', 'generic American'.",
          },
          speakingPace: {
            type: "string",
            enum: ["slow", "normal", "fast"],
          },
          energy: { type: "string", enum: ["low", "medium", "high"] },
          tone: {
            type: "string",
            description:
              "Emotional read for the voice (e.g. 'tired and skeptical', 'anxious quick-fire', 'gruff and impatient', 'soft and worried')",
          },
        },
      },
    },
  },
};

function buildProfilePrompt({ leadSource, difficulty, mode, scenarioArchetype }) {
  const constraints = [];
  if (leadSource) constraints.push(`Lead source MUST be: ${leadSource}.`);
  else
    constraints.push(
      "Lead source is operator-randomized: 50% MAIL, 50% BCD.",
    );
  if (difficulty) constraints.push(`Difficulty MUST be: ${difficulty}.`);
  else
    constraints.push(
      "Difficulty is operator-randomized: 60% easy, 40% hard.",
    );
  if (mode) {
    constraints.push(`Practice mode MUST be: ${mode}.`);
  } else {
    constraints.push("Practice mode is operator-randomized: inbound or outbound.");
  }
  if (scenarioArchetype) {
    constraints.push(`Scenario archetype MUST be: ${scenarioArchetype}.`);
  } else {
    constraints.push("Scenario archetype is operator-randomized across realistic tax-debt caller types.");
  }
  return [
    "Generate a single realistic caller profile for tax-resolution sales practice. Output via the submit_caller_profile tool.",
    "",
    "Constraints for this roll:",
    ...constraints,
    "",
    "Realism rules:",
    "- Demographics must be coherent (a 28-year-old retired person is wrong unless the spec explains it).",
    "- Tax issues must overlap plausibly. Self-employed people get 941/sales-tax/unfiled-returns. Truckers get unpaid-1099-income/unfiled. Recent inheritances surface a one-time large tax bill.",
    "- Geography matters: a farmer in Iowa vs. a doctor in rural Kentucky vs. a sole proprietor in NYC will sound completely different.",
    "- In inbound mode, the opening line is what the prospect says after the agent says 'Tax Group.' It should sound like a real human answering an unknown number, not a chatbot.",
    "- In outbound mode, the opening line is the prospect's first pickup response after receiving the call. Make it terse, skeptical, distracted, or confused like a real cold/warm outbound answer.",
    "- Voice hints must match the demographics (a 70-year-old retired farmer in Alabama should speak with a Southern drawl, slow pace, gruff/tired tone).",
    "- Vary the rolls — don't always default to white-male-middle-aged. Pull from the full demographic spread.",
  ].join("\n");
}

async function generateCallerProfile({
  leadSource = null,
  difficulty = null,
  mode = null,
  scenarioArchetype = null,
  model = null,
  timeoutMs = null,
} = {}) {
  if (!isAnthropicConfigured()) {
    throw new ExternalServiceError(
      "anthropic",
      "ANTHROPIC_API_KEY is missing — required for profile generation",
      { status: 500, retryable: false },
    );
  }

  const client = createAnthropicClient();
  const config = getSalesTrainerConfig();
  // Use a stronger model for profile generation than per-turn — happens
  // once per session and benefits from richer persona variety.
  const profileModel =
    model ||
    env("SALES_TRAINER_PROFILE_MODEL", "claude-sonnet-4-5") ||
    config.anthropicModel;

  const prompt = buildProfilePrompt({ leadSource, difficulty, mode, scenarioArchetype });

  const raw = await client.createMessage({
    system:
      "You generate realistic caller profiles for a tax-resolution sales-training simulation. Output strictly via the submit_caller_profile tool. Be concrete, be varied, be plausible.",
    messages: [{ role: "user", content: prompt }],
    model: profileModel,
    maxTokens: 2048,
    temperature: 0.95, // high temp for persona variety
    tools: [CALLER_PROFILE_TOOL],
    toolChoice: { type: "tool", name: "submit_caller_profile" },
    timeoutMs: timeoutMs || config.timeoutMs,
  });

  // Pull the tool-use block out of Claude's response.
  const content = Array.isArray(raw?.content) ? raw.content : [];
  const toolUse = content.find(
    (block) =>
      block && block.type === "tool_use" && block.name === "submit_caller_profile",
  );
  if (!toolUse || !toolUse.input) {
    throw new ExternalServiceError(
      "anthropic",
      "Caller-profile generator did not return a tool_use block",
      {
        status: 502,
        retryable: true,
        details: { responseBody: raw },
      },
    );
  }
  return {
    profile: {
      ...toolUse.input,
      practiceMode: mode || toolUse.input.practiceMode || "inbound",
      scenarioArchetype: scenarioArchetype || toolUse.input.scenarioArchetype || "random",
    },
    model: raw?.model || profileModel,
    usage: raw?.usage || null,
  };
}

// ── Caller Playbook — Sonnet writes a "story map" for Haiku ─────────
//
// Why this exists:
//   The live-turn model (Haiku 4.5) is fast but drifts on long
//   conversations. To keep it on-narrative without paying Sonnet
//   latency per turn, we have SONNET pre-generate a structured
//   playbook once at session start — an ordered objection queue,
//   hidden facts gated by trigger conditions, verbatim "tell" lines
//   for key moments, mood/trust arc, and phase-by-phase guidance.
//
//   Haiku reads the playbook on every turn (cached in the system
//   prompt), so it always has the next move pre-computed. It's the
//   classic planner-executor pattern: deep thinker writes the script,
//   fast executor runs it. Eliminates drift because Haiku is never
//   improvising the storyline — only the surface dialogue.
//
// Cost trade-off:
//   - Sonnet call at session start: ~3-5s, ~$0.02 once per session
//   - Saves ~1-2s per live turn (no Sonnet on hot path)
//   - Reduces character-drift recovery turns
//
// The playbook is treated as IMMUTABLE within a session. Haiku
// references it but does not regenerate it.

const CALLER_PLAYBOOK_TOOL = {
  name: "submit_caller_playbook",
  description:
    "Pre-generate a complete behavior playbook for the locked caller profile. This will be handed to the live-turn model (Haiku) as a story map so it stays on-narrative across the call.",
  input_schema: {
    type: "object",
    required: [
      "callerSummary",
      "objectionQueue",
      "hiddenFacts",
      "tellLines",
      "trustArc",
      "phaseGuidance",
    ],
    properties: {
      callerSummary: {
        type: "string",
        description:
          "ONE compact sentence Haiku will read on every turn to re-anchor identity. e.g. 'Mary Holcomb, 67, widowed Iowa farmer, anxious + skeptical from a 2022 bad-firm experience, fixed-income.' Under 200 chars.",
      },
      objectionQueue: {
        type: "array",
        description:
          "Ordered list of objections this character WOULD raise during the call. The live model uses these as voice/style samples when the trigger matches — they show HOW this character phrases pushback in their natural register. The live model still needs to respond to whatever the agent actually said; these are reference, not script. 4-8 entries for easy mode, 8-14 for hard.",
        minItems: 3,
        maxItems: 16,
        items: {
          type: "object",
          required: ["phase", "trigger", "verbatim", "underlyingConcern"],
          properties: {
            phase: {
              type: "integer",
              enum: [1, 2, 3],
              description: "Which phase this objection naturally surfaces in",
            },
            trigger: {
              type: "string",
              description:
                "Plain-English condition: 'agent asks for SSN', 'agent quotes price > $2000', 'agent asks about household finances', 'silence > 3s', etc.",
            },
            verbatim: {
              type: "string",
              description:
                "A SAMPLE of how this character would phrase the objection — showing vocabulary, hedge words, register, sentence rhythm. The live model uses this as a voice reference when responding to a trigger event, but actually responds to what the agent said. 1-2 sentences max.",
            },
            underlyingConcern: {
              type: "string",
              description:
                "What the caller ACTUALLY wants to know. The live model uses this to recognize what a 'strong handling' response by the agent would address — for trust delta scoring.",
            },
          },
        },
      },
      hiddenFacts: {
        type: "array",
        description:
          "Truths about the character that they KNOW but won't volunteer. The live model surfaces these only when the agent asks a question matching the trigger. 1 entry for easy, 2-3 for hard.",
        minItems: 1,
        maxItems: 5,
        items: {
          type: "object",
          required: ["fact", "revealsWhen", "revealLine"],
          properties: {
            fact: {
              type: "string",
              description: "The hidden truth, in plain language. This is what the character knows internally.",
            },
            revealsWhen: {
              type: "string",
              description:
                "Trigger condition: 'agent asks about retirement distributions', 'agent asks about all years filed', 'agent asks who else lives in the household'.",
            },
            revealLine: {
              type: "string",
              description:
                "A SAMPLE of how this character would surface this fact when finally asked — showing their voice, hedging, embarrassment, or matter-of-fact delivery. The live model uses this as a tone reference; it generates a response that actually engages with the agent's question while revealing the fact.",
            },
          },
        },
      },
      tellLines: {
        type: "object",
        description:
          "Emotional-beat reference lines for KEY MOMENTS. The live model uses these as tone/register samples — showing how this character would deliver each beat — but generates a response that engages with what the agent actually said in the triggering moment.",
        required: [
          "earnedVulnerability",
          "closeAccept",
          "closeDecline",
          "hangup",
        ],
        properties: {
          earnedVulnerability: {
            type: "string",
            description:
              "Sample of how this character would say their 'true thing' when trust crosses 7 and they drop the act. Fires AT MOST ONCE per call, and only in response to an agent move that genuinely earned it.",
          },
          closeAccept: {
            type: "string",
            description:
              "Sample of how this character would phrase agreement to engage. Should sound like THIS caller, not a generic 'yes' — e.g. 'Okay. Alright. What do I need to give you?' Used as tone reference when close conditions are met.",
          },
          closeDecline: {
            type: "string",
            description:
              "Sample of a soft decline / 'let me think' exit in this character's voice — used as tone reference when the close attempt fails or close conditions aren't met.",
          },
          hangup: {
            type: "string",
            description:
              "Sample of how this character would terminate the call — voice + register for a catastrophic-mistake or health=0 exit.",
          },
        },
      },
      trustArc: {
        type: "object",
        required: ["startTrust", "minTrust", "maxTrust", "triggers"],
        properties: {
          startTrust: { type: "integer", minimum: 0, maximum: 10 },
          minTrust: {
            type: "integer",
            minimum: 0,
            maximum: 10,
            description: "Floor — trust never drops below this value during the call.",
          },
          maxTrust: {
            type: "integer",
            minimum: 0,
            maximum: 10,
            description:
              "Ceiling — even perfect handling can't push trust past this. Hard mode + Skeptic archetypes cap lower than easy + Trusting.",
          },
          triggers: {
            type: "array",
            description: "Trust-shifting events specific to THIS caller's psychology.",
            minItems: 3,
            maxItems: 10,
            items: {
              type: "object",
              required: ["event", "trustDelta"],
              properties: {
                event: {
                  type: "string",
                  description: "Observable agent behavior. 'agent confirms not IRS', 'agent rushes for SSN', 'agent acknowledges I-worked-my-whole-life feeling'",
                },
                trustDelta: {
                  type: "integer",
                  minimum: -5,
                  maximum: 5,
                  description: "How much trust shifts when this triggers. Negative = damage, positive = repair.",
                },
              },
            },
          },
        },
      },
      phaseGuidance: {
        type: "object",
        required: ["phase1", "phase2", "phase3"],
        description:
          "Per-phase narrative direction for the live-turn model. 1-2 sentences each. What should the prospect's energy be? What should they volunteer? What should they hold back?",
        properties: {
          phase1: { type: "string" },
          phase2: { type: "string" },
          phase3: { type: "string" },
        },
      },
      uncloseableReason: {
        type: "string",
        description:
          "Hard mode only: if this caller is by-design uncloseable on this call, what's the reason? ('Burned twice already — needs to talk to her daughter before any decision.') Leave empty for easy mode and closeable hard calls.",
      },
      optIn: {
        type: "object",
        description:
          "OUTBOUND ONLY: the opt-in receipt this character has. Outbound prospects are opted-in data (Facebook lead ad / Google ad / landing page / partner site). They filled out a form and consented to a callback — they may not REMEMBER doing it, but they DID. The live model uses this to decide when the prospect's memory of the opt-in should surface (when the agent references source + timing + a specific detail). For inbound mode, leave this object out or empty.",
        properties: {
          source: {
            type: "string",
            description: "Where they opted in: 'Facebook lead ad', 'Google search ad', 'TAG landing page', 'tax-debt quiz partner site', etc.",
          },
          approximateDate: {
            type: "string",
            description: "Rough date of opt-in: '2 days ago', 'last week', 'about 3 weeks ago'. Live model uses this to time the recognition arc.",
          },
          formContext: {
            type: "string",
            description: "What the form captured beyond contact info: 'debt range ~$30k, IRS issue', 'state lien concern, California', 'unfiled returns 3+ years'. Used by the agent's reference-the-opt-in move to jog recognition.",
          },
          remembersOptIn: {
            type: "boolean",
            description: "Does this character REMEMBER opting in at pickup? 60% should be false (forgot), 40% should be true (remembers vaguely). The recognition arc still fires for both — but those who forgot need a bigger lift from the agent.",
          },
          recognitionLine: {
            type: "string",
            description: "VOICE SAMPLE of how this character would say 'oh, right, I think I did fill something out' when the agent surfaces the opt-in correctly. e.g. 'Oh... was that the Facebook one? Yeah, I guess I did fill something out.' Used by the live model when the agent passes the gate competently.",
          },
        },
      },
    },
  },
};

function buildPlaybookPrompt({ profile }) {
  const safeProfile = profile && typeof profile === "object" ? profile : {};
  return [
    "You are pre-generating a behavior playbook for a tax-resolution caller. The live conversation will be driven by a faster model (Haiku) that uses your playbook as REFERENCE MATERIAL on every turn — not as a script to recite.",
    "",
    "Important framing: the live model still has to read the agent's actual transcribed turn and respond to what was specifically said. Your playbook gives that model: (a) the character's identity and psychology, (b) what objections are likely to surface and in what voice, (c) hidden truths the character knows but won't volunteer, (d) emotional-beat tone samples for key moments, (e) trust trajectory, (f) phase-by-phase posture. The live model uses all of this as CONTEXT to generate authentic in-character responses to whatever the agent actually says.",
    "",
    "Think of the verbatim lines you write as VOICE SAMPLES — they show HOW this character phrases things (vocabulary, hedge words, register, sentence rhythm). The live model will match the style/length/register when responding to a trigger event, but the actual response engages with the agent's specific words.",
    "",
    "Output via the submit_caller_playbook tool.",
    "",
    "Locked caller profile (use these traits EXACTLY — do not invent new ones):",
    JSON.stringify(safeProfile, null, 2),
    "",
    "What the playbook needs to provide:",
    "- callerSummary: a compact identity anchor the live model re-reads each turn",
    "- objectionQueue: voice samples of how this character pushes back, tagged by phase + trigger condition",
    "- hiddenFacts: truths the character knows, gated by what discovery question would naturally surface them",
    "- tellLines: tone samples for key emotional beats (earned vulnerability, close accept, close decline, hangup)",
    "- trustArc: starting trust, floor, ceiling, and event-based deltas tied to specific agent behaviors",
    "- phaseGuidance: one-sentence directive for each phase's energy and what to volunteer vs. hold back",
    "",
    "Writing rules:",
    "- Every voice sample must SOUND like THIS caller — match the locked profile's vocabulary, register, mood, accent hints, education level. A grade-school-educated trucker doesn't say 'I appreciate the candor.' These samples teach the live model the character's verbal fingerprint.",
    "- Voice sample length: keep each verbatim/sample to 1-2 short sentences. Phone-call cadence, not paragraphs.",
    "- Objection count: 3-6 for easy, 8-14 for hard. Match the locked difficulty.",
    "- Hidden facts: 1 for easy, 2-3 for hard.",
    "- Trust arc realism: Skeptic archetypes start trust low (3-4), max ceiling 6-7. Trusting archetypes can start at 6, max 9. Easy mode favors recoverable trust (small deltas); hard mode rewards permanent cliffs (-3 from one wrong move).",
    "- The earnedVulnerability sample should evoke the one true thing this caller would say if trust crossed 7 — read painPoints and voiceHints to pick what that is.",
    "- The closeAccept sample should match the caller's energy — not a generic 'sounds good.' Defeated callers might say 'Yeah... okay.' Bargainers might say 'Alright, fine. Send it over.'",
    "",
    "If difficulty is HARD and the caller archetype is naturally uncloseable on a first call (Skeptic who was burned, Defeated already-bankruptcy, fixed-income with no resources), set uncloseableReason. Leave empty for easy mode — easy mode is designed to be winnable.",
    "",
    "OUTBOUND-SPECIFIC: if profile.practiceMode === 'outbound', the prospect is OPTED-IN data. They filled out an online form (Facebook lead ad / Google ad / TAG landing page / partner tax-debt quiz) and consented to a callback. The firm has the receipt. Populate the `optIn` field:",
    "  - source: which channel they came from",
    "  - approximateDate: when they opted in (within last 0-30 days)",
    "  - formContext: what the form captured beyond contact info (debt range, type of issue, state) — this is what the AGENT will use to jog recognition",
    "  - remembersOptIn: roll 40% true, 60% false — but EVEN WHEN FALSE, the prospect can be brought back to recognition when the agent references source + timing + a detail correctly",
    "  - recognitionLine: a voice sample of how this character would say 'oh, right, I think I did do that' once the agent surfaces the opt-in well",
    "Outbound prospects NEVER say 'you've got the wrong person' as a hard rejection — the data is real. They can say 'I don't remember' but the opt-in IS true. The training point is: agents earn recognition by surfacing context that matches what the prospect was thinking when they filled the form.",
    "For INBOUND mode (caller dialed in from a marketing letter), leave optIn off or empty — there's no opt-in receipt to track.",
  ].join("\n");
}

async function generateCallerPlaybook({
  profile,
  model = null,
  timeoutMs = null,
} = {}) {
  if (!profile || typeof profile !== "object") {
    throw new ValidationError("profile is required for playbook generation");
  }
  if (!isAnthropicConfigured()) {
    throw new ExternalServiceError(
      "anthropic",
      "ANTHROPIC_API_KEY is missing — required for playbook generation",
      { status: 500, retryable: false },
    );
  }

  const client = createAnthropicClient();
  const config = getSalesTrainerConfig();
  // Playbook generation uses the heavier model (Sonnet by default) since
  // it runs once per session and benefits from the deeper planning.
  const playbookModel =
    model ||
    env("SALES_TRAINER_PLAYBOOK_MODEL", "claude-sonnet-4-6") ||
    config.coachModel ||
    config.anthropicModel;

  const prompt = buildPlaybookPrompt({ profile });

  const raw = await client.createMessage({
    system:
      "You are the story architect for a tax-resolution sales-training simulator. You write playbooks that a faster live-turn model executes against. Output strictly via the submit_caller_playbook tool. Be concrete, write verbatim lines in the caller's voice, and structure the call so it's coherent and dramatic.",
    messages: [{ role: "user", content: prompt }],
    model: playbookModel,
    maxTokens: 4096,
    temperature: 0.7,
    tools: [CALLER_PLAYBOOK_TOOL],
    toolChoice: { type: "tool", name: "submit_caller_playbook" },
    timeoutMs: timeoutMs || config.timeoutMs,
  });

  const content = Array.isArray(raw?.content) ? raw.content : [];
  const toolUse = content.find(
    (block) => block && block.type === "tool_use" && block.name === "submit_caller_playbook",
  );
  if (!toolUse || !toolUse.input) {
    throw new ExternalServiceError(
      "anthropic",
      "Playbook generator did not return a tool_use block",
      { status: 502, retryable: true, details: { responseBody: raw } },
    );
  }
  return {
    playbook: toolUse.input,
    model: raw?.model || playbookModel,
    usage: raw?.usage || null,
  };
}

// ── Voice picker — profile → OpenAI TTS voice + instructions ───────
//
// Maps demographic + voice-hint fields onto:
//   - voice: the OpenAI TTS voice slot (onyx/ash/echo/nova/sage/coral...)
//   - persona: a coarse persona label (matched against codex's
//     SALES_TRAINER_TTS_PERSONAS catalog when available, else "neutral")
//   - extraInstructions: a free-text steering string passed to gpt-4o-mini-tts
//     describing accent, pace, energy, and emotional tone
//
// The OpenAI voices map roughly as:
//   onyx   → mature/older male, deep, gruff
//   ash    → middle-aged male, calm/professional
//   echo   → younger-to-middle male, neutral
//   nova   → mature/older female, warm
//   sage   → middle-aged female, calm
//   coral  → younger female, warm/friendly
//   shimmer → younger female, lighter
// Newer voices (cedar, marin, ballad, verse) we don't have strong reads
// on yet — left out of the picker until we A/B them.

function pickTtsVoiceForProfile(profile) {
  if (!profile || typeof profile !== "object") {
    return {
      voice: "ash",
      persona: "neutral",
      extraInstructions: "Speak naturally and conversationally as if on a phone call.",
    };
  }

  const age = Number(profile.age) || 40;
  const sex = String(profile.sex || "").toLowerCase();
  let voice;
  if (sex === "male") {
    if (age >= 55) voice = "onyx";
    else if (age >= 35) voice = "ash";
    else voice = "echo";
  } else {
    if (age >= 55) voice = "nova";
    else if (age >= 35) voice = "sage";
    else voice = "coral";
  }

  const hints = profile.voiceHints || {};
  const instructionLines = [];
  if (hints.accent) instructionLines.push(`Accent: ${hints.accent}.`);
  // DELIBERATELY NOT passing `speakingPace` to TTS — it caused dragging
  // delivery that read as nightmare-fuel for the user. Pacing is now
  // governed by the `speed` parameter and the persona
  // notes, both of which bias toward natural phone-call cadence.
  if (hints.energy) instructionLines.push(`Energy: ${hints.energy}.`);
  if (hints.tone) instructionLines.push(`Tone: ${hints.tone}.`);
  if (profile.mood) instructionLines.push(`Mood for this call: ${profile.mood}.`);
  instructionLines.push(
    "Speak BRISKLY — at real phone-conversation pace, faster than audiobook narration. Sound like a real person, not an announcer or narrator. Do NOT stretch out words. Do NOT insert dramatic pauses. No 'slow build,' no 'careful enunciation.' Get through the words.",
  );

  // Map to a persona slot if codex's persona catalog defines a fitting
  // one. Otherwise default to "neutral" — extraInstructions carries
  // the per-call detail anyway.
  const persona = pickPersonaSlot({ sex, age, mood: profile.mood });

  return {
    voice,
    persona,
    extraInstructions: instructionLines.join(" "),
  };
}

function pickPersonaSlot({ sex, age }) {
  const candidates = Array.isArray(SALES_TRAINER_TTS_PERSONAS)
    ? SALES_TRAINER_TTS_PERSONAS
    : [];
  if (candidates.length === 0) return null;
  const ageBucket = age >= 55 ? "older" : age >= 35 ? "mid" : "young";
  const target = `${sex}-${ageBucket}`;
  const match = candidates.find(
    (p) =>
      typeof p === "string" &&
      p.toLowerCase().includes(sex) &&
      p.toLowerCase().includes(ageBucket),
  );
  if (match) return match;
  return target;
}

// ── Full session-start orchestrator ────────────────────────────────
//
// One call that:
//   1. Rolls a caller profile (Claude tool-use)
//   2. Maps that profile to a TTS voice + instructions
//   3. Optionally pre-synthesizes the opening line so the client can
//      play it the moment the agent says "Tax Group."
//
// Returns the full session bundle:
//   {
//     sessionId,
//     profile,         // full structured caller profile
//     voice,           // { voice, persona, extraInstructions }
//     openingLine,     // the prospect's first utterance (text)
//     openingAudio?,   // { audioBase64, contentType, durationMs } if includeAudio !== false and TTS configured
//     models,          // which models were used for profile + (potentially) audio
//   }
//
// The client stores `profile` and includes it on every /respond turn
// so Claude stays in character.

async function startSalesTrainerSession({
  leadSource = null,
  difficulty = null,
  mode = null,
  scenarioArchetype = null,
  includeAudio = true,
  audio = {},
  user = null,
} = {}) {
  // 1. Generate profile
  const { profile, model: profileModel, usage: profileUsage } =
    await generateCallerProfile({ leadSource, difficulty, mode, scenarioArchetype });

  // 2. Pick voice + generate playbook in parallel.
  //    - Voice picker is local/fast (no API call)
  //    - Playbook generation is a Sonnet call that runs alongside the
  //      opening-audio TTS synth in step 3 (separate provider, no
  //      shared bottleneck). Total wall-clock cost is the slower of the
  //      two, not the sum.
  //    Playbook failure is non-fatal — session still works, Haiku just
  //    doesn't have the story map. We log it and continue.
  const voice = pickTtsVoiceForProfile(profile);
  const playbookPromise = (async () => {
    try {
      return await generateCallerPlaybook({ profile });
    } catch (err) {
      return {
        playbook: null,
        error: { message: err?.message || String(err), status: err?.status || null },
      };
    }
  })();

  // 3. Pre-synth opening line audio (best-effort)
  let openingAudio = null;
  let openingAudioError = null;
  const wantAudio = includeAudio !== false;
  if (wantAudio && isOpenAiConfigured() && profile.openingLine) {
    try {
      const audioResult = await synthesizeSalesTrainerSpeech({
        text: profile.openingLine,
        // Operator overrides win, otherwise use what we picked from the profile.
        voice: audio?.voice || voice.voice,
        persona: audio?.persona || voice.persona,
        extraInstructions:
          audio?.extraInstructions ||
          audio?.voiceNotes ||
          voice.extraInstructions,
        responseFormat: audio?.responseFormat || audio?.format || undefined,
        speed: audio?.speed,
        emotion: audio?.emotion,
        pacing: audio?.pacing,
        intensity: audio?.intensity,
      });
      openingAudio = audioResult;
    } catch (audioErr) {
      // Don't fail session start if TTS hiccups — UI can re-request audio
      // from the regular per-turn flow.
      openingAudioError = {
        message: audioErr?.message || String(audioErr),
        status: audioErr?.status || null,
      };
    }
  }

  const sessionId = crypto.randomUUID
    ? crypto.randomUUID()
    : `sess-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  // Persist opening prospect audio as turn 0 so the training session
  // folder reflects what the rep actually heard before they spoke.
  // Same best-effort policy as the per-turn recording in runSalesTrainerTurn.
  let openingRecording = null;
  if (openingAudio?.audioBase64) {
    try {
      const openingBuffer = Buffer.from(openingAudio.audioBase64, "base64");
      const openingExt = sanitizeAudioExt(openingAudio.format) || "mp3";
      const written = await writeRecordingBuffer({
        kind: KIND_TRAINING,
        buffer: openingBuffer,
        sessionId,
        turnNumber: 0,
        side: "prospect",
        ext: openingExt,
        mimeType: openingAudio.mimeType || `audio/${openingExt}`,
      });
      openingRecording = { localPath: written.localPath, sha256: written.sha256, byteLength: written.byteLength };
      if (isDriveArchiveConfigured(KIND_TRAINING)) {
        const archive = await archiveRecordingSafe({
          localPath: written.localPath,
          kind: KIND_TRAINING,
          sessionId,
          turnNumber: 0,
          side: "prospect",
          mimeType: openingAudio.mimeType || `audio/${openingExt}`,
        });
        if (archive.ok) {
          openingRecording.driveFileId = archive.manifest?.driveFileId || null;
        }
      }
      await appendTrainingSessionEntry({
        sessionId,
        entry: {
          turnNumber: 0,
          repText: null,
          prospectText: profile.openingLine,
          prospectLocalPath: written.localPath,
          prospectDriveFileId: openingRecording.driveFileId || null,
          voice: openingAudio.voice || null,
          stage: "opening",
        },
      });
    } catch (err) {
      openingRecording = { error: err?.message || String(err) };
    }
  }

  // Same autoplay envelope as /turn for consistency. The UI grabs
  // `result.playback.dataUrl`, drops it in `<audio>`, and the prospect
  // pickup plays the moment the call starts. For inbound mode the UI
  // holds this audio until the rep triggers ("Tax Group"); for outbound
  // it autoplays on session-load (the rep dialed the prospect — the
  // prospect speaks first by definition).
  const openingPlayback = openingAudio?.audioBase64
    ? {
        autoplay: true,
        mimeType: openingAudio.mimeType,
        format: openingAudio.format,
        voice: openingAudio.voice,
        audioBase64: openingAudio.audioBase64,
        dataUrl: `data:${openingAudio.mimeType};base64,${openingAudio.audioBase64}`,
      }
    : null;

  // Collect the playbook now that we're past the parallel work. If
  // generation failed (network blip, schema validation), we proceed
  // without it — the live model loses the story map but the session
  // still runs on profile + v2 prompt alone.
  const playbookResult = await playbookPromise;
  const playbook = playbookResult?.playbook || null;
  const playbookError = playbookResult?.error || null;
  const playbookModel = playbookResult?.model || null;

  return {
    sessionId,
    profile,
    playbook,
    playbookError,
    voice,
    mode: profile.practiceMode || mode || "inbound",
    scenarioArchetype: profile.scenarioArchetype || scenarioArchetype || "random",
    openingLine: profile.openingLine,
    openingAudio,
    openingAudioError,
    openingPlayback,
    openingRecording,
    models: {
      profile: profileModel,
      playbook: playbookModel,
    },
    usage: {
      profile: profileUsage,
    },
    trainee: user?.email || null,
  };
}

const COACHING_PANEL_TOOL = {
  name: "submit_call_coaching_panel",
  description:
    "Submit compact UI-only coaching for the trainee. Do not roleplay as the caller and do not write the caller's chat response.",
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
    ],
    properties: {
      phase: {
        type: "object",
        required: ["key", "label", "reason"],
        properties: {
          key: { type: "string", enum: COACHING_PHASE_KEYS },
          label: { type: "string" },
          reason: { type: "string" },
        },
      },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      oneSentenceFocus: {
        type: "string",
        description: "The main coaching focus for the trainee right now.",
      },
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
      nextBestQuestion: {
        type: "string",
        description: "One concise question the trainee could ask next.",
      },
    },
  },
};

function clampStringList(input, maxItems = 4, maxChars = 160) {
  const list = Array.isArray(input) ? input : [];
  return list
    .map((item) => cleanText(item, maxChars))
    .filter(Boolean)
    .slice(0, maxItems);
}

function normalizeCoachingPanel(input = {}) {
  const phaseInput = input.phase && typeof input.phase === "object" ? input.phase : {};
  const key = COACHING_PHASE_KEYS.includes(String(phaseInput.key || "").toLowerCase())
    ? String(phaseInput.key).toLowerCase()
    : "discovery";
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
  };
}

function normalizeSessionId(value) {
  const sessionId = String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._:-]/g, "")
    .slice(0, 120);
  if (!sessionId) {
    throw new ValidationError("sessionId is required");
  }
  return sessionId;
}

function pruneSalesTrainerUiState(now = Date.now()) {
  for (const [sessionId, state] of salesTrainerUiState.entries()) {
    const updated = Date.parse(state?.updatedAt || "");
    if (!Number.isFinite(updated) || now - updated > SALES_TRAINER_UI_STATE_TTL_MS) {
      salesTrainerUiState.delete(sessionId);
    }
  }
}

function publishSalesTrainerUiState(sessionId, input = {}, actor = {}) {
  const normalizedSessionId = normalizeSessionId(sessionId);
  pruneSalesTrainerUiState();
  const existing = salesTrainerUiState.get(normalizedSessionId) || {};
  const source = input && typeof input === "object" ? input : {};
  const now = new Date().toISOString();
  const coachInput =
    source.coach && typeof source.coach === "object" ? source.coach : source;
  const state = {
    sessionId: normalizedSessionId,
    version: Number(existing.version || 0) + 1,
    updatedAt: now,
    source: cleanText(source.source || actor.source || "claude-brain", 80),
    actor: cleanText(actor.email || actor.id || "internal-service", 120),
    coach: normalizeCoachingPanel(coachInput),
    suggestedDraft: cleanText(source.suggestedDraft || source.draft || "", 1_000),
    metadata:
      source.metadata && typeof source.metadata === "object"
        ? JSON.parse(JSON.stringify(source.metadata))
        : null,
  };
  salesTrainerUiState.set(normalizedSessionId, state);
  return state;
}

function getSalesTrainerUiState(sessionId, { sinceVersion = null } = {}) {
  const normalizedSessionId = normalizeSessionId(sessionId);
  pruneSalesTrainerUiState();
  const state = salesTrainerUiState.get(normalizedSessionId) || null;
  if (!state) return null;
  const requestedVersion = Number(sinceVersion);
  if (Number.isFinite(requestedVersion) && requestedVersion >= Number(state.version || 0)) {
    return null;
  }
  return state;
}

function buildCoachingTranscript(messages) {
  const normalized = normalizeMessages(messages);
  return normalized
    .map((message) => {
      const speaker = message.role === "assistant" ? "Prospect" : "Trainee";
      return `${speaker}: ${message.content}`;
    })
    .join("\n");
}

function buildCoachingPrompt({ messages, profile, scenario, previousPhase } = {}) {
  const transcript = buildCoachingTranscript(messages);
  if (!transcript) {
    throw new ValidationError("At least one trainer message is required for coaching");
  }
  const profileText = profile && typeof profile === "object"
    ? cleanText(JSON.stringify(profile), 6_000)
    : "No caller profile supplied.";
  return [
    "Analyze this live tax-resolution sales-practice call for a UI coaching panel only.",
    "Do not write a prospect response. Do not include coaching inside the roleplay chat.",
    "Classify the current call phase and give short tactical guidance the UI can display beside the chat.",
    "Keep guidance sales-process oriented: discovery, pain, qualification, solution framing, objection handling, or closing.",
    "Avoid tax/legal advice and avoid over-coaching. Prefer practical next moves.",
    "",
    `Scenario: ${cleanText(scenario || "Tax-resolution roleplay", 400)}`,
    `Previous phase: ${cleanText(previousPhase || "unknown", 80) || "unknown"}`,
    `Caller profile: ${profileText}`,
    "",
    "Transcript:",
    transcript,
  ].join("\n");
}

async function callAnthropicCoachingPanel({ prompt, model, timeoutMs }) {
  const config = getSalesTrainerConfig();
  const client = createAnthropicClient();
  const raw = await client.createMessage({
    system:
      "You are a quiet live-call coach. Output strictly via submit_call_coaching_panel. Your content is for UI guidance only, never for the roleplay chat.",
    messages: [{ role: "user", content: prompt }],
    // Coach uses the heavier model by default (Sonnet) — it's a
    // side-channel UI render, not user-facing latency. Caller can
    // override per-call via `model`, else config.coachModel.
    model: model || config.coachModel || config.anthropicModel,
    maxTokens: 900,
    temperature: 0.3,
    tools: [COACHING_PANEL_TOOL],
    toolChoice: { type: "tool", name: "submit_call_coaching_panel" },
    timeoutMs: timeoutMs || config.timeoutMs,
  });
  const content = Array.isArray(raw?.content) ? raw.content : [];
  const toolUse = content.find(
    (block) =>
      block && block.type === "tool_use" && block.name === "submit_call_coaching_panel",
  );
  if (!toolUse || !toolUse.input) {
    throw new ExternalServiceError("anthropic", "Coach did not return a tool_use block", {
      status: 502,
      retryable: true,
      details: { responseBody: raw },
    });
  }
  return {
    ...normalizeCoachingPanel(toolUse.input),
    provider: "anthropic",
    model: raw?.model || model || config.anthropicModel,
    usage: raw?.usage || null,
  };
}

async function callOpenAiCoachingPanel({ prompt, model, timeoutMs }) {
  const config = getSalesTrainerConfig();
  if (!config.apiKey) {
    throw new ExternalServiceError("openai", "OPENAI_API_KEY is missing", {
      status: 500,
      retryable: false,
    });
  }

  const effectiveTimeoutMs = Math.max(Number(timeoutMs) || config.timeoutMs, 1000);
  const abortController = new AbortController();
  const timeoutHandle = setTimeout(() => abortController.abort(), effectiveTimeoutMs);

  let response;
  try {
    response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: model || config.model,
        instructions:
          "You are a quiet live-call coach. Return only a JSON object matching this shape: { phase: { key, label, reason }, confidence, oneSentenceFocus, tips, suggestedMoves, listenFor, riskFlags, nextBestQuestion }. Your content is for UI guidance only, never for the roleplay chat.",
        input: [{ role: "user", content: prompt }],
        max_output_tokens: 900,
      }),
      signal: abortController.signal,
    });
  } catch (error) {
    clearTimeout(timeoutHandle);
    const isAbort = error?.name === "AbortError";
    throw new ExternalServiceError(
      "openai",
      isAbort
        ? `OpenAI coach request timed out after ${effectiveTimeoutMs}ms`
        : `OpenAI coach request failed: ${error.message}`,
      {
        status: isAbort ? 504 : 502,
        retryable: true,
        details: { reason: isAbort ? "timeout" : "network" },
      },
    );
  }
  clearTimeout(timeoutHandle);

  const rawText = await response.text();
  const payload = safeJsonParse(rawText) || (rawText ? (() => {
    try { return JSON.parse(rawText); } catch { return { rawText }; }
  })() : null);

  if (!response.ok) {
    throw new ExternalServiceError("openai", `OpenAI coach request failed: ${response.status}`, {
      status: response.status >= 500 || response.status === 429 ? 502 : 400,
      retryable: response.status >= 500 || response.status === 429,
      details: { responseStatus: response.status, responseBody: payload },
    });
  }

  const outputText = extractOutputText(payload);
  const parsed = safeJsonParse(outputText);
  if (!parsed) {
    throw new ExternalServiceError("openai", "OpenAI coach returned non-JSON guidance", {
      status: 502,
      retryable: true,
      details: { responseBody: payload },
    });
  }
  return {
    ...normalizeCoachingPanel(parsed),
    provider: "openai",
    model: payload?.model || model || config.model,
    usage: payload?.usage || null,
  };
}

async function runSalesTrainerCoachingPanel({
  messages,
  profile = null,
  scenario = "",
  previousPhase = "",
  provider = null,
  model = null,
  timeoutMs = null,
} = {}) {
  const prompt = buildCoachingPrompt({ messages, profile, scenario, previousPhase });
  const config = getSalesTrainerConfig();
  const effectiveProvider = normalizeProvider(provider || config.provider);

  if (effectiveProvider === "anthropic" && isAnthropicConfigured()) {
    return callAnthropicCoachingPanel({ prompt, model, timeoutMs });
  }
  if (isOpenAiConfigured()) {
    return callOpenAiCoachingPanel({ prompt, model, timeoutMs });
  }
  throw new ExternalServiceError("trainer-coach", "No configured provider for trainer coaching", {
    status: 500,
    retryable: false,
  });
}

// ── Coaching narrator ─────────────────────────────────────────────
//
// When the live model emits a UI_SCORECARD payload at end of call,
// the on-protocol response in chat is just "Your scorecard is in
// your panel" — which TTS reads back robotically. That's not how a
// real coach delivers a debrief.
//
// This narrator takes the scorecard structure and synthesizes a
// natural spoken coaching summary: 3-5 sentences, conversational
// tempo, the voice of a calm direct coach who just sat through the
// call with you. The JSON still goes to the UI side panel for visual
// review — the narrator's output is what the rep HEARS.
//
// Model: Opus by default per user request, env-overridable. This
// fires ONCE per session at end of call, so latency is acceptable.

const COACHING_NARRATOR_SYSTEM_PROMPT = `You are a calm, direct, experienced sales coach who just sat through a tax-resolution practice call. Your job: take the structured scorecard handed to you and turn it into a natural spoken debrief the rep will HEAR (this is going to TTS — your words become audio).

Rules:
- 3 to 5 short sentences. Phone-call cadence, not a memo.
- Speak TO the rep, second person. "You..." not "the agent..."
- Lead with what actually happened. Skip the score number — they can see it.
- Surface the ONE biggest thing to fix and ONE thing they could have said instead. Concrete words, not advice.
- End with the drill for next call, framed as a single concrete behavior.
- Honest, not cruel. If they got hammered, say so. If they did fine, say that too.
- NO meta. NO stage directions. NO references to "the scorecard" or "the JSON" or "the playbook." Just talk like a coach reviewing the call.
- NO markup. No asterisks, no parentheses for tone, no brackets. The TTS reads everything verbatim.

Examples of what good sounds like:

Bad (reads the structure): "Your overall score is zero. You had ten mistakes. The termination reason was harassment after removal."

Good (talks to the rep): "That call was lost before you got to discovery. The big problem was quoting a million dollars and then a dollar with no scope behind it — that's where she stopped trusting you. Next time, before you say any number, name three things the fee covers. Just three. Then the number. Try it on the next call."

Bad (lists patterns generically): "Pattern: pitching before diagnosing. Pattern: filling silence with pitch."

Good (names the moment): "You opened with the pitch instead of asking what brought her in — that's where the call started slipping. Try this on the next one: your first move is a question, not an answer."

Your output is ONLY the spoken coaching text. No JSON, no labels, no preamble.`;

async function generateCoachingNarration({
  scorecard,
  profile = null,
  model = null,
  timeoutMs = null,
} = {}) {
  if (!scorecard || typeof scorecard !== "object") {
    throw new ValidationError("scorecard payload is required for narration");
  }
  if (!isAnthropicConfigured()) {
    throw new ExternalServiceError(
      "anthropic",
      "ANTHROPIC_API_KEY is missing — required for coaching narration",
      { status: 500, retryable: false },
    );
  }

  const client = createAnthropicClient();
  const config = getSalesTrainerConfig();
  // Default to Opus for richer coaching synthesis. Env override drops
  // to Sonnet or Haiku for cost-sensitive deployments.
  const narratorModel =
    model ||
    env("SALES_TRAINER_COACH_NARRATOR_MODEL", "claude-opus-4-6") ||
    config.coachModel ||
    config.anthropicModel;

  // Compact the scorecard into a short JSON for the narrator prompt.
  // We don't want to send the entire structure if it's huge — keep
  // the load-bearing fields and trim verbose mistake-log entries.
  const compactScorecard = {
    outcome: scorecard?.facts?.outcome || scorecard?.outcome,
    termination_reason:
      scorecard?.facts?.termination_reason || scorecard?.termination_reason || null,
    overall_score:
      scorecard?.assessment?.overall_score ?? scorecard?.overall_score ?? null,
    mood_arc: scorecard?.assessment?.mood_arc || null,
    inflection_moment: scorecard?.assessment?.inflection_moment || null,
    weakest_overall_moment:
      scorecard?.assessment?.weakest_overall_moment ||
      scorecard?.weakest_overall_moment ||
      null,
    strongest_overall_moment:
      scorecard?.assessment?.strongest_overall_moment ||
      scorecard?.strongest_overall_moment ||
      null,
    ethical_flags:
      (scorecard?.assessment?.ethical_flags || scorecard?.ethical_flags || []).slice(0, 3),
    patterns: scorecard?.assessment?.patterns || scorecard?.patterns || [],
    drill_for_next_call:
      scorecard?.assessment?.drill_for_next_call ||
      scorecard?.drill_for_next_call ||
      null,
    final_mistakes:
      scorecard?.facts?.final_mistakes ?? scorecard?.final_mistakes ?? null,
  };

  // Optional caller context — gives the narrator a feel for who this
  // was, so the debrief can name the archetype if useful.
  const callerHint = profile
    ? `Caller was: ${profile.callerFirstName || ""} ${profile.callerLastName || ""}, ${profile.scenarioArchetype || profile.tempermentRoll || "unknown archetype"}, ${profile.practiceMode || "inbound"}.`
    : "";

  const prompt = [
    "Scorecard from the call you're about to debrief:",
    JSON.stringify(compactScorecard, null, 2),
    callerHint ? "" : null,
    callerHint || null,
    "",
    "Write the spoken debrief now. 3-5 sentences. Direct, honest, second-person. End with the drill as a concrete behavior.",
  ]
    .filter((part) => part !== null)
    .join("\n");

  const raw = await client.createMessage({
    system: COACHING_NARRATOR_SYSTEM_PROMPT,
    messages: [{ role: "user", content: prompt }],
    model: narratorModel,
    maxTokens: 400,
    temperature: 0.6,
    timeoutMs: timeoutMs || config.timeoutMs,
  });

  const text = extractAnthropicTextBlocks(raw).trim();
  if (!text) {
    throw new ExternalServiceError(
      "anthropic",
      "Coaching narrator returned empty text",
      { status: 502, retryable: true, details: { responseBody: raw } },
    );
  }
  return {
    text,
    model: raw?.model || narratorModel,
    usage: raw?.usage || null,
  };
}

// Extract the first <UI_SCORECARD>...</UI_SCORECARD> JSON payload
// from a model response. Returns the parsed object or null. Used to
// detect end-of-call so we can route the spoken text through the
// coaching narrator.
function extractScorecardPayload(text) {
  const match = String(text || "").match(/<UI_SCORECARD>\s*([\s\S]*?)\s*<\/UI_SCORECARD>/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

async function runTaxResolutionSalesTrainer({
  messages,
  mode = "auto",
  scenario = "",
  user = null,
  profile = null,
  playbook = null,
  model = null,
  maxOutputTokens = null,
  timeoutMs = null,
  provider = null,
  // "slim" (default) uses the live-turn-only prompt (~2.3k tokens).
  // "full" loads the entire v2 reference prompt (~27.5k tokens) — used
  // when the trainee or client invokes a "break character" recovery
  // turn. The full prompt re-anchors the model against the complete
  // simulator rule book in case it's drifted off-spec.
  promptVariant = "slim",
} = {}) {
  const input = buildInput({ messages, mode, scenario, user, profile, playbook });
  const config = getSalesTrainerConfig();
  const effectiveProvider = normalizeProvider(provider || config.provider);

  if (effectiveProvider === "anthropic") {
    if (!isAnthropicConfigured()) {
      // If Anthropic isn't wired but OpenAI is, gracefully fall back so
      // we don't break the route on a half-configured env.
      if (isOpenAiConfigured()) {
        return tagProvider(await callOpenAiResponses({
          input,
          model,
          maxOutputTokens,
          timeoutMs,
        }), "openai-fallback");
      }
      throw new ExternalServiceError("anthropic", "ANTHROPIC_API_KEY is missing and no fallback provider is configured", {
        status: 500,
        retryable: false,
      });
    }
    return callAnthropicMessages({ input, model, maxOutputTokens, timeoutMs, promptVariant });
  }

  // provider === "openai" (or anything that normalized to openai)
  return tagProvider(await callOpenAiResponses({
    input,
    model,
    maxOutputTokens,
    timeoutMs,
  }), "openai");
}

function tagProvider(result, provider) {
  if (!result || typeof result !== "object") return result;
  return { ...result, provider };
}

// One round-trip = one voice turn. The client uploads mic audio plus the
// running message history + immutable caller profile; the server runs
// Whisper → Claude → TTS sequentially and returns the bundle.
//
// Why one orchestrator instead of three client calls:
//   - latency: three HTTPS round-trips over a residential uplink cost
//     ~400-700ms of wall-clock time the user just hears as silence
//   - consistency: profile/messages can't drift between calls
//   - errors: a single error envelope is easier for the UI to render
//   - audio: we already have the synthesized prospect audio in memory,
//     no reason to re-stage it
//
// If `audioBuffer` is omitted, the caller is using text input and we
// skip Whisper. If `includeAudio` is false, we skip TTS. Both knobs let
// the same route serve the typed-fallback path without branching in the
// UI layer.
async function runSalesTrainerTurn({
  audioBuffer = null,
  audioMimeType = "audio/webm",
  audioFilename = "trainer-mic.webm",
  textInput = "",
  messages = [],
  profile = null,
  // Playbook is the Sonnet-generated story map (objection queue,
  // hidden facts, tell lines, trust arc, phase guidance). The client
  // passes it back on every turn so Haiku has the same script the
  // session was built around. Optional — if missing, Haiku improvises.
  playbook = null,
  mode = "auto",
  scenario = "",
  user = null,
  provider = null,
  model = null,
  maxOutputTokens = null,
  includeAudio = true,
  audio = {},
  sttPrompt = "",
  sttLanguage = null,
  // "slim" (default) loads the ~2.3k-token live-turn prompt.
  // "full" loads the ~27.5k-token v2 prompt — pass when the trainee
  // hits the "break character" recovery button so the model gets the
  // full simulator rulebook back for one turn.
  promptVariant = "slim",
  // Recording controls — default ON per policy decided 2026-05-13.
  // Caller must pass sessionId (matches startSalesTrainerSession's id)
  // and turnNumber (1-indexed) to enable persistence. If either is
  // missing we silently skip recording so the function stays usable
  // for ad-hoc/test calls.
  recordTurn = true,
  sessionId = null,
  turnNumber = null,
  archiveToDrive = true,
} = {}) {
  const turnStartedAt = Date.now();
  const shouldRecord = recordTurn !== false && Boolean(sessionId) && Number.isFinite(Number(turnNumber));

  // --- 1. STT (skipped if textInput supplied) ---
  let transcript = null;
  let sttError = null;
  let userText = String(textInput || "").trim();
  if (!userText && audioBuffer) {
    try {
      // Build STT context from the previous assistant turn so Whisper
      // has conversational continuity. The domain primer is added
      // automatically inside transcribeSalesTrainerAudio — what we add
      // here is the "what was just said to you" hint, which helps when
      // the rep's first words echo or respond to the prospect's last
      // line (acronyms, names, dollar amounts).
      const priorAssistant = Array.isArray(messages)
        ? [...messages].reverse().find((m) => m?.role === "assistant")
        : null;
      const contextHint = sttPrompt
        || (priorAssistant?.content ? stripTrainerUiTags(priorAssistant.content) : "");
      transcript = await transcribeSalesTrainerAudio({
        buffer: audioBuffer,
        mimeType: audioMimeType,
        filename: audioFilename,
        prompt: contextHint,
        language: sttLanguage,
      });
      userText = String(transcript.text || "").trim();
    } catch (error) {
      // STT failure is fatal for the turn — we have nothing to feed Claude.
      sttError = {
        message: error?.message || String(error),
        status: error?.status || 502,
        details: error?.details || null,
      };
      throw Object.assign(
        new ExternalServiceError("trainer-turn", "Speech-to-text failed before Claude could respond", {
          status: error?.status || 502,
          retryable: false,
          details: { sttError, stage: "stt" },
        }),
        // Surface the original status code for the route's error envelope.
        { stage: "stt" },
      );
    }
  }
  if (!userText) {
    throw new ValidationError("No audio or text supplied for this turn");
  }

  // --- 1b. Persist rep mic clip (best-effort, never blocks the turn) ---
  // The rep audio is the input to Whisper; we keep it alongside the
  // prospect TTS so future review can hear *both* sides. Errors here
  // are logged on the recording manifest but never throw — a missing
  // training recording shouldn't kill a live coaching session.
  const recordings = { rep: null, prospect: null, errors: [] };
  if (shouldRecord && audioBuffer) {
    try {
      // Try to infer extension from the inbound mimeType. The browser
      // MediaRecorder typically gives us audio/webm; we keep webm so we
      // don't re-encode bytes the Whisper turn already chewed through.
      const repExt = /webm/i.test(audioMimeType) ? "webm"
        : /ogg/i.test(audioMimeType) ? "ogg"
        : /mp4|m4a/i.test(audioMimeType) ? "m4a"
        : /wav/i.test(audioMimeType) ? "wav"
        : "webm";
      const written = await writeRecordingBuffer({
        kind: KIND_TRAINING,
        buffer: audioBuffer,
        sessionId,
        turnNumber,
        side: "rep",
        ext: repExt,
        mimeType: audioMimeType,
      });
      recordings.rep = { ...written, transcript: userText };
      if (archiveToDrive && isDriveArchiveConfigured(KIND_TRAINING)) {
        const archive = await archiveRecordingSafe({
          localPath: written.localPath,
          kind: KIND_TRAINING,
          sessionId,
          turnNumber,
          side: "rep",
          mimeType: audioMimeType,
        });
        if (archive.ok) {
          recordings.rep.driveFileId = archive.manifest?.driveFileId || null;
        } else if (archive.error) {
          recordings.errors.push({ side: "rep", stage: "archive", ...archive.error });
        }
      }
    } catch (err) {
      recordings.errors.push({ side: "rep", stage: "write", message: err?.message || String(err) });
    }
  }

  // --- 2. Build messages with the new user turn appended ---
  const priorMessages = Array.isArray(messages) ? messages.slice() : [];
  const nextMessages = [
    ...priorMessages,
    { role: "user", content: userText },
  ];

  // --- 3. Claude (or OpenAI fallback) ---
  const responseResult = await runTaxResolutionSalesTrainer({
    messages: nextMessages,
    mode,
    scenario,
    user,
    profile,
    playbook,
    provider,
    model,
    maxOutputTokens,
    promptVariant,
  });

  // --- 4. TTS (best-effort; UI can retry via /speech if it fails) ---
  let responseAudio = null;
  let responseAudioError = null;
  if (includeAudio !== false && isOpenAiConfigured() && responseResult?.text) {
    try {
      // Voice selection precedence: explicit `audio.voice` from caller →
      // profile-derived voice (already on `profile.voiceHints`) → config default.
      // We trust startSalesTrainerSession to have stamped the right voice
      // on the profile; the route just forwards whatever lives there.
      // The complete voiceProfile is the actual lock; explicit voice is
      // only a fallback when an older client sends no profile object.
      const voiceProfilePref = audio?.voiceProfile || audio?.profile || null;
      const voicePref = audio?.voice
        || voiceProfilePref?.voice
        || profile?.voiceHints?.voice
        || null;
      // Strip <UI_*> payload blocks before TTS — those are JSON for the
      // side panel and would be read aloud verbatim otherwise.
      let spokenText = stripTrainerUiTags(responseResult.text);

      // If a scorecard fired this turn, the protocol-mandated chat text
      // is just "Your scorecard is in your panel" — which sounds robotic
      // when TTS'd. Route the structured scorecard through the coaching
      // narrator (Opus by default) to synthesize a natural spoken
      // debrief, and REPLACE the spoken text with that. The structured
      // JSON still flows to the UI side panel via the unstripped
      // responseResult.text — only the audio path changes.
      const scorecardPayload = extractScorecardPayload(responseResult.text);
      if (scorecardPayload) {
        try {
          const narration = await generateCoachingNarration({
            scorecard: scorecardPayload,
            profile,
          });
          if (narration?.text) {
            spokenText = narration.text;
            // Tag the response so the client can show the debrief text
            // in the chat bubble alongside the side-panel scorecard.
            responseResult.coachingNarration = narration.text;
            responseResult.coachingNarrationModel = narration.model;
          }
        } catch (narrErr) {
          // Narrator failure is non-fatal — fall back to whatever the
          // live model said (typically the boring "scorecard is in your
          // panel" line). UI still gets the structured scorecard.
          responseResult.coachingNarrationError = {
            message: narrErr?.message || String(narrErr),
            status: narrErr?.status || null,
          };
        }
      }
      // Use the chunked variant: splits into sentences and renders TTS
      // in parallel. Wall-clock cost ≈ longest single chunk, not sum.
      // For a 3-sentence response that's ~700ms instead of ~2-3s.
      responseAudio = spokenText
        ? await synthesizeSalesTrainerSpeechChunks({
            text: spokenText,
            voiceProfile: voiceProfilePref,
            voice: voicePref,
            persona: audio?.persona
              || voiceProfilePref?.persona
              || profile?.voiceHints?.persona,
            extraInstructions: audio?.extraInstructions
              || audio?.voiceNotes
              || voiceProfilePref?.extraInstructions
              || voiceProfilePref?.voiceNotes
              || profile?.voiceHints?.extraInstructions,
            responseFormat: audio?.responseFormat
              || audio?.format
              || voiceProfilePref?.responseFormat
              || voiceProfilePref?.format,
            speed: audio?.speed ?? voiceProfilePref?.speed,
            emotion: audio?.emotion || voiceProfilePref?.emotion,
            pacing: audio?.pacing || voiceProfilePref?.pacing,
            intensity: audio?.intensity || voiceProfilePref?.intensity,
          })
        : null;
    } catch (audioErr) {
      responseAudioError = {
        message: audioErr?.message || String(audioErr),
        status: audioErr?.status || null,
      };
    }
  }

  // --- 4b. Persist prospect TTS audio (best-effort) ---
  if (shouldRecord && responseAudio?.audioBase64) {
    try {
      const ttsBuffer = Buffer.from(responseAudio.audioBase64, "base64");
      const ttsExt = sanitizeAudioExt(responseAudio.format) || "mp3";
      const written = await writeRecordingBuffer({
        kind: KIND_TRAINING,
        buffer: ttsBuffer,
        sessionId,
        turnNumber,
        side: "prospect",
        ext: ttsExt,
        mimeType: responseAudio.mimeType || `audio/${ttsExt}`,
      });
      recordings.prospect = {
        ...written,
        text: responseResult?.text || null,
        voice: responseAudio.voice || null,
      };
      if (archiveToDrive && isDriveArchiveConfigured(KIND_TRAINING)) {
        const archive = await archiveRecordingSafe({
          localPath: written.localPath,
          kind: KIND_TRAINING,
          sessionId,
          turnNumber,
          side: "prospect",
          mimeType: responseAudio.mimeType || `audio/${ttsExt}`,
        });
        if (archive.ok) {
          recordings.prospect.driveFileId = archive.manifest?.driveFileId || null;
        } else if (archive.error) {
          recordings.errors.push({ side: "prospect", stage: "archive", ...archive.error });
        }
      }
    } catch (err) {
      recordings.errors.push({ side: "prospect", stage: "write", message: err?.message || String(err) });
    }
  }

  // --- 4c. Append to session manifest so the directory tells a story ---
  if (shouldRecord && (recordings.rep || recordings.prospect)) {
    try {
      await appendTrainingSessionEntry({
        sessionId,
        entry: {
          turnNumber,
          repText: userText,
          prospectText: responseResult?.text || null,
          repLocalPath: recordings.rep?.localPath || null,
          prospectLocalPath: recordings.prospect?.localPath || null,
          repDriveFileId: recordings.rep?.driveFileId || null,
          prospectDriveFileId: recordings.prospect?.driveFileId || null,
          provider: responseResult?.provider || null,
          model: responseResult?.model || null,
          voice: responseAudio?.voice || null,
        },
      });
    } catch (err) {
      recordings.errors.push({ side: "manifest", stage: "write", message: err?.message || String(err) });
    }
  }

  const elapsedMs = Date.now() - turnStartedAt;

  // Build an autoplay-friendly playback envelope. The UI grabs ONE
  // field instead of digging through `result.audio.audioBase64` +
  // `result.audio.mimeType` separately, and gets an explicit
  // `autoplay: true` signal so it doesn't have to guess intent.
  //
  // The data URL is fully self-contained — assign it to
  // `<audio src=...>` or `new Audio(...)` and call .play(). Browsers
  // honor autoplay if the page already had a user gesture this
  // session (which the rep just provided by speaking), so this lands
  // in Chrome/Safari without a click.
  // Build the autoplay envelope. The chunked TTS path returns a
  // `chunks: [...]` array (each with its own audioBase64 + mimeType);
  // legacy single-blob callers see chunks=undefined and we fall back
  // to the original shape. The UI should prefer playback.chunks when
  // present and play them as an ordered playlist.
  let playback = null;
  if (responseAudio?.chunks && Array.isArray(responseAudio.chunks) && responseAudio.chunks.length > 0) {
    playback = {
      autoplay: true,
      mimeType: responseAudio.mimeType,
      format: responseAudio.format,
      voice: responseAudio.voice,
      // Chunked playback — UI plays these sequentially. Each chunk has
      // its own dataUrl ready for `new Audio(dataUrl).play()`.
      chunks: responseAudio.chunks.map((chunk) => ({
        index: chunk.index,
        text: chunk.text,
        mimeType: chunk.mimeType,
        format: chunk.format,
        audioBase64: chunk.audioBase64,
        dataUrl: `data:${chunk.mimeType};base64,${chunk.audioBase64}`,
      })),
      // Mirror first chunk at the top level for backwards-compat with
      // clients that haven't been updated to handle the chunks array.
      // They'll just play the first sentence; updated clients use chunks.
      audioBase64: responseAudio.audioBase64,
      dataUrl: `data:${responseAudio.mimeType};base64,${responseAudio.audioBase64}`,
    };
  } else if (responseAudio?.audioBase64) {
    playback = {
      autoplay: true,
      mimeType: responseAudio.mimeType,
      format: responseAudio.format,
      voice: responseAudio.voice,
      audioBase64: responseAudio.audioBase64,
      dataUrl: `data:${responseAudio.mimeType};base64,${responseAudio.audioBase64}`,
    };
  }

  return {
    transcript,
    sttError,
    response: responseResult,
    audio: responseAudio,
    audioError: responseAudioError,
    playback,
    recordings: shouldRecord ? recordings : null,
    messages: [
      ...nextMessages,
      { role: "assistant", content: responseResult?.text || "" },
    ],
    elapsedMs,
  };
}

module.exports = {
  SALES_TRAINER_TTS_FORMATS,
  SALES_TRAINER_TTS_PERSONAS,
  SALES_TRAINER_TTS_VOICES,
  TAX_RESOLUTION_SALES_TRAINER_PROMPT,
  buildTtsInstructions,
  buildSalesTrainerAccount,
  generateCallerProfile,
  generateCallerPlaybook,
  generateCoachingNarration,
  extractScorecardPayload,
  // Exported for diagnostic tooling (scripts/show-trainer-prompt.js):
  // these are normally internal but useful for inspecting exactly what
  // gets sent to Claude on a given turn.
  buildSessionHeader,
  buildInput,
  adaptInputForAnthropic,
  splitIntoSpeechChunks,
  getSalesTrainerUiState,
  getSalesTrainerConfig,
  isAnthropicConfigured,
  isConfigured,
  isEmailAllowedForSalesTrainer,
  isOpenAiConfigured,
  isSalesTrainerAccountAllowed,
  isTaxAdvocateGroupSalesTrainerAccount,
  issueSalesTrainerToken,
  listConfiguredProviders,
  normalizeTtsProfile,
  pickTtsVoiceForProfile,
  publishSalesTrainerUiState,
  runSalesTrainerCoachingPanel,
  runSalesTrainerTurn,
  runTaxResolutionSalesTrainer,
  startSalesTrainerSession,
  synthesizeSalesTrainerSpeech,
  transcribeSalesTrainerAudio,
  verifySalesTrainerToken,
};
