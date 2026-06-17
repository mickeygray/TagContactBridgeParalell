"use strict";

function parseBooleanFlag(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

function isCxCallTraceEnabled() {
  return parseBooleanFlag(process.env.CX_CALL_TRACE_ENABLED, false);
}

function clean(value, max = 180) {
  const text = String(value || "").trim();
  return text ? text.slice(0, max) : null;
}

function callIdentity(call = {}) {
  return clean(
    call?.telephonySessionId
      || call?.sessionId
      || call?.callSessionId
      || call?.uii
      || call?.rcxUii
      || call?.callUii
      || "",
  );
}

function summarizeCall(call = {}) {
  if (!call || typeof call !== "object") return null;
  const identity = callIdentity(call);
  const hasAnyField = identity
    || call.telephonySessionId
    || call.sessionId
    || call.callSessionId
    || call.uii
    || call.rcxUii
    || call.channel
    || call.direction
    || call.from
    || call.to
    || call.phone
    || call.phoneNumber;
  if (!hasAnyField) return null;
  return {
    identity,
    uii: clean(call.uii || call.rcxUii || call.callUii),
    sessionId: clean(call.sessionId),
    telephonySessionId: clean(call.telephonySessionId),
    callSessionId: clean(call.callSessionId),
    channel: clean(call.channel, 40),
    direction: clean(call.direction, 40),
    phonePresent: Boolean(call.from || call.to || call.phone || call.phoneNumber),
  };
}

function summarizeAgentState(agent = {}) {
  if (!agent || typeof agent !== "object") return null;
  return {
    extensionId: clean(agent.extensionId, 80),
    status: clean(agent.status, 60),
    activityState: clean(agent.activityState, 60),
    activePlatform: clean(agent.activePlatform, 40),
    desiredAvailability: clean(agent.cxRouting?.desiredAvailability, 80),
    routingReason: clean(agent.cxRouting?.reason, 100),
    currentCall: summarizeCall(agent.currentCall || {}),
  };
}

function traceCxCallIdentity(logger, step, payload = {}) {
  if (!isCxCallTraceEnabled()) return;
  const log = logger && typeof logger.info === "function" ? logger.info.bind(logger) : null;
  if (!log) return;
  log("cx.call.trace", {
    step: clean(step, 120),
    extensionId: clean(payload.extensionId || payload.agentState?.extensionId, 80),
    domain: clean(payload.domain, 40),
    caseId: payload.caseId == null ? null : clean(payload.caseId, 80),
    queueItemId: clean(payload.queueItemId, 120),
    actionKey: clean(payload.actionKey, 120),
    reason: clean(payload.reason, 160),
    requestedUii: clean(payload.requestedUii || payload.uii, 180),
    observedUii: clean(payload.observedUii, 180),
    agentState: summarizeAgentState(payload.agentState),
    previousAgentState: summarizeAgentState(payload.previousAgentState),
    nextAgentState: summarizeAgentState(payload.nextAgentState),
    currentCall: summarizeCall(payload.currentCall),
    previousCall: summarizeCall(payload.previousCall),
    observedCall: summarizeCall(payload.observedCall),
    nextCall: summarizeCall(payload.nextCall),
  });
}

module.exports = {
  callIdentity,
  isCxCallTraceEnabled,
  summarizeAgentState,
  summarizeCall,
  traceCxCallIdentity,
};
