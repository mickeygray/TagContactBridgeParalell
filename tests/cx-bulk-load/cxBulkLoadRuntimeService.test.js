"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  createCxBulkLoadRuntimeService,
  familyRefillTargets,
  DEFAULT_TARGET_BUFFER,
  sanitizeSession,
} = require("../../packages/shared-services/src/cxBulkLoadRuntimeService");
const { reduceCxBulkLoadState } = require("../../packages/shared-services/src/cxBulkLoadStateMachine");
const watcher = require("../../packages/shared-services/src/cxBulkLoadActiveCallWatcher");
const leadSource = require("../../packages/shared-services/src/cxBulkLoadLeadSourceService");
const publisher = require("../../packages/shared-services/src/cxBulkLoadRingcxPublisher");

const NOW = new Date("2026-06-22T10:00:00.000Z");

// In-memory repo whose update MERGES (like findOneAndUpdate $set), preserving identity.
function makeRepo() {
  const store = new Map();
  const counters = { updates: 0 };
  return {
    store,
    counters,
    async createBulkLoadSession(seed) {
      const doc = { __v: 0, current: null, acceptedBuffer: [], completed: [], stats: {}, trace: {}, ...seed };
      store.set(seed.sessionId, doc);
      return { ...doc };
    },
    async findBulkLoadSessionById(id) {
      const d = store.get(id);
      return d ? { ...d } : null;
    },
    async updateBulkLoadSession(id, patch, options = {}) {
      counters.updates += 1;
      const d = store.get(id) || {};
      if (options.versionGuard && options.expectedVersion != null && d.__v !== options.expectedVersion) return null;
      if (options.versionGuard && options.expectedUpdatedAt != null && d.updatedAt !== options.expectedUpdatedAt) return null;
      const next = { ...d, ...patch, sessionId: id, __v: Number(d.__v || 0) + 1 };
      store.set(id, next);
      return { ...next };
    },
    async findActiveBulkLoadSessionForAgent({ agentEmail }) {
      for (const d of store.values()) if (d.agentEmail === agentEmail && d.status === "running") return { ...d };
      return null;
    },
    async listActiveBulkLoadSessions(input = {}) {
      return Array.from(store.values())
        .filter((d) => d.status === "running")
        .filter((d) => !input.sessionId || d.sessionId === input.sessionId)
        .filter((d) => !input.agentEmail || d.agentEmail === input.agentEmail)
        .filter((d) => !input.agentExtensionId || d.agentExtensionId === input.agentExtensionId)
        .map((d) => ({ ...d }));
    },
    async killActiveBulkLoadSessionsForAgent() {
      return { matchedCount: 0, modifiedCount: 0 };
    },
  };
}

// Fake RingCX client; `liveCalls` is mutated by the test to simulate dialing.
function makeClient(liveCalls) {
  const calls = {
    dispositions: [],
    cancels: [],
    loads: [],
  };
  return {
    calls,
    async loadLeads(campaignId, payload) {
      calls.loads.push({ campaignId, payload });
      return { leadsSupplied: payload.uploadLeads.length, leadsInserted: payload.uploadLeads.length, rejectedRows: [] };
    },
    async listActiveCalls() {
      return { activeCalls: liveCalls.value };
    },
    async dispositionCall(uii, opts) {
      calls.dispositions.push({ uii, opts });
      return true;
    },
    async leadAction(action, body) {
      calls.cancels.push({ action, body });
      return { ok: true };
    },
  };
}

function makeOutcomeAdapter() {
  const writes = [];
  return { writes, async persistTerminalOutcome(x) { writes.push(x); return { written: true }; } };
}

// Fake reservation service (M4): reserves up to totalLimit rows from a test-seeded pool,
// in pool order (family-ordering itself is reserveReadyRows' Mongo concern, tested in M8).
// A released row returns to the front of the pool (so a publish reject re-reserves next tick).
function makeReservation(pool) {
  const rows = pool.map((r) => ({ ...r }));
  const released = [];
  const cancelled = [];
  const reserves = [];
  return {
    cancelled,
    released,
    reserves,
    async reserveFromFamilyOrder(args = {}) {
      reserves.push(args);
      const n = Math.max(Number(args.totalLimit) || 0, 0);
      const reserved = rows.splice(0, n).map((r) => ({ ...r, metadata: { reservationSessionId: "s1" } }));
      return { reserved, missing: {} };
    },
    async releaseReserved(items = []) {
      for (const it of items) { released.push(it._id); rows.unshift(it); }
    },
    async cancelReserved(items = []) {
      for (const it of items) { cancelled.push(it._id); }
    },
  };
}

// 5 ready queue rows; reader returns all (the lead source excludes + caps).
const ROWS = Array.from({ length: 5 }, (_, i) => ({
  _id: `q${i + 1}`,
  domain: "TAG",
  caseId: 100 + i,
  phone: `55510000${i + 1}`,
  name: `Lead ${i + 1}`,
}));

function mickeyRow(queueItemId, family, ordinal) {
  return {
    _id: queueItemId,
    domain: "TAG",
    caseId: 900000 + ordinal,
    phone: `310666${String(ordinal).padStart(4, "0")}`,
    name: `Mickey ${family} ${String(ordinal).padStart(2, "0")}`,
    queueFamily: family,
  };
}

function rangeRows(prefix, family, start, count) {
  return Array.from({ length: count }, (_, index) => {
    const ordinal = start + index;
    return mickeyRow(`${prefix}-${String(ordinal).padStart(2, "0")}`, family, ordinal);
  });
}

function bufferCandidate(queueItemId, family, ordinal, patch = {}) {
  const row = mickeyRow(queueItemId, family, ordinal);
  const externId = externFor(row._id);
  return {
    queueItemId: row._id,
    domain: row.domain,
    caseId: row.caseId,
    name: row.name,
    queueFamily: row.queueFamily,
    externId,
    ringcx: { externId },
    ...patch,
  };
}

function externFor(queueItemId, sessionId = "s1", domain = "TAG") {
  return leadSource.buildExternId({ domain, queueItemId, sessionId });
}

function build(liveCalls, overrides = {}) {
  const repo = overrides.repo || makeRepo();
  const client = makeClient(liveCalls);
  const outcomeAdapter = overrides.outcomeAdapter || makeOutcomeAdapter();
  const reservation = makeReservation(overrides.reservationPool || ROWS);
  const svc = createCxBulkLoadRuntimeService({
    repo,
    leadSource,
    publisher,
    watcher,
    outcomeAdapter,
    reservationService: reservation,
    ...(overrides.queueStateAdapter ? { queueStateAdapter: overrides.queueStateAdapter } : {}),
    ...(overrides.leadStarter ? { leadStarter: overrides.leadStarter } : {}),
    ...(overrides.greenFirstTouchPlanner ? { greenFirstTouchPlanner: overrides.greenFirstTouchPlanner } : {}),
    ...(overrides.contactEligibilityAdapter ? { contactEligibilityAdapter: overrides.contactEligibilityAdapter } : {}),
    terminalExecutor: overrides.terminalExecutor || (async ({ candidate, outcome }) => {
      try {
        const ok = await client.dispositionCall(candidate?.uii, { disposition: outcome });
        return ok ? { ok: true, uii: candidate?.uii, disposition: outcome } : { ok: false, error: "disposition-rejected" };
      } catch (error) {
        return { ok: false, error: error.message || String(error) };
      }
    }),
    client,
    offhookGate: overrides.offhookGate || { isAgentOffhook: async () => ({ ok: true, reason: "test-offhook" }) },
    listReadyQueueItems: overrides.listReadyQueueItems || (async () => ROWS), // still a required dep; fillBuffer no longer reads it (M4)
    reduce: reduceCxBulkLoadState,
    now: () => NOW,
    newSessionId: overrides.newSessionId || (() => "s1"),
  });
  return { svc, repo, client, outcomeAdapter, reservation };
}

