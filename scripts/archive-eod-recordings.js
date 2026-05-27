"use strict";

const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const mm = require("music-metadata");

require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

// Parse the actual audio file's duration from the in-memory buffer
// before upload. Source-of-truth duration: the API-reported call
// duration drifts from the recording (calls that transfer or clip
// produce shorter audio than the call lifecycle). Returns 0 if the
// parse fails — caller should treat that as "unknown" and decide.
async function parseAudioDurationSec(buffer, mimeType) {
  try {
    const metadata = await mm.parseBuffer(
      buffer,
      mimeType ? { mimeType } : undefined,
      { duration: true, skipCovers: true, skipPostHeaders: true },
    );
    const seconds = Number(metadata?.format?.duration || 0);
    return Number.isFinite(seconds) ? seconds : 0;
  } catch {
    return 0;
  }
}

const {
  createCallrailClient,
  createGoogleDriveClient,
  createRingCentralClient,
} = require("../packages/shared-integrations/src");
const {
  getCompanyKeys,
  getInternalFromEmail,
  getSharedConfig,
} = require("../packages/shared-config/src");
const {
  listLegacyContactActivityDocs,
} = require("../packages/shared-services/src/legacyContactActivityService");
const {
  CallLog,
} = require("../packages/shared-models/src");
const {
  sendPlainEmail,
} = require("../packages/shared-services/src/sendgridMailService");
const {
  syncCallLedgerFromCallLog,
} = require("../packages/shared-services/src/callLedgerService");

const TIME_ZONE = "America/Los_Angeles";
const DEFAULT_MIN_DURATION_SEC = 480;
const DEFAULT_OUTPUT_ROOT = path.resolve(
  __dirname,
  "..",
  "ops",
  "end-of-day-recordings",
);
const DEFAULT_DELAY_MS = 400;
const DEFAULT_DOWNLOAD_RETRIES = 4;
const DEFAULT_RETRY_BASE_DELAY_MS = 3000;
const MAX_RETRY_DELAY_MS = 90_000;
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

const CALLRAIL_FIELDS = [
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

function parseArgs(argv = []) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || "");
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || String(next).startsWith("--")) {
      args[key] = "true";
      continue;
    }
    args[key] = String(next);
    index += 1;
  }
  return args;
}

function boolArg(value, fallback = false) {
  if (value == null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return fallback;
  return !["0", "false", "no", "off"].includes(normalized);
}

function parseList(value) {
  if (Array.isArray(value)) {
    return value
      .map((entry) => String(entry || "").trim())
      .filter(Boolean);
  }
  return String(value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(Number(ms) || 0, 0)));
}

function parseRetryAfterMs(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(raw);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : null;
}

function isRetryableHttpStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

function createDownloadError(response, body = "", url = "") {
  const error = new Error(
    `Binary download failed (${response.status}): ${String(body).slice(0, 240)}`,
  );
  error.status = response.status;
  error.retryable = isRetryableHttpStatus(response.status);
  error.retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
  error.url = url;
  return error;
}

