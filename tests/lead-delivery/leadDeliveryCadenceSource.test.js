"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createLeadDeliveryCadenceSource,
} = require("../../packages/shared-services/src/leadDeliveryService");

function sourceRow(overrides = {}) {
  return {
    _id: "cadence-1",
    domain: "TAG",
    caseId: 1001,
    firstName: "First",
    lastName: "Last",
    name: null,
    normalizedPhone: "5555550101",
    statusId: 1,
    active: true,
    currentStage: "new",
    createdAt: new Date("2026-07-09T18:00:00.000Z"),
    attributionContext: { receivedAt: new Date("2026-07-10T16:00:00.000Z") },
    payloadSnapshot: {
      createdAt: new Date("2026-07-10T17:00:00.000Z"),
      state: "OH",
      timeZone: "America/New_York",
    },
    cadenceState: { channelDnc: { cx: { blocked: false } } },
    dncCheckpoints: { hit: false },
    counterCadence: {
      cxDailyDateKey: "2026-07-10",
      cxDailyCalls: 1,
      lastCxDialedAt: new Date("2026-07-10T18:00:00.000Z"),
    },
    cadenceCounters: { cx: 7 },
    lastTouched: { cx: new Date("2026-07-10T18:00:00.000Z") },
    logicsStatusInvalidatedAt: new Date("2026-07-10T18:00:00.000Z"),
    logicsStatusCheckedAt: new Date("2026-07-10T18:01:00.000Z"),
    logicsProspectEligible: true,
    caseProfile: {
      statusId: 1,
      statusCategory: "prospect",
      paymentsCount: 0,
      totalPaid: 0,
    },
    ...overrides,
  };
}

function harness({
  row = sourceRow(),
  floor = {},
  window = { allowed: true },
  statusMaxAgeMs = 0,
} = {}) {
  const calls = [];
  const repository = {
    async readSourceBatch(input) {
      calls.push({ method: "readSourceBatch", input });
      return { items: [row], nextCursor: null, done: true };
    },
    async readSourceLead(input) {
      calls.push({ method: "readSourceLead", input });
      return row;
    },
    async readLegacyDailyAttemptFloor(input) {
      calls.push({ method: "readLegacyDailyAttemptFloor", input });
      return {
        cadenceDailyCount: 0,
        terminalOutboxCallCount: 0,
        callLogSessionCount: 0,
        mpiFillerDailyAttempts: 0,
        ...floor,
      };
    },
  };
  const source = createLeadDeliveryCadenceSource({
    repository,
    domains: ["tag"],
    policyForDomain: () => ({ allowedProspectStatusIds: [1, 2], dncStatusIds: [99] }),
    contactWindowEvaluator: () => window,
    statusMaxAgeMs,
  });
  return { source, calls };
}

test("cadence source uses receipt evidence order and keeps batch reads provider-dark", async () => {
  const { source, calls } = harness();
  const batch = await source.readBatch({ now: new Date("2026-07-10T19:00:00.000Z"), limit: 25 });

  assert.equal(batch.items.length, 1);
  assert.equal(batch.items[0].receivedAt.toISOString(), "2026-07-10T17:00:00.000Z");
  assert.equal(batch.items[0].normalizedPhone, "5555550101");
  assert.equal(batch.items[0].dailyAttemptCount, 1);
  assert.equal(batch.items[0].totalAttemptCount, 7);
  assert.deepEqual(batch.items[0].eligibility, { ok: true, reason: "contactable", retryable: false });
  assert.equal(calls.filter((call) => call.method === "readLegacyDailyAttemptFloor").length, 0);
});

test("legacy voice touch persists the two-hour follow-up timer", async () => {
  const { source } = harness();
  const batch = await source.readBatch({
    now: new Date("2026-07-10T18:05:00.000Z"),
    limit: 25,
  });
  const item = batch.items[0];
  assert.equal(item.state, "follow_up_wait");
  assert.equal(item.nextContactAt.toISOString(), "2026-07-10T20:00:00.000Z");
});

