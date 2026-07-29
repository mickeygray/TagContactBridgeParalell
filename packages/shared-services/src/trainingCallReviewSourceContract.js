"use strict";

const CALL_REVIEW_LISTED_PROVIDERS = Object.freeze([
  "ex",
  "phoneburner",
  "callrail",
]);

const CALL_REVIEW_ALLOWED_PROVIDERS = CALL_REVIEW_LISTED_PROVIDERS;

// EX is recording-eligible only through its exact session-bounded lookup.
// A broad EX Drive archive remains non-authoritative.
const CALL_REVIEW_RECORDING_PROVIDERS = CALL_REVIEW_LISTED_PROVIDERS;

const CLIENT_LOCATOR_KEYS = new Set([
  "caseid",
  "calllogid",
  "telephonysessionid",
  "providercallid",
  "providerattemptkey",
  "drivefileid",
  "drivefolderid",
  "drivewebviewlink",
  "drivewebcontentlink",
  "recordingurl",
  "sourceuri",
  "listenurl",
  "localpath",
  "phone",
  "normalizedphone",
  "contactname",
  "transcript",
]);

function normalizeProviderToken(value) {
  return String(value || "").trim().toLowerCase();
}

/**
 * Resolve the safe display provider for one CallLog.
 *
 * platform "ex" is the authoritative EX stamp. Historical EX rows may
 * carry no provider or a RingCentral alias. Any contradictory provider /
 * platform pair fails closed instead of being guessed into an allow-list.
 */
function resolveCallReviewListingProvider(callLog = {}) {
  if (!callLog || typeof callLog !== "object") return null;

  const provider = normalizeProviderToken(callLog.provider);
  const platform = normalizeProviderToken(callLog.platform);

  if (platform === "cx") return null;

  if (platform === "ex") {
    return ["", "ex", "ringcentral", "ringcentral-ex"].includes(provider)
      ? "ex"
      : null;
  }

  if (platform === "phoneburner" || platform === "callrail") {
    return !provider || provider === platform ? platform : null;
  }

  if (platform) return null;
  return CALL_REVIEW_LISTED_PROVIDERS.includes(provider) ? provider : null;
}

function normalizedRecordingProvider(callLog = {}) {
  const provider = resolveCallReviewListingProvider(callLog);
  if (provider === "ex") {
    return normalizeProviderToken(callLog.platform) === "ex" ? "ex" : null;
  }
  return CALL_REVIEW_ALLOWED_PROVIDERS.includes(provider) ? provider : null;
}

function isSafeStoredHttpsUrl(value) {
  try {
    const parsed = new URL(String(value || "").trim());
    return (
      parsed.protocol === "https:" &&
      !parsed.username &&
      !parsed.password &&
      parsed.href.length <= 2048
    );
  } catch {
    return false;
  }
}

function unavailable(reason, provider = null) {
  return Object.freeze({
    eligible: false,
    provider,
    kind: null,
    reason,
  });
}

/**
 * Pure eligibility contract for a CallLog that has already passed fresh
 * assignment and case-membership authorization. It performs no lookup,
 * download, grading, or ownership decision.
 */
function resolveCallReviewRecordingCandidate(callLog) {
  if (!callLog || typeof callLog !== "object") {
    return unavailable("call-log-required");
  }

  const listingProvider = resolveCallReviewListingProvider(callLog);
  const provider = normalizedRecordingProvider(callLog);
  if (!provider) {
    return unavailable("provider-not-allowed", listingProvider);
  }
  if (
    !String(callLog.domain || "").trim() ||
    callLog.caseId == null ||
    !String(callLog.telephonySessionId || "").trim()
  ) {
    return unavailable("authorized-call-binding-required", provider);
  }

  const archive =
    callLog.recordingArchive && typeof callLog.recordingArchive === "object"
      ? callLog.recordingArchive
      : {};

  if (provider === "ex") {
    return Object.freeze({
      eligible: true,
      provider,
      kind: "exact-telephony-session-lookup",
      reason: null,
      locator: Object.freeze({
        telephonySessionId: String(callLog.telephonySessionId).trim(),
      }),
    });
  }

  if (provider === "callrail" && String(callLog.providerCallId || "").trim()) {
    return Object.freeze({
      eligible: true,
      provider,
      kind: "provider-call-lookup",
      reason: null,
      locator: Object.freeze({
        providerCallId: String(callLog.providerCallId).trim(),
      }),
    });
  }

  if (provider === "phoneburner" && isSafeStoredHttpsUrl(archive.sourceUri)) {
    return Object.freeze({
      eligible: true,
      provider,
      kind: "persisted-provider-recording",
      reason: null,
      locator: Object.freeze({
        sourceUri: String(archive.sourceUri).trim(),
      }),
    });
  }

  return unavailable("recording-evidence-unavailable", provider);
}

