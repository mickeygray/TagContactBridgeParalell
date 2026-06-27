"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  createCxBulkLoadRuntimeService,
  familyRefillTargets,
  DEFAULT_TARGET_BUFFER,
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
  const calls = { dispositions: [], cancels: [], loads: [], manualStarts: [] };
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
    async placeManualCall(opts) {
      calls.manualStarts.push(opts);
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
  const reserves = [];
  return {
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
  const externId = `cxbl-tag-${row._id}`.toLowerCase();
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

function build(liveCalls, overrides = {}) {
  const repo = makeRepo();
  const client = makeClient(liveCalls);
  const outcomeAdapter = makeOutcomeAdapter();
  const reservation = makeReservation(overrides.reservationPool || ROWS);
  const svc = createCxBulkLoadRuntimeService({
    repo,
    leadSource,
    publisher,
    watcher,
    outcomeAdapter,
    reservationService: reservation,
    ...(overrides.queueStateAdapter ? { queueStateAdapter: overrides.queueStateAdapter } : {}),
    ...(overrides.manualDialer ? { manualDialer: overrides.manualDialer } : {}),
    ...(overrides.leadStarter ? { leadStarter: overrides.leadStarter } : {}),
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
    newSessionId: () => "s1",
  });
  return { svc, repo, client, outcomeAdapter, reservation };
}

async function syncFromRingCx(svc, sessionId = "s1") {
  await svc.watchAccountActiveCalls({ sessionId });
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
  const { svc } = build(liveCalls);
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
  assert.equal("phone" in snap.remainingQueue[0], false);
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
  liveCalls.value = [{ externalId: "cxbl-tag-q1", uii: "u1", callState: "connected" }];
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
  liveCalls.value = [{ externalId: "cxbl-tag-q1", uii: "u1", callState: "connected" }];
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
  liveCalls.value = [{ externalId: "cxbl-tag-q1", uii: "u1" }];
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

test("a rejected dispositionCall never completes the lead (no fake outcome)", async () => {
  const liveCalls = { value: [] };
  const { svc, client, outcomeAdapter } = build(liveCalls);
  client.dispositionCall = async () => false; // RingCX soft-fail
  await svc.startCxBulkLoadSession({ agentEmail: "a@x.com", domain: "TAG", ringcx: { accountId: "acct1", campaignId: "camp1" }, targetSize: 2, refillThreshold: 1 });
  liveCalls.value = [{ externalId: "cxbl-tag-q1", uii: "u1" }];
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

test("a thrown dispositionCall leaves current retryable and visible", async () => {
  const liveCalls = { value: [] };
  const { svc, client, outcomeAdapter } = build(liveCalls);
  client.dispositionCall = async () => {
    throw new Error("ringcx-timeout");
  };
  await svc.startCxBulkLoadSession({ agentEmail: "a@x.com", domain: "TAG", ringcx: { accountId: "acct1", campaignId: "camp1" }, targetSize: 2, refillThreshold: 1 });
  liveCalls.value = [{ externalId: "cxbl-tag-q1", uii: "u1" }];
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
  liveCalls.value = [{ externalId: "cxbl-tag-q1", uii: "u1" }];
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

test("account watcher is a no-op write when there is no match and the buffer is healthy", async () => {
  const liveCalls = { value: [] };
  const { svc, repo } = build(liveCalls);
  await svc.startCxBulkLoadSession({ agentEmail: "a@x.com", domain: "TAG", ringcx: { accountId: "acct1", campaignId: "camp1" }, targetSize: 2, refillThreshold: 1 });
  const before = repo.counters.updates;
  // no active calls + buffer (2) > threshold (1) -> nothing changed, no write
  await syncFromRingCx(svc);
  assert.equal(repo.counters.updates, before);
});

test("browser watch is read-only; account watcher owns RingCX projection", async () => {
  const liveCalls = { value: [] };
  const { svc, repo } = build(liveCalls);
  await svc.startCxBulkLoadSession({ agentEmail: "a@x.com", domain: "TAG", ringcx: { accountId: "acct1", campaignId: "camp1" }, targetSize: 2, refillThreshold: 1 });
  const before = repo.counters.updates;

  liveCalls.value = [{ externalId: "cxbl-tag-q1", uii: "u1" }];
  const readOnly = await svc.watchCxBulkLoadSession({ sessionId: "s1" });

  assert.equal(repo.counters.updates, before);
  assert.equal(readOnly.current, null);

  const projected = await syncFromRingCx(svc);
  assert.equal(projected.current.queueItemId, "q1");
  assert.equal(projected.current.uii, "u1");
});

test("skip routes its terminal write through the outcome adapter (single writer)", async () => {
  const liveCalls = { value: [] };
  const { svc, outcomeAdapter } = build(liveCalls);
  await svc.startCxBulkLoadSession({ agentEmail: "a@x.com", domain: "TAG", ringcx: { accountId: "acct1", campaignId: "camp1" }, targetSize: 2, refillThreshold: 1 });
  liveCalls.value = [{ externalId: "cxbl-tag-q1", uii: "u1" }];
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
  liveCalls.value = [{ externalId: "cxbl-tag-q1", uii: "u1" }, { externalId: "cxbl-tag-q2", uii: "u2" }];
  await syncFromRingCx(svc);
  // tick 2: q2 is gone (RingCX dialed+released it between polls), q1 still active.
  liveCalls.value = [{ externalId: "cxbl-tag-q1", uii: "u1" }];
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
  liveCalls.value = [{ externalId: "cxbl-tag-q1", uii: "u1" }];
  await syncFromRingCx(svc); // q1 active
  liveCalls.value = [{ externalId: "cxbl-tag-q2", uii: "u2" }];
  await syncFromRingCx(svc); // RingCX swapped to q2 -> q1 auto-completes
  assert.equal(outcomeAdapter.writes.length, 1, "the departed current is durably terminalized");
  assert.equal(outcomeAdapter.writes[0].source, "active-call-release");
  assert.equal(outcomeAdapter.writes[0].candidate.queueItemId, "q1");
  assert.equal(outcomeAdapter.writes[0].candidate.uii, "u1");
  assert.equal(outcomeAdapter.writes[0].outcome, "did_not_connect");
});

test("watch clears and terminalizes current when RingCX drops it without a replacement", async () => {
  const liveCalls = { value: [] };
  const { svc, outcomeAdapter } = build(liveCalls);
  await svc.startCxBulkLoadSession({ agentEmail: "a@x.com", domain: "TAG", ringcx: { accountId: "acct1", campaignId: "camp1" }, targetSize: 3, refillThreshold: 1 });
  liveCalls.value = [{ externalId: "cxbl-tag-q1", uii: "u1" }];
  await syncFromRingCx(svc);
  liveCalls.value = [];
  const snap = await syncFromRingCx(svc);
  assert.equal(outcomeAdapter.writes.length, 1);
  assert.equal(outcomeAdapter.writes[0].source, "active-call-release");
  assert.equal(snap.current, null);
  assert.equal(snap.completedCount, 1);
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
    current: {
      queueItemId: "current-1",
      externId: "cxbl-tag-current-1",
      ringcx: { externId: "cxbl-tag-current-1" },
      queueFamily: "fresh-day1",
      uii: "u-current-1",
    },
    acceptedBuffer: [],
    prevActiveExternIds: ["cxbl-tag-current-1"],
    trace: { prevActiveCalls: [{ externId: "cxbl-tag-current-1", externalId: "cxbl-tag-current-1", uii: "u-current-1" }] },
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
  liveCalls.value = [{ externalId: "cxbl-tag-q1", uii: "u1" }];
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

test("manual start-next probe promotes the first accepted buffer lead and waits for watcher UII", async () => {
  const liveCalls = { value: [] };
  const starts = [];
  const manualDialer = {
    async startNext({ candidate, ringDuration }) {
      starts.push({ candidate, ringDuration });
      return { ok: true, elapsedMs: 42 };
    },
  };
  const { svc, outcomeAdapter } = build(liveCalls, { manualDialer });

  const started = await svc.startCxBulkLoadSession({
    agentEmail: "mickey@example.com",
    agentExtensionId: "mickey-ext",
    domain: "TAG",
    ringcx: { accountId: "acct1", campaignId: "camp1" },
    targetSize: 2,
    refillThreshold: 1,
  });
  assert.equal(started.bufferCount, 2);

  const snap = await svc.startCxBulkLoadNextManualCall({ sessionId: "s1" });
  assert.equal(snap.manualStart.ok, true);
  assert.equal(starts.length, 1);
  assert.equal(starts[0].candidate.queueItemId, "q1");
  assert.equal(snap.current.queueItemId, "q1");
  assert.equal(snap.current.uii, null);
  assert.equal(snap.current.manualStartPending, true);
  assert.deepEqual(snap.current.matchReasons, ["manual-start-request"]);
  assert.equal(snap.bufferCount, 1);
  assert.equal(snap.remainingQueue[0].queueItemId, "q2");
  assert.equal(outcomeAdapter.writes.length, 0);
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