test("claim-time read takes MAX legacy evidence and proves the contact window", async () => {
  const { source, calls } = harness({
    floor: {
      cadenceDailyCount: 1,
      terminalOutboxCallCount: 2,
      callLogSessionCount: 1,
      mpiFillerDailyAttempts: 0,
    },
  });
  const item = await source.readOne({
    domain: "TAG",
    caseId: 1001,
    now: new Date("2026-03-08T19:00:00.000Z"),
  });

  assert.equal(item.dailyAttemptCount, 2);
  const floorCall = calls.find((call) => call.method === "readLegacyDailyAttemptFloor");
  assert.equal(floorCall.input.dateKey, "2026-03-08");
  assert.equal(floorCall.input.dayStart.toISOString(), "2026-03-08T08:00:00.000Z");
  assert.equal(floorCall.input.dayEnd.toISOString(), "2026-03-09T07:00:00.000Z");
  assert.equal(item.eligibility.ok, true);
});

test("claim-time source uses cadence DNC and contact window, never CaseProfile payment state", async () => {
  const dnc = harness({ row: sourceRow({
    cadenceState: { channelDnc: { cx: { blocked: true } } },
  }) });
  assert.equal((await dnc.source.readOne({ domain: "TAG", caseId: 1001 })).eligibility.reason, "voice-channel-dnc");

  const paid = harness({ row: sourceRow({
    caseProfile: { statusId: 1, statusCategory: "prospect", paymentsCount: 1, totalPaid: 100 },
  }) });
  assert.equal((await paid.source.readOne({ domain: "TAG", caseId: 1001 })).eligibility.ok, true);

  const closed = harness({ window: {
    allowed: false,
    reason: "before-window",
    nextAllowedAt: new Date("2026-07-13T15:00:00.000Z"),
  } });
  const closedItem = await closed.source.readOne({ domain: "TAG", caseId: 1001 });
  assert.equal(closedItem.eligibility.reason, "before-window");
  assert.equal(closedItem.eligibility.retryable, true);
});

test("LeadCadence Logics evidence is authoritative and CaseProfile is not required", async () => {
  const cadenceClosed = harness({ row: sourceRow({
    statusId: 99,
    caseProfile: { statusId: 1, statusCategory: "prospect", paymentsCount: 0, totalPaid: 0 },
  }) });
  assert.equal(
    (await cadenceClosed.source.readOne({ domain: "TAG", caseId: 1001 })).eligibility.reason,
    "logics-dnc-status",
  );

  const noProfile = harness({ row: sourceRow({
    statusId: 1,
    caseProfile: null,
  }) });
  assert.equal((await noProfile.source.readOne({ domain: "TAG", caseId: 1001 })).eligibility.ok, true);
});