async function syncFromRingCx(svc, sessionId = "s1") {
  // answeredMinConnectedMs: 0 — the harness clock is frozen (now: () => NOW), so the
  // real-pickup duration guard is exercised by its own explicit-time pins at the
  // pure projection layer, not here.
  await svc.watchAccountActiveCalls({ sessionId, answeredMinConnectedMs: 0 });
  return svc.getCxBulkLoadSession({ sessionId });
}

test("M11 gate 7: a reserved row whose OWN campaign differs from the session route is released, not published", async () => {
  const liveCalls = { value: [] };
  const pool = [{ _id: "qx", domain: "TAG", caseId: 1, phone: "5551112222", name: "Wrong Route", rcxCampaignId: "OTHER_CAMP" }];
  const { svc, client, reservation } = build(liveCalls, { reservationPool: pool });
  await svc.startCxBulkLoadSession({ agentEmail: "a@x.com", domain: "TAG", ringcx: { accountId: "acct1", campaignId: "camp1" }, targetSize: 1, refillThreshold: 1 });
  assert.equal(client.calls.loads.length, 0, "a route-mismatched row is never loaded to RingCX");
  assert.ok(reservation.released.includes("qx"), "the misrouted row is released back to the pool");
});

test("M11 gate 7: a reserved row whose case is already active on another row is released (cross-pool)", async () => {
  const liveCalls = { value: [] };
  const queueStateAdapter = { async findActiveSibling() { return { _id: "other-active-row" }; } };
  const { svc, client, reservation } = build(liveCalls, { queueStateAdapter });
  await svc.startCxBulkLoadSession({ agentEmail: "a@x.com", domain: "TAG", ringcx: { accountId: "acct1", campaignId: "camp1" }, targetSize: 1, refillThreshold: 1 });
  assert.equal(client.calls.loads.length, 0, "a case with an active sibling is never loaded to RingCX");
  assert.ok(reservation.released.length >= 1, "the cross-pool-conflicting row is released");
});

test("reserved rows blocked by contact eligibility are not published to RingCX", async () => {
  const liveCalls = { value: [] };
  const contactEligibilityAdapter = {
    async resolve({ queueItem }) {
      return {
        ok: false,
        reason: queueItem.caseId === 100 ? "blocked-stage" : "unexpected",
        enforced: true,
      };
    },
  };
  const { svc, client, reservation } = build(liveCalls, { contactEligibilityAdapter });
  const snap = await svc.startCxBulkLoadSession({
    agentEmail: "a@x.com",
    domain: "TAG",
    ringcx: { accountId: "acct1", campaignId: "camp1" },
    targetSize: 1,
    refillThreshold: 1,
  });
  assert.equal(client.calls.loads.length, 0, "blocked rows never reach RingCX loadLeads");
  assert.equal(snap.bufferCount, 0);
  assert.equal(snap.stats.failedPublishCount, 1);
  assert.equal(snap.lastError, "blocked-stage");
  assert.deepEqual(reservation.released, [], "adapter-enforced blocked rows are not re-released to ready");
  assert.deepEqual(reservation.cancelled, ["q1"], "adapter-enforced blocked rows are terminalized out of the queue");
});

test("M11 gate 8: the canonical default target buffer is 35", () => {
  assert.equal(DEFAULT_TARGET_BUFFER, 35);
});

test("M11 gate 8: refill computes per-family residuals from the live buffer (green-full -> refills red)", () => {
  // buffer already holds the full green allotment + some blue, but NO aged.
  const state = {
    acceptedBuffer: [
      { queueItemId: "g1", queueFamily: "fresh-day1" },
      { queueItemId: "g2", queueFamily: "fresh-day1" },
      { queueItemId: "b1", queueFamily: "fresh-day2to10" },
    ],
    current: { queueItemId: "g3", queueFamily: "fresh-day1" }, // current counts toward live
  };
  const targets = { "fresh-day1": 3, "fresh-day2to10": 2, aged: 2 };
  const residual = familyRefillTargets(state, targets);
  // green is satisfied (3 live >= 3 target) -> absent; the short families remain.
  assert.equal(residual["fresh-day1"], undefined);
  assert.equal(residual["fresh-day2to10"], 1); // 2 target - 1 live
  assert.equal(residual.aged, 2); // none live -> full need
});

test("M11 gate 8: an empty buffer yields the full family targets (fresh start)", () => {
  const residual = familyRefillTargets({ acceptedBuffer: [], current: null }, { "fresh-day1": 15, aged: 5 });
  assert.deepEqual(residual, { "fresh-day1": 15, aged: 5 });
});

test("start fills the buffer to target via one publish and goes ready", async () => {
  const liveCalls = { value: [] };
  const { svc, client } = build(liveCalls);
  const snap = await svc.startCxBulkLoadSession({
    agentEmail: "a@x.com",
    domain: "TAG",
    ringcx: { accountId: "acct1", campaignId: "camp1" },
    targetSize: 2,
    refillThreshold: 1,
  });
  assert.equal(snap.status, "running");
  assert.equal(snap.phase, "ready");
  assert.equal(snap.bufferCount, 2); // q1, q2
  assert.equal(snap.remainingQueue.length, 2);
  assert.equal(client.calls.loads[0].payload.uploadLeads[0].externId, externFor("q1"));
  assert.equal(snap.remainingQueue[0].externId, externFor("q1"));
  assert.equal("phone" in snap.remainingQueue[0], false);
});

test("start preloads RingCX leads while on hook, then waits offhook", async () => {
  const liveCalls = { value: [] };
  const { svc, client, reservation } = build(liveCalls, {
    offhookGate: { isAgentOffhook: async () => ({ ok: false, reason: "agent-not-offhook" }) },
  });
  const snap = await svc.startCxBulkLoadSession({
    agentEmail: "a@x.com",
    domain: "TAG",
    ringcx: { accountId: "acct1", campaignId: "camp1" },
    targetSize: 2,
    refillThreshold: 1,
  });

  assert.equal(snap.status, "running");
  assert.equal(snap.phase, "waiting_offhook");
  assert.equal(snap.bufferCount, 2);
  assert.equal(client.calls.loads.length, 2);
  assert.equal(reservation.reserves.length, 1);
});

test("WO-1 legacy green first-touch planner is ignored by bulk reservation", async () => {
  const liveCalls = { value: [] };
  const plans = [];
  const greenFirstTouchPlanner = {
    async resolvePlan(input) {
      plans.push(input);
      return {
        lane: "morningCoverage",
        batchId: "green-coverage-2026-06-22-TAG",
        firstTouchOnly: true,
        coverageOpen: true,
        familyTargets: { "fresh-day1": 2 },
        claimFilter: {
          firstTouchOnly: true,
          greenCoverageBatchId: "green-coverage-2026-06-22-TAG",
        },
        counts: { remaining: 2 },
        reason: "morning-coverage-open",
      };
    },
  };
  const { svc, reservation } = build(liveCalls, { greenFirstTouchPlanner });
  const normalTargets = { "fresh-day1": 15, "fresh-day2to10": 10, aged: 5 };

  await svc.startCxBulkLoadSession({
    agentEmail: "a@x.com",
    agentExtensionId: "63914587001",
    domain: "TAG",
    ringcx: { accountId: "acct1", campaignId: "camp1", dialGroupId: "dg1" },
    targetSize: 2,
    refillThreshold: 1,
    familyTargets: normalTargets,
  });

  assert.equal(plans.length, 0);
  assert.deepEqual(reservation.reserves[0].familyTargets, normalTargets);
  assert.equal(reservation.reserves[0].firstTouchOnly, undefined);
  assert.equal(reservation.reserves[0].greenCoverageBatchId, undefined);
  assert.equal(reservation.reserves[0].queueLane, undefined);
});

