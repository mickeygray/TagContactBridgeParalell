"use strict";

const {
  getSharedConfig,
} = require("../../shared-config/src");
const {
  createCallrailClient,
  createGoogleDriveClient,
  createRingCentralClient,
  createRingcxVoiceClient,
} = require("../../shared-integrations/src");
const { CallLog } = require("../../shared-models/src");
const {
  agentStateRepository,
  reviewQueueRepository,
} = require("../../shared-repositories/src");
const { emitHourlyJobEvent } = require("./hourlyJobEventService");

const CALLRAIL_RECORDING_FIELDS = [
  "id",
  "customer_phone_number",
  "tracking_phone_number",
  "formatted_tracking_phone_number",
  "source",
  "source_name",
  "start_time",
  "duration",
  "direction",
  "recording",
  "recording_duration",
];
const RC_RECORDING_SEARCH_WINDOW_MS =
  Number(process.env.RECORDING_ARCHIVE_RC_SEARCH_WINDOW_MS) || 30 * 60 * 1000;
const MIN_RECORDING_AGE_MS =
  Number(process.env.MIN_RECORDING_AGE_MS) || 90_000;
const RINGCX_RECORDING_READY_DELAY_MS = Math.max(
  Number(process.env.RINGCX_RECORDING_READY_DELAY_MS) || 15 * 60 * 1000,
  15 * 60 * 1000,
);
const RINGCX_RECORDING_RETRY_DELAY_MS = Math.max(
  Number(process.env.RINGCX_RECORDING_RETRY_DELAY_MS) || 3 * 60 * 1000,
  60 * 1000,
);
const DOWNLOAD_TIMEOUT_MS =
  Number(process.env.RECORDING_ARCHIVE_DOWNLOAD_TIMEOUT_MS) || 60_000;
const TERMINAL_ARCHIVE_STATUSES = new Set([
  "completed",
  "no_group_match",
  "skipped",
  "abandoned",
]);
const AMBIGUOUS_ADSERV_AGENTS = new Set(["bruce allen"]);
const DEFAULT_EXCLUDED_AGENT_TOKENS = [
  "Michael Gray",
  "Mickey Gray",
  "mgray",
  "mgray@taxadvocategroup.com",
  "Alex Banks",
  "Alexander Banks",
  "abanks",
  "abanks@taxadvocategroup.com",
];
const DEFAULT_ASCS_AGENT_NAMES = [
  "Neyla Ramirez",
  "Neyla",
  "Jonathan Haro",
  "Leo Collins",
  "Leo",
  "Matthew Anderson",
  "Matt Anderson",
  "Dani Pearson",
  "Dani",
  "Andrew Wells",
  "Andrew",
  "Monica Cazares",
  "Monica",
];
const DEFAULT_ALWAYS_CX_AGENT_NAMES = [
  "Chris Bolt",
  "Brad Hansen",
  "James Sharp",
];

function getArchiveConfig() {
  return getSharedConfig().recordingArchive || {};
}

function normalizeDomain(domain) {
  return String(domain || "").trim().toUpperCase();
}

function normalizeDigits(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  return digits.length === 11 && digits.startsWith("1")
    ? digits.slice(1)
    : digits.slice(-10);
}

function sanitizeFileComponent(value, fallback = "unknown") {
  const cleaned = String(value || "")
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  return cleaned || fallback;
}

function normalizeName(value) {
  return String(value || "").trim().toLowerCase();
}

