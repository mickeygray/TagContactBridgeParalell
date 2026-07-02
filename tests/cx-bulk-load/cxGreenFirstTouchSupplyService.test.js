"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  buildMorningCoverageSupplyPlan,
  createCxGreenFirstTouchSupplyPlanner,
  resolveMorningCoverageBatchWindow,
  summarizeMorningCoverageDebt,
} = require("../../packages/shared-services/src/cxGreenFirstTouchSupplyService");

test("Monday morning coverage window looks back across the weekend", () => {
  const window = resolveMorningCoverageBatchWindow({
    domain: "wynn",
    asOf: new Date("2026-06-29T15:00:00.000Z"),
    cutoffHour: 7,
    cutoffMinute: 45,
  });
  assert.equal(window.batchId, "green-coverage-2026-06-29-WYNN");
  assert.equal(window.lookbackDays, 3);
  assert.equal(window.reason, "weekend-and-overnight-coverage");
  assert.equal(window.timezone, "America/Los_Angeles");
  assert.equal(window.cutoffAt.toISOString(), "2026-06-29T14:45:00.000Z");
  assert.equal(window.windowStartAt.toISOString(), "2026-06-26T14:45:00.000Z");
});

test("TAG morning coverage cutoff resolves in Eastern time", () => {
  const window = resolveMorningCoverageBatchWindow({
    domain: "tag",
    asOf: new Date("2026-06-29T12:00:00.000Z"),
    cutoffHour: 7,
    cutoffMinute: 45,
  });
  assert.equal(window.batchId, "green-coverage-2026-06-29-TAG");
  assert.equal(window.timezone, "America/New_York");
  assert.equal(window.cutoffAt.toISOString(), "2026-06-29T11:45:00.000Z");
  assert.equal(window.windowStartAt.toISOString(), "2026-06-26T11:45:00.000Z");
});

test("coverage plan opens a finite first-touch claim for remaining debt", () => {
  const debt = summarizeMorningCoverageDebt({
    batchId: "green-coverage-2026-06-29-WYNN",
    eligible: 12,
    touched: 4,
    blocked: 1,
    queued: 5,
    missingQueueRows: 2,
  });
  const plan = buildMorningCoverageSupplyPlan({
    batchId: debt.batchId,
    debt,
    deficit: 3,
    normalFamilyTargets: { "fresh-day1": 15, aged: 5 },
  });
  assert.equal(plan.lane, "morningCoverage");
  assert.equal(plan.coverageOpen, true);
  assert.equal(plan.firstTouchOnly, true);
  assert.deepEqual(plan.familyTargets, { "fresh-day1": 3 });
  assert.deepEqual(plan.claimFilter, {
    firstTouchOnly: true,
    greenCoverageBatchId: "green-coverage-2026-06-29-WYNN",
    firstTouchMaxAttempts: 1,
  });
});

test("coverage plan returns normal mix when debt is gone", () => {
  const plan = buildMorningCoverageSupplyPlan({
    batchId: "green-coverage-2026-06-29-WYNN",
    debt: { remaining: 0 },
    normalFamilyTargets: { "fresh-day1": 10, aged: 5 },
  });
  assert.equal(plan.lane, "normal");
  assert.equal(plan.coverageOpen, false);
  assert.equal(plan.firstTouchOnly, false);
  assert.deepEqual(plan.familyTargets, { "fresh-day1": 10, aged: 5 });
  assert.deepEqual(plan.claimFilter, { firstTouchOnly: false });
});

test("supply planner is default-off and returns the normal family mix", async () => {
  const planner = createCxGreenFirstTouchSupplyPlanner({
    enabled: false,
    queueRepository: {
      async countReadyFirstTouchRows() {
        throw new Error("should-not-count-when-disabled");
      },
    },
  });

  const plan = await planner.resolvePlan({
    domain: "wynn",
    asOf: new Date("2026-06-29T15:00:00.000Z"),
    deficit: 4,
    normalFamilyTargets: { "fresh-day1": 15, aged: 5 },
  });

  assert.equal(plan.lane, "normal");
  assert.equal(plan.firstTouchOnly, false);
  assert.equal(plan.reason, "green-first-touch-disabled");
  assert.equal(plan.batchId, "green-coverage-2026-06-29-WYNN");
  assert.deepEqual(plan.familyTargets, { "fresh-day1": 15, aged: 5 });
});

test("supply planner counts ready first-touch rows for the finite coverage batch", async () => {
  const calls = [];
  const planner = createCxGreenFirstTouchSupplyPlanner({
    enabled: true,
    queueRepository: {
      async countReadyFirstTouchRows(input) {
        calls.push(input);
        return 6;
      },
    },
    cutoffHour: 7,
    cutoffMinute: 45,
  });

  const plan = await planner.resolvePlan({
    domain: "tag",
    asOf: new Date("2026-06-29T15:00:00.000Z"),
    deficit: 3,
    normalFamilyTargets: { "fresh-day1": 15, "fresh-day2to10": 10, aged: 5 },
    ringcx: { accountId: "acct1", campaignId: "camp1", dialGroupId: "dg1" },
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    domain: "tag",
    greenCoverageBatchId: "green-coverage-2026-06-29-TAG",
    rcxAccountId: "acct1",
    rcxCampaignId: "camp1",
    rcxDialGroupId: "dg1",
    firstTouchMaxAttempts: 1,
    now: new Date("2026-06-29T15:00:00.000Z"),
  });
  assert.equal(plan.lane, "morningCoverage");
  assert.equal(plan.firstTouchOnly, true);
  assert.equal(plan.batchId, "green-coverage-2026-06-29-TAG");
  assert.deepEqual(plan.familyTargets, { "fresh-day1": 3 });
  assert.deepEqual(plan.claimFilter, {
    firstTouchOnly: true,
    greenCoverageBatchId: "green-coverage-2026-06-29-TAG",
    firstTouchMaxAttempts: 1,
  });
  assert.equal(plan.counts.remaining, 6);
});

test("supply planner forwards configured first-touch max attempts to count and claim", async () => {
  const calls = [];
  const planner = createCxGreenFirstTouchSupplyPlanner({
    enabled: true,
    firstTouchMaxAttempts: 2,
    queueRepository: {
      async countReadyFirstTouchRows(input) {
        calls.push(input);
        return 4;
      },
    },
  });

  const plan = await planner.resolvePlan({
    domain: "wynn",
    asOf: new Date("2026-06-29T15:00:00.000Z"),
    deficit: 2,
    normalFamilyTargets: { "fresh-day1": 15 },
  });

  assert.equal(calls[0].firstTouchMaxAttempts, 2);
  assert.equal(plan.claimFilter.firstTouchMaxAttempts, 2);
});