test("WO-1 unscoped legacy first-touch planner injection is ignored", async () => {
  const liveCalls = { value: [] };
  const plans = [];
  const greenFirstTouchPlanner = {
    async resolvePlan() {
      plans.push(true);
      return {
        lane: "morningCoverage",
        firstTouchOnly: true,
        familyTargets: { "fresh-day1": 1 },
        claimFilter: { firstTouchOnly: true },
        reason: "missing-scope-bug",
      };
    },
  };
  const { svc, reservation } = build(liveCalls, { greenFirstTouchPlanner });
  const normalTargets = { "fresh-day1": 15, "fresh-day2to10": 10, aged: 5 };

  await svc.startCxBulkLoadSession({
    agentEmail: "a@x.com",
    agentExtensionId: "63914587001",
    domain: "TAG",
    ringcx: { accountId: "acct1", campaignId: "camp1", dialGroupId: "dg1" },
    targetSize: 2,
    refillThreshold: 1,
    familyTargets: normalTargets,
  });

  assert.equal(plans.length, 0);
  assert.deepEqual(reservation.reserves[0].familyTargets, normalTargets);
  assert.equal(reservation.reserves[0].firstTouchOnly, undefined);
  assert.equal(reservation.reserves[0].greenCoverageBatchId, undefined);
  assert.equal(reservation.reserves[0].queueLane, undefined);
});

test("start sources the buffer from the reservation service, scoped to agent + domain + session", async () => {
  const liveCalls = { value: [] };
  const { svc, reservation } = build(liveCalls);
  await svc.startCxBulkLoadSession({
    agentEmail: "a@x.com",
    agentExtensionId: "63914587001",
    domain: "TAG",
    ringcx: { accountId: "acct1", campaignId: "camp1" },
    targetSize: 2,
    refillThreshold: 1,
  });
  assert.equal(reservation.reserves.length, 1);
  assert.equal(reservation.reserves[0].domain, "TAG");
  assert.equal(reservation.reserves[0].agentExtensionId, "63914587001");
  assert.equal(reservation.reserves[0].sessionId, "s1");
  assert.equal(reservation.reserves[0].totalLimit, 2); // deficit toward target
  assert.equal(reservation.reserves[0].metadata.rail, "bulk_load");
});

test("watch matches the live call to a buffered candidate and makes it current", async () => {
  const liveCalls = { value: [] };
  const { svc } = build(liveCalls);
  await svc.startCxBulkLoadSession({ agentEmail: "a@x.com", domain: "TAG", ringcx: { accountId: "acct1", campaignId: "camp1" }, targetSize: 2, refillThreshold: 1 });

  // RingCX dials q1
  liveCalls.value = [{ externalId: externFor("q1"), uii: "u1", callState: "connected" }];
  const snap = await syncFromRingCx(svc);
  assert.equal(snap.current.queueItemId, "q1");
  assert.equal(snap.current.uii, "u1");
  assert.equal(snap.bufferCount, 1); // q1 left the buffer, q2 remains (live=2 > threshold 1, no refill)
});

test("watch promotes a matched active call even when offhook gate is stale", async () => {
  const liveCalls = { value: [] };
  const offhook = { ok: true };
  const { svc } = build(liveCalls, {
    offhookGate: { isAgentOffhook: async () => offhook.ok ? { ok: true, reason: "test-offhook" } : { ok: false, reason: "stale-login-read" } },
  });
  await svc.startCxBulkLoadSession({ agentEmail: "a@x.com", domain: "TAG", ringcx: { accountId: "acct1", campaignId: "camp1" }, targetSize: 2, refillThreshold: 1 });

  offhook.ok = false;
  liveCalls.value = [{ externalId: externFor("q1"), uii: "u1", callState: "connected" }];
  const snap = await syncFromRingCx(svc);
  assert.equal(snap.current.queueItemId, "q1");
  assert.equal(snap.current.uii, "u1");
  assert.equal(snap.phase, "active");
  assert.equal(snap.bufferCount, 1);
});

test("disposition closes current once and RingCX-side advance refills the buffer", async () => {
  const liveCalls = { value: [] };
  const { svc, client, outcomeAdapter } = build(liveCalls);
  await svc.startCxBulkLoadSession({ agentEmail: "a@x.com", domain: "TAG", ringcx: { accountId: "acct1", campaignId: "camp1" }, targetSize: 2, refillThreshold: 1 });
  liveCalls.value = [{ externalId: externFor("q1"), uii: "u1" }];
  await syncFromRingCx(svc);

  const snap = await svc.submitCxBulkLoadDisposition({ sessionId: "s1", disposition: "ANSWER" });
  assert.equal(snap.dispositionOk, true);
  assert.equal(client.calls.dispositions.length, 1);
  assert.equal(client.calls.dispositions[0].uii, "u1");
  assert.equal(outcomeAdapter.writes.length, 1); // single terminal write
  assert.equal(snap.current, null);
  assert.equal(snap.completedCount, 1);
  assert.equal(snap.bufferCount, 2); // q2 + refilled q3 (live had dropped to 1 <= threshold)
});

test("did_not_connect disposition requests next preview without staging current", async () => {
  const liveCalls = { value: [] };
  const requests = [];
  const leadStarter = {
    async getLeads({ session, candidate }) {
      requests.push({ sessionId: session.sessionId, candidate });
      return { ok: true, elapsedMs: 31, source: "setAgentState" };
    },
  };
  const { svc, outcomeAdapter } = build(liveCalls, { leadStarter });
  await svc.startCxBulkLoadSession({ agentEmail: "a@x.com", domain: "TAG", ringcx: { accountId: "acct1", campaignId: "camp1" }, targetSize: 2, refillThreshold: 1 });
  liveCalls.value = [{ externalId: externFor("q1"), uii: "u1" }];
  await syncFromRingCx(svc);

  const snap = await svc.submitCxBulkLoadDisposition({ sessionId: "s1", disposition: "did_not_connect" });
  assert.equal(snap.dispositionOk, true);
  assert.equal(snap.current, null);
  assert.equal(snap.completedCount, 1);
  assert.equal(outcomeAdapter.writes.length, 1);
  assert.equal(requests.length, 1);
  assert.equal(snap.getLeads.ok, true);
  assert.equal(snap.getLeads.queueItemId, "q2");
  assert.equal(snap.stats.lastGetLeadsQueueItemId, "q2");
  assert.equal(snap.remainingQueue[0].queueItemId, "q2");
  assert.equal(requests[0].candidate.queueItemId, "q2");
});

test("did_not_connect does not advance when the terminal executor rejects the disposition", async () => {
  const liveCalls = { value: [] };
  const requests = [];
  const leadStarter = {
    async getLeads({ session, candidate }) {
      requests.push({ sessionId: session.sessionId, candidate });
      return { ok: true, elapsedMs: 28, source: "setAgentState" };
    },
  };
  const terminalExecutor = async ({ candidate, outcome }) => ({
    ok: false,
    executed: true,
    disposition: "Auto Dispo",
    uii: candidate.uii,
    dispositionStatus: "rejected",
    reason: "terminal-rejected",
    activeCall: { uii: candidate.uii, externalId: candidate.externId, callState: "ACTIVE" },
    outcome,
  });
  const { svc, outcomeAdapter } = build(liveCalls, { leadStarter, terminalExecutor });
  await svc.startCxBulkLoadSession({ agentEmail: "a@x.com", domain: "TAG", ringcx: { accountId: "acct1", campaignId: "camp1" }, targetSize: 2, refillThreshold: 1 });
  liveCalls.value = [{ externalId: externFor("q1"), uii: "u1" }];
  await syncFromRingCx(svc);

  const snap = await svc.submitCxBulkLoadDisposition({ sessionId: "s1", disposition: "did_not_connect" });
  assert.equal(snap.dispositionOk, false);
  assert.equal(snap.terminal.ok, false);
  assert.equal(snap.current.queueItemId, "q1");
  assert.equal(snap.completedCount, 0);
  assert.equal(outcomeAdapter.writes.length, 0);
  assert.equal(requests.length, 0);
  assert.equal(snap.getLeads, undefined);
});

