"use strict";

const crypto = require("crypto");
const {
  queueItemRepository,
  agentSliceRepository,
  agentStateRepository,
  callSessionRepository,
} = require("../../shared-repositories/src");
const { getConfig } = require("./pacingConfigService");
const { formatHourBucket, isOperatingNow } = require("./businessHoursGuard");

// agentSliceService — issues, releases, and tracks the 10-batch slices
// of non-fresh QueueItems handed to each agent.
//
// Core flow:
//   issueSlice(agent) →
//     1. Check eligibility (presence gate + business hours + no active slice)
//     2. Read pool's age-bucket distribution
//     3. Compute target counts per bucket (proportional sampling)
//     4. Pull FIFO-oldest items per bucket, atomically claim each
//     5. Create AgentSlice doc with sliceId, ageMix
//
//   releaseSlice(agent, reason) →
//     1. Mark AgentSlice as released
//     2. Bulk-flip in_slice items back to in_pool (with bumped enteredQueueAt)
//
// Atomicity: each item claim is a separate findOneAndUpdate. Two
// concurrent issuers might find the same candidate, but only one wins
// the CAS. The losing issuer just gets a smaller slice (caller can re-pull).
//
// Eligibility (must all be true):
//   - PacingConfig.enabled === true
//   - isOperatingNow(config) === true
//   - Agent's cxRouting.enabled === true
//   - Agent's cxRouting.desiredAvailability === "available"
//   - Agent doesn't have an active slice already

async function isAgentEligibleForSlice(agentId, config) {
  if (!config) config = await getConfig();
  if (config.enabled === false) return { eligible: false, reason: "config-disabled" };
  if (!isOperatingNow(config)) return { eligible: false, reason: "outside-hours" };

  const agent = await agentStateRepository.findAgentStateByExtensionId(agentId);
  if (!agent) return { eligible: false, reason: "agent-not-found" };
  if (!agent.cxRouting?.enabled) return { eligible: false, reason: "cx-routing-disabled" };
  if (agent.cxRouting?.desiredAvailability === "unavailable") {
    return { eligible: false, reason: `agent-unavailable:${agent.cxRouting?.reason || "unknown"}` };
  }
  // activityState: introduced in this PR. If not yet present on the
  // doc, default to "idle" (treat as eligible).
  const activityState = agent.activityState || "idle";
  if (["onCall", "dialing", "dispositioning", "wrapup", "unavailable", "offline"].includes(activityState)) {
    return { eligible: false, reason: `activity-${activityState}` };
  }

  const existing = await agentSliceRepository.findActiveByAgent(agentId);
  if (existing) return { eligible: false, reason: "active-slice-exists", existing };

  // Belt-and-suspenders: an active CallSession means the agent is on
  // a call regardless of stale activityState. Block slice issuance.
  const activeCall = await callSessionRepository.findActiveByAgent(agentId);
  if (activeCall) return { eligible: false, reason: "active-call-session", activeCall };

  return { eligible: true, agent };
}

// ── Proportional age-mix sampling ──────────────────────────────────
//
// Given the pool's current ageBucket distribution and a slice size,
// compute target counts per non-fresh bucket so each slice approximates
// the global mix. Fresh buckets are NOT sampled here — fresh leads ride
// in their own per-agent fresh queue, not in slices.
//
// Algorithm:
//   1. Sum non-fresh pool counts (day2_10 + aged)
//   2. For each bucket, target[b] = round(sliceSize * pool[b] / total)
//   3. Drift correction: if sum(target) != sliceSize, adjust the
//      largest bucket by ±1 until it matches
//   4. Cap each bucket at the actual pool[b] (can't take more than exists)
//
// Returns { day2_10: n, aged: n } summing to <= sliceSize.

function computeTargetMix({ poolByAgeBucket, sliceSize }) {
  const buckets = ["day2_10", "aged"];
  const counts = {};
  let total = 0;
  for (const b of buckets) {
    counts[b] = poolByAgeBucket?.[b] || 0;
    total += counts[b];
  }

  if (total === 0) return { day2_10: 0, aged: 0 };

  const desiredSize = Math.min(sliceSize, total);
  const target = {};
  for (const b of buckets) {
    target[b] = Math.min(counts[b], Math.round(desiredSize * (counts[b] / total)));
  }

  // Drift correction
  let drift = desiredSize - (target.day2_10 + target.aged);
  while (drift !== 0) {
    // Find bucket with most slack (largest pool minus current target)
    let bestBucket = null;
    let bestSlack = drift > 0 ? -Infinity : Infinity;
    for (const b of buckets) {
      const slack = drift > 0 ? counts[b] - target[b] : target[b];
      if (drift > 0 && slack > bestSlack) {
        bestSlack = slack;
        bestBucket = b;
      } else if (drift < 0 && slack > 0 && target[b] < bestSlack) {
        bestSlack = target[b];
        bestBucket = b;
      }
    }
    if (!bestBucket) break;
    target[bestBucket] += drift > 0 ? 1 : -1;
    drift = desiredSize - (target.day2_10 + target.aged);
    if (target[bestBucket] < 0) {
      target[bestBucket] = 0;
      break;
    }
  }
  return target;
}

