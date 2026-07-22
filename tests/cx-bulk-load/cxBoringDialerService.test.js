"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { createCxBoringDialer } = require("../../packages/shared-services/src/cxBoringDialerService");
const { buildExternId } = require("../../packages/shared-services/src/cxBulkLoadLeadSourceService");

const AGENT = Object.freeze({
  sessionId: "cxbl-session-123456789abc",
  domain: "TAG",
  agentId: "agent-1",
  accountId: "account-1",
  campaignId: "campaign-1",
});

function lead(queueItemId, queueFamily = "fresh-day1", extra = {}) {
  return {
    queueItemId,
    domain: "TAG",
    caseId: Number(String(queueItemId).replace(/\D+/g, "")) || queueItemId,
    name: `Lead ${queueItemId}`,
    phone: `310555${String(queueItemId).replace(/\D+/g, "").padStart(4, "0").slice(-4)}`,
    queueFamily,
    ...extra,
  };
}

function externFor(queueItemId) {
  return buildExternId({ domain: AGENT.domain, sessionId: AGENT.sessionId, queueItemId });
}

function buildHarness(options = {}) {
  const calls = {
    listEligible: [],
    claims: [],
    published: [],
    releases: [],
    loads: [],
    dispositions: [],
    cancels: [],
    hangups: [],
    candidateLookups: [],
    outstandingProjections: [],
    currentProjections: [],
    completedProjections: [],
    retiredProjections: [],
    updatedProjections: [],
    terminals: [],
    outstandingReads: 0,
  };
  const state = {
    outstanding: [...(options.outstanding || [])],
    activeCalls: [...(options.activeCalls || [])],
    completed: [...(options.completed || [])],
    knownLeads: [...(options.knownLeads || [])],
    activeError: options.activeError || null,
  };
  const rejectedIds = new Set(options.rejectedIds || []);
  const terminalKeys = new Set(options.terminalKeys || []);
  let terminalFailuresRemaining = Number(options.terminalFailures) || 0;
  let terminalAttemptCount = 0;
  const releaseResults = [...(options.releaseResults || [])];

  const inventory = {
    async listOwned() {
      const rows = options.ownedRows || [...state.knownLeads, ...state.outstanding];
      const byId = new Map();
      for (const row of rows) {
        if (row?.queueItemId) byId.set(String(row.queueItemId), row);
      }
      return [...byId.values()];
    },
    async listEligible(params) {
      calls.listEligible.push(params);
      return [...(options.eligibleRows || [])];
    },
    async claim(rows, context) {
      calls.claims.push({ rows: [...rows], context });
      return typeof options.claim === "function" ? options.claim(rows) : [...rows];
    },
    async release(rows, reason) {
      calls.releases.push({ rows: [...rows], reason });
      return releaseResults.length
        ? releaseResults.shift()
        : (options.releaseResponse || { ok: true, released: rows, failed: [] });
    },
    async markPublished(rows, context) {
      calls.published.push({ rows: [...rows], context });
      if (options.markPublishedError) throw options.markPublishedError;
      return rows;
    },
    async findByExtern(agent, externId) {
      calls.candidateLookups.push({ agent, externId });
      return state.knownLeads.find((row) => row.externId === externId) || null;
    },
    async normalizeIncoming(post) {
      return post?.lead || post;
    },
    isHardEligible(row) {
      return Boolean(row) && row.blocked !== true && row.appointment !== true && row.client !== true && row.dnc !== true;
    },
  };

  const ringcx = {
    async listOutstanding() {
      calls.outstandingReads += 1;
      return state.outstanding.map((row) => ({ ...row }));
    },
    async load(agent, rows) {
      calls.loads.push({ agent, rows: [...rows] });
      if (options.loadError) throw options.loadError;
      const acceptedCandidates = rows.filter((row) => !rejectedIds.has(row.queueItemId));
      state.knownLeads.push(...acceptedCandidates);
      state.outstanding.push(...acceptedCandidates);
      return {
        accepted: acceptedCandidates.map((candidate) => ({
          queueItemId: candidate.queueItemId,
          externId: candidate.externId,
          candidate,
        })),
        rejected: rows.filter((row) => rejectedIds.has(row.queueItemId)),
      };
    },
    async listActiveCalls() {
      if (state.activeError) throw state.activeError;
      return state.activeCalls.map((row) => ({ ...row }));
    },
    async disposition(agent, payload) {
      calls.dispositions.push({ agent, payload });
      return options.dispositionResponse || { ok: true, uii: payload.uii };
    },
    async listCompleted() {
      return state.completed.map((row) => ({ ...row }));
    },
    async cancel(agent, externIds) {
      calls.cancels.push({ agent, externIds: [...externIds] });
      if (options.cancelError) throw options.cancelError;
      if (options.cancelResponse?.ok === false) return options.cancelResponse;
      state.outstanding = state.outstanding.filter((row) => !externIds.includes(row.externId));
      return options.cancelResponse || { ok: true };
    },
    async hangup(agent, uii) {
      calls.hangups.push({ agent, uii });
      if (options.hangupError) throw options.hangupError;
      const response = options.hangupResponses?.[uii] || options.hangupResponse;
      if (response?.ok === false) return response;
      state.activeCalls = state.activeCalls.filter((row) => String(row?.uii || "") !== String(uii));
      return response || { ok: true };
    },
  };

  const projection = {
    async replaceOutstanding(agent, rows) {
      calls.outstandingProjections.push({ agent, rows: [...rows] });
    },
    async setCurrent(agent, current, settings) {
      calls.currentProjections.push({ agent, current, settings });
    },
    async appendCompleted(agent, completed) {
      calls.completedProjections.push({ agent, completed });
    },
    async retireObserved(agent, identity) {
      calls.retiredProjections.push({ agent, identity });
    },
    async updateObserved(agent, identity, patch) {
      calls.updatedProjections.push({ agent, identity, patch });
      const row = state.completed.find((candidate) => candidate.externId === identity.externId && candidate.uii === identity.uii);
      if (row) Object.assign(row, patch);
    },
  };

  const terminal = {
    async hasTerminalOutcome({ candidate = {} } = {}) {
      return terminalKeys.has(`${candidate.queueItemId || ""}:${candidate.uii || ""}`);
    },
    async persistTerminalOutcome(input) {
      terminalAttemptCount += 1;
      const queueItemId = input.candidate?.queueItemId || "";
      const uii = input.candidate?.uii || "";
      const key = `${queueItemId}:${uii}`;
      const written = !terminalKeys.has(key);
      calls.terminals.push(input);
      if (terminalFailuresRemaining > 0) {
        terminalFailuresRemaining -= 1;
        throw new Error("terminal-write-failed");
      }
      if (Number(options.terminalFailureAt) === terminalAttemptCount) {
        throw new Error("terminal-write-failed");
      }
      terminalKeys.add(key);
      return { written, idemKey: key };
    },
  };

  return {
    service: createCxBoringDialer({ inventory, ringcx, projection, terminal }),
    calls,
    state,
  };
}