test("rolling refill tops up at threshold regardless of hook state", async () => {
  const liveCalls = { value: [] };
  const { svc, client, outcomeAdapter, reservation } = build(liveCalls, {
    offhookGate: { isAgentOffhook: async () => ({ ok: false, reason: "agent-not-offhook" }) },
  });
  await svc.startCxBulkLoadSession({
    agentEmail: "a@x.com",
    domain: "TAG",
    ringcx: { accountId: "acct1", campaignId: "camp1" },
    targetSize: 2,
    refillThreshold: 1,
  });
  assert.equal(client.calls.loads.length, 2, "initial preload is allowed while on hook");
  assert.equal(reservation.reserves.length, 1);

  liveCalls.value = [{ externalId: externFor("q1"), uii: "u1" }];
  await syncFromRingCx(svc);

  const snap = await svc.submitCxBulkLoadDisposition({ sessionId: "s1", disposition: "ANSWER" });
  assert.equal(snap.dispositionOk, true);
  assert.equal(outcomeAdapter.writes.length, 1);
  assert.equal(snap.current, null);
  assert.equal(snap.completedCount, 1);
  assert.equal(snap.bufferCount, 2, "rolling refill tops up from q2 to q2+q3 while on hook");
  assert.equal(client.calls.loads.length, 3);
  assert.equal(reservation.reserves.length, 2);
});

test("a rejected dispositionCall never completes the lead (no fake outcome)", async () => {
  const liveCalls = { value: [] };
  const { svc, client, outcomeAdapter } = build(liveCalls);
  client.dispositionCall = async () => false; // RingCX soft-fail
  await svc.startCxBulkLoadSession({ agentEmail: "a@x.com", domain: "TAG", ringcx: { accountId: "acct1", campaignId: "camp1" }, targetSize: 2, refillThreshold: 1 });
  liveCalls.value = [{ externalId: externFor("q1"), uii: "u1" }];
  await syncFromRingCx(svc);

  const snap = await svc.submitCxBulkLoadDisposition({ sessionId: "s1", disposition: "ANSWER" });
  assert.equal(snap.dispositionOk, false);
  assert.equal(outcomeAdapter.writes.length, 0); // never wrote an outcome
  assert.equal(snap.completedCount, 0);
  assert.equal(snap.phase, "active");
  assert.equal(snap.current.queueItemId, "q1");
  assert.equal(snap.current.uii, "u1");
  assert.equal("phone" in snap.current, false);
  assert.equal(snap.current.terminalError, "disposition-rejected");
  assert.equal(snap.lastError, "disposition-rejected");
});

test("#8 a double-fault in durable recording still advances the (already hung-up) call past terminal.started", async () => {
  // terminalExecutor (hangup) SUCCEEDS, but durable recording reports the double-fault (outbox
  // insert AND fallback dispatch both failed). The call already ended, so the reducer MUST reach
  // terminal.accepted (counted + current cleared), with a replay marker — never stranded at
  // terminal.started, uncounted.
  const liveCalls = { value: [] };
  const outcomeAdapter = {
    writes: [],
    async persistTerminalOutcome(x) {
      this.writes.push(x);
      return { written: false, idemKey: "k", result: { fallbackFailed: true, error: new Error("outbox+fallback down") } };
    },
  };
  const { svc } = build(liveCalls, { outcomeAdapter });
  await svc.startCxBulkLoadSession({ agentEmail: "a@x.com", domain: "TAG", ringcx: { accountId: "acct1", campaignId: "camp1" }, targetSize: 2, refillThreshold: 1 });
  liveCalls.value = [{ externalId: externFor("q1"), uii: "u1" }];
  await syncFromRingCx(svc);

  const snap = await svc.submitCxBulkLoadDisposition({ sessionId: "s1", disposition: "ANSWER" });
  assert.equal(snap.dispositionOk, true, "call still dispositions ok (it hung up)");
  assert.equal(snap.current, null, "current cleared — not stranded at terminal.started");
  assert.equal(snap.completedCount, 1, "lead is counted");
  assert.notEqual(snap.phase, "releasing", "reducer advanced past the RELEASING/terminal.started state");
  assert.equal(snap.terminalRecordDeferred, true);
  assert.match(snap.lastError, /terminal-record-deferred/);
});

test("#8 a THROWN persistTerminalOutcome on an already hung-up call still completes the lead", async () => {
  const liveCalls = { value: [] };
  const outcomeAdapter = {
    writes: [],
    async persistTerminalOutcome() { throw new Error("mongo down"); },
  };
  const { svc } = build(liveCalls, { outcomeAdapter });
  await svc.startCxBulkLoadSession({ agentEmail: "a@x.com", domain: "TAG", ringcx: { accountId: "acct1", campaignId: "camp1" }, targetSize: 2, refillThreshold: 1 });
  liveCalls.value = [{ externalId: externFor("q1"), uii: "u1" }];
  await syncFromRingCx(svc);

  const snap = await svc.submitCxBulkLoadDisposition({ sessionId: "s1", disposition: "ANSWER" });
  assert.equal(snap.dispositionOk, true);
  assert.equal(snap.current, null);
  assert.equal(snap.completedCount, 1);
  assert.equal(snap.terminalRecordDeferred, true);
  assert.match(snap.lastError, /terminal-record-deferred: mongo down/);
});

test("a thrown dispositionCall leaves current retryable and visible", async () => {
  const liveCalls = { value: [] };
  const { svc, client, outcomeAdapter } = build(liveCalls);
  client.dispositionCall = async () => {
    throw new Error("ringcx-timeout");
  };
  await svc.startCxBulkLoadSession({ agentEmail: "a@x.com", domain: "TAG", ringcx: { accountId: "acct1", campaignId: "camp1" }, targetSize: 2, refillThreshold: 1 });
  liveCalls.value = [{ externalId: externFor("q1"), uii: "u1" }];
  await syncFromRingCx(svc);

  const snap = await svc.submitCxBulkLoadDisposition({ sessionId: "s1", disposition: "ANSWER" });
  assert.equal(snap.dispositionOk, false);
  assert.equal(outcomeAdapter.writes.length, 0);
  assert.equal(snap.completedCount, 0);
  assert.equal(snap.phase, "active");
  assert.equal(snap.current.queueItemId, "q1");
  assert.equal(snap.current.uii, "u1");
  assert.equal(snap.current.terminalError, "ringcx-timeout");
  assert.equal(snap.lastError, "ringcx-timeout");
});

test("kill cancels the buffered candidates and marks the session killed", async () => {
  const liveCalls = { value: [] };
  const { svc, client } = build(liveCalls);
  await svc.startCxBulkLoadSession({ agentEmail: "a@x.com", domain: "TAG", ringcx: { accountId: "acct1", campaignId: "camp1" }, targetSize: 2, refillThreshold: 1 });
  const snap = await svc.killCxBulkLoadSession({ sessionId: "s1", reason: "manual" });
  assert.equal(snap.status, "killed");
  assert.equal(snap.current, null);
  assert.equal(client.calls.cancels.length, 1);
  assert.equal(client.calls.cancels[0].action, "CANCEL_LEADS");
});

