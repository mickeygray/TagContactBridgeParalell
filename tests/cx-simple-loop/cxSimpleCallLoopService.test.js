"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  normalizeSimpleLoopDisposition,
  reduceCxSimpleLoopSession,
  sanitizeSessionForClient,
} = require("../../packages/shared-services/src/cxSimpleCallLoopService");

function baseCandidate(overrides = {}) {
  return {
    queueItemId: "queue-1",
    domain: "WYNN",
    caseId: 12345,
    name: "Example Prospect",
    phone: "3105551212",
    phoneLast4: "1212",
    campaignId: "campaign-a",
    dialGroupId: "group-a",
    externId: "parallel:WYNN:12345:queue-1",
    status: "pending",
    ...overrides,
  };
}

test("simple loop normalizes UI terminal button outcomes for the CX disposition path", () => {
  assert.equal(normalizeSimpleLoopDisposition("answered"), "answered");
  assert.equal(normalizeSimpleLoopDisposition("answer"), "answered");
  assert.equal(normalizeSimpleLoopDisposition("did-not-answer"), "did_not_connect");
  assert.equal(normalizeSimpleLoopDisposition("did_not_connect"), "did_not_connect");
  assert.equal(normalizeSimpleLoopDisposition("no answer"), "did_not_connect");
  assert.equal(normalizeSimpleLoopDisposition("voicemail"), "voicemail");
  assert.equal(normalizeSimpleLoopDisposition("left_message"), "voicemail");
});

test("simple loop reducer moves one candidate from queue to active current", () => {
  const startedAt = new Date("2026-06-19T12:00:00.000Z");
  const first = reduceCxSimpleLoopSession(
    {
      status: "running",
      queue: [baseCandidate()],
      current: null,
      completed: [],
      events: [],
      stats: {},
    },
    {
      type: "advance.started",
      candidate: baseCandidate(),
    },
    startedAt,
  );

  assert.equal(first.queue.length, 0);
  assert.equal(first.current.queueItemId, "queue-1");
  assert.equal(first.current.phase, "publishing");

  const published = reduceCxSimpleLoopSession(
    first,
    {
      type: "publish.accepted",
      queueItemId: "queue-1",
      campaignId: "campaign-a",
      dialGroupId: "group-a",
      externId: "parallel:WYNN:12345:queue-1",
    },
    new Date("2026-06-19T12:00:01.000Z"),
  );

  assert.equal(published.current.phase, "confirming");
  assert.equal(published.current.ringcx.status, "published");
  assert.equal(published.stats.published, 1);

  const active = reduceCxSimpleLoopSession(
    published,
    {
      type: "capture.found",
      queueItemId: "queue-1",
      uii: "202606190001",
      matchReasons: ["externId"],
      firstPollMs: 0,
      uiiFoundMs: 240,
    },
    new Date("2026-06-19T12:00:02.000Z"),
  );

  assert.equal(active.current.phase, "active");
  assert.equal(active.current.uii, "202606190001");
  assert.equal(active.stats.captureFound, 1);
});

test("simple loop reducer can make a lead active without UII evidence", () => {
  const active = reduceCxSimpleLoopSession(
    {
      status: "running",
      queue: [],
      current: {
        ...baseCandidate({ queueItemId: "queue-1", phone: "3105551212", phoneLast4: "1212" }),
        phase: "confirming",
      },
      completed: [],
      events: [],
      stats: {},
    },
    {
      type: "capture.found",
      queueItemId: "queue-1",
      activeCallSummary: { state: "ringing" },
      matchReasons: ["campaignId", "agentEmail", "activeState"],
      firstPollMs: 0,
      uiiFoundMs: 240,
    },
    new Date("2026-06-19T12:00:01.500Z"),
  );

  assert.equal(active.current.phase, "active");
  assert.equal(active.current.uii, null);
});

