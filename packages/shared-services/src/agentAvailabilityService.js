"use strict";

const { agentStateRepository } = require("../../shared-repositories/src");
const {
  isLeadServingAllowedAgent,
  isLeadServingExcludedAgent,
} = require("./cxLeadServingEligibilityService");

const EX_BUSY_TELEPHONY_STATUSES = new Set(["callconnected", "onhold"]);
const APP_BUSY_STATUSES = new Set(["oncall"]);
const MANUAL_CX_ROUTING_SOURCES = new Set(["cx-workspace", "agent-toggle", "manual"]);
const DAILY_STAT_KEYS = Object.freeze([
  "hot",
  "day1",
  "day10",
  "aged",
  "totalCalls",
  "cxCalls",
  "exCalls",
  "inboundCalls",
  "outboundCalls",
  "goodCalls",
  "badCalls",
]);
const SHORT_BREAK_TYPE = "short-break";
const MEAL_BREAK_TYPE = "meal-break";
const LONG_CALL_HOLD_TYPE = "long-call-hold";
const LOGOUT_PAUSE_TYPE = "logout";
const COUNTED_BREAK_TYPES = new Set([SHORT_BREAK_TYPE, MEAL_BREAK_TYPE]);

function isExLeadServingGateEnabled() {
  return String(process.env.RC_CX_EX_BUSY_GATE_ENABLED || "false").toLowerCase() === "true";
}

function getLongCallHoldThresholdMs() {
  const raw =
    process.env.RC_CX_LONG_CALL_HOLD_THRESHOLD_MS
    || process.env.RC_CX_LONG_CALL_HOLD_MS;
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  const minutes = Number(process.env.RC_CX_LONG_CALL_HOLD_MINUTES);
  return Math.max(Number.isFinite(minutes) ? minutes : 15, 1) * 60 * 1000;
}

function readDurationMs({ msKeys = [], minutesKeys = [], defaultMinutes = 0 } = {}) {
  for (const key of msKeys) {
    const parsed = Number(process.env[key]);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  for (const key of minutesKeys) {
    const parsed = Number(process.env[key]);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed * 60 * 1000;
  }
  return Math.max(Number(defaultMinutes) || 0, 0) * 60 * 1000;
}

function readCount({ keys = [], defaultValue = 0 } = {}) {
  for (const key of keys) {
    const parsed = Number(process.env[key]);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed);
  }
  return Math.max(Math.floor(Number(defaultValue) || 0), 0);
}

function getPauseReleaseDelayMs(pauseType = SHORT_BREAK_TYPE) {
  const normalized = normalizeCxPauseType(pauseType) || SHORT_BREAK_TYPE;
  if (normalized === MEAL_BREAK_TYPE) {
    return readDurationMs({
      msKeys: ["RC_CX_MEAL_BREAK_MS"],
      minutesKeys: ["RC_CX_MEAL_BREAK_MINUTES"],
      defaultMinutes: 15,
    });
  }
  if (normalized === LONG_CALL_HOLD_TYPE) {
    return readDurationMs({
      msKeys: ["RC_CX_LONG_CALL_RELEASE_MS"],
      minutesKeys: ["RC_CX_LONG_CALL_RELEASE_MINUTES"],
      defaultMinutes: 5,
    });
  }
  if (normalized === LOGOUT_PAUSE_TYPE) return 0;
  return readDurationMs({
    msKeys: [
      "RC_CX_SHORT_BREAK_MS",
      "RC_CX_MANUAL_UNAVAILABLE_RELEASE_DELAY_MS",
      "RC_CX_MANUAL_UNAVAILABLE_RELEASE_MS",
    ],
    minutesKeys: [
      "RC_CX_SHORT_BREAK_MINUTES",
      "RC_CX_MANUAL_UNAVAILABLE_RELEASE_MINUTES",
    ],
    defaultMinutes: 5,
  });
}

function getBreakAllowance(pauseType = SHORT_BREAK_TYPE) {
  const normalized = normalizeCxPauseType(pauseType);
  if (normalized === MEAL_BREAK_TYPE) {
    return readCount({
      keys: ["RC_CX_MEAL_BREAKS_PER_BLOCK"],
      defaultValue: 1,
    });
  }
  if (normalized === SHORT_BREAK_TYPE) {
    return readCount({
      keys: ["RC_CX_SHORT_BREAKS_PER_BLOCK"],
      defaultValue: 2,
    });
  }
  return null;
}

function normalizeCxPauseType(value) {
  const token = String(value || "").trim().toLowerCase();
  if (!token) return null;
  if (["short", "short-break", "five", "5", "5-minute", "5-minute-break", "break"].includes(token)) {
    return SHORT_BREAK_TYPE;
  }
  if (["meal", "meal-break", "lunch", "lunch-break", "fifteen", "15", "15-minute", "15-minute-break"].includes(token)) {
    return MEAL_BREAK_TYPE;
  }
  if (["long-call", "long-call-hold", "call-hold", "call-grace"].includes(token)) {
    return LONG_CALL_HOLD_TYPE;
  }
  if (["logout", "log-out", "signed-out", "auth-logout"].includes(token)) {
    return LOGOUT_PAUSE_TYPE;
  }
  return null;
}

