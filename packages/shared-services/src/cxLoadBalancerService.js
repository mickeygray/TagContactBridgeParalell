"use strict";

const { agentStateRepository, userAccountRepository } = require("../../shared-repositories/src");
const {
  deriveQueueFamilyFromLeadCreatedAt,
  getQueueFamilyPolicy,
  getQueueFamilySortRank,
  getQueueFamilyTargetOpen,
  hasManualQueuePolicy,
  isQueueFamilyAllowedForAccountPolicy,
  normalizeQueueFamily,
  resolveAccountQueuePolicy,
} = require("./cxQueuePolicyService");
const {
  isLeadServingExcludedAgent,
} = require("./cxLeadServingEligibilityService");
const {
  isCxWorkspacePresenceActive,
  isCxWorkspacePresenceRequired,
  isExLeadServingGateEnabled,
} = require("./agentAvailabilityService");

const DEFAULT_MAX_OPEN_ASSIGNMENTS = Math.max(Number(process.env.CX_MAX_OPEN_ASSIGNMENTS) || 3, 1);
const DAY_ZERO_PROGRESSIVE_STAGES = Object.freeze({
  "cx-day0-1": {
    progressiveStageKey: "just-came-in",
    progressiveStageIndex: 0,
    progressiveStageLabel: "Just came in",
  },
  "cx-day0-2": {
    progressiveStageKey: "second-contact",
    progressiveStageIndex: 1,
    progressiveStageLabel: "Second contact",
  },
  "cx-day0-3": {
    progressiveStageKey: "third-contact",
    progressiveStageIndex: 2,
    progressiveStageLabel: "Third contact",
  },
});

const INELIGIBLE_ACTIVITY_STATES = new Set([
  "dialing",
  "oncall",
  "dispositioning",
  "wrapup",
  "unavailable",
  "offline",
]);

function normalizeActionKey(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function getTodayKey() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
  }).format(new Date());
}

function readBooleanEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const normalized = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function emptyAssignmentStats(date = getTodayKey()) {
  return {
    date,
    totalAssigned: 0,
    freshDay1Assigned: 0,
    freshDay2to10Assigned: 0,
    freshDay16to30Assigned: 0,
    agedAssigned: 0,
    openAssignments: 0,
    lastAssignedAt: null,
    lastAssignedQueueFamily: null,
  };
}

function normalizeAssignmentStats(raw = null, date = getTodayKey()) {
  const base = emptyAssignmentStats(date);
  if (!raw || typeof raw !== "object") return base;
  if (String(raw.date || "") !== date) return base;
  return {
    date,
    totalAssigned: Number(raw.totalAssigned || 0),
    freshDay1Assigned: Number(raw.freshDay1Assigned || 0),
    freshDay2to10Assigned: Number(raw.freshDay2to10Assigned || 0),
    freshDay16to30Assigned: Number(raw.freshDay16to30Assigned || 0),
    agedAssigned: Number(raw.agedAssigned || 0),
    openAssignments: Math.max(Number(raw.openAssignments || 0), 0),
    lastAssignedAt: raw.lastAssignedAt || null,
    lastAssignedQueueFamily: raw.lastAssignedQueueFamily || null,
  };
}

function familyCountForStats(stats, queueFamily) {
  const normalized = normalizeQueueFamily(queueFamily);
  if (normalized === "fresh-day1") return Number(stats.freshDay1Assigned || 0);
  if (normalized === "fresh-day2to10") return Number(stats.freshDay2to10Assigned || 0);
  if (normalized === "fresh-day16to30") return Number(stats.freshDay16to30Assigned || 0);
  if (normalized === "aged") return Number(stats.agedAssigned || 0);
  return Number(stats.totalAssigned || 0);
}

function resolveAgentQueuePolicy(agentState = null) {
  if (agentState?.cxQueuePolicy && typeof agentState.cxQueuePolicy === "object") {
    return resolveAccountQueuePolicy({
      role: agentState.userAccount?.role || agentState.accountRole || null,
      audience: agentState.userAccount?.audience || agentState.accountAudience || null,
      status: agentState.userAccount?.status || agentState.accountStatus || "active",
      cxQueuePolicy: agentState.cxQueuePolicy,
    });
  }
  if (agentState?.userAccount && typeof agentState.userAccount === "object") {
    return resolveAccountQueuePolicy(agentState.userAccount);
  }
  return resolveAccountQueuePolicy(null);
}

