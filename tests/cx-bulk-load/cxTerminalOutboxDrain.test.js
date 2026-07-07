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
  assert.deepEqual(result, { scanned: 2, drained: 2, failed: 0, minimalResolved: 0, oldestPendingAgeMs: 0 });
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
  assert.deepEqual(result, { scanned: 2, drained: 1, failed: 1, minimalResolved: 0, oldestPendingAgeMs: 0 });
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
  assert.deepEqual(result, { scanned: 0, drained: 0, failed: 0, minimalResolved: 0, oldestPendingAgeMs: 0, scanError: true });
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
  assert.deepEqual(result, { scanned: 1, drained: 1, failed: 0, minimalResolved: 0, oldestPendingAgeMs: 0, callWrapQueued: 1, callWrapSkipped: 0, callWrapFailed: 0 });
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
    minimalResolved: 0,
    oldestPendingAgeMs: 0,
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
    minimalResolved: 0,
    oldestPendingAgeMs: 0,
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
  assert.deepEqual(result, { scanned: 1, drained: 1, failed: 0, minimalResolved: 0, oldestPendingAgeMs: 0, callWrapQueued: 0, callWrapSkipped: 0, callWrapFailed: 1 });
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
  assert.deepEqual(result, { scanned: 1, drained: 1, failed: 0, minimalResolved: 0, oldestPendingAgeMs: 0, callWrapQueued: 0, callWrapSkipped: 1, callWrapFailed: 0 });
});

// ---- 2026-07-06 drain hardening pins (dead-letter, CAS, stuck-ness metric) ----

test("MINIMAL RESOLUTION: past the attempt threshold the drain stamps the bare outcome and clears the row", async () => {
  // Mickey's ruling (2026-07-06 late): don't try 24 times on something that's never going
  // to work — resolve the lead with the bare minimum (the outcome string tied back to the
  // row) and drain it. The full effect chain must NOT be re-attempted.
  const resolved = [];
  const outbox = fakeOutbox([
    { idemKey: "poison-1", attempts: 3, lastError: "still-broken", payload: { queueItemId: "q-poison", outcome: "did_not_connect" }, createdAt: new Date(Date.now() - 60_000) },
    { idemKey: "ok-1", payload: { queueItemId: "q-ok", outcome: "answered" }, createdAt: new Date() },
  ]);
  let replays = 0;
  const drain = createCxTerminalOutboxDrain({
    outboxRepository: outbox,
    recordCadenceEvent: async () => { replays += 1; return { ok: true }; },
    resolveMinimal: async ({ payload }) => { resolved.push(payload.queueItemId); return { ok: true, minimal: true }; },
    logger: { warn() {}, error() {} },
  });
  const result = await drain.drainOnce({ limit: 10 });
  assert.equal(result.minimalResolved, 1);
  assert.equal(result.drained, 1, "the healthy row still drains normally");
  assert.equal(replays, 1, "the poison row's effect chain must NOT be replayed again");
  assert.deepEqual(resolved, ["q-poison"], "the bare-minimum stamp goes back to the lead");
  assert.ok(outbox.calls.drained.includes("poison-1"), "the poison row leaves the queue");
});

test("MALFORMED: a row with no queue-item identity drains immediately — no retries, no writes", async () => {
  // Mickey: "if there is no button press ie a malformed lead do nothing and just drain it."
  const resolved = [];
  const outbox = fakeOutbox([
    { idemKey: "junk-1", payload: { outcome: "answered" }, createdAt: new Date() }, // no queueItemId
  ]);
  let replays = 0;
  const drain = createCxTerminalOutboxDrain({
    outboxRepository: outbox,
    recordCadenceEvent: async () => { replays += 1; return { ok: true }; },
    resolveMinimal: async ({ payload }) => { resolved.push(payload); return { ok: true }; },
    logger: { warn() {}, error() {} },
  });
  const result = await drain.drainOnce({ limit: 10 });
  assert.equal(replays, 0, "nothing to tie back — never replayed");
  assert.deepEqual(resolved, [], "no minimal write either — do nothing and drain it");
  assert.ok(outbox.calls.drained.includes("junk-1"));
  assert.equal(result.failed, 0);
});

test("a markDrained CAS miss (concurrent drain) is absorbed and logged, never thrown", async () => {
  const outbox = fakeOutbox([{ idemKey: "raced-1", payload: { queueItemId: "q-raced", outcome: "answered" }, createdAt: new Date() }]);
  outbox.markDrained = async (idemKey) => {
    outbox.calls.drained.push(idemKey);
    return null; // another drainer already marked it
  };
  const drain = createCxTerminalOutboxDrain({
    outboxRepository: outbox,
    recordCadenceEvent: async () => ({ ok: true }),
    logger: { warn() {}, error() {} },
  });
  const result = await drain.drainOnce({ limit: 10 });
  assert.equal(result.drained, 1, "the effects ran; the row still counts as drained this tick");
  assert.equal(result.failed, 0);
});

test("oldestPendingAgeMs reports the stuck-ness of the scan set", async () => {
  const outbox = fakeOutbox([
    { idemKey: "old-1", payload: { outcome: "answered" }, createdAt: new Date(Date.now() - 120_000) },
  ]);
  const drain = createCxTerminalOutboxDrain({
    outboxRepository: outbox,
    recordCadenceEvent: async () => ({ ok: true }),
    logger: { warn() {}, error() {} },
  });
  const result = await drain.drainOnce({ limit: 10 });
  assert.ok(result.oldestPendingAgeMs >= 110_000, "the oldest row's age must surface as the health metric");
});
