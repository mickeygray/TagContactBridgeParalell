"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  POOLS,
  assignPacificMorningBatch,
  buildEventDedupeKey,
  buildProviderAttemptKey,
  buildProviderAcceptanceTransition,
  buildProviderAttemptPreparation,
  buildProviderDeliveryFailureTransition,
  buildProviderPostLease,
  buildFreshReservationPatch,
  calculateFreshLease,
  calculatePacketDeficit,
  canAttemptToday,
  classifyCapturedProviderEvent,
  classifyPool,
  claimNextFairPick,
  composePacketRecipe,
  computeRefillDecision,
  decideOutcomeState,
  dailyAttemptLimitForLeadAge,
  evaluateFreshAgentEligibility,
  fairnessTieBreaker,
  getPacificDateKey,
  getPacificHourKey,
  isPacificBusinessDay,
  isPacificDeliveryWindowOpen,
  isFreshReservationProtected,
  isActiveAttemptState,
  normalizeAgentFairnessHour,
  normalizeOutcome,
  nextFairPick,
  orderPoolItems,
  projectAttemptCompletion,
  rankFreshAgents,
  reconstructAgentProjection,
  retryDelayMinutesForLeadAge,
  resolvePacificEndOfDayDrain,
  resolveLeadDeliveryTickMode,
  resolvePacificMorningBatchWindow,
  resolveProviderEventItem,
  shouldRequestRefill,
  transitionCompletedAttempt,
} = require("../../packages/shared-services/src/leadDeliveryService");

const NOW = new Date("2026-07-10T17:00:00.000Z");
const HOUR_KEY = "2026-07-10T10-07:00";
const policy = Object.freeze({
  providerBufferTarget: 5,
  refillAtOrBelow: 1,
  freshReservationRange: 3,
  freshReservationMinutes: 15,
  maxPendingFreshReservations: 1,
  maxDailyAttempts: 3,
  retryDelayMinutes: 120,
});

function item(id, extra = {}) {
  return {
    workItemId: id,
    domain: "TAG",
    caseId: Number(String(id).replace(/\D/g, "")) || 1,
    state: "eligible",
    normalizedPhone: "3105550100",
    receivedAt: "2026-07-09T17:00:00.000Z",
    dailyAttemptDateKey: "2026-07-10",
    dailyAttemptCount: 0,
    ...extra,
  };
}

function agent(agentId, extra = {}) {
  return {
    agentId,
    enabled: true,
    shiftEnabled: true,
    activeUntil: "2026-07-10T18:00:00.000Z",
    estimatedOutstanding: 1,
    pendingFreshCount: 0,
    freshReservedThisHour: 0,
    fairnessHourKey: HOUR_KEY,
    subscribedPools: [POOLS.NEW_TODAY, POOLS.OVERNIGHT, POOLS.OLDER_AVAILABLE, POOLS.FOLLOW_UP_DUE],
    packetAllowances: {
      [POOLS.NEW_TODAY]: 1,
      [POOLS.OVERNIGHT]: 2,
      [POOLS.OLDER_AVAILABLE]: 1,
      [POOLS.FOLLOW_UP_DUE]: 1,
    },
    providerConfig: {
      memberId: "member-test",
      distributionFolderId: "distribution-test",
      receivingFolderId: "receiving-test",
      leadStreamId: "stream-test",
    },
    ...extra,
  };
}

test("Pacific date/hour keys use calendar date and distinguish the repeated DST hour", () => {
  assert.equal(getPacificDateKey(NOW), "2026-07-10");
  assert.equal(getPacificHourKey(NOW), HOUR_KEY);
  assert.equal(getPacificHourKey("2026-11-01T08:30:00.000Z"), "2026-11-01T01-07:00");
  assert.equal(getPacificHourKey("2026-11-01T09:30:00.000Z"), "2026-11-01T01-08:00");
});

test("floor delivery window is 7:50 inclusive through 5:00 Pacific exclusive", () => {
  assert.equal(isPacificDeliveryWindowOpen("2026-07-13T14:49:59.000Z"), false);
  assert.equal(isPacificDeliveryWindowOpen("2026-07-13T14:50:00.000Z"), true);
  assert.equal(isPacificDeliveryWindowOpen("2026-07-13T23:59:59.000Z"), true);
  assert.equal(isPacificDeliveryWindowOpen("2026-07-14T00:00:00.000Z"), false);
  assert.equal(isPacificBusinessDay("2026-08-02T16:00:00.000Z"), false);
  assert.equal(isPacificDeliveryWindowOpen("2026-08-02T16:00:00.000Z"), false);
});

test("end-of-day folder drain is due at 5:30 Pacific across daylight offsets", () => {
  assert.deepEqual(resolvePacificEndOfDayDrain("2026-07-14T00:29:59.999Z"), {
    dateKey: "2026-07-13",
    due: false,
    minuteOfDay: 17 * 60 + 29,
  });
  assert.deepEqual(resolvePacificEndOfDayDrain("2026-07-14T00:30:00.000Z"), {
    dateKey: "2026-07-13",
    due: true,
    minuteOfDay: 17 * 60 + 30,
  });
  assert.equal(resolvePacificEndOfDayDrain("2026-12-15T01:29:59.000Z").due, false);
  assert.deepEqual(resolvePacificEndOfDayDrain("2026-12-15T01:30:00.000Z"), {
    dateKey: "2026-12-14",
    due: true,
    minuteOfDay: 17 * 60 + 30,
  });
});

test("tick mode is explicit across the Pacific floor day and weekend", () => {
  assert.equal(resolveLeadDeliveryTickMode("2026-07-10T10:00:00.000Z"), "preopen_event_drain");
  assert.equal(resolveLeadDeliveryTickMode("2026-07-10T14:50:00.000Z"), "delivery_open");
  assert.equal(resolveLeadDeliveryTickMode("2026-07-11T00:00:00.000Z"), "postwindow_event_drain");
  assert.equal(resolveLeadDeliveryTickMode("2026-07-11T00:30:00.000Z"), "close_due");
  assert.equal(resolveLeadDeliveryTickMode("2026-07-11T00:30:00.000Z", {
    completedCloseDateKey: "2026-07-10",
  }), "close_complete_event_drain");
  assert.equal(resolveLeadDeliveryTickMode("2026-08-02T16:00:00.000Z"), "weekend_idle");
});

test("Pacific morning batch rolls at exactly 7:50 Pacific", () => {
  const before = resolvePacificMorningBatchWindow("2026-07-13T14:49:59.999Z");
  assert.equal(before.batchKey, "2026-07-12");
  assert.equal(before.cutoffAt.toISOString(), "2026-07-12T14:50:00.000Z");

  const exact = resolvePacificMorningBatchWindow("2026-07-13T14:50:00.000Z");
  assert.equal(exact.batchKey, "2026-07-13");
  assert.equal(exact.cutoffAt.toISOString(), "2026-07-13T14:50:00.000Z");
});

test("morning batch includes only untouched leads received before the active cutoff", () => {
  const options = { now: "2026-07-13T14:50:00.000Z" };
  assert.deepEqual(assignPacificMorningBatch({
    receivedAt: "2026-07-13T14:49:00.000Z",
    lastContactAt: null,
    totalAttemptCount: 0,
  }, options), {
    overnightBatchKey: "2026-07-13",
    overnightOrder: 60_000,
  });
  assert.equal(assignPacificMorningBatch({
    receivedAt: "2026-07-13T14:50:00.000Z",
    lastContactAt: null,
    totalAttemptCount: 0,
  }, options), null);
  assert.equal(assignPacificMorningBatch({
    receivedAt: "2026-07-13T14:49:00.000Z",
    lastContactAt: "2026-07-13T14:49:30.000Z",
    totalAttemptCount: 0,
  }, options), null);
  assert.equal(assignPacificMorningBatch({
    receivedAt: "2026-07-13T14:49:00.000Z",
    lastContactAt: null,
    totalAttemptCount: 1,
  }, options), null);
});

