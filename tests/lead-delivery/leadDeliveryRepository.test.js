"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const LeadDeliveryItem = require("../../packages/shared-models/src/LeadDeliveryItem");
const LeadDeliveryAgent = require("../../packages/shared-models/src/LeadDeliveryAgent");
const LeadDeliveryCheckpoint = require("../../packages/shared-models/src/LeadDeliveryCheckpoint");
const LeadDeliveryEvent = require("../../packages/shared-models/src/LeadDeliveryEvent");
const { transitionCompletedAttempt } = require("../../packages/shared-services/src/leadDeliveryService");
const {
  ACTIVE_ATTEMPT_INDEX,
  SOURCE_IDENTITY_INDEX,
  EVENT_DEDUPE_INDEX,
  EVENT_PROVIDER_ID_INDEX,
  createLeadDeliveryRepository,
} = require("../../packages/shared-repositories/src/leadDeliveryRepository");

function valueAt(object, dotted) {
  return String(dotted).split(".").reduce((value, key) => value?.[key], object);
}

function comparable(value) {
  if (value instanceof Date) return value.getTime();
  const parsed = value != null && typeof value !== "object" ? new Date(value).getTime() : NaN;
  return Number.isFinite(parsed) && typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)
    ? parsed
    : value;
}

function matchesValue(actual, expected) {
  if (expected && typeof expected === "object" && !Array.isArray(expected) && !(expected instanceof Date)) {
    if (Object.hasOwn(expected, "$in") && !expected.$in.map(comparable).includes(comparable(actual))) return false;
    if (Object.hasOwn(expected, "$ne") && comparable(actual) === comparable(expected.$ne)) return false;
    if (Object.hasOwn(expected, "$eq") && comparable(actual) !== comparable(expected.$eq)) return false;
    if (Object.hasOwn(expected, "$lte") && !(comparable(actual) <= comparable(expected.$lte))) return false;
    return true;
  }
  return comparable(actual) === comparable(expected);
}

function matches(document, filter) {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === "$or") return expected.some((clause) => matches(document, clause));
    if (key === "$and") return expected.every((clause) => matches(document, clause));
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

function unsetAt(object, dotted) {
  const keys = String(dotted).split(".");
  let cursor = object;
  while (keys.length > 1) cursor = cursor?.[keys.shift()];
  if (cursor) delete cursor[keys[0]];
}

function applyUpdate(document, update) {
  for (const [key, value] of Object.entries(update.$set || {})) setAt(document, key, structuredClone(value));
  for (const key of Object.keys(update.$unset || {})) unsetAt(document, key);
  for (const [key, value] of Object.entries(update.$inc || {})) setAt(document, key, Number(valueAt(document, key) || 0) + Number(value));
  for (const [key, value] of Object.entries(update.$push || {})) {
    const current = valueAt(document, key) || [];
    setAt(document, key, [...current, ...structuredClone(value.$each || [])]);
  }
}

class FakeQuery {
  constructor(run) {
    this.run = run;
    this.selected = null;
  }
  select(fields) { this.selected = fields; return this; }
  session() { return this; }
  async lean() { return this.run(); }
  then(resolve, reject) { return Promise.resolve(this.run()).then(resolve, reject); }
}

function duplicateError(indexName) {
  const error = new Error(`E11000 duplicate key error index: ${indexName}`);
  error.code = 11000;
  error.index = indexName;
  return error;
}

