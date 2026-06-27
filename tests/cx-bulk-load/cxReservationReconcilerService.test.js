"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  createCxReservationReconcilerService,
} = require("../../packages/shared-services/src/cxReservationReconcilerService");

function row(id, sessionId, hasTerminal = false) {
  return { _id: id, metadata: { reservationSessionId: sessionId, hasTerminal } };
}

// adoptResult(id) decides the CAS outcome per id: truthy = adopted, null = a live session won it.
function build({ rows = [], adopt = (id) => ({ _id: id }) } = {}) {
  const calls = { list: [], transition: [], complete: [], release: [] };
  const repo = {
    listQueueItems: async (filters) => {
      calls.list.push(filters);
      return rows;
    },
    transitionQueueItemState: async (id, fromStates, update, options) => {
      calls.transition.push({ id, fromStates, update, options });
      return adopt(id);
    },
  };
  const cadence = { completeCxQueueItem: async (opts) => calls.complete.push(opts) };
  const reservation = { releaseReserved: async (r, reason) => calls.release.push({ rows: r, reason }) };
  const terminalEvidence = async (r) => Boolean(r?.metadata?.hasTerminal);
  const svc = createCxReservationReconcilerService({
    cxDialQueueRepository: repo,
    cxCadenceService: cadence,
    cxQueueReservationService: reservation,
    terminalEvidence,
  });
  return { svc, calls };
}

test("factory guards required deps", () => {
  assert.throws(() => createCxReservationReconcilerService({ terminalEvidence: () => false }), /listQueueItems/);
  assert.throws(
    () => createCxReservationReconcilerService({ cxDialQueueRepository: { listQueueItems: () => [] } }),
    /terminalEvidence/,
  );
});

test("queries only stale claimed rows (states:[claimed] + metadataReservationSessionIdNotIn + unbounded)", async () => {
  const { svc, calls } = build({ rows: [] });
  await svc.reconcileDanglingReservations({ activeSessionIds: ["live-1", "live-2"] });
  assert.deepEqual(calls.list[0].states, ["claimed"]);
  assert.deepEqual(calls.list[0].metadataReservationSessionIdNotIn, ["live-1", "live-2"]);
  assert.equal(calls.list[0].limit, "all");
});

test("row WITH terminal evidence is adopted then FORCE-completed (not released)", async () => {
  const { svc, calls } = build({ rows: [row("a", "dead-1", true)] });
  const result = await svc.reconcileDanglingReservations({ activeSessionIds: [] });
  // adopt CAS first, guarded by the row's reservationSessionId
  assert.equal(calls.transition[0].id, "a");
  assert.deepEqual(calls.transition[0].options.match, { "metadata.reservationSessionId": "dead-1" });
  // then force-complete via completeCxQueueItem
  assert.equal(calls.complete.length, 1);
  assert.equal(calls.complete[0].queueItemId, "a");
  assert.equal(calls.release.length, 0);
  assert.deepEqual({ completed: result.completed, released: result.released, adopted: result.adopted }, {
    completed: 1,
    released: 0,
    adopted: 1,
  });
});

test("row WITHOUT terminal evidence is adopted then released back to ready", async () => {
  const { svc, calls } = build({ rows: [row("b", "dead-2", false)] });
  const result = await svc.reconcileDanglingReservations({ activeSessionIds: [] });
  assert.equal(calls.release.length, 1);
  assert.equal(calls.release[0].rows[0]._id, "b");
  assert.equal(calls.complete.length, 0);
  assert.equal(result.released, 1);
});

test("terminal evidence errors release the adopted row instead of stranding it claimed", async () => {
  const warns = [];
  const calls = { release: [] };
  const repo = {
    listQueueItems: async () => [row("e", "dead-3", true)],
    transitionQueueItemState: async (id) => ({ _id: id }),
  };
  const cadence = { completeCxQueueItem: async () => assert.fail("should not complete after evidence error") };
  const reservation = { releaseReserved: async (r, reason) => calls.release.push({ rows: r, reason }) };
  const svc = createCxReservationReconcilerService({
    cxDialQueueRepository: repo,
    cxCadenceService: cadence,
    cxQueueReservationService: reservation,
    terminalEvidence: async () => {
      throw new Error("evidence boom");
    },
    logger: { warn: (...a) => warns.push(a) },
  });
  const result = await svc.reconcileDanglingReservations({ activeSessionIds: [] });
  assert.equal(warns.length, 1);
  assert.equal(calls.release.length, 1);
  assert.equal(calls.release[0].rows[0]._id, "e");
  assert.equal(calls.release[0].reason, "reservation-reconciler:evidence-error");
  assert.equal(result.released, 1);
});

test("a row a live session re-adopts first (CAS returns null) is left untouched", async () => {
  const { svc, calls } = build({ rows: [row("c", "restarted", true)], adopt: () => null });
  const result = await svc.reconcileDanglingReservations({ activeSessionIds: [] });
  assert.equal(calls.complete.length, 0);
  assert.equal(calls.release.length, 0);
  assert.equal(result.adopted, 0);
  assert.equal(result.skipped, 1);
});

test("a row with no reservationSessionId is skipped without a CAS", async () => {
  const { svc, calls } = build({ rows: [{ _id: "d", metadata: {} }] });
  const result = await svc.reconcileDanglingReservations({ activeSessionIds: [] });
  assert.equal(calls.transition.length, 0);
  assert.equal(result.skipped, 1);
});

test("a failing row is logged and does not abort the rest of the sweep", async () => {
  const warns = [];
  const calls = { complete: [] };
  const repo = {
    listQueueItems: async () => [row("x", "s1", true), row("y", "s2", false)],
    transitionQueueItemState: async (id) => ({ _id: id }),
  };
  const cadence = {
    completeCxQueueItem: async () => {
      throw new Error("complete boom");
    },
  };
  const reservation = { releaseReserved: async (r) => calls.complete.push(r) };
  const svc = createCxReservationReconcilerService({
    cxDialQueueRepository: repo,
    cxCadenceService: cadence,
    cxQueueReservationService: reservation,
    terminalEvidence: async (r) => Boolean(r.metadata.hasTerminal),
    logger: { warn: (...a) => warns.push(a) },
  });
  const result = await svc.reconcileDanglingReservations({ activeSessionIds: [] });
  assert.equal(warns.length, 1); // 'x' threw, logged
  assert.equal(result.released, 1); // 'y' still processed
});
