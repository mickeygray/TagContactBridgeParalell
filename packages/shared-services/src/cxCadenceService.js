"use strict";

const { createEvent, processNextEvent } = require("../../event-core/src");
const { env } = require("../../shared-config/src");
const { LeadCadence } = require("../../shared-models/src");
const {
  agentStateRepository,
  cxDialQueueRepository,
  leadCadenceRepository,
  metricsSnapshotRepository,
} = require("../../shared-repositories/src");
const {
  buildEligibility,
  buildNextAssignmentStats,
  buildReleasedAssignmentStats,
  deriveQueueFamily,
  enrichAgentStatesWithQueuePolicies,
  getQueueFamilySortRank,
  listEligibleAgentsForCx,
  normalizeAssignmentStats,
  normalizeQueueFamily,
  rankAgentsForQueueItem,
  resolveDayZeroProgressiveStage,
} = require("./cxLoadBalancerService");
const {
  buildCallAttemptPatch,
  deriveQueueFamilyFromAgeDays,
  getCooldownReleaseAt,
  getQueueFamilyPolicy,
  resolveQueueDialability,
} = require("./cxQueuePolicyService");
const { evaluateChannelContactTime } = require("./contactTimingPolicyService");
const { resolveCaseContactEligibility, stopCaseContact } = require("./contactEligibilityService");
const { cancelPublishedQueueItemInRingcx } = require("./ringcxLeadServingService");
const { recordWorkflowStage } = require("./workflowStateService");

const CX_CADENCE_EVENT_TYPES = Object.freeze({
  DIAL_REQUESTED: "cx.dial.requested",
  CALL_PLACED: "cx.call.placed",
});

function normalizeDomain(domain) {
  return String(domain || "").trim().toUpperCase();
}

