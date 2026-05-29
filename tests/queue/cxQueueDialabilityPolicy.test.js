"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

process.env.CX_LEAD_SERVING_ALLOWED_AGENT_TOKENS = "agent 101,agent 102,101,102,agent101@example.com,agent102@example.com";
process.env.CX_LEAD_SERVING_EXCLUDED_AGENT_TOKENS = "";
process.env.RC_CX_REQUIRE_WORKSPACE_ACTIVE = "false";
process.env.RC_CX_WORKING_START_HOUR = "8";
process.env.RC_CX_WORKING_END_HOUR = "17";
process.env.RC_CX_GREEN_DAILY_MAX = "3";
process.env.RC_CX_BLUE_DAILY_MAX = "3";
process.env.RC_CX_YELLOW_DAILY_MAX = "1";
process.env.RC_CX_RED_DAILY_MAX = "1";
process.env.RC_CX_GREEN_TOTAL_MAX_CALLS = "8";
process.env.RC_CX_INITIAL_ACTIVE_BUSINESS_DAYS = "5";
process.env.RC_CX_INITIAL_UNANSWERED_MAX = "15";
process.env.RC_CX_CONTACT_EXTENSION_BUSINESS_DAY = "15";
process.env.RC_CX_SECOND_HALF_REQUIRED_CONTACTS = "2";
process.env.RC_CX_SECOND_HALF_BUSINESS_DAY_MAX = "30";
process.env.RC_CX_ENGAGEMENT_POLICY_EFFECTIVE_AT = "2026-04-01T00:00:00.000Z";

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