test("pool classification is exclusive and current morning batch precedes same-day arrival", () => {
  const opts = { now: NOW, currentOvernightBatchKey: "2026-07-10", maxDailyAttempts: 3, eligibility: { ok: true } };
  assert.equal(classifyPool(item("due", {
    receivedAt: "2026-07-10T16:55:00Z",
    overnightBatchKey: "2026-07-10",
    nextContactAt: NOW,
    state: "follow_up_wait",
  }), opts).pool, POOLS.FOLLOW_UP_DUE);
  assert.equal(classifyPool(item("today", {
    receivedAt: "2026-07-10T16:55:00Z",
  }), opts).pool, POOLS.NEW_TODAY);
  assert.equal(classifyPool(item("same-day-morning", {
    receivedAt: "2026-07-10T14:40:00Z",
    overnightBatchKey: "2026-07-10",
  }), opts).pool, POOLS.OVERNIGHT);
  assert.equal(classifyPool(item("overnight", {
    overnightBatchKey: "2026-07-10",
  }), opts).pool, POOLS.OVERNIGHT);
  assert.equal(classifyPool(item("older"), opts).pool, POOLS.OLDER_AVAILABLE);
  assert.equal(classifyPool(item("old-batch", { overnightBatchKey: "2026-07-09" }), opts).pool, POOLS.OLDER_AVAILABLE);
});

test("pool classification fails closed for future timers, non-pool states, caps, bad dates, and unknown eligibility", () => {
  const opts = { now: NOW, currentOvernightBatchKey: "2026-07-10", eligibility: { ok: true } };
  assert.equal(classifyPool(item("future", { nextContactAt: "2026-07-10T18:00:00Z" }), opts).pool, null);
  for (const state of ["reserved", "packetized", "provider_accepted", "in_call", "terminal", "blocked", "delivery_failed", "review"]) {
    assert.equal(classifyPool(item(`state-${state}`, { state }), opts).pool, null);
  }
  assert.equal(classifyPool(item("capped", { dailyAttemptCount: 3 }), opts).reason, "daily-attempt-limit");
  assert.equal(classifyPool(item("yesterday-count", {
    state: "follow_up_wait",
    dailyAttemptDateKey: "2026-07-09",
    dailyAttemptCount: 3,
    nextContactAt: "2026-07-10T16:00:00Z",
  }), opts).pool, POOLS.FOLLOW_UP_DUE);
  assert.equal(classifyPool(item("bad-date", { nextContactAt: "not-a-date" }), opts).reason, "invalid-next-contact-at");
  assert.equal(classifyPool(item("future-received", { receivedAt: "2026-07-10T18:00:00Z" }), opts).reason, "received-in-future");
  assert.equal(classifyPool(item("unknown-eligibility"), { ...opts, eligibility: { ok: false, reason: "status-read-failed" } }).reason, "status-read-failed");
  assert.equal(classifyPool(item("unproven"), { now: NOW }).reason, "eligibility-not-proven");
  assert.equal(classifyPool({ ...item("no-domain"), domain: "" }, opts).reason, "missing-domain-case-identity");
  assert.equal(classifyPool({ ...item("no-phone"), normalizedPhone: "" }, opts).reason, "normalized-phone-not-proven");
  assert.equal(classifyPool({ ...item("no-state"), state: "" }, opts).reason, "missing-state");
  assert.equal(classifyPool(item("missing-key", { dailyAttemptDateKey: null, dailyAttemptCount: 2 }), opts).reason, "invalid-daily-attempt-state");
  assert.equal(classifyPool(item("bad-key", { dailyAttemptDateKey: "yesterday", dailyAttemptCount: 2 }), opts).reason, "invalid-daily-attempt-state");
  assert.equal(classifyPool(item("impossible-key", { dailyAttemptDateKey: "2026-02-31", dailyAttemptCount: 2 }), opts).reason, "invalid-daily-attempt-state");
  assert.equal(classifyPool(item("future-key", { dailyAttemptDateKey: "2026-07-11", dailyAttemptCount: 2 }), opts).reason, "invalid-daily-attempt-state");
});

test("Pacific midnight, not UTC midnight or old CX rollover, separates new-today", () => {
  const opts = { now: "2026-07-10T17:00:00Z", eligibility: { ok: true } };
  assert.equal(classifyPool(item("midnight", { receivedAt: "2026-07-10T07:00:00Z" }), opts).pool, POOLS.NEW_TODAY);
  assert.equal(classifyPool(item("before-midnight", { receivedAt: "2026-07-10T06:59:59Z" }), opts).pool, POOLS.OLDER_AVAILABLE);
});

test("new today is newest-first with stable identity ties", () => {
  const input = [
    item("n2", { receivedAt: "2026-07-10T16:58:00Z" }),
    item("n3", { receivedAt: "2026-07-10T16:59:00Z" }),
    item("n1", { receivedAt: "2026-07-10T16:58:00Z" }),
  ];
  const snapshot = structuredClone(input);
  assert.deepEqual(orderPoolItems(POOLS.NEW_TODAY, input).map((row) => row.workItemId), ["n3", "n1", "n2"]);
  assert.deepEqual(input, snapshot);
});

test("follow-up is most-overdue then never/oldest-contacted", () => {
  const rows = [
    item("f4", { nextContactAt: "2026-07-10T15:00:00Z", lastContactAt: "2026-07-10T13:00:00Z" }),
    item("f2", { nextContactAt: "2026-07-10T15:00:00Z", lastContactAt: null }),
    item("f1", { nextContactAt: "2026-07-10T14:00:00Z" }),
    item("f3", { nextContactAt: "2026-07-10T15:00:00Z", lastContactAt: "2026-07-10T12:00:00Z" }),
  ];
  assert.deepEqual(orderPoolItems(POOLS.FOLLOW_UP_DUE, rows).map((row) => row.workItemId), ["f1", "f2", "f3", "f4"]);
});

test("overnight persists builder order and older inventory is least-recently-contacted", () => {
  const overnight = [item("o3", { overnightOrder: 3 }), item("o1", { overnightOrder: 1 }), item("o2", { overnightOrder: 2 })];
  assert.deepEqual(orderPoolItems(POOLS.OVERNIGHT, overnight).map((row) => row.workItemId), ["o1", "o2", "o3"]);
  const older = [
    item("a3", { lastContactAt: "2026-07-09T15:00:00Z" }),
    item("a1", { lastContactAt: null }),
    item("a2", { lastContactAt: "2026-07-09T14:00:00Z" }),
  ];
  assert.deepEqual(orderPoolItems(POOLS.OLDER_AVAILABLE, older).map((row) => row.workItemId), ["a1", "a2", "a3"]);
});

test("daily attempts reset by Pacific date and cap at three", () => {
  assert.deepEqual(canAttemptToday(item("two", { dailyAttemptCount: 2 }), { now: NOW, maxDailyAttempts: 3 }), {
    allowed: true, count: 2, maximum: 3, reason: "daily-attempt-available",
  });
  assert.equal(canAttemptToday(item("three", { dailyAttemptCount: 3 }), { now: NOW, maxDailyAttempts: 3 }).allowed, false);
  assert.equal(canAttemptToday(item("old-three", { dailyAttemptDateKey: "2026-07-09", dailyAttemptCount: 3 }), { now: NOW, maxDailyAttempts: 3 }).count, 0);
});

test("fresh fairness gives Brad the next lead despite his larger eligible buffer", () => {
  const agents = [
    agent("chris", { estimatedOutstanding: 1, freshReservedThisHour: 2 }),
    agent("sean", { estimatedOutstanding: 2, freshReservedThisHour: 1 }),
    agent("brad", { estimatedOutstanding: 3, freshReservedThisHour: 0 }),
  ];
  assert.deepEqual(rankFreshAgents(agents, { now: NOW, ...policy }).map((row) => row.agentId), ["brad", "sean", "chris"]);
  const patch = buildFreshReservationPatch(agents[2], { now: NOW });
  assert.equal(patch.freshReservedThisHour, 1);
  assert.equal(patch.pendingFreshCount, 1);
  assert.equal(patch.fairnessHourKey, HOUR_KEY);
  assert.equal(patch.lastFreshReservedAt.toISOString(), NOW.toISOString());
  assert.equal(agents[2].freshReservedThisHour, 0);
});

