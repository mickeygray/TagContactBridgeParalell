"use strict";

// RESYNC pins (2026-07-06 ghost-lead incident): a buffered candidate whose queue row
// drifted (cancelled out-of-band / reaped to ready / foreign reservation) wedges the
// session — the serving CAS refuses it forever and nothing signals. The resync audit
// mirrors the CAS precondition, prunes the session's buffer view (never queue rows),
// and stamps a resync annotation. Triggers: serving-stamp miss (drift proven) and the
// idle-drift sweep (drift rotting quietly, post ghost-guard fix).

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  deriveBufferInvalidations,
  runCxAccountActiveCallWatchOnce,
} = require("../../packages/shared-services/src/cxAccountActiveCallWatcherService");
const { reduceCxBulkLoadState } = require("../../packages/shared-services/src/cxBulkLoadStateMachine");

function candidate(queueItemId, externId) {
  return {
    queueItemId,
    caseId: Number(queueItemId.replace(/\D/g, "")) || 1,
    domain: "TAG",
    name: `Lead ${queueItemId}`,
    externId,
    ringcx: { externId },
  };
}

function row(queueItemId, state, reservationSessionId) {
  return {
    _id: queueItemId,
    state,
    metadata: { reservationSessionId },
  };
}

test("deriveBufferInvalidations mirrors the serving CAS: cancelled/reaped/foreign/missing pruned, claimed+owned kept", () => {
  const session = {
    sessionId: "cxbl-resync-1",
    acceptedBuffer: [
      candidate("qi-healthy", "e-healthy"),
      candidate("qi-cancelled", "e-cancelled"),   // the Codex one-off shape
      candidate("qi-reaped", "e-reaped"),         // the long-call-hold-reaper shape
      candidate("qi-foreign", "e-foreign"),
      candidate("qi-gone", "e-gone"),
    ],
  };
  const invalid = deriveBufferInvalidations(session, [
    row("qi-healthy", "claimed", "cxbl-resync-1"),
    row("qi-cancelled", "cancelled", "cxbl-resync-1"),
    row("qi-reaped", "ready", "cxbl-resync-1"),
    row("qi-foreign", "claimed", "cxbl-SOMEONE-ELSE"),
    // qi-gone: no row at all
  ]);
  const byId = Object.fromEntries(invalid.map((entry) => [entry.queueItemId, entry.why]));
  assert.equal(invalid.length, 4);
  assert.equal(byId["qi-cancelled"], "row-cancelled");
  assert.equal(byId["qi-reaped"], "row-state-unadoptable");
  assert.equal(byId["qi-foreign"], "reservation-foreign");
  assert.equal(byId["qi-gone"], "row-missing");
  assert.equal(byId["qi-healthy"], undefined, "a claimed row owned by this session must never be flagged");
});

test("reducer buffer.invalidated prunes the buffer, stamps resync, and records NO outcome", () => {
  const state = {
    sessionId: "cxbl-resync-2",
    status: "running",
    acceptedBuffer: [candidate("qi-a", "e-a"), candidate("qi-b", "e-b")],
    completed: [],
    current: null,
  };
  const next = reduceCxBulkLoadState(state, {
    type: "buffer.invalidated",
    reason: "serving-stamp-miss",
    removed: [{ queueItemId: "qi-a", rowState: "cancelled", why: "row-cancelled" }],
  }, new Date("2026-07-06T16:00:00.000Z"));
  assert.deepEqual(next.acceptedBuffer.map((c) => c.queueItemId), ["qi-b"]);
  assert.equal(next.completed.length, 0, "pruning must not invent an outcome for a lead never worked");
  assert.equal(next.current, null);
  assert.equal(next.resync.reason, "serving-stamp-miss");
  assert.equal(next.resync.removed[0].queueItemId, "qi-a");
  assert.equal(next.resync.removed[0].why, "row-cancelled");
});

function makeResyncHarness({ sessionId, activeCalls, rowsById, servingResult }) {
  const sessionDoc = {
    sessionId,
    __v: 7,
    status: "running",
    phase: "ready",
    agentEmail: `${sessionId}@example.test`,
    agentExtensionId: sessionId,
    domain: "TAG",
    ringcx: { accountId: "acct-1" },
    current: null,
    acceptedBuffer: [candidate("qi-dead", `cxbl-${sessionId}-qi-dead`)],
    completed: [],
    stats: {},
    trace: {},
  };
  const updates = [];
  const sessionRepository = {
    async listActiveBulkLoadSessions() { return [sessionDoc]; },
    async updateBulkLoadSession(id, patch, options) {
      updates.push({ id, patch, options });
      return { ...patch, sessionId: id };
    },
  };
  const client = { async listActiveCalls() { return activeCalls; } };
  const queueStateAdapter = {
    async markCandidateServing() { return servingResult; },
    async loadCandidateRows(ids) { return ids.map((id) => rowsById[id]).filter(Boolean); },
  };
  return { sessionRepository, client, queueStateAdapter, updates, sessionDoc };
}

