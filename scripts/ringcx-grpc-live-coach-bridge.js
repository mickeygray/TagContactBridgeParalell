#!/usr/bin/env node
"use strict";

// Local RingCX gRPC -> live-coach bus bridge.
//
// This is intentionally thin: RingCX streams audio into this process on
// 3344, this process chunks prospect/contact audio into WAV snippets,
// transcribes them with the shared trainer STT path, then feeds final text
// into the AI bus. The AI bus owns the watcher -> context -> dialog loop and
// the dashboard UI.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const grpc = require("@grpc/grpc-js");
const {
  decodeEvent,
  ensureDir,
  loadProto,
  pcm16FromPayload,
  requireBasicAuth,
  safeString,
  sanitizeMetadata,
  stamp,
  wavHeader,
  writeJsonLine,
  writeWav,
} = require("./ringcx-grpc-stream-receiver");
const {
  transcribeSalesTrainerAudio,
} = require("../packages/shared-services/src/taxResolutionSalesTrainerService");

const TERMINAL_COACH_STATUSES = new Set(["stopped", "stale", "voicemail_rejected"]);
const TERMINAL_COACH_BIND_MISS_STATUSES = new Set(["closed", "event-expired", "binding-inactive", "disposition-hangup"]);
const TERMINAL_COACH_POST_ERROR_PATTERN =
  /Session is (?:stale|stopped|voicemail_rejected)|uii-mismatch|queue-item-mismatch|agent-mismatch|agent-current-(?:uii|queue|call-session)-mismatch|not_current|binding-inactive|disposition-hangup|event-expired/i;
const OPENAI_REALTIME_TRANSCRIPTION_URL = "wss://api.openai.com/v1/realtime?intent=transcription";
const STT_MODEL_ALIASES = new Map([
  ["4o", "gpt-4o-transcribe"],
  ["4otranscribe", "gpt-4o-transcribe"],
  ["gpt4o", "gpt-4o-transcribe"],
  ["gpt4otranscribe", "gpt-4o-transcribe"],
  ["gpt-4o", "gpt-4o-transcribe"],
  ["gpt-4o-transcribe", "gpt-4o-transcribe"],
  ["mini", "gpt-4o-mini-transcribe"],
  ["4omini", "gpt-4o-mini-transcribe"],
  ["gpt4omini", "gpt-4o-mini-transcribe"],
  ["gpt-4o-mini-transcribe", "gpt-4o-mini-transcribe"],
  ["realtimewhisper", "gpt-realtime-whisper"],
  ["rtwhisper", "gpt-realtime-whisper"],
  ["gptrealtimewhisper", "gpt-realtime-whisper"],
  ["gpt-realtime-whisper", "gpt-realtime-whisper"],
  ["whisper", "gpt-realtime-whisper"],
  ["whisper1", "whisper-1"],
  ["whisper-1", "whisper-1"],
]);

function readFlag(argv, name, fallback = "") {
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const idx = argv.indexOf(name);
  if (idx >= 0 && idx < argv.length - 1) return argv[idx + 1];
  return fallback;
}

function readBoolFlag(argv, name, fallback = true) {
  const raw = String(readFlag(argv, name, fallback ? "true" : "false")).trim().toLowerCase();
  if (["0", "false", "no", "off", "disabled"].includes(raw)) return false;
  if (["1", "true", "yes", "on", "enabled"].includes(raw)) return true;
  return Boolean(fallback);
}

function readEnvBool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return Boolean(fallback);
  const raw = String(value).trim().toLowerCase();
  if (["0", "false", "no", "off", "disabled"].includes(raw)) return false;
  if (["1", "true", "yes", "on", "enabled"].includes(raw)) return true;
  return Boolean(fallback);
}

