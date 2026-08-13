"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { buildEventDedupeKey } = require("../../packages/shared-services/src/leadDeliveryService");
const {
  createLeadDeliveryRepository,
} = require("../../packages/shared-repositories/src/leadDeliveryRepository");

function valueAt(object, dotted) {
  return String(dotted).split(".").reduce((value, key) => {
    if (Array.isArray(value)) return value.map((entry) => entry?.[key]).flat();
    return value?.[key];
  }, object);
}

function comparable(value) {
  return value instanceof Date ? value.getTime() : value;
}

function matchesValue(actual, expected) {
  if (Array.isArray(actual)) return actual.some((value) => matchesValue(value, expected));
  if (expected && typeof expected === "object" && !Array.isArray(expected) && !(expected instanceof Date)) {
    if (Object.hasOwn(expected, "$ne") && comparable(actual) === comparable(expected.$ne)) return false;
    if (Object.hasOwn(expected, "$eq") && comparable(actual) !== comparable(expected.$eq)) return false;
    if (Object.hasOwn(expected, "$lt") && !(comparable(actual) < comparable(expected.$lt))) return false;
    if (Object.hasOwn(expected, "$lte") && !(comparable(actual) <= comparable(expected.$lte))) return false;
    if (Object.hasOwn(expected, "$gte") && !(comparable(actual) >= comparable(expected.$gte))) return false;
    if (Object.hasOwn(expected, "$in") && !expected.$in.some((value) => comparable(actual) === comparable(value))) return false;
    return true;
  }
  if (expected === null) return actual == null;
  return comparable(actual) === comparable(expected);
}

function matches(document, filter) {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === "$and") return expected.every((clause) => matches(document, clause));
    if (key === "$or") return expected.some((clause) => matches(document, clause));
    return matchesValue(valueAt(document, key), expected);
  });
}

function setAt(object, dotted, value) {
  const keys = String(dotted).split(".");
  let cursor = object;
  while (keys.length > 1) {
    const key = keys.shift();
    cursor[key] ||= {};
    cursor = cursor[key];
  }
  cursor[keys[0]] = value;
}

function applyUpdate(document, update, { insert = false } = {}) {
  if (insert) {
    for (const [key, value] of Object.entries(update.$setOnInsert || {})) {
      setAt(document, key, structuredClone(value));
    }
  }
  for (const [key, value] of Object.entries(update.$set || {})) setAt(document, key, structuredClone(value));
  for (const key of Object.keys(update.$unset || {})) delete document[key];
  for (const [key, delta] of Object.entries(update.$inc || {})) {
    setAt(document, key, Number(valueAt(document, key) || 0) + delta);
  }
}

function projectRow(row, selection) {
  if (row == null || !selection) return row;
  const output = {};
  for (const [field, included] of Object.entries(selection)) {
    if (included !== 1) continue;
    const value = valueAt(row, field);
    if (value !== undefined) setAt(output, field, structuredClone(value));
  }
  return output;
}

class FakeQuery {
  constructor(run) {
    this.run = run;
    this.selection = null;
    this.maximum = null;
    this.order = null;
  }

  select(selection) {
    this.selection = structuredClone(selection);
    return this;
  }

  limit(maximum) {
    this.maximum = maximum;
    return this;
  }

  sort(order) {
    this.order = structuredClone(order);
    return this;
  }

  session() {
    return this;
  }

  async lean() {
    let result = this.run();
    if (!Array.isArray(result)) {
      result = result == null ? result : structuredClone(result);
      return this.selection ? projectRow(result, this.selection) : result;
    }
    result = result.map((row) => structuredClone(row));
    if (this.order) {
      const entries = Object.entries(this.order);
      result.sort((left, right) => {
        for (const [field, direction] of entries) {
          const a = comparable(valueAt(left, field));
          const b = comparable(valueAt(right, field));
          if (a < b) return -1 * direction;
          if (a > b) return 1 * direction;
        }
        return 0;
      });
    }
    if (this.maximum != null) result = result.slice(0, this.maximum);
    if (this.selection) result = result.map((row) => projectRow(row, this.selection));
    return result;
  }
}

function createFakeModel(initial = [], { createError = null } = {}) {
  const Model = {
    docs: structuredClone(initial),
    calls: [],
    findCalls: [],
    findOneCalls: [],
    async create(input) {
      if (createError) throw createError;
      const row = Array.isArray(input) ? input[0] : input;
      const created = {
        _id: row._id || `row-${Model.docs.length + 1}`,
        version: row.version ?? 0,
        ...structuredClone(row),
      };
      Model.docs.push(created);
      return Array.isArray(input) ? [structuredClone(created)] : structuredClone(created);
    },
    findOneAndUpdate(filter, update, options) {
      Model.calls.push({
        filter: structuredClone(filter),
        update: structuredClone(update),
        options: { ...options },
      });
      return new FakeQuery(() => {
        let found = Model.docs.find((document) => matches(document, filter));
        if (!found && options.upsert) {
          found = { _id: `row-${Model.docs.length + 1}`, version: 0 };
          for (const [field, value] of Object.entries(filter)) {
            if (!field.startsWith("$") && (value == null || typeof value !== "object" || value instanceof Date)) {
              setAt(found, field, structuredClone(value));
            }
          }
          applyUpdate(found, update, { insert: true });
          Model.docs.push(found);
          return structuredClone(found);
        }
        if (!found) return null;
        applyUpdate(found, update);
        return structuredClone(found);
      });
    },
    findOne(filter) {
      const call = { filter: structuredClone(filter), query: null };
      const query = new FakeQuery(() => {
        const found = Model.docs.find((document) => matches(document, filter));
        return found ? structuredClone(found) : null;
      });
      call.query = query;
      Model.findOneCalls.push(call);
      return query;
    },
    find(filter) {
      const call = { filter: structuredClone(filter), query: null };
      const query = new FakeQuery(() => Model.docs.filter((document) => matches(document, filter)));
      call.query = query;
      Model.findCalls.push(call);
      return query;
    },
    aggregate(pipeline) {
      const matchStage = pipeline.filter((stage) => stage.$match).at(-1)?.$match || {};
      const rows = [];
      for (const document of Model.docs) {
        for (const entry of document.providerAttemptHistory || []) {
          const expanded = { ...document, providerAttemptHistory: entry };
          if (matches(expanded, matchStage)) rows.push(expanded);
        }
      }
      const distinct = new Set(rows.map((row) => (
        `${row._id}:${Number(row.providerAttemptHistory?.attemptNumber || 0)}`
      )));
      const result = distinct.size ? [{ count: distinct.size }] : [];
      const promise = Promise.resolve(structuredClone(result));
      promise.session = () => promise;
      return promise;
    },
  };
  return Model;
}

function makeRepository({
  items = [],
  agents = [],
  events = [],
  leadCadences = [],
  caseProfiles = [],
  cxAppointments = [],
  terminalOutboxRows = [],
  callLogs = [],
  masterProspects = [],
  itemOptions,
  agentOptions,
  eventOptions,
} = {}) {
  const Item = createFakeModel(items, itemOptions);
  const Agent = createFakeModel(agents, agentOptions);
  const Event = createFakeModel(events, eventOptions);
  const LeadCadence = createFakeModel(leadCadences);
  const CaseProfile = createFakeModel(caseProfiles);
  const CxAppointment = createFakeModel(cxAppointments);
  const CxTerminalOutbox = createFakeModel(terminalOutboxRows);
  const CallLog = createFakeModel(callLogs);
  const MasterProspectIndex = createFakeModel(masterProspects);
  return {
    Item,
    Agent,
    Event,
    LeadCadence,
    CaseProfile,
    CxAppointment,
    CxTerminalOutbox,
    CallLog,
    MasterProspectIndex,
    repository: createLeadDeliveryRepository({
      LeadDeliveryItem: Item,
      LeadDeliveryAgent: Agent,
      LeadDeliveryEvent: Event,
      LeadCadence,
      CaseProfile,
      CxAppointment,
      CxTerminalOutbox,
      CallLog,
      MasterProspectIndex,
    }),
  };
}