function parseTokenList(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry || "").trim()).filter(Boolean);
  }
  return String(value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeAgentBucketName(value) {
  return normalizeAgentDisplayName(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getAscsAgentNameSet() {
  return new Set(
    parseTokenList(process.env.RECORDING_ARCHIVE_ASCS_AGENT_NAMES || DEFAULT_ASCS_AGENT_NAMES)
      .map((name) => normalizeAgentBucketName(name))
      .filter(Boolean),
  );
}

function getAlwaysCxAgentNameSet() {
  return new Set(
    parseTokenList(process.env.RECORDING_ARCHIVE_ALWAYS_CX_AGENT_NAMES || DEFAULT_ALWAYS_CX_AGENT_NAMES)
      .map((name) => normalizeAgentBucketName(name))
      .filter(Boolean),
  );
}

function getExcludedAgentTokens() {
  return parseTokenList(
    process.env.RECORDING_ARCHIVE_EXCLUDED_AGENT_TOKENS ||
      DEFAULT_EXCLUDED_AGENT_TOKENS,
  );
}

function normalizeArchiveExcludeText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s*-\s*(tag|wynn|amity)\b.*$/i, "")
    .replace(/[^a-z0-9@.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function findExcludedAgentMatch(values = [], excludeTokens = getExcludedAgentTokens()) {
  const normalizedTokens = parseTokenList(excludeTokens)
    .map((token) => normalizeArchiveExcludeText(token))
    .filter(Boolean);
  if (normalizedTokens.length === 0) return null;

  for (const value of values) {
    const normalizedValue = normalizeArchiveExcludeText(value);
    if (!normalizedValue) continue;
    const token = normalizedTokens.find((entry) =>
      normalizedValue === entry || normalizedValue.includes(entry),
    );
    if (token) {
      return {
        token,
        value: String(value || ""),
      };
    }
  }
  return null;
}

function findExcludedCallLogAgentMatch(callLog = {}, routing = null) {
  return findExcludedAgentMatch([
    callLog.agentName,
    callLog.recordingArchive?.terminalAgentName,
    routing?.candidate?.agentName,
  ]);
}

function normalizeAgentDisplayName(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const withoutCompanySuffix = raw.replace(/\s*-\s*(tag|wynn|amity)\b.*$/i, "").trim();
  const firstSegment = withoutCompanySuffix.split(/\s*-\s*/)[0].trim();
  return firstSegment || withoutCompanySuffix || raw;
}

function formatDateStamp(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return "unknown-date";
  return date.toISOString().slice(0, 10);
}

function buildCallrailDateWindow(callStartTime) {
  const base = callStartTime ? new Date(callStartTime) : new Date();
  if (Number.isNaN(base.getTime())) {
    const today = new Date().toISOString().slice(0, 10);
    return { startDate: today, endDate: today };
  }
  const start = new Date(base);
  start.setUTCDate(start.getUTCDate() - 1);
  const end = new Date(base);
  end.setUTCDate(end.getUTCDate() + 1);
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  };
}

function buildRecordingFileName(callLog, routing, artifact) {
  const datePart = formatDateStamp(callLog.callStartTime);
  const bucketPart = sanitizeFileComponent(
    String(routing?.destination?.label || routing?.destination?.key || "UNASSIGNED").toUpperCase(),
    "UNASSIGNED",
  );
  const agentPart = sanitizeFileComponent(
    String(
      normalizeAgentDisplayName(
        routing?.candidate?.agentName ||
          callLog.agentName ||
          routing?.candidate?.extensionNumber ||
          routing?.candidate?.extensionId ||
          "UNKNOWN AGENT",
      ),
    ).toUpperCase(),
    "UNKNOWN-AGENT",
  );
  const phonePart = sanitizeFileComponent(normalizeDigits(callLog.phone) || "unknown-phone");
  const sessionPart = sanitizeFileComponent(callLog.telephonySessionId || "unknown-session");
  const extension = extensionFromMimeType(artifact?.mimeType, artifact?.sourceUri);

  return [
    agentPart,
    bucketPart,
    datePart,
    phonePart,
    sessionPart,
  ].join("__") + extension;
}

function extensionFromMimeType(mimeType, sourceUri = "") {
  const lowerMime = String(mimeType || "").toLowerCase();
  if (lowerMime.includes("wav")) return ".wav";
  if (lowerMime.includes("mpeg") || lowerMime.includes("mp3")) return ".mp3";

  const uri = String(sourceUri || "").toLowerCase();
  if (uri.endsWith(".wav")) return ".wav";
  if (uri.endsWith(".mp3")) return ".mp3";
  return ".mp3";
}

function normalizeStringSet(values = [], mapper = (value) => String(value || "").trim()) {
  return new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => mapper(value))
      .filter(Boolean),
  );
}

function isRecordingArchiveConfigured() {
  const config = getArchiveConfig();
  const destinations = config.destinations || {};
  const hasFolder =
    String(destinations.og?.folderId || "").trim() ||
    String(destinations.cx?.folderId || "").trim() ||
    String(destinations.as?.folderId || "").trim() ||
    String(destinations.cs?.folderId || "").trim();
  return Boolean(
    config.enabled &&
      hasFolder &&
      config.drive?.clientEmail &&
      config.drive?.privateKey,
  );
}

function qualifiesForArchive(callLog, config = getArchiveConfig()) {
  if (!callLog?.telephonySessionId) return false;
  if (callLog.missed) return false;
  return Number(callLog.durationSec || 0) >= Number(config.minDurationSec || 360);
}

function isTerminalArchiveStatus(status) {
  return TERMINAL_ARCHIVE_STATUSES.has(String(status || ""));
}

function buildRetryError(message, options = {}) {
  const error = new Error(message);
  error.retryable = true;
  if (options.nextAttemptAt) {
    error.nextAttemptAt = new Date(options.nextAttemptAt);
  }
  return error;
}

function buildProviderOrder(callLog = {}) {
  const platform = String(callLog?.platform || "").trim().toLowerCase();
  // CX-platform calls (placed/answered through the RingCX dialer) have
  // their audio in the RingCX recordings store — neither CallRail nor
  // RingCentral EX will have it. Try ringcx first; fall through to the
  // others only when RECORDING_ARCHIVE_CX_FALLBACK_PROVIDERS_ENABLED is on.
  if (platform === "cx") {
    const allowFallback = String(process.env.RECORDING_ARCHIVE_CX_FALLBACK_PROVIDERS_ENABLED || "")
      .trim()
      .toLowerCase();
    if (["1", "true", "yes", "on"].includes(allowFallback)) {
      return ["ringcx", "ringcentral", "callrail"];
    }
    return ["ringcx"];
  }
  return ["callrail", "ringcentral"];
}

function getCallEndReference(callLog = {}) {
  if (callLog.callEndTime) return new Date(callLog.callEndTime);
  if (callLog.callStartTime && callLog.durationSec) {
    return new Date(
      new Date(callLog.callStartTime).getTime() +
        Number(callLog.durationSec || 0) * 1000,
    );
  }
  return callLog.callStartTime ? new Date(callLog.callStartTime) : null;
}

function minRecordingAgeMsForCallLog(callLog = {}) {
  return String(callLog.platform || "").trim().toLowerCase() === "cx"
    ? Math.max(MIN_RECORDING_AGE_MS, RINGCX_RECORDING_READY_DELAY_MS)
    : MIN_RECORDING_AGE_MS;
}

function retryDelayMsForCallLog(callLog = {}) {
  return String(callLog.platform || "").trim().toLowerCase() === "cx"
    ? RINGCX_RECORDING_RETRY_DELAY_MS
    : 60 * 60 * 1000;
}

function computeArchiveNextAttemptAt(callLog = {}, config = getArchiveConfig(), now = new Date()) {
  const normalizedNow = now instanceof Date ? now : new Date(now);
  const platform = String(callLog.platform || "").trim().toLowerCase();
  const callEnd = getCallEndReference(callLog);

  if (platform === "cx" && callEnd && !Number.isNaN(callEnd.getTime())) {
    const readyAt = new Date(callEnd.getTime() + RINGCX_RECORDING_READY_DELAY_MS);
    return readyAt > normalizedNow ? readyAt : normalizedNow;
  }

  return new Date(
    normalizedNow.getTime() + Math.max(Number(config.initialDelayMs) || 0, 0),
  );
}

// Lazy singleton for the RingCX client. Reused across many calls
// within a single sweep tick (so the bearer token cache works).
let _ringcxClient = null;
function getRingcxClient() {
  if (!_ringcxClient) {
    try {
      _ringcxClient = createRingcxVoiceClient();
    } catch (error) {
      // Missing env → recording resolver is a no-op rather than a crash.
      return null;
    }
  }
  return _ringcxClient;
}

function isRingcxRecordingEnabled() {
  const raw = String(process.env.RINGCX_RECORDING_ENABLED || "").trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes";
}

function pickBestSegmentForCallLog(segments = [], callLog = {}) {
  // Per RingCX, an interaction breaks into N segments (one per agent /
  // IVR / bot leg). The recording lives on the longest agent segment
  // for outbound dialer calls; for inbound queue-routed calls, the
  // segment whose agent matches our callLog.agentName / extensionId is
  // the canonical one. Pick by descending segmentDuration as a safe
  // default — the longest segment is the actual customer-agent leg in
  // practice. Filter out segments with no recording URL.
  const candidates = (Array.isArray(segments) ? segments : []).filter((seg) => {
    if (!seg) return false;
    const dialogId = seg.dialogId || seg.dialogID || seg.dialog_id;
    const segmentId = seg.segmentID || seg.segmentId || seg.segment_id;
    return Boolean(dialogId && segmentId);
  });
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  const targetExt = String(callLog?.extensionId || "").trim();
  const targetAgent = normalizeName(callLog?.agentName);
  function score(seg) {
    let s = Number(seg.segmentDuration || seg.segmentDurationMs || 0);
    if (targetExt && String(seg.segmentAgentExtensionId || "").trim() === targetExt) s += 1e9;
    if (targetAgent && normalizeName(seg.segmentAgentName) === targetAgent) s += 1e8;
    if (seg.segmentRecordingURL) s += 1e6;
    return s;
  }
  return [...candidates].sort((a, b) => score(b) - score(a))[0];
}

function cloneRingcxSnapshot(value, depth = 0) {
  if (value == null) return value;
  if (depth > 6) return "[depth-limit]";
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value.slice(0, 80).map((item) => cloneRingcxSnapshot(item, depth + 1));
  }
  if (typeof value === "object") {
    const out = {};
    for (const [key, child] of Object.entries(value).slice(0, 160)) {
      out[key] = cloneRingcxSnapshot(child, depth + 1);
    }
    return out;
  }
  if (typeof value === "string") {
    return value.length > 4000 ? `${value.slice(0, 4000)}...[truncated]` : value;
  }
  return value;
}