test("green is age-based and respects 90-minute interval plus 3/day cap", () => {
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
    dailyPlacedCalls: 2,
  }, now).ok, true);

  assert.equal(resolveQueueDialability({
    queueFamily: "fresh-day1",
    lastPlacedAt: minutesAgo(91),
    dailyPlacedDateKey: dateKey,
    dailyPlacedCalls: 3,
  }, now).reason, "daily-cap-reached");

  assert.equal(deriveQueueFamilyFromLeadTouchState({
    createdAt: now,
    asOf: now,
    placedCalls: 99,
  }), "fresh-day1");
  assert.equal(deriveQueueFamilyFromLeadTouchState({
    createdAt: now,
    asOf: new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000),
    placedCalls: 0,
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

test("yellow and red use once-per-day pacing after the initial window", () => {
  assert.equal(resolveQueueDialability({
    queueFamily: "fresh-day16to30",
    dailyPlacedDateKey: dateKey,
    dailyPlacedCalls: 1,
  }, now).reason, "daily-cap-reached");

  assert.equal(resolveQueueDialability({
    queueFamily: "aged",
    lastPlacedAt: new Date("2026-05-01T19:00:00.000Z"),
    dailyPlacedDateKey: dateKey,
    dailyPlacedCalls: 0,
    monthlyPlacedMonthKey: monthKey,
    monthlyPlacedCalls: 99,
  }, now).ok, true);

  assert.equal(resolveQueueDialability({
    queueFamily: "aged",
    lastPlacedAt: new Date("2026-05-01T19:00:00.000Z"),
    dailyPlacedDateKey: dateKey,
    dailyPlacedCalls: 1,
    monthlyPlacedMonthKey: monthKey,
    monthlyPlacedCalls: 99,
  }, now).reason, "daily-cap-reached");
});

test("cx lifecycle requires contact unlocks for day 6-30 eligibility", () => {
  const createdAt = new Date("2026-05-04T23:00:00.000Z");
  const dayFour = new Date("2026-05-08T23:00:00.000Z");
  const dayFive = new Date("2026-05-11T23:00:00.000Z");
  const dayTen = new Date("2026-05-18T23:00:00.000Z");
  const dayFifteen = new Date("2026-05-25T23:00:00.000Z");
  const dayTwenty = new Date("2026-06-01T23:00:00.000Z");
  const dayThirty = new Date("2026-06-15T23:00:00.000Z");
  const dayFortyFive = new Date("2026-07-06T23:00:00.000Z");

  assert.equal(resolveQueueDialability({
    queueFamily: "fresh-day2to10",
    createdAt,
    metadata: { unansweredCalls: 14 },
  }, dayFour).ok, true);

  const budget = resolveQueueDialability({
    queueFamily: "fresh-day2to10",
    createdAt,
    metadata: { unansweredCalls: 15 },
  }, dayFour);
  assert.equal(budget.reason, "no-answer-budget-exhausted");
  assert.equal(budget.nextEligibleAt, null);
  assert.equal(budget.lifecycleHold.terminal, true);

  const age = resolveQueueDialability({
    queueFamily: "fresh-day2to10",
    createdAt,
    metadata: { unansweredCalls: 3 },
  }, dayFive);
  assert.equal(age.reason, "initial-window-complete");
  assert.equal(age.nextEligibleAt, null);

  assert.equal(resolveQueueDialability({
    queueFamily: "fresh-day2to10",
    createdAt,
    metadata: { answeredContacts: 1, unansweredCalls: 20 },
  }, dayTen).ok, true);

  const oneContactExpired = resolveQueueDialability({
    queueFamily: "fresh-day2to10",
    createdAt,
    metadata: { answeredContacts: 1 },
  }, dayFifteen);
  assert.equal(oneContactExpired.reason, "single-contact-window-complete");

  assert.equal(resolveQueueDialability({
    queueFamily: "fresh-day16to30",
    createdAt,
    metadata: { answeredContacts: 2 },
  }, dayTwenty).ok, true);

  const twoContactExpired = resolveQueueDialability({
    queueFamily: "fresh-day16to30",
    createdAt,
    metadata: { answeredContacts: 2 },
  }, dayThirty);
  assert.equal(twoContactExpired.reason, "second-half-window-complete");

  assert.equal(resolveQueueDialability({
    queueFamily: "aged",
    createdAt,
    metadata: { unansweredCalls: 15 },
  }, dayFortyFive).ok, true);
});

test("pacific-state leads wait until 8am local while mountain-plus can start at 7am PT", () => {
  const previousOperationalStart = process.env.RC_CX_OPERATIONAL_START_HOUR;
  const previousOperationalEnd = process.env.RC_CX_OPERATIONAL_END_HOUR;
  process.env.RC_CX_OPERATIONAL_START_HOUR = "7";
  process.env.RC_CX_OPERATIONAL_END_HOUR = "17";
  try {
    const now = new Date("2026-06-01T14:30:00.000Z"); // 7:30am PT, 8:30am MT, 9:30am CT

    const california = resolveQueueDialability({
      queueFamily: "fresh-day1",
      createdAt: now,
      metadata: { leadState: "CA" },
    }, now);
    assert.equal(california.reason, "queue-contact-window");
    assert.equal(california.nextEligibleAt.toISOString(), "2026-06-01T15:00:01.000Z");

    assert.equal(resolveQueueDialability({
      queueFamily: "fresh-day1",
      createdAt: now,
      metadata: { leadState: "CO" },
    }, now).ok, true);

    assert.equal(resolveQueueDialability({
      queueFamily: "fresh-day1",
      createdAt: now,
      metadata: { leadState: "TX" },
    }, now).ok, true);
  } finally {
    if (previousOperationalStart == null) delete process.env.RC_CX_OPERATIONAL_START_HOUR;
    else process.env.RC_CX_OPERATIONAL_START_HOUR = previousOperationalStart;
    if (previousOperationalEnd == null) delete process.env.RC_CX_OPERATIONAL_END_HOUR;
    else process.env.RC_CX_OPERATIONAL_END_HOUR = previousOperationalEnd;
  }
});

test("grandfathered leads use softer first-pass contact gates", () => {
  const previousEffectiveAt = process.env.RC_CX_ENGAGEMENT_POLICY_EFFECTIVE_AT;
  process.env.RC_CX_ENGAGEMENT_POLICY_EFFECTIVE_AT = "2026-05-10T00:00:00.000Z";
  try {
    const createdAt = new Date("2026-04-27T23:00:00.000Z");
    const daySeven = new Date("2026-05-06T23:00:00.000Z");
    const dayTwelve = new Date("2026-05-13T23:00:00.000Z");
    const dayTwenty = new Date("2026-05-25T23:00:00.000Z");

    assert.equal(resolveQueueDialability({
      queueFamily: "fresh-day2to10",
      createdAt,
      metadata: { unansweredCalls: 15 },
    }, daySeven).ok, true);

    const contactRequired = resolveQueueDialability({
      queueFamily: "fresh-day2to10",
      createdAt,
      metadata: { unansweredCalls: 15 },
    }, dayTwelve);
    assert.equal(contactRequired.reason, "grandfather-contact-required");
    assert.equal(contactRequired.lifecycleHold.grandfathered, true);

    assert.equal(resolveQueueDialability({
      queueFamily: "fresh-day2to10",
      createdAt,
      metadata: { answeredContacts: 1, unansweredCalls: 15 },
    }, dayTwelve).ok, true);

    assert.equal(resolveQueueDialability({
      queueFamily: "fresh-day16to30",
      createdAt,
      metadata: { answeredContacts: 0, unansweredCalls: 15 },
    }, dayTwenty).ok, true);
  } finally {
    process.env.RC_CX_ENGAGEMENT_POLICY_EFFECTIVE_AT = previousEffectiveAt;
  }
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
