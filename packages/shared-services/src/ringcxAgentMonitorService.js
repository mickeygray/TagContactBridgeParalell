"use strict";

const { createRingcxVoiceClient } = require("../../shared-integrations/src");
const { CxDialQueue } = require("../../shared-models/src");
const { agentStateRepository } = require("../../shared-repositories/src");
const {
  applyCallEndedDailyStats,
  applyCallStartedDailyStats,
  deriveCxRouting,
  normalizeDailyStats,
} = require("./agentAvailabilityService");
const {
  classifyCxTerminalOutcome,
  handleCxTerminalCallOutcome,
} = require("./cxCadenceService");
const { traceCxCallIdentity } = require("./cxCallTraceService");

function isRingcxAgentMonitorEnabled() {
  return String(process.env.RINGCX_AGENT_MONITOR_ENABLED || "true").toLowerCase() !== "false";
}

function readBooleanEnv(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

function allowWeakRingcxActiveCallMatch() {
  return readBooleanEnv("RINGCX_ACTIVE_CALL_ALLOW_WEAK_MATCH", false);
}

function coerceActiveCallList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.records)) return payload.records;
  if (Array.isArray(payload?.content)) return payload.content;
  if (Array.isArray(payload?.activeCalls)) return payload.activeCalls;
  if (Array.isArray(payload?.items)) return payload.items;
  return [];
}

function normalizeExternalId(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function extractActiveCallUii(call = null) {
  return normalizeExternalId(
    call?.uii
      || call?.UII
      || call?.callId
      || call?.callID
      || call?.activeCallId
      || call?.id,
  );
}

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D+/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  if (digits.length >= 10) return digits.slice(-10);
  return digits || null;
}

function phoneValuesCouldMatch(left, right) {
  const a = normalizePhone(left);
  const b = normalizePhone(right);
  if (!a || !b) return false;
  if (a === b) return true;
  return a.length >= 4 && b.length >= 4 && (a.endsWith(b) || b.endsWith(a));
}

function collectScalarStrings(value, output = [], depth = 0) {
  if (output.length >= 160 || depth > 5 || value === null || value === undefined) return output;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    output.push(String(value));
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 30)) collectScalarStrings(item, output, depth + 1);
    return output;
  }
  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value).slice(0, 80)) {
      output.push(String(key));
      collectScalarStrings(child, output, depth + 1);
      if (output.length >= 160) break;
    }
  }
  return output;
}

function activeCallContainsText(call, value) {
  const needle = String(value || "").trim().toLowerCase();
  if (!needle) return false;
  return collectScalarStrings(call)
    .some((candidate) => String(candidate || "").toLowerCase().includes(needle));
}

function activeCallContainsPhone(call, phone) {
  const target = normalizePhone(phone);
  if (!target) return false;
  return collectScalarStrings(call)
    .map(normalizePhone)
    .filter(Boolean)
    .some((candidate) => candidate === target);
}

function cloneActiveCallForAudit(value, depth = 0) {
  if (value == null) return value;
  if (depth > 5) return "[depth-limit]";
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value.slice(0, 40).map((item) => cloneActiveCallForAudit(item, depth + 1));
  }
  if (typeof value === "object") {
    const out = {};
    for (const [key, child] of Object.entries(value).slice(0, 120)) {
      out[key] = cloneActiveCallForAudit(child, depth + 1);
    }
    return out;
  }
  if (typeof value === "string") {
    return value.length > 2000 ? `${value.slice(0, 2000)}...[truncated]` : value;
  }
  return value;
}

function summarizeActiveCall(call = null) {
  if (!call || typeof call !== "object") return null;
  const summary = {};
  for (const key of [
    "uii",
    "UII",
    "callId",
    "callID",
    "activeCallId",
    "id",
    "state",
    "status",
    "callState",
    "ani",
    "dnis",
    "callerId",
    "sourcePhone",
    "destination",
    "destinationPhone",
    "leadPhone",
    "phone",
    "campaignId",
    "dialGroupId",
    "agentId",
    "username",
    "agentEmail",
    "externId",
    "externalId",
    "interactionId",
    "dialogId",
    "segmentId",
    "sessionId",
    "callSessionId",
  ]) {
    if (call[key] !== undefined && call[key] !== null && call[key] !== "") {
      summary[key] = call[key];
    }
  }
  summary.uii = summary.uii || summary.UII || summary.callId || summary.callID || summary.activeCallId || summary.id || null;
  summary.rawKeys = Object.keys(call).slice(0, 120);
  summary.raw = cloneActiveCallForAudit(call);
  return summary;
}