function duplicateError(keyPattern, message = "E11000 duplicate key error") {
  const error = new Error(message);
  error.code = 11000;
  error.keyPattern = keyPattern;
  return error;
}

test("completed agent metric is derived from unique immutable item attempts", async () => {
  const { repository } = makeRepository({ items: [
    {
      _id: "metric-item-1",
      providerAttemptHistory: [
        { attemptNumber: 1, event: "completed", deliveryAgentId: "bruce", occurredAt: new Date("2026-07-15T16:45:00.000Z") },
        { attemptNumber: 1, event: "completed", deliveryAgentId: "bruce", reason: "strengthened", occurredAt: new Date("2026-07-15T16:45:00.000Z") },
        { attemptNumber: 2, event: "completed", deliveryAgentId: "bruce", occurredAt: new Date("2026-07-15T16:55:00.000Z") },
      ],
    },
    {
      _id: "metric-item-2",
      providerAttemptHistory: [
        { attemptNumber: 1, event: "completed", deliveryAgentId: "brad", occurredAt: new Date("2026-07-15T16:40:00.000Z") },
        { attemptNumber: 2, event: "accepted", deliveryAgentId: "bruce" },
      ],
    },
  ] });

  assert.equal(await repository.countAgentCompletedAttempts("BRUCE"), 2);
  assert.equal(await repository.countAgentCompletedAttempts("brad"), 1);
  assert.equal(await repository.countAgentCompletedAttempts("sean"), 0);
  assert.equal(await repository.countAgentCompletedAttemptsSince(
    "bruce",
    new Date("2026-07-15T16:50:00.000Z"),
    { until: new Date("2026-07-15T17:00:00.000Z") },
  ), 1);
  assert.equal(await repository.countAgentCompletedAttemptsSince(
    "brad",
    new Date("2026-07-15T16:50:00.000Z"),
    { until: new Date("2026-07-15T17:00:00.000Z") },
  ), 0);
});

test("provider identity lookup prefers exact contact and external IDs over reusable call ID", async () => {
  const { repository, Item } = makeRepository({ items: [
    {
      _id: "matching-item",
      provider: "phoneburner",
      providerExternalLeadId: "TAG:case-701:attempt-1",
      providerContactId: "1701",
      providerCallId: null,
      normalizedPhone: "5555550101",
      state: "provider_accepted",
      activeAttempt: true,
      version: 2,
    },
    {
      _id: "same-phone-wrong-identity",
      provider: "phoneburner",
      providerExternalLeadId: "TAG:case-799:attempt-1",
      providerContactId: "1799",
      providerCallId: "799",
      normalizedPhone: "5555550101",
      state: "provider_accepted",
      activeAttempt: true,
      version: 1,
    },
  ] });
  const rows = await repository.listProviderIdentityCandidates({
    provider: "PhoneBurner",
    providerExternalLeadId: "TAG:case-701:attempt-1",
    providerContactId: "1701",
    providerCallId: "701",
    normalizedPhone: "5555550101",
  });
  assert.deepEqual(rows.map((row) => row._id), ["matching-item"]);
  assert.equal(Object.hasOwn(rows[0], "normalizedPhone"), false);
  const serializedFilter = JSON.stringify(Item.findCalls[0].filter);
  assert.equal(serializedFilter.includes("normalizedPhone"), false);
  assert.deepEqual(Item.findCalls[0].filter.$and[0], { $or: [
    { provider: "phoneburner" },
    { "providerAttemptHistory.provider": "phoneburner" },
  ] });
  assert.deepEqual(Item.findCalls[0].filter.$and[1].$or, [
    { providerExternalLeadId: "TAG:case-701:attempt-1" },
    { "providerAttemptHistory.providerExternalLeadId": "TAG:case-701:attempt-1" },
    { providerContactId: "1701" },
    { "providerAttemptHistory.providerContactId": "1701" },
  ]);
  await assert.rejects(
    repository.listProviderIdentityCandidates({ provider: "phoneburner", normalizedPhone: "5555550101" }),
    /at least one provider identity is required/,
  );
});

test("provider identity lookup retains a released item through immutable history", async () => {
  const { repository } = makeRepository({ items: [{
    _id: "released-item",
    provider: null,
    providerExternalLeadId: null,
    providerContactId: null,
    providerCallId: null,
    providerAttemptHistory: [{
      attemptNumber: 1,
      event: "provider_removed",
      provider: "phoneburner",
      providerExternalLeadId: "released-external",
      providerContactId: "released-contact",
      providerCallId: null,
      occurredAt: new Date("2026-07-11T00:30:00.000Z"),
    }],
    state: "eligible",
    activeAttempt: true,
    version: 4,
  }] });

  const rows = await repository.listProviderIdentityCandidates({
    provider: "phoneburner",
    providerExternalLeadId: "released-external",
    providerContactId: "released-contact",
  });
  assert.deepEqual(rows.map((row) => row._id), ["released-item"]);
  assert.equal(rows[0].provider, null);
  assert.equal(rows[0].providerAttemptHistory[0].provider, "phoneburner");
});

