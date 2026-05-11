"use strict";

const {
  queueItemRepository,
  agentStateRepository,
  callSessionRepository,
} = require("../../shared-repositories/src");
const { getConfig } = require("./pacingConfigService");
const { formatHourBucket, isOperatingNow } = require("./businessHoursGuard");

// freshLeadAssignmentService — handles the fresh-lead lane.
//
// Fresh leads bypass the standard 10-batch slicing. They land in the
// pool with partition: "fresh" and get assigned to ONE eligible idle
// agent via round-robin, with a hard timer (default 90s).
//
// Timer expiry → ripped out, reassigned to next idle agent.
// All agents busy → moved to pending_assignment lane, drained when
// any agent becomes eligible.
//
// Round-robin state: tracked in-process. On service restart, it just
// starts fresh — at most a momentary fairness hiccup.

let lastAssignedIndex = -1;

// ── Helpers ────────────────────────────────────────────────────────

async function listEligibleIdleAgents(config, { excludeAgentIds = [] } = {}) {
  if (!config) config = await getConfig();
  const all = await agentStateRepository.listAgentStates({ routingEnabled: true });
  const skip = new Set((excludeAgentIds || []).map(String));
  const baseEligible = (all || []).filter((agent) => {
    if (skip.has(String(agent.extensionId))) return false;
    if (!agent.cxRouting?.enabled) return false;
    if (agent.cxRouting?.desiredAvailability !== "available") return false;
    const activityState = agent.activityState || "idle";
    if (["onCall", "dialing", "dispositioning", "wrapup", "unavailable", "offline"].includes(activityState)) {
      return false;
    }
    return true;
  });

  // Filter out agents who already have a fresh_assigned item OR an
  // active CallSession. Done sequentially to avoid an N+1 nightmare —
  // for typical agent counts (<20) this is fine.
  const truly = [];
  for (const agent of baseEligible) {
    const items = await queueItemRepository.listByAgent(agent.extensionId, {
      states: ["fresh_assigned"],
    });
    if (items.length) continue;
    const activeCall = await callSessionRepository.findActiveByAgent(agent.extensionId);
    if (activeCall) continue;
    truly.push(agent);
  }
  return truly;
}

function pickRoundRobin(eligibleAgents) {
  if (!eligibleAgents.length) return null;
  lastAssignedIndex = (lastAssignedIndex + 1) % eligibleAgents.length;
  return eligibleAgents[lastAssignedIndex];
}

// ── Assign one fresh item ──────────────────────────────────────────
//
// Called when a fresh QueueItem appears (either via enqueueLead or
// found in pending_assignment by the drain worker).

async function assignOne(itemId, { excludeAgentIds = [] } = {}) {
  const config = await getConfig();
  if (config.enabled === false) return { assigned: false, reason: "config-disabled" };

  // If outside business hours, park in pending_assignment lane.
  if (!isOperatingNow(config)) {
    const moved = await queueItemRepository.moveToPendingAssignment(itemId);
    return {
      assigned: false,
      reason: "outside-hours",
      pending: Boolean(moved),
    };
  }

  const eligible = await listEligibleIdleAgents(config, { excludeAgentIds });
  if (!eligible.length) {
    const moved = await queueItemRepository.moveToPendingAssignment(itemId);
    return {
      assigned: false,
      reason: "no-eligible-agents",
      pending: Boolean(moved),
    };
  }

  const agent = pickRoundRobin(eligible);
  const timerSeconds = config.freshLeadTimerSeconds || 90;
  const expiresAt = new Date(Date.now() + timerSeconds * 1000);
  const tz = config.businessHoursTimezone || "America/Los_Angeles";
  const hourBucket = formatHourBucket(new Date(), tz);

  const claimed = await queueItemRepository.claimToFreshAgent(itemId, {
    agentId: agent.extensionId,
    expiresAt,
    hourBucket,
  });
  if (!claimed) {
    return { assigned: false, reason: "claim-race-lost" };
  }

  return {
    assigned: true,
    agentId: agent.extensionId,
    agentName: agent.name,
    expiresAt,
    item: claimed,
  };
}

// ── Drain pending_assignment lane ──────────────────────────────────
//
// Called when an agent becomes eligible OR by the 60s tick. Iterates
// pending fresh items in FIFO order, tries to assign each. Stops when
// no eligible agents left or pending lane drained.

