"use strict";

const CX_BULK_LOAD_PHASES = Object.freeze({
  IDLE: "idle",
  WAITING_OFFHOOK: "waiting_offhook",
  PRELOADING: "preloading",
  READY: "ready",
  WATCHING: "watching",
  ACTIVE: "active",
  RELEASING: "releasing",
  REFILLING: "refilling",
  RELEASED: "released",
  FAILED: "failed",
});

function clonePlain(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return JSON.parse(JSON.stringify(value));
}

function arrayOf(value) {
  return Array.isArray(value) ? value.map((item) => clonePlain(item)) : [];
}

function queueItemKey(value = null) {
  return String(value?.queueItemId || value?.id || value?._id || "").trim();
}

function upsertByQueueItemId(items = [], candidate = {}) {
  const key = queueItemKey(candidate);
  if (!key) return arrayOf(items);
  let replaced = false;
  const next = arrayOf(items).map((item) => {
    if (queueItemKey(item) !== key) return item;
    replaced = true;
    return {
      ...item,
      ...clonePlain(candidate),
    };
  });
  if (!replaced) next.push(clonePlain(candidate));
  return next;
}

function removeByQueueItemId(items = [], candidate = {}) {
  const key = queueItemKey(candidate);
  if (!key) return arrayOf(items);
  return arrayOf(items).filter((item) => queueItemKey(item) !== key);
}

function pushCompletedOnce(items = [], outcome = {}) {
  const key = queueItemKey(outcome);
  if (!key) return arrayOf(items);
  const existing = arrayOf(items);
  if (existing.some((item) => queueItemKey(item) === key && item.outcome === outcome.outcome)) {
    return existing;
  }
  return [...existing, clonePlain(outcome)].slice(-200);
}

