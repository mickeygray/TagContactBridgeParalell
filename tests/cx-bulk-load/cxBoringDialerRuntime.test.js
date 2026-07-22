"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  _test,
  createCxBoringDialerRuntime,
} = require("../../packages/shared-services/src/cxBoringDialerRuntime");

const AGENT = {
  sessionId: "cxbl-5b4e8332-7d66-48f8-8ef5-123456789abc",
  domain: "WYNN",
  campaignId: "2306",
};

function buildRuntimeHarness(options = {}) {
  const q1 = "6a4dfd5778d3657be4f15120";
  const q2 = "6a4dfd5778d3657be4f15121";
  const extern = (queueItemId) => `cxbl-wynn-123456789abc-${queueItemId}`;
  const rows = [q1, q2].map((queueItemId, index) => ({
    _id: queueItemId,
    queueItemId,
    domain: "WYNN",
    caseId: 101 + index,
    phone: `31055512${10 + index}`,
    name: `Lead ${index + 1}`,
    state: "claimed",
    metadata: {
      reservationSessionId: AGENT.sessionId,
      lastRingcxPublishedExternId: extern(queueItemId),
    },
  }));
  let session = {
    sessionId: AGENT.sessionId,
    runtime: "boring",
    status: "running",
    phase: "watching",
    agentEmail: "agent@example.test",
    agentExtensionId: "agent-1",
    cxAgentId: "cx-agent-1",
    domain: "WYNN",
    ringcx: { accountId: "account-1", campaignId: "2306", dialGroupId: "963" },
    current: null,
    completed: [],
    stats: {},
    ...options.session,
  };
  const calls = { active: 0, search: [], updates: [], outbox: [], dispositions: [] };
  const state = {
    activeCalls: options.activeCalls || [],
    terminalLeads: options.terminalLeads || [],
    outstandingLeads: options.outstandingLeads || [],
  };
  const repository = {
    async findBulkLoadSessionById() { return session; },
    async listActiveBulkLoadSessions(input) {
      calls.listInput = input;
      return session.status === "running" ? [session] : [];
    },
    async updateBulkLoadSession(_sessionId, patch) {
      calls.updates.push(patch);
      session = { ...session, ...patch };
      return session;
    },
  };
  const CxDialQueue = {
    find(query) {
      const wanted = new Set((query?._id?.$in || []).map(String));
      return { lean: async () => rows.filter((row) => wanted.has(String(row._id))) };
    },
    findOne(query) {
      const row = rows.find((candidate) => String(candidate._id) === String(query._id)
        && candidate.metadata.reservationSessionId === query["metadata.reservationSessionId"]
        && candidate.metadata.lastRingcxPublishedExternId === query["metadata.lastRingcxPublishedExternId"]);
      return { lean: async () => row || null };
    },
  };
  const client = {
    async listActiveCalls() {
      calls.active += 1;
      return { activeCalls: state.activeCalls };
    },
    async searchLeads(payload) {
      calls.search.push(payload);
      return payload.leadStates?.includes("COMPLETE") ? state.terminalLeads : state.outstandingLeads;
    },
    async dispositionCall(uii, payload) {
      calls.dispositions.push({ uii, payload });
      return options.dispositionResponse === undefined ? true : options.dispositionResponse;
    },
  };
  const runtime = createCxBoringDialerRuntime({
    client,
    CxDialQueue,
    cxBulkLoadSessionRepository: repository,
    cxTerminalOutboxRepository: {
      async insertOnce(row) {
        if (calls.outbox.some((existing) => existing.idemKey === row.idemKey)) return null;
        calls.outbox.push(row);
        return row;
      },
      async findByAgentUii({ agentId, uii }) {
        return calls.outbox.find((row) => row.agentId === agentId && row.uii === uii) || null;
      },
    },
    userAccountRepository: {
      async findUserAccountByEmail() {
        return { email: session.agentEmail, extensionId: session.agentExtensionId, cxAgentId: session.cxAgentId };
      },
    },
    env: {
      RINGCX_AGENT_ROUTE_AGENT_1_CAMPAIGN_ID: "2306",
      RINGCX_AGENT_ROUTE_AGENT_1_DIAL_GROUP_ID: "963",
    },
  });
  return { runtime, calls, state, rows, extern, getSession: () => session };
}

test("lead search always carries both RingCX campaign filters", () => {
  assert.deepEqual(_test.buildLeadSearchPayload(AGENT, { leadStates: ["READY", "ACTIVE"] }), {
    campaignId: 2306,
    campaignIds: [2306],
    listIds: [],
    agentDispositions: [],
    systemDispositions: [],
    leadStates: ["READY", "ACTIVE"],
    physicalStates: [],
    leadTimezones: [],
    suppressed: "ALL",
  });
});

test("session prefix is the only way the replacement adopts RingCX leads", () => {
  assert.equal(_test.sessionPrefix(AGENT), "cxbl-wynn-123456789abc-");
  assert.equal(
    _test.queueItemIdFromExtern(AGENT, "cxbl-wynn-123456789abc-6a4dfd5778d3657be4f15120"),
    "6a4dfd5778d3657be4f15120",
  );
  assert.equal(_test.queueItemIdFromExtern(AGENT, "cxbl-wynn-foreign-6a4dfd5778d3657be4f15120"), null);
});

test("thirty-lead refill keeps a mixed family batch and backfills shortages", () => {
  const lead = (id) => ({ queueItemId: id });
  const pool = {
    "fresh-day1": [lead("g1"), lead("g2")],
    "fresh-day2to10": [lead("b1"), lead("b2")],
    "fresh-day16to30": [lead("y1")],
    aged: Array.from({ length: 20 }, (_, index) => lead(`a${index}`)),
  };

  assert.equal(Object.values(_test.chooseFamilyTargets(pool)).reduce((sum, value) => sum + value, 0), 25);
  const fullPool = Object.fromEntries(["fresh-day1", "fresh-day2to10", "fresh-day16to30", "aged"]
    .map((family) => [family, Array.from({ length: 30 }, (_, index) => lead(`${family}-${index}`))]));
  assert.deepEqual(_test.chooseFamilyTargets(fullPool), {
    "fresh-day1": 15,
    "fresh-day2to10": 8,
    "fresh-day16to30": 4,
    aged: 3,
  });
});

