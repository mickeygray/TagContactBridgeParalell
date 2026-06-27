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
    // Default: echo the ids back as "renewed"; renewReturns can override per session.
    renewClaim: async (ids, claimMinutes, sessionId) => {
      calls.renew.push({ ids, claimMinutes, sessionId });
      return renewReturns ? renewReturns(sessionId, ids) : ids;
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

test("renewReserved groups ids by reservationSessionId and delegates one CAS batch per owner", async () => {
  const repo = fakeRepo();
  const svc = createCxQueueReservationService({ cxDialQueueRepository: repo });
  const renewed = await svc.renewReserved(
    [
      { _id: "a", metadata: { reservationSessionId: "sess-1" } },
      { _id: "b", metadata: { reservationSessionId: "sess-1" } },
      { _id: "c", metadata: { reservationSessionId: "sess-2" } },
    ],
    10,
  );
  assert.equal(repo.calls.renew.length, 2); // one batch per session
  const s1 = repo.calls.renew.find((c) => c.sessionId === "sess-1");
  assert.deepEqual(s1.ids, ["a", "b"]);
  assert.equal(s1.claimMinutes, 10);
  assert.deepEqual(renewed.sort(), ["a", "b", "c"]); // union of renewed ids
});

test("renewReserved skips rows missing an id or a reservationSessionId", async () => {
  const repo = fakeRepo();
  const svc = createCxQueueReservationService({ cxDialQueueRepository: repo });
  await svc.renewReserved([
    { _id: "a", metadata: { reservationSessionId: "sess-1" } },
    { _id: "b", metadata: {} }, // no sessionId -> skipped
    { metadata: { reservationSessionId: "sess-1" } }, // no _id -> skipped
  ]);
  assert.equal(repo.calls.renew.length, 1);
  assert.deepEqual(repo.calls.renew[0].ids, ["a"]);
});

test("renewReserved returns only the ids the CAS actually renewed (serving/reaped rows drop out)", async () => {
  // sess-1 row 'b' lost its lease (serving/reaped) -> CAS returns only 'a'.
  const repo = fakeRepo({ renewReturns: () => ["a"] });
  const svc = createCxQueueReservationService({ cxDialQueueRepository: repo });
  const renewed = await svc.renewReserved([
    { _id: "a", metadata: { reservationSessionId: "sess-1" } },
    { _id: "b", metadata: { reservationSessionId: "sess-1" } },
  ]);
  assert.deepEqual(renewed, ["a"]);
});

test("renewReserved requires cxDialQueueRepository.renewClaim", async () => {
  const svc = createCxQueueReservationService({
    cxDialQueueRepository: { reserveReadyRows: async () => ({ reserved: [], missing: {} }) },
  });
  await assert.rejects(() => svc.renewReserved([{ _id: "a", metadata: { reservationSessionId: "s" } }]), /renewClaim/);
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