function extractSegmentsFromCallHistory(history = {}, uii = "") {
  const dialogId = history?.dialogId || null;
  const sessions = Array.isArray(history?.activeCallSessionHistories)
    ? history.activeCallSessionHistories
    : [];
  return sessions
    .map((session) => {
      const segmentId = session?.segmentId || session?.segmentID || session?.segment_id || null;
      if (!dialogId || !segmentId) return null;
      return {
        dialogId,
        segmentId,
        interactionId: history?.uii || uii || null,
        segmentDuration: Number(session?.duration || session?.dialDuration || 0) || null,
        segmentRecordingURL: session?.recordingUrl || null,
        segmentAgentId:
          session?.agentSession?.agentId
          || session?.rcAgentAgentSession?.agentId
          || history?.agentNameAndType?.agentId
          || null,
        segmentAgentName:
          session?.agentLogin
          || session?.agentSession?.agentName
          || history?.agentNameAndType?.agentName
          || null,
        segmentAgentGroupId:
          history?.historySource?.sourceGroupId
          || null,
        interactionDirection: history?.callType || history?.dialogContext?.dialogOrigination || null,
        source: "callHistory",
        rawSession: session,
      };
    })
    .filter(Boolean);
}

async function resolveRingcxRecording(callLog, metadataCache = null) {
  if (!isRingcxRecordingEnabled()) {
    return { artifact: null, reason: "ringcx-recording-disabled" };
  }
  const client = getRingcxClient();
  if (!client) {
    return { artifact: null, reason: "ringcx-client-unconfigured" };
  }
  const uii = String(callLog?.telephonySessionId || "").trim();
  if (!uii) return { artifact: null, reason: "missing-uii" };

  // Prefer the pre-fetched batch metadata when available (one POST per
  // hour-window, shared across all rows in the sweep). Falls back to a
  // per-call metadata fetch when the cache miss happens — this path is
  // rate-limited (2 calls/min) so a hot loop would hit the limit fast.
  let segments = null;
  if (metadataCache?.byUii && metadataCache.byUii instanceof Map) {
    const hit = metadataCache.byUii.get(uii);
    if (Array.isArray(hit)) segments = hit;
  }

  if (!segments) {
    // Single-row fallback. Scope the window narrowly around the call's
    // start time so the metadata POST returns a tractable result set.
    const start = callLog.callStartTime
      ? new Date(callLog.callStartTime)
      : new Date(Date.now() - 2 * 60 * 60 * 1000);
    const end = callLog.callEndTime
      ? new Date(new Date(callLog.callEndTime).getTime() + 5 * 60 * 1000)
      : new Date(start.getTime() + 2 * 60 * 60 * 1000);
    try {
      const metadata = await client.fetchInteractionMetadata({
        startTime: new Date(start.getTime() - 60 * 1000),
        endTime: end,
      });
      segments = extractSegmentsForUii(metadata, uii);
    } catch (error) {
      segments = null;
    }
  }

  if (!Array.isArray(segments) || segments.length === 0) {
    if (typeof client.getCallHistory === "function") {
      try {
        const history = await client.getCallHistory(uii);
        segments = extractSegmentsFromCallHistory(history, uii);
        await CallLog.updateOne(
          { _id: callLog._id },
          {
            $set: {
              "recordingArchive.ringcxCallHistoryFetchedAt": new Date(),
              "recordingArchive.ringcxCallHistorySnapshot": cloneRingcxSnapshot(history),
              "recordingArchive.ringcxDialogId": history?.dialogId || null,
              "recordingArchive.ringcxSegmentIds": segments.map((segment) => segment.segmentId),
            },
          },
        ).catch(() => null);
      } catch (error) {
        return { artifact: null, reason: "ringcx-call-history-failed", error: error.message };
      }
    }
  }

  const segment = pickBestSegmentForCallLog(segments, callLog);
  if (!segment) {
    return { artifact: null, reason: "no-ringcx-segment-with-recording" };
  }
  const dialogId = segment.dialogId || segment.dialogID || segment.dialog_id;
  const segmentId = segment.segmentID || segment.segmentId || segment.segment_id;
  if (!dialogId || !segmentId) {
    return { artifact: null, reason: "ringcx-segment-missing-ids" };
  }

  let download;
  try {
    download = await client.downloadRecordingBySegment({ dialogId, segmentId });
  } catch (error) {
    return { artifact: null, reason: "ringcx-download-failed", error: error.message };
  }

  return {
    artifact: {
      provider: "ringcx",
      sourceUri: `cx://accounts/sub/recordings/dialogs/${dialogId}/segments/${segmentId}`,
      mimeType: download.mimeType || "audio/wav",
      buffer: download.buffer,
      finalUrl: segment.segmentRecordingURL || null,
      recordingDuration: Number(segment.segmentDuration || 0) || null,
      providerMetadata: {
        dialogId,
        segmentId,
        interactionId: segment.interactionId || uii,
        segmentAgentId: segment.segmentAgentId || null,
        segmentAgentGroupId: segment.segmentAgentGroupId || null,
        segmentDurationMs: Number(segment.segmentDuration || 0) || null,
        interactionDirection: segment.interactionDirection || null,
      },
    },
  };
}

// Walks the metadata response (whose top-level shape isn't fully
// pinned down in the docs — different docs show {records:[]} vs
// {segments:[]} vs raw arrays) and returns segments matching the UII.
function extractSegmentsForUii(metadata, uii) {
  const target = String(uii || "").trim();
  if (!target) return [];
  const rows = Array.isArray(metadata)
    ? metadata
    : Array.isArray(metadata?.records)
      ? metadata.records
      : Array.isArray(metadata?.segments)
        ? metadata.segments
        : Array.isArray(metadata?.data)
          ? metadata.data
          : [];
  return rows.filter((row) => {
    const candidate = String(
      row?.interactionId || row?.uii || row?.UII || row?.dialogId || "",
    ).trim();
    return candidate === target;
  });
}

// Build a UII → segments map from one bulk metadata response. Caller
// passes this into resolveRingcxRecording via the metadataCache option
// so a sweep tick of N rows triggers exactly one metadata POST.
function buildRingcxMetadataCache(metadata) {
  const byUii = new Map();
  const rows = Array.isArray(metadata)
    ? metadata
    : Array.isArray(metadata?.records)
      ? metadata.records
      : Array.isArray(metadata?.segments)
        ? metadata.segments
        : Array.isArray(metadata?.data)
          ? metadata.data
          : [];
  for (const row of rows) {
    const uii = String(
      row?.interactionId || row?.uii || row?.UII || "",
    ).trim();
    if (!uii) continue;
    if (!byUii.has(uii)) byUii.set(uii, []);
    byUii.get(uii).push(row);
  }
  return { byUii, totalSegments: rows.length };
}

async function readBinaryResponse(response) {
  const buffer = Buffer.from(await response.arrayBuffer());
  return {
    buffer,
    mimeType: response.headers.get("content-type") || "application/octet-stream",
    finalUrl: response.url || null,
  };
}

async function fetchBinary(url, { headers = {}, timeoutMs = DOWNLOAD_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers,
      redirect: "follow",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new Error(`download HTTP ${response.status}`);
  }

  return readBinaryResponse(response);
}