test("terminal mapping keeps the agent vocabulary small", () => {
  assert.equal(_test.outcomeFromLead({ lastPassDispo: "ANSWER" }), "answered");
  assert.equal(_test.outcomeFromLead({ lastPassDispo: "NOANSWER" }), "did_not_connect");
  assert.equal(_test.outcomeFromLead({ outboundDisposition: "NO ANSWER" }), "did_not_connect");
  assert.equal(_test.outcomeFromLead({ lastPassDispo: "MACHINE" }), "voicemail");
  assert.equal(_test.outcomeFromLead({ lastPassDispo: "CONGESTION" }), "did_not_connect");
  assert.equal(_test.outcomeFromLead({ lastPassDispo: "SOMETHING_NEW" }), null);
  assert.equal(_test.ringcxDisposition("voicemail"), "VM DROP");
  assert.equal(_test.ringcxDisposition("answered"), "Auto Dispo");
});

test("per-agent route resolution uses the existing environment contract", () => {
  const env = {
    RINGCX_AGENT_ROUTE_AGENT_1_CAMPAIGN_ID: "2306",
    RINGCX_AGENT_ROUTE_AGENT_1_DIAL_GROUP_ID: "963",
  };
  assert.deepEqual(_test.resolveAgentRoute({ agentExtensionId: "agent-1" }, {}, env), {
    campaignId: "2306",
    dialGroupId: "963",
  });
});

test("daily made-call admission is current-status plus latest terminal fact", () => {
  const now = new Date("2026-07-09T12:00:00-07:00");
  const at = (minutesAgo, outcome) => ({
    outcome,
    createdAt: new Date(now.getTime() - minutesAgo * 60 * 1000),
  });

  assert.equal(_test.currentStatusCallable({ statusId: 2, statusCategory: "prospect" }, [2]), true);
  assert.equal(_test.currentStatusCallable({ statusId: 9, statusCategory: "prospect" }, [2]), false);
  assert.equal(_test.currentStatusCallable({ statusId: 2, statusCategory: "client" }, [2]), false);
  assert.equal(_test.currentStatusCallable(null, [2]), false);
  assert.equal(_test.currentStatusCallable({ statusId: null, statusCategory: "prospect" }, [2]), false);
  assert.equal(_test.dailyTerminalAllows(at(30, "did_not_connect"), { now, cadenceWindowMinutes: 90 }), false);
  assert.equal(_test.dailyTerminalAllows(at(91, "did_not_connect"), { now, cadenceWindowMinutes: 90 }), true);
  assert.equal(_test.dailyTerminalAllows(at(91, "voicemail"), { now, cadenceWindowMinutes: 90 }), true);
  assert.equal(_test.dailyTerminalAllows(at(600, "answered"), { now, cadenceWindowMinutes: 90 }), false);
  assert.equal(_test.dailyTerminalAllows(at(600, "dnc"), { now, cadenceWindowMinutes: 90 }), false);
  assert.equal(_test.dailyTerminalAllows(at(600, "bad_number"), { now, cadenceWindowMinutes: 90 }), false);
  assert.equal(_test.dailyTerminalAllows(at(600, "unknown"), { now, cadenceWindowMinutes: 90 }), false);
  assert.equal(_test.dailyTerminalAllows({
    outcome: "did_not_connect",
    createdAt: new Date(now.getTime() - 5 * 60 * 1000),
    payload: { at: new Date(now.getTime() - 91 * 60 * 1000).toISOString() },
  }, { now, cadenceWindowMinutes: 90 }), true, "durable call time wins over a delayed outbox insert");
  assert.equal(_test.dailyTerminalAllows({
    outcome: "did_not_connect",
    createdAt: new Date(now.getTime() - 91 * 60 * 1000),
    payload: { at: new Date(now.getTime() - 5 * 60 * 1000).toISOString() },
  }, { now, cadenceWindowMinutes: 90 }), false, "payload time is authoritative when both timestamps exist");
  assert.equal(_test.leadLedgerKey({ domain: "wynn", caseId: 44, phone: "(310) 555-1212" }), "WYNN:case:44");
  assert.equal(_test.leadLedgerKey({ domain: "wynn", phone: "+1 (310) 555-1212" }), "WYNN:phone:3105551212");
  assert.equal(_test.leadLedgerKey({ domain: "wynn", caseId: null, phone: "+1 (310) 555-1212" }), "WYNN:phone:3105551212");
});

test("daily call boundaries are Pacific even when the host clock is UTC", () => {
  assert.equal(
    _test.pacificDayStart(new Date("2026-07-09T06:30:00.000Z")).toISOString(),
    "2026-07-08T07:00:00.000Z",
  );
  assert.equal(
    _test.pacificDayStart(new Date("2026-07-09T08:00:00.000Z")).toISOString(),
    "2026-07-09T07:00:00.000Z",
  );
});

