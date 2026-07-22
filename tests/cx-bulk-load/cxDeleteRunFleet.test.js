"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createCxBulkLoadRuntimeService,
} = require("../../packages/shared-services/src/cxBulkLoadRuntimeService");
const { reduceCxBulkLoadState } = require("../../packages/shared-services/src/cxBulkLoadStateMachine");
const watcher = require("../../packages/shared-services/src/cxBulkLoadActiveCallWatcher");
const leadSource = require("../../packages/shared-services/src/cxBulkLoadLeadSourceService");
const publisher = require("../../packages/shared-services/src/cxBulkLoadRingcxPublisher");
const {
  buildReviewCorrectionRow,
} = require("../../packages/shared-services/src/cxBulkLoadOutcomeAdapter");
const {
  createCxCallWrapCardService,
} = require("../../packages/shared-services/src/cxCallWrapCardService");
const {
  createCxAppointmentDispatcher,
} = require("../../packages/shared-services/src/cxAppointmentDispatchService");

const NOW = new Date("2026-07-07T17:00:00.000Z");
const MICKEY = Object.freeze({
  email: "mgray@taxadvocategroup.com",
  extensionId: "63730035004",
  cxAgentId: "21018",
  domain: "WYNN",
  accountId: "acct-mickey",
  campaignId: "camp-mickey",
});

function makeRepo() {
  const store = new Map();
  return {
    store,
    async createBulkLoadSession(seed) {
      const doc = { __v: 0, current: null, acceptedBuffer: [], completed: [], stats: {}, trace: {}, ...seed };
      store.set(seed.sessionId, doc);
      return { ...doc };
    },
    async findBulkLoadSessionById(id) {
      const doc = store.get(id);
      return doc ? { ...doc } : null;
    },
    async updateBulkLoadSession(id, patch, options = {}) {
      const current = store.get(id) || {};
      if (options.versionGuard && options.expectedVersion != null && current.__v !== options.expectedVersion) return null;
      if (options.versionGuard && options.expectedUpdatedAt != null && current.updatedAt !== options.expectedUpdatedAt) return null;
      const next = { ...current, ...patch, sessionId: id, __v: Number(current.__v || 0) + 1 };
      store.set(id, next);
      return { ...next };
    },
    async findActiveBulkLoadSessionForAgent({ agentEmail }) {
      for (const doc of store.values()) {
        if (doc.agentEmail === agentEmail && doc.status === "running") return { ...doc };
      }
      return null;
    },
    async findActiveBulkLoadSessionsForAgent({ agentEmail }) {
      return Array.from(store.values())
        .filter((doc) => doc.agentEmail === agentEmail && doc.status === "running")
        .map((doc) => ({ ...doc }));
    },
    async listActiveBulkLoadSessions(input = {}) {
      return Array.from(store.values())
        .filter((doc) => doc.status === "running")
        .filter((doc) => !input.sessionId || doc.sessionId === input.sessionId)
        .map((doc) => ({ ...doc }));
    },
  };
}

