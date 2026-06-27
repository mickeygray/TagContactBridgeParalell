"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  makeOutcomeIdemKey,
  buildCadenceEvent,
  createCxBulkLoadOutcomeAdapter,
} = require("../../packages/shared-services/src/cxBulkLoadOutcomeAdapter");

// In-memory durable writer: records true only the first time an idemKey is seen.
function fakeDeps() {
  const seen = new Set();
  const recorded = [];
  return {
    recorded,
    recordCadenceEvent: async (event) => {
      if (seen.has(event.idemKey)) return { written: false, reason: "duplicate" };
      seen.add(event.idemKey);
      recorded.push(event);
      return { written: true };
    },
  };
}

const SESSION = { sessionId: "s1", domain: "TAG", agentEmail: "a@x.com" };
const CANDIDATE = { queueItemId: "q1", caseId: 42, externId: "x1", uii: "u1" };
const NOW = new Date("2026-06-22T10:00:00.000Z");

// ── pure builders ───────────────────────────────────────────────────────
test("makeOutcomeIdemKey keys on queueItemId:uii when uii is present (M11 gate 3)", () => {
  assert.equal(makeOutcomeIdemKey({ sessionId: "s1", queueItemId: "q1", uii: "u1" }), "q1:u1");
  // distinct UIIs on the same queue item produce DISTINCT keys (no collapse).
  assert.notEqual(
    makeOutcomeIdemKey({ sessionId: "s1", queueItemId: "q1", uii: "u1" }),
    makeOutcomeIdemKey({ sessionId: "s1", queueItemId: "q1", uii: "u2" }),
  );
});

test("makeOutcomeIdemKey keeps UII when queueItemId is missing and separates corrections", () => {
  assert.equal(makeOutcomeIdemKey({ sessionId: "s1", uii: "u1" }), "s1:uii:u1");
  assert.notEqual(
    makeOutcomeIdemKey({ sessionId: "s1", uii: "u1" }),
    makeOutcomeIdemKey({ sessionId: "s1", uii: "u2" }),
  );
  assert.equal(makeOutcomeIdemKey({ sessionId: "s1", queueItemId: "q1", uii: "u1", eventType: "dnc" }), "q1:u1:dnc");
});

test("makeOutcomeIdemKey falls back to (sessionId, queueItemId, eventType) for a no-UII terminal", () => {
  assert.equal(makeOutcomeIdemKey({ sessionId: "s1", queueItemId: "q1", eventType: "terminal" }), "s1:q1:terminal");
  assert.equal(makeOutcomeIdemKey({ sessionId: "s1", queueItemId: "q1" }), "s1:q1:terminal");
});

test("makeOutcomeIdemKey scopes malformed no-queue fallbacks by caseId when present", () => {
  assert.equal(makeOutcomeIdemKey({ sessionId: "s1", caseId: 42, eventType: "terminal" }), "s1:case:42:terminal");
});

test("buildCadenceEvent is a narrow pure projection", () => {
  const e = buildCadenceEvent({ session: SESSION, candidate: CANDIDATE, outcome: "ANSWER", source: "disposition", at: NOW.toISOString() });
  assert.equal(e.sessionId, "s1");
  assert.equal(e.queueItemId, "q1");
  assert.equal(e.caseId, 42);
  assert.equal(e.externId, "x1");
  assert.equal(e.domain, "TAG");
  assert.equal(e.agentEmail, "a@x.com");
  assert.equal(e.uii, "u1");
  assert.equal(e.outcome, "ANSWER");
  assert.equal(e.source, "disposition");
  assert.equal(e.at, NOW.toISOString());
});

test("buildCadenceEvent falls back to nested agent email and ringcx externId", () => {
  const e = buildCadenceEvent({
    session: { sessionId: "s2", domain: "WYNN", agent: { email: "b@x.com" } },
    candidate: { _id: "mongo1", caseId: 44, ringcx: { externId: "rx1" } },
    outcome: "ANSWER",
  });
  assert.equal(e.queueItemId, "mongo1");
  assert.equal(e.externId, "rx1");
  assert.equal(e.agentEmail, "b@x.com");
});

test("buildCadenceEvent carries drain-to-coach handoff identity without AI prose", () => {
  const e = buildCadenceEvent({
    session: { ...SESSION, agentName: "Agent One" },
    candidate: {
      ...CANDIDATE,
      phone: "+15555551212",
      phoneLast4: "1212",
      durationSec: 182,
      coachSessionId: "coach-s1",
      interviewSnapshotWorkflowId: "wf1",
    },
    outcome: "answered",
    source: "active-call-release",
    at: NOW.toISOString(),
  });
  assert.equal(e.agentName, "Agent One");
  assert.equal(e.phone, "+15555551212");
  assert.equal(e.phoneLast4, "1212");
  assert.equal(e.durationSec, 182);
  assert.equal(e.coachSessionId, "coach-s1");
  assert.equal(e.interviewSnapshotWorkflowId, "wf1");
});