test("runtime reads normalize identities and return only time-eligible storage candidates", async () => {
  const { repository, Item, Agent } = makeRepository({
    items: [
      {
        _id: "candidate-c",
        sourceIdentity: "TAG:case-c",
        sourcePool: "new_today",
        state: "eligible",
        activeAttempt: true,
        reservedAgentId: null,
        deliveryAgentId: "bruce",
        receivedAt: new Date("2026-07-10T18:00:00Z"),
      },
      {
        _id: "candidate-a",
        sourceIdentity: "TAG:case-a",
        sourcePool: "overnight",
        state: "reserved",
        activeAttempt: true,
        totalAttemptCount: 0,
        lastContactAt: null,
        reservedAgentId: "bruce",
        deliveryAgentId: "bruce",
        receivedAt: new Date("2026-07-10T20:00:00Z"),
      },
      {
        _id: "candidate-b",
        sourceIdentity: "TAG:case-b",
        sourcePool: "follow_up_due",
        state: "follow_up_wait",
        activeAttempt: true,
        reservedAgentId: null,
        deliveryAgentId: null,
        receivedAt: new Date("2026-07-10T19:00:00Z"),
        nextContactAt: new Date("2026-07-10T22:00:00Z"),
      },
      {
        _id: "foreign-reservation",
        sourceIdentity: "TAG:case-foreign",
        sourcePool: "new_today",
        state: "reserved",
        activeAttempt: true,
        reservedAgentId: "brad",
        deliveryAgentId: null,
        receivedAt: new Date("2026-07-10T21:00:00Z"),
      },
      {
        _id: "inactive-history",
        sourceIdentity: "TAG:case-history",
        sourcePool: "new_today",
        state: "terminal",
        activeAttempt: false,
        reservedAgentId: null,
        deliveryAgentId: "bruce",
        receivedAt: new Date("2026-07-10T22:00:00Z"),
      },
    ],
    agents: [
      { _id: "agent-bruce", agentId: "bruce", enabled: true, version: 2 },
      { _id: "agent-brad", agentId: "brad", enabled: false, version: 1 },
    ],
  });

  assert.equal((await repository.getItemById("candidate-c"))._id, "candidate-c");
  assert.equal((await repository.findItemBySourceIdentity({ domain: "tag", caseId: "case-a" }))._id, "candidate-a");
  assert.equal((await repository.getAgentById("BRUCE")).agentId, "bruce");
  assert.deepEqual((await repository.listAgents()).map((row) => row.agentId), ["bruce", "brad"]);
  assert.deepEqual((await repository.listAgents({ enabledOnly: true })).map((row) => row.agentId), ["bruce"]);
  assert.deepEqual((await repository.listAgentDeliveryItems("BRUCE")).map((row) => row._id), [
    "candidate-c",
    "candidate-a",
  ]);

  const candidates = await repository.listPacketCandidateItems({
    agentId: "BRUCE",
    sourcePools: ["NEW_TODAY", "overnight", "follow_up_due", "new_today"],
    now: new Date("2026-07-10T23:00:00Z"),
    limit: 3,
  });
  assert.deepEqual(candidates.map((row) => row._id), ["candidate-a", "candidate-b", "candidate-c"]);
  const candidateRead = Item.findCalls.at(-1);
  assert.deepEqual(candidateRead.filter, {
    activeAttempt: true,
    providerContactId: null,
    state: { $in: ["eligible", "follow_up_wait", "reserved"] },
    $and: [
      { $or: [
        { sourcePool: "new_today" },
        { sourcePool: "overnight" },
        { sourcePool: "follow_up_due", nextContactAt: { $lte: new Date("2026-07-10T23:00:00Z") } },
      ] },
      { $or: [
        { reservedAgentId: null },
        { reservedAgentId: "bruce" },
      ] },
    ],
  });
  assert.deepEqual(candidateRead.query.order, { _id: 1 });
  assert.equal(Object.hasOwn(candidateRead.query.order, "receivedAt"), false, "repository order is not dial priority");
  assert.equal(candidateRead.query.maximum, 3);

  const fresh = await repository.listImmediateFreshItems({ limit: 2 });
  assert.deepEqual(fresh.map((row) => row._id), ["foreign-reservation", "candidate-c"]);
  const freshRead = Item.findCalls.at(-1);
  assert.deepEqual(freshRead.filter, {
    activeAttempt: true,
    sourcePool: "new_today",
    providerContactId: null,
    state: { $in: ["eligible", "reserved"] },
  });
  assert.deepEqual(freshRead.query.order, { receivedAt: -1, _id: 1 });
  assert.equal(freshRead.query.maximum, 2);

  assert.equal(await repository.hasUnconsumedOvernightFirstContact(), true);
  const overnightBarrierRead = Item.findOneCalls.at(-1);
  assert.deepEqual(overnightBarrierRead.filter, {
    activeAttempt: true,
    sourcePool: "overnight",
    totalAttemptCount: 0,
    lastContactAt: null,
  });
  assert.deepEqual(overnightBarrierRead.query.selection, { _id: 1 });
  for (const [pool, order] of [
    ["new_today", { receivedAt: -1, _id: 1 }],
    ["overnight", { overnightOrder: 1, _id: 1 }],
    ["follow_up_due", { totalAttemptCount: 1, nextContactAt: 1, lastContactAt: 1, _id: 1 }],
    ["older_available", { totalAttemptCount: 1, lastContactAt: 1, receivedAt: 1, _id: 1 }],
  ]) {
    await repository.listPacketCandidateItems({
      agentId: "BRUCE",
      sourcePools: [pool],
      now: new Date("2026-07-10T23:00:00Z"),
      limit: 3,
    });
    assert.deepEqual(Item.findCalls.at(-1).query.order, order);
  }
  for (const [attemptBand, expectedFilter, expectedOrder] of [
    ["standard", {
      $or: [
        { totalAttemptCount: { $gte: 1, $lt: 10 } },
        { totalAttemptCount: 0, lastContactAt: { $ne: null } },
      ],
    }, { totalAttemptCount: 1, nextContactAt: 1, lastContactAt: 1, _id: 1 }],
    ["age_sorted", {
      totalAttemptCount: { $gte: 10, $lt: 15 },
    }, { receivedAt: -1, totalAttemptCount: 1, nextContactAt: 1, _id: 1 }],
    ["phase_out", {
      totalAttemptCount: { $gte: 15 },
    }, { receivedAt: -1, nextContactAt: 1, totalAttemptCount: 1, _id: 1 }],
  ]) {
    await repository.listPacketCandidateItems({
      agentId: "BRUCE",
      sourcePools: ["follow_up_due"],
      attemptBand,
      now: new Date("2026-07-10T23:00:00Z"),
      limit: 3,
    });
    const read = Item.findCalls.at(-1);
    for (const [key, value] of Object.entries(expectedFilter)) {
      assert.deepEqual(read.filter[key], value);
    }
    assert.deepEqual(read.query.order, expectedOrder);
  }
  await assert.rejects(() => repository.listPacketCandidateItems({
    agentId: "BRUCE",
    sourcePools: ["follow_up_due"],
    untouchedOnly: true,
    attemptBand: "phase_out",
    now: new Date("2026-07-10T23:00:00Z"),
  }), /untouchedOnly cannot be combined/);
  assert.deepEqual(Item.findOneCalls[0].filter, { _id: "candidate-c" });
  assert.deepEqual(Item.findOneCalls[1].filter, { sourceIdentity: "TAG:case-a" });
  assert.deepEqual(Agent.findOneCalls[0].filter, { agentId: "bruce" });
  await assert.rejects(() => repository.listAgents({ enabledOnly: "true" }), /enabledOnly must be a boolean/);
});

test("nightly health repair candidates are bounded to unowned expired reservations and ordinary phase-out rows", async () => {
  const at = new Date("2026-08-14T03:10:00.000Z");
  const common = {
    activeAttempt: true,
    providerContactId: null,
    providerExternalLeadId: null,
    providerCallId: null,
    providerPostState: null,
    packetId: null,
    deliveryAgentId: null,
  };
  const { repository, Item } = makeRepository({ items: [
    {
      _id: "expired-unposted",
      version: 0,
      ...common,
      state: "reserved",
      sourcePool: "older_available",
      reservedAgentId: "brad",
      reservationExpiresAt: new Date("2026-08-14T03:00:00.000Z"),
    },
    {
      _id: "reserved-provider-owned",
      version: 0,
      ...common,
      state: "reserved",
      sourcePool: "older_available",
      reservedAgentId: "brad",
      reservationExpiresAt: new Date("2026-08-14T03:00:00.000Z"),
      providerContactId: "contact",
    },
    {
      _id: "ordinary-phase-out",
      version: 0,
      ...common,
      state: "eligible",
      sourcePool: "older_available",
      reservedAgentId: null,
      totalAttemptCount: 15,
      lastContactAt: new Date("2026-08-10T17:00:00.000Z"),
    },
    {
      _id: "recovery-phase-out",
      version: 0,
      ...common,
      state: "eligible",
      sourcePool: "older_available",
      inventoryClass: "callrail_long_call_recovery",
      reservedAgentId: null,
      totalAttemptCount: 20,
      lastContactAt: new Date("2026-08-10T17:00:00.000Z"),
    },
  ] });

  const result = await repository.listNightlyLeadHealthRepairCandidates({ now: at, limit: 1 });
  assert.deepEqual(result.expiredReservations.map((row) => row._id), ["expired-unposted"]);
  assert.deepEqual(result.phaseOutCandidates.map((row) => row._id), ["ordinary-phase-out"]);
  assert.equal(result.expiredReservationsTruncated, false);
  assert.equal(result.phaseOutCandidatesTruncated, false);
  assert.equal(Item.findCalls.at(-2).query.maximum, 2, "limit+1 proves truncation without an unbounded read");
  assert.equal(Item.findCalls.at(-1).query.maximum, 2);
  assert.deepEqual(Item.findCalls.at(-2).query.order, { reservationExpiresAt: 1, _id: 1 });
  assert.deepEqual(Item.findCalls.at(-1).query.order, { lastContactAt: -1, _id: 1 });
});