test("nextFairPick advances one fixed ring and skips only caller exclusions", () => {
  const ring = ["bruce", "phil", "sean", "brad", "chris"];
  assert.equal(nextFairPick({ agentOrder: ring, lastPickedAgentId: "sean" }), "brad");
  assert.equal(nextFairPick({
    agentOrder: ring,
    lastPickedAgentId: "sean",
    excludedAgentIds: ["brad", "chris"],
  }), "bruce");
  assert.equal(nextFairPick({
    agentOrder: ring,
    lastPickedAgentId: "chris",
    excludedAgentIds: ["bruce"],
  }), "phil");
  assert.equal(nextFairPick({
    agentOrder: ring,
    lastPickedAgentId: "missing",
    excludedAgentIds: ring,
  }), null);
});

test("claimNextFairPick durably advances the cursor with CAS retry", async () => {
  const agentOrder = ["bruce", "phil", "sean", "brad", "chris"];
  let cursor = { agentOrder, lastPickedAgentId: "phil", version: 3 };
  let conflicts = 1;
  const repository = {
    async getOrCreateFairPickCursor() { return { ...cursor }; },
    async compareAndSetFairPickCursor(input) {
      if (conflicts > 0) {
        conflicts -= 1;
        cursor = { agentOrder, lastPickedAgentId: "sean", version: 4 };
        return null;
      }
      assert.equal(input.expectedVersion, 4);
      assert.equal(input.expectedLastPickedAgentId, "sean");
      cursor = { agentOrder, lastPickedAgentId: input.lastPickedAgentId, version: 5 };
      return { ...cursor };
    },
  };
  const result = await claimNextFairPick({
    repository,
    workType: "new_today",
    agentOrder,
    excludedAgentIds: ["brad"],
  });
  assert.deepEqual(result, {
    status: "picked",
    workType: "new_today",
    agentId: "chris",
    version: 5,
  });
  assert.equal(cursor.lastPickedAgentId, "chris");
});

test("fresh eligibility depends on activity and configuration, never bulk depth", () => {
  assert.equal(evaluateFreshAgentEligibility(agent("ok", { estimatedOutstanding: 3 }), { now: NOW, ...policy }).eligible, true);
  assert.equal(evaluateFreshAgentEligibility(agent("depth", { estimatedOutstanding: 400 }), { now: NOW, ...policy }).eligible, true);
  assert.equal(evaluateFreshAgentEligibility(agent("pending", { pendingFreshCount: 25 }), { now: NOW, ...policy }).eligible, true);
  const cases = [
    [agent("expired", { activeUntil: NOW }), "agent-inactive"],
    [agent("disabled", { enabled: false }), "agent-disabled"],
    [agent("shift", { shiftEnabled: false }), "shift-disabled"],
    [agent("distribution", { providerConfig: { distributionFolderId: "", receivingFolderId: "receiving" } }), "provider-config-incomplete"],
    [agent("receiving", { providerConfig: { distributionFolderId: "distribution", receivingFolderId: "" } }), "provider-config-incomplete"],
    [agent("subscription", { subscribedPools: [POOLS.OVERNIGHT] }), "not-subscribed-new-today"],
    [agent("allowance", { packetAllowances: { [POOLS.NEW_TODAY]: 0 } }), "new-today-allowance-invalid"],
    [agent("fractional-allowance", { packetAllowances: { [POOLS.NEW_TODAY]: 0.5 } }), "new-today-allowance-invalid"],
  ];
  for (const [candidate, reason] of cases) {
    assert.equal(evaluateFreshAgentEligibility(candidate, { now: NOW, ...policy }).reason, reason);
  }
});

test("fairness uses oldest/never served then deterministic hourly hash independent of input order", () => {
  const served = [
    agent("chris", { lastFreshReservedAt: "2026-07-10T16:50:00Z" }),
    agent("sean", { lastFreshReservedAt: null }),
    agent("brad", { lastFreshReservedAt: "2026-07-10T16:40:00Z" }),
  ];
  assert.deepEqual(rankFreshAgents(served, { now: NOW, ...policy }).map((row) => row.agentId), ["sean", "brad", "chris"]);

  const tied = [agent("chris"), agent("sean"), agent("brad")];
  const expected = [...tied]
    .sort((left, right) => fairnessTieBreaker(HOUR_KEY, left.agentId).localeCompare(fairnessTieBreaker(HOUR_KEY, right.agentId)))
    .map((row) => row.agentId);
  assert.deepEqual(rankFreshAgents(tied, { now: NOW, ...policy }).map((row) => row.agentId), expected);
  assert.deepEqual(rankFreshAgents([...tied].reverse(), { now: NOW, ...policy }).map((row) => row.agentId), expected);
});

test("lazy hour reset clears only hourly count and preserves pending ownership/history", () => {
  const prior = agent("sean", {
    fairnessHourKey: "2026-07-10T09-07:00",
    freshReservedThisHour: 7,
    pendingFreshCount: 1,
    lastFreshReservedAt: "2026-07-10T16:50:00Z",
  });
  const projected = normalizeAgentFairnessHour(prior, { now: NOW });
  assert.equal(projected.freshReservedThisHour, 0);
  assert.equal(projected.pendingFreshCount, 1);
  assert.equal(new Date(projected.lastFreshReservedAt).toISOString(), "2026-07-10T16:50:00.000Z");
  assert.equal(prior.freshReservedThisHour, 7);
});

test("fresh lease is anchored to receipt and never renews on reassignment", () => {
  const first = calculateFreshLease({ receivedAt: "2026-07-10T16:00:00Z", reservedAt: "2026-07-10T16:01:00Z", leaseMinutes: 15 });
  const later = calculateFreshLease({ receivedAt: "2026-07-10T16:00:00Z", reservedAt: "2026-07-10T16:10:00Z", leaseMinutes: 15 });
  assert.equal(first.freshDeadlineAt.toISOString(), "2026-07-10T16:15:00.000Z");
  assert.equal(first.reservationExpiresAt.toISOString(), "2026-07-10T16:15:00.000Z");
  assert.equal(later.reservationExpiresAt.toISOString(), "2026-07-10T16:15:00.000Z");
  assert.equal(isFreshReservationProtected({ ...later }, "2026-07-10T16:14:59.999Z"), true);
  assert.equal(isFreshReservationProtected({ ...later }, "2026-07-10T16:15:00.000Z"), false);
  assert.equal(calculateFreshLease({ receivedAt: "2026-07-10T16:00:00Z", reservedAt: "2026-07-10T16:15:00Z" }).canProtect, false);
  assert.equal(calculateFreshLease({ receivedAt: "2026-07-10T16:00:00Z", reservedAt: "2026-07-10T16:01:00Z", leaseMinutes: 5 }).reservationExpiresAt.toISOString(), "2026-07-10T16:06:00.000Z");
  assert.equal(calculateFreshLease({ receivedAt: "2026-07-10T16:00:00Z", reservedAt: "2026-07-10T16:01:00Z", leaseMinutes: 20 }).reservationExpiresAt.toISOString(), "2026-07-10T16:15:00.000Z");
  assert.equal(calculateFreshLease({ receivedAt: "2026-07-10T16:00:00Z", reservedAt: "2026-07-10T16:01:00Z", freshDeadlineMinutes: 20 }).freshDeadlineAt.toISOString(), "2026-07-10T16:15:00.000Z");
  assert.throws(() => calculateFreshLease({ receivedAt: "2026-07-10T16:00:00Z", reservedAt: "2026-07-10T15:59:00Z" }));
});

