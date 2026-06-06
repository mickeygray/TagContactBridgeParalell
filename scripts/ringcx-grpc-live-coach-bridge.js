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
const OPENAI_REALTIME_TRANSCRIPTION_URL = "wss://api.openai.com/v1/realtime?intent=transcription";

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

function cleanText(value, maxLength = 4000) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  for (const buf of pcmBuffers || []) {
    for (let i = 0; i + 1 < buf.length; i += 2) {
      const a = Math.abs(buf.readInt16LE(i));
      total += 1;
      if (a > maxAbs) maxAbs = a;
      if (a > 500) active += 1;
    }
  }
  return { samples: total, maxAbs, activePctOver500: total ? Number(((active / total) * 100).toFixed(3)) : 0 };
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
  openAiApiKey,
  turnDetection,
  semanticEagerness,
  noiseReduction,
  realtimeProvisionalEnabled,
  allowUnboundCoachSessions,
  language,
  eventLog,
  dialogIdentity = {},
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
    sttModel,
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
    coachTerminal: false,
    realtimeStt: null,
    transcribeQueue: Promise.resolve(),
  };
  if (state.role === "prospect" && state.sttProvider === "openai-realtime") {
    state.realtimeStt = new OpenAiRealtimeSttChannel({
      segment: state,
      apiKey: state.openAiApiKey,
      model: state.sttModel,
      language: state.language,
      turnDetection: state.turnDetection,
      semanticEagerness: state.semanticEagerness,
      noiseReduction: state.noiseReduction,
      provisionalEnabled: state.realtimeProvisionalEnabled,
    });
    state.realtimeStt.connect().catch((error) => {
      writeJsonLine(state.eventLog, {
        type: "stt.realtime.connect_error",
        at: new Date().toISOString(),
        streamId: state.streamId,
        segmentId: state.segmentId,
        error: error.message,
      });
    });
  }
  return state;
}

async function ensureCoachSession(segment) {
  if (segment.coachSessionStarted || segment.role !== "prospect") return null;
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
    if (now < segment.nextCoachBindAt) return null;
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
    firmName: "Tax Advocate Group",
  });
  segment.coachSessionStarted = true;
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
  await ensureCoachSession(segment);
  if (!segment.coachSessionStarted || !segment.coachSessionId) return null;
  const boundUii = cleanText(
    segment.coachBinding?.metadata?.uii ||
      segment.coachBinding?.event?.uii ||
      segment.dialogIdentity?.uii ||
      "",
    160,
  );
  const itemId = cleanText(input.itemId || input.chunkId || "", 160) || null;
  return postJson(`${segment.aiBusUrl}/api/ai/live-coach/grpc/${encodeURIComponent(segment.coachSessionId)}/input`, {
    text: transcript.text,
    role: "prospect",
    source: input.source || "grpc-stt-chunk",
    provider: transcript.provider || "openai",
    model: transcript.model || segment.sttModel,
    itemId,
    final: true,
    durationSec: input.durationSec || null,
    confidence: transcript.confidence || null,
    streamId: segment.streamId,
    workflowInstanceId: segment.sessionId,
    uii: boundUii,
    callSessionId: segment.dialogIdentity?.callSessionId || segment.sessionId || "",
    queueItemId: segment.dialogIdentity?.queueItemId || "",
    agentExtensionId: segment.dialogIdentity?.agentExtensionId || "",
    agentEmail: segment.dialogIdentity?.agentEmail || "",
  }, 20_000);
}