test("buildPool applies the fixed hard filters and preserves FIFO inside four buckets", async () => {
  const rows = [
    lead("g1", "fresh-day1"),
    lead("b1", "fresh-day2to10"),
    lead("g2", "fresh-day1"),
    lead("y1", "fresh-day16to30"),
    lead("a1", "aged"),
    lead("blocked", "fresh-day1", { dnc: true }),
    lead("unknown", "banana"),
  ];
  const { service, calls } = buildHarness({ eligibleRows: rows });

  const pool = await service.buildPool({ acceptedStatusIds: [11, 12], cadenceWindowMinutes: 90 });

  assert.deepEqual(pool["fresh-day1"].map((row) => row.queueItemId), ["g1", "g2"]);
  assert.deepEqual(pool["fresh-day2to10"].map((row) => row.queueItemId), ["b1"]);
  assert.deepEqual(pool["fresh-day16to30"].map((row) => row.queueItemId), ["y1"]);
  assert.deepEqual(pool.aged.map((row) => row.queueItemId), ["a1"]);
  assert.deepEqual(calls.listEligible[0], {
    acceptedStatusIds: [11, 12],
    excludeAppointments: true,
    excludeDnc: true,
    excludeClients: true,
    excludeNonProspects: true,
    cadenceWindowMinutes: 90,
  });
});

test("loadLeads claims once, uses session-scoped externs, and releases RingCX rejects", async () => {
  const existing = { ...lead("old", "fresh-day1", { caseId: 100 }), externId: externFor("old") };
  const { service, calls } = buildHarness({ outstanding: [existing], rejectedIds: ["q3"] });

  const result = await service.loadLeads(AGENT, [
    lead("duplicate-case", "fresh-day1", { caseId: 100 }),
    lead("q2", "fresh-day2to10"),
    lead("q3", "aged"),
  ]);

  assert.deepEqual(calls.claims[0].rows.map((row) => row.queueItemId), ["q2", "q3"]);
  assert.equal(calls.loads.length, 1);
  assert.equal(calls.loads[0].rows[0].externId, externFor("q2"));
  assert.deepEqual(result.accepted.map((row) => row.queueItemId), ["q2"]);
  assert.deepEqual(result.rejected.map((row) => row.queueItemId), ["q3"]);
  assert.equal(calls.releases.length, 1);
  assert.equal(calls.releases[0].reason, "ringcx-rejected");
  assert.deepEqual(calls.releases[0].rows.map((row) => row.queueItemId), ["q3"]);
  assert.deepEqual(calls.published[0].rows.map((row) => row.queueItemId), ["q2"]);
});

test("loadLeads cancels exact externs before releasing a claim after an ambiguous load failure", async () => {
  const { service, calls } = buildHarness({ loadError: new Error("RingCX unavailable") });

  await assert.rejects(() => service.loadLeads(AGENT, [lead("q1")]), /RingCX unavailable/);

  assert.deepEqual(calls.cancels[0].externIds, [externFor("q1")]);
  assert.equal(calls.releases.length, 1);
  assert.equal(calls.releases[0].reason, "ringcx-load-failed-cancelled");
  assert.deepEqual(calls.releases[0].rows.map((row) => row.queueItemId), ["q1"]);
});

test("loadLeads keeps the local claim when RingCX cannot confirm cleanup", async () => {
  const { service, calls } = buildHarness({
    loadError: new Error("timeout-after-commit"),
    cancelResponse: { ok: false, reason: "cleanup-unconfirmed" },
  });

  await assert.rejects(() => service.loadLeads(AGENT, [lead("q1")]), /timeout-after-commit/);

  assert.equal(calls.cancels.length, 1);
  assert.equal(calls.releases.length, 0);
});