function isTerminalOutcomeMonitorEnabled() {
  return String(process.env.RINGCX_AGENT_MONITOR_TERMINAL_OUTCOME_ENABLED || "true").toLowerCase() !== "false";
}

function buildTerminalOutcomePayload(queueItem = {}, call = {}, now = new Date()) {
  const summary = summarizeActiveCall(call) || {};
  const uii = extractActiveCallUii(call);
  return {
    ...summary,
    domain: queueItem.domain || null,
    caseId: queueItem.caseId || null,
    queueItemId: queueItem._id ? String(queueItem._id) : null,
    actionKey: queueItem.metadata?.actionKey || null,
    phone: queueItem.phone || call?.destination || call?.destinationPhone || call?.leadPhone || call?.phone || null,
    assignedExtensionId: queueItem.assignment?.extensionId || null,
    assignedAgentName: queueItem.assignment?.agentName || null,
    uii,
    callSessionId: uii,
    outcomeAt: now,
    sourceService: "ringcx-agent-monitor",
    source: "ringcx-agent-monitor",
    call: summary,
    record: summary,
    raw: summary,
    outcome: call?.outcome || call?.callOutcome || call?.result || call?.disposition || null,
    result: call?.result || call?.callResult || null,
    status: call?.status || call?.state || call?.callState || null,
    reason: call?.reason || call?.terminationReason || null,
  };
}

async function maybeHandleTerminalOutcome(queueItem = {}, call = {}, now = new Date(), logger = null) {
  if (!isTerminalOutcomeMonitorEnabled()) {
    return { terminal: false, skipped: true, reason: "terminal-outcome-monitor-disabled" };
  }
  const payload = buildTerminalOutcomePayload(queueItem, call, now);
  const classification = classifyCxTerminalOutcome(payload);
  if (!classification.safeToAdvance) {
    return { terminal: false, classification };
  }

  try {
    const result = await handleCxTerminalCallOutcome(payload);
    return {
      terminal: true,
      classification,
      result,
    };
  } catch (error) {
    logger?.warn?.("ringcx.agentMonitor.terminalOutcome.failed", {
      queueItemId: queueItem?._id ? String(queueItem._id) : null,
      caseId: queueItem?.caseId || null,
      uii: payload.uii || null,
      error: error.message,
    });
    return {
      terminal: true,
      classification,
      result: { ok: false, error: error.message || "terminal-outcome-handler-failed" },
    };
  }
}

function callIdentity(call = {}) {
  return normalizeExternalId(call?.telephonySessionId || call?.sessionId || call?.uii);
}

function scoreQueueItemForActiveCall(queueItem = {}, call = {}) {
  const metadata = queueItem.metadata || {};
  const uii = extractActiveCallUii(call);
  let score = 0;
  const reasons = [];

  for (const value of [
    metadata.lastDialExecutionUii,
    metadata.lastQueueAttemptUii,
    metadata.lastHangupRequestUii,
  ]) {
    if (uii && normalizeExternalId(value) === uii) {
      score += 100;
      reasons.push("uii");
      break;
    }
  }

  for (const value of [
    metadata.lastRingcxPublishedExternId,
    metadata.lastRingcxPublishedRoute?.externId,
    metadata.lastDialExecutionRingcxPublish?.externId,
    metadata.lastDialExecutionExternId,
    metadata.rcxVisibilityExternId,
  ]) {
    if (value && activeCallContainsText(call, value)) {
      score += 100;
      reasons.push("externId");
      break;
    }
  }

  if (queueItem.phone && activeCallContainsPhone(call, queueItem.phone)) {
    score += 10;
    reasons.push("phone");
  }
  if (metadata.lastDialExecutionAgentEmail && activeCallContainsText(call, metadata.lastDialExecutionAgentEmail)) {
    score += 5;
    reasons.push("agentEmail");
  }
  if (metadata.lastDialExecutionDialerCxAgentId && activeCallContainsText(call, metadata.lastDialExecutionDialerCxAgentId)) {
    score += 5;
    reasons.push("agentId");
  }
  for (const campaignId of [
    metadata.lastRingcxPublishedCampaignId,
    metadata.lastRingcxPublishedRoute?.campaignId,
    metadata.lastDialExecutionRingcxPublish?.campaignId,
    metadata.lastDialExecutionCampaignId,
  ]) {
    if (campaignId && activeCallContainsText(call, campaignId)) {
      score += 3;
      reasons.push("campaignId");
      break;
    }
  }
  for (const dialGroupId of [
    metadata.lastRingcxPublishedDialGroupId,
    metadata.lastRingcxPublishedRoute?.dialGroupId,
    metadata.lastDialExecutionRingcxPublish?.dialGroupId,
    metadata.lastDialExecutionDialGroupId,
  ]) {
    if (dialGroupId && activeCallContainsText(call, dialGroupId)) {
      score += 3;
      reasons.push("dialGroupId");
      break;
    }
  }

  return { score, reasons };
}