function collectPhoneMatches(value, targetPhone, matches = new Set()) {
  if (!targetPhone) return matches;
  if (value == null) return matches;
  if (Array.isArray(value)) {
    value.forEach((entry) => collectPhoneMatches(entry, targetPhone, matches));
    return matches;
  }
  if (typeof value === "object") {
    Object.values(value).forEach((entry) => collectPhoneMatches(entry, targetPhone, matches));
    return matches;
  }
  const normalized = normalizeDigits(value);
  if (normalized && normalized === targetPhone) {
    matches.add(normalized);
  }
  return matches;
}

function recordContainsPhone(record, phone) {
  return collectPhoneMatches(record, phone).size > 0;
}

function selectBestCallrailCall(calls = [], callLog = {}) {
  if (!Array.isArray(calls) || calls.length === 0) return null;
  const targetStart = callLog.callStartTime
    ? new Date(callLog.callStartTime).getTime()
    : null;
  const targetDuration = Number(callLog.durationSec || 0);

  return [...calls]
    .filter((call) => call && call.id)
    .sort((left, right) => {
      const leftStart = left.start_time ? new Date(left.start_time).getTime() : 0;
      const rightStart = right.start_time ? new Date(right.start_time).getTime() : 0;
      const leftTimeScore = targetStart == null ? 0 : Math.abs(leftStart - targetStart);
      const rightTimeScore = targetStart == null ? 0 : Math.abs(rightStart - targetStart);
      if (leftTimeScore !== rightTimeScore) return leftTimeScore - rightTimeScore;

      const leftDurationScore = Math.abs(Number(left.duration || 0) - targetDuration);
      const rightDurationScore = Math.abs(Number(right.duration || 0) - targetDuration);
      if (leftDurationScore !== rightDurationScore) return leftDurationScore - rightDurationScore;

      return rightStart - leftStart;
    })[0] || null;
}

function selectBestRingcentralRecord(records = [], callLog = {}) {
  if (!Array.isArray(records) || records.length === 0) return null;
  const targetStart = callLog.callStartTime
    ? new Date(callLog.callStartTime).getTime()
    : null;
  const targetDuration = Number(callLog.durationSec || 0);

  return [...records]
    .filter(Boolean)
    .sort((left, right) => {
      const leftStart = left.startTime ? new Date(left.startTime).getTime() : 0;
      const rightStart = right.startTime ? new Date(right.startTime).getTime() : 0;
      const leftTimeScore = targetStart == null ? 0 : Math.abs(leftStart - targetStart);
      const rightTimeScore = targetStart == null ? 0 : Math.abs(rightStart - targetStart);
      if (leftTimeScore !== rightTimeScore) return leftTimeScore - rightTimeScore;

      const leftDurationScore = Math.abs(Number(left.duration || 0) - targetDuration);
      const rightDurationScore = Math.abs(Number(right.duration || 0) - targetDuration);
      if (leftDurationScore !== rightDurationScore) return leftDurationScore - rightDurationScore;

      return rightStart - leftStart;
    })[0] || null;
}

async function resolveCallrailRecording(callLog) {
  const domain = normalizeDomain(callLog.domain);
  const client = createCallrailClient(domain);

  let callId = String(callLog.attempts?.callrail?.callId || "").trim();
  if (!callId) {
    const phone = normalizeDigits(callLog.phone);
    if (!phone) return null;
    const window = buildCallrailDateWindow(callLog.callStartTime);
    const payload = await client.lookupInboundCallByPhone(phone, {
      perPage: 10,
      startDate: window.startDate,
      endDate: window.endDate,
      fields: CALLRAIL_RECORDING_FIELDS,
    });
    const candidate = selectBestCallrailCall(payload.calls || [], callLog);
    callId = String(candidate?.id || "").trim();
  }

  if (!callId) return null;

  const call = await client.getCall(callId, {
    fields: CALLRAIL_RECORDING_FIELDS,
  });
  const recordingPayload = await client.getCallRecording(callId).catch(() => null);
  const sourceUri = String(
    recordingPayload?.url ||
      call?.recording ||
      "",
  ).trim();
  if (!sourceUri) return null;

  const download = await fetchBinary(sourceUri);
  return {
    provider: "callrail",
    sourceUri,
    mimeType: download.mimeType || "audio/mpeg",
    buffer: download.buffer,
    finalUrl: download.finalUrl,
    callrailId: callId,
    recordingDuration: Number(call?.recording_duration || call?.duration || 0) || null,
  };
}

async function findRingcentralRecordForSession(callLog) {
  const rc = createRingCentralClient();
  await rc.reinitializePlatform({ force: false, reason: "recording-archive" });

  const start = callLog.callStartTime
    ? new Date(callLog.callStartTime).getTime()
    : Date.now() - RC_RECORDING_SEARCH_WINDOW_MS;
  const query = {
    view: "Detailed",
    type: "Voice",
    perPage: 100,
    dateFrom: new Date(start - 10 * 60 * 1000).toISOString(),
    dateTo: new Date(start + RC_RECORDING_SEARCH_WINDOW_MS).toISOString(),
  };

  const sessionId = String(callLog.telephonySessionId || "");
  let records = [];
  if (callLog.extensionId) {
    try {
      const payload = await rc.getExtensionCallLog(String(callLog.extensionId), query);
      records = payload.records || [];
    } catch {
      records = [];
    }
  }
  if (records.length === 0) {
    const payload = await rc.getAccountCallLog(query);
    records = payload.records || [];
  }

  const bySession = records.find(
    (record) =>
      record.telephonySessionId === sessionId ||
      (Array.isArray(record.legs) &&
        record.legs.some((leg) => leg.telephonySessionId === sessionId)),
  ) || null;
  if (bySession) return bySession;

  const phone = normalizeDigits(callLog.phone);
  if (!phone) return null;

  const searchVariants = [
    { ...query, phoneNumber: `+1${phone}` },
    query,
  ];
  for (const variant of searchVariants) {
    const payload = await rc.getAccountCallLog(variant).catch(() => null);
    const variantRecords = payload?.records || [];
    const matches = variantRecords.filter((record) => recordContainsPhone(record, phone));
    const winner = selectBestRingcentralRecord(matches, callLog);
    if (winner) return winner;
  }

  return null;
}

async function resolveRingcentralRecording(callLog, rcRecord = null) {
  const record = rcRecord || await findRingcentralRecordForSession(callLog);
  if (!record?.recording?.contentUri) {
    return { artifact: null, record };
  }

  const rc = createRingCentralClient();
  const token = await rc.authenticate();
  const download = await fetchBinary(record.recording.contentUri, {
    headers: { Authorization: `Bearer ${token}` },
  });

  return {
    artifact: {
      provider: "ringcentral",
      sourceUri: record.recording.contentUri,
      mimeType: download.mimeType || "audio/mpeg",
      buffer: download.buffer,
      finalUrl: download.finalUrl,
      recordingDuration: Number(record.duration || 0) || null,
    },
    record,
  };
}