// ── Main: issue a slice ────────────────────────────────────────────

async function issueSlice(agentId, { hourBucket = null } = {}) {
  const config = await getConfig();
  const eligibility = await isAgentEligibleForSlice(agentId, config);
  if (!eligibility.eligible) {
    return { issued: false, reason: eligibility.reason, ...eligibility };
  }

  const sliceSize = config.perAgentSliceSize || 10;
  const tz = config.businessHoursTimezone || "America/Los_Angeles";
  const effectiveHourBucket = hourBucket || formatHourBucket(new Date(), tz);

  // Read pool-age distribution (non-fresh only)
  const counts = await queueItemRepository.countByAgeBucket();
  const poolByAgeBucket = {};
  for (const row of counts) poolByAgeBucket[row._id] = row.count;

  const target = computeTargetMix({ poolByAgeBucket, sliceSize });
  const targetTotal = target.day2_10 + target.aged;
  if (targetTotal === 0) {
    return { issued: false, reason: "pool-empty" };
  }

  // Pull FIFO-oldest candidates per bucket; over-pull by 50% to absorb
  // any concurrent claims losing the CAS.
  const sliceId = crypto.randomUUID();
  const claimed = [];
  const ageMix = { just_came_in: 0, second_contact: 0, third_contact: 0, day2_10: 0, aged: 0 };

  for (const bucket of ["day2_10", "aged"]) {
    if (target[bucket] === 0) continue;
    const overpull = Math.max(target[bucket] * 2, target[bucket] + 5);
    const candidates = await queueItemRepository.listInPool({
      ageBucket: bucket,
      limit: overpull,
    });
    let need = target[bucket];
    for (const candidate of candidates) {
      if (need <= 0) break;
      const won = await queueItemRepository.claimToSlice(candidate._id, {
        sliceId,
        agentId,
        hourBucket: effectiveHourBucket,
      });
      if (won) {
        claimed.push(won);
        ageMix[bucket] += 1;
        need -= 1;
      }
    }
  }

  if (!claimed.length) {
    return { issued: false, reason: "claim-race-lost" };
  }

  const slice = await agentSliceRepository.createSlice({
    sliceId,
    agentId,
    hourBucket: effectiveHourBucket,
    sliceSize: claimed.length,
    itemIds: claimed.map((c) => c._id),
    ageMix,
  });

  return {
    issued: true,
    sliceId,
    sliceSize: claimed.length,
    ageMix,
    items: claimed,
    slice,
  };
}

// ── Release a slice ────────────────────────────────────────────────

async function releaseSlice(agentId, { reason = "manual" } = {}) {
  const slice = await agentSliceRepository.findActiveByAgent(agentId);
  if (!slice) return { released: false, reason: "no-active-slice" };
  await agentSliceRepository.markReleased(slice.sliceId, { reason });
  await queueItemRepository.releaseSliceItems(slice.sliceId);
  return { released: true, sliceId: slice.sliceId, reason };
}

async function releaseSliceById(sliceId, { reason = "manual" } = {}) {
  await agentSliceRepository.markReleased(sliceId, { reason });
  await queueItemRepository.releaseSliceItems(sliceId);
  return { released: true, sliceId, reason };
}

// ── Item-level transitions called by DialService / disposition flow ──

async function recordItemDispositioned(itemId, sliceId, { dispositionResult }) {
  if (sliceId) await agentSliceRepository.incrementCompleted(sliceId);
  // Recycle vs complete by disposition type
  const TERMINAL = ["dnc", "postdate", "inactive", "connected_no_sale", "connected_sale", "wrong_number"];
  const RECYCLE = ["did_not_connect", "voicemail", "callback"];
  if (TERMINAL.includes(dispositionResult)) {
    return queueItemRepository.markCompleted(itemId, { dispositionResult });
  }
  if (RECYCLE.includes(dispositionResult)) {
    return queueItemRepository.recycle(itemId, { reason: dispositionResult });
  }
  // Unknown disposition — default to complete with the raw value
  return queueItemRepository.markCompleted(itemId, { dispositionResult });
}

async function maybeCompleteSlice(sliceId) {
  // Called after each item dispositions. If the slice is fully drained,
  // mark it completed so the agent becomes eligible for a new slice.
  const slice = await agentSliceRepository.findBySliceId(sliceId);
  if (!slice) return { completed: false, reason: "slice-not-found" };
  if (slice.state !== "active") return { completed: false, reason: "not-active" };
  if (slice.completedCount >= slice.sliceSize) {
    await agentSliceRepository.markCompleted(sliceId);
    return { completed: true, sliceId };
  }
  return { completed: false, remaining: slice.sliceSize - slice.completedCount };
}

module.exports = {
  isAgentEligibleForSlice,
  computeTargetMix,
  issueSlice,
  releaseSlice,
  releaseSliceById,
  recordItemDispositioned,
  maybeCompleteSlice,
};