function cleanText(value, maxLength = 4000) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function normalizeLookupKey(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function resolveSttModelAlias(value, fallback = "") {
  const raw = cleanText(value, 120);
  if (!raw) return fallback;
  return STT_MODEL_ALIASES.get(normalizeLookupKey(raw)) || STT_MODEL_ALIASES.get(raw.toLowerCase()) || raw;
}

function parseSttModelMap(raw = "") {
  const map = new Map();
  String(raw || "")
    .split(/[;,]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .forEach((part) => {
      const splitAt = part.includes("=") ? part.indexOf("=") : part.indexOf(":");
      if (splitAt <= 0) return;
      const key = normalizeLookupKey(part.slice(0, splitAt));
      const model = resolveSttModelAlias(part.slice(splitAt + 1));
      if (key && model) map.set(key, model);
    });
  return map;
}

function openAiRealtimeTranscriptionSupportsTurnDetection(model) {
  const normalized = normalizeLookupKey(resolveSttModelAlias(model));
  return !["gptrealtimewhisper", "whisper1"].includes(normalized);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTerminalCoachPostError(error) {
  return TERMINAL_COACH_POST_ERROR_PATTERN.test(String(error?.message || error || ""));
}

function isMissingCoachSessionPostError(error) {
  return /Session not found/i.test(String(error?.message || error || ""));
}

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits;
}

function firstClean(values, maxLength = 4000) {
  for (const value of values || []) {
    const clean = cleanText(value, maxLength);
    if (clean) return clean;
  }
  return "";
}

function attributeValue(attributes = {}, names = []) {
  const entries = Object.entries(attributes || {});
  for (const name of names) {
    const wanted = String(name || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
    const hit = entries.find(([key]) => String(key || "").replace(/[^a-z0-9]/gi, "").toLowerCase() === wanted);
    if (hit) return cleanText(hit[1], 4000);
  }
  return "";
}

function extractDialogIdentity(decoded = {}, sessionId = "") {
  const dialog = decoded.dialog || {};
  const attributes = dialog.attributes || {};
  return {
    dialogId: cleanText(dialog.id || "", 160),
    dialogType: cleanText(dialog.type || "", 80),
    callSessionId: firstClean([
      attributeValue(attributes, ["callSessionId", "sessionId", "workflowInstanceId"]),
      sessionId,
    ], 160),
    uii: attributeValue(attributes, ["uii", "rcxUii", "callUii", "activeCallCaptureUii"]),
    queueItemId: attributeValue(attributes, ["queueItemId", "queueTicketId", "dialRequestId", "leadQueueItemId"]),
    agentExtensionId: attributeValue(attributes, ["agentExtensionId", "extensionId", "agentExt", "dialerExtensionId"]),
    agentEmail: attributeValue(attributes, ["agentEmail", "dialerEmail", "requestedByUserEmail"]),
    caseId: attributeValue(attributes, ["caseId", "logicsCaseId", "sourceLogicsCaseId"]),
    phone: normalizePhone(firstClean([
      attributeValue(attributes, ["phone", "phoneNumber", "leadPhone", "contactPhone"]),
      dialog.ani,
      dialog.dnis,
    ], 80)),
    ani: normalizePhone(dialog.ani || ""),
    dnis: normalizePhone(dialog.dnis || ""),
    attributes,
  };
}

function compactObject(input = {}) {
  const out = {};
  for (const [key, value] of Object.entries(input || {})) {
    if (value === undefined || value === null || value === "") continue;
    out[key] = value;
  }
  return out;
}

// Underlying hallucination fix: don't transcribe non-speech audio. Measures the
// PCM16 chunk energy; if almost nothing is above the activity floor it's silence/
// hold/noise -> skip STT entirely (no prompt to echo, no Whisper "thank you").
// Content-agnostic; no word matching. Set MIN_STT_ACTIVE_PCT=0 to disable.
let MIN_STT_ACTIVE_PCT = Number(process.env.LIVE_COACH_MIN_STT_ACTIVE_PCT || 1) || 0;

function measurePcm16Activity(pcmBuffers) {
  let active = 0;
  let total = 0;
  let maxAbs = 0;
  let sumSquares = 0;
  for (const buf of pcmBuffers || []) {
    for (let i = 0; i + 1 < buf.length; i += 2) {
      const a = Math.abs(buf.readInt16LE(i));
      total += 1;
      sumSquares += a * a;
      if (a > maxAbs) maxAbs = a;
      if (a > 500) active += 1;
    }
  }
  return {
    samples: total,
    maxAbs,
    rms: total ? Number(Math.sqrt(sumSquares / total).toFixed(3)) : 0,
    activePctOver500: total ? Number(((active / total) * 100).toFixed(3)) : 0,
  };
}

function isLowSignalTranscript(text) {
  const clean = cleanText(text, 240).toLowerCase();
  if (!clean) return true;
  const compact = clean.replace(/[\s.,!?¿¡'"“”‘’()[\]{}:;:…-]+/g, "");
  if (!compact) return true;
  const latinLetters = [...compact.matchAll(/\p{Script=Latin}/gu)].length;
  const asciiDigits = [...compact.matchAll(/[0-9]/g)].length;
  const letters = [...compact.matchAll(/\p{L}/gu)].length;
  const numbers = [...compact.matchAll(/\p{N}/gu)].length;
  const latinOrAsciiSignal = latinLetters + asciiDigits;
  const totalWordSignal = letters + numbers;
  if (compact.length <= 1) return true;
  if (compact.length <= 2 && latinOrAsciiSignal === 0) return true;
  if (compact.length <= 8 && totalWordSignal > 0 && latinOrAsciiSignal === 0) return true;
  if (compact.length <= 12 && totalWordSignal > 0 && latinOrAsciiSignal / totalWordSignal < 0.35) return true;
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

function wavBufferFromPcmBuffers(pcmBuffers, sampleRate = 8000) {
  const dataBytes = pcmBuffers.reduce((sum, item) => sum + item.length, 0);
  return Buffer.concat([wavHeader({ dataBytes, sampleRate }), ...pcmBuffers]);
}

function internalHeaders() {
  const secret = String(
    process.env.AI_BUS_INTERNAL_SECRET ||
      process.env.INTERNAL_SERVICE_SECRET ||
      process.env.SALES_TRAINER_BRIDGE_SECRET ||
      "",
  ).trim();
  return {
    "content-type": "application/json",
    ...(secret ? { "x-internal-secret": secret } : {}),
  };
}

async function postJson(url, body, timeoutMs = 15_000) {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), Math.max(1000, timeoutMs));
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: internalHeaders(),
      body: JSON.stringify(body || {}),
      signal: abortController.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  if (!response.ok) {
    throw new Error(`POST ${url} failed: ${response.status} ${text.slice(0, 300)}`);
  }
  return json;
}

function coachPostIdentity(segment) {
  const boundUii = cleanText(
    segment.coachBinding?.metadata?.uii ||
      segment.coachBinding?.event?.uii ||
      segment.dialogIdentity?.uii ||
      "",
    160,
  );
  return {
    streamId: segment.streamId,
    workflowInstanceId: segment.sessionId,
    uii: boundUii,
    callSessionId: segment.dialogIdentity?.callSessionId || segment.sessionId || "",
    queueItemId: segment.dialogIdentity?.queueItemId || "",
    agentExtensionId: segment.dialogIdentity?.agentExtensionId || "",
    agentEmail: segment.dialogIdentity?.agentEmail || "",
  };
}

function resetCoachSessionAfterMissing(segment, reason = "session-not-found") {
  if (!segment) return;
  segment.coachSessionStarted = false;
  segment.coachBinding = null;
  segment.coachSessionMetadata = null;
  writeJsonLine(segment.eventLog, {
    type: "coach.session.rebind_after_missing",
    at: new Date().toISOString(),
    streamId: segment.streamId,
    segmentId: segment.segmentId,
    coachSessionId: segment.coachSessionId,
    reason,
  });
}

async function postCoachInput(segment, buildBody, timeoutMs = 15_000, options = {}) {
  if (segment.role !== "prospect") return null;
  if (segment.coachTerminal) return null;
  // STREAM 4 self-healing: piggyback the agent-uii drift check on the transcript
  // cadence (throttled internally, fire-and-forget). No new always-on timer; the
  // check is a no-op unless LIVE_COACH_UII_RECONCILE_ENABLED is set and bound.
  if (segment.uiiReconcileEnabled && segment.coachSessionStarted) {
    reconcileCoachUii(segment).catch(() => {});
  }
  const forceBind = Boolean(options.forceBind);
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await ensureCoachSession(segment, { forceBind: forceBind || attempt > 1 });
    if (!segment.coachSessionStarted || !segment.coachSessionId) return null;
    const body = typeof buildBody === "function" ? buildBody() : buildBody;
    if (!body) return null;
    try {
      const result = await postJson(
        `${segment.aiBusUrl}/api/ai/live-coach/grpc/${encodeURIComponent(segment.coachSessionId)}/input`,
        body,
        timeoutMs,
      );
      if (TERMINAL_COACH_STATUSES.has(String(result?.session?.status || ""))) {
        segment.coachTerminal = true;
      }
      return result;
    } catch (error) {
      if (isTerminalCoachPostError(error)) {
        segment.coachTerminal = true;
        writeJsonLine(segment.eventLog, {
          type: "coach.post.terminal",
          at: new Date().toISOString(),
          streamId: segment.streamId,
          segmentId: segment.segmentId,
          coachSessionId: segment.coachSessionId,
          error: error.message,
        });
        return null;
      }
      if (attempt === 1 && isMissingCoachSessionPostError(error)) {
        resetCoachSessionAfterMissing(segment, error.message);
        continue;
      }
      throw error;
    }
  }
  return null;
}

async function postCoachStreamStatus(segment, buildBody, timeoutMs = 5000, options = {}) {
  if (segment.role !== "prospect") return null;
  if (segment.coachTerminal) return null;
  const forceBind = Boolean(options.forceBind);
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await ensureCoachSession(segment, { forceBind: forceBind || attempt > 1 });
    if (!segment.coachSessionStarted || !segment.coachSessionId) return null;
    const body = typeof buildBody === "function" ? buildBody() : buildBody;
    if (!body) return null;
    try {
      return await postJson(
        `${segment.aiBusUrl}/api/ai/live-coach/grpc/${encodeURIComponent(segment.coachSessionId)}/stream-status`,
        body,
        timeoutMs,
      );
    } catch (error) {
      if (isTerminalCoachPostError(error)) {
        segment.coachTerminal = true;
        writeJsonLine(segment.eventLog, {
          type: "stream.status_terminal",
          at: new Date().toISOString(),
          streamId: segment.streamId,
          segmentId: segment.segmentId,
          coachSessionId: segment.coachSessionId,
          error: error.message,
        });
        return null;
      }
      if (attempt === 1 && isMissingCoachSessionPostError(error)) {
        resetCoachSessionAfterMissing(segment, error.message);
        continue;
      }
      throw error;
    }
  }
  return null;
}

function participantRole(participant = {}) {
  const type = String(participant.type || "").toUpperCase();
  if (type.includes("CONTACT")) return "prospect";
  if (type.includes("AGENT")) return "agent";
  if (type.includes("BOT")) return "system";
  return "unknown";
}

function isWorkflowStreamSessionId(value) {
  return /^STREAM-/i.test(cleanText(value, 80));
}

function openAiRealtimeProtocols(apiKey) {
  const protocols = [
    "realtime",
    `openai-insecure-api-key.${apiKey}`,
  ];
  const project = process.env.OPENAI_PROJECT_ID || process.env.OPENAI_PROJECT || "";
  const org = process.env.OPENAI_ORG_ID || process.env.OPENAI_ORGANIZATION || "";
  if (project) protocols.push(`openai-project.${project}`);
  if (org) protocols.push(`openai-organization.${org}`);
  return protocols;
}

function appendRealtimeTranscriptDelta(existing, delta) {
  const left = String(existing || "");
  const right = String(delta || "");
  if (!left) return right;
  if (!right) return left;
  if (/^\s/.test(right) || /\s$/.test(left)) return `${left}${right}`;
  if (/^[.,!?;:%)\]}]/.test(right)) return `${left}${right}`;
  if (/^['’](s|re|ve|d|ll|m|t)\b/i.test(right)) return `${left}${right}`;
  if (/[-/]$/.test(left) || /^[-/]/.test(right)) return `${left}${right}`;
  return `${left} ${right}`;
}

function buildProvisionalPreviewChunks(text, options = {}) {
  const clean = cleanText(text, 2000);
  if (!clean) return [];
  const words = clean.split(/\s+/).filter(Boolean);
  if (words.length <= 2) return [clean];
  const maxChunks = Math.max(1, Math.min(8, Number(options.maxChunks || 4) || 4));
  const chunkWords = Math.max(2, Number(options.chunkWords || Math.ceil(words.length / maxChunks)) || 2);
  const chunks = [];
  for (let end = Math.min(chunkWords, words.length); end < words.length; end += chunkWords) {
    chunks.push(words.slice(0, end).join(" "));
  }
  chunks.push(clean);
  return [...new Set(chunks)].slice(-maxChunks);
}

function createSegmentState({
  streamId,
  sessionId,
  segmentId,
  decoded,
  outDir,
  aiBusUrl,
  chunkSec,
  provisionalPreviewMs,
  provisionalPreviewChunks,
  sttProvider,
  sttModel,
  sttModelMap,
  openAiApiKey,
  turnDetection,
  semanticEagerness,
  noiseReduction,
  realtimeProvisionalEnabled,
  allowUnboundCoachSessions,
  language,
  eventLog,
  dialogIdentity = {},
  agentSttEnabled = false,
  agentSttModel = "",
  agentSemanticEagerness = "low",
  sttDomainPrimer = "",
  getCoachSegment = null,
  dualVadEnabled = false,
  fastSttModel = "",
  fastVadSilenceMs = 500,
  turnEagerness = "low",
}) {
  const role = participantRole(decoded.participant || {});
  const safeSegment = safeString(`${sessionId || "no-session"}-${segmentId || crypto.randomBytes(3).toString("hex")}`, 140)
    .replace(/[^a-z0-9_.@-]+/gi, "-")
    .replace(/^-+|-+$/g, "");
  const segmentDir = path.join(outDir, "segments", safeSegment);
  ensureDir(segmentDir);

  const coachSessionId = `coach-grpc-${streamId}-${String(segmentId || "").slice(-12) || crypto.randomBytes(3).toString("hex")}`
    .replace(/[^a-z0-9_.@-]+/gi, "-")
    .slice(0, 120);
  // STREAM 4 self-healing: agent UII drift reconcile (default OFF). Read env at
  // segment construction so behavior is gated per-segment and stays inert unless
  // LIVE_COACH_UII_RECONCILE_ENABLED is explicitly truthy.
  const uiiReconcileEnabled = readEnvBool(process.env.LIVE_COACH_UII_RECONCILE_ENABLED, false);
  const uiiReconcileIntervalMs = Math.max(
    5000,
    Number(process.env.LIVE_COACH_UII_RECONCILE_MS || "15000") || 15000,
  );
  // MISS->ADOPT is now opt-in (default OFF). The gRPC dialogInit UII comes from
  // RingCX itself — ground truth for THIS stream. Overwriting it with the latest
  // cx.call.placed event's UII inverted that authority: when the event table was
  // stale (hook missed, inbound call, page reload) adoption rebound the live
  // stream to a dead/closed call and locked binding out for the whole call.
  // Default path now logs the drift and falls through to the unbound fallback.
  const uiiAdoptEnabled = readEnvBool(process.env.LIVE_COACH_UII_ADOPT_ENABLED, false);
  const state = {
    streamId,
    sessionId,
    segmentId,
    role,
    participant: decoded.participant || {},
    dialogIdentity,
    contactPhone: role === "prospect"
      ? normalizePhone(firstClean([decoded.participant?.id, dialogIdentity.phone, dialogIdentity.ani, dialogIdentity.dnis], 80))
      : "",
    codec: decoded.audioFormat?.codec || "",
    rate: Number(decoded.audioFormat?.rate || 8000) || 8000,
    aiBusUrl,
    coachSessionId,
    chunkSec,
    provisionalPreviewMs,
    provisionalPreviewChunks,
    sttProvider,
    // Agent segments run the cheap context-only model; prospect keeps the full
    // model (it's the system's ears — per-agent overrides via sttModelMap).
    sttModel: role === "agent"
      ? resolveSttModelAlias(agentSttModel || "gpt-4o-mini-transcribe", "gpt-4o-mini-transcribe")
      : sttModel,
    agentSttEnabled: role === "agent" ? Boolean(agentSttEnabled) : false,
    agentSemanticEagerness,
    // Dual-VAD (prospect only): fast additive channel + semantic turn channel.
    dualVadEnabled: role === "prospect" ? Boolean(dualVadEnabled) : false,
    fastSttModel: resolveSttModelAlias(fastSttModel || "gpt-4o-mini-transcribe", "gpt-4o-mini-transcribe"),
    fastVadSilenceMs,
    turnEagerness,
    turnStt: null,
    sttDomainPrimer,
    getCoachSegment: typeof getCoachSegment === "function" ? getCoachSegment : null,
    sttModelMap: sttModelMap instanceof Map ? sttModelMap : new Map(),
    openAiApiKey,
    turnDetection,
    semanticEagerness,
    noiseReduction,
    realtimeProvisionalEnabled,
    allowUnboundCoachSessions,
    language,
    eventLog,
    dir: segmentDir,
    rawPath: path.join(segmentDir, "audio.raw"),
    wavPath: path.join(segmentDir, "audio.wav"),
    jsonPath: path.join(segmentDir, "events.ndjson"),
    pcmBuffers: [],
    pendingPcmBuffers: [],
    pendingRawBytes: 0,
    rawBytes: 0,
    mediaCount: 0,
    chunkCount: 0,
    stopped: false,
    coachSessionStarted: false,
    coachBound: false,
    coachBindAttempts: 0,
    nextCoachBindAt: 0,
    coachBinding: null,
    coachSessionMetadata: null,
    coachTerminal: false,
    uiiReconcileEnabled,
    uiiReconcileIntervalMs,
    uiiAdoptEnabled,
    nextUiiReconcileAt: 0,
    uiiDriftCandidate: null,
    uiiDriftConfirmCount: 0,
    coachEnrichAttempts: 0,
    nextCoachEnrichAt: 0,
    coachEnriching: false,
    realtimeStt: null,
    realtimeSttStarting: false,
    realtimeSttStartPromise: null,
    realtimeSttStartAttempts: 0,
    nextRealtimeSttStartAt: 0,
    lastStreamStatusAtMs: 0,
    streamStatusIntervalMs: Math.max(
      1000,
      Number(process.env.LIVE_COACH_STREAM_STATUS_INTERVAL_MS || "2500") || 2500,
    ),
    pendingRealtimePayloads: [],
    pendingRealtimePayloadBytes: 0,
    pendingRealtimeDroppedChunks: 0,
    pendingRealtimeDroppedBytes: 0,
    // 320KB (~40s of PCMU) proved too small when binding was slow: a 5-minute
    // unbound call silently shed almost all of its audio. 2.56MB rides out a
    // multi-minute bind/enrich delay; flushed audio is still released to STT
    // in order once the session starts.
    pendingRealtimePayloadMaxBytes: Math.max(
      8000,
      Number(process.env.LIVE_COACH_REALTIME_PENDING_BIND_MAX_BYTES || "2560000") || 2560000,
    ),
    transcribeQueue: Promise.resolve(),
  };
  scheduleRealtimeSttStart(state, "segment-start");
  return state;
}

function collectAgentLookupKeys(segment, bound = null) {
  const metadata = bound?.session?.metadata || segment?.coachSessionMetadata || {};
  const binding = bound?.binding || segment?.coachBinding || {};
  const values = [
    segment?.dialogIdentity?.agentExtensionId,
    segment?.dialogIdentity?.agentEmail,
    metadata.agentExtension,
    metadata.agentExtensionId,
    metadata.agentEmail,
    metadata.email,
    metadata.agentName,
    binding.metadata?.agentExtension,
    binding.metadata?.agentExtensionId,
    binding.metadata?.agentEmail,
    binding.metadata?.agentName,
    binding.event?.agentExtension,
    binding.event?.agentExtensionId,
    binding.event?.agentEmail,
    binding.event?.agentName,
  ].filter(Boolean);
  const keys = new Set();
  for (const value of values) {
    const raw = cleanText(value, 240);
    const normalized = normalizeLookupKey(raw);
    if (!normalized) continue;
    keys.add(normalized);
    if (raw.includes("@")) {
      const local = raw.split("@")[0];
      keys.add(normalizeLookupKey(local));
      const parts = local.split(/[._-]+/).filter(Boolean);
      if (parts.length >= 2) {
        keys.add(normalizeLookupKey(`${parts[0]}${parts[parts.length - 1]}`));
        keys.add(normalizeLookupKey(`${parts[0][0] || ""}${parts[parts.length - 1]}`));
      }
    } else {
      const parts = raw.split(/\s+/).filter(Boolean);
      if (parts.length >= 2) {
        keys.add(normalizeLookupKey(`${parts[0]}${parts[parts.length - 1]}`));
        keys.add(normalizeLookupKey(`${parts[0][0] || ""}${parts[parts.length - 1]}`));
      }
    }
  }
  return [...keys].filter(Boolean);
}

function selectRealtimeSttModel(segment, bound = null) {
  const map = segment?.sttModelMap instanceof Map ? segment.sttModelMap : new Map();
  const keys = collectAgentLookupKeys(segment, bound);
  for (const key of keys) {
    if (map.has(key)) {
      return {
        model: map.get(key),
        matchedKey: key,
        lookupKeys: keys,
      };
    }
  }
  return {
    model: resolveSttModelAlias(segment?.sttModel || "gpt-4o-transcribe", "gpt-4o-transcribe"),
    matchedKey: "",
    lookupKeys: keys,
  };
}

function queueRealtimePayload(segment, payload) {
  if (!segment || !payload?.length) return;
  segment.pendingRealtimePayloads.push(Buffer.from(payload));
  segment.pendingRealtimePayloadBytes += payload.length;
  let droppedChunks = 0;
  let droppedBytes = 0;
  while (
    segment.pendingRealtimePayloadBytes > segment.pendingRealtimePayloadMaxBytes &&
    segment.pendingRealtimePayloads.length
  ) {
    const removed = segment.pendingRealtimePayloads.shift();
    segment.pendingRealtimePayloadBytes -= removed.length;
    droppedChunks += 1;
    droppedBytes += removed.length;
  }
  if (droppedChunks) {
    // This used to be a fully silent drop — a stuck bind shed audio with zero
    // evidence. Keep counters on the segment (surfaced via stream-status) and
    // log at most every 5s so a sustained overflow is visible without spam.
    segment.pendingRealtimeDroppedChunks = (segment.pendingRealtimeDroppedChunks || 0) + droppedChunks;
    segment.pendingRealtimeDroppedBytes = (segment.pendingRealtimeDroppedBytes || 0) + droppedBytes;
    const now = Date.now();
    if (!segment.nextPendingDropLogAt || now >= segment.nextPendingDropLogAt) {
      segment.nextPendingDropLogAt = now + 5000;
      writeJsonLine(segment.eventLog, {
        type: "stt.realtime.pending_drop",
        at: new Date().toISOString(),
        streamId: segment.streamId,
        segmentId: segment.segmentId,
        droppedChunks: segment.pendingRealtimeDroppedChunks,
        droppedBytes: segment.pendingRealtimeDroppedBytes,
        pendingBytes: segment.pendingRealtimePayloadBytes,
        maxBytes: segment.pendingRealtimePayloadMaxBytes,
        coachSessionStarted: Boolean(segment.coachSessionStarted),
      });
    }
  }
}

function flushPendingRealtimePayloads(segment, reason = "stt-start") {
  if (!segment?.realtimeStt || !segment.pendingRealtimePayloads?.length) return 0;
  const pending = segment.pendingRealtimePayloads;
  const bytes = segment.pendingRealtimePayloadBytes;
  segment.pendingRealtimePayloads = [];
  segment.pendingRealtimePayloadBytes = 0;
  for (const payload of pending) {
    segment.realtimeStt.appendPcmu(payload);
    segment.turnStt?.appendPcmu(payload);
  }
  writeJsonLine(segment.eventLog, {
    type: "stt.realtime.pending_flush",
    at: new Date().toISOString(),
    streamId: segment.streamId,
    segmentId: segment.segmentId,
    reason,
    chunks: pending.length,
    bytes,
    model: segment.sttModel,
  });
  return pending.length;
}

// ---- live-coach kill switch -------------------------------------------------
// Short-circuit coaching on the live box WITHOUT dropping the gRPC stream: the bridge
// keeps accepting RingCX media (no floor-side connection error) but stops STT + coaching.
// Toggle with NO restart by creating/removing the kill file (scripts/live-coach-kill.js
// on|off|status), or set LIVE_COACH_BRIDGE_DISABLED=1 to start disabled. Re-checked per
// stream so a flip takes effect on the next call immediately.
const LIVE_COACH_KILL_FILE = process.env.LIVE_COACH_KILL_FILE
  || path.resolve(__dirname, "..", "runtime", "live-coach.killed");
function liveCoachKilledVia() {
  if (/^(1|true|yes|on)$/i.test(String(process.env.LIVE_COACH_BRIDGE_DISABLED || "").trim())) return "env";
  try { if (fs.existsSync(LIVE_COACH_KILL_FILE)) return "kill-file"; } catch {}
  return null;
}
function isLiveCoachKilled() { return liveCoachKilledVia() !== null; }

// Prospect always transcribes; agent transcribes only when the agent channel is
// enabled (LIVE_COACH_AGENT_STT_ENABLED) — context-only, cheap model, no coach
// session of its own.
function realtimeSttRoleEnabled(segment) {
  if (!segment) return false;
  if (segment.role === "prospect") return true;
  return segment.role === "agent" && Boolean(segment.agentSttEnabled);
}

function scheduleRealtimeSttStart(segment, reason = "media") {
  if (!segment || !realtimeSttRoleEnabled(segment) || segment.sttProvider !== "openai-realtime") return null;
  if (isLiveCoachKilled()) {
    if (!segment._coachKilledLogged) {
      segment._coachKilledLogged = true;
      try {
        writeJsonLine(segment.eventLog, {
          type: "coach.kill_switch.active",
          at: new Date().toISOString(),
          streamId: segment.streamId,
          segmentId: segment.segmentId,
          via: liveCoachKilledVia(),
          reason,
        });
      } catch {}
      console.log(`[coach] KILL SWITCH active (${liveCoachKilledVia()}) -> STT/coaching off, gRPC stream still accepted (reason=${reason})`);
    }
    return null;
  }
  if (segment.realtimeStt || segment.realtimeSttStarting || segment.coachTerminal) return segment.realtimeStt || null;
  const now = Date.now();
  if (segment.nextRealtimeSttStartAt && now < segment.nextRealtimeSttStartAt) return null;
  segment.nextRealtimeSttStartAt = now + 250;
  segment.realtimeSttStartPromise = ensureRealtimeStt(segment, reason).catch((error) => {
    writeJsonLine(segment.eventLog, {
      type: "stt.realtime.start_error",
      at: new Date().toISOString(),
      streamId: segment.streamId,
      segmentId: segment.segmentId,
      reason,
      error: error.message,
    });
    return null;
  });
  return segment.realtimeSttStartPromise;
}

// ── STT channel factories (creation + mid-call healing share these) ─────────
function createProspectFastChannel(segment) {
  return new OpenAiRealtimeSttChannel({
    segment,
    apiKey: segment.openAiApiKey,
    model: segment.fastSttModel || "gpt-4o-mini-transcribe",
    language: segment.language,
    turnDetection: "server_vad",
    semanticEagerness: segment.semanticEagerness,
    noiseReduction: segment.noiseReduction,
    provisionalEnabled: segment.realtimeProvisionalEnabled,
    transcriptionPrompt: buildCallSttPrimer(segment) || segment.sttDomainPrimer || "",
    channelTag: segment.fastChannelComposeFallback ? "" : "fast",
    serverVadSilenceMsOverride: segment.fastVadSilenceMs || 500,
  });
}

function createProspectTurnChannel(segment) {
  return new OpenAiRealtimeSttChannel({
    segment,
    apiKey: segment.openAiApiKey,
    model: segment.sttModel,
    language: segment.language,
    turnDetection: "semantic_vad",
    semanticEagerness: segment.turnEagerness || "low",
    noiseReduction: segment.noiseReduction,
    provisionalEnabled: false,
    transcriptionPrompt: buildCallSttPrimer(segment) || segment.sttDomainPrimer || "",
    channelTag: "turn",
  });
}

function createProspectSingleChannel(segment) {
  return new OpenAiRealtimeSttChannel({
    segment,
    apiKey: segment.openAiApiKey,
    model: segment.sttModel,
    language: segment.language,
    turnDetection: segment.turnDetection,
    semanticEagerness: segment.semanticEagerness,
    noiseReduction: segment.noiseReduction,
    provisionalEnabled: segment.realtimeProvisionalEnabled,
    transcriptionPrompt: buildCallSttPrimer(segment) || segment.sttDomainPrimer || "",
  });
}

// ── Mid-call STT healing ─────────────────────────────────────────────────────
// An OpenAI websocket that dies mid-call used to just log and stay dead —
// silent coach for the rest of the call. The watchdog recreates dead channels
// (capped attempts, audio resumes on the new socket). If the TURN channel
// exhausts its attempts the fast channel DEGRADES to compose-eligible
// (channelTag "") so coaching continues single-channel rather than never.
const STT_HEAL_INTERVAL_MS = 4000;
const STT_HEAL_MAX_ATTEMPTS = 5;

function healChannel(segment, slot, factory) {
  const attemptsKey = `${slot}HealAttempts`;
  segment[attemptsKey] = (segment[attemptsKey] || 0) + 1;
  const attempt = segment[attemptsKey];
  if (attempt > STT_HEAL_MAX_ATTEMPTS) return false;
  const channel = factory(segment);
  segment[slot] = channel;
  writeJsonLine(segment.eventLog, {
    type: "stt.realtime.heal",
    at: new Date().toISOString(),
    streamId: segment.streamId,
    segmentId: segment.segmentId,
    slot,
    attempt,
    model: channel.model,
    channel: channel.channelTag || "single",
  });
  channel.connect().catch((error) => {
    writeJsonLine(segment.eventLog, {
      type: "stt.realtime.heal_connect_error",
      at: new Date().toISOString(),
      streamId: segment.streamId,
      segmentId: segment.segmentId,
      slot,
      attempt,
      error: error.message,
    });
  });
  return true;
}

function channelNeedsHeal(channel) {
  return Boolean(channel && channel.closed && !channel.disabled);
}

function armSttHealing(segment) {
  if (segment.sttHealTimer) return;
  segment.sttHealTimer = setInterval(() => {
    if (segment.stopped || segment.coachTerminal) {
      clearInterval(segment.sttHealTimer);
      segment.sttHealTimer = null;
      return;
    }
    if (channelNeedsHeal(segment.realtimeStt)) {
      healChannel(
        segment,
        "realtimeStt",
        segment.role === "agent"
          ? createAgentChannel
          : segment.dualVadEnabled
            ? createProspectFastChannel
            : createProspectSingleChannel,
      );
    }
    if (segment.dualVadEnabled && channelNeedsHeal(segment.turnStt)) {
      const healed = healChannel(segment, "turnStt", createProspectTurnChannel);
      if (!healed && !segment.fastChannelComposeFallback) {
        // Turn channel is gone for good: composes would never fire again.
        // Degrade: the fast channel drops its "fast" tag so its finals become
        // compose-eligible (single-channel behavior) for the rest of the call.
        segment.fastChannelComposeFallback = true;
        if (segment.realtimeStt) segment.realtimeStt.channelTag = "";
        writeJsonLine(segment.eventLog, {
          type: "stt.realtime.turn_channel_degraded",
          at: new Date().toISOString(),
          streamId: segment.streamId,
          segmentId: segment.segmentId,
          attempts: segment.turnSttHealAttempts || 0,
          action: "fast-channel-now-composes",
        });
      }
    }
  }, STT_HEAL_INTERVAL_MS);
  if (typeof segment.sttHealTimer.unref === "function") segment.sttHealTimer.unref();
}

function createAgentChannel(segment) {
  return new OpenAiRealtimeSttChannel({
    segment,
    apiKey: segment.openAiApiKey,
    model: segment.sttModel,
    language: segment.language,
    turnDetection: "semantic_vad",
    semanticEagerness: segment.agentSemanticEagerness || "low",
    noiseReduction: segment.noiseReduction,
    provisionalEnabled: false,
    transcriptionPrompt: segment.sttDomainPrimer || "",
    channelTag: "turn",
  });
}

async function ensureRealtimeStt(segment, reason = "media") {
  if (!segment || !realtimeSttRoleEnabled(segment) || segment.sttProvider !== "openai-realtime") return null;
  if (segment.realtimeStt || segment.coachTerminal) return segment.realtimeStt || null;
  if (segment.realtimeSttStarting) return segment.realtimeSttStartPromise || null;
  segment.realtimeSttStarting = true;
  segment.realtimeSttStartAttempts += 1;
  try {
    if (segment.role === "agent") {
      // Agent channel: no coach session, no binding, no provisionals. Connects
      // immediately at first media; finals route into the prospect segment's
      // session via postAgentCompleted. Semantic VAD so agent sentences arrive
      // as complete thoughts for the composer's context.
      // Low eagerness: agent rows are completed-thought turns for the
      // composer's both-parties read, same cadence as the prospect turn channel.
      segment.realtimeStt = createAgentChannel(segment);
      writeJsonLine(segment.eventLog, {
        type: "stt.realtime.model_select",
        at: new Date().toISOString(),
        streamId: segment.streamId,
        segmentId: segment.segmentId,
        role: "agent",
        reason,
        model: segment.sttModel,
        turnDetection: "semantic_vad",
        semanticEagerness: segment.agentSemanticEagerness || "low",
        pendingBytes: segment.pendingRealtimePayloadBytes,
      });
      segment.realtimeStt.connect().catch((error) => {
        writeJsonLine(segment.eventLog, {
          type: "stt.realtime.connect_error",
          at: new Date().toISOString(),
          streamId: segment.streamId,
          segmentId: segment.segmentId,
          model: segment.sttModel,
          error: error.message,
        });
      });
      armSttHealing(segment);
      flushPendingRealtimePayloads(segment, reason);
      return segment.realtimeStt;
    }
    const bound = await ensureCoachSession(segment, { forceBind: true });
    if (!segment.coachSessionStarted || !segment.coachSessionId) return null;
    const selected = selectRealtimeSttModel(segment, bound);
    segment.sttModel = selected.model;
    if (segment.dualVadEnabled) {
      // DUAL-VAD: two decodes of the same prospect audio.
      //  - FAST channel (segment.realtimeStt): server_vad ~500ms, cheap model,
      //    provisionals ON. Everything additive rides here — ribbon, gates,
      //    term catching, memory. It never composes.
      //  - TURN channel (segment.turnStt): semantic_vad on LOW eagerness, full
      //    model, no provisionals. Fires only on completed thoughts — Claude's
      //    trigger.
      segment.realtimeStt = createProspectFastChannel(segment);
      segment.turnStt = createProspectTurnChannel(segment);
      segment.turnStt.connect().catch((error) => {
        writeJsonLine(segment.eventLog, {
          type: "stt.realtime.connect_error",
          at: new Date().toISOString(),
          streamId: segment.streamId,
          segmentId: segment.segmentId,
          model: segment.sttModel,
          channel: "turn",
          error: error.message,
        });
      });
    } else {
      segment.realtimeStt = createProspectSingleChannel(segment);
    }
    armSttHealing(segment);
    writeJsonLine(segment.eventLog, {
      type: "stt.realtime.model_select",
      at: new Date().toISOString(),
      streamId: segment.streamId,
      segmentId: segment.segmentId,
      coachSessionId: segment.coachSessionId,
      reason,
      model: segment.sttModel,
      matchedKey: selected.matchedKey,
      lookupKeys: selected.lookupKeys,
      agentName: bound?.session?.metadata?.agentName || segment.coachBinding?.metadata?.agentName || "",
      agentEmail: bound?.session?.metadata?.agentEmail || segment.coachBinding?.metadata?.agentEmail || "",
      agentExtension: bound?.session?.metadata?.agentExtension || segment.coachBinding?.metadata?.agentExtension || "",
      pendingBytes: segment.pendingRealtimePayloadBytes,
    });
    segment.realtimeStt.connect().catch((error) => {
      writeJsonLine(segment.eventLog, {
        type: "stt.realtime.connect_error",
        at: new Date().toISOString(),
        streamId: segment.streamId,
        segmentId: segment.segmentId,
        model: segment.sttModel,
        error: error.message,
      });
    });
    flushPendingRealtimePayloads(segment, reason);
    return segment.realtimeStt;
  } finally {
    segment.realtimeSttStarting = false;
  }
}

function isRealtimeItemCompleted(segment, itemId) {
  return Boolean(itemId && segment?.realtimeStt?.completedItemIds?.has?.(itemId));
}

// Late enrichment: a session started unbound (fallback /grpc/start) keeps
// transcribing and coaching, but its metadata is thin (no case/queue/contact).
// Retry bind/latest in the background, passing OUR sessionId so ai-bus enriches
// the existing session in place (ensureSession merges metadata) instead of
// spawning a second session. Never tears anything down, never retires other
// sessions, and gives up after ~5 minutes.
//
// Cadence is front-loaded: the cx.call.placed event usually lags the stream by
// a few SECONDS (fire-and-forget hook), so the first retries come fast — the
// wallboard heals the lane almost immediately — then back off to 10s.
const COACH_ENRICH_FAST_INTERVAL_MS = 2_000;
const COACH_ENRICH_FAST_ATTEMPTS = 5;
const COACH_ENRICH_INTERVAL_MS = 10_000;
const COACH_ENRICH_MAX_ATTEMPTS = 34;

function scheduleCoachBindingEnrichment(segment) {
  if (!segment || segment.role !== "prospect") return;
  if (!segment.coachSessionStarted || segment.coachBinding || segment.coachTerminal) return;
  if ((segment.coachEnrichAttempts || 0) >= COACH_ENRICH_MAX_ATTEMPTS) return;
  const identity = segment.dialogIdentity || {};
  // Live RingCX dialogInits carry NO agent identity (observed 541/541 with
  // empty ext/email), so requiring it meant enrichment never fired in prod.
  // UII is an exact-match key — a mismatched event uii can never bind — so
  // uii-keyed enrichment is safe without the agent filter. Phone-only stays
  // excluded: phone alone could match another concurrent call's event.
  if (!identity.uii && !identity.agentExtensionId && !identity.agentEmail) return;
  const now = Date.now();
  if (segment.coachEnriching || now < (segment.nextCoachEnrichAt || 0)) return;
  segment.coachEnriching = true;
  segment.coachEnrichAttempts = (segment.coachEnrichAttempts || 0) + 1;
  segment.nextCoachEnrichAt = now + (
    segment.coachEnrichAttempts <= COACH_ENRICH_FAST_ATTEMPTS
      ? COACH_ENRICH_FAST_INTERVAL_MS
      : COACH_ENRICH_INTERVAL_MS
  );
  enrichCoachBinding(segment)
    .catch((error) => {
      writeJsonLine(segment.eventLog, {
        type: "coach.session.enrich_error",
        at: new Date().toISOString(),
        streamId: segment.streamId,
        segmentId: segment.segmentId,
        coachSessionId: segment.coachSessionId,
        attempt: segment.coachEnrichAttempts,
        error: error.message,
      });
    })
    .finally(() => {
      segment.coachEnriching = false;
    });
}

async function enrichCoachBinding(segment) {
  const identity = segment.dialogIdentity || {};
  const bindCallSessionId = identity.callSessionId && !isWorkflowStreamSessionId(identity.callSessionId)
    ? identity.callSessionId
    : "";
  const bound = await postJson(`${segment.aiBusUrl}/api/ai/live-coach/grpc/mongo/bind/latest`, compactObject({
    sessionId: segment.coachSessionId,
    retireReplaced: false,
    phone: segment.contactPhone,
    uii: identity.uii,
    callSessionId: bindCallSessionId,
    queueItemId: identity.queueItemId,
    agentExtensionId: identity.agentExtensionId,
    agentEmail: identity.agentEmail,
    caseId: identity.caseId,
    source: "grpc-live-bridge-enrich",
    streamId: segment.streamId,
  }), 8000);
  if (!bound?.session?.id || !bound?.binding?.active) return null;
  if (bound.session.id !== segment.coachSessionId) {
    // ai-bus honored a different session id; keep coaching where we already are
    // and just record the divergence — switching sessions mid-call is worse
    // than thin metadata.
    writeJsonLine(segment.eventLog, {
      type: "coach.session.enrich_session_mismatch",
      at: new Date().toISOString(),
      streamId: segment.streamId,
      segmentId: segment.segmentId,
      coachSessionId: segment.coachSessionId,
      boundSessionId: bound.session.id,
    });
    return null;
  }
  segment.coachBinding = bound.binding || null;
  segment.coachSessionMetadata = bound.session.metadata || segment.coachSessionMetadata;
  // Names just arrived (or improved) — refresh the STT primer mid-call so the
  // engine hears the prospect/agent names spelled right from here on.
  segment.realtimeStt?.updateTranscriptionPrompt?.(buildCallSttPrimer(segment));
  segment.turnStt?.updateTranscriptionPrompt?.(buildCallSttPrimer(segment));
  writeJsonLine(segment.eventLog, {
    type: "coach.session.enriched",
    at: new Date().toISOString(),
    streamId: segment.streamId,
    segmentId: segment.segmentId,
    coachSessionId: segment.coachSessionId,
    attempt: segment.coachEnrichAttempts,
    bindingStatus: bound.status || null,
    bindingReason: bound.binding?.reason || null,
    uii: bound.session.metadata?.uii || "",
    caseId: bound.session.metadata?.caseId || "",
    queueItemId: bound.session.metadata?.queueItemId || "",
  });
  return bound;
}

async function ensureCoachSession(segment, options = {}) {
  if (segment.role !== "prospect") return null;
  if (isLiveCoachKilled()) return null; // kill switch: never start a coach session / LLM call
  if (segment.coachSessionStarted) {
    // Unbound sessions keep trying to pick up CX metadata in the background.
    scheduleCoachBindingEnrichment(segment);
    return {
      status: "existing",
      binding: segment.coachBinding,
      session: {
        id: segment.coachSessionId,
        metadata: segment.coachSessionMetadata || segment.coachBinding?.metadata || {},
      },
    };
  }
  const forceBind = Boolean(options.forceBind);
  const hasBindIdentity = Boolean(
    segment.contactPhone ||
      segment.dialogIdentity?.uii ||
      segment.dialogIdentity?.queueItemId ||
      segment.dialogIdentity?.callSessionId ||
      segment.dialogIdentity?.agentExtensionId ||
      segment.dialogIdentity?.agentEmail,
  );
  const now = Date.now();
  if (!segment.allowUnboundCoachSessions && !hasBindIdentity) {
    if (!segment.nextCoachBindAt || now >= segment.nextCoachBindAt) {
      segment.nextCoachBindAt = now + 1500;
      writeJsonLine(segment.eventLog, {
        type: "coach.session.bind_wait",
        at: new Date().toISOString(),
        streamId: segment.streamId,
        segmentId: segment.segmentId,
        reason: "missing-call-identity",
      });
    }
    return null;
  }
  if (hasBindIdentity) {
    if (!forceBind && now < segment.nextCoachBindAt) return null;
    segment.coachBindAttempts += 1;
    segment.nextCoachBindAt = now + Math.min(5000, 1000 + segment.coachBindAttempts * 500);
    try {
      const identity = segment.dialogIdentity || {};
      const bindCallSessionId = identity.callSessionId && !isWorkflowStreamSessionId(identity.callSessionId)
        ? identity.callSessionId
        : "";
      const bindInput = compactObject({
        phone: segment.contactPhone,
        uii: identity.uii,
        callSessionId: bindCallSessionId,
        queueItemId: identity.queueItemId,
        agentExtensionId: identity.agentExtensionId,
        agentEmail: identity.agentEmail,
        caseId: identity.caseId,
        source: "grpc-live-bridge",
        streamId: segment.streamId,
        metadata: compactObject({
          streamId: segment.streamId,
          workflowInstanceId: segment.sessionId,
          dialogId: identity.dialogId,
          callSessionId: identity.callSessionId || segment.sessionId,
          uii: identity.uii,
          queueItemId: identity.queueItemId,
          agentExtensionId: identity.agentExtensionId,
          agentEmail: identity.agentEmail,
          caseId: identity.caseId,
          phone: segment.contactPhone,
        }),
      });
      const bound = await postJson(`${segment.aiBusUrl}/api/ai/live-coach/grpc/mongo/bind/latest`, {
        ...bindInput,
      }, 8000);
      if (bound?.session?.id) {
        segment.coachSessionId = bound.session.id;
        segment.coachSessionStarted = true;
        segment.coachBinding = bound.binding || null;
        segment.coachSessionMetadata = bound.session.metadata || null;
        // If the STT channels already connected (unbound start), give them the
        // per-call primer now that names are known.
        segment.realtimeStt?.updateTranscriptionPrompt?.(buildCallSttPrimer(segment));
        segment.turnStt?.updateTranscriptionPrompt?.(buildCallSttPrimer(segment));
        writeJsonLine(segment.eventLog, {
          type: "coach.session.bind",
          at: new Date().toISOString(),
          streamId: segment.streamId,
          segmentId: segment.segmentId,
          coachSessionId: segment.coachSessionId,
          phone: segment.contactPhone,
          callSessionId: bindInput.callSessionId || "",
          requestedUii: bindInput.uii || "",
          requestedQueueItemId: bindInput.queueItemId || "",
          requestedAgentExtension: bindInput.agentExtensionId || "",
          bindingStatus: bound.status || null,
          bindingReason: bound.binding?.reason || null,
          agentName: bound.session.metadata?.agentName || "",
          agentExtension: bound.session.metadata?.agentExtension || "",
          uii: bound.session.metadata?.uii || "",
        });
        return bound;
      }
      // STREAM 4 self-healing MISS->ADOPT (opt-in via LIVE_COACH_UII_ADOPT_ENABLED):
      // the bridge requested a uii that the mongo bridge says is stale
      // ('not_current'), and the response carries the agent's latest event uii.
      // Adoption overwrites the stream's identity with the event's — which is
      // backwards when the EVENT table is the stale side (missed workspace hook,
      // inbound call): it rebinds the live stream to a dead/closed call and locks
      // binding out for the whole call. Default OFF: log the drift instead and
      // fall through to bind_miss -> unbound fallback so coaching continues under
      // the stream's own (RingCX ground-truth) identity.
      const currentEvent = bound?.binding?.event || null;
      const adoptUii = cleanText(currentEvent?.uii || "", 160);
      const requestedUii = cleanText(segment.dialogIdentity?.uii || "", 160);
      const uiiDrifted =
        String(bound?.status || "") === "not_current" &&
        adoptUii &&
        adoptUii !== requestedUii;
      if (uiiDrifted && !segment.uiiAdoptEnabled) {
        writeJsonLine(segment.eventLog, {
          type: "coach.session.uii_drift",
          at: new Date().toISOString(),
          streamId: segment.streamId,
          segmentId: segment.segmentId,
          streamUii: requestedUii || null,
          latestEventUii: adoptUii,
          queueItemId: cleanText(currentEvent?.queueItemId || "", 160) || null,
          adoption: "disabled",
        });
      }
      if (uiiDrifted && segment.uiiAdoptEnabled) {
        segment.dialogIdentity = {
          ...(segment.dialogIdentity || {}),
          uii: adoptUii,
        };
        const adoptQueueItemId = cleanText(currentEvent?.queueItemId || "", 160);
        const adoptCallSessionId = cleanText(currentEvent?.callSessionId || "", 160);
        if (adoptQueueItemId) segment.dialogIdentity.queueItemId = adoptQueueItemId;
        if (adoptCallSessionId) segment.dialogIdentity.callSessionId = adoptCallSessionId;
        writeJsonLine(segment.eventLog, {
          type: "coach.session.uii_adopted",
          at: new Date().toISOString(),
          streamId: segment.streamId,
          segmentId: segment.segmentId,
          coachSessionId: segment.coachSessionId,
          fromUii: requestedUii || null,
          toUii: adoptUii,
          queueItemId: adoptQueueItemId || null,
          callSessionId: adoptCallSessionId || null,
        });
        // Advance the existing backoff so the next attempt rebinds promptly with
        // the adopted identity rather than spinning. Return non-terminal (null).
        segment.coachBindAttempts += 1;
        segment.nextCoachBindAt = now + Math.min(5000, 1000 + segment.coachBindAttempts * 500);
        return null;
      }
      writeJsonLine(segment.eventLog, {
        type: "coach.session.bind_miss",
        at: new Date().toISOString(),
        streamId: segment.streamId,
        segmentId: segment.segmentId,
        phone: segment.contactPhone,
        callSessionId: segment.dialogIdentity?.callSessionId || segment.sessionId || "",
        uii: segment.dialogIdentity?.uii || "",
        queueItemId: segment.dialogIdentity?.queueItemId || "",
        status: bound?.status || null,
        reason: bound?.reason || null,
        allowUnboundCoachSessions: Boolean(segment.allowUnboundCoachSessions),
      });
      const bindMissStatus = String(bound?.status || "").trim().toLowerCase();
      const bindMissReason = String(bound?.reason || bound?.binding?.reason || "").trim().toLowerCase();
      if (
        TERMINAL_COACH_BIND_MISS_STATUSES.has(bindMissStatus) ||
        TERMINAL_COACH_BIND_MISS_STATUSES.has(bindMissReason)
      ) {
        segment.coachTerminal = true;
        writeJsonLine(segment.eventLog, {
          type: "coach.session.bind_miss_terminal",
          at: new Date().toISOString(),
          streamId: segment.streamId,
          segmentId: segment.segmentId,
          status: bound?.status || null,
          reason: bound?.reason || bound?.binding?.reason || null,
        });
        return null;
      }
      if (!segment.allowUnboundCoachSessions) return null;
    } catch (error) {
      writeJsonLine(segment.eventLog, {
        type: "coach.session.bind_error",
        at: new Date().toISOString(),
        streamId: segment.streamId,
        segmentId: segment.segmentId,
        phone: segment.contactPhone,
        callSessionId: segment.dialogIdentity?.callSessionId || segment.sessionId || "",
        uii: segment.dialogIdentity?.uii || "",
        queueItemId: segment.dialogIdentity?.queueItemId || "",
        error: error.message,
        allowUnboundCoachSessions: Boolean(segment.allowUnboundCoachSessions),
      });
      if (!segment.allowUnboundCoachSessions) return null;
    }
  } else if (!segment.allowUnboundCoachSessions) {
    return null;
  }
  const result = await postJson(`${segment.aiBusUrl}/api/ai/live-coach/grpc/start`, {
    sessionId: segment.coachSessionId,
    source: "grpc-live-bridge",
    streamId: segment.streamId,
    workflowInstanceId: segment.sessionId,
    uii: segment.dialogIdentity?.uii || "",
    callSessionId: segment.dialogIdentity?.callSessionId || segment.sessionId || "",
    queueItemId: segment.dialogIdentity?.queueItemId || "",
    agentExtensionId: segment.dialogIdentity?.agentExtensionId || "",
    agentEmail: segment.dialogIdentity?.agentEmail || "",
    phone: segment.contactPhone,
    contactName: segment.participant?.name || "",
    firmName: "Wynn Tax Solutions",
  });
  segment.coachSessionStarted = true;
  segment.coachSessionMetadata = result.session?.metadata || null;
  writeJsonLine(segment.eventLog, {
    type: "coach.session.start",
    at: new Date().toISOString(),
    streamId: segment.streamId,
    segmentId: segment.segmentId,
    coachSessionId: segment.coachSessionId,
    aiBusSessionId: result.session?.id || null,
  });
  return result;
}

async function postTranscript(segment, transcript, input = {}) {
  if (segment.role !== "prospect") return null;
  const itemId = cleanText(input.itemId || input.chunkId || "", 160) || null;
  return postCoachInput(segment, () => ({
    text: transcript.text,
    role: "prospect",
    source: input.source || "grpc-stt-chunk",
    provider: transcript.provider || "openai",
    model: transcript.model || segment.sttModel,
    itemId,
    final: true,
    durationSec: input.durationSec || null,
    confidence: transcript.confidence || null,
    ...coachPostIdentity(segment),
    asyncContextPipeline: true,
  }), 20_000, { forceBind: input.forceBind === true });
}

async function postProvisionalTranscript(segment, transcript, input = {}) {
  if (segment.role !== "prospect") return null;
  const itemId = cleanText(input.itemId || transcript.itemId || transcript.item_id || input.chunkId || "", 160) || null;
  if (isRealtimeItemCompleted(segment, itemId)) return null;
  return postCoachInput(segment, () => isRealtimeItemCompleted(segment, itemId) ? null : ({
    text: transcript.text,
    role: "prospect",
    source: input.source || "grpc-openai-realtime-delta",
    provider: transcript.provider || "openai-realtime",
    model: transcript.model || segment.sttModel,
    itemId,
    type: "conversation.item.input_audio_transcription.delta",
    provisional: true,
    final: false,
    durationSec: input.durationSec || null,
    confidence: transcript.confidence || null,
    ...coachPostIdentity(segment),
  }), 8000);
}

async function postProvisionalTranscriptPreview(segment, transcript, input = {}) {
  if (segment.role !== "prospect") return 0;
  const text = cleanText(transcript.text || "", 2000);
  if (!text || segment.provisionalPreviewMs <= 0) return 0;
  await ensureCoachSession(segment);
  if (!segment.coachSessionStarted || !segment.coachSessionId) return 0;
  const chunks = buildProvisionalPreviewChunks(text, {
    maxChunks: segment.provisionalPreviewChunks,
  });
  const itemId = cleanText(input.itemId || input.chunkId || `preview-${segment.chunkCount}`, 160);
  const delayMs = chunks.length > 1
    ? Math.max(0, Math.floor(segment.provisionalPreviewMs / chunks.length))
    : Math.max(0, segment.provisionalPreviewMs);
  let posted = 0;
  for (const chunk of chunks) {
    if (segment.coachTerminal) break;
    await postCoachInput(segment, () => ({
      text: chunk,
      role: "prospect",
      source: "grpc-stt-preview",
      provider: transcript.provider || "openai",
      model: transcript.model || segment.sttModel,
      itemId,
      type: "conversation.item.input_audio_transcription.delta",
      provisional: true,
      final: false,
      durationSec: input.durationSec || null,
      confidence: transcript.confidence || null,
      ...coachPostIdentity(segment),
    }), 8000);
    posted += 1;
    if (delayMs) await sleep(delayMs);
  }
  return posted;
}

async function postStreamStatus(segment, input = {}) {
  if (segment.role !== "prospect") return null;
  return postCoachStreamStatus(segment, () => ({
    role: "prospect",
    source: "grpc-audio-status",
    segmentId: segment.segmentId,
    mediaCount: segment.mediaCount,
    rawBytes: segment.rawBytes,
    durationSec: segment.rate ? Number((segment.rawBytes / segment.rate).toFixed(2)) : null,
    activePct: input.activePct || 0,
    rms: input.rms || 0,
    maxAbs: input.maxAbs || 0,
    state: input.state || "audio-receiving",
    // Binding visibility: "bound" (CX event matched), "unbound" (coaching on
    // stream identity only, enrichment retrying), or "binding" (not started).
    bindState: segment.coachBinding ? "bound" : segment.coachSessionStarted ? "unbound" : "binding",
    bindReason: segment.coachBinding?.reason || "",
    pendingDroppedBytes: segment.pendingRealtimeDroppedBytes || 0,
    ...coachPostIdentity(segment),
  }), 5000, { forceBind: input.forceBind === true });
}

// Domain primer for the realtime transcription prompt. A previous primer was
// disabled because Whisper-family models echoed it over silence/noise; that
// echo vector is now blocked upstream by the energy gate (MIN_STT_ACTIVE_PCT)
// and the low-signal filters, so the primer is back on by default for tax-term
// accuracy (CP504 vs "CP five oh four" at the source instead of regex repair).
// Keep it SHORT (vocabulary list, not instructions). Disable with
// LIVE_COACH_STT_DOMAIN_PRIMER_ENABLED=false or override via LIVE_COACH_STT_PROMPT.
const DEFAULT_STT_DOMAIN_PRIMER = [
  "CP504", "CP503", "CP501", "LT11", "Letter 1058",
  "levy", "lien", "wage garnishment", "offer in compromise",
  "installment agreement", "currently not collectible", "penalty abatement",
  "unfiled returns", "941", "1099", "W-2", "revenue officer",
  "Wynn Tax Solutions",
].join(", ");

// Per-call primer: prospect + agent names prepended to the domain vocabulary.
// Names are the most-misheard class on 8kHz carrier audio and we KNOW them at
// bind time — tell the engine who is on the phone. Vocabulary-list style only
// (instructions get echoed; see the primer note above).
function buildCallSttPrimer(segment) {
  const base = cleanText(segment?.sttDomainPrimer || "", 700);
  const names = [
    cleanText(segment?.coachSessionMetadata?.contactName || segment?.participant?.name || "", 80),
    cleanText(segment?.coachSessionMetadata?.agentName || segment?.coachBinding?.metadata?.agentName || "", 80),
  ].filter(Boolean);
  if (!names.length) return base;
  return [...new Set(names), base].filter(Boolean).join(", ");
}

// Primer-echo detector: the known failure mode of transcription prompts is the
// model "reading the bank back" over noise/silence — and since the primer
// vocabulary IS the deterministic match vocabulary, an echoed bank self-matches
// downstream and ships junk coach lines. Flag finals whose content words are
// mostly primer vocabulary when the engine itself wasn't confident.
function detectPrimerEcho(text, primer, confidence) {
  if (!text || !primer) return false;
  if (confidence !== null && confidence >= 0.6) return false; // confident speech is speech
  const primerWords = new Set(
    String(primer).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3),
  );
  if (!primerWords.size) return false;
  const contentWords = String(text).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4);
  if (contentWords.length < 3) return false;
  const hits = contentWords.filter((w) => primerWords.has(w)).length;
  return hits / contentWords.length >= 0.75;
}

