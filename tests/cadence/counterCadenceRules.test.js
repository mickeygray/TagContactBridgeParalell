"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  evaluateCounterCadenceDueItems,
  formatDateInZone,
  getCounterCadenceCounters,
  getCounterCadenceTemplateKey,
  isWeekdayBatchTime,
} = require("../../packages/shared-services/src/counterCadenceService");

function buildLead(overrides = {}) {
  return {
    domain: "WYNN",
    caseId: 101617,
    active: true,
    primaryPhone: "3106665997",
    email: "lead@example.com",
    createdAt: new Date("2026-05-05T18:00:00.000Z"),
    payloadSnapshot: {
      createdAt: new Date("2026-05-05T14:00:00.000Z"),
    },
    validationContext: {
      phoneCanText: true,
      phoneCanCall: true,
      emailCanSend: true,
    },
    cadenceCounters: {
      sms: 0,
      email: 0,
      rvm: 0,
      cx: 0,
    },
    lastTouched: {
      sms: null,
      email: null,
      rvm: null,
      cx: null,
    },
    cadenceState: {
      channelDnc: {},
    },
    counterCadence: {
      lastDailyBatchKey: {},
      deferUntil: {},
      locks: {},
    },
    ...overrides,
  };
}

test("template chains are one-based and flat", () => {
  assert.equal(getCounterCadenceTemplateKey("sms", 1), "prospect-first-text");
  assert.equal(getCounterCadenceTemplateKey("sms", 2), "prospect-follow-up-text-2");
  assert.equal(getCounterCadenceTemplateKey("email", 10), "prospect-follow-up-10-email");
  assert.equal(getCounterCadenceTemplateKey("rvm", 12), "prospect-rvm-12");
  assert.equal(getCounterCadenceTemplateKey("sms", 99), null);
});

test("counters fall back to migrated legacy payload", () => {
  const counters = getCounterCadenceCounters(buildLead({
    cadenceCounters: undefined,
    cadenceState: {},
    payloadSnapshot: {
      legacyCounters: {
        textsSent: 2,
        emailsSent: 4,
        rvmsSent: 6,
        callsMade: 8,
      },
    },
  }));

  assert.deepEqual(counters, {
    sms: 2,
    email: 4,
    rvm: 6,
    cx: 8,
  });
});

test("text 2 is due at receipt plus 2h, not Mongo upsert createdAt", () => {
  const now = new Date("2026-05-05T18:05:00.000Z");
  const items = evaluateCounterCadenceDueItems(buildLead({
    createdAt: new Date("2026-05-05T18:00:00.000Z"),
    payloadSnapshot: {
      createdAt: new Date("2026-05-05T15:59:00.000Z"),
    },
    cadenceCounters: {
      sms: 1,
      email: 1,
      rvm: 0,
      cx: 0,
    },
    lastTouched: {
      sms: new Date("2026-05-05T15:59:00.000Z"),
      email: null,
      rvm: null,
      cx: null,
    },
  }), {
    now,
    includeDaily: false,
  });

  assert.equal(items.length, 1);
  assert.equal(items[0].channel, "sms");
  assert.equal(items[0].templateIndex, 2);
  assert.equal(items[0].templateKey, "prospect-follow-up-text-2");
  assert.equal(items[0].reason, "text-2-age-relative");
});

test("daily batch advances due text/email/rvm counters during weekday window", () => {
  const now = new Date("2026-05-05T17:00:00.000Z");
  assert.equal(isWeekdayBatchTime(now), true);

  const items = evaluateCounterCadenceDueItems(buildLead({
    payloadSnapshot: {
      createdAt: new Date("2026-05-04T12:00:00.000Z"),
    },
    cadenceCounters: {
      sms: 2,
      email: 1,
      rvm: 0,
      cx: 0,
    },
    lastTouched: {
      sms: new Date("2026-05-04T12:00:00.000Z"),
      email: new Date("2026-05-04T12:00:00.000Z"),
      rvm: null,
      cx: null,
    },
  }), {
    now,
    includeAgeRelative: false,
  });

  assert.deepEqual(
    items.map((item) => `${item.channel}:${item.templateIndex}:${item.reason}`),
    [
      "sms:3:daily-time-of-day",
      "email:2:daily-time-of-day",
      "rvm:1:daily-time-of-day",
    ],
  );
});

test("daily batch respects channel blocks and per-day channel touch keys", () => {
  const now = new Date("2026-05-05T17:00:00.000Z");
  const items = evaluateCounterCadenceDueItems(buildLead({
    payloadSnapshot: {
      createdAt: new Date("2026-05-01T12:00:00.000Z"),
    },
    cadenceCounters: {
      sms: 2,
      email: 1,
      rvm: 0,
      cx: 0,
    },
    cadenceState: {
      channelDnc: {
        rvm: { blocked: true, reason: "legacy-rvm-dnc" },
      },
    },
    counterCadence: {
      lastDailyBatchKey: {
        sms: formatDateInZone(now),
      },
    },
  }), {
    now,
    includeAgeRelative: false,
  });

  assert.deepEqual(items.map((item) => item.channel), ["email"]);
});

test("daily batch does not run outside the configured Los Angeles window", () => {
  const now = new Date("2026-05-05T15:00:00.000Z");
  assert.equal(isWeekdayBatchTime(now), false);

  const items = evaluateCounterCadenceDueItems(buildLead({
    payloadSnapshot: {
      createdAt: new Date("2026-05-01T12:00:00.000Z"),
    },
    cadenceCounters: {
      sms: 2,
      email: 1,
      rvm: 0,
      cx: 0,
    },
  }), {
    now,
    includeAgeRelative: false,
  });

  assert.equal(items.length, 0);
});