function createFakeModel(kind, initial = []) {
  const model = {
    kind,
    docs: structuredClone(initial),
    nextId: initial.length + 1,
    calls: [],
    async create(input) {
      const row = Array.isArray(input) ? input[0] : input;
      if (kind === "item") {
        const sourceCollision = model.docs.some((doc) => doc.sourceIdentity === row.sourceIdentity);
        if (sourceCollision) throw duplicateError(SOURCE_IDENTITY_INDEX);
        const activeCollision = model.docs.some((doc) => doc.domain === row.domain && doc.caseId === row.caseId && doc.activeAttempt && row.activeAttempt);
        if (activeCollision) throw duplicateError(ACTIVE_ATTEMPT_INDEX);
        const externalCollision = row.providerExternalLeadId && model.docs.some((doc) => doc.providerExternalLeadId === row.providerExternalLeadId);
        if (externalCollision) throw duplicateError("uq_lead_delivery_external_id");
      }
      if (kind === "event") {
        const duplicate = model.docs.some((doc) => doc.provider === row.provider && doc.dedupeKey === row.dedupeKey);
        if (duplicate) throw duplicateError(EVENT_DEDUPE_INDEX);
        const providerIdDuplicate = row.providerEventId && model.docs.some((doc) => doc.provider === row.provider && doc.providerEventId === row.providerEventId);
        if (providerIdDuplicate) throw duplicateError(EVENT_PROVIDER_ID_INDEX);
      }
      if (kind === "checkpoint") {
        const duplicate = model.docs.some((doc) => doc._id === row._id);
        if (duplicate) throw duplicateError("_id_");
      }
      const created = { _id: row._id || `${kind}-${model.nextId++}`, version: row.version ?? 0, ...structuredClone(row) };
      model.docs.push(created);
      return Array.isArray(input) ? [structuredClone(created)] : structuredClone(created);
    },
    findOneAndUpdate(filter, update, options) {
      model.calls.push({ op: "findOneAndUpdate", filter: structuredClone(filter), update: structuredClone(update), options: { ...options } });
      return new FakeQuery(() => {
        const found = model.docs.find((doc) => matches(doc, filter));
        if (!found) return null;
        applyUpdate(found, update);
        return structuredClone(found);
      });
    },
    find(filter) {
      return new FakeQuery(() => model.docs.filter((doc) => matches(doc, filter)).map((doc) => structuredClone(doc)));
    },
    findOne(filter) {
      return new FakeQuery(() => {
        const found = model.docs.find((doc) => matches(doc, filter));
        return found ? structuredClone(found) : null;
      });
    },
  };
  return model;
}

function makeRepository({ items = [], agents = [], checkpoints = [], events = [] } = {}) {
  const Item = createFakeModel("item", items);
  const Agent = createFakeModel("agent", agents);
  const Checkpoint = createFakeModel("checkpoint", checkpoints);
  const Event = createFakeModel("event", events);
  const startSession = async () => {
    const snapshots = () => ({
      item: structuredClone(Item.docs),
      agent: structuredClone(Agent.docs),
      checkpoint: structuredClone(Checkpoint.docs),
      event: structuredClone(Event.docs),
    });
    return {
      async withTransaction(work) {
        const before = snapshots();
        try {
          await work();
        } catch (error) {
          Item.docs = before.item;
          Agent.docs = before.agent;
          Checkpoint.docs = before.checkpoint;
          Event.docs = before.event;
          throw error;
        }
      },
      async endSession() {},
    };
  };
  return {
    Item,
    Agent,
    Checkpoint,
    Event,
    repository: createLeadDeliveryRepository({
      LeadDeliveryItem: Item,
      LeadDeliveryAgent: Agent,
      LeadDeliveryCheckpoint: Checkpoint,
      LeadDeliveryEvent: Event,
      startSession,
    }),
  };
}

function indexByName(Model, name) {
  return Model.schema.indexes().find(([, options]) => options.name === name);
}

