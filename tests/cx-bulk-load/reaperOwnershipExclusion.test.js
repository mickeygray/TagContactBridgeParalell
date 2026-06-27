"use strict";

// M2 — reaper ownership exclusion (THE deploy gate: M2 strictly before M4).
//
// The global expired-claim reaper (`requeueExpiredClaims`) must be BLIND to rows a
// reservation session holds: only the owning session (releaseReserved) or the crash
// reconciler may free a reserved row. If the reaper could requeue a reserved row, the
// bulk/slow rail and the reaper would fight over it (publish/cancel/retry churn — the
// 2026-06-17 floor incident). Appointment rows are likewise never reaper-freed.
//
// We can't run real Mongo offline (no mongodb-memory-server; the repo hard-requires the
// model). So we test the INVARIANT behaviorally: evaluate the pure query builder
// `buildExpiredClaimRequeueQuery(now)` against crafted documents with a tiny Mongo-query
// matcher. This asserts WHAT the query selects, not its literal shape — so it survives an
// equivalent refactor (Codex's tightening pass) but fails loudly if the exclusion is lost.
// The matcher THROWS on any operator it doesn't model, so a refactor to an unhandled
// operator surfaces as a test error, never a silent false pass.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  buildExpiredClaimRequeueQuery,
} = require("../../packages/shared-repositories/src/cxDialQueueRepository");

// ---- tiny Mongo-query matcher (only the operators this query uses) ----
function getPath(doc, path) {
  return path.split(".").reduce((acc, key) => (acc == null ? undefined : acc[key]), doc);
}

function matchCondition(value, condition) {
  // Primitive / Date condition => equality. Mongo `{f: null}` also matches a MISSING field.
  if (condition === null) return value === null || value === undefined;
  if (typeof condition !== "object" || condition instanceof Date) {
    if (condition instanceof Date) return value instanceof Date && value.getTime() === condition.getTime();
    return value === condition;
  }
  // Operator object.
  return Object.entries(condition).every(([op, operand]) => {
    switch (op) {
      case "$exists":
        return operand ? value !== undefined : value === undefined;
      case "$eq":
        return value === operand;
      case "$ne":
        // Mongo: $ne null means "exists and not null".
        if (operand === null) return value !== null && value !== undefined;
        return value !== operand;
      case "$lte":
        return value !== undefined && value !== null && value <= operand;
      case "$in":
        return Array.isArray(operand) && operand.includes(value);
      default:
        throw new Error(`matcher: unhandled operator ${op} — extend the matcher or the query changed shape`);
    }
  });
}

function matchesQuery(doc, query) {
  return Object.entries(query).every(([key, condition]) => {
    if (key === "$and") return condition.every((sub) => matchesQuery(doc, sub));
    if (key === "$or") return condition.some((sub) => matchesQuery(doc, sub));
    return matchCondition(getPath(doc, key), condition);
  });
}

// ---- self-tests: prove the matcher itself is trustworthy before relying on it ----
test("matcher self-test: equality, $exists, null-matches-missing, and unknown-op throws", () => {
  assert.equal(matchesQuery({ a: 1 }, { a: 1 }), true);
  assert.equal(matchesQuery({ a: 1 }, { a: 2 }), false);
  assert.equal(matchesQuery({}, { a: { $exists: false } }), true);
  assert.equal(matchesQuery({ a: 5 }, { a: { $exists: true } }), true);
  assert.equal(matchesQuery({ a: null }, { a: null }), true);
  assert.equal(matchesQuery({}, { a: null }), true); // missing matches {f:null}
  assert.equal(matchesQuery({ a: "x" }, { a: { $in: ["x", "y"] } }), true);
  assert.equal(matchesQuery({ a: 3 }, { $or: [{ a: 1 }, { a: 3 }] }), true);
  assert.throws(() => matchesQuery({ a: 1 }, { a: { $weird: 1 } }), /unhandled operator/);
});

const NOW = new Date("2026-06-23T12:00:00Z");
const PAST = new Date("2026-06-23T11:00:00Z");
const FUTURE = new Date("2026-06-23T13:00:00Z");
const query = buildExpiredClaimRequeueQuery(NOW);

// Baseline: a plain expired claimed row with clean metadata IS reaped.
const expired = { state: "claimed", claimUntil: PAST, metadata: {} };

test("baseline: a clean expired claimed row IS selected by the reaper", () => {
  assert.equal(matchesQuery(expired, query), true);
});

test("M2 GATE: a reservation-session-held row is INVISIBLE to the reaper", () => {
  const reserved = { state: "claimed", claimUntil: PAST, metadata: { reservationSessionId: "sess-1" } };
  assert.equal(matchesQuery(reserved, query), false);
});

test("FM-5: an appointment row is never reaper-freed", () => {
  const appt = { state: "claimed", claimUntil: PAST, metadata: { appointmentId: "appt-1" } };
  assert.equal(matchesQuery(appt, query), false);
});

test("a serving row (metadata.servingAt set) is not reaped", () => {
  const serving = { state: "claimed", claimUntil: PAST, metadata: { servingAt: PAST } };
  assert.equal(matchesQuery(serving, query), false);
});

test("a row mid-dial-execution (lastDialExecutionUii set) is not reaped", () => {
  const dialing = { state: "claimed", claimUntil: PAST, metadata: { lastDialExecutionUii: "uii-9" } };
  assert.equal(matchesQuery(dialing, query), false);
});

test("a row held for disposition is not reaped", () => {
  const held = { state: "claimed", claimUntil: PAST, metadata: { lastQueueAttemptHeldForDisposition: true } };
  assert.equal(matchesQuery(held, query), false);
});

test("an unexpired lease (claimUntil in the future) is not reaped", () => {
  const future = { state: "claimed", claimUntil: FUTURE, metadata: {} };
  assert.equal(matchesQuery(future, query), false);
});

test("a non-claimed row (state:'ready') is not reaped", () => {
  const ready = { state: "ready", claimUntil: PAST, metadata: {} };
  assert.equal(matchesQuery(ready, query), false);
});

test("a row whose last dial intent errored IS reapable (terminal-error path)", () => {
  const errored = { state: "claimed", claimUntil: PAST, metadata: { lastDialIntentStatus: "error" } };
  assert.equal(matchesQuery(errored, query), true);
});

test("a row mid-flight with a non-terminal dial intent is NOT reaped", () => {
  const inflight = { state: "claimed", claimUntil: PAST, metadata: { lastDialIntentStatus: "queued" } };
  assert.equal(matchesQuery(inflight, query), false);
});
