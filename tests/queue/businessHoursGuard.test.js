"use strict";

// Pure-function tests for businessHoursGuard. No Mongo, no async deps.
// Run via: node --test tests/queue/businessHoursGuard.test.js

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  isOperatingNow,
  isChannelOperatingNow,
  clampToOperatingHours,
  clampToChannelOperatingHours,
  formatHourBucket,
  getZonedParts,
} = require("../../packages/shared-services/src/businessHoursGuard");

const baseConfig = {
  enabled: true,
  businessHoursStart: 8,
  businessHoursEnd: 16,
  businessHoursTimezone: "America/Los_Angeles",
  businessDays: [1, 2, 3, 4, 5],
  holidays: [],
  channelOperatingHours: {
    voice: { respectsBusinessHours: true },
    sms: { respectsBusinessHours: true },
    rvm: { respectsBusinessHours: true },
    email: { respectsBusinessHours: false },
  },
};

// Helper: build a Date for a specific PT wall-clock time. Use the
// "America/Los_Angeles" trick: build via UTC, knowing PT is UTC-7
// (PDT) or UTC-8 (PST). For tests we pick dates safely inside DST.
function ptDate(year, month, day, hour, minute = 0) {
  // Use mid-year date when possible to keep PDT (UTC-7).
  // Test dates must be confirmed PDT to avoid DST flakiness.
  const utcHour = hour + 7;
  return new Date(Date.UTC(year, month - 1, day, utcHour, minute, 0));
}

test("isOperatingNow — Monday 9am PT (PDT) is operating", () => {
  // 2026-05-04 is a Monday during PDT
  const monday9amPT = ptDate(2026, 5, 4, 9);
  assert.equal(isOperatingNow(baseConfig, monday9amPT), true);
});

test("isOperatingNow — Monday 7:59am PT is NOT operating", () => {
  const monday759amPT = ptDate(2026, 5, 4, 7, 59);
  assert.equal(isOperatingNow(baseConfig, monday759amPT), false);
});

test("isOperatingNow — Friday 4:00pm PT is NOT operating (end is exclusive)", () => {
  // 2026-05-08 is Friday during PDT
  const fri4pmPT = ptDate(2026, 5, 8, 16, 0);
  assert.equal(isOperatingNow(baseConfig, fri4pmPT), false);
});

test("isOperatingNow — Friday 3:59pm PT IS operating", () => {
  const fri359pmPT = ptDate(2026, 5, 8, 15, 59);
  assert.equal(isOperatingNow(baseConfig, fri359pmPT), true);
});

test("isOperatingNow — Saturday 10am PT is NOT operating (weekend)", () => {
  const sat10amPT = ptDate(2026, 5, 9, 10);
  assert.equal(isOperatingNow(baseConfig, sat10amPT), false);
});

test("isOperatingNow — Sunday 10am PT is NOT operating (weekend)", () => {
  const sun10amPT = ptDate(2026, 5, 10, 10);
  assert.equal(isOperatingNow(baseConfig, sun10amPT), false);
});

test("isOperatingNow — holiday during business hours is NOT operating", () => {
  const config = { ...baseConfig, holidays: ["2026-05-04"] };
  const monday9amPT = ptDate(2026, 5, 4, 9);
  assert.equal(isOperatingNow(config, monday9amPT), false);
});

test("isOperatingNow — config.enabled = false short-circuits to false", () => {
  const config = { ...baseConfig, enabled: false };
  const monday9amPT = ptDate(2026, 5, 4, 9);
  assert.equal(isOperatingNow(config, monday9amPT), false);
});

test("isChannelOperatingNow — email always operates (Sat 11pm)", () => {
  const sat11pmPT = ptDate(2026, 5, 9, 23);
  assert.equal(isChannelOperatingNow(baseConfig, "email", sat11pmPT), true);
});

test("isChannelOperatingNow — voice respects business hours (Sat 11pm fails)", () => {
  const sat11pmPT = ptDate(2026, 5, 9, 23);
  assert.equal(isChannelOperatingNow(baseConfig, "voice", sat11pmPT), false);
});

test("isChannelOperatingNow — sms respects business hours (Mon 7am fails)", () => {
  const mon7amPT = ptDate(2026, 5, 4, 7);
  assert.equal(isChannelOperatingNow(baseConfig, "sms", mon7amPT), false);
});

test("isChannelOperatingNow — rvm respects business hours (Mon 9am succeeds)", () => {
  const mon9amPT = ptDate(2026, 5, 4, 9);
  assert.equal(isChannelOperatingNow(baseConfig, "rvm", mon9amPT), true);
});

test("clampToOperatingHours — Sunday afternoon shifts to Monday 8am window", () => {
  const sun3pmPT = ptDate(2026, 5, 10, 15);
  const clamped = clampToOperatingHours(sun3pmPT, baseConfig);
  // Should be Monday 2026-05-11, 8am PT
  const parts = getZonedParts(clamped, "America/Los_Angeles");
  assert.equal(parts.weekday, 1, "should land on Monday");
  assert.equal(parts.hour, 8, "should land at 8am PT");
});

test("clampToChannelOperatingHours — email passes through unchanged", () => {
  const sun3pmPT = ptDate(2026, 5, 10, 15);
  const clamped = clampToChannelOperatingHours(sun3pmPT, "email", baseConfig);
  assert.equal(clamped.getTime(), sun3pmPT.getTime());
});

test("clampToChannelOperatingHours — voice clamps off-hours", () => {
  const sun3pmPT = ptDate(2026, 5, 10, 15);
  const clamped = clampToChannelOperatingHours(sun3pmPT, "voice", baseConfig);
  assert.notEqual(clamped.getTime(), sun3pmPT.getTime());
});

test("formatHourBucket — produces YYYY-MM-DD-HH PT key", () => {
  const mon9amPT = ptDate(2026, 5, 4, 9);
  const bucket = formatHourBucket(mon9amPT, "America/Los_Angeles");
  assert.equal(bucket, "2026-05-04-09");
});