test("provider-neutral schemas expose the required unique and repair indexes", () => {
  const modelBarrel = require("../../packages/shared-models/src");
  const repositoryBarrel = require("../../packages/shared-repositories/src");
  const serviceBarrel = require("../../packages/shared-services/src");
  assert.equal(modelBarrel.LeadDeliveryItem, LeadDeliveryItem);
  assert.equal(modelBarrel.LeadDeliveryCheckpoint, LeadDeliveryCheckpoint);
  assert.equal(repositoryBarrel.leadDeliveryRepository.createLeadDeliveryRepository, createLeadDeliveryRepository);
  assert.equal(typeof serviceBarrel.leadDeliveryService.transitionCompletedAttempt, "function");
  const active = indexByName(LeadDeliveryItem, ACTIVE_ATTEMPT_INDEX);
  assert.deepEqual(active[0], { domain: 1, caseId: 1 });
  assert.equal(active[1].unique, true);
  assert.deepEqual(active[1].partialFilterExpression, { activeAttempt: true });
  assert.equal(indexByName(LeadDeliveryItem, SOURCE_IDENTITY_INDEX)[1].unique, true);
  assert.equal(indexByName(LeadDeliveryItem, "uq_lead_delivery_external_id")[1].unique, true);
  const externalKeyDeclarations = LeadDeliveryItem.schema.indexes()
    .filter(([fields]) => JSON.stringify(fields) === JSON.stringify({ providerExternalLeadId: 1 }));
  assert.equal(externalKeyDeclarations.length, 1);
  assert.equal(externalKeyDeclarations[0][1].name, "uq_lead_delivery_external_id");
  assert.equal(indexByName(LeadDeliveryItem, "uq_lead_delivery_provider_contact_id")[1].unique, true);
  assert.deepEqual(
    indexByName(LeadDeliveryItem, "idx_lead_delivery_completed_agent_attempts")[0],
    {
      "providerAttemptHistory.deliveryAgentId": 1,
      "providerAttemptHistory.event": 1,
    },
  );
  assert.equal(indexByName(LeadDeliveryEvent, EVENT_DEDUPE_INDEX)[1].unique, true);
  assert.equal(indexByName(LeadDeliveryEvent, EVENT_PROVIDER_ID_INDEX)[1].unique, true);
  assert.equal(LeadDeliveryItem.schema.options.versionKey, false);
  assert.equal(LeadDeliveryAgent.schema.options.versionKey, false);
  assert.equal(LeadDeliveryEvent.schema.options.versionKey, false);
  assert.equal(LeadDeliveryCheckpoint.schema.options.versionKey, false);
  assert.equal(LeadDeliveryItem.schema.path("version").defaultValue, 0);
  assert.equal(LeadDeliveryAgent.schema.path("refillRequestId").defaultValue, null);
  assert.equal(LeadDeliveryEvent.schema.path("status").defaultValue, "pending");
  assert.equal(LeadDeliveryCheckpoint.schema.path("status").defaultValue, "scheduled");
  for (const piiField of ["caseId", "sourceIdentity", "normalizedPhone", "displayName", "folderId"]) {
    assert.equal(LeadDeliveryCheckpoint.schema.path(piiField), undefined);
  }
  const invalid = new LeadDeliveryItem({
    domain: "TAG", caseId: "101", normalizedPhone: "3105550100",
    receivedAt: new Date(), state: "not-a-real-state", activeAttempt: true,
  }).validateSync();
  assert.ok(invalid?.errors?.state);
  const normalized = new LeadDeliveryItem({
    domain: " tag ", caseId: " 101 ", normalizedPhone: "3105550100",
    receivedAt: new Date(), state: "eligible", activeAttempt: true,
    provider: " PhoneBurner ", reservedAgentId: " BRAD ", deliveryAgentId: " ",
    providerExternalLeadId: " ", providerContactId: " contact-1 ", providerCallId: " ",
  });
  assert.equal(normalized.domain, "TAG");
  assert.equal(normalized.caseId, "101");
  assert.equal(normalized.provider, "phoneburner");
  assert.equal(normalized.reservedAgentId, "brad");
  assert.equal(normalized.deliveryAgentId, null);
  assert.equal(normalized.providerExternalLeadId, null);
  assert.equal(normalized.providerContactId, "contact-1");
  assert.equal(normalized.providerCallId, null);
  const failClosed = new LeadDeliveryItem({
    domain: "TAG", caseId: "102", normalizedPhone: "3105550100", receivedAt: new Date(),
  }).validateSync();
  assert.ok(failClosed?.errors?.state);
  assert.ok(failClosed?.errors?.activeAttempt);
  assert.equal(LeadDeliveryItem.schema.path("state").defaultValue, undefined);
  assert.equal(LeadDeliveryItem.schema.path("activeAttempt").defaultValue, undefined);
  const blankEvent = new LeadDeliveryEvent({
    provider: " PhoneBurner ", providerEventId: " ", providerCallId: " ",
    providerContactId: " ", providerExternalLeadId: " ", eventType: "call_done",
    dedupeKey: "key", payloadDigest: "digest",
  });
  assert.equal(blankEvent.provider, "phoneburner");
  assert.equal(blankEvent.providerEventId, null);
  assert.equal(blankEvent.providerCallId, null);
  assert.equal(blankEvent.providerContactId, null);
  assert.equal(blankEvent.providerExternalLeadId, null);
  const invalidAgentCounter = new LeadDeliveryAgent({
    agentId: "brad", estimatedOutstanding: -1, pendingFreshCount: 0.5,
  }).validateSync();
  assert.ok(invalidAgentCounter?.errors?.estimatedOutstanding);
  assert.ok(invalidAgentCounter?.errors?.pendingFreshCount);
  const invalidEventCounter = new LeadDeliveryEvent({
    provider: "phoneburner", providerCallId: "call-counter", eventType: "call_done",
    dedupeKey: "key-counter", payloadDigest: "digest-counter", attempts: -1,
  }).validateSync();
  assert.ok(invalidEventCounter?.errors?.attempts);
});