test("eligible-pool gate batch-checks current statuses and today's terminal ledger", async () => {
  const now = new Date();
  const queueRows = [1, 2, 3, 4, 5].map((caseId) => ({
    _id: `6a4dfd5778d3657be4f1512${caseId}`,
    domain: "WYNN",
    caseId,
    phone: `310555120${caseId}`,
    state: "ready",
    releaseAt: new Date(now.getTime() - 1000),
    queueFamily: "fresh-day1",
  }));
  let profileReads = 0;
  let terminalReads = 0;
  const deps = {
    client: {},
    CxDialQueue: {
      find() {
        const chain = {
          sort() { return chain; },
          limit() { return chain; },
          lean: async () => queueRows,
        };
        return chain;
      },
    },
    caseProfileRepository: {
      async listCaseProfilesByCaseIds(_domain, caseIds, options) {
        profileReads += 1;
        assert.deepEqual(caseIds, [1, 2, 3, 4, 5]);
        assert.deepEqual(options, { currentOnly: true });
        return caseIds
          .filter((caseId) => caseId !== 5)
          .map((caseId) => ({ domain: "WYNN", caseId, statusId: caseId === 2 ? 9 : 2, statusCategory: "prospect" }));
      },
    },
    cxTerminalOutboxRepository: {
      async listLatestTodayForLeads(input) {
        terminalReads += 1;
        assert.deepEqual(input.caseIds, [1, 3, 4]);
        return [
          { domain: "WYNN", caseId: 3, outcome: "answered", createdAt: new Date(now.getTime() - 4 * 60 * 60 * 1000) },
          { domain: "WYNN", caseId: 4, outcome: "did_not_connect", createdAt: new Date(now.getTime() - 2 * 60 * 60 * 1000) },
        ];
      },
      async insertOnce() { return {}; },
      async findByAgentUii() { return null; },
    },
  };
  const { inventory } = _test.createRuntimeAdapters(deps);

  const eligible = await inventory.listEligible({
    agent: { ...AGENT, agentExtensionId: "agent-1" },
    acceptedStatusIds: [2],
    cadenceWindowMinutes: 90,
    now,
  });

  assert.deepEqual(eligible.map((row) => row.caseId), [1, 4]);
  assert.equal(profileReads, 1);
  assert.equal(terminalReads, 1);
});

test("phone-only pool rows require one callable canonical profile and claim by its case id", async () => {
  const now = new Date();
  const uniqueId = "6a4dfd5778d3657be4f15125";
  const ambiguousId = "6a4dfd5778d3657be4f15126";
  const terminalId = "6a4dfd5778d3657be4f15127";
  const rows = [
    { _id: uniqueId, domain: "WYNN", caseId: null, leadPhone: "+1 (310) 555-1300", state: "ready", releaseAt: new Date(now - 1000), queueFamily: "fresh-day1" },
    { _id: ambiguousId, domain: "WYNN", caseId: null, phone: "3105551400", state: "ready", releaseAt: new Date(now - 1000), queueFamily: "fresh-day1" },
    { _id: terminalId, domain: "WYNN", caseId: null, phone: "3105551500", state: "ready", releaseAt: new Date(now - 1000), queueFamily: "fresh-day1" },
  ];
  let phoneProfileReads = 0;
  let blockedReads = 0;
  let claimUpdate = null;
  const deps = {
    client: {},
    CxDialQueue: {
      find() {
        const chain = { sort() { return chain; }, limit() { return chain; }, lean: async () => rows };
        return chain;
      },
      findOneAndUpdate(_query, update) {
        claimUpdate = update;
        return { lean: async () => ({ ...rows[0], _id: uniqueId, caseId: update.$set.caseId }) };
      },
    },
    caseProfileRepository: {
      async listCaseProfilesByCaseIds() { return []; },
      async listCaseProfilesByPhones(_domain, phones, options) {
        phoneProfileReads += 1;
        assert.deepEqual(phones, ["3105551300", "3105551400", "3105551500"]);
        assert.deepEqual(options, { currentOnly: true });
        return [
          { domain: "WYNN", caseId: 55, statusId: 2, statusCategory: "prospect", normalizedPhones: ["3105551300"] },
          { domain: "WYNN", caseId: 60, statusId: 2, statusCategory: "prospect", normalizedPhones: ["3105551400"] },
          { domain: "WYNN", caseId: 61, statusId: 2, statusCategory: "prospect", normalizedPhones: ["3105551400"] },
          { domain: "WYNN", caseId: 56, statusId: 2, statusCategory: "prospect", normalizedPhones: ["3105551500"] },
        ];
      },
    },
    cxTerminalOutboxRepository: {
      async listLatestTodayForLeads(input) {
        assert.deepEqual(input.caseIds, [55, 56]);
        assert.deepEqual(input.phones, ["3105551300", "3105551500"]);
        return [{
          domain: "WYNN",
          caseId: null,
          phone: "3105551500",
          outcome: "answered",
          createdAt: now,
        }];
      },
      async insertOnce() { return {}; },
      async findByAgentUii() { return null; },
    },
    queueItemRepository: {
      async listActiveLeadIds(leadIds) {
        blockedReads += 1;
        assert.deepEqual(leadIds, ["55"]);
        return [];
      },
    },
  };
  const { inventory } = _test.createRuntimeAdapters(deps);

  const eligible = await inventory.listEligible({
    agent: { ...AGENT, agentExtensionId: "agent-1" },
    acceptedStatusIds: [2],
    cadenceWindowMinutes: 90,
    now,
  });
  const claimed = await inventory.claim(eligible, { agent: { ...AGENT, agentExtensionId: "agent-1" } });

  assert.equal(phoneProfileReads, 1);
  assert.deepEqual(eligible.map((row) => row.caseId), [55]);
  assert.equal(blockedReads, 1);
  assert.equal(claimed.length, 1);
  assert.equal(claimUpdate.$set.caseId, 55);
});

test("active identity resolves directly from the extern-embedded local queue id", async () => {
  const queueItemId = "6a4dfd5778d3657be4f15120";
  const externId = `cxbl-wynn-123456789abc-${queueItemId}`;
  const row = { _id: queueItemId, name: "Local identity" };
  const deps = {
    client: {},
    CxDialQueue: {
      findOne(query) {
        assert.deepEqual(query, {
          _id: queueItemId,
          domain: "WYNN",
          "metadata.reservationSessionId": AGENT.sessionId,
          "metadata.lastRingcxPublishedExternId": externId,
        });
        return { lean: async () => row };
      },
    },
    cxTerminalOutboxRepository: { insertOnce: async () => ({ written: true }), findByAgentUii: async () => null },
  };
  const { inventory } = _test.createRuntimeAdapters(deps);

  const found = await inventory.findByExtern(AGENT, externId);

  assert.equal(found.queueItemId, queueItemId);
  assert.equal(found.externId, externId);
  assert.equal(found.name, "Local identity");
});