async function postProvisionalTranscript(segment, transcript, input = {}) {
  if (segment.role !== "prospect") return null;
  await ensureCoachSession(segment);
  if (!segment.coachSessionStarted || !segment.coachSessionId) return null;
  const boundUii = cleanText(
    segment.coachBinding?.metadata?.uii ||
      segment.coachBinding?.event?.uii ||
      segment.dialogIdentity?.uii ||
      "",
    160,
  );
  const itemId = cleanText(input.itemId || transcript.itemId || transcript.item_id || input.chunkId || "", 160) || null;
  return postJson(`${segment.aiBusUrl}/api/ai/live-coach/grpc/${encodeURIComponent(segment.coachSessionId)}/input`, {
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
    streamId: segment.streamId,
    workflowInstanceId: segment.sessionId,
    uii: boundUii,
    callSessionId: segment.dialogIdentity?.callSessionId || segment.sessionId || "",
    queueItemId: segment.dialogIdentity?.queueItemId || "",
    agentExtensionId: segment.dialogIdentity?.agentExtensionId || "",
    agentEmail: segment.dialogIdentity?.agentEmail || "",
  }, 8000);
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
  const boundUii = cleanText(
    segment.coachBinding?.metadata?.uii ||
      segment.coachBinding?.event?.uii ||
      segment.dialogIdentity?.uii ||
      "",
    160,
  );
  let posted = 0;
  for (const chunk of chunks) {
    if (segment.coachTerminal) break;
    await postJson(`${segment.aiBusUrl}/api/ai/live-coach/grpc/${encodeURIComponent(segment.coachSessionId)}/input`, {
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
      streamId: segment.streamId,
      workflowInstanceId: segment.sessionId,
      uii: boundUii,
      callSessionId: segment.dialogIdentity?.callSessionId || segment.sessionId || "",
      queueItemId: segment.dialogIdentity?.queueItemId || "",
      agentExtensionId: segment.dialogIdentity?.agentExtensionId || "",
      agentEmail: segment.dialogIdentity?.agentEmail || "",
    }, 8000);
    posted += 1;
    if (delayMs) await sleep(delayMs);
  }
  return posted;
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
  } = {}) {
    if (!apiKey) throw new Error("OPENAI_API_KEY is missing for realtime transcription");
    this.segment = segment;
    this.apiKey = apiKey;
    this.model = model || "gpt-4o-transcribe";
    this.language = language || "en";
    this.turnDetection = turnDetection || "semantic_vad";
    this.semanticEagerness = semanticEagerness || "high";
    this.noiseReduction = noiseReduction || "near_field";
    this.provisionalEnabled = provisionalEnabled !== false;
    this.maxBufferedBytes = Math.max(8000, Number(maxBufferedBytes) || 240_000);
    this.ws = null;
    this.ready = false;
    this.closed = false;
    this.sessionId = "";
    this.disabled = false;
    this.itemTextById = new Map();
    this.pendingPayloads = [];
    this.pendingPayloadBytes = 0;
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
            audio: {
              input: {
                format: { type: "audio/pcmu" },
                noise_reduction: this.noiseReduction === "off" || this.noiseReduction === "none"
                  ? null
                  : { type: this.noiseReduction },
                transcription: {
                  model: this.model,
                  language: this.language,
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

  buildTurnDetection() {
    if (this.turnDetection === "off" || this.turnDetection === "none" || this.turnDetection === "manual") return null;
    if (this.turnDetection === "server_vad") {
      return {
        type: "server_vad",
        threshold: 0.5,
        prefix_padding_ms: 300,
        silence_duration_ms: 500,
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
        });
        this.flushBufferedAudio();
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
      this.eventQueue = this.eventQueue.then(() => this.handleDelta(event, delta)).catch((error) => {
        writeJsonLine(this.segment.eventLog, {
          type: "stt.realtime.delta_error",
          at: new Date().toISOString(),
          streamId: this.segment.streamId,
          segmentId: this.segment.segmentId,
          error: error.message,
        });
      });
      return;
    }
    if (event.type === "conversation.item.input_audio_transcription.completed") {
      const text = cleanText(event.transcript || "", 4000);
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

  async handleDelta(event, delta) {
    if (this.disabled || this.segment.coachTerminal) return;
    const itemId = cleanText(event.item_id || "unknown-item", 160);
    const text = cleanText(appendRealtimeTranscriptDelta(this.itemTextById.get(itemId) || "", delta), 4000);
    this.itemTextById.set(itemId, text);
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
    let posted = null;
    try {
      posted = await postProvisionalTranscript(this.segment, {
        text,
        provider: "openai-realtime",
        model: this.model,
        itemId,
        eventId: event.event_id || "",
      });
    } catch (error) {
      if (/Session is stale|Session is stopped|Session is voicemail_rejected/i.test(error.message)) {
        this.segment.coachTerminal = true;
        this.disabled = true;
        writeJsonLine(this.segment.eventLog, {
          type: "stt.realtime.disabled",
          at: new Date().toISOString(),
          streamId: this.segment.streamId,
          segmentId: this.segment.segmentId,
          reason: error.message.slice(0, 240),
        });
        return;
      }
      throw error;
    }
    writeJsonLine(this.segment.eventLog, {
      type: "stt.realtime.delta",
      at: new Date().toISOString(),
      streamId: this.segment.streamId,
      segmentId: this.segment.segmentId,
      itemId,
      text,
      coachStatus: posted?.session?.status || null,
    });
  }

  async handleCompleted(event, text) {
    if (this.disabled || this.segment.coachTerminal) return;
    const itemId = cleanText(event.item_id || "unknown-item", 160);
    if (!text) text = cleanText(this.itemTextById.get(itemId) || "", 4000);
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
    let posted = null;
    try {
      posted = await postTranscript(this.segment, {
        text,
        provider: "openai-realtime",
        model: this.model,
        itemId,
      }, {
        source: "grpc-openai-realtime-semantic-vad",
        itemId,
        durationSec: null,
      });
    } catch (error) {
      if (/Session is stale|Session is stopped|Session is voicemail_rejected/i.test(error.message)) {
        this.segment.coachTerminal = true;
        this.disabled = true;
        writeJsonLine(this.segment.eventLog, {
          type: "stt.realtime.disabled",
          at: new Date().toISOString(),
          streamId: this.segment.streamId,
          segmentId: this.segment.segmentId,
          reason: error.message.slice(0, 240),
        });
        return;
      }
      throw error;
    }
    if (TERMINAL_COACH_STATUSES.has(String(posted?.session?.status || ""))) {
      this.segment.coachTerminal = true;
    }
    writeJsonLine(this.segment.eventLog, {
      type: "stt.realtime.completed",
      at: new Date().toISOString(),
      streamId: this.segment.streamId,
      segmentId: this.segment.segmentId,
      itemId,
      text,
      coachStatus: posted?.session?.status || null,
      coachAction: posted?.result?.action || null,
      usage: event.usage || null,
    });
  }

  close() {
    this.closed = true;
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
      writeJsonLine(this.segment.eventLog, {
        type: "stt.realtime.finish",
        at: new Date().toISOString(),
        streamId: this.segment.streamId,
        segmentId: this.segment.segmentId,
        reason,
      });
      await Promise.race([
        this.eventQueue.catch(() => null),
        sleep(1200),
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
      writeJsonLine(segment.eventLog, {
        type: "stt.error",
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

function createLiveCoachStreamingService({
  outDir,
  eventLog,
  aiBusUrl,
  chunkSec,
  provisionalPreviewMs,
  provisionalPreviewChunks,
  sttProvider,
  sttModel,
  openAiApiKey,
  turnDetection,
  semanticEagerness,
  noiseReduction,
  realtimeProvisionalEnabled,
  allowUnboundCoachSessions,
  language,
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
          queueFlush(segment, reason);
          if (segment.realtimeStt) {
            segment.transcribeQueue = segment.transcribeQueue
              .then(() => segment.realtimeStt.finish(reason))
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
            openAiApiKey,
            turnDetection,
            semanticEagerness,
            noiseReduction,
            realtimeProvisionalEnabled,
            allowUnboundCoachSessions,
            language,
            eventLog,
            dialogIdentity,
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
            fs.appendFileSync(segment.rawPath, payload);
            segment.rawBytes += payload.length;
            if (segment.sttProvider !== "openai-realtime") {
              segment.pendingRawBytes += payload.length;
            }
            const pcm = pcm16FromPayload(payload, segment.codec);
            if (pcm) {
              segment.pcmBuffers.push(pcm);
              if (segment.sttProvider !== "openai-realtime") {
                segment.pendingPcmBuffers.push(pcm);
              }
            }
            if (segment.sttProvider === "openai-realtime") {
              segment.realtimeStt?.appendPcmu(payload);
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
              .then(() => segment.realtimeStt ? segment.realtimeStt.finish("segment-stop") : null)
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
  const sttModel = readFlag(argv, "--stt-model", process.env.LIVE_COACH_STT_MODEL || process.env.SALES_TRAINER_STT_MODEL || "gpt-4o-transcribe");
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
    ["1", "true", "yes", "on", "enabled"].includes(String(process.env.LIVE_COACH_ALLOW_UNBOUND_SESSIONS || "").trim().toLowerCase()),
  );
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
    openAiApiKey,
    turnDetection,
    semanticEagerness,
    noiseReduction,
    realtimeProvisionalEnabled,
    allowUnboundCoachSessions,
    language,
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

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
