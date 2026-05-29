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

const RC_BASE = (process.env.RING_CENTRAL_SERVER_URL || "https://platform.ringcentral.com").replace(/\/$/, "");
const PHASE_KEYS = ["opening", "discovery", "pain", "qualification", "solution", "objection", "close", "wrap"];
const SPEAKER_KEYS = ["agent", "prospect", "system", "unknown"];
const HUMAN_SPEAKER_KEYS = ["agent", "prospect"];

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
    /\bwe('re| are)\b/,
    /\bwe help\b/,
    /\bwhat we do\b/,
    /\btax resolution\b/,
    /\bwith (the )?(tax advocate group|tax group|group|wynn tax|wynn)\b/,
    /\bresponding to your (query|inquiry|request)\b/,
    /\bhow can i help\b/,
    /\bhow much do you owe\b/,
    /\bdo you owe\b/,
    /\banything unfiled\b/,
    /\bcalling (from|about)\b/,
    /\bmy name is\b/,
    /\blet me\b/,
  ];
  if (agentPatterns.some((pattern) => pattern.test(clean))) return "agent";

  if (callFlow === "outbound" && lastHumanSpeaker === "prospect" && /\bhi this is\b/.test(clean)) {
    return "agent";
  }

  const prospectPatterns = [
    /^(hello|hello there|hi|yeah hi|yes hello|speaking)\b/,
    /\bwho is this\b/,
    /\bi was wondering\b/,
    /\bwhat kind of\b/,
    /\bdo you guys\b/,
    /\bcan you help\b/,
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
  const nativeSegments = (Array.isArray(rawSegments) ? rawSegments : [])
    .map((segment) => {
      const text = cleanText(segment?.text || "", 1000);
      if (!text) return null;
      const nativeSpeaker = cleanText(segment?.speaker || "", 20);
      return {
        speaker: "unknown",
        nativeSpeaker,
        text,
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
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: jwtToken,
  });
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
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
  if (!response.ok) throw new Error(`RC OAuth failed: ${response.status} ${text.slice(0, 300)}`);
  return json.access_token;
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

function buildAdvicePrompt({ transcripts, metadata }) {
  const recent = transcripts.slice(-16);
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
    "Your output goes to a tiny side panel beside the call. Keep it short, tactical, and useful while the agent is talking.",
    "Focus on discovery, pain, qualification, trust, next question, and objection handling.",
    "Do not give tax/legal advice, exact program recommendations, fees, timelines, guarantees, or anything the agent should not say.",
    "If the transcript is mostly hold music/system prompts/no real conversation, say to keep listening and leave suggestedDraft empty.",
    "",
    `Monitor metadata: ${JSON.stringify(metadata || {})}`,
    "",
    "Recent transcript, oldest first:",
    transcriptText || "(no usable transcript yet)",
  ].join("\n");
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

function isLowSignalTranscript(text) {
  const clean = cleanText(text, 240).toLowerCase();
  if (!clean) return true;
  if (isPrimerHallucination(text)) return true;
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
    .status { font-size: 12px; color: #9da7b3; }
    main { display: grid; grid-template-columns: minmax(0, 1fr) 380px; gap: 14px; padding: 14px; }
    section { border: 1px solid #30363d; border-radius: 8px; background: #0f141b; min-height: 180px; }
    h2 { font-size: 13px; margin: 0; padding: 12px 12px 0; color: #9da7b3; font-weight: 600; }
    .list { padding: 10px 12px 14px; display: flex; flex-direction: column; gap: 10px; }
    .row { border: 1px solid #26313d; border-radius: 7px; padding: 10px; background: #111923; }
    .meta { color: #7d8590; font-size: 11px; margin-bottom: 5px; }
    .text { white-space: pre-wrap; line-height: 1.42; font-size: 14px; }
    .focus { font-size: 16px; line-height: 1.35; }
    .pill { display: inline-block; border: 1px solid #3b4754; border-radius: 999px; padding: 2px 8px; color: #9da7b3; font-size: 11px; margin-right: 6px; }
    ul { margin: 8px 0 0 18px; padding: 0; }
    li { margin: 5px 0; }
    code { color: #a5d6ff; }
    @media (max-width: 900px) { main { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <header>
    <h1>EX Live Monitor One-Off</h1>
    <div class="status" id="status">connecting...</div>
  </header>
  <main>
    <section>
      <h2>Transcript</h2>
      <div class="list" id="transcripts"></div>
    </section>
    <section>
      <h2>Advice</h2>
      <div class="list" id="advice"></div>
      <h2>Events</h2>
      <div class="list" id="events"></div>
    </section>
  </main>
  <script>
    const statusEl = document.getElementById("status");
    const transcriptsEl = document.getElementById("transcripts");
    const adviceEl = document.getElementById("advice");
    const eventsEl = document.getElementById("events");
    const esc = (v) => String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    function render(state) {
      statusEl.textContent = [
        state.status || "unknown",
        state.packetCount ? \`\${state.packetCount} packets\` : "",
        state.byteCount ? \`\${state.byteCount} bytes\` : "",
        state.outputPath ? \`writing \${state.outputPath.split(/[\\\\/]/).pop()}\` : "",
      ].filter(Boolean).join(" | ");
    const transcripts = state.transcripts || [];
    transcriptsEl.innerHTML = transcripts.length
      ? transcripts.slice(-80).reverse().map((item) => \`
          <div class="row">
            <div class="meta">\${esc(item.at)} | \${esc(item.durationSec)}s | active \${esc(item.activePctOver500)}% | \${esc(item.model || "")} \${esc(item.responseFormat || "")} \${esc(item.speakerStatus || "")}</div>
            <div class="text">\${(item.speakerSegments || []).length
              ? item.speakerSegments.map((segment) => \`<span class="pill">\${esc([segment.speaker, segment.nativeSpeaker].filter(Boolean).join("/"))} \${Math.round((segment.confidence || 0) * 100)}%</span>\${esc(segment.text)}\`).join("<br>")
              : esc(item.text)}</div>
          </div>\`).join("")
      : '<div class="row"><div class="text">Waiting for usable audio...</div></div>';
      const coach = state.advice && state.advice.coach;
      adviceEl.innerHTML = coach ? \`
        <div class="row">
          <div class="meta"><span class="pill">\${esc(coach.phase?.label || coach.phase?.key)}</span><span class="pill">\${Math.round((coach.confidence || 0) * 100)}%</span></div>
          <div class="focus">\${esc(coach.oneSentenceFocus)}</div>
          \${state.advice.suggestedDraft ? \`<p><strong>Say:</strong> \${esc(state.advice.suggestedDraft)}</p>\` : ""}
          <strong>Moves</strong><ul>\${(coach.suggestedMoves || []).map((x) => \`<li>\${esc(x)}</li>\`).join("")}</ul>
          <strong>Listen for</strong><ul>\${(coach.listenFor || []).map((x) => \`<li>\${esc(x)}</li>\`).join("")}</ul>
          \${(coach.riskFlags || []).length ? \`<strong>Risk</strong><ul>\${coach.riskFlags.map((x) => \`<li>\${esc(x)}</li>\`).join("")}</ul>\` : ""}
        </div>\` : '<div class="row"><div class="text">Advice will appear after the first usable transcript chunks.</div></div>';
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
      events: state.events.slice(-50),
      advice: state.advice,
    };
  }

  function send(client, event, payload) {
    client.write(`event: ${event}\n`);
    client.write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  const server = http.createServer((req, res) => {
    if (req.url === "/events") {
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
    if (req.url === "/api/state" || req.url === "/health") {
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
  --dashboard-port 7331      Local dashboard port
  --session-id ID            Optional trainer UI session id to publish advice into
  --supervise-wait-sec 120   When --supervise is set, wait for an active call

Audio/AI options:
  --chunk-sec 2              Seconds of PCMU per transcription chunk
  --coach-every-sec 10       Minimum seconds between Claude advice calls
  --min-active-pct 0.35      Skip chunks quieter than this active-sample percent
  --sentence-hold-ms 4000    Hold fragments briefly for complete sentences
  --language en              STT language hint
  --stt-model MODEL          OpenAI STT model
  --stt-response-format FMT  json | diarized_json
  --coach-model MODEL        Claude model for live advice
  --speaker-model MODEL      Claude model for speaker labels (default Haiku)
  --speaker-labels           Force Haiku labels even with native diarize
  --no-speaker-labels        Skip logical speaker separation
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
  const supervisePollMs = Math.max(5000, Number(readFlag(argv, "--supervise-poll-ms", env("EX_LIVE_MONITOR_SUPERVISE_POLL_MS", "6000"))) || 6000);
  const onlyNewCalls = hasFlag(argv, "--only-new-calls")
    || env("EX_LIVE_MONITOR_ONLY_NEW_CALLS", "").toLowerCase() === "true";
  const dashboardPort = Number(readFlag(argv, "--dashboard-port", env("EX_LIVE_MONITOR_DASHBOARD_PORT", "7331"))) || 7331;
  const timeoutSec = Math.max(10, Number(readFlag(argv, "--timeout-sec", env("EX_LIVE_MONITOR_TIMEOUT_SECONDS", "3600"))) || 3600);
  const chunkSec = Math.max(1, Math.min(20, Number(readFlag(argv, "--chunk-sec", env("EX_LIVE_MONITOR_CHUNK_SECONDS", "2"))) || 2));
  const coachEverySec = Math.max(5, Number(readFlag(argv, "--coach-every-sec", env("EX_LIVE_MONITOR_COACH_EVERY_SECONDS", "10"))) || 10);
  const minActivePct = Math.max(0, Number(readFlag(argv, "--min-active-pct", env("EX_LIVE_MONITOR_MIN_ACTIVE_PCT", "0.35"))) || 0);
  const sentenceHoldMs = Math.max(0, Number(readFlag(argv, "--sentence-hold-ms", env("EX_LIVE_MONITOR_SENTENCE_HOLD_MS", "4000"))) || 0);
  const language = readFlag(argv, "--language", env("EX_LIVE_MONITOR_LANGUAGE", "en"));
  const sttModel = readFlag(
    argv,
    "--stt-model",
    env("EX_LIVE_MONITOR_STT_MODEL", env("SALES_TRAINER_STT_MODEL", "gpt-4o-mini-transcribe")),
  );
  const sttResponseFormat = readFlag(
    argv,
    "--stt-response-format",
    env("EX_LIVE_MONITOR_STT_RESPONSE_FORMAT", /diarize/i.test(sttModel) ? "diarized_json" : "json"),
  );
  const nativeDiarizeEnabled = !hasFlag(argv, "--no-native-diarize")
    && (/diarize/i.test(sttModel) || String(sttResponseFormat).toLowerCase() === "diarized_json");
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
  const speakerModel = readFlag(
    argv,
    "--speaker-model",
    env("LIVE_CALL_MONITOR_SPEAKER_MODEL", "claude-haiku-4-5"),
  );
  const speakerLabelsEnabled = !hasFlag(argv, "--no-speaker-labels")
    && (!nativeDiarizeEnabled || hasFlag(argv, "--speaker-labels"));
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
      coachEverySec,
      minActivePct,
      callFlow,
      initialHumanSpeaker,
      sentenceHoldMs,
      sttModel,
      sttResponseFormat,
      nativeDiarizeEnabled,
      speakerLabelsEnabled,
      speakerModel,
    },
    transcripts: [],
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
  const monitorToken = await rcAccessToken({
    jwtToken: process.env.RING_CENTRAL_MONITOR_JWT_TOKEN || process.env.RING_CENTRAL_JWT_TOKEN,
    clientId: process.env.RING_CENTRAL_MONITOR_CLIENT_ID || process.env.RING_CENTRAL_CLIENT_ID,
    clientSecret: process.env.RING_CENTRAL_MONITOR_CLIENT_SECRET || process.env.RING_CENTRAL_CLIENT_SECRET,
  });

  const supervisorExt = await resolveExtension(lookupToken, supervisorExtNumber);
  if (!supervisorExt) throw new Error(`Could not resolve supervisor extension ${supervisorExtNumber}`);
  const agentExt = agentExtNumber ? await resolveExtension(lookupToken, agentExtNumber) : null;
  if (agentExtNumber && !agentExt) throw new Error(`Could not resolve agent extension ${agentExtNumber}`);

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
  let chunkSequence = 0;
  let transcriptionQueue = Promise.resolve();
  let pendingTranscript = null;
  let lastAdviceAt = 0;
  let adviceInFlight = false;
  const nativeSpeakerAssignments = new Map();
  let monitorMetadata = {
    runId,
    supervisorExtNumber,
    agentExtNumber: agentExtNumber || null,
    partyMode,
    callFlow,
    initialHumanSpeaker,
    sessionId: sessionId || null,
  };

  async function maybeRefreshAdvice(reason = "transcript") {
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

  function takeDisplayTranscripts({ text, chunkId, startedAt, endedAt }) {
    const now = Date.now();
    if (!pendingTranscript) {
      pendingTranscript = {
        text: "",
        chunkIds: [],
        startedAt,
        startedMs: now,
      };
    }

    pendingTranscript.text = mergeTranscriptFragments([pendingTranscript.text, text]);
    if (!pendingTranscript.chunkIds.includes(chunkId)) pendingTranscript.chunkIds.push(chunkId);
    const combined = pendingTranscript.text;
    const holdMs = now - pendingTranscript.startedMs;
    const { sentences, tail } = splitCompleteTranscriptUnits(combined);
    const holdExpired = sentenceHoldMs > 0 && holdMs >= sentenceHoldMs;
    const results = sentences.map((sentence) => ({
      text: sentence,
      startedAt: pendingTranscript.startedAt,
      endedAt,
      heldChunkIds: [...pendingTranscript.chunkIds],
      holdMs,
      complete: true,
    }));

    if (results.length) {
      pendingTranscript = tail
        ? {
          text: tail,
          chunkIds: [chunkId],
          startedAt,
          startedMs: now,
        }
        : null;
      return results;
    }

    const tailText = tail || combined;
    if (shouldPublishIncompleteTranscript(tailText, holdExpired)) {
      const result = {
        text: tailText,
        startedAt: pendingTranscript.startedAt,
        endedAt,
        heldChunkIds: [...pendingTranscript.chunkIds],
        holdMs,
        complete: false,
      };
      pendingTranscript = null;
      return [result];
    }

    pendingTranscript.text = tailText;
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

  async function processAudioChunk({ pcmuBuffer, chunkId, startedAt, endedAt, stats }) {
    const activePct = Number(stats.activePctOver500 || 0);
    if (activePct < minActivePct) {
      addEvent(state, eventLog, "chunk.skip", `quiet chunk skipped (${activePct}% active)`, {
        chunkId,
        stats,
      });
      broadcast();
      return;
    }

    const wav = buildPcm16WavFromPcmu(pcmuBuffer);
    const wavPath = path.join(runDir, `${chunkId}.wav`);
    if (writeWavChunks) fs.writeFileSync(wavPath, wav);

    addEvent(state, eventLog, "stt.start", `transcribing ${chunkId}`, {
      chunkId,
      durationSec: stats.durationSec,
      activePctOver500: stats.activePctOver500,
    });
    const sttStarted = Date.now();
    const transcript = await transcribeSalesTrainerAudio({
      buffer: wav,
      mimeType: "audio/wav",
      filename: `${chunkId}.wav`,
      language,
      model: sttModel,
      responseFormat: sttResponseFormat,
      prompt: "",
      includeDomainPrimer: false,
      timeoutMs: 20_000,
    });
    const priorTexts = state.transcripts.slice(-8).map((entry) => entry.text);
    const text = removePriorTranscriptEcho(transcript.text || "", priorTexts);
    if (isLowSignalTranscript(text)) {
      addEvent(state, eventLog, "stt.skip", `low-signal transcript skipped: ${text || "(empty)"}`, {
        chunkId,
        elapsedMs: Date.now() - sttStarted,
        rawText: cleanText(transcript.text || "", 500),
      });
      broadcast();
      return;
    }

    const displayTranscripts = takeDisplayTranscripts({ text, chunkId, startedAt, endedAt });
    if (!displayTranscripts.length) {
      addEvent(state, eventLog, "stt.hold", `holding fragment for sentence completion: ${text}`, {
        chunkId,
        elapsedMs: Date.now() - sttStarted,
      });
      broadcast();
      return;
    }

    displayTranscripts.forEach((displayTranscript, index) => {
      const entryId = displayTranscripts.length === 1 ? chunkId : `${chunkId}-s${index + 1}`;
      const recentSegments = state.transcripts
        .filter((item) => item.id !== entryId)
        .flatMap((item) => item.speakerSegments || []);
      const nativeSpeakerSegments = nativeDiarizeEnabled
        ? speakerSegmentsFromNativeDiarize(transcript.segments, displayTranscript.text, {
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
        nativeDiarizeSegments: nativeDiarizeEnabled ? transcript.segments || [] : undefined,
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
      void maybeRefreshAdvice("transcript");

      enqueueSpeakerLabel(entry, displayTranscript.text, entryId);
    });
  }

  function resetPending() {
    pendingChunks = [];
    pendingBytes = 0;
    pendingStartedAt = 0;
  }

  function flushPending(reason = "interval") {
    if (!pendingBytes) return;
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
      .then(() => processAudioChunk({ pcmuBuffer, chunkId, startedAt, endedAt, stats }))
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
        if (!pendingStartedAt) pendingStartedAt = Date.now();
        pendingChunks.push(payload);
        pendingBytes += payload.length;
        if (Date.now() - pendingStartedAt >= chunkSec * 1000) {
          flushPending("interval");
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
  console.log(`  chunk:      ${chunkSec}s, active>=${minActivePct}%`);
  console.log(`  call flow:  ${callFlow}, initial human=${initialHumanSpeaker}`);
  console.log(`  sentences:  hold fragments up to ${sentenceHoldMs}ms`);
  console.log(`  stt:        ${sttModel}, format=${sttResponseFormat}`);
  console.log(`  coach:      every ${coachEverySec}s, model=${coachModel}`);
  console.log(`  speakers:   ${nativeDiarizeEnabled ? "native diarize" : speakerLabelsEnabled ? speakerModel : "off"}`);
  console.log(`  ui bridge:  ${sessionId ? `session=${sessionId}` : "off"}`);

  await softphone.register();
  state.public.status = "registered";
  addEvent(state, eventLog, "register", "headless AI Monitor phone registered");
  broadcast();

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
        if (!/No (active|live) agent telephonySessionId|MBW-005|Your call cannot be connected|TAS-120|TAS-102|WrongState|CMN-101/i.test(String(error?.message || ""))) {
          throw error;
        }
        addEvent(state, eventLog, "supervise.wait", `waiting for active call on agent ext ${agentExtNumber}`, {
          error: error.message,
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
    if (pendingBytes && pendingStartedAt && Date.now() - pendingStartedAt >= chunkSec * 1000) {
      flushPending("timer");
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
    flushPending("shutdown");
    await transcriptionQueue.catch(() => {});
    if (state.transcripts.length) await maybeRefreshAdvice("forced");
    if (activeSession && !activeSession.disposed) {
      addEvent(state, eventLog, "timeout", "hanging up active monitor call");
      await activeSession.hangup().catch((error) => addEvent(state, eventLog, "hangup.error", error.message));
    }
    closeOutput();
    softphone.revoke();
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
