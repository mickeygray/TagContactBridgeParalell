"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

process.env.CX_LEAD_SERVING_ALLOWED_AGENT_TOKENS = "agent 101,agent 102,101,102,agent101@example.com,agent102@example.com";
process.env.CX_LEAD_SERVING_EXCLUDED_AGENT_TOKENS = "";
process.env.RC_CX_REQUIRE_WORKSPACE_ACTIVE = "false";
process.env.RC_CX_WORKING_START_HOUR = "8";
process.env.RC_CX_WORKING_END_HOUR = "17";
process.env.RC_CX_GREEN_DAILY_MAX = "5";
process.env.RC_CX_BLUE_DAILY_MAX = "3";
process.env.RC_CX_YELLOW_DAILY_MAX = "1";
process.env.RC_CX_RED_DAILY_MAX = "1";
process.env.RC_CX_GREEN_TOTAL_MAX_CALLS = "8";

const {
  deriveQueueFamilyFromLeadTouchState,
  getPacificDateKey,
  getPacificMonthKey,
  resolveQueueDialability,
} = require("../../packages/shared-services/src/cxQueuePolicyService");
const {
  rankAgentsForQueueItem,
} = require("../../packages/shared-services/src/cxLoadBalancerService");

const now = new Date("2026-05-20T19:00:00.000Z");
const dateKey = getPacificDateKey(now);
const monthKey = getPacificMonthKey(now);

function minutesAgo(minutes) {
  return new Date(now.getTime() - minutes * 60 * 1000);
}

test("green respects 90-minute interval, 5/day cap, and 8 total green attempts", () => {
  assert.equal(resolveQueueDialability({
    queueFamily: "fresh-day1",
    lastPlacedAt: minutesAgo(89),
    dailyPlacedDateKey: dateKey,
    dailyPlacedCalls: 1,
  }, now).reason, "cooldown-active");

  assert.equal(resolveQueueDialability({
    queueFamily: "fresh-day1",
    lastPlacedAt: minutesAgo(91),
    dailyPlacedDateKey: dateKey,
    dailyPlacedCalls: 4,
  }, now).ok, true);

  assert.equal(resolveQueueDialability({
    queueFamily: "fresh-day1",
    lastPlacedAt: minutesAgo(91),
    dailyPlacedDateKey: dateKey,
    dailyPlacedCalls: 5,
  }, now).reason, "daily-cap-reached");

  assert.equal(deriveQueueFamilyFromLeadTouchState({
    createdAt: now,
    asOf: now,
    placedCalls: 7,
  }), "fresh-day1");
  assert.equal(deriveQueueFamilyFromLeadTouchState({
    createdAt: now,
    asOf: now,
    placedCalls: 8,
  }), "fresh-day2to10");
});

test("blue respects 2-hour interval and 3/day cap", () => {
  assert.equal(resolveQueueDialability({
    queueFamily: "fresh-day2to10",
    lastPlacedAt: minutesAgo(119),
    dailyPlacedDateKey: dateKey,
    dailyPlacedCalls: 1,
  }, now).reason, "cooldown-active");

  assert.equal(resolveQueueDialability({
    queueFamily: "fresh-day2to10",
    lastPlacedAt: minutesAgo(121),
    dailyPlacedDateKey: dateKey,
    dailyPlacedCalls: 2,
  }, now).ok, true);

  assert.equal(resolveQueueDialability({
    queueFamily: "fresh-day2to10",
    lastPlacedAt: minutesAgo(121),
    dailyPlacedDateKey: dateKey,
    dailyPlacedCalls: 3,
  }, now).reason, "daily-cap-reached");
});

test("yellow and red use day/month caps instead of green-blue pacing", () => {
  assert.equal(resolveQueueDialability({
    queueFamily: "fresh-day16to30",
    dailyPlacedDateKey: dateKey,
    dailyPlacedCalls: 1,
  }, now).reason, "daily-cap-reached");

  assert.equal(resolveQueueDialability({
    queueFamily: "aged",
    lastPlacedAt: new Date("2026-05-01T19:00:00.000Z"),
    monthlyPlacedMonthKey: monthKey,
    monthlyPlacedCalls: 1,
  }, now).ok, true);

  assert.equal(resolveQueueDialability({
    queueFamily: "aged",
    lastPlacedAt: new Date("2026-05-01T19:00:00.000Z"),
    monthlyPlacedMonthKey: monthKey,
    monthlyPlacedCalls: 2,
  }, now).reason, "monthly-cap-reached");
});

test("last agent to touch a lead is not eligible for the next assignment", () => {
  const policy = {
    enabled: true,
    totalOpen: 20,
    fresh: { eligible: true, firstTouchEligible: true, targetOpen: 10, priorityWeight: 0 },
    day2to15: { targetOpen: 10 },
    day16to30: { targetOpen: 10 },
    aged: { targetOpen: 10, fillRemainder: false },
  };
  const agent = (extensionId) => ({
    extensionId,
    name: `Agent ${extensionId}`,
    status: "available",
    activityState: "idle",
    cxQueuePolicyExplicit: true,
    cxQueuePolicy: policy,
    userAccount: { email: `agent${extensionId}@example.com`, status: "active" },
    cxRouting: {
      enabled: true,
      desiredAvailability: "available",
      assignmentStats: {
        date: dateKey,
        totalAssigned: 0,
        freshDay1Assigned: 0,
        freshDay2to10Assigned: 0,
        freshDay16to30Assigned: 0,
        agedAssigned: 0,
        openAssignments: 0,
      },
    },
  });

  const ranking = rankAgentsForQueueItem([agent("101"), agent("102")], {
    queueFamily: "fresh-day2to10",
    metadata: { lastTouchedExtensionId: "101" },
  });

  assert.equal(ranking.selected.extensionId, "102");
  assert.equal(
    ranking.ranked.find((entry) => entry.extensionId === "101").eligibility.reason,
    "last-agent-called-lead",
  );
});