// Average token logprob -> a 0..1 confidence. null when logprobs are absent.
function realtimeTranscriptConfidence(event) {
  const rows = Array.isArray(event?.logprobs) ? event.logprobs : [];
  const values = rows
    .map((row) => Number(row?.logprob))
    .filter((value) => Number.isFinite(value));
  if (!values.length) return null;
  const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Number(Math.min(1, Math.max(0, Math.exp(avg))).toFixed(4));
}

class OpenAiRealtimeSttChannel {
  constructor({
    segment,
    apiKey,
    model,
    language,
    turnDetection,
    semanticEagerness,
    noiseReduction,
    provisionalEnabled = true,
    maxBufferedBytes = 240_000,
    transcriptionPrompt = "",
    includeLogprobs = true,
    channelTag = "",
    serverVadSilenceMsOverride = 0,
  } = {}) {
    if (!apiKey) throw new Error("OPENAI_API_KEY is missing for realtime transcription");
    this.segment = segment;
    this.apiKey = apiKey;
    this.role = segment?.role || "prospect";
    // Dual-VAD channel identity: "fast" (server_vad additive) | "turn"
    // (semantic completed thoughts — the compose trigger). Rides every post.
    this.channelTag = cleanText(channelTag || "", 20);
    this.model = model || "gpt-4o-transcribe";
    this.language = language || "en";
    this.turnDetection = turnDetection || "semantic_vad";
    this.turnDetectionSupported = openAiRealtimeTranscriptionSupportsTurnDetection(this.model);
    this.semanticEagerness = semanticEagerness || "high";
    this.noiseReduction = noiseReduction || "near_field";
    this.transcriptionPrompt = cleanText(transcriptionPrompt || "", 800);
    this.includeLogprobs = includeLogprobs !== false;
    // Finals whose average token confidence falls below this are dropped (with a
    // log). exp(avg logprob) ~= 0.25 corresponds to clearly degraded audio; real
    // telephone speech sits well above it. 0 disables the gate.
    this.minConfidence = Math.min(
      0.95,
      Math.max(0, Number(process.env.LIVE_COACH_STT_MIN_CONFIDENCE ?? "0.25") || 0),
    );
    // 600ms default (was 1000): every prospect final lands ~0.4s sooner, which
    // every downstream stage inherits. The cost is more mid-thought splits —
    // completeness is the composer's WAIT call, so splits hold less risk than
    // they used to. Tune live via LIVE_COACH_OPENAI_SERVER_VAD_SILENCE_MS.
    this.serverVadSilenceMs = serverVadSilenceMsOverride > 0
      ? Math.max(200, Math.min(3000, serverVadSilenceMsOverride))
      : Math.max(
        200,
        Math.min(3000, Number(process.env.LIVE_COACH_OPENAI_SERVER_VAD_SILENCE_MS || "600") || 600),
      );
    this.provisionalEnabled = provisionalEnabled !== false;
    this.maxBufferedBytes = Math.max(8000, Number(maxBufferedBytes) || 240_000);
    this.ws = null;
    this.ready = false;
    this.closed = false;
    this.sessionId = "";
    this.disabled = false;
    this.itemTextById = new Map();
    this.completedItemIds = new Set();
    this.completionGeneration = 0;
    this.completionWaiters = [];
    this.pendingProvisionalByItemId = new Map();
    this.provisionalFlushTimer = null;
    this.provisionalPostInFlight = false;
    this.lastProvisionalPostAtMs = 0;
    this.provisionalPostIntervalMs = Math.max(
      0,
      Math.min(1000, Number(process.env.LIVE_COACH_REALTIME_PROVISIONAL_MIN_MS || "50") || 0),
    );
    this.completionWaitMs = Math.max(
      500,
      Math.min(8000, Number(process.env.LIVE_COACH_REALTIME_COMPLETION_WAIT_MS || "3000") || 3000),
    );
    this.pendingPayloads = [];
    this.pendingPayloadBytes = 0;
    this.bytesSinceCommit = 0;
    this.manualCommitMs = this.turnDetectionSupported
      ? 0
      : Math.max(
        500,
        Math.min(5000, Number(process.env.LIVE_COACH_REALTIME_MANUAL_COMMIT_MS || "1200") || 1200),
      );
    this.manualCommitTimer = null;
    this.connectPromise = null;
    this.eventQueue = Promise.resolve();
  }

