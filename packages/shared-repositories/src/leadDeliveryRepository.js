"use strict";

const DefaultItem = require("../../shared-models/src/LeadDeliveryItem");
const DefaultAgent = require("../../shared-models/src/LeadDeliveryAgent");
const DefaultCheckpoint = require("../../shared-models/src/LeadDeliveryCheckpoint");
const DefaultEvent = require("../../shared-models/src/LeadDeliveryEvent");
const DefaultFairPickCursor = require("../../shared-models/src/LeadDeliveryFairPickCursor");
const DefaultLeadCadence = require("../../shared-models/src/LeadCadence");
const DefaultCaseProfile = require("../../shared-models/src/CaseProfile");
const DefaultCxAppointment = require("../../shared-models/src/CxAppointment");
const DefaultCxTerminalOutbox = require("../../shared-models/src/CxTerminalOutbox");
const DefaultCallLog = require("../../shared-models/src/CallLog");
const DefaultMasterProspectIndex = require("../../shared-models/src/MasterProspectIndex");

// Phase 9: LeadCadence + current Logics evidence are the pre-serve authority.
// Preserve the legacy join for the no-delete proof window, but never execute
// it from the production source reader.
const CASE_PROFILE_SOURCE_JOIN_ENABLED = false;
const {
  ACTIVE_APPOINTMENT_STATUSES,
} = require("./cxAppointmentRepository");
const {
  buildEventDedupeKey,
  isActiveAttemptState,
} = require("../../shared-services/src/leadDeliveryService");

const ACTIVE_ATTEMPT_INDEX = "uq_lead_delivery_active_attempt";
const SOURCE_IDENTITY_INDEX = "uq_lead_delivery_source_identity";
const EVENT_DEDUPE_INDEX = "uq_lead_delivery_provider_event";
const EVENT_PROVIDER_ID_INDEX = "uq_lead_delivery_provider_event_id";

const ITEM_INCREMENTABLE_COUNTERS = new Set([
  "dailyAttemptCount",
  "totalAttemptCount",
  "providerPostAttemptCount",
]);
const AGENT_INCREMENTABLE_COUNTERS = new Set([
  "providerAcceptedCount",
  "providerCompletedCount",
  "estimatedOutstanding",
  "freshReservedThisHour",
  "pendingFreshCount",
]);
const POOL_OPERATION_KINDS = new Set([
  "ordinary_refill",
  "immediate_fresh",
  "productivity",
  "day_start",
  "day_close",
]);
const EVENT_INCREMENTABLE_COUNTERS = new Set(["attempts"]);
const CHECKPOINT_INSERT_FIELDS = new Set([
  "checkpointKey",
  "kind",
  "source",
  "windowStartAt",
  "cutoffAt",
  "preloadPredicate",
  "continuationPredicate",
  "sortContract",
  "preloadKey",
  "maxContacts",
  "agentSetDigest",
  "status",
  "scannedCount",
  "eligibleCount",
  "admittedCount",
  "acceptedCount",
  "pendingCount",
  "failedCount",
  "conflictCount",
  "capReached",
  "admittedDigest",
  "acceptedDigest",
  "latestAdmittedReceivedAt",
  "latestAdmittedIdentityDigest",
  "latestAcceptedReceivedAt",
  "latestAcceptedIdentityDigest",
  "completedAt",
  "lastErrorCode",
]);
const CHECKPOINT_MUTABLE_FIELDS = new Set([
  "status",
  "scannedCount",
  "eligibleCount",
  "admittedCount",
  "acceptedCount",
  "pendingCount",
  "failedCount",
  "conflictCount",
  "capReached",
  "admittedDigest",
  "acceptedDigest",
  "latestAdmittedReceivedAt",
  "latestAdmittedIdentityDigest",
  "latestAcceptedReceivedAt",
  "latestAcceptedIdentityDigest",
  "completedAt",
  "lastErrorCode",
]);
const CHECKPOINT_COUNT_FIELDS = new Set([
  "scannedCount",
  "eligibleCount",
  "admittedCount",
  "acceptedCount",
  "pendingCount",
  "failedCount",
  "conflictCount",
]);
const CHECKPOINT_DATE_FIELDS = new Set([
  "latestAdmittedReceivedAt",
  "latestAcceptedReceivedAt",
  "completedAt",
]);
const CHECKPOINT_DIGEST_FIELDS = new Set([
  "agentSetDigest",
  "admittedDigest",
  "acceptedDigest",
  "latestAdmittedIdentityDigest",
  "latestAcceptedIdentityDigest",
]);
const CHECKPOINT_STATUSES = new Set(["scheduled", "running", "partial", "completed", "failed"]);
const SOURCE_REPAIR_STATUSES = new Set(["scheduled", "running", "completed", "failed"]);
const SOURCE_REPAIR_MUTABLE_FIELDS = new Set([
  "status",
  "repairCursorCreatedAt",
  "repairCursorId",
  "highWaterCreatedAt",
  "highWaterId",
  "scannedCount",
  "admittedCount",
  "skippedCount",
  "completedAt",
  "lastRunAt",
  "lastErrorCode",
]);
const SHA256_HEX = /^[a-f0-9]{64}$/;
const ITEM_APPENDABLE_ARRAYS = new Set(["providerAttemptHistory"]);
const IMMUTABLE_ITEM_FIELDS = new Set(["domain", "caseId", "sourceIdentity", "leadCadenceId"]);
const AGENT_CONFIGURATION_FIELDS = new Set([
  "provider",
  "providerConfig",
  "phoneBurnerMemberId",
  "phoneBurnerUsername",
  "applicationAccountEmail",
  "distributionFolderId",
  "receivingFolderId",
  "leadStreamId",
  "subscribedPools",
  "packetAllowances",
  "providerBufferTarget",
  "refillAtOrBelow",
  "freshReservationRange",
  "freshReservationMinutes",
  "activeEvidenceMinutes",
  "maxPendingFreshReservations",
]);
const AGENT_CONFIGURATION_INPUT_FIELDS = new Set(["agentId", "displayName", "enabled", "configuration"]);
const AGENT_RUNTIME_FIELDS = new Set([
  "agentId",
  "displayName",
  "enabled",
  "operatorPaused",
  "operatorChangedAt",
  "shiftEnabled",
  "activeUntil",
  "lastProviderEvidenceAt",
  "providerAcceptedCount",
  "providerCompletedCount",
  "estimatedOutstanding",
  "openRefillRequest",
  "refillRequestId",
  "refillLeaseExpiresAt",
  "lastRefillRequestedAt",
  "lastPacketAt",
  "fairnessHourKey",
  "fairnessTieBreaker",
  "freshReservedThisHour",
  "lastFreshReservedAt",
  "pendingFreshCount",
  "poolOperationId",
  "poolOperationKind",
  "poolOperationLeaseExpiresAt",
  "poolOperationStartedAt",
  "version",
  "metadata",
  "createdAt",
  "updatedAt",
]);
const SECRET_LIKE_CONFIGURATION_FIELD = /(?:secret|token|password|credential|authorization|api[_-]?key|private[_-]?key)/i;
const PACKET_CANDIDATE_STATES = Object.freeze(["eligible", "follow_up_wait", "reserved"]);
const SOURCE_LEAD_PROJECTION = Object.freeze({
  _id: 1,
  domain: 1,
  caseId: 1,
  firstName: 1,
  lastName: 1,
  name: 1,
  primaryPhone: 1,
  normalizedPhone: 1,
  city: 1,
  state: 1,
  statusId: 1,
  logicsStatusCheckedAt: 1,
  logicsProspectEligible: 1,
  active: 1,
  currentStage: 1,
  createdAt: 1,
  updatedAt: 1,
  "attributionContext.receivedAt": 1,
  "payloadSnapshot.createdAt": 1,
  "payloadSnapshot.state": 1,
  "payloadSnapshot.timeZone": 1,
  "payloadSnapshot.timezone": 1,
  "payloadSnapshot.cxAppointment": 1,
  "cadenceState.channelDnc.cx.blocked": 1,
  "cadenceState.channelDnc.cx.reason": 1,
  "dncCheckpoints.hit": 1,
  "counterCadence.cxDailyDateKey": 1,
  "counterCadence.cxDailyCalls": 1,
  "counterCadence.lastCxDialedAt": 1,
  "counterCadence.lastCxAnsweredAt": 1,
  "counterCadence.lastCxDncAt": 1,
  "counterCadence.lastCxTerminalCountedUii": 1,
  "lastTouched.cx": 1,
  "cadenceCounters.cx": 1,
});
const SOURCE_CASE_PROJECTION = Object.freeze({
  _id: 1,
  domain: 1,
  caseId: 1,
  statusId: 1,
  statusCategory: 1,
  lastStatusCheckAt: 1,
  convertedAt: 1,
  firstPaymentDate: 1,
  paymentsCount: 1,
  totalPaid: 1,
  "conversationAi.optOutDetected": 1,
  "aiActivityReview.status": 1,
  "aiCaseReview.nextEligibleAt": 1,
  "scrubSummary.status": 1,
});
const SOURCE_APPOINTMENT_PROJECTION = Object.freeze({
  _id: 1,
  appointmentId: 1,
  domain: 1,
  caseId: 1,
  status: 1,
  appointmentAt: 1,
  legalDialAt: 1,
  updatedAt: 1,
});
const LEGACY_CADENCE_COUNT_PROJECTION = Object.freeze({
  _id: 1,
  "counterCadence.cxDailyDateKey": 1,
  "counterCadence.cxDailyCalls": 1,
});
const LEGACY_OUTBOX_COUNT_PROJECTION = Object.freeze({
  _id: 1,
  uii: 1,
  idemKey: 1,
  createdAt: 1,
  "payload.uii": 1,
});
const LEGACY_CALL_LOG_COUNT_PROJECTION = Object.freeze({
  _id: 1,
  telephonySessionId: 1,
  callStartTime: 1,
});
const LEGACY_MPI_COUNT_PROJECTION = Object.freeze({
  _id: 1,
  "filler.dailyDateKey": 1,
  "filler.dailyAttempts": 1,
});