function normalizeActionKey(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function normalizeExternalId(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function resolveRcxQueueRouting(queueFamily, payload = {}) {
  const metadata = payload?.metadata && typeof payload.metadata === "object"
    ? payload.metadata
    : {};
  const normalizedFamily = normalizeQueueFamily(queueFamily);
  const explicitCampaignId =
    normalizeExternalId(payload.rcxCampaignId)
    || normalizeExternalId(payload.campaignId)
    || normalizeExternalId(payload.queueId)
    || normalizeExternalId(metadata.rcxCampaignId)
    || normalizeExternalId(metadata.campaignId)
    || normalizeExternalId(metadata.queueId);
  const explicitDialGroupId =
    normalizeExternalId(payload.rcxDialGroupId)
    || normalizeExternalId(payload.dialGroupId)
    || normalizeExternalId(metadata.rcxDialGroupId)
    || normalizeExternalId(metadata.dialGroupId);
  const explicitAccountId =
    normalizeExternalId(payload.rcxAccountId)
    || normalizeExternalId(payload.accountId)
    || normalizeExternalId(metadata.rcxAccountId)
    || normalizeExternalId(metadata.accountId);

  const defaultCampaignId = normalizeExternalId(env("RINGCX_VOICE_DEFAULT_CAMPAIGN_ID", ""));
  const familyCampaignId =
    normalizedFamily === "fresh-day1"
      ? normalizeExternalId(env("RINGCX_VOICE_NEW_CAMPAIGN_ID", "")) || defaultCampaignId || "2306"
      : normalizedFamily === "fresh-day2to10"
        ? normalizeExternalId(env("RINGCX_VOICE_OLD_CAMPAIGN_ID", "")) || null
        : normalizedFamily === "aged"
          ? normalizeExternalId(env("RINGCX_VOICE_AGED_CAMPAIGN_ID", "")) || null
          : null;

  return {
    rcxAccountId: explicitAccountId || normalizeExternalId(env("RINGCX_VOICE_ACCOUNT_ID", "")),
    rcxDialGroupId: explicitDialGroupId || normalizeExternalId(env("RINGCX_VOICE_DEFAULT_DIAL_GROUP_ID", "")),
    rcxCampaignId: explicitCampaignId || familyCampaignId,
  };
}

function readStoredRcxQueueRouting(payload = {}) {
  const metadata = payload?.metadata && typeof payload.metadata === "object"
    ? payload.metadata
    : {};
  return {
    rcxAccountId: normalizeExternalId(payload.rcxAccountId) || normalizeExternalId(metadata.rcxAccountId),
    rcxDialGroupId: normalizeExternalId(payload.rcxDialGroupId) || normalizeExternalId(metadata.rcxDialGroupId),
    rcxCampaignId: normalizeExternalId(payload.rcxCampaignId) || normalizeExternalId(metadata.rcxCampaignId),
  };
}

function buildInitialCallPlan() {
  return {
    phaseIndex: 0,
    delaysMinutes: [15, 25, 60],
    activeDay: 0,
    nextDelayMinutes: 0,
  };
}

async function maybeRunFreshHotLaneImmediate(queueItem = null, queueFamily = null) {
  if (String(process.env.RC_CX_FRESH_HOT_LANE_IMMEDIATE_ENABLED || "true").toLowerCase() === "false") {
    return null;
  }
  if (normalizeQueueFamily(queueFamily || queueItem?.queueFamily) !== "fresh-day1") {
    return null;
  }
  const domain = normalizeDomain(queueItem?.domain || "");
  if (!domain) return null;
  try {
    // Lazy require avoids a module-load cycle: cxFreshHotLaneService calls
    // back into this module only after the queue row is already durable.
    // eslint-disable-next-line global-require
    const { runFreshHotLaneAllocator } = require("./cxFreshHotLaneService");
    return runFreshHotLaneAllocator({
      mode: "immediate",
      domains: [domain],
      maxCount: Number(process.env.RC_CX_FRESH_HOT_LANE_IMMEDIATE_MAX) || 25,
      claimMinutes: Number(process.env.RC_CX_FRESH_CLAIM_MINUTES) || 15,
      requestKeyPrefix: `fresh-hot-lane:immediate:${queueItem?._id || Date.now()}`,
    });
  } catch (error) {
    return {
      ok: false,
      error: error.message || "fresh-hot-lane-immediate-failed",
    };
  }
}

function computePriorityScore(payload = {}) {
  const source = String(payload.intakeSource || payload.sourceName || "").toLowerCase();
  if (source.includes("ld")) return 300;
  if (source.includes("affiliate")) return 250;
  if (source.includes("organic")) return 175;
  return 200;
}

function resolveQueueFamilyForPayload(payload = {}) {
  const explicit = normalizeQueueFamily(
    payload.queueFamily
      || payload.metadata?.queueFamily
      || payload.family,
  );
  if (explicit !== "unassigned") return explicit;

  if (payload.isAged === true || payload.aged === true) return "aged";
  const leadAgeDays = Number(payload.leadAgeDays);
  if (Number.isFinite(leadAgeDays)) return deriveQueueFamilyFromAgeDays(leadAgeDays);

  const queueTier = String(payload.queueTier || "").trim().toLowerCase();
  if (queueTier === "later") return "fresh-day2to10";
  if (queueTier === "day1" || queueTier === "day0") return "fresh-day1";

  const activeDay = Number(
    payload.queueDayIndex
      ?? payload.callPlan?.activeDay
      ?? payload.activeDay
      ?? 0,
  );
  if (Number.isFinite(activeDay)) {
    if (activeDay > 15) return "aged";
    if (activeDay > 0) return "fresh-day2to10";
  }

  const source = String(payload.intakeSource || payload.sourceName || "").toLowerCase();
  if (source.includes("aged")) return "aged";
  return "fresh-day1";
}

function hasActiveExCall(agentState = null) {
  const currentCall = agentState?.currentCall && typeof agentState.currentCall === "object"
    ? agentState.currentCall
    : {};
  const channel = String(currentCall.channel || "").trim().toLowerCase();
  if (channel !== "ex") return false;
  return Boolean(
    currentCall.sessionId
      || currentCall.telephonySessionId
      || currentCall.from
      || currentCall.to,
  );
}

function normalizeCandidateExtensionIds(values = []) {
  return Array.from(
    new Set(
      (Array.isArray(values) ? values : [values])
        .map((value) => String(value || "").trim())
        .filter(Boolean),
    ),
  );
}

function summarizeQueueItem(item = {}) {
  return {
    id: item?._id ? String(item._id) : null,
    domain: normalizeDomain(item.domain),
    caseId: Number(item.caseId || 0) || null,
    state: item.state || null,
    phone: item.phone || null,
    name: item.name || null,
    sourceName: item.sourceName || null,
    intakeSource: item.intakeSource || null,
    rcxAccountId: normalizeExternalId(item.rcxAccountId) || normalizeExternalId(item.metadata?.rcxAccountId),
    rcxDialGroupId: normalizeExternalId(item.rcxDialGroupId) || normalizeExternalId(item.metadata?.rcxDialGroupId),
    rcxCampaignId: normalizeExternalId(item.rcxCampaignId) || normalizeExternalId(item.metadata?.rcxCampaignId),
    queueFamily: deriveQueueFamily(item),
    queueTier: item.queueTier || null,
    queueFamilyRank: Number(item.queueFamilyRank ?? getQueueFamilySortRank(item.queueFamily)),
    progressiveStageKey: item.progressiveStageKey || null,
    progressiveStageIndex: Number(item.progressiveStageIndex ?? 99),
    progressiveStageLabel: item.progressiveStageLabel || null,
    priorityScore: Number(item.priorityScore || 0),
    releaseAt: item.releaseAt || null,
    claimUntil: item.claimUntil || null,
    assignedExtensionId: item.assignment?.extensionId || null,
    assignedAgentName: item.assignment?.agentName || null,
  };
}

function cloneAssignment(assignment = null) {
  if (!assignment || typeof assignment !== "object") return null;
  if (typeof assignment.toObject === "function") return assignment.toObject();
  return { ...assignment };
}

function isOpenAssignedQueueState(state) {
  return ["queued", "ready", "claimed", "serving", "paused"].includes(
    String(state || "").trim().toLowerCase(),
  );
}

function buildOpenAssignmentMap(queueItems = []) {
  const counts = new Map();
  for (const item of Array.isArray(queueItems) ? queueItems : []) {
    const state = String(item?.state || "").trim().toLowerCase();
    if (!isOpenAssignedQueueState(state)) continue;
    const extensionId = String(item?.assignment?.extensionId || "").trim();
    if (!extensionId) continue;
    counts.set(extensionId, Number(counts.get(extensionId) || 0) + 1);
  }
  return counts;
}

function buildOpenAssignmentMapsByFamily(queueItems = []) {
  const maps = new Map();
  for (const item of Array.isArray(queueItems) ? queueItems : []) {
    const state = String(item?.state || "").trim().toLowerCase();
    if (!isOpenAssignedQueueState(state)) continue;
    const extensionId = String(item?.assignment?.extensionId || "").trim();
    if (!extensionId) continue;
    const family = deriveQueueFamily(item);
    if (!maps.has(family)) maps.set(family, new Map());
    const familyMap = maps.get(family);
    familyMap.set(extensionId, Number(familyMap.get(extensionId) || 0) + 1);
  }
  return maps;
}

function buildQueueProgressionState(payload = {}, queueFamily = null, callPlan = null, placedCalls = null) {
  const normalizedFamily = normalizeQueueFamily(
    queueFamily || resolveQueueFamilyForPayload({
      ...payload,
      callPlan: callPlan || payload.callPlan,
    }),
  );
  const normalizedPlacedCalls = Math.max(
    Number(
      placedCalls
        ?? payload.placedCalls
        ?? 0,
    ) || 0,
    0,
  );
  const stage = resolveDayZeroProgressiveStage({
    ...payload,
    queueFamily: normalizedFamily,
    callPlan: callPlan || payload.callPlan || null,
    placedCalls: normalizedPlacedCalls,
    actionKey: payload.actionKey || payload.metadata?.actionKey || null,
  });

  return {
    queueFamily: normalizedFamily,
    queueFamilyRank: getQueueFamilySortRank(normalizedFamily),
    progressiveStageKey: stage.progressiveStageKey,
    progressiveStageIndex: stage.progressiveStageIndex,
    progressiveStageLabel: stage.progressiveStageLabel,
    metadata: {
      queueFamily: normalizedFamily,
      queueFamilyRank: getQueueFamilySortRank(normalizedFamily),
      progressiveStageKey: stage.progressiveStageKey,
      progressiveStageIndex: stage.progressiveStageIndex,
      progressiveStageLabel: stage.progressiveStageLabel,
    },
  };
}

function buildRankReasonCode(entry = {}, selected = null) {
  if (!entry.eligibility?.eligible) {
    return String(entry.eligibility?.reason || "ineligible");
  }
  if (!selected) return "eligible";
  if (String(entry.extensionId || "") === String(selected.extensionId || "")) {
    return "selected";
  }
  if (Number(entry.familyCount || 0) !== Number(selected.familyCount || 0)) {
    return "higher-family-count";
  }
  if (Number(entry.totalAssigned || 0) !== Number(selected.totalAssigned || 0)) {
    return "higher-total-assigned";
  }
  if (Number(entry.openAssignments || 0) !== Number(selected.openAssignments || 0)) {
    return "more-open-assignments";
  }
  if (Number(entry.lastAssignedAt || 0) !== Number(selected.lastAssignedAt || 0)) {
    return "newer-last-assigned";
  }
  return "lost-tiebreak";
}

function formatRankedAgents(ranking = {}, openAssignmentMap = new Map()) {
  const selected = ranking.selected || null;
  return (Array.isArray(ranking.ranked) ? ranking.ranked : []).map((entry, index) => ({
    rank: index + 1,
    extensionId: entry.extensionId,
    name: entry.name,
    eligible: Boolean(entry.eligibility?.eligible),
    reason: entry.eligibility?.reason || null,
    reasonCode: buildRankReasonCode(entry, selected),
    queueFamily: entry.queueFamily || ranking.queueFamily || null,
    queuePolicyTier: entry.queuePolicy?.tier || null,
    queuePolicyLabel: entry.queuePolicy?.label || null,
    policyTargetOpen: Number(entry.policyTargetOpen || 0),
    targetRemaining: Number(entry.targetRemaining || 0),
    familyCount: Number(entry.familyCount || 0),
    totalAssigned: Number(entry.totalAssigned || 0),
    openAssignments: Number(
      openAssignmentMap.get(String(entry.extensionId || "").trim())
        ?? entry.openAssignments
        ?? 0,
    ),
    lastAssignedAt: entry.assignmentStats?.lastAssignedAt || null,
  }));
}

async function updateAgentAssignmentStats(extensionId, nextAssignmentStats) {
  if (!extensionId || !nextAssignmentStats) return null;
  return agentStateRepository.updateAgentState(extensionId, {
    "cxRouting.assignmentStats": nextAssignmentStats,
    "cxRouting.syncedAt": new Date(),
  });
}

async function decrementAgentOpenAssignments(extensionId) {
  const normalizedExtensionId = String(extensionId || "").trim();
  if (!normalizedExtensionId) return null;
  const agentState = await agentStateRepository.findAgentStateByExtensionId(normalizedExtensionId);
  if (!agentState) return null;
  const nextAssignmentStats = buildReleasedAssignmentStats(agentState?.cxRouting?.assignmentStats || null);
  return updateAgentAssignmentStats(normalizedExtensionId, nextAssignmentStats);
}

function buildClearedOpenAssignmentStats(existingStats = null) {
  const stats = normalizeAssignmentStats(existingStats || null);
  return {
    ...stats,
    openAssignments: 0,
  };
}

async function markAgentCxCallState(queueItem = null, payload = {}, placedAt = new Date()) {
  const extensionId = String(queueItem?.assignment?.extensionId || "").trim();
  if (!extensionId) return null;
  const startedAt = placedAt instanceof Date ? placedAt : new Date(placedAt);
  const phone = String(payload.phone || queueItem?.phone || "").trim() || null;
  const uii = String(payload.uii || "").trim() || null;
  return agentStateRepository.updateAgentState(extensionId, {
    status: "onCall",
    activityState: "onCall",
    activePlatform: "CX",
    currentCall: {
      sessionId: uii,
      telephonySessionId: uii,
      direction: "outbound",
      from: null,
      fromName: queueItem?.assignment?.agentName || null,
      to: phone,
      channel: "cx",
      startTime: Number.isNaN(startedAt.getTime()) ? new Date() : startedAt,
    },
    lastActivityAt: new Date(),
    lastStatusChange: new Date(),
    "upstream.source": "cx-call-placed",
    "upstream.mirroredAt": new Date(),
  });
}

function getServingIntentDate(queueItem = {}) {
  const candidates = [
    queueItem.metadata?.servingAt,
    queueItem.metadata?.lastDialIntentAt,
    queueItem.lastClaimedAt,
    queueItem.updatedAt,
  ];
  for (const value of candidates) {
    if (!value) continue;
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return null;
}

function isProtectedServingQueueItem(queueItem = {}) {
  const metadata = queueItem.metadata || {};
  return Boolean(
    metadata.dealHandoffHold === true
      || metadata.lastQueueAttemptHeldForDisposition === true
      || metadata.lastDialExecutionUii
      || metadata.lastHangupRequestStatus === "accepted",
  );
}

async function requeueStaleServingQueueItems(now = new Date(), limit = 50) {
  const staleMinutes = Math.max(Number(process.env.RC_CX_STALE_SERVING_MINUTES) || 8, 1);
  const cutoff = new Date(new Date(now).getTime() - staleMinutes * 60 * 1000);
  const candidates = await cxDialQueueRepository.listQueueItems({
    states: ["serving"],
    limit: Math.min(Math.max(Number(limit) || 50, 1), 200),
  });
  const requeued = [];
  for (const item of candidates) {
    if (isProtectedServingQueueItem(item)) continue;
    const servingAt = getServingIntentDate(item);
    if (!servingAt || servingAt > cutoff) continue;
    const previousAssignment = cloneAssignment(item.assignment);
    const updated = await cxDialQueueRepository.transitionQueueItemState(
      item._id,
      ["serving"],
      {
        state: "ready",
        releaseAt: now,
        claimUntil: null,
        assignment: buildClearedAssignment(),
        "metadata.lastReleasedAt": now,
        "metadata.lastReleaseReason": "stale-serving-timeout",
        "metadata.lastReleasedExtensionId": previousAssignment?.extensionId || null,
        "metadata.lastReleasedAgentName": previousAssignment?.agentName || null,
        "metadata.staleServingAt": servingAt,
      },
      { returnNew: true },
    );
    if (!updated) continue;
    if (previousAssignment?.extensionId) {
      await decrementAgentOpenAssignments(previousAssignment.extensionId).catch(() => null);
      await agentStateRepository.updateAgentState(previousAssignment.extensionId, {
        status: "available",
        activityState: "idle",
        activePlatform: "none",
        currentCall: {},
        lastActivityAt: now,
        lastStatusChange: now,
        "upstream.source": "stale-serving-timeout",
        "upstream.mirroredAt": now,
      }).catch(() => null);
    }
    requeued.push({
      ...(updated.toObject ? updated.toObject() : updated),
      previousAssignment,
    });
  }
  return requeued;
}

async function decrementOpenAssignmentsForQueueItem(queueItem = null) {
  const extensionId = String(queueItem?.assignment?.extensionId || "").trim();
  if (!extensionId) return null;
  return decrementAgentOpenAssignments(extensionId);
}

async function cancelRingcxPublishedCopyForQueueItem(queueItem = null, reason = "parallel-queue-release") {
  const status = String(queueItem?.metadata?.rcxVisibilityStatus || "").trim().toLowerCase();
  const hasRingcxCopy = Boolean(
    queueItem?.metadata?.rcxVisibilityExternId
      && queueItem?.metadata?.rcxVisibilityCampaignId,
  );
  if (status !== "published" || !hasRingcxCopy) {
    return { ok: true, cancelled: false, skipped: true, reason: "no-published-ringcx-copy" };
  }
  return cancelPublishedQueueItemInRingcx(queueItem, { reason }).catch((error) => ({
    ok: false,
    cancelled: false,
    error: error.message || "ringcx-cancel-copy-failed",
  }));
}

async function buildClaimedOpenAssignmentMap(domain = null, options = {}) {
  const domainScope = String(options.domainScope || options.assignmentScope || "").trim().toLowerCase();
  const assignmentDomain = domainScope === "domain" ? domain : null;
  const queueItems = await cxDialQueueRepository.listQueueItems({
    domain: assignmentDomain || null,
    states: ["queued", "ready", "claimed", "serving", "paused"],
    assignedOnly: true,
    limitAll: options.limitAll !== false,
    limit: Math.min(Math.max(Number(options.limit) || 5000, 100), 10000),
  });
  const queueFamilies = Array.from(
    new Set(
      [
        ...(Array.isArray(options.queueFamilies) ? options.queueFamilies : []),
        options.queueFamily || "",
      ]
        .map((value) => normalizeQueueFamily(value))
        .filter((value) => value !== "unassigned"),
    ),
  );
  const filteredItems = queueFamilies.length > 0
    ? queueItems.filter((queueItem) => queueFamilies.includes(deriveQueueFamily(queueItem)))
    : queueItems;
  return buildOpenAssignmentMap(filteredItems);
}

async function buildClaimedOpenAssignmentFamilyMaps(domain = null, options = {}) {
  const domainScope = String(options.domainScope || options.assignmentScope || "").trim().toLowerCase();
  const assignmentDomain = domainScope === "domain" ? domain : null;
  const queueItems = await cxDialQueueRepository.listQueueItems({
    domain: assignmentDomain || null,
    states: ["queued", "ready", "claimed", "serving", "paused"],
    assignedOnly: true,
    limitAll: options.limitAll !== false,
    limit: Math.min(Math.max(Number(options.limit) || 5000, 100), 10000),
  });
  return buildOpenAssignmentMapsByFamily(queueItems);
}

async function backfillCxQueueOrdering(domain = null, limit = 250) {
  const queueItems = await cxDialQueueRepository.listQueueItems({
    domain: domain || null,
    states: ["queued", "ready", "claimed", "serving", "paused"],
    limit,
  });

  for (const item of queueItems) {
    const progression = buildQueueProgressionState(
      item,
      item.queueFamily,
      item.callPlan || null,
      item.placedCalls,
    );
    const needsPatch = (
      normalizeQueueFamily(item.queueFamily) !== progression.queueFamily
      || Number(item.queueFamilyRank ?? -1) !== progression.queueFamilyRank
      || String(item.progressiveStageKey || "") !== String(progression.progressiveStageKey || "")
      || Number(item.progressiveStageIndex ?? -1) !== progression.progressiveStageIndex
      || String(item.progressiveStageLabel || "") !== String(progression.progressiveStageLabel || "")
      || String(item.metadata?.queueFamily || "") !== String(progression.metadata.queueFamily || "")
      || Number(item.metadata?.queueFamilyRank ?? -1) !== progression.metadata.queueFamilyRank
      || String(item.metadata?.progressiveStageKey || "") !== String(progression.metadata.progressiveStageKey || "")
      || Number(item.metadata?.progressiveStageIndex ?? -1) !== progression.metadata.progressiveStageIndex
      || String(item.metadata?.progressiveStageLabel || "") !== String(progression.metadata.progressiveStageLabel || "")
    );
    if (!needsPatch) continue;

    await cxDialQueueRepository.updateQueueItem(item._id, {
      queueFamily: progression.queueFamily,
      queueFamilyRank: progression.queueFamilyRank,
      progressiveStageKey: progression.progressiveStageKey,
      progressiveStageIndex: progression.progressiveStageIndex,
      progressiveStageLabel: progression.progressiveStageLabel,
      metadata: {
        ...(item.metadata || {}),
        ...(progression.metadata || {}),
      },
    });
  }
}

async function queueCxDialRequest(payload = {}) {
  const domain = normalizeDomain(payload.domain);
  const caseId = Number(payload.caseId);
  const actionKey = normalizeActionKey(
    payload.actionKey || payload.queueKey || payload.metadata?.actionKey,
  );
  if (!domain || !Number.isFinite(caseId)) {
    throw new Error("domain and caseId are required for cx dial queueing");
  }

  const eligibility = await resolveCaseContactEligibility(domain, caseId, {
    enforceStop: true,
    currentStage: "contact-blocked",
    sourceService: "ringcentral-cx",
  });
  if (!eligibility.ok) {
    return {
      queued: false,
      skipped: true,
      reason: eligibility.reason,
      detail: eligibility.detail || null,
    };
  }

  const payloadQueueItemId = String(payload.queueItemId || payload.queueTicketId || "").trim();
  let existing = payloadQueueItemId
    ? await cxDialQueueRepository.findQueueItemById(payloadQueueItemId)
    : null;
  if (!existing) {
    existing = await cxDialQueueRepository.findActiveQueueItem(
      domain,
      caseId,
      actionKey ? { actionKey } : {},
    );
  }
  if (!existing && actionKey) {
    existing = await cxDialQueueRepository.findActiveQueueItem(domain, caseId);
  }
  if (existing) {
    const existingObject = existing.toObject ? existing.toObject() : existing;
    const existingActionKey = normalizeActionKey(existingObject?.metadata?.actionKey);
    const existingRouting = readStoredRcxQueueRouting(existingObject);
    const requestedRouting = resolveRcxQueueRouting(existingObject.queueFamily, {
      ...existingObject,
      ...payload,
      metadata: {
        ...(existingObject.metadata || {}),
        ...(payload.metadata || {}),
      },
    });
    const needsMetadataPatch = (
      (actionKey && existingActionKey !== actionKey)
      || (!existingObject?.leadCadenceId && payload.leadCadenceId)
      || normalizeExternalId(existingRouting.rcxCampaignId) !== normalizeExternalId(requestedRouting.rcxCampaignId)
      || normalizeExternalId(existingRouting.rcxDialGroupId) !== normalizeExternalId(requestedRouting.rcxDialGroupId)
      || normalizeExternalId(existingRouting.rcxAccountId) !== normalizeExternalId(requestedRouting.rcxAccountId)
    );
    if (needsMetadataPatch) {
      const progression = buildQueueProgressionState(
        {
          ...existingObject,
          ...payload,
          actionKey: actionKey || existingActionKey || null,
          metadata: {
            ...(existingObject.metadata || {}),
            ...(payload.metadata || {}),
            actionKey: actionKey || existingActionKey || null,
          },
        },
        existingObject.queueFamily,
        existingObject.callPlan || null,
        existingObject.placedCalls,
      );
      const patched = await cxDialQueueRepository.updateQueueItem(existingObject._id, {
        leadCadenceId: existingObject.leadCadenceId || payload.leadCadenceId || null,
        rcxAccountId: requestedRouting.rcxAccountId,
        rcxDialGroupId: requestedRouting.rcxDialGroupId,
        rcxCampaignId: requestedRouting.rcxCampaignId,
        queueFamily: progression.queueFamily,
        queueFamilyRank: progression.queueFamilyRank,
        progressiveStageKey: progression.progressiveStageKey,
        progressiveStageIndex: progression.progressiveStageIndex,
        progressiveStageLabel: progression.progressiveStageLabel,
        metadata: {
          ...(existingObject.metadata || {}),
          ...(progression.metadata || {}),
          actionKey: actionKey || existingActionKey || null,
          rcxAccountId: requestedRouting.rcxAccountId,
          rcxDialGroupId: requestedRouting.rcxDialGroupId,
          rcxCampaignId: requestedRouting.rcxCampaignId,
        },
      });
      return { queued: true, deduped: true, queueItem: patched?.toObject ? patched.toObject() : patched };
    }
    return { queued: true, deduped: true, queueItem: existingObject };
  }

  const now = new Date();
  const callPlan = buildInitialCallPlan();
  const queueFamily = resolveQueueFamilyForPayload({
    ...payload,
    callPlan,
  });
  const rcxRouting = resolveRcxQueueRouting(queueFamily, payload);
  const progression = buildQueueProgressionState(
    {
      ...payload,
      actionKey,
      metadata: payload.metadata || {},
    },
    queueFamily,
    callPlan,
    payload.placedCalls || 0,
  );
  const queueTier = queueFamily === "fresh-day1" ? "day0" : queueFamily === "fresh-day2to10" ? "later" : "later";
  const timing = evaluateChannelContactTime(
    domain,
    "cx",
    new Date(now.getTime() + callPlan.nextDelayMinutes * 60 * 1000),
  );
  const queueItem = await cxDialQueueRepository.upsertQueueItem(domain, caseId, {
    leadCadenceId: payload.leadCadenceId || null,
    phone: payload.phone || null,
    name: payload.name || null,
    intakeSource: payload.intakeSource || null,
    intakeRoute: payload.intakeRoute || null,
    sourceName: payload.sourceName || null,
    rcxAccountId: rcxRouting.rcxAccountId,
    rcxDialGroupId: rcxRouting.rcxDialGroupId,
    rcxCampaignId: rcxRouting.rcxCampaignId,
    state: timing.allowed ? "ready" : "queued",
    queueFamily: progression.queueFamily,
    queueFamilyRank: progression.queueFamilyRank,
    queueTier,
    progressiveStageKey: progression.progressiveStageKey,
    progressiveStageIndex: progression.progressiveStageIndex,
    progressiveStageLabel: progression.progressiveStageLabel,
    priorityScore: computePriorityScore(payload),
    releaseAt: timing.nextAllowedAt,
    callPlan,
    metadata: {
      requestedBy: payload.requestedBy || "cadence-engine",
      executionOwner: payload.executionOwner || "ringcentral-cx",
      futureAdapterPort: payload.futureAdapterPort || 6101,
      actionKey,
      requestedWorkflowId: payload.workflowId || null,
      requestedByUserEmail: payload.requestedByUserEmail || null,
      leadCreatedAt: payload.leadCreatedAt || payload.createdAt || payload.payloadSnapshot?.createdAt || null,
      rcxAccountId: rcxRouting.rcxAccountId,
      rcxDialGroupId: rcxRouting.rcxDialGroupId,
      rcxCampaignId: rcxRouting.rcxCampaignId,
      ...(progression.metadata || {}),
    },
  }, actionKey ? { actionKey } : {});

  await recordWorkflowStage({
    domain,
    family: "cx",
    subtype: "cadence-queue",
    stage: "queued",
    aggregateType: "cx-dial-queue",
    aggregateId: String(queueItem._id),
    caseId,
    sourceService: "ringcentral-cx",
    summary: `CX cadence queue created for case ${caseId}`,
    payload: {
      phone: payload.phone || null,
      releaseAt: queueItem.releaseAt,
      queueTier: queueItem.queueTier,
      priorityScore: queueItem.priorityScore,
      rcxCampaignId: queueItem.rcxCampaignId || null,
      rcxDialGroupId: queueItem.rcxDialGroupId || null,
      timezone: timing.timezone,
    },
  });

  const queueObject = queueItem.toObject ? queueItem.toObject() : queueItem;
  const hotLane = await maybeRunFreshHotLaneImmediate(queueObject, progression.queueFamily);

  return {
    queued: true,
    deduped: false,
    queueItem: queueObject,
    hotLane,
  };
}

async function handleCxCallPlaced(payload = {}) {
  const queueItemId = String(payload.queueItemId || "").trim();
  const queueItem = queueItemId
    ? await cxDialQueueRepository.findQueueItemById(queueItemId)
    : await cxDialQueueRepository.findActiveQueueItem(
      payload.domain,
      payload.caseId,
      payload.actionKey ? { actionKey: payload.actionKey } : {},
    );

  if (!queueItem) {
    throw new Error("CX queue item not found for call placed callback");
  }

  const domain = normalizeDomain(queueItem.domain);
  const caseId = Number(queueItem.caseId);
  const placedAt = payload.placedAt ? new Date(payload.placedAt) : new Date();
  const eligibility = await resolveCaseContactEligibility(domain, caseId, {
    enforceStop: false,
    currentStage: "contact-blocked",
    sourceService: "ringcentral-cx",
  });
  const currentPlan = queueItem.callPlan || buildInitialCallPlan();
  const nextIndex = Number(currentPlan.phaseIndex || 0) + 1;
  const nextDelayMinutes = eligibility.ok ? (currentPlan.delaysMinutes?.[nextIndex] ?? null) : null;
  const attemptPatch = buildCallAttemptPatch(queueItem, placedAt);
  const attemptQueuePatch = Object.fromEntries(
    Object.entries(attemptPatch).filter(([key]) => !key.startsWith("metadata.")),
  );
  const nextPlacedCalls = Number(attemptPatch.placedCalls || 0);
  await markAgentCxCallState(queueItem, payload, placedAt).catch(() => null);
  const queueState = String(queueItem.state || "").trim().toLowerCase();
  if (["completed", "cancelled"].includes(queueState)) {
    await cxDialQueueRepository.updateQueueItem(queueItem._id, {
      ...attemptQueuePatch,
      metadata: {
        ...(queueItem.metadata || {}),
        dailyPlacedDateKey: attemptPatch.dailyPlacedDateKey,
        dailyPlacedCalls: attemptPatch.dailyPlacedCalls,
        lastQueueAttemptAt: placedAt,
        lastQueueAttemptIgnoredState: queueState,
        lastQueueAttemptUii: payload.uii || null,
        lastQueueAttemptPhone: payload.phone || queueItem.phone || null,
      },
    }).catch(() => null);
    return {
      ok: true,
      queueItemId: String(queueItem._id),
      caseId,
      placedCalls: nextPlacedCalls,
      nextDelayMinutes: null,
      ignoredTerminalState: queueState,
    };
  }
  if (queueState !== "serving" && String(queueItem.metadata?.lastReleaseReason || "") === "callback") {
    await cxDialQueueRepository.updateQueueItem(queueItem._id, {
      ...attemptQueuePatch,
      metadata: {
        ...(queueItem.metadata || {}),
        dailyPlacedDateKey: attemptPatch.dailyPlacedDateKey,
        dailyPlacedCalls: attemptPatch.dailyPlacedCalls,
        lastQueueAttemptAt: placedAt,
        lastQueueAttemptIgnoredState: queueState,
        lastQueueAttemptIgnoredReason: "already-callback-rescheduled",
        lastQueueAttemptUii: payload.uii || null,
        lastQueueAttemptPhone: payload.phone || queueItem.phone || null,
      },
    }).catch(() => null);
    return {
      ok: true,
      queueItemId: String(queueItem._id),
      caseId,
      placedCalls: nextPlacedCalls,
      nextDelayMinutes: null,
      ignoredReleasedState: queueState,
    };
  }
  const nextPlan = nextDelayMinutes == null
    ? currentPlan
    : {
      ...currentPlan,
      phaseIndex: nextIndex,
      nextDelayMinutes,
    };
  const progression = buildQueueProgressionState(
    {
      ...queueItem,
      metadata: {
        ...(queueItem.metadata || {}),
      },
    },
    queueItem.queueFamily,
    nextPlan,
    nextPlacedCalls,
  );
  const holdUntilDisposition =
    queueState === "serving"
    || queueItem.metadata?.dealHandoffHold === true;

  if (holdUntilDisposition) {
    await cxDialQueueRepository.updateQueueItem(queueItem._id, {
      state: "serving",
      claimUntil: null,
      ...attemptQueuePatch,
      callPlan: nextPlan,
      queueFamilyRank: progression.queueFamilyRank,
      progressiveStageKey: progression.progressiveStageKey,
      progressiveStageIndex: progression.progressiveStageIndex,
      progressiveStageLabel: progression.progressiveStageLabel,
      metadata: {
        ...(queueItem.metadata || {}),
        ...(progression.metadata || {}),
        dailyPlacedDateKey: attemptPatch.dailyPlacedDateKey,
        dailyPlacedCalls: attemptPatch.dailyPlacedCalls,
        lastQueueAttemptAt: placedAt,
        lastQueueAttemptHeldForDisposition: true,
        lastQueueAttemptUii: payload.uii || null,
        lastQueueAttemptPhone: payload.phone || queueItem.phone || null,
      },
    });
  } else if (nextDelayMinutes == null) {
    await completeCxQueueItem({
      queueItemId: String(queueItem._id),
      queueOutcome: "cadence-finished",
      disposition: "cx-call-placed",
      extraUpdate: {
        ...attemptQueuePatch,
        queueFamilyRank: progression.queueFamilyRank,
        progressiveStageKey: progression.progressiveStageKey,
        progressiveStageIndex: progression.progressiveStageIndex,
        progressiveStageLabel: progression.progressiveStageLabel,
        metadata: {
          ...(queueItem.metadata || {}),
          ...(progression.metadata || {}),
          dailyPlacedDateKey: attemptPatch.dailyPlacedDateKey,
          dailyPlacedCalls: attemptPatch.dailyPlacedCalls,
          lastQueueAttemptAt: placedAt,
        },
      },
    });
  } else {
    const timing = evaluateChannelContactTime(
      domain,
      "cx",
      new Date(placedAt.getTime() + nextDelayMinutes * 60 * 1000),
    );
    await rescheduleCxQueueItem({
      queueItemId: String(queueItem._id),
      releaseAt: timing.nextAllowedAt,
      reason: "follow-up-delay",
      extraUpdate: {
        ...attemptQueuePatch,
        callPlan: nextPlan,
        queueFamilyRank: progression.queueFamilyRank,
        progressiveStageKey: progression.progressiveStageKey,
        progressiveStageIndex: progression.progressiveStageIndex,
        progressiveStageLabel: progression.progressiveStageLabel,
        metadata: {
          ...(queueItem.metadata || {}),
          ...(progression.metadata || {}),
          dailyPlacedDateKey: attemptPatch.dailyPlacedDateKey,
          dailyPlacedCalls: attemptPatch.dailyPlacedCalls,
          lastQueueAttemptAt: placedAt,
        },
      },
    });
  }

  const lead = await LeadCadence.findOne({
    domain,
    caseId,
  }).lean();
  const preferredActionKey = normalizeActionKey(payload.actionKey || queueItem?.metadata?.actionKey);
  const pendingCxActions = (lead?.schedule?.actions || []).filter(
    (entry) => entry.channel === "cx" && (entry.status === "pending" || entry.status === "requested"),
  );
  const pendingCxAction = (
    (preferredActionKey
      ? pendingCxActions.find((entry) => String(entry.key || "").trim() === preferredActionKey)
      : null)
    || pendingCxActions[0]
    || null
  );
  if (pendingCxAction && !holdUntilDisposition) {
    await leadCadenceRepository.markScheduledActionStatus(domain, caseId, pendingCxAction.key, "completed", {
      currentStage: "cx-call-placed",
    });
    await leadCadenceRepository.syncLeadCadenceState(domain, caseId);
  }

  await metricsSnapshotRepository.recordMetricEvent(domain, {
    metricName: "contacts_sent",
    sourceKey: "cx",
    amount: 1,
    caseId,
    title: "cx call placed",
    eventType: "outbound.cx.completed",
    happenedAt: placedAt,
  });

  await recordWorkflowStage({
    domain,
    family: "cx",
    subtype: "cadence-call",
    stage: "completed",
    aggregateType: "case",
    aggregateId: String(caseId),
    caseId,
    sourceService: "ringcentral-cx",
    summary: "CX cadence call placed",
    payload: {
      queueItemId: String(queueItem._id),
      placedAt,
      nextDelayMinutes,
      placedCalls: nextPlacedCalls,
      heldForDisposition: holdUntilDisposition,
    },
  });

  if (!eligibility.ok) {
    await stopCaseContact(domain, caseId, {
      reason: eligibility.reason,
      detail: eligibility.detail || "Future contact cancelled after CX call placed",
      currentStage: "contact-blocked",
      sourceService: "ringcentral-cx",
    });
  }

  return {
    ok: true,
    queueItemId: String(queueItem._id),
    caseId,
    placedCalls: nextPlacedCalls,
    nextDelayMinutes,
    heldForDisposition: holdUntilDisposition,
  };
}

function buildCxCadenceHandlers() {
  return {
    [CX_CADENCE_EVENT_TYPES.DIAL_REQUESTED]: (event) => queueCxDialRequest(event.payload || {}),
    [CX_CADENCE_EVENT_TYPES.CALL_PLACED]: (event) => handleCxCallPlaced(event.payload || {}),
  };
}

async function processNextCxCadenceEvent(options = {}) {
  return processNextEvent({
    workerName: options.workerName || "ringcentral-cx-cadence-worker",
    handlers: buildCxCadenceHandlers(),
    maxAttempts: options.maxAttempts || 5,
  });
}

async function processCxCadenceEventBatch(options = {}) {
  const maxCount = Math.min(Number(options.maxCount) || 10, 100);
  const results = [];
  for (let index = 0; index < maxCount; index += 1) {
    const result = await processNextCxCadenceEvent(options);
    results.push(result);
    if (!result.claimed) break;
  }

  return {
    processed: results.filter((entry) => entry.claimed).length,
    handled: results.filter((entry) => entry.handled).length,
    results,
  };
}

async function releaseCxQueueBatch(options = {}) {
  const now = options.now || new Date();
  const releaseExpiredAssignments =
    String(process.env.RC_CX_RELEASE_EXPIRED_ASSIGNMENTS_ENABLED || "true").toLowerCase() !== "false";
  const releaseStaleServing =
    String(process.env.RC_CX_RELEASE_STALE_SERVING_ENABLED || "true").toLowerCase() !== "false";
  const requeued = releaseExpiredAssignments
    ? await cxDialQueueRepository.requeueExpiredClaims(now, options.limit || 50)
    : [];
  for (const item of requeued) {
    if (item?.previousAssignment?.extensionId) {
      await decrementAgentOpenAssignments(item.previousAssignment.extensionId).catch(() => null);
    }
  }
  const staleServing = releaseStaleServing
    ? await requeueStaleServingQueueItems(now, options.limit || 50)
    : [];
  const released = await cxDialQueueRepository.releaseDueQueueItems(now, options.limit || 50);
  return {
    releaseExpiredAssignments,
    releaseStaleServing,
    requeuedCount: requeued.length,
    staleServingRequeuedCount: staleServing.length,
    releasedCount: released.length,
    requeued,
    staleServing,
    released,
  };
}

async function reconcileRequestedCxCadence(options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const olderThanMs = Math.max(Number(options.olderThanMs) || 2 * 60 * 1000, 30 * 1000);
  const limit = Math.min(Math.max(Number(options.limit) || 100, 1), 500);
  const requeueDelayMs = Math.max(Number(options.requeueDelayMs) || 60 * 1000, 15 * 1000);
  const staleDocs = await leadCadenceRepository.listCxRequestedActionsForReconcile({
    domain: options.domain || null,
    now,
    olderThanMs,
    limit,
  });

  const summary = {
    scanned: 0,
    preserved: 0,
    requeued: 0,
    completed: 0,
    cancelled: 0,
    skipped: 0,
    errors: 0,
    items: [],
  };

  for (const doc of staleDocs) {
    const requestedActions = (Array.isArray(doc?.schedule?.actions) ? doc.schedule.actions : [])
      .filter((entry) => {
        if (entry?.channel !== "cx" || entry?.status !== "requested") return false;
        if (!entry?.scheduledFor) return false;
        return new Date(entry.scheduledFor).getTime() <= (now.getTime() - olderThanMs);
      });

    for (const action of requestedActions) {
      const actionKey = normalizeActionKey(action?.key);
      if (!actionKey) {
        summary.skipped += 1;
        summary.items.push({
          domain: doc.domain,
          caseId: Number(doc.caseId),
          actionKey: null,
          outcome: "skipped-missing-action-key",
        });
        continue;
      }

      summary.scanned += 1;
      try {
        let matchingQueueItems = await cxDialQueueRepository.listQueueItems({
          domain: doc.domain,
          caseId: doc.caseId,
          metadataActionKey: actionKey,
          limit: 25,
        });
        if (matchingQueueItems.length === 0) {
          matchingQueueItems = await cxDialQueueRepository.listQueueItems({
            domain: doc.domain,
            caseId: doc.caseId,
            limit: 25,
          });
        }
        const activeQueueItem = matchingQueueItems.find((item) =>
          ["queued", "ready", "claimed", "serving", "paused"].includes(String(item?.state || "").trim().toLowerCase()),
        );
        if (activeQueueItem) {
          summary.preserved += 1;
          summary.items.push({
            domain: doc.domain,
            caseId: Number(doc.caseId),
            actionKey,
            queueItemId: activeQueueItem?._id ? String(activeQueueItem._id) : null,
            queueState: activeQueueItem?.state || null,
            outcome: "preserved-active-queue",
          });
          continue;
        }

        const terminalQueueItem = matchingQueueItems.find((item) =>
          ["completed", "cancelled"].includes(String(item?.state || "").trim().toLowerCase()),
        );
        if (terminalQueueItem) {
          const terminalState = String(terminalQueueItem.state || "").trim().toLowerCase();
          await leadCadenceRepository.markScheduledActionStatus(
            doc.domain,
            doc.caseId,
            actionKey,
            terminalState === "completed" ? "completed" : "cancelled",
            {
              currentStage: terminalState === "completed" ? "cx-call-placed" : "cx-cancelled",
            },
          );
          await leadCadenceRepository.syncLeadCadenceState(doc.domain, doc.caseId).catch(() => null);
          if (terminalState === "completed") {
            summary.completed += 1;
          } else {
            summary.cancelled += 1;
          }
          summary.items.push({
            domain: doc.domain,
            caseId: Number(doc.caseId),
            actionKey,
            queueItemId: terminalQueueItem?._id ? String(terminalQueueItem._id) : null,
            queueState: terminalQueueItem?.state || null,
            outcome: terminalState === "completed" ? "completed-from-queue" : "cancelled-from-queue",
          });
          continue;
        }

        const retryAt = new Date(now.getTime() + requeueDelayMs);
        await leadCadenceRepository.rescheduleScheduledAction(
          doc.domain,
          doc.caseId,
          actionKey,
          retryAt,
          {
            currentStage: "cx-requeued",
          },
        );
        await leadCadenceRepository.syncLeadCadenceState(doc.domain, doc.caseId).catch(() => null);
        await recordWorkflowStage({
          domain: doc.domain,
          family: "cx",
          subtype: "cadence-queue",
          stage: "queued",
          aggregateType: "case",
          aggregateId: String(doc.caseId),
          caseId: Number(doc.caseId),
          sourceService: "ringcentral-cx",
          summary: `Re-queued stale CX cadence request for case ${doc.caseId}`,
          payload: {
            actionKey,
            retryAt,
            reason: "queue-item-missing",
          },
        });
        summary.requeued += 1;
        summary.items.push({
          domain: doc.domain,
          caseId: Number(doc.caseId),
          actionKey,
          retryAt,
          outcome: "requeued-missing-queue",
        });
      } catch (error) {
        summary.errors += 1;
        summary.items.push({
          domain: doc.domain,
          caseId: Number(doc.caseId),
          actionKey,
          outcome: "error",
          error: error.message,
        });
      }
    }
  }

  return summary;
}

async function claimNextCxQueueItem(options = {}) {
  await backfillCxQueueOrdering(options.domain || null).catch(() => null);
  const requestKey = String(options.requestKey || "").trim();
  if (requestKey) {
    const existingClaim = await cxDialQueueRepository.findClaimedQueueItemByRequestKey(options.domain || null, requestKey);
    if (existingClaim) {
      const existingItem = existingClaim.toObject ? existingClaim.toObject() : existingClaim;
      return {
        ok: true,
        claimed: true,
        requestReused: true,
        item: existingItem,
        assignment: existingItem.assignment?.extensionId
          ? {
            extensionId: existingItem.assignment.extensionId,
            agentName: existingItem.assignment.agentName || null,
            queueFamily: deriveQueueFamily(existingItem),
            requestKey,
            rankedAgents: [],
          }
          : null,
      };
    }
  }

  let item = null;
  const policySkipped = [];
  const maxClaimAttempts = Math.min(Math.max(Number(options.maxClaimAttempts) || 10, 1), 50);
  for (let attempt = 0; attempt < maxClaimAttempts; attempt += 1) {
    const claimed = await cxDialQueueRepository.claimNextReadyQueueItem(
      options.domain || null,
      options.claimMinutes || 5,
      {
        queueFamily: options.queueFamily || null,
        queueFamilies: Array.isArray(options.queueFamilies) ? options.queueFamilies : [],
        randomize: Boolean(options.randomize),
        preferQueueFamilyOrder: options.preferQueueFamilyOrder !== false,
        createdAtGte: options.createdAtGte || options.windowStart || null,
        createdAtLte: options.createdAtLte || options.windowEnd || null,
      },
    );
    if (!claimed) break;
    const claimedObject = claimed.toObject ? claimed.toObject() : claimed;
    const claimedFamily = deriveQueueFamily(claimedObject);
    const dialability = resolveQueueDialability({
      ...claimedObject,
      queueFamily: claimedFamily,
    }, new Date());
    if (dialability.ok) {
      item = claimed;
      break;
    }

    await cxDialQueueRepository.updateQueueItem(claimedObject._id, {
      state: "queued",
      claimUntil: null,
      releaseAt: dialability.nextEligibleAt || new Date(Date.now() + 30 * 60 * 1000),
      "metadata.lastPolicyHoldAt": new Date(),
      "metadata.lastPolicyHoldReason": dialability.reason,
      "metadata.lastPolicyHoldDetail": dialability.detail || null,
      "metadata.queueFamily": claimedFamily,
      "metadata.lastPolicyHoldDailyCount": dialability.dailyCount,
      "metadata.lastPolicyHoldDailyMax": dialability.dailyMax,
      "metadata.lastPolicyHoldReleaseAt": dialability.nextEligibleAt || null,
    }).catch(() => null);
    policySkipped.push({
      queueItemId: claimedObject?._id ? String(claimedObject._id) : null,
      caseId: Number(claimedObject?.caseId || 0) || null,
      queueFamily: deriveQueueFamily(claimedObject),
      reason: dialability.reason,
      releaseAt: dialability.nextEligibleAt || null,
    });
  }
  if (!item) {
    return {
      ok: true,
      claimed: false,
      skipped: policySkipped.length > 0,
      reason: policySkipped.length > 0 ? "queue-policy-hold" : null,
      policySkipped,
    };
  }
  let claimedItem = item.toObject ? item.toObject() : item;

  const eligibility = await resolveCaseContactEligibility(item.domain, item.caseId, {
    enforceStop: true,
    currentStage: "contact-blocked",
    sourceService: "ringcentral-cx",
  });
  if (!eligibility.ok) {
    await cancelCxQueueItem({
      queueItemId: String(item._id),
      reason: eligibility.reason || "contact-blocked",
      queueOutcome: "cancelled",
      statusCategory: "contact-blocked",
      statusLabel: eligibility.detail || eligibility.reason || "contact blocked",
    }).catch(() => null);
    return {
      ok: true,
      claimed: false,
      skipped: true,
      reason: eligibility.reason,
      detail: eligibility.detail || null,
    };
  }

  const timing = evaluateChannelContactTime(item.domain, "cx", new Date());
  if (!timing.allowed) {
    await cxDialQueueRepository.updateQueueItem(item._id, {
      state: "queued",
      claimUntil: null,
      releaseAt: timing.nextAllowedAt,
    });
    return {
      ok: true,
      claimed: false,
      skipped: true,
      reason: timing.reason,
      detail: `Deferred until ${timing.nextAllowedAt.toISOString()} (${timing.timezone})`,
      deferUntil: timing.nextAllowedAt,
      timezone: timing.timezone,
    };
  }

  const extensionId = String(options.extensionId || "").trim();
  const candidateExtensionIds = Array.isArray(options.candidateExtensionIds)
    ? options.candidateExtensionIds
    : [];
  let assignment = null;

  {
    const queueFamily = deriveQueueFamily(item);
    const assignmentScope = String(options.maxOpenAssignmentsScope || "").trim().toLowerCase();
    const openAssignmentFamilyMaps = await buildClaimedOpenAssignmentFamilyMaps(item.domain);
    const openAssignmentMap =
      openAssignmentFamilyMaps.get(queueFamily)
      || await buildClaimedOpenAssignmentMap(item.domain, {
        queueFamily: assignmentScope === "queue-family" ? queueFamily : null,
        queueFamilies: assignmentScope === "non-fresh" ? ["fresh-day2to10", "aged"] : [],
      });
    const agents = extensionId
      ? await listEligibleAgentsForCx(item.domain, [extensionId])
      : await listEligibleAgentsForCx(item.domain, candidateExtensionIds);
    const ranking = rankAgentsForQueueItem(agents, item, {
      openAssignmentMap,
      openAssignmentFamilyMaps,
      maxOpenAssignments: options.maxOpenAssignments,
      scopedOpenAssignmentMap: true,
    });
    if (!ranking.selected) {
      await cxDialQueueRepository.updateQueueItem(item._id, {
        state: "ready",
        claimUntil: null,
      });
      return {
        ok: true,
        claimed: false,
        skipped: true,
        reason: "no-eligible-agents",
        detail: "No eligible CX agents were available for this queue family.",
        queueFamily: ranking.queueFamily,
        rankedAgents: formatRankedAgents(ranking, openAssignmentMap),
      };
    }

    const selectedAgent = ranking.selected.agentState;
    const assignedQueueFamily = ranking.queueFamily || queueFamily;
    const nextAssignmentStats = buildNextAssignmentStats(selectedAgent?.cxRouting?.assignmentStats || null, assignedQueueFamily);
    const updatedAgentState = await updateAgentAssignmentStats(selectedAgent.extensionId, nextAssignmentStats);
    const assignedAt = new Date();
    const claimMinutes = Math.max(
      Number(options.claimMinutes || 0) || Number(getQueueFamilyPolicy(assignedQueueFamily).claimMinutes || 0) || 5,
      1,
    );

    const updatedQueueItem = await cxDialQueueRepository.updateQueueItem(item._id, {
      assignment: {
        extensionId: selectedAgent.extensionId,
        agentName: selectedAgent.name || null,
        assignedAt,
        queueFamilySnapshot: assignedQueueFamily,
      },
      queueFamily: assignedQueueFamily,
      claimUntil: new Date(assignedAt.getTime() + claimMinutes * 60 * 1000),
      "metadata.assignedExtensionId": selectedAgent.extensionId,
      "metadata.assignedAgentName": selectedAgent.name || null,
      "metadata.assignmentReason": "balanced-load",
      "metadata.assignmentRequestKey": requestKey || null,
      "metadata.assignedAt": assignedAt,
      "metadata.assignmentClaimMinutes": claimMinutes,
    });
    claimedItem = updatedQueueItem?.toObject ? updatedQueueItem.toObject() : updatedQueueItem || claimedItem;

    assignment = {
      extensionId: selectedAgent.extensionId,
      agentName: selectedAgent.name || null,
      queueFamily: assignedQueueFamily,
      requestKey: requestKey || null,
      assignmentStats: updatedAgentState?.cxRouting?.assignmentStats || nextAssignmentStats,
      rankedAgents: formatRankedAgents(
        ranking,
        new Map(openAssignmentMap).set(
          String(selectedAgent.extensionId || "").trim(),
          Number(openAssignmentMap.get(String(selectedAgent.extensionId || "").trim()) || 0) + 1,
        ),
      ),
    };
  }

  await recordWorkflowStage({
    domain: item.domain,
    family: "cx",
    subtype: "cadence-queue",
    stage: "requested",
    aggregateType: "cx-dial-queue",
    aggregateId: String(item._id),
    caseId: Number(item.caseId),
    sourceService: "ringcentral-cx",
    summary: `CX queue item claimed for case ${item.caseId}`,
    payload: {
      phone: item.phone || null,
      queueTier: item.queueTier,
      queueFamily: assignment?.queueFamily || item.queueFamily || deriveQueueFamily(item),
      priorityScore: item.priorityScore,
      claimUntil: item.claimUntil,
      assignedExtensionId: assignment?.extensionId || null,
      assignedAgentName: assignment?.agentName || null,
    },
  });

  const rcxVisibility = {
    ok: true,
    published: false,
    skipped: true,
    reason: "assignment-only",
    queueItemId: claimedItem?._id ? String(claimedItem._id) : null,
  };

  return {
    ok: true,
    claimed: true,
    item: claimedItem,
    assignment,
    rcxVisibility,
  };
}

async function assignCxQueueBatch(options = {}) {
  const maxCount = Math.min(Math.max(Number(options.maxCount) || 10, 1), 100);
  const results = [];
  const requestKeyPrefix = String(options.requestKeyPrefix || `assign-batch:${Date.now()}`).trim();
  const explicitQueueFamilies = Array.isArray(options.queueFamilies) && options.queueFamilies.length > 0
    ? options.queueFamilies
    : [];
  const queueFamilies = explicitQueueFamilies.length > 0
    ? explicitQueueFamilies
    : String(options.queueFamily || "")
      .split(",")
      .map((value) => String(value || "").trim())
      .filter(Boolean);

  for (let index = 0; index < maxCount; index += 1) {
    const result = await claimNextCxQueueItem({
      domain: options.domain || null,
      claimMinutes: options.claimMinutes || 5,
      extensionId: options.extensionId || null,
      candidateExtensionIds: Array.isArray(options.candidateExtensionIds)
        ? options.candidateExtensionIds
        : [],
      queueFamilies,
      randomize: Boolean(options.randomize),
      preferQueueFamilyOrder: options.preferQueueFamilyOrder !== false,
      maxOpenAssignments: options.maxOpenAssignments,
      maxOpenAssignmentsScope: options.maxOpenAssignmentsScope || null,
      createdAtGte: options.createdAtGte || options.windowStart || null,
      createdAtLte: options.createdAtLte || options.windowEnd || null,
      requestKey: `${requestKeyPrefix}:${index + 1}`,
    });
    results.push(result);
    if (!result.claimed && result.reason !== "queue-policy-hold") break;
  }

  return {
    ok: true,
    requested: maxCount,
    assigned: results.filter((entry) => entry.claimed).length,
    skipped: results.filter((entry) => entry.skipped).length,
    results,
  };
}

function buildClearedAssignment() {
  return {
    extensionId: null,
    agentName: null,
    assignedAt: null,
    queueFamilySnapshot: null,
  };
}

function normalizeExtraQueueUpdate(extraUpdate = null) {
  if (!extraUpdate || typeof extraUpdate !== "object") return {};
  const normalized = { ...extraUpdate };
  const metadata = normalized.metadata && typeof normalized.metadata === "object"
    ? normalized.metadata
    : null;
  delete normalized.metadata;
  if (metadata) {
    for (const [key, value] of Object.entries(metadata)) {
      normalized[`metadata.${key}`] = value;
    }
  }
  return normalized;
}

async function resolveQueueItemForMutation(options = {}) {
  const queueItemId = String(options.queueItemId || "").trim();
  if (queueItemId) {
    const item = await cxDialQueueRepository.findQueueItemById(queueItemId);
    return item ? (item.toObject ? item.toObject() : item) : null;
  }

  const domain = normalizeDomain(options.domain);
  const caseId = Number(options.caseId);
  if (domain && Number.isFinite(caseId)) {
    const actionKey = normalizeActionKey(options.actionKey || options.queueActionKey);
    const item = await cxDialQueueRepository.findActiveQueueItem(
      domain,
      caseId,
      actionKey ? { actionKey } : {},
    );
    return item ? (item.toObject ? item.toObject() : item) : null;
  }

  return null;
}

async function releaseCxQueueItem(options = {}) {
  const item = await resolveQueueItemForMutation(options);
  if (!item) {
    return { ok: true, mutated: false, reason: "queue-item-not-found" };
  }

  const now = options.now ? new Date(options.now) : new Date();
  const releaseAt = options.releaseAt ? new Date(options.releaseAt) : now;
  const previousAssignment = cloneAssignment(item.assignment);
  const ringcxCancel = await cancelRingcxPublishedCopyForQueueItem(
    item,
    `queue-release:${options.reason || "manual-release"}`,
  );
  await cxDialQueueRepository.transitionQueueItemState(
    item._id,
    ["queued", "ready", "claimed", "serving", "paused"],
    {
      state: "ready",
      releaseAt,
      claimUntil: null,
      assignment: buildClearedAssignment(),
      completedAt: null,
      cancelledAt: null,
      "metadata.lastReleasedAt": now,
      "metadata.lastReleaseReason": options.reason || "manual-release",
      "metadata.lastReleasedExtensionId": previousAssignment?.extensionId || null,
      "metadata.lastReleasedAgentName": previousAssignment?.agentName || null,
      "metadata.lastReleasedBy": options.actorEmail || null,
      "metadata.lastRingcxReleaseCancel": ringcxCancel,
      ...normalizeExtraQueueUpdate(options.extraUpdate),
    },
  );
  if (isOpenAssignedQueueState(item.state) && previousAssignment?.extensionId) {
    await decrementAgentOpenAssignments(previousAssignment.extensionId).catch(() => null);
  }

  return {
    ok: true,
    mutated: true,
    state: "ready",
    queueItemId: String(item._id),
    caseId: Number(item.caseId),
    previousAssignment,
    ringcxCancel,
    releaseAt,
  };
}

async function releaseAssignedCxQueueForAgent(options = {}) {
  const extensionId = String(options.extensionId || "").trim();
  if (!extensionId) {
    return { ok: false, released: 0, reason: "extension-id-required" };
  }

  const now = options.now ? new Date(options.now) : new Date();
  const actorEmail = String(options.actorEmail || "").trim() || null;
  const reason = options.reason || "agent-logout";
  const states = Array.isArray(options.states) && options.states.length > 0
    ? options.states
    : ["queued", "ready", "claimed", "serving", "paused"];
  const assignedItems = await cxDialQueueRepository.listQueueItems({
    assignedExtensionId: extensionId,
    states,
    limitAll: true,
  });

  const results = [];
  for (const item of assignedItems) {
    const result = await releaseCxQueueItem({
      queueItemId: item._id,
      now,
      releaseAt: now,
      reason,
      actorEmail,
      extraUpdate: {
        metadata: {
          logoutReleasedAt: now,
          logoutReleasedBy: actorEmail,
        },
      },
    });
    results.push(result);
  }

  const agentState = await agentStateRepository.findAgentStateByExtensionId(extensionId);
  const nextAssignmentStats = buildClearedOpenAssignmentStats(
    agentState?.cxRouting?.assignmentStats || null,
  );
  await agentStateRepository.updateAgentState(extensionId, {
    activityState: "unavailable",
    lastActivityAt: now,
    lastStatusChange: now,
    "cxRouting.desiredAvailability": "unavailable",
    "cxRouting.reason": "manual-unavailable",
    "cxRouting.syncedAt": now,
    "cxRouting.lastSource": "cx-workspace",
    "cxRouting.assignmentStats": nextAssignmentStats,
    "upstream.source": reason,
    "upstream.mirroredAt": now,
  }).catch(() => null);

  return {
    ok: true,
    extensionId,
    scanned: assignedItems.length,
    released: results.filter((entry) => entry?.mutated).length,
    results,
  };
}

async function rescheduleCxQueueItem(options = {}) {
  const item = await resolveQueueItemForMutation(options);
  if (!item) {
    return { ok: true, mutated: false, reason: "queue-item-not-found" };
  }

  const now = options.now ? new Date(options.now) : new Date();
  const releaseAt = options.releaseAt ? new Date(options.releaseAt) : now;
  const previousAssignment = cloneAssignment(item.assignment);
  const ringcxCancel = await cancelRingcxPublishedCopyForQueueItem(
    item,
    `queue-reschedule:${options.reason || "rescheduled"}`,
  );
  await cxDialQueueRepository.transitionQueueItemState(
    item._id,
    ["queued", "ready", "claimed", "serving", "paused"],
    {
      state: "queued",
      releaseAt,
      claimUntil: null,
      assignment: buildClearedAssignment(),
      completedAt: null,
      cancelledAt: null,
      "metadata.lastReleasedAt": now,
      "metadata.lastReleaseReason": options.reason || "rescheduled",
      "metadata.lastReleasedExtensionId": previousAssignment?.extensionId || null,
      "metadata.lastReleasedAgentName": previousAssignment?.agentName || null,
      "metadata.lastReleasedBy": options.actorEmail || null,
      "metadata.lastRingcxReleaseCancel": ringcxCancel,
      ...normalizeExtraQueueUpdate(options.extraUpdate),
    },
  );
  if (isOpenAssignedQueueState(item.state) && previousAssignment?.extensionId) {
    await decrementAgentOpenAssignments(previousAssignment.extensionId).catch(() => null);
  }

  return {
    ok: true,
    mutated: true,
    state: "queued",
    queueItemId: String(item._id),
    caseId: Number(item.caseId),
    previousAssignment,
    ringcxCancel,
    releaseAt,
  };
}

async function stageCxDispatchIntent(options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const dispatchIntent =
    options.dispatchIntent && typeof options.dispatchIntent === "object"
      ? { ...options.dispatchIntent }
      : {};
  const item = await resolveQueueItemForMutation({
    queueItemId:
      options.queueItemId ||
      dispatchIntent.queueItemId ||
      dispatchIntent.queueTicketId ||
      null,
    domain: options.domain || dispatchIntent.domain || null,
    caseId:
      options.caseId != null
        ? Number(options.caseId)
        : dispatchIntent.caseId != null
          ? Number(dispatchIntent.caseId)
          : null,
  });

  const normalizedDomain = normalizeDomain(
    options.domain || dispatchIntent.domain || item?.domain || "",
  );
  const normalizedCaseId = Number(
    options.caseId != null
      ? options.caseId
      : dispatchIntent.caseId != null
        ? dispatchIntent.caseId
        : item?.caseId,
  );
  const queueItemId = String(
    options.queueItemId ||
      dispatchIntent.queueItemId ||
      dispatchIntent.queueTicketId ||
      item?._id ||
      "",
  ).trim() || null;

  if (!queueItemId && !Number.isFinite(normalizedCaseId)) {
    const error = new Error("queueItemId or caseId is required to stage a CX dispatch intent");
    error.status = 400;
    throw error;
  }

  const status = String(options.status || "").trim().toLowerCase();
  const markServing =
    options.markServing === true ||
    status === "serving" ||
    status === "staged";
  const markClaimed =
    !markServing &&
    status === "queued" &&
    dispatchIntent.consumeQueueItem === true;
  const assignedExtensionId = String(
    dispatchIntent.assignedExtensionId ||
      dispatchIntent.agent?.assignedExtensionId ||
      dispatchIntent.agent?.extensionId ||
      item?.assignment?.extensionId ||
      "",
  ).trim() || null;
  const assignedAgentName = String(
    dispatchIntent.assignedAgentName ||
      dispatchIntent.agent?.assignedAgentName ||
      dispatchIntent.agent?.name ||
      item?.assignment?.agentName ||
      "",
  ).trim() || null;
  const existingAssignedExtensionId = String(item?.assignment?.extensionId || "").trim() || null;
  if (
    item?._id &&
    existingAssignedExtensionId &&
    assignedExtensionId &&
    existingAssignedExtensionId !== assignedExtensionId
  ) {
    const error = new Error(
      `CX queue item is assigned to ${item.assignment?.agentName || existingAssignedExtensionId}`,
    );
    error.status = 409;
    throw error;
  }

  const relaySummary = {
    requestedAt: now.toISOString(),
    source: options.source || dispatchIntent.requestedBy || "cx-dispatch",
    workflowId: dispatchIntent.workflowId || null,
    eventId: dispatchIntent.eventId || null,
    assignedExtensionId,
  };
  const policyClaimMinutes = Math.max(
    Number(getQueueFamilyPolicy(item?.queueFamily || dispatchIntent.queueFamily).claimMinutes || 0) || 5,
    1,
  );

  let updated = null;
  if (item?._id) {
    updated = await cxDialQueueRepository.updateQueueItem(item._id, {
      ...(assignedExtensionId
        ? {
          assignment: {
            extensionId: assignedExtensionId,
            agentName: assignedAgentName,
            assignedAt: item.assignment?.assignedAt || now,
            queueFamilySnapshot: item.assignment?.queueFamilySnapshot || item.queueFamily || null,
          },
          "metadata.assignedExtensionId": assignedExtensionId,
          "metadata.assignedAgentName": assignedAgentName,
        }
        : {}),
      ...(markClaimed
        ? {
          state: "claimed",
          lastClaimedAt: item.lastClaimedAt || now,
          claimUntil: new Date(now.getTime() + policyClaimMinutes * 60 * 1000),
        }
        : {}),
      ...(markServing
        ? {
          state: "serving",
          claimUntil: null,
          "metadata.servingAt": now,
          "metadata.servingBy": relaySummary.source,
        }
        : {}),
      "metadata.lastDialIntent": dispatchIntent,
      "metadata.lastDialIntentAt": now,
      "metadata.lastDialIntentSource": relaySummary.source,
      "metadata.lastDialIntentWorkflowId": relaySummary.workflowId,
      "metadata.lastDialIntentEventId": relaySummary.eventId,
      "metadata.lastDialIntentAssignedExtensionId": relaySummary.assignedExtensionId,
      "metadata.lastDialIntentPhone": dispatchIntent.phone || null,
      "metadata.lastDialIntentQueueState": dispatchIntent.queueState || item.state || null,
      "metadata.lastDialIntentStatus": options.status || "staged",
    });
  }

  const effectiveItem = updated?.toObject ? updated.toObject() : updated || item || null;
  const rcxVisibility = {
    ok: true,
    published: false,
    skipped: true,
    reason:
      String(dispatchIntent.mode || "").trim().toLowerCase() === "manual-oneoff"
        ? "manual-oneoff-no-autopublish"
        : "staged-no-autopublish",
    queueItemId: effectiveItem?._id ? String(effectiveItem._id) : queueItemId,
  };

  return {
    ok: true,
    staged: Boolean(item?._id),
    queueItemId,
    domain: normalizedDomain || null,
    caseId: Number.isFinite(normalizedCaseId) ? normalizedCaseId : null,
    queueState: markServing
      ? "serving"
      : markClaimed
        ? "claimed"
        : dispatchIntent.queueState || item?.state || null,
    assignedExtensionId: relaySummary.assignedExtensionId,
    updatedAt: now.toISOString(),
    dispatchIntent,
    metadataStamped: Boolean(updated?._id),
    rcxVisibility,
  };
}

async function completeCxQueueItem(options = {}) {
  const item = await resolveQueueItemForMutation(options);
  if (!item) {
    return { ok: true, mutated: false, reason: "queue-item-not-found" };
  }

  const now = options.now ? new Date(options.now) : new Date();
  const previousAssignment = cloneAssignment(item.assignment);
  await cxDialQueueRepository.transitionQueueItemState(
    item._id,
    ["queued", "ready", "claimed", "serving", "paused"],
    {
      state: "completed",
      claimUntil: null,
      assignment: buildClearedAssignment(),
      completedAt: now,
      "metadata.queueOutcome": options.queueOutcome || "completed",
      "metadata.disposition": options.disposition || null,
      "metadata.reflectedLogicsStatusId": options.statusId != null ? Number(options.statusId) : null,
      "metadata.reflectedLogicsStatusCategory": options.statusCategory || null,
      "metadata.reflectedLogicsStatusLabel": options.statusLabel || null,
      "metadata.completedBy": options.actorEmail || null,
      "metadata.completionWorkflowId": options.workflowId || null,
      ...normalizeExtraQueueUpdate(options.extraUpdate),
    },
  );
  if (isOpenAssignedQueueState(item.state) && previousAssignment?.extensionId) {
    await decrementAgentOpenAssignments(previousAssignment.extensionId).catch(() => null);
  }

  return {
    ok: true,
    mutated: true,
    state: "completed",
    queueItemId: String(item._id),
    caseId: Number(item.caseId),
    previousAssignment,
    completedAt: now,
  };
}

async function cancelCxQueueItem(options = {}) {
  const item = await resolveQueueItemForMutation(options);
  if (!item) {
    return { ok: true, mutated: false, reason: "queue-item-not-found" };
  }

  const now = options.now ? new Date(options.now) : new Date();
  const previousAssignment = cloneAssignment(item.assignment);
  await cxDialQueueRepository.transitionQueueItemState(
    item._id,
    ["queued", "ready", "claimed", "serving", "paused"],
    {
      state: "cancelled",
      claimUntil: null,
      assignment: buildClearedAssignment(),
      cancelledAt: now,
      "metadata.cancelReason": options.reason || "cancelled",
      "metadata.queueOutcome": options.queueOutcome || "cancelled",
      "metadata.disposition": options.disposition || null,
      "metadata.reflectedLogicsStatusId": options.statusId != null ? Number(options.statusId) : null,
      "metadata.reflectedLogicsStatusCategory": options.statusCategory || null,
      "metadata.reflectedLogicsStatusLabel": options.statusLabel || null,
      "metadata.cancelledBy": options.actorEmail || null,
      "metadata.completionWorkflowId": options.workflowId || null,
      ...normalizeExtraQueueUpdate(options.extraUpdate),
    },
  );
  if (isOpenAssignedQueueState(item.state) && previousAssignment?.extensionId) {
    await decrementAgentOpenAssignments(previousAssignment.extensionId).catch(() => null);
  }

  return {
    ok: true,
    mutated: true,
    state: "cancelled",
    queueItemId: String(item._id),
    caseId: Number(item.caseId),
    previousAssignment,
    cancelledAt: now,
  };
}

async function resolvePreviewQueueItem(options = {}) {
  const queueItemId = String(options.queueItemId || "").trim();
  if (queueItemId) {
    const item = await cxDialQueueRepository.findQueueItemById(queueItemId);
    if (!item) {
      const error = new Error(`CX queue item ${queueItemId} not found`);
      error.status = 404;
      throw error;
    }
    return item.toObject ? item.toObject() : item;
  }

  const domain = normalizeDomain(options.domain || options.item?.domain);
  const caseId = Number(options.caseId ?? options.item?.caseId);
  if (domain && Number.isFinite(caseId)) {
    const actionKey = normalizeActionKey(options.actionKey || options.queueActionKey || options.item?.metadata?.actionKey);
    const item = await cxDialQueueRepository.findActiveQueueItem(
      domain,
      caseId,
      actionKey ? { actionKey } : {},
    );
    if (item) {
      return item.toObject ? item.toObject() : item;
    }
  }

  if (options.item && typeof options.item === "object") {
    return {
      ...options.item,
      domain,
      caseId: Number.isFinite(caseId) ? caseId : options.item.caseId,
      queueFamily: normalizeQueueFamily(options.item.queueFamily || options.item.metadata?.queueFamily),
    };
  }

  const error = new Error("queueItemId, domain+caseId, or item payload is required");
  error.status = 400;
  throw error;
}

async function previewCxAssignment(options = {}) {
  const item = await resolvePreviewQueueItem(options);
  const domain = normalizeDomain(options.domain || item.domain);
  const extensionId = String(options.extensionId || "").trim();
  const candidateExtensionIds = normalizeCandidateExtensionIds(options.candidateExtensionIds);
  const agents = extensionId
    ? await listEligibleAgentsForCx(domain, [extensionId])
    : await listEligibleAgentsForCx(domain, candidateExtensionIds);
  const openAssignmentFamilyMaps = await buildClaimedOpenAssignmentFamilyMaps(domain);
  const queueFamily = deriveQueueFamily(item);
  const openAssignmentMap = openAssignmentFamilyMaps.get(queueFamily) || await buildClaimedOpenAssignmentMap(domain);
  const ranking = rankAgentsForQueueItem(agents, item, {
    openAssignmentMap,
    openAssignmentFamilyMaps,
    scopedOpenAssignmentMap: true,
  });

  return {
    ok: true,
    domain,
    queueItem: summarizeQueueItem(item),
    queueFamily: ranking.queueFamily,
    candidateExtensionIds: extensionId ? [extensionId] : candidateExtensionIds,
    candidateCount: agents.length,
    selected: ranking.selected
      ? {
        extensionId: ranking.selected.extensionId,
        name: ranking.selected.name,
        queueFamily: ranking.queueFamily,
        familyCount: Number(ranking.selected.familyCount || 0),
        totalAssigned: Number(ranking.selected.totalAssigned || 0),
        openAssignments: Number(openAssignmentMap.get(String(ranking.selected.extensionId || "").trim()) || 0),
      }
      : null,
    rankedAgents: formatRankedAgents(ranking, openAssignmentMap),
  };
}

async function previewCxAssignmentBuild(options = {}) {
  const domain = normalizeDomain(options.domain);
  if (!domain) {
    const error = new Error("domain is required");
    error.status = 400;
    throw error;
  }

  const maxCount = Math.min(Math.max(Number(options.maxCount) || 10, 1), 100);
  const extensionId = String(options.extensionId || "").trim();
  const candidateExtensionIds = normalizeCandidateExtensionIds(options.candidateExtensionIds);
  const [readyItems, claimedItems, agents] = await Promise.all([
    cxDialQueueRepository.listQueueItems({
      domain,
      state: "ready",
      limit: Math.max(maxCount * 3, 100),
    }),
    cxDialQueueRepository.listQueueItems({
      domain,
      states: ["claimed", "serving"],
      limit: 1000,
    }),
    extensionId
      ? listEligibleAgentsForCx(domain, [extensionId])
      : listEligibleAgentsForCx(domain, candidateExtensionIds),
  ]);

  const simulatedOpenAssignments = buildOpenAssignmentMap(claimedItems);
  const simulatedOpenAssignmentFamilyMaps = buildOpenAssignmentMapsByFamily(claimedItems);
  const simulatedStats = new Map(
    agents.map((agent) => [
      String(agent?.extensionId || "").trim(),
      normalizeAssignmentStats(agent?.cxRouting?.assignmentStats || null),
    ]),
  );
  const plans = [];

  for (const item of readyItems.slice(0, maxCount)) {
    const simulatedAgents = agents.map((agent) => {
      const extension = String(agent?.extensionId || "").trim();
      return {
        ...agent,
        cxRouting: {
          ...(agent?.cxRouting || {}),
          assignmentStats: simulatedStats.get(extension) || normalizeAssignmentStats(null),
        },
      };
    });
    const rankingFamily = deriveQueueFamily(item);
    const familyOpenAssignments =
      simulatedOpenAssignmentFamilyMaps.get(rankingFamily)
      || simulatedOpenAssignments;
    const ranking = rankAgentsForQueueItem(simulatedAgents, item, {
      openAssignmentMap: familyOpenAssignments,
      openAssignmentFamilyMaps: simulatedOpenAssignmentFamilyMaps,
      scopedOpenAssignmentMap: true,
    });
    const selected = ranking.selected || null;
    const selectedExtension = String(selected?.extensionId || "").trim();
    if (selected && selectedExtension) {
      const nextStats = buildNextAssignmentStats(simulatedStats.get(selectedExtension) || null, ranking.queueFamily);
      simulatedStats.set(selectedExtension, nextStats);
      simulatedOpenAssignments.set(selectedExtension, Number(simulatedOpenAssignments.get(selectedExtension) || 0) + 1);
      if (!simulatedOpenAssignmentFamilyMaps.has(ranking.queueFamily)) {
        simulatedOpenAssignmentFamilyMaps.set(ranking.queueFamily, new Map());
      }
      const selectedFamilyMap = simulatedOpenAssignmentFamilyMaps.get(ranking.queueFamily);
      selectedFamilyMap.set(
        selectedExtension,
        Number(selectedFamilyMap.get(selectedExtension) || 0) + 1,
      );
    }
    plans.push({
      queueItem: summarizeQueueItem(item),
      queueFamily: ranking.queueFamily,
      selected: selected
        ? {
          extensionId: selected.extensionId,
          name: selected.name,
          familyCount: Number(selected.familyCount || 0),
          totalAssigned: Number(selected.totalAssigned || 0),
          openAssignments: Number(simulatedOpenAssignments.get(selectedExtension) || 0),
        }
        : null,
      rankedAgents: formatRankedAgents(ranking, simulatedOpenAssignments),
    });
  }

  return {
    ok: true,
    domain,
    candidateExtensionIds: extensionId ? [extensionId] : candidateExtensionIds,
    candidateCount: agents.length,
    requested: maxCount,
    planned: plans.length,
    plans,
  };
}

async function createCxCallPlacedEvent(input = {}) {
  return createEvent({
    eventType: CX_CADENCE_EVENT_TYPES.CALL_PLACED,
    sourceService: input.sourceService || "ringcentral-cx",
    aggregateType: "case",
    aggregateId: String(input.caseId || input.queueItemId || "cx-call"),
    dedupeKey: input.dedupeKey || null,
    payload: input.payload || {},
  });
}

async function buildCxCadenceRuntimeSnapshot(domain = null) {
  const normalizedDomain = normalizeDomain(domain);
  const [queueItems, domainAgents, fallbackAgents] = await Promise.all([
    cxDialQueueRepository.listQueueItems({ domain: normalizedDomain || null, limit: 1000 }),
    normalizedDomain ? agentStateRepository.listAgentStates({ company: normalizedDomain }) : [],
    normalizedDomain ? [] : agentStateRepository.listAgentStates({}),
  ]);

  const agentStates = normalizedDomain
    ? domainAgents
    : fallbackAgents;
  const enrichedAgentStates = await enrichAgentStatesWithQueuePolicies(agentStates);
  const queue = {
    total: 0,
    byState: {
      queued: 0,
      ready: 0,
      claimed: 0,
      serving: 0,
      completed: 0,
      cancelled: 0,
      paused: 0,
    },
    byFamily: {
      "fresh-day1": { total: 0, queued: 0, ready: 0, claimed: 0, serving: 0, completed: 0, cancelled: 0, paused: 0 },
      "fresh-day2to10": { total: 0, queued: 0, ready: 0, claimed: 0, serving: 0, completed: 0, cancelled: 0, paused: 0 },
      aged: { total: 0, queued: 0, ready: 0, claimed: 0, serving: 0, completed: 0, cancelled: 0, paused: 0 },
      unassigned: { total: 0, queued: 0, ready: 0, claimed: 0, serving: 0, completed: 0, cancelled: 0, paused: 0 },
    },
  };

  for (const item of queueItems) {
    const state = String(item?.state || "").trim().toLowerCase();
    const family = deriveQueueFamily(item);
    queue.total += 1;
    if (Object.prototype.hasOwnProperty.call(queue.byState, state)) {
      queue.byState[state] += 1;
    }
    if (!Object.prototype.hasOwnProperty.call(queue.byFamily, family)) {
      queue.byFamily[family] = { total: 0, queued: 0, ready: 0, claimed: 0, serving: 0, completed: 0, cancelled: 0, paused: 0 };
    }
    queue.byFamily[family].total += 1;
    if (Object.prototype.hasOwnProperty.call(queue.byFamily[family], state)) {
      queue.byFamily[family][state] += 1;
    }
  }

  const openAssignmentMap = buildOpenAssignmentMap(queueItems);
  const agents = (Array.isArray(enrichedAgentStates) ? enrichedAgentStates : []).map((agentState) => {
    const extensionId = String(agentState?.extensionId || "").trim() || null;
    const openAssignments = Number(openAssignmentMap.get(extensionId) || 0);
    return {
      extensionId,
      name: agentState?.name || null,
      company: agentState?.company || null,
      desiredAvailability: agentState?.cxRouting?.desiredAvailability || null,
      routingEnabled: agentState?.cxRouting?.enabled !== false,
      currentChannel: agentState?.currentCall?.channel || null,
      eligibility: buildEligibility(agentState, { openAssignments }),
      queuePolicy: agentState?.cxQueuePolicy || null,
      userAccountEmail: agentState?.userAccount?.email || null,
      assignmentStats: agentState?.cxRouting?.assignmentStats || null,
      openAssignments,
      hasActiveExCall: hasActiveExCall(agentState),
    };
  });
  const eligibleAgents = agents.filter((agent) => agent.eligibility?.eligible).length;

  return {
    domain: normalizedDomain || null,
    generatedAt: new Date(),
    queue,
    agents: {
      total: agents.length,
      eligible: eligibleAgents,
      unavailable: Math.max(agents.length - eligibleAgents, 0),
      items: agents,
    },
  };
}

module.exports = {
  assignCxQueueBatch,
  cancelCxQueueItem,
  CX_CADENCE_EVENT_TYPES,
  buildCxCadenceRuntimeSnapshot,
  claimNextCxQueueItem,
  completeCxQueueItem,
  createCxCallPlacedEvent,
  handleCxCallPlaced,
  processCxCadenceEventBatch,
  processNextCxCadenceEvent,
  previewCxAssignment,
  previewCxAssignmentBuild,
  queueCxDialRequest,
  reconcileRequestedCxCadence,
  releaseAssignedCxQueueForAgent,
  releaseCxQueueItem,
  releaseCxQueueBatch,
  rescheduleCxQueueItem,
  stageCxDispatchIntent,
};