  connect() {
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = new Promise((resolve, reject) => {
      const protocols = openAiRealtimeProtocols(this.apiKey);
      this.ws = new WebSocket(OPENAI_REALTIME_TRANSCRIPTION_URL, protocols);
      this.ws.addEventListener("open", () => {
        this.send({
          type: "session.update",
          session: {
            type: "transcription",
            // Per-token logprobs ride along on completed transcripts so finals
            // can be confidence-gated instead of word-blacklisted.
            ...(this.includeLogprobs ? { include: ["item.input_audio_transcription.logprobs"] } : {}),
            audio: {
              input: {
                format: { type: "audio/pcmu" },
                noise_reduction: this.noiseReduction === "off" || this.noiseReduction === "none"
                  ? null
                  : { type: this.noiseReduction },
                transcription: {
                  model: this.model,
                  language: this.language,
                  // Short domain vocabulary primer (see DEFAULT_STT_DOMAIN_PRIMER).
                  ...(this.transcriptionPrompt ? { prompt: this.transcriptionPrompt } : {}),
                },
                turn_detection: this.buildTurnDetection(),
              },
            },
          },
        });
      });
      this.ws.addEventListener("message", (event) => this.handleMessage(event.data));
      this.ws.addEventListener("error", () => {
        const error = new Error("OpenAI realtime transcription websocket error");
        writeJsonLine(this.segment.eventLog, {
          type: "stt.realtime.error",
          at: new Date().toISOString(),
          streamId: this.segment.streamId,
          segmentId: this.segment.segmentId,
          error: error.message,
        });
        reject(error);
      });
      this.ws.addEventListener("close", (event) => {
        this.closed = true;
        this.ready = false;
        writeJsonLine(this.segment.eventLog, {
          type: "stt.realtime.close",
          at: new Date().toISOString(),
          streamId: this.segment.streamId,
          segmentId: this.segment.segmentId,
          code: event.code || null,
          reason: event.reason || "",
        });
      });
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    return this.connectPromise;
  }

  // Per-call primer refresh: when the binding (and with it the prospect/agent
  // names) arrives after the channel connected, re-send the transcription
  // prompt so the engine knows who is on the phone. Vocabulary-list style
  // only — same echo-safety rules as DEFAULT_STT_DOMAIN_PRIMER.
  updateTranscriptionPrompt(prompt) {
    const next = cleanText(prompt || "", 800);
    if (!next || next === this.transcriptionPrompt) return false;
    this.transcriptionPrompt = next;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.send({
        type: "session.update",
        session: {
          type: "transcription",
          audio: {
            input: {
              transcription: {
                model: this.model,
                language: this.language,
                prompt: next,
              },
            },
          },
        },
      });
      writeJsonLine(this.segment.eventLog, {
        type: "stt.realtime.prompt_update",
        at: new Date().toISOString(),
        streamId: this.segment.streamId,
        segmentId: this.segment.segmentId,
        promptLength: next.length,
      });
      return true;
    } catch {
      return false;
    }
  }

  buildTurnDetection() {
    if (!this.turnDetectionSupported) return null;
    if (this.turnDetection === "off" || this.turnDetection === "none" || this.turnDetection === "manual") return null;
    if (this.turnDetection === "server_vad") {
      return {
        type: "server_vad",
        threshold: 0.5,
        prefix_padding_ms: 300,
        silence_duration_ms: this.serverVadSilenceMs,
        create_response: false,
        interrupt_response: false,
      };
    }
    return {
      type: "semantic_vad",
      eagerness: this.semanticEagerness,
      create_response: false,
      interrupt_response: false,
    };
  }

  send(payload) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("OpenAI realtime transcription websocket is not open");
    }
    this.ws.send(JSON.stringify(payload));
  }

  appendPcmu(payload) {
    if (this.disabled || this.closed || !payload?.length) return;
    if (!this.connectPromise) this.connect().catch(() => {});
    if (!this.ready) {
      this.pendingPayloads.push(Buffer.from(payload));
      this.pendingPayloadBytes += payload.length;
      while (this.pendingPayloadBytes > this.maxBufferedBytes && this.pendingPayloads.length) {
        const removed = this.pendingPayloads.shift();
        this.pendingPayloadBytes -= removed.length;
      }
      return;
    }
    this.sendAudio(payload);
  }

  sendAudio(payload) {
    if (this.disabled) return;
    try {
      this.send({
        type: "input_audio_buffer.append",
        audio: Buffer.from(payload).toString("base64"),
      });
      this.bytesSinceCommit += payload.length;
    } catch (error) {
      writeJsonLine(this.segment.eventLog, {
        type: "stt.realtime.append_error",
        at: new Date().toISOString(),
        streamId: this.segment.streamId,
        segmentId: this.segment.segmentId,
        error: error.message,
      });
    }
  }

  flushBufferedAudio() {
    const pending = this.pendingPayloads;
    this.pendingPayloads = [];
    this.pendingPayloadBytes = 0;
    for (const payload of pending) this.sendAudio(payload);
  }

  startManualCommitLoop() {
    if (!this.manualCommitMs || this.manualCommitTimer) return;
    this.manualCommitTimer = setInterval(() => {
      if (this.disabled || this.closed || !this.ready) return;
      if (this.bytesSinceCommit <= 0) return;
      this.commitInputBuffer("manual-commit");
    }, this.manualCommitMs);
    if (typeof this.manualCommitTimer.unref === "function") this.manualCommitTimer.unref();
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
      if (event.type === "session.updated") {
        this.ready = true;
        writeJsonLine(this.segment.eventLog, {
          type: "stt.realtime.ready",
          at: new Date().toISOString(),
          streamId: this.segment.streamId,
          segmentId: this.segment.segmentId,
          sessionId: this.sessionId,
          turnDetection: this.turnDetection,
          semanticEagerness: this.semanticEagerness,
          bufferedBytes: this.pendingPayloadBytes,
          model: this.model,
          turnDetectionSupported: this.turnDetectionSupported,
          manualCommitMs: this.manualCommitMs,
        });
        this.flushBufferedAudio();
        this.startManualCommitLoop();
        if (this.resolveReady) {
          this.resolveReady(event.session || {});
          this.resolveReady = null;
          this.rejectReady = null;
        }
      }
      return;
    }
    if (event.type === "input_audio_buffer.speech_started" || event.type === "input_audio_buffer.speech_stopped") {
      writeJsonLine(this.segment.eventLog, {
        type: `stt.realtime.${event.type.split(".").pop()}`,
        at: new Date().toISOString(),
        streamId: this.segment.streamId,
        segmentId: this.segment.segmentId,
        itemId: event.item_id || null,
        audioStartMs: event.audio_start_ms || null,
        audioEndMs: event.audio_end_ms || null,
      });
      return;
    }
    if (event.type === "conversation.item.input_audio_transcription.delta") {
      const delta = cleanText(event.delta || "", 2000);
      if (!delta) return;
      try {
        this.handleDelta(event, delta);
      } catch (error) {
        writeJsonLine(this.segment.eventLog, {
          type: "stt.realtime.delta_error",
          at: new Date().toISOString(),
          streamId: this.segment.streamId,
          segmentId: this.segment.segmentId,
          error: error.message,
        });
      }
      return;
    }
    if (event.type === "conversation.item.input_audio_transcription.completed") {
      const text = cleanText(event.transcript || "", 4000);
      this.markCompletionReceived(event.item_id || "");
      this.eventQueue = this.eventQueue.then(() => this.handleCompleted(event, text)).catch((error) => {
        writeJsonLine(this.segment.eventLog, {
          type: "stt.realtime.completed_error",
          at: new Date().toISOString(),
          streamId: this.segment.streamId,
          segmentId: this.segment.segmentId,
          error: error.message,
        });
      });
      return;
    }
    if (event.type === "error") {
      const message = event.error?.message || "OpenAI realtime transcription error";
      const code = event.error?.code ? ` (${event.error.code})` : "";
      const error = new Error(`${message}${code}`);
      writeJsonLine(this.segment.eventLog, {
        type: "stt.realtime.error",
        at: new Date().toISOString(),
        streamId: this.segment.streamId,
        segmentId: this.segment.segmentId,
        error: error.message,
      });
      if (this.rejectReady) this.rejectReady(error);
    }
  }

  markCompletionReceived(itemId = "") {
    this.completionGeneration += 1;
    const waiters = this.completionWaiters.splice(0);
    for (const waiter of waiters) {
      try {
        waiter.resolve({
          itemId,
          generation: this.completionGeneration,
        });
      } catch {
        // no-op
      }
    }
  }

  waitForCompletionAfter(generation, timeoutMs) {
    if (this.completionGeneration > generation) {
      return Promise.resolve({ generation: this.completionGeneration, immediate: true });
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const index = this.completionWaiters.indexOf(waiter);
        if (index >= 0) this.completionWaiters.splice(index, 1);
        resolve({ generation: this.completionGeneration, timedOut: true });
      }, Math.max(0, Number(timeoutMs) || 0));
      if (typeof timer.unref === "function") timer.unref();
      const waiter = {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
      };
      this.completionWaiters.push(waiter);
    });
  }

  handleTerminalPostError(error) {
    if (!isTerminalCoachPostError(error)) {
      return false;
    }
    this.segment.coachTerminal = true;
    this.disabled = true;
    writeJsonLine(this.segment.eventLog, {
      type: "stt.realtime.disabled",
      at: new Date().toISOString(),
      streamId: this.segment.streamId,
      segmentId: this.segment.segmentId,
      reason: error.message.slice(0, 240),
    });
    return true;
  }

  scheduleProvisionalFlush(delayMs = this.provisionalPostIntervalMs) {
    if (this.provisionalFlushTimer || this.disabled || this.segment.coachTerminal) return;
    this.provisionalFlushTimer = setTimeout(() => {
      this.provisionalFlushTimer = null;
      this.flushProvisionalPosts().catch((error) => {
        writeJsonLine(this.segment.eventLog, {
          type: "stt.realtime.delta_error",
          at: new Date().toISOString(),
          streamId: this.segment.streamId,
          segmentId: this.segment.segmentId,
          error: error.message,
        });
      });
    }, Math.max(0, Number(delayMs) || 0));
    if (typeof this.provisionalFlushTimer.unref === "function") this.provisionalFlushTimer.unref();
  }

  queueProvisionalPost(event, itemId, text) {
    if (this.completedItemIds.has(itemId)) return;
    this.pendingProvisionalByItemId.set(itemId, {
      eventId: event.event_id || "",
      itemId,
      text,
      queuedAt: new Date().toISOString(),
    });
    if (this.provisionalPostInFlight) return;
    const elapsed = Date.now() - this.lastProvisionalPostAtMs;
    const delayMs = this.lastProvisionalPostAtMs
      ? Math.max(0, this.provisionalPostIntervalMs - elapsed)
      : 0;
    this.scheduleProvisionalFlush(delayMs);
  }

  async flushProvisionalPosts() {
    if (this.provisionalPostInFlight || this.disabled || this.segment.coachTerminal) return;
    const entries = Array.from(this.pendingProvisionalByItemId.values())
      .filter((entry) => !this.completedItemIds.has(entry.itemId));
    this.pendingProvisionalByItemId.clear();
    if (!entries.length) return;

    this.provisionalPostInFlight = true;
    try {
      for (const entry of entries) {
        if (this.disabled || this.segment.coachTerminal || this.completedItemIds.has(entry.itemId)) continue;
        let posted = null;
        try {
          posted = await postProvisionalTranscript(this.segment, {
            text: entry.text,
            provider: "openai-realtime",
            model: this.model,
            itemId: entry.itemId,
            eventId: entry.eventId,
          });
        } catch (error) {
          if (this.handleTerminalPostError(error)) return;
          throw error;
        }
        if (!posted) {
          writeJsonLine(this.segment.eventLog, {
            type: "stt.realtime.delta_drop",
            at: new Date().toISOString(),
            streamId: this.segment.streamId,
            segmentId: this.segment.segmentId,
            itemId: entry.itemId,
            textLength: entry.text.length,
            reason: this.completedItemIds.has(entry.itemId) ? "final-already-committed" : "coach-session-not-bound",
          });
          continue;
        }
        this.lastProvisionalPostAtMs = Date.now();
        writeJsonLine(this.segment.eventLog, {
          type: "stt.realtime.delta",
          at: new Date().toISOString(),
          streamId: this.segment.streamId,
          segmentId: this.segment.segmentId,
          itemId: entry.itemId,
          text: entry.text,
          coachStatus: posted?.session?.status || null,
        });
      }
    } finally {
      this.provisionalPostInFlight = false;
      if (this.pendingProvisionalByItemId.size) this.scheduleProvisionalFlush();
    }
  }

  handleDelta(event, delta) {
    if (this.disabled || this.segment.coachTerminal) return;
    const itemId = cleanText(event.item_id || "unknown-item", 160);
    if (this.completedItemIds.has(itemId)) return;
    const text = cleanText(appendRealtimeTranscriptDelta(this.itemTextById.get(itemId) || "", delta), 4000);
    this.itemTextById.set(itemId, text);
    // Agent channel is context-only: accumulate silently (finals are what feed
    // the composer); no provisional machinery, no per-delta log spam.
    if (this.role === "agent") return;
    if (!this.provisionalEnabled) {
      writeJsonLine(this.segment.eventLog, {
        type: "stt.realtime.delta_buffered",
        at: new Date().toISOString(),
        streamId: this.segment.streamId,
        segmentId: this.segment.segmentId,
        itemId,
        textLength: text.length,
        reason: "provisional-disabled",
      });
      return;
    }
    if (isLowSignalTranscript(text)) {
      writeJsonLine(this.segment.eventLog, {
        type: "stt.realtime.delta_skip",
        at: new Date().toISOString(),
        streamId: this.segment.streamId,
        segmentId: this.segment.segmentId,
        itemId,
        text,
        reason: "low-signal-provisional",
      });
      return;
    }
    writeJsonLine(this.segment.eventLog, {
      type: "stt.realtime.delta_queued",
      at: new Date().toISOString(),
      streamId: this.segment.streamId,
      segmentId: this.segment.segmentId,
      itemId,
      text,
      textLength: text.length,
    });
    this.queueProvisionalPost(event, itemId, text);
  }

  async postCompletedWithBindRetry(event, itemId, text, confidence = null, lowConfidence = false, primerEcho = false) {
    const maxWaitMs = Math.max(
      0,
      Math.min(5000, Number(process.env.LIVE_COACH_REALTIME_FINAL_BIND_WAIT_MS || "2500") || 2500),
    );
    const startedAt = Date.now();
    let attempts = 0;
    for (;;) {
      attempts += 1;
      const posted = await postTranscript(this.segment, {
        text,
        provider: "openai-realtime",
        model: this.model,
        itemId,
        confidence,
        lowConfidence: lowConfidence || undefined,
        primerEcho: primerEcho || undefined,
        channel: this.channelTag || undefined,
      }, {
        source: "grpc-openai-realtime-semantic-vad",
        itemId,
        durationSec: null,
        forceBind: true,
      });
      if (posted || this.disabled || this.segment.coachTerminal) {
        if (posted && attempts > 1) {
          writeJsonLine(this.segment.eventLog, {
            type: "stt.realtime.completed_bind_retry_success",
            at: new Date().toISOString(),
            streamId: this.segment.streamId,
            segmentId: this.segment.segmentId,
            itemId,
            attempts,
            elapsedMs: Date.now() - startedAt,
          });
        }
        return posted;
      }
      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs >= maxWaitMs) {
        writeJsonLine(this.segment.eventLog, {
          type: "stt.realtime.completed_bind_miss",
          at: new Date().toISOString(),
          streamId: this.segment.streamId,
          segmentId: this.segment.segmentId,
          itemId,
          attempts,
          elapsedMs,
          maxWaitMs,
        });
        return null;
      }
      await sleep(Math.min(350, 100 + attempts * 75));
    }
  }

  async handleCompleted(event, text) {
    if (this.disabled || this.segment.coachTerminal) return;
    const itemId = cleanText(event.item_id || "unknown-item", 160);
    if (!text) text = cleanText(this.itemTextById.get(itemId) || "", 4000);
    this.bytesSinceCommit = 0;
    this.completedItemIds.add(itemId);
    this.pendingProvisionalByItemId.delete(itemId);
    this.itemTextById.delete(itemId);
    if (isLowSignalTranscript(text)) {
      writeJsonLine(this.segment.eventLog, {
        type: "stt.realtime.skip",
        at: new Date().toISOString(),
        streamId: this.segment.streamId,
        segmentId: this.segment.segmentId,
        itemId,
        text,
        reason: "low-signal-transcript",
      });
      return;
    }
    // Confidence MARK (was a gate): finals whose average token logprob marks
    // them as probable garble are DELIVERED with lowConfidence:true instead of
    // dropped — silent discards ate real speech on noisy carrier audio (a VM
    // greeting survived only as fragments at 0.10-0.24 and vanished entirely).
    // The UI grays marked rows; the models see the flag and weigh accordingly.
    const confidence = realtimeTranscriptConfidence(event);
    const lowConfidence = confidence !== null && this.minConfidence > 0 && confidence < this.minConfidence;
    const primerEcho = detectPrimerEcho(text, this.transcriptionPrompt, confidence);
    if (lowConfidence || primerEcho) {
      writeJsonLine(this.segment.eventLog, {
        type: primerEcho ? "stt.realtime.primer_echo" : "stt.realtime.low_confidence",
        at: new Date().toISOString(),
        streamId: this.segment.streamId,
        segmentId: this.segment.segmentId,
        itemId,
        text,
        confidence,
        minConfidence: this.minConfidence,
        role: this.role,
        delivered: true,
      });
    }
    if (this.role === "agent") {
      await this.postAgentCompleted(event, itemId, text, confidence, lowConfidence || primerEcho);
      return;
    }
    let posted = null;
    try {
      posted = await this.postCompletedWithBindRetry(event, itemId, text, confidence, lowConfidence || primerEcho, primerEcho);
    } catch (error) {
      if (this.handleTerminalPostError(error)) return;
      throw error;
    }
    if (TERMINAL_COACH_STATUSES.has(String(posted?.session?.status || ""))) {
      this.segment.coachTerminal = true;
      this.disabled = true;
    }
    writeJsonLine(this.segment.eventLog, {
      type: "stt.realtime.completed",
      at: new Date().toISOString(),
      streamId: this.segment.streamId,
      segmentId: this.segment.segmentId,
      itemId,
      text,
      channel: this.channelTag || "single",
      confidence,
      coachStatus: posted?.session?.status || null,
      coachAction: posted?.result?.action || null,
      usage: event.usage || null,
    });
    if (this.disabled) this.close();
  }

  // Agent-channel finals route into the PROSPECT segment's coach session as
  // role:"agent" rows — context for the Claude composer only (the pipeline
  // stores agent rows without triggering compose; the mini never sees them).
  async postAgentCompleted(event, itemId, text, confidence = null, lowConfidence = false) {
    const coachSegment = this.segment.getCoachSegment?.();
    if (!coachSegment || !coachSegment.coachSessionStarted || !coachSegment.coachSessionId) {
      writeJsonLine(this.segment.eventLog, {
        type: "stt.realtime.agent_skip",
        at: new Date().toISOString(),
        streamId: this.segment.streamId,
        segmentId: this.segment.segmentId,
        itemId,
        textLength: text.length,
        reason: coachSegment ? "prospect-session-not-started" : "no-prospect-segment",
      });
      return null;
    }
    let posted = null;
    try {
      posted = await postCoachInput(coachSegment, () => ({
        text,
        role: "agent",
        source: "grpc-agent-stt",
        provider: "openai-realtime",
        model: this.model,
        itemId: `agent-${itemId}`,
        final: true,
        confidence,
        lowConfidence: lowConfidence || undefined,
        channel: this.channelTag || undefined,
        ...coachPostIdentity(coachSegment),
      }), 8000);
    } catch (error) {
      writeJsonLine(this.segment.eventLog, {
        type: "stt.realtime.agent_post_error",
        at: new Date().toISOString(),
        streamId: this.segment.streamId,
        segmentId: this.segment.segmentId,
        itemId,
        error: error.message,
      });
      return null;
    }
    writeJsonLine(this.segment.eventLog, {
      type: "stt.realtime.agent_completed",
      at: new Date().toISOString(),
      streamId: this.segment.streamId,
      segmentId: this.segment.segmentId,
      itemId,
      text,
      confidence,
      coachSessionId: coachSegment.coachSessionId,
      coachStatus: posted?.session?.status || null,
    });
    return posted;
  }

  commitInputBuffer(reason = "segment-ended") {
    if (this.disabled || this.closed || !this.ready || this.ws?.readyState !== WebSocket.OPEN) return 0;
    if (this.bytesSinceCommit <= 0) return 0;
    // OpenAI rejects commits under 100ms of audio ("buffer too small" — 137
    // hits in one live log window). A sub-100ms tail is unusable anyway: drop
    // it instead of erroring. PCMU @8kHz = 8000 bytes/s, so 960B ≈ 120ms.
    if (this.bytesSinceCommit < 960) {
      this.bytesSinceCommit = 0;
      return 0;
    }
    const committedBytes = this.bytesSinceCommit;
    this.bytesSinceCommit = 0;
    try {
      this.send({ type: "input_audio_buffer.commit" });
      writeJsonLine(this.segment.eventLog, {
        type: "stt.realtime.commit",
        at: new Date().toISOString(),
        streamId: this.segment.streamId,
        segmentId: this.segment.segmentId,
        reason,
        committedBytes,
      });
      return committedBytes;
    } catch (error) {
      this.bytesSinceCommit += committedBytes;
      writeJsonLine(this.segment.eventLog, {
        type: "stt.realtime.commit_error",
        at: new Date().toISOString(),
        streamId: this.segment.streamId,
        segmentId: this.segment.segmentId,
        reason,
        error: error.message,
      });
      return 0;
    }
  }

  close() {
    this.closed = true;
    if (this.manualCommitTimer) {
      clearInterval(this.manualCommitTimer);
      this.manualCommitTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close(1000, "segment ended");
      } catch {
        // no-op
      }
    }
  }

  async finish(reason = "segment-ended") {
    if (this.closed) return;
    if (this.ready && this.ws?.readyState === WebSocket.OPEN) {
      const completionGeneration = this.completionGeneration;
      const committedBytes = this.commitInputBuffer(reason);
      writeJsonLine(this.segment.eventLog, {
        type: "stt.realtime.finish",
        at: new Date().toISOString(),
        streamId: this.segment.streamId,
        segmentId: this.segment.segmentId,
        reason,
        committedBytes,
      });
      if (committedBytes > 0) {
        const waitResult = await this.waitForCompletionAfter(completionGeneration, this.completionWaitMs);
        writeJsonLine(this.segment.eventLog, {
          type: "stt.realtime.finish_wait",
          at: new Date().toISOString(),
          streamId: this.segment.streamId,
          segmentId: this.segment.segmentId,
          reason,
          committedBytes,
          completionGenerationBefore: completionGeneration,
          completionGenerationAfter: this.completionGeneration,
          timedOut: !!waitResult?.timedOut,
        });
      }
      await Promise.race([
        this.eventQueue.catch(() => null),
        sleep(this.completionWaitMs),
      ]);
    }
    this.close();
  }
}