test("loadLeads cancels accepted externs if the local published stamp fails", async () => {
  const { service, calls } = buildHarness({
    markPublishedError: new Error("publish-stamp-failed"),
  });

  await assert.rejects(() => service.loadLeads(AGENT, [lead("q1")]), /publish-stamp-failed/);

  assert.deepEqual(calls.cancels.at(-1).externIds, [externFor("q1")]);
  assert.equal(calls.releases.at(-1).reason, "ringcx-published-local-stamp-failed");
  assert.deepEqual(calls.releases.at(-1).rows.map((row) => row.queueItemId), ["q1"]);
});

test("loadLeads holds accepted claims if post-publish cleanup cannot be proven", async () => {
  const { service, calls } = buildHarness({
    markPublishedError: new Error("publish-stamp-failed"),
    cancelResponse: { ok: false, reason: "cleanup-unconfirmed" },
  });

  await assert.rejects(() => service.loadLeads(AGENT, [lead("q1")]), /publish-stamp-failed/);

  assert.equal(calls.cancels.length, 1);
  assert.equal(calls.releases.length, 0);
});

test("incoming leads use the same loader and hard-ineligible posts never reach RingCX", async () => {
  const { service, calls } = buildHarness();

  const blocked = await service.addIncomingLead(AGENT, { lead: lead("q1", "fresh-day1", { client: true }) });
  const accepted = await service.addIncomingLead(AGENT, { lead: lead("q2", "fresh-day1") });

  assert.equal(blocked.reason, "not-eligible");
  assert.equal(accepted.accepted.length, 1);
  assert.equal(calls.loads.length, 1);
  assert.equal(calls.loads[0].rows[0].queueItemId, "q2");
});

test("refill reads RingCX outstanding count, not an app-side append log", async () => {
  const firstSix = Array.from({ length: 6 }, (_, index) => ({
    ...lead(`g${index + 1}`, "fresh-day1"),
    externId: externFor(`g${index + 1}`),
  }));
  const { service, calls, state } = buildHarness({ outstanding: firstSix });
  const pool = {
    "fresh-day1": [],
    "fresh-day2to10": [
      lead("b1", "fresh-day2to10", { caseId: 101 }),
      lead("b2", "fresh-day2to10", { caseId: 102 }),
      lead("b3", "fresh-day2to10", { caseId: 103 }),
    ],
    "fresh-day16to30": [],
    aged: [],
  };
  const rules = {
    refillAt: 5,
    familyTargets: { "fresh-day1": 5, "fresh-day2to10": 3, "fresh-day16to30": 0, aged: 0 },
  };

  const above = await service.refillAgent(AGENT, pool, rules);
  assert.equal(above.reason, "queue-above-refill");
  assert.equal(calls.loads.length, 0);

  state.outstanding = state.outstanding.slice(0, 5);
  const refilled = await service.refillAgent(AGENT, pool, rules);
  assert.equal(refilled.accepted.length, 3);
  assert.deepEqual(calls.loads[0].rows.map((row) => row.queueItemId), ["b1", "b2", "b3"]);
});

test("refill reuses the button's fresh RingCX extern snapshot instead of reading twice", async () => {
  const existing = { ...lead("g1", "fresh-day1"), externId: externFor("g1") };
  const next = lead("g2", "fresh-day1");
  const { service, calls } = buildHarness();

  const result = await service.refillAgent(AGENT, {
    "fresh-day1": [next],
    "fresh-day2to10": [],
    "fresh-day16to30": [],
    aged: [],
  }, {
    outstanding: [existing],
    refillAt: 2,
    familyTargets: { "fresh-day1": 2, "fresh-day2to10": 0, "fresh-day16to30": 0, aged: 0 },
  });

  assert.equal(calls.outstandingReads, 1, "only the post-publish verification re-reads RingCX");
  assert.deepEqual(result.accepted.map((row) => row.queueItemId), ["g2"]);
});

test("refreshAgent rebuilds projection from RingCX without loading or claiming", async () => {
  const existing = { ...lead("q1"), externId: externFor("q1") };
  const { service, calls } = buildHarness({ outstanding: [existing] });

  const result = await service.refreshAgent(AGENT);

  assert.equal(result.outstanding.length, 1);
  assert.equal(calls.claims.length, 0);
  assert.equal(calls.loads.length, 0);
  assert.deepEqual(calls.outstandingProjections[0].rows.map((row) => row.queueItemId), ["q1"]);
});

test("observeAgent projects the RingCX extern/UII and clears only after a confirmed empty read", async () => {
  const candidate = { ...lead("q1"), externId: externFor("q1") };
  const { service, calls, state } = buildHarness({
    outstanding: [candidate],
    knownLeads: [candidate],
    activeCalls: [{ externalId: candidate.externId, uii: "u1", callState: "ACTIVE" }],
  });

  const matched = await service.observeAgent(AGENT);
  assert.equal(matched.status, "matched");
  assert.equal(matched.current.queueItemId, "q1");
  assert.equal(matched.current.uii, "u1");

  state.activeCalls = [];
  const empty = await service.observeAgent(AGENT);
  assert.equal(empty.status, "empty");
  assert.equal(calls.currentProjections.at(-1).current, null);
});

test("observeAgent resolves one exact session call through local inventory", async () => {
  const candidate = { ...lead("q1"), externId: externFor("q1") };
  const { service, calls } = buildHarness({
    knownLeads: [candidate],
    activeCalls: [{ externalId: candidate.externId, uii: "u1", callState: "ACTIVE" }],
  });

  const result = await service.observeAgent(AGENT);

  assert.equal(result.status, "matched");
  assert.equal(result.current.queueItemId, "q1");
  assert.equal(result.current.uii, "u1");
  assert.deepEqual(calls.candidateLookups.map((entry) => entry.externId), [candidate.externId]);
  assert.equal(calls.outstandingProjections.length, 0);
});

