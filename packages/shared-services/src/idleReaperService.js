"use strict";

const {
  agentSliceRepository,
  agentStateRepository,
  cxDialQueueRepository,
} = require("../../shared-repositories/src");
const { getConfig } = require("./pacingConfigService");
const { isOperatingNow } = require("./businessHoursGuard");
const { releaseSliceById } = require("./agentSliceService");
const {
  isCxWorkspacePresenceActive,
  isCxWorkspacePresenceRequired,
} = require("./agentAvailabilityService");

// idleReaperService — releases active slices for agents who've been
// idle (no activity) for longer than `unavailReaperMinutes`.
//
// "Idle" is defined as: holding an active slice but `lastActivityAt`
// older than the threshold. If the agent has no active slice, the
// reaper has no work for them.
//
// Caller: 60s tick. Only runs during business hours (off-hours, idle
// is meaningless — slices are already paused).

const ACTIVE_CX_QUEUE_STATES = ["queued", "ready", "claimed", "serving", "paused"];
const ACTIVE_CALL_ACTIVITY_STATES = new Set(["dialing", "oncall", "dispositioning", "wrapup"]);
const ORPHAN_DISPOSITION_STATES = new Set(["dispositioning", "wrapup"]);

function normalizeToken(value) {
  return String(value || "").trim().toLowerCase();
}

function resolveCxQueueReleaseReason(agent = null, asOf = new Date()) {
  if (!agent) return "agent-not-found";

  const activityState = normalizeToken(agent.activityState);
  if (ACTIVE_CALL_ACTIVITY_STATES.has(activityState)) return null;
  if (activityState === "offline" || activityState === "unavailable") {
    return `activity-${activityState}`;
  }

  const routing = agent.cxRouting && typeof agent.cxRouting === "object"
    ? agent.cxRouting
    : {};
  if (routing.enabled === false) return "cx-routing-disabled";
  if (normalizeToken(routing.desiredAvailability) !== "available") {
    return normalizeToken(routing.reason) || "cx-unavailable";
  }

  if (isCxWorkspacePresenceRequired() && !isCxWorkspacePresenceActive(agent, asOf)) {
    return "cx-workspace-stale";
  }

  return null;
}

async function reapStaleCxQueueAssignments({ asOf = new Date() } = {}) {
  if (String(process.env.RC_CX_STALE_WORKSPACE_QUEUE_REAPER_ENABLED || "true").toLowerCase() === "false") {
    return { released: 0, reason: "disabled" };
  }

  const assignedItems = await cxDialQueueRepository.listQueueItems({
    states: ACTIVE_CX_QUEUE_STATES,
    limitAll: true,
  });
  const assignedExtensionIds = Array.from(
    new Set(
      assignedItems
        .map((item) => String(item?.assignment?.extensionId || "").trim())
        .filter(Boolean),
    ),
  );
  if (assignedExtensionIds.length === 0) {
    return { released: 0, reason: "no-assigned-cx-queue" };
  }

  // Lazy require avoids coupling the reaper module load path back into the
  // queue mutators while still using the canonical queue-release logic.
  // eslint-disable-next-line global-require
  const { releaseAssignedCxQueueForAgent } = require("./cxCadenceService");
  const results = [];
  for (const extensionId of assignedExtensionIds) {
    const agent = await agentStateRepository.findAgentStateByExtensionId(extensionId);
    const reason = resolveCxQueueReleaseReason(agent, asOf);
    if (!reason) continue;

    const released = await releaseAssignedCxQueueForAgent({
      extensionId,
      now: asOf,
      reason,
      actorEmail: "idle-reaper",
    });
    results.push({
      extensionId,
      reason,
      scanned: released?.scanned || 0,
      released: released?.released || 0,
    });
  }

  return {
    released: results.reduce((total, result) => total + Number(result.released || 0), 0),
    results,
  };
}

function getOrphanDispositionClearMs() {
  const parsed = Number(process.env.RC_CX_ORPHAN_DISPOSITION_CLEAR_MS);
  if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  return 90_000;
}