test("M11 gate 10: kill RELEASES every reserved buffer row back to the pool", async () => {
  const liveCalls = { value: [] };
  const { svc, reservation } = build(liveCalls);
  await svc.startCxBulkLoadSession({ agentEmail: "a@x.com", domain: "TAG", ringcx: { accountId: "acct1", campaignId: "camp1" }, targetSize: 2, refillThreshold: 1 });
  // 2 rows reserved+buffered, none current.
  await svc.killCxBulkLoadSession({ sessionId: "s1", reason: "manual" });
  // both leaked-claimed rows are released (else the reaper-excluded rows ghost forever).
  assert.deepEqual(reservation.released.sort(), ["q1", "q2"]);
});

test("M11 gate 10: kill terminalizes the in-flight current row (manual-reset release)", async () => {
  const liveCalls = { value: [] };
  const { svc, outcomeAdapter } = build(liveCalls);
  await svc.startCxBulkLoadSession({ agentEmail: "a@x.com", domain: "TAG", ringcx: { accountId: "acct1", campaignId: "camp1" }, targetSize: 2, refillThreshold: 1 });
  liveCalls.value = [{ externalId: externFor("q1"), uii: "u1" }];
  await syncFromRingCx(svc); // q1 becomes current
  await svc.killCxBulkLoadSession({ sessionId: "s1", reason: "manual" });
  const resetWrite = outcomeAdapter.writes.find((w) => w.source === "manual-reset");
  assert.ok(resetWrite, "the in-flight current was terminalized on kill");
  assert.equal(resetWrite.candidate.queueItemId, "q1");
  assert.equal(resetWrite.outcome, "did_not_connect");
});

test("start replaces a prior active session through full kill cleanup", async () => {
  const liveCalls = { value: [] };
  const { svc, repo, client, reservation, outcomeAdapter } = build(liveCalls);
  await repo.createBulkLoadSession({
    sessionId: "old-session",
    agentEmail: "a@x.com",
    agentExtensionId: "63914587001",
    domain: "TAG",
    status: "running",
    phase: "ready",
    ringcx: { accountId: "acct1", campaignId: "camp1" },
    acceptedBuffer: [{ queueItemId: "old-buffer", externId: "old-ext" }],
    current: { queueItemId: "old-current", caseId: 42, domain: "TAG", uii: "old-uii" },
  });

  await svc.startCxBulkLoadSession({
    sessionId: "new-session",
    agentEmail: "a@x.com",
    agentExtensionId: "63914587001",
    domain: "TAG",
    ringcx: { accountId: "acct1", campaignId: "camp1" },
    targetSize: 1,
    refillThreshold: 1,
  });

  const old = await repo.findBulkLoadSessionById("old-session");
  assert.equal(old.status, "killed");
  assert.equal(client.calls.cancels.length, 1, "old buffered RingCX leads are cancelled");
  assert.ok(reservation.released.includes("old-buffer"), "old reserved buffer rows are released");
  const resetWrite = outcomeAdapter.writes.find((w) => w.source === "manual-reset");
  assert.ok(resetWrite, "old current is terminalized through the single terminal writer");
  assert.equal(resetWrite.candidate.queueItemId, "old-current");
});

test("#2 two concurrent no-sessionId starts for one agent produce exactly ONE running session", async () => {
  // The agent-keyed start serializer must make the second start wait, see the first's running
  // session, and retire it — instead of two distinct minted sessionIds both creating a running row.
  const liveCalls = { value: [] };
  let n = 0;
  const { svc, repo } = build(liveCalls, { newSessionId: () => `s${++n}` });
  await Promise.all([
    svc.startCxBulkLoadSession({ agentEmail: "sean@x.com", domain: "TAG", ringcx: { accountId: "acct1", campaignId: "camp1" }, targetSize: 2, refillThreshold: 1 }),
    svc.startCxBulkLoadSession({ agentEmail: "sean@x.com", domain: "TAG", ringcx: { accountId: "acct1", campaignId: "camp1" }, targetSize: 2, refillThreshold: 1 }),
  ]);
  const running = Array.from(repo.store.values()).filter((d) => d.agentEmail === "sean@x.com" && d.status === "running");
  const killed = Array.from(repo.store.values()).filter((d) => d.status === "killed");
  assert.equal(running.length, 1, "the agent-keyed start lock prevents two concurrent running sessions");
  assert.equal(killed.length, 1, "the second start retired the first through the kill path");
});

test("#2 E11000 on create (DB backstop) retires the conflict and retries instead of duplicating", async () => {
  // Simulate the multi-process race the in-memory lock cannot catch: a concurrent insert landed
  // between our retire and create, so the partial-unique index rejects ours with E11000. The start
  // must retire the conflict and retry rather than throwing or duplicating.
  const base = makeRepo();
  await base.createBulkLoadSession({ sessionId: "rival", agentEmail: "sean@x.com", status: "running", domain: "TAG" });
  let createCalls = 0;
  const repo = {
    ...base,
    async createBulkLoadSession(seed) {
      createCalls += 1;
      if (createCalls === 1) {
        const err = new Error("E11000 duplicate key error");
        err.code = 11000;
        throw err;
      }
      return base.createBulkLoadSession(seed);
    },
  };
  const { svc } = build({ value: [] }, { repo, newSessionId: () => "s-new" });
  const snap = await svc.startCxBulkLoadSession({ agentEmail: "sean@x.com", domain: "TAG", ringcx: { accountId: "a", campaignId: "c" }, sessionId: "s-new", targetSize: 1, refillThreshold: 1 });
  assert.ok(createCalls >= 2, "first create hit E11000, then retried after retiring the conflict");
  assert.equal(snap.sessionId, "s-new", "the new session was created on retry");
  assert.equal(base.store.get("rival").status, "killed", "the conflicting running session was retired");
});

test("#11 a held busy flag makes the watcher SKIP the session, preserving current across a wrap (no deadlock)", async () => {
  // The appointment-wrap race: while the wrap commits the Logics appointment, a watcher tick that
  // sees the call released would clear state.current -> the terminal becomes a no-op (missing-current)
  // and the wrap strands resume after an already-committed appointment. markSessionBusy holds the
  // watcher-skip flag for the whole wrap so current survives, and (being a counter, not the serializer
  // tail) the inner disposition's withSessionMutation still runs without self-deadlock.
  const liveCalls = { value: [] };
  const { svc } = build(liveCalls);
  await svc.startCxBulkLoadSession({ agentEmail: "a@x.com", domain: "TAG", ringcx: { accountId: "acct1", campaignId: "camp1" }, targetSize: 2, refillThreshold: 1 });
  liveCalls.value = [{ externalId: externFor("q1"), uii: "u1" }];
  await syncFromRingCx(svc); // current = q1/u1

  const release = svc.markSessionBusy("s1");
  liveCalls.value = []; // RingCX shows the current call released mid-wrap
  await syncFromRingCx(svc); // watcher tick — must SKIP (busy), NOT clear current

  const mid = await svc.getCxBulkLoadSession({ sessionId: "s1" });
  assert.ok(mid.current && mid.current.queueItemId === "q1", "watcher skipped the busy session; current preserved");

  const snap = await svc.submitCxBulkLoadDisposition({ sessionId: "s1", disposition: "ANSWER" });
  release();
  assert.equal(snap.dispositionOk, true, "inner disposition completes while busy is held (no self-deadlock)");
  assert.equal(snap.current, null, "lead dispositioned after the wrap");
  assert.equal(snap.completedCount, 1);
});

