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

test("new green window starts at 3:30pm PT and stays green through day two", () => {
  const createdAfterRollover = new Date("2026-05-11T22:40:00.000Z"); // 3:40pm PDT

  assert.equal(
    deriveQueueFamilyFromLeadCreatedAt(createdAfterRollover, new Date("2026-05-12T22:29:00.000Z")),
    "fresh-day1",
  );
  assert.equal(
    deriveQueueFamilyFromLeadCreatedAt(createdAfterRollover, new Date("2026-05-12T22:31:00.000Z")),
    "fresh-day1",
  );
  assert.equal(getPacificFreshExpiry(createdAfterRollover).toISOString(), "2026-05-12T22:30:00.000Z");
  assert.equal(
    deriveQueueFamilyFromLeadCreatedAt(createdAfterRollover, new Date("2026-05-13T22:31:00.000Z")),
    "fresh-day2to10",
  );
});

test("pre-rollover green stays green through its second business day", () => {
  const createdBeforeRollover = new Date("2026-05-11T22:20:00.000Z"); // 3:20pm PDT
  const beforeRolloverSameCalendarDay = new Date("2026-05-11T22:29:00.000Z"); // 3:29pm PDT
  const afterRolloverSameCalendarDay = new Date("2026-05-11T22:31:00.000Z"); // 3:31pm PDT
  const afterSecondRollover = new Date("2026-05-12T22:31:00.000Z"); // 3:31pm PDT next day

  assert.equal(getPacificBusinessDayAge(createdBeforeRollover, beforeRolloverSameCalendarDay), 0);
  assert.equal(
    deriveQueueFamilyFromLeadCreatedAt(createdBeforeRollover, beforeRolloverSameCalendarDay),
    "fresh-day1",
  );
  assert.equal(
    deriveQueueFamilyFromLeadCreatedAt(createdBeforeRollover, afterRolloverSameCalendarDay),
    "fresh-day1",
  );
  assert.equal(
    deriveQueueFamilyFromLeadCreatedAt(createdBeforeRollover, afterSecondRollover),
    "fresh-day2to10",
  );
});

test("friday afternoon and weekend leads stay green on monday morning", () => {
  const fridayAfterRollover = new Date("2026-05-15T22:40:00.000Z"); // Friday 3:40pm PDT
  const mondayMorning = new Date("2026-05-18T14:00:00.000Z"); // Monday 7:00am PDT
  const mondayAfternoon = new Date("2026-05-18T22:31:00.000Z"); // Monday 3:31pm PDT
  const tuesdayAfternoon = new Date("2026-05-19T22:31:00.000Z"); // Tuesday 3:31pm PDT

  assert.equal(getPacificBusinessDayAge(fridayAfterRollover, mondayMorning), 1);
  assert.equal(
    deriveQueueFamilyFromLeadCreatedAt(fridayAfterRollover, mondayMorning),
    "fresh-day1",
  );
  assert.equal(
    deriveQueueFamilyFromLeadCreatedAt(fridayAfterRollover, mondayAfternoon),
    "fresh-day1",
  );
  assert.equal(
    deriveQueueFamilyFromLeadCreatedAt(fridayAfterRollover, tuesdayAfternoon),
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
