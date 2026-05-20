"use strict";

const { createEvent } = require("../../event-core/src");
const { getRingCentralConfig } = require("../../shared-config/src");
const {
  createRingCentralClient,
} = require("../../shared-integrations/src");
const {
  getRingCentralBusinessWindow,
} = require("../../shared-integrations/src/ringcentralClient");
const { agentStateRepository } = require("../../shared-repositories/src");
const {
  applyCallEndedDailyStats,
  applyCallStartedDailyStats,
  deriveActivityState,
  deriveCxRouting,
  isLikelyCxBridgeExCall,
  normalizeDailyStats,
} = require("./agentAvailabilityService");
// Lazy-required at call-site to avoid a require cycle with
// presenceBridgeService (which itself requires agentAvailabilityService
// → which is required from this file). Importing inline at the call
// site means the module is resolved only when a presence event lands,
// after both modules are fully loaded.
function getReactToPresenceChange() {
  // eslint-disable-next-line global-require
  return require("./presenceBridgeService").reactToPresenceChange;
}

// Lazy require: same circular-dep avoidance pattern. The fresh-lead
// service imports agentSliceService → universalQueueService → which may
// transitively pull in this file in some build orderings.
function getOnAgentBecomesEligible() {
  // eslint-disable-next-line global-require
  return require("./freshLeadAssignmentService").onAgentBecomesEligible;
}

// Lazy require: dialService transitively imports many of these layers.
function getDialReconcilers() {
  // eslint-disable-next-line global-require
  const ds = require("./dialService");
  return {
    reconcileCallEnded: ds.reconcileCallEnded,
    reconcileCallConnected: ds.reconcileCallConnected,
    materializeInboundCall: ds.materializeInboundCall,
  };
}
const {
  relayMetricObserved,
  relayReviewItemObserved,
} = require("./controlPlaneRelayService");
const { recordWorkflowStage } = require("./workflowStateService");

const EX_EVENT_TYPES = Object.freeze({
  PRESENCE_OBSERVED: "ringcentral.ex.presence.observed",
  AGENT_STATE_CHANGED: "ringcentral.ex.agent-state.changed",
  CALL_STARTED: "ringcentral.ex.call.started",
  CALL_ENDED: "ringcentral.ex.call.ended",
  CALL_MISSED: "ringcentral.ex.call.missed",
  POLL_RECONCILED: "ringcentral.ex.poll.reconciled",
});

