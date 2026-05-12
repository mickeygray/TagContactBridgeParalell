"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  deriveQueueFamily,
} = require("../../packages/shared-services/src/cxLoadBalancerService");
const {
  deriveQueueFamilyFromLeadCreatedAt,
  getPacificBusinessDayAge,
  getPacificFreshExpiry,
} = require("../../packages/shared-services/src/cxQueuePolicyService");

test("new green window starts at 4pm PT but expires at 6pm PT the next day", () => {
  const createdAfterFour = new Date("2026-05-11T23:10:00.000Z"); // 4:10pm PDT

  assert.equal(
    deriveQueueFamilyFromLeadCreatedAt(createdAfterFour, new Date("2026-05-12T22:59:00.000Z")),
    "fresh-day1",
  );
  assert.equal(
    deriveQueueFamilyFromLeadCreatedAt(createdAfterFour, new Date("2026-05-12T23:01:00.000Z")),
    "fresh-day1",
  );
  assert.equal(getPacificFreshExpiry(createdAfterFour).toISOString(), "2026-05-13T01:00:00.000Z");
  assert.equal(
    deriveQueueFamilyFromLeadCreatedAt(createdAfterFour, new Date("2026-05-13T01:01:00.000Z")),
    "fresh-day2to10",
  );
});

test("old green does not age until 6pm PT", () => {
  const createdBeforeFour = new Date("2026-05-11T22:30:00.000Z"); // 3:30pm PDT
  const afterFourSameCalendarDay = new Date("2026-05-11T23:45:00.000Z"); // 4:45pm PDT
  const afterGraceSameCalendarDay = new Date("2026-05-12T01:01:00.000Z"); // 6:01pm PDT

  assert.equal(getPacificBusinessDayAge(createdBeforeFour, afterFourSameCalendarDay), 0);
  assert.equal(
    deriveQueueFamilyFromLeadCreatedAt(createdBeforeFour, afterFourSameCalendarDay),
    "fresh-day1",
  );
  assert.equal(
    deriveQueueFamilyFromLeadCreatedAt(createdBeforeFour, afterGraceSameCalendarDay),
    "fresh-day2to10",
  );
});

test("trusted lead-created timestamp overrides stale stored queue family", () => {
  const item = {
    queueFamily: "fresh-day2to10",
    now: new Date("2026-05-12T23:01:00.000Z"),
    metadata: {
      leadCreatedAt: new Date("2026-05-11T23:10:00.000Z"),
    },
  };

  assert.equal(deriveQueueFamily(item), "fresh-day1");
});

test("fresh-looking queue rows rewritten blue are restored during 6pm grace", () => {
  assert.equal(
    deriveQueueFamily({
      queueFamily: "fresh-day2to10",
      queueTier: "day0",
      intakeRoute: "ld-posting-lead",
      createdAt: new Date("2026-05-11T22:50:00.000Z"), // 3:50pm PDT
      now: new Date("2026-05-11T23:55:00.000Z"), // 4:55pm PDT
      metadata: { actionKey: "first-cx:112451" },
      callPlan: { activeDay: 0 },
    }),
    "fresh-day1",
  );
  assert.equal(
    deriveQueueFamily({
      queueFamily: "fresh-day2to10",
      queueTier: "later",
      intakeRoute: "day2to15-cx-refill",
      createdAt: new Date("2026-05-11T23:50:00.000Z"),
      now: new Date("2026-05-11T23:55:00.000Z"),
      metadata: { materializedBy: "cx-workspace-refill" },
    }),
    "fresh-day2to10",
  );
});