test("intake status ships untouched leads and post-touch retries require newer Logics proof", async () => {
  const now = new Date("2026-07-10T19:00:00.000Z");
  const maxAge = 24 * 60 * 60 * 1000;
  const untouched = {
    totalAttemptCount: 0,
    lastContactAt: null,
    cadenceCounters: { cx: 0 },
    lastTouched: { cx: null },
    counterCadence: { cxDailyDateKey: null, cxDailyCalls: 0, lastCxDialedAt: null },
  };
  const fresh = harness({
    row: sourceRow({
      caseProfile: null,
      totalAttemptCount: 1,
      lastContactAt: new Date("2026-07-10T17:30:00.000Z"),
      logicsStatusInvalidatedAt: new Date("2026-07-10T17:30:00.000Z"),
      logicsStatusCheckedAt: new Date("2026-07-10T18:00:00.000Z"),
      logicsProspectEligible: true,
    }),
    statusMaxAgeMs: maxAge,
  });
  assert.equal(
    (await fresh.source.readOne({ domain: "TAG", caseId: 1001, now })).eligibility.ok,
    true,
  );

  const missing = harness({ row: sourceRow(untouched), statusMaxAgeMs: maxAge });
  assert.equal(
    (await missing.source.readOne({ domain: "TAG", caseId: 1001, now })).eligibility.ok,
    true,
  );

  const touchedMissing = harness({
    row: sourceRow({
      totalAttemptCount: 1,
      lastContactAt: new Date("2026-07-10T17:30:00.000Z"),
      logicsStatusInvalidatedAt: new Date("2026-07-10T17:30:00.000Z"),
      logicsStatusCheckedAt: null,
    }),
    statusMaxAgeMs: maxAge,
  });
  assert.equal(
    (await touchedMissing.source.readOne({ domain: "TAG", caseId: 1001, now })).eligibility.reason,
    "status-freshness-unproven",
  );

  const untouchedStale = harness({
    row: sourceRow({
      ...untouched,
      caseProfile: null,
      logicsStatusCheckedAt: new Date("2026-07-09T18:59:59.999Z"),
      logicsProspectEligible: true,
    }),
    statusMaxAgeMs: maxAge,
  });
  assert.equal(
    (await untouchedStale.source.readOne({ domain: "TAG", caseId: 1001, now })).eligibility.ok,
    true,
  );

  const touchedStale = harness({
    row: sourceRow({
      caseProfile: null,
      totalAttemptCount: 1,
      lastContactAt: new Date("2026-07-10T17:30:00.000Z"),
      logicsStatusCheckedAt: new Date("2026-07-09T18:59:59.999Z"),
      logicsStatusInvalidatedAt: null,
      logicsProspectEligible: true,
    }),
    statusMaxAgeMs: maxAge,
  });
  assert.equal(
    (await touchedStale.source.readOne({ domain: "TAG", caseId: 1001, now })).eligibility.reason,
    "status-stale",
  );

  const invalidated = harness({
    row: sourceRow({
      caseProfile: null,
      totalAttemptCount: 1,
      lastContactAt: new Date("2026-07-10T18:30:00.000Z"),
      logicsStatusCheckedAt: new Date("2026-07-10T18:00:00.000Z"),
      logicsStatusInvalidatedAt: new Date("2026-07-10T18:30:00.000Z"),
      logicsProspectEligible: true,
    }),
    statusMaxAgeMs: maxAge,
  });
  assert.equal(
    (await invalidated.source.readOne({ domain: "TAG", caseId: 1001, now })).eligibility.reason,
    "status-invalidated-after-touch",
  );

  const invalidatedWithoutAgeGate = harness({
    row: sourceRow({
      totalAttemptCount: 1,
      lastContactAt: new Date("2026-07-10T18:30:00.000Z"),
      logicsStatusCheckedAt: new Date("2026-07-10T18:00:00.000Z"),
      logicsStatusInvalidatedAt: new Date("2026-07-10T18:30:00.000Z"),
      logicsProspectEligible: true,
    }),
    statusMaxAgeMs: 0,
  });
  assert.equal(
    (await invalidatedWithoutAgeGate.source.readOne({ domain: "TAG", caseId: 1001, now })).eligibility.reason,
    "status-invalidated-after-touch",
  );
});

test("scheduled appointment hold is never callable", async () => {
  const scheduled = harness({ row: sourceRow({
    currentStage: "cx-appointment-scheduled",
    payloadSnapshot: {
      createdAt: new Date("2026-07-10T17:00:00.000Z"),
      cxAppointment: { appointmentId: "appointment-1", status: "scheduled" },
    },
  }) });
  assert.equal(
    (await scheduled.source.readOne({ domain: "TAG", caseId: 1001 })).eligibility.reason,
    "appointment-scheduled",
  );
});

test("canonical active appointment evidence is never callable even when cadence mirror is missing", async () => {
  const scheduled = harness({ row: sourceRow({
    currentStage: "new",
    payloadSnapshot: {
      createdAt: new Date("2026-07-10T17:00:00.000Z"),
    },
    activeAppointment: {
      appointmentId: "appointment-canonical-1",
      status: "scheduled",
      legalDialAt: new Date("2026-07-14T17:00:00.000Z"),
    },
  }) });
  assert.equal(
    (await scheduled.source.readOne({ domain: "TAG", caseId: 1001 })).eligibility.reason,
    "appointment-active",
  );
});

test("persistent DNC evidence blocks delivery even when the channel flag drifted", async () => {
  const dnc = harness({ row: sourceRow({
    cadenceState: { channelDnc: { cx: { blocked: false } } },
    counterCadence: {
      cxDailyDateKey: "2026-07-10",
      cxDailyCalls: 1,
      lastCxDialedAt: new Date("2026-07-10T18:00:00.000Z"),
      lastCxDncAt: new Date("2026-07-10T18:01:00.000Z"),
    },
  }) });
  assert.equal(
    (await dnc.source.readOne({ domain: "TAG", caseId: 1001 })).eligibility.reason,
    "voice-dnc-recorded",
  );
});