function isCxWorkspacePresenceRequired() {
  return String(process.env.RC_CX_REQUIRE_WORKSPACE_ACTIVE || "true").toLowerCase() !== "false";
}

function getCxWorkspacePresenceTtlMs() {
  const minutes = Math.max(Number(process.env.RC_CX_WORKSPACE_ACTIVE_TTL_MINUTES) || 5, 1);
  return minutes * 60 * 1000;
}

function isCxWorkspacePresenceActive(snapshot = {}, now = new Date()) {
  if (!isCxWorkspacePresenceRequired()) return true;
  const presence = snapshot?.appPresence && typeof snapshot.appPresence === "object"
    ? snapshot.appPresence
    : {};
  if (presence.cxWorkspaceActive !== true) return false;
  const lastSeenAt = presence.lastSeenAt ? new Date(presence.lastSeenAt).getTime() : 0;
  const nowTime = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(lastSeenAt) || !Number.isFinite(nowTime) || lastSeenAt <= 0) return false;
  return lastSeenAt >= nowTime - getCxWorkspacePresenceTtlMs();
}

function getAgentDailyStatsDateKey(date = new Date()) {
  const normalized = date instanceof Date ? date : new Date(date);
  const safeDate = Number.isNaN(normalized.getTime()) ? new Date() : normalized;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(safeDate);
}

function getPacificParts(date = new Date()) {
  const normalized = date instanceof Date ? date : new Date(date);
  const safeDate = Number.isNaN(normalized.getTime()) ? new Date() : normalized;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
  }).formatToParts(safeDate);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(byType.year),
    month: Number(byType.month),
    day: Number(byType.day),
    hour: Number(byType.hour),
  };
}

