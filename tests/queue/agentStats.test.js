"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  applyCallEndedDailyStats,
  applyCallStartedDailyStats,
  normalizeDailyStats,
} = require("../../packages/shared-services/src/agentAvailabilityService");

test("CX call start increments total/cx/outbound once for a new call identity", () => {
  const now = new Date("2026-05-12T17:00:00.000Z");
  const previous = {
    status: "available",
    activityState: "idle",
    currentCall: {},
    dailyStats: normalizeDailyStats({}, now),
  };
  const call = {
    sessionId: "uii-1",
    telephonySessionId: "uii-1",
    channel: "cx",
    direction: "outbound",
  };

  const stats = applyCallStartedDailyStats(previous, previous.dailyStats, {
    call,
    platform: "cx",
    direction: "outbound",
    date: now,
  });

  assert.equal(stats.totalCalls, 1);
  assert.equal(stats.cxCalls, 1);
  assert.equal(stats.outboundCalls, 1);
});

test("CX call end increments goodCalls while the active call is still present", () => {
  const now = new Date("2026-05-12T17:05:00.000Z");
  const previous = {
    status: "onCall",
    activityState: "onCall",
    activePlatform: "CX",
    currentCall: {
      sessionId: "uii-1",
      telephonySessionId: "uii-1",
      channel: "cx",
    },
    dailyStats: {
      ...normalizeDailyStats({}, now),
      totalCalls: 1,
      cxCalls: 1,
      outboundCalls: 1,
    },
  };

  const stats = applyCallEndedDailyStats(previous, previous.dailyStats, {
    missed: false,
    date: now,
  });

  assert.equal(stats.goodCalls, 1);
  assert.equal(stats.badCalls, 0);
  assert.equal(stats.totalCalls, 1);
});

test("CX call end is idempotent after the agent is already available", () => {
  const now = new Date("2026-05-12T17:10:00.000Z");
  const previous = {
    status: "available",
    activityState: "idle",
    activePlatform: "none",
    currentCall: {},
    dailyStats: {
      ...normalizeDailyStats({}, now),
      totalCalls: 1,
      cxCalls: 1,
      outboundCalls: 1,
      goodCalls: 1,
    },
  };

  const stats = applyCallEndedDailyStats(previous, previous.dailyStats, {
    missed: false,
    date: now,
  });

  assert.equal(stats.goodCalls, 1);
  assert.equal(stats.totalCalls, 1);
});