function isDuplicateKeyError(error) {
  return Number(error?.code) === 11000;
}

function duplicateIndexName(error) {
  const keyPattern = error?.keyPattern;
  if (keyPattern && typeof keyPattern === "object" && !Array.isArray(keyPattern)) {
    const keys = Object.keys(keyPattern).sort().join("|");
    if (keys === "caseId|domain") return ACTIVE_ATTEMPT_INDEX;
    if (keys === "sourceIdentity") return SOURCE_IDENTITY_INDEX;
    if (keys === "dedupeKey|provider") return EVENT_DEDUPE_INDEX;
    if (keys === "provider|providerEventId") return EVENT_PROVIDER_ID_INDEX;
    if (keys === "_id") return "_id_";
    return null;
  }
  const message = String(error?.message || "");
  if (message.includes(ACTIVE_ATTEMPT_INDEX)) return ACTIVE_ATTEMPT_INDEX;
  if (message.includes(SOURCE_IDENTITY_INDEX)) return SOURCE_IDENTITY_INDEX;
  if (message.includes(EVENT_DEDUPE_INDEX)) return EVENT_DEDUPE_INDEX;
  if (message.includes(EVENT_PROVIDER_ID_INDEX)) return EVENT_PROVIDER_ID_INDEX;
  return String(error?.index || error?.indexName || "").trim() || null;
}

function plain(value) {
  if (!value) return value;
  return typeof value.toObject === "function" ? value.toObject() : value;
}

async function lean(query) {
  if (query && typeof query.lean === "function") return query.lean();
  return query;
}

function requireString(value, name) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new TypeError(`${name} is required`);
  return normalized;
}

