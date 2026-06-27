"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  reduceCxBulkLoadState,
  CX_BULK_LOAD_PHASES,
} = require("../../packages/shared-services/src/cxBulkLoadStateMachine");

// Fixed clock so transitions are deterministic and need zero mocks.
const NOW = new Date("2026-06-22T10:00:00.000Z");
const reduce = (prev, event, now = NOW) => reduceCxBulkLoadState(prev, event, now);

function started() {
  return reduce({}, { type: "session.started" });
}
function accepted(state, queueItemId, extra = {}) {
  return reduce(state, {
    type: "buffer.publish_accepted",
    candidate: { queueItemId, ...extra },
    externId: `x-${queueItemId}`,
  });
}
function matched(state, queueItemId, opts = {}) {
  return reduce(state, {
    type: "current.matched",
    candidate: { queueItemId },
    uii: opts.uii || `u-${queueItemId}`,
    completePrevious: opts.completePrevious,
    previousOutcome: opts.previousOutcome,
  });
}

// ── start / preload ─────────────────────────────────────────────────────
test("session.started initializes a running IDLE session", () => {
  const s = started();
  assert.equal(s.status, "running");
  assert.equal(s.phase, CX_BULK_LOAD_PHASES.IDLE);
  assert.equal(s.startedAt, NOW.toISOString());
  assert.equal(s.current, null);
  assert.deepEqual(s.acceptedBuffer, []);
});

// ── buffer ──────────────────────────────────────────────────────────────
test("buffer.publish_accepted fills the buffer (READY) and upserts by queueItemId", () => {
  let s = started();
  s = accepted(s, "q1");
  s = accepted(s, "q2");
  assert.equal(s.acceptedBuffer.length, 2);
  assert.equal(s.phase, CX_BULK_LOAD_PHASES.READY);
  assert.equal(s.acceptedBuffer[0].ringcx.externId, "x-q1");
  // re-accept q1 -> upsert, not duplicate
  s = accepted(s, "q1", { name: "updated" });
  assert.equal(s.acceptedBuffer.length, 2);
  assert.equal(s.acceptedBuffer.find((c) => c.queueItemId === "q1").name, "updated");
});

// ── match (current) ─────────────────────────────────────────────────────
test("current.matched promotes a candidate and removes it from the buffer", () => {
  let s = started();
  s = accepted(s, "q1");
  s = accepted(s, "q2");
  s = matched(s, "q1");
  assert.equal(s.current.queueItemId, "q1");
  assert.equal(s.current.uii, "u-q1");
  assert.equal(s.phase, CX_BULK_LOAD_PHASES.ACTIVE);
  assert.equal(s.acceptedBuffer.length, 1);
  assert.equal(s.acceptedBuffer[0].queueItemId, "q2");
});

test("current.matched with completePrevious auto-completes the prior current once", () => {
  let s = started();
  s = accepted(s, "q1");
  s = accepted(s, "q2");
  s = matched(s, "q1");
  s = matched(s, "q2", { completePrevious: true, previousOutcome: "did_not_connect" });
  assert.equal(s.current.queueItemId, "q2");
  assert.equal(s.completed.length, 1);
  assert.equal(s.completed[0].queueItemId, "q1");
  assert.equal(s.completed[0].outcome, "did_not_connect");
});

// ── terminal ────────────────────────────────────────────────────────────
test("terminal.started -> RELEASING; terminal.accepted completes and clears current", () => {
  let s = started();
  s = accepted(s, "q1");
  s = matched(s, "q1");
  s = reduce(s, { type: "terminal.started", outcome: "ANSWER" });
  assert.equal(s.phase, CX_BULK_LOAD_PHASES.RELEASING);
  assert.equal(s.current.phase, CX_BULK_LOAD_PHASES.RELEASING);
  s = reduce(s, { type: "terminal.accepted", outcome: "ANSWER" });
  assert.equal(s.current, null);
  assert.equal(s.completed.length, 1);
  assert.equal(s.completed[0].queueItemId, "q1");
  assert.equal(s.phase, CX_BULK_LOAD_PHASES.RELEASED); // buffer empty
});

test("terminal.accepted is idempotent by (queueItemId, outcome)", () => {
  let s = started();
  s = accepted(s, "q1");
  s = matched(s, "q1");
  s = reduce(s, { type: "terminal.accepted", outcome: "ANSWER" });
  assert.equal(s.completed.length, 1);
  // repeat the same candidate + outcome -> no duplicate
  s = reduce(s, { type: "terminal.accepted", candidate: { queueItemId: "q1" }, outcome: "ANSWER" });
  assert.equal(s.completed.length, 1);
});

test("terminal.accepted returns to READY when the buffer still has candidates", () => {
  let s = started();
  s = accepted(s, "q1");
  s = accepted(s, "q2");
  s = matched(s, "q1");
  s = reduce(s, {
    type: "terminal.accepted",
    outcome: "ANSWER",
    reviewHoldUntil: "2026-06-22T10:00:03.000Z",
    reviewHoldReason: "manual-disposition",
  });
  assert.equal(s.phase, CX_BULK_LOAD_PHASES.READY);
  assert.equal(s.acceptedBuffer.length, 1);
  assert.equal(s.reviewHoldUntil, "2026-06-22T10:00:03.000Z");
  assert.equal(s.reviewHoldReason, "manual-disposition");
  s = matched(s, "q2");
  assert.equal(s.reviewHoldUntil, null);
  assert.equal(s.reviewHoldReason, null);
});

test("current.released completes and clears the active current without touching the buffer", () => {
  let s = started();
  s = accepted(s, "q1");
  s = accepted(s, "q2");
  s = matched(s, "q1");
  s = reduce(s, {
    type: "current.released",
    outcome: "did_not_connect",
    reason: "ringcx-current-released",
    reviewHoldUntil: "2026-06-22T10:00:03.000Z",
  });
  assert.equal(s.current, null);
  assert.equal(s.completed.length, 1);
  assert.equal(s.completed[0].queueItemId, "q1");
  assert.equal(s.completed[0].outcome, "did_not_connect");
  assert.equal(s.completed[0].releaseReason, "ringcx-current-released");
  assert.equal(s.reviewHoldUntil, "2026-06-22T10:00:03.000Z");
  assert.equal(s.reviewHoldReason, "ringcx-current-released");
  assert.equal(s.acceptedBuffer.length, 1);
  assert.equal(s.acceptedBuffer[0].queueItemId, "q2");
  assert.equal(s.phase, CX_BULK_LOAD_PHASES.READY);
});

// ── kill / robustness ───────────────────────────────────────────────────
test("session.killed clears current and marks the session killed", () => {
  let s = started();
  s = accepted(s, "q1");
  s = accepted(s, "q2");
  s = matched(s, "q1");
  s = reduce(s, { type: "session.killed", reason: "manual" });
  assert.equal(s.status, "killed");
  assert.equal(s.current, null);
  assert.equal(s.acceptedBuffer.length, 0);
  assert.equal(s.phase, CX_BULK_LOAD_PHASES.RELEASED);
  assert.equal(s.lastError, "manual");
});

test("now is injectable (stamps updatedAt); unknown events pass through with trace", () => {
  const s = reduce({ status: "running", phase: "ready" }, { type: "nope" });
  assert.equal(s.updatedAt, NOW.toISOString());
  assert.equal(s.phase, "ready"); // unchanged by unknown event
  assert.equal(s.trace.lastEvent, "nope");
});
