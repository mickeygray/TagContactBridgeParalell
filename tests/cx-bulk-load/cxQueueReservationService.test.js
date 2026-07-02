"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  createCxQueueReservationService,
} = require("../../packages/shared-services/src/cxQueueReservationService");

// Fake repo: records every call, returns whatever the test seeds. No Mongo.
function fakeRepo({ reserveResult = { reserved: [], missing: {} }, reserveImpl = null, transitionThrows = false, renewReturns = null } = {}) {
  const calls = { reserve: [], transition: [], renew: [] };
  return {
    calls,
    reserveReadyRows: async (domain, familyTargets, options) => {
      calls.reserve.push({ domain, familyTargets, options });
      if (typeof reserveImpl === "function") return reserveImpl(domain, familyTargets, options);
      return reserveResult;
    },
    transitionQueueItemState: async (id, fromStates, update, options) => {
      calls.transition.push({ id, fromStates, update, options });
      if (transitionThrows) throw new Error("transition boom");
      return { _id: id };
    },
  };
}

function reservedRowsForTargets(familyTargets = {}) {
  const reserved = [];
  for (const [family, count] of Object.entries(familyTargets)) {
    for (let index = 0; index < Number(count || 0); index += 1) {
      reserved.push({ _id: `${family}-${index + 1}`, queueFamily: family });
    }
  }
  return { reserved, missing: {} };
}

test("factory requires cxDialQueueRepository.reserveReadyRows", () => {
  assert.throws(() => createCxQueueReservationService({}), /reserveReadyRows/);
  assert.throws(() => createCxQueueReservationService({ cxDialQueueRepository: {} }), /reserveReadyRows/);
});

test("reserveFromFamilyOrder requires a sessionId", async () => {
  const svc = createCxQueueReservationService({ cxDialQueueRepository: fakeRepo() });
  await assert.rejects(() => svc.reserveFromFamilyOrder({ domain: "TAG", familyTargets: { "fresh-day1": 5 } }), /sessionId/);
});

test("totalLimit caps per-family targets in family order (green before blue before red)", async () => {
  const repo = fakeRepo({ reserveImpl: (_domain, familyTargets) => reservedRowsForTargets(familyTargets) });
  const svc = createCxQueueReservationService({ cxDialQueueRepository: repo });
  await svc.reserveFromFamilyOrder({
    domain: "TAG",
    sessionId: "sess-1",
    familyTargets: { "fresh-day1": 15, "fresh-day2to10": 10, aged: 5 },
    totalLimit: 20,
  });
  // 15 green accepted (remaining 5), 5 blue accepted (remaining 0), red dropped.
  assert.deepEqual(repo.calls.reserve.map((call) => call.familyTargets), [
    { "fresh-day1": 15 },
    { "fresh-day2to10": 5 },
  ]);
});

test("totalLimit smaller than the first family takes only what's left", async () => {
  const repo = fakeRepo({ reserveImpl: (_domain, familyTargets) => reservedRowsForTargets(familyTargets) });
  const svc = createCxQueueReservationService({ cxDialQueueRepository: repo });
  await svc.reserveFromFamilyOrder({
    sessionId: "sess-1",
    familyTargets: { "fresh-day1": 15, "fresh-day2to10": 10 },
    totalLimit: 6,
  });
  assert.deepEqual(repo.calls.reserve[0].familyTargets, { "fresh-day1": 6 });
  assert.equal(repo.calls.reserve.length, 1);
});

test("totalLimit falls through to later families when earlier families are short", async () => {
  const repo = fakeRepo({
    reserveImpl: (_domain, familyTargets) => {
      if (familyTargets["fresh-day1"]) {
        return { reserved: [], missing: { "fresh-day1": familyTargets["fresh-day1"] } };
      }
      return reservedRowsForTargets(familyTargets);
    },
  });
  const svc = createCxQueueReservationService({ cxDialQueueRepository: repo });
  const out = await svc.reserveFromFamilyOrder({
    sessionId: "sess-1",
    familyTargets: { "fresh-day1": 15, "fresh-day2to10": 10, aged: 5 },
    totalLimit: 5,
  });
  assert.deepEqual(repo.calls.reserve.map((call) => call.familyTargets), [
    { "fresh-day1": 5 },
    { "fresh-day2to10": 5 },
  ]);
  assert.equal(out.reserved.length, 5);
});

test("no totalLimit passes the full family targets through", async () => {
  const repo = fakeRepo();
  const svc = createCxQueueReservationService({ cxDialQueueRepository: repo });
  await svc.reserveFromFamilyOrder({
    sessionId: "sess-1",
    familyTargets: { "fresh-day1": 15, aged: 5 },
  });
  assert.deepEqual(repo.calls.reserve.map((call) => call.familyTargets), [
    { "fresh-day1": 15 },
    { aged: 5 },
  ]);
});

