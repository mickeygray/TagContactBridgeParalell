"use strict";

// M11 gate 2 — durable terminal-outbox DRAIN (pure-core; fakes, no Mongo).
// The drain replays pending terminal rows into the cadence writer off the live loop, so a call
// recorded-but-not-yet-counted still counts on the next drain. The Mongo insert-once / unique-key
// dedup is integration-deferred (no local Mongo); this locks the drain orchestration.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createCxTerminalOutboxDrain } = require("../../packages/shared-services/src/cxTerminalOutboxDrain");

function fakeOutbox(pending = []) {
  const calls = { drained: [], failed: [] };
  return {
    calls,
    rows: pending,
    async listPendingForDrain() { return this.rows; },
    async markDrained(idemKey) { calls.drained.push(idemKey); return { idemKey, status: "drained" }; },
    async markFailed(idemKey, error) { calls.failed.push({ idemKey, error }); return { idemKey, status: "failed" }; },
  };
}

test("factory requires outboxRepository.listPendingForDrain + recordCadenceEvent", () => {
  assert.throws(() => createCxTerminalOutboxDrain({}), /listPendingForDrain/);
  assert.throws(() => createCxTerminalOutboxDrain({ outboxRepository: fakeOutbox() }), /recordCadenceEvent/);
});

test("drainOnce replays each pending payload and marks it drained", async () => {
  const outbox = fakeOutbox([
    { idemKey: "q1:u1", payload: { queueItemId: "q1", outcome: "ANSWER" } },
    { idemKey: "q2:u2", payload: { queueItemId: "q2", outcome: "did_not_connect" } },
  ]);
  const replayed = [];
  const drain = createCxTerminalOutboxDrain({ outboxRepository: outbox, recordCadenceEvent: async (e) => replayed.push(e) });
  const result = await drain.drainOnce();
  assert.deepEqual(replayed.map((e) => e.queueItemId), ["q1", "q2"]);
  assert.deepEqual(outbox.calls.drained, ["q1:u1", "q2:u2"]);
  assert.deepEqual(result, { scanned: 2, drained: 2, failed: 0 });
});

test("a replay failure marks THAT row failed and never aborts the rest of the batch", async () => {
  const outbox = fakeOutbox([
    { idemKey: "q1:u1", payload: { queueItemId: "q1" } },
    { idemKey: "q2:u2", payload: { queueItemId: "q2" } },
  ]);
  const drain = createCxTerminalOutboxDrain({
    outboxRepository: outbox,
    recordCadenceEvent: async (e) => { if (e.queueItemId === "q1") throw new Error("cadence boom"); },
    logger: { warn() {} },
  });
  const result = await drain.drainOnce();
  assert.deepEqual(outbox.calls.failed.map((f) => f.idemKey), ["q1:u1"]); // q1 failed
  assert.deepEqual(outbox.calls.drained, ["q2:u2"]); // q2 still drained
  assert.deepEqual(result, { scanned: 2, drained: 1, failed: 1 });
});

test("a scan failure returns an explicit scanError result instead of aborting the drain", async () => {
  const warns = [];
  const drain = createCxTerminalOutboxDrain({
    outboxRepository: {
      listPendingForDrain: async () => {
        throw new Error("scan boom");
      },
    },
    recordCadenceEvent: async () => assert.fail("no rows should replay after scan failure"),
    logger: { warn: (...a) => warns.push(a) },
  });
  const result = await drain.drainOnce();
  assert.deepEqual(result, { scanned: 0, drained: 0, failed: 0, scanError: true });
  assert.equal(warns.length, 1);
});

test("a pending row with no payload is marked drained (not wedged) and not replayed", async () => {
  const outbox = fakeOutbox([{ idemKey: "q3:u3", payload: null }]);
  const replayed = [];
  const drain = createCxTerminalOutboxDrain({ outboxRepository: outbox, recordCadenceEvent: async (e) => replayed.push(e) });
  const result = await drain.drainOnce();
  assert.equal(replayed.length, 0);
  assert.deepEqual(outbox.calls.drained, ["q3:u3"]);
  assert.equal(result.drained, 0); // payload-less rows don't count as a replayed drain
});

