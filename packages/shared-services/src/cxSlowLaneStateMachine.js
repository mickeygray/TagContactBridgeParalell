"use strict";

const CX_SLOW_LANE_PHASES = Object.freeze({
  IDLE: "idle",
  SELECTING: "selecting",
  PUBLISHING: "publishing",
  PENDING_CONFIRMATION: "pending_confirmation",
  ACTIVE: "active",
  RELEASING: "releasing",
  RELEASED: "released",
  FAILED: "failed",
});

function clonePlain(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return JSON.parse(JSON.stringify(value));
}

function reduceCxSlowLaneState(previous = {}, event = {}, nowInput = new Date()) {
  const now = nowInput instanceof Date ? nowInput : new Date(nowInput);
  const nowIso = now.toISOString();
  const state = {
    ...clonePlain(previous || {}),
    current: previous.current ? clonePlain(previous.current) : null,
    lastOutcome: previous.lastOutcome ? clonePlain(previous.lastOutcome) : null,
    trace: previous.trace ? clonePlain(previous.trace) : {},
    phase: previous.phase || CX_SLOW_LANE_PHASES.IDLE,
    status: previous.status || "running",
    updatedAt: nowIso,
  };

  switch (event.type) {
    case "session.started": {
      state.status = "running";
      state.phase = CX_SLOW_LANE_PHASES.IDLE;
      state.startedAt = state.startedAt || nowIso;
      break;
    }
    case "select.started": {
      state.phase = CX_SLOW_LANE_PHASES.SELECTING;
      state.lastError = null;
      break;
    }
    case "publish.started": {
      state.phase = CX_SLOW_LANE_PHASES.PUBLISHING;
      state.current = {
        ...(event.current || {}),
        phase: CX_SLOW_LANE_PHASES.PUBLISHING,
        selectedAt: event.current?.selectedAt || nowIso,
        updatedAt: nowIso,
      };
      state.lastError = null;
      break;
    }
    case "publish.accepted": {
      state.phase = CX_SLOW_LANE_PHASES.PENDING_CONFIRMATION;
      if (state.current) {
        state.current = {
          ...state.current,
          phase: CX_SLOW_LANE_PHASES.PENDING_CONFIRMATION,
          ringcx: {
            ...(state.current.ringcx || {}),
            status: "published",
            campaignId: event.campaignId || state.current.campaignId || null,
            dialGroupId: event.dialGroupId || state.current.dialGroupId || null,
            accountId: event.accountId || state.current.accountId || null,
            externId: event.externId || state.current.externId || null,
            loadSummary: event.loadSummary || null,
            publishedAt: nowIso,
          },
          campaignId: event.campaignId || state.current.campaignId || null,
          dialGroupId: event.dialGroupId || state.current.dialGroupId || null,
          accountId: event.accountId || state.current.accountId || null,
          externId: event.externId || state.current.externId || null,
          updatedAt: nowIso,
        };
      }
      break;
    }
    case "active.confirmed": {
      state.phase = CX_SLOW_LANE_PHASES.ACTIVE;
      state.trace = {
        ...(state.trace || {}),
        captureMisses: 0,
        captureMissLimit: event.missLimit ?? state.trace?.captureMissLimit ?? null,
      };
      if (state.current) {
        state.current = {
          ...state.current,
          phase: CX_SLOW_LANE_PHASES.ACTIVE,
          uii: event.uii || state.current.uii || null,
          activeCallSummary: event.activeCallSummary || null,
          matchReasons: Array.isArray(event.matchReasons) ? event.matchReasons : [],
          callPlacedResult: event.callPlacedResult || state.current.callPlacedResult || null,
          callPlacedRecordedAt:
            event.callPlacedResult ? nowIso : state.current.callPlacedRecordedAt || null,
          firstPollMs: event.firstPollMs ?? null,
          uiiFoundMs: event.uiiFoundMs ?? null,
          activeAt: nowIso,
          updatedAt: nowIso,
        };
      }
      break;
    }
    case "active.pending": {
      const priorMisses = Number(state.trace?.captureMisses || 0) || 0;
      const captureMisses = Number(event.captureMisses || 0) || priorMisses + 1;
      state.trace = {
        ...(state.trace || {}),
        captureMisses,
        captureMissLimit: event.missLimit ?? state.trace?.captureMissLimit ?? null,
        lastCaptureMissReason: event.reason || "active-call-not-found",
        lastCaptureMissAt: nowIso,
      };
      if (state.phase === CX_SLOW_LANE_PHASES.ACTIVE && state.current?.uii) {
        state.trace = {
          ...(state.trace || {}),
          ignoredPendingReason: event.reason || "active-call-not-found",
          ignoredPendingAt: nowIso,
        };
        break;
      }
      state.phase = CX_SLOW_LANE_PHASES.PENDING_CONFIRMATION;
      if (state.current) {
        state.current = {
          ...state.current,
          phase: CX_SLOW_LANE_PHASES.PENDING_CONFIRMATION,
          pendingReason: event.reason || "active-call-not-found",
          lastCaptureAt: nowIso,
          updatedAt: nowIso,
        };
      }
      break;
    }
    case "active.failed": {
      state.phase = CX_SLOW_LANE_PHASES.FAILED;
      state.lastError = event.error || event.reason || "active-call-confirmation-failed";
      state.lastOutcome = state.current
        ? {
          ...state.current,
          phase: CX_SLOW_LANE_PHASES.FAILED,
          error: state.lastError,
          failedAt: nowIso,
        }
        : state.lastOutcome;
      state.current = null;
      state.trace = {
        ...(state.trace || {}),
        captureMisses: event.captureMisses ?? state.trace?.captureMisses ?? null,
        captureMissLimit: event.missLimit ?? state.trace?.captureMissLimit ?? null,
        activeFailedAt: nowIso,
        activeFailedReason: state.lastError,
      };
      break;
    }
    case "terminal.started": {
      state.phase = CX_SLOW_LANE_PHASES.RELEASING;
      if (state.current) {
        state.current = {
          ...state.current,
          phase: CX_SLOW_LANE_PHASES.RELEASING,
          outcome: event.outcome || null,
          terminalStartedAt: nowIso,
          updatedAt: nowIso,
        };
      }
      break;
    }
    case "terminal.failed": {
      state.phase = state.current?.uii ? CX_SLOW_LANE_PHASES.ACTIVE : CX_SLOW_LANE_PHASES.FAILED;
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
    case "terminal.accepted": {
      state.phase = CX_SLOW_LANE_PHASES.RELEASED;
      state.lastOutcome = {
        ...(state.current || {}),
        phase: CX_SLOW_LANE_PHASES.RELEASED,
        outcome: event.outcome || state.current?.outcome || null,
        hangup: event.hangup || null,
        cadence: event.cadence || null,
        releasedAt: nowIso,
      };
      state.current = null;
      break;
    }
    case "next.unavailable": {
      state.phase = CX_SLOW_LANE_PHASES.RELEASED;
      state.current = null;
      state.lastError = event.reason || null;
      state.trace = {
        ...(state.trace || {}),
        nextUnavailableAt: nowIso,
        nextUnavailableReason: event.reason || "no-next-lead",
      };
      break;
    }
    case "next.failed": {
      state.phase = CX_SLOW_LANE_PHASES.RELEASED;
      state.current = null;
      state.lastError = event.error || event.reason || "next-lead-failed";
      state.trace = {
        ...(state.trace || {}),
        nextFailedAt: nowIso,
        nextFailedReason: state.lastError,
      };
      break;
    }
    case "session.completed": {
      state.status = "completed";
      state.phase = CX_SLOW_LANE_PHASES.RELEASED;
      state.completedAt = nowIso;
      break;
    }
    case "session.killed": {
      state.status = "killed";
      state.phase = CX_SLOW_LANE_PHASES.RELEASED;
      state.killedAt = nowIso;
      state.current = null;
      state.lastError = event.reason || null;
      break;
    }
    case "failed": {
      state.status = event.fatal === true ? "failed" : state.status;
      state.phase = CX_SLOW_LANE_PHASES.FAILED;
      state.lastError = event.error || event.reason || "cx-slow-lane-failed";
      if (state.current) {
        state.current = {
          ...state.current,
          phase: CX_SLOW_LANE_PHASES.FAILED,
          error: state.lastError,
          failedAt: nowIso,
          updatedAt: nowIso,
        };
      }
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
  CX_SLOW_LANE_PHASES,
  reduceCxSlowLaneState,
};