test("replacement claims stay on the existing bulk_load terminal rail", async () => {
  const queueItemId = "6a4dfd5778d3657be4f15120";
  let claimUpdate = null;
  const deps = {
    client: {},
    CxDialQueue: {
      findOneAndUpdate(_query, update) {
        claimUpdate = update;
        return { lean: async () => ({ _id: queueItemId }) };
      },
    },
    queueItemRepository: { listActiveLeadIds: async () => [] },
    cxTerminalOutboxRepository: { insertOnce: async () => ({ written: true }), findByAgentUii: async () => null },
  };
  const { inventory } = _test.createRuntimeAdapters(deps);

  await inventory.claim([{ queueItemId, caseId: 101, queueFamily: "fresh-day1" }], {
    agent: { ...AGENT, agentExtensionId: "agent-1" },
  });

  assert.equal(claimUpdate.$set["metadata.reservationRail"], "bulk_load");
});

test("confirmed kill cleanup can release a session-owned local serving row", async () => {
  const transitions = [];
  const deps = {
    client: {},
    CxDialQueue: {},
    cxDialQueueRepository: {
      async transitionQueueItemState(...args) { transitions.push(args); return {}; },
    },
    cxTerminalOutboxRepository: { insertOnce: async () => ({}), findByAgentUii: async () => null },
  };
  const { inventory } = _test.createRuntimeAdapters(deps);

  await inventory.release([{
    queueItemId: "6a4dfd5778d3657be4f15120",
    state: "serving",
    metadata: { reservationSessionId: AGENT.sessionId },
  }], "session-killed");

  assert.deepEqual(transitions[0][1], ["claimed", "ready", "serving"]);
  assert.deepEqual(transitions[0][3].match, { "metadata.reservationSessionId": AGENT.sessionId });
});

test("a local release CAS miss is reported instead of pretending kill cleanup succeeded", async () => {
  const deps = {
    client: {},
    CxDialQueue: {},
    cxDialQueueRepository: {
      async transitionQueueItemState() { return null; },
    },
    cxTerminalOutboxRepository: { insertOnce: async () => ({}), findByAgentUii: async () => null },
  };
  const { inventory } = _test.createRuntimeAdapters(deps);

  const result = await inventory.release([{
    queueItemId: "6a4dfd5778d3657be4f15120",
    state: "serving",
    metadata: { reservationSessionId: AGENT.sessionId },
  }], "session-killed");

  assert.equal(result.ok, false);
  assert.equal(result.failed.length, 1);
});

test("a local release CAS miss is idempotent after the session no longer owns the row", async () => {
  const deps = {
    client: {},
    CxDialQueue: {
      findOne() { return { lean: async () => null }; },
    },
    cxDialQueueRepository: {
      async transitionQueueItemState() { return null; },
    },
    cxTerminalOutboxRepository: { insertOnce: async () => ({}), findByAgentUii: async () => null },
  };
  const { inventory } = _test.createRuntimeAdapters(deps);

  const result = await inventory.release([{
    queueItemId: "6a4dfd5778d3657be4f15120",
    state: "serving",
    metadata: { reservationSessionId: AGENT.sessionId },
  }], "session-killed");

  assert.equal(result.ok, true);
  assert.equal(result.released.length, 1);
  assert.equal(result.failed.length, 0);
});

test("malformed RingCX active-call responses fail closed", async () => {
  const deps = {
    client: { listActiveCalls: async () => ({ unexpected: true }) },
    CxDialQueue: {},
    cxTerminalOutboxRepository: { insertOnce: async () => ({ written: true }), findByAgentUii: async () => null },
  };
  const { ringcx } = _test.createRuntimeAdapters(deps);

  await assert.rejects(
    () => ringcx.listActiveCalls({ accountId: "account-1" }),
    /active-call-list-unexpected-response/,
  );
});

test("outstanding inventory includes RingCX PENDING so kill can cancel every session lead", async () => {
  let payload = null;
  const deps = {
    client: {
      async searchLeads(input) {
        payload = input;
        return [];
      },
    },
    CxDialQueue: { find() { return { lean: async () => [] }; } },
    cxTerminalOutboxRepository: { insertOnce: async () => ({}), findByAgentUii: async () => null },
  };
  const { ringcx } = _test.createRuntimeAdapters(deps);

  await ringcx.listOutstanding(AGENT);

  assert.deepEqual(payload.leadStates, ["PENDING", "READY", "ACTIVE"]);
});

test("lead-level disposition never fans out across two unresolved UIIs for one extern", async () => {
  const queueItemId = "6a4dfd5778d3657be4f15120";
  const externId = `cxbl-wynn-123456789abc-${queueItemId}`;
  let terminalRow = { externId, leadState: "COMPLETE", lastPassDispo: "ANSWER" };
  const deps = {
    client: { async searchLeads() { return [terminalRow]; } },
    CxDialQueue: {
      find() {
        return { lean: async () => [{
          _id: queueItemId,
          domain: "WYNN",
          caseId: 101,
          metadata: { reservationSessionId: AGENT.sessionId, lastRingcxPublishedExternId: externId },
        }] };
      },
    },
    cxTerminalOutboxRepository: { insertOnce: async () => ({}), findByAgentUii: async () => null },
  };
  const { ringcx } = _test.createRuntimeAdapters(deps);
  const agent = {
    ...AGENT,
    stats: { observedCalls: [
      { queueItemId, externId, uii: "u1", lastSeenAt: "2026-07-09T00:00:00.000Z" },
      { queueItemId, externId, uii: "u2", lastSeenAt: "2026-07-09T00:00:00.000Z" },
    ] },
  };

  assert.deepEqual(await ringcx.listCompleted(agent, { activeCalls: [] }), []);
  terminalRow = { ...terminalRow, uii: "u2", lastPassDispo: null, outboundDisposition: "NOANSWER" };
  const exact = await ringcx.listCompleted(agent, { activeCalls: [] });

  assert.equal(exact.length, 1);
  assert.equal(exact[0].uii, "u2");
  assert.equal(exact[0].outcome, "did_not_connect");
});