test("agent configuration upsert changes only configuration fields and rejects runtime or secret material", async () => {
  const { repository, Agent } = makeRepository({ agents: [{
    _id: "agent-bruce",
    agentId: "bruce",
    displayName: "Old Name",
    enabled: false,
    shiftEnabled: true,
    activeUntil: new Date("2026-07-10T23:00:00Z"),
    providerAcceptedCount: 7,
    providerCompletedCount: 5,
    estimatedOutstanding: 2,
    freshReservedThisHour: 3,
    version: 9,
    metadata: { auditMarker: "preserve", configuration: { provider: "old" } },
  }] });
  const input = {
    agentId: "BRUCE",
    displayName: "Bruce Allen",
    enabled: true,
    configuration: {
      provider: "phoneburner",
      providerConfig: {
        distributionFolderId: "distribution-test",
        receivingFolderId: "receiving-test",
        ownerId: null,
        ownerUsername: null,
      },
      subscribedPools: ["new_today", "overnight"],
      packetAllowances: { new_today: 2, overnight: 1 },
      providerBufferTarget: 5,
      refillAtOrBelow: 1,
    },
  };
  const before = structuredClone(input);
  const updated = await repository.upsertAgentConfiguration(input);

  assert.deepEqual(input, before);
  assert.equal(updated.displayName, "Bruce Allen");
  assert.equal(updated.enabled, true);
  assert.equal(updated.shiftEnabled, true);
  assert.equal(updated.providerAcceptedCount, 7);
  assert.equal(updated.providerCompletedCount, 5);
  assert.equal(updated.estimatedOutstanding, 2);
  assert.equal(updated.freshReservedThisHour, 3);
  assert.equal(updated.version, 9);
  assert.equal(updated.metadata.auditMarker, "preserve");
  assert.deepEqual(updated.metadata.configuration, input.configuration);
  assert.deepEqual(Agent.calls[0].filter, { agentId: "bruce" });
  assert.deepEqual(Agent.calls[0].update, {
    $set: {
      displayName: "Bruce Allen",
      enabled: true,
      "metadata.configuration": input.configuration,
    },
    $setOnInsert: { agentId: "bruce" },
  });
  assert.deepEqual(Agent.calls[0].options, {
    new: true,
    upsert: true,
    runValidators: true,
    setDefaultsOnInsert: true,
    session: undefined,
  });

  const createdRepository = makeRepository();
  const created = await createdRepository.repository.upsertAgentConfiguration({
    agentId: "new_agent",
    displayName: null,
    enabled: false,
    configuration: {},
  });
  assert.equal(created.agentId, "new_agent");
  assert.equal(created.enabled, false);
  assert.deepEqual(created.metadata.configuration, {});

  await assert.rejects(
    repository.upsertAgentConfiguration({ ...input, shiftEnabled: false }),
    /input contains unknown field shiftEnabled/,
  );
  await assert.rejects(
    repository.upsertAgentConfiguration({
      ...input,
      configuration: { ...input.configuration, providerAcceptedCount: 99 },
    }),
    /configuration contains unknown field providerAcceptedCount/,
  );
  await assert.rejects(
    repository.upsertAgentConfiguration({
      ...input,
      configuration: {
        ...input.configuration,
        packetAllowances: { new_today: 2, estimatedOutstanding: 4 },
      },
    }),
    /configuration\.packetAllowances\.estimatedOutstanding is runtime-owned/,
  );
  await assert.rejects(
    repository.upsertAgentConfiguration({
      ...input,
      configuration: {
        ...input.configuration,
        packetAllowances: { new_today: 2, refreshToken: "redacted-test-value" },
      },
    }),
    /may not contain secret material/,
  );
});