const ACTIVE_STATUSES = new Set(["onCall", "ringing", "disposition"]);
const IDLE_PRESENCE_STATUSES = new Set(["Available"]);
const AWAY_PRESENCE_STATUSES = new Set(["Busy", "DoNotDisturb", "Dnd", "Unavailable"]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asDate(value, fallback = new Date()) {
  const date = value ? new Date(value) : fallback;
  return Number.isNaN(date.getTime()) ? fallback : date;
}

function normalizeExtensionId(value) {
  return String(value || "").trim();
}

function isPollableExtensionId(value) {
  return /^\d+$/.test(normalizeExtensionId(value));
}

function normalizePresenceStatus(value, fallback = "Offline") {
  return String(value || fallback || "Offline").trim();
}

function hasCxCallSnapshot(state = {}) {
  const currentCall = state.currentCall && typeof state.currentCall === "object"
    ? state.currentCall
    : {};
  const channel = String(currentCall.channel || "").trim().toLowerCase();
  const activePlatform = String(state.activePlatform || "").trim().toUpperCase();
  return (
    (channel === "cx" || activePlatform === "CX")
    && Boolean(
      currentCall.sessionId
        || currentCall.telephonySessionId
        || currentCall.from
        || currentCall.to,
    )
  );
}

function shouldHoldCxDisposition(previousState = {}, telephonyStatus = "") {
  const status = String(previousState.status || "").trim();
  return (
    telephonyStatus === "NoCall"
    && ["onCall", "ringing", "disposition"].includes(status)
    && hasCxCallSnapshot(previousState)
  );
}

function computePolledStatus(previousState, telephonyStatus, presenceStatus) {
  if (telephonyStatus === "Ringing") return "ringing";
  if (telephonyStatus === "CallConnected" || telephonyStatus === "OnHold") return "onCall";

  if (telephonyStatus === "NoCall") {
    if (shouldHoldCxDisposition(previousState, telephonyStatus)) return "disposition";
    if (IDLE_PRESENCE_STATUSES.has(presenceStatus)) return "available";
    if (AWAY_PRESENCE_STATUSES.has(presenceStatus)) return "away";
    if (presenceStatus === "Offline") return "offline";
    if (previousState.status === "onCall" || previousState.status === "ringing") return "available";
    if (previousState.status === "disposition") return "available";
  }

  return previousState.status || "offline";
}

function dispositionStaleThresholdMs(options = {}) {
  const configured = options.staleThresholdMs ?? getRingCentralConfig().presenceStaleThresholdMs;
  return Math.max(Number(configured) || 120000, 30000);
}

function ageSinceLastStatusChangeMs(agent = {}) {
  const raw = agent.lastStatusChange || agent.updatedAt || agent.lastEventReceived || null;
  const timestamp = raw ? new Date(raw).getTime() : 0;
  if (!timestamp || Number.isNaN(timestamp)) return Number.POSITIVE_INFINITY;
  return Date.now() - timestamp;
}

function callSignature(call = {}) {
  if (!call || typeof call !== "object") return "";
  return [
    call.sessionId || "",
    call.telephonySessionId || "",
    call.direction || "",
    call.from || "",
    call.to || "",
  ].join("|");
}

function routingSignature(routing = {}) {
  if (!routing || typeof routing !== "object") return "";
  const unavailableAt = routing.manualUnavailableAt ? new Date(routing.manualUnavailableAt) : null;
  return [
    routing.enabled === false ? "disabled" : "enabled",
    routing.desiredAvailability || "",
    routing.reason || "",
    routing.lastSource || "",
    unavailableAt && !Number.isNaN(unavailableAt.getTime()) ? unavailableAt.toISOString() : "",
  ].join("|");
}

function hasPolledStateChanged(previous, next) {
  return (
    previous.status !== next.status
    || previous.activityState !== next.activityState
    || previous.exTelephonyStatus !== next.exTelephonyStatus
    || previous.exPresenceStatus !== next.exPresenceStatus
    || previous.activePlatform !== next.activePlatform
    || callSignature(previous.currentCall) !== callSignature(next.currentCall)
    || routingSignature(previous.cxRouting) !== routingSignature(next.cxRouting)
  );
}

function buildDailyStats(existing = {}) {
  return normalizeDailyStats(existing);
}

function snapshotCurrentCall(activeCall = null) {
  if (!activeCall) return {};

  return {
    sessionId: activeCall.sessionId || null,
    telephonySessionId: activeCall.telephonySessionId || null,
    direction: activeCall.direction || null,
    from: activeCall.from || null,
    fromName: activeCall.fromName || null,
    to: activeCall.to || null,
    // "ex" = call landed on the agent's RC desk app (typical inbound to
    // a TAG ext). "cx" = call routed via CX queue / cadence (typical
    // WYNN). Used by the CX UI to bias the lookup ladder fallback
    // order. Defaults to "ex" because RC EX session events are the
    // primary write path for currentCall.
    channel: activeCall.channel || "ex",
    startTime: activeCall.startTime ? asDate(activeCall.startTime) : new Date(),
  };
}

function cloneCall(call = {}) {
  return {
    sessionId: call.sessionId || null,
    telephonySessionId: call.telephonySessionId || null,
    direction: call.direction || null,
    from: call.from || null,
    fromName: call.fromName || null,
    to: call.to || null,
    channel: call.channel || null,
    startTime: call.startTime ? asDate(call.startTime) : null,
  };
}

function buildEventKey(prefix, payload = {}) {
  return [
    prefix,
    payload.extensionId || "unknown-ext",
    payload.telephonySessionId || payload.sessionId || "no-session",
    payload.eventTime || payload.timestamp || new Date().toISOString(),
  ].join(":");
}

function computeTargetStatus(previousState, telephonyStatus, presenceStatus) {
  const previousStatus = previousState.status || "offline";

  switch (telephonyStatus) {
    case "Ringing":
      return "ringing";
    case "CallConnected":
    case "OnHold":
      return "onCall";
    case "NoCall":
      if (shouldHoldCxDisposition(previousState, telephonyStatus)) return "disposition";
      if (previousStatus === "disposition") return "available";
      if (previousStatus === "onCall" || previousStatus === "ringing") return "disposition";
      return previousStatus;
    default:
      break;
  }

  switch (presenceStatus) {
    case "Available":
      if (previousStatus === "offline" || previousStatus === "away") return "available";
      return previousStatus;
    case "DoNotDisturb":
      return "away";
    case "Offline":
      return "offline";
    default:
      return previousStatus;
  }
}

function createStateSnapshot(existing = {}, extensionId) {
  return {
    extensionId,
    name: existing.name || `Extension ${extensionId}`,
    company: existing.company || "TAG",
    cxAgentId: existing.cxAgentId || null,
    cxProfileId: existing.cxProfileId || null,
    pin: existing.pin || null,
    status: existing.status || "offline",
    exTelephonyStatus: existing.exTelephonyStatus || "NoCall",
    exPresenceStatus: existing.exPresenceStatus || "Offline",
    currentCall: cloneCall(existing.currentCall || {}),
    lastCallOutcome: existing.lastCallOutcome || null,
    lastCallEndedAt: existing.lastCallEndedAt ? asDate(existing.lastCallEndedAt) : null,
    lastCallDirection: existing.lastCallDirection || null,
    lastMissedCallAt: existing.lastMissedCallAt ? asDate(existing.lastMissedCallAt) : null,
    lastMissedCallFrom: existing.lastMissedCallFrom || null,
    lastMissedCallTo: existing.lastMissedCallTo || null,
    activePlatform: existing.activePlatform || "none",
    activityState: existing.activityState
      || deriveActivityState(existing),
    lastActivityAt: existing.lastActivityAt ? asDate(existing.lastActivityAt) : null,
    lastStatusChange: existing.lastStatusChange ? asDate(existing.lastStatusChange) : new Date(),
    lastEventReceived: existing.lastEventReceived ? asDate(existing.lastEventReceived) : null,
    lastPresencePollAt: existing.lastPresencePollAt ? asDate(existing.lastPresencePollAt) : null,
    lastPresencePollError: existing.lastPresencePollError || null,
    dailyStats: buildDailyStats(existing.dailyStats),
    cxRouting: existing.cxRouting || null,
  };
}

function buildChangePayload(agent, extra = {}) {
  return {
    extensionId: agent.extensionId,
    name: agent.name,
    company: agent.company,
    status: agent.status,
    exTelephonyStatus: agent.exTelephonyStatus,
    exPresenceStatus: agent.exPresenceStatus,
    currentCall: cloneCall(agent.currentCall),
    lastCallOutcome: agent.lastCallOutcome || null,
    lastCallEndedAt: agent.lastCallEndedAt || null,
    lastCallDirection: agent.lastCallDirection || null,
    lastMissedCallAt: agent.lastMissedCallAt || null,
    lastMissedCallFrom: agent.lastMissedCallFrom || null,
    lastMissedCallTo: agent.lastMissedCallTo || null,
    activePlatform: agent.activePlatform,
    activityState: agent.activityState || null,
    lastActivityAt: agent.lastActivityAt || null,
    lastStatusChange: agent.lastStatusChange,
    lastEventReceived: agent.lastEventReceived,
    lastPresencePollAt: agent.lastPresencePollAt || null,
    lastPresencePollError: agent.lastPresencePollError || null,
    dailyStats: agent.dailyStats,
    cxRouting: agent.cxRouting,
    ...extra,
  };
}

async function persistState(nextState, existingState = null) {
  const currentCall = nextState?.currentCall && typeof nextState.currentCall === "object"
    ? nextState.currentCall
    : {};
  const suppressBridgeCall = isLikelyCxBridgeExCall(currentCall);
  const normalizedState = suppressBridgeCall
    ? {
      ...nextState,
      status: "available",
      exTelephonyStatus: "NoCall",
      currentCall: {},
      activePlatform: "none",
    }
    : nextState;
  if (suppressBridgeCall) {
    normalizedState.activityState = deriveActivityState(normalizedState, existingState?.activityState);
  }
  const payload = {
    ...normalizedState,
    cxRouting: deriveCxRouting(normalizedState, existingState?.cxRouting || null),
    upstream: {
      source: "ringcentral-ex",
      mirroredAt: new Date(),
    },
  };
  return agentStateRepository.upsertAgentState(payload);
}

async function reactToSavedPresence(saved, logger, extensionId, options = {}) {
  try {
    const reactToPresenceChange = getReactToPresenceChange();
    if (typeof reactToPresenceChange === "function") {
      const reaction = await reactToPresenceChange(saved, options);
      if (logger?.debug) {
        logger.debug("ex-presence.cxBridge.reaction", {
          extensionId,
          desiredAvailability: reaction?.desired,
          reason: reaction?.reason,
          skipped: reaction?.skipped || false,
        });
      }
      return reaction;
    }
  } catch (bridgeError) {
    logger?.warn?.("ex-presence.cxBridge.failed", {
      extensionId,
      error: bridgeError.message,
    });
  }
  return null;
}

async function emitEvent(eventType, aggregateId, dedupeKey, payload) {
  return createEvent({
    eventType,
    sourceService: "ringcentral-cx",
    aggregateType: "ringcentral-ex",
    aggregateId: String(aggregateId || "unknown"),
    dedupeKey,
    payload,
  });
}

async function processPresenceEnvelope(envelope = {}, logger) {
  const body = envelope.body || {};
  const extensionId = normalizeExtensionId(body.extensionId);
  if (!extensionId) {
    throw new Error("Presence event missing extensionId");
  }

  const existing = await agentStateRepository.findAgentStateByExtensionId(extensionId);
  const previous = createStateSnapshot(existing || {}, extensionId);
  const telephonyStatus = body.telephonyStatus || previous.exTelephonyStatus || "NoCall";
  const presenceStatus = body.presenceStatus || previous.exPresenceStatus || "Offline";
  const activeCall = Array.isArray(body.activeCalls) ? body.activeCalls[0] || null : null;
  const eventTime = body.eventTime || envelope.timestamp || new Date().toISOString();

  const next = {
    ...previous,
    exTelephonyStatus: telephonyStatus,
    exPresenceStatus: presenceStatus,
    lastEventReceived: asDate(eventTime),
  };

  const targetStatus = computeTargetStatus(previous, telephonyStatus, presenceStatus);
  const previousCall = cloneCall(previous.currentCall);

  if (telephonyStatus === "Ringing") {
    next.status = targetStatus;
    next.currentCall = snapshotCurrentCall(activeCall);
    next.lastCallDirection = activeCall?.direction || previous.lastCallDirection || null;
  } else if (telephonyStatus === "CallConnected" || telephonyStatus === "OnHold") {
    next.status = targetStatus;
    next.activePlatform = "EX";
    if (!previous.currentCall?.sessionId || activeCall?.sessionId !== previous.currentCall?.sessionId) {
      next.currentCall = snapshotCurrentCall(activeCall);
    }
    next.lastCallDirection = activeCall?.direction || previous.lastCallDirection || null;
    next.dailyStats = applyCallStartedDailyStats(previous, next.dailyStats, {
      call: next.currentCall,
      platform: "ex",
      direction: activeCall?.direction || next.lastCallDirection || null,
      date: asDate(eventTime),
    });
  } else if (telephonyStatus === "NoCall") {
    next.status = targetStatus;
    if (previous.status === "ringing" || previous.status === "onCall") {
      next.lastCallEndedAt = asDate(eventTime);
      next.lastCallDirection = previous.currentCall?.direction || next.lastCallDirection || null;
    }
    if (targetStatus === "disposition" || targetStatus === "available") {
      if (targetStatus === "disposition" && shouldHoldCxDisposition(previous, telephonyStatus)) {
        next.currentCall = previousCall;
        next.activePlatform = "CX";
        next.activityState = "dispositioning";
      } else {
        next.currentCall = {};
        next.activePlatform = targetStatus === "available" ? "none" : previous.activePlatform || "EX";
      }
    }
  } else {
    next.status = targetStatus;
    if (targetStatus === "offline") {
      next.activePlatform = "none";
    }
  }

  if (next.status !== previous.status) {
    next.lastStatusChange = asDate(eventTime);
  }

  const nextActivityState = deriveActivityState(next, previous.activityState);
  if (next.activityState !== nextActivityState) {
    next.activityState = nextActivityState;
    next.lastActivityAt = asDate(eventTime);
  }

  const saved = await persistState(next, existing);

  // ── Reactor: feed the saved state through Codex's policy + the
  // lead-pusher gate. This is the production wiring that replaces
  // the standalone polling bridge — RC presence webhooks fire here,
  // we recompute cxRouting and persist via mirrorAgentState, and the
  // ringcxLeadServingService.publishQueueItemToRingcx gate reads the
  // resulting desiredAvailability to decide whether to push leads.
  //
  // Best-effort: any failure here is logged and swallowed so a
  // bridge bug doesn't break the existing presence-observation flow.
  await reactToSavedPresence(saved, logger, extensionId);

  // ── CallSession reconciliation ─────────────────────────────────
  //
  // Mirror call-state changes from RC presence into our CallSession
  // record. Three transitions matter:
  //   - any → CallConnected → reconcileCallConnected (state="connected")
  //   - any → NoCall (was onCall/Ringing) → reconcileCallEnded (state="ended")
  //   - inbound Ringing without active session → materializeInboundCall
  //
  // Best-effort: failures are logged but don't break the existing
  // presence flow.
  try {
    const tel = saved.exTelephonyStatus || telephonyStatus;
    const previousTel = previous?.exTelephonyStatus || "NoCall";
    const sessionRcId = activeCall?.sessionId || null;
    const telephonySessionId = activeCall?.telephonySessionId || null;

    if (tel === "CallConnected" && previousTel !== "CallConnected") {
      const { reconcileCallConnected, materializeInboundCall } = getDialReconcilers();
      // If outbound (we initiated), reconcile the existing CallSession.
      // If inbound (no active session for this agent yet), materialize one.
      const reconciled = await reconcileCallConnected({
        agentId: extensionId,
        sessionRcId,
        telephonySessionId,
        logger,
      });
      if (reconciled?.reason === "no-active-session"
        && activeCall?.direction === "Inbound") {
        await materializeInboundCall({
          agentId: extensionId,
          fromNumber: activeCall.from,
          sessionRcId,
          telephonySessionId,
          logger,
        });
      }
    } else if (tel === "NoCall" && (previousTel === "CallConnected" || previousTel === "OnHold" || previousTel === "Ringing")) {
      const { reconcileCallEnded } = getDialReconcilers();
      await reconcileCallEnded({
        agentId: extensionId,
        sessionRcId: previous?.currentCall?.sessionId || null,
        telephonySessionId: previous?.currentCall?.telephonySessionId || null,
        logger,
      });
    } else if (tel === "Ringing"
      && previousTel === "NoCall"
      && activeCall?.direction === "Inbound") {
      // Inbound ringing — materialize so SPA can render the incoming card
      const { materializeInboundCall } = getDialReconcilers();
      await materializeInboundCall({
        agentId: extensionId,
        fromNumber: activeCall.from,
        sessionRcId,
        telephonySessionId,
        logger,
      });
    }
  } catch (reconcileError) {
    logger?.warn?.("ex-presence.callSessionReconcile.failed", {
      extensionId,
      error: reconcileError.message,
    });
  }

  // ── Queue-eligibility hook ─────────────────────────────────────
  //
  // If this presence change transitioned the agent from busy→idle (or
  // first-time-online), kick the fresh-lead drain so any pending fresh
  // leads land on this agent immediately. Best-effort, swallowed.
  try {
    const wasIneligible = previous?.activityState
      && ["onCall", "dialing", "dispositioning", "wrapup", "offline", "unavailable"].includes(previous.activityState);
    const nowIdle = (saved.activityState === "idle"
      || saved.status === "available")
      && saved.cxRouting?.desiredAvailability === "available";
    if (wasIneligible && nowIdle) {
      const onAgentBecomesEligible = getOnAgentBecomesEligible();
      if (typeof onAgentBecomesEligible === "function") {
        const triggered = await onAgentBecomesEligible(extensionId);
        logger?.debug?.("ex-presence.queueEligibility.triggered", {
          extensionId,
          triggered: triggered?.triggered || false,
          reason: triggered?.reason,
        });
      }
    }
  } catch (eligibilityError) {
    logger?.warn?.("ex-presence.queueEligibility.failed", {
      extensionId,
      error: eligibilityError.message,
    });
  }

  await emitEvent(
    EX_EVENT_TYPES.PRESENCE_OBSERVED,
    extensionId,
    buildEventKey("ex-presence", {
      extensionId,
      telephonySessionId: activeCall?.telephonySessionId || previousCall.telephonySessionId,
      sessionId: activeCall?.sessionId || previousCall.sessionId,
      eventTime,
    }),
    {
      previous: buildChangePayload(previous),
      current: buildChangePayload(saved),
      raw: body,
      source: "webhook",
      eventTime,
    },
  );

  await recordWorkflowStage({
    domain: saved.company || "TAG",
    family: "ringcentral",
    subtype: "presence",
    stage: "observed",
    aggregateType: "agent",
    aggregateId: extensionId,
    sourceService: "ringcentral-cx",
    summary: `Presence observed for extension ${extensionId}`,
    payload: {
      previousStatus: previous.status,
      newStatus: saved.status,
      telephonyStatus,
      presenceStatus,
    },
  });

  if (saved.status !== previous.status || saved.exTelephonyStatus !== previous.exTelephonyStatus) {
    try {
      await relayReviewItemObserved({
        domain: saved.company || "TAG",
        category: "ringcentral-agent-state",
        title: "RingCentral agent state changed",
        summary: `${saved.name || extensionId} is now ${saved.status}`,
        payload: {
          extensionId,
          previousStatus: previous.status,
          newStatus: saved.status,
          previousTelephonyStatus: previous.exTelephonyStatus,
          newTelephonyStatus: saved.exTelephonyStatus,
          currentCall: cloneCall(saved.currentCall),
        },
        tags: ["ringcentral", "agent-state"],
        dedupeKey: buildEventKey("cp-agent-state", {
          extensionId,
          telephonySessionId: activeCall?.telephonySessionId || previousCall.telephonySessionId,
          sessionId: activeCall?.sessionId || previousCall.sessionId,
          eventTime,
        }),
      });
    } catch (error) {
      logger?.warn("ringcentral.ex.control_plane_relay_failed", {
        error: error.message,
        subtype: "agent-state",
        extensionId,
      });
    }
  }

  if (saved.status !== previous.status || saved.exTelephonyStatus !== previous.exTelephonyStatus) {
    await emitEvent(
      EX_EVENT_TYPES.AGENT_STATE_CHANGED,
      extensionId,
      buildEventKey("ex-agent-state", {
        extensionId,
        telephonySessionId: activeCall?.telephonySessionId || previousCall.telephonySessionId,
        sessionId: activeCall?.sessionId || previousCall.sessionId,
        eventTime,
      }),
      {
        previous: buildChangePayload(previous),
        current: buildChangePayload(saved),
        source: "webhook",
        eventTime,
      },
    );

    await recordWorkflowStage({
      domain: saved.company || "TAG",
      family: "ringcentral",
      subtype: "agent-state",
      stage: "completed",
      aggregateType: "agent",
      aggregateId: extensionId,
      sourceService: "ringcentral-cx",
      summary: `Agent state changed to ${saved.status}`,
      payload: {
        previousStatus: previous.status,
        newStatus: saved.status,
        previousTelephonyStatus: previous.exTelephonyStatus,
        newTelephonyStatus: saved.exTelephonyStatus,
      },
    });
  }

  if (telephonyStatus === "CallConnected" && previous.status !== "onCall") {
    await emitEvent(
      EX_EVENT_TYPES.CALL_STARTED,
      activeCall?.telephonySessionId || activeCall?.sessionId || extensionId,
      buildEventKey("ex-call-started", {
        extensionId,
        telephonySessionId: activeCall?.telephonySessionId,
        sessionId: activeCall?.sessionId,
        eventTime,
      }),
      {
        extensionId,
        agent: buildChangePayload(saved),
        call: snapshotCurrentCall(activeCall),
        source: "webhook",
        eventTime,
      },
    );

    await recordWorkflowStage({
      domain: saved.company || "TAG",
      family: "ringcentral",
      subtype: "call",
      stage: "requested",
      aggregateType: "telephony-session",
      aggregateId: activeCall?.telephonySessionId || activeCall?.sessionId || extensionId,
      sourceService: "ringcentral-cx",
      summary: "EX call started",
      payload: {
        extensionId,
        direction: activeCall?.direction || null,
        from: activeCall?.from || null,
        to: activeCall?.to || null,
      },
    });

    try {
      await Promise.all([
        relayReviewItemObserved({
          domain: saved.company || "TAG",
          category: "ringcentral-call-started",
          title: "RingCentral EX call started",
          summary: `${saved.name || extensionId} connected a call`,
          payload: {
            extensionId,
            call: snapshotCurrentCall(activeCall),
          },
          tags: ["ringcentral", "call-started"],
          dedupeKey: buildEventKey("cp-call-started", {
            extensionId,
            telephonySessionId: activeCall?.telephonySessionId,
            sessionId: activeCall?.sessionId,
            eventTime,
          }),
        }),
        relayMetricObserved({
          domain: saved.company || "TAG",
          metricName: "ringcentral_calls_started",
          sourceKey: "ringcentral-ex",
          amount: 1,
          title: "RingCentral EX call started",
          happenedAt: eventTime,
        }),
      ]);
    } catch (error) {
      logger?.warn("ringcentral.ex.control_plane_relay_failed", {
        error: error.message,
        subtype: "call-started",
        extensionId,
      });
    }
  }

  if (
    telephonyStatus === "NoCall"
    && (previous.status === "onCall" || previous.status === "ringing")
    && (previousCall.telephonySessionId || previousCall.sessionId)
  ) {
    const endedReason = previous.status === "ringing" ? "missed" : "presence-no-call";
    next.lastCallOutcome = endedReason;
    next.dailyStats = applyCallEndedDailyStats(previous, next.dailyStats, {
      missed: endedReason === "missed",
      date: asDate(eventTime),
    });
    if (endedReason === "missed") {
      next.lastMissedCallAt = asDate(eventTime);
      next.lastMissedCallFrom = previousCall.from || null;
      next.lastMissedCallTo = previousCall.to || null;
    }
    const finalized = await persistState(next, existing);

    if (endedReason === "missed") {
      await emitEvent(
        EX_EVENT_TYPES.CALL_MISSED,
        previousCall.telephonySessionId || previousCall.sessionId || extensionId,
        buildEventKey("ex-call-missed", {
          extensionId,
          telephonySessionId: previousCall.telephonySessionId,
          sessionId: previousCall.sessionId,
          eventTime,
        }),
        {
          extensionId,
          agent: buildChangePayload(finalized),
          previousStatus: previous.status,
          endedReason,
          call: previousCall,
          source: "webhook",
          eventTime,
        },
      );

      await recordWorkflowStage({
        domain: finalized.company || "TAG",
        family: "ringcentral",
        subtype: "call-missed",
        stage: "completed",
        aggregateType: "telephony-session",
        aggregateId: previousCall.telephonySessionId || previousCall.sessionId || extensionId,
        sourceService: "ringcentral-cx",
        summary: "EX call missed",
        payload: {
          extensionId,
          direction: previousCall.direction || null,
          from: previousCall.from || null,
          to: previousCall.to || null,
        },
      });
    }

    await emitEvent(
      EX_EVENT_TYPES.CALL_ENDED,
      previousCall.telephonySessionId || previousCall.sessionId || extensionId,
      buildEventKey("ex-call-ended", {
        extensionId,
        telephonySessionId: previousCall.telephonySessionId,
        sessionId: previousCall.sessionId,
        eventTime,
      }),
      {
        extensionId,
        agent: buildChangePayload(finalized),
        previousStatus: previous.status,
        endedReason,
        call: previousCall,
        source: "webhook",
        eventTime,
      },
    );

    await recordWorkflowStage({
      domain: finalized.company || "TAG",
      family: "ringcentral",
      subtype: "call",
      stage: "completed",
      aggregateType: "telephony-session",
      aggregateId: previousCall.telephonySessionId || previousCall.sessionId || extensionId,
      sourceService: "ringcentral-cx",
      summary: endedReason === "missed" ? "EX call ended as missed" : "EX call ended",
      payload: {
        extensionId,
        previousStatus: previous.status,
        endedReason,
        direction: previousCall.direction || null,
        from: previousCall.from || null,
        to: previousCall.to || null,
      },
    });

    try {
      await Promise.all([
        relayReviewItemObserved({
          domain: finalized.company || "TAG",
          category: endedReason === "missed" ? "ringcentral-call-missed" : "ringcentral-call-ended",
          title: endedReason === "missed" ? "RingCentral EX call missed" : "RingCentral EX call ended",
          summary: endedReason === "missed"
            ? `${finalized.name || extensionId} missed a call`
            : `${finalized.name || extensionId} completed a call`,
          payload: {
            extensionId,
            endedReason,
            call: previousCall,
          },
          tags: endedReason === "missed" ? ["ringcentral", "call-missed"] : ["ringcentral", "call-ended"],
          dedupeKey: buildEventKey(endedReason === "missed" ? "cp-call-missed" : "cp-call-ended", {
            extensionId,
            telephonySessionId: previousCall.telephonySessionId,
            sessionId: previousCall.sessionId,
            eventTime,
          }),
        }),
        relayMetricObserved({
          domain: finalized.company || "TAG",
          metricName: endedReason === "missed" ? "ringcentral_calls_missed" : "ringcentral_calls_ended",
          sourceKey: "ringcentral-ex",
          amount: 1,
          title: endedReason === "missed" ? "RingCentral EX call missed" : "RingCentral EX call ended",
          happenedAt: eventTime,
        }),
      ]);
    } catch (error) {
      logger?.warn("ringcentral.ex.control_plane_relay_failed", {
        error: error.message,
        subtype: "call-ended",
        extensionId,
      });
    }

    logger?.info("ringcentral.ex.presence.processed", {
      extensionId,
      previousStatus: previous.status,
      newStatus: finalized.status,
      telephonyStatus,
      endedReason,
    });

    return {
      previous,
      current: finalized.toObject ? finalized.toObject() : finalized,
    };
  }

  logger?.info("ringcentral.ex.presence.processed", {
    extensionId,
    previousStatus: previous.status,
    newStatus: saved.status,
    telephonyStatus,
  });

  return {
    previous,
    current: saved.toObject ? saved.toObject() : saved,
  };
}

function detectPollMismatch(agent, presence, options = {}) {
  const telephonyStatus = presence?.telephonyStatus || "NoCall";
  const activeCalls = Array.isArray(presence?.activeCalls) ? presence.activeCalls : [];
  const activeCall = activeCalls[0] || null;

  if (shouldHoldCxDisposition(agent, telephonyStatus)) {
    return null;
  }
  if (agent.status === "onCall" && telephonyStatus === "NoCall") {
    return { type: "stuck_oncall", activeCall: null };
  }
  if (agent.status === "ringing" && telephonyStatus === "NoCall") {
    return { type: "stuck_ringing", activeCall: null };
  }
  if (
    agent.status === "disposition"
    && telephonyStatus === "NoCall"
    && ageSinceLastStatusChangeMs(agent) > dispositionStaleThresholdMs(options)
  ) {
    return { type: "stuck_disposition", activeCall: null };
  }
  if (
    agent.status === "onCall"
    && telephonyStatus === "CallConnected"
    && activeCall?.sessionId
    && agent.currentCall?.sessionId
    && activeCall.sessionId !== agent.currentCall.sessionId
  ) {
    return { type: "session_mismatch", activeCall };
  }

  return null;
}

async function reconcilePresenceMismatch(agent, presence, logger, options = {}) {
  const mismatch = detectPollMismatch(agent, presence, options);
  if (!mismatch) {
    return { changed: false, reason: null };
  }

  const previous = createStateSnapshot(agent, agent.extensionId);
  const next = createStateSnapshot(agent, agent.extensionId);
  const eventTime = new Date().toISOString();

  if (mismatch.type === "stuck_oncall" || mismatch.type === "stuck_ringing") {
    next.status = "available";
    next.exTelephonyStatus = "NoCall";
    next.currentCall = {};
    next.activePlatform = "none";
    next.lastStatusChange = new Date();
    next.lastCallEndedAt = new Date();
    next.lastCallDirection = previous.currentCall?.direction || next.lastCallDirection || null;
    if (mismatch.type === "stuck_ringing") {
      next.lastCallOutcome = "missed";
      next.dailyStats = applyCallEndedDailyStats(previous, next.dailyStats, {
        missed: true,
      });
      next.lastMissedCallAt = new Date();
      next.lastMissedCallFrom = previous.currentCall?.from || null;
      next.lastMissedCallTo = previous.currentCall?.to || null;
    } else {
      next.lastCallOutcome = "ended";
      next.dailyStats = applyCallEndedDailyStats(previous, next.dailyStats);
    }
  } else if (mismatch.type === "stuck_disposition") {
    next.status = "available";
    next.exTelephonyStatus = "NoCall";
    next.currentCall = {};
    next.activePlatform = "none";
    next.lastStatusChange = new Date();
  } else if (mismatch.type === "session_mismatch") {
    next.status = "onCall";
    next.exTelephonyStatus = "CallConnected";
    next.currentCall = snapshotCurrentCall(mismatch.activeCall);
    next.activePlatform = "EX";
    next.lastStatusChange = new Date();
    next.dailyStats = applyCallStartedDailyStats(previous, next.dailyStats, {
      call: next.currentCall,
      platform: "ex",
      direction: mismatch.activeCall?.direction || null,
    });
  }

  next.exPresenceStatus = presence?.presenceStatus || next.exPresenceStatus;
  next.lastEventReceived = new Date();
  next.lastPresencePollAt = new Date();
  next.lastPresencePollError = null;

  const nextActivityState = deriveActivityState(next, previous.activityState);
  if (next.activityState !== nextActivityState) {
    next.activityState = nextActivityState;
    next.lastActivityAt = new Date();
  }

  const saved = await persistState(next, agent);
  await reactToSavedPresence(saved, logger, agent.extensionId, {
    forceApply: true,
  });

  await emitEvent(
    EX_EVENT_TYPES.POLL_RECONCILED,
    agent.extensionId,
    buildEventKey("ex-poll-reconcile", {
      extensionId: agent.extensionId,
      telephonySessionId: mismatch.activeCall?.telephonySessionId || previous.currentCall?.telephonySessionId,
      sessionId: mismatch.activeCall?.sessionId || previous.currentCall?.sessionId,
      eventTime,
    }),
    {
      reason: mismatch.type,
      previous: buildChangePayload(previous),
      current: buildChangePayload(saved),
      source: "presence-poller",
      eventTime,
    },
  );

  await recordWorkflowStage({
    domain: saved.company || "TAG",
    family: "ringcentral",
    subtype: "poll-reconcile",
    stage: "completed",
    aggregateType: "agent",
    aggregateId: agent.extensionId,
    sourceService: "ringcentral-cx",
    summary: `Presence poll reconciled ${mismatch.type}`,
    payload: {
      reason: mismatch.type,
      previousStatus: previous.status,
      newStatus: saved.status,
    },
  });

  try {
    await relayReviewItemObserved({
      domain: saved.company || "TAG",
      category: "ringcentral-poll-reconcile",
      title: "RingCentral presence reconciled",
      summary: `${saved.name || agent.extensionId} reconciled from ${mismatch.type}`,
      payload: {
        extensionId: agent.extensionId,
        reason: mismatch.type,
        previousStatus: previous.status,
        newStatus: saved.status,
      },
      tags: ["ringcentral", "poll-reconcile"],
      dedupeKey: buildEventKey("cp-poll-reconcile", {
        extensionId: agent.extensionId,
        telephonySessionId: mismatch.activeCall?.telephonySessionId || previous.currentCall?.telephonySessionId,
        sessionId: mismatch.activeCall?.sessionId || previous.currentCall?.sessionId,
        eventTime,
      }),
    });
  } catch (error) {
    logger?.warn("ringcentral.ex.control_plane_relay_failed", {
      error: error.message,
      subtype: "poll-reconcile",
      extensionId: agent.extensionId,
    });
  }

  if (
    (mismatch.type === "stuck_oncall" || mismatch.type === "stuck_ringing")
    && (previous.currentCall?.telephonySessionId || previous.currentCall?.sessionId)
  ) {
    if (mismatch.type === "stuck_ringing") {
      await emitEvent(
        EX_EVENT_TYPES.CALL_MISSED,
        previous.currentCall.telephonySessionId || previous.currentCall.sessionId || agent.extensionId,
        buildEventKey("ex-call-missed-poll", {
          extensionId: agent.extensionId,
          telephonySessionId: previous.currentCall.telephonySessionId,
          sessionId: previous.currentCall.sessionId,
          eventTime,
        }),
        {
          extensionId: agent.extensionId,
          agent: buildChangePayload(saved),
          previousStatus: previous.status,
          endedReason: mismatch.type,
          call: cloneCall(previous.currentCall),
          source: "presence-poller",
          eventTime,
        },
      );
    }

    await emitEvent(
      EX_EVENT_TYPES.CALL_ENDED,
      previous.currentCall.telephonySessionId || previous.currentCall.sessionId || agent.extensionId,
      buildEventKey("ex-call-ended-poll", {
        extensionId: agent.extensionId,
        telephonySessionId: previous.currentCall.telephonySessionId,
        sessionId: previous.currentCall.sessionId,
        eventTime,
      }),
      {
        extensionId: agent.extensionId,
        agent: buildChangePayload(saved),
        previousStatus: previous.status,
        endedReason: mismatch.type,
        call: cloneCall(previous.currentCall),
        source: "presence-poller",
        eventTime,
      },
    );

    await recordWorkflowStage({
      domain: saved.company || "TAG",
      family: "ringcentral",
      subtype: "call",
      stage: "completed",
      aggregateType: "telephony-session",
      aggregateId: previous.currentCall.telephonySessionId || previous.currentCall.sessionId || agent.extensionId,
      sourceService: "ringcentral-cx",
      summary: `EX call ended (${mismatch.type})`,
      payload: {
        extensionId: agent.extensionId,
        endedReason: mismatch.type,
      },
    });
  }

  if (mismatch.type === "session_mismatch" && mismatch.activeCall) {
    await emitEvent(
      EX_EVENT_TYPES.CALL_STARTED,
      mismatch.activeCall.telephonySessionId || mismatch.activeCall.sessionId || agent.extensionId,
      buildEventKey("ex-call-started-poll", {
        extensionId: agent.extensionId,
        telephonySessionId: mismatch.activeCall.telephonySessionId,
        sessionId: mismatch.activeCall.sessionId,
        eventTime,
      }),
      {
        extensionId: agent.extensionId,
        agent: buildChangePayload(saved),
        call: snapshotCurrentCall(mismatch.activeCall),
        source: "presence-poller",
        eventTime,
      },
    );

    await recordWorkflowStage({
      domain: saved.company || "TAG",
      family: "ringcentral",
      subtype: "call",
      stage: "requested",
      aggregateType: "telephony-session",
      aggregateId: mismatch.activeCall.telephonySessionId || mismatch.activeCall.sessionId || agent.extensionId,
      sourceService: "ringcentral-cx",
      summary: "EX call started from poll reconciliation",
      payload: {
        extensionId: agent.extensionId,
        reason: mismatch.type,
      },
    });
  }

  logger?.warn("ringcentral.ex.poll.reconciled", {
    extensionId: agent.extensionId,
    reason: mismatch.type,
    previousStatus: previous.status,
    newStatus: saved.status,
  });

  return {
    changed: true,
    reason: mismatch.type,
    current: saved.toObject ? saved.toObject() : saved,
  };
}

async function reconcilePolledPresence(agent, presence, logger, options = {}) {
  const mismatch = detectPollMismatch(agent, presence, options);
  if (mismatch) {
    return reconcilePresenceMismatch(agent, presence, logger, options);
  }

  const extensionId = normalizeExtensionId(agent.extensionId);
  const previous = createStateSnapshot(agent, extensionId);
  const telephonyStatus = presence?.telephonyStatus || previous.exTelephonyStatus || "NoCall";
  const presenceStatus = normalizePresenceStatus(
    presence?.presenceStatus || presence?.userStatus,
    previous.exPresenceStatus || "Offline",
  );
  const activeCall = Array.isArray(presence?.activeCalls) ? presence.activeCalls[0] || null : null;
  const eventTime = new Date().toISOString();
  const nextStatus = computePolledStatus(previous, telephonyStatus, presenceStatus);
  const holdCxDisposition =
    nextStatus === "disposition" && shouldHoldCxDisposition(previous, telephonyStatus);

  const nextCurrentCall = activeCall
    ? snapshotCurrentCall(activeCall)
    : holdCxDisposition
      ? cloneCall(previous.currentCall)
      : {};
  const nextActivePlatform =
    telephonyStatus === "CallConnected" || telephonyStatus === "OnHold"
      ? "EX"
      : holdCxDisposition
        ? "CX"
        : "none";
  const nextActivityState = holdCxDisposition
    ? "dispositioning"
    : deriveActivityState(
        {
          ...previous,
          status: nextStatus,
          exTelephonyStatus: telephonyStatus,
          exPresenceStatus: presenceStatus,
          currentCall: nextCurrentCall,
          activePlatform: nextActivePlatform,
        },
        previous.activityState,
      );

  const next = {
    ...previous,
    status: nextStatus,
    exTelephonyStatus: telephonyStatus,
    exPresenceStatus: presenceStatus,
    currentCall: nextCurrentCall,
    activePlatform: nextActivePlatform,
    activityState: nextActivityState,
    lastPresencePollAt: new Date(),
    lastPresencePollError: null,
  };
  if (isLikelyCxBridgeExCall(next.currentCall)) {
    next.status = "available";
    next.exTelephonyStatus = "NoCall";
    next.currentCall = {};
    next.activePlatform = "none";
    next.activityState = deriveActivityState(next, previous.activityState);
  }
  next.cxRouting = deriveCxRouting(next, agent?.cxRouting || previous.cxRouting || null);

  if (next.status !== previous.status) {
    next.lastStatusChange = new Date();
  }
  if (next.status === "onCall" && previous.status !== "onCall") {
    next.dailyStats = applyCallStartedDailyStats(previous, next.dailyStats, {
      call: next.currentCall,
      platform: "ex",
      direction: activeCall?.direction || next.currentCall?.direction || null,
    });
  }
  if (previous.status === "onCall" && next.status !== "onCall") {
    next.lastCallEndedAt = new Date();
    next.lastCallOutcome = "ended";
    next.dailyStats = applyCallEndedDailyStats(previous, next.dailyStats);
  }
  if (previous.status === "ringing" && next.status !== "ringing") {
    next.lastCallEndedAt = new Date();
    next.lastCallOutcome = "missed";
    next.lastMissedCallAt = new Date();
    next.lastMissedCallFrom = previous.currentCall?.from || null;
    next.lastMissedCallTo = previous.currentCall?.to || null;
    next.dailyStats = applyCallEndedDailyStats(previous, next.dailyStats, {
      missed: true,
    });
  }

  if (!hasPolledStateChanged(previous, next)) {
    await agentStateRepository.updateAgentState(extensionId, {
      lastPresencePollAt: new Date(),
      lastPresencePollError: null,
      "upstream.source": "ringcentral-ex-poller",
      "upstream.mirroredAt": new Date(),
    });
    return {
      changed: false,
      reason: null,
      current: agent,
    };
  }

  const saved = await persistState(next, agent);
  await reactToSavedPresence(saved, logger, extensionId, {
    forceApply: true,
  });

  await emitEvent(
    EX_EVENT_TYPES.POLL_RECONCILED,
    extensionId,
    buildEventKey("ex-poll-status", {
      extensionId,
      telephonySessionId: activeCall?.telephonySessionId || previous.currentCall?.telephonySessionId,
      sessionId: activeCall?.sessionId || previous.currentCall?.sessionId,
      eventTime,
    }),
    {
      reason: "presence_status_changed",
      previous: buildChangePayload(previous),
      current: buildChangePayload(saved),
      source: "presence-poller",
      eventTime,
    },
  );

  await recordWorkflowStage({
    domain: saved.company || "TAG",
    family: "ringcentral",
    subtype: "poll-reconcile",
    stage: "completed",
    aggregateType: "agent",
    aggregateId: extensionId,
    sourceService: "ringcentral-cx",
    summary: "Presence poll updated EX status",
    payload: {
      previousStatus: previous.status,
      newStatus: saved.status,
      telephonyStatus,
      presenceStatus,
    },
  });

  logger?.info("ringcentral.ex.poll.status_updated", {
    extensionId,
    previousStatus: previous.status,
    newStatus: saved.status,
    telephonyStatus,
    presenceStatus,
  });

  return {
    changed: true,
    reason: "presence_status_changed",
    current: saved.toObject ? saved.toObject() : saved,
  };
}

async function seedPresenceForAgents(logger) {
  const config = getRingCentralConfig();
  const rc = createRingCentralClient();
  const agents = await agentStateRepository.listAgentStates();
  const results = [];

  for (const agent of agents) {
    if (!isPollableExtensionId(agent.extensionId)) {
      results.push({
        extensionId: agent.extensionId,
        changed: false,
        skipped: true,
        reason: "non-ringcentral-extension-id",
      });
      continue;
    }
    try {
      const presence = await rc.getPresence(agent.extensionId);
      const result = await reconcilePolledPresence(agent, presence, logger, {
        staleThresholdMs: config.presenceStaleThresholdMs,
      });
      results.push({
        extensionId: agent.extensionId,
        changed: result.changed,
        reason: result.reason,
      });
    } catch (error) {
      await agentStateRepository.updateAgentState(agent.extensionId, {
        lastPresencePollAt: new Date(),
        lastPresencePollError: error.message,
      }).catch(() => null);
      results.push({
        extensionId: agent.extensionId,
        changed: false,
        error: error.message,
      });
    }
    const paceMs = Math.max(Number(config.presencePollPaceMs) || 0, 0);
    if (paceMs > 0) {
      await sleep(paceMs);
    }
  }

  return {
    checked: agents.length,
    pollable: results.filter((entry) => !entry.skipped).length,
    results,
  };
}

function startPresencePoller(logger) {
  const config = getRingCentralConfig();
  const rc = createRingCentralClient();
  const intervalMs = Math.max(Number(config.presencePollIntervalMs) || 30000, 5000);
  const fullPollIntervalMs = Math.max(
    Number(config.presenceFullPollIntervalMs) || 120000,
    intervalMs,
  );
  const state = {
    enabled: true,
    running: false,
    intervalMs,
    fullPollIntervalMs,
    businessHoursOnly: config.presencePollBusinessHoursOnly !== false,
    businessWindow: getRingCentralBusinessWindow(config, new Date(), "presencePoll"),
    lastStartedAt: null,
    lastCompletedAt: null,
    lastSkippedAt: null,
    lastSkippedReason: null,
    lastAuthCheckAt: null,
    lastAuthResult: null,
    lastFullPollAt: null,
    lastError: null,
    lastResult: null,
    timer: null,
  };

  const tick = async () => {
    if (state.running) return;
    state.running = true;
    state.lastStartedAt = new Date();
    try {
      // Hard cutover kill-switch. Same flag used in ringcentralClient
      // and ringcxVoiceClient — a single env entry stops all RC traffic
      // from this process. The presence poller's setInterval still ticks,
      // but the body short-circuits so we make zero HTTP calls to RC.
      const suspendedFlag = String(process.env.PARALLEL_RC_SUSPENDED || "").trim().toLowerCase();
      if (["1", "true", "yes", "on"].includes(suspendedFlag)) {
        state.lastCompletedAt = new Date();
        state.lastSkippedAt = new Date();
        state.lastSkippedReason = "parallel-rc-suspended";
        state.lastResult = {
          skipped: true,
          reason: "parallel-rc-suspended",
          checked: 0,
          changed: 0,
          staleCount: 0,
          results: [],
        };
        state.lastError = null;
        return;
      }

      const businessWindow = getRingCentralBusinessWindow(config, new Date(), "presencePoll");
      state.businessWindow = businessWindow;
      if (!businessWindow.active) {
        state.lastCompletedAt = new Date();
        state.lastSkippedAt = new Date();
        state.lastSkippedReason = businessWindow.reason;
        state.lastResult = {
          skipped: true,
          reason: businessWindow.reason,
          checked: 0,
          changed: 0,
          staleCount: 0,
          results: [],
        };
        state.lastError = null;
        return;
      }

      state.lastAuthCheckAt = new Date();
      const authResult = await rc.ensureAuthenticated({
        reason: "presence-poller",
        businessHoursOnly: true,
        windowPrefix: "presencePoll",
        minTtlMs: config.presencePollMinTokenTtlMs,
      });
      state.lastAuthResult = authResult;
      if (authResult?.ok === false) {
        throw new Error(authResult.error || "RingCentral authentication failed");
      }
      if (authResult?.skipped) {
        state.lastCompletedAt = new Date();
        state.lastSkippedAt = new Date();
        state.lastSkippedReason = authResult.reason || "auth-skipped";
        state.lastResult = {
          skipped: true,
          reason: authResult.reason || "auth-skipped",
          checked: 0,
          changed: 0,
          staleCount: 0,
          results: [],
        };
        state.lastError = null;
        return;
      }

      const allAgents = await agentStateRepository.listAgentStates();
      const now = Date.now();
      const shouldFullPoll =
        !state.lastFullPollAt
        || now - new Date(state.lastFullPollAt).getTime() >= fullPollIntervalMs;
      const pollableAgents = allAgents.filter((agent) => isPollableExtensionId(agent.extensionId));
      const agents = shouldFullPoll
        ? pollableAgents
        : pollableAgents.filter((agent) => ACTIVE_STATUSES.has(agent.status));
      const results = [];
      const staleThresholdMs = Math.max(Number(config.presenceStaleThresholdMs) || 120000, 30000);
      let staleCount = 0;
      const paceMs = Math.max(Number(config.presencePollPaceMs) || 0, 0);

      for (const agent of agents) {
        const lastEventReceivedAt = agent.lastEventReceived ? new Date(agent.lastEventReceived).getTime() : 0;
        const lastPresencePollAt = agent.lastPresencePollAt ? new Date(agent.lastPresencePollAt).getTime() : 0;
        const latestSignalAt = Math.max(lastEventReceivedAt, lastPresencePollAt);
        if (!latestSignalAt || (Date.now() - latestSignalAt) > staleThresholdMs) {
          staleCount += 1;
        }
        try {
          const presence = await rc.getPresence(agent.extensionId);
          const result = await reconcilePolledPresence(agent, presence, logger, {
            staleThresholdMs,
          });
          results.push({
            extensionId: agent.extensionId,
            changed: result.changed,
            reason: result.reason,
          });
        } catch (error) {
          await agentStateRepository.updateAgentState(agent.extensionId, {
            lastPresencePollAt: new Date(),
            lastPresencePollError: error.message,
          }).catch(() => null);
          results.push({
            extensionId: agent.extensionId,
            changed: false,
            error: error.message,
          });
        }
        if (paceMs > 0) {
          await sleep(paceMs);
        }
      }

      if (shouldFullPoll) {
        state.lastFullPollAt = new Date();
      }
      state.lastCompletedAt = new Date();
      state.lastResult = {
        skipped: false,
        fullPoll: shouldFullPoll,
        totalAgents: allAgents.length,
        pollableAgents: pollableAgents.length,
        checked: agents.length,
        changed: results.filter((entry) => entry.changed).length,
        staleCount,
        results,
      };
      state.lastSkippedReason = null;
      state.lastError = null;
    } catch (error) {
      state.lastCompletedAt = new Date();
      state.lastError = error.message;
    } finally {
      state.running = false;
    }
  };

  state.timer = setInterval(tick, intervalMs);
  if (typeof state.timer.unref === "function") {
    state.timer.unref();
  }
  void tick();

  return {
    getState() {
      return {
        enabled: state.enabled,
        running: state.running,
        intervalMs: state.intervalMs,
        fullPollIntervalMs: state.fullPollIntervalMs,
        businessHoursOnly: state.businessHoursOnly,
        businessWindow: state.businessWindow,
        lastStartedAt: state.lastStartedAt,
        lastCompletedAt: state.lastCompletedAt,
        lastSkippedAt: state.lastSkippedAt,
        lastSkippedReason: state.lastSkippedReason,
        lastAuthCheckAt: state.lastAuthCheckAt,
        lastAuthResult: state.lastAuthResult,
        lastFullPollAt: state.lastFullPollAt,
        lastError: state.lastError,
        lastResult: state.lastResult,
      };
    },
    stop() {
      if (state.timer) {
        clearInterval(state.timer);
        state.timer = null;
      }
    },
    runNow: tick,
  };
}

module.exports = {
  EX_EVENT_TYPES,
  detectPollMismatch,
  processPresenceEnvelope,
  reconcilePolledPresence,
  reconcilePresenceMismatch,
  seedPresenceForAgents,
  startPresencePoller,
};
