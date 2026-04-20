"use strict";

const { createEvent } = require("../../event-core/src");
const { getRingCentralConfig } = require("../../shared-config/src");
const { createRingCentralClient } = require("../../shared-integrations/src");
const { agentStateRepository } = require("../../shared-repositories/src");
const { deriveCxRouting } = require("./agentAvailabilityService");

const EX_EVENT_TYPES = Object.freeze({
  PRESENCE_OBSERVED: "ringcentral.ex.presence.observed",
  AGENT_STATE_CHANGED: "ringcentral.ex.agent-state.changed",
  CALL_STARTED: "ringcentral.ex.call.started",
  CALL_ENDED: "ringcentral.ex.call.ended",
  POLL_RECONCILED: "ringcentral.ex.poll.reconciled",
});

const ACTIVE_STATUSES = new Set(["onCall", "ringing", "disposition"]);

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function asDate(value, fallback = new Date()) {
  const date = value ? new Date(value) : fallback;
  return Number.isNaN(date.getTime()) ? fallback : date;
}

function normalizeExtensionId(value) {
  return String(value || "").trim();
}

function buildDailyStats(existing = {}) {
  const key = todayKey();
  if (existing?.date === key) {
    return {
      date: key,
      hot: Number(existing.hot) || 0,
      day1: Number(existing.day1) || 0,
      day10: Number(existing.day10) || 0,
      aged: Number(existing.aged) || 0,
      totalCalls: Number(existing.totalCalls) || 0,
      goodCalls: Number(existing.goodCalls) || 0,
      badCalls: Number(existing.badCalls) || 0,
    };
  }

  return {
    date: key,
    hot: 0,
    day1: 0,
    day10: 0,
    aged: 0,
    totalCalls: 0,
    goodCalls: 0,
    badCalls: 0,
  };
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
    activePlatform: existing.activePlatform || "none",
    lastStatusChange: existing.lastStatusChange ? asDate(existing.lastStatusChange) : new Date(),
    lastEventReceived: existing.lastEventReceived ? asDate(existing.lastEventReceived) : null,
    dailyStats: buildDailyStats(existing.dailyStats),
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
    activePlatform: agent.activePlatform,
    lastStatusChange: agent.lastStatusChange,
    lastEventReceived: agent.lastEventReceived,
    dailyStats: agent.dailyStats,
    cxRouting: agent.cxRouting,
    ...extra,
  };
}

async function persistState(nextState) {
  const payload = {
    ...nextState,
    cxRouting: deriveCxRouting(nextState),
    upstream: {
      source: "ringcentral-ex",
      mirroredAt: new Date(),
    },
  };
  return agentStateRepository.upsertAgentState(payload);
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
  } else if (telephonyStatus === "CallConnected" || telephonyStatus === "OnHold") {
    next.status = targetStatus;
    next.activePlatform = "EX";
    if (!previous.currentCall?.sessionId || activeCall?.sessionId !== previous.currentCall?.sessionId) {
      next.currentCall = snapshotCurrentCall(activeCall);
    }
    if (previous.status !== "onCall") {
      next.dailyStats.totalCalls += 1;
    }
  } else if (telephonyStatus === "NoCall") {
    next.status = targetStatus;
    if (targetStatus === "disposition" || targetStatus === "available") {
      next.currentCall = {};
      next.activePlatform = targetStatus === "available" ? "none" : previous.activePlatform || "EX";
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

  const saved = await persistState(next);

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
  }

  if (
    telephonyStatus === "NoCall"
    && (previous.status === "onCall" || previous.status === "ringing")
    && (previousCall.telephonySessionId || previousCall.sessionId)
  ) {
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
        agent: buildChangePayload(saved),
        previousStatus: previous.status,
        endedReason: "presence-no-call",
        call: previousCall,
        source: "webhook",
        eventTime,
      },
    );
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

function detectPollMismatch(agent, presence) {
  const telephonyStatus = presence?.telephonyStatus || "NoCall";
  const activeCalls = Array.isArray(presence?.activeCalls) ? presence.activeCalls : [];
  const activeCall = activeCalls[0] || null;

  if (agent.status === "onCall" && telephonyStatus === "NoCall") {
    return { type: "stuck_oncall", activeCall: null };
  }
  if (agent.status === "ringing" && telephonyStatus === "NoCall") {
    return { type: "stuck_ringing", activeCall: null };
  }
  if (agent.status === "disposition" && telephonyStatus === "NoCall") {
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

async function reconcilePresenceMismatch(agent, presence, logger) {
  const mismatch = detectPollMismatch(agent, presence);
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
    next.dailyStats.totalCalls += 1;
  }

  next.exPresenceStatus = presence?.presenceStatus || next.exPresenceStatus;
  next.lastEventReceived = new Date();

  const saved = await persistState(next);

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

  if (
    (mismatch.type === "stuck_oncall" || mismatch.type === "stuck_ringing")
    && (previous.currentCall?.telephonySessionId || previous.currentCall?.sessionId)
  ) {
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

async function seedPresenceForAgents(logger) {
  const rc = createRingCentralClient();
  const agents = await agentStateRepository.listAgentStates();
  const results = [];

  for (const agent of agents) {
    try {
      const presence = await rc.getPresence(agent.extensionId);
      const result = await reconcilePresenceMismatch(agent, presence, logger);
      results.push({
        extensionId: agent.extensionId,
        changed: result.changed,
        reason: result.reason,
      });
    } catch (error) {
      results.push({
        extensionId: agent.extensionId,
        changed: false,
        error: error.message,
      });
    }
  }

  return {
    checked: agents.length,
    results,
  };
}

function startPresencePoller(logger) {
  const config = getRingCentralConfig();
  const rc = createRingCentralClient();
  const state = {
    enabled: true,
    running: false,
    intervalMs: config.presencePollIntervalMs,
    lastStartedAt: null,
    lastCompletedAt: null,
    lastError: null,
    lastResult: null,
    timer: null,
  };

  const tick = async () => {
    if (state.running) return;
    state.running = true;
    state.lastStartedAt = new Date();
    try {
      const agents = (await agentStateRepository.listAgentStates()).filter((agent) => ACTIVE_STATUSES.has(agent.status));
      const results = [];

      for (const agent of agents) {
        try {
          const presence = await rc.getPresence(agent.extensionId);
          const result = await reconcilePresenceMismatch(agent, presence, logger);
          results.push({
            extensionId: agent.extensionId,
            changed: result.changed,
            reason: result.reason,
          });
        } catch (error) {
          results.push({
            extensionId: agent.extensionId,
            changed: false,
            error: error.message,
          });
        }
      }

      state.lastCompletedAt = new Date();
      state.lastResult = {
        checked: agents.length,
        changed: results.filter((entry) => entry.changed).length,
        results,
      };
      state.lastError = null;
    } catch (error) {
      state.lastCompletedAt = new Date();
      state.lastError = error.message;
    } finally {
      state.running = false;
    }
  };

  state.timer = setInterval(tick, Math.max(Number(config.presencePollIntervalMs) || 30000, 5000));
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
        lastStartedAt: state.lastStartedAt,
        lastCompletedAt: state.lastCompletedAt,
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
  processPresenceEnvelope,
  reconcilePresenceMismatch,
  seedPresenceForAgents,
  startPresencePoller,
};