test("migration checkpoint persists one PII-free half-open cutover contract", async () => {
  const { repository, Checkpoint } = makeRepository();
  const input = {
    checkpointKey: "monday-july-cutover",
    source: "lead_cadence",
    windowStartAt: new Date("2026-07-01T07:00:00.000Z"),
    cutoffAt: new Date("2026-07-13T14:30:00.000Z"),
    preloadKey: "preload-v1-safe",
    maxContacts: 5000,
    agentSetDigest: "a".repeat(64),
  };

  const inserted = await repository.insertCheckpointOnce(input);
  const duplicate = await repository.insertCheckpointOnce(input);
  const found = await repository.getCheckpointByKey(input.checkpointKey);

  assert.equal(duplicate, null);
  assert.equal(Checkpoint.docs.length, 1);
  assert.equal(inserted.status, "scheduled");
  assert.equal(inserted.preloadPredicate, "received_at_lt_cutoff");
  assert.equal(inserted.continuationPredicate, "received_at_gte_cutoff");
  assert.equal(inserted.sortContract, "received_at_desc_source_identity_asc_v1");
  assert.equal(inserted.cutoffAt.toISOString(), "2026-07-13T14:30:00.000Z");
  assert.equal(found._id, input.checkpointKey);
  assert.equal(found.latestAdmittedIdentityDigest, undefined);
  assert.equal(JSON.stringify(found).includes("caseId"), false);
  assert.equal(JSON.stringify(found).includes("normalizedPhone"), false);
});

test("migration checkpoint updates only audit state under exact version CAS", async () => {
  const { repository } = makeRepository();
  const checkpoint = await repository.insertCheckpointOnce({
    checkpointKey: "monday-july-cutover",
    source: "lead_cadence",
    windowStartAt: new Date("2026-07-01T07:00:00.000Z"),
    cutoffAt: new Date("2026-07-13T14:30:00.000Z"),
    preloadKey: "preload-v1-safe",
    maxContacts: 5000,
    agentSetDigest: "a".repeat(64),
  });
  const updated = await repository.compareAndSetCheckpoint({
    checkpointKey: checkpoint._id,
    expectedVersion: 0,
    expected: { status: "scheduled" },
    set: {
      status: "running",
      scannedCount: 12,
      admittedCount: 10,
      acceptedCount: 8,
      pendingCount: 2,
      latestAdmittedReceivedAt: new Date("2026-07-13T14:29:59.000Z"),
      latestAdmittedIdentityDigest: "b".repeat(64),
    },
  });

  assert.equal(updated.version, 1);
  assert.equal(updated.status, "running");
  assert.equal(updated.acceptedCount, 8);
  assert.equal(await repository.compareAndSetCheckpoint({
    checkpointKey: checkpoint._id,
    expectedVersion: 0,
    set: { status: "completed" },
  }), null);
  await assert.rejects(repository.compareAndSetCheckpoint({
    checkpointKey: checkpoint._id,
    expectedVersion: 1,
    set: { cutoffAt: new Date() },
  }), /unknown field cutoffAt/);
});

