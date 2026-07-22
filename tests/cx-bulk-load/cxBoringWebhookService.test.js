"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ACTIONS,
  classifyDisposition,
  createCxBoringWebhookActionDrain,
  createCxBoringWebhookCallPoller,
  createCxBoringWebhookService,
  normalizeRingcxWebhook,
  parseDirectExternId,
} = require("../../packages/shared-services/src/cxBoringWebhookService");

function fakeRepository() {
  const memory = [];
  const actions = [];
  const completed = [];
  const failed = [];
  return {
    memory,
    actions,
    completed,
    failed,
    async upsertCallMemory(row) { memory.push(row); },
    async enqueueAction(row) {
      if (actions.some((entry) => entry.id === row.id)) return false;
      actions.push(row);
      return true;
    },
    async listPendingActions() { return actions; },
    async markActionCompleted(id, result) { completed.push({ id, result }); },
    async markActionFailed(id, error) { failed.push({ id, error }); },
  };
}

test("normalizes RingCX identity and strips the generated username suffix", () => {
  const event = normalizeRingcxWebhook({
    campaign_id: "2306",
    extern_id: "cx-direct-wynn-1234",
    uii: "u-1",
    agent_id: "21018",
    agent_username: "mgray+50810001_9702@taxadvocategroup.com",
    lead_state: "ACTIVE",
    pass_disposition: "ANSWER",
  }, { receivedAt: new Date("2026-07-10T17:00:00.000Z") });
  assert.deepEqual(parseDirectExternId(event.externId), { domain: "WYNN", caseId: 1234 });
  assert.equal(event.agentEmail, "mgray@taxadvocategroup.com");
  assert.equal(event.outcome, "answered");
  assert.equal(classifyDisposition("Auto Dispo"), null);
});

test("active ANSWER is call memory only; the webhook does not invent business work", async () => {
  const repository = fakeRepository();
  const service = createCxBoringWebhookService({ repository });
  const result = await service.ingest({
    campaign_id: "2306",
    extern_id: "cx-direct-wynn-1234",
    uii: "u-1",
    agent_username: "mgray@example.com",
    lead_state: "ACTIVE",
    pass_disposition: "ANSWER",
  });
  assert.equal(result.remembered, true);
  assert.equal(result.actionQueued, false);
  assert.equal(result.reason, "memory-only");
  assert.equal(repository.memory[0].status, "active");
  assert.equal(repository.actions.length, 0);
});

test("DNC and bad lead share one durable Logics action", async () => {
  for (const disposition of ["DNC", "Bad Lead", "Bad Number"]) {
    const repository = fakeRepository();
    const service = createCxBoringWebhookService({ repository });
    const result = await service.ingest({
      campaign_id: "2306",
      extern_id: "cx-direct-wynn-1234",
      uii: `u-${disposition}`,
      agent_username: "mgray@example.com",
      lead_state: "COMPLETE",
      agent_disposition: disposition,
    });
    assert.equal(result.actionQueued, true);
    assert.equal(repository.actions[0].type, ACTIONS.LOGICS_DNC);
    assert.equal(repository.actions[0].domain, "WYNN");
    assert.equal(repository.actions[0].caseId, 1234);
  }
});

test("appointment without time queues only the Boring date/time prompt", async () => {
  const repository = fakeRepository();
  const service = createCxBoringWebhookService({ repository });
  await service.ingest({
    campaign_id: "2306",
    extern_id: "cx-direct-wynn-1234",
    uii: "u-appt",
    agent_username: "mgray@example.com",
    lead_state: "COMPLETE",
    agent_disposition: "Appointment",
  });
  assert.equal(repository.actions[0].type, ACTIONS.APPOINTMENT_PROMPT);
});

test("appointment date/time in RingCX bypasses the fallback prompt", async () => {
  const repository = fakeRepository();
  const service = createCxBoringWebhookService({ repository });
  await service.ingest({
    campaign_id: "2306",
    extern_id: "cx-direct-wynn-1234",
    uii: "u-appt",
    agent_username: "mgray@example.com",
    lead_state: "COMPLETE",
    agent_disposition: "Appointment",
    appointment_date: "2026-07-11",
    appointment_time: "10:30",
    appointment_timezone: "America/Los_Angeles",
  });
  assert.equal(repository.actions[0].type, ACTIONS.APPOINTMENT);
});

test("cadence actions carry the observed retry timestamp and dedupe", async () => {
  const repository = fakeRepository();
  const service = createCxBoringWebhookService({ repository, cadenceDelayMs: 30 * 60 * 1000 });
  const body = {
    extern_id: "cx-direct-wynn-1234",
    uii: "u-no-answer",
    agent_username: "mgray@example.com",
    lead_state: "COMPLETE",
    pass_disposition: "NO ANSWER",
  };
  const at = new Date("2026-07-10T17:00:00.000Z");
  const first = await service.ingest(body, { receivedAt: at });
  const duplicate = await service.ingest(body, { receivedAt: at });
  assert.equal(first.actionQueued, true);
  assert.equal(duplicate.duplicate, true);
  assert.equal(repository.actions[0].type, ACTIONS.CADENCE);
  assert.equal(repository.actions[0].nextEligibleAt.toISOString(), "2026-07-10T17:30:00.000Z");
});

test("action drain isolates failures and never loses the other rows", async () => {
  const repository = fakeRepository();
  repository.actions.push(
    { id: "a", type: ACTIONS.LOGICS_DNC },
    { id: "b", type: ACTIONS.CADENCE },
  );
  const drain = createCxBoringWebhookActionDrain({
    repository,
    handlers: {
      [ACTIONS.LOGICS_DNC]: async () => { throw new Error("logics down"); },
      [ACTIONS.CADENCE]: async () => ({ ok: true }),
    },
    logger: { warn() {} },
  });
  const result = await drain.drainOnce();
  assert.deepEqual(result, { scanned: 2, completed: 1, failed: 1 });
  assert.equal(repository.failed[0].id, "a");
  assert.equal(repository.completed[0].id, "b");
});

test("fallback poller repairs display memory but never creates an outcome", async () => {
  const ingested = [];
  const retired = [];
  const poller = createCxBoringWebhookCallPoller({
    client: {
      async listActiveCalls() {
        return { activeCalls: [{ uii: "u-live", externalId: "cx-direct-wynn-1234", callState: "OUTDIAL", agentId: "9" }] };
      },
    },
    service: {
      async ingest(body) { ingested.push(body); return { remembered: true }; },
    },
    repository: {
      async retireMissingActive(uiis) { retired.push(uiis); return { modifiedCount: 0 }; },
    },
  });
  const result = await poller.pollOnce({ now: new Date("2026-07-10T17:00:00.000Z") });
  assert.deepEqual(result, { active: 1, remembered: 1, retired: 0 });
  assert.equal(ingested[0].lead_state, "OUTDIAL");
  assert.equal(ingested[0].agent_disposition, undefined);
  assert.deepEqual(retired[0], ["u-live"]);
});

test("empty confirmed poll clears display memory without inferring a terminal outcome", async () => {
  let retired = null;
  const poller = createCxBoringWebhookCallPoller({
    client: { async listActiveCalls() { return []; } },
    service: { async ingest() { throw new Error("should not run"); } },
    repository: {
      async retireMissingActive(uiis) { retired = uiis; return { modifiedCount: 2 }; },
    },
  });
  const result = await poller.pollOnce();
  assert.deepEqual(result, { active: 0, remembered: 0, retired: 2 });
  assert.deepEqual(retired, []);
});