test("observeAgent clears current instead of projecting the old call when two session calls overlap", async () => {
  const oldCandidate = { ...lead("q1"), externId: externFor("q1") };
  const nextCandidate = { ...lead("q2"), externId: externFor("q2") };
  const { service, calls } = buildHarness({
    outstanding: [oldCandidate],
    knownLeads: [oldCandidate],
    activeCalls: [
      { externalId: oldCandidate.externId, uii: "u-old", callState: "ACTIVE" },
      { externalId: nextCandidate.externId, uii: "u-new", callState: "ACTIVE" },
    ],
  });

  const result = await service.observeAgent(AGENT);

  assert.equal(result.ok, false);
  assert.equal(result.status, "ambiguous");
  assert.deepEqual(
    calls.currentProjections.map((entry) => entry.current?.queueItemId || null),
    [null],
  );
  assert.deepEqual(
    calls.currentProjections[0].settings.observedCalls.map((call) => [call.externId, call.uii]),
    [[oldCandidate.externId, "u-old"], [nextCandidate.externId, "u-new"]],
  );
});

test("an unresolved first overlap cannot hide a later exact session UII sighting", async () => {
  const unresolved = { ...lead("q1"), externId: externFor("q1") };
  const owned = { ...lead("q2"), externId: externFor("q2") };
  const { service, calls } = buildHarness({
    knownLeads: [owned],
    activeCalls: [
      { externalId: unresolved.externId, uii: "u-unresolved", callState: "ACTIVE" },
      { externalId: owned.externId, uii: "u-owned", callState: "ACTIVE" },
    ],
  });

  const result = await service.observeAgent(AGENT);

  assert.equal(result.status, "ambiguous");
  assert.deepEqual(
    calls.currentProjections[0].settings.observedCalls.map((row) => row.uii),
    ["u-unresolved", "u-owned"],
  );
});

test("observeAgent discards completed UIIs before choosing the one new call", async () => {
  const oldCandidate = { ...lead("q1"), externId: externFor("q1") };
  const nextCandidate = { ...lead("q2"), externId: externFor("q2") };
  const { service, calls } = buildHarness({
    knownLeads: [nextCandidate],
    activeCalls: [
      { externalId: oldCandidate.externId, uii: "u-old", callState: "ACTIVE" },
      { externalId: nextCandidate.externId, uii: "u-new", callState: "ACTIVE" },
    ],
  });

  const result = await service.observeAgent({
    ...AGENT,
    completed: [{ ...oldCandidate, uii: "u-old", outcome: "did_not_connect" }],
  });

  assert.equal(result.status, "matched");
  assert.equal(result.current.queueItemId, "q2");
  assert.equal(result.current.uii, "u-new");
  assert.equal(calls.currentProjections.at(-1).current.queueItemId, "q2");
});

test("observeAgent never reopens a completed UII that RingCX still reports", async () => {
  const candidate = { ...lead("q1"), externId: externFor("q1") };
  const { service, calls } = buildHarness({
    knownLeads: [candidate],
    activeCalls: [{ externalId: candidate.externId, uii: "u1", callState: "ACTIVE" }],
  });

  const result = await service.observeAgent({
    ...AGENT,
    completed: [{ ...candidate, uii: "u1", outcome: "voicemail" }],
  });

  assert.equal(result.reason, "active-call-uii-already-completed");
  assert.equal(calls.currentProjections.at(-1).current, null);
});

test("observeAgent never reopens a UII already present in the durable terminal ledger", async () => {
  const candidate = { ...lead("q1"), externId: externFor("q1") };
  const { service, calls } = buildHarness({
    knownLeads: [candidate],
    activeCalls: [{ externalId: candidate.externId, uii: "u1", callState: "ACTIVE" }],
    terminalKeys: ["q1:u1"],
  });

  const result = await service.observeAgent({
    ...AGENT,
    completed: Array.from({ length: 200 }, (_, index) => ({ queueItemId: `old-${index}`, uii: `old-u-${index}` })),
  });

  assert.equal(result.reason, "active-call-uii-already-terminal");
  assert.equal(calls.currentProjections.at(-1).current, null);
});

test("observeAgent drops a durable old UII before choosing the one new overlapping call", async () => {
  const oldCandidate = { ...lead("q1"), externId: externFor("q1") };
  const nextCandidate = { ...lead("q2"), externId: externFor("q2") };
  const { service } = buildHarness({
    // The old row may already have drained and released its reservation; the durable
    // UII fact must retire it before local inventory lookup.
    knownLeads: [nextCandidate],
    activeCalls: [
      { externalId: oldCandidate.externId, uii: "u-old", callState: "ACTIVE" },
      { externalId: nextCandidate.externId, uii: "u-new", callState: "ACTIVE" },
    ],
    terminalKeys: ["q1:u-old"],
  });

  const result = await service.observeAgent(AGENT);

  assert.equal(result.status, "matched");
  assert.equal(result.current.queueItemId, "q2");
  assert.equal(result.current.uii, "u-new");
});

test("observeAgent blanks current but keeps release inference off when the RingCX read fails", async () => {
  const { service, calls } = buildHarness({ activeError: new Error("429") });

  const result = await service.observeAgent(AGENT);

  assert.equal(result.reason, "ringcx-read-failed");
  assert.deepEqual(calls.currentProjections.map((entry) => entry.current), [null]);
});

