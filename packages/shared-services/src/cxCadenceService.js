"use strict";

const {
  EVENT_STATUS,
  createEvent,
  markCompleted,
  markFailed,
  processNextEvent,
} = require("../../event-core/src");
const { env } = require("../../shared-config/src");
const { CxDialQueue, LeadCadence, MasterProspectIndex } = require("../../shared-models/src");
const {
  agentStateRepository,
  callLogRepository,
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
  deriveQueueFamilyFromLeadCreatedAt,
  deriveQueueFamilyFromLeadTouchState,
  getCooldownReleaseAt,
  getQueueDailyDateKey,
  getPacificDateKey,
  getPacificMonthKey,
  getQueueFamilyPolicy,
  getTouchAgeFreshWindowDays,
  resolveQueueDialability,
  resolveQueueDialTimeWindow,
} = require("./cxQueuePolicyService");
const { resolveCaseContactEligibility, stopCaseContact } = require("./contactEligibilityService");
const { evaluateCxClear } = require("./cxCallStateGuard");
const { cancelPublishedQueueItemInRingcx } = require("./ringcxLeadServingService");
const {
  observeCxBucketTerminalOutcome,
} = require("./cxDialQueueMediatorService");
const {
  buildCxCallLifecyclePatch,
  isCxCanonicalCallWriteEnabled,
  writeCxCallLifecycleShadowState,
} = require("./cxCallLifecycleService");
const { syncCallLedgerFromCallLog } = require("./callLedgerService");
const {
  applyCallEndedDailyStats,
  applyCallStartedDailyStats,
  getPauseReleaseDelayMs,
  isCxWorkspacePresenceActive,
  normalizeCxPauseType,
  normalizeDailyStats,
} = require("./agentAvailabilityService");
const { recordWorkflowStage } = require("./workflowStateService");
const { invalidateAgentCallStatsSnapshot } = require("./agentCallStatsService");

const CX_CADENCE_EVENT_TYPES = Object.freeze({
  DIAL_REQUESTED: "cx.dial.requested",
  CALL_PLACED: "cx.call.placed",
  CALL_TERMINAL_OUTCOME: "cx.call.terminal-outcome",
});

const cxQueueOrderingBackfillMemo = new Map();

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