test("simple loop reducer terminal submit is idempotent by queue item", () => {
  const first = reduceCxSimpleLoopSession(
    {
      status: "running",
      queue: [],
      current: {
        ...baseCandidate({ queueItemId: "queue-1" }),
        phase: "active",
        uii: "202606190002",
      },
      completed: [],
      events: [],
      stats: {},
    },
    {
      type: "terminal.submitted",
      outcome: "no_answer",
      dispositionResult: { ok: true },
    },
    new Date("2026-06-19T12:05:00.000Z"),
  );

  const second = reduceCxSimpleLoopSession(
    first,
    {
      type: "terminal.submitted",
      outcome: "no_answer",
      dispositionResult: { ok: true },
    },
    new Date("2026-06-19T12:05:00.500Z"),
  );

  assert.equal(second.current, null);
  assert.equal(second.completed.length, 1);
  assert.equal(second.completed[0].outcome, "no_answer");
  assert.equal(second.stats.completed, 1);
});

test("simple loop reducer does not duplicate capture-miss outcomes", () => {
  const first = reduceCxSimpleLoopSession(
    {
      status: "running",
      queue: [],
      current: {
        ...baseCandidate(),
        phase: "confirming",
      },
      completed: [],
      events: [],
      stats: {},
    },
    {
      type: "capture.missed",
      queueItemId: "queue-1",
      reason: "active-call-not-found",
    },
    new Date("2026-06-19T12:01:00.000Z"),
  );

  const second = reduceCxSimpleLoopSession(
    first,
    {
      type: "capture.missed",
      queueItemId: "queue-1",
      reason: "active-call-not-found",
    },
    new Date("2026-06-19T12:01:01.000Z"),
  );

  assert.equal(second.current, null);
  assert.equal(second.completed.length, 1);
  assert.equal(second.stats.captureMissed, 1);
});

test("capture miss can advance breaker state without a current candidate", () => {
  const first = reduceCxSimpleLoopSession(
    {
      status: "running",
      queue: [],
      current: null,
      completed: [],
      events: [],
      stats: {},
    },
    {
      type: "capture.missed",
      reason: "active-call-not-found",
    },
    new Date("2026-06-19T12:02:00.000Z"),
  );

  assert.equal(first.current, null);
  assert.equal(first.completed.length, 0);
  assert.equal(first.stats.captureMissed, 1);
  assert.equal(first.stats.captureMissWindow.length, 1);
});

test("bulk watch empty is neutral while waiting for CX active call", () => {
  const state = reduceCxSimpleLoopSession(
    {
      status: "running",
      queue: [
        baseCandidate({ queueItemId: "queue-1", status: "mirrored" }),
        baseCandidate({ queueItemId: "queue-2", status: "mirrored" }),
      ],
      current: null,
      completed: [],
      events: [],
      stats: {},
    },
    {
      type: "bulk.watch.empty",
      reason: "active-call-not-found",
      mirroredCount: 2,
    },
    new Date("2026-06-19T12:03:00.000Z"),
  );

  assert.equal(state.status, "running");
  assert.equal(state.current, null);
  assert.equal(state.queue.length, 2);
  assert.equal(state.completed.length, 0);
  assert.equal(state.stats.captureMissed, 0);
  assert.equal(state.stats.bulkWatchEmpty, 1);
  assert.equal(state.stats.bulkBufferCount, 2);
  assert.equal(state.lastError, null);
});

test("simple loop reducer terminal submit buffers completed call and clears current", () => {
  const state = {
    status: "running",
    queue: [],
    current: {
      ...baseCandidate(),
      phase: "active",
      uii: "202606190002",
    },
    completed: [],
    events: [],
    stats: {},
  };

  const next = reduceCxSimpleLoopSession(
    state,
    {
      type: "terminal.submitted",
      outcome: "no_answer",
      dispositionResult: { ok: true, dispositionStatus: "accepted" },
    },
    new Date("2026-06-19T12:05:00.000Z"),
  );

  assert.equal(next.current, null);
  assert.equal(next.completed.length, 1);
  assert.equal(next.completed[0].phase, "released");
  assert.equal(next.completed[0].outcome, "no_answer");
  assert.equal(next.stats.completed, 1);
});