function queueFlush(segment, reason = "interval") {
  if (!segment.pendingPcmBuffers.length) return;
  if (segment.role === "prospect" && segment.coachTerminal) {
    segment.pendingPcmBuffers = [];
    segment.pendingRawBytes = 0;
    return;
  }
  const pendingPcmBuffers = segment.pendingPcmBuffers;
  const pendingRawBytes = segment.pendingRawBytes;
  segment.pendingPcmBuffers = [];
  segment.pendingRawBytes = 0;
  segment.chunkCount += 1;
  const chunkId = `${segment.streamId}-${segment.segmentId || "segment"}-${String(segment.chunkCount).padStart(4, "0")}`
    .replace(/[^a-z0-9_.@-]+/gi, "-")
    .slice(0, 180);
  const wav = wavBufferFromPcmBuffers(pendingPcmBuffers, segment.rate);
  const wavPath = path.join(segment.dir, `${chunkId}.wav`);
  fs.writeFileSync(wavPath, wav);
  writeJsonLine(segment.eventLog, {
    type: "stt.chunk",
    at: new Date().toISOString(),
    streamId: segment.streamId,
    segmentId: segment.segmentId,
    role: segment.role,
    reason,
    chunkId,
    rawBytes: pendingRawBytes,
    wavPath,
  });

  segment.transcribeQueue = segment.transcribeQueue
    .then(async () => {
      if (segment.coachTerminal) return null;
      if (segment.role !== "prospect") return null;
      const started = Date.now();
      // Gate on audio energy BEFORE STT -- never transcribe non-speech.
      const activity = measurePcm16Activity(pendingPcmBuffers);
      if (MIN_STT_ACTIVE_PCT > 0 && activity.activePctOver500 < MIN_STT_ACTIVE_PCT) {
        writeJsonLine(segment.eventLog, {
          type: "stt.skip",
          at: new Date().toISOString(),
          streamId: segment.streamId,
          segmentId: segment.segmentId,
          chunkId,
          reason: "low-signal-audio",
          activePctOver500: activity.activePctOver500,
          maxAbs: activity.maxAbs,
          minActivePct: MIN_STT_ACTIVE_PCT,
        });
        return null;
      }
      const transcript = await transcribeSalesTrainerAudio({
        buffer: wav,
        mimeType: "audio/wav",
        filename: `${chunkId}.wav`,
        language: segment.language,
        model: segment.sttModel,
        responseFormat: "json",
        includeDomainPrimer: false, // no jargon prompt -> nothing for the model to echo
        timeoutMs: 20_000,
      });
      const text = cleanText(transcript.text || "", 2000);
      if (isLowSignalTranscript(text)) {
        writeJsonLine(segment.eventLog, {
          type: "stt.skip",
          at: new Date().toISOString(),
          streamId: segment.streamId,
          segmentId: segment.segmentId,
          chunkId,
          text,
          elapsedMs: Date.now() - started,
        });
        return null;
      }
      const previewCount = await postProvisionalTranscriptPreview(segment, {
        ...transcript,
        text,
        provider: "openai",
      }, {
        durationSec: pendingRawBytes / Math.max(1, segment.rate),
        chunkId,
        itemId: chunkId,
      });
      const posted = await postTranscript(segment, {
        ...transcript,
        text,
        provider: "openai",
      }, {
        durationSec: pendingRawBytes / Math.max(1, segment.rate),
        chunkId,
        itemId: chunkId,
      });
      if (TERMINAL_COACH_STATUSES.has(String(posted?.session?.status || ""))) {
        segment.coachTerminal = true;
      }
      writeJsonLine(segment.eventLog, {
        type: "stt.done",
        at: new Date().toISOString(),
        streamId: segment.streamId,
        segmentId: segment.segmentId,
        chunkId,
        text,
        previewCount,
        elapsedMs: Date.now() - started,
        coachStatus: posted?.session?.status || null,
        coachAction: posted?.result?.action || null,
      });
      return posted;
    })
    .catch((error) => {
      if (isTerminalCoachPostError(error)) {
        segment.coachTerminal = true;
      }
      writeJsonLine(segment.eventLog, {
        type: segment.coachTerminal ? "stt.terminal" : "stt.error",
        at: new Date().toISOString(),
        streamId: segment.streamId,
        segmentId: segment.segmentId,
        chunkId,
        error: error.message,
      });
    });
}