test("finishCall requires and enforces the displayed extern/UII identity", async () => {
  const active = { ...lead("q2"), externId: externFor("q2") };
  const stale = { ...lead("q1"), externId: externFor("q1") };
  const expectations = [
    undefined,
    { expectedExternId: active.externId },
    { expectedUii: "u-active" },
    { expectedExternId: stale.externId, expectedUii: "u-active" },
    { expectedExternId: active.externId, expectedUii: "u-stale" },
  ];
  const attempts = [];

  for (const expected of expectations) {
    const harness = buildHarness({
      knownLeads: [active],
      activeCalls: [{ externalId: active.externId, uii: "u-active", callState: "ACTIVE" }],
    });
    const result = await harness.service.finishCall(AGENT, "answered", {
      ...(expected || {}),
      nextAction: "call_wrap",
    });
    attempts.push({ result, calls: harness.calls });
  }

  assert.deepEqual(attempts.map((attempt) => attempt.result.ok), [false, false, false, false, false]);
  assert.deepEqual(attempts.map((attempt) => attempt.calls.dispositions.length), [0, 0, 0, 0, 0]);
  assert.deepEqual(attempts.map((attempt) => attempt.calls.terminals.length), [0, 0, 0, 0, 0]);
});

test("finishCall asks RingCX for identity so a stale outstanding cache cannot veto a real call", async () => {
  const candidate = { ...lead("q1"), externId: externFor("q1") };
  const { service, calls } = buildHarness({
    outstanding: [],
    knownLeads: [candidate],
    activeCalls: [{ externalId: candidate.externId, uii: "u1", callState: "ACTIVE" }],
  });

  const result = await service.finishCall(AGENT, "did not connect", {
    expectedExternId: candidate.externId,
    expectedUii: "u1",
    nextAction: "cadence",
  });

  assert.equal(result.ok, true);
  assert.equal(calls.dispositions[0].payload.uii, "u1");
  assert.equal(calls.dispositions[0].payload.outcome, "did_not_connect");
  assert.deepEqual(calls.hangups.map((entry) => entry.uii), ["u1"]);
  assert.equal(calls.terminals[0].candidate.queueItemId, "q1");
  assert.equal(calls.terminals[0].source, "agent-button");
  assert.equal(calls.completedProjections[0].completed.queueItemId, "q1");
  assert.equal(calls.currentProjections.at(-1).current, null);
});