async function resolveRecordingArtifact(callLog, rcRecord = null, logger = null, options = {}) {
  const providerOrder = buildProviderOrder(callLog);
  let mutableRecord = rcRecord || null;
  let lastError = null;
  const ringcxMetadataCache = options.ringcxMetadataCache || null;

  for (const provider of providerOrder) {
    if (provider === "ringcx") {
      try {
        const result = await resolveRingcxRecording(callLog, ringcxMetadataCache);
        if (result?.artifact) {
          return { artifact: result.artifact, rcRecord: mutableRecord, providerOrder };
        }
        // No artifact yet — log the reason for observability and fall
        // through to the next provider (in case the EX or CallRail path
        // happens to have a copy).
        if (result?.reason && result.reason !== "ringcx-recording-disabled") {
          logger?.warn?.("recording_archive.ringcx_missed", {
            telephonySessionId: callLog.telephonySessionId,
            reason: result.reason,
            error: result.error || null,
          });
        }
      } catch (error) {
        lastError = error;
        logger?.warn?.("recording_archive.ringcx_failed", {
          telephonySessionId: callLog.telephonySessionId,
          error: error.message,
        });
      }
      continue;
    }

    if (provider === "callrail") {
      try {
        const artifact = await resolveCallrailRecording(callLog);
        if (artifact) {
          return { artifact, rcRecord: mutableRecord, providerOrder };
        }
      } catch (error) {
        lastError = error;
        logger?.warn?.("recording_archive.callrail_failed", {
          telephonySessionId: callLog.telephonySessionId,
          error: error.message,
        });
      }
      continue;
    }

    if (provider === "ringcentral") {
      try {
        const rcArtifact = await resolveRingcentralRecording(callLog, mutableRecord).catch((error) => {
          error.stage = "download";
          throw error;
        });
        if (rcArtifact?.record) {
          mutableRecord = rcArtifact.record;
        }
        if (rcArtifact?.artifact) {
          return { artifact: rcArtifact.artifact, rcRecord: mutableRecord, providerOrder };
        }
      } catch (error) {
        lastError = error;
        logger?.warn?.("recording_archive.ringcentral_failed", {
          telephonySessionId: callLog.telephonySessionId,
          error: error.message,
        });
      }
    }
  }

  if (lastError) throw lastError;
  return { artifact: null, rcRecord: mutableRecord, providerOrder };
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const stringValue = String(value || "").trim();
    if (stringValue) return stringValue;
  }
  return "";
}

function buildLegCandidate(leg = {}, legIndex = null) {
  const extensionId = firstNonEmpty(
    leg.extension?.id,
    leg.extensionId,
    leg.to?.extensionId,
    leg.from?.extensionId,
  );
  const extensionNumber = firstNonEmpty(
    leg.extension?.extensionNumber,
    leg.to?.extensionNumber,
    leg.from?.extensionNumber,
  );
  let agentName = firstNonEmpty(leg.extension?.name);
  if (!agentName && extensionId && String(leg.from?.extensionId || "").trim() === extensionId) {
    agentName = firstNonEmpty(leg.from?.name);
  }
  if (!agentName && extensionId && String(leg.to?.extensionId || "").trim() === extensionId) {
    agentName = firstNonEmpty(leg.to?.name);
  }
  if (!agentName) {
    agentName = firstNonEmpty(
      leg.from?.name,
      leg.to?.name,
    );
  }

  if (!extensionId && !extensionNumber && !agentName) {
    return null;
  }

  return {
    legIndex,
    extensionId: extensionId || null,
    extensionNumber: extensionNumber || null,
    agentName: agentName || null,
    durationSec: Number(leg.duration || 0) || 0,
    durationMs: Number(leg.durationMs || 0) || 0,
    result: firstNonEmpty(leg.result),
    action: firstNonEmpty(leg.action),
    legType: firstNonEmpty(leg.legType),
    direction: firstNonEmpty(leg.direction),
    internalType: firstNonEmpty(leg.internalType),
    isMaster: Boolean(leg.master),
  };
}

function containsCustomerServiceText(value) {
  return /customer\s*service/i.test(String(value || ""));
}

function legHasCustomerServiceText(leg = {}) {
  return [
    leg?.from?.name,
    leg?.to?.name,
    leg?.extension?.name,
    leg?.name,
    leg?.reason,
    leg?.reasonDescription,
  ].some((value) => containsCustomerServiceText(value));
}

function isConnectedLeg(candidate = {}) {
  const result = String(candidate.result || "").toLowerCase();
  const action = String(candidate.action || "").toLowerCase();
  const legType = String(candidate.legType || "").toLowerCase();
  return (
    (result.includes("call connected") || result.includes("accepted")) &&
    (action.includes("findme") || action.includes("transfer") || legType.includes("findme"))
  );
}

function isIngressQueueLeg(candidate = {}) {
  return (
    candidate.isMaster ||
    (
      String(candidate.direction || "").toLowerCase() === "inbound" &&
      String(candidate.action || "").toLowerCase() === "phone call" &&
      String(candidate.legType || "").toLowerCase() === "accept"
    )
  );
}

function pickTerminalCandidate(candidates = []) {
  const agentCandidates = candidates.filter((candidate) =>
    !isIngressQueueLeg(candidate) &&
    (candidate.agentName || candidate.extensionId || candidate.extensionNumber),
  );
  const connectedAgents = agentCandidates.filter((candidate) => isConnectedLeg(candidate));
  const pool = connectedAgents.length > 0
    ? connectedAgents
    : agentCandidates.length > 0
      ? agentCandidates
      : candidates;

  return [...pool].sort((left, right) => {
    const rightDuration = Number(right.durationSec || 0);
    const leftDuration = Number(left.durationSec || 0);
    if (rightDuration !== leftDuration) return rightDuration - leftDuration;
    const rightMs = Number(right.durationMs || 0);
    const leftMs = Number(left.durationMs || 0);
    if (rightMs !== leftMs) return rightMs - leftMs;
    return Number(right.legIndex ?? -1) - Number(left.legIndex ?? -1);
  })[0] || null;
}

function candidateMatchesGroup(candidate = {}, group = {}) {
  const extensionIds = normalizeStringSet(group.extensionIds);
  const extensionNumbers = normalizeStringSet(group.extensionNumbers);
  const agentNames = normalizeStringSet(group.agentNames, normalizeName);
  const candidateExtensionId = String(candidate.extensionId || "").trim();
  const candidateExtensionNumber = String(candidate.extensionNumber || "").trim();
  const candidateAgentName = normalizeName(candidate.agentName);

  return Boolean(
    (candidateExtensionId && extensionIds.has(candidateExtensionId)) ||
      (candidateExtensionNumber && extensionNumbers.has(candidateExtensionNumber)) ||
      (candidateAgentName && agentNames.has(candidateAgentName)),
  );
}

function anyCandidateMatchesGroup(candidates = [], group = {}) {
  return candidates.some((candidate) => candidateMatchesGroup(candidate, group));
}

function buildCservGroup(cservConfig = {}, groups = []) {
  if (String(cservConfig.folderId || "").trim()) {
    return {
      key: cservConfig.key || "customer-service",
      label: cservConfig.label || "Customer Service",
      folderId: cservConfig.folderId,
      folderConfigured: true,
      extensionIds: [],
      extensionNumbers: cservConfig.queueExtensionNumbers || [],
      agentNames: [],
      routeType: "customer-service",
      fallbackGroupKey: null,
    };
  }

  const fallback = groups[1] || groups.find((group) => String(group?.folderId || "").trim()) || null;
  if (!fallback) return null;
  return {
    ...fallback,
    key: cservConfig.key || "customer-service",
    label: cservConfig.label || "Customer Service",
    folderConfigured: Boolean(String(fallback.folderId || "").trim()),
    routeType: "customer-service",
    fallbackGroupKey: fallback.key || null,
  };
}