test("refill trigger is separate from exact deficit math", () => {
  assert.equal(shouldRequestRefill({ currentOutstanding: 2, refillAtOrBelow: 1 }).shouldRequest, false);
  assert.equal(shouldRequestRefill({ currentOutstanding: 1, refillAtOrBelow: 1 }).shouldRequest, true);
  assert.equal(calculatePacketDeficit({ providerBufferTarget: 5, currentOutstanding: 1, acceptedInFlight: 1 }), 3);
  assert.deepEqual(computeRefillDecision({ providerBufferTarget: 5, refillAtOrBelow: 1, projection: { reliable: true, estimatedOutstanding: 0 }, acceptedInFlight: 2 }), {
    shouldRequest: true,
    shouldOpenRefill: true,
    reason: "at-or-below-low-water",
    deficit: 3,
  });
  assert.equal(computeRefillDecision({ providerBufferTarget: 5, refillAtOrBelow: 1, projection: { reliable: true, estimatedOutstanding: 1 }, acceptedInFlight: 4 }).shouldOpenRefill, false);
  assert.equal(computeRefillDecision({ providerBufferTarget: 5, refillAtOrBelow: 1, projection: { reliable: true, estimatedOutstanding: 0 }, openRefillRequest: true }).shouldOpenRefill, false);
  assert.deepEqual(computeRefillDecision({ providerBufferTarget: 5, refillAtOrBelow: 1, projection: { reliable: false, estimatedOutstanding: 0 } }), {
    shouldRequest: false,
    shouldOpenRefill: false,
    reason: "projection-unreliable",
    deficit: 0,
  });
  assert.equal(computeRefillDecision({ providerBufferTarget: 5, refillAtOrBelow: 1 }).reason, "projection-not-proven");
  assert.throws(() => computeRefillDecision({ providerBufferTarget: 5, refillAtOrBelow: 5, projection: { reliable: true, estimatedOutstanding: 0 } }), /must be below/);
});

test("morning barrier puts protected fresh first, then overnight before follow-up or aged work", () => {
  const packet = composePacketRecipe({
    agentId: "brad",
    now: NOW,
    needed: 5,
    subscribedPools: [POOLS.NEW_TODAY, POOLS.OVERNIGHT, POOLS.FOLLOW_UP_DUE, POOLS.OLDER_AVAILABLE],
    packetAllowances: { [POOLS.NEW_TODAY]: 1, [POOLS.OVERNIGHT]: 2, [POOLS.FOLLOW_UP_DUE]: 1, [POOLS.OLDER_AVAILABLE]: 2 },
    reservedFreshItems: [
      item("b-old", { state: "reserved", receivedAt: "2026-07-10T16:40:00Z", reservedAgentId: "brad", reservationExpiresAt: "2026-07-10T17:05:00Z", freshDeadlineAt: "2026-07-10T17:05:00Z" }),
      item("b-new", { state: "reserved", receivedAt: "2026-07-10T16:50:00Z", reservedAgentId: "brad", reservationExpiresAt: "2026-07-10T17:05:00Z", freshDeadlineAt: "2026-07-10T17:05:00Z" }),
      item("b-expired", { state: "reserved", receivedAt: "2026-07-10T16:55:00Z", reservedAgentId: "brad", reservationExpiresAt: NOW, freshDeadlineAt: NOW }),
      item("chris-only", { state: "reserved", receivedAt: "2026-07-10T16:56:00Z", reservedAgentId: "chris", reservationExpiresAt: "2026-07-10T17:05:00Z", freshDeadlineAt: "2026-07-10T17:05:00Z" }),
    ],
    forcedExpiredFreshItems: [item("urgent-expired", { state: "reserved", receivedAt: "2026-07-10T16:00:00Z", freshDeadlineAt: NOW, speedOverrideAgentId: "brad" })],
    poolsByName: {
      [POOLS.OVERNIGHT]: [item("o2", { overnightOrder: 2 }), item("o1", { overnightOrder: 1 })],
      [POOLS.FOLLOW_UP_DUE]: [item("f1", { nextContactAt: "2026-07-10T15:00:00Z" })],
      [POOLS.OLDER_AVAILABLE]: [item("a1")],
    },
  });
  assert.deepEqual(packet.items.map((row) => row.workItemId), ["b-new", "b-old", "urgent-expired", "o1", "o2"]);
  assert.equal(packet.items.length, 5);
  assert.equal(packet.items.some((row) => row.workItemId === "f1" || row.workItemId === "a1"), false);
  assert.ok(packet.excluded.some((row) => row.identity === "chris-only"));
});

test("packet honors positive allowances, deterministic fallback, zero/unsubscribed exclusions, and dedupe", () => {
  const duplicate = item("a1");
  const input = {
    agentId: "chris",
    now: NOW,
    needed: 5,
    subscribedPools: [POOLS.OVERNIGHT, POOLS.FOLLOW_UP_DUE, POOLS.OLDER_AVAILABLE],
    packetAllowances: { [POOLS.OVERNIGHT]: 2, [POOLS.FOLLOW_UP_DUE]: 1, [POOLS.OLDER_AVAILABLE]: 2, [POOLS.NEW_TODAY]: 0 },
    poolsByName: {
      [POOLS.OVERNIGHT]: [item("o1", { overnightOrder: 1 })],
      [POOLS.FOLLOW_UP_DUE]: [item("f1", { nextContactAt: "2026-07-10T15:00:00Z" })],
      [POOLS.OLDER_AVAILABLE]: [duplicate, duplicate, item("a2"), item("a3")],
      [POOLS.NEW_TODAY]: [item("unreserved-new", { receivedAt: "2026-07-10T16:59:00Z" })],
    },
  };
  const snapshot = structuredClone(input);
  const packet = composePacketRecipe(input);
  assert.deepEqual(packet.items.map((row) => row.workItemId), ["o1", "f1", "a1", "a2", "a3"]);
  assert.equal(new Set(packet.items.map((row) => row.workItemId)).size, 5);
  assert.deepEqual(input, snapshot);
  assert.deepEqual(composePacketRecipe({ ...input, needed: 0 }).items, []);
});

test("unconsumed zero-touch overnight work hard-blocks aged packet selection", () => {
  const packet = composePacketRecipe({
    agentId: "chris",
    now: NOW,
    needed: 3,
    subscribedPools: [POOLS.OVERNIGHT, POOLS.OLDER_AVAILABLE],
    packetAllowances: { [POOLS.OVERNIGHT]: 1, [POOLS.OLDER_AVAILABLE]: 3 },
    poolsByName: {
      [POOLS.OVERNIGHT]: [item("o1", { overnightOrder: 1, totalAttemptCount: 0, lastContactAt: null })],
      [POOLS.OLDER_AVAILABLE]: [item("a1"), item("a2"), item("a3")],
    },
    blockAgedForOvernightFirstContact: true,
  });

  assert.deepEqual(packet.items.map((row) => row.workItemId), ["o1"]);
  assert.equal(packet.unfilled, 2);
  assert.equal(packet.countsByPool[POOLS.OLDER_AVAILABLE], 0);
});