test("post-drain call wrap hook runs after terminal replay and receives terminal result", async () => {
  const outbox = fakeOutbox([
    { idemKey: "q1:u1", payload: { queueItemId: "q1", uii: "u1", outcome: "answered" } },
  ]);
  const wrapped = [];
  const drain = createCxTerminalOutboxDrain({
    outboxRepository: outbox,
    recordCadenceEvent: async (event) => ({ counted: true, queueItemId: event.queueItemId }),
    enqueueCallWrap: async (packet) => wrapped.push(packet),
  });
  const result = await drain.drainOnce();
  assert.deepEqual(outbox.calls.drained, ["q1:u1"]);
  assert.equal(wrapped.length, 1);
  assert.equal(wrapped[0].row.idemKey, "q1:u1");
  assert.equal(wrapped[0].payload.uii, "u1");
  assert.deepEqual(wrapped[0].terminalResult, { counted: true, queueItemId: "q1" });
  assert.deepEqual(result, { scanned: 1, drained: 1, failed: 0, callWrapQueued: 1, callWrapSkipped: 0, callWrapFailed: 0 });
});

test("post-drain call note hook runs independently from call wrap", async () => {
  const outbox = fakeOutbox([
    { idemKey: "q1:u1", payload: { queueItemId: "q1", uii: "u1", outcome: "answered" } },
  ]);
  const notes = [];
  const wrapped = [];
  const drain = createCxTerminalOutboxDrain({
    outboxRepository: outbox,
    recordCadenceEvent: async (event) => ({ counted: true, queueItemId: event.queueItemId }),
    writeCallNote: async (packet) => notes.push(packet),
    enqueueCallWrap: async (packet) => wrapped.push(packet),
  });
  const result = await drain.drainOnce();
  assert.deepEqual(outbox.calls.drained, ["q1:u1"]);
  assert.equal(notes.length, 1);
  assert.equal(wrapped.length, 1);
  assert.equal(notes[0].payload.uii, "u1");
  assert.deepEqual(result, {
    scanned: 1,
    drained: 1,
    failed: 0,
    callNotesWritten: 1,
    callNotesSkipped: 0,
    callNotesFailed: 0,
    callWrapQueued: 1,
    callWrapSkipped: 0,
    callWrapFailed: 0,
  });
});

test("post-drain call note failure does not fail terminal replay", async () => {
  const warns = [];
  const outbox = fakeOutbox([
    { idemKey: "q1:u1", payload: { queueItemId: "q1", uii: "u1", outcome: "answered" } },
  ]);
  const drain = createCxTerminalOutboxDrain({
    outboxRepository: outbox,
    recordCadenceEvent: async () => ({ counted: true }),
    writeCallNote: async () => { throw new Error("note db down"); },
    logger: { warn: (...args) => warns.push(args) },
  });
  const result = await drain.drainOnce();
  assert.deepEqual(outbox.calls.drained, ["q1:u1"]);
  assert.deepEqual(outbox.calls.failed, []);
  assert.equal(warns.length, 1);
  assert.deepEqual(result, {
    scanned: 1,
    drained: 1,
    failed: 0,
    callNotesWritten: 0,
    callNotesSkipped: 0,
    callNotesFailed: 1,
  });
});

test("post-drain call wrap failure does not fail the terminal row", async () => {
  const warns = [];
  const outbox = fakeOutbox([
    { idemKey: "q1:u1", payload: { queueItemId: "q1", uii: "u1", outcome: "answered" } },
  ]);
  const drain = createCxTerminalOutboxDrain({
    outboxRepository: outbox,
    recordCadenceEvent: async () => ({ counted: true }),
    enqueueCallWrap: async () => { throw new Error("coach queue down"); },
    logger: { warn: (...args) => warns.push(args) },
  });
  const result = await drain.drainOnce();
  assert.deepEqual(outbox.calls.drained, ["q1:u1"]);
  assert.deepEqual(outbox.calls.failed, []);
  assert.equal(warns.length, 1);
  assert.deepEqual(result, { scanned: 1, drained: 1, failed: 0, callWrapQueued: 0, callWrapSkipped: 0, callWrapFailed: 1 });
});

test("post-drain call wrap hook can explicitly skip rows without wrap material", async () => {
  const outbox = fakeOutbox([
    { idemKey: "q1:u1", payload: { queueItemId: "q1", uii: "u1", outcome: "did_not_connect" } },
  ]);
  const drain = createCxTerminalOutboxDrain({
    outboxRepository: outbox,
    recordCadenceEvent: async () => ({ counted: true }),
    enqueueCallWrap: async () => ({ skipped: true, reason: "no-wrap-material" }),
  });
  const result = await drain.drainOnce();
  assert.deepEqual(outbox.calls.drained, ["q1:u1"]);
  assert.deepEqual(result, { scanned: 1, drained: 1, failed: 0, callWrapQueued: 0, callWrapSkipped: 1, callWrapFailed: 0 });
});