test("reserveFromFamilyOrder returns the repo's reserved + missing unchanged, and forwards session/claimMinutes", async () => {
  const reserveResult = { reserved: [{ _id: "a" }, { _id: "b" }], missing: { "fresh-day1": 3 } };
  const repo = fakeRepo({ reserveResult });
  const svc = createCxQueueReservationService({ cxDialQueueRepository: repo });
  const out = await svc.reserveFromFamilyOrder({
    domain: "WYNN",
    agentExtensionId: "101",
    sessionId: "sess-9",
    familyTargets: { "fresh-day1": 2 },
    claimMinutes: 12,
  });
  assert.deepEqual(out, reserveResult);
  const passed = repo.calls.reserve[0];
  assert.equal(passed.domain, "WYNN");
  assert.equal(passed.options.sessionId, "sess-9");
  assert.equal(passed.options.agentExtensionId, "101");
  assert.equal(passed.options.claimMinutes, 12);
  assert.ok(passed.options.now instanceof Date);
});

test("reserveFromFamilyOrder forwards rail provenance metadata to the repo (M8b §3)", async () => {
  const repo = fakeRepo();
  const svc = createCxQueueReservationService({ cxDialQueueRepository: repo });
  await svc.reserveFromFamilyOrder({
    sessionId: "sess-rail",
    familyTargets: { "fresh-day1": 3 },
    metadata: { rail: "bulk_load" },
  });
  // The repo's reserveReadyRows is what stamps metadata.reservationRail; the service must
  // hand it the rail so a publish can echo it and a cross-rail actor can fail closed.
  assert.deepEqual(repo.calls.reserve[0].options.metadata, { rail: "bulk_load" });
});

test("WO-1 reserveFromFamilyOrder ignores legacy first-touch claim options", async () => {
  const repo = fakeRepo();
  const svc = createCxQueueReservationService({ cxDialQueueRepository: repo });
  await svc.reserveFromFamilyOrder({
    sessionId: "sess-green",
    familyTargets: { "fresh-day1": 3 },
    firstTouchOnly: true,
    greenCoverageBatchId: "green-coverage-2026-06-29-WYNN",
    queueLane: "firstContact",
    firstTouchMaxAttempts: 1,
  });
  const options = repo.calls.reserve[0].options;
  assert.equal(options.firstTouchOnly, undefined);
  assert.equal(options.greenCoverageBatchId, undefined);
  assert.equal(options.queueLane, undefined);
  assert.equal(options.firstTouchMaxAttempts, undefined);
});

test("releaseReserved clears claimed/ready reserved rows with a reservationSessionId-guarded CAS", async () => {
  const repo = fakeRepo();
  const svc = createCxQueueReservationService({ cxDialQueueRepository: repo });
  await svc.releaseReserved(
    [
      { _id: "x", metadata: { reservationSessionId: "sess-1" } },
      { _id: "y", metadata: { reservationSessionId: "sess-2" } },
    ],
    "publish-rejected",
  );
  assert.equal(repo.calls.transition.length, 2);
  const first = repo.calls.transition[0];
  assert.equal(first.id, "x");
  assert.deepEqual(first.fromStates, ["claimed", "ready"]);
  assert.equal(first.update.state, "ready");
  assert.equal(first.update.claimUntil, null);
  assert.equal(first.update.assignment.extensionId, null);
  assert.equal(first.update["metadata.reservationSessionId"], null);
  assert.equal(first.update["metadata.reservedAt"], null);
  assert.equal(first.update["metadata.reservationExpiresAt"], null);
  assert.equal(first.update["metadata.lastReleaseReason"], "publish-rejected");
  assert.deepEqual(first.options.match, { "metadata.reservationSessionId": "sess-1" });
  assert.deepEqual(repo.calls.transition[1].options.match, { "metadata.reservationSessionId": "sess-2" });
});

test("WO-1 releaseReserved no longer stamps first-touch attempts", async () => {
  const repo = fakeRepo();
  const svc = createCxQueueReservationService({ cxDialQueueRepository: repo });
  await svc.releaseReserved(
    [{
      _id: "green-1",
      metadata: {
        reservationSessionId: "sess-green",
        firstTouchOnly: true,
        greenCoverageBatchId: "green-coverage-2026-06-29-WYNN",
      },
    }],
    "publish-rejected",
  );

  assert.equal(repo.calls.transition.length, 1);
  const update = repo.calls.transition[0].update;
  assert.equal(update["metadata.firstTouchAttempts"], undefined);
  assert.equal(update["metadata.firstTouchLastAttemptAt"], undefined);
  assert.equal(update["metadata.lastReleaseReason"], "publish-rejected");
});

test("WO-1 releaseReserved ignores existing first-touch attempt snapshots", async () => {
  const repo = fakeRepo();
  const svc = createCxQueueReservationService({ cxDialQueueRepository: repo });
  await svc.releaseReserved([
    {
      _id: "green-2",
      metadata: {
        reservationSessionId: "sess-green",
        greenCoverageBatchId: "green-coverage-2026-06-29-WYNN",
        firstTouchAttempts: 1,
      },
    },
  ]);

  assert.equal(repo.calls.transition[0].update["metadata.firstTouchAttempts"], undefined);
});