test("expired fresh cannot leak through ordinary new-today fill or an unsubscribed speed override", () => {
  const expired = item("expired", {
    receivedAt: "2026-07-10T16:00:00Z",
    reservedAgentId: "brad",
    reservationExpiresAt: NOW,
    freshDeadlineAt: NOW,
  });
  const ordinary = composePacketRecipe({
    agentId: "brad",
    now: NOW,
    needed: 1,
    subscribedPools: [POOLS.NEW_TODAY],
    packetAllowances: { [POOLS.NEW_TODAY]: 1 },
    poolsByName: { [POOLS.NEW_TODAY]: [expired] },
  });
  assert.deepEqual(ordinary.items, []);

  const unsubscribed = composePacketRecipe({
    agentId: "brad",
    now: NOW,
    needed: 1,
    subscribedPools: [POOLS.OVERNIGHT],
    packetAllowances: { [POOLS.OVERNIGHT]: 1, [POOLS.NEW_TODAY]: 0 },
    forcedExpiredFreshItems: [expired],
  });
  assert.deepEqual(unsubscribed.items, []);

  const unclaimedOverride = composePacketRecipe({
    agentId: "brad",
    now: NOW,
    needed: 1,
    subscribedPools: [POOLS.NEW_TODAY],
    packetAllowances: { [POOLS.NEW_TODAY]: 1 },
    forcedExpiredFreshItems: [item("not-claimed", { state: "reserved", receivedAt: "2026-07-10T16:00:00Z", freshDeadlineAt: NOW })],
  });
  assert.deepEqual(unclaimedOverride.items, []);
  assert.throws(() => composePacketRecipe({
    agentId: "brad",
    now: NOW,
    needed: 1,
    subscribedPools: [POOLS.NEW_TODAY],
    packetAllowances: { [POOLS.NEW_TODAY]: 0.5 },
    forcedExpiredFreshItems: [item("fractional", { state: "reserved", receivedAt: "2026-07-10T16:00:00Z", freshDeadlineAt: NOW, speedOverrideAgentId: "brad" })],
  }), /non-negative integer/);
});

test("provider attempt identity is persisted before POST and replays the same identity after a crash", () => {
  const packetized = item("attempt-1", {
    state: "packetized",
    activeAttempt: true,
    providerAttemptSequence: 0,
    providerAttemptHistory: [],
  });
  const prepared = buildProviderAttemptPreparation(packetized, { now: NOW });
  assert.equal(prepared.attemptNumber, 1);
  assert.match(prepared.providerExternalLeadId, /^ld-v1-[a-f0-9]{32}-1$/);
  assert.equal(prepared.replay, false);
  assert.equal(prepared.requiresReconciliation, false);
  assert.equal(prepared.mutation.set.providerAttemptSequence, 1);
  assert.equal(prepared.mutation.append.providerAttemptHistory[0].event, "prepared");

  const persisted = {
    ...packetized,
    ...prepared.mutation.set,
    providerAttemptHistory: prepared.mutation.append.providerAttemptHistory,
  };
  const replay = buildProviderAttemptPreparation(persisted, { now: new Date(NOW.getTime() + 60_000) });
  assert.deepEqual(replay, {
    attemptNumber: 1,
    providerExternalLeadId: prepared.providerExternalLeadId,
    replay: true,
    requiresReconciliation: false,
    mutation: null,
  });
});

test("provider post lease has one live owner and stale work must reconcile before another POST", () => {
  const prepared = item("lease-1", {
    state: "packetized",
    activeAttempt: true,
    providerPostState: "prepared",
    providerPostLeaseId: null,
    providerPostLeaseExpiresAt: null,
    providerPostAttemptCount: 0,
  });
  const first = buildProviderPostLease(prepared, { now: NOW, leaseId: "lease-a", leaseMs: 60_000 });
  assert.equal(first.acquired, true);
  assert.equal(first.reconcileBeforePost, false);
  const posting = {
    ...prepared,
    ...first.mutation.set,
    providerPostAttemptCount: 1,
  };
  assert.equal(buildProviderPostLease(posting, {
    now: new Date(NOW.getTime() + 30_000),
    leaseId: "lease-b",
  }).reason, "provider-post-lease-live");
  const stale = buildProviderPostLease(posting, {
    now: new Date(NOW.getTime() + 60_000),
    leaseId: "lease-c",
  });
  assert.equal(stale.acquired, true);
  assert.equal(stale.reconcileBeforePost, true);
  assert.equal(stale.expected.providerPostLeaseId, "lease-a");
});

test("provider acceptance and failure append immutable attempt evidence", () => {
  const prepared = item("attempt-2", {
    state: "packetized",
    activeAttempt: true,
    provider: "phoneburner",
    providerAttemptSequence: 2,
    providerExternalLeadId: "ld-v1-test-2",
    providerPostState: "posting",
    providerPostLeaseId: "lease-2",
    deliveryAgentId: "bruce_allen",
    packetId: "packet-2",
  });
  const accepted = buildProviderAcceptanceTransition(prepared, {
    providerContactId: "9002",
    acceptedAt: NOW,
    providerPostLeaseId: "lease-2",
  });
  assert.equal(accepted.set.state, "provider_accepted");
  assert.equal(accepted.set.providerContactId, "9002");
  assert.deepEqual(accepted.append.providerAttemptHistory[0], {
    attemptNumber: 2,
    event: "accepted",
    provider: "phoneburner",
    providerExternalLeadId: "ld-v1-test-2",
    providerContactId: "9002",
    providerCallId: null,
    deliveryAgentId: "bruce_allen",
    packetId: "packet-2",
    occurredAt: NOW,
    outcome: null,
    reason: null,
  });

  const failed = buildProviderDeliveryFailureTransition(prepared, {
    failedAt: NOW,
    reason: "Raw Provider Error 500",
    providerPostLeaseId: "lease-2",
  });
  assert.equal(failed.set.state, "delivery_failed");
  assert.equal(failed.append.providerAttemptHistory[0].reason, "raw-provider-error-500");

  const rateLimited = buildProviderDeliveryFailureTransition(prepared, {
    failedAt: NOW,
    reason: "rate_limited",
    providerPostLeaseId: "lease-2",
    retryable: true,
  });
  assert.equal(rateLimited.set.state, "packetized");
  assert.equal(rateLimited.set.providerPostState, "prepared");
  assert.equal(rateLimited.set.providerPostLeaseId, null);
  assert.equal(rateLimited.append.providerAttemptHistory[0].event, "review");
  assert.equal(rateLimited.append.providerAttemptHistory[0].reason, "rate_limited");
});

test("provider event identity resolves one historical attempt and rejects cross-attempt mixtures", () => {
  const candidate = item("history-1", {
    provider: "phoneburner",
    providerAttemptSequence: 2,
    providerExternalLeadId: "external-2",
    providerContactId: "contact-2",
    providerCallId: "call-2",
    providerAttemptHistory: [
      { attemptNumber: 1, providerExternalLeadId: "external-1", providerContactId: "contact-1", providerCallId: "call-1" },
      { attemptNumber: 2, providerExternalLeadId: "external-2", providerContactId: "contact-2", providerCallId: "call-2" },
    ],
  });
  const resolved = resolveProviderEventItem([candidate], {
    provider: "phoneburner",
    providerExternalLeadId: "external-1",
    providerContactId: "contact-1",
    providerCallId: "call-1",
  });
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.attemptNumber, 1);
  assert.equal(resolveProviderEventItem([candidate], {
    provider: "phoneburner",
    providerExternalLeadId: "external-1",
    providerContactId: "contact-2",
    providerCallId: "call-1",
  }).status, "conflict");
});

test("outcome normalization preserves bad lead and never invents no-answer", () => {
  assert.equal(normalizeOutcome("Bad Number"), "bad_lead");
  assert.equal(normalizeOutcome("Wrong Number"), "bad_lead");
  assert.equal(normalizeOutcome("Busy Signal"), "busy");
  assert.equal(normalizeOutcome("Busy Phone"), "busy");
  assert.equal(normalizeOutcome("Left Message"), "voicemail");
  assert.equal(normalizeOutcome("something new"), "review");
});