function normalizeDigits(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

function normalizeAgentDisplayName(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const withoutCompanySuffix = raw.replace(/\s*-\s*(tag|wynn|amity)\b.*$/i, "").trim();
  const firstSegment = withoutCompanySuffix.split(/\s*-\s*/)[0].trim();
  return firstSegment || withoutCompanySuffix || raw;
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

function collectRcIdentityTexts(record = null) {
  if (!record) return [];
  const values = [
    record?.from?.name,
    record?.from?.email,
    record?.to?.name,
    record?.to?.email,
    record?.extension?.name,
  ];
  for (const leg of Array.isArray(record?.legs) ? record.legs : []) {
    values.push(
      leg?.from?.name,
      leg?.from?.email,
      leg?.to?.name,
      leg?.to?.email,
      leg?.extension?.name,
      leg?.name,
    );
  }
  return values;
}

function findExcludedAgentMatch(values = [], excludeTokens = []) {
  const normalizedTokens = parseList(excludeTokens)
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

function findExcludedTaskAgentMatch(task = {}, excludeTokens = []) {
  return findExcludedAgentMatch(
    [
      task.seed?.agentName,
      task.routing?.candidate?.agentName,
      ...collectRcIdentityTexts(task.rcRecord),
    ],
    excludeTokens,
  );
}

function isCallrailArchiveTask(task = {}) {
  return (
    task.providerHint === "callrail" ||
    task.sourceKind === "callrail-direct" ||
    Boolean(task.callrailMatch) ||
    Boolean(task.callrailCallId)
  );
}

async function stampCallLogRecordingArchive({ task, artifact, upload, uploadFolderId, fileName }) {
  const sessionId = String(task?.telephonySessionId || "").trim();
  if (!sessionId || !upload?.id) {
    return { matchedCount: 0, modifiedCount: 0, skipped: true };
  }

  const routing = task.routing || {};
  const candidate = routing.candidate || null;
  const bucket = routing.bucket || null;
  const update = {
    "recordingArchive.status": "completed",
    "recordingArchive.provider": artifact.provider || null,
    "recordingArchive.sourceUri": artifact.sourceUri || artifact.finalUrl || null,
    "recordingArchive.mimeType": artifact.mimeType || null,
    "recordingArchive.fileName": fileName || upload.name || null,
    "recordingArchive.uploadedAt": new Date(),
    "recordingArchive.driveFileId": upload.id || null,
    "recordingArchive.driveFolderId": uploadFolderId || upload.parents?.[0] || null,
    "recordingArchive.driveWebViewLink": upload.webViewLink || null,
    "recordingArchive.driveWebContentLink": upload.webContentLink || null,
    "recordingArchive.error": null,
    "recordingArchive.terminalAgentName": normalizeAgentDisplayName(candidate?.agentName || "") || null,
    "recordingArchive.terminalExtensionId": candidate?.extensionId || null,
    "recordingArchive.terminalExtensionNumber": candidate?.extensionNumber || null,
    "recordingArchive.terminalLegIndex": candidate?.legIndex ?? null,
    "recordingArchive.agentGroupKey": String(bucket || "").toLowerCase() || null,
    "recordingArchive.agentGroupLabel": bucket || null,
  };

  const result = await CallLog.updateMany(
    { telephonySessionId: sessionId },
    { $set: update },
  );
  let ledgerSynced = 0;
  if (Number(result.matchedCount || 0) > 0) {
    const callLogs = await CallLog.find({ telephonySessionId: sessionId }).lean();
    for (const callLog of callLogs) {
      const syncResult = await syncCallLedgerFromCallLog(callLog, { syncedAt: new Date() }).catch(() => null);
      if (syncResult && !syncResult.skipped) ledgerSynced += 1;
    }
  }
  return {
    matchedCount: Number(result.matchedCount || 0),
    modifiedCount: Number(result.modifiedCount || 0),
    ledgerSynced,
  };
}

function sanitizeFileComponent(value, fallback = "unknown") {
  const cleaned = String(value || "")
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  return cleaned || fallback;
}

function inferExtension(mimeType = "", sourceUri = "") {
  const lowerMime = String(mimeType || "").toLowerCase();
  if (lowerMime.includes("wav")) return "wav";
  if (lowerMime.includes("mpeg") || lowerMime.includes("mp3")) return "mp3";
  if (lowerMime.includes("ogg")) return "ogg";
  if (lowerMime.includes("mp4") || lowerMime.includes("m4a")) return "m4a";
  const pathname = String(sourceUri || "").split("?")[0];
  const ext = pathname.includes(".") ? pathname.split(".").pop() : "";
  return String(ext || "bin").toLowerCase();
}

function coerceDate(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (value == null || value === "") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatDateKeyForZone(date = new Date(), timeZone = TIME_ZONE) {
  const safeDate = coerceDate(date);
  if (!safeDate) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(safeDate);
}

function getTimeZoneOffsetMs(date, timeZone = TIME_ZONE) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  const zonedUtcMs = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return zonedUtcMs - date.getTime();
}

function zonedDateTimeToUtc(dateKey, timeString, timeZone = TIME_ZONE) {
  const [year, month, day] = String(dateKey).split("-").map((value) => Number(value));
  const [hour, minute, second] = String(timeString)
    .split(":")
    .map((value) => Number(value || 0));
  const naiveUtcMs = Date.UTC(year, month - 1, day, hour, minute, second || 0, 0);
  const offsetMs = getTimeZoneOffsetMs(new Date(naiveUtcMs), timeZone);
  return new Date(naiveUtcMs - offsetMs);
}

function buildDayWindow(dateKey, timeZone = TIME_ZONE) {
  const start = zonedDateTimeToUtc(dateKey, "00:00:00", timeZone);
  const end = new Date(zonedDateTimeToUtc(dateKey, "23:59:59", timeZone).getTime() + 999);
  return { start, end };
}

function toIsoDate(date) {
  const safeDate = coerceDate(date);
  return safeDate ? safeDate.toISOString() : null;
}

function toCalendarDate(date) {
  const safeDate = coerceDate(date);
  return safeDate ? safeDate.toISOString().slice(0, 10) : null;
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const stringValue = String(value || "").trim();
    if (stringValue) return stringValue;
  }
  return "";
}

function collectTenDigitPhones(value, set = new Set()) {
  if (value == null) return set;
  if (Array.isArray(value)) {
    value.forEach((entry) => collectTenDigitPhones(entry, set));
    return set;
  }
  if (typeof value === "object") {
    Object.values(value).forEach((entry) => collectTenDigitPhones(entry, set));
    return set;
  }
  const digits = normalizeDigits(value);
  if (digits && digits.length === 10) set.add(digits);
  return set;
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
    agentName = firstNonEmpty(leg.from?.name, leg.to?.name);
  }

  if (!extensionId && !extensionNumber && !agentName) return null;

  return {
    legIndex,
    extensionId: extensionId || null,
    extensionNumber: extensionNumber || null,
    agentName: normalizeAgentDisplayName(agentName) || null,
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

function containsPhoneBurnerText(value) {
  return /phone\s*burner/i.test(String(value || ""));
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

/**
 * Interoffice = both ends of the call are internal extensions.
 *
 * "Origin is internal":
 *   - Outbound calls always originate internally (we placed it).
 *   - Inbound calls originate internally only when leg-1's `from` has
 *     an `extensionId` populated (extension dialing extension).
 *
 * "Terminal is internal":
 *   - Pick the leg that actually connected with an internal `to`
 *     (`Call connected` / `Accepted` + `to.extensionId` set). Falling
 *     back to the last leg's `to` covers cases where no leg cleanly
 *     transitions to "connected" (eg short ring-and-drops between
 *     desks). External callers never carry `to.extensionId`, so this
 *     check stays false for prospect / client interactions.
 *
 * When both sides are internal we don't archive — the recording isn't
 * a prospect interaction and pollutes AS otherwise.
 */
function isInterofficeCall(rcRecord = null) {
  const legs = Array.isArray(rcRecord?.legs) ? rcRecord.legs : [];
  if (legs.length === 0) return false;

  const leg1 = legs[0] || {};
  const leg1Direction = String(leg1.direction || "").toLowerCase();
  const originIsInternal =
    leg1Direction === "outbound"
      || Boolean(leg1.from?.extensionId);
  if (!originIsInternal) return false;

  const connectedTerminal = legs.find((leg) => {
    const result = String(leg.result || "").toLowerCase();
    return Boolean(leg.to?.extensionId)
      && (result.includes("connected") || result.includes("accepted"));
  });
  const terminalLeg = connectedTerminal || legs[legs.length - 1] || {};
  const terminalIsInternal = Boolean(terminalLeg.to?.extensionId);

  return terminalIsInternal;
}

function deriveRouting(provider, rcRecord = null, seed = {}) {
  const legs = Array.isArray(rcRecord?.legs) ? rcRecord.legs : [];
  const candidates = [];
  for (let index = 0; index < legs.length; index += 1) {
    const candidate = buildLegCandidate(legs[index], index);
    if (candidate) candidates.push(candidate);
  }
  if (seed.extensionId || seed.agentName) {
    candidates.push({
      legIndex: null,
      extensionId: seed.extensionId || null,
      extensionNumber: seed.extensionNumber || null,
      agentName: normalizeAgentDisplayName(seed.agentName || "") || null,
      durationSec: Number(seed.durationSec || 0) || 0,
      durationMs: 0,
      result: "",
      action: "",
      legType: "",
      direction: seed.direction || "",
      internalType: "",
      isMaster: false,
    });
  }

  const terminalCandidate = pickTerminalCandidate(candidates);
  const queueTouches = candidates.filter((candidate) =>
    ["505", "5051", "5052"].includes(String(candidate.extensionNumber || "").trim()),
  );
  const hasCustomerServiceTouch = legs.some((leg) => legHasCustomerServiceText(leg));
  const phoneBurnerTouch =
    containsPhoneBurnerText(seed.source) ||
    containsPhoneBurnerText(seed.contactMethod) ||
    containsPhoneBurnerText(seed.agentName) ||
    containsPhoneBurnerText(rcRecord?.from?.name) ||
    containsPhoneBurnerText(rcRecord?.to?.name) ||
    candidates.some((candidate) => containsPhoneBurnerText(candidate.agentName));

  // Interoffice exclusion takes precedence over OG/CS/CX bucketing.
  // CallRail-provider calls bypass the check by construction (CallRail
  // sources only carry external prospects), but keep the guard tight
  // so a future leg shape couldn't sneak through.
  const interoffice = provider !== "callrail" && isInterofficeCall(rcRecord);

  const bucket = interoffice
    ? null
    : provider === "callrail" || phoneBurnerTouch
      ? "OG"
      : (queueTouches.length > 0 || hasCustomerServiceTouch)
          ? "CS"
          : "CX";

  return {
    bucket,
    interoffice,
    candidate: terminalCandidate,
    queueTouches,
    hasCustomerServiceTouch,
  };
}

function buildFileName(task) {
  const agentPart = sanitizeFileComponent(
    String(normalizeAgentDisplayName(task.routing?.candidate?.agentName || task.seed?.agentName || "") || "UNKNOWN AGENT").toUpperCase(),
    "UNKNOWN-AGENT",
  );
  const bucketPart = sanitizeFileComponent(String(task.routing?.bucket || "UNASSIGNED").toUpperCase(), "UNASSIGNED");
  const datePart = sanitizeFileComponent(task.dateKey || "unknown-date");
  const phonePart = sanitizeFileComponent(normalizeDigits(task.phone) || "unknown-phone");
  const idPart = sanitizeFileComponent(
    task.telephonySessionId ||
      task.callrailCallId ||
      task.callSessionId ||
      task.seed?._id ||
      "unknown-id",
  );
  const extension = inferExtension(task.artifact?.mimeType, task.artifact?.sourceUri);

  return `${agentPart}__${bucketPart}__${datePart}__${phonePart}__${idPart}.${extension}`;
}

async function fetchBinary(url, options = {}) {
  const maxAttempts = Math.max(
    1,
    Number(
      options.maxAttempts ||
        process.env.RECORDING_ARCHIVE_DOWNLOAD_RETRIES ||
        DEFAULT_DOWNLOAD_RETRIES,
    ) || DEFAULT_DOWNLOAD_RETRIES,
  );
  const baseDelayMs = Math.max(
    0,
    Number(
      options.retryBaseDelayMs ||
        process.env.RECORDING_ARCHIVE_RETRY_BASE_DELAY_MS ||
        DEFAULT_RETRY_BASE_DELAY_MS,
    ) || DEFAULT_RETRY_BASE_DELAY_MS,
  );
  const fetchOptions = { ...options };
  delete fetchOptions.maxAttempts;
  delete fetchOptions.retryBaseDelayMs;

  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await fetch(url, fetchOptions);
    if (response.ok) {
      return {
        buffer: Buffer.from(await response.arrayBuffer()),
        mimeType: response.headers.get("content-type") || "application/octet-stream",
        finalUrl: response.url || url,
      };
    }

    const text = await response.text().catch(() => "");
    lastError = createDownloadError(response, text, url);
    if (!lastError.retryable || attempt >= maxAttempts) {
      throw lastError;
    }

    const retryDelayMs = Math.min(
      Math.max(lastError.retryAfterMs || 0, baseDelayMs * attempt),
      MAX_RETRY_DELAY_MS,
    );
    await sleep(retryDelayMs);
  }

  throw lastError || new Error("Binary download failed");
}

async function fetchRcRecordsForDay(rcClient, dateKey) {
  const query = {
    view: "Detailed",
    type: "Voice",
    perPage: 1000,
    dateFrom: `${dateKey}T00:00:00.000Z`,
    dateTo: `${dateKey}T23:59:59.999Z`,
  };
  const payload = await rcClient.getAccountCallLog(query);
  return Array.isArray(payload?.records) ? payload.records : [];
}

async function fetchCallrailCallsForDay(dateKey, minDurationSec) {
  const calls = [];
  for (const companyKey of getCompanyKeys()) {
    let client;
    try {
      client = createCallrailClient(companyKey);
    } catch {
      client = null;
    }
    if (!client) continue;

    try {
      const payload = await client.listInboundCallsForRange({
        startDate: dateKey,
        endDate: dateKey,
        perPage: 250,
        maxPages: 20,
        fields: CALLRAIL_FIELDS,
      });
      for (const call of payload.calls || []) {
        const durationSec =
          Number(call.recording_duration || call.duration || 0) || 0;
        if (durationSec < minDurationSec) continue;
        const phone = normalizeDigits(call.customer_phone_number);
        if (!phone || !call.id) continue;
        calls.push({
          provider: "callrail",
          companyKey,
          callId: String(call.id),
          phone,
          startedAt: call.start_time || null,
          durationSec,
          sourceName: call.source_name || null,
          raw: call,
        });
      }
    } catch {
      // Skip missing or broken company configs; summary will show call count.
    }
  }
  return calls.sort((left, right) =>
    new Date(left.startedAt || 0).getTime() - new Date(right.startedAt || 0).getTime(),
  );
}

function buildRcIndexes(records = []) {
  const bySession = new Map();
  const byPhone = new Map();

  for (const record of records) {
    const sessionKey = String(record.telephonySessionId || "").trim();
    if (sessionKey && !bySession.has(sessionKey)) {
      bySession.set(sessionKey, record);
    }

    const phones = [...collectTenDigitPhones(record)];
    for (const phone of phones) {
      if (!byPhone.has(phone)) byPhone.set(phone, []);
      byPhone.get(phone).push(record);
    }
  }

  return { bySession, byPhone };
}

function selectBestRcRecord(records = [], startedAt = null) {
  const target = startedAt ? new Date(startedAt).getTime() : null;
  return [...records]
    .filter(Boolean)
    .sort((left, right) => {
      const leftStart = left.startTime ? new Date(left.startTime).getTime() : 0;
      const rightStart = right.startTime ? new Date(right.startTime).getTime() : 0;
      const leftScore = target == null ? 0 : Math.abs(leftStart - target);
      const rightScore = target == null ? 0 : Math.abs(rightStart - target);
      if (leftScore !== rightScore) return leftScore - rightScore;
      if (rightStart !== leftStart) return rightStart - leftStart;
      return (Number(right.duration || 0) || 0) - (Number(left.duration || 0) || 0);
    })[0] || null;
}

function findRcRecordForSeed(seed, rcIndex) {
  const sessionCandidates = [
    String(seed.telephonySessionId || "").trim(),
    String(seed.callSessionId || "").trim(),
  ].filter(Boolean);

  for (const sessionId of sessionCandidates) {
    if (rcIndex.bySession.has(sessionId)) {
      return rcIndex.bySession.get(sessionId);
    }
  }

  const phone = normalizeDigits(seed.phone);
  if (phone && rcIndex.byPhone.has(phone)) {
    return selectBestRcRecord(rcIndex.byPhone.get(phone), seed.callStartTime || seed.createdAt || null);
  }

  return null;
}

function selectBestCallrailMatch(entries = [], phone, startedAt = null) {
  const normalizedPhone = normalizeDigits(phone);
  const target = startedAt ? new Date(startedAt).getTime() : null;
  return [...entries]
    .filter((entry) => entry.phone === normalizedPhone)
    .sort((left, right) => {
      const leftStart = left.startedAt ? new Date(left.startedAt).getTime() : 0;
      const rightStart = right.startedAt ? new Date(right.startedAt).getTime() : 0;
      const leftScore = target == null ? 0 : Math.abs(leftStart - target);
      const rightScore = target == null ? 0 : Math.abs(rightStart - target);
      if (leftScore !== rightScore) return leftScore - rightScore;
      if (rightStart !== leftStart) return rightStart - leftStart;
      return (Number(right.durationSec || 0) || 0) - (Number(left.durationSec || 0) || 0);
    })[0] || null;
}

function isMailerInbound(seed = {}) {
  return /mailer inbound/i.test(String(seed.contactMethod || ""));
}

function isPhoneBurner(seed = {}) {
  return containsPhoneBurnerText(seed.source) || containsPhoneBurnerText(seed.contactMethod);
}

function isPhoneBurnerRecord(record = {}) {
  return [
    record?.from?.name,
    record?.to?.name,
    record?.extension?.name,
    record?.reason,
    record?.reasonDescription,
    ...(Array.isArray(record?.legs)
      ? record.legs.flatMap((leg) => [
          leg?.from?.name,
          leg?.to?.name,
          leg?.extension?.name,
          leg?.reason,
          leg?.reasonDescription,
        ])
      : []),
  ].some((value) => containsPhoneBurnerText(value));
}

function buildSeedRouteHint(seed = {}) {
  if (isMailerInbound(seed)) return "mailer";
  if (/hand dialed/i.test(String(seed.contactMethod || ""))) return "hand-dialed";
  if (/sms reply/i.test(String(seed.contactMethod || ""))) return "sms";
  if (/inbound/i.test(String(seed.contactMethod || ""))) return "generic-inbound";
  return "generic";
}

async function fetchCallrailArtifact(entry) {
  const client = createCallrailClient(entry.companyKey);
  const call = await client.getCall(entry.callId, { fields: CALLRAIL_FIELDS });
  const recording = await client.getCallRecording(entry.callId).catch(() => null);
  const sourceUri = String(recording?.url || call?.recording || "").trim();
  if (!sourceUri) return null;
  const download = await fetchBinary(sourceUri);
  return {
    provider: "callrail",
    sourceUri,
    mimeType: download.mimeType,
    buffer: download.buffer,
    finalUrl: download.finalUrl,
    callId: entry.callId,
    companyKey: entry.companyKey,
    startedAt: call?.start_time || entry.startedAt || null,
    durationSec: Number(call?.recording_duration || call?.duration || entry.durationSec || 0) || null,
  };
}

async function fetchRingcentralArtifact(rcClient, record = null, seed = {}) {
  const token = await rcClient.authenticate();
  const sourceUri = String(
    record?.recording?.contentUri ||
      seed.transcription?.recordingUri ||
      "",
  ).trim();
  if (!sourceUri) return null;

  const download = await fetchBinary(sourceUri, {
    headers: { Authorization: `Bearer ${token}` },
  });

  return {
    provider: "ringcentral",
    sourceUri,
    mimeType: download.mimeType,
    buffer: download.buffer,
    finalUrl: download.finalUrl,
    telephonySessionId: record?.telephonySessionId || seed.telephonySessionId || null,
    recordingId: record?.recording?.id || null,
    startedAt: record?.startTime || seed.callStartTime || null,
    durationSec: Number(record?.recording?.duration || record?.duration || seed.durationSeconds || 0) || null,
  };
}

function writeLocalCopy(rootDir, bucket, fileName, artifact) {
  const outDir = path.join(rootDir, bucket);
  fs.mkdirSync(outDir, { recursive: true });
  const filePath = path.join(outDir, fileName);
  fs.writeFileSync(filePath, artifact.buffer);
  return filePath;
}

function buildTaskKey(task) {
  const sessionId = String(task.telephonySessionId || "").trim();
  if (sessionId) return `session:${sessionId}`;

  const callrailCallId = String(task.callrailCallId || "").trim();
  if (callrailCallId) return `callrail:${callrailCallId}`;

  return [
    "fallback",
    normalizeDigits(task.phone),
    String(task.startedAt || ""),
    String(task.durationSec || ""),
  ].join("|");
}

async function buildLegacySeedTasks({
  legacyDocs,
  rcIndex,
  callrailCalls,
  minDurationSec,
}) {
  const tasks = [];
  const skipped = [];

  for (const seed of legacyDocs) {
    const durationSec = Number(seed.durationSeconds || 0) || 0;
    if (durationSec < minDurationSec) continue;
    if (isPhoneBurner(seed)) {
      skipped.push({
        reason: "unsupported-provider",
        source: seed.source || null,
        contactMethod: seed.contactMethod || null,
        telephonySessionId: seed.telephonySessionId || null,
      });
      continue;
    }

    const routeHint = buildSeedRouteHint(seed);
    const rcRecord = findRcRecordForSeed(seed, rcIndex);
    const callrailMatch = isMailerInbound(seed)
      ? selectBestCallrailMatch(callrailCalls, seed.phone, seed.callStartTime || null)
      : null;

    tasks.push({
      sourceKind: "legacy",
      providerHint: callrailMatch ? "callrail" : "ringcentral",
      routeHint,
      seed,
      rcRecord,
      callrailMatch,
      company: seed.company || null,
      phone: normalizeDigits(seed.phone),
      telephonySessionId: seed.telephonySessionId || null,
      callSessionId: seed.callSessionId || null,
      callrailCallId: callrailMatch?.callId || null,
      startedAt: seed.callStartTime || null,
      durationSec,
      dateKey: formatDateKeyForZone(seed.callStartTime || new Date()),
    });
  }

  return { tasks, skipped };
}

function supplementRcTasks({
  rcRecords,
  existingTaskKeys,
  minDurationSec,
}) {
  const tasks = [];
  for (const record of rcRecords) {
    const durationSec = Number(record?.duration || 0) || 0;
    if (durationSec < minDurationSec) continue;
    if (!record?.recording?.contentUri) continue;

    const phone =
      [...collectTenDigitPhones(record)][0] ||
      "";
    const task = {
      sourceKind: "ringcentral-direct",
      providerHint: "ringcentral",
      routeHint: "rc-direct",
      seed: {
        company: null,
        contactMethod: null,
        source: "RingCentral",
        agentName: record?.from?.name || null,
        extensionId: record?.from?.extensionId || record?.extension?.id || null,
        direction: record?.direction ? String(record.direction).toLowerCase() : null,
        callStartTime: record?.startTime || null,
        durationSeconds: durationSec,
      },
      rcRecord: record,
      callrailMatch: null,
      company: null,
      phone,
      telephonySessionId: record.telephonySessionId || null,
      callSessionId: record.sessionId || null,
      callrailCallId: null,
      startedAt: record.startTime || null,
      durationSec,
      dateKey: formatDateKeyForZone(record.startTime || new Date()),
    };

    const key = buildTaskKey(task);
    if (existingTaskKeys.has(key)) continue;
    existingTaskKeys.add(key);
    tasks.push(task);
  }
  return tasks;
}

function supplementCallrailTasks({
  callrailCalls,
  rcIndex,
  existingTaskKeys,
}) {
  const tasks = [];
  for (const entry of callrailCalls) {
    const rcRecord = entry.phone && rcIndex.byPhone.has(entry.phone)
      ? selectBestRcRecord(rcIndex.byPhone.get(entry.phone), entry.startedAt)
      : null;
    const task = {
      sourceKind: "callrail-direct",
      providerHint: "callrail",
      routeHint: "callrail-direct",
      seed: {
        company: entry.companyKey,
        contactMethod: "Mailer Inbound",
        source: "CallRail",
        agentName: rcRecord?.from?.name || null,
        extensionId: rcRecord?.from?.extensionId || rcRecord?.extension?.id || null,
        direction: "inbound",
        callStartTime: entry.startedAt || null,
        durationSeconds: entry.durationSec,
      },
      rcRecord,
      callrailMatch: entry,
      company: entry.companyKey,
      phone: entry.phone,
      telephonySessionId: rcRecord?.telephonySessionId || null,
      callSessionId: rcRecord?.sessionId || null,
      callrailCallId: entry.callId,
      startedAt: entry.startedAt || null,
      durationSec: entry.durationSec,
      dateKey: formatDateKeyForZone(entry.startedAt || new Date()),
    };
    const key = buildTaskKey(task);
    if (existingTaskKeys.has(key)) continue;
    existingTaskKeys.add(key);
    tasks.push(task);
  }
  return tasks;
}

function buildJsonSummaryPath(rootDir, dateKey, dryRun, providerOnly = null) {
  const providerSuffix = providerOnly ? `-${sanitizeFileComponent(providerOnly, "provider").toLowerCase()}` : "";
  const fileName = `archive-eod-recordings-${dateKey}${providerSuffix}${dryRun ? "-dry-run" : ""}.json`;
  return path.join(rootDir, fileName);
}

function parseRecipientList(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry || "").trim().toLowerCase()).filter(Boolean);
  }
  return String(value || "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

async function sendCompletionEmail({
  companyKey = "TAG",
  recipients = [],
  summary,
} = {}) {
  const cleanRecipients = parseRecipientList(recipients);
  if (cleanRecipients.length === 0 || !summary || !Array.isArray(summary.results)) {
    return { sent: false, reason: "missing-email-input" };
  }

  const uploadedRows = summary.results.filter((row) => row.uploaded);
  if (uploadedRows.length === 0) {
    return { sent: false, reason: "no-uploaded-files" };
  }

  const bucketCounts = uploadedRows.reduce((accumulator, row) => {
    const key = String(row.bucket || "unknown");
    accumulator[key] = (accumulator[key] || 0) + 1;
    return accumulator;
  }, {});

  const fileLines = uploadedRows
    .slice()
    .sort((left, right) => String(left.fileName || "").localeCompare(String(right.fileName || "")))
    .map((row) => `- [${row.bucket}] ${row.fileName}`);

  const fromEmail = getInternalFromEmail();

  const subject = `[${String(companyKey).toUpperCase()}] EOD recordings dropped for ${summary.dateKey} (${uploadedRows.length} files)`;
  const body = [
    `The end-of-day recording archive finished for ${summary.dateKey}.`,
    "",
    `Uploaded files: ${uploadedRows.length}`,
    `OG: ${bucketCounts.OG || 0}`,
    `CX: ${bucketCounts.CX || 0}`,
    `AS: ${bucketCounts.AS || 0}`,
    `CS: ${bucketCounts.CS || 0}`,
    "",
    "Files:",
    ...fileLines,
    "",
    summary.skipped?.length
      ? `Skipped: ${summary.skipped.length}`
      : "Skipped: 0",
  ].join("\n");

  await sendPlainEmail(companyKey, {
    personalizations: [
      {
        to: cleanRecipients.map((email) => ({ email })),
        custom_args: {
          channel: "eod-recording-archive",
          archiveDate: summary.dateKey,
          fileCount: String(uploadedRows.length),
        },
      },
    ],
    from: {
      email: fromEmail,
      name: `${String(companyKey).toUpperCase()} Parallel`,
    },
    reply_to: {
      email: fromEmail,
      name: `${String(companyKey).toUpperCase()} Parallel`,
    },
    subject,
    content: [
      {
        type: "text/plain",
        value: body,
      },
    ],
  });

  return {
    sent: true,
    recipientCount: cleanRecipients.length,
    uploadedCount: uploadedRows.length,
    subject,
  };
}

async function runArchiveEodRecordings(options = {}) {
  const sharedConfig = getSharedConfig();
  const archiveConfig = sharedConfig.recordingArchive || {};
  const driveConfig = archiveConfig.drive || {};
  const driveDestinations = archiveConfig.destinations || {};
  const eodConfig = archiveConfig.endOfDay || {};
  const dateKey = String(options.date || formatDateKeyForZone(new Date(), TIME_ZONE)).trim();
  const minDurationSec = Math.max(Number(options.minDurationSec || DEFAULT_MIN_DURATION_SEC) || DEFAULT_MIN_DURATION_SEC, 1);
  const dryRun = Boolean(options.dryRun);
  const writeLocal =
    options.writeLocal !== undefined
      ? Boolean(options.writeLocal)
      : !dryRun;
  const limit = Math.max(Number(options.limit || 0) || 0, 0);
  const delayMs = Math.max(Number(options.delayMs || DEFAULT_DELAY_MS) || DEFAULT_DELAY_MS, 0);
  const outputRoot = path.resolve(String(options.outputRoot || DEFAULT_OUTPUT_ROOT));
  const sessionFilter = new Set(
    parseList(options.sessionIds)
      .map((entry) => String(entry).trim())
      .filter(Boolean),
  );
  // Optional bucket filter — when set, only tasks whose derived bucket
  // matches are uploaded. Historical sweeps use this to touch one
  // bucket without re-pulling unrelated artifacts. Accepts "OG",
  // "CX", "AS", or "CS"; null = no filter.
  const bucketOnly = String(options.bucketOnly || "").trim().toUpperCase() || null;
  const providerOnly = String(options.providerOnly || "").trim().toLowerCase() || null;
  const excludeAgentTokens = parseList(
    options.excludeAgents !== undefined
      ? options.excludeAgents
      : process.env.RECORDING_ARCHIVE_EXCLUDED_AGENT_TOKENS || DEFAULT_EXCLUDED_AGENT_TOKENS,
  );
  const notifyRecipients = parseRecipientList(
    options.notifyRecipients !== undefined
      ? options.notifyRecipients
      : eodConfig.notifyRecipients,
  );
  const sendCompletionNotice = Boolean(options.sendCompletionNotice) && !dryRun;
  const emailCompanyKey = String(options.emailCompanyKey || eodConfig.emailCompanyKey || "TAG").toUpperCase();
  const { start, end } = buildDayWindow(dateKey, TIME_ZONE);

  await mongoose.connect(sharedConfig.mongoUri, { dbName: sharedConfig.parallelDbName });

  const legacyDocs = await listLegacyContactActivityDocs({
    from: start,
    to: end,
    limit: 5000,
  });

  const rcClient = createRingCentralClient();
  await rcClient.reinitializePlatform({ force: false, reason: "eod-recording-archive" });
  const rcRecords = await fetchRcRecordsForDay(rcClient, dateKey);
  const rcIndex = buildRcIndexes(rcRecords);
  const callrailCalls = await fetchCallrailCallsForDay(dateKey, minDurationSec);

  const { tasks: legacyTasks, skipped: skippedSeeds } = await buildLegacySeedTasks({
    legacyDocs,
    rcIndex,
    callrailCalls,
    minDurationSec,
  });

  const existingTaskKeys = new Set(legacyTasks.map(buildTaskKey));
  const rcTasks = supplementRcTasks({
    rcRecords,
    existingTaskKeys,
    minDurationSec,
  });
  const callrailTasks = supplementCallrailTasks({
    callrailCalls,
    rcIndex,
    existingTaskKeys,
  });

  let tasks = [...legacyTasks, ...rcTasks, ...callrailTasks];
  if (providerOnly) {
    tasks = tasks.filter((task) =>
      providerOnly === "callrail"
        ? isCallrailArchiveTask(task)
        : providerOnly === "ringcentral"
          ? !isCallrailArchiveTask(task)
          : true,
    );
  }
  if (sessionFilter.size > 0) {
    tasks = tasks.filter((task) => {
      const sessionId = String(task.telephonySessionId || "").trim();
      const callrailCallId = String(task.callrailCallId || "").trim();
      return sessionFilter.has(sessionId) || sessionFilter.has(callrailCallId);
    });
  }
  const skippedByAgent = [];
  if (excludeAgentTokens.length > 0) {
    tasks = tasks.filter((task) => {
      if (isCallrailArchiveTask(task)) return true;
      const match = findExcludedTaskAgentMatch(task, excludeAgentTokens);
      if (!match) return true;
      skippedByAgent.push({
        reason: "excluded-agent",
        phase: "pre-fetch",
        matchedToken: match.token,
        matchedValue: match.value,
        sourceKind: task.sourceKind,
        telephonySessionId: task.telephonySessionId || null,
        callrailCallId: task.callrailCallId || null,
        phone: task.phone || null,
        routeHint: task.routeHint,
      });
      return false;
    });
  }
  tasks.sort((left, right) =>
    new Date(left.startedAt || 0).getTime() - new Date(right.startedAt || 0).getTime(),
  );
  if (limit > 0) {
    tasks = tasks.slice(0, limit);
  }

  const driveClient = createGoogleDriveClient(driveConfig);
  const canUpload = !dryRun && driveClient.isConfigured();
  const folderByBucket = {
    OG: String(driveDestinations.og?.folderId || "").trim(),
    CX: String(driveDestinations.cx?.folderId || "").trim(),
    AS: String(driveDestinations.as?.folderId || "").trim(),
    CS: String(driveDestinations.cs?.folderId || "").trim(),
  };

  if (canUpload) {
    for (const [bucket, folderId] of Object.entries(folderByBucket)) {
      if (!folderId) continue;
      const folder = await driveClient.getFileMetadata({ fileId: folderId });
      if (folder?.trashed) {
        throw new Error(
          `Configured ${bucket} recording archive folder is in Google Drive trash: ${folder.name || folderId} (${folderId})`,
        );
      }
    }
  }

  // Per-run cache for date subfolders. Key = `${bucketFolderId}:${dateKey}`,
  // value = subfolder id. The archiver typically processes many files
  // sharing the same (bucket, dateKey) so this collapses N find-or-create
  // calls into 1 per (bucket, dateKey) pair.
  const dateFolderCache = new Map();
  async function ensureDateSubfolder(bucketFolderId, dateKeyForFile) {
    const cacheKey = `${bucketFolderId}:${dateKeyForFile}`;
    if (dateFolderCache.has(cacheKey)) {
      return dateFolderCache.get(cacheKey);
    }
    const folder = await driveClient.ensureFolder({
      parentId: bucketFolderId,
      name: dateKeyForFile,
    });
    const subfolderId = folder?.id || null;
    if (subfolderId) dateFolderCache.set(cacheKey, subfolderId);
    return subfolderId;
  }

  const results = [];
  const skipped = [...skippedSeeds, ...skippedByAgent];

  for (const task of tasks) {
    try {
      let artifact = null;
      if (task.providerHint === "callrail" && task.callrailMatch) {
        artifact = await fetchCallrailArtifact(task.callrailMatch);
      }
      if (!artifact) {
        artifact = await fetchRingcentralArtifact(rcClient, task.rcRecord, task.seed);
      }
      if (!artifact) {
        skipped.push({
          reason: "no-recording-found",
          sourceKind: task.sourceKind,
          telephonySessionId: task.telephonySessionId || null,
          callrailCallId: task.callrailCallId || null,
          phone: task.phone || null,
          routeHint: task.routeHint,
        });
        continue;
      }

      task.artifact = artifact;

      // Buffer-parse the actual audio duration BEFORE we route +
      // upload. The call-log API duration (artifact.durationSec) is
      // based on the call lifecycle and routinely drifts from the
      // recording's true length — calls that transfer, clip, or
      // start late produce audio shorter than the API claims. We
      // sweep the past once, but going forward we just refuse to
      // upload audio that's actually under the threshold.
      const actualDurationSec = await parseAudioDurationSec(
        artifact.buffer,
        artifact.mimeType,
      );
      task.actualDurationSec = actualDurationSec;
      if (actualDurationSec > 0 && actualDurationSec < minDurationSec) {
        skipped.push({
          reason: "audio-too-short",
          sourceKind: task.sourceKind,
          telephonySessionId: task.telephonySessionId || null,
          callrailCallId: task.callrailCallId || null,
          phone: task.phone || null,
          actualDurationSec,
          apiDurationSec: artifact.durationSec || task.durationSec || 0,
        });
        continue;
      }

      task.routing = deriveRouting(artifact.provider, task.rcRecord, task.seed);
      const excludedRouteAgent = isCallrailArchiveTask(task)
        ? null
        : findExcludedTaskAgentMatch(task, excludeAgentTokens);
      if (excludedRouteAgent) {
        skipped.push({
          reason: "excluded-agent",
          phase: "post-route",
          matchedToken: excludedRouteAgent.token,
          matchedValue: excludedRouteAgent.value,
          sourceKind: task.sourceKind,
          telephonySessionId: task.telephonySessionId || null,
          callrailCallId: task.callrailCallId || null,
          phone: task.phone || null,
          routeHint: task.routeHint,
        });
        continue;
      }
      const bucket = task.routing.bucket;

      // Interoffice calls (extension <-> extension, no external party)
      // never get archived — they're not prospect or client interactions
      // and pre-reorg they were polluting the catch-all bucket. The router
      // returns `bucket: null, interoffice: true` for these.
      if (task.routing.interoffice || !bucket) {
        skipped.push({
          reason: task.routing.interoffice ? "interoffice" : "no-bucket",
          sourceKind: task.sourceKind,
          telephonySessionId: task.telephonySessionId || null,
          callrailCallId: task.callrailCallId || null,
          phone: task.phone || null,
          routeHint: task.routeHint,
        });
        continue;
      }

      // Optional bucket-only filter. Repopulate workers use this so
      // they skip other buckets instead of pulling artifacts
      // for every call on the day.
      if (bucketOnly && bucket !== bucketOnly) {
        skipped.push({
          reason: "bucket-not-targeted",
          targetBucket: bucketOnly,
          actualBucket: bucket,
          sourceKind: task.sourceKind,
          telephonySessionId: task.telephonySessionId || null,
          callrailCallId: task.callrailCallId || null,
        });
        continue;
      }

      const fileName = buildFileName(task);
      const localPath = writeLocal
        ? writeLocalCopy(path.join(outputRoot, dateKey), bucket, fileName, artifact)
        : null;

      let upload = null;
      let deduped = false;
      let uploadFolderId = null;
      if (canUpload) {
        const bucketFolderId = folderByBucket[bucket];
        if (!bucketFolderId) {
          throw new Error(`Missing folder for bucket ${bucket}`);
        }

        // Drive-side dedup — search globally (no parent filter) for a
        // file already tagged with the same telephonySessionId (or
        // callrailCallId fallback for CallRail-only inbound legs).
        // Globally because: post-reorg files live in
        // `<bucket>/<dateKey>/`, but pre-reorg files still sit flat in
        // `<bucket>/`. The telephonySessionId is unique enough that a
        // single appProperty match is safe without a parent filter.
        const dedupAppProps = {};
        if (task.telephonySessionId) {
          dedupAppProps.telephonySessionId = String(task.telephonySessionId);
        } else if (task.callrailCallId) {
          dedupAppProps.callrailCallId = String(task.callrailCallId);
        }
        if (Object.keys(dedupAppProps).length > 0) {
          const existing = await driveClient
            .findFilesByAppProperties({
              appProperties: dedupAppProps,
              pageSize: 1,
            })
            .catch(() => []);
          if (existing.length > 0) {
            const hit = existing[0];
            upload = {
              id: hit.id,
              name: hit.name,
              mimeType: hit.mimeType,
              webViewLink: hit.webViewLink,
              webContentLink: hit.webContentLink,
              size: hit.size,
              parents: hit.parents || null,
            };
            uploadFolderId = Array.isArray(hit.parents) ? hit.parents[0] || null : null;
            deduped = true;
          }
        }

        if (!upload) {
          // Resolve `<bucket>/<dateKey>/` and upload there. The cache
          // collapses N tasks sharing the same (bucket, dateKey) into a
          // single find-or-create round-trip.
          const dateSubfolderId = await ensureDateSubfolder(bucketFolderId, dateKey);
          uploadFolderId = dateSubfolderId || bucketFolderId;
          upload = await driveClient.uploadFileResumable({
            folderId: uploadFolderId,
            name: fileName,
            mimeType: artifact.mimeType,
            buffer: artifact.buffer,
            description: `EOD archive ${dateKey} ${artifact.provider} ${task.phone || ""}`.trim(),
            appProperties: {
              provider: artifact.provider,
              phone: task.phone || "",
              telephonySessionId: task.telephonySessionId || "",
              callrailCallId: task.callrailCallId || "",
              bucket,
              dateKey,
              // Stamp the actual audio duration (buffer-parsed) so
              // later cleanups / audits don't need to re-download
              // the file or query an API that drifts from reality.
              // Falls back to API duration only if the parse failed.
              durationSec: String(
                Number(
                  task.actualDurationSec
                    || artifact.durationSec
                    || task.durationSec
                    || 0,
                ) || 0,
              ),
            },
          });
        }
      }

      const callLogStamp = canUpload && upload
        ? await stampCallLogRecordingArchive({
            task,
            artifact,
            upload,
            uploadFolderId,
            fileName,
          }).catch((error) => ({
            error: error.message,
            matchedCount: 0,
            modifiedCount: 0,
          }))
        : null;

      results.push({
        sourceKind: task.sourceKind,
        provider: artifact.provider,
        bucket,
        agentName: task.routing?.candidate?.agentName || task.seed?.agentName || null,
        phone: task.phone || null,
        telephonySessionId: task.telephonySessionId || null,
        callrailCallId: task.callrailCallId || null,
        startedAt: task.startedAt || artifact.startedAt || null,
        durationSec: artifact.durationSec || task.durationSec || null,
        routeHint: task.routeHint,
        routeReason:
          artifact.provider === "callrail"
            ? "callrail-provider"
            : task.routing?.hasCustomerServiceTouch
              ? "customer-service-text-touch"
              : task.routing?.queueTouches?.length
                ? "customer-service-queue-touch"
                : "ringcentral-provider-cx-default",
        fileName,
        localPath,
        uploaded: Boolean(upload),
        deduped,
        driveFileId: upload?.id || null,
        driveFolderId: uploadFolderId || upload?.parents?.[0] || null,
        driveWebViewLink: upload?.webViewLink || null,
        sourceUri: artifact.sourceUri || null,
        callLogStamp,
      });

      if (delayMs > 0) {
        await sleep(delayMs);
      }
    } catch (error) {
      skipped.push({
        reason: "task-failed",
        sourceKind: task.sourceKind,
        telephonySessionId: task.telephonySessionId || null,
        callrailCallId: task.callrailCallId || null,
        phone: task.phone || null,
        error: String(error && error.message ? error.message : error),
      });
    }
  }

  const summary = {
    dateKey,
    timeZone: TIME_ZONE,
    startedAt: toIsoDate(start),
    endedAt: toIsoDate(end),
    dryRun,
    minDurationSec,
    providerOnly: providerOnly || null,
    sessionFilterCount: sessionFilter.size,
    canUpload,
    configuredFolders: folderByBucket,
    excludedAgentTokens: excludeAgentTokens,
    stats: {
      legacyRowsFetched: legacyDocs.length,
      rcRecordsFetched: rcRecords.length,
      callrailCallsFetched: callrailCalls.length,
      legacyTasks: legacyTasks.length,
      rcSupplementTasks: rcTasks.length,
      callrailSupplementTasks: callrailTasks.length,
      tasksProcessed: tasks.length,
      archived: results.length,
      skipped: skipped.length,
    },
    results,
    skipped,
  };

  if (sendCompletionNotice) {
    summary.email = await sendCompletionEmail({
      companyKey: emailCompanyKey,
      recipients: notifyRecipients,
      summary,
    }).catch((error) => ({
      sent: false,
      error: String(error?.message || error),
    }));
  } else {
    summary.email = {
      sent: false,
      reason: dryRun ? "dry-run" : "disabled",
    };
  }

  fs.mkdirSync(outputRoot, { recursive: true });
  const summaryPath = buildJsonSummaryPath(outputRoot, dateKey, dryRun, providerOnly);
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

  await mongoose.disconnect();
  return { summaryPath, summary };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await runArchiveEodRecordings({
    date: args.date,
    minDurationSec: args["min-duration"],
    dryRun: boolArg(args["dry-run"], false),
    writeLocal:
      args["write-local"] !== undefined
        ? boolArg(args["write-local"], true)
        : undefined,
    limit: args.limit,
    delayMs: args["delay-ms"],
    outputRoot: args["out-dir"],
    sendCompletionNotice: boolArg(args.notify, false),
    notifyRecipients: args.recipients,
    emailCompanyKey: args.company,
    bucketOnly: args["bucket-only"],
    providerOnly: args["provider-only"],
    sessionIds: args["session-ids"],
    excludeAgents: args["exclude-agents"],
  });
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch(async (error) => {
    try {
      await mongoose.disconnect();
    } catch {
      // Ignore disconnect errors on crash path.
    }
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  runArchiveEodRecordings,
};