test("account watcher is a no-op write when there is no match and the buffer is healthy", async () => {
  const liveCalls = { value: [] };
  const { svc, repo } = build(liveCalls);
  await svc.startCxBulkLoadSession({ agentEmail: "a@x.com", domain: "TAG", ringcx: { accountId: "acct1", campaignId: "camp1" }, targetSize: 2, refillThreshold: 1 });
  const before = repo.counters.updates;
  // no active calls + buffer (2) > threshold (1) -> nothing changed, no write
  await syncFromRingCx(svc);
  assert.equal(repo.counters.updates, before);
});

test("WO-4 browser watch compatibility mutator is not exported", () => {
  const { svc } = build({ value: [] });
  assert.equal(svc.watchCxBulkLoadSession, undefined, "runtime service exposes no browser watch mutator");
  const runtime = require("../../packages/shared-services/src/cxBulkLoadRuntime");
  assert.equal(runtime.watchCxBulkLoadSession, undefined, "runtime exposes no browser watch wrapper");
  const barrel = require("../../packages/shared-services/src");
  assert.equal(barrel.watchCxBulkLoadSession, undefined, "shared-services barrel exposes no browser watch export");
});

test("skip routes its terminal write through the outcome adapter (single writer)", async () => {
  const liveCalls = { value: [] };
  const { svc, outcomeAdapter } = build(liveCalls);
  await svc.startCxBulkLoadSession({ agentEmail: "a@x.com", domain: "TAG", ringcx: { accountId: "acct1", campaignId: "camp1" }, targetSize: 2, refillThreshold: 1 });
  liveCalls.value = [{ externalId: externFor("q1"), uii: "u1" }];
  await syncFromRingCx(svc);
  await svc.skipCxBulkLoadCurrent({ sessionId: "s1" });
  assert.equal(outcomeAdapter.writes.length, 1);
  assert.equal(outcomeAdapter.writes[0].source, "skip");
});

test("watch observes a buffer lead released between polls and terminalizes it once", async () => {
  const liveCalls = { value: [] };
  const { svc, outcomeAdapter } = build(liveCalls);
  await svc.startCxBulkLoadSession({ agentEmail: "a@x.com", domain: "TAG", ringcx: { accountId: "acct1", campaignId: "camp1" }, targetSize: 3, refillThreshold: 1 });
  // tick 1: q1 AND q2 both active (ambiguous -> no current promoted) — records the prior active set.
  liveCalls.value = [{ externalId: externFor("q1"), uii: "u1" }, { externalId: externFor("q2"), uii: "u2" }];
  await syncFromRingCx(svc);
  // tick 2: q2 is gone (RingCX dialed+released it between polls), q1 still active.
  liveCalls.value = [{ externalId: externFor("q1"), uii: "u1" }];
  const snap = await syncFromRingCx(svc);
  assert.equal(outcomeAdapter.writes.length, 1, "RingCX-proven released UIIs are durably terminalized");
  assert.equal(outcomeAdapter.writes[0].source, "active-call-release");
  assert.equal(outcomeAdapter.writes[0].candidate.queueItemId, "q2");
  assert.equal(outcomeAdapter.writes[0].candidate.uii, "u2");
  assert.equal(outcomeAdapter.writes[0].outcome, "did_not_connect");
  // q2 was dropped from the buffer and is not the current.
  assert.ok(!(snap.remainingQueue || []).some((c) => c.queueItemId === "q2"));
  assert.notEqual(snap.current && snap.current.queueItemId, "q2");
});

test("watch auto-advance writes one terminal outcome for the departed current", async () => {
  const liveCalls = { value: [] };
  const { svc, outcomeAdapter } = build(liveCalls);
  await svc.startCxBulkLoadSession({ agentEmail: "a@x.com", domain: "TAG", ringcx: { accountId: "acct1", campaignId: "camp1" }, targetSize: 3, refillThreshold: 1 });
  liveCalls.value = [{ externalId: externFor("q1"), uii: "u1", callState: "ACTIVE" }];
  await syncFromRingCx(svc); // q1 active
  liveCalls.value = [{ externalId: externFor("q2"), uii: "u2", callState: "ACTIVE" }];
  const snap = await syncFromRingCx(svc); // RingCX swapped to q2: the wrapped q1 is SUPERSEDED
  // TRUNK: a genuine next-call arrival ends q1's wrap window via the switch path —
  // one durable terminal for q1, and q2 promotes immediately (no hold gap).
  assert.equal(outcomeAdapter.writes.length, 1, "the superseded current is durably terminalized");
  assert.equal(outcomeAdapter.writes[0].source, "active-call-switch");
  assert.equal(outcomeAdapter.writes[0].candidate.queueItemId, "q1");
  assert.equal(outcomeAdapter.writes[0].candidate.uii, "u1");
  assert.equal(outcomeAdapter.writes[0].outcome, "answered", "connected supersede defaults to answered");
  assert.equal(snap.current.queueItemId, "q2", "the next call promotes without a hold gap");
});

test("watch release evidence clears current after a rejected disposition attempt", async () => {
  const liveCalls = { value: [] };
  const { svc, client, outcomeAdapter } = build(liveCalls);
  client.dispositionCall = async () => false;
  await svc.startCxBulkLoadSession({ agentEmail: "a@x.com", domain: "TAG", ringcx: { accountId: "acct1", campaignId: "camp1" }, targetSize: 3, refillThreshold: 1 });
  liveCalls.value = [{ externalId: externFor("q1"), uii: "u1", callState: "ACTIVE" }];
  const failed = await syncFromRingCx(svc);
  assert.equal(failed.current.queueItemId, "q1");

  const retryable = await svc.submitCxBulkLoadDisposition({ sessionId: "s1", disposition: "voicemail" });
  assert.equal(retryable.dispositionOk, false);
  assert.equal(retryable.current.queueItemId, "q1");
  assert.equal(retryable.current.outcome, "voicemail");
  assert.equal(outcomeAdapter.writes.length, 0);

  liveCalls.value = [{ externalId: externFor("q2"), uii: "u2", callState: "ACTIVE" }];
  const snap = await syncFromRingCx(svc);
  // TRUNK: q1 wraps on release, then q2's arrival supersedes it via the switch path.
  assert.equal(outcomeAdapter.writes.length, 1);
  assert.equal(outcomeAdapter.writes[0].source, "active-call-switch");
  assert.equal(outcomeAdapter.writes[0].candidate.queueItemId, "q1");
  assert.equal(outcomeAdapter.writes[0].candidate.uii, "u1");
  assert.equal(snap.current.queueItemId, "q2");
  assert.equal(snap.completedCount, 1);
});

test("TRUNK: RingCX dropping a connected current without a replacement WRAPS it (the Joe case)", async () => {
  const liveCalls = { value: [] };
  const { svc, outcomeAdapter } = build(liveCalls);
  await svc.startCxBulkLoadSession({ agentEmail: "a@x.com", domain: "TAG", ringcx: { accountId: "acct1", campaignId: "camp1" }, targetSize: 3, refillThreshold: 1 });
  liveCalls.value = [{ externalId: externFor("q1"), uii: "u1", callState: "ACTIVE" }];
  await syncFromRingCx(svc);
  liveCalls.value = [];
  const snap = await syncFromRingCx(svc);
  // Call end is not an outcome: nothing written, the lead stays on screen for the
  // agent's disposition — which remains the record.
  assert.equal(outcomeAdapter.writes.length, 0);
  assert.equal(snap.current.queueItemId, "q1");
  assert.equal(snap.current.uii, "u1");
  assert.ok(snap.current.wrap && snap.current.wrap.at, "current is held in wrap");
  assert.equal(snap.completedCount, 0);
});