function resolveEffectiveMaxOpenAssignments(queuePolicy, queueFamily, configuredMax = null, options = {}) {
  const policyTarget = getQueueFamilyTargetOpen(queuePolicy, queueFamily);
  const configured = Number(configuredMax);
  if (options.explicitPolicyTarget === true && policyTarget > 0) return Math.max(policyTarget, 1);
  if (policyTarget > 0 && Number.isFinite(configured) && configured > 0) {
    return Math.max(Math.min(policyTarget, Math.trunc(configured)), 1);
  }
  if (policyTarget > 0) return Math.max(policyTarget, 1);
  if (Number.isFinite(configured) && configured > 0) return Math.max(Math.trunc(configured), 1);
  return DEFAULT_MAX_OPEN_ASSIGNMENTS;
}

function getOpenAssignmentMapForFamily(openAssignmentFamilyMaps, queueFamily) {
  if (!(openAssignmentFamilyMaps instanceof Map)) return null;
  const normalized = normalizeQueueFamily(queueFamily);
  return openAssignmentFamilyMaps.get(normalized) || null;
}

function hasActiveExCall(agentState = null) {
  const currentCall = agentState?.currentCall && typeof agentState.currentCall === "object"
    ? agentState.currentCall
    : {};
  const channel = String(currentCall.channel || "").trim().toLowerCase();
  if (channel !== "ex") return false;
  const telephonyStatus = String(agentState?.exTelephonyStatus || "").trim().toLowerCase();
  const appStatus = String(agentState?.status || "").trim().toLowerCase();
  const connected = telephonyStatus === "callconnected"
    || telephonyStatus === "onhold"
    || appStatus === "oncall";
  if (!connected) return false;
  return Boolean(
    currentCall.sessionId
      || currentCall.telephonySessionId
      || currentCall.from
      || currentCall.to,
  );
}

function deriveEffectiveActivityState(agentState = null) {
  const explicit = String(agentState?.activityState || "").trim();
  const currentCallChannel = String(agentState?.currentCall?.channel || "").trim().toLowerCase();
  if (explicit) {
    if (!isExLeadServingGateEnabled() && currentCallChannel === "ex") return "idle";
    return explicit;
  }

  const status = String(agentState?.status || "").trim().toLowerCase();
  if (status === "available") return "idle";
  if (status === "oncall") return "onCall";
  if (status === "ringing") {
    const direction = String(agentState?.currentCall?.direction || "").trim().toLowerCase();
    return direction === "outbound" ? "dialing" : "idle";
  }
  if (status === "disposition") return "dispositioning";
  if (status === "away") return "unavailable";
  if (status === "offline") return "offline";
  return "idle";
}

function pickLeadCreatedAt(item = {}, { includeQueueItemCreatedAt = true } = {}) {
  const rawCreatedAt =
    item.metadata?.leadCreatedAt ||
    item.payloadSnapshot?.createdAt ||
    item.leadCreatedAt ||
    (includeQueueItemCreatedAt ? item.createdAt : null) ||
    null;
  return rawCreatedAt || null;
}

function deriveAgeFamilyFromCreatedAt(item = {}, now = new Date(), options = {}) {
  const rawCreatedAt = pickLeadCreatedAt(item, options);
  if (!rawCreatedAt) return null;
  const createdAt = new Date(rawCreatedAt);
  const nowDate = new Date(now);
  if (Number.isNaN(createdAt.getTime()) || Number.isNaN(nowDate.getTime())) return null;
  return deriveQueueFamilyFromLeadCreatedAt(createdAt, nowDate, {
    placedCalls:
      item.placedCalls
      ?? item.metadata?.placedCalls
      ?? item.payloadSnapshot?.placedCalls
      ?? item.payloadSnapshot?.metadata?.placedCalls
      ?? 0,
  });
}

function isZeroContactFreshQueueItem(item = {}) {
  if (deriveQueueFamily(item) !== "fresh-day1") return false;
  const placedCalls = Number(item.placedCalls ?? item.dailyPlacedCalls ?? item.metadata?.placedCalls ?? 0);
  if (Number.isFinite(placedCalls) && placedCalls > 0) return false;
  const stageIndex = Number(item.progressiveStageIndex);
  if (Number.isFinite(stageIndex) && stageIndex > 0) return false;
  return true;
}