async function enrichTerminalCandidate(candidate = {}) {
  let agentState = null;
  if (candidate.extensionId) {
    agentState = await agentStateRepository
      .findAgentStateByExtensionId(candidate.extensionId)
      .catch(() => null);
  }
  if (!agentState && candidate.agentName) {
    agentState = await agentStateRepository
      .findAgentStateByName(candidate.agentName)
      .catch(() => null);
  }

  return {
    ...candidate,
    extensionId: candidate.extensionId || agentState?.extensionId || null,
    extensionNumber: candidate.extensionNumber || null,
    agentName: agentState?.name || candidate.agentName || null,
    agentState: agentState || null,
  };
}

function matchConfiguredGroup(candidate = {}, groups = []) {
  for (const group of groups) {
    if (candidateMatchesGroup(candidate, group)) {
      return {
        ...group,
        folderConfigured: Boolean(String(group.folderId || "").trim()),
      };
    }
  }

  return null;
}

function buildDestination(configured = {}, routeType, fallbackLabel) {
  return {
    key: configured?.key || routeType,
    label: configured?.label || fallbackLabel,
    folderId: configured?.folderId || "",
    folderConfigured: Boolean(String(configured?.folderId || "").trim()),
    routeType,
  };
}

function candidateIsAscsAgent(candidate = {}, ascsAgentNames = getAscsAgentNameSet()) {
  const candidateName = normalizeAgentBucketName(candidate.agentName);
  return Boolean(candidateName && ascsAgentNames.has(candidateName));
}

function candidateIsAlwaysCxAgent(candidate = {}, alwaysCxAgentNames = getAlwaysCxAgentNameSet()) {
  const candidateName = normalizeAgentBucketName(candidate.agentName);
  return Boolean(candidateName && alwaysCxAgentNames.has(candidateName));
}

function normalizeArchiveDirection(value, fallback = "outbound") {
  const clean = String(value || "").trim().toLowerCase();
  if (clean === "inbound" || clean === "outbound") return clean;
  return fallback;
}

function buildRingcxDestination(destinations = {}, direction = "outbound") {
  const normalizedDirection = normalizeArchiveDirection(direction);
  const base = destinations.cx || destinations.as || destinations.og || {};
  return {
    key: base.key || "cx",
    label: base.label || "CX",
    folderId: base.folderId || "",
    folderConfigured: Boolean(String(base.folderId || "").trim()),
    routeType: `ringcx-${normalizedDirection}`,
    sourceGroupKey: base.key || "cx",
  };
}

