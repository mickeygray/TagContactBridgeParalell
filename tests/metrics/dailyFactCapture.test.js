"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const DailyQueueRollup = require("../../packages/shared-models/src/DailyQueueRollup");
const queue = require("../../packages/shared-services/src/queueRollupService");
const { ringCentralDateWindow } = require("../../packages/shared-services/src/mailerQueueService");
const {
  createNightlyHygieneRuntime,
} = require("../../apps/control-plane/src/services/nightlyHygieneRuntime");

test("RingCentral capture covers the full Pacific calendar day", () => {
  assert.deepEqual(ringCentralDateWindow("2026-07-31"), {
    dateFrom: "2026-07-31T07:00:00.000Z",
    dateTo: "2026-08-01T06:59:59.999Z",
  });
});

test("RingCentral capture honors 23-hour and 25-hour Pacific DST days", () => {
  const spring = ringCentralDateWindow("2026-03-08");
  const fall = ringCentralDateWindow("2026-11-01");
  assert.equal(Date.parse(spring.dateTo) - Date.parse(spring.dateFrom) + 1, 23 * 60 * 60 * 1000);
  assert.equal(Date.parse(fall.dateTo) - Date.parse(fall.dateFrom) + 1, 25 * 60 * 60 * 1000);
});

test("the durable queue contract canonicalizes agent aliases and strips extra fields", () => {
  const normalized = queue.normalizeQueueDay({
    dateKey: "2026-08-03",
    agents: [
      { agent: "Bruce Allen - TAG", taken: 2, made: 0, byStream: { mailer: 2 }, raw: "drop" },
      { agent: "Bruce Allen", taken: 1, made: 3, byStream: { LD: 3 } },
    ],
    streams: [{ stream: "mailer", calls: 4, connected: 3, missed: 1, raw: "drop" }],
    sourceStatus: {
      ringCentral: { status: "complete" },
      phoneBurner: { status: "complete" },
    },
  });
  assert.equal(normalized.captureVersion, queue.CAPTURE_VERSION);
  assert.deepEqual(normalized.agents, [{
    agent: "Bruce Allen", taken: 3, made: 3, byStream: { MAILER: 2, LD: 3 },
  }]);
  assert.deepEqual(normalized.streams, [{ stream: "MAILER", calls: 4, connected: 3, missed: 1 }]);
  assert.equal("raw" in normalized.agents[0], false);
});

test("stored range coverage separates missing, partial, unavailable, and legacy days", () => {
  const base = (dateKey) => ({
    dateKey,
    captureVersion: queue.CAPTURE_VERSION,
    agents: [],
    streams: [],
  });
  const result = queue.mergeQueueRollups({
    from: "2026-08-01",
    to: "2026-08-05",
    docs: [
      base("2026-08-01"),
      { ...base("2026-08-02"), partial: true },
      { ...base("2026-08-03"), unavailable: true },
      { ...base("2026-08-04"), captureVersion: 1 },
    ],
  });
  assert.deepEqual(result.coverage.missing, ["2026-08-05"]);
  assert.deepEqual(result.coverage.partialDays, ["2026-08-02"]);
  assert.deepEqual(result.coverage.unavailableDays, ["2026-08-03"]);
  assert.deepEqual(result.coverage.legacyDays, ["2026-08-04"]);
  assert.equal(result.coverage.complete, false);
});

test("stored range merge canonicalizes historical agent keys", () => {
  const result = queue.mergeQueueRollups({
    from: "2026-08-01",
    to: "2026-08-02",
    docs: [
      {
        dateKey: "2026-08-01", captureVersion: 2,
        agents: [{ agent: "Bruce Allen - TAG", byStream: { MAILER: 2 } }], streams: [],
      },
      {
        dateKey: "2026-08-02", captureVersion: 2,
        agents: [{ agent: "Bruce Allen", byStream: { MAILER: 3 } }], streams: [],
      },
    ],
  });
  assert.deepEqual(result.queueByAgent, { "Bruce Allen": { MAILER: 5 } });
  assert.equal(result.coverage.complete, true);
});

test("nightly queue apply persists its planned snapshot even on a zero-call day", async () => {
  const task = createNightlyHygieneRuntime({}).TASKS.find((candidate) => candidate.key === "queue-rollup");
  const planned = {
    dateKey: "2026-08-03",
    agents: [],
    streams: [],
    captureVersion: 2,
    sourceStatus: {
      ringCentral: { status: "complete" },
      phoneBurner: { status: "complete" },
    },
    capturedAt: new Date("2026-08-04T07:00:05.000Z"),
    partial: false,
    unavailable: false,
  };
  assert.equal(task.count([planned]), 1, "a quiet day is still a captured fact");

  const originalUpdateOne = DailyQueueRollup.updateOne;
  let update = null;
  DailyQueueRollup.updateOne = async (...args) => { update = args; return { acknowledged: true }; };
  try {
    const result = await task.apply([planned], {});
    assert.equal(result.written, 1);
    assert.equal(update[0].dateKey, planned.dateKey);
    assert.equal(update[1].$set.capturedAt.toISOString(), planned.capturedAt.toISOString());
    assert.deepEqual(update[1].$set.agents, []);
  } finally {
    DailyQueueRollup.updateOne = originalUpdateOne;
  }
});