test("releaseReserved does not count session cleanup as a first-touch attempt", async () => {
  const repo = fakeRepo();
  const svc = createCxQueueReservationService({ cxDialQueueRepository: repo });
  await svc.releaseReserved(
    [{
      _id: "green-cleanup",
      metadata: {
        reservationSessionId: "sess-green",
        greenCoverageBatchId: "green-coverage-2026-06-29-WYNN",
      },
    }],
    "session-killed",
  );

  const update = repo.calls.transition[0].update;
  assert.equal(update["metadata.firstTouchAttempts"], undefined);
  assert.equal(update["metadata.firstTouchLastAttemptAt"], undefined);
  assert.equal(update["metadata.lastReleaseReason"], "session-killed");
});

test("cancelReserved terminalizes claimed/ready reserved rows with a reservationSessionId-guarded CAS", async () => {
  const repo = fakeRepo();
  const svc = createCxQueueReservationService({ cxDialQueueRepository: repo });
  await svc.cancelReserved(
    [{ _id: "blocked", metadata: { reservationSessionId: "sess-1" } }],
    "contact-blocked",
  );
  assert.equal(repo.calls.transition.length, 1);
  const call = repo.calls.transition[0];
  assert.equal(call.id, "blocked");
  assert.deepEqual(call.fromStates, ["claimed", "ready"]);
  assert.equal(call.update.state, "cancelled");
  assert.equal(call.update.claimUntil, null);
  assert.equal(call.update["metadata.reservationSessionId"], null);
  assert.equal(call.update["metadata.cancelledByReservation"], true);
  assert.equal(call.update["metadata.cancelledReason"], "contact-blocked");
  assert.deepEqual(call.options.match, { "metadata.reservationSessionId": "sess-1" });
});

test("releaseReserved skips rows without reservationSessionId instead of CASing null", async () => {
  const repo = fakeRepo();
  const warns = [];
  const svc = createCxQueueReservationService({
    cxDialQueueRepository: repo,
    logger: { warn: (...a) => warns.push(a) },
  });
  await svc.releaseReserved([{ _id: "missing-owner", metadata: {} }, { _id: "missing-metadata" }]);
  assert.equal(repo.calls.transition.length, 0);
  assert.equal(warns.length, 2);
});

test("releaseReserved is fail-soft: a transition error is logged, never thrown", async () => {
  const repo = fakeRepo({ transitionThrows: true });
  const warns = [];
  const svc = createCxQueueReservationService({
    cxDialQueueRepository: repo,
    logger: { warn: (...a) => warns.push(a) },
  });
  await assert.doesNotReject(() => svc.releaseReserved([{ _id: "x", metadata: { reservationSessionId: "s" } }]));
  assert.equal(warns.length, 1);
});


test("reserveFromFamilyOrder drops + releases a reserved row already active in the UCQ pool (M5 interlock)", async () => {
  const repo = fakeRepo({
    reserveResult: {
      reserved: [
        { _id: "a", caseId: 1, metadata: { reservationSessionId: "s" } },
        { _id: "b", caseId: 2, metadata: { reservationSessionId: "s" } },
      ],
      missing: {},
    },
  });
  const queueItemRepository = { existsForLead: async (leadId) => leadId === "2" }; // case 2 is active in the UCQ
  const svc = createCxQueueReservationService({ cxDialQueueRepository: repo, queueItemRepository });
  const out = await svc.reserveFromFamilyOrder({ sessionId: "s", familyTargets: { "fresh-day1": 2 } });
  assert.deepEqual(out.reserved.map((r) => r._id), ["a"]); // b excluded
  assert.equal(repo.calls.transition.length, 1); // b released
  assert.equal(repo.calls.transition[0].id, "b");
  assert.equal(repo.calls.transition[0].update["metadata.lastReleaseReason"], "cross-pool-interlock:active-in-queueitem");
});

test("the cross-pool interlock is a no-op when no queueItemRepository is wired (flag-OFF belt applies)", async () => {
  const repo = fakeRepo({ reserveResult: { reserved: [{ _id: "a", caseId: 1, metadata: {} }], missing: {} } });
  const svc = createCxQueueReservationService({ cxDialQueueRepository: repo }); // no queueItemRepository
  const out = await svc.reserveFromFamilyOrder({ sessionId: "s", familyTargets: { "fresh-day1": 1 } });
  assert.deepEqual(out.reserved.map((r) => r._id), ["a"]);
  assert.equal(repo.calls.transition.length, 0); // nothing released
});

test("newSessionId returns distinct uuids", () => {
  const svc = createCxQueueReservationService({ cxDialQueueRepository: fakeRepo() });
  const a = svc.newSessionId();
  const b = svc.newSessionId();
  assert.notEqual(a, b);
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});