// ── single writer / idempotency ─────────────────────────────────────────
test("persistTerminalOutcome writes exactly once per (sessionId, queueItemId, eventType)", async () => {
  const deps = fakeDeps();
  const adapter = createCxBulkLoadOutcomeAdapter(deps);

  const first = await adapter.persistTerminalOutcome({ session: SESSION, candidate: CANDIDATE, outcome: "ANSWER", source: "disposition", now: NOW });
  assert.equal(first.written, true);
  assert.equal(first.idemKey, "q1:u1");
  assert.equal(deps.recorded.length, 1);

  // a re-fire (double-click, retry) is a no-op, not an error and not a 2nd write
  const second = await adapter.persistTerminalOutcome({ session: SESSION, candidate: CANDIDATE, outcome: "OTHER", source: "disposition", now: NOW });
  assert.equal(second.written, false);
  assert.equal(second.reason, "duplicate");
  assert.equal(deps.recorded.length, 1);
});

test("post-call correction writes do not collide with terminal outcomes", async () => {
  const deps = fakeDeps();
  const adapter = createCxBulkLoadOutcomeAdapter(deps);
  await adapter.persistTerminalOutcome({ session: SESSION, candidate: CANDIDATE, outcome: "ANSWER", source: "active-call-release", now: NOW });
  const dnc = await adapter.persistTerminalOutcome({ session: SESSION, candidate: CANDIDATE, outcome: "DNC", source: "review", eventType: "dnc", now: NOW });
  assert.equal(dnc.written, true);
  assert.equal(dnc.idemKey, "q1:u1:dnc");
  assert.equal(deps.recorded.length, 2);
});

test("persistTerminalOutcome returns written false when the durable writer returns null", async () => {
  const adapter = createCxBulkLoadOutcomeAdapter({ recordCadenceEvent: async () => null });
  const result = await adapter.persistTerminalOutcome({ session: SESSION, candidate: CANDIDATE, outcome: "ANSWER", now: NOW });
  assert.equal(result.written, false);
});

test("persistTerminalOutcome accepts ISO string timestamps", async () => {
  const deps = fakeDeps();
  const adapter = createCxBulkLoadOutcomeAdapter(deps);
  const result = await adapter.persistTerminalOutcome({
    session: SESSION,
    candidate: { queueItemId: "q3" },
    outcome: "ANSWER",
    now: "2026-06-22T10:00:00.000Z",
  });
  assert.equal(result.cadenceEvent.at, "2026-06-22T10:00:00.000Z");
});

test("the manual disposition and the auto-advance close of the SAME call collapse to one write", async () => {
  const deps = fakeDeps();
  const adapter = createCxBulkLoadOutcomeAdapter(deps);
  // both funnel through the same key (same queueItemId+uii = one call)
  await adapter.persistTerminalOutcome({ session: SESSION, candidate: CANDIDATE, outcome: "ANSWER", source: "disposition", now: NOW });
  await adapter.persistTerminalOutcome({ session: SESSION, candidate: CANDIDATE, outcome: "did_not_connect", source: "active-call-release", now: NOW });
  assert.equal(deps.recorded.length, 1);
});

test("M11 gate 3: two DISTINCT calls (different UII) on the same queue item each write once", async () => {
  const deps = fakeDeps();
  const adapter = createCxBulkLoadOutcomeAdapter(deps);
  // a re-dial of the same queue item is a genuinely distinct call — it must NOT be suppressed.
  await adapter.persistTerminalOutcome({ session: SESSION, candidate: { queueItemId: "q1", uii: "u1" }, outcome: "NO_ANSWER", now: NOW });
  await adapter.persistTerminalOutcome({ session: SESSION, candidate: { queueItemId: "q1", uii: "u2" }, outcome: "ANSWER", now: NOW });
  assert.equal(deps.recorded.length, 2);
});

test("different leads in the same session each write once", async () => {
  const deps = fakeDeps();
  const adapter = createCxBulkLoadOutcomeAdapter(deps);
  await adapter.persistTerminalOutcome({ session: SESSION, candidate: { queueItemId: "q1" }, outcome: "ANSWER", now: NOW });
  await adapter.persistTerminalOutcome({ session: SESSION, candidate: { queueItemId: "q2" }, outcome: "BUSY", now: NOW });
  assert.equal(deps.recorded.length, 2);
});

test("factory rejects missing effects", () => {
  assert.throws(() => createCxBulkLoadOutcomeAdapter({}), /requires recordCadenceEvent/);
});
