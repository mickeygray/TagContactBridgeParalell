"use strict";

const crypto = require("node:crypto");
const { agentStateRepository } = require("../../shared-repositories/src");
const {
  isExpiredNoUiiCxCallShell,
  normalizeCxCallUii,
} = require("./cxCallLifecycleService");

const DEFAULT_MAX_NEW_CALLS = 50;
const DEFAULT_MAX_COMPLETED_CALLS = 25;

function readBooleanEnv(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

function isCxBucketShadowEnabled() {
  return readBooleanEnv("CX_BUCKET_SHADOW_ENABLED", false);
}

function isCxBucketDebugReadEnabled() {
  return readBooleanEnv("CX_BUCKET_SHADOW_DEBUG_READ_ENABLED", false);
}

function isCxBucketStaleReconcileEnabled() {
  return readBooleanEnv("CX_BUCKET_STALE_RECONCILE_ENABLED", true);
}

function normalizeBucketMs(value, fallback) {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  return Number.isFinite(Number(fallback)) ? Number(fallback) : 0;
}

function normalizeExternalId(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function normalizeDomain(value) {
  const normalized = String(value || "").trim().toUpperCase();
  return normalized || null;
}

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D+/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  if (digits.length >= 10) return digits.slice(-10);
  return digits || null;
}

function phoneLast4(value) {
  const normalized = normalizePhone(value);
  return normalized ? normalized.slice(-4) : null;
}

function hashPhone(value) {
  const normalized = normalizePhone(value);
  if (!normalized) return null;
  const salt = String(process.env.CX_BUCKET_PHONE_HASH_SALT || "cx-bucket-shadow-v1");
  return `sha256:${crypto.createHash("sha256").update(`${salt}:${normalized}`).digest("hex").slice(0, 24)}`;
}

function toIso(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function compactObject(value) {
  const out = {};
  for (const [key, item] of Object.entries(value || {})) {
    if (item === undefined || item === "") continue;
    out[key] = item;
  }
  return out;
}

function toDateMs(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  const ms = date.getTime();
  return Number.isFinite(ms) ? ms : null;
}

function ageMs(value, now = new Date()) {
  const then = toDateMs(value);
  const nowMs = toDateMs(now) || Date.now();
  return then == null ? null : Math.max(0, nowMs - then);
}

function getQueueItemId(input = {}) {
  return normalizeExternalId(
    input.queueItemId ||
      input.queueTicketId ||
      input.cxQueueRecordId ||
      input._id ||
      input.id,
  );
}

function getActionKey(input = {}) {
  return normalizeExternalId(
    input.actionKey ||
      input.queueActionKey ||
      input.cxAction?.key ||
      input.metadata?.actionKey,
  );
}

function getCallUii(input = {}) {
  return normalizeCxCallUii(
    input.uii ||
      input.UII ||
      input.rcxUii ||
      input.callId ||
      input.callID ||
      input.activeCallId ||
      input.callSessionId ||
      input.sessionId ||
      input.id,
  );
}

function summarizeCallIdentity(input = {}, options = {}) {
  const source = input && typeof input === "object" ? input : {};
  const phone = getCandidatePhone(source);
  const observedAt = source.lastObservedAt ||
    source.activeObservedAt ||
    source.buttonClickedAt ||
    source.startTime ||
    source.seenAt ||
    source.updatedAt ||
    options.observedAt ||
    null;
  return compactObject({
    phase: normalizeExternalId(source.phase || options.phase),
    uii: getCallUii(source),
    queueItemId: getQueueItemId(source),
    caseId: source.caseId != null && source.caseId !== "" ? source.caseId : null,
    phoneLast4: phoneLast4(phone),
    matchedBy: normalizeExternalId(source.matchedBy),
    confidence: normalizeExternalId(source.confidence),
    outcome: normalizeExternalId(source.outcome || source.disposition || source.normalizedOutcome),
    lastWriter: normalizeExternalId(source.lastWriter),
    observedAt: observedAt ? toIso(observedAt) : null,
    ageMs: ageMs(observedAt, options.now),
    expiresAt: source.expiresAt ? toIso(source.expiresAt) : null,
  });
}

function getCandidateExternalId(input = {}) {
  const metadata = input.metadata && typeof input.metadata === "object" ? input.metadata : {};
  return normalizeExternalId(
    input.externalId ||
      input.externId ||
      metadata.lastRingcxPublishedExternId ||
      metadata.lastRingcxPublishedRoute?.externId ||
      metadata.lastDialExecutionRingcxPublish?.externId ||
      metadata.lastDialExecutionExternId ||
      metadata.rcxVisibilityExternId,
  );
}

function getCandidatePhone(input = {}) {
  const leadBody = input.leadBody && typeof input.leadBody === "object" ? input.leadBody : {};
  return (
    input.phone ||
    input.leadPhone ||
    input.destinationPhone ||
    input.cellPhone ||
    input.primaryPhone ||
    leadBody.phone ||
    input.metadata?.lastDialExecutionPhone ||
    null
  );
}

function getCandidateCampaignId(input = {}) {
  const metadata = input.metadata && typeof input.metadata === "object" ? input.metadata : {};
  return normalizeExternalId(
    input.campaignId ||
      input.rcxCampaignId ||
      metadata.lastRingcxPublishedCampaignId ||
      metadata.lastRingcxPublishedRoute?.campaignId ||
      metadata.lastDialExecutionRingcxPublish?.campaignId ||
      metadata.lastDialExecutionCampaignId ||
      metadata.rcxVisibilityCampaignId,
  );
}

function getCandidateDialGroupId(input = {}) {
  const metadata = input.metadata && typeof input.metadata === "object" ? input.metadata : {};
  return normalizeExternalId(
    input.dialGroupId ||
      input.rcxDialGroupId ||
      metadata.lastRingcxPublishedDialGroupId ||
      metadata.lastRingcxPublishedRoute?.dialGroupId ||
      metadata.lastDialExecutionRingcxPublish?.dialGroupId ||
      metadata.lastDialExecutionDialGroupId ||
      metadata.rcxVisibilityDialGroupId,
  );
}

function normalizeCxBucketCandidate(input = {}, options = {}) {
  const phone = getCandidatePhone(input);
  const domain = normalizeDomain(input.domain || input.queueDomain || options.domain);
  const caseId = input.caseId != null && input.caseId !== ""
    ? input.caseId
    : input.leadBody?.caseId != null
      ? input.leadBody.caseId
      : null;
  const queueItemId = getQueueItemId(input);
  const actionKey = getActionKey(input);
  const candidate = compactObject({
    queueItemId,
    externalId: getCandidateExternalId(input),
    domain,
    caseId,
    phoneLast4: phoneLast4(phone),
    phoneHash: hashPhone(phone),
    displayName: normalizeExternalId(input.displayName || input.name || input.leadName || input.leadBody?.name),
    campaignId: getCandidateCampaignId(input),
    dialGroupId: getCandidateDialGroupId(input),
    agentExtensionId: normalizeExternalId(
      input.agentExtensionId ||
        input.assignedExtensionId ||
        input.assignment?.extensionId ||
        options.agentExtensionId,
    ),
    actionKey,
    source: normalizeExternalId(options.source || input.source) || "workspace-queue",
    seenAt: toIso(options.now || input.seenAt || new Date()),
  });

  if (options.includeNormalizedPhone) {
    candidate.normalizedPhone = normalizePhone(phone);
  }

  return candidate;
}

function candidateKey(candidate = {}) {
  return normalizeExternalId(candidate.queueItemId)
    || normalizeExternalId(candidate.externalId)
    || [
      normalizeDomain(candidate.domain),
      candidate.caseId != null ? String(candidate.caseId) : null,
      normalizeExternalId(candidate.actionKey),
      normalizeExternalId(candidate.agentExtensionId),
    ].filter(Boolean).join(":")
    || normalizeExternalId(candidate.phoneHash)
    || null;
}

function emptyStats() {
  return {
    activeMatches: 0,
    misses: 0,
    ambiguous: 0,
    weakMatchesRejected: 0,
    legacyAgreements: 0,
    legacyDisagreements: 0,
    staleCurrentClears: 0,
  };
}

function normalizeCxCallBuckets(input = null, agentExtensionId = null, options = {}) {
  const now = toIso(options.now || new Date());
  return {
    agentExtensionId: normalizeExternalId(input?.agentExtensionId || agentExtensionId),
    newCalls: Array.isArray(input?.newCalls) ? input.newCalls.filter(Boolean) : [],
    currentCall: input?.currentCall && typeof input.currentCall === "object" ? input.currentCall : null,
    completionBuffer: Array.isArray(input?.completionBuffer) ? input.completionBuffer.filter(Boolean) : [],
    stats: {
      ...emptyStats(),
      ...(input?.stats && typeof input.stats === "object" ? input.stats : {}),
    },
    updatedAt: input?.updatedAt || now,
  };
}

function hasIdentity(summary = {}) {
  return Boolean(summary.uii || summary.queueItemId || summary.caseId || summary.phoneLast4);
}

function identityAgrees(left = {}, right = {}) {
  if (!left || !right) return false;
  if (left.uii && right.uii && left.uii === right.uii) return true;
  if (left.queueItemId && right.queueItemId && left.queueItemId === right.queueItemId) return true;
  if (left.caseId != null && right.caseId != null && String(left.caseId) === String(right.caseId)) return true;
  return false;
}

function phaseIsLegacyActive(value) {
  const phase = String(value || "").trim().toLowerCase();
  return ["dialing", "oncall", "dispositioning", "wrapup"].includes(phase);
}

function phaseIsLegacyIdle(value) {
  const phase = String(value || "").trim().toLowerCase();
  return ["idle", "offline", "unavailable", "available"].includes(phase);
}

function phaseIsBlockingCxCall(value) {
  const phase = String(value || "").trim().toLowerCase();
  return ["publishing", "confirming", "active", "dispositioning"].includes(phase);
}

function buildCxBucketReadRow(agent = {}, options = {}) {
  const now = options.now || new Date();
  const staleCurrentMs = Math.max(Number(options.staleCurrentMs) || 15_000, 1_000);
  const bucket = normalizeCxCallBuckets(agent.cxCallBuckets || null, agent.extensionId, { now });
  const legacyCurrent = summarizeCallIdentity(agent.currentCall || {}, {
    now,
    phase: agent.activityState,
    observedAt: agent.currentCall?.startTime || agent.lastActivityAt || agent.lastStatusChange,
  });
  const cxCall = summarizeCallIdentity(agent.cxCall || {}, {
    now,
    phase: agent.cxCall?.phase,
    observedAt: agent.cxCall?.lastObservedAt || agent.lastActivityAt || agent.lastStatusChange,
  });
  const bucketCurrent = summarizeCallIdentity(bucket.currentCall || {}, {
    now,
    phase: bucket.currentCall?.phase,
    observedAt: bucket.currentCall?.activeObservedAt || bucket.currentCall?.seenAt || bucket.updatedAt,
  });
  const newestCompletion = bucket.completionBuffer?.[0]
    ? summarizeCallIdentity(bucket.completionBuffer[0], {
      now,
      phase: bucket.completionBuffer[0].phase || "completed",
      observedAt: bucket.completionBuffer[0].buttonClickedAt || bucket.completionBuffer[0].seenAt,
    })
    : null;

  const legacyActive = phaseIsLegacyActive(agent.activityState) || String(agent.activePlatform || "").toUpperCase() === "CX";
  const legacyIdle = phaseIsLegacyIdle(agent.activityState) && !hasIdentity(legacyCurrent);
  const hasBucketCurrent = hasIdentity(bucketCurrent) || Boolean(bucket.currentCall);
  const hasCxCall = hasIdentity(cxCall) || Boolean(cxCall.phase);
  const staleBucketCurrent = Boolean(
    hasBucketCurrent &&
      bucketCurrent.ageMs != null &&
      bucketCurrent.ageMs >= staleCurrentMs &&
      (legacyIdle || (!legacyActive && !identityAgrees(legacyCurrent, bucketCurrent))),
  );
  const staleCxDisposition = Boolean(
    hasCxCall &&
      phaseIsBlockingCxCall(cxCall.phase) &&
      cxCall.uii &&
      cxCall.ageMs != null &&
      cxCall.ageMs >= staleCurrentMs &&
      (legacyIdle || (!legacyActive && !identityAgrees(legacyCurrent, cxCall))),
  );
  const missingActiveMatch = Boolean(
    legacyActive &&
      !hasBucketCurrent &&
      Array.isArray(bucket.newCalls) &&
      bucket.newCalls.length > 0
  );
  const healthy = Boolean(
    hasBucketCurrent &&
      (identityAgrees(bucketCurrent, legacyCurrent) || identityAgrees(bucketCurrent, cxCall)) &&
      !staleBucketCurrent &&
      !staleCxDisposition
  );
  const orderHasExplicitHandoff = (bucket.newCalls || []).some((candidate) => (
    candidate?.handoffBatchId ||
      candidate?.handoffOrder != null ||
      candidate?.ringcxHandoffOrder != null
  ));
  const handoffOrderRisk = Boolean((bucket.newCalls || []).length > 1 && !orderHasExplicitHandoff);

  let readBucket = "unknown";
  let severity = "info";
  let reason = "insufficient-signal";
  let nextLook = "keep-observing";
  if (staleBucketCurrent || staleCxDisposition) {
    readBucket = "stale-terminal-bridge";
    severity = "warn";
    reason = staleBucketCurrent ? "bucket-current-outlived-legacy" : "cxcall-dispositioning-outlived-legacy";
    nextLook = "terminal-or-orphan-clear-helper";
  } else if (missingActiveMatch) {
    readBucket = "missing-active-match";
    severity = "warn";
    reason = "legacy-active-with-candidates-but-no-bucket-current";
    nextLook = "active-call-matcher-inputs";
  } else if (healthy) {
    readBucket = "healthy-handoff";
    reason = "bucket-current-agrees-with-legacy-or-cxcall";
    nextLook = "terminal-drain-on-click";
  } else if (handoffOrderRisk) {
    readBucket = "handoff-order-risk";
    severity = "info";
    reason = "newcalls-has-no-explicit-handoff-order";
    nextLook = "handoff-batch-and-order";
  }

  return {
    agent: compactObject({
      extensionId: normalizeExternalId(agent.extensionId),
      name: normalizeExternalId(agent.name),
      company: normalizeDomain(agent.company),
    }),
    verdict: {
      bucket: readBucket,
      severity,
      reason,
      nextLook,
    },
    legacy: {
      activityState: normalizeExternalId(agent.activityState),
      activePlatform: normalizeExternalId(agent.activePlatform),
      status: normalizeExternalId(agent.status),
      hasCurrent: hasIdentity(legacyCurrent),
      current: legacyCurrent,
    },
    cxCall: {
      ...cxCall,
      expiredNoUiiShell: isExpiredNoUiiCxCallShell(agent.cxCall || {}, now),
    },
    bucket: {
      currentCall: hasBucketCurrent ? bucketCurrent : null,
      newCallsCount: Array.isArray(bucket.newCalls) ? bucket.newCalls.length : 0,
      completionBufferCount: Array.isArray(bucket.completionBuffer) ? bucket.completionBuffer.length : 0,
      newestCompletion,
      stats: bucket.stats || emptyStats(),
      updatedAt: bucket.updatedAt || null,
    },
    comparisons: {
      legacyToBucketAgreement: identityAgrees(legacyCurrent, bucketCurrent),
      cxCallToBucketAgreement: identityAgrees(cxCall, bucketCurrent),
      legacyToCxCallAgreement: identityAgrees(legacyCurrent, cxCall),
      staleBucketCurrent,
      staleCxDisposition,
      missingActiveMatch,
      handoffOrderRisk,
      orderHasExplicitHandoff,
    },
  };
}

function upsertCxBucketCandidate(bucketInput, candidateInput = {}, options = {}) {
  const bucket = normalizeCxCallBuckets(bucketInput, candidateInput.agentExtensionId, options);
  const candidate = normalizeCxBucketCandidate(candidateInput, {
    ...options,
    agentExtensionId: candidateInput.agentExtensionId || bucket.agentExtensionId,
  });
  const key = candidateKey(candidate);
  if (!key) return { bucket, changed: false, reason: "missing-candidate-key", candidate: null };

  const nextCalls = [];
  let changed = false;
  let found = false;
  for (const existing of bucket.newCalls) {
    if (candidateKey(existing) !== key) {
      nextCalls.push(existing);
      continue;
    }
    found = true;
    const merged = {
      ...existing,
      ...compactObject(candidate),
      firstSeenAt: existing.firstSeenAt || existing.seenAt || candidate.seenAt,
      seenAt: candidate.seenAt,
    };
    nextCalls.push(merged);
    changed = JSON.stringify(existing) !== JSON.stringify(merged);
  }
  if (!found) {
    nextCalls.push({
      ...candidate,
      firstSeenAt: candidate.seenAt,
    });
    changed = true;
  }

  const maxNewCalls = Math.max(Number(options.maxNewCalls) || DEFAULT_MAX_NEW_CALLS, 1);
  bucket.newCalls = nextCalls
    .sort((left, right) => new Date(right.seenAt || 0).getTime() - new Date(left.seenAt || 0).getTime())
    .slice(0, maxNewCalls);
  if (changed) bucket.updatedAt = toIso(options.now || new Date());
  return { bucket, changed, candidate, key };
}

function findCandidate(bucket = {}, identity = {}) {
  const queueItemId = normalizeExternalId(identity.queueItemId || identity.queueTicketId);
  const externalId = normalizeExternalId(identity.externalId || identity.externId);
  const domain = normalizeDomain(identity.domain);
  const caseId = identity.caseId != null ? String(identity.caseId) : null;
  const actionKey = normalizeExternalId(identity.actionKey || identity.queueActionKey);
  return (bucket.newCalls || []).find((candidate) => {
    if (queueItemId && normalizeExternalId(candidate.queueItemId) === queueItemId) return true;
    if (externalId && normalizeExternalId(candidate.externalId) === externalId) return true;
    if (
      domain &&
      caseId &&
      normalizeDomain(candidate.domain) === domain &&
      String(candidate.caseId || "") === caseId &&
      (!actionKey || normalizeExternalId(candidate.actionKey) === actionKey)
    ) return true;
    return false;
  }) || null;
}

function extractActiveCallUii(call = {}) {
  return normalizeExternalId(
    call?.uii ||
      call?.UII ||
      call?.callId ||
      call?.callID ||
      call?.activeCallId ||
      call?.id ||
      call?.callSessionId,
  );
}

function deriveMatchedBy(reasons = [], uii = null) {
  const normalized = new Set((Array.isArray(reasons) ? reasons : []).map((reason) => String(reason || "").trim()));
  if (uii && normalized.has("uii")) return "uii";
  if (normalized.has("externId") || normalized.has("externalId")) return "externId-scan";
  if (
    normalized.has("phone") &&
    (normalized.has("agentEmail") || normalized.has("agentId") || normalized.has("campaignId") || normalized.has("dialGroupId"))
  ) {
    return "phone-agent-campaign";
  }
  return "telephony-presence";
}

function confidenceForMatchedBy(matchedBy) {
  if (matchedBy === "uii" || matchedBy === "externId-scan") return "high";
  if (matchedBy === "phone-agent-campaign") return "medium";
  return "low";
}

function shouldRejectMatch(matchResult = {}) {
  if (matchResult.ambiguous === true) return { reject: true, reason: "ambiguous" };
  const reasons = Array.isArray(matchResult.reasons) ? matchResult.reasons : [];
  if (matchResult.weakRejected === true) return { reject: true, reason: "weak-rejected" };
  if (reasons.includes("phone") && reasons.length === 1) return { reject: true, reason: "phone-only" };
  return { reject: false, reason: null };
}

function isBucketCurrentCallStale({
  bucket = null,
  agentState = null,
  activeIdentities = new Set(),
  now = new Date(),
  staleCurrentMs = 30_000,
  mismatchMs = 20_000,
  confirmingMs = 60_000,
} = {}) {
  const currentCall = bucket?.currentCall && typeof bucket.currentCall === "object" ? bucket.currentCall : null;
  if (!currentCall) return { stale: false, reason: null };

  const currentPhase = String(currentCall.phase || "unknown").trim().toLowerCase();
  const activeObservedAt = currentCall.activeObservedAt || currentCall.seenAt || currentCall.updatedAt || bucket.updatedAt || now;
  const age = ageMs(activeObservedAt, now);
  const staleWindow = currentPhase === "confirming" ? normalizeBucketMs(confirmingMs, 60_000) : normalizeBucketMs(staleCurrentMs, 30_000);
  const mismatchWindow = normalizeBucketMs(mismatchMs, 20_000);
  const bucketCurrentIdentity = normalizeExternalId(currentCall.uii || currentCall.queueItemId || currentCall.caseId || currentCall.phoneHash);
  const hasCurrentIdentity = hasIdentity(currentCall);

  const legacyCurrent = agentState
    ? summarizeCallIdentity(agentState.currentCall || {}, {
      now,
      phase: agentState.currentCall?.phase || agentState.activityState,
      observedAt: agentState.currentCall?.startTime || agentState.currentCall?.seenAt || agentState.currentCall?.lastObservedAt || agentState.lastActivityAt || agentState.lastStatusChange,
    })
    : {};
  const legacyHasCurrent = hasIdentity(legacyCurrent);
  const legacyActive = phaseIsLegacyActive(agentState?.activityState)
    || String(agentState?.activePlatform || "").toUpperCase() === "CX";
  const legacyMatchesCurrent = legacyHasCurrent && identityAgrees(legacyCurrent, currentCall);
  if (legacyMatchesCurrent) {
    return {
      stale: false,
      reason: "legacy-active-match",
      ageMs: age,
    };
  }

  if (bucketCurrentIdentity && activeIdentities && activeIdentities.has(bucketCurrentIdentity)) {
    return {
      stale: false,
      reason: "active-list-match",
      ageMs: age,
    };
  }

  if (legacyActive && legacyHasCurrent) {
    if (age != null && age < mismatchWindow) {
      return {
        stale: false,
        reason: "legacy-identity-mismatch-young",
        ageMs: age,
      };
    }
    return {
      stale: true,
      reason: "legacy-identity-mismatch",
      ageMs: age,
      staleWindowMs: mismatchWindow,
    };
  }

  if (legacyActive && !legacyHasCurrent) {
    return {
      stale: false,
      reason: "legacy-active-no-identity",
      ageMs: age,
    };
  }

  if (age == null || age < staleWindow) {
    return {
      stale: false,
      reason: "not-old-enough",
      ageMs: age,
      staleWindowMs: staleWindow,
    };
  }

  if (!legacyHasCurrent && !hasCurrentIdentity) {
    return {
      stale: true,
      reason: currentPhase === "confirming" ? "confirming-identity-gap" : "no-legacy-identity",
      ageMs: age,
      staleWindowMs: staleWindow,
    };
  }

  if (!legacyHasCurrent) {
    return {
      stale: true,
      reason: "legacy-no-current",
      ageMs: age,
      staleWindowMs: staleWindow,
    };
  }

  if (age < mismatchWindow) {
    return {
      stale: false,
      reason: "legacy-mismatch-young",
      ageMs: age,
      staleWindowMs: mismatchWindow,
    };
  }

  return {
    stale: true,
    reason: "legacy-mismatch",
    ageMs: age,
    staleWindowMs: mismatchWindow,
  };
}

function applyCxBucketActiveCallObservation(bucketInput, observation = {}, options = {}) {
  const bucket = normalizeCxCallBuckets(bucketInput, observation.agentExtensionId, options);
  const matchResult = observation.matchResult && typeof observation.matchResult === "object"
    ? observation.matchResult
    : {};
  const rejection = shouldRejectMatch(matchResult);
  if (rejection.reject) {
    const statKey = rejection.reason === "ambiguous" ? "ambiguous" : "weakMatchesRejected";
    bucket.stats[statKey] = Number(bucket.stats[statKey] || 0) + 1;
    bucket.updatedAt = toIso(options.now || new Date());
    return { bucket, changed: true, promoted: false, rejected: true, reason: rejection.reason };
  }

  const activeCall = observation.activeCall && typeof observation.activeCall === "object"
    ? observation.activeCall
    : {};
  const observedUii = normalizeExternalId(observation.uii || extractActiveCallUii(activeCall));
  let candidate = observation.candidate || observation.queueItem || matchResult.queueItem || null;
  if (candidate) {
    const upsert = upsertCxBucketCandidate(bucket, candidate, {
      ...options,
      source: options.source || observation.source || "active-call-observed",
      agentExtensionId: observation.agentExtensionId || bucket.agentExtensionId,
    });
    candidate = upsert.candidate;
    bucket.newCalls = upsert.bucket.newCalls;
    bucket.updatedAt = upsert.bucket.updatedAt;
  } else {
    candidate = findCandidate(bucket, observation);
  }

  if (!candidate) {
    bucket.stats.misses = Number(bucket.stats.misses || 0) + 1;
    bucket.updatedAt = toIso(options.now || new Date());
    return { bucket, changed: true, promoted: false, reason: "missing-candidate" };
  }

  const matchedBy = observation.matchedBy || deriveMatchedBy(matchResult.reasons, observedUii);
  const currentCall = {
    ...candidate,
    phase: observedUii ? "active" : "confirming",
    telephonyActive: true,
    uii: observedUii || null,
    activeObservedAt: toIso(options.now || observation.activeObservedAt || new Date()),
    matchedBy,
    confidence: observation.confidence || confidenceForMatchedBy(matchedBy),
    outcome: null,
  };
  bucket.currentCall = currentCall;
  bucket.stats.activeMatches = Number(bucket.stats.activeMatches || 0) + 1;
  bucket.updatedAt = toIso(options.now || new Date());
  return { bucket, changed: true, promoted: true, currentCall };
}

function sameCallIdentity(left = {}, right = {}) {
  const leftUii = normalizeExternalId(left.uii);
  const rightUii = normalizeExternalId(right.uii);
  if (leftUii && rightUii && leftUii === rightUii) return true;
  const leftQueueItemId = normalizeExternalId(left.queueItemId);
  const rightQueueItemId = normalizeExternalId(right.queueItemId || right.queueTicketId);
  if (leftQueueItemId && rightQueueItemId && leftQueueItemId === rightQueueItemId) return true;
  return false;
}

function shouldDrainCurrentCallForTerminal(bucket = {}, identity = {}, outcomeInput = {}) {
  if (!bucket.currentCall) return { drain: false, reason: null };
  if (sameCallIdentity(bucket.currentCall, identity)) {
    return { drain: true, reason: "identity-match" };
  }
  if (outcomeInput.drainCurrentCall === true || outcomeInput.clearCurrentCall === true) {
    return { drain: true, reason: "trusted-terminal-drain" };
  }
  return { drain: false, reason: null };
}

function applyCxBucketTerminalOutcome(bucketInput, outcomeInput = {}, options = {}) {
  const bucket = normalizeCxCallBuckets(bucketInput, outcomeInput.agentExtensionId, options);
  const now = toIso(options.now || outcomeInput.buttonClickedAt || new Date());
  const identity = {
    ...outcomeInput,
    queueItemId: outcomeInput.queueItemId || outcomeInput.queueTicketId,
  };
  const drainDecision = shouldDrainCurrentCallForTerminal(bucket, identity, outcomeInput);
  const current = drainDecision.drain ? bucket.currentCall : null;
  const candidate = current || findCandidate(bucket, identity) || normalizeCxBucketCandidate(outcomeInput, {
    ...options,
    source: outcomeInput.source || "terminal-outcome",
  });
  const uii = normalizeExternalId(outcomeInput.uii || outcomeInput.rcxUii || current?.uii);
  const outcome = normalizeExternalId(outcomeInput.outcome || outcomeInput.disposition || outcomeInput.normalizedOutcome)
    || "unknown";
  const handoffId = normalizeExternalId(outcomeInput.handoffId)
    || [
      "cx-completed",
      uii || candidate.queueItemId || candidate.externalId || candidate.phoneHash || "unknown",
      outcome,
    ].join(":");
  const completed = {
    ...candidate,
    phase: "completed",
    uii: uii || null,
    uiiFinalizationStatus: uii ? "captured" : (outcomeInput.uiiFinalizationStatus || "pending"),
    outcome,
    buttonClickedAt: now,
    dispositionAcceptedAt: outcomeInput.dispositionAcceptedAt ? toIso(outcomeInput.dispositionAcceptedAt) : null,
    postCallStatus: outcomeInput.postCallStatus || "pending",
    handoffId,
  };

  const completionByKey = new Map();
  for (const existing of bucket.completionBuffer || []) {
    completionByKey.set(normalizeExternalId(existing.handoffId) || candidateKey(existing), existing);
  }
  completionByKey.set(handoffId, completed);
  const maxCompletedCalls = Math.max(Number(options.maxCompletedCalls) || DEFAULT_MAX_COMPLETED_CALLS, 1);
  bucket.completionBuffer = Array.from(completionByKey.values())
    .sort((left, right) => new Date(right.buttonClickedAt || right.seenAt || 0).getTime() - new Date(left.buttonClickedAt || left.seenAt || 0).getTime())
    .slice(0, maxCompletedCalls);

  const completedKey = candidateKey(completed);
  bucket.newCalls = (bucket.newCalls || []).filter((candidateRow) => {
    const rowKey = candidateKey(candidateRow);
    return !completedKey || rowKey !== completedKey;
  });
  if (drainDecision.drain) bucket.currentCall = null;
  bucket.updatedAt = toIso(options.now || new Date());
  return {
    bucket,
    changed: true,
    completed,
    drainedCurrentCall: drainDecision.drain,
    drainReason: drainDecision.reason,
  };
}

async function reconcileCxBucketCurrentCalls(options = {}) {
  const {
    activeIdentities = null,
    now = new Date(),
    logger = null,
    repository = null,
  } = options || {};
  if (!isCxBucketShadowEnabled()) return { ok: true, skipped: true, reason: "bucket-shadow-disabled" };
  if (!isCxBucketStaleReconcileEnabled()) {
    return { ok: true, skipped: true, reason: "stale-reconcile-disabled" };
  }
  const activeIdentitiesKnown = options.activeIdentitiesKnown === true
    || Array.isArray(activeIdentities)
    || activeIdentities instanceof Set;
  if (!activeIdentitiesKnown) {
    return { ok: true, skipped: true, reason: "active-identities-unknown" };
  }

  const normalizedIdentities = new Set();
  for (const identity of Array.isArray(activeIdentities) ? activeIdentities : Array.from(activeIdentities || [])) {
    const normalized = normalizeExternalId(identity);
    if (normalized) normalizedIdentities.add(normalized);
  }

  const agents = await (repository || agentStateRepository).listAgentStates().catch(() => []);
  const staleCurrentMs = Math.max(normalizeBucketMs(process.env.CX_BUCKET_STALE_CURRENT_MS, 30_000), 5_000);
  const mismatchMs = Math.max(normalizeBucketMs(process.env.CX_BUCKET_STALE_MISMATCH_MS, 20_000), 5_000);
  const confirmingMs = Math.max(normalizeBucketMs(process.env.CX_BUCKET_CONFIRMING_STALE_MS, 60_000), 5_000);
  const reconciled = [];
  let checked = 0;
  let written = 0;

  for (const agent of Array.isArray(agents) ? agents : []) {
    checked += 1;
    const extensionId = normalizeExternalId(agent?.extensionId || agent?.extension?.extensionId);
    if (!extensionId) continue;

    let bucket = await readBucketsForAgent(extensionId, { repository, now });
    const stale = isBucketCurrentCallStale({
      bucket,
      agentState: agent,
      activeIdentities: normalizedIdentities,
      now,
      staleCurrentMs,
      mismatchMs,
      confirmingMs,
    });
    if (!stale.stale) {
      continue;
    }

    const previous = summarizeCallIdentity(bucket.currentCall || {}, {
      now,
      phase: bucket.currentCall?.phase || null,
      observedAt: bucket.currentCall?.activeObservedAt || bucket.currentCall?.seenAt || bucket.updatedAt,
    });
    bucket.currentCall = null;
    bucket.stats.staleCurrentClears = Number(bucket.stats.staleCurrentClears || 0) + 1;
    bucket.updatedAt = toIso(now);
    const updated = await writeBucketsForAgent(extensionId, bucket, { repository }).then(() => true).catch(() => false);
    if (updated) {
      written += 1;
      emitBucketLog(logger, "cx.bucket.current_stale", bucket, {
        reason: stale.reason || "current-stale",
        queueItemId: previous.queueItemId || null,
        uii: previous.uii || null,
        staleAgeMs: stale.ageMs || null,
        staleWindowMs: stale.staleWindowMs || null,
        activeCallSeen: normalizedIdentities.has(previous.uii || ""),
      });
      reconciled.push({
        extensionId,
        reason: stale.reason || "current-stale",
        queueItemId: previous.queueItemId || null,
        uii: previous.uii || null,
      });
    }
  }

  return {
    ok: true,
    checked,
    reconciledCount: reconciled.length,
    written,
    reconciled: reconciled.slice(0, 50),
  };
}

function buildCxBucketLogPayload(bucket = {}, event, details = {}) {
  const hasDrainSignal = Object.prototype.hasOwnProperty.call(details, "drainedCurrentCall") ||
    Object.prototype.hasOwnProperty.call(details, "drainReason");
  return compactObject({
    event,
    agentExtensionId: bucket.agentExtensionId || details.agentExtensionId || null,
    bucketPhase: bucket.currentCall?.phase || null,
    bucketQueueItemId: bucket.currentCall?.queueItemId || details.queueItemId || null,
    bucketUii: bucket.currentCall?.uii || details.uii || null,
    telephonyActive: bucket.currentCall?.telephonyActive === true || details.telephonyActive === true,
    uiiFinalizationStatus: details.uiiFinalizationStatus || null,
    matchedBy: bucket.currentCall?.matchedBy || details.matchedBy || null,
    confidence: bucket.currentCall?.confidence || details.confidence || null,
    reason: details.reason || null,
    drainedCurrentCall: hasDrainSignal ? details.drainedCurrentCall === true : undefined,
    drainReason: hasDrainSignal ? details.drainReason || null : undefined,
    newCallCount: Array.isArray(bucket.newCalls) ? bucket.newCalls.length : 0,
    completionBufferCount: Array.isArray(bucket.completionBuffer) ? bucket.completionBuffer.length : 0,
  });
}

function emitBucketLog(logger, event, bucket, details = {}, level = "info") {
  if (!logger || typeof logger[level] !== "function") return;
  logger[level](event, buildCxBucketLogPayload(bucket, event, details));
}

async function readBucketsForAgent(extensionId, options = {}) {
  const repository = options.repository || agentStateRepository;
  const normalizedExtensionId = normalizeExternalId(extensionId);
  if (!normalizedExtensionId) return null;
  const agent = await repository.findAgentStateByExtensionId(normalizedExtensionId).catch(() => null);
  return normalizeCxCallBuckets(agent?.cxCallBuckets || null, normalizedExtensionId, options);
}

async function writeBucketsForAgent(extensionId, bucket, options = {}) {
  const repository = options.repository || agentStateRepository;
  const normalizedExtensionId = normalizeExternalId(extensionId || bucket?.agentExtensionId);
  if (!normalizedExtensionId || !bucket) return null;
  return repository.updateAgentState(normalizedExtensionId, {
    cxCallBuckets: {
      ...bucket,
      agentExtensionId: normalizedExtensionId,
      updatedAt: bucket.updatedAt || toIso(new Date()),
    },
  });
}

async function primeCxBucketNewCalls({ extensionId, queueItems = [], logger = null, now = new Date(), source = "workspace-queue", repository = null } = {}) {
  const normalizedExtensionId = normalizeExternalId(extensionId);
  if (!isCxBucketShadowEnabled()) return { ok: true, skipped: true, reason: "disabled" };
  if (!normalizedExtensionId) return { ok: false, skipped: true, reason: "missing-extension-id" };
  if (!Array.isArray(queueItems) || queueItems.length === 0) {
    return { ok: true, skipped: true, reason: "no-queue-items" };
  }

  let bucket = await readBucketsForAgent(normalizedExtensionId, { repository, now });
  let changed = false;
  let primed = 0;
  for (const item of queueItems) {
    const upsert = upsertCxBucketCandidate(bucket, item, {
      now,
      source,
      agentExtensionId: normalizedExtensionId,
    });
    bucket = upsert.bucket;
    if (upsert.changed) {
      changed = true;
      primed += 1;
    }
  }
  if (changed) {
    await writeBucketsForAgent(normalizedExtensionId, bucket, { repository });
  }
  emitBucketLog(logger, "cx.bucket.queue_primed", bucket, { reason: source, primed });
  return { ok: true, primed, changed, bucket };
}

async function observeCxBucketActiveCall({ extensionId, queueItem = null, activeCall = null, matchResult = null, logger = null, now = new Date(), repository = null } = {}) {
  const normalizedExtensionId = normalizeExternalId(extensionId || queueItem?.assignment?.extensionId || queueItem?.assignedExtensionId);
  if (!isCxBucketShadowEnabled()) return { ok: true, skipped: true, reason: "disabled" };
  if (!normalizedExtensionId) return { ok: false, skipped: true, reason: "missing-extension-id" };

  let bucket = await readBucketsForAgent(normalizedExtensionId, { repository, now });
  const result = applyCxBucketActiveCallObservation(bucket, {
    agentExtensionId: normalizedExtensionId,
    queueItem,
    activeCall,
    matchResult,
    source: "active-call-observed",
  }, { now });
  bucket = result.bucket;
  await writeBucketsForAgent(normalizedExtensionId, bucket, { repository });

  if (result.promoted) {
    emitBucketLog(
      logger,
      result.currentCall?.phase === "confirming" ? "cx.bucket.active_confirming" : "cx.bucket.active_match",
      bucket,
      {
        matchedBy: result.currentCall?.matchedBy || null,
        confidence: result.currentCall?.confidence || null,
        reason: "active-call-observed",
      },
    );
  } else {
    emitBucketLog(logger, result.rejected ? "cx.bucket.active_match_ambiguous" : "cx.bucket.active_match_miss", bucket, {
      reason: result.reason || "not-promoted",
    }, "warn");
  }

  return { ok: true, ...result, bucket };
}

async function observeCxBucketTerminalOutcome({ extensionId, queueItem = null, outcome = null, logger = null, now = new Date(), repository = null, ...input } = {}) {
  const normalizedExtensionId = normalizeExternalId(extensionId || queueItem?.assignment?.extensionId || input.assignedExtensionId);
  if (!isCxBucketShadowEnabled()) return { ok: true, skipped: true, reason: "disabled" };
  if (!normalizedExtensionId) return { ok: false, skipped: true, reason: "missing-extension-id" };

  let bucket = await readBucketsForAgent(normalizedExtensionId, { repository, now });
  const result = applyCxBucketTerminalOutcome(bucket, {
    ...input,
    ...queueItem,
    queueItemId: input.queueItemId || input.queueTicketId || (queueItem?._id ? String(queueItem._id) : null),
    agentExtensionId: normalizedExtensionId,
    outcome,
    source: "terminal-outcome",
  }, { now });
  bucket = result.bucket;
  await writeBucketsForAgent(normalizedExtensionId, bucket, { repository });
  emitBucketLog(logger, "cx.bucket.terminal_observed", bucket, {
    reason: outcome || "terminal-outcome",
    queueItemId: result.completed?.queueItemId || null,
    uii: result.completed?.uii || null,
    uiiFinalizationStatus: result.completed?.uiiFinalizationStatus || null,
    drainedCurrentCall: result.drainedCurrentCall === true,
    drainReason: result.drainReason || null,
  });
  emitBucketLog(logger, "cx.bucket.completion_buffered", bucket, {
    reason: outcome || "terminal-outcome",
    queueItemId: result.completed?.queueItemId || null,
    uii: result.completed?.uii || null,
    uiiFinalizationStatus: result.completed?.uiiFinalizationStatus || null,
    drainedCurrentCall: result.drainedCurrentCall === true,
    drainReason: result.drainReason || null,
  });
  if (result.completed?.uiiFinalizationStatus === "pending") {
    emitBucketLog(logger, "cx.bucket.uii_finalization_pending", bucket, {
      reason: outcome || "terminal-outcome",
      queueItemId: result.completed?.queueItemId || null,
    }, "warn");
  }
  return { ok: true, ...result, bucket };
}

async function getCxBucketSnapshotForExtension(extensionId, options = {}) {
  if (!isCxBucketDebugReadEnabled() && options.force !== true) {
    return { ok: true, skipped: true, reason: "debug-read-disabled" };
  }
  const bucket = await readBucketsForAgent(extensionId, options);
  return { ok: true, bucket };
}

async function getCxBucketLiveRead(options = {}) {
  if (!isCxBucketDebugReadEnabled() && options.force !== true) {
    return { ok: true, skipped: true, reason: "debug-read-disabled" };
  }
  const repository = options.repository || agentStateRepository;
  const domain = normalizeDomain(options.domain);
  const agents = await repository.listAgentStates({
    ...(domain ? { company: domain } : {}),
  });
  const now = options.now || new Date();
  const rows = (Array.isArray(agents) ? agents : [])
    .map((agent) => buildCxBucketReadRow(agent, {
      now,
      staleCurrentMs: options.staleCurrentMs,
    }))
    .filter((row) => {
      if (options.activeOnly !== true) return true;
      return row.verdict.bucket !== "unknown" ||
        row.legacy.activePlatform === "CX" ||
        row.legacy.activityState === "onCall" ||
        row.legacy.activityState === "dialing" ||
        row.bucket.newCallsCount > 0 ||
        Boolean(row.bucket.currentCall);
    });
  const counts = rows.reduce((acc, row) => {
    const key = row.verdict?.bucket || "unknown";
    acc[key] = Number(acc[key] || 0) + 1;
    return acc;
  }, {});
  const severityRank = { warn: 0, info: 1 };
  rows.sort((left, right) => {
    const severityDelta = (severityRank[left.verdict.severity] ?? 2) - (severityRank[right.verdict.severity] ?? 2);
    if (severityDelta !== 0) return severityDelta;
    return String(left.agent.name || left.agent.extensionId || "").localeCompare(String(right.agent.name || right.agent.extensionId || ""));
  });
  return {
    ok: true,
    generatedAt: toIso(now),
    domain: domain || null,
    count: rows.length,
    counts,
    rows,
  };
}

module.exports = {
  applyCxBucketActiveCallObservation,
  applyCxBucketTerminalOutcome,
  buildCxBucketReadRow,
  buildCxBucketLogPayload,
  candidateKey,
  deriveMatchedBy,
  getCxBucketLiveRead,
  isBucketCurrentCallStale,
  getCxBucketSnapshotForExtension,
  hashPhone,
  isCxBucketDebugReadEnabled,
  isCxBucketShadowEnabled,
  reconcileCxBucketCurrentCalls,
  normalizeCxBucketCandidate,
  normalizeCxCallBuckets,
  observeCxBucketActiveCall,
  observeCxBucketTerminalOutcome,
  phoneLast4,
  primeCxBucketNewCalls,
  upsertCxBucketCandidate,
};