function isMaterializedBacklogQueueItem(item = {}) {
  const metadata = item.metadata && typeof item.metadata === "object" ? item.metadata : {};
  const markers = [
    metadata.materializedBy,
    metadata.materializedFrom,
    metadata.actionKey,
    item.intakeRoute,
    item.progressiveStageKey,
    item.queueTier,
  ].map((value) => String(value || "").trim().toLowerCase());
  return markers.some((marker) =>
    marker.includes("day2to15")
      || marker.includes("day2-15")
      || marker.includes("aged")
      || marker.includes("filler")
      || marker.includes("cx-workspace-refill")
      || marker === "later",
  );
}

function buildEligibility(agentState = null, options = {}) {
  const routing = agentState?.cxRouting && typeof agentState.cxRouting === "object"
    ? agentState.cxRouting
    : {};
  const assignmentStats = normalizeAssignmentStats(agentState?.cxRouting?.assignmentStats);
  const queueFamily = normalizeQueueFamily(options.queueFamily || "unassigned");
  const queuePolicy = resolveAgentQueuePolicy(agentState);
  const openAssignments = Math.max(
    Number(options.openAssignments ?? assignmentStats.openAssignments ?? 0),
    0,
  );
  const maxOpenAssignments = resolveEffectiveMaxOpenAssignments(
    queuePolicy,
    queueFamily,
    options.maxOpenAssignments,
    {
      explicitPolicyTarget: Boolean(agentState?.cxQueuePolicyExplicit),
    },
  );
  if (!agentState) {
    return {
      eligible: false,
      reason: "agent-not-found",
    };
  }
  if (!queuePolicy.enabled) {
    return {
      eligible: false,
      reason: "queue-policy-no-leads",
      queuePolicy,
    };
  }
  const zeroContactFreshAllowed =
    options.zeroContactFresh === true
    && queueFamily === "fresh-day1"
    && queuePolicy.fresh?.firstTouchEligible === true;
  if (options.zeroContactFresh === true && queueFamily === "fresh-day1" && !zeroContactFreshAllowed) {
    return {
      eligible: false,
      reason: "queue-policy-blocked-first-touch",
      queuePolicy,
    };
  }
  if (
    queueFamily !== "unassigned"
    && !isQueueFamilyAllowedForAccountPolicy(queuePolicy, queueFamily)
    && !zeroContactFreshAllowed
  ) {
    return {
      eligible: false,
      reason: `queue-policy-blocked-${queueFamily}`,
      queuePolicy,
    };
  }
  if (isLeadServingExcludedAgent(agentState) && !(agentState?.cxQueuePolicyExplicit && queuePolicy.enabled)) {
    return {
      eligible: false,
      reason: "lead-serving-excluded",
      queuePolicy,
    };
  }
  if (routing.enabled === false) {
    return {
      eligible: false,
      reason: "cx-routing-disabled",
      queuePolicy,
    };
  }
  if (isExLeadServingGateEnabled() && hasActiveExCall(agentState)) {
    return {
      eligible: false,
      reason: "ex-busy",
      queuePolicy,
    };
  }
  if (String(routing.desiredAvailability || "").trim().toLowerCase() !== "available") {
    return {
      eligible: false,
      reason: String(routing.reason || "cx-unavailable"),
      queuePolicy,
    };
  }
  if (options.drainBeforeRefill === true && openAssignments > 0) {
    return {
      eligible: false,
      reason: "drain-before-refill",
      queuePolicy,
      maxOpenAssignments,
    };
  }
  if (isCxWorkspacePresenceRequired() && !isCxWorkspacePresenceActive(agentState)) {
    return {
      eligible: false,
      reason: "cx-workspace-stale",
      queuePolicy,
    };
  }
  const activityState = deriveEffectiveActivityState(agentState);
  if (
    options.ignoreActivityState !== true
    && INELIGIBLE_ACTIVITY_STATES.has(String(activityState || "").trim().toLowerCase())
  ) {
    return {
      eligible: false,
      reason: `activity-${activityState}`,
      queuePolicy,
    };
  }
  if (options.ignoreMaxOpenAssignments !== true && openAssignments >= maxOpenAssignments) {
    return {
      eligible: false,
      reason: "cx-saturated",
      queuePolicy,
      maxOpenAssignments,
    };
  }
  return {
    eligible: true,
    reason: "available",
    queuePolicy,
    maxOpenAssignments,
  };
}

