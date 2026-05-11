"use strict";

// Pure-function tests for agent-login-window helpers.
// Run via: node --test tests/auth/agentLoginWindow.test.js

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  isAgentLoginWindowOpen,
  todaysAgentLoginWindowClose,
} = require("../../packages/shared-services/src/businessHoursGuard");

const baseConfig = {
  enabled: true,
  agentLoginStartHour: 7,
  agentLoginEndHour: 17,
  agentLoginDays: [1, 2, 3, 4, 5],
  agentLoginTimezone: "America/Los_Angeles",
  holidays: [],
};

// Helper: build a Date for a specific PT wall-clock time. Uses PDT (UTC-7).
// Test dates must be inside DST.
function ptDate(year, month, day, hour, minute = 0) {
  const utcHour = hour + 7;
  return new Date(Date.UTC(year, month - 1, day, utcHour, minute, 0));
}

test("isAgentLoginWindowOpen — Mon 7:00am PT is open (start inclusive)", () => {
  const t = ptDate(2026, 5, 4, 7, 0);  // Monday in PDT
  assert.equal(isAgentLoginWindowOpen(baseConfig, t), true);
});

test("isAgentLoginWindowOpen — Mon 6:59am PT is closed", () => {
  const t = ptDate(2026, 5, 4, 6, 59);
  assert.equal(isAgentLoginWindowOpen(baseConfig, t), false);
});

test("isAgentLoginWindowOpen — Mon 4:59pm PT is open", () => {
  const t = ptDate(2026, 5, 4, 16, 59);
  assert.equal(isAgentLoginWindowOpen(baseConfig, t), true);
});

test("isAgentLoginWindowOpen — Mon 5:00pm PT is closed (end exclusive)", () => {
  const t = ptDate(2026, 5, 4, 17, 0);
  assert.equal(isAgentLoginWindowOpen(baseConfig, t), false);
});

test("isAgentLoginWindowOpen — Sat 10am PT is closed (weekend)", () => {
  const sat = ptDate(2026, 5, 9, 10);  // 2026-05-09 is Saturday
  assert.equal(isAgentLoginWindowOpen(baseConfig, sat), false);
});

test("isAgentLoginWindowOpen — Sun 10am PT is closed", () => {
  const sun = ptDate(2026, 5, 10, 10);
  assert.equal(isAgentLoginWindowOpen(baseConfig, sun), false);
});

test("isAgentLoginWindowOpen — holiday during business hours is closed", () => {
  const config = { ...baseConfig, holidays: ["2026-05-04"] };
  const t = ptDate(2026, 5, 4, 9);
  assert.equal(isAgentLoginWindowOpen(config, t), false);
});

test("isAgentLoginWindowOpen — null config returns false", () => {
  assert.equal(isAgentLoginWindowOpen(null, new Date()), false);
});

test("isAgentLoginWindowOpen — falls back to businessHours fields if agentLogin* missing", () => {
  const fallback = {
    enabled: true,
    businessHoursStart: 7,
    businessHoursEnd: 17,
    businessDays: [1, 2, 3, 4, 5],
    businessHoursTimezone: "America/Los_Angeles",
    holidays: [],
  };
  const mon = ptDate(2026, 5, 4, 9);
  assert.equal(isAgentLoginWindowOpen(fallback, mon), true);
});

test("todaysAgentLoginWindowClose — null when window closed", () => {
  const sat = ptDate(2026, 5, 9, 10);
  assert.equal(todaysAgentLoginWindowClose(baseConfig, sat), null);
});

test("todaysAgentLoginWindowClose — Mon 9am PT returns 5pm PT same day", () => {
  const mon9am = ptDate(2026, 5, 4, 9, 0);
  const close = todaysAgentLoginWindowClose(baseConfig, mon9am);
  assert.ok(close instanceof Date);
  // 5pm PT = mon9am + 8 hours
  const expected = mon9am.getTime() + 8 * 60 * 60 * 1000;
  assert.equal(close.getTime(), expected);
});

test("todaysAgentLoginWindowClose — Mon 4:35pm PT returns 5pm PT (25 min away)", () => {
  const t = ptDate(2026, 5, 4, 16, 35);
  const close = todaysAgentLoginWindowClose(baseConfig, t);
  // 25 minutes from 4:35pm to 5:00pm
  assert.equal(close.getTime() - t.getTime(), 25 * 60 * 1000);
});

test("todaysAgentLoginWindowClose — Mon 7:01am PT returns 5pm same day", () => {
  const t = ptDate(2026, 5, 4, 7, 1);
  const close = todaysAgentLoginWindowClose(baseConfig, t);
  // (17-7) * 60 - 1 = 599 minutes
  assert.equal(close.getTime() - t.getTime(), 599 * 60 * 1000);
});