function requireNonblankString(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} must be a nonblank string`);
  return value.trim();
}

function normalizeNullableIdentity(value, name, { lowercase = false } = {}) {
  if (value == null) return null;
  if (typeof value !== "string" && typeof value !== "number") {
    throw new TypeError(`${name} must be a string, number, or null`);
  }
  const normalized = String(value).trim();
  if (!normalized) return null;
  return lowercase ? normalized.toLowerCase() : normalized;
}

function requireVersion(value, name = "expectedVersion") {
  if (typeof value === "number") {
    if (Number.isSafeInteger(value) && value >= 0) return value;
  } else if (typeof value === "string" && /^(?:0|[1-9]\d*)$/.test(value)) {
    const number = Number(value);
    if (Number.isSafeInteger(number)) return number;
  }
  throw new TypeError(`${name} must be a non-negative integer`);
}

function requireDate(value, name) {
  const validInputType = value instanceof Date
    || (typeof value === "string" && value.trim() !== "")
    || (typeof value === "number" && Number.isFinite(value));
  if (!validInputType) throw new TypeError(`${name} must be a valid date`);
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new TypeError(`${name} must be a valid date`);
  return parsed;
}

function requireBusinessDate(value, name = "businessDate") {
  const normalized = requireNonblankString(value, name);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw new TypeError(`${name} must use YYYY-MM-DD`);
  }
  return normalized;
}

function requirePoolOperationKind(value, name = "poolOperationKind") {
  const normalized = requireNonblankString(value, name).toLowerCase();
  if (!POOL_OPERATION_KINDS.has(normalized)) throw new TypeError(`${name} is unsupported`);
  return normalized;
}

function requireSourceCaseId(value, name = "caseId") {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^(?:0|[1-9]\d*)$/.test(value.trim())) {
    const parsed = Number(value.trim());
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  throw new TypeError(`${name} must be a non-negative integer`);
}

function normalizeSourceDomains(domains) {
  if (!Array.isArray(domains) || domains.length === 0) {
    throw new TypeError("domains must be a non-empty array");
  }
  return [...new Set(domains.map((domain, index) => (
    requireNonblankString(domain, `domains[${index}]`).toUpperCase()
  )))];
}

function valueAtPath(object, dottedPath) {
  return String(dottedPath).split(".").reduce((value, key) => value?.[key], object);
}

function sourceJoinKey(domain, caseId) {
  return `${String(domain || "").trim().toUpperCase()}:${String(caseId ?? "").trim()}`;
}

function safeCount(value) {
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

function normalizeSourceCursor(cursor) {
  if (cursor == null) return null;
  const normalized = exactObject(cursor, new Set(["createdAt", "id"]), "cursor");
  return {
    createdAt: requireDate(normalized.createdAt, "cursor.createdAt"),
    id: requireNonblankString(normalized.id, "cursor.id"),
  };
}

function sourceReceiptWindowFilter(receivedFrom, receivedBefore) {
  const from = requireDate(receivedFrom, "receivedFrom");
  const before = requireDate(receivedBefore, "receivedBefore");
  if (before.getTime() <= from.getTime()) {
    throw new TypeError("receivedBefore must be after receivedFrom");
  }
  const inWindow = { $gte: from, $lt: before };
  const missing = (field) => ({ $or: [{ [field]: null }, { [field]: "" }] });
  return {
    $or: [
      { "payloadSnapshot.createdAt": inWindow },
      // payloadSnapshot is Mixed in older cadence rows, so its createdAt may
      // be a string. Include the indexed cadence timestamp as a broad
      // candidate path; the service parses canonical receipt evidence and
      // reapplies the exact half-open bounds before selecting anything.
      { createdAt: inWindow },
      {
        $and: [
          missing("payloadSnapshot.createdAt"),
          { "attributionContext.receivedAt": inWindow },
        ],
      },
      {
        $and: [
          missing("payloadSnapshot.createdAt"),
          missing("attributionContext.receivedAt"),
          { createdAt: inWindow },
        ],
      },
    ],
  };
}

function terminalOutboxOccurrenceKey(row = {}) {
  const uii = String(row.uii || valueAtPath(row, "payload.uii") || "").trim();
  if (uii) return `uii:${uii}`;
  const idemKey = String(row.idemKey || "").trim();
  if (!idemKey) return null;
  const parts = idemKey.split(":").map((part) => part.trim());
  if (parts.some((part) => !part)) return null;
  if (parts.length === 2) return `uii:${parts[1]}`;
  if (parts.length === 3 && parts[1].toLowerCase() === "uii") return `uii:${parts[2]}`;
  if (parts.length === 3 && parts[2].toLowerCase() === "terminal") return `idem:${idemKey}`;
  if (parts.length === 4
    && parts[1].toLowerCase() === "case"
    && parts[3].toLowerCase() === "terminal") return `idem:${idemKey}`;
  return null;
}

function safeObject(value, name) {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  const output = { ...value };
  for (const key of Object.keys(output)) {
    if (key === "_id" || key === "version" || key.startsWith("$")) {
      throw new TypeError(`${name}.${key} is not allowed`);
    }
  }
  return output;
}

function exactObject(value, allowedFields, name) {
  const output = safeObject(value, name);
  for (const field of Object.keys(output)) {
    if (!allowedFields.has(field)) throw new TypeError(`${name} contains unknown field ${field}`);
  }
  return output;
}

function cloneConfigurationValue(value, path = "configuration", depth = 0) {
  if (depth > 12) throw new TypeError(`${path} is nested too deeply`);
  if (value == null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${path} must contain finite numbers`);
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => cloneConfigurationValue(entry, `${path}[${index}]`, depth + 1));
  }
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${path} must contain only plain configuration values`);
  }
  const output = {};
  for (const [field, entry] of Object.entries(value)) {
    if (!field || field === "_id" || field.startsWith("$") || field.includes(".")) {
      throw new TypeError(`${path}.${field || "<blank>"} is not allowed`);
    }
    if (SECRET_LIKE_CONFIGURATION_FIELD.test(field)) {
      throw new TypeError(`${path}.${field} may not contain secret material`);
    }
    if (AGENT_RUNTIME_FIELDS.has(field)) {
      throw new TypeError(`${path}.${field} is runtime-owned`);
    }
    output[field] = cloneConfigurationValue(entry, `${path}.${field}`, depth + 1);
  }
  return output;
}

function normalizeAgentConfiguration(value) {
  const configuration = exactObject(value, AGENT_CONFIGURATION_FIELDS, "configuration");
  return cloneConfigurationValue(configuration);
}

function applySession(query, session) {
  if (session && query && typeof query.session === "function") return query.session(session);
  return query;
}

function normalizeIncrements(increment, incrementableCounters) {
  const safeIncrement = safeObject(increment, "increment");
  const decrementGuards = [];
  for (const [field, delta] of Object.entries(safeIncrement)) {
    if (!incrementableCounters.has(field)) {
      throw new TypeError(`increment.${field} is not an incrementable counter`);
    }
    if (!Number.isSafeInteger(delta)) {
      throw new TypeError(`increment.${field} must be an integer`);
    }
    if (delta < 0) decrementGuards.push({ [field]: { $gte: Math.abs(delta) } });
  }
  return { increment: safeIncrement, decrementGuards };
}

function normalizeAppend(append, appendableArrays) {
  const safeAppend = safeObject(append, "append");
  const output = {};
  for (const [field, entries] of Object.entries(safeAppend)) {
    if (!appendableArrays.has(field)) throw new TypeError(`append.${field} is not an appendable array`);
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new TypeError(`append.${field} must be a non-empty array`);
    }
    output[field] = { $each: entries.map((entry) => safeObject(entry, `append.${field} entry`)) };
  }
  return output;
}

function buildCasMutation({ set = {}, unset = {}, increment = {}, append = {} } = {}, incrementableCounters, appendableArrays = new Set()) {
  const safeSet = safeObject(set, "set");
  const safeUnset = safeObject(unset, "unset");
  const normalized = normalizeIncrements(increment, incrementableCounters);
  const safeAppend = normalizeAppend(append, appendableArrays);
  const safeIncrement = normalized.increment;
  const update = { $inc: { ...safeIncrement, version: 1 } };
  if (Object.keys(safeSet).length) update.$set = safeSet;
  if (Object.keys(safeUnset).length) {
    update.$unset = Object.fromEntries(Object.keys(safeUnset).map((key) => [key, 1]));
  }
  if (Object.keys(safeAppend).length) update.$push = safeAppend;
  return { update, decrementGuards: normalized.decrementGuards };
}

function normalizeItemStatePair(input, name = "set") {
  const output = safeObject(input, name);
  const hasState = Object.hasOwn(output, "state");
  const hasActiveAttempt = Object.hasOwn(output, "activeAttempt");
  if (hasState !== hasActiveAttempt) {
    throw new TypeError(`${name}.state and ${name}.activeAttempt must be supplied together`);
  }
  if (!hasState) return output;
  const state = requireNonblankString(output.state, `${name}.state`).toLowerCase();
  if (typeof output.activeAttempt !== "boolean") {
    throw new TypeError(`${name}.activeAttempt must be a boolean`);
  }
  const expectedActiveAttempt = isActiveAttemptState(state);
  if (output.activeAttempt !== expectedActiveAttempt) {
    throw new TypeError(`${name}.activeAttempt does not match state ${state}`);
  }
  return { ...output, state, activeAttempt: output.activeAttempt };
}

function addDecrementGuards(filter, decrementGuards) {
  if (!decrementGuards.length) return filter;
  const guarded = { ...filter };
  const collisions = [];
  for (const guard of decrementGuards) {
    const [field, predicate] = Object.entries(guard)[0];
    if (Object.hasOwn(guarded, field)) collisions.push(guard);
    else guarded[field] = predicate;
  }
  if (collisions.length) guarded.$and = collisions;
  return guarded;
}

async function createWithSession(Model, input, session = null) {
  if (!session) return plain(await Model.create(input));
  const rows = await Model.create([input], { session });
  return plain(rows[0]);
}

function createLeadDeliveryRepository({
  LeadDeliveryItem = DefaultItem,
  LeadDeliveryAgent = DefaultAgent,
  LeadDeliveryCheckpoint = DefaultCheckpoint,
  LeadDeliveryEvent = DefaultEvent,
  LeadDeliveryFairPickCursor = DefaultFairPickCursor,
  LeadCadence = DefaultLeadCadence,
  CaseProfile = DefaultCaseProfile,
  CxAppointment = DefaultCxAppointment,
  CxTerminalOutbox = DefaultCxTerminalOutbox,
  CallLog = DefaultCallLog,
  MasterProspectIndex = DefaultMasterProspectIndex,
  startSession = null,
} = {}) {
  const beginSession = startSession || (() => LeadDeliveryItem.db.startSession());

  async function getOrCreateFairPickCursor(workType, { agentOrder, session = null } = {}) {
    const key = requireNonblankString(workType, "workType").toLowerCase();
    if (!Array.isArray(agentOrder)) throw new TypeError("agentOrder must be an array");
    const ring = [...new Set(agentOrder
      .map((value) => requireNonblankString(value, "agentOrder entry").toLowerCase()))];
    if (!ring.length) throw new TypeError("agentOrder must not be empty");
    return lean(LeadDeliveryFairPickCursor.findOneAndUpdate(
      { _id: key },
      {
        $set: { agentOrder: ring },
        $setOnInsert: { _id: key, lastPickedAgentId: null, version: 0 },
      },
      {
        new: true,
        upsert: true,
        runValidators: true,
        setDefaultsOnInsert: true,
        session: session || undefined,
      },
    ));
  }

  async function compareAndSetFairPickCursor({
    workType,
    expectedVersion,
    expectedLastPickedAgentId = null,
    lastPickedAgentId,
    session = null,
  } = {}) {
    const key = requireNonblankString(workType, "workType").toLowerCase();
    const expectedLast = expectedLastPickedAgentId == null
      ? null
      : requireNonblankString(expectedLastPickedAgentId, "expectedLastPickedAgentId").toLowerCase();
    const picked = requireNonblankString(lastPickedAgentId, "lastPickedAgentId").toLowerCase();
    return lean(LeadDeliveryFairPickCursor.findOneAndUpdate(
      { _id: key, version: requireVersion(expectedVersion), lastPickedAgentId: expectedLast },
      { $set: { lastPickedAgentId: picked }, $inc: { version: 1 } },
      { new: true, runValidators: true, session: session || undefined },
    ));
  }

  async function compareAndSetItem({
    itemId,
    expectedVersion,
    expected = {},
    set = {},
    unset = {},
    increment = {},
    append = {},
    session = null,
  } = {}) {
    const normalizedSet = normalizeItemStatePair(set);
    const normalizedUnset = safeObject(unset, "unset");
    for (const field of IMMUTABLE_ITEM_FIELDS) {
      if (Object.hasOwn(normalizedSet, field) || Object.hasOwn(normalizedUnset, field)) {
        throw new TypeError(`${field} is immutable after source ingestion`);
      }
    }
    const mutation = buildCasMutation({
      set: normalizedSet,
      unset: normalizedUnset,
      increment,
      append,
    }, ITEM_INCREMENTABLE_COUNTERS, ITEM_APPENDABLE_ARRAYS);
    const filter = addDecrementGuards({
      _id: requireString(itemId, "itemId"),
      version: requireVersion(expectedVersion),
      ...safeObject(expected, "expected"),
    }, mutation.decrementGuards);
    return lean(LeadDeliveryItem.findOneAndUpdate(
      filter,
      mutation.update,
      { new: true, runValidators: true, session: session || undefined },
    ));
  }

  function normalizeCheckpointDigest(value, name, { required = false } = {}) {
    if (value == null || value === "") {
      if (required) throw new TypeError(`${name} is required`);
      return null;
    }
    const normalized = requireNonblankString(value, name).toLowerCase();
    if (!SHA256_HEX.test(normalized)) throw new TypeError(`${name} must be a SHA-256 digest`);
    return normalized;
  }

  function normalizeCheckpointStatus(value, name = "status") {
    const normalized = requireNonblankString(value, name).toLowerCase();
    if (!CHECKPOINT_STATUSES.has(normalized)) throw new TypeError(`${name} is invalid`);
    return normalized;
  }

  function normalizeCheckpointMutation(input, name = "set") {
    const output = exactObject(input, CHECKPOINT_MUTABLE_FIELDS, name);
    const normalized = { ...output };
    if (Object.hasOwn(output, "status")) normalized.status = normalizeCheckpointStatus(output.status, `${name}.status`);
    for (const field of CHECKPOINT_COUNT_FIELDS) {
      if (Object.hasOwn(output, field)) normalized[field] = requireVersion(output[field], `${name}.${field}`);
    }
    for (const field of CHECKPOINT_DATE_FIELDS) {
      if (Object.hasOwn(output, field)) {
        normalized[field] = output[field] == null ? null : requireDate(output[field], `${name}.${field}`);
      }
    }
    for (const field of CHECKPOINT_DIGEST_FIELDS) {
      if (field === "agentSetDigest" || !Object.hasOwn(output, field)) continue;
      normalized[field] = normalizeCheckpointDigest(output[field], `${name}.${field}`);
    }
    if (Object.hasOwn(output, "capReached") && typeof output.capReached !== "boolean") {
      throw new TypeError(`${name}.capReached must be a boolean`);
    }
    if (Object.hasOwn(output, "lastErrorCode")) {
      normalized.lastErrorCode = output.lastErrorCode == null
        ? null
        : requireNonblankString(output.lastErrorCode, `${name}.lastErrorCode`);
    }
    return normalized;
  }

  async function insertCheckpointOnce(input = {}, { session = null } = {}) {
    const source = exactObject(input, CHECKPOINT_INSERT_FIELDS, "checkpoint");
    const windowStartAt = requireDate(source.windowStartAt, "checkpoint.windowStartAt");
    const cutoffAt = requireDate(source.cutoffAt, "checkpoint.cutoffAt");
    if (cutoffAt.getTime() <= windowStartAt.getTime()) {
      throw new TypeError("checkpoint.cutoffAt must be after windowStartAt");
    }
    const maxContacts = requireVersion(source.maxContacts, "checkpoint.maxContacts");
    if (maxContacts < 1 || maxContacts > 5000) {
      throw new TypeError("checkpoint.maxContacts must be between 1 and 5000");
    }
    const mutable = Object.fromEntries(
      Object.entries(source).filter(([field]) => CHECKPOINT_MUTABLE_FIELDS.has(field)),
    );
    const normalized = {
      ...normalizeCheckpointMutation(mutable, "checkpoint"),
      _id: requireNonblankString(source.checkpointKey, "checkpoint.checkpointKey"),
      kind: "source_cutover",
      source: requireNonblankString(source.source, "checkpoint.source").toLowerCase(),
      windowStartAt,
      cutoffAt,
      preloadPredicate: "received_at_lt_cutoff",
      continuationPredicate: "received_at_gte_cutoff",
      sortContract: "received_at_desc_source_identity_asc_v1",
      preloadKey: requireNonblankString(source.preloadKey, "checkpoint.preloadKey"),
      maxContacts,
      agentSetDigest: normalizeCheckpointDigest(
        source.agentSetDigest,
        "checkpoint.agentSetDigest",
        { required: true },
      ),
      status: normalizeCheckpointStatus(source.status || "scheduled", "checkpoint.status"),
      version: 0,
    };
    try {
      return await createWithSession(LeadDeliveryCheckpoint, normalized, session);
    } catch (error) {
      if (isDuplicateKeyError(error) && duplicateIndexName(error) === "_id_") return null;
      throw error;
    }
  }

  async function getCheckpointByKey(checkpointKey, { session = null } = {}) {
    const query = applySession(LeadDeliveryCheckpoint.findOne({
      _id: requireNonblankString(checkpointKey, "checkpointKey"),
    }), session);
    return lean(query);
  }

  async function compareAndSetCheckpoint({
    checkpointKey,
    expectedVersion,
    expected = {},
    set = {},
    session = null,
  } = {}) {
    const expectedFields = normalizeCheckpointMutation(expected, "expected");
    const normalizedSet = normalizeCheckpointMutation(set, "set");
    return lean(LeadDeliveryCheckpoint.findOneAndUpdate(
      {
        _id: requireNonblankString(checkpointKey, "checkpointKey"),
        version: requireVersion(expectedVersion),
        ...expectedFields,
      },
      { $set: normalizedSet, $inc: { version: 1 } },
      { new: true, runValidators: true, session: session || undefined },
    ));
  }

  function normalizeSourceRepairMutation(input, name = "set") {
    const source = exactObject(input, SOURCE_REPAIR_MUTABLE_FIELDS, name);
    const output = { ...source };
    if (Object.hasOwn(source, "status")) {
      output.status = requireNonblankString(source.status, `${name}.status`).toLowerCase();
      if (!SOURCE_REPAIR_STATUSES.has(output.status)) {
        throw new TypeError(`${name}.status is invalid`);
      }
    }
    for (const field of ["repairCursorCreatedAt", "highWaterCreatedAt", "completedAt", "lastRunAt"]) {
      if (Object.hasOwn(source, field)) output[field] = source[field] == null ? null : requireDate(source[field], `${name}.${field}`);
    }
    for (const field of ["repairCursorId", "highWaterId", "lastErrorCode"]) {
      if (Object.hasOwn(source, field)) {
        output[field] = source[field] == null ? null : requireNonblankString(source[field], `${name}.${field}`);
      }
    }
    for (const field of ["scannedCount", "admittedCount", "skippedCount"]) {
      if (Object.hasOwn(source, field)) output[field] = requireVersion(source[field], `${name}.${field}`);
    }
    return output;
  }

  async function insertSourceRepairCheckpointOnce({
    checkpointKey,
    provider,
    source,
    businessDate,
  } = {}, { session = null } = {}) {
    const row = {
      _id: requireNonblankString(checkpointKey, "checkpointKey"),
      kind: "source_repair",
      provider: requireNonblankString(provider, "provider").toLowerCase(),
      source: requireNonblankString(source, "source").toLowerCase(),
      businessDate: requireBusinessDate(businessDate),
      status: "scheduled",
      version: 0,
    };
    try {
      return await createWithSession(LeadDeliveryCheckpoint, row, session);
    } catch (error) {
      if (isDuplicateKeyError(error) && duplicateIndexName(error) === "_id_") return null;
      throw error;
    }
  }

  async function getSourceRepairCheckpoint(checkpointKey, { session = null } = {}) {
    const query = applySession(LeadDeliveryCheckpoint.findOne({
      _id: requireNonblankString(checkpointKey, "checkpointKey"),
      kind: "source_repair",
    }), session);
    return lean(query);
  }

  async function compareAndSetSourceRepairCheckpoint({
    checkpointKey,
    expectedVersion,
    expected = {},
    set = {},
    increment = {},
    session = null,
  } = {}) {
    const expectedFields = normalizeSourceRepairMutation(expected, "expected");
    const normalizedSet = normalizeSourceRepairMutation(set, "set");
    const normalizedIncrement = exactObject(
      increment,
      new Set(["scannedCount", "admittedCount", "skippedCount"]),
      "increment",
    );
    for (const [field, value] of Object.entries(normalizedIncrement)) {
      normalizedIncrement[field] = requireVersion(value, `increment.${field}`);
    }
    const update = { $set: normalizedSet, $inc: { version: 1, ...normalizedIncrement } };
    return lean(LeadDeliveryCheckpoint.findOneAndUpdate(
      {
        _id: requireNonblankString(checkpointKey, "checkpointKey"),
        kind: "source_repair",
        version: requireVersion(expectedVersion),
        ...expectedFields,
      },
      update,
      { new: true, runValidators: true, session: session || undefined },
    ));
  }

  async function insertActiveItemOnce(input = {}, { session = null } = {}) {
    const normalized = {
      ...input,
      domain: requireString(input.domain, "domain").toUpperCase(),
      caseId: requireString(input.caseId, "caseId"),
      state: requireNonblankString(input.state, "state").toLowerCase(),
    };
    normalized.sourceIdentity = `${normalized.domain}:${normalized.caseId}`;
    if (typeof input.activeAttempt !== "boolean") {
      throw new TypeError("activeAttempt must be a boolean");
    }
    normalized.activeAttempt = input.activeAttempt;
    normalizeItemStatePair({ state: normalized.state, activeAttempt: normalized.activeAttempt }, "input");
    const ordinaryIdentityFields = [
      "leadCadenceId",
      "packetId",
      "providerContactId",
      "providerExternalLeadId",
      "providerCallId",
      "lastCountedProviderCallId",
      "lastCountedProviderAttemptKey",
    ];
    const agentIdentityFields = ["reservedAgentId", "speedOverrideAgentId", "deliveryAgentId"];
    for (const field of ordinaryIdentityFields) {
      if (Object.hasOwn(input, field)) normalized[field] = normalizeNullableIdentity(input[field], field);
    }
    for (const field of agentIdentityFields) {
      if (Object.hasOwn(input, field)) {
        normalized[field] = normalizeNullableIdentity(input[field], field, { lowercase: true });
      }
    }
    if (Object.hasOwn(input, "provider")) {
      normalized.provider = normalizeNullableIdentity(input.provider, "provider", { lowercase: true });
    }
    try {
      return await createWithSession(LeadDeliveryItem, normalized, session);
    } catch (error) {
      if (isDuplicateKeyError(error)
        && [ACTIVE_ATTEMPT_INDEX, SOURCE_IDENTITY_INDEX].includes(duplicateIndexName(error))) return null;
      throw error;
    }
  }

      async function getItemById(itemId, { session = null } = {}) {
    const query = applySession(LeadDeliveryItem.findOne({
      _id: requireString(itemId, "itemId"),
    }), session);
    return lean(query);
  }

  async function findItemBySourceIdentity({ domain, caseId } = {}, { session = null } = {}) {
    const normalizedDomain = requireString(domain, "domain").toUpperCase();
    const normalizedCaseId = requireString(caseId, "caseId");
    const query = applySession(LeadDeliveryItem.findOne({
      sourceIdentity: `${normalizedDomain}:${normalizedCaseId}`,
    }), session);
    return lean(query);
  }

  async function findItemsBySourceIdentities(rows = [], { session = null } = {}) {
    const identities = [...new Set((Array.isArray(rows) ? rows : []).map((row) => {
      const domain = requireString(row?.domain, "domain").toUpperCase();
      const caseId = requireString(row?.caseId, "caseId");
      return `${domain}:${caseId}`;
    }))];
    if (!identities.length) return [];
    let query = LeadDeliveryItem.find({ sourceIdentity: { $in: identities } });
    query = applySession(query, session);
    return lean(query);
  }

  async function readCaseProfilesForSources(sourceRows, { session = null } = {}) {
    const identities = new Map();
    for (const row of sourceRows) {
      const domain = String(row?.domain || "").trim().toUpperCase();
      let caseId;
      try {
        caseId = requireSourceCaseId(row?.caseId, "source caseId");
      } catch {
        continue;
      }
      if (!domain) continue;
      identities.set(sourceJoinKey(domain, caseId), { domain, caseId });
    }
    if (!identities.size) return new Map();
    const caseIdsByDomain = new Map();
    for (const { domain, caseId } of identities.values()) {
      if (!caseIdsByDomain.has(domain)) caseIdsByDomain.set(domain, []);
      caseIdsByDomain.get(domain).push(caseId);
    }
    const domainBranches = [...caseIdsByDomain.entries()].map(([domain, caseIds]) => ({
      domain,
      caseId: { $in: caseIds },
    }));
    let query = CaseProfile.find({ $or: domainBranches }).select(SOURCE_CASE_PROJECTION);
    query = applySession(query, session);
    const profiles = await lean(query);
    return new Map((profiles || []).map((profile) => [
      sourceJoinKey(profile.domain, profile.caseId),
      plain(profile),
    ]));
  }

  async function readActiveAppointmentsForSources(sourceRows, { session = null } = {}) {
    const identities = new Map();
    for (const row of sourceRows) {
      const domain = String(row?.domain || "").trim().toUpperCase();
      let caseId;
      try {
        caseId = requireSourceCaseId(row?.caseId, "source caseId");
      } catch {
        continue;
      }
      if (!domain) continue;
      identities.set(sourceJoinKey(domain, caseId), { domain, caseId });
    }
    if (!identities.size) return new Map();
    const caseIdsByDomain = new Map();
    for (const { domain, caseId } of identities.values()) {
      if (!caseIdsByDomain.has(domain)) caseIdsByDomain.set(domain, []);
      caseIdsByDomain.get(domain).push(caseId);
    }
    let query = CxAppointment.find({
      $or: [...caseIdsByDomain.entries()].map(([domain, caseIds]) => ({
        domain,
        caseId: { $in: caseIds },
      })),
      status: { $in: [...ACTIVE_APPOINTMENT_STATUSES] },
    })
      .select(SOURCE_APPOINTMENT_PROJECTION)
      .sort({ legalDialAt: 1, updatedAt: -1 });
    query = applySession(query, session);
    const appointments = await lean(query);
    const byIdentity = new Map();
    for (const appointment of appointments || []) {
      const key = sourceJoinKey(appointment.domain, appointment.caseId);
      if (!byIdentity.has(key)) byIdentity.set(key, plain(appointment));
    }
    return byIdentity;
  }

  async function joinProjectedSourceRows(sourceRows, { session = null } = {}) {
    // Keep reads sequential when a transaction session is injected; Mongo does
    // not support parallel operations on one session/transaction.
    const profilesByIdentity = CASE_PROFILE_SOURCE_JOIN_ENABLED
      ? await readCaseProfilesForSources(sourceRows, { session })
      : new Map();
    const appointmentsByIdentity = await readActiveAppointmentsForSources(sourceRows, { session });
    return sourceRows.map((row) => {
      const cadence = plain(row);
      const identity = sourceJoinKey(cadence.domain, cadence.caseId);
      return {
        ...cadence,
        caseProfile: profilesByIdentity.get(identity) || null,
        activeAppointment: appointmentsByIdentity.get(identity) || null,
      };
    });
  }

  async function readSourceBatch({
    cursor = null,
    limit = 250,
    domains,
    session = null,
  } = {}) {
    const normalizedDomains = normalizeSourceDomains(domains);
    const normalizedCursor = normalizeSourceCursor(cursor);
    const cap = requireVersion(limit, "limit");
    if (cap < 1 || cap > 1000) throw new TypeError("limit must be between 1 and 1000");
    // The delivery universe is active cadence only. Filtering after the read
    // makes a sparse historical collection look empty to callback refills
    // while the cursor spends minutes walking inactive rows.
    const filter = {
      domain: { $in: normalizedDomains },
      active: true,
    };
    if (normalizedCursor) {
      filter.$or = [
        { createdAt: { $lt: normalizedCursor.createdAt } },
        { createdAt: normalizedCursor.createdAt, _id: { $lt: normalizedCursor.id } },
      ];
    }
    let query = LeadCadence.find(filter)
      .select(SOURCE_LEAD_PROJECTION)
      .sort({ createdAt: -1, _id: -1 })
      .limit(cap + 1);
    query = applySession(query, session);
    const fetched = await lean(query);
    const hasMore = fetched.length > cap;
    const page = hasMore ? fetched.slice(0, cap) : fetched;
    const items = await joinProjectedSourceRows(page, { session });
    const first = page[0] || null;
    const last = page.at(-1) || null;
    return {
      items,
      highWater: first
        ? { createdAt: new Date(first.createdAt), id: String(first._id) }
        : null,
      nextCursor: hasMore && last
        ? { createdAt: new Date(last.createdAt), id: String(last._id) }
        : null,
      done: !hasMore,
    };
  }

  async function readSourceNewerBatch({
    after,
    limit = 250,
    domains,
    session = null,
  } = {}) {
    const normalizedDomains = normalizeSourceDomains(domains);
    const highWater = normalizeSourceCursor(after);
    if (!highWater) throw new TypeError("after is required");
    const cap = requireVersion(limit, "limit");
    if (cap < 1 || cap > 1000) throw new TypeError("limit must be between 1 and 1000");
    const filter = {
      domain: { $in: normalizedDomains },
      active: true,
      $or: [
        { createdAt: { $gt: highWater.createdAt } },
        { createdAt: highWater.createdAt, _id: { $gt: highWater.id } },
      ],
    };
    let query = LeadCadence.find(filter)
      .select(SOURCE_LEAD_PROJECTION)
      .sort({ createdAt: 1, _id: 1 })
      .limit(cap + 1);
    query = applySession(query, session);
    const fetched = await lean(query);
    const hasMore = fetched.length > cap;
    const page = hasMore ? fetched.slice(0, cap) : fetched;
    const items = await joinProjectedSourceRows(page, { session });
    const last = page.at(-1) || null;
    return {
      items,
      nextHighWater: last
        ? { createdAt: new Date(last.createdAt), id: String(last._id) }
        : highWater,
      done: !hasMore,
    };
  }

  async function readSourceWindowBatch({
    cursor = null,
    limit = 250,
    domains,
    receivedFrom,
    receivedBefore,
    session = null,
  } = {}) {
    const normalizedDomains = normalizeSourceDomains(domains);
    const normalizedCursor = normalizeSourceCursor(cursor);
    const cap = requireVersion(limit, "limit");
    if (cap < 1 || cap > 1000) throw new TypeError("limit must be between 1 and 1000");
    const clauses = [sourceReceiptWindowFilter(receivedFrom, receivedBefore)];
    if (normalizedCursor) {
      clauses.push({
        $or: [
          { createdAt: { $lt: normalizedCursor.createdAt } },
          { createdAt: normalizedCursor.createdAt, _id: { $lt: normalizedCursor.id } },
        ],
      });
    }
    const filter = {
      domain: { $in: normalizedDomains },
      active: true,
      $and: clauses,
    };
    let query = LeadCadence.find(filter)
      .select(SOURCE_LEAD_PROJECTION)
      .sort({ createdAt: -1, _id: -1 })
      .limit(cap + 1);
    query = applySession(query, session);
    const fetched = await lean(query);
    const hasMore = fetched.length > cap;
    const page = hasMore ? fetched.slice(0, cap) : fetched;
    const items = await joinProjectedSourceRows(page, { session });
    const last = page.at(-1) || null;
    return {
      items,
      nextCursor: hasMore && last
        ? { createdAt: new Date(last.createdAt), id: String(last._id) }
        : null,
      done: !hasMore,
    };
  }

  async function readSourceLead({ domain, caseId, session = null } = {}) {
    const normalizedDomain = requireNonblankString(domain, "domain").toUpperCase();
    const normalizedCaseId = requireSourceCaseId(caseId);
    let query = LeadCadence.findOne({ domain: normalizedDomain, caseId: normalizedCaseId })
      .select(SOURCE_LEAD_PROJECTION);
    query = applySession(query, session);
    const row = await lean(query);
    if (!row) return null;
    const joined = await joinProjectedSourceRows([row], { session });
    return joined[0] || null;
  }

  async function readLegacyDailyAttemptFloor({
    domain,
    caseId,
    dateKey,
    dayStart,
    dayEnd,
    session = null,
  } = {}) {
    const normalizedDomain = requireNonblankString(domain, "domain").toUpperCase();
    const normalizedCaseId = requireSourceCaseId(caseId);
    const normalizedDateKey = requireNonblankString(dateKey, "dateKey");
    const start = requireDate(dayStart, "dayStart");
    const end = requireDate(dayEnd, "dayEnd");
    if (end.getTime() <= start.getTime()) throw new TypeError("dayEnd must be after dayStart");

    let cadenceQuery = LeadCadence.findOne({ domain: normalizedDomain, caseId: normalizedCaseId })
      .select(LEGACY_CADENCE_COUNT_PROJECTION);
    let outboxQuery = CxTerminalOutbox.find({
      domain: normalizedDomain,
      caseId: normalizedCaseId,
      createdAt: { $gte: start, $lt: end },
    }).select(LEGACY_OUTBOX_COUNT_PROJECTION);
    let callLogQuery = CallLog.find({
      domain: normalizedDomain,
      caseId: normalizedCaseId,
      platform: "cx",
      direction: "outbound",
      callStartTime: { $gte: start, $lt: end },
    }).select(LEGACY_CALL_LOG_COUNT_PROJECTION);
    let mpiQuery = MasterProspectIndex.findOne({ domain: normalizedDomain, caseId: normalizedCaseId })
      .select(LEGACY_MPI_COUNT_PROJECTION);
    cadenceQuery = applySession(cadenceQuery, session);
    outboxQuery = applySession(outboxQuery, session);
    callLogQuery = applySession(callLogQuery, session);
    mpiQuery = applySession(mpiQuery, session);

    const [cadence, outboxRows, callLogRows, mpi] = await Promise.all([
      lean(cadenceQuery),
      lean(outboxQuery),
      lean(callLogQuery),
      lean(mpiQuery),
    ]);
    const terminalOccurrences = new Set((outboxRows || [])
      .map(terminalOutboxOccurrenceKey)
      .filter(Boolean));
    const callLogSessions = new Set((callLogRows || [])
      .map((row) => String(row.telephonySessionId || "").trim())
      .filter(Boolean));
    return {
      cadenceDailyCount: String(valueAtPath(cadence, "counterCadence.cxDailyDateKey") || "") === normalizedDateKey
        ? safeCount(valueAtPath(cadence, "counterCadence.cxDailyCalls"))
        : 0,
      terminalOutboxCallCount: terminalOccurrences.size,
      callLogSessionCount: callLogSessions.size,
      mpiFillerDailyAttempts: String(valueAtPath(mpi, "filler.dailyDateKey") || "") === normalizedDateKey
        ? safeCount(valueAtPath(mpi, "filler.dailyAttempts"))
        : 0,
    };
  }

  async function expireReservationCas({
    itemId,
    expectedVersion,
    expectedAgentId,
    expectedExpiresAt,
    now,
    set = {},
    unset = {},
    session = null,
  } = {}) {
    const expiry = requireDate(expectedExpiresAt, "expectedExpiresAt");
    const at = requireDate(now, "now");
    return compareAndSetItem({
      itemId,
      expectedVersion,
      expected: {
        state: "reserved",
        reservedAgentId: requireString(expectedAgentId, "expectedAgentId").toLowerCase(),
        reservationExpiresAt: { $eq: expiry, $lte: at },
      },
      set,
      unset,
      session,
    });
  }

  async function compareAndSetAgent({
    agentId,
    expectedVersion,
    expected = {},
    set = {},
    unset = {},
    increment = {},
    session = null,
  } = {}) {
    const mutation = buildCasMutation({ set, unset, increment }, AGENT_INCREMENTABLE_COUNTERS);
    const filter = addDecrementGuards({
      agentId: requireString(agentId, "agentId").toLowerCase(),
      version: requireVersion(expectedVersion),
      ...safeObject(expected, "expected"),
    }, mutation.decrementGuards);
    return lean(LeadDeliveryAgent.findOneAndUpdate(
      filter,
      mutation.update,
      { new: true, runValidators: true, session: session || undefined },
    ));
  }

                    async function acquireAgentPoolOperation({
    agentId,
    expectedVersion,
    operationId,
    operationKind,
    now,
    leaseMs = 60_000,
    session = null,
  } = {}) {
    const at = requireDate(now, "now");
    const duration = requireVersion(leaseMs, "leaseMs");
    if (duration < 1) throw new TypeError("leaseMs must be positive");
    return lean(LeadDeliveryAgent.findOneAndUpdate(
      {
        agentId: requireNonblankString(agentId, "agentId").toLowerCase(),
        version: requireVersion(expectedVersion),
        $or: [
          { poolOperationId: null },
          { poolOperationLeaseExpiresAt: { $lte: at } },
        ],
      },
      {
        $set: {
          poolOperationId: requireNonblankString(operationId, "operationId"),
          poolOperationKind: requirePoolOperationKind(operationKind),
          poolOperationLeaseExpiresAt: new Date(at.getTime() + duration),
          poolOperationStartedAt: at,
        },
        $inc: { version: 1 },
      },
      { new: true, runValidators: true, session: session || undefined },
    ));
  }

  async function renewAgentPoolOperation({
    agentId,
    expectedVersion,
    operationId,
    operationKind,
    now,
    leaseMs = 60_000,
    session = null,
  } = {}) {
    const at = requireDate(now, "now");
    const duration = requireVersion(leaseMs, "leaseMs");
    if (duration < 1) throw new TypeError("leaseMs must be positive");
    return compareAndSetAgent({
      agentId,
      expectedVersion,
      expected: {
        poolOperationId: requireNonblankString(operationId, "operationId"),
        poolOperationKind: requirePoolOperationKind(operationKind),
      },
      set: { poolOperationLeaseExpiresAt: new Date(at.getTime() + duration) },
      session,
    });
  }

  async function releaseAgentPoolOperation({
    agentId,
    expectedVersion,
    operationId,
    operationKind,
    session = null,
  } = {}) {
    return compareAndSetAgent({
      agentId,
      expectedVersion,
      expected: {
        poolOperationId: requireNonblankString(operationId, "operationId"),
        poolOperationKind: requirePoolOperationKind(operationKind),
      },
      set: {
        poolOperationId: null,
        poolOperationKind: null,
        poolOperationLeaseExpiresAt: null,
        poolOperationStartedAt: null,
      },
      session,
    });
  }

  async function getAgentById(agentId, { session = null } = {}) {
    const query = applySession(LeadDeliveryAgent.findOne({
      agentId: requireString(agentId, "agentId").toLowerCase(),
    }), session);
    return lean(query);
  }

  async function listAgents({ enabledOnly = false, session = null } = {}) {
    if (typeof enabledOnly !== "boolean") throw new TypeError("enabledOnly must be a boolean");
    const query = applySession(LeadDeliveryAgent.find(enabledOnly ? { enabled: true } : {}), session);
    return lean(query);
  }

  async function upsertAgentConfiguration(input = {}, { session = null } = {}) {
    const normalized = exactObject(input, AGENT_CONFIGURATION_INPUT_FIELDS, "input");
    const agentId = requireString(normalized.agentId, "agentId").toLowerCase();
    if (!Object.hasOwn(normalized, "displayName")) throw new TypeError("displayName is required");
    const displayName = normalized.displayName == null
      ? null
      : requireNonblankString(normalized.displayName, "displayName");
    if (typeof normalized.enabled !== "boolean") throw new TypeError("enabled must be a boolean");
    if (!Object.hasOwn(normalized, "configuration")) throw new TypeError("configuration is required");
    const configuration = normalizeAgentConfiguration(normalized.configuration);
    return lean(LeadDeliveryAgent.findOneAndUpdate(
      { agentId },
      {
        $set: {
          displayName,
          enabled: normalized.enabled,
          "metadata.configuration": configuration,
        },
        $setOnInsert: { agentId },
      },
      {
        new: true,
        upsert: true,
        runValidators: true,
        setDefaultsOnInsert: true,
        session: session || undefined,
      },
    ));
  }

  async function compareAndSetEvent({
    eventId,
    expectedVersion,
    expected = {},
    set = {},
    unset = {},
    increment = {},
    session = null,
  } = {}) {
    const mutation = buildCasMutation({ set, unset, increment }, EVENT_INCREMENTABLE_COUNTERS);
    const filter = addDecrementGuards({
      _id: requireString(eventId, "eventId"),
      version: requireVersion(expectedVersion),
      ...safeObject(expected, "expected"),
    }, mutation.decrementGuards);
    return lean(LeadDeliveryEvent.findOneAndUpdate(
      filter,
      mutation.update,
      { new: true, runValidators: true, session: session || undefined },
    ));
  }

  async function upgradeEventEvidenceCas({
    eventId,
    expectedVersion,
    expected = {},
    set = {},
    session = null,
  } = {}) {
    return compareAndSetEvent({
      eventId,
      expectedVersion,
      expected,
      set,
      session,
    });
  }

  async function acquireEventProcessingLease({
    eventId,
    expectedVersion,
    leaseId,
    now,
    leaseMs = 60_000,
    session = null,
  } = {}) {
    const at = requireDate(now, "now");
    const duration = requireVersion(leaseMs, "leaseMs");
    if (duration < 1) throw new TypeError("leaseMs must be a positive integer");
    const token = requireString(leaseId, "leaseId");
    return lean(LeadDeliveryEvent.findOneAndUpdate(
      {
        _id: requireString(eventId, "eventId"),
        version: requireVersion(expectedVersion),
        $or: [
          { status: "pending" },
          { status: "failed", nextAttemptAt: { $lte: at } },
          { status: "processing", processingLeaseExpiresAt: { $lte: at } },
        ],
      },
      {
        $set: {
          status: "processing",
          processingLeaseId: token,
          processingLeaseExpiresAt: new Date(at.getTime() + duration),
        },
        $inc: { attempts: 1, version: 1 },
      },
      { new: true, runValidators: true, session: session || undefined },
    ));
  }

  async function acquireRefillRequest({
    agentId,
    expectedVersion,
    refillRequestId,
    requestedAt,
    leaseMs = 60_000,
    session = null,
  } = {}) {
    const at = requireDate(requestedAt, "requestedAt");
    const duration = requireVersion(leaseMs, "leaseMs");
    if (duration < 1) throw new TypeError("leaseMs must be a positive integer");
    return lean(LeadDeliveryAgent.findOneAndUpdate(
      {
        agentId: requireString(agentId, "agentId").toLowerCase(),
        version: requireVersion(expectedVersion),
        $or: [
          { openRefillRequest: false, refillRequestId: null },
          { openRefillRequest: true, refillLeaseExpiresAt: { $lte: at } },
        ],
      },
      {
        $set: {
          openRefillRequest: true,
          refillRequestId: requireString(refillRequestId, "refillRequestId"),
          lastRefillRequestedAt: at,
          refillLeaseExpiresAt: new Date(at.getTime() + duration),
        },
        $inc: { version: 1 },
      },
      { new: true, runValidators: true, session: session || undefined },
    ));
  }

  async function releaseRefillRequest({
    agentId,
    expectedVersion,
    refillRequestId,
    set = {},
    session = null,
  } = {}) {
    return compareAndSetAgent({
      agentId,
      expectedVersion,
      expected: {
        openRefillRequest: true,
        refillRequestId: requireString(refillRequestId, "refillRequestId"),
      },
      set: {
        ...safeObject(set, "set"),
        openRefillRequest: false,
        refillRequestId: null,
        refillLeaseExpiresAt: null,
      },
      session,
    });
  }

  async function insertEventOnce(input = {}, { session = null } = {}) {
    const provider = requireString(input.provider, "provider").toLowerCase();
    const normalized = {
      ...input,
      provider,
      eventType: requireNonblankString(input.eventType, "eventType").toLowerCase(),
      payloadDigest: requireNonblankString(input.payloadDigest, "payloadDigest"),
      providerEventId: normalizeNullableIdentity(input.providerEventId, "providerEventId"),
      providerCallId: normalizeNullableIdentity(input.providerCallId, "providerCallId"),
      providerContactId: normalizeNullableIdentity(input.providerContactId, "providerContactId"),
      providerExternalLeadId: normalizeNullableIdentity(input.providerExternalLeadId, "providerExternalLeadId"),
    };
    const dedupeKey = buildEventDedupeKey(normalized);
    try {
      return await createWithSession(LeadDeliveryEvent, { ...normalized, dedupeKey }, session);
    } catch (error) {
      if (isDuplicateKeyError(error) && [EVENT_DEDUPE_INDEX, EVENT_PROVIDER_ID_INDEX].includes(duplicateIndexName(error))) return null;
      throw error;
    }
  }

  async function findEventByDedupeKey(input = {}, { session = null } = {}) {
    const provider = requireString(input.provider, "provider").toLowerCase();
    const dedupeKey = buildEventDedupeKey({ ...input, provider });
    let query = LeadDeliveryEvent.findOne({ provider, dedupeKey });
    if (session && typeof query.session === "function") query = query.session(session);
    return lean(query);
  }

  async function listAgentProjectionItems(agentId, { session = null } = {}) {
    let query = LeadDeliveryItem.find({ deliveryAgentId: requireString(agentId, "agentId").toLowerCase() })
      .select({
        _id: 1,
        state: 1,
        deliveryAgentId: 1,
        provider: 1,
        providerExternalLeadId: 1,
        providerContactId: 1,
        providerAcceptedAt: 1,
        providerCallId: 1,
        providerCompletedAt: 1,
        metadata: 1,
      });
    if (session && typeof query.session === "function") query = query.session(session);
    return lean(query);
  }

  async function countAgentCompletedAttempts(agentId, { session = null } = {}) {
    const id = requireString(agentId, "agentId").toLowerCase();
    let aggregate = LeadDeliveryItem.aggregate([
      {
        $match: {
          providerAttemptHistory: {
            $elemMatch: { event: "completed", deliveryAgentId: id },
          },
        },
      },
      { $unwind: "$providerAttemptHistory" },
      {
        $match: {
          "providerAttemptHistory.event": "completed",
          "providerAttemptHistory.deliveryAgentId": id,
        },
      },
      {
        $group: {
          _id: {
            itemId: "$_id",
            attemptNumber: "$providerAttemptHistory.attemptNumber",
          },
        },
      },
      { $count: "count" },
    ]);
    if (session && typeof aggregate.session === "function") aggregate = aggregate.session(session);
    const rows = await aggregate;
    return Number(rows?.[0]?.count || 0);
  }

  async function countAgentCompletedAttemptsSince(agentId, since, { until = new Date(), session = null } = {}) {
    const id = requireString(agentId, "agentId").toLowerCase();
    const from = requireDate(since, "since");
    const through = requireDate(until, "until");
    if (through.getTime() < from.getTime()) throw new RangeError("until must not precede since");
    let aggregate = LeadDeliveryItem.aggregate([
      { $unwind: "$providerAttemptHistory" },
      {
        $match: {
          "providerAttemptHistory.event": "completed",
          "providerAttemptHistory.deliveryAgentId": id,
          "providerAttemptHistory.occurredAt": { $gte: from, $lt: through },
        },
      },
      {
        $group: {
          _id: {
            itemId: "$_id",
            attemptNumber: "$providerAttemptHistory.attemptNumber",
          },
        },
      },
      { $count: "count" },
    ]);
    if (session && typeof aggregate.session === "function") aggregate = aggregate.session(session);
    const rows = await aggregate;
    return Number(rows?.[0]?.count || 0);
  }

  async function listAgentDeliveryItems(agentId, { session = null } = {}) {
    const query = applySession(LeadDeliveryItem.find({
      deliveryAgentId: requireString(agentId, "agentId").toLowerCase(),
      activeAttempt: true,
    }), session);
    return lean(query);
  }

  async function listAgentPendingProviderPosts(agentId, { session = null } = {}) {
    const query = applySession(LeadDeliveryItem.find({
      deliveryAgentId: requireString(agentId, "agentId").toLowerCase(),
      state: "packetized",
      $or: [
        { providerContactId: null },
        { providerContactId: "" },
        { providerContactId: { $exists: false } },
      ],
    }), session);
    return lean(query);
  }

  async function listItemsByPacketId(packetId, { session = null } = {}) {
    let query = LeadDeliveryItem.find({
      packetId: requireNonblankString(packetId, "packetId"),
    });
    if (typeof query.sort === "function") query = query.sort({ receivedAt: -1, _id: 1 });
    query = applySession(query, session);
    return lean(query);
  }

  async function summarizePacketAssignments(packetId, { session = null } = {}) {
    const id = requireNonblankString(packetId, "packetId");
    let aggregate = LeadDeliveryItem.aggregate([
      { $match: { packetId: id } },
      {
        $group: {
          _id: "$deliveryAgentId",
          total: { $sum: 1 },
          accepted: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $ne: ["$state", "delivery_failed"] },
                    { $ne: [{ $ifNull: ["$providerAcceptedAt", null] }, null] },
                    { $eq: [{ $type: "$providerContactId" }, "string"] },
                    { $ne: ["$providerContactId", ""] },
                    { $eq: [{ $type: "$providerExternalLeadId" }, "string"] },
                    { $ne: ["$providerExternalLeadId", ""] },
                  ],
                },
                1,
                0,
              ],
            },
          },
          failed: { $sum: { $cond: [{ $eq: ["$state", "delivery_failed"] }, 1, 0] } },
        },
      },
    ]);
    if (session && typeof aggregate.session === "function") aggregate = aggregate.session(session);
    const rows = await aggregate;
    const countsByAgent = {};
    let total = 0;
    let accepted = 0;
    let pending = 0;
    let failed = 0;
    for (const row of Array.isArray(rows) ? rows : []) {
      const agentId = String(row?._id || "").trim().toLowerCase();
      const count = Number(row?.total || 0);
      countsByAgent[agentId] = (countsByAgent[agentId] || 0) + count;
      total += count;
      accepted += Number(row?.accepted || 0);
      failed += Number(row?.failed || 0);
    }
    pending = Math.max(0, total - accepted - failed);
    return { total, accepted, pending, failed, countsByAgent };
  }

  async function listPacketCandidateItems({
    agentId,
    sourcePools,
    untouchedOnly = false,
    now = null,
    limit = 500,
    session = null,
  } = {}) {
    if (typeof untouchedOnly !== "boolean") throw new TypeError("untouchedOnly must be a boolean");
    const normalizedAgentId = requireString(agentId, "agentId").toLowerCase();
    if (!Array.isArray(sourcePools) || sourcePools.length === 0) {
      throw new TypeError("sourcePools must be a non-empty array");
    }
    const normalizedPools = [...new Set(sourcePools.map((pool, index) => (
      requireNonblankString(pool, `sourcePools[${index}]`).toLowerCase()
    )))];
    const at = now == null ? null : requireDate(now, "now");
    if (normalizedPools.includes("follow_up_due") && !at) {
      throw new TypeError("now is required when reading follow_up_due candidates");
    }
    const cap = requireVersion(limit, "limit");
    if (cap < 1 || cap > 5000) throw new TypeError("limit must be between 1 and 5000");
    const poolPredicates = normalizedPools.map((pool) => (
      pool === "follow_up_due"
        ? { sourcePool: pool, nextContactAt: { $lte: at } }
        : { sourcePool: pool }
    ));
    let query = LeadDeliveryItem.find({
      activeAttempt: true,
      providerContactId: null,
      state: { $in: PACKET_CANDIDATE_STATES },
      ...(untouchedOnly ? {
        totalAttemptCount: 0,
        lastContactAt: null,
      } : {}),
      $and: [
        { $or: poolPredicates },
        { $or: [
          { reservedAgentId: null },
          { reservedAgentId: normalizedAgentId },
        ] },
      ],
    });
    if (typeof query.sort === "function") {
      const pool = normalizedPools.length === 1 ? normalizedPools[0] : null;
      const sort = pool === "new_today"
        ? { receivedAt: -1, _id: 1 }
        : pool === "overnight"
          ? { overnightOrder: 1, _id: 1 }
          : pool === "follow_up_due"
            ? { nextContactAt: 1, lastContactAt: 1, _id: 1 }
            : pool === "older_available"
              ? { lastContactAt: 1, receivedAt: 1, _id: 1 }
              : { _id: 1 };
      query = query.sort(sort);
    }
    if (typeof query.limit === "function") query = query.limit(cap);
    query = applySession(query, session);
    return lean(query);
  }

  async function listImmediateFreshItems({ limit = 5000, session = null } = {}) {
    const cap = requireVersion(limit, "limit");
    if (cap < 1 || cap > 5000) throw new TypeError("limit must be between 1 and 5000");
    let query = LeadDeliveryItem.find({
      activeAttempt: true,
      sourcePool: "new_today",
      providerContactId: null,
      state: { $in: ["eligible", "reserved"] },
    });
    if (typeof query.sort === "function") query = query.sort({ receivedAt: -1, _id: 1 });
    if (typeof query.limit === "function") query = query.limit(cap);
    query = applySession(query, session);
    return lean(query);
  }

  async function hasUnconsumedOvernightFirstContact({ session = null } = {}) {
    let query = LeadDeliveryItem.findOne({
      activeAttempt: true,
      sourcePool: "overnight",
      totalAttemptCount: 0,
      lastContactAt: null,
    });
    if (typeof query.select === "function") query = query.select({ _id: 1 });
    query = applySession(query, session);
    return Boolean(await lean(query));
  }

  async function listProviderIdentityCandidates(input = {}, { session = null, limit = 10 } = {}) {
    const provider = requireString(input.provider, "provider").toLowerCase();
    const identityFields = ["providerExternalLeadId", "providerContactId", "providerCallId"];
    let identities = identityFields
      .map((field) => [field, normalizeNullableIdentity(input[field], field)])
      .filter(([, value]) => Boolean(value));
    // PhoneBurner can reuse its callback call ID across a dial session. When
    // both physical-contact identities are present, do not let that broad
    // session ID crowd the exact candidate out of the bounded query.
    if (identities.some(([field]) => field === "providerExternalLeadId")
      && identities.some(([field]) => field === "providerContactId")) {
      identities = identities.filter(([field]) => field !== "providerCallId");
    }
    if (!identities.length) throw new TypeError("at least one provider identity is required");
    const cap = requireVersion(limit, "limit");
    if (cap < 1 || cap > 100) throw new TypeError("limit must be between 1 and 100");
    let query = LeadDeliveryItem.find({
      $and: [
        {
          $or: [
            { provider },
            { "providerAttemptHistory.provider": provider },
          ],
        },
        {
          $or: identities.flatMap(([field, value]) => [
            { [field]: value },
            { [`providerAttemptHistory.${field}`]: value },
          ]),
        },
      ],
    }).select({
      _id: 1,
      provider: 1,
      providerExternalLeadId: 1,
      providerContactId: 1,
      providerCallId: 1,
      providerAttemptHistory: 1,
      deliveryAgentId: 1,
      state: 1,
      activeAttempt: 1,
      version: 1,
    });
    if (typeof query.limit === "function") query = query.limit(cap);
    if (session && typeof query.session === "function") query = query.session(session);
    return lean(query);
  }

  async function listEventsForDrain({
    provider,
    limit = 50,
    now = new Date(),
    session = null,
  } = {}) {
    const providerName = requireNonblankString(provider, "provider").toLowerCase();
    const cap = requireVersion(limit, "limit");
    if (cap < 1 || cap > 500) throw new TypeError("limit must be between 1 and 500");
    const at = requireDate(now, "now");
    const readHead = async (filter, sort) => {
      let query = LeadDeliveryEvent.find({ provider: providerName, ...filter });
      if (typeof query.sort === "function") query = query.sort(sort);
      if (typeof query.limit === "function") query = query.limit(cap);
      query = applySession(query, session);
      return lean(query);
    };
    const reads = [
      () => readHead({ status: "pending" }, { receivedAt: 1, _id: 1 }),
      () => readHead(
        { status: "failed", nextAttemptAt: { $lte: at } },
        { nextAttemptAt: 1, receivedAt: 1, _id: 1 },
      ),
      () => readHead(
        { status: "processing", processingLeaseExpiresAt: { $lte: at } },
        { processingLeaseExpiresAt: 1, receivedAt: 1, _id: 1 },
      ),
    ];
    // MongoDB does not permit parallel operations on one transaction
    // session. Normal drain reads stay concurrent; transaction callers keep
    // the repository contract by executing the same bounded heads in order.
    const [pending, failed, processing] = session
      ? [await reads[0](), await reads[1](), await reads[2]()]
      : await Promise.all(reads.map((read) => read()));
    return [...pending, ...failed, ...processing]
      .sort((left, right) => {
        const leftAt = requireDate(left.receivedAt, "event.receivedAt").getTime();
        const rightAt = requireDate(right.receivedAt, "event.receivedAt").getTime();
        if (leftAt !== rightAt) return leftAt - rightAt;
        return String(left._id).localeCompare(String(right._id));
      })
      .slice(0, cap);
  }

  async function withTransaction(work) {
    if (typeof work !== "function") throw new TypeError("work must be a function");
    const session = await beginSession();
    let result;
    try {
      await session.withTransaction(async () => {
        result = await work(session);
      });
      return result;
    } finally {
      await session.endSession();
    }
  }

  return {
    acquireAgentPoolOperation,
    acquireEventProcessingLease,
    acquireRefillRequest,
    compareAndSetAgent,
    compareAndSetCheckpoint,
    compareAndSetSourceRepairCheckpoint,
    compareAndSetEvent,
    compareAndSetFairPickCursor,
    compareAndSetItem,
    countAgentCompletedAttempts,
    countAgentCompletedAttemptsSince,
    expireReservationCas,
    findItemsBySourceIdentities,
    findItemBySourceIdentity,
    findEventByDedupeKey,
    getAgentById,
    getCheckpointByKey,
    getSourceRepairCheckpoint,
    getOrCreateFairPickCursor,
    getItemById,
    hasUnconsumedOvernightFirstContact,
    insertActiveItemOnce,
    insertCheckpointOnce,
    insertSourceRepairCheckpointOnce,
    insertEventOnce,
    listAgentDeliveryItems,
    listAgentPendingProviderPosts,
    listItemsByPacketId,
    summarizePacketAssignments,
    listAgentProjectionItems,
    listAgents,
    listEventsForDrain,
    listImmediateFreshItems,
    listPacketCandidateItems,
    listProviderIdentityCandidates,
    readLegacyDailyAttemptFloor,
    readSourceBatch,
    readSourceNewerBatch,
    readSourceWindowBatch,
    readSourceLead,
    releaseRefillRequest,
    releaseAgentPoolOperation,
    renewAgentPoolOperation,
    upsertAgentConfiguration,
    upgradeEventEvidenceCas,
    withTransaction,
  };
}

module.exports = {
  ACTIVE_ATTEMPT_INDEX,
  SOURCE_IDENTITY_INDEX,
  EVENT_DEDUPE_INDEX,
  EVENT_PROVIDER_ID_INDEX,
  createLeadDeliveryRepository,
  ...createLeadDeliveryRepository(),
};