test("finishCall never records an outcome rejected by RingCX", async () => {
  const candidate = { ...lead("q1"), externId: externFor("q1") };
  const { service, calls } = buildHarness({
    knownLeads: [candidate],
    activeCalls: [{ externalId: candidate.externId, uii: "u1", callState: "ACTIVE" }],
    dispositionResponse: { ok: false, reason: "rejected" },
  });

  const result = await service.finishCall(AGENT, "answered", {
    expectedExternId: candidate.externId,
    expectedUii: "u1",
    nextAction: "call_wrap",
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "ringcx-disposition-rejected");
  assert.equal(calls.terminals.length, 0);
  assert.equal(calls.completedProjections.length, 0);
  assert.equal(calls.currentProjections.length, 0);
});

test("finishCall refuses an active call from another session without phone guessing", async () => {
  const { service, calls } = buildHarness({
    activeCalls: [{ externalId: "cxbl-tag-oldsession-q9", uii: "u9", ani: "3105550009" }],
  });

  const result = await service.finishCall(AGENT, "answered", {
    expectedExternId: "cxbl-tag-oldsession-q9",
    expectedUii: "u9",
    nextAction: "call_wrap",
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "expected-identity-owned-elsewhere");
  assert.equal(calls.dispositions.length, 0);
  assert.equal(calls.terminals.length, 0);
});

test("recordCompleted writes only session-owned UII-bearing RingCX outcomes", async () => {
  const valid = {
    ...lead("q1"),
    externId: externFor("q1"),
    uii: "u1",
    outcome: "did_not_connect",
    systemDisposition: "CONGESTION",
  };
  const { service, calls } = buildHarness({
    completed: [
      valid,
      { ...valid, queueItemId: "q2", externId: "cxbl-tag-oldsession-q2" },
      { ...valid, queueItemId: "q3", externId: externFor("q3"), uii: null },
      { ...valid, queueItemId: "q4", externId: externFor("q4"), uii: "u4", outcome: "unknown" },
    ],
  });

  const result = await service.recordCompleted(AGENT);

  assert.equal(result.written.length, 1);
  assert.equal(result.skipped.length, 3);
  assert.equal(calls.terminals[0].source, "ringcx-system-disposition");
  assert.equal(calls.terminals[0].systemDisposition, "CONGESTION");
  assert.equal(calls.completedProjections[0].completed.queueItemId, "q1");
});

test("an agent-button outcome cannot be relabeled by a later RingCX terminal read", async () => {
  const candidate = { ...lead("q1"), externId: externFor("q1") };
  const { service, calls, state } = buildHarness({
    knownLeads: [candidate],
    activeCalls: [{ externalId: candidate.externId, uii: "u1", callState: "ACTIVE" }],
  });

  await service.finishCall(AGENT, "voicemail", {
    expectedExternId: candidate.externId,
    expectedUii: "u1",
    nextAction: "ringcx_vm_drop",
  });
  state.completed.push({ ...candidate, uii: "u1", outcome: "answered", systemDisposition: "ANSWER" });
  const reread = await service.recordCompleted(AGENT);

  assert.equal(reread.written[0].written, false);
  assert.equal(calls.completedProjections.length, 1);
  assert.equal(calls.completedProjections[0].completed.outcome, "voicemail");
  assert.equal(calls.hangups.length, 0, "VM Drop owns call completion");
});

test("finishCall rejects a button whose declared destination does not match its outcome", async () => {
  const candidate = { ...lead("q1"), externId: externFor("q1") };
  const { service, calls } = buildHarness({
    knownLeads: [candidate],
    activeCalls: [{ externalId: candidate.externId, uii: "u1", callState: "ACTIVE" }],
  });

  const result = await service.finishCall(AGENT, "bad_number", {
    expectedExternId: candidate.externId,
    expectedUii: "u1",
    nextAction: "cadence",
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "button-action-mismatch");
  assert.equal(calls.dispositions.length, 0);
  assert.equal(calls.hangups.length, 0);
  assert.equal(calls.terminals.length, 0);
});

test("a duplicate agent-button retry cannot recreate or relabel the completed projection", async () => {
  const candidate = { ...lead("q1"), externId: externFor("q1") };
  const { service, calls } = buildHarness({
    knownLeads: [candidate],
    activeCalls: [{ externalId: candidate.externId, uii: "u1", callState: "ACTIVE" }],
  });
  const expected = {
    expectedExternId: candidate.externId,
    expectedUii: "u1",
    nextAction: "ringcx_vm_drop",
  };

  await service.finishCall(AGENT, "voicemail", expected);
  const retry = await service.finishCall(AGENT, "answered", { ...expected, nextAction: "call_wrap" });

  assert.equal(retry.reason, "active-call-uii-already-terminal");
  assert.equal(calls.dispositions.length, 1);
  assert.equal(calls.terminals.length, 1);
  assert.equal(calls.completedProjections.length, 1);
  assert.equal(calls.completedProjections[0].completed.outcome, "voicemail");
});

test("finishCall rejects outcomes outside the four-button vocabulary", async () => {
  const candidate = { ...lead("q1"), externId: externFor("q1") };
  const { service, calls } = buildHarness({
    knownLeads: [candidate],
    activeCalls: [{ externalId: candidate.externId, uii: "u1", callState: "ACTIVE" }],
  });

  const result = await service.finishCall(AGENT, "banana", {
    expectedExternId: candidate.externId,
    expectedUii: "u1",
  });

  assert.equal(result.reason, "invalid-outcome");
  assert.equal(calls.dispositions.length, 0);
  assert.equal(calls.terminals.length, 0);
});

test("resetAgent is the sole cancellation lane and closes the in-flight call", async () => {
  const buffered = { ...lead("q1"), externId: externFor("q1") };
  const current = { ...lead("q2"), externId: externFor("q2") };
  const { service, calls } = buildHarness({
    outstanding: [buffered, current],
    knownLeads: [current],
    activeCalls: [{ externalId: current.externId, uii: "u2", callState: "ACTIVE" }],
  });

  const result = await service.resetAgent({ ...AGENT, current: { ...current, uii: "u2" } }, "manual-test");

  assert.equal(result.ok, true);
  assert.deepEqual(new Set(calls.cancels[0].externIds), new Set([buffered.externId, current.externId]));
  assert.equal(calls.hangups[0].uii, "u2");
  assert.equal(calls.terminals[0].source, "manual-reset");
  assert.equal(calls.terminals[0].outcome, "did_not_connect");
  assert.equal(calls.releases[0].reason, "session-killed");
  assert.deepEqual(new Set(calls.releases[0].rows.map((row) => row.queueItemId)), new Set(["q1", "q2"]));
  assert.deepEqual(calls.outstandingProjections.at(-1).rows, []);
  assert.equal(calls.currentProjections.at(-1).current, null);
});

test("resetAgent keeps local ownership when RingCX rejects cancellation", async () => {
  const buffered = { ...lead("q1"), externId: externFor("q1") };
  const { service, calls } = buildHarness({
    outstanding: [buffered],
    cancelResponse: { ok: false, reason: "rejected" },
  });

  const result = await service.resetAgent(AGENT, "manual-test");

  assert.equal(result.reason, "ringcx-cancel-rejected");
  assert.equal(calls.releases.length, 0);
  assert.equal(calls.outstandingProjections.length, 0);
  assert.equal(calls.currentProjections.length, 0);
});

test("resetAgent does not clear or release after a failed active hangup", async () => {
  const current = { ...lead("q2"), externId: externFor("q2") };
  const { service, calls } = buildHarness({
    outstanding: [current],
    knownLeads: [current],
    activeCalls: [{ externalId: current.externId, uii: "u2", callState: "ACTIVE" }],
    hangupResponse: { ok: false, reason: "rejected" },
  });

  const result = await service.resetAgent({ ...AGENT, current: { ...current, uii: "u2" } }, "manual-test");

  assert.equal(result.reason, "ringcx-hangup-rejected");
  assert.equal(calls.terminals.length, 0);
  assert.equal(calls.releases.length, 0);
  assert.equal(calls.outstandingProjections.length, 0);
  assert.equal(calls.currentProjections.length, 0);
});

test("resetAgent retries the remembered current terminal after RingCX is already empty", async () => {
  const current = { ...lead("q2"), externId: externFor("q2"), uii: "u2" };
  const { service, calls, state } = buildHarness({
    outstanding: [current],
    knownLeads: [current],
    activeCalls: [{ externalId: current.externId, uii: current.uii, callState: "ACTIVE" }],
    terminalFailures: 1,
  });
  const agent = { ...AGENT, current };

  await assert.rejects(() => service.resetAgent(agent, "manual-test"), /terminal-write-failed/);
  state.activeCalls = [];
  const retried = await service.resetAgent(agent, "manual-test");

  assert.equal(retried.ok, true);
  assert.equal(calls.terminals.length, 2);
  assert.equal(calls.terminals.at(-1).candidate.uii, "u2");
  assert.equal(calls.currentProjections.at(-1).current, null);
});

test("resetAgent keeps every pending identity when the second terminal write fails", async () => {
  const first = { ...lead("q1"), externId: externFor("q1"), uii: "u1" };
  const second = { ...lead("q2"), externId: externFor("q2"), uii: "u2" };
  const { service, calls } = buildHarness({
    knownLeads: [first, second],
    terminalFailureAt: 2,
  });
  const agent = { ...AGENT, stats: { observedCalls: [first, second] } };

  await assert.rejects(() => service.resetAgent(agent, "manual-test"), /terminal-write-failed/);

  assert.equal(calls.releases.length, 0);
  assert.equal(calls.completedProjections.length, 0);
  assert.equal(calls.retiredProjections.length, 0);

  const retried = await service.resetAgent(agent, "manual-test");
  assert.equal(retried.ok, true);
  assert.deepEqual(calls.terminals.map((row) => row.candidate.uii), ["u1", "u2", "u2"]);
  assert.equal(calls.releases.length, 1);
});

test("resetAgent retries local release without rewriting its durable terminal", async () => {
  const current = { ...lead("q1"), externId: externFor("q1"), uii: "u1" };
  const { service, calls } = buildHarness({
    knownLeads: [current],
    releaseResults: [
      { ok: false, released: [], failed: [current] },
      { ok: true, released: [current], failed: [] },
    ],
  });
  const agent = { ...AGENT, current };

  const first = await service.resetAgent(agent, "manual-test");
  assert.equal(first.ok, false);
  assert.equal(first.reason, "local-release-unconfirmed");
  assert.equal(calls.completedProjections.length, 0);

  const retried = await service.resetAgent(agent, "manual-test");
  assert.equal(retried.ok, true);
  assert.equal(calls.terminals.length, 1, "retry uses the existing exact durable terminal");
  assert.equal(calls.releases.length, 2);
});

test("resetAgent attempts every active hangup before reporting incomplete cleanup", async () => {
  const first = { ...lead("q1"), externId: externFor("q1"), uii: "u1" };
  const second = { ...lead("q2"), externId: externFor("q2"), uii: "u2" };
  const { service, calls } = buildHarness({
    outstanding: [first, second],
    knownLeads: [first, second],
    activeCalls: [
      { externalId: first.externId, uii: first.uii, callState: "ACTIVE" },
      { externalId: second.externId, uii: second.uii, callState: "ACTIVE" },
    ],
    hangupResponses: { u1: { ok: false, reason: "rejected" } },
  });

  const result = await service.resetAgent({
    ...AGENT,
    stats: { observedCalls: [first, second] },
  }, "manual-test");

  assert.equal(result.ok, false);
  assert.equal(result.reason, "ringcx-hangup-rejected");
  assert.deepEqual(calls.hangups.map((row) => row.uii), ["u1", "u2"]);
  assert.equal(calls.terminals.length, 0);
  assert.equal(calls.releases.length, 0);
  assert.equal(calls.completedProjections.length, 0);
});

test("resetAgent first retains then cleans an exact active UII missing from the session snapshot", async () => {
  const current = { ...lead("q1"), externId: externFor("q1"), uii: "u1" };
  const { service, calls } = buildHarness({
    outstanding: [current],
    knownLeads: [current],
    activeCalls: [{ externalId: current.externId, uii: current.uii, callState: "ACTIVE" }],
  });

  const result = await service.resetAgent(AGENT, "manual-test");

  assert.equal(result.ok, true);
  assert.equal(calls.currentProjections.length > 0, true, "the existing observed identity set receives the retry snapshot");
  assert.equal(calls.cancels.length, 1);
  assert.deepEqual(calls.hangups.map((row) => row.uii), ["u1"]);
  assert.deepEqual(calls.terminals.map((row) => row.candidate.uii), ["u1"]);
  assert.equal(calls.releases.length, 1);
});

test("resetAgent still cancels a known extern when the active endpoint has no UII", async () => {
  const current = { ...lead("q1"), externId: externFor("q1") };
  const { service, calls } = buildHarness({
    outstanding: [current],
    knownLeads: [current],
    activeCalls: [{ externalId: current.externId, uii: null, callState: "ACTIVE" }],
  });

  const result = await service.resetAgent(AGENT, "manual-test");

  assert.equal(result.ok, false, "the still-active no-UII call prevents local release");
  assert.equal(result.reason, "ringcx-cleanup-unconfirmed");
  assert.deepEqual(calls.cancels[0].externIds, [current.externId]);
  assert.equal(calls.hangups.length, 0);
  assert.equal(calls.terminals.length, 0, "no UII means no invented terminal fact");
  assert.equal(calls.releases.length, 0);
});

test("an already-durable completed UII does not require stale local case or phone identity", async () => {
  const completed = { queueItemId: "q1", externId: externFor("q1"), uii: "u1" };
  const owned = {
    queueItemId: "q1",
    externId: completed.externId,
    state: "serving",
    metadata: { reservationSessionId: AGENT.sessionId, lastRingcxPublishedExternId: completed.externId },
  };
  const { service, calls } = buildHarness({
    ownedRows: [owned],
    terminalKeys: ["q1:u1"],
  });

  const result = await service.resetAgent({ ...AGENT, completed: [completed] }, "manual-test");

  assert.equal(result.ok, true);
  assert.equal(calls.terminals.length, 0);
  assert.deepEqual(calls.releases[0].rows.map((row) => row.queueItemId), ["q1"]);
});

test("a previously observed UII waits for RingCX when it disappears while the next call is active", async () => {
  const first = { ...lead("q1"), externId: externFor("q1"), uii: "u1", lastSeenAt: new Date(Date.now() - 5_000).toISOString() };
  const next = { ...lead("q2"), externId: externFor("q2"), uii: "u2" };
  const { service, calls } = buildHarness({ knownLeads: [first, next] });
  const agent = { ...AGENT, stats: { observedCalls: [first, next] } };

  const result = await service.recordReleased(agent, {
    activeCalls: [{ externalId: next.externId, uii: next.uii, callState: "ACTIVE" }],
  });

  assert.equal(result.written.length, 0);
  assert.deepEqual(result.awaitingSystemDisposition.map((row) => row.uii), ["u1"]);
  assert.equal(calls.terminals.length, 0);
  assert.equal(calls.completedProjections.length, 0);
  assert.equal(calls.updatedProjections[0].identity.uii, "u1");
  assert.ok(calls.updatedProjections[0].patch.releasedAt);
});

test("a released UII stays pending when RingCX no longer returns the lead", async () => {
  const observed = { ...lead("q1"), externId: externFor("q1"), uii: "u1", lastSeenAt: new Date(Date.now() - 5_000).toISOString() };
  const { service, calls } = buildHarness({ knownLeads: [] });

  await service.recordReleased({ ...AGENT, stats: { observedCalls: [observed] } }, { activeCalls: [] });

  assert.equal(calls.terminals.length, 0);
  assert.equal(calls.updatedProjections[0].identity.caseId, observed.caseId);
  assert.equal(calls.updatedProjections[0].identity.phone, observed.phone);
});

test("repeated calls to one extern wait by exact released UII, never by extern alone", async () => {
  const base = { ...lead("q1"), externId: externFor("q1") };
  const first = { ...base, uii: "u1", lastSeenAt: new Date(Date.now() - 5_000).toISOString() };
  const second = { ...base, uii: "u2" };
  const { service, calls } = buildHarness({ knownLeads: [base] });

  await service.recordReleased({ ...AGENT, stats: { observedCalls: [first, second] } }, {
    activeCalls: [{ externalId: base.externId, uii: "u2", callState: "ACTIVE" }],
  });

  assert.deepEqual(calls.terminals, []);
  assert.deepEqual(calls.updatedProjections.map((row) => row.identity.uii), ["u1"]);
});

test("a button can close its exact pending UII after the active endpoint has drained", async () => {
  const candidate = { ...lead("q1"), externId: externFor("q1"), uii: "u1" };
  const { service, calls, state } = buildHarness({
    knownLeads: [candidate],
    activeCalls: [],
    dispositionResponse: { ok: false, reason: "call-already-released" },
  });
  const agent = { ...AGENT, stats: { observedCalls: [candidate] }, current: candidate };

  const result = await service.finishCall(agent, "voicemail", {
    expectedExternId: candidate.externId,
    expectedUii: candidate.uii,
    nextAction: "ringcx_vm_drop",
  });
  state.completed.push({ ...candidate, outcome: "answered", systemDisposition: "ANSWER" });
  await service.recordCompleted(agent);

  assert.equal(result.ok, true);
  assert.equal(result.transport.ok, false);
  assert.equal(calls.terminals[0].source, "agent-button");
  assert.equal(calls.terminals[0].outcome, "voicemail");
  assert.equal(calls.completedProjections.length, 1, "later system state cannot relabel the button fact");
  assert.equal(calls.retiredProjections.at(-1).identity.uii, "u1");
});

test("kill closes every observed UII but never invents a call for an unobserved pending lead", async () => {
  const first = { ...lead("q1"), externId: externFor("q1"), uii: "u1" };
  const second = { ...lead("q2"), externId: externFor("q2"), uii: "u2" };
  const neverCalled = { ...lead("q3"), externId: externFor("q3"), leadState: "PENDING", state: "serving" };
  const { service, calls } = buildHarness({
    outstanding: [neverCalled],
    knownLeads: [first, second, neverCalled],
    activeCalls: [],
  });

  const result = await service.resetAgent({
    ...AGENT,
    current: null,
    stats: { observedCalls: [first, second] },
  }, "manual-test");

  assert.equal(result.ok, true);
  assert.deepEqual(new Set(calls.cancels[0].externIds), new Set([first.externId, second.externId, neverCalled.externId]));
  assert.deepEqual(new Set(calls.terminals.map((row) => row.candidate.uii)), new Set(["u1", "u2"]));
  assert.equal(calls.terminals.some((row) => row.candidate.externId === neverCalled.externId), false);
  assert.deepEqual(new Set(calls.releases[0].rows.map((row) => row.queueItemId)), new Set(["q1", "q2", "q3"]));
});