test("Trigger A: a serving-stamp miss on a cancelled row prunes it from the buffer (the incident cure)", async () => {
  const sessionId = "cxbl-resync-A";
  const harness = makeResyncHarness({
    sessionId,
    // the ghost call: RingCX dials the cancelled row's extern
    activeCalls: [{ externId: `cxbl-${sessionId}-qi-dead`, uii: "u-ghost", callState: "OUTDIAL" }],
    rowsById: { "qi-dead": row("qi-dead", "cancelled", sessionId) },
    servingResult: null, // the CAS refuses — exactly the incident
  });
  const result = await runCxAccountActiveCallWatchOnce({
    sessionRepository: harness.sessionRepository,
    client: harness.client,
    queueStateAdapter: harness.queueStateAdapter,
    now: new Date("2026-07-06T16:10:00.000Z"),
  });
  assert.ok(
    result.applied.skipped.some((s) => s.reason === "serving-ownership-stamp-miss"),
    "the adoption itself must still be refused",
  );
  const resyncWrite = harness.updates.find((u) => u.patch.resync);
  assert.ok(resyncWrite, "the miss must trigger a resync write");
  assert.deepEqual(resyncWrite.patch.acceptedBuffer, [], "the dead candidate must leave the buffer");
  assert.equal(resyncWrite.patch.resync.removed[0].why, "row-cancelled");
  assert.equal(resyncWrite.options.expectedVersion, 7, "the resync write must be version-guarded");
});

test("Trigger B: an idle session holding a reaped (ready) batch gets swept without any call activity", async () => {
  const sessionId = "cxbl-resync-B";
  const harness = makeResyncHarness({
    sessionId,
    activeCalls: [], // nothing dialing — the quiet-drift shape
    rowsById: { "qi-dead": row("qi-dead", "ready", sessionId) },
    servingResult: { ok: true }, // never reached
  });
  const result = await runCxAccountActiveCallWatchOnce({
    sessionRepository: harness.sessionRepository,
    client: harness.client,
    queueStateAdapter: harness.queueStateAdapter,
    now: new Date("2026-07-06T16:20:00.000Z"),
  });
  assert.equal(result.applied.writeCount, 0, "no projection write — the session looked idle");
  const resyncWrite = harness.updates.find((u) => u.patch.resync);
  assert.ok(resyncWrite, "the idle sweep must find the dead buffer");
  assert.deepEqual(resyncWrite.patch.acceptedBuffer, []);
  assert.equal(resyncWrite.patch.resync.removed[0].why, "row-state-unadoptable");
  assert.equal(resyncWrite.patch.resync.reason, "idle-drift-sweep");
});

test("a failed row read prunes NOTHING — a Mongo blip must never look like a deleted row", async () => {
  // Adversarial-verify blocker (2026-07-06): loadCandidateRows used to swallow per-id
  // errors, so a transient read failure produced a partial array and healthy leads got
  // pruned as row-missing. The contract: any read failure rejects the whole batch and
  // the trigger does nothing.
  const sessionId = "cxbl-resync-readfail";
  const harness = makeResyncHarness({
    sessionId,
    activeCalls: [{ externId: `cxbl-${sessionId}-qi-dead`, uii: "u-ghost", callState: "OUTDIAL" }],
    rowsById: {},
    servingResult: null,
  });
  harness.queueStateAdapter.loadCandidateRows = async () => {
    throw new Error("mongo-transient-timeout");
  };
  const result = await runCxAccountActiveCallWatchOnce({
    sessionRepository: harness.sessionRepository,
    client: harness.client,
    queueStateAdapter: harness.queueStateAdapter,
    now: new Date("2026-07-06T16:40:00.000Z"),
  });
  assert.ok(result.applied.skipped.some((s) => s.reason === "serving-ownership-stamp-miss"));
  assert.equal(harness.updates.filter((u) => u.patch.resync).length, 0, "no prune on a failed read");
});

test("kill switch: resyncEnabled=false leaves the buffer alone even on a serving miss", async () => {
  const sessionId = "cxbl-resync-off";
  const harness = makeResyncHarness({
    sessionId,
    activeCalls: [{ externId: `cxbl-${sessionId}-qi-dead`, uii: "u-ghost", callState: "OUTDIAL" }],
    rowsById: { "qi-dead": row("qi-dead", "cancelled", sessionId) },
    servingResult: null,
  });
  await runCxAccountActiveCallWatchOnce({
    sessionRepository: harness.sessionRepository,
    client: harness.client,
    queueStateAdapter: harness.queueStateAdapter,
    resyncEnabled: false,
    now: new Date("2026-07-06T16:30:00.000Z"),
  });
  assert.equal(harness.updates.filter((u) => u.patch.resync).length, 0);
});