function normalizeIso(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function reduceCxBulkLoadState(previous = {}, event = {}, nowInput = new Date()) {
  const now = nowInput instanceof Date ? nowInput : new Date(nowInput);
  const nowIso = now.toISOString();
  const state = {
    ...clonePlain(previous || {}),
    current: previous.current ? clonePlain(previous.current) : null,
    acceptedBuffer: arrayOf(previous.acceptedBuffer),
    completed: arrayOf(previous.completed),
    stats: previous.stats ? clonePlain(previous.stats) : {},
    trace: previous.trace ? clonePlain(previous.trace) : {},
    phase: previous.phase || CX_BULK_LOAD_PHASES.IDLE,
    status: previous.status || "running",
    updatedAt: nowIso,
  };

  switch (event.type) {
    case "session.started": {
      state.status = "running";
      state.phase = CX_BULK_LOAD_PHASES.IDLE;
      state.startedAt = nowIso;
      state.acceptedBuffer = [];
      state.completed = [];
      state.current = null;
      state.trace = {};
      state.reviewHoldUntil = null;
      state.reviewHoldReason = null;
      state.lastOutcome = null;
      state.lastError = null;
      break;
    }
    case "buffer.preload_started": {
      state.phase = CX_BULK_LOAD_PHASES.PRELOADING;
      state.lastError = null;
      state.stats = {
        ...state.stats,
        targetSize: event.targetSize ?? state.stats.targetSize ?? null,
      };
      break;
    }
    case "agent.waiting_offhook": {
      state.phase = CX_BULK_LOAD_PHASES.WAITING_OFFHOOK;
      state.lastError = null;
      state.trace = {
        ...state.trace,
        offhook: {
          ready: false,
          reason: event.reason || "agent-not-offhook",
          checkedAt: nowIso,
        },
      };
      break;
    }
    case "agent.offhook_ready": {
      if (state.phase === CX_BULK_LOAD_PHASES.WAITING_OFFHOOK) {
        state.phase = state.acceptedBuffer.length > 0 ? CX_BULK_LOAD_PHASES.READY : CX_BULK_LOAD_PHASES.IDLE;
      }
      state.lastError = null;
      state.trace = {
        ...state.trace,
        offhook: {
          ready: true,
          reason: event.reason || "agent-offhook",
          checkedAt: nowIso,
        },
      };
      break;
    }
    case "buffer.refill_started": {
      state.phase = CX_BULK_LOAD_PHASES.REFILLING;
      state.lastError = null;
      state.stats = {
        ...state.stats,
        refillThreshold: event.refillThreshold ?? state.stats.refillThreshold ?? null,
      };
      break;
    }
    case "buffer.publish_accepted": {
      const candidate = {
        ...(event.candidate || {}),
        phase: "accepted",
        status: "accepted",
        ringcx: {
          ...(event.candidate?.ringcx || {}),
          campaignId: event.campaignId || event.candidate?.campaignId || null,
          dialGroupId: event.dialGroupId || event.candidate?.dialGroupId || null,
          accountId: event.accountId || event.candidate?.accountId || null,
          externId: event.externId || event.candidate?.externId || null,
          loadSummary: event.loadSummary || null,
          acceptedAt: nowIso,
        },
        campaignId: event.campaignId || event.candidate?.campaignId || null,
        dialGroupId: event.dialGroupId || event.candidate?.dialGroupId || null,
        accountId: event.accountId || event.candidate?.accountId || null,
        externId: event.externId || event.candidate?.externId || null,
        acceptedAt: nowIso,
      };
      state.acceptedBuffer = upsertByQueueItemId(state.acceptedBuffer, candidate);
      state.phase = state.current ? state.phase : CX_BULK_LOAD_PHASES.READY;
      state.stats = {
        ...state.stats,
        acceptedCount: Number(state.stats.acceptedCount || 0) + 1,
      };
      break;
    }
    case "buffer.publish_failed": {
      state.lastError = event.error || event.reason || "bulk-publish-failed";
      state.stats = {
        ...state.stats,
        failedPublishCount: Number(state.stats.failedPublishCount || 0) + 1,
      };
      break;
    }
    case "watch.started": {
      state.phase = state.current ? state.phase : CX_BULK_LOAD_PHASES.WATCHING;
      break;
    }
    case "current.matched": {
      const candidate = {
        ...(event.candidate || {}),
        phase: CX_BULK_LOAD_PHASES.ACTIVE,
        status: "active",
        uii: event.uii || event.candidate?.uii || null,
        activeCallSummary: event.activeCallSummary || null,
        matchReasons: Array.isArray(event.matchReasons) ? event.matchReasons : [],
        activeAt: nowIso,
        updatedAt: nowIso,
      };
      if (event.completePrevious === true && state.current) {
        const previous = {
          ...state.current,
          // M11 gate 9: never default a completed record to the synthetic `auto_advanced`
          // outcome — a no-intent auto-advance release is `did_not_connect`.
          outcome: event.previousOutcome || "did_not_connect",
          releasedAt: nowIso,
        };
        state.completed = pushCompletedOnce(state.completed, previous);
        // TRUNK (2026-07-02): a superseded ANSWERED call (connectedAt latched, no
        // manual disposition) must stay reachable for the answered-undisposed
        // correction card — lastOutcome is where the UI reads it.
        state.lastOutcome = previous;
      }
      state.current = candidate;
      state.acceptedBuffer = removeByQueueItemId(state.acceptedBuffer, candidate);
      state.reviewHoldUntil = null;
      state.reviewHoldReason = null;
      state.phase = CX_BULK_LOAD_PHASES.ACTIVE;
      break;
    }
    case "terminal.started": {
      state.phase = CX_BULK_LOAD_PHASES.RELEASING;
      if (state.current) {
        state.current = {
          ...state.current,
          phase: CX_BULK_LOAD_PHASES.RELEASING,
          outcome: event.outcome || null,
          terminalStartedAt: nowIso,
          updatedAt: nowIso,
        };
      }
      break;
    }
    case "terminal.accepted": {
      const outcome = {
        ...(state.current || event.candidate || {}),
        phase: CX_BULK_LOAD_PHASES.RELEASED,
        outcome: event.outcome || state.current?.outcome || null,
        hangup: event.hangup || null,
        cadence: event.cadence || null,
        releasedAt: nowIso,
      };
      state.completed = pushCompletedOnce(state.completed, outcome);
      state.lastOutcome = outcome;
      state.acceptedBuffer = removeByQueueItemId(state.acceptedBuffer, outcome);
      state.current = null;
      state.reviewHoldUntil = normalizeIso(event.reviewHoldUntil);
      state.reviewHoldReason = event.reviewHoldReason || null;
      state.phase = state.acceptedBuffer.length > 0 ? CX_BULK_LOAD_PHASES.READY : CX_BULK_LOAD_PHASES.RELEASED;
      break;
    }
    case "terminal.failed": {
      state.phase = state.current?.uii ? CX_BULK_LOAD_PHASES.ACTIVE : CX_BULK_LOAD_PHASES.FAILED;
      state.lastError = event.error || event.reason || "terminal-failed";
      if (state.current) {
        state.current = {
          ...state.current,
          phase: state.phase,
          terminalError: state.lastError,
          terminalFailedAt: nowIso,
          updatedAt: nowIso,
        };
      }
      break;
    }
    case "current.cleared": {
      state.current = null;
      state.reviewHoldUntil = null;
      state.reviewHoldReason = null;
      state.phase = state.acceptedBuffer.length > 0 ? CX_BULK_LOAD_PHASES.READY : CX_BULK_LOAD_PHASES.RELEASED;
      break;
    }
    case "current.released": {
      if (state.current) {
        const outcome = {
          ...state.current,
          phase: CX_BULK_LOAD_PHASES.RELEASED,
          outcome: event.outcome || "did_not_connect",
          releaseReason: event.reason || "ringcx-current-released",
          releasedAt: nowIso,
        };
        state.completed = pushCompletedOnce(state.completed, outcome);
        state.lastOutcome = outcome;
      }
      state.current = null;
      state.reviewHoldUntil = normalizeIso(event.reviewHoldUntil);
      state.reviewHoldReason = event.reviewHoldReason || event.reason || null;
      state.phase = state.acceptedBuffer.length > 0 ? CX_BULK_LOAD_PHASES.READY : CX_BULK_LOAD_PHASES.RELEASED;
      break;
    }
    case "buffer.released": {
      // M11 gate 1: a buffered lead RingCX dialed AND released between two polls (never our
      // `current`). Count it as completed and drop it from the buffer; `current` is untouched.
      const releasedCandidate = event.candidate || {};
      const releasedOutcome = {
        ...releasedCandidate,
        phase: CX_BULK_LOAD_PHASES.RELEASED,
        outcome: event.outcome || "did_not_connect",
        releasedAt: nowIso,
      };
      state.completed = pushCompletedOnce(state.completed, releasedOutcome);
      state.acceptedBuffer = removeByQueueItemId(state.acceptedBuffer, releasedCandidate);
      break;
    }
    case "session.completed": {
      state.status = "completed";
      state.phase = CX_BULK_LOAD_PHASES.RELEASED;
      state.completedAt = nowIso;
      break;
    }
    case "session.killed": {
      state.status = "killed";
      state.phase = CX_BULK_LOAD_PHASES.RELEASED;
      state.current = null;
      state.reviewHoldUntil = null;
      state.reviewHoldReason = null;
      state.acceptedBuffer = [];
      state.prevActiveExternIds = [];
      state.killedAt = nowIso;
      state.lastError = event.reason || null;
      break;
    }
    case "failed": {
      state.status = event.fatal === true ? "failed" : state.status;
      state.phase = CX_BULK_LOAD_PHASES.FAILED;
      state.lastError = event.error || event.reason || "cx-bulk-load-failed";
      break;
    }
    default:
      break;
  }

  state.trace = {
    ...(state.trace || {}),
    lastEvent: event.type || "unknown",
    lastTransitionAt: nowIso,
  };
  return state;
}

module.exports = {
  CX_BULK_LOAD_PHASES,
  reduceCxBulkLoadState,
};
