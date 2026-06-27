"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  buildTerminalOutboxPayloadFromEvidence,
  classifyRectificationEvidence,
  runCxTerminalRectification,
} = require("../../packages/shared-services/src/cxTerminalRectificationService");

const NOW = new Date("2026-06-24T17:00:00.000Z");
const START = new Date("2026-06-24T16:42:00.000Z");
const END = new Date("2026-06-24T16:43:00.000Z");

function callLog(overrides = {}) {
  return {
    domain: "TAG",
    caseId: 12345,
    platform: "cx",
    telephonySessionId: "UII-REAL-1",
    callStartTime: START,
    callEndTime: END,
    ringcx: {
      queueItemId: "q1",
      externId: "ext-1",
      agentEmail: "agent@example.com",
    },
    ...overrides,
  };
}

function queueItem(overrides = {}) {
  return {
    _id: "q1",
    state: "serving",
    metadata: {},
    ...overrides,
  };
}

function fakeDeps({ logs = [callLog()], queueRows = { q1: queueItem() }, existing = [] } = {}) {
  const inserted = [];
  return {
    inserted,
    callLogRepository: {
      async listCxCallLogsForTerminalRectification() {
        return logs;
      },
    },
    queueRepository: {
      async findQueueItemById(id) {
        return queueRows[id] || null;
      },
    },
    outboxRepository: {
      async findByIdemKeys() {
        return existing;
      },
      async insertOnce(row) {
        inserted.push(row);
        return row;
      },
    },
  };
}

test("classifyRectificationEvidence inserts only for an ended real RingCX call with an owned queue row", () => {
  const evidence = classifyRectificationEvidence({
    callLog: callLog(),
    queueItem: queueItem(),
    activeUiiSet: new Set(),
  });

  assert.equal(evidence.level, "strong");
  assert.equal(evidence.action, "insert-terminal-outbox");
  assert.equal(evidence.outcome, "did_not_connect");
  assert.equal(evidence.reason, "ended-cx-call-without-terminal");
  assert.equal(evidence.idemKey, "q1:UII-REAL-1");
});

test("classifyRectificationEvidence reports synthetic or missing UII evidence without writing", () => {
  const evidence = classifyRectificationEvidence({
    callLog: callLog({ telephonySessionId: "cx-synth:q1" }),
    queueItem: queueItem(),
    activeUiiSet: new Set(),
  });

  assert.equal(evidence.action, "report-only");
  assert.equal(evidence.reason, "missing-real-uii");
});

test("classifyRectificationEvidence skips active UIIs", () => {
  const evidence = classifyRectificationEvidence({
    callLog: callLog(),
    queueItem: queueItem(),
    activeUiiSet: new Set(["UII-REAL-1"]),
  });

  assert.equal(evidence.action, "skip");
  assert.equal(evidence.reason, "still-active");
});

test("classifyRectificationEvidence skips existing outbox rows", () => {
  const evidence = classifyRectificationEvidence({
    callLog: callLog(),
    queueItem: queueItem(),
    existingOutbox: { idemKey: "q1:UII-REAL-1" },
    activeUiiSet: new Set(),
  });

  assert.equal(evidence.action, "skip");
  assert.equal(evidence.reason, "already-has-terminal-outbox");
});

test("classifyRectificationEvidence keeps open call logs read-only by default", () => {
  const evidence = classifyRectificationEvidence({
    callLog: callLog({ callEndTime: null }),
    queueItem: queueItem(),
    activeUiiSet: new Set(),
  });

  assert.equal(evidence.level, "medium");
  assert.equal(evidence.action, "report-only");
  assert.equal(evidence.reason, "missing-call-end-time");
});

test("classifyRectificationEvidence keeps too-recent ended calls read-only", () => {
  const evidence = classifyRectificationEvidence({
    callLog: callLog(),
    queueItem: queueItem(),
    activeUiiSet: new Set(),
    minEndedBefore: new Date("2026-06-24T16:42:30.000Z"),
  });

  assert.equal(evidence.level, "medium");
  assert.equal(evidence.action, "report-only");
  assert.equal(evidence.reason, "call-ended-too-recent");
});

test("buildTerminalOutboxPayloadFromEvidence creates the drain payload shape", () => {
  const evidence = classifyRectificationEvidence({
    callLog: callLog(),
    queueItem: queueItem(),
    activeUiiSet: new Set(),
  });
  const payload = buildTerminalOutboxPayloadFromEvidence(evidence, { at: NOW });

  assert.equal(payload.idemKey, "q1:UII-REAL-1");
  assert.equal(payload.rail, "rectifier");
  assert.equal(payload.outcome, "did_not_connect");
  assert.equal(payload.payload.queueItemId, "q1");
  assert.equal(payload.payload.sourceService, "cx-terminal-rectifier");
});

test("runCxTerminalRectification dry-run reports inserts without writing", async () => {
  const deps = fakeDeps();
  const result = await runCxTerminalRectification(deps, {
    dryRun: true,
    now: NOW,
  });

  assert.equal(result.dryRun, true);
  assert.equal(result.scanned, 1);
  assert.equal(result.wouldInsert, 1);
  assert.equal(result.inserted, 0);
  assert.equal(deps.inserted.length, 0);
});

test("runCxTerminalRectification write mode inserts one terminal outbox row", async () => {
  const deps = fakeDeps();
  const result = await runCxTerminalRectification(deps, {
    dryRun: false,
    now: NOW,
  });

  assert.equal(result.dryRun, false);
  assert.equal(result.wouldInsert, 1);
  assert.equal(result.inserted, 1);
  assert.equal(deps.inserted.length, 1);
  assert.equal(deps.inserted[0].idemKey, "q1:UII-REAL-1");
  assert.equal(deps.inserted[0].payload.outcome, "did_not_connect");
});