test("source batches use newest-first keysets, skip CaseProfile, and preserve exact active-appointment joins", async () => {
  const at12 = new Date("2026-07-10T12:00:00Z");
  const at11 = new Date("2026-07-10T11:00:00Z");
  const at10 = new Date("2026-07-10T10:00:00Z");
  const { repository, LeadCadence, CaseProfile, CxAppointment } = makeRepository({
    leadCadences: [
      {
        _id: "cadence-4",
        domain: "TAG",
        caseId: 4,
        firstName: "Synthetic",
        lastName: "Four",
        name: "Synthetic Four",
        primaryPhone: "synthetic-phone-4",
        normalizedPhone: "synthetic-normalized-4",
        city: "Test City",
        state: "CA",
        statusId: 1,
        active: true,
        currentStage: "new",
        createdAt: at12,
        updatedAt: at12,
        attributionContext: { receivedAt: at12, forbidden: "omit" },
        payloadSnapshot: { createdAt: at12, state: "CA", timeZone: "America/Los_Angeles", forbidden: "omit" },
        cadenceState: { channelDnc: { cx: { blocked: false, reason: null, forbidden: "omit" } } },
        dncCheckpoints: { hit: false, reason: "omit" },
        counterCadence: {
          cxDailyDateKey: "2026-07-10",
          cxDailyCalls: 1,
          lastCxDialedAt: at11,
          lastCxAnsweredAt: at10,
          lastCxDncAt: null,
          lastCxTerminalCountedUii: "synthetic-uii",
        },
        lastTouched: { cx: at11, sms: at10 },
        cadenceCounters: { cx: 1, sms: 9 },
        email: "must-not-project",
      },
      { _id: "cadence-3b", domain: "TAG", caseId: 3, createdAt: at11, updatedAt: at11, active: true },
      { _id: "cadence-3a", domain: "TAG", caseId: 31, createdAt: at11, updatedAt: at11, active: true },
      { _id: "cadence-2", domain: "WYNN", caseId: 2, createdAt: at10, updatedAt: at10, active: true },
      { _id: "other-domain", domain: "OTHER", caseId: 9, createdAt: new Date("2026-07-10T13:00:00Z"), active: true },
    ],
    caseProfiles: [
      {
        _id: "profile-4",
        domain: "TAG",
        caseId: 4,
        statusId: 100,
        statusCategory: "prospect",
        lastStatusCheckAt: at12,
        convertedAt: null,
        firstPaymentDate: null,
        paymentsCount: 0,
        totalPaid: 0,
        conversationAi: { optOutDetected: false, latestInboundText: "omit" },
        aiActivityReview: { status: "complete", rationale: "omit" },
        aiCaseReview: { nextEligibleAt: at12, summary: "omit" },
        scrubSummary: { status: "clear", providers: { omit: true } },
        primaryPhone: "must-not-project",
        firstName: "must-not-project",
      },
      { _id: "profile-3", domain: "TAG", caseId: 3, statusId: 101, statusCategory: "prospect" },
      { _id: "cross-profile", domain: "WYNN", caseId: 4, statusId: 999, statusCategory: "client" },
      { _id: "profile-31", domain: "TAG", caseId: 31, statusId: 102, statusCategory: "prospect" },
      { _id: "profile-2", domain: "WYNN", caseId: 2, statusId: 103, statusCategory: "prospect" },
    ],
    cxAppointments: [
      {
        _id: "appointment-active",
        appointmentId: "appointment-4",
        domain: "TAG",
        caseId: 4,
        status: "scheduled",
        appointmentAt: at12,
        legalDialAt: at11,
        updatedAt: at12,
        prospectName: "must-not-project",
        phone: "must-not-project",
      },
      {
        _id: "appointment-completed",
        appointmentId: "appointment-3",
        domain: "TAG",
        caseId: 3,
        status: "completed",
        appointmentAt: at11,
        legalDialAt: at10,
        updatedAt: at12,
      },
      {
        _id: "appointment-other-domain",
        appointmentId: "appointment-cross",
        domain: "WYNN",
        caseId: 4,
        status: "scheduled",
        appointmentAt: at11,
        legalDialAt: at10,
        updatedAt: at12,
      },
    ],
  });

  const first = await repository.readSourceBatch({ domains: ["tag", "WYNN", "tag"], limit: 2 });
  assert.deepEqual(first.items.map((row) => row._id), ["cadence-4", "cadence-3b"]);
  assert.equal(first.done, false);
  assert.deepEqual(first.nextCursor, { createdAt: at11, id: "cadence-3b" });
  assert.equal(first.items[0].caseProfile, null);
  assert.equal(first.items[0].activeAppointment._id, "appointment-active");
  assert.equal(first.items[1].activeAppointment, null);
  assert.equal(Object.hasOwn(first.items[0], "email"), false);
  assert.equal(Object.hasOwn(first.items[0].payloadSnapshot, "forbidden"), false);
  assert.equal(Object.hasOwn(first.items[0].activeAppointment, "prospectName"), false);
  assert.equal(Object.hasOwn(first.items[0].activeAppointment, "phone"), false);
  assert.equal(CaseProfile.findCalls.length, 0);
  assert.deepEqual(CxAppointment.findCalls[0].filter, {
    $or: [
      { domain: "TAG", caseId: { $in: [4, 3] } },
    ],
    status: { $in: ["scheduled", "due", "fired", "blocked"] },
  });

  const second = await repository.readSourceBatch({
    domains: ["TAG", "WYNN"],
    limit: 2,
    cursor: first.nextCursor,
  });
  assert.deepEqual(second.items.map((row) => row._id), ["cadence-3a", "cadence-2"]);
  assert.equal(second.done, true);
  assert.equal(second.nextCursor, null);
  assert.deepEqual(LeadCadence.findCalls[1].filter, {
    domain: { $in: ["TAG", "WYNN"] },
    active: true,
    $or: [
      { createdAt: { $lt: at11 } },
      { createdAt: at11, _id: { $lt: "cadence-3b" } },
    ],
  });
  assert.equal(LeadCadence.findCalls[0].filter.active, true);
  assert.deepEqual(LeadCadence.findCalls[0].query.order, { createdAt: -1, _id: -1 });
  assert.equal(LeadCadence.findCalls[0].query.maximum, 3);

  const window = await repository.readSourceWindowBatch({
    domains: ["TAG", "WYNN"],
    receivedFrom: new Date("2026-07-10T11:30:00Z"),
    receivedBefore: new Date("2026-07-10T12:30:00Z"),
    limit: 2,
  });
  assert.deepEqual(window.items.map((row) => row._id), ["cadence-4"]);
  const windowFilter = LeadCadence.findCalls[2].filter;
  assert.equal(windowFilter.active, true);
  assert.deepEqual(windowFilter.domain, { $in: ["TAG", "WYNN"] });
  assert.deepEqual(windowFilter.$and[0].$or[0], {
    "payloadSnapshot.createdAt": {
      $gte: new Date("2026-07-10T11:30:00Z"),
      $lt: new Date("2026-07-10T12:30:00Z"),
    },
  });
  assert.deepEqual(windowFilter.$and[0].$or[1], {
    createdAt: {
      $gte: new Date("2026-07-10T11:30:00Z"),
      $lt: new Date("2026-07-10T12:30:00Z"),
    },
  });

  const expectedCadenceProjection = [
    "_id", "active", "attributionContext.receivedAt", "cadenceCounters.cx",
    "cadenceState.channelDnc.cx.blocked", "cadenceState.channelDnc.cx.reason", "caseId", "city",
    "counterCadence.cxDailyCalls", "counterCadence.cxDailyDateKey", "counterCadence.lastCxDialedAt",
    "counterCadence.lastCxAnsweredAt", "counterCadence.lastCxDncAt", "counterCadence.lastCxTerminalCountedUii", "createdAt", "currentStage",
    "dncCheckpoints.hit", "domain", "firstName", "lastName", "lastTouched.cx",
    "logicsProspectEligible", "logicsStatusCheckedAt", "logicsStatusInvalidatedAt", "name", "normalizedPhone",
    "payloadSnapshot.createdAt", "payloadSnapshot.cxAppointment", "payloadSnapshot.state", "payloadSnapshot.timeZone", "payloadSnapshot.timezone",
    "primaryPhone", "state", "statusId", "updatedAt",
  ].sort();
  assert.deepEqual(Object.keys(LeadCadence.findCalls[0].query.selection).sort(), expectedCadenceProjection);
  const expectedAppointmentProjection = [
    "_id", "appointmentAt", "appointmentId", "caseId", "domain", "legalDialAt", "status", "updatedAt",
  ].sort();
  assert.deepEqual(
    Object.keys(CxAppointment.findCalls[0].query.selection).sort(),
    expectedAppointmentProjection,
  );

  const one = await repository.readSourceLead({ domain: "tag", caseId: "4" });
  assert.equal(one._id, "cadence-4");
  assert.equal(one.caseProfile, null);
  assert.equal(one.activeAppointment._id, "appointment-active");
  assert.deepEqual(LeadCadence.findOneCalls[0].filter, { domain: "TAG", caseId: 4 });
  assert.equal(CaseProfile.findCalls.length, 0);
  assert.deepEqual(CxAppointment.findCalls.at(-1).filter, {
    $or: [{ domain: "TAG", caseId: { $in: [4] } }],
    status: { $in: ["scheduled", "due", "fired", "blocked"] },
  });
});

test("packet assignment summaries are one aggregate and normalize PII-free counters", async () => {
  const { repository, Item } = makeRepository();
  let pipeline = null;
  Item.aggregate = async (value) => {
    pipeline = structuredClone(value);
    return [
      { _id: "BRUCE_ALLEN", total: 2, accepted: 1, pending: 1, failed: 0 },
      { _id: "phil_olson", total: 1, accepted: 0, pending: 0, failed: 1 },
    ];
  };

  const summary = await repository.summarizePacketAssignments("preload-safe");

  assert.deepEqual(pipeline[0], { $match: { packetId: "preload-safe" } });
  assert.deepEqual(summary, {
    total: 3,
    accepted: 1,
    pending: 1,
    failed: 1,
    countsByAgent: { bruce_allen: 2, phil_olson: 1 },
  });
});