test("one session task finishes before the next task begins", async () => {
  const run = _test.createSerialTaskRunner();
  const events = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const first = run("session-1", async () => {
    events.push("first-start");
    await firstGate;
    events.push("first-end");
  });
  await new Promise((resolve) => setImmediate(resolve));
  const second = run("session-1", async () => {
    events.push("second-start");
    events.push("second-end");
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(events, ["first-start"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first-start", "first-end", "second-start", "second-end"]);
});

test("start adopts the live legacy session without touching its RingCX campaign", async () => {
  const originalSessionId = "cxbl-legacy-session-123456789abc";
  let session = {
    sessionId: originalSessionId,
    runtime: "bulk_load",
    status: "running",
    phase: "ready",
    agentEmail: "agent@example.test",
    agentExtensionId: "agent-1",
    domain: "WYNN",
    ringcx: { accountId: "account-1", campaignId: "2306", dialGroupId: "963" },
    acceptedBuffer: [{ externId: "cxbl-wynn-123456789abc-row-1" }],
    stats: { legacy: true },
    startedAt: new Date("2026-07-09T08:00:00.000Z"),
  };
  let createCalls = 0;
  let ringcxReads = 0;
  const repository = {
    async findActiveBulkLoadSessionForAgent(input) {
      if (input.runtime === "boring") return null;
      return session;
    },
    async updateBulkLoadSession(sessionId, patch, options) {
      assert.equal(sessionId, originalSessionId);
      if (patch.runtime === "boring") {
        assert.deepEqual(options, { match: { runtime: { $ne: "boring" }, status: "running" } });
      } else {
        assert.deepEqual(options, { match: { runtime: "boring", status: "running" } });
      }
      session = { ...session, ...patch };
      return session;
    },
    async findBulkLoadSessionById(sessionId) {
      return session?.sessionId === sessionId ? session : null;
    },
    async createBulkLoadSession() { createCalls += 1; return null; },
  };
  const runtime = createCxBoringDialerRuntime({
    client: {
      async searchLeads() {
        ringcxReads += 1;
        return Array.from({ length: 5 }, (_, index) => ({
          externId: `cxbl-wynn-123456789abc-row-${index + 1}`,
          leadState: "READY",
        }));
      },
    },
    cxBulkLoadSessionRepository: repository,
    userAccountRepository: {
      async findUserAccountByEmail() {
        return { extensionId: "agent-1", cxAgentId: "cx-agent-1" };
      },
    },
    env: {
      RINGCX_AGENT_ROUTE_AGENT_1_CAMPAIGN_ID: "2306",
      RINGCX_AGENT_ROUTE_AGENT_1_DIAL_GROUP_ID: "963",
    },
  });

  const adopted = await runtime.start({
    agentEmail: "agent@example.test",
    domain: "WYNN",
    accountId: "account-1",
  }, { user: { email: "agent@example.test" } });

  assert.equal(adopted.sessionId, originalSessionId, "the extern-id session token stays valid");
  assert.equal(adopted.runtime, "boring");
  assert.equal(adopted.phase, "ready");
  assert.deepEqual(adopted.acceptedBuffer, [], "legacy UI buffer state is discarded");
  assert.equal(createCalls, 0, "takeover does not mint a competing session");
  assert.equal(ringcxReads, 1, "takeover reads the real campaign once for the login low-water check");
});

test("startup refill and backend watch share the session gate", async () => {
  let session = null;
  let releasePoolRead;
  let markPoolReadStarted;
  let watchSettled = false;
  let activeReads = 0;
  const poolReadGate = new Promise((resolve) => { releasePoolRead = resolve; });
  const poolReadStarted = new Promise((resolve) => { markPoolReadStarted = resolve; });
  const repository = {
    async findActiveBulkLoadSessionForAgent() { return session?.status === "running" ? session : null; },
    async createBulkLoadSession(row) { session = { ...row }; return session; },
    async findBulkLoadSessionById(sessionId) { return session?.sessionId === sessionId ? session : null; },
    async listActiveBulkLoadSessions() { return session?.status === "running" ? [session] : []; },
    async updateBulkLoadSession(_sessionId, patch) { session = { ...session, ...patch }; return session; },
  };
  const CxDialQueue = {
    find() {
      const chain = {
        sort() { return chain; },
        limit() { return chain; },
        async lean() {
          markPoolReadStarted();
          await poolReadGate;
          return [];
        },
      };
      return chain;
    },
  };
  const runtime = createCxBoringDialerRuntime({
    client: {
      async searchLeads() { return []; },
      async listActiveCalls() { activeReads += 1; return { activeCalls: [] }; },
    },
    CxDialQueue,
    cxBulkLoadSessionRepository: repository,
    caseProfileRepository: {
      async listCaseProfilesByCaseIds() { return []; },
      async listCaseProfilesByPhones() { return []; },
    },
    cxTerminalOutboxRepository: { insertOnce: async () => ({}), findByAgentUii: async () => null },
    queueItemRepository: { listActiveLeadIds: async () => [] },
    userAccountRepository: {
      async findUserAccountByEmail() {
        return { extensionId: "agent-1", cxAgentId: "cx-agent-1" };
      },
    },
    env: {
      RINGCX_AGENT_ROUTE_AGENT_1_CAMPAIGN_ID: "2306",
      RINGCX_AGENT_ROUTE_AGENT_1_DIAL_GROUP_ID: "963",
    },
  });

  const start = runtime.start({
    agentEmail: "agent@example.test",
    domain: "WYNN",
    accountId: "account-1",
    campaignId: "client-cannot-override",
    dialGroupId: "client-cannot-override",
  }, { user: { email: "agent@example.test" } });
  await poolReadStarted;
  assert.equal(session.ringcx.campaignId, "2306");
  assert.equal(session.ringcx.dialGroupId, "963");
  const watch = runtime.watch({ sessionId: session.sessionId }).finally(() => { watchSettled = true; });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(watchSettled, false, "watch waits behind the startup refill");
  assert.equal(activeReads, 0);

  releasePoolRead();
  const [, watchResult] = await Promise.all([start, watch]);
  assert.equal(watchResult.summary.skippedCount, 1, "watch rechecks state after startup finishes");
  assert.equal(activeReads, 0, "a failed startup is never observed as a live session");
});

test("projection writes only to a running replacement session and keeps an identity ledger", async () => {
  let session = {
    sessionId: AGENT.sessionId,
    runtime: "boring",
    status: "running",
    current: null,
    stats: { outstandingCount: 1 },
  };
  const writes = [];
  const repository = {
    async findBulkLoadSessionById() { return session; },
    async updateBulkLoadSession(sessionId, patch, options) {
      writes.push({ sessionId, patch, options });
      session = { ...session, ...patch };
      return session;
    },
  };
  const deps = {
    client: {},
    CxDialQueue: {
      findOne(query) {
        return {
          lean: async () => ({
            _id: query._id,
            domain: query.domain,
            metadata: {
              reservationSessionId: query["metadata.reservationSessionId"],
              lastRingcxPublishedExternId: query["metadata.lastRingcxPublishedExternId"],
            },
          }),
        };
      },
    },
    cxBulkLoadSessionRepository: repository,
    cxTerminalOutboxRepository: { insertOnce: async () => ({ written: true }), findByAgentUii: async () => null },
  };
  const { projection } = _test.createRuntimeAdapters(deps);
  const current = {
    queueItemId: "6a4dfd5778d3657be4f15120",
    externId: "cxbl-wynn-123456789abc-6a4dfd5778d3657be4f15120",
    uii: "uii-1",
  };

  await projection.setCurrent(AGENT, current);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].options.match, { runtime: "boring", status: "running" });
  assert.deepEqual(writes[0].patch.stats.observedCalls, [{
    queueItemId: current.queueItemId,
    externId: current.externId,
    uii: current.uii,
    domain: "WYNN",
    caseId: null,
    phone: null,
    name: null,
    lastSeenAt: writes[0].patch.stats.observedCalls[0].lastSeenAt,
  }]);

  const overlap = {
    externId: "cxbl-wynn-123456789abc-6a4dfd5778d3657be4f15121",
    uii: "uii-2",
  };
  await projection.setCurrent(AGENT, null, { observedCalls: [overlap] });
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[1].patch.stats.observedCalls.at(-1), {
    queueItemId: "6a4dfd5778d3657be4f15121",
    externId: overlap.externId,
    uii: overlap.uii,
    domain: "WYNN",
    caseId: null,
    phone: null,
    name: null,
    lastSeenAt: writes[1].patch.stats.observedCalls.at(-1).lastSeenAt,
  });

  session = { ...session, status: "killed" };
  await projection.setCurrent(AGENT, null);
  assert.equal(writes.length, 2);
});

test("projection retains an exact owned extern/UII sighting even while local hydration is missing", async () => {
  let session = {
    sessionId: AGENT.sessionId,
    runtime: "boring",
    status: "running",
    stats: {},
  };
  const repository = {
    async findBulkLoadSessionById() { return session; },
    async updateBulkLoadSession(_sessionId, patch) { session = { ...session, ...patch }; return session; },
  };
  const deps = {
    client: {},
    CxDialQueue: {
      findOne() { return { lean: async () => null }; },
    },
    cxBulkLoadSessionRepository: repository,
    cxTerminalOutboxRepository: { insertOnce: async () => ({}), findByAgentUii: async () => null },
  };
  const { projection } = _test.createRuntimeAdapters(deps);
  const exact = {
    externId: "cxbl-wynn-123456789abc-6a4dfd5778d3657be4f15120",
    uii: "uii-local-miss",
  };

  await projection.setCurrent(AGENT, null, { observedCalls: [exact] });

  assert.equal(session.current, null);
  assert.equal(session.stats.observedCalls.length, 1);
  assert.equal(session.stats.observedCalls[0].queueItemId, "6a4dfd5778d3657be4f15120");
  assert.equal(session.stats.observedCalls[0].uii, "uii-local-miss");
  assert.equal(session.stats.observedCalls[0].caseId, null);
});

test("terminal retirement reads the durable outbox by exact UII identity", async () => {
  const seen = [];
  const deps = {
    client: {},
    CxDialQueue: {},
    cxTerminalOutboxRepository: {
      async insertOnce() { return { written: true }; },
      async findByAgentUii(identity) {
        seen.push(identity);
        return { agentId: "agent-1", uii: "uii-1" };
      },
    },
  };
  const { terminal } = _test.createRuntimeAdapters(deps);

  const retired = await terminal.hasTerminalOutcome({
    session: { ...AGENT, cxAgentId: "agent-1" },
    candidate: { queueItemId: "queue-1", uii: "uii-1" },
  });

  assert.equal(retired, true);
  assert.deepEqual(seen, [{ agentId: "agent-1", uii: "uii-1" }]);
});

test("kill leaves the session running when RingCX cleanup cannot be proven", async () => {
  const session = {
    sessionId: AGENT.sessionId,
    runtime: "boring",
    status: "running",
    phase: "active",
    agentEmail: "agent@example.test",
    agentExtensionId: "agent-1",
    domain: "WYNN",
    ringcx: { accountId: "account-1", campaignId: "2306", dialGroupId: "963" },
    stats: {},
  };
  const updates = [];
  const repository = {
    async findBulkLoadSessionById() { return session; },
    async updateBulkLoadSession(_sessionId, patch) { updates.push(patch); return { ...session, ...patch }; },
  };
  const runtime = createCxBoringDialerRuntime({
    client: { listActiveCalls: async () => ({ unexpected: true }) },
    CxDialQueue: {},
    cxBulkLoadSessionRepository: repository,
    cxTerminalOutboxRepository: { insertOnce: async () => ({ written: true }), findByAgentUii: async () => null },
    userAccountRepository: {
      async findUserAccountByEmail() { return { email: session.agentEmail, extensionId: session.agentExtensionId }; },
    },
  });

  const result = await runtime.kill(
    { sessionId: session.sessionId },
    { user: { email: session.agentEmail, role: "admin", extensionId: session.agentExtensionId } },
  );

  assert.equal(result.killOk, false);
  assert.equal(result.status, "running");
  assert.equal(result.killResult.reason, "ringcx-read-failed");
  assert.equal(updates.length, 0, "failed cleanup leaves the existing projection untouched");
});

test("browser GET and manual sync are read-only snapshots", async () => {
  const { runtime, calls } = buildRuntimeHarness();
  const options = { user: { email: "agent@example.test", role: "admin", extensionId: "agent-1" } };

  const getResult = await runtime.get({ sessionId: AGENT.sessionId }, options);
  const syncResult = await runtime.sync({ sessionId: AGENT.sessionId }, options);

  assert.equal(getResult.sessionId, AGENT.sessionId);
  assert.equal(syncResult.sessionId, AGENT.sessionId);
  assert.equal(calls.active, 0);
  assert.equal(calls.search.length, 0);
  assert.equal(calls.updates.length, 0);
});

test("the backend watch owns active-call mutation and scopes enumeration to boring sessions", async () => {
  const harness = buildRuntimeHarness({
    activeCalls: [{ externalId: "cxbl-wynn-123456789abc-6a4dfd5778d3657be4f15120", uii: "u1", callState: "ACTIVE" }],
  });

  const result = await harness.runtime.watch();

  assert.equal(result.summary.refreshedCount, 1);
  assert.equal(harness.calls.active, 1);
  assert.equal(harness.calls.listInput.runtime, "boring");
  assert.equal(harness.getSession().current.uii, "u1");
  assert.equal(harness.getSession().stats.observedCalls[0].uii, "u1");
});

test("one session-owned PENDING extern displays dialing before RingCX emits its UII", async () => {
  const harness = buildRuntimeHarness({
    outstandingLeads: [{
      externId: "cxbl-wynn-123456789abc-6a4dfd5778d3657be4f15120",
      leadState: "PENDING",
    }],
  });

  await harness.runtime.watch();

  const session = harness.getSession();
  assert.equal(session.current.queueItemId, "6a4dfd5778d3657be4f15120");
  assert.equal(session.current.name, "Lead 1");
  assert.equal(session.current.externId, "cxbl-wynn-123456789abc-6a4dfd5778d3657be4f15120");
  assert.equal(session.current.uii, null);
  assert.equal(session.current.status, "dialing");
  assert.equal(session.phase, "dialing");
  assert.deepEqual(session.stats.observedCalls || [], []);
  assert.equal(harness.calls.outbox.length, 0);
});

test("two session-owned PENDING externs are ambiguous and display no current lead", async () => {
  const harness = buildRuntimeHarness({
    outstandingLeads: [
      { externId: "cxbl-wynn-123456789abc-6a4dfd5778d3657be4f15120", leadState: "PENDING" },
      { externId: "cxbl-wynn-123456789abc-6a4dfd5778d3657be4f15121", leadState: "PENDING" },
    ],
  });

  await harness.runtime.watch();

  assert.equal(harness.getSession().current, null);
  assert.deepEqual(harness.getSession().stats.observedCalls || [], []);
  assert.equal(harness.calls.outbox.length, 0);
});

test("backend watch records RingCX terminal disposition before release fallback", async () => {
  const harness = buildRuntimeHarness({
    session: {
      stats: {
        observedCalls: [{
          queueItemId: "6a4dfd5778d3657be4f15120",
          externId: "cxbl-wynn-123456789abc-6a4dfd5778d3657be4f15120",
          uii: "u1",
          domain: "WYNN",
          caseId: 101,
          phone: "3105551210",
          lastSeenAt: new Date(Date.now() - 5_000).toISOString(),
        }],
      },
    },
    activeCalls: [{ externalId: "cxbl-wynn-123456789abc-6a4dfd5778d3657be4f15121", uii: "u2", callState: "ACTIVE" }],
    terminalLeads: [{
      externId: "cxbl-wynn-123456789abc-6a4dfd5778d3657be4f15120",
      leadState: "COMPLETE",
      lastPassDispo: "ANSWER",
    }],
  });

  await harness.runtime.watch();

  assert.equal(harness.calls.outbox.length, 1);
  assert.equal(harness.calls.outbox[0].uii, "u1");
  assert.equal(harness.calls.outbox[0].outcome, "answered");
  assert.equal(harness.calls.outbox[0].source, "ringcx-system-disposition");
  assert.deepEqual(harness.getSession().stats.observedCalls.map((row) => row.uii), ["u2"]);
});

test("backend watch keeps a released UII pending until RingCX supplies a disposition", async () => {
  const harness = buildRuntimeHarness({
    session: {
      stats: {
        observedCalls: [{
          queueItemId: "6a4dfd5778d3657be4f15120",
          externId: "cxbl-wynn-123456789abc-6a4dfd5778d3657be4f15120",
          uii: "u1",
          domain: "WYNN",
          caseId: 101,
          phone: "3105551210",
          lastSeenAt: new Date(Date.now() - 5_000).toISOString(),
        }],
      },
    },
    activeCalls: [{ externalId: "cxbl-wynn-123456789abc-6a4dfd5778d3657be4f15121", uii: "u2", callState: "ACTIVE" }],
    outstandingLeads: [{
      externId: "cxbl-wynn-123456789abc-6a4dfd5778d3657be4f15120",
      leadState: "READY",
    }],
  });

  await harness.runtime.watch();

  assert.equal(harness.calls.outbox.length, 0);
  assert.deepEqual(harness.getSession().stats.observedCalls.map((row) => row.uii).sort(), ["u1", "u2"]);
  const released = harness.getSession().stats.observedCalls.find((row) => row.uii === "u1");
  assert.ok(released.releasedAt);
  assert.equal(released.releaseSource, "active-call-feed");
});

test("worker-first disappearance leaves a grace window for the exact wrap button", async () => {
  const pending = {
    queueItemId: "6a4dfd5778d3657be4f15120",
    externId: "cxbl-wynn-123456789abc-6a4dfd5778d3657be4f15120",
    uii: "u1",
    domain: "WYNN",
    caseId: 101,
    phone: "3105551210",
    lastSeenAt: new Date().toISOString(),
  };
  const harness = buildRuntimeHarness({
    session: { current: pending, stats: { observedCalls: [pending] } },
    activeCalls: [],
    terminalLeads: [],
  });

  await harness.runtime.watch();

  assert.equal(harness.getSession().current, null, "the center clears when RingCX drains");
  assert.deepEqual(harness.getSession().stats.observedCalls.map((row) => row.uii), ["u1"]);
  assert.equal(harness.calls.outbox.length, 0, "the worker does not beat the human during grace");

  const result = await harness.runtime.disposition({
    sessionId: AGENT.sessionId,
    agentEmail: "agent@example.test",
    disposition: "voicemail",
    expectedExternId: pending.externId,
    expectedUii: pending.uii,
    nextAction: "ringcx_vm_drop",
  }, { user: { email: "agent@example.test" } });

  assert.equal(result.dispositionOk, true);
  assert.equal(harness.calls.dispositions.length, 1);
  assert.equal(harness.calls.outbox.length, 1);
  assert.equal(harness.calls.outbox[0].uii, "u1");
  assert.equal(harness.calls.outbox[0].outcome, "voicemail");
  assert.equal(harness.calls.outbox[0].payload.nextAction, "ringcx_vm_drop");

  harness.state.terminalLeads = [{
    externId: pending.externId,
    uii: pending.uii,
    leadState: "COMPLETE",
    lastPassDispo: "ANSWER",
  }];
  await harness.runtime.watch();
  assert.equal(harness.calls.outbox.length, 1, "later RingCX state cannot relabel the button outcome");
});

test("an active-call read failure does not retire pending UIIs", async () => {
  let session = {
    sessionId: AGENT.sessionId,
    runtime: "boring",
    status: "running",
    agentEmail: "agent@example.test",
    agentExtensionId: "agent-1",
    cxAgentId: "cx-agent-1",
    domain: "WYNN",
    ringcx: { accountId: "account-1", campaignId: "2306", dialGroupId: "963" },
    current: {
      queueItemId: "6a4dfd5778d3657be4f15120",
      externId: "cxbl-wynn-123456789abc-6a4dfd5778d3657be4f15120",
      uii: "u1",
    },
    stats: { observedCalls: [{ queueItemId: "6a4dfd5778d3657be4f15120", externId: "cxbl-wynn-123456789abc-6a4dfd5778d3657be4f15120", uii: "u1" }] },
  };
  let terminalWrites = 0;
  const runtime = createCxBoringDialerRuntime({
    client: { async listActiveCalls() { throw new Error("429"); } },
    CxDialQueue: {},
    cxBulkLoadSessionRepository: {
      async listActiveBulkLoadSessions() { return [session]; },
      async findBulkLoadSessionById() { return session; },
      async updateBulkLoadSession(_sessionId, patch) { session = { ...session, ...patch }; return session; },
    },
    cxTerminalOutboxRepository: {
      async insertOnce() { terminalWrites += 1; return {}; },
      async findByAgentUii() { return null; },
    },
  });

  const result = await runtime.watch();

  assert.equal(result.summary.errorCount, 1);
  assert.equal(session.current, null);
  assert.equal(session.stats.observedCalls[0].uii, "u1");
  assert.equal(terminalWrites, 0);
});

test("an owned active row without UII blanks current and skips every terminal path", async () => {
  const queueItemId = "6a4dfd5778d3657be4f15120";
  const externId = `cxbl-wynn-123456789abc-${queueItemId}`;
  const harness = buildRuntimeHarness({
    session: {
      current: { queueItemId, externId, uii: "u1" },
      stats: { observedCalls: [{ queueItemId, externId, uii: "u1", caseId: 101, phone: "3105551210" }] },
    },
    activeCalls: [{ externalId: externId, callState: "OUTDIAL" }],
    terminalLeads: [{ externId, leadState: "COMPLETE", lastPassDispo: "ANSWER" }],
  });

  const result = await harness.runtime.watch();

  assert.equal(result.summary.refreshedCount, 1);
  assert.equal(harness.getSession().current, null);
  assert.deepEqual(harness.getSession().stats.observedCalls.map((row) => row.uii), ["u1"]);
  assert.equal(harness.calls.search.length, 1);
  assert.deepEqual(harness.calls.search[0].leadStates, ["PENDING", "READY", "ACTIVE"]);
  assert.equal(harness.calls.outbox.length, 0);
});