test("answered-today evidence fails closed until an explicit outcome resolves it", async () => {
  const now = new Date("2026-07-10T19:00:00.000Z");
  const answeredToday = harness({ row: sourceRow({
    counterCadence: {
      cxDailyDateKey: "2026-07-10",
      cxDailyCalls: 1,
      lastCxDialedAt: new Date("2026-07-10T18:00:00.000Z"),
      lastCxAnsweredAt: new Date("2026-07-10T18:01:00.000Z"),
    },
  }) });
  assert.equal(
    (await answeredToday.source.readOne({ domain: "TAG", caseId: 1001, now })).eligibility.reason,
    "answered-today-needs-resolution",
  );

  const answeredYesterday = harness({ row: sourceRow({
    counterCadence: {
      cxDailyDateKey: "2026-07-09",
      cxDailyCalls: 1,
      lastCxDialedAt: new Date("2026-07-09T18:00:00.000Z"),
      lastCxAnsweredAt: new Date("2026-07-09T18:01:00.000Z"),
    },
  }) });
  assert.equal(
    (await answeredYesterday.source.readOne({ domain: "TAG", caseId: 1001, now })).eligibility.ok,
    true,
  );

  const explicitlyResolvedDnc = harness({ row: sourceRow({
    statusId: 99,
    caseProfile: { statusId: 99, statusCategory: "dnc", paymentsCount: 0, totalPaid: 0 },
    counterCadence: {
      cxDailyDateKey: "2026-07-10",
      cxDailyCalls: 1,
      lastCxDialedAt: new Date("2026-07-10T18:00:00.000Z"),
      lastCxAnsweredAt: new Date("2026-07-10T18:01:00.000Z"),
    },
  }) });
  assert.equal(
    (await explicitlyResolvedDnc.source.readOne({ domain: "TAG", caseId: 1001, now })).eligibility.reason,
    "logics-dnc-status",
  );
});

test("pre-position intent skips only the current-clock window and keeps other claim checks", async () => {
  const closed = harness({ window: {
    allowed: false,
    reason: "weekend-window-closed",
    nextAllowedAt: new Date("2026-07-13T15:00:00.000Z"),
  } });
  const prepositioned = await closed.source.readOne({
    domain: "TAG",
    caseId: 1001,
    deliveryIntent: "preposition",
  });
  assert.equal(prepositioned.eligibility.ok, true);

  const unknownIntent = await closed.source.readOne({
    domain: "TAG",
    caseId: 1001,
    deliveryIntent: "anything_else",
  });
  assert.equal(unknownIntent.eligibility.reason, "weekend-window-closed");

  const dnc = harness({
    row: sourceRow({ cadenceState: { channelDnc: { cx: { blocked: true } } } }),
    window: { allowed: false, reason: "weekend-window-closed" },
  });
  const blocked = await dnc.source.readOne({
    domain: "TAG",
    caseId: 1001,
    deliveryIntent: "preposition",
  });
  assert.equal(blocked.eligibility.reason, "voice-channel-dnc");
});

test("source continuation performs one bounded page without an unconditional hot-head reread", async () => {
  const older = sourceRow({ _id: "cadence-old", caseId: 1002 });
  const newest = sourceRow({ _id: "cadence-new", caseId: 1003 });
  const calls = [];
  const repository = {
    async readSourceBatch(input) {
      calls.push(input);
      if (input.cursor) return { items: [older], nextCursor: { createdAt: "older", id: "old" }, done: false };
      return { items: [newest], nextCursor: null, done: true };
    },
    async readSourceLead() { return newest; },
    async readLegacyDailyAttemptFloor() {
      return { cadenceDailyCount: 0, terminalOutboxCallCount: 0, callLogSessionCount: 0, mpiFillerDailyAttempts: 0 };
    },
  };
  const source = createLeadDeliveryCadenceSource({
    repository,
    domains: ["TAG"],
    contactWindowEvaluator: () => ({ allowed: true }),
  });
  const cursor = { createdAt: "2026-01-01T00:00:00.000Z", id: "cursor" };
  const batch = await source.readBatch({ cursor, limit: 5, now: new Date("2026-07-10T19:00:00.000Z") });

  assert.deepEqual(batch.items.map((item) => item.caseId), ["1002"]);
  assert.deepEqual(batch.nextCursor, { createdAt: "older", id: "old" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cursor, cursor);
});
