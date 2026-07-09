"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  makeOutcomeIdemKey,
  buildTerminalEvidenceKeys,
  buildReviewCorrectionRow,
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
const CANDIDATE = {
  queueItemId: "q1",
  caseId: 42,
  externId: "x1",
  uii: "u1",
  name: "Test Prospect",
  sourceName: "Mickey local bulk test",
};
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
  assert.equal(e.name, "Test Prospect");
  assert.equal(e.externId, "x1");
  assert.equal(e.domain, "TAG");
  assert.equal(e.agentEmail, "a@x.com");
  assert.equal(e.uii, "u1");
  assert.equal(e.sourceName, "Mickey local bulk test");
  assert.equal(e.outcome, "ANSWER");
  assert.equal(e.source, "disposition");
  assert.equal(e.at, NOW.toISOString());
});

test("buildCadenceEvent carries display-name aliases into terminal payloads", () => {
  const e = buildCadenceEvent({
    session: SESSION,
    candidate: {
      queueItemId: "q-alias",
      caseId: 43,
      prospectName: "Alias Prospect",
      payloadSnapshot: { sourceName: "Snapshot Source" },
    },
    outcome: "answered",
  });
  assert.equal(e.name, "Alias Prospect");
  assert.equal(e.sourceName, "Snapshot Source");
});

test("buildCadenceEvent carries bad-number flags for the drain side effects", () => {
  const e = buildCadenceEvent({
    session: SESSION,
    candidate: CANDIDATE,
    outcome: "bad_number",
    badNumber: true,
    badNumberReason: "disconnected-or-out-of-service",
  });
  assert.equal(e.outcome, "bad_number");
  assert.equal(e.badNumber, true);
  assert.equal(e.badNumberReason, "disconnected-or-out-of-service");
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

// ── #12: buildTerminalEvidenceKeys (read-side) reproduces every writer idemKey shape ──
test("#12 buildTerminalEvidenceKeys matches the no-UII terminal key a skip/manual-reset writes", () => {
  // The writer keys a no-UII terminal (skip / kill-manual-reset on a current with no live call) as
  // `${sessionId}:${queueItemId}:terminal`. The reconciler sees the queue row carrying the
  // reservationSessionId — the evidence set MUST include that exact key or the lead gets re-dialed.
  const written = makeOutcomeIdemKey({ sessionId: "S1", queueItemId: "Q1", uii: null, eventType: "terminal" });
  assert.equal(written, "S1:Q1:terminal");
  const row = { _id: "Q1", metadata: { reservationSessionId: "S1" } }; // no uii anywhere
  assert.ok(buildTerminalEvidenceKeys(row).includes(written), "no-UII terminal key must be reproduced");
});

test("#12 buildTerminalEvidenceKeys matches the no-qid UII key shape (no _id on the row)", () => {
  // The writer's no-qid-with-UII shape is `${sessionId}:uii:${uii}`. A row whose only call identity
  // is metadata.lastQueueAttemptUii (and which has no _id) must still match — the old early-return
  // on a missing queueItemId returned [] and missed it.
  const written = makeOutcomeIdemKey({ sessionId: "S1", queueItemId: null, uii: "U9", eventType: "terminal" });
  assert.equal(written, "S1:uii:U9");
  const row = { metadata: { reservationSessionId: "S1", lastQueueAttemptUii: "U9" } };
  assert.ok(buildTerminalEvidenceKeys(row).includes(written), "no-qid UII key must be reproduced");
});

test("#12 buildTerminalEvidenceKeys reproduces the UII-bearing key and the no-UII fallback together", () => {
  const row = { _id: "Q1", uii: "U1", caseId: 42, metadata: { reservationSessionId: "S1" } };
  const keys = buildTerminalEvidenceKeys(row);
  assert.ok(keys.includes(makeOutcomeIdemKey({ sessionId: "S1", queueItemId: "Q1", uii: "U1" })), "Q1:U1");
  assert.ok(keys.includes(makeOutcomeIdemKey({ sessionId: "S1", queueItemId: "Q1", uii: null })), "no-UII fallback");
});

test("#12 buildTerminalEvidenceKeys never emits a degenerate session-only key", () => {
  // No queueItemId, no caseId, no UII, no session -> there is nothing specific to prove terminal
  // evidence, so the set is empty (returning a broad key would force-complete an unrelated lead).
  assert.deepEqual(buildTerminalEvidenceKeys({}), []);
  assert.deepEqual(buildTerminalEvidenceKeys({ metadata: { reservationSessionId: "S1" } }), []);
});

// ── #4: buildReviewCorrectionRow (rectification lane — a NEW row, not a terminal-row mutation) ──
test("#4 buildReviewCorrectionRow keys the DNC correction DISTINCTLY from the original terminal row", () => {
  const terminalKey = makeOutcomeIdemKey({ sessionId: "S1", queueItemId: "Q1", uii: "U1", eventType: "terminal" });
  const row = buildReviewCorrectionRow({ sessionId: "S1", queueItemId: "Q1", uii: "U1", at: "2026-06-29T00:00:00.000Z" });
  assert.equal(row.idemKey, "Q1:U1:review-dnc");
  assert.notEqual(row.idemKey, terminalKey, "must not collide with the terminal row's idemKey");
  assert.equal(row.outcome, "dnc");
  assert.equal(row.payload.outcome, "dnc");
  assert.equal(row.rail, "bulk_load");
});

test("#4 buildReviewCorrectionRow copies case context from the original terminal row and flips outcome to dnc", () => {
  const original = {
    domain: "TAG",
    caseId: 4242,
    externId: "cxbl-tag-q1",
    agentEmail: "sean@x.com",
    payload: { queueItemId: "Q1", uii: "U1", domain: "TAG", caseId: 4242, externId: "cxbl-tag-q1", outcome: "did_not_connect", agentEmail: "sean@x.com", at: "2026-06-29T00:00:00.000Z" },
  };
  const row = buildReviewCorrectionRow({ sessionId: "S1", queueItemId: "Q1", uii: "U1", original, at: "2026-06-29T01:00:00.000Z" });
  assert.equal(row.caseId, 4242, "caseId carried so the drain routes the DNC to Logics");
  assert.equal(row.domain, "TAG");
  assert.equal(row.payload.outcome, "dnc", "the replayed payload outcome is dnc, not the stale did_not_connect");
  assert.equal(row.payload.caseId, 4242);
  assert.equal(row.payload.reviewSource, "agent-auto-review");
  assert.equal(row.source, "agent-auto-review");
});

test("#4 buildReviewCorrectionRow falls back to a minimal payload when no original row exists", () => {
  const row = buildReviewCorrectionRow({
    sessionId: "S1", queueItemId: "Q1", uii: "U1", domain: "WYNN", caseId: 77, agentEmail: "a@x.com",
    at: "2026-06-29T00:00:00.000Z",
  });
  assert.equal(row.idemKey, "Q1:U1:review-dnc");
  assert.equal(row.domain, "WYNN");
  assert.equal(row.caseId, 77);
  assert.equal(row.payload.outcome, "dnc");
  assert.equal(row.payload.agentEmail, "a@x.com");
});