function resolveDayZeroProgressiveStage(item = {}) {
  const queueFamily = deriveQueueFamily(item);
  if (queueFamily !== "fresh-day1") {
    return {
      progressiveStageKey: null,
      progressiveStageIndex: 99,
      progressiveStageLabel: null,
    };
  }

  const explicitActionKey = normalizeActionKey(
    item.actionKey
      || item.metadata?.actionKey
      || item.assignment?.actionKey
      || item.queueKey,
  );
  if (explicitActionKey && DAY_ZERO_PROGRESSIVE_STAGES[explicitActionKey]) {
    return DAY_ZERO_PROGRESSIVE_STAGES[explicitActionKey];
  }

  const placedCalls = Math.max(Number(item.placedCalls || 0), 0);
  const phaseIndex = Math.max(Number(item.callPlan?.phaseIndex || 0), 0);
  const journeyIndex = Math.min(Math.max(placedCalls, phaseIndex), 2);

  if (journeyIndex >= 2) return DAY_ZERO_PROGRESSIVE_STAGES["cx-day0-3"];
  if (journeyIndex >= 1) return DAY_ZERO_PROGRESSIVE_STAGES["cx-day0-2"];
  return DAY_ZERO_PROGRESSIVE_STAGES["cx-day0-1"];
}

function deriveQueueFamily(item = {}) {
  const asOf = item.now || item.asOf || new Date();
  const explicitRaw = normalizeQueueFamily(
    item.queueFamily
      || item.assignment?.queueFamilySnapshot
      || item.metadata?.queueFamily
      || "",
  );
  const fallbackFromPlan = normalizeQueueFamily(
    Number(item.callPlan?.activeDay) > 15
      ? Number(item.callPlan?.activeDay) <= 30
        ? "fresh-day16to30"
        : Number(item.callPlan?.activeDay) <= 120
          ? "aged"
          : "dead"
      : Number(item.callPlan?.activeDay) > 0
        ? Number(item.callPlan?.activeDay) <= 2
          ? "fresh-day1"
          : "fresh-day2to10"
        : "fresh-day1",
  );
  const explicit = explicitRaw !== "unassigned" ? explicitRaw : fallbackFromPlan;
  const trustedAgeFamily = deriveAgeFamilyFromCreatedAt(item, asOf, {
    includeQueueItemCreatedAt: false,
  });
  if (trustedAgeFamily && trustedAgeFamily !== explicit) return trustedAgeFamily;

  const ageFamily = deriveAgeFamilyFromCreatedAt(item, asOf);
  if (ageFamily && explicitRaw === "unassigned") return ageFamily;
  if (
    ageFamily === "fresh-day1"
    && explicit === "fresh-day2to10"
    && !isMaterializedBacklogQueueItem(item)
  ) {
    return "fresh-day1";
  }
  if (ageFamily && explicit === "fresh-day1" && ageFamily !== "fresh-day1") return ageFamily;
  if (ageFamily === "fresh-day16to30" && explicit === "fresh-day2to10") return "fresh-day16to30";
  if (ageFamily === "aged" && (explicit === "fresh-day2to10" || explicit === "fresh-day16to30")) return "aged";
  if (ageFamily === "dead" && explicit !== "dead") return "dead";
  return explicit;
}

function readLastTouchedExtensionId(item = {}) {
  return String(
    item?.metadata?.lastTouchedExtensionId ||
      item?.metadata?.lastCxDialedByExtensionId ||
      item?.payloadSnapshot?.lastCxDialedByExtensionId ||
      item?.metadata?.lastDialExecutionDialerExtensionId ||
      item?.metadata?.lastDialIntentAssignedExtensionId ||
      item?.metadata?.lastReleasedExtensionId ||
      "",
  ).trim();
}