async function stopCoachSession(segment, reason = "stream-end") {
  if (!segment.coachSessionStarted) return null;
  try {
    const boundUii = cleanText(
      segment.coachBinding?.metadata?.uii ||
        segment.coachBinding?.event?.uii ||
        segment.dialogIdentity?.uii ||
        "",
      160,
    );
    return await postJson(`${segment.aiBusUrl}/api/ai/live-coach/grpc/${encodeURIComponent(segment.coachSessionId)}/stop`, {
      reason,
      streamId: segment.streamId,
      workflowInstanceId: segment.sessionId,
      uii: boundUii,
      callSessionId: segment.dialogIdentity?.callSessionId || segment.sessionId || "",
      queueItemId: segment.dialogIdentity?.queueItemId || "",
      agentExtensionId: segment.dialogIdentity?.agentExtensionId || "",
      agentEmail: segment.dialogIdentity?.agentEmail || "",
    }, 8000);
  } catch (error) {
    writeJsonLine(segment.eventLog, {
      type: "coach.session.stop_error",
      at: new Date().toISOString(),
      streamId: segment.streamId,
      segmentId: segment.segmentId,
      coachSessionId: segment.coachSessionId,
      error: error.message,
    });
    return null;
  }
}

// STREAM 4 self-healing DRIFT->REBIND: while a coach session is bound, the agent
// may roll to a new call (new uii) without the bridge tearing down the segment.
// Periodically (throttled, piggybacked on transcript cadence) ask the mongo
// bridge for the agent's CURRENT uii using agent-only filters. If it changed,
// require the SAME new uii on 2 consecutive ticks (debounce) before tearing down
// the stale session and rebinding to the current call. Default OFF; inert unless
// LIVE_COACH_UII_RECONCILE_ENABLED is set.
async function reconcileCoachUii(segment) {
  if (!segment || !segment.uiiReconcileEnabled) return null;
  if (segment.role !== "prospect") return null;
  if (!segment.coachSessionStarted || segment.coachTerminal) return null;
  const agentExtensionId = cleanText(segment.dialogIdentity?.agentExtensionId || "", 80);
  const agentEmail = cleanText(segment.dialogIdentity?.agentEmail || "", 180);
  if (!agentExtensionId && !agentEmail) return null;
  const now = Date.now();
  if (segment.nextUiiReconcileAt && now < segment.nextUiiReconcileAt) return null;
  segment.nextUiiReconcileAt = now + segment.uiiReconcileIntervalMs;
  const boundUii = cleanText(
    segment.coachBinding?.metadata?.uii ||
      segment.coachBinding?.event?.uii ||
      segment.dialogIdentity?.uii ||
      "",
    160,
  );
  try {
    // AGENT-ONLY filters: no uii/callSessionId/queueItemId so we get whatever
    // call the agent is on right now, regardless of what we are bound to.
    const latest = await postJson(`${segment.aiBusUrl}/api/ai/live-coach/grpc/mongo/bind/latest`, compactObject({
      agentExtensionId,
      agentEmail,
      source: "grpc-live-bridge-reconcile",
      streamId: segment.streamId,
      // bind/latest would otherwise ensure/replace a coach session; this is a
      // read-only probe, so do not retire other sessions on our behalf.
      retireReplaced: false,
    }), 8000);
    const currentEvent = latest?.binding?.event || latest?.session?.metadata || null;
    const currentUii = cleanText(currentEvent?.uii || "", 160);
    if (!currentUii || currentUii === boundUii) {
      // No drift: clear any half-formed candidate.
      segment.uiiDriftCandidate = null;
      segment.uiiDriftConfirmCount = 0;
      return null;
    }
    // Drift detected. Debounce: require the SAME new uii on 2 consecutive ticks.
    if (segment.uiiDriftCandidate === currentUii) {
      segment.uiiDriftConfirmCount += 1;
    } else {
      segment.uiiDriftCandidate = currentUii;
      segment.uiiDriftConfirmCount = 1;
    }
    if (segment.uiiDriftConfirmCount < 2) {
      writeJsonLine(segment.eventLog, {
        type: "coach.uii.reconcile_candidate",
        at: new Date().toISOString(),
        streamId: segment.streamId,
        segmentId: segment.segmentId,
        coachSessionId: segment.coachSessionId,
        fromUii: boundUii || null,
        toUii: currentUii,
        confirmCount: segment.uiiDriftConfirmCount,
      });
      return null;
    }
    // Confirmed drift: tear down the stale session and rebind to current call.
    const currentQueueItemId = cleanText(currentEvent?.queueItemId || "", 160);
    const currentCallSessionId = cleanText(currentEvent?.callSessionId || "", 160);
    await stopCoachSession(segment, "uii-reconcile");
    resetCoachSessionAfterMissing(segment, "uii-reconcile");
    segment.dialogIdentity = {
      ...(segment.dialogIdentity || {}),
      uii: currentUii,
    };
    if (currentQueueItemId) segment.dialogIdentity.queueItemId = currentQueueItemId;
    if (currentCallSessionId) segment.dialogIdentity.callSessionId = currentCallSessionId;
    segment.uiiDriftCandidate = null;
    segment.uiiDriftConfirmCount = 0;
    await ensureCoachSession(segment, { forceBind: true });
    writeJsonLine(segment.eventLog, {
      type: "coach.uii.reconciled",
      at: new Date().toISOString(),
      streamId: segment.streamId,
      segmentId: segment.segmentId,
      coachSessionId: segment.coachSessionId,
      fromUii: boundUii || null,
      toUii: currentUii,
      queueItemId: currentQueueItemId || null,
      callSessionId: currentCallSessionId || null,
    });
    return { fromUii: boundUii || null, toUii: currentUii };
  } catch (error) {
    writeJsonLine(segment.eventLog, {
      type: "coach.uii.reconcile_error",
      at: new Date().toISOString(),
      streamId: segment.streamId,
      segmentId: segment.segmentId,
      coachSessionId: segment.coachSessionId,
      error: error.message,
    });
    return null;
  }
}