function makeClient(liveCalls) {
  const calls = { loads: [], dispositions: [], cancels: [] };
  return {
    calls,
    async loadLeads(campaignId, payload) {
      calls.loads.push({ campaignId, payload });
      return {
        processingStatus: "COMPLETE",
        leadsSupplied: payload.uploadLeads.length,
        leadsInserted: payload.uploadLeads.length,
        rejectedRows: [],
      };
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
  return {
    writes,
    async persistTerminalOutcome(input) {
      writes.push(input);
      return { written: true, idemKey: `${input.candidate?.queueItemId}:${input.candidate?.uii}` };
    },
  };
}

function makeReservation(pool) {
  const rows = pool.map((row) => ({ ...row }));
  const released = [];
  const cancelled = [];
  return {
    released,
    cancelled,
    async reserveFromFamilyOrder(args = {}) {
      const count = Math.max(Number(args.totalLimit) || 0, 0);
      return {
        reserved: rows.splice(0, count).map((row) => ({
          ...row,
          metadata: { ...(row.metadata || {}), reservationSessionId: args.sessionId },
        })),
        missing: {},
      };
    },
    async releaseReserved(items = []) {
      for (const item of items) released.push(String(item._id || item.queueItemId || ""));
    },
    async cancelReserved(items = []) {
      for (const item of items) cancelled.push(String(item._id || item.queueItemId || ""));
    },
  };
}

function mickeyRows() {
  return [
    { _id: "mickey-q1", domain: MICKEY.domain, caseId: 101001, phone: "3106660001", name: "Mickey Fleet One", queueFamily: "fresh-day2to10" },
    { _id: "mickey-q2", domain: MICKEY.domain, caseId: 101002, phone: "3106660002", name: "Mickey Fleet Two", queueFamily: "fresh-day2to10" },
    { _id: "mickey-q3", domain: MICKEY.domain, caseId: 101003, phone: "3106660003", name: "Mickey Fleet Three", queueFamily: "aged" },
  ];
}

function makeRuntime(liveCalls, overrides = {}) {
  const repo = overrides.repo || makeRepo();
  const client = makeClient(liveCalls);
  const outcomeAdapter = overrides.outcomeAdapter || makeOutcomeAdapter();
  const reservationService = makeReservation(overrides.pool || mickeyRows());
  const getLeadRequests = [];
  const leadStarter = overrides.leadStarter || {
    async getLeads({ session, candidate }) {
      getLeadRequests.push({ sessionId: session.sessionId, queueItemId: candidate.queueItemId });
      return { ok: true, elapsedMs: 25, source: "fleet-fake-get-leads" };
    },
  };
  const service = createCxBulkLoadRuntimeService({
    repo,
    leadSource,
    publisher,
    watcher,
    outcomeAdapter,
    reservationService,
    leadStarter,
    terminalExecutor: async ({ candidate, outcome, callback, callBackDTS, notes }) => {
      const ok = await client.dispositionCall(candidate?.uii, { disposition: outcome, callback, callBackDTS, notes });
      return ok
        ? { ok: true, uii: candidate?.uii, disposition: outcome }
        : { ok: false, reason: "disposition-rejected" };
    },
    client,
    offhookGate: { isAgentOffhook: async () => ({ ok: true, reason: "fleet-offhook" }) },
    listReadyQueueItems: async () => [],
    reduce: reduceCxBulkLoadState,
    now: () => NOW,
    newSessionId: () => "fleet-mickey-session",
  });
  return { service, repo, client, outcomeAdapter, reservationService, getLeadRequests };
}

async function startMickeyFleet(service) {
  return service.startCxBulkLoadSession({
    sessionId: "fleet-mickey-session",
    agentEmail: MICKEY.email,
    agentExtensionId: MICKEY.extensionId,
    cxAgentId: MICKEY.cxAgentId,
    domain: MICKEY.domain,
    ringcx: { accountId: MICKEY.accountId, campaignId: MICKEY.campaignId },
    targetSize: 2,
    refillThreshold: 1,
    familyTargets: { "fresh-day2to10": 2, aged: 1 },
  });
}

test("DELETE-RUN FLEET: Mickey bulk lead publish, poller match, button disposition, terminal write, advance", async () => {
  const liveCalls = { value: [] };
  const { service, client, outcomeAdapter, getLeadRequests } = makeRuntime(liveCalls);
  const started = await startMickeyFleet(service);

  assert.equal(started.agentEmail, MICKEY.email);
  assert.equal(started.bufferCount, 2);
  assert.equal(client.calls.loads.length, 2, "bulk publish still loads fake Mickey leads to the RingCX buffer");
  assert.ok(started.remainingQueue.every((candidate) => String(candidate.externId || "").startsWith("cxbl-wynn-")));

  const first = started.remainingQueue[0];
  liveCalls.value = [{ externalId: first.externId, uii: "uii-mickey-1", callState: "connected" }];
  await service.watchAccountActiveCalls({ sessionId: "fleet-mickey-session", answeredMinConnectedMs: 0 });
  const matched = await service.getCxBulkLoadSession({ sessionId: "fleet-mickey-session" });
  assert.equal(matched.current.queueItemId, "mickey-q1");
  assert.equal(matched.current.uii, "uii-mickey-1");

  const noAnswer = await service.submitCxBulkLoadDisposition({
    sessionId: "fleet-mickey-session",
    disposition: "did_not_connect",
  });
  assert.equal(noAnswer.dispositionOk, true);
  assert.equal(noAnswer.current, null);
  assert.equal(noAnswer.completedCount, 1);
  assert.equal(outcomeAdapter.writes.length, 1);
  assert.equal(outcomeAdapter.writes[0].outcome, "did_not_connect");
  assert.equal(client.calls.dispositions[0].uii, "uii-mickey-1");
  assert.equal(getLeadRequests.length, 0, "RingCX owns the next call; the app does not prefetch a preview lead");

  const nextLead = noAnswer.remainingQueue.find((candidate) => candidate.queueItemId === "mickey-q2");
  assert.ok(nextLead, "next lead remains available for the watcher to match");
  liveCalls.value = [{ externalId: nextLead.externId, uii: "uii-mickey-2", callState: "connected" }];
  await service.watchAccountActiveCalls({ sessionId: "fleet-mickey-session", answeredMinConnectedMs: 0 });
  const matchedAgain = await service.getCxBulkLoadSession({ sessionId: "fleet-mickey-session" });
  assert.equal(matchedAgain.current.queueItemId, "mickey-q2");

  const voicemail = await service.submitCxBulkLoadDisposition({
    sessionId: "fleet-mickey-session",
    disposition: "voicemail",
  });
  assert.equal(voicemail.dispositionOk, true);
  assert.equal(voicemail.current, null);
  assert.equal(voicemail.completedCount, 2);
  assert.equal(outcomeAdapter.writes.length, 2);
  assert.equal(outcomeAdapter.writes[1].outcome, "voicemail");
  assert.equal(client.calls.dispositions.length, 2);
});

function makeWrapHarness() {
  const cards = new Map();
  const calls = { interviews: [], corrections: [], appointments: [], dncStatus: [] };
  const repository = {
    async insertOnce(card) {
      if (cards.has(card.idemKey)) return null;
      const stored = { status: "pending", ...card };
      cards.set(card.idemKey, stored);
      return { ...stored };
    },
    async findByIdemKey(idemKey) {
      const card = cards.get(idemKey);
      return card ? { ...card } : null;
    },
    async listPendingForAgent(agentEmail) {
      return Array.from(cards.values()).filter((card) => card.agentEmail === agentEmail && card.status === "pending");
    },
    async resolveCard(idemKey, resolution, detail = {}) {
      const card = cards.get(idemKey);
      if (!card || card.status !== "pending") return null;
      const resolved = {
        ...card,
        status: resolution,
        resolution,
        resolvedAt: NOW.toISOString(),
        resolutionDetail: detail.detail || null,
      };
      cards.set(idemKey, resolved);
      return { ...resolved };
    },
    async listDueForExpiry() {
      return [];
    },
  };
  const service = createCxCallWrapCardService({
    cardRepository: repository,
    outboxRepository: {
      async findByIdentity({ queueItemId, uii }) {
        return {
          idemKey: `${queueItemId}:${uii}`,
          payload: {
            sessionId: "fleet-mickey-session",
            queueItemId,
            uii,
            outcome: "answered",
            domain: MICKEY.domain,
            caseId: 101617,
            agentEmail: MICKEY.email,
            callSummary: "spoke to taxpayer and confirmed next step",
          },
        };
      },
      async insertOnce(row) {
        calls.corrections.push(row);
        return row;
      },
    },
    buildCorrectionRow: buildReviewCorrectionRow,
    writeInterview: async (card) => {
      calls.interviews.push(card.idemKey);
      return { ok: true };
    },
    createAppointment: async ({ card, appointmentAt }) => {
      calls.appointments.push({ idemKey: card.idemKey, appointmentAt });
      return { ok: true };
    },
    updateLogicsDncStatus: async (card) => {
      calls.dncStatus.push(card.idemKey);
      return { ok: true };
    },
    logger: { info() {}, warn() {}, error() {} },
  });
  return { service, calls, cards };
}

function terminalDrainPacket({ queueItemId, uii, idemKey }) {
  const payload = {
    sessionId: "fleet-mickey-session",
    queueItemId,
    uii,
    outcome: "answered",
    eventType: "terminal",
    nextAction: "call_wrap",
    domain: MICKEY.domain,
    caseId: 101617,
    agentEmail: MICKEY.email,
    name: "Mickey Fleet Answered",
    at: NOW.toISOString(),
    callSummary: "prospect answered and asked for a scheduled follow up",
  };
  return { row: { idemKey }, payload, coachSummary: null };
}

test("DELETE-RUN FLEET: answered drain item mints wrap card; DNC and appointment resolutions fire effects", async () => {
  const { service, calls, cards } = makeWrapHarness();

  const dncKey = "mickey-q3:uii-answer-1";
  const created = await service.createFromDrain(terminalDrainPacket({
    queueItemId: "mickey-q3",
    uii: "uii-answer-1",
    idemKey: dncKey,
  }));
  assert.deepEqual(created, { ok: true, created: true, idemKey: dncKey });
  assert.equal(cards.size, 1);

  const dnc = await service.resolve({ idemKey: dncKey, action: "dnc", resolvedBy: MICKEY.email });
  assert.equal(dnc.ok, true);
  assert.equal(dnc.effects.interview.ok, true);
  assert.equal(dnc.effects.correction.ok, true);
  assert.equal(dnc.effects.logicsStatus.ok, true);
  assert.equal(calls.interviews.length, 1);
  assert.equal(calls.corrections.length, 1);
  assert.equal(calls.corrections[0].outcome, "dnc");
  assert.match(calls.corrections[0].idemKey, /:review-dnc$/);
  assert.deepEqual(calls.dncStatus, [dncKey]);

  const appointmentKey = "mickey-q4:uii-answer-2";
  await service.createFromDrain(terminalDrainPacket({
    queueItemId: "mickey-q4",
    uii: "uii-answer-2",
    idemKey: appointmentKey,
  }));
  const appointmentAt = "2026-07-08T17:00:00.000Z";
  const appointment = await service.resolve({
    idemKey: appointmentKey,
    action: "appointment",
    appointmentAt,
    resolvedBy: MICKEY.email,
  });
  assert.equal(appointment.ok, true);
  assert.equal(appointment.effects.interview.ok, true);
  assert.equal(appointment.effects.appointment.ok, true);
  assert.deepEqual(calls.appointments, [{ idemKey: appointmentKey, appointmentAt }]);
});

test("DELETE-RUN FLEET: due Mickey appointment publishes to Mickey campaign; future/unmapped wait or skip", async () => {
  const now = new Date("2026-07-08T17:00:05.000Z");
  const appointments = [
    {
      appointmentId: "appointment:mickey-due",
      domain: MICKEY.domain,
      caseId: 101617,
      agentEmail: MICKEY.email,
      phone: "3106660004",
      prospectName: "Mickey Appointment Due",
      appointmentAt: "2026-07-08T17:00:00.000Z",
      legalDialAt: "2026-07-08T16:00:00.000Z",
      status: "scheduled",
      rcxDispatch: null,
    },
    {
      appointmentId: "appointment:mickey-future",
      domain: MICKEY.domain,
      caseId: 101618,
      agentEmail: MICKEY.email,
      phone: "3106660005",
      prospectName: "Mickey Appointment Later",
      appointmentAt: "2026-07-08T19:00:00.000Z",
      legalDialAt: "2026-07-08T16:00:00.000Z",
      status: "scheduled",
      rcxDispatch: null,
    },
    {
      appointmentId: "appointment:unmapped",
      domain: MICKEY.domain,
      caseId: 101619,
      agentEmail: "ghost@example.invalid",
      phone: "3106660006",
      prospectName: "Unmapped Appointment",
      appointmentAt: "2026-07-08T17:00:00.000Z",
      legalDialAt: "2026-07-08T16:00:00.000Z",
      status: "scheduled",
      rcxDispatch: null,
    },
  ];
  const published = [];
  const stamped = [];
  const dispatcher = createCxAppointmentDispatcher({
    isEnabled: () => true,
    resolveQueueMap: () => [{ agentEmail: MICKEY.email, campaignId: MICKEY.campaignId }],
    resolveLeadMs: () => 0,
    listDispatchable: async () => appointments.filter((appointment) => !appointment.rcxDispatch),
    claimAppointment: async (appointmentId, claim) => {
      const appointment = appointments.find((item) => item.appointmentId === appointmentId);
      if (!appointment || appointment.rcxDispatch) return false;
      appointment.rcxDispatch = claim;
      return true;
    },
    stampAppointment: async (appointmentId, fields) => {
      stamped.push({ appointmentId, fields });
    },
    releaseClaim: async (appointmentId) => {
      const appointment = appointments.find((item) => item.appointmentId === appointmentId);
      if (appointment) appointment.rcxDispatch = null;
    },
    publishBatch: async (_client, input) => {
      published.push(input);
      return { accepted: input.candidates, rejected: [] };
    },
    logger: { info() {}, warn() {}, error() {} },
  });

  const result = await dispatcher.tickOnce({ now });
  assert.equal(result.dispatched, 1);
  assert.equal(result.waiting, 1);
  assert.equal(published.length, 1);
  assert.equal(published[0].campaignId, MICKEY.campaignId);
  assert.equal(published[0].dialPriority, "IMMEDIATE");
  assert.equal(published[0].candidates[0].externId, "cxapt-appointment:mickey-due");
  assert.equal(published[0].candidates[0].caseId, 101617);
  assert.equal(stamped.length, 1);
  assert.equal(appointments[1].rcxDispatch, null, "future appointment did not publish early");
  assert.equal(appointments[2].rcxDispatch, null, "unmapped appointment did not borrow Mickey's queue");
});