function parseBooleanFlag(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

function shouldStageDispatchIntentAsServing(options = {}, status = "") {
  if (options.markServing === true) return true;
  if (options.markServing === false) return false;
  const enabled = parseBooleanFlag(process.env.CX_DISPATCH_STAGE_AS_SERVING, true);
  if (!enabled) return false;
  return status === "serving" || status === "staged";
}

function buildSyntheticCxSessionId(queueItemId, placedAt = new Date()) {
  const id = normalizeExternalId(queueItemId);
  if (!id) return null;
  const date = placedAt instanceof Date ? placedAt : new Date(placedAt);
  const stamp = Number.isNaN(date.getTime()) ? Date.now() : date.getTime();
  return `cx-synth:${id}:${stamp}`;
}

function ringcxSessionDateKey(value) {
  const match = String(value || "").trim().match(/^(\d{4})(\d{2})(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

function isMetadataSessionIdCompatible(value, placedAt = new Date()) {
  const sessionDateKey = ringcxSessionDateKey(value);
  if (!sessionDateKey) return Boolean(normalizeExternalId(value));
  const date = placedAt instanceof Date ? placedAt : new Date(placedAt);
  if (Number.isNaN(date.getTime())) return false;
  return sessionDateKey === getPacificDateKey(date);
}

function resolveCxPlacedSessionId(payload = {}, queueItem = {}, placedAt = new Date()) {
  const explicit = normalizeExternalId(
    payload.uii ||
      payload.telephonySessionId ||
      payload.callSessionId ||
      payload.sessionId ||
      payload.dialogId ||
      payload.interactionId,
  );
  if (explicit) return explicit;

  const metadataSessionId = normalizeExternalId(queueItem?.metadata?.lastDialExecutionUii);
  if (metadataSessionId && isMetadataSessionIdCompatible(metadataSessionId, placedAt)) {
    return metadataSessionId;
  }

  return buildSyntheticCxSessionId(queueItem?._id, placedAt);
}

function normalizeOutcomeToken(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function collectOutcomeCandidates(payload = {}) {
  const output = [];
  const push = (value) => {
    const normalized = String(value || "").trim();
    if (normalized) output.push(normalized);
  };
  push(payload.outcome);
  push(payload.disposition);
  push(payload.result);
  push(payload.callResult);
  push(payload.callOutcome);
  push(payload.status);
  push(payload.reason);
  for (const nested of [
    payload.details,
    payload.data,
    payload.record,
    payload.call,
    payload.raw,
  ]) {
    if (!nested || typeof nested !== "object") continue;
    push(nested.outcome);
    push(nested.disposition);
    push(nested.result);
    push(nested.callResult);
    push(nested.callOutcome);
    push(nested.status);
    push(nested.reason);
  }
  return output;
}

function classifyCxTerminalOutcome(payload = {}) {
  const candidates = collectOutcomeCandidates(payload);
  const trustedManualSource = String(payload.sourceService || "").trim().toLowerCase() === "cx-bulk-load";
  for (const candidate of candidates) {
    const token = normalizeOutcomeToken(candidate);
    if (!token) continue;
    const compact = token.replace(/_/g, "");

    if (trustedManualSource && (
      token === "answered"
      || token === "answer"
      || token === "connected"
      || compact === "answered"
    )) {
      return {
        safeToAdvance: true,
        normalizedOutcome: "answered",
        matchedValue: candidate,
      };
    }

    if (trustedManualSource && (
      token === "dnc"
      || token === "do_not_call"
      || token === "donotcall"
      || token === "do-not-call"
      || compact === "donotcall"
    )) {
      return {
        safeToAdvance: true,
        normalizedOutcome: "dnc",
        matchedValue: candidate,
      };
    }

    // "No voicemail box" is a failed drop-style signal, not a confirmed
    // RingCX voicemail outcome. Keep it out of the fast-skip lane.
    if (compact.includes("novoicemail")) continue;

    if (
      token === "voicemail"
      || token === "voice_mail"
      || token === "left_message"
      || token === "left_voicemail"
      || token === "answering_machine"
      || token === "machine_detected"
      || token === "voicemail_detected"
      || compact === "leftmessage"
      || compact === "leftvoicemail"
      || compact === "answeringmachine"
      || compact === "voicemaildetected"
    ) {
      return {
        safeToAdvance: true,
        normalizedOutcome: "voicemail",
        matchedValue: candidate,
      };
    }

    if (
      token === "no_answer"
      || token === "did_not_connect"
      || token === "didnt_connect"
      || token === "no_connect"
      || token === "not_connected"
      || token === "not_answered"
      || compact === "noanswer"
      || compact === "didnotconnect"
      || compact === "didntconnect"
      || compact === "noconnect"
      || compact === "notconnected"
      || compact === "notanswered"
    ) {
      return {
        safeToAdvance: true,
        normalizedOutcome: "did_not_connect",
        matchedValue: candidate,
      };
    }
  }

  return {
    safeToAdvance: false,
    normalizedOutcome: null,
    matchedValue: null,
  };
}

function buildTerminalAttemptProofPatch(queueItem = {}, payload = {}, outcomeAt = new Date(), terminalMetadata = {}) {
  const terminalSource = String(payload.sourceService || payload.source || "").trim().toLowerCase();
  const terminalUii = normalizeExternalId(
    terminalMetadata.lastTerminalOutcomeUii ||
      payload.uii ||
      payload.callSessionId,
  );
  if (terminalSource !== "cx-bulk-load" || !terminalUii) {
    return {
      countable: false,
      terminalUii: terminalUii || null,
      queuePatch: {},
    };
  }
  return {
    countable: true,
    terminalUii,
    queuePatch: buildCallAttemptPatch(queueItem, outcomeAt),
  };
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
        : normalizedFamily === "fresh-day16to30"
          ? normalizeExternalId(env("RINGCX_VOICE_YELLOW_CAMPAIGN_ID", ""))
            || normalizeExternalId(env("RINGCX_VOICE_OLD_CAMPAIGN_ID", ""))
            || null
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
    delaysMinutes: [0, 90, 90, 90, 90, 90, 90, 90],
    activeDay: 0,
    nextDelayMinutes: 0,
  };
}

function getFreshMinimumDailyTouches() {
  const configured = Number(
    process.env.RC_CX_GREEN_MIN_DAILY_TOUCHES
      || process.env.RC_CX_FRESH_MIN_DAILY_TOUCHES,
  );
  if (Number.isFinite(configured) && configured > 0) return Math.trunc(configured);
  const dailyMax = Number(getQueueFamilyPolicy("fresh-day1").dailyMax);
  return Number.isFinite(dailyMax) && dailyMax > 0 ? Math.trunc(dailyMax) : 5;
}

function getFreshRetryDelayMinutes() {
  const configured = Number(
    process.env.RC_CX_GREEN_RETRY_DELAY_MINUTES
      || process.env.RC_CX_FRESH_RETRY_DELAY_MINUTES,
  );
  if (Number.isFinite(configured) && configured >= 0) return Math.trunc(configured);
  return 90;
}

function normalizeCallPlanForQueueFamily(callPlan = null, queueFamily = null) {
  const base = callPlan && typeof callPlan === "object"
    ? {
      phaseIndex: Number.isFinite(Number(callPlan.phaseIndex)) ? Number(callPlan.phaseIndex) : 0,
      delaysMinutes: Array.isArray(callPlan.delaysMinutes)
        ? callPlan.delaysMinutes.map((value) => Number(value)).filter((value) => Number.isFinite(value) && value >= 0)
        : [],
      activeDay: Number.isFinite(Number(callPlan.activeDay)) ? Number(callPlan.activeDay) : 0,
      nextDelayMinutes:
        callPlan.nextDelayMinutes == null
          ? null
          : Number.isFinite(Number(callPlan.nextDelayMinutes))
            ? Number(callPlan.nextDelayMinutes)
            : null,
    }
    : buildInitialCallPlan();

  if (normalizeQueueFamily(queueFamily) !== "fresh-day1") return base;

  const minimumTouches = getFreshMinimumDailyTouches();
  const retryDelay = getFreshRetryDelayMinutes();
  const delays = [...base.delaysMinutes];
  while (delays.length < minimumTouches) {
    delays.push(retryDelay);
  }
  if (!delays.length) delays.push(0);
  delays[0] = Number.isFinite(Number(delays[0])) ? Number(delays[0]) : 0;
  return {
    ...base,
    delaysMinutes: delays,
    activeDay: 0,
    nextDelayMinutes: base.nextDelayMinutes == null ? 0 : base.nextDelayMinutes,
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

function isImmediateSmsHotIntentPayload(payload = {}) {
  const metadata = payload?.metadata && typeof payload.metadata === "object" ? payload.metadata : {};
  return (
    String(payload.priorityLane || "").trim().toLowerCase() === "sms-hot-intent"
    || String(payload.intakeRoute || "").trim().toLowerCase() === "sms-hot-intent-now"
    || String(metadata.smsCallbackUrgency || "").trim().toLowerCase() === "immediate-hot"
  );
}

function computePriorityScore(payload = {}) {
  const explicit = Number(payload.priorityScore ?? payload.metadata?.priorityScore);
  if (Number.isFinite(explicit)) return explicit;
  if (isImmediateSmsHotIntentPayload(payload)) return 500;
  const source = String(payload.intakeSource || payload.sourceName || "").toLowerCase();
  if (source.includes("sms-hot-intent")) return 350;
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
  const createdAtFamily = deriveQueueFamilyFromLeadCreatedAt(
    payload.leadCreatedAt
      || payload.createdAt
      || payload.payloadSnapshot?.createdAt
      || payload.metadata?.leadCreatedAt
      || null,
    payload.now || new Date(),
    {
      placedCalls:
        payload.placedCalls
        ?? payload.metadata?.placedCalls
        ?? payload.payloadSnapshot?.placedCalls
        ?? payload.payloadSnapshot?.metadata?.placedCalls
        ?? 0,
    },
  );
  if (createdAtFamily) return createdAtFamily;

  const leadAgeDays = Number(payload.leadAgeDays);
  if (Number.isFinite(leadAgeDays)) {
    return deriveQueueFamilyFromLeadTouchState({
      ageDays: leadAgeDays,
      asOf: payload.now || new Date(),
      placedCalls:
        payload.placedCalls
        ?? payload.metadata?.placedCalls
        ?? payload.payloadSnapshot?.placedCalls
        ?? payload.payloadSnapshot?.metadata?.placedCalls
        ?? 0,
    }) || deriveQueueFamilyFromAgeDays(leadAgeDays);
  }

  const queueTier = String(payload.queueTier || "").trim().toLowerCase();
  if (queueTier === "later") return "fresh-day2to10";
  if (queueTier === "yellow" || queueTier === "day16to30") return "fresh-day16to30";
  if (queueTier === "dead") return "dead";
  if (queueTier === "day1" || queueTier === "day0") return "fresh-day1";

  const activeDay = Number(
    payload.queueDayIndex
      ?? payload.callPlan?.activeDay
      ?? payload.activeDay
      ?? 0,
  );
  if (Number.isFinite(activeDay)) {
    if (activeDay > 120) return "dead";
    if (activeDay > 30) return "aged";
    if (activeDay > 15) return "fresh-day16to30";
    if (activeDay > 2) return "fresh-day2to10";
    return "fresh-day1";
  }

  const source = String(payload.intakeSource || payload.sourceName || "").toLowerCase();
  if (source.includes("dead")) return "dead";
  if (source.includes("yellow") || source.includes("16to30") || source.includes("16-30")) return "fresh-day16to30";
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
  const normalizedPlacedCalls = Math.max(
    Number(
      placedCalls
        ?? payload.placedCalls
        ?? 0,
    ) || 0,
    0,
  );
  const seedFamily = normalizeQueueFamily(
    queueFamily || resolveQueueFamilyForPayload({
      ...payload,
      callPlan: callPlan || payload.callPlan,
    }),
  );
  const normalizedFamily = deriveQueueFamily({
    ...payload,
    queueFamily: seedFamily,
    callPlan: callPlan || payload.callPlan || null,
    placedCalls: normalizedPlacedCalls,
  });
  const stage = resolveDayZeroProgressiveStage({
    ...payload,
    queueFamily: normalizedFamily,
    callPlan: callPlan || payload.callPlan || null,
    placedCalls: normalizedPlacedCalls,
    actionKey: payload.actionKey || payload.metadata?.actionKey || null,
  });

  if (normalizedFamily === "fresh-day1" && isImmediateSmsHotIntentPayload(payload)) {
    return {
      queueFamily: normalizedFamily,
      queueFamilyRank: -1,
      progressiveStageKey: "sms-hot-intent",
      progressiveStageIndex: -1,
      progressiveStageLabel: "SMS hot intent",
      metadata: {
        queueFamily: normalizedFamily,
        queueFamilyRank: -1,
        progressiveStageKey: "sms-hot-intent",
        progressiveStageIndex: -1,
        progressiveStageLabel: "SMS hot intent",
        smsCallbackUrgency: "immediate-hot",
      },
    };
  }

  const activeDay = Number((callPlan || payload.callPlan || {})?.activeDay);
  const familyStage =
    normalizedFamily === "fresh-day2to10"
      ? {
          progressiveStageKey: "day2to15",
          progressiveStageIndex: Number.isFinite(activeDay) ? activeDay : 3,
          progressiveStageLabel: "3-15",
        }
      : normalizedFamily === "fresh-day16to30"
        ? {
            progressiveStageKey: "day16to30",
            progressiveStageIndex: Number.isFinite(activeDay) ? activeDay : 16,
            progressiveStageLabel: "16-30",
          }
        : normalizedFamily === "aged"
          ? {
              progressiveStageKey: "aged-cadence",
              progressiveStageIndex: 99,
              progressiveStageLabel: "31-120",
            }
          : normalizedFamily === "dead"
            ? {
                progressiveStageKey: "dead",
                progressiveStageIndex: 999,
                progressiveStageLabel: "Dead",
              }
            : stage;
  const progressiveStageKey = stage.progressiveStageKey || familyStage.progressiveStageKey;
  const progressiveStageIndex = stage.progressiveStageKey ? stage.progressiveStageIndex : familyStage.progressiveStageIndex;
  const progressiveStageLabel = stage.progressiveStageLabel || familyStage.progressiveStageLabel;

  return {
    queueFamily: normalizedFamily,
    queueFamilyRank: getQueueFamilySortRank(normalizedFamily),
    progressiveStageKey,
    progressiveStageIndex,
    progressiveStageLabel,
    metadata: {
      queueFamily: normalizedFamily,
      queueFamilyRank: getQueueFamilySortRank(normalizedFamily),
      progressiveStageKey,
      progressiveStageIndex,
      progressiveStageLabel,
    },
  };
}

function parseRequestedReleaseAt(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function readLeadStateForQueue(payload = {}) {
  return (
    payload.leadState ||
    payload.state ||
    payload.contactState ||
    payload.metadata?.leadState ||
    payload.metadata?.contactState ||
    payload.metadata?.state ||
    payload.payloadSnapshot?.state ||
    payload.attributionContext?.state ||
    null
  );
}

function readLeadTimeZoneForQueue(payload = {}) {
  return (
    payload.leadTimeZone ||
    payload.leadTimezone ||
    payload.timeZone ||
    payload.timezone ||
    payload.metadata?.leadTimeZone ||
    payload.metadata?.leadTimezone ||
    payload.metadata?.timeZone ||
    payload.metadata?.timezone ||
    payload.cadenceState?.timezone ||
    payload.payloadSnapshot?.timeZone ||
    payload.payloadSnapshot?.timezone ||
    null
  );
}

function buildQueueTimingPayload(domain, payload = {}) {
  const leadState = readLeadStateForQueue(payload);
  const leadTimeZone = readLeadTimeZoneForQueue(payload);
  return {
    ...payload,
    domain,
    metadata: {
      ...(payload.metadata || {}),
      ...(leadState ? { leadState } : {}),
      ...(leadTimeZone ? { leadTimeZone } : {}),
    },
  };
}

function resolveRequestedReleaseTiming(domain, requestedReleaseAt = null, payload = {}) {
  const now = new Date();
  const target = requestedReleaseAt || now;
  const timing = resolveQueueDialTimeWindow(buildQueueTimingPayload(domain, payload), target);
  const releaseAt = timing.nextAllowedAt || target;
  return {
    timing,
    releaseAt,
    state: releaseAt.getTime() <= now.getTime() + 1000 ? "ready" : "queued",
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

function buildDailyAgentTouchMetadata(queueItem = {}, placedAt = new Date()) {
  const extensionId = String(queueItem?.assignment?.extensionId || "").trim();
  if (!extensionId) return {};
  const metadata = queueItem?.metadata && typeof queueItem.metadata === "object"
    ? queueItem.metadata
    : {};
  const dateKey = getPacificDateKey(placedAt);
  const priorDateKey = String(metadata.dailyAgentTouchDateKey || "").trim();
  const priorTouched = priorDateKey === dateKey && Array.isArray(metadata.dailyAgentTouchedExtensionIds)
    ? metadata.dailyAgentTouchedExtensionIds
    : [];
  const nextTouched = Array.from(
    new Set(
      [
        ...priorTouched,
        extensionId,
      ]
        .map((value) => String(value || "").trim())
        .filter(Boolean),
    ),
  );
  return {
    dailyAgentTouchDateKey: dateKey,
    dailyAgentTouchedExtensionIds: nextTouched,
    lastTouchedExtensionId: extensionId,
    lastTouchedAgentName: queueItem?.assignment?.agentName || null,
    lastTouchedAt: placedAt,
  };
}

function resolveCxTouchIdentity(queueItem = {}, payload = {}) {
  const metadata = queueItem?.metadata && typeof queueItem.metadata === "object"
    ? queueItem.metadata
    : {};
  const extensionId = String(
    queueItem?.assignment?.extensionId ||
      metadata.assignedExtensionId ||
      metadata.lastDialIntentAssignedExtensionId ||
      payload.assignedExtensionId ||
      payload.extensionId ||
      "",
  ).trim();
  const agentName = String(
    queueItem?.assignment?.agentName ||
      metadata.assignedAgentName ||
      payload.agentName ||
      "",
  ).trim();
  const agentEmail = String(
    payload.agentEmail ||
      metadata.rcxVisibilityAgentUsername ||
      metadata.lastDialExecutionAgentEmail ||
      "",
  ).trim();

  return {
    extensionId: extensionId || null,
    agentName: agentName || null,
    agentEmail: agentEmail || null,
  };
}

async function markLeadCxTouchState({
  domain,
  caseId,
  queueItem = {},
  payload = {},
  placedAt = new Date(),
  confirmedCall = false,
} = {}) {
  if (!confirmedCall) return { skipped: true, reason: "unconfirmed-call" };
  const normalizedDomain = normalizeDomain(domain || queueItem?.domain);
  const numericCaseId = Number(caseId ?? queueItem?.caseId);
  if (!normalizedDomain || !Number.isFinite(numericCaseId)) {
    return { skipped: true, reason: "missing-case" };
  }

  const safePlacedAt = placedAt instanceof Date && !Number.isNaN(placedAt.getTime())
    ? placedAt
    : new Date();
  const identity = resolveCxTouchIdentity(queueItem, payload);
  const dateKey = getPacificDateKey(safePlacedAt);
  const monthKey = getPacificMonthKey(safePlacedAt);
  const [existing, existingProspect] = await Promise.all([
    LeadCadence.findOne(
      { domain: normalizedDomain, caseId: numericCaseId },
      {
        "counterCadence.cxDailyDateKey": 1,
        "counterCadence.cxDailyCalls": 1,
        "counterCadence.cxMonthlyMonthKey": 1,
        "counterCadence.cxMonthlyCalls": 1,
      },
    ).lean().catch(() => null),
    MasterProspectIndex.findOne(
      { domain: normalizedDomain, caseId: numericCaseId },
      {
        "filler.dailyDateKey": 1,
        "filler.dailyAttempts": 1,
        "filler.monthlyMonthKey": 1,
        "filler.monthlyAttempts": 1,
      },
    ).lean().catch(() => null),
  ]);

  const priorDailyKey = String(existing?.counterCadence?.cxDailyDateKey || "").trim();
  const priorMonthlyKey = String(existing?.counterCadence?.cxMonthlyMonthKey || "").trim();
  const nextDailyCalls = priorDailyKey === dateKey
    ? Math.max(Number(existing?.counterCadence?.cxDailyCalls || 0) || 0, 0) + 1
    : 1;
  const nextMonthlyCalls = priorMonthlyKey === monthKey
    ? Math.max(Number(existing?.counterCadence?.cxMonthlyCalls || 0) || 0, 0) + 1
    : 1;
  const priorProspectDailyKey = String(existingProspect?.filler?.dailyDateKey || "").trim();
  const priorProspectMonthlyKey = String(existingProspect?.filler?.monthlyMonthKey || "").trim();
  const nextProspectDailyCalls = priorProspectDailyKey === dateKey
    ? Math.max(Number(existingProspect?.filler?.dailyAttempts || 0) || 0, 0) + 1
    : 1;
  const nextProspectMonthlyCalls = priorProspectMonthlyKey === monthKey
    ? Math.max(Number(existingProspect?.filler?.monthlyAttempts || 0) || 0, 0) + 1
    : 1;
  const queueFamily = normalizeQueueFamily(queueItem?.queueFamily || queueItem?.metadata?.queueFamily || "");
  const queueItemId = queueItem?._id ? String(queueItem._id) : null;

  const cadenceUpdate = await LeadCadence.findOneAndUpdate(
    { domain: normalizedDomain, caseId: numericCaseId },
    {
      $set: {
        "lastTouched.cx": safePlacedAt,
        "counterCadence.lastCxDialedAt": safePlacedAt,
        "counterCadence.lastCxDialedByExtensionId": identity.extensionId,
        "counterCadence.lastCxDialedByAgentName": identity.agentName,
        "counterCadence.lastCxDialedByAgentEmail": identity.agentEmail,
        "counterCadence.lastCxQueueFamily": queueFamily,
        "counterCadence.lastCxQueueItemId": queueItemId,
        "counterCadence.cxDailyDateKey": dateKey,
        "counterCadence.cxDailyCalls": nextDailyCalls,
        "counterCadence.cxMonthlyMonthKey": monthKey,
        "counterCadence.cxMonthlyCalls": nextMonthlyCalls,
        "payloadSnapshot.lastCxDialedAt": safePlacedAt,
        "payloadSnapshot.lastCxDialedByExtensionId": identity.extensionId,
        "payloadSnapshot.lastCxDialedByAgentName": identity.agentName,
        "payloadSnapshot.lastCxDialedByAgentEmail": identity.agentEmail,
        "payloadSnapshot.lastCxQueueFamily": queueFamily,
        "payloadSnapshot.lastCxQueueItemId": queueItemId,
      },
      $inc: {
        "cadenceCounters.cx": 1,
      },
    },
    { new: false },
  ).catch(() => null);

  const prospectUpdate = await MasterProspectIndex.findOneAndUpdate(
    { domain: normalizedDomain, caseId: numericCaseId },
    {
      $set: {
        "filler.lastDialAttempt": safePlacedAt,
        "filler.lastAttemptResult": "cx-call-placed",
        "filler.lastDialedByExtensionId": identity.extensionId,
        "filler.lastDialedByAgentName": identity.agentName,
        "filler.dailyDateKey": dateKey,
        "filler.dailyAttempts": nextProspectDailyCalls,
        "filler.monthlyMonthKey": monthKey,
        "filler.monthlyAttempts": nextProspectMonthlyCalls,
      },
      $inc: {
        "filler.attemptCount": 1,
      },
    },
    { new: false },
  ).catch(() => null);

  return {
    ok: true,
    cadenceMatched: Boolean(cadenceUpdate),
    prospectMatched: Boolean(prospectUpdate),
    extensionId: identity.extensionId,
    dailyCalls: nextDailyCalls,
    monthlyCalls: nextMonthlyCalls,
  };
}

function latestDateValue(...values) {
  const dates = values
    .map((value) => value ? new Date(value) : null)
    .filter((date) => date && !Number.isNaN(date.getTime()));
  if (dates.length === 0) return null;
  return new Date(Math.max(...dates.map((date) => date.getTime())));
}

async function readPersistedCxTouchState(domain, caseId) {
  const normalizedDomain = normalizeDomain(domain);
  const numericCaseId = Number(caseId);
  if (!normalizedDomain || !Number.isFinite(numericCaseId)) return null;

  const [cadence, prospect] = await Promise.all([
    LeadCadence.findOne(
      { domain: normalizedDomain, caseId: numericCaseId },
      {
        state: 1,
        "cadenceCounters.cx": 1,
        "lastTouched.cx": 1,
        "counterCadence.lastCxDialedAt": 1,
        "counterCadence.lastCxDialedByExtensionId": 1,
        "counterCadence.lastCxDialedByAgentName": 1,
        "counterCadence.cxAnsweredContacts": 1,
        "counterCadence.cxNoAnswerCalls": 1,
        "counterCadence.cxDailyDateKey": 1,
        "counterCadence.cxDailyCalls": 1,
        "counterCadence.cxMonthlyMonthKey": 1,
        "counterCadence.cxMonthlyCalls": 1,
        "payloadSnapshot.lastCxDialedAt": 1,
        "payloadSnapshot.lastCxDialedByExtensionId": 1,
        "payloadSnapshot.lastCxDialedByAgentName": 1,
        "payloadSnapshot.cxAnsweredContacts": 1,
        "payloadSnapshot.cxNoAnswerCalls": 1,
        "payloadSnapshot.state": 1,
        "payloadSnapshot.timezone": 1,
        "payloadSnapshot.timeZone": 1,
      },
    ).lean().catch(() => null),
    MasterProspectIndex.findOne(
      { domain: normalizedDomain, caseId: numericCaseId },
      {
        "filler.lastDialAttempt": 1,
        "filler.attemptCount": 1,
        "filler.lastDialedByExtensionId": 1,
        "filler.lastDialedByAgentName": 1,
        "filler.answeredContacts": 1,
        "filler.noAnswerCalls": 1,
        "filler.dailyDateKey": 1,
        "filler.dailyAttempts": 1,
        "filler.monthlyMonthKey": 1,
        "filler.monthlyAttempts": 1,
        state: 1,
        timeZone: 1,
        timezone: 1,
        "payloadSnapshot.state": 1,
        "payloadSnapshot.timezone": 1,
        "payloadSnapshot.timeZone": 1,
      },
    ).lean().catch(() => null),
  ]);

  const cadenceTouchAt = latestDateValue(
    cadence?.lastTouched?.cx,
    cadence?.counterCadence?.lastCxDialedAt,
    cadence?.payloadSnapshot?.lastCxDialedAt,
  );
  const prospectTouchAt = latestDateValue(prospect?.filler?.lastDialAttempt);
  const useProspect =
    prospectTouchAt &&
    (!cadenceTouchAt || prospectTouchAt.getTime() > cadenceTouchAt.getTime());
  const source = useProspect ? prospect?.filler || {} : null;
  const counter = !useProspect ? cadence?.counterCadence || {} : {};
  const payload = !useProspect ? cadence?.payloadSnapshot || {} : {};
  const touchedAt = useProspect ? prospectTouchAt : cadenceTouchAt;
  if (!touchedAt) return null;

  return {
    touchedAt,
    totalCalls: useProspect
      ? Math.max(Number(source.attemptCount || 0) || 0, 0)
      : Math.max(Number(cadence?.cadenceCounters?.cx || 0) || 0, 0),
    answeredContacts: useProspect
      ? Math.max(Number(source.answeredContacts || 0) || 0, 0)
      : Math.max(Number(counter.cxAnsweredContacts || payload.cxAnsweredContacts || 0) || 0, 0),
    noAnswerCalls: useProspect
      ? Math.max(Number(source.noAnswerCalls || 0) || 0, 0)
      : Math.max(Number(counter.cxNoAnswerCalls || payload.cxNoAnswerCalls || 0) || 0, 0),
    extensionId: String(
      useProspect
        ? source.lastDialedByExtensionId || ""
        : counter.lastCxDialedByExtensionId || payload.lastCxDialedByExtensionId || "",
    ).trim() || null,
    agentName: useProspect
      ? source.lastDialedByAgentName || null
      : counter.lastCxDialedByAgentName || payload.lastCxDialedByAgentName || null,
    dailyDateKey: String(useProspect ? source.dailyDateKey || "" : counter.cxDailyDateKey || "").trim() || null,
    dailyCalls: Math.max(Number(useProspect ? source.dailyAttempts || 0 : counter.cxDailyCalls || 0) || 0, 0),
    monthlyMonthKey: String(useProspect ? source.monthlyMonthKey || "" : counter.cxMonthlyMonthKey || "").trim() || null,
    monthlyCalls: Math.max(Number(useProspect ? source.monthlyAttempts || 0 : counter.cxMonthlyCalls || 0) || 0, 0),
    leadState: (
      cadence?.state ||
      cadence?.payloadSnapshot?.state ||
      prospect?.state ||
      prospect?.payloadSnapshot?.state ||
      null
    ),
    leadTimeZone: (
      cadence?.payloadSnapshot?.timezone ||
      cadence?.payloadSnapshot?.timeZone ||
      prospect?.timeZone ||
      prospect?.timezone ||
      prospect?.payloadSnapshot?.timezone ||
      prospect?.payloadSnapshot?.timeZone ||
      null
    ),
  };
}

function buildHydratedCxTouchPatch(item = {}, persisted = null, now = new Date()) {
  if (!persisted?.touchedAt) return null;
  const leadState = persisted.leadState || item.metadata?.leadState || null;
  const leadTimeZone = persisted.leadTimeZone || item.metadata?.leadTimeZone || null;
  const timingItem = {
    ...item,
    metadata: {
      ...(item.metadata || {}),
      ...(leadState ? { leadState } : {}),
      ...(leadTimeZone ? { leadTimeZone } : {}),
    },
  };
  const dateKey = getQueueDailyDateKey(timingItem, now);
  const pacificDateKey = getPacificDateKey(now);
  const monthKey = getPacificMonthKey(now);
  const itemLastPlacedAt = latestDateValue(item.lastPlacedAt, item.metadata?.lastQueueAttemptAt);
  const nextLastPlacedAt =
    !itemLastPlacedAt || persisted.touchedAt.getTime() > itemLastPlacedAt.getTime()
      ? persisted.touchedAt
      : itemLastPlacedAt;
  const itemDailyCalls =
    [dateKey, pacificDateKey].includes(String(item.dailyPlacedDateKey || item.metadata?.dailyPlacedDateKey || "").trim())
      ? Math.max(Number(item.dailyPlacedCalls ?? item.metadata?.dailyPlacedCalls ?? 0) || 0, 0)
      : 0;
  const persistedDailyCalls = [dateKey, pacificDateKey].includes(persisted.dailyDateKey) ? persisted.dailyCalls : 0;
  const itemMonthlyCalls =
    String(item.monthlyPlacedMonthKey || item.metadata?.monthlyPlacedMonthKey || "").trim() === monthKey
      ? Math.max(Number(item.monthlyPlacedCalls ?? item.metadata?.monthlyPlacedCalls ?? 0) || 0, 0)
      : 0;
  const persistedMonthlyCalls = persisted.monthlyMonthKey === monthKey ? persisted.monthlyCalls : 0;

  return {
    placedCalls: Math.max(Number(item.placedCalls || 0) || 0, Number(persisted.totalCalls || 0) || 0),
    lastPlacedAt: nextLastPlacedAt,
    dailyPlacedDateKey: dateKey,
    dailyPlacedCalls: Math.max(itemDailyCalls, persistedDailyCalls),
    monthlyPlacedMonthKey: monthKey,
    monthlyPlacedCalls: Math.max(itemMonthlyCalls, persistedMonthlyCalls),
    "metadata.lastQueueAttemptAt": nextLastPlacedAt,
    "metadata.lastTouchedAt": nextLastPlacedAt,
    "metadata.lastTouchedExtensionId": persisted.extensionId || item.metadata?.lastTouchedExtensionId || null,
    "metadata.lastTouchedAgentName": persisted.agentName || item.metadata?.lastTouchedAgentName || null,
    "metadata.lastCxDialedByExtensionId": persisted.extensionId || item.metadata?.lastCxDialedByExtensionId || null,
    "metadata.lastCxDialedByAgentName": persisted.agentName || item.metadata?.lastCxDialedByAgentName || null,
    "metadata.answeredContacts": Math.max(
      Number(item.metadata?.answeredContacts || item.metadata?.cxAnsweredContacts || 0) || 0,
      Number(persisted.answeredContacts || 0) || 0,
    ),
    "metadata.cxAnsweredContacts": Math.max(
      Number(item.metadata?.answeredContacts || item.metadata?.cxAnsweredContacts || 0) || 0,
      Number(persisted.answeredContacts || 0) || 0,
    ),
    "metadata.unansweredCalls": Math.max(
      Number(item.metadata?.unansweredCalls || item.metadata?.noAnswerCalls || item.metadata?.cxNoAnswerCalls || 0) || 0,
      Number(persisted.noAnswerCalls || 0) || 0,
    ),
    "metadata.noAnswerCalls": Math.max(
      Number(item.metadata?.unansweredCalls || item.metadata?.noAnswerCalls || item.metadata?.cxNoAnswerCalls || 0) || 0,
      Number(persisted.noAnswerCalls || 0) || 0,
    ),
    "metadata.cxNoAnswerCalls": Math.max(
      Number(item.metadata?.unansweredCalls || item.metadata?.noAnswerCalls || item.metadata?.cxNoAnswerCalls || 0) || 0,
      Number(persisted.noAnswerCalls || 0) || 0,
    ),
    "metadata.dailyPlacedDateKey": dateKey,
    "metadata.dailyPlacedCalls": Math.max(itemDailyCalls, persistedDailyCalls),
    "metadata.dailyPlacedTimezone": leadTimeZone || item.metadata?.dailyPlacedTimezone || null,
    "metadata.monthlyPlacedMonthKey": monthKey,
    "metadata.monthlyPlacedCalls": Math.max(itemMonthlyCalls, persistedMonthlyCalls),
    "metadata.leadState": leadState,
    "metadata.leadTimeZone": leadTimeZone,
  };
}

async function hydrateClaimedQueueItemCxTouchState(item = {}) {
  if (!item?._id) return item;
  const persisted = await readPersistedCxTouchState(item.domain, item.caseId).catch(() => null);
  const patch = buildHydratedCxTouchPatch(item, persisted);
  if (!patch) return item;
  await cxDialQueueRepository.updateQueueItem(item._id, patch).catch(() => null);
  return {
    ...item,
    placedCalls: patch.placedCalls,
    lastPlacedAt: patch.lastPlacedAt,
    dailyPlacedDateKey: patch.dailyPlacedDateKey,
    dailyPlacedCalls: patch.dailyPlacedCalls,
    monthlyPlacedMonthKey: patch.monthlyPlacedMonthKey,
    monthlyPlacedCalls: patch.monthlyPlacedCalls,
    metadata: {
      ...(item.metadata || {}),
      lastQueueAttemptAt: patch["metadata.lastQueueAttemptAt"],
      lastTouchedAt: patch["metadata.lastTouchedAt"],
      lastTouchedExtensionId: patch["metadata.lastTouchedExtensionId"],
      lastTouchedAgentName: patch["metadata.lastTouchedAgentName"],
      lastCxDialedByExtensionId: patch["metadata.lastCxDialedByExtensionId"],
      lastCxDialedByAgentName: patch["metadata.lastCxDialedByAgentName"],
      dailyPlacedDateKey: patch["metadata.dailyPlacedDateKey"],
      dailyPlacedCalls: patch["metadata.dailyPlacedCalls"],
      dailyPlacedTimezone: patch["metadata.dailyPlacedTimezone"],
      monthlyPlacedMonthKey: patch["metadata.monthlyPlacedMonthKey"],
      monthlyPlacedCalls: patch["metadata.monthlyPlacedCalls"],
      leadState: patch["metadata.leadState"],
      leadTimeZone: patch["metadata.leadTimeZone"],
    },
  };
}

function writeShadowCxCallState(extensionId, patch, options = {}) {
  if (!isCxCanonicalCallWriteEnabled()) return null;
  if (!extensionId || !patch) return null;
  return writeCxCallLifecycleShadowState({
    agentStateRepository,
    extensionId,
    patch,
    logger: options.logger || null,
    reason: options.reason || null,
    event: options.event || null,
  });
}

async function markAgentCxCallState(queueItem = null, payload = {}, placedAt = new Date()) {
  const extensionId = String(queueItem?.assignment?.extensionId || "").trim();
  if (!extensionId) return null;
  const startedAt = placedAt instanceof Date ? placedAt : new Date(placedAt);
  const phone = String(payload.phone || queueItem?.phone || "").trim() || null;
  const uii = String(payload.uii || "").trim() || null;
  const queueItemId = queueItem?._id ? String(queueItem._id) : null;
  const existing = await agentStateRepository.findAgentStateByExtensionId(extensionId);
  const currentCall = {
    sessionId: uii,
    telephonySessionId: uii,
    uii,
    direction: "outbound",
    from: null,
    fromName: queueItem?.assignment?.agentName || null,
    to: phone,
    phone,
    channel: "cx",
    startTime: Number.isNaN(startedAt.getTime()) ? new Date() : startedAt,
    queueItemId,
    queueTicketId: queueItemId,
    caseId:
      queueItem?.caseId != null && Number.isFinite(Number(queueItem.caseId))
        ? Number(queueItem.caseId)
        : payload.caseId != null && Number.isFinite(Number(payload.caseId))
          ? Number(payload.caseId)
          : null,
    domain: normalizeDomain(queueItem?.domain || payload.domain || null) || null,
    actionKey: String(payload.actionKey || queueItem?.metadata?.actionKey || "").trim() || null,
  };
  const dailyStats = applyCallStartedDailyStats(existing || {}, normalizeDailyStats(existing?.dailyStats, startedAt), {
    call: currentCall,
    platform: "cx",
    direction: "outbound",
    date: startedAt,
  });
  const canonicalPatch = buildCxCallLifecyclePatch({
    writer: "cx-cadence",
    queueItemId,
    caseId: currentCall.caseId,
    phone,
    uii,
    phase: "active",
    lastObservedAt: startedAt,
    lastWriter: "cx-cadence-call-placed",
  });
  writeShadowCxCallState(extensionId, canonicalPatch, {
    reason: "call-placed",
    event: "active-observed",
  });
  return agentStateRepository.updateAgentState(extensionId, {
    status: "onCall",
    activityState: "onCall",
    activePlatform: "CX",
    currentCall,
    dailyStats,
    lastActivityAt: new Date(),
    lastStatusChange: new Date(),
    "upstream.source": "cx-call-placed",
    "upstream.mirroredAt": new Date(),
  });
}

function callIdentity(call = {}) {
  return normalizeExternalId(call?.telephonySessionId || call?.sessionId || call?.uii);
}

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D+/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  if (digits.length >= 10) return digits.slice(-10);
  return digits || null;
}

function collectQueueItemDialIdentities(queueItem = {}) {
  const metadata = queueItem.metadata || {};
  return Array.from(
    new Set(
      [
        metadata.lastDialExecutionUii,
        metadata.lastDialExecutionCallSessionId,
        metadata.lastQueueAttemptUii,
        metadata.lastHangupRequestUii,
        metadata.lastRingcxMonitorUii,
        metadata.lastTerminalOutcomeUii,
      ]
        .map(normalizeExternalId)
        .filter(Boolean),
    ),
  );
}

function collectCurrentCallIdentities(call = {}) {
  return Array.from(
    new Set(
      [
        call?.telephonySessionId,
        call?.sessionId,
        call?.uii,
        call?.callId,
        call?.activeCallId,
        call?.id,
      ]
        .map(normalizeExternalId)
        .filter(Boolean),
    ),
  );
}

function collectQueueItemPhones(queueItem = {}) {
  const metadata = queueItem.metadata || {};
  return Array.from(
    new Set(
      [
        queueItem.phone,
        metadata.lastDialExecutionPhone,
        metadata.lastDialIntentPhone,
        metadata.lastQueueAttemptPhone,
        metadata.lastHangupRequestPhone,
      ]
        .map(normalizePhone)
        .filter(Boolean),
    ),
  );
}

function collectCurrentCallPhones(call = {}) {
  return Array.from(
    new Set(
      [
        call?.to,
        call?.from,
        call?.phone,
        call?.destination,
        call?.destinationPhone,
        call?.leadPhone,
        call?.callerId,
        call?.sourcePhone,
      ]
        .map(normalizePhone)
        .filter(Boolean),
    ),
  );
}

function hasRecentDate(value, now = new Date(), maxAgeMs = 5 * 60 * 1000) {
  if (!value) return false;
  const date = new Date(value);
  const nowDate = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(date.getTime()) || Number.isNaN(nowDate.getTime())) return false;
  return nowDate.getTime() - date.getTime() <= maxAgeMs;
}

function getServingActiveSignalMaxAgeMs() {
  const parsed = Number(process.env.RC_CX_SERVING_ACTIVE_SIGNAL_MAX_AGE_MS);
  if (Number.isFinite(parsed) && parsed >= 30_000) return parsed;
  return 10 * 60 * 1000;
}

function hasFreshAgentCxSignal(agentState = {}, now = new Date()) {
  const maxAgeMs = getServingActiveSignalMaxAgeMs();
  return Boolean(
    hasRecentDate(agentState.lastActivityAt, now, maxAgeMs)
      || hasRecentDate(agentState.lastStatusChange, now, maxAgeMs)
      || hasRecentDate(agentState.upstream?.mirroredAt, now, maxAgeMs)
      || hasRecentDate(agentState.appPresence?.lastSeenAt, now, maxAgeMs),
  );
}

function evaluateServingQueueActivity(queueItem = {}, agentState = null, now = new Date()) {
  const assignedExtensionId = String(queueItem.assignment?.extensionId || "").trim();
  if (!assignedExtensionId) {
    return { active: false, reason: "missing-assignment" };
  }
  if (!agentState) {
    return { active: false, reason: "missing-agent-state" };
  }
  const agentExtensionId = String(agentState.extensionId || "").trim();
  if (agentExtensionId && agentExtensionId !== assignedExtensionId) {
    return { active: false, reason: "different-agent-state" };
  }

  const currentCall = agentState.currentCall && typeof agentState.currentCall === "object"
    ? agentState.currentCall
    : {};
  const activePlatform = String(agentState.activePlatform || "").trim().toUpperCase();
  const callChannel = String(currentCall.channel || "").trim().toLowerCase();
  const status = String(agentState.status || "").trim().toLowerCase();
  const activityState = String(agentState.activityState || "").trim().toLowerCase();
  const isCxContext = activePlatform === "CX" || callChannel === "cx";
  const isUiPresent = isCxWorkspacePresenceActive(agentState, now);
  const isActiveCxActivity = (
    ["oncall", "ringing", "disposition"].includes(status)
      || ["dialing", "oncall", "dispositioning", "wrapup"].includes(activityState)
  );
  const hasFreshSignal = hasFreshAgentCxSignal(agentState, now);
  const metadata = queueItem.metadata || {};

  if (!isCxContext && !isUiPresent) {
    return { active: false, reason: "agent-not-cx-active" };
  }
  if (!isActiveCxActivity && !isUiPresent) {
    return { active: false, reason: "agent-idle" };
  }
  if (!hasFreshSignal) {
    return { active: false, reason: "agent-signal-stale" };
  }

  const queueIdentities = collectQueueItemDialIdentities(queueItem);
  const callIdentities = collectCurrentCallIdentities(currentCall);
  if (queueIdentities.length > 0 && callIdentities.length > 0) {
    const callIdentitySet = new Set(callIdentities);
    if (queueIdentities.some((value) => callIdentitySet.has(value))) {
      return { active: true, reason: "active-call-identity-match" };
    }
    return { active: false, reason: "different-active-cx-call" };
  }

  const queuePhones = collectQueueItemPhones(queueItem);
  const callPhones = collectCurrentCallPhones(currentCall);
  if (queuePhones.length > 0 && callPhones.length > 0) {
    const callPhoneSet = new Set(callPhones);
    if (queuePhones.some((value) => callPhoneSet.has(value))) {
      return { active: true, reason: "active-call-phone-match" };
    }
    return { active: false, reason: "different-active-cx-phone" };
  }

  if (
    metadata.lastQueueAttemptHeldForDisposition === true
    && isUiPresent
    && ["dispositioning", "wrapup"].includes(activityState)
  ) {
    return { active: true, reason: "active-ui-disposition-hold" };
  }

  if (isCxContext && isActiveCxActivity) {
    return { active: true, reason: "active-cx-agent-state" };
  }

  return { active: false, reason: "no-active-serving-signal" };
}

async function clearAgentCxCallStateForTerminalOutcome(queueItem = null, payload = {}, outcomeAt = new Date()) {
  const extensionId = String(
    payload.assignedExtensionId ||
      queueItem?.assignment?.extensionId ||
      "",
  ).trim();
  if (!extensionId) return { skipped: true, reason: "missing-extension-id" };

  const existing = await agentStateRepository
    .findAgentStateByExtensionId(extensionId)
    .catch(() => null);
  const existingCall = existing?.currentCall && typeof existing.currentCall === "object"
    ? existing.currentCall
    : {};
  const { skip: cxClearSkip, existingIdentity, requestedIdentity } = evaluateCxClear(
    existing,
    payload.uii ||
      payload.callSessionId ||
      queueItem?.metadata?.lastDialExecutionUii ||
      queueItem?.metadata?.lastQueueAttemptUii ||
      null,
  );
  if (cxClearSkip) {
    return {
      skipped: true,
      reason: cxClearSkip,
      extensionId,
      existingIdentity,
      requestedIdentity,
    };
  }

  const currentCallChannel = String(existingCall.channel || "").trim().toLowerCase();
  const wasCxCall =
    currentCallChannel === "cx" ||
    String(existing?.activePlatform || "").trim().toUpperCase() === "CX";
  const dailyStats = wasCxCall
    ? applyCallEndedDailyStats(existing || {}, normalizeDailyStats(existing?.dailyStats, outcomeAt), {
      missed: true,
      date: outcomeAt,
    })
    : normalizeDailyStats(existing?.dailyStats, outcomeAt);
  const canonicalPatch = buildCxCallLifecyclePatch({
    writer: "cx-cadence",
    queueItemId: queueItem?._id ? String(queueItem._id) : null,
    caseId: queueItem?.caseId || null,
    phone: queueItem?.phone || null,
    uii:
      payload.uii ||
      payload.callSessionId ||
      queueItem?.metadata?.lastDialExecutionUii ||
      queueItem?.metadata?.lastQueueAttemptUii ||
      null,
    phase: "released",
    lastObservedAt: outcomeAt,
    lastWriter: "cx-cadence-terminal-outcome",
  });
  writeShadowCxCallState(extensionId, canonicalPatch, {
    reason: payload.normalizedOutcome || payload.outcome || "terminal-outcome-release",
    event: "release",
  });

  const updated = await agentStateRepository.updateAgentState(extensionId, {
    status: "available",
    activityState: "idle",
    activePlatform: "none",
    currentCall: {},
    dailyStats,
    lastCallEndedAt: outcomeAt,
    lastCallOutcome: payload.normalizedOutcome || payload.outcome || "ringcx-terminal-non-connect",
    lastActivityAt: outcomeAt,
    lastStatusChange: outcomeAt,
    "upstream.source": "cx-terminal-outcome",
    "upstream.mirroredAt": outcomeAt,
  });

  const terminalOutcome = {
    extensionId,
    queueItemId: queueItem?._id ? String(queueItem._id) : null,
    caseId: queueItem?.caseId || null,
    phone: queueItem?.phone || null,
    uii: payload.uii || payload.callSessionId
      || queueItem?.metadata?.lastDialExecutionUii
      || queueItem?.metadata?.lastQueueAttemptUii
      || null,
    outcome: payload.normalizedOutcome || payload.outcome || "terminal-outcome",
    drainCurrentCall: true,
    logger: payload.logger || null,
  };
  observeCxBucketTerminalOutcome(terminalOutcome).catch(() => null);

  return {
    ok: true,
    extensionId,
    cleared: true,
    counted: wasCxCall,
    state: updated,
  };
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

function isProtectedServingQueueItem(queueItem = {}, now = new Date()) {
  const metadata = queueItem.metadata || {};
  if (metadata.dealHandoffHold === true) return true;
  if (metadata.lastHangupRequestStatus === "accepted") {
    const hangupGraceMs = Math.max(Number(process.env.RC_CX_HANGUP_ACCEPTED_GRACE_MS) || 2 * 60 * 1000, 30 * 1000);
    return hasRecentDate(metadata.lastHangupRequestAt, now, hangupGraceMs);
  }
  return false;
}

function buildClaimedDialingEvidenceQuery() {
  const correlatedDialEvidence = [
    { "metadata.servingAt": { $exists: true, $ne: null } },
    { "metadata.lastQueueAttemptAt": { $exists: true, $ne: null } },
    { "metadata.lastQueueAttemptHeldForDisposition": true },
    { "metadata.lastQueueAttemptUii": { $exists: true, $nin: [null, ""] } },
    { "metadata.lastDialExecutionAt": { $exists: true, $ne: null } },
    { "metadata.lastDialExecutionUii": { $exists: true, $nin: [null, ""] } },
    { "metadata.lastRingcxPublishedAt": { $exists: true, $ne: null } },
    { "metadata.lastRingcxPublishedExternId": { $exists: true, $nin: [null, ""] } },
    { "metadata.lastDialExecutionRingcxPublish": { $exists: true, $ne: null } },
    { "metadata.lastDialIntentLocalStage": { $exists: true, $ne: null } },
  ];
  return {
    $or: [
      ...correlatedDialEvidence,
      {
        "metadata.lastDialIntentStatus": {
          $in: [
            "staged",
            "relayed",
            "queued-in-ringcx",
            "accepted",
            "relay-timeout-pending",
            "unconfirmed-active-call",
            "unconfirmed",
            "awaiting-confirmation",
          ],
        },
      },
      {
        $and: [
          { "metadata.lastDialIntentStatus": "relay-failed" },
          { $or: correlatedDialEvidence },
        ],
      },
    ],
  };
}

async function promoteExpiredDialingClaims(now = new Date(), limit = 50) {
  const docs = await CxDialQueue.find({
    state: "claimed",
    claimUntil: { $ne: null, $lte: now },
    ...buildClaimedDialingEvidenceQuery(),
  })
    .sort({ claimUntil: 1 })
    .limit(Math.min(Number(limit) || 50, 200));

  const promoted = [];
  for (const doc of docs) {
    const metadata = doc.metadata && typeof doc.metadata.toObject === "function"
      ? doc.metadata.toObject()
      : doc.metadata || {};
    const servingAt = metadata.servingAt || metadata.lastDialIntentAt || now;
    const updated = await cxDialQueueRepository.transitionQueueItemState(
      doc._id,
      ["claimed"],
      {
        state: "serving",
        claimUntil: null,
        "metadata.servingAt": servingAt,
        "metadata.promotedClaimToServingAt": now,
        "metadata.promotedClaimToServingReason": "expired-claim-with-dial-evidence",
      },
      { returnNew: true },
    );
    if (!updated) continue;
    promoted.push(updated.toObject ? updated.toObject() : updated);
  }
  return promoted;
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
    if (isProtectedServingQueueItem(item, now)) continue;
    const servingAt = getServingIntentDate(item);
    if (!servingAt || servingAt > cutoff) continue;
    const previousAssignment = cloneAssignment(item.assignment);
    const agentState = previousAssignment?.extensionId
      ? await agentStateRepository.findAgentStateByExtensionId(previousAssignment.extensionId).catch(() => null)
      : null;
    const activeServing = evaluateServingQueueActivity(item, agentState, now);
    if (activeServing.active) {
      await cxDialQueueRepository.updateQueueItem(item._id, {
        state: "serving",
        claimUntil: null,
        "metadata.lastServingReconcileAt": now,
        "metadata.lastServingReconcileReason": activeServing.reason,
        "metadata.lastServingReconcileSource": "stale-serving-guard",
      }).catch(() => null);
      continue;
    }
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
        "metadata.staleServingInactiveReason": activeServing.reason,
      },
      { returnNew: true },
    );
    if (!updated) continue;
    if (previousAssignment?.extensionId) {
      await decrementAgentOpenAssignments(previousAssignment.extensionId).catch(() => null);
      const latestAgentState = await agentStateRepository
        .findAgentStateByExtensionId(previousAssignment.extensionId)
        .catch(() => null);
      const latestActiveServing = evaluateServingQueueActivity(item, latestAgentState, now);
      if (!latestActiveServing.active) {
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
        observeCxBucketTerminalOutcome({
          extensionId: previousAssignment.extensionId,
          queueItemId: item?._id ? String(item._id) : null,
          caseId: item.caseId || null,
          phone: item.phone || null,
          uii: item.metadata?.lastDialExecutionUii || item.metadata?.lastQueueAttemptUii || null,
          outcome: "stale-serving-timeout",
          drainCurrentCall: true,
        }).catch(() => null);
      }
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
  const normalizedLimit = Math.min(Math.max(Number(limit) || 250, 25), 5000);
  const recentTouchAgeLimit = Math.min(
    Math.max(Number(process.env.RC_CX_TOUCH_AGE_BACKFILL_LIMIT) || 750, 50),
    5000,
  );
  const touchAgeWindowDays = Math.max(Number(getTouchAgeFreshWindowDays()) || 2, 1);
  const touchAgeCutoff = new Date(Date.now() - (touchAgeWindowDays + 2) * 24 * 60 * 60 * 1000);
  const [orderedItems, recentLowTouchItems] = await Promise.all([
    cxDialQueueRepository.listQueueItems({
      domain: domain || null,
      states: ["queued", "ready", "claimed", "serving", "paused"],
      limit: normalizedLimit,
    }),
    cxDialQueueRepository.listQueueItems({
      domain: domain || null,
      states: ["queued", "ready", "claimed", "serving", "paused"],
      queueFamilies: ["fresh-day2to10", "fresh-day16to30"],
      createdAtGte: touchAgeCutoff,
      limit: recentTouchAgeLimit,
    }),
  ]);

  const byId = new Map();
  for (const item of [...orderedItems, ...recentLowTouchItems]) {
    const id = item?._id ? String(item._id) : "";
    if (!id || byId.has(id)) continue;
    byId.set(id, item);
  }
  const queueItems = [...byId.values()];

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

async function maybeBackfillCxQueueOrdering(domain = null, limit = 250, options = {}) {
  if (options.skipOrderingBackfill === true) return { ok: true, skipped: true, reason: "skip-requested" };

  const normalizedLimit = Math.min(Math.max(Number(limit) || 250, 25), 5000);
  const normalizedDomain = normalizeDomain(domain);
  const cacheKey = `${normalizedDomain || "ALL"}:${normalizedLimit}`;
  const intervalMs = Math.max(
    Number(process.env.RC_CX_ORDERING_BACKFILL_MIN_INTERVAL_MS) || 60_000,
    0,
  );
  const now = Date.now();
  const previousAt = Number(cxQueueOrderingBackfillMemo.get(cacheKey) || 0);
  if (
    options.forceOrderingBackfill !== true
    && intervalMs > 0
    && previousAt > 0
    && now - previousAt < intervalMs
  ) {
    return {
      ok: true,
      skipped: true,
      reason: "recent-backfill",
      nextEligibleAt: new Date(previousAt + intervalMs),
    };
  }

  // Set before awaiting so simultaneous refill requests do not all start
  // their own ordering scan against the same queue.
  cxQueueOrderingBackfillMemo.set(cacheKey, now);
  await backfillCxQueueOrdering(domain, normalizedLimit);
  return { ok: true, skipped: false };
}

async function queueCxDialRequest(payload = {}) {
  const domain = normalizeDomain(payload.domain);
  const caseId = Number(payload.caseId);
  const actionKey = normalizeActionKey(
    payload.actionKey || payload.queueKey || payload.metadata?.actionKey,
  );
  const leadState = readLeadStateForQueue(payload);
  const leadTimeZone = readLeadTimeZoneForQueue(payload);
  if (!domain || !Number.isFinite(caseId)) {
    throw new Error("domain and caseId are required for cx dial queueing");
  }

  const eligibility = await resolveCaseContactEligibility(domain, caseId, {
    enforceStop: true,
    requireFreshLogicsStatus: true,
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
    const existingAppointmentId = String(existingObject?.metadata?.appointmentId || "").trim();
    const requestedAppointmentId = String(payload.appointmentId || payload.metadata?.appointmentId || "").trim();
    const appointmentHoldStatus = String(existingObject?.metadata?.appointmentStatus || "").trim().toLowerCase();
    const appointmentHoldReason = String(existingObject?.metadata?.dialabilityHoldReason || "").trim().toLowerCase();
    const isDifferentAppointmentRequest =
      existingAppointmentId &&
      requestedAppointmentId &&
      existingAppointmentId !== requestedAppointmentId;
    const isOrdinaryRequestAgainstAppointment =
      existingAppointmentId &&
      !requestedAppointmentId;
    if (
      appointmentHoldReason === "appointment" &&
      ["scheduled", "blocked"].includes(appointmentHoldStatus) &&
      (isDifferentAppointmentRequest || isOrdinaryRequestAgainstAppointment)
    ) {
      return {
        queued: false,
        skipped: true,
        reason: "appointment-hold",
        appointmentId: existingAppointmentId,
        releaseAt: existingObject.releaseAt || existingObject.metadata?.dialabilityHoldUntil || null,
        queueItem: existingObject,
      };
    }
    const existingRouting = readStoredRcxQueueRouting(existingObject);
    const requestedReleaseAt = parseRequestedReleaseAt(payload.releaseAt);
    const requestedReleaseTiming = requestedReleaseAt
      ? resolveRequestedReleaseTiming(domain, requestedReleaseAt, { ...existingObject, ...payload })
      : null;
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
    const existingCallPlan = normalizeCallPlanForQueueFamily(
      existingObject.callPlan || null,
      existingObject.queueFamily || payload.queueFamily,
    );
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
      existingCallPlan,
      existingObject.placedCalls,
    );
    const existingReleaseAt = existingObject.releaseAt ? new Date(existingObject.releaseAt).getTime() : null;
    const requestedReleaseAtMs = requestedReleaseTiming?.releaseAt
      ? new Date(requestedReleaseTiming.releaseAt).getTime()
      : null;
    const releasePatchAllowed = ["queued", "ready"].includes(
      String(existingObject.state || "").trim().toLowerCase(),
    );
    const needsReleasePatch = Boolean(
      requestedReleaseTiming
        && releasePatchAllowed
        && Number.isFinite(requestedReleaseAtMs)
        && existingReleaseAt !== requestedReleaseAtMs,
    );
    const needsOrderingPatch = (
      normalizeQueueFamily(existingObject.queueFamily) !== progression.queueFamily
      || Number(existingObject.queueFamilyRank ?? -1) !== progression.queueFamilyRank
      || String(existingObject.progressiveStageKey || "") !== String(progression.progressiveStageKey || "")
      || Number(existingObject.progressiveStageIndex ?? -1) !== progression.progressiveStageIndex
      || String(existingObject.progressiveStageLabel || "") !== String(progression.progressiveStageLabel || "")
    );
    const requestedPriorityScore = computePriorityScore(payload);
    const needsPriorityPatch =
      Number.isFinite(requestedPriorityScore)
      && Number(existingObject.priorityScore ?? -1) !== requestedPriorityScore;
    if (needsMetadataPatch || needsOrderingPatch || needsReleasePatch || needsPriorityPatch) {
      const patch = {
        leadCadenceId: existingObject.leadCadenceId || payload.leadCadenceId || null,
        rcxAccountId: requestedRouting.rcxAccountId,
        rcxDialGroupId: requestedRouting.rcxDialGroupId,
        rcxCampaignId: requestedRouting.rcxCampaignId,
        queueFamily: progression.queueFamily,
        queueFamilyRank: progression.queueFamilyRank,
        progressiveStageKey: progression.progressiveStageKey,
        progressiveStageIndex: progression.progressiveStageIndex,
        progressiveStageLabel: progression.progressiveStageLabel,
        priorityScore: requestedPriorityScore,
        callPlan: existingCallPlan,
        metadata: {
          ...(existingObject.metadata || {}),
          ...(payload.metadata || {}),
          ...(progression.metadata || {}),
          actionKey: actionKey || existingActionKey || null,
          ...(leadState ? { leadState } : {}),
          ...(leadTimeZone ? { leadTimeZone } : {}),
          rcxAccountId: requestedRouting.rcxAccountId,
          rcxDialGroupId: requestedRouting.rcxDialGroupId,
          rcxCampaignId: requestedRouting.rcxCampaignId,
        },
      };
      if (needsReleasePatch) {
        patch.releaseAt = requestedReleaseTiming.releaseAt;
        patch.state = requestedReleaseTiming.state;
        patch.claimUntil = null;
        patch.metadata.requestedReleaseAt = requestedReleaseAt;
        patch.metadata.requestedReleaseTimingReason = payload.metadata?.callbackQueueTimingReason || null;
      }
      const patched = await cxDialQueueRepository.updateQueueItem(existingObject._id, patch);
      return { queued: true, deduped: true, queueItem: patched?.toObject ? patched.toObject() : patched };
    }
    return { queued: true, deduped: true, queueItem: existingObject };
  }

  const now = new Date();
  let callPlan = buildInitialCallPlan();
  const queueFamily = resolveQueueFamilyForPayload({
    ...payload,
    callPlan,
  });
  callPlan = normalizeCallPlanForQueueFamily(callPlan, queueFamily);
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
  const requestedReleaseAt = parseRequestedReleaseAt(payload.releaseAt);
  const releaseTiming = resolveRequestedReleaseTiming(
    domain,
    requestedReleaseAt || new Date(now.getTime() + callPlan.nextDelayMinutes * 60 * 1000),
    payload,
  );
  const timing = releaseTiming.timing;
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
    state: releaseTiming.state,
    queueFamily: progression.queueFamily,
    queueFamilyRank: progression.queueFamilyRank,
    queueTier,
    progressiveStageKey: progression.progressiveStageKey,
    progressiveStageIndex: progression.progressiveStageIndex,
    progressiveStageLabel: progression.progressiveStageLabel,
    priorityScore: computePriorityScore(payload),
    releaseAt: releaseTiming.releaseAt,
    callPlan,
    metadata: {
      requestedBy: payload.requestedBy || "cadence-engine",
      executionOwner: payload.executionOwner || "ringcentral-cx",
      futureAdapterPort: payload.futureAdapterPort || 6101,
      actionKey,
      requestedWorkflowId: payload.workflowId || null,
      requestedByUserEmail: payload.requestedByUserEmail || null,
      leadCreatedAt: payload.leadCreatedAt || payload.createdAt || payload.payloadSnapshot?.createdAt || null,
      ...(leadState ? { leadState } : {}),
      ...(leadTimeZone ? { leadTimeZone } : {}),
      requestedReleaseAt: requestedReleaseAt || null,
      ...(payload.metadata || {}),
      ...(progression.metadata || {}),
      actionKey,
      rcxAccountId: rcxRouting.rcxAccountId,
      rcxDialGroupId: rcxRouting.rcxDialGroupId,
      rcxCampaignId: rcxRouting.rcxCampaignId,
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
  if (payload.alreadyHandled === true) {
    return {
      ok: true,
      skipped: true,
      reason: "already-handled-inline",
    };
  }

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
  const currentPlan = normalizeCallPlanForQueueFamily(
    queueItem.callPlan || null,
    queueItem.queueFamily || queueItem.metadata?.queueFamily,
  );
  const nextIndex = Number(currentPlan.phaseIndex || 0) + 1;
  const nextDelayMinutes = eligibility.ok ? (currentPlan.delaysMinutes?.[nextIndex] ?? null) : null;
  const attemptPatch = buildCallAttemptPatch(queueItem, placedAt);
  const confirmedCall =
    payload.confirmedCall === true
    || Boolean(String(payload.uii || payload.callSessionId || "").trim());
  const callTelephonySessionId = confirmedCall
    ? resolveCxPlacedSessionId(payload, queueItem, placedAt)
    : null;
  const callPayload = callTelephonySessionId
    ? {
      ...payload,
      uii: payload.uii || callTelephonySessionId,
      callSessionId: payload.callSessionId || callTelephonySessionId,
    }
    : payload;
  const countableAttempt =
    confirmedCall
    || payload.countAsAttempt === true
    || payload.holdUntilDisposition === true
    || payload.ringcxPublished === true;
  const touchMetadata = countableAttempt
    ? buildDailyAgentTouchMetadata(queueItem, placedAt)
    : {};
  const attemptQueuePatch = Object.fromEntries(
    Object.entries(attemptPatch).filter(([key]) => !key.startsWith("metadata.")),
  );
  const nextPlacedCalls = Number(attemptPatch.placedCalls || 0);
  if (countableAttempt) {
    const touchWrites = [
      markLeadCxTouchState({
        domain,
        caseId,
        queueItem,
        payload: callPayload,
        placedAt,
        confirmedCall: true,
      }).catch(() => null),
    ];
    if (confirmedCall) {
      touchWrites.push(markAgentCxCallState(queueItem, callPayload, placedAt).catch(() => null));
    }
    await Promise.all(touchWrites);
  }
  if (confirmedCall && callTelephonySessionId) {
    // Read the RingCX-specific identifiers stamped on the queue item
    // at publish time (ringcxLeadServingService sets metadata.rcxVisibility*
    // when the lead is loaded into the campaign). These power the spot-
    // download path in the call review dashboard — agentId is the
    // narrow filter for the `interaction-metadata` POST that returns
    // dialogId + segmentId for this specific call.
    const queueMetadata = queueItem.metadata && typeof queueItem.metadata === "object"
      ? queueItem.metadata
      : {};
    const ringcxStamp = {
      agentId: queueMetadata.rcxVisibilityAgentId
        ? String(queueMetadata.rcxVisibilityAgentId)
        : null,
      agentGroupId: queueMetadata.rcxVisibilityAgentGroupId
        ? String(queueMetadata.rcxVisibilityAgentGroupId)
        : null,
      agentUsername: queueMetadata.rcxVisibilityAgentUsername || null,
      campaignId: queueMetadata.rcxVisibilityCampaignId
        ? String(queueMetadata.rcxVisibilityCampaignId)
        : null,
      dialGroupId: queueMetadata.rcxVisibilityDialGroupId
        ? String(queueMetadata.rcxVisibilityDialGroupId)
        : null,
      accountId: queueMetadata.rcxVisibilityAccountId
        ? String(queueMetadata.rcxVisibilityAccountId)
        : null,
      externId: queueMetadata.rcxVisibilityExternId || null,
      queueItemId: String(queueItem._id),
      agentEmail: payload.agentEmail || null,
      actionKey: payload.actionKey || queueItem.metadata?.actionKey || null,
    };
    // Stamp routeCampaignKey at write time so the vendor families
    // rollup can split LD into ld-custom / ld-general without waiting
    // on the nightly source backfill. Backfill (callLogSourceBackfill
    // Service) remains the safety net for stubs that race the queue
    // metadata or older rows.
    //
    // TODO(ld-campaign-queue-feed): the producer side needs to
    // guarantee `queueItem.metadata.routeCampaignKey` is set for every
    // CX-publish path. Existing materializers in cxWorkspaceService
    // (line ~2369 / 2465 / 2566 / 2637) already copy it from
    // LeadCadence / MasterProspect.metadata — verify the live publish
    // path (ringcxLeadServingService.publishQueueItemToRingcx) also
    // propagates it onto the RingCX-side custom-fields if we want it
    // visible in the agent dashboard. If the queue item lacks it, this
    // code silently writes null and the nightly backfill fills it in
    // from LeadCadence — correctness is preserved but real-time
    // dashboards see the gap.
    const routeCampaignKey = queueMetadata.routeCampaignKey || null;
    const routeCampaignName = queueMetadata.routeCampaignName || null;
    // Real-time source attribution. The nightly backfill
    // (callLogSourceBackfillService) has been observed to leave a
    // significant fraction of CX CallLog rows null-sourced, which
    // causes the vendor email's "Vendor families" table to silently
    // drop CX calls (the classifier treats null source as "other"
    // family which isn't tracked). Stamping sourceName/sourceChannel
    // at call-placed time eliminates the gap entirely — backfill
    // becomes a safety net only.
    //
    // Order of preference: queueItem.metadata (no extra query) →
    // LeadCadence lookup (one indexed query per call-placed). Cost
    // of the lookup is small relative to the rest of the call-placed
    // path (multiple queries already happen for case eligibility,
    // queue update, etc.).
    let sourceName = queueMetadata.sourceName || null;
    let sourceChannel = queueMetadata.sourceChannel || null;
    if (!sourceName) {
      try {
        const cadence = await leadCadenceRepository
          .findLeadCadence(domain, caseId)
          .catch(() => null);
        if (cadence) {
          sourceName = cadence.sourceName || null;
          sourceChannel = cadence.sourceChannel || null;
        }
      } catch (_) {
        // Best-effort — if LeadCadence lookup fails, the nightly
        // backfill remains the fallback. Don't let it block the
        // call-log write.
      }
    }
    const callLog = await callLogRepository.upsertCallLog({
      domain,
      telephonySessionId: callTelephonySessionId,
      callSessionId: payload.callSessionId || null,
      direction: "outbound",
      callStartTime: placedAt,
      caseId,
      phone: payload.phone || queueItem.phone || null,
      extensionId: queueItem.assignment?.extensionId || null,
      executionOwner: "ringcentral-cx",
      platform: "cx",
      ringcx: ringcxStamp,
      sourceName,
      sourceChannel,
      routeCampaignKey,
      routeCampaignName,
      audit: {
        dispatchSource: "cx-call-placed",
        intent: "cx-call-defensive-write",
        queueItemId: String(queueItem._id),
        actionKey: payload.actionKey || queueItem.metadata?.actionKey || null,
        agentEmail: payload.agentEmail || null,
        syntheticSessionId: callTelephonySessionId.startsWith("cx-synth:"),
      },
    }).catch(() => null);
    if (callLog) {
      await syncCallLedgerFromCallLog(callLog, { syncedAt: new Date() }).catch(() => null);
    }
  }
  const queueState = String(queueItem.state || "").trim().toLowerCase();
  if (["completed", "cancelled"].includes(queueState)) {
    await cxDialQueueRepository.updateQueueItem(queueItem._id, normalizeExtraQueueUpdate({
      ...attemptQueuePatch,
      metadata: {
        dailyPlacedDateKey: attemptPatch.dailyPlacedDateKey,
        dailyPlacedCalls: attemptPatch.dailyPlacedCalls,
        monthlyPlacedMonthKey: attemptPatch.monthlyPlacedMonthKey,
        monthlyPlacedCalls: attemptPatch.monthlyPlacedCalls,
        hourlyPlacedHourKey: attemptPatch.hourlyPlacedHourKey,
        hourlyPlacedCalls: attemptPatch.hourlyPlacedCalls,
        ...touchMetadata,
        lastQueueAttemptAt: placedAt,
        lastQueueAttemptIgnoredState: queueState,
        lastQueueAttemptUii: callTelephonySessionId || null,
        lastQueueAttemptPhone: payload.phone || queueItem.phone || null,
      },
    })).catch(() => null);
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
    await cxDialQueueRepository.updateQueueItem(queueItem._id, normalizeExtraQueueUpdate({
      ...attemptQueuePatch,
      metadata: {
        dailyPlacedDateKey: attemptPatch.dailyPlacedDateKey,
        dailyPlacedCalls: attemptPatch.dailyPlacedCalls,
        monthlyPlacedMonthKey: attemptPatch.monthlyPlacedMonthKey,
        monthlyPlacedCalls: attemptPatch.monthlyPlacedCalls,
        hourlyPlacedHourKey: attemptPatch.hourlyPlacedHourKey,
        hourlyPlacedCalls: attemptPatch.hourlyPlacedCalls,
        ...touchMetadata,
        lastQueueAttemptAt: placedAt,
        lastQueueAttemptIgnoredState: queueState,
        lastQueueAttemptIgnoredReason: "already-callback-rescheduled",
        lastQueueAttemptUii: callTelephonySessionId || null,
        lastQueueAttemptPhone: payload.phone || queueItem.phone || null,
      },
    })).catch(() => null);
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
  const confirmedClaimedCxCall = confirmedCall && queueState === "claimed";
  const confirmedExplicitDispositionHold =
    confirmedCall && payload.holdUntilDisposition === true;
  const holdUntilDisposition =
    queueState === "serving"
    || queueItem.metadata?.dealHandoffHold === true
    || confirmedClaimedCxCall
    || confirmedExplicitDispositionHold;
  const holdReason = confirmedClaimedCxCall
    ? "confirmed-claimed-call"
    : confirmedExplicitDispositionHold
      ? "confirmed-explicit-disposition-hold"
    : queueItem.metadata?.dealHandoffHold === true
      ? "deal-handoff-hold"
      : "serving-call";

  if (holdUntilDisposition) {
    await cxDialQueueRepository.updateQueueItem(queueItem._id, normalizeExtraQueueUpdate({
      state: "serving",
      claimUntil: null,
      ...attemptQueuePatch,
      callPlan: nextPlan,
      queueFamily: progression.queueFamily,
      queueFamilyRank: progression.queueFamilyRank,
      progressiveStageKey: progression.progressiveStageKey,
      progressiveStageIndex: progression.progressiveStageIndex,
      progressiveStageLabel: progression.progressiveStageLabel,
      metadata: {
        ...(progression.metadata || {}),
        dailyPlacedDateKey: attemptPatch.dailyPlacedDateKey,
        dailyPlacedCalls: attemptPatch.dailyPlacedCalls,
        monthlyPlacedMonthKey: attemptPatch.monthlyPlacedMonthKey,
        monthlyPlacedCalls: attemptPatch.monthlyPlacedCalls,
        hourlyPlacedHourKey: attemptPatch.hourlyPlacedHourKey,
        hourlyPlacedCalls: attemptPatch.hourlyPlacedCalls,
        ...touchMetadata,
        lastQueueAttemptAt: placedAt,
        lastQueueAttemptHeldForDisposition: true,
        lastQueueAttemptHoldReason: holdReason,
        lastQueueAttemptUii: callTelephonySessionId || null,
        lastQueueAttemptPhone: payload.phone || queueItem.phone || null,
      },
    }), {
      match: {
        ...buildQueueItemMutationMatch(queueItem, { matchAssignment: false }),
        ...(queueState ? { state: queueState } : {}),
      },
    });
  } else if (nextDelayMinutes == null) {
    await completeCxQueueItem({
      queueItemId: String(queueItem._id),
      queueOutcome: "cadence-finished",
      disposition: "cx-call-placed",
      extraUpdate: {
        ...attemptQueuePatch,
        queueFamily: progression.queueFamily,
        queueFamilyRank: progression.queueFamilyRank,
        progressiveStageKey: progression.progressiveStageKey,
        progressiveStageIndex: progression.progressiveStageIndex,
        progressiveStageLabel: progression.progressiveStageLabel,
        metadata: {
          ...(progression.metadata || {}),
          dailyPlacedDateKey: attemptPatch.dailyPlacedDateKey,
          dailyPlacedCalls: attemptPatch.dailyPlacedCalls,
          monthlyPlacedMonthKey: attemptPatch.monthlyPlacedMonthKey,
          monthlyPlacedCalls: attemptPatch.monthlyPlacedCalls,
          hourlyPlacedHourKey: attemptPatch.hourlyPlacedHourKey,
          hourlyPlacedCalls: attemptPatch.hourlyPlacedCalls,
          ...touchMetadata,
          lastQueueAttemptAt: placedAt,
        },
      },
    });
  } else {
    const timing = resolveQueueDialTimeWindow(
      queueItem,
      new Date(placedAt.getTime() + nextDelayMinutes * 60 * 1000),
    );
    await rescheduleCxQueueItem({
      queueItemId: String(queueItem._id),
      releaseAt: timing.nextAllowedAt,
      reason: "follow-up-delay",
      extraUpdate: {
        ...attemptQueuePatch,
        callPlan: nextPlan,
        queueFamily: progression.queueFamily,
        queueFamilyRank: progression.queueFamilyRank,
        progressiveStageKey: progression.progressiveStageKey,
        progressiveStageIndex: progression.progressiveStageIndex,
        progressiveStageLabel: progression.progressiveStageLabel,
        metadata: {
          ...(progression.metadata || {}),
          dailyPlacedDateKey: attemptPatch.dailyPlacedDateKey,
          dailyPlacedCalls: attemptPatch.dailyPlacedCalls,
          monthlyPlacedMonthKey: attemptPatch.monthlyPlacedMonthKey,
          monthlyPlacedCalls: attemptPatch.monthlyPlacedCalls,
          hourlyPlacedHourKey: attemptPatch.hourlyPlacedHourKey,
          hourlyPlacedCalls: attemptPatch.hourlyPlacedCalls,
          ...touchMetadata,
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

  // Invalidate the assigned agent's call-stats snapshot so the admin
  // board reflects this call within the next read cycle (~5s) instead
  // of waiting up to 5 min for the snapshot TTL to expire. Best-effort:
  // never blocks the call-placement flow.
  if (confirmedCall) {
    const assignedExtensionId =
      queueItem.assignment?.extensionId
      || queueItem.metadata?.lastAssignedExtensionId
      || payload.extensionId
      || null;
    if (assignedExtensionId) {
      invalidateAgentCallStatsSnapshot(assignedExtensionId).catch(() => null);
    }
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

async function handleCxTerminalCallOutcome(payload = {}) {
  const classification = classifyCxTerminalOutcome(payload);
  const queueItemId = String(payload.queueItemId || payload.queueTicketId || "").trim();
  const queueItem = queueItemId
    ? await cxDialQueueRepository.findQueueItemById(queueItemId)
    : await cxDialQueueRepository.findActiveQueueItem(
      payload.domain,
      payload.caseId,
      payload.actionKey ? { actionKey: payload.actionKey } : {},
    );

  if (!queueItem) {
    return {
      ok: true,
      advanced: false,
      reason: "queue-item-not-found",
      classification,
    };
  }

  const domain = normalizeDomain(queueItem.domain);
  const caseId = Number(queueItem.caseId);
  const outcomeAt = payload.outcomeAt ? new Date(payload.outcomeAt) : new Date();
  const safeOutcomeAt = Number.isNaN(outcomeAt.getTime()) ? new Date() : outcomeAt;
  const normalizedOutcome = classification.normalizedOutcome;
  const nonConnectOutcome = normalizedOutcome === "voicemail" || normalizedOutcome === "did_not_connect";
  const contactOutcome = normalizedOutcome === "answered" || normalizedOutcome === "dnc";
  const terminalMetadata = {
    lastTerminalOutcomeAt: safeOutcomeAt,
    lastTerminalOutcome: payload.outcome || payload.result || payload.disposition || null,
    lastTerminalOutcomeNormalized: normalizedOutcome,
    lastTerminalOutcomeMatchedValue: classification.matchedValue,
    lastTerminalOutcomeSource: payload.sourceService || payload.source || "ringcentral-cx",
    lastTerminalOutcomeUii:
      normalizeExternalId(payload.uii || payload.callSessionId)
      || queueItem.metadata?.lastDialExecutionUii
      || queueItem.metadata?.lastQueueAttemptUii
      || null,
  };
  const terminalAttemptProof = buildTerminalAttemptProofPatch(queueItem, payload, safeOutcomeAt, terminalMetadata);
  const countableBulkTerminalAttempt = terminalAttemptProof.countable;
  const terminalAttemptPatch = terminalAttemptProof.queuePatch;

  if (!classification.safeToAdvance) {
    await cxDialQueueRepository.updateQueueItem(queueItem._id, {
      "metadata.lastTerminalOutcomeIgnoredAt": safeOutcomeAt,
      "metadata.lastTerminalOutcomeIgnoredReason": "not-safe-non-connect",
      ...Object.fromEntries(
        Object.entries(terminalMetadata).map(([key, value]) => [`metadata.${key}`, value]),
      ),
    }).catch(() => null);
    return {
      ok: true,
      advanced: false,
      reason: "not-safe-non-connect",
      queueItemId: String(queueItem._id),
      caseId,
      classification,
    };
  }

  const queueState = String(queueItem.state || "").trim().toLowerCase();
  const heldForDisposition =
    queueState === "serving"
    || queueItem.metadata?.lastQueueAttemptHeldForDisposition === true
    || queueItem.metadata?.wrapUpRequired === true;
  const bulkTerminalBypass = shouldBypassHeldGateForBulkTerminal({ payload, queueItem, queueState });
  if (["completed", "cancelled"].includes(queueState)) {
    await cxDialQueueRepository.updateQueueItem(queueItem._id, {
      "metadata.lastTerminalOutcomeIgnoredAt": safeOutcomeAt,
      "metadata.lastTerminalOutcomeIgnoredReason": `terminal-state:${queueState}`,
      ...Object.fromEntries(
        Object.entries(terminalMetadata).map(([key, value]) => [`metadata.${key}`, value]),
      ),
    }).catch(() => null);
    return {
      ok: true,
      advanced: false,
      reason: "terminal-state",
      queueItemId: String(queueItem._id),
      caseId,
      queueState,
      classification,
    };
  }
  if (!heldForDisposition && !bulkTerminalBypass) {
    await cxDialQueueRepository.updateQueueItem(queueItem._id, {
      "metadata.lastTerminalOutcomeIgnoredAt": safeOutcomeAt,
      "metadata.lastTerminalOutcomeIgnoredReason": "not-held-for-disposition",
      ...Object.fromEntries(
        Object.entries(terminalMetadata).map(([key, value]) => [`metadata.${key}`, value]),
      ),
    }).catch(() => null);
    return {
      ok: true,
      advanced: false,
      reason: "not-held-for-disposition",
      queueItemId: String(queueItem._id),
      caseId,
      queueState,
      classification,
    };
  }

  const preferredActionKey = normalizeActionKey(payload.actionKey || queueItem?.metadata?.actionKey);
  const lead = await LeadCadence.findOne({ domain, caseId }).lean();
  const priorCxAnsweredContacts = Math.max(Number(
    lead?.counterCadence?.cxAnsweredContacts ||
      lead?.payloadSnapshot?.cxAnsweredContacts ||
      queueItem?.metadata?.answeredContacts ||
      queueItem?.metadata?.cxAnsweredContacts ||
      0,
  ) || 0, 0);
  const priorCxNoAnswerCalls = Math.max(Number(
    lead?.counterCadence?.cxNoAnswerCalls ||
      lead?.payloadSnapshot?.cxNoAnswerCalls ||
      queueItem?.metadata?.unansweredCalls ||
      queueItem?.metadata?.noAnswerCalls ||
      queueItem?.metadata?.cxNoAnswerCalls ||
      0,
  ) || 0, 0);
  const nextCxAnsweredContacts = priorCxAnsweredContacts + (contactOutcome ? 1 : 0);
  const nextCxNoAnswerCalls = priorCxNoAnswerCalls + (nonConnectOutcome ? 1 : 0);
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
  if (pendingCxAction) {
    await leadCadenceRepository.markScheduledActionStatus(domain, caseId, pendingCxAction.key, "completed", {
      currentStage:
        normalizedOutcome === "voicemail"
          ? "cx-call-voicemail"
          : normalizedOutcome === "did_not_connect"
            ? "cx-call-no-answer"
            : normalizedOutcome === "dnc"
              ? "cx-call-dnc"
              : "cx-call-answered",
    });
    await leadCadenceRepository.syncLeadCadenceState(domain, caseId).catch(() => null);
  }
  if (countableBulkTerminalAttempt) {
    await markLeadCxTouchState({
      domain,
      caseId,
      queueItem,
      payload,
      placedAt: safeOutcomeAt,
      confirmedCall: true,
    }).catch(() => null);
  }
  const leadCadenceSet = {
    "counterCadence.cxNoAnswerCalls": nextCxNoAnswerCalls,
    "payloadSnapshot.cxNoAnswerCalls": nextCxNoAnswerCalls,
    "payloadSnapshot.cxAnsweredContacts": nextCxAnsweredContacts,
  };
  if (nonConnectOutcome) {
    leadCadenceSet["counterCadence.lastCxNoAnswerAt"] = safeOutcomeAt;
    leadCadenceSet["payloadSnapshot.lastCxNoAnswerAt"] = safeOutcomeAt;
  }
  if (contactOutcome) {
    leadCadenceSet["counterCadence.cxAnsweredContacts"] = nextCxAnsweredContacts;
    leadCadenceSet["counterCadence.lastCxAnsweredAt"] = safeOutcomeAt;
    leadCadenceSet["payloadSnapshot.lastCxAnsweredAt"] = safeOutcomeAt;
  }
  if (normalizedOutcome === "dnc") {
    leadCadenceSet["counterCadence.lastCxDncAt"] = safeOutcomeAt;
    leadCadenceSet["payloadSnapshot.lastCxDncAt"] = safeOutcomeAt;
  }
  await LeadCadence.updateOne(
    { domain, caseId },
    { $set: leadCadenceSet },
  ).catch(() => null);

  const currentPlan = normalizeCallPlanForQueueFamily(
    queueItem.callPlan || null,
    queueItem.queueFamily || queueItem.metadata?.queueFamily,
  );
  const nextDelayMinutes = Number.isFinite(Number(currentPlan.nextDelayMinutes))
    ? Number(currentPlan.nextDelayMinutes)
    : null;
  const baseMetadata = {
    ...terminalMetadata,
    answeredContacts: nextCxAnsweredContacts,
    cxAnsweredContacts: nextCxAnsweredContacts,
    unansweredCalls: nextCxNoAnswerCalls,
    noAnswerCalls: nextCxNoAnswerCalls,
    cxNoAnswerCalls: nextCxNoAnswerCalls,
    lastQueueAttemptHeldForDisposition: false,
    wrapUpRequired: false,
    wrapUpReason: null,
    ...(countableBulkTerminalAttempt
      ? {
        lastTerminalAttemptCountedAt: safeOutcomeAt,
        lastTerminalAttemptCountedUii: terminalMetadata.lastTerminalOutcomeUii,
      }
      : {}),
  };
  const projectedQueueItem = {
    ...queueItem,
    ...Object.fromEntries(
      Object.entries(terminalAttemptPatch).filter(([key]) => !key.startsWith("metadata.")),
    ),
    metadata: {
      ...(queueItem.metadata || {}),
      ...Object.fromEntries(
        Object.entries(terminalAttemptPatch)
          .filter(([key]) => key.startsWith("metadata."))
          .map(([key, value]) => [key.slice("metadata.".length), value]),
      ),
      ...baseMetadata,
    },
  };
  const postOutcomeDialability = resolveQueueDialability(projectedQueueItem, safeOutcomeAt);
  const terminalPolicyHold = Boolean(
    postOutcomeDialability?.ok === false && postOutcomeDialability.lifecycleHold?.terminal,
  );
  let queueMutation = null;
  if (contactOutcome || nextDelayMinutes == null || terminalPolicyHold) {
    queueMutation = await completeCxQueueItem({
      queueItemId: String(queueItem._id),
      queueOutcome:
        normalizedOutcome === "dnc"
          ? "dnc"
          : normalizedOutcome === "answered"
            ? "answered"
            : "cadence-finished",
      disposition: normalizedOutcome,
      extraUpdate: {
        ...terminalAttemptPatch,
        metadata: {
          ...baseMetadata,
          lastPolicyHoldReason: terminalPolicyHold ? postOutcomeDialability.reason : null,
          lastPolicyHoldReleaseAt: terminalPolicyHold ? postOutcomeDialability.nextEligibleAt || null : null,
        },
      },
    });
  } else {
    const timing = resolveQueueDialTimeWindow(
      queueItem,
      new Date(safeOutcomeAt.getTime() + Math.max(nextDelayMinutes, 0) * 60 * 1000),
    );
    queueMutation = await rescheduleCxQueueItem({
      queueItemId: String(queueItem._id),
      releaseAt: timing.nextAllowedAt,
      reason: `terminal-${normalizedOutcome}`,
      actorEmail: payload.actorEmail || payload.agentEmail || null,
      cancelRingcxInBackground: true,
      extraUpdate: {
        ...terminalAttemptPatch,
        metadata: {
          ...baseMetadata,
          terminalOutcomeNextDelayMinutes: nextDelayMinutes,
        },
      },
    });
  }

  const uii = terminalMetadata.lastTerminalOutcomeUii;
  if (uii) {
    await callLogRepository.upsertCallLog({
      domain,
      telephonySessionId: uii,
      direction: "outbound",
      caseId,
      phone: payload.phone || queueItem.phone || null,
      extensionId: queueItem.assignment?.extensionId || payload.assignedExtensionId || null,
      executionOwner: "ringcentral-cx",
      platform: "cx",
      missed: nonConnectOutcome,
      callEndTime: safeOutcomeAt,
      "ringcx.queueItemId": String(queueItem._id),
      "ringcx.externId": queueItem.metadata?.rcxVisibilityExternId || payload.externId || null,
      "ringcx.agentEmail": payload.actorEmail || payload.agentEmail || null,
      "ringcx.actionKey": payload.actionKey || queueItem.metadata?.actionKey || null,
      "ringcx.terminalSource": payload.sourceService || payload.source || "ringcentral-cx",
      audit: {
        dispatchSource: "cx-terminal-outcome",
        intent: contactOutcome ? "cx-contact-terminal-outcome" : "cx-non-connect-fast-advance",
        normalizedOutcome,
        matchedValue: classification.matchedValue,
        queueItemId: String(queueItem._id),
      },
    }).catch(() => null);
  }

  const agentClear = await clearAgentCxCallStateForTerminalOutcome(queueItem, {
    ...payload,
    normalizedOutcome,
  }, safeOutcomeAt).catch((error) => ({
    ok: false,
    error: error.message || "agent-clear-failed",
  }));
  let eligibilityKick = null;
  const extensionId = String(
    queueItem.assignment?.extensionId ||
      payload.assignedExtensionId ||
      "",
  ).trim();
  // Do NOT advance the agent if the CX clear was SKIPPED because they are still on a live CX call
  // (missing-uii-active-cx-call / different-active-cx-call). Kicking eligibility here would serve a
  // fresh lead off a still-active call — the Tracey->Veronica class of bug.
  if (extensionId && agentClear?.skipped) {
    eligibilityKick = { ok: false, skipped: true, reason: agentClear.reason || "cx-clear-skipped" };
  } else if (extensionId) {
    try {
      const { onAgentBecomesEligible } = require("./freshLeadAssignmentService");
      eligibilityKick = await onAgentBecomesEligible(extensionId);
    } catch (error) {
      eligibilityKick = { ok: false, error: error.message || "eligibility-kick-failed" };
    }
  }

  await recordWorkflowStage({
    domain,
    family: "cx",
    subtype: "terminal-call-outcome",
    stage: "completed",
    aggregateType: "cx-dial-queue",
    aggregateId: String(queueItem._id),
    caseId,
    sourceService: "ringcentral-cx",
    title: "CX terminal outcome advanced queue",
    summary:
      normalizedOutcome === "voicemail"
        ? "RingCX reported voicemail; queue advanced without Logics disposition"
        : normalizedOutcome === "did_not_connect"
          ? "RingCX reported no answer; queue advanced without Logics disposition"
          : normalizedOutcome === "dnc"
            ? "Bulk DNC disposition completed the queue item"
            : "Bulk answered disposition completed the queue item",
    payload,
    result: {
      classification,
      queueMutation,
      agentClear,
      eligibilityKick,
      // Call identity so the wallboard can match a terminal row to the LIVE call
      // (stronger than queueItemId/caseId — the Tracey->Veronica anti-flicker class).
      uii: String(
        payload.uii || payload.telephonySessionId || payload.callSessionId
        || queueItem?.metadata?.lastTerminalOutcomeUii || queueItem?.metadata?.lastDialExecutionUii || "",
      ).trim() || null,
      callSessionId: String(
        payload.callSessionId || payload.telephonySessionId
        || queueItem?.metadata?.lastDialExecutionCallSessionId || "",
      ).trim() || null,
    },
  }).catch(() => null);

  return {
    ok: true,
    advanced: true,
    queueItemId: String(queueItem._id),
    caseId,
    classification,
    queueMutation,
    agentClear,
    eligibilityKick,
  };
}

function buildCxCadenceHandlers() {
  return {
    [CX_CADENCE_EVENT_TYPES.DIAL_REQUESTED]: (event) => queueCxDialRequest(event.payload || {}),
    [CX_CADENCE_EVENT_TYPES.CALL_PLACED]: (event) => handleCxCallPlaced(event.payload || {}),
    [CX_CADENCE_EVENT_TYPES.CALL_TERMINAL_OUTCOME]: (event) => handleCxTerminalCallOutcome(event.payload || {}),
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

async function processCreatedCxCadenceEventInline(event, options = {}) {
  if (!event?._id) return { handled: false, reason: "missing-event" };

  const workerName = options.workerName || "ringcentral-cx-cadence-inline";
  const maxAttempts = options.maxAttempts || 5;
  const handlers = buildCxCadenceHandlers();
  const handler = handlers[event.eventType];
  if (!handler) return { handled: false, reason: "no-handler" };

  const startedAt = new Date();
  event.status = EVENT_STATUS.PROCESSING;
  event.lastWorker = workerName;
  event.attemptCount = Math.max(Number(event.attemptCount || 0), 0) + 1;
  event.attempts = [
    ...(Array.isArray(event.attempts) ? event.attempts : []),
    {
      worker: workerName,
      status: EVENT_STATUS.PROCESSING,
      startedAt,
    },
  ];
  await event.save();

  try {
    const handlerResult = await handler(event);
    await markCompleted(event._id, workerName);
    return {
      handled: true,
      eventId: String(event._id),
      handlerResult,
    };
  } catch (error) {
    await markFailed(event._id, workerName, error, maxAttempts);
    return {
      handled: false,
      eventId: String(event._id),
      error: error.message || "inline-cadence-handler-failed",
    };
  }
}

async function releaseCxQueueBatch(options = {}) {
  const now = options.now || new Date();
  const releaseExpiredAssignments =
    String(process.env.RC_CX_RELEASE_EXPIRED_ASSIGNMENTS_ENABLED || "true").toLowerCase() !== "false";
  const releaseStaleServing =
    String(process.env.RC_CX_RELEASE_STALE_SERVING_ENABLED || "true").toLowerCase() !== "false";
  const promotedDialingClaims = releaseExpiredAssignments
    ? await promoteExpiredDialingClaims(now, options.limit || 50)
    : [];
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
    promotedDialingClaimsCount: promotedDialingClaims.length,
    requeuedCount: requeued.length,
    staleServingRequeuedCount: staleServing.length,
    releasedCount: released.length,
    promotedDialingClaims,
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
  if (options.skipOrderingBackfill !== true) {
    await maybeBackfillCxQueueOrdering(options.domain || null, options.orderingBackfillLimit || 250, {
      forceOrderingBackfill: options.forceOrderingBackfill === true,
    }).catch(() => null);
  }
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
        routeCampaigns: Array.isArray(options.routeCampaigns) ? options.routeCampaigns : [],
        randomize: Boolean(options.randomize),
        preferQueueFamilyOrder: options.preferQueueFamilyOrder !== false,
        createdAtGte: options.createdAtGte || options.windowStart || null,
        createdAtLte: options.createdAtLte || options.windowEnd || null,
        excludeLastTouchedExtensionId: options.extensionId || null,
      },
    );
    if (!claimed) break;
    const claimedObject = await hydrateClaimedQueueItemCxTouchState(
      claimed.toObject ? claimed.toObject() : claimed,
    );
    const claimedFamily = deriveQueueFamily(claimedObject);
    const dialability = resolveQueueDialability({
      ...claimedObject,
      queueFamily: claimedFamily,
    }, new Date());
    if (dialability.ok) {
      item = claimedObject;
      break;
    }

    const terminalPolicyHold = Boolean(dialability.lifecycleHold?.terminal);
    if (terminalPolicyHold) {
      await completeCxQueueItem({
        queueItemId: String(claimedObject._id),
        queueOutcome: "cadence-finished",
        disposition: dialability.reason,
        extraUpdate: {
          metadata: {
            lastPolicyHoldAt: new Date(),
            lastPolicyHoldReason: dialability.reason,
            lastPolicyHoldDetail: dialability.detail || null,
            queueFamily: claimedFamily,
            lastPolicyHoldDailyCount: dialability.dailyCount,
            lastPolicyHoldDailyMax: dialability.dailyMax,
            lastPolicyHoldHourlyCount: dialability.hourlyCount,
            lastPolicyHoldHourlyMax: dialability.hourlyMax,
            lastPolicyHoldReleaseAt: null,
          },
        },
      }).catch(() => null);
    } else {
      await cxDialQueueRepository.transitionQueueItemState(claimedObject._id, ["claimed"], {
        state: "queued",
        claimUntil: null,
        releaseAt: dialability.nextEligibleAt || new Date(Date.now() + 30 * 60 * 1000),
        "metadata.lastPolicyHoldAt": new Date(),
        "metadata.lastPolicyHoldReason": dialability.reason,
        "metadata.lastPolicyHoldDetail": dialability.detail || null,
        "metadata.queueFamily": claimedFamily,
        "metadata.lastPolicyHoldDailyCount": dialability.dailyCount,
        "metadata.lastPolicyHoldDailyMax": dialability.dailyMax,
        "metadata.lastPolicyHoldHourlyCount": dialability.hourlyCount,
        "metadata.lastPolicyHoldHourlyMax": dialability.hourlyMax,
        "metadata.lastPolicyHoldReleaseAt": dialability.nextEligibleAt || null,
      }, {
        match: buildQueueItemMutationMatch(claimedObject),
      }).catch(() => null);
    }
    policySkipped.push({
      queueItemId: claimedObject?._id ? String(claimedObject._id) : null,
      caseId: Number(claimedObject?.caseId || 0) || null,
      queueFamily: deriveQueueFamily(claimedObject),
      reason: dialability.reason,
      terminal: terminalPolicyHold,
      releaseAt: dialability.nextEligibleAt || null,
      dailyCount: dialability.dailyCount,
      dailyMax: dialability.dailyMax,
      hourlyCount: dialability.hourlyCount,
      hourlyMax: dialability.hourlyMax,
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
    requireFreshLogicsStatus: true,
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

  const timing = resolveQueueDialTimeWindow(item, new Date());
  if (!timing.allowed) {
    await cxDialQueueRepository.transitionQueueItemState(item._id, ["claimed"], {
      state: "queued",
      claimUntil: null,
      releaseAt: timing.nextAllowedAt,
    }, {
      match: buildQueueItemMutationMatch(item),
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
        queueFamilies: assignmentScope === "non-fresh" ? ["fresh-day2to10", "fresh-day16to30", "aged"] : [],
      });
    const agents = extensionId
      ? await listEligibleAgentsForCx(item.domain, [extensionId])
      : await listEligibleAgentsForCx(item.domain, candidateExtensionIds);
    const ranking = rankAgentsForQueueItem(agents, item, {
      openAssignmentMap,
      openAssignmentFamilyMaps,
      maxOpenAssignments: options.maxOpenAssignments,
      scopedOpenAssignmentMap: true,
      ignoreActivityState: options.ignoreActivityState === true,
      ignoreDrainBeforeRefill: options.ignoreDrainBeforeRefill === true,
    });
    if (!ranking.selected) {
      const rankedAgents = formatRankedAgents(ranking, openAssignmentMap);
      const blockedOnlyByLastAgent =
        rankedAgents.length > 0
        && rankedAgents.every((entry) =>
          String(entry.reasonCode || entry.reason || "").trim() === "last-agent-called-lead");

      if (
        blockedOnlyByLastAgent
        && options.skipLastAgentBlockedItems !== false
        && Number(options._lastAgentSkipDepth || 0) < maxClaimAttempts
      ) {
        const skipMinutes = Math.max(
          Number(process.env.RC_CX_LAST_AGENT_SKIP_MINUTES) || 10,
          1,
        );
        await cxDialQueueRepository.transitionQueueItemState(item._id, ["claimed"], {
          state: "queued",
          claimUntil: null,
          releaseAt: new Date(Date.now() + skipMinutes * 60 * 1000),
          "metadata.lastPolicyHoldAt": new Date(),
          "metadata.lastPolicyHoldReason": "last-agent-called-lead",
          "metadata.lastPolicyHoldDetail": "Skipped during assignment so the next eligible lead can be served.",
          "metadata.lastPolicyHoldReleaseAt": new Date(Date.now() + skipMinutes * 60 * 1000),
        }, {
          match: buildQueueItemMutationMatch(item),
        }).catch(() => null);

        return claimNextCxQueueItem({
          ...options,
          _lastAgentSkipDepth: Number(options._lastAgentSkipDepth || 0) + 1,
        });
      }

      await cxDialQueueRepository.transitionQueueItemState(item._id, ["claimed"], {
        state: "ready",
        claimUntil: null,
      }, {
        match: buildQueueItemMutationMatch(item),
      });
      return {
        ok: true,
        claimed: false,
        skipped: true,
        reason: "no-eligible-agents",
        detail: "No eligible CX agents were available for this queue family.",
        queueFamily: ranking.queueFamily,
        rankedAgents,
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
    const assignmentPackMetadata = options.assignmentPackId
      ? {
        "metadata.assignmentPackId": String(options.assignmentPackId),
        "metadata.assignmentPackFamily": options.assignmentPackFamily || assignedQueueFamily,
        "metadata.assignmentPackTarget": Number(options.assignmentPackTarget || 0) || null,
        "metadata.assignmentPackCreatedAt": options.assignmentPackCreatedAt || assignedAt,
        "metadata.assignmentPackSource": options.assignmentPackSource || "cx-queue-assignment",
      }
      : {};

    const updatedQueueItem = await cxDialQueueRepository.transitionQueueItemState(item._id, ["claimed"], {
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
      ...buildClearedDialRuntimeMetadata({
        now: assignedAt,
        reason: "new-assignment",
      }),
      ...assignmentPackMetadata,
    }, {
      match: buildQueueItemMutationMatch(item),
      returnNew: true,
    });
    if (!updatedQueueItem) {
      await decrementAgentOpenAssignments(selectedAgent.extensionId).catch(() => null);
      return {
        ok: true,
        claimed: false,
        skipped: true,
        reason: "queue-assignment-race",
        detail: "The queue item changed before assignment could be finalized.",
        queueFamily: assignedQueueFamily,
        rankedAgents: formatRankedAgents(ranking, openAssignmentMap),
      };
    }
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

  await maybeBackfillCxQueueOrdering(options.domain || null, options.orderingBackfillLimit || 250, {
    forceOrderingBackfill: options.forceOrderingBackfill === true,
  }).catch(() => null);

  for (let index = 0; index < maxCount; index += 1) {
    const result = await claimNextCxQueueItem({
      domain: options.domain || null,
      claimMinutes: options.claimMinutes || 5,
      extensionId: options.extensionId || null,
      candidateExtensionIds: Array.isArray(options.candidateExtensionIds)
        ? options.candidateExtensionIds
        : [],
      queueFamilies,
      routeCampaigns: Array.isArray(options.routeCampaigns) ? options.routeCampaigns : [],
      randomize: Boolean(options.randomize),
      preferQueueFamilyOrder: options.preferQueueFamilyOrder !== false,
      maxOpenAssignments: options.maxOpenAssignments,
      maxOpenAssignmentsScope: options.maxOpenAssignmentsScope || null,
      createdAtGte: options.createdAtGte || options.windowStart || null,
      createdAtLte: options.createdAtLte || options.windowEnd || null,
      ignoreActivityState: options.ignoreActivityState === true,
      ignoreDrainBeforeRefill: options.ignoreDrainBeforeRefill === true,
      assignmentPackId: options.assignmentPackId || null,
      assignmentPackFamily: options.assignmentPackFamily || null,
      assignmentPackTarget: options.assignmentPackTarget || null,
      assignmentPackCreatedAt: options.assignmentPackCreatedAt || null,
      assignmentPackSource: options.assignmentPackSource || null,
      requestKey: `${requestKeyPrefix}:${index + 1}`,
      skipOrderingBackfill: true,
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

function buildClearedDialRuntimeMetadata({ now = new Date(), reason = null } = {}) {
  return {
    // M3 FM-8c — null the reservation lease on every clear/complete/reschedule/assign so a
    // requeued row never keeps a stale lease that the M2 reaper-exclusion would pin with no
    // live owner. reserveReadyRows (M1) is the ONLY writer of these; the assigner and reserve
    // paths are mutually exclusive per row (see M3 Wires/Why — invariant to preserve).
    "metadata.reservationSessionId": null,
    "metadata.reservedAt": null,
    "metadata.reservationExpiresAt": null,
    "metadata.lastDialIntent": null,
    "metadata.lastDialIntentAt": null,
    "metadata.lastDialIntentWorkflowId": null,
    "metadata.lastDialIntentEventId": null,
    "metadata.lastDialIntentSource": null,
    "metadata.lastDialIntentAssignedExtensionId": null,
    "metadata.lastDialIntentPhone": null,
    "metadata.lastDialIntentQueueState": null,
    "metadata.lastDialIntentStatus": null,
    "metadata.lastDialIntentRelay": null,
    "metadata.lastDialIntentLocalStage": null,
    "metadata.lastDialIntentReleaseReason": null,
    "metadata.lastDialIntentReleasedAt": null,
    "metadata.lastDialIntentTimeoutAt": null,
    "metadata.lastDialIntentTimeoutStage": null,
    "metadata.lastDialExecutionStatus": null,
    "metadata.lastDialExecutionMode": null,
    "metadata.lastDialExecutionAt": null,
    "metadata.lastDialExecutionAgentEmail": null,
    "metadata.lastDialExecutionDialerExtensionId": null,
    "metadata.lastDialExecutionDialerCxAgentId": null,
    "metadata.lastDialExecutionDialerEmail": null,
    "metadata.lastDialExecutionPhone": null,
    "metadata.lastDialExecutionCallerId": null,
    "metadata.lastDialExecutionUii": null,
    "metadata.lastDialExecutionCallSessionId": null,
    "metadata.lastDialExecutionUcqQueueItemId": null,
    "metadata.lastDialExecutionActiveCall": null,
    "metadata.lastDialExecutionActiveCallCapture": null,
    "metadata.lastDialExecutionCampaignId": null,
    "metadata.lastDialExecutionDialGroupId": null,
    "metadata.lastDialExecutionAccountId": null,
    "metadata.lastDialExecutionExternId": null,
    "metadata.lastDialExecutionRingcxPublish": null,
    "metadata.lastDialExecutionResponse": null,
    "metadata.lastDialExecutionError": null,
    "metadata.lastDialExecutionSource": null,
    "metadata.lastDialExecutionEventId": null,
    "metadata.rcxVisibilityStatus": null,
    "metadata.rcxVisibilityReason": null,
    "metadata.rcxVisibilityAccountId": null,
    "metadata.rcxVisibilityAgentUsername": null,
    "metadata.rcxVisibilityAgentId": null,
    "metadata.rcxVisibilityAssignedExtensionId": null,
    "metadata.rcxVisibilityCampaignId": null,
    "metadata.rcxVisibilityDialGroupId": null,
    "metadata.rcxVisibilityExternId": null,
    "metadata.rcxVisibilityLastError": null,
    "metadata.lastHangupActiveCallCapture": null,
    "metadata.lastHangupActiveCallCaptureAt": null,
    "metadata.lastHangupRequestStatus": null,
    "metadata.lastHangupRequestAt": null,
    "metadata.lastHangupRequestUii": null,
    "metadata.lastHangupRequestPhone": null,
    "metadata.lastHangupRequestBy": null,
    "metadata.lastHangupRequestSource": null,
    "metadata.lastHangupRequestCampaignId": null,
    "metadata.lastHangupRequestDialGroupId": null,
    "metadata.lastHangupRequestResponse": null,
    "metadata.lastHangupRequestHangupStatus": null,
    "metadata.lastHangupRequestDisposition": null,
    "metadata.lastHangupRequestRcxDisposition": null,
    "metadata.lastHangupRequestRcxDispositionAccepted": null,
    "metadata.lastHangupRequestDispositionStatus": null,
    "metadata.lastHangupRequestDispositionResponse": null,
    "metadata.lastHangupRequestDispositionAttempts": null,
    "metadata.lastHangupRequestForceRcxDisposition": null,
    "metadata.lastHangupRequestAutoDispositionRelease": null,
    "metadata.lastHangupRequestDispositionError": null,
    "metadata.lastHangupRequestError": null,
    "metadata.lastHangupIntent": null,
    "metadata.lastHangupIntentAt": null,
    "metadata.lastHangupIntentWorkflowId": null,
    "metadata.lastHangupIntentStatus": null,
    "metadata.lastHangupIntentRelay": null,
    "metadata.lastDispositionHangupIntent": null,
    "metadata.lastDispositionHangupIntentAt": null,
    "metadata.lastDispositionHangupIntentStatus": null,
    "metadata.lastDispositionHangupIntentRelay": null,
    "metadata.lastDispositionHangupBackgroundRelay": null,
    "metadata.lastDispositionHangupBackgroundRelayAt": null,
    "metadata.lastDispositionHangupBackgroundRelayAccepted": null,
    "metadata.lastQueueAttemptHeldForDisposition": null,
    "metadata.wrapUpRequired": null,
    "metadata.wrapUpStartedAt": null,
    "metadata.wrapUpStartedWorkflowId": null,
    "metadata.wrapUpReason": null,
    "metadata.assignmentReleasedByHangup": null,
    "metadata.assignmentPackId": null,
    "metadata.assignmentPackFamily": null,
    "metadata.assignmentPackTarget": null,
    "metadata.assignmentPackCreatedAt": null,
    "metadata.assignmentPackSealedAt": null,
    "metadata.assignmentPackSource": null,
    "metadata.dealHandoffHold": null,
    "metadata.dialRuntimeClearedAt": now,
    "metadata.dialRuntimeClearedReason": reason || "queue-transition",
  };
}

function assertQueueItemMatchesMutationContext(item = null, options = {}) {
  if (!item) return;
  const expectedDomain = normalizeDomain(options.domain);
  const actualDomain = normalizeDomain(item.domain);
  if (expectedDomain && actualDomain && expectedDomain !== actualDomain) {
    const error = new Error("CX queue item does not belong to the requested domain");
    error.status = 409;
    throw error;
  }

  const expectedCaseId = Number(options.caseId);
  const actualCaseId = Number(item.caseId);
  if (
    Number.isFinite(expectedCaseId)
    && Number.isFinite(actualCaseId)
    && expectedCaseId !== actualCaseId
  ) {
    const error = new Error("CX queue item does not belong to the requested case");
    error.status = 409;
    throw error;
  }
}

function buildQueueItemMutationMatch(item = null, options = {}) {
  const match = {};
  const domain = normalizeDomain(options.domain || item?.domain);
  if (domain) match.domain = domain;
  const caseId = Number(options.caseId ?? item?.caseId);
  if (Number.isFinite(caseId)) match.caseId = caseId;
  const assignedExtensionId = String(item?.assignment?.extensionId || "").trim();
  if (assignedExtensionId) match["assignment.extensionId"] = assignedExtensionId;
  else if (options.matchAssignment !== false) {
    match.$or = [
      { "assignment.extensionId": { $exists: false } },
      { "assignment.extensionId": null },
      { "assignment.extensionId": "" },
    ];
  }
  return match;
}

function isBulkLoadOwnedCxQueueItem(item = null) {
  const metadata = item?.metadata && typeof item.metadata === "object" ? item.metadata : {};
  return (
    String(metadata.reservationRail || "").trim() === "bulk_load" ||
    Boolean(String(metadata.bulkLoadSessionId || "").trim())
  );
}

function shouldBypassHeldGateForBulkTerminal({ payload = {}, queueItem = null, queueState = "" } = {}) {
  const source = String(payload.sourceService || payload.source || "").trim().toLowerCase();
  if (source !== "cx-bulk-load") return false;
  if (!isBulkLoadOwnedCxQueueItem(queueItem)) return false;
  const state = String(queueState || queueItem?.state || "").trim().toLowerCase();
  if (!["claimed", "serving"].includes(state)) return false;
  const uii = normalizeExternalId(payload.uii || payload.callSessionId);
  return Boolean(uii);
}

async function resolveQueueItemForMutation(options = {}) {
  const queueItemId = String(options.queueItemId || "").trim();
  if (queueItemId) {
    const item = await cxDialQueueRepository.findQueueItemById(queueItemId);
    const queueItem = item ? (item.toObject ? item.toObject() : item) : null;
    assertQueueItemMatchesMutationContext(queueItem, options);
    return queueItem;
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
  if (isBulkLoadOwnedCxQueueItem(item) && options.allowBulkLoadRelease !== true) {
    return {
      ok: false,
      mutated: false,
      reason: "bulk-load-owned-queue-item",
      queueItemId: String(item._id),
      caseId: Number(item.caseId),
      state: item.state || null,
    };
  }

  const now = options.now ? new Date(options.now) : new Date();
  const releaseAt = options.releaseAt ? new Date(options.releaseAt) : now;
  const previousAssignment = cloneAssignment(item.assignment);
  const ringcxCancel = await cancelRingcxPublishedCopyForQueueItem(
    item,
    `queue-release:${options.reason || "manual-release"}`,
  );
  const updated = await cxDialQueueRepository.transitionQueueItemState(
    item._id,
    ["queued", "ready", "claimed", "serving", "paused"],
    {
      state: "ready",
      releaseAt,
      claimUntil: null,
      assignment: buildClearedAssignment(),
      completedAt: null,
      cancelledAt: null,
      ...buildClearedDialRuntimeMetadata({
        now,
        reason: options.reason || "manual-release",
      }),
      "metadata.lastReleasedAt": now,
      "metadata.lastReleaseReason": options.reason || "manual-release",
      "metadata.lastReleasedExtensionId": previousAssignment?.extensionId || null,
      "metadata.lastReleasedAgentName": previousAssignment?.agentName || null,
      "metadata.lastReleasedBy": options.actorEmail || null,
      "metadata.lastRingcxReleaseCancel": ringcxCancel,
      ...normalizeExtraQueueUpdate(options.extraUpdate),
    },
    {
      match: buildQueueItemMutationMatch(item, options),
      returnNew: true,
    },
  );
  if (updated && isOpenAssignedQueueState(item.state) && previousAssignment?.extensionId) {
    await decrementAgentOpenAssignments(previousAssignment.extensionId).catch(() => null);
  }

  return {
    ok: true,
    mutated: Boolean(updated),
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
  const normalizedReason = String(reason || "").trim().toLowerCase();
  const releaseReason = normalizedReason.includes("long-call-hold")
    ? "long-call-hold"
    : normalizedReason.includes("logout")
      ? "logout"
      : "manual-unavailable";
  const releaseSource = releaseReason === "long-call-hold"
    ? "platform-monitor"
    : releaseReason === "logout"
      ? "auth-logout"
      : "cx-workspace";
  const pauseType =
    releaseReason === "logout"
      ? "logout"
      : releaseReason === "long-call-hold"
        ? "long-call-hold"
        : normalizeCxPauseType(agentState?.cxRouting?.pauseType) || "short-break";
  const pauseStartedAt =
    agentState?.cxRouting?.pauseStartedAt
    || agentState?.cxRouting?.manualUnavailableAt
    || now;
  const pauseReleaseAt =
    agentState?.cxRouting?.pauseReleaseAt
    || (pauseType === "logout"
      ? now
      : new Date(new Date(pauseStartedAt).getTime() + getPauseReleaseDelayMs(pauseType)));
  const logoutPresencePatch = releaseReason === "logout"
    ? {
      "appPresence.cxWorkspaceActive": false,
      "appPresence.lastSeenAt": now,
      "appPresence.source": releaseSource,
      "appPresence.userEmail": actorEmail,
      "appPresence.sessionId": null,
      "appPresence.updatedAt": now,
    }
    : {};
  await agentStateRepository.updateAgentState(extensionId, {
    ...(releaseReason === "manual-unavailable" || releaseReason === "logout"
      ? {
        activityState: releaseReason === "logout" ? "offline" : "unavailable",
        lastStatusChange: now,
      }
      : {}),
    lastActivityAt: now,
    "cxRouting.desiredAvailability": "unavailable",
    "cxRouting.reason": releaseReason,
    "cxRouting.syncedAt": now,
    "cxRouting.lastSource": releaseSource,
    "cxRouting.manualUnavailableAt": agentState?.cxRouting?.manualUnavailableAt || now,
    "cxRouting.pauseType": pauseType,
    "cxRouting.pauseStartedAt": pauseStartedAt,
    "cxRouting.pauseReleaseAt": pauseReleaseAt,
    "cxRouting.lastQueueReleaseAt": now,
    "cxRouting.assignmentStats": nextAssignmentStats,
    ...logoutPresencePatch,
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

function getManualUnavailableReleaseDelayMs(pauseType = "short-break") {
  const normalizedPauseType = normalizeCxPauseType(pauseType) || "short-break";
  if (normalizedPauseType !== "short-break") {
    return getPauseReleaseDelayMs(normalizedPauseType);
  }
  const raw =
    process.env.RC_CX_MANUAL_UNAVAILABLE_RELEASE_DELAY_MS
    || process.env.RC_CX_MANUAL_UNAVAILABLE_RELEASE_MS;
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  return getPauseReleaseDelayMs(normalizedPauseType);
}

async function releaseManualUnavailableAgentQueues(options = {}) {
  const enabled =
    String(process.env.RC_CX_MANUAL_UNAVAILABLE_RELEASE_ENABLED || "true").toLowerCase() !== "false";
  if (!enabled) {
    return { ok: true, released: 0, skipped: true, reason: "manual-unavailable-release-disabled" };
  }
  const now = options.now ? new Date(options.now) : new Date();
  const defaultDelayMs = Math.max(Number(options.delayMs ?? getManualUnavailableReleaseDelayMs()) || 0, 0);
  const defaultCutoff = new Date(now.getTime() - defaultDelayMs);
  const agents = await agentStateRepository.listAgentStates({ routingEnabled: true });
  const results = [];

  for (const agent of agents) {
    const routing = agent?.cxRouting && typeof agent.cxRouting === "object" ? agent.cxRouting : {};
    if (String(routing.desiredAvailability || "").trim().toLowerCase() !== "unavailable") continue;
    const reason = String(routing.reason || "").trim().toLowerCase();
    if (!["manual-unavailable", "long-call-hold"].includes(reason)) continue;
    const pauseType = normalizeCxPauseType(routing.pauseType)
      || (reason === "long-call-hold" ? "long-call-hold" : "short-break");
    const manualUnavailableAt = routing.manualUnavailableAt ? new Date(routing.manualUnavailableAt) : null;
    if (!manualUnavailableAt || Number.isNaN(manualUnavailableAt.getTime())) continue;
    const pauseReleaseAt = routing.pauseReleaseAt ? new Date(routing.pauseReleaseAt) : null;
    const releaseAt =
      pauseReleaseAt && !Number.isNaN(pauseReleaseAt.getTime())
        ? pauseReleaseAt
        : new Date(manualUnavailableAt.getTime() + getManualUnavailableReleaseDelayMs(pauseType));
    if (releaseAt > now) continue;
    const lastQueueReleaseAt = routing.lastQueueReleaseAt ? new Date(routing.lastQueueReleaseAt) : null;
    if (lastQueueReleaseAt && !Number.isNaN(lastQueueReleaseAt.getTime()) && lastQueueReleaseAt >= releaseAt) {
      continue;
    }

    const released = await releaseAssignedCxQueueForAgent({
      extensionId: agent.extensionId,
      now,
      reason: reason === "long-call-hold" ? "long-call-hold-timeout" : "manual-unavailable-timeout-logout",
      actorEmail: reason === "long-call-hold" ? "long-call-hold-reaper" : "manual-unavailable-reaper",
    }).catch((error) => ({ ok: false, error: error.message, released: 0, scanned: 0 }));
    results.push({
      extensionId: agent.extensionId,
      name: agent.name || null,
      manualUnavailableAt,
      pauseType,
      releaseAt,
      scanned: released?.scanned || 0,
      released: released?.released || 0,
      error: released?.error || null,
    });
  }

  return {
    ok: true,
    delayMs: defaultDelayMs,
    cutoff: defaultCutoff,
    scannedAgents: agents.length,
    matchedAgents: results.length,
    released: results.reduce((total, entry) => total + Number(entry.released || 0), 0),
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
  const cancelReason = `queue-reschedule:${options.reason || "rescheduled"}`;
  let ringcxCancel = null;
  if (options.cancelRingcxInBackground === true) {
    ringcxCancel = {
      ok: true,
      cancelled: false,
      backgroundPending: true,
      reason: cancelReason,
    };
  } else {
    ringcxCancel = await cancelRingcxPublishedCopyForQueueItem(item, cancelReason);
  }
  const updated = await cxDialQueueRepository.transitionQueueItemState(
    item._id,
    ["queued", "ready", "claimed", "serving", "paused"],
    {
      state: "queued",
      releaseAt,
      claimUntil: null,
      assignment: buildClearedAssignment(),
      completedAt: null,
      cancelledAt: null,
      ...buildClearedDialRuntimeMetadata({
        now,
        reason: options.reason || "rescheduled",
      }),
      "metadata.lastReleasedAt": now,
      "metadata.lastReleaseReason": options.reason || "rescheduled",
      "metadata.lastReleasedExtensionId": previousAssignment?.extensionId || null,
      "metadata.lastReleasedAgentName": previousAssignment?.agentName || null,
      "metadata.lastReleasedBy": options.actorEmail || null,
      "metadata.lastRingcxReleaseCancel": ringcxCancel,
      ...normalizeExtraQueueUpdate(options.extraUpdate),
    },
    {
      match: buildQueueItemMutationMatch(item, options),
      returnNew: true,
    },
  );
  if (updated && options.cancelRingcxInBackground === true) {
    cancelRingcxPublishedCopyForQueueItem(item, cancelReason)
      .then((backgroundCancel) =>
        cxDialQueueRepository.updateQueueItem(item._id, {
          "metadata.lastRingcxReleaseCancel": backgroundCancel,
          "metadata.lastRingcxReleaseCancelAt": new Date(),
        }).catch(() => null),
      )
      .catch((error) =>
        cxDialQueueRepository.updateQueueItem(item._id, {
          "metadata.lastRingcxReleaseCancel": {
            ok: false,
            cancelled: false,
            error: error.message || "ringcx-cancel-copy-failed",
          },
          "metadata.lastRingcxReleaseCancelAt": new Date(),
        }).catch(() => null),
      );
  }
  if (updated && isOpenAssignedQueueState(item.state) && previousAssignment?.extensionId) {
    await decrementAgentOpenAssignments(previousAssignment.extensionId).catch(() => null);
  }

  return {
    ok: true,
    mutated: Boolean(updated),
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
  const markServing = shouldStageDispatchIntentAsServing(options, status);
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
    const allowedStates = markServing
      ? ["claimed", "serving"]
      : markClaimed
        ? ["ready", "claimed"]
        : ["queued", "ready", "claimed", "serving", "paused"];
    updated = await cxDialQueueRepository.transitionQueueItemState(item._id, allowedStates, {
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
    }, {
      match: buildQueueItemMutationMatch(item, {
        domain: normalizedDomain,
        caseId: Number.isFinite(normalizedCaseId) ? normalizedCaseId : null,
      }),
      returnNew: true,
    });
    if (!updated) {
      const error = new Error("CX queue item changed before dispatch intent could be staged");
      error.status = 409;
      throw error;
    }
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
  const updated = await cxDialQueueRepository.transitionQueueItemState(
    item._id,
    ["queued", "ready", "claimed", "serving", "paused"],
    {
      state: "completed",
      claimUntil: null,
      assignment: buildClearedAssignment(),
      completedAt: now,
      ...buildClearedDialRuntimeMetadata({
        now,
        reason: options.queueOutcome || "completed",
      }),
      "metadata.queueOutcome": options.queueOutcome || "completed",
      "metadata.disposition": options.disposition || null,
      "metadata.reflectedLogicsStatusId": options.statusId != null ? Number(options.statusId) : null,
      "metadata.reflectedLogicsStatusCategory": options.statusCategory || null,
      "metadata.reflectedLogicsStatusLabel": options.statusLabel || null,
      "metadata.completedBy": options.actorEmail || null,
      "metadata.completionWorkflowId": options.workflowId || null,
      ...normalizeExtraQueueUpdate(options.extraUpdate),
    },
    {
      match: buildQueueItemMutationMatch(item, options),
      returnNew: true,
    },
  );
  if (updated && isOpenAssignedQueueState(item.state) && previousAssignment?.extensionId) {
    await decrementAgentOpenAssignments(previousAssignment.extensionId).catch(() => null);
  }

  return {
    ok: true,
    mutated: Boolean(updated),
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
  const updated = await cxDialQueueRepository.transitionQueueItemState(
    item._id,
    ["queued", "ready", "claimed", "serving", "paused"],
    {
      state: "cancelled",
      claimUntil: null,
      assignment: buildClearedAssignment(),
      cancelledAt: now,
      ...buildClearedDialRuntimeMetadata({
        now,
        reason: options.reason || "cancelled",
      }),
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
    {
      match: buildQueueItemMutationMatch(item, options),
      returnNew: true,
    },
  );
  if (updated && isOpenAssignedQueueState(item.state) && previousAssignment?.extensionId) {
    await decrementAgentOpenAssignments(previousAssignment.extensionId).catch(() => null);
  }

  return {
    ok: true,
    mutated: Boolean(updated),
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
  const payload = input.payload || {};
  const result = await createEvent({
    eventType: CX_CADENCE_EVENT_TYPES.CALL_PLACED,
    sourceService: input.sourceService || "ringcentral-cx",
    aggregateType: "case",
    aggregateId: String(input.caseId || input.queueItemId || payload.caseId || payload.queueItemId || "cx-call"),
    dedupeKey: input.dedupeKey || null,
    payload,
  });
  if (input.processImmediately === true && !result.deduped && result.event) {
    const inline = await processCreatedCxCadenceEventInline(result.event, {
      workerName: input.workerName || `${input.sourceService || "ringcentral-cx"}-cx-cadence-inline`,
      maxAttempts: input.maxAttempts || 5,
    });
    return {
      ...result,
      inline,
    };
  }
  return result;
}

async function createCxCallTerminalOutcomeEvent(input = {}) {
  return createEvent({
    eventType: CX_CADENCE_EVENT_TYPES.CALL_TERMINAL_OUTCOME,
    sourceService: input.sourceService || "ringcentral-cx",
    aggregateType: "cx-dial-queue",
    aggregateId: String(input.queueItemId || input.caseId || "cx-call"),
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
      "fresh-day16to30": { total: 0, queued: 0, ready: 0, claimed: 0, serving: 0, completed: 0, cancelled: 0, paused: 0 },
      aged: { total: 0, queued: 0, ready: 0, claimed: 0, serving: 0, completed: 0, cancelled: 0, paused: 0 },
      dead: { total: 0, queued: 0, ready: 0, claimed: 0, serving: 0, completed: 0, cancelled: 0, paused: 0 },
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
  backfillCxQueueOrdering,
  buildClaimedDialingEvidenceQuery,
  buildClearedDialRuntimeMetadata, // exported for offline M3 reservation-trio-null test; pure
  claimNextCxQueueItem,
  completeCxQueueItem,
  createCxCallPlacedEvent,
  createCxCallTerminalOutcomeEvent,
  buildTerminalAttemptProofPatch,
  classifyCxTerminalOutcome,
  isBulkLoadOwnedCxQueueItem,
  shouldBypassHeldGateForBulkTerminal,
  handleCxTerminalCallOutcome,
  handleCxCallPlaced,
  processCxCadenceEventBatch,
  processNextCxCadenceEvent,
  previewCxAssignment,
  previewCxAssignmentBuild,
  queueCxDialRequest,
  reconcileRequestedCxCadence,
  releaseAssignedCxQueueForAgent,
  releaseManualUnavailableAgentQueues,
  releaseCxQueueItem,
  releaseCxQueueBatch,
  rescheduleCxQueueItem,
  stageCxDispatchIntent,
};