function createLiveCoachStreamingService({
  outDir,
  eventLog,
  aiBusUrl,
  chunkSec,
  provisionalPreviewMs,
  provisionalPreviewChunks,
  sttProvider,
  sttModel,
  sttModelMap,
  openAiApiKey,
  turnDetection,
  semanticEagerness,
  noiseReduction,
  realtimeProvisionalEnabled,
  allowUnboundCoachSessions,
  language,
  agentSttEnabled = false,
  agentSttModel = "",
  agentSemanticEagerness = "low",
  sttDomainPrimer = "",
  dualVadEnabled = false,
  fastSttModel = "",
  fastVadSilenceMs = 500,
  turnEagerness = "low",
}) {
  return {
    Stream(call, callback) {
      const streamId = `${stamp()}-${Math.random().toString(16).slice(2, 10)}`;
      const startedAt = new Date();
      const metadata = sanitizeMetadata(call.metadata?.getMap?.() || {});
      let auth = null;
      try {
        auth = requireBasicAuth(call);
      } catch (error) {
        writeJsonLine(eventLog, {
          type: "stream.auth_rejected",
          streamId,
          at: startedAt.toISOString(),
          metadata,
          message: error.message,
        });
        callback(error);
        return;
      }

      const segments = new Map();
      let dialogIdentity = {};
      let eventCount = 0;
      let mediaCount = 0;
      let mediaBytes = 0;
      let finalized = false;

      async function finalizeStream(reason = "stream-end", done = null, callbackError = null) {
        if (finalized) return;
        finalized = true;
        for (const segment of segments.values()) {
          // Mark stopped FIRST so the STT heal watchdog stands down — a
          // finalizing stream must never have its channels resurrected.
          segment.stopped = true;
          if (segment.sttHealTimer) {
            clearInterval(segment.sttHealTimer);
            segment.sttHealTimer = null;
          }
          queueFlush(segment, reason);
          if (segment.sttProvider === "openai-realtime") {
            segment.transcribeQueue = segment.transcribeQueue
              .then(() => segment.realtimeStt ? segment.realtimeStt : ensureRealtimeStt(segment, reason))
              .then(() => segment.realtimeStt ? segment.realtimeStt.finish(reason) : null)
              .then(() => segment.turnStt ? segment.turnStt.finish(reason) : null)
              .catch(() => null);
          }
          if (segment.pcmBuffers.length && !fs.existsSync(segment.wavPath)) {
            writeWav(segment.wavPath, segment.pcmBuffers, segment.rate || 8000);
          }
        }
        await Promise.all([...segments.values()].map((segment) => segment.transcribeQueue.catch(() => null)));
        for (const segment of segments.values()) {
          await stopCoachSession(segment, reason);
        }
        const endedAt = new Date();
        writeJsonLine(eventLog, {
          type: "stream.end",
          reason,
          streamId,
          startedAt: startedAt.toISOString(),
          endedAt: endedAt.toISOString(),
          elapsedMs: endedAt.getTime() - startedAt.getTime(),
          eventCount,
          mediaCount,
          mediaBytes,
          segments: [...segments.values()].map((segment) => ({
            sessionId: segment.sessionId,
            segmentId: segment.segmentId,
            role: segment.role,
            coachSessionId: segment.coachSessionId,
            rawBytes: segment.rawBytes,
            rawPath: segment.rawPath,
            wavPath: fs.existsSync(segment.wavPath) ? segment.wavPath : "",
          })),
        });
        console.log(`[coach-grpc] stream end ${streamId} reason=${reason} events=${eventCount} media=${mediaCount} bytes=${mediaBytes}`);
        if (typeof done === "function") done(callbackError || null, callbackError ? undefined : {});
      }

      console.log(`[coach-grpc] stream start ${streamId}`);
      writeJsonLine(eventLog, {
        type: "stream.start",
        streamId,
        at: startedAt.toISOString(),
        metadata,
        auth: auth?.enabled ? { enabled: true, user: auth.user } : { enabled: false },
      });

      call.on("data", (event) => {
        if (finalized) return;
        eventCount += 1;
        const sessionId = event.sessionId || "";
        const decoded = decodeEvent(event);
        const base = {
          type: "stream.event",
          streamId,
          eventCount,
          sessionId,
          at: new Date().toISOString(),
          ...decoded,
        };

        if (decoded.kind === "dialogInit") {
          dialogIdentity = extractDialogIdentity(decoded, sessionId);
          writeJsonLine(eventLog, {
            ...base,
            dialogIdentity: {
              dialogId: dialogIdentity.dialogId || "",
              callSessionId: dialogIdentity.callSessionId || "",
              uii: dialogIdentity.uii || "",
              queueItemId: dialogIdentity.queueItemId || "",
              agentExtensionId: dialogIdentity.agentExtensionId || "",
              agentEmail: dialogIdentity.agentEmail || "",
              phone: dialogIdentity.phone || "",
            },
          });
          return;
        }

        if (decoded.kind === "segmentStart") {
          const segment = createSegmentState({
            streamId,
            sessionId,
            segmentId: decoded.segmentId,
            decoded,
            outDir,
            aiBusUrl,
            chunkSec,
            provisionalPreviewMs,
            provisionalPreviewChunks,
            sttProvider,
            sttModel,
            sttModelMap,
            openAiApiKey,
            turnDetection,
            semanticEagerness,
            noiseReduction,
            realtimeProvisionalEnabled,
            allowUnboundCoachSessions,
            language,
            eventLog,
            dialogIdentity,
            agentSttEnabled,
            agentSttModel,
            agentSemanticEagerness,
            sttDomainPrimer,
            dualVadEnabled,
            fastSttModel,
            fastVadSilenceMs,
            turnEagerness,
            // Agent-channel finals route into this stream's prospect session.
            getCoachSegment: () => [...segments.values()].find(
              (candidate) => candidate.role === "prospect" && !candidate.coachTerminal,
            ) || null,
          });
          segments.set(decoded.segmentId, segment);
          writeJsonLine(segment.jsonPath, base);
          writeJsonLine(eventLog, {
            ...base,
            coachSessionId: segment.coachSessionId,
            role: segment.role,
          });
          console.log(`[coach-grpc] ${segment.role} segment stream=${streamId} session=${sessionId || "-"} segment=${decoded.segmentId || "-"}`);
          return;
        }

        if (decoded.kind === "segmentMedia") {
          mediaCount += 1;
          mediaBytes += decoded.payloadBytes;
          const media = event.segmentMedia || {};
          const audio = media.audioContent || {};
          const payload = audio.payload ? Buffer.from(audio.payload) : Buffer.alloc(0);
          const segment = segments.get(media.segmentId);
          if (segment && payload.length) {
            segment.mediaCount += 1;
            fs.appendFileSync(segment.rawPath, payload);
            segment.rawBytes += payload.length;
            if (segment.sttProvider !== "openai-realtime") {
              segment.pendingRawBytes += payload.length;
            }
            const pcm = pcm16FromPayload(payload, segment.codec);
            const packetActivity = pcm ? measurePcm16Activity([pcm]) : null;
            if (pcm) {
              segment.pcmBuffers.push(pcm);
              if (segment.sttProvider !== "openai-realtime") {
                segment.pendingPcmBuffers.push(pcm);
              }
            }
            if (
              segment.role === "prospect" &&
              Date.now() - segment.lastStreamStatusAtMs >= segment.streamStatusIntervalMs
            ) {
              segment.lastStreamStatusAtMs = Date.now();
              postStreamStatus(segment, {
                activePct: packetActivity?.activePctOver500 || 0,
                rms: packetActivity?.rms || 0,
                maxAbs: packetActivity?.maxAbs || 0,
                state: segment.realtimeStt ? "stt-ready-audio" : "audio-buffering",
              }).catch((error) => {
                writeJsonLine(segment.eventLog, {
                  type: "stream.status_error",
                  at: new Date().toISOString(),
                  streamId: segment.streamId,
                  segmentId: segment.segmentId,
                  error: error.message,
                });
              });
            }
            if (segment.sttProvider === "openai-realtime") {
              if (!segment.realtimeStt) {
                queueRealtimePayload(segment, payload);
                scheduleRealtimeSttStart(segment, "media");
              } else {
                flushPendingRealtimePayloads(segment, "media");
                segment.realtimeStt.appendPcmu(payload);
                segment.turnStt?.appendPcmu(payload);
              }
            } else if (segment.pendingRawBytes >= Math.max(1, segment.rate) * segment.chunkSec) {
              queueFlush(segment, "bytes");
            }
            if (mediaCount <= 5 || mediaCount % 100 === 0) {
              writeJsonLine(segment.jsonPath, base);
            }
          }
          if (mediaCount <= 5 || mediaCount % 100 === 0) {
            writeJsonLine(eventLog, base);
          }
          return;
        }

        if (decoded.kind === "segmentStop") {
          const segment = segments.get(decoded.segmentId);
          if (segment) {
            segment.stopped = true;
            queueFlush(segment, "segment-stop");
            if (segment.pcmBuffers.length) {
              writeWav(segment.wavPath, segment.pcmBuffers, segment.rate || 8000);
              base.wavPath = segment.wavPath;
              base.rawPath = segment.rawPath;
              base.rawBytes = segment.rawBytes;
            }
            writeJsonLine(segment.jsonPath, base);
            segment.transcribeQueue = segment.transcribeQueue
              .then(() => segment.realtimeStt ? segment.realtimeStt : ensureRealtimeStt(segment, "segment-stop"))
              .then(() => segment.realtimeStt ? segment.realtimeStt.finish("segment-stop") : null)
              .then(() => segment.turnStt ? segment.turnStt.finish("segment-stop") : null)
              .then(() => stopCoachSession(segment, "segment-stop"))
              .catch(() => null);
          }
        }

        writeJsonLine(eventLog, base);
      });

      call.on("end", () => {
        finalizeStream("stream-end", callback).catch((error) => {
          writeJsonLine(eventLog, {
            type: "stream.end_error",
            streamId,
            at: new Date().toISOString(),
            error: error.message,
          });
          callback(error);
        });
      });

      call.on("error", (error) => {
        writeJsonLine(eventLog, {
          type: "stream.error",
          streamId,
          at: new Date().toISOString(),
          message: error.message,
          code: error.code || null,
        });
        finalizeStream("stream-error").catch((cleanupError) => {
          writeJsonLine(eventLog, {
            type: "stream.error_cleanup_error",
            streamId,
            at: new Date().toISOString(),
            message: cleanupError.message,
          });
        });
      });
    },
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const port = Number(readFlag(argv, "--port", process.env.RINGCX_GRPC_LIVE_COACH_PORT || "3344")) || 3344;
  const aiBusUrl = String(readFlag(argv, "--ai-bus-url", process.env.AI_BUS_URL || "http://127.0.0.1:7000")).replace(/\/$/, "");
  const chunkSec = Math.max(1, Math.min(12, Number(readFlag(argv, "--chunk-sec", process.env.LIVE_COACH_GRPC_CHUNK_SECONDS || "3")) || 3));
  const provisionalPreviewMs = Math.max(
    0,
    Math.min(1000, Number(readFlag(argv, "--provisional-preview-ms", process.env.LIVE_COACH_GRPC_PROVISIONAL_PREVIEW_MS || "220")) || 0),
  );
  const provisionalPreviewChunks = Math.max(
    1,
    Math.min(8, Number(readFlag(argv, "--provisional-preview-chunks", process.env.LIVE_COACH_GRPC_PROVISIONAL_PREVIEW_CHUNKS || "4")) || 4),
  );
  const sttProvider = String(readFlag(argv, "--stt-provider", process.env.LIVE_COACH_STT_PROVIDER || "openai-realtime")).trim().toLowerCase();
  const sttModel = resolveSttModelAlias(readFlag(argv, "--stt-model", process.env.LIVE_COACH_STT_MODEL || process.env.SALES_TRAINER_STT_MODEL || "gpt-4o-transcribe"));
  const sttModelMap = parseSttModelMap(readFlag(argv, "--stt-model-map", process.env.LIVE_COACH_STT_MODEL_MAP || ""));
  const openAiApiKey = process.env.OPENAI_API_KEY || "";
  const turnDetection = String(readFlag(argv, "--turn-detection", process.env.LIVE_COACH_OPENAI_TURN_DETECTION || "semantic_vad")).trim().toLowerCase();
  const semanticEagerness = String(readFlag(argv, "--semantic-vad-eagerness", process.env.LIVE_COACH_OPENAI_SEMANTIC_EAGERNESS || "high")).trim().toLowerCase();
  const noiseReduction = String(readFlag(argv, "--noise-reduction", process.env.LIVE_COACH_OPENAI_NOISE_REDUCTION || "near_field")).trim().toLowerCase();
  const realtimeProvisionalEnabled = readBoolFlag(
    argv,
    "--realtime-provisional",
    !["0", "false", "no", "off", "disabled"].includes(String(process.env.LIVE_COACH_REALTIME_PROVISIONAL || "true").trim().toLowerCase()),
  );
  const allowUnboundCoachSessions = readBoolFlag(
    argv,
    "--allow-unbound-coach-session",
    // Default ON: a binding miss (no/stale cx.call.placed event, inbound call,
    // manual dial) must degrade to a thin-metadata session that still
    // transcribes and coaches — never to five minutes of silence. Set
    // LIVE_COACH_ALLOW_UNBOUND_SESSIONS=false to restore the strict gate.
    readEnvBool(process.env.LIVE_COACH_ALLOW_UNBOUND_SESSIONS, true),
  );
  // Agent channel: context-only transcription (cheap model, semantic VAD) whose
  // finals land in the prospect session as role:"agent" for the Claude composer.
  const agentSttEnabled = readBoolFlag(
    argv,
    "--agent-stt",
    readEnvBool(process.env.LIVE_COACH_AGENT_STT_ENABLED, true),
  );
  const agentSttModel = resolveSttModelAlias(
    readFlag(argv, "--agent-stt-model", process.env.LIVE_COACH_AGENT_STT_MODEL || "gpt-4o-mini-transcribe"),
    "gpt-4o-mini-transcribe",
  );
  const agentSemanticEagerness = String(
    readFlag(argv, "--agent-semantic-vad-eagerness", process.env.LIVE_COACH_AGENT_SEMANTIC_EAGERNESS || "low"),
  ).trim().toLowerCase();
  // DUAL-VAD (default ON): the prospect decodes twice — a fast server_vad
  // channel (cheap model, ~500ms finals: gates, term catching, ribbon, memory;
  // ADDITIVE, never composes) and a semantic_vad LOW-eagerness turn channel
  // (full model: completed thoughts — Claude's compose trigger).
  const dualVadEnabled = readBoolFlag(
    argv,
    "--dual-vad",
    readEnvBool(process.env.LIVE_COACH_DUAL_VAD_ENABLED, true),
  );
  const fastSttModel = resolveSttModelAlias(
    readFlag(argv, "--fast-stt-model", process.env.LIVE_COACH_FAST_STT_MODEL || "gpt-4o-mini-transcribe"),
    "gpt-4o-mini-transcribe",
  );
  const fastVadSilenceMs = Math.max(
    200,
    Math.min(2000, Number(readFlag(argv, "--fast-vad-silence-ms", process.env.LIVE_COACH_FAST_VAD_SILENCE_MS || "500")) || 500),
  );
  const turnEagerness = String(
    readFlag(argv, "--turn-eagerness", process.env.LIVE_COACH_TURN_EAGERNESS || "low"),
  ).trim().toLowerCase();
  const sttDomainPrimer = readEnvBool(process.env.LIVE_COACH_STT_DOMAIN_PRIMER_ENABLED, true)
    ? cleanText(process.env.LIVE_COACH_STT_PROMPT || DEFAULT_STT_DOMAIN_PRIMER, 800)
    : "";
  const language = readFlag(argv, "--language", process.env.LIVE_COACH_STT_LANGUAGE || process.env.SALES_TRAINER_STT_LANGUAGE || "en");
  MIN_STT_ACTIVE_PCT = Number(readFlag(argv, "--min-stt-active-pct", process.env.LIVE_COACH_MIN_STT_ACTIVE_PCT || "1")) || 0;
  const outDir = path.resolve(readFlag(argv, "--out-dir", path.join("runtime", "live-coach-grpc-bridge")));
  const protoPath = path.resolve(readFlag(argv, "--proto", path.join("scripts", "proto", "ringcx_streaming.proto")));
  ensureDir(outDir);
  ensureDir(path.join(outDir, "segments"));
  const eventLog = path.join(outDir, "events.ndjson");

  const ringcx = loadProto(protoPath);
  const server = new grpc.Server();
  server.addService(ringcx.Streaming.service, createLiveCoachStreamingService({
    outDir,
    eventLog,
    aiBusUrl,
    chunkSec,
    provisionalPreviewMs,
    provisionalPreviewChunks,
    sttProvider,
    sttModel,
    sttModelMap,
    openAiApiKey,
    turnDetection,
    semanticEagerness,
    noiseReduction,
    realtimeProvisionalEnabled,
    allowUnboundCoachSessions,
    language,
    agentSttEnabled,
    agentSttModel,
    agentSemanticEagerness,
    sttDomainPrimer,
    dualVadEnabled,
    fastSttModel,
    fastVadSilenceMs,
    turnEagerness,
  }));
  const bindAddress = `0.0.0.0:${port}`;
  server.bindAsync(bindAddress, grpc.ServerCredentials.createInsecure(), (error, boundPort) => {
    if (error) {
      console.error(error.stack || error.message);
      process.exit(1);
    }
    server.start();
    console.log("RingCX live coach gRPC bridge ready");
    console.log(`  address:    ${bindAddress}`);
    console.log(`  boundPort:  ${boundPort}`);
    console.log(`  ai bus:     ${aiBusUrl}`);
    console.log(`  chunk:      ${sttProvider === "openai-realtime" ? "semantic_vad realtime" : `${chunkSec}s`}`);
    console.log(`  preview:    ${sttProvider === "openai-realtime" ? (realtimeProvisionalEnabled ? "realtime deltas" : "semantic vad finals only") : provisionalPreviewMs ? `${provisionalPreviewChunks} chunks / ${provisionalPreviewMs}ms` : "off"}`);
    console.log(`  stt:        ${sttProvider}:${sttModel}`);
    console.log(`  agent stt:  ${agentSttEnabled ? `${agentSttModel} (semantic_vad ${agentSemanticEagerness}, context-only)` : "off"}`);
    console.log(`  stt primer: ${sttDomainPrimer ? `${sttDomainPrimer.split(",").length} terms` : "off"}`);
    if (sttModelMap.size) {
      console.log(`  stt map:    ${[...sttModelMap.entries()].map(([key, model]) => `${key}=${model}`).join(",")}`);
    }
    console.log(`  bind:       ${allowUnboundCoachSessions ? "allow-unbound-test" : "require-current-cx-call"}`);
    if (sttProvider === "openai-realtime") {
      console.log(`  vad:        ${turnDetection}${turnDetection === "semantic_vad" ? `/${semanticEagerness}` : ""}`);
    }
    console.log(`  eventLog:   ${eventLog}`);
  });

  const shutdown = () => {
    console.log("\n[coach-grpc] shutting down");
    server.tryShutdown(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Only auto-start the gRPC server when run directly. When required as a module
// (tests), export the self-healing helpers without booting anything.
if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}

module.exports = {
  createSegmentState,
  ensureCoachSession,
  postCoachInput,
  reconcileCoachUii,
  stopCoachSession,
  resetCoachSessionAfterMissing,
  readEnvBool,
};
