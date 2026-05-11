"use strict";

const { agentStateRepository } = require("../../shared-repositories/src");
const {
  isLeadServingAllowedAgent,
  isLeadServingExcludedAgent,
} = require("./cxLeadServingEligibilityService");

const EX_BUSY_TELEPHONY_STATUSES = new Set(["callconnected", "onhold"]);
const APP_BUSY_STATUSES = new Set(["oncall"]);
const MANUAL_CX_ROUTING_SOURCES = new Set(["cx-workspace", "agent-toggle", "manual"]);

function isExLeadServingGateEnabled() {
  return String(process.env.RC_CX_EX_BUSY_GATE_ENABLED || "true").toLowerCase() !== "false";
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

function routingAssignmentStats(existingRouting = null) {
  return existingRouting?.assignmentStats && typeof existingRouting.assignmentStats === "object"
    ? existingRouting.assignmentStats
    : null;
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

function hasManualUnavailable(existingRouting = null) {
  const desiredAvailability = String(existingRouting?.desiredAvailability || "").trim().toLowerCase();
  const reason = String(existingRouting?.reason || "").trim().toLowerCase();
  const lastSource = String(existingRouting?.lastSource || "").trim().toLowerCase();
  return desiredAvailability === "unavailable"
    && reason === "manual-unavailable"
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
      assignmentStats: routingAssignmentStats(existingRouting),
    };
  }

  if (hasManualUnavailable(existingRouting)) {
    return {
      enabled: true,
      desiredAvailability: "unavailable",
      reason: "manual-unavailable",
      syncedAt: new Date(),
      lastSource: "cx-workspace",
      assignmentStats: routingAssignmentStats(existingRouting),
    };
  }

  return {
    enabled: true,
    desiredAvailability: "available",
    reason: "ex-idle",
    syncedAt: new Date(),
    lastSource: "ringbridge",
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
    : blocked
      ? "Manual pause keeps this agent out of fresh lead serving."
      : "EX is idle and this agent profile can receive fresh leads.";

  return {
    allowed: !blocked,
    blocked,
    source,
    reason: routingReason || null,
    desiredAvailability: desiredAvailability || null,
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
async function setActivityState(extensionId, newState, { source = "manual" } = {}) {
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
      { source: normalizedSource, existing },
    );
  }

  return agentStateRepository.updateAgentState(extensionId, {
    activityState: newState,
    lastActivityAt: new Date(),
    "upstream.source": source,
    "upstream.mirroredAt": new Date(),
  });
}

function buildManualCxRouting(existing = {}, desiredAvailability) {
  const existingRouting = existing?.cxRouting || null;
  const requestedRouting = {
    enabled: true,
    desiredAvailability,
    reason: desiredAvailability === "unavailable" ? "manual-unavailable" : "manual-available",
    syncedAt: new Date(),
    lastSource: "cx-workspace",
    assignmentStats: routingAssignmentStats(existingRouting),
  };
  const effectiveRouting = deriveCxRouting(existing || {}, requestedRouting);
  if (desiredAvailability === "available" && effectiveRouting.reason === "ex-idle") {
    effectiveRouting.reason = "manual-available";
    effectiveRouting.lastSource = "cx-workspace";
  }
  if (effectiveRouting.reason === "manual-unavailable") {
    effectiveRouting.lastSource = "cx-workspace";
  }
  return effectiveRouting;
}

function deriveManualCxActivityState(existing = {}, desiredAvailability, effectiveRouting = null) {
  if (effectiveRouting?.reason === "ex-busy") {
    return deriveTelephonyActivityState(existing);
  }
  if (desiredAvailability === "unavailable") return "unavailable";
  return "idle";
}

async function setManualCxAvailability(
  extensionId,
  desiredAvailability,
  { source = "cx-workspace", existing = null } = {},
) {
  const normalizedDesiredAvailability = String(desiredAvailability || "").trim().toLowerCase();
  if (!["available", "unavailable"].includes(normalizedDesiredAvailability)) {
    throw new Error('desiredAvailability must be "available" or "unavailable"');
  }

  const existingState = existing
    || await agentStateRepository.findAgentStateByExtensionId(extensionId);
  if (!existingState) return null;

  const effectiveRouting = buildManualCxRouting(existingState, normalizedDesiredAvailability);
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
  deriveCxRouting,
  deriveActivityState,
  deriveFreshLeadGate,
  getCxAgentStateByExtensionId,
  hasActiveExCall,
  isExLeadServingGateEnabled,
  isExBusySnapshot,
  isCxWorkspacePresenceActive,
  isCxWorkspacePresenceRequired,
  listCxAgentStates,
  mirrorAgentState,
  setManualCxAvailability,
  setActivityState,
  bumpLastActivityAt,
  touchCxWorkspacePresence,
};