test("event dedupe keys are canonical and caller-provided keys cannot influence identity", () => {
  const providerEvent = buildEventDedupeKey({
    provider: " PhoneBurner ",
    providerEventId: " event-1 ",
    eventType: "contact_displayed",
  });
  assert.equal(providerEvent, buildEventDedupeKey({
    provider: "phoneburner",
    providerEventId: "event-1",
    eventType: "different_type",
  }));
  const callEvent = buildEventDedupeKey({
    provider: "phoneburner",
    providerCallId: "call-1",
    providerContactId: "contact-1",
    providerExternalLeadId: "external-1",
    eventType: " Call_Done ",
  });
  assert.equal(callEvent, buildEventDedupeKey({
    provider: "PHONEBURNER",
    providerCallId: "call-1",
    providerContactId: "contact-1",
    providerExternalLeadId: "external-1",
    eventType: "call_done",
    providerEventId: "different-hook-event-id",
  }));
  assert.notEqual(callEvent, buildEventDedupeKey({
    provider: "phoneburner",
    providerCallId: "call-1",
    providerContactId: "contact-1",
    providerExternalLeadId: "external-1",
    eventType: "disposition",
  }));
  assert.notEqual(callEvent, buildEventDedupeKey({
    provider: "phoneburner",
    providerCallId: "call-1",
    providerContactId: "contact-2",
    providerExternalLeadId: "external-2",
    eventType: "call_done",
  }));
  assert.match(callEvent, /^v1:[a-f0-9]{64}$/);
  assert.throws(() => buildEventDedupeKey({ provider: "phoneburner", eventType: "call_done" }), /providerCallId/);
  const reviewEvent = {
    provider: "phoneburner",
    eventType: "contact_displayed",
    providerContactId: "501",
    providerExternalLeadId: "TAG:case-501:attempt-1",
    status: "review",
    payloadDigest: "a".repeat(64),
  };
  assert.equal(buildEventDedupeKey(reviewEvent), buildEventDedupeKey({ ...reviewEvent }));
  assert.throws(() => buildEventDedupeKey({ ...reviewEvent, status: "pending" }), /processable event/);
});

test("Call End attempt identity is the composite call, contact, and external identity", () => {
  const attempt = {
    provider: "phoneburner",
    providerCallId: "reused-session-call",
    providerContactId: "contact-1",
    providerExternalLeadId: "external-1",
  };
  const key = buildProviderAttemptKey(attempt);
  assert.match(key, /^v1:[a-f0-9]{64}$/);
  assert.notEqual(key, buildProviderAttemptKey({ ...attempt, providerContactId: "contact-2" }));
  assert.notEqual(key, buildProviderAttemptKey({ ...attempt, providerExternalLeadId: "external-2" }));
  assert.throws(
    () => buildProviderAttemptKey({ ...attempt, providerContactId: "" }),
    /call, contact, and external identity/,
  );
  assert.throws(
    () => buildProviderAttemptKey({ ...attempt, providerExternalLeadId: "" }),
    /call, contact, and external identity/,
  );
});

test("captured provider events remain replayable only with hard occurrence and lead identity", () => {
  assert.deepEqual(classifyCapturedProviderEvent({
    eventType: "call_begin",
    providerCallId: "901",
    providerContactId: "1901",
    providerExternalLeadId: "TAG:case-901:attempt-1",
  }), {
    status: "pending",
    normalizedOutcome: null,
    reason: "captured-for-replay",
    identityStrength: "call-contact-external",
  });
  const incompleteBegin = classifyCapturedProviderEvent({
    eventType: "call_begin",
    providerCallId: "901-b",
    providerExternalLeadId: "TAG:case-901-b:attempt-1",
  });
  assert.equal(incompleteBegin.status, "review");
  assert.equal(incompleteBegin.reason, "incomplete-provider-attempt-identity");
  const done = classifyCapturedProviderEvent({
    eventType: "call_done",
    providerCallId: "902",
    providerContactId: "1902",
    providerExternalLeadId: "TAG:case-902:attempt-1",
    rawDisposition: "Left Message",
  });
  assert.equal(done.status, "pending");
  assert.equal(done.normalizedOutcome, "voicemail");
  assert.equal(done.identityStrength, "call-contact-external");

  const unknown = classifyCapturedProviderEvent({
    eventType: "call_done",
    providerCallId: "903",
    providerExternalLeadId: "TAG:case-903:attempt-1",
    rawDisposition: "New Provider Label",
  });
  assert.equal(unknown.status, "review");
  assert.equal(unknown.normalizedOutcome, "review");
  assert.equal(unknown.reason, "incomplete-provider-attempt-identity");

  const missingExternal = classifyCapturedProviderEvent({
    eventType: "call_done",
    providerCallId: "903-b",
    providerContactId: "1903",
    rawDisposition: "No Answer",
  });
  assert.equal(missingExternal.status, "review");
  assert.equal(missingExternal.reason, "incomplete-provider-attempt-identity");

  const displayedWithoutOccurrence = classifyCapturedProviderEvent({
    eventType: "contact_displayed",
    providerContactId: "1904",
    providerExternalLeadId: "TAG:case-904:attempt-1",
  });
  assert.equal(displayedWithoutOccurrence.status, "review");
  assert.equal(displayedWithoutOccurrence.reason, "missing-provider-occurrence-identity");

  const phoneOnly = classifyCapturedProviderEvent({
    eventType: "call_done",
    rawDisposition: "No Answer",
    normalizedPhone: "5555550100",
  });
  assert.equal(phoneOnly.status, "review");
  assert.equal(phoneOnly.reason, "missing-hard-provider-identity");
});

test("provider event identity converges without consulting phone", () => {
  const event = {
    provider: "phoneburner",
    providerCallId: "910",
    providerContactId: "1910",
    providerExternalLeadId: "TAG:case-910:attempt-1",
    normalizedPhone: "5555550199",
  };
  const right = {
    _id: "right",
    provider: "phoneburner",
    providerCallId: null,
    providerContactId: "1910",
    providerExternalLeadId: "TAG:case-910:attempt-1",
    normalizedPhone: "5555550101",
  };
  const samePhoneWrongIdentity = {
    _id: "wrong",
    provider: "phoneburner",
    providerCallId: "999",
    providerContactId: "1999",
    providerExternalLeadId: "TAG:case-999:attempt-1",
    normalizedPhone: event.normalizedPhone,
  };
  assert.deepEqual(resolveProviderEventItem([samePhoneWrongIdentity, right], event), {
    status: "resolved",
    reason: "provider-contact-external-match",
    item: right,
    attemptNumber: null,
  });
  assert.equal(resolveProviderEventItem([
    right,
    { ...right, _id: "contradiction", providerExternalLeadId: "TAG:case-other:attempt-1" },
  ], event).status, "resolved");
  assert.equal(resolveProviderEventItem([samePhoneWrongIdentity], event).status, "unresolved");
});

test("contact and external identity outrank a reused PhoneBurner session call id", () => {
  const right = {
    _id: "right-reused-session",
    provider: "phoneburner",
    providerCallId: null,
    providerContactId: "contact-right",
    providerExternalLeadId: "TAG:case-right:attempt-1",
  };
  const priorInSession = {
    _id: "prior-reused-session",
    provider: "phoneburner",
    providerCallId: "session-call-id",
    providerContactId: "contact-prior",
    providerExternalLeadId: "TAG:case-prior:attempt-1",
  };
  assert.deepEqual(resolveProviderEventItem([priorInSession, right], {
    provider: "phoneburner",
    providerCallId: "session-call-id",
    providerContactId: "contact-right",
    providerExternalLeadId: "TAG:case-right:attempt-1",
  }), {
    status: "resolved",
    reason: "provider-contact-external-match",
    item: right,
    attemptNumber: null,
  });
});

test("active-attempt policy is explicit and outcome transitions carry it", () => {
  for (const state of ["eligible", "reserved", "packetized", "provider_accepted", "in_call", "follow_up_wait", "delivery_failed", "review"]) {
    assert.equal(isActiveAttemptState(state), true);
  }
  assert.equal(isActiveAttemptState("terminal"), false);
  assert.equal(isActiveAttemptState("blocked"), false);
  assert.throws(() => isActiveAttemptState("mystery"), /unknown lead-delivery state/);
  assert.equal(decideOutcomeState({ normalizedOutcome: "no_answer", completedAt: NOW, dailyAttemptCount: 1 }).activeAttempt, true);
  assert.equal(decideOutcomeState({ normalizedOutcome: "answered", completedAt: NOW, dailyAttemptCount: 1 }).activeAttempt, true);
  assert.equal(decideOutcomeState({ normalizedOutcome: "dnc", completedAt: NOW, dailyAttemptCount: 1 }).activeAttempt, false);
});