function rankAgentsForQueueItem(agentStates = [], item = {}, options = {}) {
  const queueFamily = deriveQueueFamily(item);
  const zeroContactFresh = isZeroContactFreshQueueItem(item);
  const drainBeforeRefill =
    readBooleanEnv("RC_CX_DRAIN_BEFORE_REFILL_ENABLED", true)
    && !zeroContactFresh
    && options.ignoreDrainBeforeRefill !== true;
  const ignoreMaxOpenAssignments =
    zeroContactFresh
    && readBooleanEnv("RC_CX_ZERO_CONTACT_BYPASS_PACK_CAP_ENABLED", true);
  const today = getTodayKey();
  const familyOpenAssignmentMap = getOpenAssignmentMapForFamily(
    options.openAssignmentFamilyMaps,
    queueFamily,
  );
  const openAssignmentMap = familyOpenAssignmentMap || (options.openAssignmentMap instanceof Map
    ? options.openAssignmentMap
    : new Map());
  const ranked = agentStates.map((agentState) => {
    const queuePolicy = resolveAgentQueuePolicy(agentState);
    const assignmentStats = normalizeAssignmentStats(agentState?.cxRouting?.assignmentStats, today);
    const familyCount = familyCountForStats(assignmentStats, queueFamily);
    const totalAssigned = Number(assignmentStats.totalAssigned || 0);
    const extensionId = String(agentState?.extensionId || "").trim() || null;
    const openAssignments = Number(
      openAssignmentMap.has(extensionId)
        ? openAssignmentMap.get(extensionId)
        : options.scopedOpenAssignmentMap
          ? 0
          : assignmentStats.openAssignments
            ?? 0,
    );
    const lastAssignedAt = assignmentStats.lastAssignedAt
      ? new Date(assignmentStats.lastAssignedAt).getTime()
      : 0;
    const eligibility = buildEligibility(agentState, {
      openAssignments,
      maxOpenAssignments: options.maxOpenAssignments,
      queueFamily,
      drainBeforeRefill,
      ignoreActivityState: options.ignoreActivityState === true,
      ignoreDrainBeforeRefill: options.ignoreDrainBeforeRefill === true,
      ignoreMaxOpenAssignments,
      zeroContactFresh: zeroContactFresh,
    });
    const lastTouchedExtensionId = readLastTouchedExtensionId(item);
    const rotationEligibility =
      lastTouchedExtensionId && extensionId === lastTouchedExtensionId
        ? {
          ...eligibility,
          eligible: false,
          reason: "last-agent-called-lead",
          reasonCode: "last-agent-called-lead",
        }
        : eligibility;
    const policyTargetOpen = getQueueFamilyTargetOpen(queuePolicy, queueFamily);
    const targetFillRatio = policyTargetOpen > 0
      ? openAssignments / policyTargetOpen
      : 1;
    const targetRemaining = Math.max(policyTargetOpen - openAssignments, 0);
    const policyPriorityWeight = queueFamily === "fresh-day1"
      ? Number(queuePolicy.fresh?.priorityWeight || 0)
      : 0;
    return {
      agentState,
      extensionId,
      name: agentState?.name || null,
      queueFamily,
      queuePolicy,
      policyTargetOpen,
      policyPriorityWeight,
      targetFillRatio,
      targetRemaining,
      assignmentStats,
      familyCount,
      totalAssigned,
      openAssignments,
      lastAssignedAt,
      eligibility: rotationEligibility,
    };
  });

  ranked.sort((left, right) => {
    if (left.eligibility.eligible !== right.eligibility.eligible) {
      return left.eligibility.eligible ? -1 : 1;
    }
    if (queueFamily === "fresh-day1" && left.policyPriorityWeight !== right.policyPriorityWeight) {
      return right.policyPriorityWeight - left.policyPriorityWeight;
    }
    if (left.targetFillRatio !== right.targetFillRatio) {
      return left.targetFillRatio - right.targetFillRatio;
    }
    if (left.targetRemaining !== right.targetRemaining) {
      return right.targetRemaining - left.targetRemaining;
    }
    if (left.openAssignments !== right.openAssignments) {
      return left.openAssignments - right.openAssignments;
    }
    if (left.familyCount !== right.familyCount) {
      return left.familyCount - right.familyCount;
    }
    if (left.totalAssigned !== right.totalAssigned) {
      return left.totalAssigned - right.totalAssigned;
    }
    if (left.lastAssignedAt !== right.lastAssignedAt) {
      return left.lastAssignedAt - right.lastAssignedAt;
    }
    return String(left.name || left.extensionId || "").localeCompare(String(right.name || right.extensionId || ""));
  });

  return {
    queueFamily,
    ranked,
    selected: ranked.find((entry) => entry.eligibility.eligible) || null,
  };
}