async function resolveTerminalRouting(callLog, artifact = null, rcRecord = null) {
  const archiveConfig = getArchiveConfig();
  const destinations = archiveConfig.destinations || {};
  const csQueueNumbers = normalizeStringSet(
    destinations.cs?.queueExtensionNumbers || archiveConfig.cserv?.queueExtensionNumbers || [],
  );
  const legs = Array.isArray(rcRecord?.legs) && rcRecord.legs.length > 0
    ? rcRecord.legs
    : Array.isArray(callLog.legsSnapshot)
      ? callLog.legsSnapshot
      : [];
  const hasCustomerServiceTouch = legs.some((leg) => legHasCustomerServiceText(leg));
  const rawCandidates = [];

  for (let index = 0; index < legs.length; index += 1) {
    const candidate = buildLegCandidate(legs[index], index);
    if (candidate) rawCandidates.push(candidate);
  }
  if (callLog.extensionId || callLog.agentName) {
    rawCandidates.push({
      legIndex: null,
      extensionId: callLog.extensionId || null,
      extensionNumber: null,
      agentName: callLog.agentName || null,
    });
  }

  const seen = new Set();
  const candidates = [];
  for (const raw of rawCandidates) {
    const key = [
      raw.legIndex == null ? "none" : raw.legIndex,
      raw.extensionId || "",
      raw.extensionNumber || "",
      String(raw.agentName || "").toLowerCase(),
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(await enrichTerminalCandidate(raw));
  }

  const cservTouches = candidates.filter((candidate) =>
    candidate.extensionNumber && csQueueNumbers.has(String(candidate.extensionNumber).trim()),
  );
  const terminalCandidate = pickTerminalCandidate(candidates);
  const ascsAgentNames = getAscsAgentNameSet();
  const ascsAgentTouches = candidates.filter((candidate) =>
    candidateIsAscsAgent(candidate, ascsAgentNames),
  );
  const alwaysCxAgentNames = getAlwaysCxAgentNameSet();
  const alwaysCxAgentTouches = candidates.filter((candidate) =>
    candidateIsAlwaysCxAgent(candidate, alwaysCxAgentNames),
  );
  const provider = String(artifact?.provider || "").toLowerCase();
  const isRingcxRoute = provider === "ringcx";
  const isAscsAgentRoute = ascsAgentTouches.length > 0;
  const isAlwaysCxAgentRoute = alwaysCxAgentTouches.length > 0;
  const isCustomerServiceRoute =
    provider === "ringcentral" && (cservTouches.length > 0 || hasCustomerServiceTouch);
  const destination =
    isAlwaysCxAgentRoute
        ? buildDestination(destinations.cx || destinations.as, "cx", "CX")
      : isAscsAgentRoute || isCustomerServiceRoute
        ? buildDestination(destinations.cs, "customer-service", "CS")
      : provider === "callrail"
        ? buildDestination(destinations.og, "origination", "OG")
        : isRingcxRoute
        ? buildRingcxDestination(destinations, callLog.direction)
        : buildDestination(destinations.cx || destinations.as, "cx", "CX");
  const routeReason =
    isAlwaysCxAgentRoute
        ? "always-cx-agent-name"
      : isAscsAgentRoute
        ? "as-cs-agent-name"
      : provider === "callrail"
        ? "callrail-provider"
      : isRingcxRoute
        ? `ringcx-${normalizeArchiveDirection(callLog.direction)}-provider`
      : isCustomerServiceRoute
        ? hasCustomerServiceTouch
          ? "customer-service-text-touch"
          : "customer-service-queue-touch"
        : "ringcentral-provider-cx-default";
  return {
    candidate: terminalCandidate,
    destination,
    candidates,
    routeReason,
    queueTouches: cservTouches,
    alwaysCxAgentTouches,
    ascsAgentTouches,
  };
}

async function writeArchiveState(callLogId, update = {}) {
  if (!callLogId) return;
  await CallLog.updateOne(
    { _id: callLogId },
    { $set: update },
  );
}

async function createArchiveReviewItem(callLog, title, summary, payload = {}) {
  return reviewQueueRepository.createReviewQueueItem({
    domain: normalizeDomain(callLog.domain),
    caseId: callLog.caseId != null ? Number(callLog.caseId) : null,
    sourceService: "recording-archive",
    workflow: "recording-archive",
    category: "telephony",
    severity: "warning",
    title,
    summary,
    happenedAt: new Date(),
    payload: {
      telephonySessionId: callLog.telephonySessionId,
      callLogId: String(callLog._id),
      ...payload,
    },
    tags: ["recording-archive", "telephony", normalizeDomain(callLog.domain)],
  });
}

async function queueCallRecordingArchiveJob(callLogDoc, {
  force = false,
  lane = "hourly",
} = {}) {
  const config = getArchiveConfig();
  if (!config.enabled || !isRecordingArchiveConfigured()) {
    return { queued: false, reason: "archive-not-configured" };
  }
  if (!callLogDoc?.telephonySessionId) {
    return { queued: false, reason: "missing-session" };
  }
  const excludedAgent = findExcludedCallLogAgentMatch(callLogDoc);
  if (excludedAgent) {
    await writeArchiveState(callLogDoc._id, {
      "recordingArchive.status": "skipped",
      "recordingArchive.error": `Excluded internal/test agent: ${excludedAgent.value}`,
    });
    return { queued: false, reason: "excluded-agent" };
  }
  if (!force && !qualifiesForArchive(callLogDoc, config)) {
    return { queued: false, reason: "below-threshold" };
  }
  if (isTerminalArchiveStatus(callLogDoc.recordingArchive?.status)) {
    return { queued: false, reason: "already-terminal" };
  }

  await writeArchiveState(callLogDoc._id, {
    "recordingArchive.status": "pending",
    "recordingArchive.error": null,
  });

  const nextAttemptAt = computeArchiveNextAttemptAt(callLogDoc, config);
  const result = await emitHourlyJobEvent({
    lane: String(lane || "hourly").toLowerCase() === "nightly" ? "nightly" : "hourly",
    domain: callLogDoc.domain,
    eventType: "call.recording.archive.pending",
    targetService: "control-plane",
    handlerKey: "retryCallRecordingArchive",
    aggregateType: "call-log",
    aggregateId: String(callLogDoc.telephonySessionId),
    caseId: callLogDoc.caseId != null ? Number(callLogDoc.caseId) : null,
    payload: {
      telephonySessionId: String(callLogDoc.telephonySessionId),
      callLogId: String(callLogDoc._id),
      extensionId: callLogDoc.extensionId || null,
    },
    resolutionCheckKey: "recording-archive-ready-state",
    resolutionContext: {
      telephonySessionId: String(callLogDoc.telephonySessionId),
      extensionId: callLogDoc.extensionId || null,
    },
    dedupeKey: `${normalizeDomain(callLogDoc.domain)}:recording-archive:${String(callLogDoc.telephonySessionId)}`,
    emittedBy: "recording-archive",
    priority: 55,
    severity: "warning",
    nextAttemptAt,
    maxAttempts: Number(config.maxAttempts) || 24,
    notify: false,
  });

  return {
    queued: true,
    deduped: Boolean(result?.deduped),
    jobId: result?.job?._id ? String(result.job._id) : null,
  };
}

async function processCallRecordingArchive({
  domain,
  telephonySessionId,
  logger = null,
  ringcxMetadataCache = null,
} = {}) {
  const normalizedDomain = normalizeDomain(domain);
  const config = getArchiveConfig();

  const callLog = await CallLog.findOne({
    domain: normalizedDomain,
    telephonySessionId: String(telephonySessionId || ""),
  }).lean();

  if (!callLog) {
    const error = new Error("CallLog row not found");
    error.deadLetter = true;
    throw error;
  }

  if (!config.enabled || !isRecordingArchiveConfigured()) {
    await writeArchiveState(callLog._id, {
      "recordingArchive.status": "skipped",
      "recordingArchive.error": "Recording archive is disabled or not configured",
    });
    return { status: "skipped" };
  }

  if (!qualifiesForArchive(callLog, config)) {
    await writeArchiveState(callLog._id, {
      "recordingArchive.status": "skipped",
      "recordingArchive.error": "Call does not meet archive threshold",
    });
    return { status: "skipped" };
  }

  if (callLog.recordingArchive?.status === "completed") {
    return {
      status: "completed",
      driveFileId: callLog.recordingArchive?.driveFileId || null,
      provider: callLog.recordingArchive?.provider || null,
    };
  }

  const callEndReference = getCallEndReference(callLog);
  if (callEndReference) {
    const ageMs = Date.now() - new Date(callEndReference).getTime();
    const minAgeMs = minRecordingAgeMsForCallLog(callLog);
    if (ageMs < minAgeMs) {
      const nextAttemptAt = new Date(new Date(callEndReference).getTime() + minAgeMs);
      await writeArchiveState(callLog._id, {
        "recordingArchive.status": "too_early",
        "recordingArchive.error": `Recording not ready yet (${ageMs}ms old)`,
      });
      throw buildRetryError("Recording still settling", { nextAttemptAt });
    }
  }

  const attemptNumber = Number(callLog.recordingArchive?.attempts || 0) + 1;
  await writeArchiveState(callLog._id, {
    "recordingArchive.status": "processing",
    "recordingArchive.attempts": attemptNumber,
    "recordingArchive.error": null,
  });

  let rcRecord = null;
  try {
    const needsFreshRcRecord =
      !Array.isArray(callLog.legsSnapshot) ||
      callLog.legsSnapshot.length === 0;
    if (needsFreshRcRecord) {
      rcRecord = await findRingcentralRecordForSession(callLog).catch(() => null);
      if (rcRecord?.legs?.length) {
        await CallLog.updateOne(
          { _id: callLog._id },
          { $set: { legsSnapshot: rcRecord.legs } },
        );
      }
    }

    const recordingResolution = await resolveRecordingArtifact(
      callLog,
      rcRecord,
      logger,
      { ringcxMetadataCache },
    );
    const artifact = recordingResolution.artifact;
    rcRecord = recordingResolution.rcRecord || rcRecord;
    if (
      (!Array.isArray(callLog.legsSnapshot) || callLog.legsSnapshot.length === 0) &&
      rcRecord?.legs?.length
    ) {
      await CallLog.updateOne(
        { _id: callLog._id },
        { $set: { legsSnapshot: rcRecord.legs } },
      );
    }

    const routing = await resolveTerminalRouting(callLog, artifact, rcRecord);
    const candidate = routing.candidate || null;
    const destination = routing.destination || null;
    const baseState = {
      "recordingArchive.terminalAgentName": normalizeAgentDisplayName(candidate?.agentName || "") || null,
      "recordingArchive.terminalExtensionId": candidate?.extensionId || null,
      "recordingArchive.terminalExtensionNumber": candidate?.extensionNumber || null,
      "recordingArchive.terminalLegIndex": candidate?.legIndex ?? null,
      "recordingArchive.agentGroupKey": destination?.key || null,
      "recordingArchive.agentGroupLabel": destination?.label || null,
    };
    const excludedAgent = findExcludedCallLogAgentMatch(callLog, routing);
    if (excludedAgent) {
      await writeArchiveState(callLog._id, {
        ...baseState,
        "recordingArchive.status": "skipped",
        "recordingArchive.error": `Excluded internal/test agent: ${excludedAgent.value}`,
      });
      return {
        status: "skipped",
        reason: "excluded-agent",
      };
    }

    if (!artifact) {
      const exhausted = attemptNumber >= Number(config.maxAttempts || 24);
      const providerNote =
        String(callLog.direction || "").toLowerCase() === "outbound"
          ? "No recording found from RingCentral/CallRail; CX recording may not be exposed yet."
          : "Recording not available yet";
      await writeArchiveState(callLog._id, {
        ...baseState,
        "recordingArchive.status": exhausted ? "abandoned" : "no_recording",
        "recordingArchive.error": exhausted
          ? `Recording not found after ${attemptNumber} attempts`
          : providerNote,
      });
      if (exhausted) {
        await createArchiveReviewItem(
          callLog,
          "Recording archive gave up",
          "Long call never produced an audio file from CallRail or RingCentral before retries were exhausted.",
          {
            reason: "recording-never-available",
            terminalAgent: candidate,
            providersTried: recordingResolution.providerOrder,
          },
        ).catch(() => null);
        return { status: "abandoned", attempts: attemptNumber };
      }
      throw buildRetryError("Recording not available yet", {
        nextAttemptAt: new Date(Date.now() + retryDelayMsForCallLog(callLog)),
      });
    }

    if (!destination?.folderConfigured) {
      await writeArchiveState(callLog._id, {
        ...baseState,
        "recordingArchive.status": "no_group_match",
        "recordingArchive.error": "No configured Google Drive destination matched the recording provider",
      });
      await createArchiveReviewItem(
        callLog,
        "Recording archive missing destination route",
        "Recording was found, but no configured Google Drive destination matched the provider/queue rule.",
        {
          reason: "no-destination-match",
          terminalAgent: candidate,
          routeReason: routing.routeReason || null,
          provider: artifact.provider,
          queueTouches: routing.queueTouches || [],
        },
      ).catch(() => null);
      return { status: "no_group_match" };
    }

    const driveClient = createGoogleDriveClient(config.drive);
    const fileName = buildRecordingFileName(callLog, routing, artifact);
    const dateKey = formatDateStamp(callLog.callStartTime);
    const archiveFileProperties = {
      telephonySessionId: String(callLog.telephonySessionId),
      domain: normalizeDomain(callLog.domain),
      provider: String(artifact.provider || ""),
      platform: String(callLog.platform || ""),
      direction: normalizeArchiveDirection(callLog.direction, "unknown"),
      bucket: destination.key || "",
      dateKey,
    };

    // Drive-side idempotency: search globally by appProperties for a
    // file already tagged with the same telephonySessionId before
    // uploading. The `recordingArchive.status === "completed"` early
    // return higher up usually catches this, but Mongo status resets /
    // EOD batch reprocessing / migration mid-flight can sneak through.
    //
    // No parent filter: post-reorg files live in
    // `<bucket>/<dateKey>/` while pre-reorg ones still sit flat in
    // `<bucket>/`. telephonySessionId is unique enough that a single
    // appProperty match is safe without scoping to either parent.
    const existingDriveFiles = await driveClient
      .findFilesByAppProperties({
        appProperties: {
          telephonySessionId: String(callLog.telephonySessionId),
        },
        pageSize: 1,
      })
      .catch(() => []);
    if (existingDriveFiles.length > 0) {
      const existing = existingDriveFiles[0];
      const existingFolderId =
        Array.isArray(existing.parents) && existing.parents.length > 0
          ? existing.parents[0]
          : destination.folderId;
      logger?.info?.("recording_archive.drive_dup_skip", {
        telephonySessionId: callLog.telephonySessionId,
        driveFileId: existing.id,
        existingName: existing.name,
        existingFolderId,
      });
      await writeArchiveState(callLog._id, {
        ...baseState,
        "recordingArchive.status": "completed",
        "recordingArchive.provider": artifact.provider,
        "recordingArchive.fileName": existing.name || fileName,
        "recordingArchive.driveFileId": existing.id || null,
        "recordingArchive.driveFolderId": existingFolderId,
        "recordingArchive.driveWebViewLink": existing.webViewLink || null,
        "recordingArchive.driveWebContentLink": existing.webContentLink || null,
        "recordingArchive.error": null,
        "recordingArchive.dedupedAt": new Date(),
      });
      return {
        status: "completed",
        deduped: true,
        provider: artifact.provider,
        driveFileId: existing.id || null,
        driveFolderId: existingFolderId,
        fileName: existing.name || fileName,
      };
    }

    // Resolve `<bucket>/<dateKey>/` (find-or-create) so the new file
    // lands in its date subfolder. Falling back to the bucket root only
    // happens if ensureFolder somehow returns null, which would be a
    // Drive API anomaly worth letting downstream code surface.
    const dateSubfolder = await driveClient
      .ensureFolder({
        parentId: destination.folderId,
        name: dateKey,
      })
      .catch((error) => {
        error.stage = "upload";
        throw error;
      });
    const uploadFolderId = dateSubfolder?.id || destination.folderId;

    const upload = await driveClient.uploadFileResumable({
      folderId: uploadFolderId,
      name: fileName,
      mimeType: artifact.mimeType,
      buffer: artifact.buffer,
      appProperties: archiveFileProperties,
      properties: archiveFileProperties,
      description: `Archived call recording for ${normalizeDomain(callLog.domain)} ${callLog.caseId ? `case ${callLog.caseId}` : "unbound call"}`,
    }).catch((error) => {
      error.stage = "upload";
      throw error;
    });

    await writeArchiveState(callLog._id, {
      ...baseState,
      "recordingArchive.status": "completed",
      "recordingArchive.provider": artifact.provider,
      "recordingArchive.sourceUri": artifact.sourceUri || artifact.finalUrl || null,
      "recordingArchive.mimeType": artifact.mimeType || null,
      "recordingArchive.fileName": fileName,
      "recordingArchive.uploadedAt": new Date(),
      "recordingArchive.driveFileId": upload?.id || null,
      "recordingArchive.driveFolderId": uploadFolderId,
      "recordingArchive.driveWebViewLink": upload?.webViewLink || null,
      "recordingArchive.driveWebContentLink": upload?.webContentLink || null,
      "recordingArchive.error": null,
    });

    return {
      status: "completed",
      provider: artifact.provider,
      driveFileId: upload?.id || null,
      driveFolderId: uploadFolderId,
      fileName,
    };
  } catch (error) {
    if (error.retryable) {
      await writeArchiveState(callLog._id, {
        "recordingArchive.status": "retrying",
        "recordingArchive.error": error.message,
      }).catch(() => null);
      throw error;
    }
    if (error.deadLetter) {
      throw error;
    }

    const failStatus =
      error.stage === "upload"
        ? "upload_failed"
        : error.stage === "download"
          ? "download_failed"
          : "error";
    await writeArchiveState(callLog._id, {
      "recordingArchive.status": failStatus,
      "recordingArchive.error": error.message,
    });
    throw error;
  }
}

module.exports = {
  isRecordingArchiveConfigured,
  isRingcxRecordingEnabled,
  isTerminalArchiveStatus,
  buildRingcxMetadataCache,
  processCallRecordingArchive,
  queueCallRecordingArchiveJob,
  resolveRingcxRecording,
};