function findQueueItemForActiveCall(queueItems = [], call = {}) {
  const scored = queueItems
    .map((queueItem) => ({
      queueItem,
      ...scoreQueueItemForActiveCall(queueItem, call),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score);
  const top = scored[0];
  if (!top) return null;
  const next = scored[1];
  const hasExactQueueIdentity = top.reasons.includes("uii") || top.reasons.includes("externId");
  if (hasExactQueueIdentity) {
    if (next && next.score === top.score && !next.reasons.some((reason) => reason === "uii" || reason === "externId")) {
      return top;
    }
    if (next && next.score === top.score && !top.reasons.includes("uii")) return null;
    return top;
  }

  const hasWeakFallbackIdentity =
    allowWeakRingcxActiveCallMatch()
    && top.reasons.includes("phone")
    && (top.reasons.includes("agentEmail") || top.reasons.includes("agentId"));
  if (!hasWeakFallbackIdentity) return null;
  if (next && next.score === top.score) return null;
  return top;
}

function resolveCallStartTime(queueItem = {}, now = new Date()) {
  for (const value of [
    queueItem.metadata?.lastDialExecutionAt,
    queueItem.metadata?.lastQueueAttemptAt,
    queueItem.lastPlacedAt,
    queueItem.updatedAt,
  ]) {
    if (!value) continue;
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return now;
}

function hasActiveExCall(agentState = {}) {
  const call = agentState.currentCall && typeof agentState.currentCall === "object"
    ? agentState.currentCall
    : {};
  return String(call.channel || "").toLowerCase() === "ex"
    && ["CallConnected", "OnHold"].includes(String(agentState.exTelephonyStatus || ""));
}

async function markAgentCxActive(queueItem = {}, call = {}, now = new Date(), logger = null) {
  const extensionId = String(queueItem.assignment?.extensionId || "").trim();
  if (!extensionId) return { changed: false, reason: "missing-extension" };
  const existing = await agentStateRepository.findAgentStateByExtensionId(extensionId);
  if (hasActiveExCall(existing || {})) {
    traceCxCallIdentity(logger, "ringcx-monitor.mark-active.skip-active-ex", {
      extensionId,
      reason: "agent-has-active-ex-call",
      queueItemId: queueItem._id ? String(queueItem._id) : null,
      caseId: queueItem.caseId,
      domain: queueItem.domain,
      agentState: existing,
      observedCall: call,
    });
    return { changed: false, skipped: true, reason: "agent-has-active-ex-call", extensionId };
  }

  const uii = extractActiveCallUii(call);
  const fromPhone = call?.ani || call?.sourcePhone || call?.callerId || null;
  const genericPhone = call?.phone || null;
  const genericMatchesFrom = phoneValuesCouldMatch(genericPhone, fromPhone);
  const toPhone =
    queueItem.phone ||
    call?.destination ||
    call?.destinationPhone ||
    call?.leadPhone ||
    call?.dnis ||
    (genericMatchesFrom ? null : genericPhone) ||
    null;
  const currentCall = {
    sessionId: uii,
    telephonySessionId: uii,
    direction: "outbound",
    from: fromPhone,
    fromName: queueItem.assignment?.agentName || null,
    to: toPhone,
    channel: "cx",
    startTime: resolveCallStartTime(queueItem, now),
  };
  const previousIdentity = callIdentity(existing?.currentCall || {});
  const sameCall = previousIdentity && uii && previousIdentity === uii
    && existing?.status === "onCall"
    && existing?.activePlatform === "CX";
  traceCxCallIdentity(logger, "ringcx-monitor.mark-active.before", {
    extensionId,
    queueItemId: queueItem._id ? String(queueItem._id) : null,
    caseId: queueItem.caseId,
    domain: queueItem.domain,
    requestedUii: uii,
    previousAgentState: existing,
    currentCall,
    observedCall: call,
    reason: sameCall ? "same-call" : "new-or-changed-call",
  });
  const dailyStats = applyCallStartedDailyStats(
    existing || {},
    normalizeDailyStats(existing?.dailyStats, now),
    {
      call: currentCall,
      platform: "cx",
      direction: "outbound",
      date: now,
    },
  );
  const stateSnapshot = {
    ...(existing || {}),
    status: "onCall",
    activityState: "onCall",
    activePlatform: "CX",
    currentCall,
    dailyStats,
    lastCallDirection: "outbound",
  };
  const routing = deriveCxRouting(stateSnapshot, existing?.cxRouting || null);
  const update = {
    status: "onCall",
    activityState: "onCall",
    activePlatform: "CX",
    currentCall,
    dailyStats,
    lastCallDirection: "outbound",
    "cxRouting.enabled": routing.enabled,
    "cxRouting.desiredAvailability": routing.desiredAvailability,
    "cxRouting.reason": routing.reason,
    "cxRouting.syncedAt": routing.syncedAt || now,
    "cxRouting.lastSource": routing.lastSource || "platform-monitor",
    "cxRouting.manualUnavailableAt": routing.manualUnavailableAt || null,
    "cxRouting.pauseType": routing.pauseType || null,
    "cxRouting.pauseStartedAt": routing.pauseStartedAt || null,
    "cxRouting.pauseReleaseAt": routing.pauseReleaseAt || null,
    "cxRouting.breakUsage": routing.breakUsage || existing?.cxRouting?.breakUsage || null,
    "cxRouting.lastQueueReleaseAt": routing.lastQueueReleaseAt || existing?.cxRouting?.lastQueueReleaseAt || null,
    "cxRouting.assignmentStats": routing.assignmentStats || existing?.cxRouting?.assignmentStats || null,
    lastActivityAt: now,
    "upstream.source": "ringcx-agent-monitor",
    "upstream.mirroredAt": now,
  };
  if (!sameCall) update.lastStatusChange = now;

  const [updated] = await Promise.all([
    agentStateRepository.updateAgentState(extensionId, update),
    CxDialQueue.updateOne(
      { _id: queueItem._id },
      {
        $set: {
          "metadata.lastRingcxMonitorSeenAt": now,
          "metadata.lastRingcxMonitorUii": uii,
          "metadata.lastRingcxMonitorActiveCall": summarizeActiveCall(call),
          "metadata.lastDialExecutionUii": queueItem.metadata?.lastDialExecutionUii || uii,
          "metadata.lastDialExecutionStatus": "accepted",
        },
      },
    ).catch(() => null),
  ]);
  traceCxCallIdentity(logger, "ringcx-monitor.mark-active.after", {
    extensionId,
    queueItemId: queueItem._id ? String(queueItem._id) : null,
    caseId: queueItem.caseId,
    domain: queueItem.domain,
    requestedUii: uii,
    previousAgentState: existing,
    nextAgentState: updated,
    currentCall,
    reason: sameCall ? "same-call" : "updated-agent-state",
  });

  return {
    changed: !sameCall,
    extensionId,
    queueItemId: String(queueItem._id),
    uii,
    current: updated,
  };
}

async function markMissingCxCallsEnded(activeIdentities = new Set(), now = new Date(), logger = null) {
  const endGraceMs = Math.max(Number(process.env.RINGCX_AGENT_MONITOR_END_GRACE_MS) || 20_000, 5_000);
  const noUiiStaleMs = Math.max(Number(process.env.RINGCX_AGENT_MONITOR_STALE_NO_UII_MS) || 120_000, 30_000);
  const agents = await agentStateRepository.listAgentStates();
  const ended = [];

  for (const agent of agents) {
    const call = agent.currentCall && typeof agent.currentCall === "object" ? agent.currentCall : {};
    if (String(call.channel || "").toLowerCase() !== "cx") continue;
    if (agent.activePlatform !== "CX") continue;
    if (!["onCall", "ringing"].includes(String(agent.status || ""))) continue;

    const identity = callIdentity(call);
    const lastChangedAt = agent.lastStatusChange ? new Date(agent.lastStatusChange).getTime() : 0;
    const startedAt = call.startTime ? new Date(call.startTime).getTime() : lastChangedAt;
    const ageMs = now.getTime() - (Number.isFinite(lastChangedAt) && lastChangedAt > 0 ? lastChangedAt : startedAt || 0);
    if (identity && activeIdentities.has(identity)) continue;
    if (identity && ageMs < endGraceMs) continue;
    if (!identity && ageMs < noUiiStaleMs) continue;

    traceCxCallIdentity(logger, "ringcx-monitor.mark-missing-ended.before", {
      extensionId: agent.extensionId,
      reason: identity ? "identity-not-active" : "missing-identity-stale",
      agentState: agent,
      currentCall: call,
      observedUii: identity,
    });
    const dailyStats = applyCallEndedDailyStats(
      agent,
      normalizeDailyStats(agent.dailyStats, now),
      { missed: false, date: now },
    );
    const clearLongCallHold = String(agent.cxRouting?.reason || "").trim().toLowerCase() === "long-call-hold";
    const updated = await agentStateRepository.updateAgentState(agent.extensionId, {
      status: "disposition",
      activityState: "dispositioning",
      activePlatform: "CX",
      currentCall: call,
      dailyStats,
      ...(clearLongCallHold
        ? {
          "cxRouting.desiredAvailability": "available",
          "cxRouting.reason": "cx-call-ended",
          "cxRouting.syncedAt": now,
          "cxRouting.lastSource": "ringcx-agent-monitor",
          "cxRouting.manualUnavailableAt": null,
          "cxRouting.pauseType": null,
          "cxRouting.pauseStartedAt": null,
          "cxRouting.pauseReleaseAt": null,
        }
        : {}),
      lastCallEndedAt: now,
      lastCallOutcome: "ringcx-active-call-ended",
      lastActivityAt: now,
      lastStatusChange: now,
      "upstream.source": "ringcx-agent-monitor",
      "upstream.mirroredAt": now,
    }).catch((error) => {
      logger?.warn?.("ringcx.agentMonitor.endState.failed", {
        extensionId: agent.extensionId,
        error: error.message,
      });
      return null;
    });
    if (updated) {
      traceCxCallIdentity(logger, "ringcx-monitor.mark-missing-ended.after", {
        extensionId: agent.extensionId,
        reason: identity ? "identity-not-active" : "missing-identity-stale",
        previousAgentState: agent,
        nextAgentState: updated,
        currentCall: call,
        observedUii: identity,
      });
      ended.push({
        extensionId: agent.extensionId,
        identity,
      });
    }
  }

  return ended;
}

async function runRingcxAgentMonitor(options = {}) {
  const logger = options.logger || null;
  if (!isRingcxAgentMonitorEnabled()) {
    return { enabled: false, skipped: true, reason: "disabled" };
  }
  const now = options.now ? new Date(options.now) : new Date();
  const limit = Math.min(Math.max(Number(options.limit) || 250, 1), 1000);
  const client = options.client || createRingcxVoiceClient();
  const activePayload = await client.listActiveCalls({
    product: "ACCOUNT",
    productId: client.config?.accountId,
  });
  const activeCalls = coerceActiveCallList(activePayload);
  const activeIdentities = new Set(
    activeCalls
      .map(extractActiveCallUii)
      .filter(Boolean),
  );
  const queueItems = await CxDialQueue.find({
    state: "serving",
    "assignment.extensionId": { $nin: [null, ""] },
  })
    .sort({ updatedAt: -1 })
    .limit(limit)
    .lean();

  const matched = [];
  for (const call of activeCalls) {
    const match = findQueueItemForActiveCall(queueItems, call);
    if (!match) continue;
    const terminalOutcome = await maybeHandleTerminalOutcome(match.queueItem, call, now, logger);
    if (terminalOutcome.terminal) {
      matched.push({
        queueItemId: String(match.queueItem._id),
        extensionId: match.queueItem.assignment?.extensionId || null,
        score: match.score,
        reasons: match.reasons,
        uii: extractActiveCallUii(call),
        terminalOutcome: terminalOutcome.classification?.normalizedOutcome || "unknown",
        advanced: terminalOutcome.result?.advanced === true,
      });
      continue;
    }
    const result = await markAgentCxActive(match.queueItem, call, now, logger);
    matched.push({
      queueItemId: String(match.queueItem._id),
      extensionId: match.queueItem.assignment?.extensionId || null,
      score: match.score,
      reasons: match.reasons,
      uii: extractActiveCallUii(call),
      changed: result.changed,
    });
  }

  const ended = await markMissingCxCallsEnded(activeIdentities, now, logger);
  return {
    enabled: true,
    activeCalls: activeCalls.length,
    servingQueueItems: queueItems.length,
    matched: matched.length,
    ended: ended.length,
    matches: matched.slice(0, 20),
    endedAgents: ended.slice(0, 20),
  };
}

module.exports = {
  buildTerminalOutcomePayload,
  maybeHandleTerminalOutcome,
  runRingcxAgentMonitor,
};