test("TRUNK: the outcome entered on a wrapped current IS the record — stable, written once", async () => {
  const liveCalls = { value: [] };
  const { svc, outcomeAdapter } = build(liveCalls);
  await svc.startCxBulkLoadSession({ agentEmail: "a@x.com", domain: "TAG", ringcx: { accountId: "acct1", campaignId: "camp1" }, targetSize: 3, refillThreshold: 1 });
  liveCalls.value = [{ externalId: externFor("q1"), uii: "u1", callState: "ACTIVE" }];
  await syncFromRingCx(svc);
  liveCalls.value = [];
  await syncFromRingCx(svc); // q1 wraps

  const result = await svc.submitCxBulkLoadDisposition({ sessionId: "s1", disposition: "voicemail" });
  assert.equal(result.dispositionOk, true, "disposition on a wrapped current is the normal path");
  assert.equal(outcomeAdapter.writes.length, 1, "exactly one record");
  assert.equal(outcomeAdapter.writes[0].outcome, "voicemail", "the HUMAN's outcome, not the machine's");
  assert.equal(outcomeAdapter.writes[0].candidate.queueItemId, "q1");
  assert.equal(outcomeAdapter.writes[0].candidate.uii, "u1");
  assert.equal(result.current, null, "cleared only after the human's record landed");

  // And it stays stable: a follow-up watcher tick neither re-terminals nor resurrects it.
  const after = await syncFromRingCx(svc);
  assert.equal(outcomeAdapter.writes.length, 1);
  assert.equal(after.completedCount, 1);
});

test("overlapping account watcher ticks serialize one refill per session", async () => {
  const liveCalls = { value: [] };
  const { svc, repo, reservation } = build(liveCalls, {
    reservationPool: [
      ...rangeRows("race-refill", "fresh-day1", 1, 4),
    ],
  });
  await repo.createBulkLoadSession({
    sessionId: "s1",
    status: "running",
    phase: "READY",
    agentEmail: "a@x.com",
    domain: "TAG",
    ringcx: { accountId: "acct1", campaignId: "camp1" },
    stats: { targetSize: 2, refillThreshold: 1, familyTargets: { "fresh-day1": 2 }, claimMinutes: 10 },
    // never-connected current (no uii): releases immediately under the trunk rule,
    // keeping this test focused on its real subject — refill serialization.
    current: {
      queueItemId: "current-1",
      externId: externFor("current-1"),
      ringcx: { externId: externFor("current-1") },
      queueFamily: "fresh-day1",
    },
    acceptedBuffer: [],
    prevActiveExternIds: [externFor("current-1")],
    trace: { prevActiveCalls: [{ externId: externFor("current-1"), externalId: externFor("current-1"), uii: "u-current-1" }] },
    completed: [],
    __v: 0,
  });

  const originalReserve = reservation.reserveFromFamilyOrder;
  reservation.reserveFromFamilyOrder = async (...args) => {
    await new Promise((resolve) => setTimeout(resolve, 25));
    return originalReserve.apply(reservation, args);
  };

  await Promise.all([
    svc.watchAccountActiveCalls({ sessionId: "s1" }),
    svc.watchAccountActiveCalls({ sessionId: "s1" }),
  ]);

  assert.equal(reservation.reserves.length, 1);
  const snap = await repo.findBulkLoadSessionById("s1");
  assert.equal((snap.acceptedBuffer || []).length, 2);
  assert.equal(snap.current, null);
});

test("M11 gate 4+5: a serving-stamp miss (unowned row) does NOT promote the lead to current", async () => {
  const liveCalls = { value: [] };
  // queueStateAdapter whose serving stamp always MISSES (guarded CAS returns null = not ours).
  const stampCalls = { published: 0, serving: 0 };
  const queueStateAdapter = {
    async markCandidatePublished() { stampCalls.published += 1; return { _id: "ok" }; }, // publish owns
    async markCandidateServing() { stampCalls.serving += 1; return null; }, // serving CAS misses
  };
  const { svc } = build(liveCalls, { queueStateAdapter });
  await svc.startCxBulkLoadSession({ agentEmail: "a@x.com", domain: "TAG", ringcx: { accountId: "acct1", campaignId: "camp1" }, targetSize: 2, refillThreshold: 1 });
  liveCalls.value = [{ externalId: externFor("q1"), uii: "u1" }];
  const snap = await syncFromRingCx(svc);
  assert.ok(stampCalls.serving >= 1, "the serving stamp was attempted");
  // The CAS missed -> the lead must NOT be promoted to current (no ghost current the DB doesn't own).
  assert.equal(snap.current, null);
});

test("M11 gate 4: a publish-stamp miss fails closed — the row is not buffered and is released", async () => {
  const liveCalls = { value: [] };
  const queueStateAdapter = {
    async markCandidatePublished() { return null; }, // publish ownership CAS misses
    async markCandidateServing() { return { _id: "ok" }; },
  };
  const { svc, reservation } = build(liveCalls, { queueStateAdapter });
  const snap = await svc.startCxBulkLoadSession({ agentEmail: "a@x.com", domain: "TAG", ringcx: { accountId: "acct1", campaignId: "camp1" }, targetSize: 2, refillThreshold: 1 });
  // Nothing buffered (every publish stamp missed) and every reserved row was released.
  assert.equal((snap.acceptedBuffer || []).length, 0);
  assert.ok(reservation.released.length >= 1, "unowned published rows were released back to the pool");
});

test("fillBuffer reserves up to the deficit and publishes each reserved row one-at-a-time in reserve order, phone carried through", async () => {
  const liveCalls = { value: [] };
  // The reservation service hands rows back in family order (its Mongo concern, tested in M8);
  // the runtime's job is to publish each reserved row one-at-a-time in that order.
  const familyOrdered = [
    ...rangeRows("mickey-green", "fresh-day1", 1, 3),
    ...rangeRows("mickey-blue", "fresh-day2to10", 1, 2),
    ...rangeRows("mickey-red", "aged", 1, 1),
  ];
  const { svc, client, reservation } = build(liveCalls, { reservationPool: familyOrdered });

  const started = await svc.startCxBulkLoadSession({
    agentEmail: "mickey@example.com",
    agentExtensionId: "mickey-ext",
    domain: "TAG",
    ringcx: { accountId: "acct1", campaignId: "camp1" },
    targetSize: 6,
    refillThreshold: 1,
  });
  assert.equal(started.bufferCount, 6);
  assert.equal(reservation.reserves[0].totalLimit, 6); // deficit toward the 6-slot target

  // one publish per reserved row (publish-one-at-a-time), in reserve/family order
  assert.equal(client.calls.loads.length, 6);
  const publishedIds = client.calls.loads.map((l) => l.payload.uploadLeads[0].extendedLeadData.queueItemId);
  assert.deepEqual(publishedIds, familyOrdered.map((r) => r._id));
  // phone must survive into the published lead (publisher drops phone-less candidates)
  assert.equal(client.calls.loads[0].payload.uploadLeads[0].leadPhone, familyOrdered[0].phone);
});