async function enrichAgentStatesWithQueuePolicies(agentStates = []) {
  const rows = Array.isArray(agentStates) ? agentStates.filter(Boolean) : [];
  const enriched = await Promise.all(
    rows.map(async (agentState) => {
      const extensionId = String(agentState?.extensionId || "").trim();
      const userAccount = extensionId
        ? await userAccountRepository.findUserAccountByExtensionId(extensionId).catch(() => null)
        : null;
      const explicitAgentPolicy =
        agentState?.cxQueuePolicy && typeof agentState.cxQueuePolicy === "object"
          ? agentState.cxQueuePolicy
          : null;
      const queuePolicy = resolveAccountQueuePolicy({
        role: userAccount?.role || agentState?.accountRole || null,
        audience: userAccount?.audience || agentState?.accountAudience || null,
        status: userAccount?.status || agentState?.accountStatus || "active",
        cxQueuePolicy: explicitAgentPolicy || userAccount?.cxQueuePolicy || null,
      });
      return {
        ...agentState,
        email: agentState.email || userAccount?.email || null,
        userEmail: agentState.userEmail || userAccount?.email || null,
        accountEmail: agentState.accountEmail || userAccount?.email || null,
        userAccount: userAccount
          ? {
            id: userAccount.id || null,
            email: userAccount.email || null,
            name: userAccount.name || null,
            role: userAccount.role || null,
            audience: userAccount.audience || null,
            status: userAccount.status || null,
          }
          : null,
        cxQueuePolicy: queuePolicy,
        cxQueuePolicyExplicit: Boolean(
          agentState?.cxQueuePolicyExplicit
          || hasManualQueuePolicy(explicitAgentPolicy)
          || hasManualQueuePolicy(userAccount?.cxQueuePolicy),
        ),
      };
    }),
  );
  return enriched;
}

async function listEligibleAgentsForCx(domain = null, candidateExtensionIds = []) {
  const normalizedCandidateIds = Array.from(
    new Set(
      (Array.isArray(candidateExtensionIds) ? candidateExtensionIds : [])
        .map((value) => String(value || "").trim())
        .filter(Boolean),
    ),
  );

  if (normalizedCandidateIds.length > 0) {
    const docs = await Promise.all(
      normalizedCandidateIds.map((extensionId) => agentStateRepository.findAgentStateByExtensionId(extensionId)),
    );
    return enrichAgentStatesWithQueuePolicies(docs.filter(Boolean));
  }

  const docs = await agentStateRepository.listAgentStates({ routingEnabled: true });
  return enrichAgentStatesWithQueuePolicies(docs);
}

function buildNextAssignmentStats(existingStats = null, queueFamily) {
  const normalizedFamily = normalizeQueueFamily(queueFamily);
  const next = normalizeAssignmentStats(existingStats, getTodayKey());
  next.totalAssigned += 1;
  if (normalizedFamily === "fresh-day1") next.freshDay1Assigned += 1;
  if (normalizedFamily === "fresh-day2to10") next.freshDay2to10Assigned += 1;
  if (normalizedFamily === "fresh-day16to30") next.freshDay16to30Assigned += 1;
  if (normalizedFamily === "aged") next.agedAssigned += 1;
  next.openAssignments = Math.max(Number(next.openAssignments || 0) + 1, 0);
  next.lastAssignedAt = new Date();
  next.lastAssignedQueueFamily = normalizedFamily;
  return next;
}

function buildReleasedAssignmentStats(existingStats = null) {
  const next = normalizeAssignmentStats(existingStats, getTodayKey());
  next.openAssignments = Math.max(Number(next.openAssignments || 0) - 1, 0);
  return next;
}

module.exports = {
  buildEligibility,
  buildNextAssignmentStats,
  buildReleasedAssignmentStats,
  DEFAULT_MAX_OPEN_ASSIGNMENTS,
  deriveQueueFamily,
  enrichAgentStatesWithQueuePolicies,
  getQueueFamilyPolicy,
  getQueueFamilySortRank,
  listEligibleAgentsForCx,
  normalizeAssignmentStats,
  normalizeQueueFamily,
  rankAgentsForQueueItem,
  resolveAgentQueuePolicy,
  resolveDayZeroProgressiveStage,
};
