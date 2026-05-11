"use strict";

const {
  getSharedConfig,
} = require("../../shared-config/src");
const {
  createCallrailClient,
  createGoogleDriveClient,
  createRingCentralClient,
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
const DOWNLOAD_TIMEOUT_MS =
  Number(process.env.RECORDING_ARCHIVE_DOWNLOAD_TIMEOUT_MS) || 60_000;
const TERMINAL_ARCHIVE_STATUSES = new Set([
  "completed",
  "no_group_match",
  "skipped",
  "abandoned",
]);
const AMBIGUOUS_ADSERV_AGENTS = new Set(["bruce allen"]);

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

function buildRetryError(message) {
  const error = new Error(message);
  error.retryable = true;
  return error;
}

function buildProviderOrder(callLog = {}) {
  return ["callrail", "ringcentral"];
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

async function resolveRecordingArtifact(callLog, rcRecord = null, logger = null) {
  const providerOrder = buildProviderOrder(callLog);
  let mutableRecord = rcRecord || null;
  let lastError = null;

  for (const provider of providerOrder) {
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
  const provider = String(artifact?.provider || "").toLowerCase();
  const isCustomerServiceRoute =
    provider === "ringcentral" && (cservTouches.length > 0 || hasCustomerServiceTouch);
  const destination =
    provider === "callrail"
      ? buildDestination(destinations.og, "origination", "OG")
      : isCustomerServiceRoute
        ? buildDestination(destinations.cs, "customer-service", "CS")
        : buildDestination(destinations.as, "ad-serv", "AS");
  const routeReason =
    provider === "callrail"
      ? "callrail-provider"
      : isCustomerServiceRoute
        ? hasCustomerServiceTouch
          ? "customer-service-text-touch"
          : "customer-service-queue-touch"
        : "ringcentral-provider";
  return {
    candidate: terminalCandidate,
    destination,
    candidates,
    routeReason,
    queueTouches: cservTouches,
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

  const nextAttemptAt = new Date(Date.now() + Math.max(Number(config.initialDelayMs) || 0, 0));
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

  const callEndReference =
    callLog.callEndTime ||
    (callLog.callStartTime && callLog.durationSec
      ? new Date(
          new Date(callLog.callStartTime).getTime() +
            Number(callLog.durationSec || 0) * 1000,
        )
      : callLog.callStartTime);
  if (callEndReference) {
    const ageMs = Date.now() - new Date(callEndReference).getTime();
    if (ageMs < MIN_RECORDING_AGE_MS) {
      await writeArchiveState(callLog._id, {
        "recordingArchive.status": "too_early",
        "recordingArchive.error": `Recording not ready yet (${ageMs}ms old)`,
      });
      throw buildRetryError("Recording still settling");
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

    const recordingResolution = await resolveRecordingArtifact(callLog, rcRecord, logger);
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
      throw buildRetryError("Recording not available yet");
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
      appProperties: {
        telephonySessionId: String(callLog.telephonySessionId),
        domain: normalizeDomain(callLog.domain),
        provider: artifact.provider,
        bucket: destination.key || "",
        dateKey,
      },
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
    if (error.deadLetter || error.retryable) {
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
  isTerminalArchiveStatus,
  processCallRecordingArchive,
  queueCallRecordingArchiveJob,
};