test("get-leads asks RingCX for the next preview lead without staging a current call", async () => {
  const liveCalls = { value: [] };
  const requests = [];
  const leadStarter = {
    async getLeads({ session, candidate }) {
      requests.push({ sessionId: session.sessionId, candidate });
      return { ok: true, elapsedMs: 24, source: "setAgentState" };
    },
  };
  const { svc, outcomeAdapter } = build(liveCalls, { leadStarter });

  const started = await svc.startCxBulkLoadSession({
    agentEmail: "mickey@example.com",
    agentExtensionId: "mickey-ext",
    domain: "TAG",
    ringcx: { accountId: "acct1", campaignId: "camp1" },
    targetSize: 2,
    refillThreshold: 1,
  });
  assert.equal(started.bufferCount, 2);

  const snap = await svc.startCxBulkLoadGetLeads({ sessionId: "s1" });
  assert.equal(snap.getLeads.ok, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].candidate.queueItemId, "q1");
  assert.equal(snap.current, null);
  assert.equal(snap.bufferCount, 2);
  assert.equal(snap.remainingQueue[0].queueItemId, "q1");
  assert.equal(snap.stats.lastGetLeadsQueueItemId, "q1");
  assert.equal(outcomeAdapter.writes.length, 0);
});

test("bulk refill at the threshold tops the buffer back to 35 in residual family order", async () => {
  const liveCalls = { value: [] };
  const refillRows = [
    ...rangeRows("refill-green", "fresh-day1", 1, 10),
    ...rangeRows("refill-blue", "fresh-day2to10", 1, 10),
    ...rangeRows("refill-yellow", "fresh-day16to30", 1, 5),
    ...rangeRows("refill-red", "aged", 1, 5),
  ];
  const { svc, repo, client, reservation, outcomeAdapter } = build(liveCalls, { reservationPool: refillRows });
  const familyTargets = {
    "fresh-day1": 15,
    "fresh-day2to10": 10,
    "fresh-day16to30": 5,
    aged: 5,
  };
  const existingBuffer = rangeRows("existing-green", "fresh-day1", 1, 5)
    .map((row, index) => bufferCandidate(row._id, row.queueFamily, index + 1));

  await repo.createBulkLoadSession({
    sessionId: "s1",
    agentEmail: "a@x.com",
    agentExtensionId: "63914587001",
    domain: "TAG",
    status: "running",
    phase: "active",
    ringcx: { accountId: "acct1", campaignId: "camp1" },
    stats: { targetSize: 35, refillThreshold: 5, familyTargets },
    current: bufferCandidate("current-green-01", "fresh-day1", 100, { uii: "u-current" }),
    acceptedBuffer: existingBuffer,
    completed: [],
  });

  const snap = await svc.submitCxBulkLoadDisposition({ sessionId: "s1", disposition: "ANSWER" });

  assert.equal(snap.dispositionOk, true);
  assert.equal(outcomeAdapter.writes.length, 1);
  assert.equal(reservation.reserves.length, 1);
  assert.equal(reservation.reserves[0].totalLimit, 30);
  assert.deepEqual(reservation.reserves[0].familyTargets, {
    "fresh-day1": 10,
    "fresh-day2to10": 10,
    "fresh-day16to30": 5,
    aged: 5,
  });
  assert.equal(client.calls.loads.length, 30);
  const publishedIds = client.calls.loads.map((load) => load.payload.uploadLeads[0].extendedLeadData.queueItemId);
  assert.deepEqual(publishedIds, refillRows.map((row) => row._id));
  assert.equal(snap.bufferCount, 35);
  assert.equal("phone" in snap.remainingQueue[0], false);
});

test("a publish reject drops the candidate from the buffer and releases its reservation", async () => {
  const liveCalls = { value: [] };
  const pool = rangeRows("mickey-green", "fresh-day1", 1, 2);
  const { svc, client, reservation } = build(liveCalls, { reservationPool: pool });
  // Reject the SECOND publish only.
  let loadN = 0;
  client.loadLeads = async (campaignId, payload) => {
    loadN += 1;
    client.calls.loads.push({ campaignId, payload });
    if (loadN === 2) return { leadsSupplied: 1, leadsInserted: 0, rejectedRows: payload.uploadLeads };
    return { leadsSupplied: 1, leadsInserted: 1, rejectedRows: [] };
  };
  const started = await svc.startCxBulkLoadSession({
    agentEmail: "mickey@example.com",
    agentExtensionId: "mickey-ext",
    domain: "TAG",
    ringcx: { accountId: "acct1", campaignId: "camp1" },
    targetSize: 2,
    refillThreshold: 1,
  });
  assert.equal(started.bufferCount, 1); // only the accepted row stays buffered
  assert.deepEqual(reservation.released, [pool[1]._id]); // the rejected row's claim was released
});


test("PII: sanitizeSession strips raw phone digits (ani/dnis/leadPhone) from current.activeCallSummary", () => {
  const projected = sanitizeSession({
    sessionId: "s1",
    status: "running",
    phase: "dialing",
    current: {
      queueItemId: "q1",
      phone: "5125551234",
      leadPhone: "5125551234",
      activeCallSummary: { ani: "5125551234", dnis: "8005550000", state: "active", elapsedMs: 12 },
    },
    acceptedBuffer: [{ queueItemId: "q2", phone: "5125559999", activeCallSummary: { ani: "5125559999" } }],
    completed: [],
  });
  assert.equal(projected.current.phone, undefined, "top-level phone stripped");
  assert.equal(projected.current.leadPhone, undefined, "leadPhone stripped");
  assert.equal(projected.current.activeCallSummary.ani, undefined, "current ani stripped");
  assert.equal(projected.current.activeCallSummary.dnis, undefined, "current dnis stripped");
  assert.equal(projected.current.activeCallSummary.state, "active", "non-PII fields preserved");
  assert.equal(projected.remainingQueue[0].activeCallSummary.ani, undefined, "buffered candidate ani stripped too");
});

test("WO-3 manual-dial mutator is not exported", () => {
  const { svc } = build({ value: [] });
  assert.equal(svc.startCxBulkLoadNextManualCall, undefined, "runtime service exposes no manual-start mutator");
  const runtime = require("../../packages/shared-services/src/cxBulkLoadRuntime");
  assert.equal(runtime.startCxBulkLoadNextManualCall, undefined, "runtime exposes no manual-start wrapper");
  const barrel = require("../../packages/shared-services/src");
  assert.equal(barrel.startCxBulkLoadNextManualCall, undefined, "shared-services barrel exposes no manual-start export");
});

test("TRUNK: a hung-up-on ANSWERED call superseded by the next call stays correctable (connectedAt survives)", async () => {
  const liveCalls = { value: [] };
  const { svc, outcomeAdapter } = build(liveCalls);
  await svc.startCxBulkLoadSession({ agentEmail: "a@x.com", domain: "TAG", ringcx: { accountId: "acct1", campaignId: "camp1" }, targetSize: 3, refillThreshold: 1 });
  liveCalls.value = [{ externalId: externFor("q1"), uii: "u1", callState: "ACTIVE" }];
  await syncFromRingCx(svc); // q1 answered (connected latch)
  liveCalls.value = [{ externalId: externFor("q2"), uii: "u2", callState: "ACTIVE" }];
  const snap = await syncFromRingCx(svc); // prospect hung up; RingCX advanced to q2

  // The new call owns the screen; the previous answered call is provisionally
  // recorded but must stay identifiable as answered-undisposed for the modal +
  // correction lane (lastOutcome.connectedAt + no manual outcome = show the card).
  assert.equal(snap.current.queueItemId, "q2", "next call promotes without a gap");
  assert.equal(outcomeAdapter.writes.length, 1);
  assert.equal(outcomeAdapter.writes[0].candidate.queueItemId, "q1");
  assert.ok(outcomeAdapter.writes[0].candidate.connectedAt, "the terminal record knows q1 was answered");
  assert.equal(snap.lastOutcome.queueItemId, "q1");
  assert.ok(snap.lastOutcome.connectedAt, "lastOutcome carries the answered signal for the modal");
  assert.equal(snap.lastOutcome.outcome, "answered", "the machine KNOWS it was answered — the card is an opportunity, not a correction");
});