test("legacy daily attempt reads return four independent projected evidence counts", async () => {
  const dayStart = new Date("2026-07-10T07:00:00Z");
  const dayEnd = new Date("2026-07-11T07:00:00Z");
  const inside = new Date("2026-07-10T12:00:00Z");
  const outside = new Date("2026-07-11T08:00:00Z");
  const {
    repository,
    LeadCadence,
    CxTerminalOutbox,
    CallLog,
    MasterProspectIndex,
  } = makeRepository({
    leadCadences: [{
      _id: "cadence-count",
      domain: "TAG",
      caseId: 101,
      counterCadence: { cxDailyDateKey: "2026-07-10", cxDailyCalls: 2 },
      primaryPhone: "must-not-project",
    }],
    terminalOutboxRows: [
      { _id: "outbox-1", domain: "TAG", caseId: 101, createdAt: inside, uii: "call-1", idemKey: "queue-1:call-1", phone: "omit" },
      { _id: "outbox-2", domain: "TAG", caseId: 101, createdAt: inside, payload: { uii: "call-1", phone: "omit" }, idemKey: "queue-2:call-1" },
      { _id: "outbox-3", domain: "TAG", caseId: 101, createdAt: inside, idemKey: "session-a:queue-3:terminal" },
      { _id: "outbox-4", domain: "TAG", caseId: 101, createdAt: inside, idemKey: "session-b:case:101:terminal" },
      { _id: "outbox-5", domain: "TAG", caseId: 101, createdAt: inside, idemKey: "queue-5:call-2" },
      { _id: "outbox-review", domain: "TAG", caseId: 101, createdAt: inside, idemKey: "queue-6:call-3:review-dnc" },
      { _id: "outbox-outside", domain: "TAG", caseId: 101, createdAt: outside, uii: "call-outside", idemKey: "queue-o:call-outside" },
      { _id: "outbox-other", domain: "WYNN", caseId: 101, createdAt: inside, uii: "call-other", idemKey: "queue-x:call-other" },
    ],
    callLogs: [
      { _id: "log-1", domain: "TAG", caseId: 101, platform: "cx", direction: "outbound", callStartTime: inside, telephonySessionId: "session-1", phone: "omit" },
      { _id: "log-1-duplicate", domain: "TAG", caseId: 101, platform: "cx", direction: "outbound", callStartTime: inside, telephonySessionId: "session-1" },
      { _id: "log-2", domain: "TAG", caseId: 101, platform: "cx", direction: "outbound", callStartTime: inside, telephonySessionId: "session-2" },
      { _id: "log-inbound", domain: "TAG", caseId: 101, platform: "cx", direction: "inbound", callStartTime: inside, telephonySessionId: "session-inbound" },
      { _id: "log-ex", domain: "TAG", caseId: 101, platform: "ex", direction: "outbound", callStartTime: inside, telephonySessionId: "session-ex" },
      { _id: "log-outside", domain: "TAG", caseId: 101, platform: "cx", direction: "outbound", callStartTime: outside, telephonySessionId: "session-outside" },
    ],
    masterProspects: [{
      _id: "mpi-count",
      domain: "TAG",
      caseId: 101,
      filler: { dailyDateKey: "2026-07-10", dailyAttempts: 1, lastAttemptResult: "omit" },
      cellPhone: "must-not-project",
    }],
  });

  const counts = await repository.readLegacyDailyAttemptFloor({
    domain: "tag",
    caseId: "101",
    dateKey: "2026-07-10",
    dayStart,
    dayEnd,
  });
  assert.deepEqual(counts, {
    cadenceDailyCount: 2,
    terminalOutboxCallCount: 4,
    callLogSessionCount: 2,
    mpiFillerDailyAttempts: 1,
  });
  assert.deepEqual(LeadCadence.findOneCalls[0].filter, { domain: "TAG", caseId: 101 });
  assert.deepEqual(CxTerminalOutbox.findCalls[0].filter, {
    domain: "TAG",
    caseId: 101,
    createdAt: { $gte: dayStart, $lt: dayEnd },
  });
  assert.deepEqual(CallLog.findCalls[0].filter, {
    domain: "TAG",
    caseId: 101,
    platform: "cx",
    direction: "outbound",
    callStartTime: { $gte: dayStart, $lt: dayEnd },
  });
  assert.deepEqual(MasterProspectIndex.findOneCalls[0].filter, { domain: "TAG", caseId: 101 });
  assert.deepEqual(Object.keys(LeadCadence.findOneCalls[0].query.selection).sort(), [
    "_id", "counterCadence.cxDailyCalls", "counterCadence.cxDailyDateKey",
  ]);
  assert.deepEqual(Object.keys(CxTerminalOutbox.findCalls[0].query.selection).sort(), [
    "_id", "createdAt", "idemKey", "payload.uii", "uii",
  ]);
  assert.deepEqual(Object.keys(CallLog.findCalls[0].query.selection).sort(), [
    "_id", "callStartTime", "telephonySessionId",
  ]);
  assert.deepEqual(Object.keys(MasterProspectIndex.findOneCalls[0].query.selection).sort(), [
    "_id", "filler.dailyAttempts", "filler.dailyDateKey",
  ]);
  assert.equal(Object.values(counts).every((value) => Number.isSafeInteger(value) && value >= 0), true);
  assert.equal(JSON.stringify(counts).includes("phone"), false);

  const mismatchedDate = await repository.readLegacyDailyAttemptFloor({
    domain: "TAG",
    caseId: 101,
    dateKey: "2026-07-11",
    dayStart,
    dayEnd,
  });
  assert.equal(mismatchedDate.cadenceDailyCount, 0);
  assert.equal(mismatchedDate.mpiFillerDailyAttempts, 0);
  assert.equal(mismatchedDate.terminalOutboxCallCount, 4);
  assert.equal(mismatchedDate.callLogSessionCount, 2);
});

test("event compare-and-set lets exactly one stale worker claim an event", async () => {
  const { repository, Event } = makeRepository({ events: [{
    _id: "event-1",
    status: "pending",
    attempts: 0,
    version: 0,
  }] });
  const claim = () => repository.compareAndSetEvent({
    eventId: "event-1",
    expectedVersion: 0,
    expected: { status: "pending" },
    set: { status: "processing" },
    increment: { attempts: 1 },
  });

  const results = await Promise.all([claim(), claim()]);

  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(Event.docs[0].status, "processing");
  assert.equal(Event.docs[0].attempts, 1);
  assert.equal(Event.docs[0].version, 1);
  assert.equal(Event.calls[0].options.runValidators, true);
  assert.equal(Event.calls[0].options.new, true);

  const requeued = await repository.compareAndSetEvent({
    eventId: "event-1",
    expectedVersion: 1,
    expected: { status: "processing" },
    set: { status: "pending" },
  });
  assert.equal(requeued.version, 2);
  const reclaimed = await repository.compareAndSetEvent({
    eventId: "event-1",
    expectedVersion: 2,
    expected: { status: "pending" },
    set: { status: "processing" },
    increment: { attempts: 1 },
  });
  assert.equal(reclaimed.version, 3);
  const staleCompletion = await repository.compareAndSetEvent({
    eventId: "event-1",
    expectedVersion: 1,
    expected: { status: "processing" },
    set: { status: "completed" },
  });
  assert.equal(staleCompletion, null);
  assert.equal(Event.docs[0].status, "processing");
  assert.equal(Event.docs[0].attempts, 2);
  assert.equal(Event.docs[0].version, 3);
});

