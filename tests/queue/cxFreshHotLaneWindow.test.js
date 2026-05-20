"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  computeFreshHotLaneWindow,
} = require("../../packages/shared-services/src/cxFreshHotLaneService");

test("computeFreshHotLaneWindow uses previous 3:30pm LA before daily rollover", () => {
  const asOf = new Date("2026-05-06T15:00:00.000Z"); // 8:00am PDT
  const window = computeFreshHotLaneWindow(asOf);

  assert.equal(window.timeZone, "America/Los_Angeles");
  assert.equal(window.rolloverHour, 15);
  assert.equal(window.rolloverMinute, 30);
  assert.equal(window.windowStart.toISOString(), "2026-05-05T22:30:00.000Z");
  assert.equal(window.windowEnd.toISOString(), asOf.toISOString());
});

test("computeFreshHotLaneWindow uses same-day 3:30pm LA after rollover", () => {
  const asOf = new Date("2026-05-07T00:30:00.000Z"); // 5:30pm PDT on May 6
  const window = computeFreshHotLaneWindow(asOf);

  assert.equal(window.windowStart.toISOString(), "2026-05-06T22:30:00.000Z");
  assert.equal(window.windowEnd.toISOString(), asOf.toISOString());
});