function assertNoClientLocatorInput(value, path = "request") {
  if (value == null || typeof value !== "object") return true;
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertNoClientLocatorInput(item, `${path}[${index}]`),
    );
    return true;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (CLIENT_LOCATOR_KEYS.has(String(key).toLowerCase())) {
      const error = new Error("Client-supplied call locator is not allowed");
      error.code = "TRAINER_CALL_REVIEW_LOCATOR_REJECTED";
      error.path = `${path}.${key}`;
      throw error;
    }
    assertNoClientLocatorInput(nested, `${path}.${key}`);
  }
  return true;
}

function isOpaqueReviewSourceId(value) {
  return /^trsrc_[A-Za-z0-9_-]{24,128}$/.test(String(value || ""));
}

function buildPublicCallReviewSource({
  sourceId,
  callStartTime,
  durationSec,
  direction,
  recordingStatus,
} = {}) {
  if (!isOpaqueReviewSourceId(sourceId)) {
    throw new Error("Opaque call-review source ID is required");
  }
  const startedAt = new Date(callStartTime);
  if (Number.isNaN(startedAt.getTime())) {
    throw new Error("Valid call start time is required");
  }
  const safeDuration = Math.max(0, Math.floor(Number(durationSec) || 0));
  const safeDirection = ["inbound", "outbound", "unknown"].includes(
    String(direction || "").toLowerCase(),
  )
    ? String(direction).toLowerCase()
    : "unknown";
  const safeStatus = ["available", "pending", "unavailable"].includes(
    String(recordingStatus || "").toLowerCase(),
  )
    ? String(recordingStatus).toLowerCase()
    : "unavailable";

  return Object.freeze({
    sourceId: String(sourceId),
    startedAt: startedAt.toISOString(),
    durationSec: safeDuration,
    direction: safeDirection,
    recordingStatus: safeStatus,
  });
}

function cleanPublicText(value, maxLength = 120) {
  const text = String(value || "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text ? text.slice(0, maxLength) : null;
}

/**
 * Public list-row contract for direct one-case Call Review discovery.
 * Internal call IDs, case IDs, provider locators, phone/customer fields, and
 * archive details are intentionally not accepted into the returned object.
 */
function buildPublicCaseCallReviewSource({
  sourceId = null,
  provider,
  callStartTime,
  durationSec,
  direction,
  agentName,
  outcome,
  recordingStatus,
  analysisEligible = false,
  analysisReason = null,
} = {}) {
  const safeProvider = normalizeProviderToken(provider);
  if (!CALL_REVIEW_LISTED_PROVIDERS.includes(safeProvider)) {
    throw new Error("Allowed call-review listing provider is required");
  }

  const eligible = analysisEligible === true;
  if (eligible && !isOpaqueReviewSourceId(sourceId)) {
    throw new Error("Eligible calls require an opaque recording source ID");
  }

  const requestedStatus = normalizeProviderToken(recordingStatus);
  const safeStatus = eligible
    ? "available"
    : requestedStatus === "pending"
      ? "pending"
      : "unavailable";
  const requestedReason = normalizeProviderToken(analysisReason);
  const safeReason = eligible
    ? null
    : ["recording-pending", "exact-recording-evidence-unavailable"].includes(
          requestedReason,
        )
      ? requestedReason
      : "exact-recording-evidence-unavailable";

  const base = buildPublicCallReviewSource({
    sourceId: eligible ? sourceId : "trsrc_unavailable000000000000000000",
    callStartTime,
    durationSec,
    direction,
    recordingStatus: safeStatus,
  });

  return Object.freeze({
    sourceId: eligible ? base.sourceId : null,
    provider: safeProvider,
    startedAt: base.startedAt,
    durationSec: base.durationSec,
    direction: base.direction,
    agentName: cleanPublicText(agentName),
    outcome: cleanPublicText(outcome),
    recordingStatus: base.recordingStatus,
    analysisEligible: eligible,
    analysisReason: safeReason,
  });
}

module.exports = {
  CALL_REVIEW_ALLOWED_PROVIDERS,
  CALL_REVIEW_LISTED_PROVIDERS,
  CALL_REVIEW_RECORDING_PROVIDERS,
  assertNoClientLocatorInput,
  buildPublicCallReviewSource,
  buildPublicCaseCallReviewSource,
  isOpaqueReviewSourceId,
  isSafeStoredHttpsUrl,
  resolveCallReviewListingProvider,
  resolveCallReviewRecordingCandidate,
};