test("retryable outcomes count once and schedule exactly two elapsed hours", () => {
  for (const outcome of ["no_answer", "voicemail", "busy", "congestion", "intercept"]) {
    const result = transitionCompletedAttempt(item(`retry-${outcome}`, { state: "provider_accepted", totalAttemptCount: 7 }), outcome, {
      attemptedAt: NOW,
      completedAt: NOW,
      providerCallId: `call-${outcome}`,
      ...policy,
    });
    assert.equal(result.state, "follow_up_wait");
    assert.equal(result.dailyAttemptCount, 1);
    assert.equal(result.totalAttemptCount, 8);
    assert.equal(result.nextContactAt.toISOString(), "2026-07-10T19:00:00.000Z");
    assert.equal(result.providerCompletedAt.toISOString(), NOW.toISOString());
    assert.deepEqual(result.actions, []);
  }
});

test("age cadence allows 3 attempts for days 0-1, 2 for days 2-16, and 1 from day 17 onward", () => {
  const received = (value) => item(`age-${value}`, { receivedAt: `${value}T17:00:00.000Z` });
  assert.equal(dailyAttemptLimitForLeadAge(received("2026-07-10"), { now: NOW }), 3);
  assert.equal(dailyAttemptLimitForLeadAge(received("2026-07-09"), { now: NOW }), 3);
  assert.equal(dailyAttemptLimitForLeadAge(received("2026-07-08"), { now: NOW }), 2);
  assert.equal(dailyAttemptLimitForLeadAge(received("2026-06-24"), { now: NOW }), 2);
  assert.equal(dailyAttemptLimitForLeadAge(received("2026-06-23"), { now: NOW }), 1);
  assert.equal(dailyAttemptLimitForLeadAge(received("2026-06-09"), { now: NOW }), 1);
  assert.equal(dailyAttemptLimitForLeadAge(received("2026-06-08"), { now: NOW }), 1);
  assert.equal(canAttemptToday(received("2026-07-08"), {
    now: NOW,
    ageBasedDailyCaps: true,
    maxDailyAttempts: 3,
  }).maximum, 2);
});

test("red leads from day 32 onward are held for fifteen days between attempts", () => {
  const red = item("red", {
    receivedAt: "2026-06-08T17:00:00.000Z",
    lastContactAt: "2026-06-26T17:00:00.000Z",
    nextContactAt: null,
  });
  assert.equal(retryDelayMinutesForLeadAge(red, { now: NOW }), 15 * 24 * 60);
  const held = classifyPool(red, {
    now: NOW,
    ageBasedDailyCaps: true,
    eligibility: { ok: true },
  });
  assert.equal(held.reason, "follow-up-not-due");
  assert.equal(held.nextEligibleAt.toISOString(), "2026-07-11T17:00:00.000Z");
  assert.equal(classifyPool(red, {
    now: "2026-07-11T17:00:00.001Z",
    ageBasedDailyCaps: true,
    eligibility: { ok: true },
  }).pool, POOLS.OLDER_AVAILABLE);
});

test("ordinary leads phase out to a fifteen-day retry at attempt fifteen", () => {
  const highTouch = item("high-touch", {
    receivedAt: "2026-07-08T17:00:00.000Z",
    totalAttemptCount: 15,
    lastContactAt: "2026-07-09T17:00:00.000Z",
    nextContactAt: null,
  });
  assert.equal(retryDelayMinutesForLeadAge(highTouch, { now: NOW }), 15 * 24 * 60);
  const held = classifyPool(highTouch, {
    now: NOW,
    ageBasedDailyCaps: true,
    eligibility: { ok: true },
  });
  assert.equal(held.reason, "follow-up-not-due");
  assert.equal(held.nextEligibleAt.toISOString(), "2026-07-24T17:00:00.000Z");

  const crossing = transitionCompletedAttempt(item("crossing", {
    state: "provider_accepted",
    receivedAt: "2026-07-08T17:00:00.000Z",
    dailyAttemptCount: 0,
    totalAttemptCount: 14,
  }), "no_answer", {
    attemptedAt: NOW,
    completedAt: NOW,
    providerCallId: "call-crossing",
    maxDailyAttempts: 3,
    retryDelayMinutes: 120,
  });
  assert.equal(crossing.totalAttemptCount, 15);
  assert.equal(crossing.nextContactAt.toISOString(), "2026-07-25T17:00:00.000Z",
    "the fifteenth completed attempt starts phase-out immediately");
});

test("third no-connect remains waiting but same-day cap blocks it; fourth attempt stays visible", () => {
  const third = transitionCompletedAttempt(item("third", { state: "provider_accepted", dailyAttemptCount: 2, totalAttemptCount: 2 }), "no_answer", {
    attemptedAt: NOW,
    completedAt: NOW,
    providerCallId: "call-third",
    ...policy,
  });
  assert.equal(third.state, "follow_up_wait");
  assert.equal(third.dailyAttemptCount, 3);
  assert.equal(third.reason, "daily-attempt-limit");
  assert.equal(third.nextContactAt, null);
  assert.equal(classifyPool(third, { now: "2026-07-10T18:00:00Z", eligibility: { ok: true } }).reason, "daily-attempt-limit");

  const fourth = transitionCompletedAttempt(item("fourth", { state: "provider_accepted", dailyAttemptCount: 3, totalAttemptCount: 3 }), "busy", {
    attemptedAt: NOW,
    completedAt: NOW,
    providerCallId: "call-fourth",
    ...policy,
  });
  assert.equal(fourth.dailyAttemptCount, 4);
  assert.equal(fourth.policyViolation, "daily-attempt-limit-exceeded");
});

test("a same-day cap carries no retry timer", () => {
  for (const outcome of ["voicemail", "review"]) {
    const capped = decideOutcomeState({
      normalizedOutcome: outcome,
      completedAt: NOW,
      dailyAttemptCount: 2,
      maxDailyAttempts: 2,
      retryDelayMinutes: 120,
    });
    assert.equal(capped.state, "follow_up_wait");
    assert.equal(capped.reason, "daily-attempt-limit");
    assert.equal(capped.nextContactAt, null);
  }
});

test("terminal outcome table emits declarative actions only", () => {
  const cases = [
    ["dnc", "terminal", "logics_dnc"],
    ["bad_lead", "terminal", "logics_dnc"],
    ["appointment", "terminal", null],
    ["client", "terminal", null],
  ];
  for (const [outcome, state, action] of cases) {
    const decision = decideOutcomeState({ normalizedOutcome: outcome, completedAt: NOW, dailyAttemptCount: 1 });
    assert.equal(decision.state, state);
    assert.equal(decision.nextContactAt, null);
    assert.equal(decision.terminalAt.toISOString(), NOW.toISOString());
    assert.equal(decision.actions[0]?.type || null, action);
  }
});

test("answered calls wait for review while unknown calls enter the timed follow-up queue", () => {
  const first = transitionCompletedAttempt(item("review", { state: "provider_accepted", totalAttemptCount: 4 }), "unknown", {
    attemptedAt: "2026-07-10T16:59:30Z",
    completedAt: NOW,
    providerCallId: "call-review",
    ...policy,
  });
  assert.equal(first.state, "follow_up_wait");
  assert.equal(first.activeAttempt, true);
  assert.equal(first.dailyAttemptCount, 1);
  assert.equal(first.totalAttemptCount, 5);
  assert.equal(first.nextContactAt.toISOString(), "2026-07-10T19:00:00.000Z");

  const resolved = transitionCompletedAttempt(first, "dnc", {
    attemptedAt: "2026-07-10T16:59:30Z",
    completedAt: "2026-07-10T17:02:00Z",
    providerCallId: "call-review",
    attemptAlreadyCounted: true,
    ...policy,
  });
  assert.equal(resolved.dailyAttemptCount, 1);
  assert.equal(resolved.totalAttemptCount, 5);
  assert.equal(resolved.lastContactAt.toISOString(), NOW.toISOString());
  assert.equal(resolved.providerCompletedAt.toISOString(), NOW.toISOString());
  assert.equal(resolved.state, "terminal");
  assert.equal(resolved.activeAttempt, false);

  const answered = transitionCompletedAttempt(item("answered", { state: "provider_accepted" }), "answered", {
    attemptedAt: NOW,
    completedAt: NOW,
    providerCallId: "call-answered",
    ...policy,
  });
  assert.equal(answered.state, "review");
  assert.equal(answered.lastOutcome, "answered");
});