async function drainPending({ maxItems = 20 } = {}) {
  const config = await getConfig();
  if (config.enabled === false) return { drained: 0, reason: "config-disabled" };
  if (!isOperatingNow(config)) return { drained: 0, reason: "outside-hours" };

  const pending = await queueItemRepository.listPendingAssignments({
    partition: "fresh",
    limit: maxItems,
  });
  if (!pending.length) return { drained: 0, reason: "lane-empty" };

  let drained = 0;
  const results = [];
  for (const item of pending) {
    const result = await assignOne(item._id);
    if (result.assigned) {
      drained += 1;
      results.push(result);
    } else if (result.reason === "no-eligible-agents") {
      // Stop — no one to assign to right now
      break;
    }
  }
  return { drained, results };
}

// ── Expiry sweep ───────────────────────────────────────────────────
//
// Runs every 60s. Finds fresh_assigned items where expiresAt <= now,
// releases them back to pending_assignment, then drains.

async function expirySweep({ asOf = new Date() } = {}) {
  const expired = await queueItemRepository.listExpiredFreshAssignments(asOf);
  let releasedCount = 0;
  // Track previous owners so the immediate re-assignment doesn't pick
  // the same agent who just let it expire.
  const expiredBy = new Map(); // itemId → previousOwnerAgentId
  for (const item of expired) {
    expiredBy.set(String(item._id), String(item.assignedTo || ""));
    await queueItemRepository.releaseFreshAssignment(item._id, { reason: "timer-expired" });
    releasedCount += 1;
  }
  // Try to re-assign immediately after release. For each pending item
  // that was just released, exclude the previous owner.
  let drainedCount = 0;
  if (releasedCount > 0) {
    const config = await getConfig();
    if (config.enabled !== false && isOperatingNow(config)) {
      const pending = await queueItemRepository.listPendingAssignments({
        partition: "fresh",
        limit: 50,
      });
      for (const item of pending) {
        const prevOwner = expiredBy.get(String(item._id));
        const result = await assignOne(item._id, {
          excludeAgentIds: prevOwner ? [prevOwner] : [],
        });
        if (result.assigned) drainedCount += 1;
        else if (result.reason === "no-eligible-agents") break;
      }
    }
  }
  return {
    expiredCount: releasedCount,
    drained: drainedCount,
  };
}

// ── Hook for "agent just became eligible" ──────────────────────────
//
// Called from processPresenceEnvelope when an agent transitions to
// idle inside business hours. Drains pending_assignment to give them
// a fresh lead immediately (don't wait for the next 60s tick).

async function onAgentBecomesEligible(agentId) {
  const config = await getConfig();
  if (config.enabled === false) return { triggered: false, reason: "config-disabled" };
  if (!isOperatingNow(config)) return { triggered: false, reason: "outside-hours" };

  const result = { triggered: false };

  // 1. Try to assign a pending fresh lead (highest priority lane).
  //    Cheap drain — at most 1 item, since the agent can only take one
  //    fresh assignment at a time anyway.
  const pending = await queueItemRepository.listPendingAssignments({
    partition: "fresh",
    limit: 1,
  });
  if (pending.length) {
    const fresh = await assignOne(pending[0]._id);
    if (fresh.assigned) {
      result.triggered = true;
      result.fresh = fresh;
    } else {
      result.freshReason = fresh.reason;
    }
  }

  // 2. Generate a non-fresh slice if the agent has none. Without this,
  //    an agent who toggles back from "unavailable" to "available"
  //    mid-hour would have an empty queue until the next hourly rollover.
  //    issueSlice's own eligibility check rejects if a slice already exists.
  //    Lazy require: agentSliceService → universalQueueService → cycle risk.
  // eslint-disable-next-line global-require
  const { issueSlice } = require("./agentSliceService");
  const slice = await issueSlice(agentId);
  if (slice.issued) {
    result.triggered = true;
    result.slice = {
      sliceId: slice.sliceId,
      sliceSize: slice.sliceSize,
      ageMix: slice.ageMix,
    };
  } else {
    result.sliceReason = slice.reason;
  }

  return result;
}

module.exports = {
  assignOne,
  drainPending,
  expirySweep,
  onAgentBecomesEligible,
  listEligibleIdleAgents,
  // exposed for tests:
  __resetRoundRobin: () => { lastAssignedIndex = -1; },
};