test("insertActiveItemOnce derives one permanent source identity and swallows only owned identity conflicts", async () => {
  const { repository, Item } = makeRepository();
  const required = { normalizedPhone: "3105550100", receivedAt: new Date("2026-07-10T17:00:00Z") };
  const first = await repository.insertActiveItemOnce({ ...required, domain: "TAG", caseId: "101", state: "provider_accepted", activeAttempt: true, providerExternalLeadId: "ext-a" });
  const duplicate = await repository.insertActiveItemOnce({ ...required, domain: "TAG", caseId: "101", state: "eligible", activeAttempt: true, providerExternalLeadId: "ext-b" });
  assert.ok(first);
  assert.equal(first.sourceIdentity, "TAG:101");
  assert.equal(duplicate, null);
  assert.equal(Item.docs.length, 1);
  await assert.rejects(
    repository.insertActiveItemOnce({ ...required, domain: "TAG", caseId: "102", state: "eligible", activeAttempt: true, providerExternalLeadId: "ext-a" }),
    /external_id/,
  );
  const completion = transitionCompletedAttempt(first, "dnc", {
    attemptedAt: new Date("2026-07-10T17:00:00Z"),
    completedAt: new Date("2026-07-10T17:01:00Z"),
    providerCallId: "call-1",
  });
  const closed = await repository.compareAndSetItem({
    itemId: first._id,
    expectedVersion: 0,
    expected: { activeAttempt: true },
    set: { activeAttempt: completion.activeAttempt, state: completion.state },
  });
  assert.ok(closed);
  assert.equal(closed.activeAttempt, false);
  assert.equal(
    await repository.insertActiveItemOnce({ ...required, domain: "TAG", caseId: "101", state: "eligible", activeAttempt: true, providerExternalLeadId: "ext-c" }),
    null,
  );
  assert.equal(Item.docs.length, 1);
});