test("event evidence upgrades use the same versioned CAS boundary", async () => {
  const { repository, Event } = makeRepository({ events: [{
    _id: "event-evidence",
    status: "review",
    normalizedOutcome: "review",
    version: 4,
  }] });

  const upgraded = await repository.upgradeEventEvidenceCas({
    eventId: "event-evidence",
    expectedVersion: 4,
    expected: { status: "review", normalizedOutcome: "review" },
    set: { status: "pending", normalizedOutcome: "dnc" },
  });
  assert.equal(upgraded.status, "pending");
  assert.equal(upgraded.normalizedOutcome, "dnc");
  assert.equal(upgraded.version, 5);
  assert.deepEqual(Event.calls[0].filter, {
    _id: "event-evidence",
    version: 4,
    status: "review",
    normalizedOutcome: "review",
  });
  assert.deepEqual(Event.calls[0].update, {
    $inc: { version: 1 },
    $set: { status: "pending", normalizedOutcome: "dnc" },
  });
  assert.equal(Event.calls[0].options.runValidators, true);

  const stale = await repository.upgradeEventEvidenceCas({
    eventId: "event-evidence",
    expectedVersion: 4,
    expected: { status: "review" },
    set: { normalizedOutcome: "appointment" },
  });
  assert.equal(stale, null);
  assert.equal(Event.docs[0].normalizedOutcome, "dnc");
});

test("event processing lease is exclusive, live leases stay owned, and expired leases are reclaimed", async () => {
  const now = new Date("2026-07-10T17:00:00Z");
  const { repository, Event } = makeRepository({ events: [{
    _id: "event-lease",
    status: "pending",
    attempts: 0,
    processingLeaseId: null,
    processingLeaseExpiresAt: null,
    version: 0,
  }] });
  const first = await repository.acquireEventProcessingLease({
    eventId: "event-lease",
    expectedVersion: 0,
    leaseId: "lease-a",
    now,
    leaseMs: 60_000,
  });
  assert.equal(first.processingLeaseId, "lease-a");
  assert.equal(first.version, 1);
  assert.equal(await repository.acquireEventProcessingLease({
    eventId: "event-lease",
    expectedVersion: 1,
    leaseId: "lease-b",
    now: new Date(now.getTime() + 30_000),
  }), null);
  const reclaimed = await repository.acquireEventProcessingLease({
    eventId: "event-lease",
    expectedVersion: 1,
    leaseId: "lease-c",
    now: new Date(now.getTime() + 60_000),
  });
  assert.equal(reclaimed.processingLeaseId, "lease-c");
  assert.equal(reclaimed.attempts, 2);
  assert.equal(reclaimed.version, 2);
  const staleCompletion = await repository.compareAndSetEvent({
    eventId: "event-lease",
    expectedVersion: 2,
    expected: { status: "processing", processingLeaseId: "lease-a" },
    set: { status: "completed" },
  });
  assert.equal(staleCompletion, null);
  assert.equal(Event.docs[0].processingLeaseId, "lease-c");
});

test("CAS versions accept only nonnegative integers and canonical digit strings", async () => {
  const { repository, Event } = makeRepository();

  await repository.compareAndSetEvent({ eventId: "missing", expectedVersion: 0 });
  await repository.compareAndSetEvent({ eventId: "missing", expectedVersion: "17" });
  assert.equal(Event.calls[0].filter.version, 0);
  assert.equal(Event.calls[1].filter.version, 17);

  const rejected = [
    null,
    undefined,
    "",
    " ",
    false,
    true,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    "00",
    "01",
    "+1",
    "1.0",
    "1e2",
    {},
    [],
  ];
  for (const expectedVersion of rejected) {
    await assert.rejects(
      repository.compareAndSetEvent({ eventId: "missing", expectedVersion }),
      /expectedVersion must be a non-negative integer/,
    );
  }
});

test("reservation expiry rejects null, blank, boolean, and invalid dates before coercion", async () => {
  const { repository, Item } = makeRepository();
  const base = {
    itemId: "item-1",
    expectedVersion: 0,
    expectedAgentId: "agent-a",
    expectedExpiresAt: "2026-07-10T12:00:00.000Z",
    now: "2026-07-10T12:00:00.000Z",
  };

  for (const expectedExpiresAt of [null, undefined, "", " ", false, "not-a-date"]) {
    await assert.rejects(
      repository.expireReservationCas({ ...base, expectedExpiresAt }),
      /expectedExpiresAt must be a valid date/,
    );
  }
  for (const now of [null, undefined, "", " ", false, "not-a-date"]) {
    await assert.rejects(
      repository.expireReservationCas({ ...base, now }),
      /now must be a valid date/,
    );
  }

  await repository.expireReservationCas({ ...base, expectedExpiresAt: 0, now: 0 });
  assert.equal(Item.calls[0].filter.reservationExpiresAt.$eq.getTime(), 0);
  assert.equal(Item.calls[0].filter.reservationExpiresAt.$lte.getTime(), 0);
});

test("refill acquisition requires a real requestedAt timestamp", async () => {
  const { repository } = makeRepository();
  for (const requestedAt of [null, undefined, "", " ", false, "not-a-date"]) {
    await assert.rejects(repository.acquireRefillRequest({
      agentId: "agent-a",
      expectedVersion: 0,
      refillRequestId: "request-1",
      requestedAt,
    }), /requestedAt must be a valid date/);
  }
});