test("simple loop reducer capture miss does not strand current", () => {
  const state = {
    status: "running",
    queue: [],
    current: {
      ...baseCandidate(),
      phase: "confirming",
    },
    completed: [],
    events: [],
    stats: {},
  };

  const next = reduceCxSimpleLoopSession(
    state,
    {
      type: "capture.missed",
      queueItemId: "queue-1",
      reason: "active-call-not-found",
    },
    new Date("2026-06-19T12:01:00.000Z"),
  );

  assert.equal(next.current, null);
  assert.equal(next.completed.length, 1);
  assert.equal(next.completed[0].outcome, "capture-missed");
  assert.equal(next.stats.captureMissed, 1);
  assert.equal(next.stats.captureMissWindow.length, 1);
});

test("bulk capture found moves candidate from queue to current and stamps active evidence", () => {
  const state = {
    status: "running",
    queue: [
      {
        ...baseCandidate({ queueItemId: "queue-2", phone: "8185553434", status: "mirrored" }),
      },
    ],
    current: null,
    completed: [],
    events: [],
    stats: {},
  };

  const next = reduceCxSimpleLoopSession(
    state,
    {
      type: "bulk.capture.found",
      candidate: state.queue[0],
      uii: "202606190999",
      matchReasons: ["externId", "campaignId"],
      activeCallSummary: { state: "connected", campaignId: "campaign-a", dialGroupId: "group-a" },
      firstPollMs: 10,
      uiiFoundMs: 20,
    },
    new Date("2026-06-19T12:06:00.000Z"),
  );

  assert.equal(next.current?.queueItemId, "queue-2");
  assert.equal(next.current?.uii, "202606190999");
  assert.equal(next.current?.phase, "active");
  assert.equal(next.current?.activeEvidenceAt, "2026-06-19T12:06:00.000Z");
  assert.equal(next.queue.length, 0);
  assert.equal(next.current?.matchReasons?.length, 2);
});

test("bulk capture found auto-completes previous current when RingCX advances", () => {
  const previous = {
    status: "running",
    queue: [
      baseCandidate({ queueItemId: "queue-2", phone: "8185553434", status: "mirrored" }),
    ],
    current: {
      ...baseCandidate({ queueItemId: "queue-1", phone: "3105551212", status: "mirrored" }),
      phase: "active",
      uii: "202606190111",
    },
    completed: [],
    events: [],
    stats: {},
  };

  const next = reduceCxSimpleLoopSession(
    previous,
    {
      type: "bulk.capture.found",
      candidate: previous.queue[0],
      uii: "202606190222",
      matchReasons: ["externId", "AGENT"],
      activeCallSummary: { state: "connected" },
    },
    new Date("2026-06-19T12:07:00.000Z"),
  );

  assert.equal(next.current?.queueItemId, "queue-2");
  assert.equal(next.current?.uii, "202606190222");
  assert.equal(next.completed.length, 1);
  assert.equal(next.completed[0].queueItemId, "queue-1");
  assert.equal(next.completed[0].outcome, "cx-auto-advanced");
  assert.equal(next.stats.completed, 1);
  assert.equal(next.stats.cxAutoAdvanced, 1);
});

test("simple loop client snapshot removes full phone numbers", () => {
  const snapshot = sanitizeSessionForClient({
    sessionId: "s1",
    status: "running",
    mode: "single",
    agentEmail: "mgray@example.com",
    queue: [baseCandidate()],
    current: baseCandidate({ queueItemId: "queue-2", phone: "8185553434" }),
    completed: [],
    events: [],
    stats: {},
  });

  assert.equal(snapshot.queue[0].phone, undefined);
  assert.equal(snapshot.queue[0].phoneLast4, "1212");
  assert.equal(snapshot.current.phone, undefined);
  assert.equal(snapshot.current.phoneLast4, "3434");
});