function formatUtcDateKey(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getAgentBreakBlockDateKey(date = new Date()) {
  const parts = getPacificParts(date);
  const blockDate = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  if (parts.hour < 7) blockDate.setUTCDate(blockDate.getUTCDate() - 1);
  return formatUtcDateKey(blockDate);
}

function normalizeBreakUsage(existing = {}, date = new Date()) {
  const dateKey = getAgentBreakBlockDateKey(date);
  const sameBlock = String(existing?.dateKey || "") === dateKey;
  return {
    dateKey,
    shortBreaksUsed: sameBlock ? Math.max(Number(existing?.shortBreaksUsed || 0), 0) : 0,
    mealBreaksUsed: sameBlock ? Math.max(Number(existing?.mealBreaksUsed || 0), 0) : 0,
    lastBreakType: sameBlock ? existing?.lastBreakType || null : null,
    lastBreakStartedAt: sameBlock ? existing?.lastBreakStartedAt || null : null,
    lastBreakReleaseAt: sameBlock ? existing?.lastBreakReleaseAt || null : null,
  };
}

function breakUsageFieldForType(pauseType) {
  const normalized = normalizeCxPauseType(pauseType);
  if (normalized === SHORT_BREAK_TYPE) return "shortBreaksUsed";
  if (normalized === MEAL_BREAK_TYPE) return "mealBreaksUsed";
  return null;
}

function buildBreakUsageForPause(existingUsage = {}, pauseType, {
  date = new Date(),
  pauseStartedAt = null,
  pauseReleaseAt = null,
  increment = true,
} = {}) {
  const normalized = normalizeCxPauseType(pauseType);
  const usage = normalizeBreakUsage(existingUsage, date);
  const usageField = breakUsageFieldForType(normalized);
  if (!usageField) return usage;
  if (increment) {
    const allowance = getBreakAllowance(normalized);
    const used = Number(usage[usageField] || 0);
    if (allowance != null && used >= allowance) {
      const err = new Error(
        normalized === MEAL_BREAK_TYPE
          ? "15 minute break allowance is used for this work block"
          : "5 minute break allowance is used for this work block",
      );
      err.status = 409;
      err.code = "CX_BREAK_ALLOWANCE_EXHAUSTED";
      err.pauseType = normalized;
      err.allowance = allowance;
      err.used = used;
      throw err;
    }
    usage[usageField] = used + 1;
  }
  usage.lastBreakType = normalized;
  usage.lastBreakStartedAt = pauseStartedAt || date;
  usage.lastBreakReleaseAt = pauseReleaseAt || null;
  return usage;
}

function getBreakUsageSummary(existingUsage = {}, date = new Date()) {
  const usage = normalizeBreakUsage(existingUsage, date);
  const shortAllowance = getBreakAllowance(SHORT_BREAK_TYPE);
  const mealAllowance = getBreakAllowance(MEAL_BREAK_TYPE);
  return {
    ...usage,
    shortBreaksAllowed: shortAllowance,
    shortBreaksRemaining: Math.max(shortAllowance - Number(usage.shortBreaksUsed || 0), 0),
    mealBreaksAllowed: mealAllowance,
    mealBreaksRemaining: Math.max(mealAllowance - Number(usage.mealBreaksUsed || 0), 0),
  };
}

function toValidDate(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

function buildPauseTiming(existingRouting = null, pauseType, now = new Date(), options = {}) {
  const normalized = normalizeCxPauseType(pauseType) || SHORT_BREAK_TYPE;
  const existingType = normalizeCxPauseType(existingRouting?.pauseType);
  const existingReleaseAt = toValidDate(existingRouting?.pauseReleaseAt);
  const existingStartedAt = toValidDate(existingRouting?.pauseStartedAt)
    || toValidDate(existingRouting?.manualUnavailableAt);
  const reuseExisting =
    existingType === normalized
    && existingStartedAt
    && existingReleaseAt
    && (options.reuseExpired === true || existingReleaseAt > now);
  const startedAt = reuseExisting ? existingStartedAt : now;
  const releaseAt = reuseExisting
    ? existingReleaseAt
    : new Date(startedAt.getTime() + getPauseReleaseDelayMs(normalized));
  return {
    pauseType: normalized,
    pauseStartedAt: startedAt,
    pauseReleaseAt: releaseAt,
    reuseExisting,
  };
}

function normalizeDailyStats(existing = {}, date = new Date()) {
  const dateKey = getAgentDailyStatsDateKey(date);
  const sameDay = String(existing?.date || "") === dateKey;
  const stats = { date: dateKey };
  for (const key of DAILY_STAT_KEYS) {
    stats[key] = sameDay ? Number(existing?.[key] || 0) : 0;
  }
  return stats;
}

function incrementDailyStats(existing = {}, increments = {}, date = new Date()) {
  const stats = normalizeDailyStats(existing, date);
  for (const [key, value] of Object.entries(increments || {})) {
    if (!DAILY_STAT_KEYS.includes(key)) continue;
    stats[key] = Number(stats[key] || 0) + Number(value || 0);
  }
  return stats;
}

function buildCallStartStatIncrements({ platform = null, direction = null } = {}) {
  const increments = { totalCalls: 1 };
  const normalizedPlatform = String(platform || "").trim().toLowerCase();
  const normalizedDirection = String(direction || "").trim().toLowerCase();
  if (normalizedPlatform === "cx") increments.cxCalls = 1;
  if (normalizedPlatform === "ex") increments.exCalls = 1;
  if (normalizedDirection === "inbound") increments.inboundCalls = 1;
  if (normalizedDirection === "outbound") increments.outboundCalls = 1;
  return increments;
}

function callIdentity(call = {}) {
  return String(
    call?.telephonySessionId
      || call?.sessionId
      || call?.callSessionId
      || "",
  ).trim();
}

function shouldCountCallStart(previousState = {}, nextCall = {}) {
  const previousCall = previousState?.currentCall && typeof previousState.currentCall === "object"
    ? previousState.currentCall
    : {};
  const previousIdentity = callIdentity(previousCall);
  const nextIdentity = callIdentity(nextCall);
  if (nextIdentity && previousIdentity) return nextIdentity !== previousIdentity;
  const previousStatus = String(previousState?.status || "").trim();
  const previousActivity = String(previousState?.activityState || "").trim();
  return previousStatus !== "onCall" && previousActivity !== "onCall";
}

function applyCallStartedDailyStats(previousState = {}, nextDailyStats = {}, {
  call = {},
  platform = null,
  direction = null,
  date = new Date(),
} = {}) {
  if (!shouldCountCallStart(previousState, call)) {
    return normalizeDailyStats(nextDailyStats || previousState?.dailyStats || {}, date);
  }
  return incrementDailyStats(
    nextDailyStats || previousState?.dailyStats || {},
    buildCallStartStatIncrements({
      platform,
      direction: direction || call?.direction || null,
    }),
    date,
  );
}

function applyCallEndedDailyStats(previousState = {}, nextDailyStats = {}, {
  missed = false,
  date = new Date(),
} = {}) {
  const previousStatus = String(previousState?.status || "").trim();
  const previousActivity = String(previousState?.activityState || "").trim();
  const wasActive = ["onCall", "ringing"].includes(previousStatus)
    || ["onCall", "dialing"].includes(previousActivity);
  if (!wasActive) {
    return normalizeDailyStats(nextDailyStats || previousState?.dailyStats || {}, date);
  }
  return incrementDailyStats(
    nextDailyStats || previousState?.dailyStats || {},
    missed ? { badCalls: 1 } : { goodCalls: 1 },
    date,
  );
}

function routingAssignmentStats(existingRouting = null) {
  return existingRouting?.assignmentStats && typeof existingRouting.assignmentStats === "object"
    ? existingRouting.assignmentStats
    : null;
}

function routingBreakUsage(existingRouting = null, date = new Date()) {
  return getBreakUsageSummary(
    existingRouting?.breakUsage && typeof existingRouting.breakUsage === "object"
      ? existingRouting.breakUsage
      : {},
    date,
  );
}

function clearPauseRoutingFields(existingRouting = null) {
  return {
    pauseType: null,
    pauseStartedAt: null,
    pauseReleaseAt: null,
    breakUsage: routingBreakUsage(existingRouting),
  };
}

function preservePauseRoutingFields(existingRouting = null, fallbackPauseType = null) {
  return {
    pauseType: normalizeCxPauseType(existingRouting?.pauseType) || fallbackPauseType || null,
    pauseStartedAt: existingRouting?.pauseStartedAt || existingRouting?.manualUnavailableAt || null,
    pauseReleaseAt: existingRouting?.pauseReleaseAt || null,
    breakUsage: routingBreakUsage(existingRouting),
  };
}

function preserveManualUnavailableAt(existingRouting = null, desiredAvailability = "available", reason = "manual-unavailable") {
  if (desiredAvailability !== "unavailable") return null;
  if (hasUnavailableReason(existingRouting, reason) && existingRouting?.manualUnavailableAt) {
    return existingRouting.manualUnavailableAt;
  }
  return new Date();
}

function isCxRoutingEnabled(snapshot = {}, existingRouting = null) {
  return (
    Boolean(snapshot.cxAgentId)
    || Boolean(snapshot.cxProfileId)
    || isLeadServingAllowedAgent(snapshot)
    || Boolean(existingRouting?.enabled)
    || /bruce allen/i.test(String(snapshot.name || ""))
  );
}

function hasActiveExCall(snapshot = {}) {
  const currentCall = snapshot.currentCall && typeof snapshot.currentCall === "object"
    ? snapshot.currentCall
    : {};
  const channel = String(currentCall.channel || "").trim().toLowerCase();
  if (channel !== "ex") return false;
  const exTelephonyStatus = String(snapshot.exTelephonyStatus || "").trim().toLowerCase();
  const appStatus = String(snapshot.status || "").trim().toLowerCase();
  const connected = EX_BUSY_TELEPHONY_STATUSES.has(exTelephonyStatus)
    || APP_BUSY_STATUSES.has(appStatus);
  if (!connected) return false;
  return Boolean(
    currentCall.sessionId
      || currentCall.telephonySessionId
      || currentCall.from
      || currentCall.to,
  );
}

function isExBusySnapshot(snapshot = {}) {
  const exTelephonyStatus = String(snapshot.exTelephonyStatus || "").trim().toLowerCase();
  return EX_BUSY_TELEPHONY_STATUSES.has(exTelephonyStatus)
    || hasActiveExCall(snapshot);
}

function hasCxActiveCall(snapshot = {}) {
  const currentCall = snapshot.currentCall && typeof snapshot.currentCall === "object"
    ? snapshot.currentCall
    : {};
  const channel = String(currentCall.channel || "").trim().toLowerCase();
  if (channel !== "cx") return false;
  const activePlatform = String(snapshot.activePlatform || "").trim().toUpperCase();
  const status = String(snapshot.status || "").trim();
  const activityState = String(snapshot.activityState || "").trim();
  return activePlatform === "CX"
    && (status === "onCall" || activityState === "onCall")
    && Boolean(
      currentCall.sessionId
        || currentCall.telephonySessionId
        || currentCall.to
        || currentCall.from,
    );
}

function resolveCurrentCallStartAt(snapshot = {}) {
  const currentCall = snapshot.currentCall && typeof snapshot.currentCall === "object"
    ? snapshot.currentCall
    : {};
  const startedAt = currentCall.startTime ? new Date(currentCall.startTime) : null;
  return startedAt && !Number.isNaN(startedAt.getTime()) ? startedAt : null;
}

function hasLongActiveCall(snapshot = {}, now = new Date()) {
  if (!hasActiveExCall(snapshot) && !hasCxActiveCall(snapshot)) return false;
  const startedAt = resolveCurrentCallStartAt(snapshot);
  if (!startedAt) return false;
  const nowDate = now instanceof Date ? now : new Date(now);
  const ageMs = nowDate.getTime() - startedAt.getTime();
  return Number.isFinite(ageMs) && ageMs >= getLongCallHoldThresholdMs();
}

function hasUnavailableReason(existingRouting = null, expectedReason = "manual-unavailable") {
  const desiredAvailability = String(existingRouting?.desiredAvailability || "").trim().toLowerCase();
  const reason = String(existingRouting?.reason || "").trim().toLowerCase();
  return desiredAvailability === "unavailable"
    && reason === String(expectedReason || "").trim().toLowerCase();
}

function hasManualUnavailable(existingRouting = null) {
  const lastSource = String(existingRouting?.lastSource || "").trim().toLowerCase();
  return hasUnavailableReason(existingRouting, "manual-unavailable")
    && MANUAL_CX_ROUTING_SOURCES.has(lastSource);
}

function deriveCxRouting(snapshot = {}, existingRouting = null) {
  const enabled = isCxRoutingEnabled(snapshot, existingRouting);
  // Ringing is intentionally NOT in the busy set: mailer queue calls
  // ring every agent's phone simultaneously, but only one of them
  // answers. Marking everyone "unavailable" while the queue rings
  // would briefly empty the CX dial pool on every inbound — and then
  // snap back as soon as someone picks up. Only the agent who
  // actually CONNECTS the call (CallConnected / OnHold) should be
  // taken out of the CX dial pool.
  // App-side: same rule — only "onCall" counts. "ringing" is the
  // app-equivalent of Ringing and is treated as transient.

  if (!enabled) {
    return {
      enabled: false,
      desiredAvailability: "available",
      reason: "cx-routing-disabled",
      syncedAt: new Date(),
      lastSource: "ringbridge",
      manualUnavailableAt: null,
      ...clearPauseRoutingFields(existingRouting),
      lastQueueReleaseAt: existingRouting?.lastQueueReleaseAt || null,
      assignmentStats: routingAssignmentStats(existingRouting),
    };
  }

  const longCallHold = hasLongActiveCall(snapshot);

  if (hasManualUnavailable(existingRouting)) {
    return {
      enabled: true,
      desiredAvailability: "unavailable",
      reason: "manual-unavailable",
      syncedAt: new Date(),
      lastSource: "cx-workspace",
      manualUnavailableAt: preserveManualUnavailableAt(existingRouting, "unavailable", "manual-unavailable"),
      ...preservePauseRoutingFields(existingRouting, SHORT_BREAK_TYPE),
      lastQueueReleaseAt: existingRouting?.lastQueueReleaseAt || null,
      assignmentStats: routingAssignmentStats(existingRouting),
    };
  }

  if (longCallHold) {
    const now = new Date();
    const pause = buildPauseTiming(existingRouting, LONG_CALL_HOLD_TYPE, now, { reuseExpired: true });
    return {
      enabled: true,
      desiredAvailability: "unavailable",
      reason: "long-call-hold",
      syncedAt: now,
      lastSource: "platform-monitor",
      manualUnavailableAt: pause.pauseStartedAt,
      pauseType: LONG_CALL_HOLD_TYPE,
      pauseStartedAt: pause.pauseStartedAt,
      pauseReleaseAt: pause.pauseReleaseAt,
      breakUsage: routingBreakUsage(existingRouting, now),
      lastQueueReleaseAt: existingRouting?.lastQueueReleaseAt || null,
      assignmentStats: routingAssignmentStats(existingRouting),
    };
  }

  const busy = isExLeadServingGateEnabled() && isExBusySnapshot(snapshot);

  if (busy) {
    return {
      enabled: true,
      desiredAvailability: "unavailable",
      reason: "ex-busy",
      syncedAt: new Date(),
      lastSource: "ringbridge",
      manualUnavailableAt: null,
      ...clearPauseRoutingFields(existingRouting),
      lastQueueReleaseAt: existingRouting?.lastQueueReleaseAt || null,
      assignmentStats: routingAssignmentStats(existingRouting),
    };
  }

  return {
    enabled: true,
    desiredAvailability: "available",
    reason: "ex-idle",
    syncedAt: new Date(),
    lastSource: "ringbridge",
    manualUnavailableAt: null,
    ...clearPauseRoutingFields(existingRouting),
    lastQueueReleaseAt: existingRouting?.lastQueueReleaseAt || null,
    assignmentStats: routingAssignmentStats(existingRouting),
  };
}

function deriveFreshLeadGate(snapshot = {}, routingOverride = null) {
  const routing = routingOverride
    || (snapshot.cxRouting && typeof snapshot.cxRouting === "object" ? snapshot.cxRouting : null);
  const enabled = isCxRoutingEnabled(snapshot, routing);
  const desiredAvailability = String(
    routing?.desiredAvailability || (enabled ? "available" : "unavailable"),
  ).trim().toLowerCase();
  const routingReason = String(routing?.reason || "").trim().toLowerCase();
  const pauseType = normalizeCxPauseType(routing?.pauseType);
  const exCallActive = isExLeadServingGateEnabled()
    && (isExBusySnapshot(snapshot) || routingReason === "ex-busy");
  const leadServingExcluded = isLeadServingExcludedAgent(snapshot);
  const workspaceRequired = isCxWorkspacePresenceRequired();
  const workspaceActive = isCxWorkspacePresenceActive(snapshot);

  let source = "none";
  if (!enabled) {
    source = "routing-disabled";
  } else if (leadServingExcluded) {
    source = "lead-serving-excluded";
  } else if (exCallActive) {
    source = "ex-call";
  } else if (workspaceRequired && !workspaceActive) {
    source = "app-offline";
  } else if (desiredAvailability === "unavailable" && routingReason === "manual-unavailable") {
    source = "manual";
  } else if (desiredAvailability === "unavailable" && routingReason === "long-call-hold") {
    source = "long-call";
  } else if (desiredAvailability === "unavailable") {
    source = routingReason || "routing";
  }

  const blocked = !enabled
    || leadServingExcluded
    || exCallActive
    || (workspaceRequired && !workspaceActive)
    || desiredAvailability === "unavailable";
  const label = !enabled
    ? "Fresh leads off: routing disabled"
    : leadServingExcluded
      ? "Fresh leads off: lead serving excluded"
    : exCallActive
      ? "Fresh leads paused: EX call"
    : workspaceRequired && !workspaceActive
      ? "Fresh leads paused: CX workspace inactive"
    : routingReason === "long-call-hold"
      ? "Fresh leads paused: long call"
    : routingReason === "manual-unavailable" && pauseType === MEAL_BREAK_TYPE
      ? "Fresh leads paused: 15 minute break"
    : routingReason === "manual-unavailable" && pauseType === SHORT_BREAK_TYPE
      ? "Fresh leads paused: 5 minute break"
      : blocked
        ? "Fresh leads paused"
        : "Fresh leads allowed";
  const detail = !enabled
    ? "This agent profile is not enabled for CX fresh lead routing."
    : leadServingExcluded
      ? "This agent is excluded from automatic lead serving by runtime config."
    : exCallActive
      ? "This agent is on an EX call, so fresh leads stay off until EX returns idle."
    : workspaceRequired && !workspaceActive
      ? "Open the CX workspace to receive leads. RingCentral availability alone is not enough."
    : routingReason === "long-call-hold"
      ? "This agent has been on a call long enough to trigger a timed pause. Ending the call clears the pause before queue release."
    : routingReason === "manual-unavailable" && pauseType === MEAL_BREAK_TYPE
      ? "This agent is on a 15 minute break. Held leads release when the break window expires."
    : routingReason === "manual-unavailable" && pauseType === SHORT_BREAK_TYPE
      ? "This agent is on a 5 minute break. Held leads release when the break window expires."
    : blocked
      ? "Manual pause keeps this agent out of fresh lead serving."
      : "EX is idle and this agent profile can receive fresh leads.";

  return {
    allowed: !blocked,
    blocked,
    source,
    reason: routingReason || null,
    desiredAvailability: desiredAvailability || null,
    pauseType,
    pauseReleaseAt: routing?.pauseReleaseAt || null,
    breakUsage: routingBreakUsage(routing),
    exCallActive,
    leadServingExcluded,
    workspaceRequired,
    workspaceActive,
    label,
    detail,
    updatedAt: routing?.syncedAt || snapshot.lastStatusChange || snapshot.updatedAt || null,
  };
}

// Map presence/call state into a queue-eligibility activityState.
// `idle` = eligible for slices + fresh assignments.
// `onCall` / `dialing` / `dispositioning` / `wrapup` = ineligible.
// `unavailable` = explicit agent toggle, ineligible.
// `offline` = no presence.
function deriveActivityState(snapshot = {}, existingActivityState = null) {
  // Explicit unavail toggle wins (set by SPA action, not derived from RC)
  if (existingActivityState === "unavailable") return "unavailable";

  return deriveTelephonyActivityState(snapshot);
}

function deriveTelephonyActivityState(snapshot = {}) {
  const status = String(snapshot.status || "offline");
  if (status === "onCall") return "onCall";
  if (status === "ringing") {
    const direction = String(snapshot.currentCall?.direction || "").trim().toLowerCase();
    return direction === "outbound" ? "dialing" : "idle";
  }
  if (status === "disposition") return "dispositioning";
  if (status === "available") return "idle";
  if (status === "away") return "unavailable";
  return "offline";
}

function normalizeSnapshot(snapshot = {}, existing = null) {
  return {
    extensionId: snapshot.extensionId,
    cxAgentId: snapshot.cxAgentId || null,
    cxProfileId: snapshot.cxProfileId || null,
    name: snapshot.name,
    company: snapshot.company || "TAG",
    pin: snapshot.pin || null,
    status: snapshot.status || "offline",
    exTelephonyStatus: snapshot.exTelephonyStatus || "NoCall",
    exPresenceStatus: snapshot.exPresenceStatus || "Offline",
    currentCall: snapshot.currentCall || {},
    activePlatform: snapshot.activePlatform || "none",
    activityState: snapshot.activityState
      || deriveActivityState(snapshot, existing?.activityState),
    lastActivityAt: snapshot.lastActivityAt || existing?.lastActivityAt || null,
    lastStatusChange: snapshot.lastStatusChange || new Date(),
    lastEventReceived: snapshot.lastEventReceived || null,
    dailyStats: snapshot.dailyStats || {},
    appPresence: existing?.appPresence || {},
    upstream: {
      source: snapshot.upstream?.source || "ringbridge",
      mirroredAt: snapshot.upstream?.mirroredAt || new Date(),
    },
  };
}

async function mirrorAgentState(snapshot = {}) {
  const existing = snapshot.extensionId
    ? await agentStateRepository.findAgentStateByExtensionId(snapshot.extensionId)
    : null;
  const normalized = normalizeSnapshot(snapshot, existing);
  normalized.cxRouting = deriveCxRouting(normalized, existing?.cxRouting || null);
  if (
    normalized.activityState === "unavailable"
    && normalized.cxRouting?.desiredAvailability === "available"
    && String(existing?.cxRouting?.reason || "").trim().toLowerCase() !== "manual-unavailable"
  ) {
    normalized.activityState = deriveTelephonyActivityState(normalized);
  }
  // If the activityState transitions, bump lastActivityAt. Idempotent
  // when state is unchanged (preserves prior lastActivityAt).
  if (existing?.activityState !== normalized.activityState) {
    normalized.lastActivityAt = new Date();
  }
  return agentStateRepository.upsertAgentState(normalized);
}

// Explicit setter for activityState — used by SPA "make me unavailable"
// toggle, by DialService when a click-to-dial fires (→ "dialing"),
// and by disposition flow (→ "dispositioning" → "idle").
async function setActivityState(extensionId, newState, { source = "manual", breakType = null, pauseType = null } = {}) {
  const existing = await agentStateRepository.findAgentStateByExtensionId(extensionId);
  if (!existing) return null;
  const normalizedSource = String(source || "").trim().toLowerCase();
  if (
    MANUAL_CX_ROUTING_SOURCES.has(normalizedSource)
    && (newState === "unavailable" || newState === "idle")
  ) {
    return setManualCxAvailability(
      extensionId,
      newState === "unavailable" ? "unavailable" : "available",
      { source: normalizedSource, existing, breakType, pauseType },
    );
  }

  return agentStateRepository.updateAgentState(extensionId, {
    activityState: newState,
    lastActivityAt: new Date(),
    "upstream.source": source,
    "upstream.mirroredAt": new Date(),
  });
}

function buildManualCxRouting(existing = {}, desiredAvailability, options = {}) {
  const existingRouting = existing?.cxRouting || null;
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const requestedPauseType =
    normalizeCxPauseType(options.pauseType || options.breakType)
    || (desiredAvailability === "unavailable" ? SHORT_BREAK_TYPE : null);
  const pause = desiredAvailability === "unavailable"
    ? buildPauseTiming(existingRouting, requestedPauseType, now)
    : null;
  const breakUsage = desiredAvailability === "unavailable"
    ? buildBreakUsageForPause(existingRouting?.breakUsage || {}, requestedPauseType, {
      date: now,
      pauseStartedAt: pause.pauseStartedAt,
      pauseReleaseAt: pause.pauseReleaseAt,
      increment: COUNTED_BREAK_TYPES.has(requestedPauseType) && !pause.reuseExisting,
    })
    : routingBreakUsage(existingRouting, now);
  const requestedRouting = {
    enabled: true,
    desiredAvailability,
    reason: desiredAvailability === "unavailable" ? "manual-unavailable" : "manual-available",
    syncedAt: now,
    lastSource: "cx-workspace",
    manualUnavailableAt: pause?.pauseStartedAt || null,
    pauseType: pause?.pauseType || null,
    pauseStartedAt: pause?.pauseStartedAt || null,
    pauseReleaseAt: pause?.pauseReleaseAt || null,
    breakUsage,
    lastQueueReleaseAt: existingRouting?.lastQueueReleaseAt || null,
    assignmentStats: routingAssignmentStats(existingRouting),
  };
  const effectiveRouting = deriveCxRouting(existing || {}, requestedRouting);
  if (desiredAvailability === "available" && effectiveRouting.reason === "ex-idle") {
    effectiveRouting.reason = "manual-available";
    effectiveRouting.lastSource = "cx-workspace";
  }
  if (effectiveRouting.reason === "manual-unavailable") {
    effectiveRouting.lastSource = "cx-workspace";
    effectiveRouting.manualUnavailableAt = pause?.pauseStartedAt || effectiveRouting.manualUnavailableAt || now;
    effectiveRouting.pauseType = pause?.pauseType || requestedPauseType;
    effectiveRouting.pauseStartedAt = pause?.pauseStartedAt || effectiveRouting.manualUnavailableAt;
    effectiveRouting.pauseReleaseAt = pause?.pauseReleaseAt || null;
    effectiveRouting.breakUsage = breakUsage;
  }
  return effectiveRouting;
}

function deriveManualCxActivityState(existing = {}, desiredAvailability, effectiveRouting = null) {
  if (effectiveRouting?.reason === "ex-busy" || effectiveRouting?.reason === "long-call-hold") {
    return deriveTelephonyActivityState(existing);
  }
  if (desiredAvailability === "unavailable") return "unavailable";
  return "idle";
}

async function setManualCxAvailability(
  extensionId,
  desiredAvailability,
  { source = "cx-workspace", existing = null, breakType = null, pauseType = null } = {},
) {
  const normalizedDesiredAvailability = String(desiredAvailability || "").trim().toLowerCase();
  if (!["available", "unavailable"].includes(normalizedDesiredAvailability)) {
    throw new Error('desiredAvailability must be "available" or "unavailable"');
  }

  const existingState = existing
    || await agentStateRepository.findAgentStateByExtensionId(extensionId);
  if (!existingState) return null;

  const effectiveRouting = buildManualCxRouting(existingState, normalizedDesiredAvailability, {
    breakType,
    pauseType,
  });
  return agentStateRepository.updateAgentState(extensionId, {
    activityState: deriveManualCxActivityState(
      existingState,
      normalizedDesiredAvailability,
      effectiveRouting,
    ),
    lastActivityAt: new Date(),
    "cxRouting.enabled": effectiveRouting.enabled,
    "cxRouting.desiredAvailability": effectiveRouting.desiredAvailability,
    "cxRouting.reason": effectiveRouting.reason,
    "cxRouting.syncedAt": effectiveRouting.syncedAt || new Date(),
    "cxRouting.lastSource": effectiveRouting.lastSource || "cx-workspace",
    "cxRouting.manualUnavailableAt": effectiveRouting.manualUnavailableAt || null,
    "cxRouting.pauseType": effectiveRouting.pauseType || null,
    "cxRouting.pauseStartedAt": effectiveRouting.pauseStartedAt || null,
    "cxRouting.pauseReleaseAt": effectiveRouting.pauseReleaseAt || null,
    "cxRouting.breakUsage": routingBreakUsage(effectiveRouting),
    "cxRouting.lastQueueReleaseAt": effectiveRouting.lastQueueReleaseAt || existingState.cxRouting?.lastQueueReleaseAt || null,
    "cxRouting.assignmentStats": routingAssignmentStats(effectiveRouting),
    "upstream.source": source || "cx-workspace",
    "upstream.mirroredAt": new Date(),
  });
}

// Light-weight nudge: bump lastActivityAt without changing state.
// Called on every claim/dispose/dial-click so the idle reaper has
// fresh signal.
async function bumpLastActivityAt(extensionId, { source = null } = {}) {
  const now = new Date();
  const normalizedSource = String(source || "").trim().toLowerCase();
  const patch = { lastActivityAt: now };
  if (MANUAL_CX_ROUTING_SOURCES.has(normalizedSource)) {
    patch["cxRouting.syncedAt"] = now;
    patch["cxRouting.lastSource"] = "cx-workspace";
    patch["upstream.source"] = normalizedSource;
    patch["upstream.mirroredAt"] = now;
  }
  return agentStateRepository.updateAgentState(extensionId, patch);
}

async function touchCxWorkspacePresence(
  extensionId,
  {
    active = true,
    source = "cx-workspace",
    userEmail = null,
    sessionId = null,
  } = {},
) {
  const normalizedExtensionId = String(extensionId || "").trim();
  if (!normalizedExtensionId) return null;
  const now = new Date();
  const isActive = active !== false;
  const normalizedSource = String(source || "cx-workspace").trim().toLowerCase() || "cx-workspace";
  const patch = {
    "appPresence.cxWorkspaceActive": isActive,
    "appPresence.lastSeenAt": now,
    "appPresence.source": normalizedSource,
    "appPresence.userEmail": userEmail ? String(userEmail).trim().toLowerCase() : null,
    "appPresence.sessionId": sessionId ? String(sessionId).trim() : null,
    "appPresence.updatedAt": now,
    "upstream.source": normalizedSource,
    "upstream.mirroredAt": now,
  };
  if (isActive) {
    patch.lastActivityAt = now;
  }
  return agentStateRepository.updateAgentState(normalizedExtensionId, patch);
}

async function listCxAgentStates() {
  return agentStateRepository.listAgentStates();
}

async function getCxAgentStateByExtensionId(extensionId) {
  return agentStateRepository.findAgentStateByExtensionId(extensionId);
}

module.exports = {
  buildManualCxRouting,
  deriveCxRouting,
  deriveActivityState,
  deriveFreshLeadGate,
  applyCallEndedDailyStats,
  applyCallStartedDailyStats,
  buildCallStartStatIncrements,
  getAgentBreakBlockDateKey,
  getCxAgentStateByExtensionId,
  getAgentDailyStatsDateKey,
  getBreakUsageSummary,
  getPauseReleaseDelayMs,
  hasActiveExCall,
  incrementDailyStats,
  isExLeadServingGateEnabled,
  isExBusySnapshot,
  isCxWorkspacePresenceActive,
  isCxWorkspacePresenceRequired,
  listCxAgentStates,
  mirrorAgentState,
  normalizeBreakUsage,
  normalizeCxPauseType,
  normalizeDailyStats,
  shouldCountCallStart,
  setManualCxAvailability,
  setActivityState,
  bumpLastActivityAt,
  touchCxWorkspacePresence,
};