test("CAS increment allowlists accept only integer counter deltas", async () => {
  const { repository, Item, Agent, Event } = makeRepository();

  await repository.compareAndSetItem({
    itemId: "item-1",
    expectedVersion: 0,
    increment: { dailyAttemptCount: 1, totalAttemptCount: 1 },
  });
  await repository.compareAndSetAgent({
    agentId: "agent-a",
    expectedVersion: 0,
    increment: {
      providerAcceptedCount: 1,
      providerCompletedCount: 1,
      estimatedOutstanding: 1,
      freshReservedThisHour: 1,
      pendingFreshCount: 1,
    },
  });
  await repository.compareAndSetEvent({ eventId: "event-1", expectedVersion: 0, increment: { attempts: 1 } });

  assert.deepEqual(Item.calls[0].update.$inc, { dailyAttemptCount: 1, totalAttemptCount: 1, version: 1 });
  assert.deepEqual(Agent.calls[0].update.$inc, {
    providerAcceptedCount: 1,
    providerCompletedCount: 1,
    estimatedOutstanding: 1,
    freshReservedThisHour: 1,
    pendingFreshCount: 1,
    version: 1,
  });
  assert.deepEqual(Event.calls[0].update.$inc, { attempts: 1, version: 1 });

  await assert.rejects(
    repository.compareAndSetItem({ itemId: "item-1", expectedVersion: 0, increment: { estimatedOutstanding: 1 } }),
    /increment.estimatedOutstanding is not an incrementable counter/,
  );
  await assert.rejects(
    repository.compareAndSetAgent({ agentId: "agent-a", expectedVersion: 0, increment: { attempts: 1 } }),
    /increment.attempts is not an incrementable counter/,
  );
  await assert.rejects(
    repository.compareAndSetEvent({ eventId: "event-1", expectedVersion: 0, increment: { totalAttemptCount: 1 } }),
    /increment.totalAttemptCount is not an incrementable counter/,
  );

  for (const delta of [1.5, "1", true, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(
      repository.compareAndSetEvent({ eventId: "event-1", expectedVersion: 0, increment: { attempts: delta } }),
      /increment.attempts must be an integer/,
    );
  }
});

test("negative counter increments carry a lower-bound predicate and cannot cross zero", async () => {
  const { repository, Agent } = makeRepository({ agents: [{
    agentId: "agent-a",
    estimatedOutstanding: 2,
    version: 0,
  }] });

  const rejected = await repository.compareAndSetAgent({
    agentId: "agent-a",
    expectedVersion: 0,
    increment: { estimatedOutstanding: -3 },
  });
  assert.equal(rejected, null);
  assert.equal(Agent.docs[0].estimatedOutstanding, 2);
  assert.deepEqual(Agent.calls[0].filter.estimatedOutstanding, { $gte: 3 });

  const accepted = await repository.compareAndSetAgent({
    agentId: "agent-a",
    expectedVersion: 0,
    increment: { estimatedOutstanding: -2 },
  });
  assert.equal(accepted.estimatedOutstanding, 0);
  assert.equal(accepted.version, 1);
  assert.deepEqual(Agent.calls[1].filter.estimatedOutstanding, { $gte: 2 });

  await repository.compareAndSetAgent({
    agentId: "missing-agent",
    expectedVersion: 0,
    expected: { estimatedOutstanding: { $lte: 5 } },
    increment: { estimatedOutstanding: -1 },
  });
  assert.deepEqual(Agent.calls[2].filter.estimatedOutstanding, { $lte: 5 });
  assert.deepEqual(Agent.calls[2].filter.$and, [{ estimatedOutstanding: { $gte: 1 } }]);
});

test("active item inserts require caller-owned state and explicit activeAttempt", async () => {
  const { repository, Item } = makeRepository();
  const base = {
    domain: " tag ", caseId: " 101 ", state: "eligible", activeAttempt: true,
    normalizedPhone: "3105550100", receivedAt: new Date("2026-07-10T17:00:00Z"),
  };

  await assert.rejects(repository.insertActiveItemOnce({ ...base, state: "" }), /state must be a nonblank string/);
  await assert.rejects(repository.insertActiveItemOnce({ ...base, state: null }), /state must be a nonblank string/);
  await assert.rejects(repository.insertActiveItemOnce({ ...base, state: true }), /state must be a nonblank string/);
  await assert.rejects(repository.insertActiveItemOnce({ ...base, state: 1 }), /state must be a nonblank string/);
  await assert.rejects(repository.insertActiveItemOnce({ ...base, activeAttempt: undefined }), /activeAttempt must be a boolean/);
  await assert.rejects(repository.insertActiveItemOnce({ ...base, activeAttempt: "true" }), /activeAttempt must be a boolean/);
  await assert.rejects(repository.insertActiveItemOnce({ ...base, state: "terminal", activeAttempt: true }), /does not match state terminal/);

  const created = await repository.insertActiveItemOnce({
    ...base,
    state: " terminal ",
    activeAttempt: false,
    provider: " PhoneBurner ",
    providerExternalLeadId: " external-1 ",
    providerContactId: " ",
    reservedAgentId: " BRAD ",
  });
  assert.equal(created.domain, "TAG");
  assert.equal(created.caseId, "101");
  assert.equal(created.state, "terminal");
  assert.equal(created.activeAttempt, false);
  assert.equal(created.provider, "phoneburner");
  assert.equal(created.providerExternalLeadId, "external-1");
  assert.equal(created.providerContactId, null);
  assert.equal(created.reservedAgentId, "brad");
  assert.equal(Item.docs.length, 1);
});

test("item CAS requires state and activeAttempt to move as one service-owned pair", async () => {
  const { repository } = makeRepository();
  await assert.rejects(repository.compareAndSetItem({
    itemId: "item-1", expectedVersion: 0, set: { state: "terminal" },
  }), /must be supplied together/);
  await assert.rejects(repository.compareAndSetItem({
    itemId: "item-1", expectedVersion: 0, set: { activeAttempt: false },
  }), /must be supplied together/);
  await assert.rejects(repository.compareAndSetItem({
    itemId: "item-1", expectedVersion: 0, set: { state: "terminal", activeAttempt: true },
  }), /does not match state terminal/);
  await repository.compareAndSetItem({
    itemId: "item-1", expectedVersion: 0, set: { state: "terminal", activeAttempt: false },
  });
});

test("event inserts derive a canonical dedupe key and ignore caller input", async () => {
  const { repository, Event } = makeRepository();
  const firstInput = {
    provider: " PhoneBurner ",
    providerEventId: "provider-event-1",
    eventType: "CALL_DONE",
    dedupeKey: "caller-controlled",
    payloadDigest: "safe-digest",
  };
  const first = await repository.insertEventOnce(firstInput);
  assert.equal(first.dedupeKey, buildEventDedupeKey(firstInput));
  assert.notEqual(first.dedupeKey, firstInput.dedupeKey);
  assert.equal(first.eventType, "call_done");

  const fallbackInput = {
    provider: "phoneburner",
    providerEventId: " ",
    providerCallId: "provider-call-1",
    providerContactId: "provider-contact-1",
    providerExternalLeadId: "provider-external-1",
    eventType: "disposition",
    dedupeKey: "also-ignored",
    payloadDigest: "safe-digest-2",
  };
  const fallback = await repository.insertEventOnce(fallbackInput);
  assert.equal(fallback.dedupeKey, buildEventDedupeKey(fallbackInput));
  assert.equal(fallback.providerEventId, null);
  assert.equal(Event.docs.length, 2);

  await assert.rejects(
    repository.insertEventOnce({ provider: "phoneburner", eventType: "call_done", dedupeKey: "not-an-identity", payloadDigest: "safe-digest-3" }),
    /providerEventId or providerCallId is required for a processable event/,
  );

  const reviewOnly = await repository.insertEventOnce({
    provider: "phoneburner",
    eventType: "contact_displayed",
    providerContactId: "8801",
    providerExternalLeadId: "TAG:case-8801:attempt-1",
    status: "review",
    payloadDigest: "a".repeat(64),
  });
  assert.match(reviewOnly.dedupeKey, /^v1:[a-f0-9]{64}$/);
  await assert.rejects(repository.insertEventOnce({
    provider: "phoneburner",
    eventType: "contact_displayed",
    providerContactId: "8802",
    providerExternalLeadId: "TAG:case-8802:attempt-1",
    status: "pending",
    payloadDigest: "b".repeat(64),
  }), /processable event/);
});

test("structured duplicate key patterns swallow only the three intended conflicts", async () => {
  const activeConflict = duplicateError({ domain: 1, caseId: 1 });
  const activeRepository = makeRepository({ itemOptions: { createError: activeConflict } }).repository;
  assert.equal(await activeRepository.insertActiveItemOnce({
    domain: "TAG", caseId: "101", state: "eligible", activeAttempt: true,
    normalizedPhone: "3105550100", receivedAt: new Date("2026-07-10T17:00:00Z"),
  }), null);

  const dedupeConflict = duplicateError({ provider: 1, dedupeKey: 1 });
  const dedupeRepository = makeRepository({ eventOptions: { createError: dedupeConflict } }).repository;
  assert.equal(await dedupeRepository.insertEventOnce({
    provider: "phoneburner", providerEventId: "event-1", eventType: "call_done", payloadDigest: "safe-digest-4",
  }), null);

  const providerIdConflict = duplicateError({ provider: 1, providerEventId: 1 });
  const providerIdRepository = makeRepository({ eventOptions: { createError: providerIdConflict } }).repository;
  assert.equal(await providerIdRepository.insertEventOnce({
    provider: "phoneburner", providerEventId: "event-1", eventType: "call_done", payloadDigest: "safe-digest-5",
  }), null);

  const unrelated = duplicateError(
    { provider: 1, providerContactId: 1 },
    "E11000 duplicate key error index: uq_lead_delivery_provider_event",
  );
  const unrelatedRepository = makeRepository({ eventOptions: { createError: unrelated } }).repository;
  await assert.rejects(
    unrelatedRepository.insertEventOnce({
      provider: "phoneburner", providerEventId: "event-1", eventType: "call_done", payloadDigest: "safe-digest-6",
    }),
    (error) => error === unrelated,
  );
});