test("reservation compare-and-set race has exactly one winner", async () => {
  const { repository, Item } = makeRepository({ items: [{ _id: "item-1", state: "eligible", reservedAgentId: null, version: 0 }] });
  const claim = (agentId) => repository.compareAndSetItem({
    itemId: "item-1",
    expectedVersion: 0,
    expected: { state: "eligible", reservedAgentId: null },
    set: { state: "reserved", activeAttempt: true, reservedAgentId: agentId },
  });
  const results = await Promise.all([claim("brad"), claim("sean")]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(Item.docs[0].version, 1);
  assert.equal(Item.docs[0].state, "reserved");
  assert.ok(["brad", "sean"].includes(Item.docs[0].reservedAgentId));
});

test("item CAS appends provider attempt evidence atomically and rejects arbitrary arrays", async () => {
  const { repository, Item } = makeRepository({ items: [{
    _id: "item-attempt",
    state: "packetized",
    activeAttempt: true,
    providerAttemptHistory: [],
    version: 0,
  }] });
  const evidence = {
    attemptNumber: 1,
    event: "prepared",
    provider: "phoneburner",
    providerExternalLeadId: "external-1",
    occurredAt: new Date("2026-07-10T17:00:00Z"),
  };
  const updated = await repository.compareAndSetItem({
    itemId: "item-attempt",
    expectedVersion: 0,
    expected: { state: "packetized" },
    set: { providerAttemptSequence: 1 },
    append: { providerAttemptHistory: [evidence] },
  });
  assert.equal(updated.version, 1);
  assert.deepEqual(updated.providerAttemptHistory, [evidence]);
  assert.deepEqual(Item.calls[0].update.$push, {
    providerAttemptHistory: { $each: [evidence] },
  });
  await assert.rejects(repository.compareAndSetItem({
    itemId: "item-attempt",
    expectedVersion: 1,
    append: { mysteryHistory: [evidence] },
  }), /not an appendable array/);
});

test("refill lock uses version and request token to prevent duplicate and stale release", async () => {
  const { repository, Agent } = makeRepository({ agents: [{ agentId: "brad", openRefillRequest: false, refillRequestId: null, version: 4 }] });
  const results = await Promise.all([
    repository.acquireRefillRequest({ agentId: "brad", expectedVersion: 4, refillRequestId: "request-a", requestedAt: new Date() }),
    repository.acquireRefillRequest({ agentId: "brad", expectedVersion: 4, refillRequestId: "request-b", requestedAt: new Date() }),
  ]);
  const winner = results.find(Boolean);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(Agent.docs[0].version, 5);
  assert.equal(await repository.releaseRefillRequest({ agentId: "brad", expectedVersion: 5, refillRequestId: "wrong" }), null);
  const released = await repository.releaseRefillRequest({ agentId: "brad", expectedVersion: 5, refillRequestId: winner.refillRequestId });
  assert.equal(released.openRefillRequest, false);
  assert.equal(released.refillRequestId, null);
  assert.equal(released.version, 6);
});

test("expired refill locks are reclaimable but live locks and old tokens cannot interfere", async () => {
  const now = new Date("2026-07-10T17:00:00Z");
  const { repository, Agent } = makeRepository({ agents: [{
    agentId: "bruce_allen",
    openRefillRequest: false,
    refillRequestId: null,
    refillLeaseExpiresAt: null,
    version: 0,
  }] });
  const first = await repository.acquireRefillRequest({
    agentId: "bruce_allen",
    expectedVersion: 0,
    refillRequestId: "refill-a",
    requestedAt: now,
    leaseMs: 60_000,
  });
  assert.equal(first.refillRequestId, "refill-a");
  assert.equal(await repository.acquireRefillRequest({
    agentId: "bruce_allen",
    expectedVersion: 1,
    refillRequestId: "refill-b",
    requestedAt: new Date(now.getTime() + 30_000),
  }), null);
  const reclaimed = await repository.acquireRefillRequest({
    agentId: "bruce_allen",
    expectedVersion: 1,
    refillRequestId: "refill-c",
    requestedAt: new Date(now.getTime() + 60_000),
  });
  assert.equal(reclaimed.refillRequestId, "refill-c");
  assert.equal(reclaimed.version, 2);
  assert.equal(await repository.releaseRefillRequest({
    agentId: "bruce_allen",
    expectedVersion: 2,
    refillRequestId: "refill-a",
  }), null);
  assert.equal(Agent.docs[0].refillRequestId, "refill-c");
});

test("event insertion derives canonical identity and is idempotent", async () => {
  const { repository, Event } = makeRepository();
  const event = { provider: "phoneburner", providerEventId: "event-1", dedupeKey: "event:event-1", eventType: "call_done", payloadDigest: "digest-1" };
  const results = await Promise.all([repository.insertEventOnce(event), repository.insertEventOnce({ ...event, normalizedOutcome: "dnc" })]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(Event.docs.length, 1);
  assert.equal(Event.docs[0].normalizedOutcome, undefined);
  assert.equal(await repository.insertEventOnce({ provider: "other", providerEventId: "event-1", dedupeKey: event.dedupeKey, eventType: "call_done", payloadDigest: "digest-2" }) !== null, true);
  assert.equal(await repository.insertEventOnce({
    provider: "phoneburner",
    providerCallId: "call-fallback",
    providerContactId: "contact-fallback-a",
    providerExternalLeadId: "external-fallback-a",
    dedupeKey: "caller-cannot-own-this",
    eventType: "call_done",
    payloadDigest: "digest-3",
  }) !== null, true);
  assert.equal(await repository.insertEventOnce({
    provider: "phoneburner",
    providerCallId: "call-fallback",
    providerContactId: "contact-fallback-b",
    providerExternalLeadId: "external-fallback-b",
    eventType: "call_done",
    payloadDigest: "digest-3b",
  }) !== null, true, "a reused provider call ID must not merge two exact attempts");
  assert.equal(await repository.insertEventOnce({ provider: "phoneburner", dedupeKey: "different-key", providerEventId: "event-1", eventType: "call_done", payloadDigest: "digest-4" }), null);
  await assert.rejects(repository.insertEventOnce({ provider: "phoneburner", dedupeKey: "", eventType: "call_done", payloadDigest: "digest-5" }), /providerCallId/);
});

test("exact reservation expiry cannot release early, stale, wrong-owner, or newer reservations", async () => {
  const expiry = new Date("2026-07-10T16:15:00Z");
  const { repository, Item } = makeRepository({ items: [{
    _id: "fresh-1",
    state: "reserved",
    reservedAgentId: "brad",
    version: 3,
    reservationExpiresAt: expiry,
    freshDeadlineAt: expiry,
  }] });
  const base = {
    itemId: "fresh-1",
    expectedVersion: 3,
    expectedAgentId: "brad",
    expectedExpiresAt: expiry,
    set: { state: "eligible", activeAttempt: true, reservedAgentId: null },
    unset: { reservationExpiresAt: true },
  };
  assert.equal(await repository.expireReservationCas({ ...base, now: new Date("2026-07-10T16:14:59.999Z") }), null);
  assert.equal(await repository.expireReservationCas({ ...base, expectedAgentId: "sean", now: expiry }), null);
  assert.equal(await repository.expireReservationCas({ ...base, expectedVersion: 2, now: expiry }), null);
  Item.docs[0].reservedAgentId = "sean";
  Item.docs[0].version = 4;
  assert.equal(await repository.expireReservationCas({ ...base, now: expiry }), null);
  assert.equal(Item.docs[0].reservedAgentId, "sean");
  assert.equal(Item.docs[0].freshDeadlineAt.getTime(), expiry.getTime());
});

test("exact expiry succeeds at boundary and preserves absolute fresh deadline", async () => {
  const expiry = new Date("2026-07-10T16:15:00Z");
  const { repository, Item } = makeRepository({ items: [{
    _id: "fresh-1", state: "reserved", reservedAgentId: "brad", version: 3,
    reservationExpiresAt: expiry, freshDeadlineAt: expiry,
  }] });
  const result = await repository.expireReservationCas({
    itemId: "fresh-1",
    expectedVersion: 3,
    expectedAgentId: "brad",
    expectedExpiresAt: expiry,
    now: expiry,
    set: { state: "eligible", activeAttempt: true, reservedAgentId: null },
    unset: { reservationExpiresAt: true },
  });
  assert.equal(result.version, 4);
  assert.equal(result.state, "eligible");
  assert.equal(Item.docs[0].freshDeadlineAt.getTime(), expiry.getTime());
});

test("transaction rolls back item claim when the agent fairness CAS fails", async () => {
  const { repository, Item, Agent } = makeRepository({
    items: [{ _id: "fresh", state: "eligible", reservedAgentId: null, version: 0 }],
    agents: [{ agentId: "brad", version: 0, freshReservedThisHour: 0 }],
  });
  await assert.rejects(repository.withTransaction(async (session) => {
    const claimed = await repository.compareAndSetItem({
      itemId: "fresh", expectedVersion: 0, expected: { state: "eligible" },
      set: { state: "reserved", activeAttempt: true, reservedAgentId: "brad" }, session,
    });
    assert.ok(claimed);
    const charged = await repository.compareAndSetAgent({
      agentId: "brad", expectedVersion: 99,
      increment: { freshReservedThisHour: 1, pendingFreshCount: 1 }, session,
    });
    if (!charged) throw new Error("agent fairness conflict");
  }), /agent fairness conflict/);
  assert.deepEqual(Item.docs[0], { _id: "fresh", state: "eligible", reservedAgentId: null, version: 0 });
  assert.deepEqual(Agent.docs[0], { agentId: "brad", version: 0, freshReservedThisHour: 0 });
});

test("CAS operations carry exact version, validators, and session without mutating input", async () => {
  const { repository, Item } = makeRepository({ items: [{ _id: "item", state: "eligible", version: 0 }] });
  const set = { state: "reserved", activeAttempt: true, reservedAgentId: "brad" };
  const snapshot = structuredClone(set);
  const session = { id: "session" };
  await repository.compareAndSetItem({ itemId: "item", expectedVersion: 0, expected: { state: "eligible" }, set, session });
  const call = Item.calls[0];
  assert.equal(call.filter.version, 0);
  assert.equal(call.update.$inc.version, 1);
  assert.equal(call.options.new, true);
  assert.equal(call.options.runValidators, true);
  assert.equal(call.options.session, session);
  assert.equal(call.options.upsert, undefined);
  assert.deepEqual(set, snapshot);
  await assert.rejects(repository.compareAndSetItem({ itemId: "item", expectedVersion: 1, set: { version: 500 } }), /not allowed/);
});

test("projection read is scoped by permanent delivery agent rather than reservation owner", async () => {
  const { repository } = makeRepository({ items: [
    { _id: "brad-a", deliveryAgentId: "brad", reservedAgentId: null, state: "provider_accepted", version: 1 },
    { _id: "sean-a", deliveryAgentId: "sean", reservedAgentId: "brad", state: "provider_accepted", version: 1 },
  ] });
  const rows = await repository.listAgentProjectionItems("brad");
  assert.deepEqual(rows.map((row) => row._id), ["brad-a"]);
});