test("same-call proof is required to suppress recounting and terminal work cannot reopen", () => {
  const review = item("same-call", {
    state: "review",
    providerCallId: "call-one",
    lastCountedProviderCallId: "call-one",
    attemptedAt: NOW,
    dailyAttemptCount: 1,
    totalAttemptCount: 1,
    lastContactAt: NOW,
  });
  assert.throws(() => transitionCompletedAttempt(review, "dnc", {
    attemptedAt: NOW,
    completedAt: NOW,
    providerCallId: "call-two",
    attemptAlreadyCounted: true,
    ...policy,
  }), /first completion requires/);
  assert.throws(() => projectAttemptCompletion(review, {
    attemptedAt: NOW,
    completedAt: NOW,
    providerCallId: "call-two",
    attemptAlreadyCounted: true,
  }), /providerCallId/);
  assert.throws(() => transitionCompletedAttempt(item("terminal", { state: "terminal" }), "no_answer", {
    attemptedAt: NOW,
    completedAt: NOW,
    providerCallId: "call-terminal",
    ...policy,
  }), /cannot transition/);
  assert.throws(() => transitionCompletedAttempt(item("never-delivered", { state: "eligible" }), "no_answer", {
    attemptedAt: NOW,
    completedAt: NOW,
    providerCallId: "call-never-delivered",
    ...policy,
  }), /first completion requires/);
  assert.throws(() => transitionCompletedAttempt(item("already-final", {
    state: "follow_up_wait",
    providerCallId: "call-final",
    lastCountedProviderCallId: "call-final",
    attemptedAt: NOW,
    lastContactAt: NOW,
  }), "dnc", {
    completedAt: NOW,
    providerCallId: "call-final",
    ...policy,
  }), /same-call resolution requires review/);
});

test("attempt uses call start for Pacific daily key and completion for retry anchor", () => {
  const completion = projectAttemptCompletion(item("cross-midnight", {
    dailyAttemptDateKey: "2026-07-10",
    dailyAttemptCount: 1,
  }), {
    attemptedAt: "2026-07-11T06:59:30Z",
    completedAt: "2026-07-11T07:01:00Z",
    providerCallId: "cross-midnight",
  });
  assert.equal(completion.dailyAttemptDateKey, "2026-07-10");
  assert.equal(completion.dailyAttemptCount, 2);
  assert.equal(completion.lastContactAt.toISOString(), "2026-07-11T07:01:00.000Z");
});

test("physical completion requires call identity and same-call replay dedupes automatically", () => {
  assert.throws(() => projectAttemptCompletion(item("missing-call"), {
    attemptedAt: NOW,
    completedAt: NOW,
  }), /providerCallId is required/);
  const first = projectAttemptCompletion(item("first-call", { totalAttemptCount: 2 }), {
    attemptedAt: NOW,
    completedAt: NOW,
    providerCallId: "call-one",
  });
  assert.equal(first.attemptCounted, true);
  const replay = projectAttemptCompletion({ ...item("first-call"), ...first }, {
    completedAt: "2026-07-11T17:00:00Z",
    providerCallId: "call-one",
  });
  assert.equal(replay.attemptCounted, false);
  assert.equal(replay.dailyAttemptDateKey, "2026-07-10");
  assert.equal(replay.dailyAttemptCount, 1);
  assert.throws(() => projectAttemptCompletion(item("wrong-call", {
    state: "provider_accepted",
    providerCallId: "call-a",
  }), {
    attemptedAt: NOW,
    completedAt: NOW,
    providerCallId: "call-b",
  }), /does not match/);
  assert.throws(() => projectAttemptCompletion(item("invalid-count-key", {
    state: "provider_accepted",
    dailyAttemptDateKey: "2026-02-31",
    dailyAttemptCount: 3,
  }), {
    attemptedAt: NOW,
    completedAt: NOW,
    providerCallId: "call-invalid-key",
  }), /YYYY-MM-DD/);
});

test("agent projection counts anomalies conservatively and blocks refill until identity is repaired", () => {
  const rows = [
    item("A", { state: "provider_accepted", deliveryAgentId: "brad", provider: "phoneburner", providerExternalLeadId: "ext-a", providerContactId: "contact-a", providerAcceptedAt: NOW }),
    item("B", { state: "in_call", deliveryAgentId: "brad", provider: "phoneburner", providerExternalLeadId: "ext-b", providerContactId: "contact-b", providerAcceptedAt: NOW }),
    item("C", { state: "terminal", deliveryAgentId: "brad", provider: "phoneburner", providerExternalLeadId: "ext-c", providerContactId: "contact-c", providerAcceptedAt: NOW, providerCallId: "call-c", providerCompletedAt: NOW }),
    item("D", { state: "follow_up_wait", deliveryAgentId: "brad", provider: "phoneburner", providerExternalLeadId: "ext-d", providerContactId: "contact-d", providerAcceptedAt: NOW, providerCallId: "call-d", providerCompletedAt: NOW }),
    item("E", { state: "packetized", deliveryAgentId: "brad" }),
    item("F", { state: "delivery_failed", deliveryAgentId: "brad" }),
    item("G", { state: "provider_accepted", deliveryAgentId: "sean", provider: "phoneburner", providerExternalLeadId: "ext-g", providerContactId: "contact-g", providerAcceptedAt: NOW }),
    item("H", { state: "provider_accepted", deliveryAgentId: "brad", provider: "phoneburner", providerExternalLeadId: "ext-h", providerAcceptedAt: NOW }),
    item("I", { state: "provider_accepted", deliveryAgentId: "brad", provider: "phoneburner", providerExternalLeadId: "ext-i", providerContactId: "contact-i", providerAcceptedAt: NOW, providerCompletedAt: NOW }),
    item("J", { state: "provider_accepted", deliveryAgentId: "brad", providerExternalLeadId: "ext-j", providerContactId: "contact-j", providerAcceptedAt: NOW }),
    item("K", {
      state: "provider_accepted",
      deliveryAgentId: "brad",
      provider: "phoneburner",
      providerAttemptSequence: 1,
      providerExternalLeadId: "ext-k",
      providerContactId: "contact-k",
      providerAcceptedAt: NOW,
      metadata: { workingFolderDrain: { dateKey: "2026-07-10", status: "provider_absent", attemptNumber: 1 } },
    }),
    item("L", {
      state: "provider_accepted",
      deliveryAgentId: "brad",
      provider: "phoneburner",
      providerAttemptSequence: 2,
      providerExternalLeadId: "ext-l",
      providerContactId: "contact-l",
      providerAcceptedAt: NOW,
      metadata: { workingFolderDrain: { dateKey: "2026-07-09", status: "provider_absent", attemptNumber: 1 } },
    }),
  ];
  assert.deepEqual(reconstructAgentProjection(rows, { agentId: "brad" }), {
    estimatedOutstanding: 6,
    outstandingItemIds: ["A", "B", "H", "I", "J", "L"],
    anomalies: [
      { identity: "H", reason: "accepted-provider-identity-incomplete" },
      { identity: "I", reason: "completion-identity-incomplete" },
      { identity: "J", reason: "accepted-provider-identity-incomplete" },
    ],
    reliable: false,
  });
});