function shouldClearOrphanCxDisposition(agent = null, asOf = new Date()) {
  if (!agent) return false;
  const activityState = normalizeToken(agent.activityState);
  if (!ORPHAN_DISPOSITION_STATES.has(activityState)) return false;
  const platform = String(agent.activePlatform || "").trim().toUpperCase();
  if (platform && platform !== "CX") return false;
  const currentCall = agent.currentCall && typeof agent.currentCall === "object"
    ? agent.currentCall
    : {};
  const channel = normalizeToken(currentCall.channel);
  if (channel && channel !== "cx") return false;
  const lastCallEndedAt = agent.lastCallEndedAt ? new Date(agent.lastCallEndedAt) : null;
  if (!lastCallEndedAt || Number.isNaN(lastCallEndedAt.getTime())) return false;
  return asOf.getTime() - lastCallEndedAt.getTime() >= getOrphanDispositionClearMs();
}

async function clearOrphanCxDispositionStates({ asOf = new Date() } = {}) {
  if (String(process.env.RC_CX_ORPHAN_DISPOSITION_REAPER_ENABLED || "true").toLowerCase() === "false") {
    return { cleared: 0, reason: "disabled" };
  }

  const agents = await agentStateRepository.listAgentStates({ routingEnabled: true });
  const results = [];

  for (const agent of agents) {
    if (!shouldClearOrphanCxDisposition(agent, asOf)) continue;
    const extensionId = String(agent.extensionId || "").trim();
    if (!extensionId) continue;
    const assignedCount = await cxDialQueueRepository.countQueueItems({
      assignedExtensionId: extensionId,
      states: ACTIVE_CX_QUEUE_STATES,
    });
    if (assignedCount > 0) continue;

    const updated = await agentStateRepository.updateAgentState(extensionId, {
      status: "available",
      activityState: "idle",
      activePlatform: "none",
      currentCall: {},
      lastActivityAt: asOf,
      lastStatusChange: asOf,
      "cxRouting.assignmentStats.openAssignments": 0,
      "cxRouting.reason": "orphan-disposition-cleared",
      "cxRouting.syncedAt": asOf,
      "cxRouting.lastSource": "idle-reaper",
      "upstream.source": "idle-reaper-orphan-disposition",
      "upstream.mirroredAt": asOf,
    }).catch(() => null);

    if (!updated) continue;
    try {
      // Lazy require avoids a module cycle; refill is best-effort.
      // eslint-disable-next-line global-require
      const { onAgentBecomesEligible } = require("./freshLeadAssignmentService");
      await onAgentBecomesEligible(extensionId);
    } catch {
      // Do not fail the reaper if refill has a transient issue.
    }
    results.push({
      extensionId,
      name: agent.name || null,
      lastCallEndedAt: agent.lastCallEndedAt || null,
    });
  }

  return {
    cleared: results.length,
    results,
  };
}

async function reapTick({ asOf = new Date() } = {}) {
  const config = await getConfig();
  if (config.enabled === false) return { reaped: 0, reason: "config-disabled" };
  if (!isOperatingNow(config)) return { reaped: 0, reason: "outside-hours" };

  const thresholdMs = (config.unavailReaperMinutes || 10) * 60 * 1000;
  const cutoff = new Date(asOf.getTime() - thresholdMs);

  const activeSlices = await agentSliceRepository.listActiveSlices();
  const cxQueue = await reapStaleCxQueueAssignments({ asOf });
  const orphanDisposition = await clearOrphanCxDispositionStates({ asOf });
  if (!activeSlices.length) {
    return {
      reaped: 0,
      reason: "no-active-slices",
      cxQueue,
      orphanDisposition,
    };
  }

  let reaped = 0;
  const reapedSlices = [];
  for (const slice of activeSlices) {
    const agent = await agentStateRepository.findAgentStateByExtensionId(slice.agentId);
    if (!agent) continue;
    const lastActivityAt = agent.lastActivityAt
      ? new Date(agent.lastActivityAt)
      : (slice.issuedAt ? new Date(slice.issuedAt) : null);
    if (!lastActivityAt) continue;
    if (lastActivityAt > cutoff) continue;

    // Reap.
    await releaseSliceById(slice.sliceId, { reason: "idle-reaper" });
    reaped += 1;
    reapedSlices.push({
      sliceId: slice.sliceId,
      agentId: slice.agentId,
      idleSinceMs: asOf.getTime() - lastActivityAt.getTime(),
    });
  }

  return { reaped, reapedSlices, cxQueue, orphanDisposition };
}

module.exports = {
  clearOrphanCxDispositionStates,
  reapTick,
  reapStaleCxQueueAssignments,
};
