"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  POOLS,
  buildCapturedEventUpgrade,
  createLeadDeliveryRuntime,
  isPacificDeliveryWindowOpen,
  planProductivityPoolCull,
  resolveLeadDeliveryContactPolicy,
} = require("../../packages/shared-services/src/leadDeliveryService");

const START = new Date("2026-07-10T17:00:00.000Z");

function copy(value) {
  return value == null ? value : structuredClone(value);
}

function same(left, right) {
  if (left instanceof Date || right instanceof Date) {
    return new Date(left).getTime() === new Date(right).getTime();
  }
  return left === right;
}

function matches(document, expected = {}) {
  return Object.entries(expected).every(([field, wanted]) => {
    const actual = document[field];
    if (wanted && typeof wanted === "object" && !(wanted instanceof Date) && !Array.isArray(wanted)) {
      if (Object.hasOwn(wanted, "$ne") && same(actual, wanted.$ne)) return false;
      if (Object.hasOwn(wanted, "$eq") && !same(actual, wanted.$eq)) return false;
      if (Object.hasOwn(wanted, "$lte") && new Date(actual).getTime() > new Date(wanted.$lte).getTime()) return false;
      return true;
    }
    return same(actual, wanted);
  });
}

function mutate(document, { set = {}, unset = {}, increment = {}, append = {} } = {}) {
  Object.assign(document, copy(set));
  for (const field of Object.keys(unset)) delete document[field];
  for (const [field, delta] of Object.entries(increment)) document[field] = Number(document[field] || 0) + delta;
  for (const [field, values] of Object.entries(append)) document[field].push(...copy(values));
  document.version += 1;
  return copy(document);
}

class FakeRepository {
  constructor() {
    this.items = new Map();
    this.agents = new Map();
    this.checkpoints = new Map();
    this.events = new Map();
    this.fairPickCursors = new Map();
  }

  async getOrCreateFairPickCursor(workType, { agentOrder } = {}) {
    const key = String(workType).toLowerCase();
    const current = this.fairPickCursors.get(key) || {
      _id: key,
      lastPickedAgentId: null,
      version: 0,
    };
    current.agentOrder = [...agentOrder];
    this.fairPickCursors.set(key, current);
    return copy(current);
  }

  async compareAndSetFairPickCursor({
    workType,
    expectedVersion,
    expectedLastPickedAgentId = null,
    lastPickedAgentId,
  }) {
    const key = String(workType).toLowerCase();
    const current = this.fairPickCursors.get(key);
    if (!current
      || current.version !== expectedVersion
      || current.lastPickedAgentId !== expectedLastPickedAgentId) return null;
    current.lastPickedAgentId = lastPickedAgentId;
    current.version += 1;
    return copy(current);
  }

  async upsertAgentConfiguration({ agentId, displayName, enabled, configuration }) {
    const current = this.agents.get(agentId) || {
      agentId,
      version: 0,
      shiftEnabled: false,
      activeUntil: null,
      providerAcceptedCount: 0,
      providerCompletedCount: 0,
      estimatedOutstanding: 0,
      openRefillRequest: false,
      refillRequestId: null,
      pendingFreshCount: 0,
      poolOperationId: null,
      poolOperationKind: null,
      poolOperationLeaseExpiresAt: null,
      poolOperationStartedAt: null,
      metadata: {},
    };
    current.displayName = displayName;
    current.enabled = enabled;
    current.metadata.configuration = copy(configuration);
    this.agents.set(agentId, current);
    return copy(current);
  }

  async getAgentById(agentId) {
    return copy(this.agents.get(String(agentId).toLowerCase()) || null);
  }

  async listAgents({ enabledOnly = false } = {}) {
    return [...this.agents.values()].filter((agent) => !enabledOnly || agent.enabled).map(copy);
  }

                        async insertActiveItemOnce(input) {
    const identity = `${input.domain}:${input.caseId}`;
    if ([...this.items.values()].some((item) => item.sourceIdentity === identity)) return null;
    const item = {
      _id: `item-${input.caseId}`,
      sourceIdentity: identity,
      providerAttemptSequence: 0,
      providerAttemptHistory: [],
      providerPostState: null,
      providerPostLeaseId: null,
      providerPostLeaseExpiresAt: null,
      providerPostAttemptCount: 0,
      providerContactId: null,
      providerExternalLeadId: null,
      providerCallId: null,
      lastCountedProviderCallId: null,
      lastCountedProviderAttemptKey: null,
      providerAcceptedAt: null,
      providerCompletedAt: null,
      reservedAgentId: null,
      speedOverrideAgentId: null,
      deliveryAgentId: null,
      packetId: null,
      ...copy(input),
    };
    this.items.set(item._id, item);
    return copy(item);
  }

  async getItemById(itemId) {
    return copy(this.items.get(String(itemId)) || null);
  }

  async findItemBySourceIdentity({ domain, caseId }) {
    const identity = `${String(domain).toUpperCase()}:${String(caseId)}`;
    return copy([...this.items.values()].find((item) => item.sourceIdentity === identity) || null);
  }

  async findItemsBySourceIdentities(rows = []) {
    const wanted = new Set(rows.map((row) => `${String(row.domain).toUpperCase()}:${String(row.caseId)}`));
    return [...this.items.values()]
      .filter((item) => wanted.has(item.sourceIdentity))
      .map(copy);
  }

  async listAgentDeliveryItems(agentId) {
    return [...this.items.values()]
      .filter((item) => item.activeAttempt && item.deliveryAgentId === agentId)
      .map(copy);
  }

  async countAgentCompletedAttempts(agentId) {
    let count = 0;
    for (const item of this.items.values()) {
      const attempts = new Set((item.providerAttemptHistory || [])
        .filter((entry) => entry.event === "completed" && entry.deliveryAgentId === agentId)
        .map((entry) => Number(entry.attemptNumber || 0))
        .filter((attemptNumber) => attemptNumber > 0));
      count += attempts.size;
    }
    return count;
  }

  async countAgentCompletedAttemptsSince(agentId, since, { until = new Date() } = {}) {
    const fromMs = new Date(since).getTime();
    const untilMs = new Date(until).getTime();
    let count = 0;
    for (const item of this.items.values()) {
      const attempts = new Set((item.providerAttemptHistory || [])
        .filter((entry) => entry.event === "completed"
          && entry.deliveryAgentId === agentId
          && new Date(entry.occurredAt).getTime() >= fromMs
          && new Date(entry.occurredAt).getTime() < untilMs)
        .map((entry) => `${item._id}:${Number(entry.attemptNumber || 0)}`));
      count += attempts.size;
    }
    return count;
  }

  async listItemsByPacketId(packetId) {
    return [...this.items.values()]
      .filter((item) => item.packetId === packetId)
      .sort((left, right) => new Date(right.receivedAt).getTime() - new Date(left.receivedAt).getTime())
      .map(copy);
  }

  async summarizePacketAssignments(packetId) {
    const rows = [...this.items.values()].filter((item) => item.packetId === packetId);
    const countsByAgent = {};
    let accepted = 0;
    let pending = 0;
    let failed = 0;
    for (const item of rows) {
      const agentId = String(item.deliveryAgentId || "").toLowerCase();
      countsByAgent[agentId] = (countsByAgent[agentId] || 0) + 1;
      if (item.state !== "delivery_failed"
        && item.providerAcceptedAt
        && item.providerContactId
        && item.providerExternalLeadId) accepted += 1;
      if (item.state === "delivery_failed") failed += 1;
    }
    pending = Math.max(0, rows.length - accepted - failed);
    return { total: rows.length, accepted, pending, failed, countsByAgent };
  }

  async insertCheckpointOnce(input) {
    const key = String(input.checkpointKey);
    if (this.checkpoints.has(key)) return null;
    const checkpoint = {
      _id: key,
      ...copy(input),
      version: 0,
      scannedCount: Number(input.scannedCount || 0),
      eligibleCount: Number(input.eligibleCount || 0),
      admittedCount: Number(input.admittedCount || 0),
      acceptedCount: Number(input.acceptedCount || 0),
      pendingCount: Number(input.pendingCount || 0),
      failedCount: Number(input.failedCount || 0),
      conflictCount: Number(input.conflictCount || 0),
      capReached: input.capReached === true,
      admittedDigest: input.admittedDigest || null,
      acceptedDigest: input.acceptedDigest || null,
      completedAt: input.completedAt || null,
      lastErrorCode: input.lastErrorCode || null,
    };
    delete checkpoint.checkpointKey;
    this.checkpoints.set(key, checkpoint);
    return copy(checkpoint);
  }

  async getCheckpointByKey(checkpointKey) {
    return copy(this.checkpoints.get(String(checkpointKey)) || null);
  }

  async compareAndSetCheckpoint({ checkpointKey, expectedVersion, expected, set }) {
    const checkpoint = this.checkpoints.get(String(checkpointKey));
    if (!checkpoint || checkpoint.version !== expectedVersion || !matches(checkpoint, expected)) return null;
    return mutate(checkpoint, { set });
  }

  async insertSourceRepairCheckpointOnce({ checkpointKey, provider, source, businessDate }) {
    const key = String(checkpointKey);
    if (this.checkpoints.has(key)) return null;
    const state = {
      _id: key,
      kind: "source_repair",
      provider,
      source,
      businessDate,
      status: "scheduled",
      repairCursorCreatedAt: null,
      repairCursorId: null,
      highWaterCreatedAt: null,
      highWaterId: null,
      scannedCount: 0,
      admittedCount: 0,
      skippedCount: 0,
      completedAt: null,
      lastRunAt: null,
      lastErrorCode: null,
      version: 0,
    };
    this.checkpoints.set(key, state);
    return copy(state);
  }

  async getSourceRepairCheckpoint(checkpointKey) {
    const row = this.checkpoints.get(String(checkpointKey));
    return row?.kind === "source_repair" ? copy(row) : null;
  }

  async compareAndSetSourceRepairCheckpoint({ checkpointKey, expectedVersion, expected, set, increment }) {
    const state = this.checkpoints.get(String(checkpointKey));
    if (!state || state.version !== expectedVersion || !matches(state, expected)) return null;
    return mutate(state, { set, increment });
  }

  async listAgentProjectionItems(agentId) {
    return [...this.items.values()]
      .filter((item) => item.deliveryAgentId === agentId)
      .map(copy);
  }

  async listPacketCandidateItems({ agentId, sourcePools, untouchedOnly = false, now, limit }) {
    const at = now == null ? null : new Date(now);
    return [...this.items.values()]
      .filter((item) => item.activeAttempt
        && item.providerContactId == null
        && sourcePools.includes(item.sourcePool)
        && (untouchedOnly !== true || (
          Number(item.totalAttemptCount || 0) === 0
          && item.lastContactAt == null
        ))
        && (item.sourcePool !== POOLS.FOLLOW_UP_DUE
          || (at && item.nextContactAt && new Date(item.nextContactAt).getTime() <= at.getTime()))
        && ["eligible", "follow_up_wait", "reserved"].includes(item.state)
        && (item.reservedAgentId == null || item.reservedAgentId === agentId))
      .slice(0, limit)
      .map(copy);
  }

  async listImmediateFreshItems({ limit }) {
    return [...this.items.values()]
      .filter((item) => item.activeAttempt
        && item.providerContactId == null
        && item.sourcePool === POOLS.NEW_TODAY
        && ["eligible", "reserved"].includes(item.state))
      .sort((left, right) => (
        new Date(right.receivedAt).getTime() - new Date(left.receivedAt).getTime()
        || String(left._id).localeCompare(String(right._id))
      ))
      .slice(0, limit)
      .map(copy);
  }

  async hasUnconsumedOvernightFirstContact() {
    return [...this.items.values()].some((item) => (
      item.activeAttempt === true
      && item.sourcePool === "overnight"
      && Number(item.totalAttemptCount || 0) === 0
      && item.lastContactAt == null
    ));
  }

  async compareAndSetItem({ itemId, expectedVersion, expected, set, unset, increment, append }) {
    const item = this.items.get(String(itemId));
    if (!item || item.version !== expectedVersion || !matches(item, expected)) return null;
    return mutate(item, { set, unset, increment, append });
  }

  async compareAndSetAgent({ agentId, expectedVersion, expected, set, unset, increment }) {
    const agent = this.agents.get(String(agentId).toLowerCase());
    if (!agent || agent.version !== expectedVersion || !matches(agent, expected)) return null;
    return mutate(agent, { set, unset, increment });
  }

  async acquireAgentPoolOperation({
    agentId,
    expectedVersion,
    operationId,
    operationKind,
    now,
    leaseMs,
  }) {
    const agent = this.agents.get(String(agentId).toLowerCase());
    if (!agent || agent.version !== expectedVersion) return null;
    const expiresAt = agent.poolOperationLeaseExpiresAt == null
      ? null
      : new Date(agent.poolOperationLeaseExpiresAt);
    if (agent.poolOperationId && expiresAt && expiresAt.getTime() > new Date(now).getTime()) return null;
    return mutate(agent, { set: {
      poolOperationId: operationId,
      poolOperationKind: operationKind,
      poolOperationLeaseExpiresAt: new Date(new Date(now).getTime() + leaseMs),
      poolOperationStartedAt: new Date(now),
    } });
  }

  async renewAgentPoolOperation({
    agentId,
    expectedVersion,
    operationId,
    operationKind,
    now,
    leaseMs,
  }) {
    return this.compareAndSetAgent({
      agentId,
      expectedVersion,
      expected: { poolOperationId: operationId, poolOperationKind: operationKind },
      set: { poolOperationLeaseExpiresAt: new Date(new Date(now).getTime() + leaseMs) },
    });
  }

  async releaseAgentPoolOperation({ agentId, expectedVersion, operationId, operationKind }) {
    return this.compareAndSetAgent({
      agentId,
      expectedVersion,
      expected: { poolOperationId: operationId, poolOperationKind: operationKind },
      set: {
        poolOperationId: null,
        poolOperationKind: null,
        poolOperationLeaseExpiresAt: null,
        poolOperationStartedAt: null,
      },
    });
  }

  addEvent(input) {
    const event = {
      _id: input._id || `event-${this.events.size + 1}`,
      provider: "phoneburner",
      eventType: "call_done",
      receivedAt: START,
      status: "pending",
      attempts: 0,
      nextAttemptAt: null,
      localAppliedAt: null,
      downstreamAppliedAt: null,
      processedAt: null,
      processingLeaseId: null,
      processingLeaseExpiresAt: null,
      resolvedItemId: null,
      resolvedAttemptNumber: 0,
      safePayload: {},
      version: 0,
      ...copy(input),
    };
    this.events.set(event._id, event);
    return copy(event);
  }

  async listEventsForDrain({ limit, now }) {
    return [...this.events.values()]
      .filter((event) => event.status === "pending"
        || (event.status === "failed" && new Date(event.nextAttemptAt).getTime() <= now.getTime())
        || (event.status === "processing" && new Date(event.processingLeaseExpiresAt).getTime() <= now.getTime()))
      .slice(0, limit)
      .map(copy);
  }

  async acquireEventProcessingLease({ eventId, expectedVersion, leaseId, now, leaseMs }) {
    const event = this.events.get(String(eventId));
    if (!event || event.version !== expectedVersion) return null;
    const claimable = event.status === "pending"
      || (event.status === "failed" && new Date(event.nextAttemptAt).getTime() <= now.getTime())
      || (event.status === "processing" && new Date(event.processingLeaseExpiresAt).getTime() <= now.getTime());
    if (!claimable) return null;
    return mutate(event, {
      set: {
        status: "processing",
        processingLeaseId: leaseId,
        processingLeaseExpiresAt: new Date(now.getTime() + leaseMs),
      },
      increment: { attempts: 1 },
    });
  }

  async compareAndSetEvent({ eventId, expectedVersion, expected, set, unset, increment }) {
    const event = this.events.get(String(eventId));
    if (!event || event.version !== expectedVersion || !matches(event, expected)) return null;
    return mutate(event, { set, unset, increment });
  }

  async listProviderIdentityCandidates(event) {
    const fields = ["providerExternalLeadId", "providerContactId", "providerCallId"];
    return [...this.items.values()].filter((item) => fields.some((field) => {
      const wanted = String(event[field] || "");
      return wanted && (String(item[field] || "") === wanted
        || item.providerAttemptHistory.some((entry) => String(entry[field] || "") === wanted));
    })).map(copy);
  }

  async acquireRefillRequest({ agentId, expectedVersion, refillRequestId, requestedAt, leaseMs }) {
    const agent = this.agents.get(agentId);
    const liveRequest = agent?.openRefillRequest === true
      && new Date(agent.refillLeaseExpiresAt).getTime() > requestedAt.getTime();
    if (!agent || agent.version !== expectedVersion || liveRequest) return null;
    return mutate(agent, {
      set: {
        openRefillRequest: true,
        refillRequestId,
        lastRefillRequestedAt: requestedAt,
        refillLeaseExpiresAt: new Date(requestedAt.getTime() + leaseMs),
      },
    });
  }

  async releaseRefillRequest({ agentId, expectedVersion, refillRequestId, set }) {
    const agent = this.agents.get(agentId);
    if (!agent || agent.version !== expectedVersion || agent.refillRequestId !== refillRequestId) return null;
    return mutate(agent, { set: { ...set, openRefillRequest: false, refillRequestId: null, refillLeaseExpiresAt: null } });
  }
}

function sourceRow(number, extra = {}) {
  return {
    domain: "TAG",
    caseId: String(number),
    leadCadenceId: `cadence-${number}`,
    normalizedPhone: `310555${String(number).padStart(4, "0")}`,
    displayName: `Test ${number}`,
    receivedAt: new Date("2026-07-09T17:00:00.000Z"),
    state: "eligible",
    activeAttempt: true,
    dailyAttemptDateKey: "2026-07-10",
    dailyAttemptCount: 0,
    totalAttemptCount: 0,
    callable: true,
    sourceActive: true,
    eligibility: { ok: true },
    ...extra,
  };
}

function config({ target = 5, refill = 1 } = {}) {
  const policy = {
    enabled: true,
    displayName: "Bruce Allen",
    provider: "phoneburner",
    phoneBurnerMemberId: "",
    phoneBurnerUsername: "",
    distributionFolderId: "pool-bruce",
    receivingFolderId: "consumer-bruce",
    leadStreamId: "",
    subscribedPools: [POOLS.NEW_TODAY, POOLS.OVERNIGHT, POOLS.OLDER_AVAILABLE, POOLS.FOLLOW_UP_DUE],
    packetAllowances: {
      [POOLS.NEW_TODAY]: 2,
      [POOLS.OVERNIGHT]: 1,
      [POOLS.OLDER_AVAILABLE]: 1,
      [POOLS.FOLLOW_UP_DUE]: 1,
    },
  };
  return {
    defaults: {
      providerBufferTarget: target,
      refillAtOrBelow: refill,
      freshReservationRange: Math.min(3, target),
      freshReservationMinutes: 15,
      activeEvidenceMinutes: 10,
      maxPendingFreshReservations: 1,
    },
    agents: {
      bruce_allen: policy,
      phil_olson: { ...copy(policy), enabled: false, displayName: "Phil Olson", distributionFolderId: "pool-phil", receivingFolderId: "consumer-phil" },
    },
  };
}

function fiveAgentConfig() {
  const base = config();
  const template = copy(base.agents.bruce_allen);
  const agentIds = ["bruce_allen", "phil_olson", "sean_lucas", "brad_hansen", "chris_bolt"];
  base.agents = Object.fromEntries(agentIds.map((agentId, index) => [agentId, {
    ...copy(template),
    enabled: true,
    displayName: `Agent ${index + 1}`,
    distributionFolderId: `pool-${index + 1}`,
    receivingFolderId: `consumer-${index + 1}`,
  }]));
  return base;
}

function harness({
  rows = [],
  actionsEnabled = false,
  refillEnabled = false,
  target = 5,
  refill = 1,
  handlers = {},
  scheduler = null,
  sourceReadOne = null,
  configuration = null,
  providerPostMinimumIntervalMs = 1,
  providerPostSleep = async () => {},
  providerPostClock = () => Date.now(),
  acquireProviderPostSlot = null,
  extendProviderPostSlot = null,
  releaseProviderPostSlot = null,
  deliveryWindowEvaluator = null,
  providerInventoryAuthoritative = false,
  endOfDayDeleteIntervalMs = 1,
  endOfDayMaxDeletesPerRun = 500,
  legacyOperatorSurfaceEnabled = true,
  simpleOperatorDirectAccessEnabled = true,
  productivityRebalanceEnabled = false,
  persistDailyDialOutcomes = null,
  reconcileDailyDialCalls = null,
  providerConsumptionOrder = null,
  refreshSourceStatuses = null,
  refreshUntouchedSourceStatuses = null,
  onSourceItemPersisted = null,
  onProviderAccepted = null,
  onAttemptCompleted = null,
  logger = null,
  durableSourceState = false,
  ingestBatchSize = 250,
  repositoryOverride = null,
} = {}) {
  const repository = repositoryOverride || new FakeRepository();
  let clock = new Date(START);
  const calls = [];
  const moves = [];
  const deletes = [];
  const providerContacts = new Map();
  const windowReads = [];
  const source = {
    async readBatch({ cursor, limit }) {
      if (durableSourceState) {
        const start = cursor?.id == null ? 0 : Number(cursor.id) + 1;
        const items = rows.slice(start, start + limit);
        const nextIndex = start + items.length;
        const lastIndex = nextIndex - 1;
        return {
          items: copy(items),
          highWater: rows[0]
            ? { createdAt: new Date(rows[0].createdAt), id: "0" }
            : null,
          nextCursor: nextIndex < rows.length && items.length
            ? { createdAt: new Date(rows[lastIndex].createdAt), id: String(lastIndex) }
            : null,
          done: nextIndex >= rows.length,
        };
      }
      const start = Number(cursor || 0);
      const items = rows.slice(start, start + limit);
      const nextCursor = start + items.length;
      return { items: copy(items), nextCursor, done: nextCursor >= rows.length };
    },
    async readOne(input) {
      const row = copy(rows.find((candidate) => (
        candidate.domain === input.domain
        && String(candidate.caseId) === String(input.caseId)
      )) || null);
      return typeof sourceReadOne === "function" ? sourceReadOne({ ...input, row }) : row;
    },
    async readWindowBatch({ cursor, limit, receivedFrom, receivedBefore }) {
      windowReads.push({
        cursor: copy(cursor),
        limit,
        receivedFrom: new Date(receivedFrom),
        receivedBefore: new Date(receivedBefore),
      });
      const inWindow = rows.filter((row) => {
        const receivedAt = new Date(row.receivedAt).getTime();
        return row.sourceActive === true
          && receivedAt >= new Date(receivedFrom).getTime()
          && receivedAt < new Date(receivedBefore).getTime();
      });
      const start = Number(cursor || 0);
      const items = inWindow.slice(start, start + limit);
      const nextCursor = start + items.length;
      return { items: copy(items), nextCursor, done: nextCursor >= inWindow.length };
    },
  };
  if (durableSourceState) {
    source.readNewerBatch = async ({ after, limit }) => {
      const highWaterAt = new Date(after.createdAt).getTime();
      const candidates = rows
        .map((row, index) => ({ row, index }))
        .filter(({ row, index }) => {
          const createdAt = new Date(row.createdAt).getTime();
          return createdAt > highWaterAt || (createdAt === highWaterAt && index > Number(after.id));
        })
        .sort((left, right) => (
          new Date(left.row.createdAt).getTime() - new Date(right.row.createdAt).getTime()
          || left.index - right.index
        ));
      const page = candidates.slice(0, limit);
      const last = page.at(-1);
      return {
        items: copy(page.map((entry) => entry.row)),
        nextHighWater: last
          ? { createdAt: new Date(last.row.createdAt), id: String(last.index) }
          : copy(after),
        done: candidates.length <= limit,
      };
    };
  }
  const phoneBurner = {
    async createContact(input) {
      calls.push(copy(input));
      const contactId = `contact-${calls.length}`;
      providerContacts.set(contactId, { contactId, folderId: input.folderId });
      return { ok: true, status: "accepted", contactId };
    },
    async getContact(contactId) {
      const contact = providerContacts.get(String(contactId));
      return contact ? { ok: true, contact: copy(contact) } : { ok: false, reason: "not-found" };
    },
    async moveContact(contactId, folderId) {
      const contact = providerContacts.get(String(contactId));
      if (!contact) return { ok: false, reason: "not-found" };
      contact.folderId = String(folderId);
      moves.push({ contactId: String(contactId), folderId: String(folderId) });
      return { ok: true, contactId: String(contactId), folderId: String(folderId) };
    },
    async deleteContact(contactId) {
      const id = String(contactId);
      if (!providerContacts.has(id)) return { ok: false, httpStatus: 404, reason: "not-found" };
      providerContacts.delete(id);
      deletes.push(id);
      return { ok: true, httpStatus: 204, contactId: id, trashed: true };
    },
    async listFolderContacts(folderId, { page = 1, pageSize = 100 } = {}) {
      const matches = [...providerContacts.values()]
        .filter((contact) => String(contact.folderId) === String(folderId))
        .sort((left, right) => String(left.contactId).localeCompare(String(right.contactId)));
      const totalPages = matches.length === 0 ? 0 : Math.ceil(matches.length / pageSize);
      const contacts = matches.slice((page - 1) * pageSize, page * pageSize);
      return {
        ok: true,
        folderId,
        page,
        pageSize: contacts.length,
        totalPages,
        totalResults: matches.length,
        contacts: copy(contacts),
      };
    },
    async getFolderCount(folderId) {
      const count = [...providerContacts.values()]
        .filter((contact) => String(contact.folderId) === String(folderId))
        .length;
      return { ok: true, folderId, count };
    },
  };
  const runtime = createLeadDeliveryRuntime({
    repository,
    source,
    phoneBurner,
    actionHandlers: { record_daily_dial: async () => {}, ...handlers },
    scheduler,
    configuration: configuration || config({ target, refill }),
    enabled: true,
    actionsEnabled,
    refillEnabled,
    now: () => new Date(clock),
    ingestBatchSize,
    providerPostMinimumIntervalMs,
    providerPostSleep,
    providerPostClock,
    acquireProviderPostSlot,
    extendProviderPostSlot,
    releaseProviderPostSlot,
    deliveryWindowEvaluator,
    providerInventoryAuthoritative,
    endOfDayDeleteIntervalMs,
    endOfDayMaxDeletesPerRun,
    legacyOperatorSurfaceEnabled,
    simpleOperatorDirectAccessEnabled,
    productivityRebalanceEnabled,
    persistDailyDialOutcomes,
    reconcileDailyDialCalls,
    providerConsumptionOrder,
    refreshSourceStatuses,
    refreshUntouchedSourceStatuses,
    onSourceItemPersisted,
    onProviderAccepted,
    onAttemptCompleted,
    logger,
  });
  return {
    repository,
    source,
    phoneBurner,
    calls,
    moves,
    deletes,
    providerContacts,
    windowReads,
    runtime,
    setClock(value) { clock = new Date(value); },
  };
}

async function ingestAndSeed(h) {
  await h.runtime.ingestOnce();
  const result = await h.runtime.seedAgent("bruce_allen");
  return result;
}

test("provider runtime performs no weekend scan, refill, or posting", async () => {
  const h = harness({ rows: [sourceRow(1)] });
  h.setClock("2026-08-02T16:00:00.000Z");
  let eventReads = 0;
  h.repository.listEventsForDrain = async () => { eventReads += 1; return []; };
  const result = await h.runtime.tick();
  assert.equal(result.status, "ok");
  assert.equal(result.tickMode, "weekend_idle");
  assert.equal(result.events.status, "weekend-paused");
  assert.equal(eventReads, 0, "durable callbacks wait for the next business day");
  assert.equal(h.calls.length, 0);
  assert.equal(h.repository.agents.size, 0);
  assert.equal(h.repository.items.size, 0);
});

test("durable daily repair stays completed across ticks and restart while newer leads still enter", async () => {
  const rows = [{ ...sourceRow(1), createdAt: new Date("2026-07-10T16:00:00Z") }];
  const first = harness({ rows, durableSourceState: true, ingestBatchSize: 1 });
  let repairReads = 0;
  let newerReads = 0;
  const firstRepair = first.source.readBatch.bind(first.source);
  const firstNewer = first.source.readNewerBatch.bind(first.source);
  first.source.readBatch = async (input) => { repairReads += 1; return firstRepair(input); };
  first.source.readNewerBatch = async (input) => { newerReads += 1; return firstNewer(input); };
  const completed = await first.runtime.ingestOnce();
  assert.equal(completed.lane, "daily-repair");
  assert.equal(completed.done, true);
  await first.runtime.ingestOnce();
  assert.equal(repairReads, 1);
  assert.equal(newerReads, 1);

  rows.push({ ...sourceRow(2), createdAt: new Date("2026-07-10T16:01:00Z") });
  const admitted = await first.runtime.ingestOnce();
  assert.equal(admitted.lane, "new-arrivals");
  assert.equal(first.repository.items.size, 2);

  const restarted = harness({
    rows,
    durableSourceState: true,
    ingestBatchSize: 1,
    repositoryOverride: first.repository,
  });
  let restartedRepairReads = 0;
  const restartedRepair = restarted.source.readBatch.bind(restarted.source);
  restarted.source.readBatch = async (input) => {
    restartedRepairReads += 1;
    return restartedRepair(input);
  };
  const afterRestart = await restarted.runtime.ingestOnce();
  assert.equal(afterRestart.lane, "new-arrivals");
  assert.equal(restartedRepairReads, 0);
  assert.equal(restarted.repository.items.size, 2);
});

test("recovery source policy survives generic runtime ingestion", async () => {
  const row = {
    ...sourceRow(1),
    inventoryClass: "callrail_long_call_recovery",
    contactPolicyId: "long_call_recovery_120d_2x",
    eligibleFrom: new Date("2026-07-09T14:50:00.000Z"),
    expiresAt: new Date("2026-11-06T15:00:00.000Z"),
    firstQualifyingCallAt: new Date("2026-07-08T18:00:00.000Z"),
    episodeId: "callrail-mail-long-call-v1:TAG:1:1",
  };
  const h = harness({ rows: [row] });
  const result = await h.runtime.ingestOnce();
  assert.equal(result.inserted, 1);
  const stored = [...h.repository.items.values()][0];
  assert.equal(stored.inventoryClass, row.inventoryClass);
  assert.equal(stored.contactPolicyId, row.contactPolicyId);
  assert.equal(new Date(stored.eligibleFrom).getTime(), row.eligibleFrom.getTime());
  assert.equal(new Date(stored.expiresAt).getTime(), row.expiresAt.getTime());
  assert.equal(new Date(stored.firstQualifyingCallAt).getTime(), row.firstQualifyingCallAt.getTime());
  assert.equal(stored.episodeId, row.episodeId);
  const policy = resolveLeadDeliveryContactPolicy(stored, { now: new Date(START) });
  assert.equal(policy.maximumDailyAttempts, 2);
  assert.equal(policy.minimumRetryMinutes, 120);
});

test("lifecycle hooks observe canonical persistence and provider acceptance", async () => {
  const persisted = [];
  const accepted = [];
  const completed = [];
  const h = harness({
    rows: [sourceRow(1)],
    actionsEnabled: true,
    onSourceItemPersisted: async (event) => persisted.push(event),
    onProviderAccepted: async (event) => accepted.push(event),
    onAttemptCompleted: async (event) => completed.push(event),
  });
  await h.runtime.ingestOnce();
  await h.runtime.seedAgent("bruce_allen");
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].created, true);
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].item.state, "provider_accepted");
  addDone(h.repository, acceptedItems(h.repository)[0], 1, "voicemail");
  await h.runtime.drainEvents();
  assert.equal(completed.length, 1);
  assert.equal(completed[0].item.totalAttemptCount, 1);
});

test("an incomplete daily repair resumes its cursor before polling new arrivals", async () => {
  const rows = [
    { ...sourceRow(1), createdAt: new Date("2026-07-10T16:01:00Z") },
    { ...sourceRow(2), createdAt: new Date("2026-07-10T16:00:00Z") },
  ];
  const h = harness({ rows, durableSourceState: true, ingestBatchSize: 1 });
  let repairReads = 0;
  let newerReads = 0;
  const readRepair = h.source.readBatch.bind(h.source);
  const readNewer = h.source.readNewerBatch.bind(h.source);
  h.source.readBatch = async (input) => { repairReads += 1; return readRepair(input); };
  h.source.readNewerBatch = async (input) => { newerReads += 1; return readNewer(input); };

  const first = await h.runtime.ingestOnce();
  assert.equal(first.lane, "daily-repair");
  assert.equal(first.done, false);
  const second = await h.runtime.ingestOnce();
  assert.equal(second.lane, "daily-repair");
  assert.equal(second.done, true);
  assert.equal(repairReads, 2);
  assert.equal(newerReads, 0);
  assert.equal(h.repository.items.size, 2);
});

test("a completed empty daily repair does not restart on the next tick", async () => {
  const h = harness({ rows: [], durableSourceState: true, ingestBatchSize: 1 });
  let repairReads = 0;
  let newerReads = 0;
  const readRepair = h.source.readBatch.bind(h.source);
  const readNewer = h.source.readNewerBatch.bind(h.source);
  h.source.readBatch = async (input) => { repairReads += 1; return readRepair(input); };
  h.source.readNewerBatch = async (input) => { newerReads += 1; return readNewer(input); };
  assert.equal((await h.runtime.ingestOnce()).done, true);
  assert.equal((await h.runtime.ingestOnce()).lane, "new-arrivals");
  assert.equal(repairReads, 1);
  assert.equal(newerReads, 1);
});

function acceptedItems(repository) {
  return [...repository.items.values()].filter((item) => item.state === "provider_accepted");
}

function addDone(repository, item, number, outcome, extra = {}) {
  return repository.addEvent({
    _id: `done-${number}`,
    providerCallId: `call-${number}`,
    providerContactId: item.providerContactId,
    providerExternalLeadId: item.providerExternalLeadId,
    normalizedOutcome: outcome,
    receivedAt: new Date(START.getTime() + number * 1_000),
    ...extra,
  });
}

async function insertEligibleRows(repository, rows) {
  for (const row of rows) {
    await repository.insertActiveItemOnce({
      ...copy(row),
      sourcePool: POOLS.OLDER_AVAILABLE,
      state: "eligible",
      activeAttempt: true,
      version: 0,
      metadata: {},
    });
  }
}

test("productivity cull keeps exactly six yellow/red contacts", () => {
  const now = new Date("2026-07-15T17:00:00.000Z");
  const items = [
    ...Array.from({ length: 4 }, (_, index) => ({
      _id: `blue-${index}`,
      providerContactId: `blue-contact-${index}`,
      receivedAt: new Date("2026-07-05T17:00:00.000Z"),
      state: "provider_accepted",
    })),
    ...Array.from({ length: 7 }, (_, index) => ({
      _id: `aged-${index}`,
      providerContactId: `aged-contact-${index}`,
      receivedAt: new Date(index < 3 ? "2026-06-10T17:00:00.000Z" : "2026-06-20T17:00:00.000Z"),
      state: "provider_accepted",
    })),
  ];
  const plan = planProductivityPoolCull(items, { now });
  assert.equal(plan.status, "planned");
  assert.equal(plan.retained.length, 6);
  assert.equal(plan.removed.length, 5);
  assert.equal(plan.removed.filter((item) => String(item._id).startsWith("blue-")).length, 4);
});

test("productivity cull reports the aged cushion it must add before moving newer contacts", () => {
  const now = new Date("2026-07-15T17:00:00.000Z");
  const items = [
    {
      _id: "red-1",
      providerContactId: "red-contact-1",
      receivedAt: new Date("2026-06-01T17:00:00.000Z"),
      state: "provider_accepted",
    },
    ...Array.from({ length: 4 }, (_, index) => ({
      _id: `blue-${index}`,
      providerContactId: `blue-contact-${index}`,
      receivedAt: new Date("2026-07-05T17:00:00.000Z"),
      state: "provider_accepted",
    })),
  ];
  const plan = planProductivityPoolCull(items, { now });
  assert.equal(plan.status, "planned");
  assert.equal(plan.retained.length, 1);
  assert.equal(plan.removed.length, 4);
  assert.equal(plan.missingCushionCount, 5);
});

test("productivity rebalance posts the missing aged cushion before moving newer work", async () => {
  const h = harness({
    rows: [],
    actionsEnabled: true,
    refillEnabled: true,
    configuration: fiveAgentConfig(),
    providerInventoryAuthoritative: true,
    productivityRebalanceEnabled: true,
  });
  await h.runtime.tick();
  const rebalanceAt = new Date(START.getTime() + 16 * 60_000);
  const operations = [];
  const createContact = h.phoneBurner.createContact.bind(h.phoneBurner);
  const moveContact = h.phoneBurner.moveContact.bind(h.phoneBurner);
  h.phoneBurner.createContact = async (input) => {
    operations.push("create");
    return createContact(input);
  };
  h.phoneBurner.moveContact = async (...args) => {
    operations.push("move");
    return moveContact(...args);
  };
  const insertProviderItem = async ({ number, receivedAt }) => {
    const contactId = `existing-${number}`;
    await h.repository.insertActiveItemOnce({
      ...sourceRow(number, { receivedAt }),
      sourcePool: POOLS.OLDER_AVAILABLE,
      state: "provider_accepted",
      activeAttempt: true,
      deliveryAgentId: "bruce_allen",
      provider: "phoneburner",
      providerContactId: contactId,
      providerExternalLeadId: `external-${number}`,
      providerAcceptedAt: START,
      providerAttemptSequence: 1,
      providerPostState: "accepted",
      providerAttemptHistory: [],
      version: 0,
    });
    h.providerContacts.set(contactId, { contactId, folderId: "pool-1" });
  };
  await insertProviderItem({ number: 100, receivedAt: new Date("2026-06-01T17:00:00.000Z") });
  for (let index = 0; index < 8; index += 1) {
    await insertProviderItem({ number: 200 + index, receivedAt: new Date("2026-07-05T17:00:00.000Z") });
  }
  for (let index = 0; index < 5; index += 1) {
    await h.repository.insertActiveItemOnce({
      ...sourceRow(300 + index, { receivedAt: new Date("2026-06-10T17:00:00.000Z") }),
      sourcePool: POOLS.OLDER_AVAILABLE,
      state: "eligible",
      activeAttempt: true,
      version: 0,
    });
  }
  await h.repository.insertActiveItemOnce({
    ...sourceRow(400),
    sourcePool: POOLS.OLDER_AVAILABLE,
    state: "terminal",
    activeAttempt: false,
    deliveryAgentId: "brad_hansen",
    providerAttemptSequence: 1,
    providerAttemptHistory: [{
      attemptNumber: 1,
      event: "completed",
      provider: "phoneburner",
      providerExternalLeadId: "completed-external",
      providerContactId: "completed-contact",
      providerCallId: "completed-call",
      deliveryAgentId: "brad_hansen",
      packetId: null,
      occurredAt: new Date(START.getTime() + 10 * 60_000),
      outcome: "no_answer",
      reason: "test",
    }],
    version: 0,
  });

  const result = await h.runtime.runProductivityRebalance(rebalanceAt, { ignoreWarmup: true });
  assert.equal(result.moved, 8);
  assert.equal((await h.phoneBurner.getFolderCount("pool-1")).count, 6);
  assert.equal((await h.phoneBurner.getFolderCount("pool-4")).count, 8);
  assert.equal(h.calls.length, 5);
  assert.deepEqual(operations.slice(0, 5), ["create", "create", "create", "create", "create"]);
  assert.deepEqual(operations.slice(5), Array.from({ length: 8 }, () => "move"));
});

test("productivity rebalance restores an empty inactive Pool to the exact aged cushion", async () => {
  const configuration = fiveAgentConfig();
  configuration.agents.phil_olson.enabled = false;
  configuration.agents.sean_lucas.enabled = false;
  configuration.agents.chris_bolt.enabled = false;
  const h = harness({
    rows: [],
    actionsEnabled: true,
    refillEnabled: true,
    configuration,
    providerInventoryAuthoritative: true,
    productivityRebalanceEnabled: true,
  });
  await h.runtime.tick();
  const rebalanceAt = new Date(START.getTime() + 16 * 60_000);
  for (let index = 0; index < 6; index += 1) {
    await h.repository.insertActiveItemOnce({
      ...sourceRow(500 + index, { receivedAt: new Date("2026-06-10T17:00:00.000Z") }),
      sourcePool: POOLS.OLDER_AVAILABLE,
      state: "eligible",
      activeAttempt: true,
      version: 0,
    });
  }
  await h.repository.insertActiveItemOnce({
    ...sourceRow(600),
    sourcePool: POOLS.OLDER_AVAILABLE,
    state: "terminal",
    activeAttempt: false,
    deliveryAgentId: "brad_hansen",
    providerAttemptSequence: 1,
    providerAttemptHistory: [{
      attemptNumber: 1,
      event: "completed",
      provider: "phoneburner",
      providerExternalLeadId: "completed-external",
      providerContactId: "completed-contact",
      providerCallId: "completed-call",
      deliveryAgentId: "brad_hansen",
      packetId: null,
      occurredAt: new Date(START.getTime() + 10 * 60_000),
      outcome: "no_answer",
      reason: "test",
    }],
    version: 0,
  });

  const result = await h.runtime.runProductivityRebalance(rebalanceAt, { ignoreWarmup: true });

  assert.equal(result.status, "completed");
  assert.equal(result.moved, 0);
  assert.equal((await h.phoneBurner.getFolderCount("pool-1")).count, 6);
  assert.equal(h.calls.length, 6);
});

test("productivity rebalance moves culled Pool contacts to active agents and leaves normal posting usable", async () => {
  const configuration = fiveAgentConfig();
  configuration.agents.phil_olson.enabled = false;
  configuration.agents.sean_lucas.enabled = false;
  const h = harness({
    rows: [],
    actionsEnabled: true,
    refillEnabled: true,
    configuration,
    providerInventoryAuthoritative: true,
    productivityRebalanceEnabled: true,
  });
  await h.runtime.tick();
  const rebalanceAt = new Date(START.getTime() + 16 * 60_000);
  const insertProviderItem = async ({ number, agentId, folderId, receivedAt }) => {
    const contactId = `existing-${number}`;
    const item = await h.repository.insertActiveItemOnce({
      ...sourceRow(number, { receivedAt }),
      sourcePool: POOLS.OLDER_AVAILABLE,
      state: "provider_accepted",
      activeAttempt: true,
      deliveryAgentId: agentId,
      provider: "phoneburner",
      providerContactId: contactId,
      providerExternalLeadId: `external-${number}`,
      providerAcceptedAt: START,
      providerAttemptSequence: 1,
      providerPostState: "accepted",
      providerAttemptHistory: [{
        attemptNumber: 1,
        event: "accepted",
        provider: "phoneburner",
        providerExternalLeadId: `external-${number}`,
        providerContactId: contactId,
        providerCallId: null,
        deliveryAgentId: agentId,
        packetId: `original-${number}`,
        occurredAt: START,
        outcome: null,
        reason: "test",
      }],
      version: 0,
    });
    h.providerContacts.set(contactId, { contactId, folderId });
    return item;
  };
  for (let index = 0; index < 6; index += 1) {
    await insertProviderItem({
      number: 100 + index,
      agentId: "bruce_allen",
      folderId: "pool-1",
      receivedAt: new Date("2026-06-20T17:00:00.000Z"),
    });
  }
  for (let index = 0; index < 4; index += 1) {
    await insertProviderItem({
      number: 200 + index,
      agentId: "bruce_allen",
      folderId: "pool-1",
      receivedAt: new Date("2026-07-05T17:00:00.000Z"),
    });
  }
  for (const [index, agentId] of ["brad_hansen", "chris_bolt"].entries()) {
    await h.repository.insertActiveItemOnce({
      ...sourceRow(300 + index),
      sourcePool: POOLS.OLDER_AVAILABLE,
      state: "terminal",
      activeAttempt: false,
      deliveryAgentId: agentId,
      providerAttemptSequence: 1,
      providerAttemptHistory: [{
        attemptNumber: 1,
        event: "completed",
        provider: "phoneburner",
        providerExternalLeadId: `completed-external-${index}`,
        providerContactId: `completed-contact-${index}`,
        providerCallId: `completed-call-${index}`,
        deliveryAgentId: agentId,
        packetId: null,
        occurredAt: new Date(START.getTime() + 10 * 60_000),
        outcome: "no_answer",
        reason: "test",
      }],
      version: 0,
    });
  }

  const result = await h.runtime.runProductivityRebalance(rebalanceAt, { ignoreWarmup: true });
  assert.equal(result.status, "completed");
  assert.equal(result.moved, 4);
  assert.equal((await h.phoneBurner.getFolderCount("pool-1")).count, 6);
  assert.equal((await h.phoneBurner.getFolderCount("pool-4")).count, 2);
  assert.equal((await h.phoneBurner.getFolderCount("pool-5")).count, 2);
  assert.equal(h.calls.length, 0, "rebalance must move existing contacts instead of creating uploads");

  await h.repository.insertActiveItemOnce({
    ...sourceRow(999, { receivedAt: new Date("2026-06-01T17:00:00.000Z") }),
    sourcePool: POOLS.OLDER_AVAILABLE,
    state: "eligible",
    activeAttempt: true,
    version: 0,
  });
  const normal = await h.runtime.postTopOfQueue("brad_hansen", { count: 1 });
  assert.equal(normal.accepted, 1);
  assert.equal(h.calls.length, 1, "ordinary posting must remain usable after the cull completes");
});

test("restart warm-up lets normal work run for fifteen minutes before automatic rebalance", async () => {
  const h = harness({
    rows: [],
    actionsEnabled: true,
    refillEnabled: true,
    configuration: fiveAgentConfig(),
    providerInventoryAuthoritative: true,
    productivityRebalanceEnabled: true,
    scheduler: {
      setInterval() { return { unref() {} }; },
      clearInterval() {},
    },
  });
  await h.runtime.start();
  await h.runtime.tick();
  assert.equal(h.runtime.getState().productivityRebalance.status, "warming");
  h.setClock(new Date(START.getTime() + 14 * 60_000));
  await h.runtime.tick();
  assert.equal(h.runtime.getState().productivityRebalance.status, "warming");
  h.setClock(new Date(START.getTime() + 15 * 60_000));
  const tick = await h.runtime.tick();
  assert.equal(tick.productivityRebalance.status, "no-active-targets");
  await h.runtime.stop();
});

test("production-simple mode disables every direct writer while preserving automated day start", async () => {
  const h = harness({
    rows: [sourceRow(1)],
    actionsEnabled: true,
    providerInventoryAuthoritative: true,
    legacyOperatorSurfaceEnabled: false,
    simpleOperatorDirectAccessEnabled: false,
  });
  await h.runtime.ingestOnce();

  assert.equal((await h.runtime.seedAgent("bruce_allen")).status, "legacy-operator-disabled");
  assert.equal((await h.runtime.launchAgent("bruce_allen")).status, "legacy-operator-disabled");
  assert.equal((await h.runtime.appendAgentPacket("bruce_allen")).status, "legacy-operator-disabled");
  assert.equal((await h.runtime.appendWeightedAgentPacket()).status, "legacy-operator-disabled");
  assert.equal((await h.runtime.refillAgent("bruce_allen")).status, "legacy-operator-disabled");
  assert.equal((await h.runtime.preloadWindow()).status, "legacy-operator-disabled");
  assert.equal((await h.runtime.postTopOfQueue("bruce_allen")).status, "direct-post-disabled");
  assert.equal(h.calls.length, 0);

  const started = await h.runtime.runDayStart();
  assert.equal(started.status, "completed");
  assert.equal(h.calls.length, 1);
});

test("morning never persists prior DailyDial rows and completed close persists the current day", async () => {
  const persistenceCalls = [];
  const projectionCalls = [];
  const h = harness({
    rows: [sourceRow(1)],
    actionsEnabled: true,
    providerInventoryAuthoritative: true,
    legacyOperatorSurfaceEnabled: false,
    simpleOperatorDirectAccessEnabled: false,
    persistDailyDialOutcomes: async (request) => {
      persistenceCalls.push(copy(request));
      return { status: "completed", rows: 0, persisted: 0, attempts: 0 };
    },
    reconcileDailyDialCalls: async (request) => {
      projectionCalls.push(copy(request));
      return {
        status: "completed",
        rows: 1,
        attempts: 2,
        reconciled: 2,
        rejected: 0,
        agentUnmapped: 0,
      };
    },
  });
  const started = await h.runtime.runDayStart();
  assert.equal(started.status, "completed");
  assert.equal(started.priorDayPersistence.status, "not-run-morning");
  assert.equal(persistenceCalls.length, 0);

  h.setClock("2026-07-11T00:31:00.000Z");
  const closed = await h.runtime.runEndOfDayFolderDrain();
  assert.equal(closed.status, "completed");
  assert.deepEqual(persistenceCalls[0], { dateKey: "2026-07-10" });
  assert.equal(closed.dailyDialPersistence.status, "completed");
  assert.deepEqual(projectionCalls[0], { dateKey: "2026-07-10" });
  assert.equal(closed.dailyDialCallLogProjection.reconciled, 2);
  assert.deepEqual(h.runtime.getState().endOfDayDrain.callLogProjection, {
    status: "completed",
    rows: 1,
    attempts: 2,
    reconciled: 2,
    rejected: 0,
    agentUnmapped: 0,
  });
});

test("a day-close persistence failure alerts without undoing the completed close", async () => {
  const h = harness({
    rows: [sourceRow(1)],
    actionsEnabled: true,
    providerInventoryAuthoritative: true,
    persistDailyDialOutcomes: async () => {
      throw new Error("test-close-persistence-failure");
    },
  });

  h.setClock("2026-07-11T00:31:00.000Z");
  const closed = await h.runtime.runEndOfDayFolderDrain();

  assert.equal(closed.status, "completed");
  assert.equal(closed.dailyDialPersistence.status, "failed");
});

test("dark runtime ingests and previews five without claiming or posting", async () => {
  const h = harness({ rows: Array.from({ length: 6 }, (_, index) => sourceRow(index + 1)) });
  await h.runtime.ingestOnce();
  const dark = await h.runtime.seedAgent("bruce_allen");
  const preview = await h.runtime.previewAgent("bruce_allen");
  assert.equal(dark.status, "actions-disabled");
  assert.equal(preview.needed, 5);
  assert.equal(preview.recipe.items.length, 5);
  assert.equal(h.calls.length, 0);
  assert.equal([...h.repository.items.values()].every((item) => item.state === "eligible"), true);
});

test("start arms the scheduler without waiting for the first tick, and stop drains it", async () => {
  let unrefCount = 0;
  let clearCount = 0;
  let releaseDrain;
  let markDrainEntered;
  const drainGate = new Promise((resolve) => { releaseDrain = resolve; });
  const drainEntered = new Promise((resolve) => { markDrainEntered = resolve; });
  const handle = { unref() { unrefCount += 1; } };
  const h = harness({
    actionsEnabled: true,
    scheduler: {
      setInterval() { return handle; },
      clearInterval(value) { assert.equal(value, handle); clearCount += 1; },
    },
  });
  const listEventsForDrain = h.repository.listEventsForDrain.bind(h.repository);
  h.repository.listEventsForDrain = async (input) => {
    markDrainEntered();
    await drainGate;
    return listEventsForDrain(input);
  };
  const started = await h.runtime.start();
  assert.equal(started.running, true);
  assert.equal(started.ticks, 0);
  assert.equal(unrefCount, 1);
  await drainEntered;
  releaseDrain();
  const stopped = await h.runtime.stop();
  assert.equal(stopped.running, false);
  assert.equal(stopped.ticks, 1);
  assert.equal(clearCount, 1);
});

test("explicit Bruce seed persists shift evidence and posts exactly target five with stable identities", async () => {
  const h = harness({ rows: Array.from({ length: 7 }, (_, index) => sourceRow(index + 1)), actionsEnabled: true });
  const result = await ingestAndSeed(h);
  const agent = await h.repository.getAgentById("bruce_allen");
  assert.equal(result.accepted, 5);
  assert.equal(h.calls.length, 5);
  assert.equal(new Set(h.calls.map((call) => call.externalLeadId)).size, 5);
  assert.equal(h.calls.every((call) => call.folderId === "pool-bruce"), true);
  assert.equal(h.calls.every((call) => (
    call.customFields.some((field) => field.name === "Logics Database" && field.value === "TAG")
    && call.customFields.some((field) => field.name === "Case ID" && /^\d+$/.test(field.value))
  )), true);
  assert.equal(agent.shiftEnabled, true);
  assert.equal(agent.estimatedOutstanding, 5);
  assert.equal((await h.runtime.seedAgent("phil_olson")).status, "agent-disabled");
});

test("operator cancel stops refill and launch admits a late agent back into the flow", async () => {
  const h = harness({ rows: [sourceRow(1), sourceRow(2)], actionsEnabled: true, target: 1, refill: 0 });
  await h.runtime.ingestOnce();

  const launched = await h.runtime.launchAgent("bruce_allen");
  assert.equal(launched.shiftEnabled, true);
  assert.equal(launched.accepted, 1);

  const cancelled = await h.runtime.cancelAgent("bruce_allen");
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.cancelled, true);
  let agent = await h.repository.getAgentById("bruce_allen");
  assert.equal(agent.operatorPaused, true);
  assert.equal(agent.shiftEnabled, false);
  assert.equal(agent.activeUntil, null);
  assert.equal((await h.runtime.seedAgent("bruce_allen", { preposition: true })).status, "operator-paused");

  const relaunched = await h.runtime.launchAgent("bruce_allen");
  assert.equal(relaunched.shiftEnabled, true);
  agent = await h.repository.getAgentById("bruce_allen");
  assert.equal(agent.operatorPaused, false);
  assert.equal(agent.shiftEnabled, true);
});

test("call-end pulse appends an exact packet beyond the tracked shallow target", async () => {
  const h = harness({
    rows: [sourceRow(1), sourceRow(2), sourceRow(3), sourceRow(4)],
    actionsEnabled: true,
    target: 1,
    refill: 0,
  });
  await h.runtime.ingestOnce();
  const launched = await h.runtime.launchAgent("bruce_allen");
  assert.equal(launched.accepted, 1);

  const pulse = await h.runtime.appendAgentPacket("bruce_allen", { count: 2 });
  assert.equal(pulse.status, "posted");
  assert.equal(pulse.requested, 2);
  assert.equal(pulse.accepted, 2);
  assert.equal(h.calls.length, 3);
  const agent = await h.repository.getAgentById("bruce_allen");
  assert.equal(agent.estimatedOutstanding, 3);
});

test("call-end pulse scans source immediately when durable inventory is empty", async () => {
  const h = harness({
    rows: [sourceRow(1), sourceRow(2)],
    actionsEnabled: true,
    target: 1,
    refill: 0,
  });
  const launch = await h.runtime.launchAgent("bruce_allen");
  assert.equal(launch.status, "no-candidates");

  const pulse = await h.runtime.appendAgentPacket("bruce_allen", { count: 2 });
  assert.equal(pulse.status, "posted");
  assert.equal(pulse.accepted, 2);
  assert.equal(pulse.inventoryScanBatches, 1);
  assert.equal(h.calls.length, 2, "the source scan must not race a duplicate fresh post");
});

test("floor-wide pulse chooses an active agent through persisted fresh weighting", async () => {
  const h = harness({
    rows: [sourceRow(1), sourceRow(2), sourceRow(3)],
    actionsEnabled: true,
    target: 1,
    refill: 0,
  });
  await h.runtime.ingestOnce();
  assert.equal((await h.runtime.appendWeightedAgentPacket({ count: 2 })).status, "no-active-agent");
  await h.runtime.launchAgent("bruce_allen");
  const pulse = await h.runtime.appendWeightedAgentPacket({ count: 2 });
  assert.equal(pulse.agentId, "bruce_allen");
  assert.equal(pulse.accepted, 2);
});

test("explicit seed cannot claim work owned by the immediate fresh lane", async () => {
  const fresh = sourceRow(1, {
    receivedAt: new Date(START.getTime() - 5 * 60_000),
  });
  const h = harness({ rows: [fresh], actionsEnabled: true, target: 1, refill: 0 });
  await h.runtime.ingestOnce();
  const result = await h.runtime.seedAgent("bruce_allen");
  const item = [...h.repository.items.values()][0];
  const agent = await h.repository.getAgentById("bruce_allen");

  assert.equal(result.accepted, 0);
  assert.equal(item.state, "eligible");
  assert.equal(item.deliveryAgentId, null);
  assert.equal(Number(agent.freshReservedThisHour || 0), 0);
  assert.equal(Number(agent.pendingFreshCount || 0), 0);
});

test("fresh ingestion posts immediately to the next active agent and commits the cursor after acceptance", async () => {
  const configuration = config({ target: 5, refill: 1 });
  configuration.agents.phil_olson.enabled = true;
  const fresh = sourceRow(1, { receivedAt: new Date(START.getTime() - 60_000) });
  const rows = [];
  const h = harness({ rows, actionsEnabled: true, configuration });
  await h.runtime.start();
  await h.runtime.stop();
  for (const [agentId, served] of [["bruce_allen", 2], ["phil_olson", 0]]) {
    const agent = await h.repository.getAgentById(agentId);
    await h.repository.compareAndSetAgent({
      agentId,
      expectedVersion: agent.version,
      set: {
        shiftEnabled: true,
        activeUntil: new Date(START.getTime() + 30 * 60_000),
        lastProviderEvidenceAt: START,
        estimatedOutstanding: agentId === "bruce_allen" ? 400 : 300,
        freshReservedThisHour: served,
      },
    });
  }
  const cursor = await h.repository.getOrCreateFairPickCursor("fresh", {
    agentOrder: ["bruce_allen", "phil_olson"],
  });
  await h.repository.compareAndSetFairPickCursor({
    workType: "fresh",
    expectedVersion: cursor.version,
    expectedLastPickedAgentId: null,
    lastPickedAgentId: "bruce_allen",
  });
  rows.push(fresh);
  await h.runtime.ingestOnce();
  const delivered = [...h.repository.items.values()][0];
  assert.equal(delivered.state, "provider_accepted");
  assert.equal(delivered.deliveryAgentId, "phil_olson");
  assert.equal(h.calls.length, 1);
  assert.equal((await h.repository.getOrCreateFairPickCursor("fresh", {
    agentOrder: ["bruce_allen", "phil_olson"],
  })).lastPickedAgentId, "phil_olson");
  assert.equal((await h.repository.getAgentById("phil_olson")).freshReservedThisHour, 1);
});

test("fresh backlog posts newest-first and alternates active agents regardless of bulk depth", async () => {
  const configuration = config({ target: 5, refill: 1 });
  configuration.agents.phil_olson.enabled = true;
  const fresh = Array.from({ length: 4 }, (_, index) => sourceRow(index + 1, {
    receivedAt: new Date(START.getTime() - (30 + index) * 60_000),
  }));
  const h = harness({ rows: fresh, actionsEnabled: true, configuration });
  await h.runtime.start();
  await h.runtime.stop();
  for (const agentId of ["bruce_allen", "phil_olson"]) {
    const agent = await h.repository.getAgentById(agentId);
    await h.repository.compareAndSetAgent({
      agentId,
      expectedVersion: agent.version,
      set: {
        shiftEnabled: true,
        activeUntil: new Date(START.getTime() + 30 * 60_000),
        lastProviderEvidenceAt: START,
        estimatedOutstanding: 500,
        freshReservedThisHour: 0,
      },
    });
  }

  await h.runtime.ingestOnce();
  const delivered = [...h.repository.items.values()]
    .filter((item) => item.state === "provider_accepted")
    .sort((left, right) => new Date(right.receivedAt) - new Date(left.receivedAt));
  assert.equal(delivered.length, 4);
  assert.deepEqual(
    Object.fromEntries(["bruce_allen", "phil_olson"].map((agentId) => [
      agentId,
      delivered.filter((item) => item.deliveryAgentId === agentId).length,
    ])),
    { bruce_allen: 2, phil_olson: 2 },
  );
  assert.equal(delivered.every((item) => item.reservationReason === "immediate-fresh"), true);
  assert.equal(new Date(delivered[0].receivedAt).getTime(), new Date(fresh[0].receivedAt).getTime());
});

test("fresh waits without exact recent provider evidence", async () => {
  const rows = [sourceRow(1, { receivedAt: new Date(START.getTime() - 60_000) })];
  const h = harness({ rows, actionsEnabled: true });
  await h.runtime.start();
  await h.runtime.stop();
  const agent = await h.repository.getAgentById("bruce_allen");
  await h.repository.compareAndSetAgent({
    agentId: "bruce_allen",
    expectedVersion: agent.version,
    set: {
      shiftEnabled: true,
      activeUntil: new Date(START.getTime() + 30 * 60_000),
      lastProviderEvidenceAt: null,
    },
  });

  const result = await h.runtime.ingestOnce();
  assert.equal(result.freshDispatch.status, "no-active-agent");
  assert.equal(h.calls.length, 0);
  assert.equal([...h.repository.items.values()][0].state, "eligible");
});

test("an exact Call End wakes the independent fresh lane", async () => {
  const fresh = sourceRow(1, { receivedAt: new Date(START.getTime() - 60_000) });
  const overnight = sourceRow(2, { receivedAt: new Date("2026-07-09T17:00:00.000Z") });
  const h = harness({
    rows: [fresh, overnight],
    actionsEnabled: true,
    refillEnabled: false,
    target: 1,
    refill: 0,
  });

  await h.runtime.ingestOnce();
  assert.equal(h.calls.length, 0);
  const seed = await h.runtime.seedAgent("bruce_allen");
  assert.equal(seed.accepted, 1);
  const first = acceptedItems(h.repository)[0];
  assert.notEqual(first.sourcePool, POOLS.NEW_TODAY);

  addDone(h.repository, first, 1, "voicemail");
  await h.runtime.drainEvents();
  await h.runtime.dispatchImmediateFresh();

  const deliveredFresh = [...h.repository.items.values()].find((item) => item.sourcePool === POOLS.NEW_TODAY);
  assert.equal(deliveredFresh.state, "provider_accepted");
  assert.equal(deliveredFresh.deliveryAgentId, "bruce_allen");
  assert.equal(deliveredFresh.reservationReason, "immediate-fresh");
  assert.equal(h.calls.length, 2);
});

test("fresh rejection does not advance the fairness cursor", async () => {
  const rows = [sourceRow(1, { receivedAt: new Date(START.getTime() - 60_000) })];
  const h = harness({ rows, actionsEnabled: true });
  await h.runtime.start();
  await h.runtime.stop();
  const agent = await h.repository.getAgentById("bruce_allen");
  await h.repository.compareAndSetAgent({
    agentId: "bruce_allen",
    expectedVersion: agent.version,
    set: {
      shiftEnabled: true,
      activeUntil: new Date(START.getTime() + 30 * 60_000),
      lastProviderEvidenceAt: START,
    },
  });
  h.phoneBurner.createContact = async () => ({ ok: false, status: "rejected", reason: "test-rejection" });

  const result = await h.runtime.ingestOnce();
  const cursor = await h.repository.getOrCreateFairPickCursor("fresh", {
    agentOrder: ["bruce_allen"],
  });
  assert.equal(result.freshDispatch.status, "provider-rejected");
  assert.equal(cursor.lastPickedAgentId, null);
  assert.equal([...h.repository.items.values()][0].state, "delivery_failed");
});

test("one malformed activity record cannot block another active agent from fresh work", async () => {
  const configuration = config({ target: 5, refill: 1 });
  configuration.agents.phil_olson.enabled = true;
  const h = harness({
    rows: [sourceRow(1, { receivedAt: new Date(START.getTime() - 60_000) })],
    actionsEnabled: true,
    configuration,
  });
  await h.runtime.start();
  await h.runtime.stop();
  for (const [agentId, evidence] of [["bruce_allen", "not-a-date"], ["phil_olson", START]]) {
    const agent = await h.repository.getAgentById(agentId);
    await h.repository.compareAndSetAgent({
      agentId,
      expectedVersion: agent.version,
      set: {
        shiftEnabled: true,
        activeUntil: new Date(START.getTime() + 30 * 60_000),
        lastProviderEvidenceAt: evidence,
      },
    });
  }

  const result = await h.runtime.ingestOnce();
  const delivered = [...h.repository.items.values()][0];
  assert.equal(result.freshDispatch.accepted, 1);
  assert.equal(delivered.deliveryAgentId, "phil_olson");
});

test("immediate fresh adopts an unposted legacy reservation during cutover", async () => {
  const h = harness({
    rows: [sourceRow(1, { receivedAt: new Date(START.getTime() - 60_000) })],
    actionsEnabled: true,
  });
  await h.runtime.start();
  await h.runtime.stop();
  await h.runtime.ingestOnce();
  const inserted = [...h.repository.items.values()][0];
  await h.repository.compareAndSetItem({
    itemId: inserted._id,
    expectedVersion: inserted.version,
    expected: { state: "eligible" },
    set: {
      state: "reserved",
      reservedAgentId: "bruce_allen",
      reservationReason: "fresh-fairness",
    },
  });
  const agent = await h.repository.getAgentById("bruce_allen");
  await h.repository.compareAndSetAgent({
    agentId: "bruce_allen",
    expectedVersion: agent.version,
    set: {
      shiftEnabled: true,
      activeUntil: new Date(START.getTime() + 30 * 60_000),
      lastProviderEvidenceAt: START,
      pendingFreshCount: 1,
    },
  });

  const result = await h.runtime.dispatchImmediateFresh();
  const delivered = [...h.repository.items.values()][0];
  assert.equal(result.accepted, 1);
  assert.equal(delivered.state, "provider_accepted");
  assert.equal(delivered.reservationReason, "immediate-fresh");
  assert.equal((await h.repository.getAgentById("bruce_allen")).pendingFreshCount, 0);
});

test("bulk cannot steal waiting fresh work after the fifteen-minute alert boundary", async () => {
  const configuration = config({ target: 1, refill: 0 });
  configuration.agents.phil_olson.enabled = true;
  const fresh = sourceRow(1, { receivedAt: new Date(START) });
  const rows = [];
  const h = harness({ rows, actionsEnabled: true, configuration });
  await h.runtime.start();
  await h.runtime.stop();
  for (const [agentId, served] of [["bruce_allen", 2], ["phil_olson", 0]]) {
    const agent = await h.repository.getAgentById(agentId);
    await h.repository.compareAndSetAgent({
      agentId,
      expectedVersion: agent.version,
      set: {
        shiftEnabled: true,
        activeUntil: new Date(START.getTime() + 60 * 60_000),
        lastProviderEvidenceAt: null,
        estimatedOutstanding: 0,
        freshReservedThisHour: served,
      },
    });
  }
  const cursor = await h.repository.getOrCreateFairPickCursor("fresh", {
    agentOrder: ["bruce_allen", "phil_olson"],
  });
  await h.repository.compareAndSetFairPickCursor({
    workType: "fresh",
    expectedVersion: cursor.version,
    expectedLastPickedAgentId: null,
    lastPickedAgentId: "bruce_allen",
  });
  rows.push(fresh);
  await h.runtime.ingestOnce();
  assert.equal([...h.repository.items.values()][0].state, "eligible");
  assert.equal([...h.repository.items.values()][0].reservedAgentId, null);

  h.setClock(new Date(START.getTime() + 16 * 60_000));
  const result = await h.runtime.postTopOfQueue("bruce_allen", { count: 1 });
  const waiting = [...h.repository.items.values()][0];
  assert.equal(result.accepted, 0);
  assert.equal(waiting.state, "eligible");
  assert.equal(waiting.deliveryAgentId, null);
  assert.equal((await h.repository.getAgentById("phil_olson")).pendingFreshCount, 0);
});

test("bulk packet requests never claim eligible fresh work", async () => {
  const configuration = config({ target: 1, refill: 0 });
  configuration.agents.phil_olson.enabled = true;
  const rows = [];
  const h = harness({ rows, actionsEnabled: true, configuration });
  await h.runtime.start();
  await h.runtime.stop();
  for (const agentId of ["bruce_allen", "phil_olson"]) {
    const agent = await h.repository.getAgentById(agentId);
    await h.repository.compareAndSetAgent({
      agentId,
      expectedVersion: agent.version,
      set: {
        shiftEnabled: true,
        activeUntil: new Date(START.getTime() + 60 * 60_000),
        lastProviderEvidenceAt: null,
        estimatedOutstanding: 0,
      },
    });
  }
  rows.push(...[1, 2, 3].map((number) => sourceRow(number, { receivedAt: new Date(START) })));
  await h.runtime.ingestOnce();

  const result = await h.runtime.postTopOfQueue("bruce_allen", { count: 1 });

  assert.equal(result.accepted, 0);
  assert.equal((await h.repository.getAgentById("bruce_allen")).pendingFreshCount, 0);
  assert.equal((await h.repository.getAgentById("phil_olson")).pendingFreshCount, 0);
  const remaining = [...h.repository.items.values()];
  assert.equal(remaining.filter((item) => item.state === "provider_accepted").length, 0);
  assert.equal(remaining.filter((item) => item.state === "reserved").length, 0);
  assert.equal(remaining.filter((item) => item.state === "eligible").length, 3);
});

test("duplicate source ingest rolls Friday new-today inventory into Monday older-available", async () => {
  const row = sourceRow(1, {
    receivedAt: new Date("2026-07-10T16:30:00.000Z"),
    dailyAttemptDateKey: "2026-07-10",
    dailyAttemptCount: 2,
  });
  const h = harness({ rows: [row] });
  h.setClock("2026-07-10T17:00:00.000Z");
  await h.runtime.ingestOnce();
  assert.equal([...h.repository.items.values()][0].sourcePool, POOLS.NEW_TODAY);

  h.setClock("2026-07-13T17:00:00.000Z");
  await h.runtime.ingestOnce();
  const rolled = [...h.repository.items.values()][0];
  assert.equal(rolled.sourcePool, POOLS.OLDER_AVAILABLE);
  assert.equal(rolled.dailyAttemptDateKey, "2026-07-13");
  assert.equal(rolled.dailyAttemptCount, 0);
  assert.equal(rolled.state, "eligible");
});

test("duplicate source recheck blocks a previously eligible lead before claim", async () => {
  const row = sourceRow(1);
  const h = harness({ rows: [row], actionsEnabled: true, target: 1, refill: 0 });
  await h.runtime.ingestOnce();
  row.eligibility = { ok: false, reason: "payment-or-converted", retryable: false };
  await h.runtime.ingestOnce();
  const blocked = [...h.repository.items.values()][0];
  assert.equal(blocked.state, "blocked");
  assert.equal(blocked.activeAttempt, false);
  assert.equal((await h.runtime.seedAgent("bruce_allen")).accepted, 0);
  assert.equal(h.calls.length, 0);
});

test("explicit weekend pre-position restores only the shallow deficit without manufacturing activity", async () => {
  const h = harness({
    rows: Array.from({ length: 7 }, (_, index) => sourceRow(index + 1)),
    actionsEnabled: true,
  });
  await h.runtime.ingestOnce();
  const result = await h.runtime.seedAgent("bruce_allen", { preposition: true });
  const agent = await h.repository.getAgentById("bruce_allen");

  assert.equal(result.accepted, 5);
  assert.equal(h.calls.length, 5);
  assert.equal(agent.estimatedOutstanding, 5);
  assert.equal(agent.shiftEnabled, false);
  assert.equal(agent.activeUntil, null);

  const second = await h.runtime.seedAgent("bruce_allen", { preposition: true });
  assert.equal(second.status, "at-target");
  assert.equal(second.accepted, 0);
  assert.equal(h.calls.length, 5);
});

test("weekend pre-position cannot consume the independent fresh lane", async () => {
  const fresh = Array.from({ length: 7 }, (_, index) => sourceRow(index + 1, {
    receivedAt: new Date(START.getTime() - (index + 1) * 30_000),
  }));
  const h = harness({ rows: fresh, actionsEnabled: true });
  await h.runtime.ingestOnce();
  const result = await h.runtime.seedAgent("bruce_allen", { preposition: true });
  const agent = await h.repository.getAgentById("bruce_allen");
  assert.equal(result.accepted, 0);
  assert.equal(agent.shiftEnabled, false);
  assert.equal(agent.activeUntil, null);
  assert.equal(Number(agent.freshReservedThisHour || 0), 0);
  assert.equal(Number(agent.pendingFreshCount || 0), 0);
  assert.equal([...h.repository.items.values()].every((item) => item.state === "eligible"), true);
});

test("preload window dry-run scans exact active receipt bounds without persistence or provider calls", async () => {
  const rows = Array.from({ length: 8 }, (_, index) => sourceRow(index + 1, {
    receivedAt: new Date(`2026-07-0${index + 1}T17:00:00.000Z`),
  }));
  rows[7].sourceActive = false;
  const h = harness({ rows, configuration: fiveAgentConfig(), actionsEnabled: false });
  const receivedFrom = new Date("2026-07-01T07:00:00.000Z");
  const receivedBefore = new Date("2026-07-08T07:00:00.000Z");

  const result = await h.runtime.preloadWindow({
    receivedFrom,
    receivedBefore,
    agentIds: ["chris_bolt", "bruce_allen", "phil_olson", "brad_hansen", "sean_lucas"],
    maxContacts: 6,
  });

  assert.equal(result.status, "preview");
  assert.equal(result.dryRun, true);
  assert.equal(result.selected, 6);
  assert.equal(result.fairnessSpread, 1);
  assert.equal(h.repository.items.size, 0);
  assert.equal(h.repository.checkpoints.size, 0);
  assert.equal(h.calls.length, 0);
  assert.equal(h.windowReads.length, 1);
  assert.equal(h.windowReads[0].receivedFrom.toISOString(), receivedFrom.toISOString());
  assert.equal(h.windowReads[0].receivedBefore.toISOString(), receivedBefore.toISOString());
});

test("preload window bypasses shallow target, deals newest-first, and keeps five-agent counts within one", async () => {
  const rows = Array.from({ length: 7 }, (_, index) => sourceRow(index + 1, {
    receivedAt: new Date(START.getTime() - index * 60_000),
  }));
  const h = harness({ rows, configuration: fiveAgentConfig(), actionsEnabled: true });
  const result = await h.runtime.preloadWindow({
    receivedFrom: new Date("2026-07-01T07:00:00.000Z"),
    receivedBefore: new Date("2026-07-11T07:00:00.000Z"),
    agentIds: ["bruce_allen", "phil_olson", "sean_lucas", "brad_hansen", "chris_bolt"],
    maxContacts: 7,
    dryRun: false,
  });

  assert.equal(result.status, "completed");
  assert.equal(result.selected, 7);
  assert.equal(result.accepted, 7);
  assert.equal(result.assigned, 7);
  assert.equal(result.fairnessSpread, 1);
  assert.equal(result.checkpoint.status, "completed");
  assert.equal(result.checkpoint.admitted, 7);
  assert.equal(result.checkpoint.accepted, 7);
  const checkpoint = [...h.repository.checkpoints.values()][0];
  assert.equal(checkpoint.cutoffAt.toISOString(), "2026-07-11T07:00:00.000Z");
  assert.equal(checkpoint.preloadPredicate, "received_at_lt_cutoff");
  assert.equal(checkpoint.continuationPredicate, "received_at_gte_cutoff");
  assert.equal(checkpoint.admittedDigest, checkpoint.acceptedDigest);
  assert.equal(h.runtime.checkpointReadyForContinuation(checkpoint), true);
  assert.equal(Math.max(...Object.values(result.countsByAgent)), 2);
  const byExternalId = new Map([...h.repository.items.values()].map((item) => [
    item.providerExternalLeadId,
    new Date(item.receivedAt).getTime(),
  ]));
  const postedReceipts = h.calls.map((call) => byExternalId.get(call.externalLeadId));
  assert.equal(postedReceipts.every((value, index) => index === 0 || value <= postedReceipts[index - 1]), true);
});

test("preload window emits one PII-free progress checkpoint every 25 acceptances", async () => {
  const rows = Array.from({ length: 25 }, (_, index) => sourceRow(index + 1, {
    receivedAt: new Date(START.getTime() - index * 60_000),
  }));
  const progress = [];
  const h = harness({ rows, configuration: fiveAgentConfig(), actionsEnabled: true });
  const result = await h.runtime.preloadWindow({
    receivedFrom: new Date("2026-07-01T07:00:00.000Z"),
    receivedBefore: new Date("2026-07-11T07:00:00.000Z"),
    agentIds: ["bruce_allen", "phil_olson", "sean_lucas", "brad_hansen", "chris_bolt"],
    maxContacts: 25,
    dryRun: false,
    onProgress: async (checkpoint) => { progress.push(copy(checkpoint)); },
  });

  assert.equal(result.status, "completed");
  assert.equal(result.accepted, 25);
  assert.equal(result.fairnessSpread, 0);
  assert.equal(progress.length, 1);
  assert.deepEqual(Object.keys(progress[0]).sort(), [
    "accepted",
    "assigned",
    "countsByAgent",
    "eligible",
    "fairnessSpread",
    "preloadKey",
    "scanned",
    "selected",
    "status",
  ]);
  assert.equal(progress[0].accepted, 25);
  assert.equal(progress[0].fairnessSpread, 0);
});

test("preload window rechecks explicit active state and snapshot receipt bounds immediately before claim", async () => {
  const rows = Array.from({ length: 7 }, (_, index) => sourceRow(index + 1, {
    receivedAt: new Date(START.getTime() - index * 60_000),
  }));
  const h = harness({
    rows,
    configuration: fiveAgentConfig(),
    actionsEnabled: true,
    sourceReadOne: ({ row }) => (String(row.caseId) === "1"
      ? { ...row, sourceActive: false }
      : String(row.caseId) === "2"
        ? { ...row, receivedAt: new Date("2026-06-30T06:59:59.000Z") }
        : row),
  });
  const result = await h.runtime.preloadWindow({
    receivedFrom: new Date("2026-07-01T07:00:00.000Z"),
    receivedBefore: new Date("2026-07-11T07:00:00.000Z"),
    agentIds: ["bruce_allen", "phil_olson", "sean_lucas", "brad_hansen", "chris_bolt"],
    maxContacts: 5,
    dryRun: false,
  });

  assert.equal(result.status, "completed");
  assert.equal(result.accepted, 5);
  const deliveredCases = [...h.repository.items.values()]
    .filter((item) => item.providerAcceptedAt)
    .map((item) => item.caseId);
  assert.equal(deliveredCases.includes("1"), false);
  assert.equal(deliveredCases.includes("2"), false);
});

test("preload window resumes the same durable assignments after provider backpressure", async () => {
  const rows = Array.from({ length: 6 }, (_, index) => sourceRow(index + 1, {
    receivedAt: new Date(START.getTime() - index * 60_000),
  }));
  let providerClock = 0;
  const h = harness({
    rows,
    configuration: fiveAgentConfig(),
    actionsEnabled: true,
    providerPostMinimumIntervalMs: 1,
    providerPostClock: () => providerClock,
    providerPostSleep: async (delayMs) => { providerClock += delayMs; },
  });
  let attempts = 0;
  h.phoneBurner.createContact = async (input) => {
    h.calls.push(copy(input));
    attempts += 1;
    return attempts === 3
      ? { ok: false, status: "rate_limited", reason: "rate_limited" }
      : { ok: true, status: "accepted", contactId: `contact-${attempts}` };
  };
  const input = {
    receivedFrom: new Date("2026-07-01T07:00:00.000Z"),
    receivedBefore: new Date("2026-07-11T07:00:00.000Z"),
    agentIds: ["bruce_allen", "phil_olson", "sean_lucas", "brad_hansen", "chris_bolt"],
    maxContacts: 6,
    dryRun: false,
  };

  const first = await h.runtime.preloadWindow(input);
  assert.equal(first.status, "provider-backpressure");
  assert.equal(first.selected, 3);
  assert.equal(first.accepted, 2);
  assert.equal(first.pending, 1);
  assert.equal(first.fairnessSpread, 1);
  const partialCheckpoint = [...h.repository.checkpoints.values()][0];
  assert.equal(partialCheckpoint.status, "partial");
  assert.equal(partialCheckpoint.admittedCount, 3);
  assert.equal(partialCheckpoint.acceptedCount, 2);
  assert.equal(partialCheckpoint.pendingCount, 1);

  providerClock = 60_000;
  const second = await h.runtime.preloadWindow(input);
  assert.equal(second.status, "completed");
  assert.equal(second.selected, 6);
  assert.equal(second.accepted, 6);
  assert.equal(second.recovered, 1);
  assert.equal(second.fairnessSpread, 1);
  assert.equal(new Set(h.calls.map((call) => call.externalLeadId)).size, 6);
  assert.equal(h.calls.length, 7);
  const completedCheckpoint = [...h.repository.checkpoints.values()][0];
  assert.equal(completedCheckpoint.status, "completed");
  assert.equal(completedCheckpoint.admittedCount, 6);
  assert.equal(completedCheckpoint.acceptedCount, 6);
  assert.equal(completedCheckpoint.pendingCount, 0);
  assert.equal(completedCheckpoint.admittedDigest, completedCheckpoint.acceptedDigest);
  assert.equal(h.runtime.checkpointReadyForContinuation(completedCheckpoint), true);

  const callsBeforeReplay = h.calls.length;
  const replay = await h.runtime.preloadWindow(input);
  assert.equal(replay.status, "completed");
  assert.equal(h.calls.length, callsBeforeReplay);
  assert.equal(h.repository.checkpoints.size, 1);
});

test("preload checkpoint immutable contract rejects a changed boundary before provider posting", async () => {
  const rows = [sourceRow(1)];
  const h = harness({ rows, configuration: fiveAgentConfig(), actionsEnabled: true });
  const base = {
    receivedFrom: new Date("2026-07-01T07:00:00.000Z"),
    receivedBefore: new Date("2026-07-11T07:00:00.000Z"),
    agentIds: ["bruce_allen", "phil_olson", "sean_lucas", "brad_hansen", "chris_bolt"],
    maxContacts: 1,
    dryRun: false,
    checkpointKey: "fixed-migration-checkpoint",
  };
  const first = await h.runtime.preloadWindow(base);
  assert.equal(first.status, "completed");
  const callsAfterFirst = h.calls.length;

  await assert.rejects(
    () => h.runtime.preloadWindow({
      ...base,
      receivedBefore: new Date("2026-07-12T07:00:00.000Z"),
    }),
    (error) => error.code === "checkpoint-contract-conflict",
  );
  assert.equal(h.calls.length, callsAfterFirst);
  assert.equal(h.repository.checkpoints.size, 1);
});

test("checkpoint readiness rejects partial, truncated, and unequal evidence", () => {
  const h = harness({ configuration: fiveAgentConfig() });
  const complete = {
    status: "completed",
    preloadPredicate: "received_at_lt_cutoff",
    continuationPredicate: "received_at_gte_cutoff",
    capReached: false,
    admittedCount: 2,
    acceptedCount: 2,
    pendingCount: 0,
    failedCount: 0,
    conflictCount: 0,
    admittedDigest: "a".repeat(64),
    acceptedDigest: "a".repeat(64),
    completedAt: new Date(),
  };
  assert.equal(h.runtime.checkpointReadyForContinuation(complete), true);
  assert.equal(h.runtime.checkpointReadyForContinuation({ ...complete, status: "partial" }), false);
  assert.equal(h.runtime.checkpointReadyForContinuation({ ...complete, capReached: true }), false);
  assert.equal(h.runtime.checkpointReadyForContinuation({ ...complete, acceptedCount: 1 }), false);
  assert.equal(h.runtime.checkpointReadyForContinuation({ ...complete, acceptedDigest: "b".repeat(64) }), false);
});

test("only explicit pre-position bypasses the current-clock contact-window verdict", async () => {
  const intents = [];
  const windowAwareRead = ({ row, deliveryIntent }) => {
    intents.push(deliveryIntent);
    return {
      ...row,
      eligibility: deliveryIntent === "preposition"
        ? { ok: true, reason: "contactable-for-preposition", retryable: false }
        : { ok: false, reason: "contact-window-closed", retryable: true },
    };
  };
  const ordinary = harness({
    rows: [sourceRow(1)],
    actionsEnabled: true,
    target: 1,
    refill: 0,
    sourceReadOne: windowAwareRead,
  });
  await ordinary.runtime.ingestOnce();
  assert.equal((await ordinary.runtime.seedAgent("bruce_allen")).accepted, 0);
  assert.equal(ordinary.calls.length, 0);

  const weekend = harness({
    rows: [sourceRow(1)],
    actionsEnabled: true,
    target: 1,
    refill: 0,
    sourceReadOne: windowAwareRead,
  });
  await weekend.runtime.ingestOnce();
  assert.equal((await weekend.runtime.seedAgent("bruce_allen", { preposition: true })).accepted, 1);
  assert.equal(weekend.calls.length, 1);
  assert.deepEqual(intents, ["dial_ready", "preposition"]);
});

test("automatic low-water refill stays contact-window strict after a pre-positioned call", async () => {
  const intents = [];
  const h = harness({
    rows: [sourceRow(1), sourceRow(2), sourceRow(3)],
    actionsEnabled: true,
    refillEnabled: true,
    target: 2,
    refill: 1,
    sourceReadOne({ row, deliveryIntent }) {
      intents.push(deliveryIntent);
      return {
        ...row,
        eligibility: deliveryIntent === "preposition"
          ? { ok: true, reason: "contactable-for-preposition", retryable: false }
          : { ok: false, reason: "contact-window-closed", retryable: true },
      };
    },
  });
  await h.runtime.ingestOnce();
  assert.equal((await h.runtime.seedAgent("bruce_allen", { preposition: true })).accepted, 2);
  const completed = acceptedItems(h.repository)[0];
  addDone(h.repository, completed, 1, "voicemail");
  await h.runtime.drainEvents();

  assert.equal(h.calls.length, 2);
  assert.equal((await h.repository.getAgentById("bruce_allen")).estimatedOutstanding, 1);
  assert.equal(intents.filter((intent) => intent === "preposition").length, 2);
  assert.equal(intents.includes("dial_ready"), true);
});

test("local completion refills before a failing downstream action retries", async () => {
  const h = harness({
    rows: [sourceRow(1), sourceRow(2), sourceRow(3)],
    actionsEnabled: true,
    refillEnabled: true,
    target: 2,
    refill: 1,
    handlers: { logics_dnc: async () => { throw new Error("logics unavailable"); } },
  });
  await ingestAndSeed(h);
  addDone(h.repository, acceptedItems(h.repository)[0], 1, "dnc");
  await h.runtime.drainEvents();
  assert.equal(h.calls.length, 3);
  assert.equal((await h.repository.getAgentById("bruce_allen")).estimatedOutstanding, 2);
  assert.equal(h.repository.events.get("done-1").status, "failed");
});

test("MVP mode treats every identified call end as capacity while only DNC invokes Logics", async () => {
  let dncActions = 0;
  const h = harness({
    rows: [sourceRow(1), sourceRow(2), sourceRow(3)],
    actionsEnabled: true,
    refillEnabled: true,
    target: 1,
    refill: 0,
    handlers: {
      logics_dnc: async () => { dncActions += 1; },
    },
  });
  await ingestAndSeed(h);
  const first = acceptedItems(h.repository)[0];
  addDone(h.repository, first, 1, "something new");
  await h.runtime.drainEvents();
  assert.equal(h.calls.length, 2);
  assert.equal((await h.repository.getItemById(first._id)).state, "follow_up_wait");

  const second = acceptedItems(h.repository).find((item) => item._id !== first._id);
  addDone(h.repository, second, 2, "appointment");
  await h.runtime.drainEvents();
  assert.equal(h.calls.length, 3);
  assert.equal((await h.repository.getItemById(second._id)).state, "terminal");

  const third = acceptedItems(h.repository).find((item) => ![first._id, second._id].includes(item._id));
  addDone(h.repository, third, 3, "bad number");
  await h.runtime.drainEvents();
  assert.equal((await h.repository.getItemById(third._id)).state, "terminal");
  assert.equal(dncActions, 1);
});

test("actions on with refill off never posts automatically and drains review identities to zero", async () => {
  const h = harness({ rows: [sourceRow(1), sourceRow(2)], actionsEnabled: true, target: 2, refill: 1 });
  await ingestAndSeed(h);
  for (const [index, item] of acceptedItems(h.repository).entries()) addDone(h.repository, item, index + 1, "review");
  await h.runtime.drainEvents();
  assert.equal(h.calls.length, 2);
  assert.equal((await h.repository.getAgentById("bruce_allen")).estimatedOutstanding, 0);
  assert.equal([...h.repository.items.values()].every((item) => item.dailyAttemptCount === 1), true);
});

test("duplicate call_done replay is exact-once for attempt and agent decrement", async () => {
  let cadenceWrites = 0;
  let cadenceAction = null;
  const h = harness({
    rows: [sourceRow(1)],
    actionsEnabled: true,
    target: 1,
    refill: 0,
    handlers: {
      record_daily_dial: async (action) => {
        cadenceWrites += 1;
        cadenceAction = action;
      },
    },
  });
  await ingestAndSeed(h);
  const item = acceptedItems(h.repository)[0];
  addDone(h.repository, item, 1, "voicemail", {
    safePayload: { recordingUrl: "https://recordings.example.invalid/call/1.mp3" },
  });
  await h.runtime.drainEvents();
  await h.runtime.drainEvents();
  const completed = await h.repository.getItemById(item._id);
  const agent = await h.repository.getAgentById("bruce_allen");
  assert.equal(completed.dailyAttemptCount, 1);
  assert.equal(completed.totalAttemptCount, 1);
  assert.equal(agent.providerCompletedCount, 1);
  assert.equal(agent.estimatedOutstanding, 0);
  assert.equal(cadenceWrites, 1);
  assert.equal(cadenceAction.dailyAttemptCount, 1);
  assert.equal(cadenceAction.dailyAttemptDateKey, "2026-07-10");
  assert.equal(cadenceAction.recordingUrl, "https://recordings.example.invalid/call/1.mp3");
  const completedEvent = h.repository.events.get("done-1");
  assert.equal(completedEvent.domain, item.domain);
  assert.equal(completedEvent.caseId, item.caseId);
  assert.equal(
    new Date(cadenceAction.completedAt).toISOString(),
    new Date(START.getTime() + 1_000).toISOString(),
  );
});

test("restart after item completion reconstructs the exact agent completion metric", async () => {
  const h = harness({
    rows: [sourceRow(1)],
    actionsEnabled: true,
    target: 1,
    refill: 0,
  });
  await ingestAndSeed(h);
  const accepted = acceptedItems(h.repository)[0];
  const done = addDone(h.repository, accepted, 1, "voicemail");
  const countCompleted = h.repository.countAgentCompletedAttempts.bind(h.repository);
  let processLost = false;
  h.repository.countAgentCompletedAttempts = async (...args) => {
    if (!processLost) {
      processLost = true;
      throw new Error("simulated-process-loss-after-item-completion");
    }
    return countCompleted(...args);
  };

  assert.equal((await h.runtime.drainCapturedEvent(done)).status, "local-failed");
  assert.equal((await h.repository.getItemById(accepted._id)).totalAttemptCount, 1);
  assert.equal((await h.repository.getAgentById("bruce_allen")).providerCompletedCount, 0);

  const failed = h.repository.events.get(done._id);
  failed.status = "pending";
  failed.nextAttemptAt = null;
  failed.version += 1;
  assert.equal((await h.runtime.drainCapturedEvent(copy(failed))).status, "completed");
  assert.equal((await h.repository.getItemById(accepted._id)).totalAttemptCount, 1);
  assert.equal((await h.repository.getAgentById("bruce_allen")).providerCompletedCount, 1);
  const recoveredEvent = h.repository.events.get(done._id);
  assert.equal(recoveredEvent.domain, accepted.domain);
  assert.equal(recoveredEvent.caseId, accepted.caseId);
});

test("non-authoritative low-water cleanup uses the fixed packet and exhausts a smaller queue", async () => {
  const h = harness({ rows: Array.from({ length: 10 }, (_, index) => sourceRow(index + 1)), actionsEnabled: true, refillEnabled: true });
  await ingestAndSeed(h);
  const initial = acceptedItems(h.repository);
  for (let index = 0; index < 4; index += 1) {
    addDone(h.repository, initial[index], index + 1, "review");
    await h.runtime.drainEvents();
  }
  assert.equal(h.calls.length, 9);
  assert.equal((await h.repository.getAgentById("bruce_allen")).estimatedOutstanding, 5);
});

test("DNC downstream retries do not recount local completion", async () => {
  let attempts = 0;
  const h = harness({
    rows: [sourceRow(1)],
    actionsEnabled: true,
    target: 1,
    refill: 0,
    handlers: {
      logics_dnc: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("retry");
      },
    },
  });
  await ingestAndSeed(h);
  const item = acceptedItems(h.repository)[0];
  addDone(h.repository, item, 1, "dnc");
  await h.runtime.drainEvents();
  h.setClock(new Date(START.getTime() + 61_000));
  await h.runtime.drainEvents();
  const completed = await h.repository.getItemById(item._id);
  const agent = await h.repository.getAgentById("bruce_allen");
  assert.equal(attempts, 2);
  assert.equal(completed.dailyAttemptCount, 1);
  assert.equal(agent.providerCompletedCount, 1);
  assert.equal(h.repository.events.get("done-1").status, "completed");
});

test("ambiguous post survives restart and reconciles the same external identity before repost", async () => {
  const h = harness({ rows: [sourceRow(1)], actionsEnabled: true, target: 1, refill: 0 });
  let first = true;
  h.phoneBurner.createContact = async (input) => {
    h.calls.push(copy(input));
    if (first) {
      first = false;
      throw new Error("timeout");
    }
    return { ok: true, status: "accepted", contactId: "contact-reconciled" };
  };
  await h.runtime.ingestOnce();
  await h.runtime.seedAgent("bruce_allen");
  const externalId = h.calls[0].externalLeadId;
  h.setClock(new Date(START.getTime() + 61_000));
  await h.runtime.tick();
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].externalLeadId, externalId);
  assert.equal(h.calls[1].reconcileBeforePost, true);
});

test("completed answered callback may strengthen to DNC but strong outcomes never reopen", () => {
  const common = {
    provider: "phoneburner",
    eventType: "call_done",
    providerCallId: "call-1",
    providerContactId: "contact-1",
    providerExternalLeadId: "external-1",
  };
  const upgrade = buildCapturedEventUpgrade(
    { ...common, status: "completed", normalizedOutcome: "answered" },
    { ...common, status: "pending", normalizedOutcome: "dnc", safePayload: {} },
  );
  assert.equal(upgrade.expected.status, "completed");
  assert.equal(upgrade.set.status, "pending");
  assert.equal(upgrade.set.localAppliedAt, null);
  const localAppliedAt = new Date("2026-07-10T17:05:00.000Z");
  const downstreamAppliedAt = new Date("2026-07-10T17:05:01.000Z");
  const recordingUpgrade = buildCapturedEventUpgrade(
    {
      ...common,
      status: "completed",
      normalizedOutcome: "voicemail",
      localAppliedAt,
      downstreamAppliedAt,
      safePayload: { durationSeconds: 60, recordingUrl: null },
    },
    {
      ...common,
      status: "pending",
      normalizedOutcome: "voicemail",
      safePayload: { recordingUrl: "https://recordings.example.invalid/call/1.mp3" },
    },
  );
  assert.equal(recordingUpgrade.set.status, "pending");
  assert.equal(recordingUpgrade.set.localAppliedAt, localAppliedAt);
  assert.equal(recordingUpgrade.set.downstreamAppliedAt, downstreamAppliedAt);
  assert.equal(recordingUpgrade.set.safePayload.durationSeconds, 60);
  assert.equal(recordingUpgrade.set.safePayload.recordingUrl, "https://recordings.example.invalid/call/1.mp3");
  const identicalRecording = buildCapturedEventUpgrade(
    {
      ...common,
      status: "completed",
      normalizedOutcome: "voicemail",
      safePayload: { recordingUrl: "https://recordings.example.invalid/call/1.mp3" },
    },
    {
      ...common,
      status: "pending",
      normalizedOutcome: "voicemail",
      safePayload: { recordingUrl: "https://recordings.example.invalid/call/1.mp3" },
    },
  );
  assert.equal(identicalRecording, null);
  const conflictingRecording = buildCapturedEventUpgrade(
    {
      ...common,
      status: "completed",
      normalizedOutcome: "voicemail",
      safePayload: { recordingUrl: "https://recordings.example.invalid/call/1.mp3" },
    },
    {
      ...common,
      status: "pending",
      normalizedOutcome: "voicemail",
      safePayload: { recordingUrl: "https://recordings.example.invalid/call/other.mp3" },
    },
  );
  assert.equal(conflictingRecording.set.status, "review");
  assert.equal(conflictingRecording.set.lastError, "recording-evidence-conflict");
  assert.equal(Object.hasOwn(conflictingRecording.set, "safePayload"), false);
  for (const status of ["failed", "processing"]) {
    const retryUpgrade = buildCapturedEventUpgrade(
      {
        ...common,
        status,
        normalizedOutcome: "answered",
        processingLeaseId: status === "processing" ? "weak-lease" : null,
      },
      { ...common, status: "pending", normalizedOutcome: "dnc", safePayload: {} },
    );
    assert.equal(retryUpgrade.expected.status, status);
    assert.equal(retryUpgrade.set.status, "pending");
    assert.equal(retryUpgrade.set.processingLeaseId, null);
    assert.equal(retryUpgrade.set.localAppliedAt, null);
  }
  assert.equal(buildCapturedEventUpgrade(
    { ...common, status: "completed", normalizedOutcome: "dnc" },
    { ...common, status: "pending", normalizedOutcome: "appointment" },
  ), null);
});

test("a failed weak Call End accepts a stronger exact disposition without recounting", async () => {
  let cadenceAttempts = 0;
  let dncActions = 0;
  const h = harness({
    rows: [sourceRow(1)],
    actionsEnabled: true,
    target: 1,
    refill: 0,
    handlers: {
      record_daily_dial: async () => {
        cadenceAttempts += 1;
        if (cadenceAttempts === 1) throw new Error("simulated-weak-action-failure");
      },
      logics_dnc: async () => { dncActions += 1; },
    },
  });
  await ingestAndSeed(h);
  const accepted = acceptedItems(h.repository)[0];
  const weak = addDone(h.repository, accepted, 1, "answered");
  assert.equal((await h.runtime.drainCapturedEvent(weak)).status, "failed");
  const failed = h.repository.events.get(weak._id);
  assert.equal(failed.status, "failed");
  assert.equal((await h.repository.getItemById(accepted._id)).totalAttemptCount, 1);

  const upgrade = buildCapturedEventUpgrade(copy(failed), {
    ...copy(failed),
    status: "pending",
    normalizedOutcome: "dnc",
    safePayload: {},
  });
  assert.ok(upgrade);
  mutate(failed, upgrade);
  assert.equal((await h.runtime.drainCapturedEvent(copy(failed))).status, "completed");

  const after = await h.repository.getItemById(accepted._id);
  assert.equal(after.state, "terminal");
  assert.equal(after.lastOutcome, "dnc");
  assert.equal(after.totalAttemptCount, 1);
  assert.equal((await h.repository.getAgentById("bruce_allen")).providerCompletedCount, 1);
  assert.equal(dncActions, 1);
});

test("answered then DNC on the same call strengthens terminal state without recount", async () => {
  let dncActions = 0;
  const h = harness({
    rows: [sourceRow(1)],
    actionsEnabled: true,
    target: 1,
    refill: 0,
    handlers: { logics_dnc: async () => { dncActions += 1; } },
  });
  await ingestAndSeed(h);
  const accepted = acceptedItems(h.repository)[0];
  addDone(h.repository, accepted, 1, "answered");
  await h.runtime.drainEvents();
  const event = h.repository.events.get("done-1");
  const incoming = { ...copy(event), status: "pending", normalizedOutcome: "dnc", safePayload: {} };
  const upgrade = buildCapturedEventUpgrade(event, incoming);
  mutate(event, upgrade);
  await h.runtime.drainEvents();
  const item = await h.repository.getItemById(accepted._id);
  const agent = await h.repository.getAgentById("bruce_allen");
  assert.equal(item.state, "terminal");
  assert.equal(item.lastOutcome, "dnc");
  assert.equal(item.dailyAttemptCount, 1);
  assert.equal(agent.providerCompletedCount, 1);
  assert.equal(dncActions, 1);
});

test("due follow-up claim uses canonical timer/count while source recheck proves contactability", async () => {
  const due = sourceRow(1, {
    state: "follow_up_wait",
    nextContactAt: new Date(START.getTime() - 1_000),
    dailyAttemptCount: 1,
    lastContactAt: new Date(START.getTime() - 7_200_000),
  });
  const h = harness({ rows: [due], actionsEnabled: true, target: 1, refill: 0 });
  const result = await ingestAndSeed(h);
  assert.equal(result.accepted, 1);
  assert.equal(h.calls.length, 1);
});

test("future follow-up persists and becomes deliverable from canonical storage without source rescanning", async () => {
  const deferred = sourceRow(1, {
    state: "follow_up_wait",
    dailyAttemptCount: 1,
    lastContactAt: new Date(START),
    nextContactAt: new Date(START.getTime() + 120 * 60_000),
  });
  const rows = [deferred];
  const h = harness({
    rows,
    actionsEnabled: true,
    target: 1,
    refill: 0,
    sourceReadOne: () => copy(deferred),
  });
  await h.runtime.ingestOnce();
  const stored = [...h.repository.items.values()][0];
  assert.equal(stored.state, "follow_up_wait");
  assert.equal(stored.sourcePool, POOLS.FOLLOW_UP_DUE);
  assert.equal((await h.runtime.seedAgent("bruce_allen")).accepted, 0);

  rows.splice(0, rows.length);
  h.setClock(new Date(START.getTime() + 120 * 60_000 + 1));
  const due = await h.runtime.seedAgent("bruce_allen");
  assert.equal(due.accepted, 1);
  assert.equal(h.calls.length, 1);
});

test("retryable Call Ends delete the PhoneBurner contact and are reposted when due", async () => {
  const row = sourceRow(1);
  const h = harness({ rows: [row], actionsEnabled: true, target: 1, refill: 0 });
  await ingestAndSeed(h);
  const first = acceptedItems(h.repository)[0];
  const contactId = first.providerContactId;
  addDone(h.repository, first, 1, "voicemail");
  await h.runtime.drainEvents();
  const waiting = await h.repository.getItemById(first._id);
  assert.deepEqual(h.deletes, [contactId]);
  assert.equal(waiting.providerContactId, null);
  assert.equal(waiting.providerExternalLeadId, null);
  assert.equal(waiting.providerCallId, null);
  h.setClock(new Date(START.getTime() + 121 * 60_000));

  const result = await h.runtime.seedAgent("bruce_allen");
  assert.equal(result.accepted, 1);
  const reposted = await h.repository.getItemById(first._id);
  assert.equal(reposted.dailyAttemptCount, 1);
  assert.notEqual(reposted.providerContactId, contactId);
  assert.equal(reposted.providerAttemptSequence, 2);
  assert.equal(h.calls.length, 2);
});

test("terminal provider contact deletion is idempotent when the contact is already absent", async () => {
  const h = harness({
    rows: [sourceRow(1)],
    actionsEnabled: true,
    target: 1,
    refill: 0,
    handlers: { logics_dnc: async () => {} },
  });
  await ingestAndSeed(h);
  const first = acceptedItems(h.repository)[0];
  h.providerContacts.delete(first.providerContactId);
  addDone(h.repository, first, 1, "dnc");
  const result = await h.runtime.drainEvents();
  const waiting = await h.repository.getItemById(first._id);
  assert.equal(result.status, "ok");
  assert.equal(waiting.state, "terminal");
  assert.equal(waiting.providerContactId, null);
});

test("the age-based daily cap deletes a retryable provider contact", async () => {
  const row = sourceRow(1, { dailyAttemptCount: 0, totalAttemptCount: 0 });
  const h = harness({
    rows: [row],
    actionsEnabled: true,
    target: 1,
    refill: 0,
    sourceReadOne: ({ row: current }) => ({
      ...current,
      dailyAttemptCount: 2,
      totalAttemptCount: 2,
    }),
  });
  await ingestAndSeed(h);
  const accepted = acceptedItems(h.repository)[0];
  const contactId = accepted.providerContactId;
  addDone(h.repository, accepted, 1, "voicemail");

  await h.runtime.drainEvents();

  const capped = await h.repository.getItemById(accepted._id);
  assert.equal(capped.dailyAttemptCount, 3);
  assert.equal(capped.state, "follow_up_wait");
  assert.equal(capped.providerContactId, null);
  assert.equal(h.providerContacts.has(contactId), false);
  assert.deepEqual(h.deletes, [contactId]);
});

test("claim-time legacy daily floor prevents a fourth same-day post", async () => {
  const row = sourceRow(1, { dailyAttemptCount: 0 });
  const h = harness({
    rows: [row],
    actionsEnabled: true,
    target: 1,
    refill: 0,
    sourceReadOne: ({ row: current }) => ({ ...current, dailyAttemptCount: 3 }),
  });
  await h.runtime.ingestOnce();
  const result = await h.runtime.seedAgent("bruce_allen");
  assert.equal(result.accepted, 0);
  assert.equal(h.calls.length, 0);
});

test("successful packet claim durably merges the claim-time legacy attempt floor", async () => {
  const row = sourceRow(1, { dailyAttemptCount: 0, totalAttemptCount: 0 });
  const h = harness({
    rows: [row],
    actionsEnabled: true,
    target: 1,
    refill: 0,
    sourceReadOne: ({ row: current }) => ({
      ...current,
      dailyAttemptCount: 2,
      totalAttemptCount: 5,
    }),
  });
  await h.runtime.ingestOnce();
  assert.equal((await h.runtime.seedAgent("bruce_allen")).accepted, 1);
  const claimed = [...h.repository.items.values()][0];
  assert.equal(claimed.dailyAttemptDateKey, "2026-07-10");
  assert.equal(claimed.dailyAttemptCount, 2);
  assert.equal(claimed.totalAttemptCount, 5);
});

test("a fresher claim-time voice touch moves the canonical timer forward instead of posting", async () => {
  const row = sourceRow(1, {
    state: "follow_up_wait",
    dailyAttemptCount: 1,
    lastContactAt: new Date(START.getTime() - 120 * 60_000),
    nextContactAt: new Date(START.getTime() - 1_000),
  });
  const fresherLast = new Date(START.getTime() - 5 * 60_000);
  const fresherDue = new Date(fresherLast.getTime() + 120 * 60_000);
  const h = harness({
    rows: [row],
    actionsEnabled: true,
    target: 1,
    refill: 0,
    sourceReadOne: ({ row: current }) => ({
      ...current,
      dailyAttemptCount: 2,
      lastContactAt: fresherLast,
      nextContactAt: fresherDue,
    }),
  });
  await h.runtime.ingestOnce();
  assert.equal((await h.runtime.seedAgent("bruce_allen")).accepted, 0);
  const held = [...h.repository.items.values()][0];
  assert.equal(held.state, "follow_up_wait");
  assert.equal(new Date(held.nextContactAt).toISOString(), fresherDue.toISOString());
  assert.equal(held.dailyAttemptCount, 2);
  assert.equal(h.calls.length, 0);
});

test("reconciliation treats a deleted completed contact as zero physical outstanding", async () => {
  const h = harness({ rows: [sourceRow(1)], actionsEnabled: true, target: 1, refill: 0 });
  await ingestAndSeed(h);
  const accepted = acceptedItems(h.repository)[0];
  addDone(h.repository, accepted, 1, "voicemail");
  await h.runtime.drainEvents();
  h.phoneBurner.listFolderContacts = async (folderId) => ({
    ok: true,
    folderId,
    page: 1,
    pageSize: 0,
    totalPages: 0,
    totalResults: 0,
    contacts: [],
  });
  const result = await h.runtime.reconcileAgent("bruce_allen");
  assert.equal(result.status, "reconciled");
  assert.equal(result.estimatedOutstanding, 0);
});

test("five simultaneous agent fills share one paced provider lane and wait without item leases", async () => {
  const agentIds = ["bruce_allen", "phil_olson", "sean_lucas", "brad_hansen", "chris_bolt"];
  const configuration = config({ target: 5, refill: 1 });
  const template = copy(configuration.agents["bruce_allen"]);
  configuration.agents = Object.fromEntries(agentIds.map((agentId, index) => [agentId, {
    ...copy(template),
    enabled: true,
    displayName: `Agent ${index + 1}`,
    distributionFolderId: `pool-${index + 1}`,
    receivingFolderId: `consumer-${index + 1}`,
  }]));
  let providerClock = 0;
  const requestedSleeps = [];
  const starts = [];
  let activePosts = 0;
  let maxActivePosts = 0;
  let releaseFirstPost;
  let markFirstPostStarted;
  const firstPostStarted = new Promise((resolve) => {
    markFirstPostStarted = resolve;
  });
  const firstPostGate = new Promise((resolve) => {
    releaseFirstPost = resolve;
  });
  const h = harness({
    rows: Array.from({ length: 25 }, (_, index) => sourceRow(index + 1)),
    actionsEnabled: true,
    configuration,
    providerPostMinimumIntervalMs: 6_000,
    providerPostClock: () => providerClock,
    providerPostSleep: async (delayMs) => {
      requestedSleeps.push(delayMs);
      providerClock += delayMs;
    },
  });
  let first = true;
  h.phoneBurner.createContact = async (input) => {
    h.calls.push(copy(input));
    starts.push(providerClock);
    activePosts += 1;
    maxActivePosts = Math.max(maxActivePosts, activePosts);
    if (first) {
      first = false;
      markFirstPostStarted();
      await firstPostGate;
    } else {
      await new Promise((resolve) => setImmediate(resolve));
    }
    activePosts -= 1;
    return { ok: true, status: "accepted", contactId: `contact-${h.calls.length}` };
  };

  await h.runtime.start();
  await h.runtime.stop();
  [...h.repository.items.values()].forEach((item, index) => {
    item.state = "eligible";
    item.reservedAgentId = agentIds[Math.floor(index / 5)];
    item.reservationReason = "test-agent-partition";
  });
  const previews = await Promise.all(agentIds.map((agentId) => h.runtime.previewAgent(agentId)));
  assert.deepEqual(previews.map((preview) => preview.recipe.items.length), [5, 5, 5, 5, 5]);
  const fills = Promise.all(agentIds.map((agentId) => h.runtime.seedAgent(agentId)));
  await firstPostStarted;
  await new Promise((resolve) => setImmediate(resolve));
  const waitingItems = [...h.repository.items.values()].filter((item) => item.state === "packetized");
  assert.equal(waitingItems.filter((item) => item.providerPostLeaseId).length, 1);
  assert.equal(waitingItems.some((item) => !item.providerPostLeaseId), true);
  releaseFirstPost();
  const results = await fills;

  assert.equal(results.reduce((sum, result) => sum + result.accepted, 0), 25);
  assert.equal(h.calls.length, 25);
  assert.equal(maxActivePosts, 1);
  assert.equal(starts.every((startedAt, index) => index === 0 || startedAt - starts[index - 1] >= 6_000), true);
  assert.equal(requestedSleeps.filter((delayMs) => delayMs >= 6_000).length, 24);
  assert.deepEqual({
    concurrency: h.runtime.getState().providerPostConcurrency,
    interval: h.runtime.getState().providerPostMinimumIntervalMs,
    queued: h.runtime.getState().providerPostQueueDepth,
    inFlight: h.runtime.getState().providerPostInFlight,
    starts: h.runtime.getState().providerPostStarts,
  }, { concurrency: 1, interval: 6_000, queued: 0, inFlight: 0, starts: 25 });
});

test("provider 429 preserves the exact item for a cooled retry instead of terminal failure", async () => {
  let providerClock = 0;
  const sleeps = [];
  const h = harness({
    rows: [sourceRow(1)],
    actionsEnabled: true,
    target: 1,
    refill: 0,
    providerPostMinimumIntervalMs: 3_000,
    providerPostClock: () => providerClock,
    providerPostSleep: async (delayMs) => {
      sleeps.push(delayMs);
      providerClock += delayMs;
    },
  });
  let attempts = 0;
  h.phoneBurner.createContact = async (input) => {
    h.calls.push(copy(input));
    attempts += 1;
    return attempts === 1
      ? { ok: false, status: "rate_limited", reason: "rate_limited", retryAfterMs: 7_000 }
      : { ok: true, status: "accepted", contactId: "contact-after-cooldown" };
  };

  await h.runtime.ingestOnce();
  const limited = await h.runtime.seedAgent("bruce_allen");
  const held = [...h.repository.items.values()][0];
  assert.equal(limited.results[0].status, "rate-limited");
  assert.equal(held.state, "packetized");
  assert.equal(held.providerPostState, "prepared");
  assert.equal(held.providerPostLeaseId, null);
  assert.equal(h.runtime.getState().providerPostRateLimited, 1);
  const externalId = held.providerExternalLeadId;

  assert.equal(sleeps.includes(30_000), false);
  providerClock = 30_000;
  const retryTick = await h.runtime.tick();
  const accepted = [...h.repository.items.values()][0];
  assert.equal(retryTick.status, "ok");
  assert.equal(h.calls.length, 2);
  assert.equal(accepted.state, "provider_accepted");
  assert.equal(accepted.providerExternalLeadId, externalId);
  assert.equal(h.calls[1].externalLeadId, externalId);
  assert.equal(h.runtime.getState().providerPostCooldownUntil, null);
});

test("automatic packet recovery never claims a refill deficit while refill is off", async () => {
  const h = harness({
    rows: Array.from({ length: 5 }, (_, index) => sourceRow(index + 1)),
    actionsEnabled: true,
    refillEnabled: false,
    target: 5,
    refill: 1,
  });
  await h.runtime.start();
  await h.runtime.stop();
  const agent = await h.repository.getAgentById("bruce_allen");
  await h.repository.compareAndSetAgent({
    agentId: "bruce_allen",
    expectedVersion: agent.version,
    set: {
      shiftEnabled: true,
      activeUntil: new Date(START.getTime() + 30 * 60_000),
    },
  });
  const stranded = [...h.repository.items.values()][0];
  stranded.state = "packetized";
  stranded.deliveryAgentId = "bruce_allen";
  stranded.packetId = "packet-before-restart";
  stranded.provider = "phoneburner";

  // The subject of this test is the TITLE, not a delivery count: recovery must
  // not open a refill claim while refill is off. It used to also assert that
  // the tick delivered ONLY the stranded packet — but immediate-fresh delivery
  // is deliberately independent of the refill flag (refill is the callback-
  // driven top-up; fresh rows flow to an active shift on their own), so a tick
  // that recovers the packet AND delivers the four fresh eligible rows is the
  // intended behaviour, not a deficit claim.
  const refillClaims = [];
  const originalAcquireRefill = h.repository.acquireRefillRequest.bind(h.repository);
  h.repository.acquireRefillRequest = async (input) => {
    refillClaims.push(copy(input));
    return originalAcquireRefill(input);
  };

  await h.runtime.tick();
  assert.equal(refillClaims.length, 0,
    "recovery with refill OFF must never open a refill claim — the title's whole point");
  assert.equal(h.calls.length, 5, "the stranded packet plus the four fresh rows");
  assert.equal(acceptedItems(h.repository).length, 5);
  assert.equal([...h.repository.items.values()].filter((item) => item.state === "eligible").length, 0);
  const recoveredAgent = await h.repository.getAgentById("bruce_allen");
  assert.equal(recoveredAgent.openRefillRequest, false, "and no refill request may be left open");
});

test("automatic recover-only posting heals a failed pre-position without inventing shift activity", async () => {
  let providerClock = 0;
  const h = harness({
    rows: [sourceRow(1)],
    actionsEnabled: true,
    refillEnabled: false,
    target: 1,
    refill: 0,
    providerPostClock: () => providerClock,
    providerPostSleep: async (delayMs) => { providerClock += delayMs; },
  });
  let attempts = 0;
  h.phoneBurner.createContact = async (input) => {
    h.calls.push(copy(input));
    attempts += 1;
    return attempts === 1
      ? { ok: false, status: "rate_limited", reason: "rate_limited" }
      : { ok: true, status: "accepted", contactId: "contact-preposition-recovered" };
  };

  await h.runtime.ingestOnce();
  const limited = await h.runtime.seedAgent("bruce_allen", { preposition: true });
  assert.equal(limited.status, "provider-backpressure");
  assert.equal((await h.repository.getAgentById("bruce_allen")).shiftEnabled, false);
  providerClock = 30_000;
  await h.runtime.seedAgent("bruce_allen", { preposition: true });

  assert.equal(acceptedItems(h.repository).length, 1);
  assert.equal((await h.repository.getAgentById("bruce_allen")).shiftEnabled, false);
});

test("paced callback refill ownership uses the five-minute processing lease budget", async () => {
  const h = harness({
    rows: [sourceRow(1), sourceRow(2)],
    actionsEnabled: true,
    refillEnabled: true,
    target: 1,
    refill: 0,
  });
  await ingestAndSeed(h);
  const accepted = acceptedItems(h.repository)[0];
  addDone(h.repository, accepted, 1, "voicemail");
  let observedEventLeaseMs = null;
  let observedRefillLeaseMs = null;
  const acquireEvent = h.repository.acquireEventProcessingLease.bind(h.repository);
  const acquireRefill = h.repository.acquireRefillRequest.bind(h.repository);
  h.repository.acquireEventProcessingLease = async (input) => {
    observedEventLeaseMs = input.leaseMs;
    return acquireEvent(input);
  };
  h.repository.acquireRefillRequest = async (input) => {
    observedRefillLeaseMs = input.leaseMs;
    return acquireRefill(input);
  };

  await h.runtime.drainEvents();
  assert.equal(observedEventLeaseMs, 300_000);
  assert.equal(observedRefillLeaseMs, 300_000);
  assert.equal(acceptedItems(h.repository).length, 1);
});

test("production callback drain completes its event after durable packetization, not provider latency", async () => {
  const h = harness({
    rows: [sourceRow(1), sourceRow(2)],
    actionsEnabled: true,
    refillEnabled: true,
    target: 1,
    refill: 0,
  });
  await ingestAndSeed(h);
  const initial = acceptedItems(h.repository)[0];
  addDone(h.repository, initial, 1, "voicemail");
  let markProviderStarted;
  let releaseProvider;
  const providerStarted = new Promise((resolve) => { markProviderStarted = resolve; });
  const providerGate = new Promise((resolve) => { releaseProvider = resolve; });
  h.phoneBurner.createContact = async (input) => {
    h.calls.push(copy(input));
    markProviderStarted();
    await providerGate;
    return { ok: true, status: "accepted", contactId: "contact-background-refill" };
  };

  const drain = h.runtime.drainEvents({ waitForRefillCompletion: false });
  await providerStarted;
  const drained = await drain;
  assert.equal(drained.results[0].status, "completed");
  assert.equal(Object.hasOwn(drained.results[0], "deferredRefillAgentId"), false);
  assert.equal(Object.hasOwn(drained.results[0], "deferredFreshDispatch"), false);
  assert.equal(h.repository.events.get("done-1").status, "completed");
  assert.equal((await h.repository.getAgentById("bruce_allen")).openRefillRequest, false);
  assert.equal(h.runtime.getState().backgroundRefillCount, 1);
  assert.equal([...h.repository.items.values()].filter((item) => item.providerPostLeaseId).length, 1);

  releaseProvider();
  await h.runtime.stop();
  assert.equal(h.runtime.getState().backgroundRefillCount, 0);
  assert.equal(acceptedItems(h.repository).length, 1);
});

test("partial refill keeps one durable owner while provider work is outstanding", async () => {
  const rows = [sourceRow(1), sourceRow(2)];
  const h = harness({
    rows,
    actionsEnabled: true,
    refillEnabled: true,
    target: 5,
    refill: 1,
  });
  await ingestAndSeed(h);
  const initial = acceptedItems(h.repository);
  assert.equal(initial.length, 2);
  rows.push(sourceRow(3));
  await h.runtime.ingestOnce();
  addDone(h.repository, initial[0], 1, "review");
  addDone(h.repository, initial[1], 2, "review");
  let markProviderStarted;
  let releaseProvider;
  const providerStarted = new Promise((resolve) => { markProviderStarted = resolve; });
  const providerGate = new Promise((resolve) => { releaseProvider = resolve; });
  h.phoneBurner.createContact = async (input) => {
    h.calls.push(copy(input));
    markProviderStarted();
    await providerGate;
    return { ok: true, status: "accepted", contactId: "contact-partial-refill" };
  };

  const drain = h.runtime.drainEvents({ waitForRefillCompletion: false });
  await drain;
  await providerStarted;
  assert.equal(h.repository.events.get("done-1").status, "completed");
  assert.equal(h.repository.events.get("done-2").status, "completed");
  assert.equal(h.calls.length, 3);
  assert.equal((await h.repository.getAgentById("bruce_allen")).openRefillRequest, true);
  assert.equal(h.runtime.getState().backgroundRefillCount, 1);

  await h.runtime.tick();
  assert.equal(h.calls.length, 3);
  assert.equal(h.runtime.getState().providerPostQueueDepth, 0);

  releaseProvider();
  await h.runtime.stop();
  assert.equal((await h.repository.getAgentById("bruce_allen")).openRefillRequest, false);
});

test("a coalesced hangup schedules one exact refill recompute after the active refill", async () => {
  const rows = [sourceRow(1), sourceRow(2)];
  const h = harness({
    rows,
    actionsEnabled: true,
    refillEnabled: true,
    target: 2,
    refill: 1,
  });
  await ingestAndSeed(h);
  const initial = acceptedItems(h.repository);
  rows.push(sourceRow(3), sourceRow(4));
  await h.runtime.ingestOnce();
  addDone(h.repository, initial[0], 1, "review");
  addDone(h.repository, initial[1], 2, "review");
  let markFirstRefillStarted;
  let releaseFirstRefill;
  const firstRefillStarted = new Promise((resolve) => { markFirstRefillStarted = resolve; });
  const firstRefillGate = new Promise((resolve) => { releaseFirstRefill = resolve; });
  let refillPosts = 0;
  h.phoneBurner.createContact = async (input) => {
    h.calls.push(copy(input));
    refillPosts += 1;
    if (refillPosts === 1) {
      markFirstRefillStarted();
      await firstRefillGate;
    }
    return { ok: true, status: "accepted", contactId: `contact-coalesced-${refillPosts}` };
  };

  const drain = h.runtime.drainEvents({ waitForRefillCompletion: false });
  await firstRefillStarted;
  await drain;
  assert.equal(h.calls.length, 3);
  releaseFirstRefill();
  for (let attempt = 0; attempt < 20 && h.calls.length < 4; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.equal(h.calls.length, 4);
  assert.equal(acceptedItems(h.repository).length, 2);
  assert.equal(h.runtime.getState().backgroundRefillCount, 0);
  await h.runtime.stop();
});

test("automatic refill reclaims an expired durable refill owner after restart", async () => {
  const rows = [sourceRow(1)];
  const h = harness({
    rows,
    actionsEnabled: true,
    refillEnabled: true,
    target: 5,
    refill: 1,
  });
  await ingestAndSeed(h);
  const agent = await h.repository.getAgentById("bruce_allen");
  await h.repository.compareAndSetAgent({
    agentId: "bruce_allen",
    expectedVersion: agent.version,
    set: {
      openRefillRequest: true,
      refillRequestId: "stale-refill-owner",
      refillLeaseExpiresAt: new Date(START.getTime() - 1),
    },
  });
  rows.push(sourceRow(2), sourceRow(3), sourceRow(4), sourceRow(5));
  await h.runtime.ingestOnce();

  await h.runtime.tick();
  assert.equal(acceptedItems(h.repository).length, 5);
  assert.equal((await h.repository.getAgentById("bruce_allen")).openRefillRequest, false);
});

test("durable provider slot uses one PII-free lane key and is held through pacing", async () => {
  let providerClock = 0;
  const acquisitions = [];
  const extensions = [];
  const releases = [];
  const sleeps = [];
  const h = harness({
    rows: [sourceRow(1)],
    actionsEnabled: true,
    target: 1,
    refill: 0,
    providerPostMinimumIntervalMs: 3_000,
    providerPostClock: () => providerClock,
    providerPostSleep: async (delayMs) => {
      sleeps.push(delayMs);
      providerClock += delayMs;
    },
    acquireProviderPostSlot: async (request) => {
      acquisitions.push(copy(request));
      return { token: "slot-token" };
    },
    extendProviderPostSlot: async (request) => {
      extensions.push(copy(request));
      return request.slot;
    },
    releaseProviderPostSlot: async (request) => {
      releases.push(copy(request));
    },
  });

  await ingestAndSeed(h);
  assert.deepEqual(acquisitions, [{
    laneKey: "lead-delivery:phoneburner:contact-post",
    leaseMs: 300_000,
  }]);
  assert.deepEqual(releases, [{
    laneKey: "lead-delivery:phoneburner:contact-post",
    slot: { token: "slot-token" },
  }]);
  assert.deepEqual(extensions, []);
  assert.equal(sleeps.includes(3_000), true);
  assert.equal(JSON.stringify(h.runtime.getState()).includes("pool-bruce"), false);
});

test("Retry-After extends the durable lane without holding the refill caller open", async () => {
  let providerClock = 0;
  const acquisitions = [];
  const extensions = [];
  const releases = [];
  const sleeps = [];
  const h = harness({
    rows: [sourceRow(1)],
    actionsEnabled: true,
    target: 1,
    refill: 0,
    providerPostMinimumIntervalMs: 3_000,
    providerPostClock: () => providerClock,
    providerPostSleep: async (delayMs) => {
      sleeps.push(delayMs);
      providerClock += delayMs;
    },
    acquireProviderPostSlot: async (request) => {
      acquisitions.push(copy(request));
      return { token: `slot-${acquisitions.length}` };
    },
    extendProviderPostSlot: async (request) => {
      extensions.push(copy(request));
      return request.slot;
    },
    releaseProviderPostSlot: async (request) => {
      releases.push(copy(request));
    },
  });
  let providerAttempts = 0;
  h.phoneBurner.createContact = async (input) => {
    h.calls.push(copy(input));
    providerAttempts += 1;
    return providerAttempts === 1
      ? { ok: false, status: "rate_limited", reason: "rate_limited", retryAfterMs: 3_600_000 }
      : { ok: true, status: "accepted", contactId: "contact-after-retry-after" };
  };

  await h.runtime.ingestOnce();
  const limited = await h.runtime.seedAgent("bruce_allen");
  assert.equal(limited.status, "provider-backpressure");
  assert.equal(acquisitions.length, 1);
  assert.equal(extensions.length, 1);
  assert.equal(extensions[0].leaseMs, 3_600_000);
  assert.equal(releases.length, 0);
  assert.equal(sleeps.includes(3_600_000), false);

  const stillCooling = await h.runtime.seedAgent("bruce_allen");
  assert.equal(stillCooling.status, "provider-backpressure");
  assert.equal(acquisitions.length, 1);
  assert.equal(h.calls.length, 1);

  providerClock = 3_600_000;
  const retried = await h.runtime.seedAgent("bruce_allen");
  assert.equal(retried.accepted, 1);
  assert.equal(acquisitions.length, 2);
  assert.equal(releases.length, 1);
  assert.equal(h.runtime.getState().providerPostCircuitOpen, false);
});

test("a long provider turn renews its durable mutex before the crash lease expires", async () => {
  let heartbeat = null;
  let heartbeatDelay = null;
  let cleared = 0;
  const scheduler = {
    setInterval(work, delayMs) {
      heartbeat = work;
      heartbeatDelay = delayMs;
      return { unref() {} };
    },
    clearInterval() { cleared += 1; },
  };
  const extensions = [];
  const releases = [];
  let markProviderStarted;
  let releaseProvider;
  const providerStarted = new Promise((resolve) => { markProviderStarted = resolve; });
  const providerGate = new Promise((resolve) => { releaseProvider = resolve; });
  const h = harness({
    rows: [sourceRow(1)],
    actionsEnabled: true,
    target: 1,
    refill: 0,
    scheduler,
    acquireProviderPostSlot: async () => ({ token: "slot-original" }),
    extendProviderPostSlot: async (request) => {
      extensions.push(copy(request));
      return { token: "slot-renewed" };
    },
    releaseProviderPostSlot: async (request) => {
      releases.push(copy(request));
    },
  });
  h.phoneBurner.createContact = async () => {
    markProviderStarted();
    await providerGate;
    return { ok: true, status: "accepted", contactId: "contact-long-turn" };
  };

  await h.runtime.ingestOnce();
  const seed = h.runtime.seedAgent("bruce_allen");
  await providerStarted;
  heartbeat();
  await new Promise((resolve) => setImmediate(resolve));
  releaseProvider();
  await seed;

  assert.equal(heartbeatDelay, 60_000);
  assert.equal(extensions.length, 1);
  assert.equal(extensions[0].leaseMs, 300_000);
  assert.equal(cleared, 1);
  assert.equal(releases[0].slot.token, "slot-renewed");
  assert.equal(h.runtime.getState().providerPostCircuitOpen, false);
});

test("lost durable mutex renewal opens the provider circuit and leaves queued work packetized", async () => {
  let heartbeat = null;
  const scheduler = {
    setInterval(work) {
      heartbeat = work;
      return { unref() {} };
    },
    clearInterval() {},
  };
  let markProviderStarted;
  let releaseProvider;
  const providerStarted = new Promise((resolve) => { markProviderStarted = resolve; });
  const providerGate = new Promise((resolve) => { releaseProvider = resolve; });
  const h = harness({
    rows: [sourceRow(1), sourceRow(2)],
    actionsEnabled: true,
    target: 2,
    refill: 0,
    scheduler,
    acquireProviderPostSlot: async () => ({ token: "slot-lost" }),
    extendProviderPostSlot: async () => null,
    releaseProviderPostSlot: async () => {
      throw new Error("lost slots must expire rather than release");
    },
  });
  h.phoneBurner.createContact = async (input) => {
    h.calls.push(copy(input));
    markProviderStarted();
    await providerGate;
    return { ok: true, status: "accepted", contactId: "contact-before-slot-loss" };
  };

  await h.runtime.ingestOnce();
  const seed = h.runtime.seedAgent("bruce_allen");
  await providerStarted;
  heartbeat();
  await new Promise((resolve) => setImmediate(resolve));
  releaseProvider();
  const result = await seed;

  assert.equal(result.status, "provider-backpressure");
  assert.equal(h.calls.length, 1);
  assert.equal(h.runtime.getState().providerPostCircuitOpen, true);
  assert.equal([...h.repository.items.values()].filter((item) => item.state === "packetized").length, 1);
});

test("one failed lane turn does not poison later durable packet recovery", async () => {
  const h = harness({
    rows: [sourceRow(1), sourceRow(2)],
    actionsEnabled: true,
    target: 2,
    refill: 0,
  });
  await h.runtime.ingestOnce();
  const getItemById = h.repository.getItemById.bind(h.repository);
  let failOnce = true;
  h.repository.getItemById = async (itemId) => {
    if (failOnce) {
      failOnce = false;
      throw new Error("synthetic repository interruption");
    }
    return getItemById(itemId);
  };

  await assert.rejects(h.runtime.seedAgent("bruce_allen"), /synthetic repository interruption/);
  const recovered = await h.runtime.seedAgent("bruce_allen");
  assert.equal(recovered.accepted, 2);
  assert.equal(h.calls.length, 2);
  assert.equal(acceptedItems(h.repository).length, 2);
  assert.equal(h.runtime.getState().providerPostQueueDepth, 0);
  assert.equal(h.runtime.getState().providerPostInFlight, 0);
});

test("drainCapturedEvent leases and processes only the supplied exact event", async () => {
  const h = harness({
    rows: [sourceRow(1), sourceRow(2)],
    actionsEnabled: true,
    target: 2,
    refill: 0,
  });
  await ingestAndSeed(h);
  const [first, second] = acceptedItems(h.repository);
  const firstEvent = addDone(h.repository, first, 1, "voicemail");
  const secondEvent = addDone(h.repository, second, 2, "voicemail");
  const leasedIds = [];
  const acquire = h.repository.acquireEventProcessingLease.bind(h.repository);
  h.repository.acquireEventProcessingLease = async (input) => {
    leasedIds.push(input.eventId);
    return acquire(input);
  };

  const result = await h.runtime.drainCapturedEvent(secondEvent);

  assert.deepEqual(leasedIds, [secondEvent._id]);
  assert.equal(result.seen, 1);
  assert.equal(result.processed, 1);
  assert.equal(Object.hasOwn(result.results[0], "deferredRefillAgentId"), false);
  assert.equal(Object.hasOwn(result.results[0], "deferredFreshDispatch"), false);
  assert.equal(h.repository.events.get(secondEvent._id).status, "completed");
  assert.equal(h.repository.events.get(firstEvent._id).status, "pending");
  assert.equal((await h.repository.getItemById(second._id)).state, "follow_up_wait");
  assert.equal((await h.repository.getItemById(first._id)).state, "provider_accepted");
});

test("a delayed call_begin cannot resurrect a completed provider attempt", async (t) => {
  for (const [outcome, expectedState] of [
    ["voicemail", "follow_up_wait"],
    ["dnc", "terminal"],
  ]) {
    await t.test(expectedState, async () => {
      const h = harness({
        rows: [sourceRow(1)],
        actionsEnabled: true,
        target: 1,
        refill: 0,
        handlers: { logics_dnc: async () => {} },
      });
      await ingestAndSeed(h);
      const accepted = acceptedItems(h.repository)[0];
      const identity = {
        providerContactId: accepted.providerContactId,
        providerExternalLeadId: accepted.providerExternalLeadId,
      };
      addDone(h.repository, accepted, 1, outcome, { providerCallId: "call-completed" });
      await h.runtime.drainEvents();
      const beforePresence = await h.repository.getItemById(accepted._id);
      const completedCount = (await h.repository.getAgentById("bruce_allen")).providerCompletedCount;
      const lateBegin = h.repository.addEvent({
        _id: `late-begin-${expectedState}`,
        eventType: "call_begin",
        providerCallId: "call-completed",
        ...identity,
        normalizedOutcome: null,
        receivedAt: new Date(START.getTime() + 2_000),
      });

      await h.runtime.drainCapturedEvent(lateBegin);

      const afterPresence = await h.repository.getItemById(accepted._id);
      assert.equal(afterPresence.state, expectedState);
      assert.equal(afterPresence.version, beforePresence.version);
      assert.equal(afterPresence.activeAttempt, beforePresence.activeAttempt);
      assert.equal(h.repository.events.get(lateBegin._id).status, "completed");
      assert.equal(
        (await h.repository.getAgentById("bruce_allen")).providerCompletedCount,
        completedCount,
      );
    });
  }
});

test("an old Call End cannot mutate or delete a newer provider attempt", async () => {
  const h = harness({
    rows: [sourceRow(1)],
    actionsEnabled: true,
    target: 1,
    refill: 0,
    handlers: { logics_dnc: async () => {} },
  });
  await ingestAndSeed(h);
  const firstAttempt = acceptedItems(h.repository)[0];
  const oldIdentity = {
    providerContactId: firstAttempt.providerContactId,
    providerExternalLeadId: firstAttempt.providerExternalLeadId,
  };
  addDone(h.repository, firstAttempt, 1, "voicemail", { providerCallId: "call-first" });
  await h.runtime.drainEvents();
  h.setClock("2026-07-11T00:30:00.000Z");
  assert.equal((await h.runtime.runEndOfDayFolderDrain()).status, "completed");
  h.setClock("2026-07-13T14:50:00.000Z");
  assert.equal((await h.runtime.launchAgent("bruce_allen")).accepted, 1);
  const newerAttempt = await h.repository.getItemById(firstAttempt._id);
  const newerContactId = newerAttempt.providerContactId;
  const newerExternalId = newerAttempt.providerExternalLeadId;
  const deletesBefore = [...h.deletes];
  const oldCallEnd = h.repository.addEvent({
    _id: "late-old-call-end",
    providerCallId: "call-first",
    ...oldIdentity,
    normalizedOutcome: "voicemail",
    receivedAt: new Date("2026-07-13T14:51:00.000Z"),
  });

  const result = await h.runtime.drainCapturedEvent(oldCallEnd);

  const afterOldEvent = await h.repository.getItemById(firstAttempt._id);
  assert.equal(result.status, "review");
  assert.equal(h.repository.events.get(oldCallEnd._id).status, "review");
  assert.equal(afterOldEvent.state, "provider_accepted");
  assert.equal(afterOldEvent.providerAttemptSequence, 2);
  assert.equal(afterOldEvent.providerContactId, newerContactId);
  assert.equal(afterOldEvent.providerExternalLeadId, newerExternalId);
  assert.deepEqual(h.deletes, deletesBefore);
  assert.equal(h.providerContacts.has(newerContactId), true);
});

test("provider-authoritative low-water uses pool only and fails closed until repeated pool counts agree", async () => {
  const h = harness({
    rows: [sourceRow(1), sourceRow(2), sourceRow(3)],
    actionsEnabled: true,
    refillEnabled: true,
    providerInventoryAuthoritative: true,
    target: 2,
    refill: 1,
  });
  await ingestAndSeed(h);
  assert.equal(h.calls.length, 2);
  let totals = [0, 1];
  let countReads = 0;
  h.phoneBurner.getFolderCount = async (folderId) => {
    countReads += 1;
    return { ok: true, folderId, count: totals.shift() };
  };

  const unstable = await h.runtime.refreshAgentCapacity("bruce_allen");

  assert.equal(unstable.status, "folder-count-unstable");
  assert.equal(countReads, 2);
  assert.equal(h.calls.length, 2);
  assert.equal((await h.repository.getAgentById("bruce_allen")).estimatedOutstanding, 2);

  totals = [1, 1];
  const stable = await h.runtime.refreshAgentCapacity("bruce_allen");

  assert.equal(stable.status, "queue-exhausted");
  assert.equal(countReads, 4);
  assert.equal(h.calls.length, 3);
  assert.equal((await h.repository.getAgentById("bruce_allen")).estimatedOutstanding, 2);
});

test("simple bulk packet excludes new-today and fills only from later pools", async () => {
  const newToday = [1, 2, 3].map((number) => sourceRow(number, {
    receivedAt: new Date(`2026-07-10T16:0${number}:00.000Z`),
  }));
  const overnight = [4, 5, 6, 7, 8].map((number) => sourceRow(number));
  const rows = [];
  const h = harness({ rows, actionsEnabled: true });
  await h.runtime.start();
  await h.runtime.stop();
  rows.push(...newToday, ...overnight);
  await h.runtime.ingestOnce();

  const result = await h.runtime.postTopOfQueue("bruce_allen", { count: 5 });

  assert.equal(result.status, "posted");
  assert.equal(result.accepted, 5);
  const posted = acceptedItems(h.repository);
  assert.equal(posted.filter((item) => item.sourcePool === POOLS.NEW_TODAY).length, 0);
  assert.equal(posted.filter((item) => item.sourcePool !== POOLS.NEW_TODAY).length, 5);
});

test("simple bulk packet posts zero-touch work before a due retry from another pool", async () => {
  const rows = [];
  const h = harness({ rows, actionsEnabled: true });
  await h.runtime.start();
  await h.runtime.stop();
  rows.push(
    sourceRow(8601, {
      receivedAt: new Date("2026-07-09T17:00:00.000Z"),
    }),
    sourceRow(8602, {
      receivedAt: new Date("2026-07-10T15:00:00.000Z"),
      totalAttemptCount: 1,
      lastContactAt: new Date("2026-07-10T16:00:00.000Z"),
    }),
  );
  await h.repository.insertActiveItemOnce({
    ...rows[0],
    sourcePool: POOLS.OLDER_AVAILABLE,
    state: "eligible",
    version: 0,
  });
  await h.repository.insertActiveItemOnce({
    ...rows[1],
    sourcePool: POOLS.FOLLOW_UP_DUE,
    state: "follow_up_wait",
    nextContactAt: new Date("2026-07-10T17:00:00.000Z"),
    version: 0,
  });

  const result = await h.runtime.postTopOfQueue("bruce_allen", { count: 1 });

  assert.equal(result.status, "posted");
  assert.equal(result.accepted, 1);
  const posted = acceptedItems(h.repository);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].caseId, "8601");
  assert.equal(posted[0].totalAttemptCount, 0);
});

test("durable agent Pool operation blocks an overlapping ordinary refill", async () => {
  const h = harness({
    rows: [],
    actionsEnabled: true,
    refillEnabled: true,
  });
  await h.runtime.tick();
  const agent = await h.repository.getAgentById("bruce_allen");
  await h.repository.compareAndSetAgent({
    agentId: "bruce_allen",
    expectedVersion: agent.version,
    set: {
      poolOperationId: "other-worker",
      poolOperationKind: "productivity",
      poolOperationLeaseExpiresAt: new Date(START.getTime() + 60_000),
      poolOperationStartedAt: START,
    },
  });
  await h.repository.insertActiveItemOnce({
    ...sourceRow(8801, { receivedAt: new Date("2026-06-01T17:00:00.000Z") }),
    sourcePool: POOLS.OLDER_AVAILABLE,
    state: "eligible",
    activeAttempt: true,
    version: 0,
  });
  const before = h.calls.length;
  const result = await h.runtime.postTopOfQueue("bruce_allen", { count: 1 });
  assert.equal(result.status, "pool-operation-busy");
  assert.equal(h.calls.length, before);
});

test("ordinary refill completes while productivity waits for the same agent Pool", async () => {
  const configuration = fiveAgentConfig();
  for (const [agentId, policy] of Object.entries(configuration.agents)) {
    policy.enabled = ["bruce_allen", "brad_hansen"].includes(agentId);
  }
  const h = harness({
    rows: [],
    actionsEnabled: true,
    refillEnabled: true,
    configuration,
    productivityRebalanceEnabled: true,
  });
  await h.runtime.tick();
  for (let index = 0; index < 6; index += 1) {
    await h.repository.insertActiveItemOnce({
      ...sourceRow(8803 + index, { receivedAt: new Date("2026-06-01T17:00:00.000Z") }),
      sourcePool: POOLS.OLDER_AVAILABLE,
      state: "eligible",
      activeAttempt: true,
      version: 0,
    });
  }

  let releaseActivityRead;
  let activityReadStarted;
  const activityRead = new Promise((resolve) => { activityReadStarted = resolve; });
  const activityGate = new Promise((resolve) => { releaseActivityRead = resolve; });
  let firstActivityRead = true;
  h.repository.countAgentCompletedAttemptsSince = async (agentId) => {
    if (firstActivityRead) {
      firstActivityRead = false;
      activityReadStarted();
      await activityGate;
    }
    return agentId === "brad_hansen" ? 1 : 0;
  };

  let releaseProviderPost;
  let providerPostStarted;
  const providerPost = new Promise((resolve) => { providerPostStarted = resolve; });
  const providerGate = new Promise((resolve) => { releaseProviderPost = resolve; });
  const createContact = h.phoneBurner.createContact.bind(h.phoneBurner);
  h.phoneBurner.createContact = async (input) => {
    providerPostStarted();
    await providerGate;
    return createContact(input);
  };

  const rebalance = h.runtime.runProductivityRebalance(START, { ignoreWarmup: true });
  await activityRead;
  const refill = h.runtime.postTopOfQueue("bruce_allen", { count: 1 });
  await Promise.race([
    providerPost,
    new Promise((_, reject) => setTimeout(() => reject(new Error("refill-waited-on-productivity")), 250)),
  ]);

  releaseActivityRead();
  releaseProviderPost();
  const [refillResult, rebalanceResult] = await Promise.race([
    Promise.all([refill, rebalance]),
    new Promise((_, reject) => setTimeout(() => reject(new Error("refill-productivity-deadlock")), 1_000)),
  ]);
  assert.equal(refillResult.status, "posted");
  assert.equal(refillResult.accepted, 1);
  assert.equal(rebalanceResult.status, "completed");
});
test("immediate fresh skips a Pool-locked agent without spending its fair turn", async () => {
  const h = harness({
    rows: [],
    actionsEnabled: true,
    refillEnabled: true,
    configuration: fiveAgentConfig(),
  });
  await h.runtime.tick();
  for (const agentId of ["bruce_allen", "brad_hansen"]) {
    const agent = await h.repository.getAgentById(agentId);
    await h.repository.compareAndSetAgent({
      agentId,
      expectedVersion: agent.version,
      set: {
        shiftEnabled: true,
        activeUntil: new Date(START.getTime() + 60_000),
        lastProviderEvidenceAt: START,
        ...(agentId === "bruce_allen" ? {
          poolOperationId: "productivity-worker",
          poolOperationKind: "productivity",
          poolOperationLeaseExpiresAt: new Date(START.getTime() + 60_000),
          poolOperationStartedAt: START,
        } : {}),
      },
    });
  }
  await h.repository.insertActiveItemOnce({
    ...sourceRow(8802, { receivedAt: START }),
    sourcePool: POOLS.NEW_TODAY,
    state: "eligible",
    activeAttempt: true,
    version: 0,
  });
  const result = await h.runtime.dispatchImmediateFresh();
  assert.equal(result.accepted, 1);
  const delivered = await h.repository.findItemBySourceIdentity({ domain: "TAG", caseId: "8802" });
  assert.equal(delivered.deliveryAgentId, "brad_hansen");
  const cursor = await h.repository.getOrCreateFairPickCursor("fresh", {
    agentOrder: Object.keys(fiveAgentConfig().agents),
  });
  assert.equal(cursor.lastPickedAgentId, "brad_hansen");
});

test("simple packet explicitly holds an age-capped due row without posting it", async () => {
  const row = sourceRow(1, {
    receivedAt: new Date("2026-07-08T17:00:00.000Z"),
    dailyAttemptDateKey: "2026-07-10",
    dailyAttemptCount: 1,
    totalAttemptCount: 1,
    lastContactAt: new Date(START.getTime() - 3 * 60 * 60_000),
    nextContactAt: new Date(START.getTime() - 1_000),
  });
  const h = harness({ rows: [row], actionsEnabled: true });
  await h.runtime.ingestOnce();
  const due = [...h.repository.items.values()][0];
  await h.repository.compareAndSetItem({
    itemId: due._id,
    expectedVersion: due.version,
    expected: { state: "follow_up_wait" },
    set: { dailyAttemptCount: 2, totalAttemptCount: 2 },
  });

  const result = await h.runtime.postTopOfQueue("bruce_allen", { count: 1 });
  const held = [...h.repository.items.values()][0];
  assert.equal(result.accepted, 0);
  assert.equal(held.state, "follow_up_wait");
  assert.equal(held.sourcePool, POOLS.FOLLOW_UP_DUE);
  assert.equal(held.nextContactAt, null);
  assert.equal(held.reservationReason, "daily-attempt-limit");
  assert.equal(h.calls.length, 0);
});

test("source refresh cannot restore a same-day timer after the item reaches its age cap", async () => {
  const row = sourceRow(1, {
    receivedAt: new Date("2026-07-08T17:00:00.000Z"),
    dailyAttemptDateKey: "2026-07-10",
    dailyAttemptCount: 1,
    totalAttemptCount: 1,
    lastContactAt: new Date(START.getTime() - 3 * 60 * 60_000),
    nextContactAt: new Date(START.getTime() - 1_000),
  });
  const h = harness({ rows: [row], actionsEnabled: true });
  await h.runtime.ingestOnce();
  const due = [...h.repository.items.values()][0];
  await h.repository.compareAndSetItem({
    itemId: due._id,
    expectedVersion: due.version,
    expected: { state: "follow_up_wait" },
    set: { dailyAttemptCount: 2, totalAttemptCount: 2, nextContactAt: null },
  });

  await h.runtime.ingestOnce();

  const refreshed = [...h.repository.items.values()][0];
  assert.equal(refreshed.dailyAttemptCount, 2);
  assert.equal(refreshed.nextContactAt, null);
  assert.equal((await h.runtime.postTopOfQueue("bruce_allen", { count: 1 })).accepted, 0);
  assert.equal(h.calls.length, 0);
});

test("a capped pending ordinary post is held instead of retried", async () => {
  const row = sourceRow(1, {
    receivedAt: new Date("2026-07-08T17:00:00.000Z"),
    dailyAttemptDateKey: "2026-07-10",
    dailyAttemptCount: 1,
    totalAttemptCount: 1,
    lastContactAt: new Date(START.getTime() - 3 * 60 * 60_000),
    nextContactAt: new Date(START.getTime() - 1_000),
  });
  const h = harness({ rows: [row], actionsEnabled: true });
  await h.runtime.ingestOnce();
  const due = [...h.repository.items.values()][0];
  await h.repository.compareAndSetItem({
    itemId: due._id,
    expectedVersion: due.version,
    expected: { state: "follow_up_wait" },
    set: {
      state: "packetized",
      dailyAttemptCount: 2,
      totalAttemptCount: 2,
      packetId: "pending-capped-packet",
      deliveryAgentId: "bruce_allen",
      reservationReason: "top-of-queue-post",
    },
  });

  const result = await h.runtime.postTopOfQueue("bruce_allen", { count: 1 });
  const held = [...h.repository.items.values()][0];
  assert.equal(result.accepted, 0);
  assert.equal(held.state, "follow_up_wait");
  assert.equal(held.nextContactAt, null);
  assert.equal(held.reservationReason, "daily-attempt-limit");
  assert.equal(h.calls.length, 0);
});

test("a capped pending immediate-fresh post is held instead of retried", async () => {
  const row = sourceRow(1, {
    receivedAt: new Date(START.getTime() - 60_000),
  });
  const h = harness({ rows: [row], actionsEnabled: true });
  await h.runtime.ingestOnce();
  const fresh = [...h.repository.items.values()][0];
  await h.repository.compareAndSetItem({
    itemId: fresh._id,
    expectedVersion: fresh.version,
    expected: { state: "eligible" },
    set: {
      state: "packetized",
      dailyAttemptDateKey: "2026-07-10",
      dailyAttemptCount: 3,
      totalAttemptCount: 3,
      packetId: "pending-capped-fresh",
      deliveryAgentId: "bruce_allen",
      reservationReason: "immediate-fresh",
    },
  });

  const result = await h.runtime.dispatchImmediateFresh();
  const held = [...h.repository.items.values()][0];
  assert.equal(result.accepted, 0);
  assert.equal(held.state, "follow_up_wait");
  assert.equal(held.nextContactAt, null);
  assert.equal(held.reservationReason, "daily-attempt-limit");
  assert.equal(h.calls.length, 0);
});

test("simple bulk packet leaves unassigned fresh work untouched", async () => {
  const configuration = config({ target: 2, refill: 0 });
  configuration.agents.phil_olson.enabled = true;
  const rows = [];
  const h = harness({ rows, actionsEnabled: true, configuration });
  await h.runtime.start();
  await h.runtime.stop();
  rows.push(
    sourceRow(1, { receivedAt: new Date(START) }),
    sourceRow(2),
    sourceRow(3),
  );
  await h.runtime.ingestOnce();
  const fresh = [...h.repository.items.values()]
    .find((item) => item.sourcePool === POOLS.NEW_TODAY);
  assert.equal(fresh.state, "eligible");
  assert.equal(fresh.reservedAgentId, null);

  const result = await h.runtime.postTopOfQueue("bruce_allen", { count: 2 });

  assert.equal(result.accepted, 2);
  assert.equal(acceptedItems(h.repository).every((item) => item.sourcePool !== POOLS.NEW_TODAY), true);
  const untouchedFresh = await h.repository.getItemById(fresh._id);
  assert.equal(untouchedFresh.state, "eligible");
  assert.equal(untouchedFresh.reservedAgentId, null);
});

test("simple packet retries one unresolved provider post before claiming another lead", async () => {
  const h = harness({ rows: [sourceRow(1), sourceRow(2)], actionsEnabled: true });
  await h.runtime.ingestOnce();
  const createContact = h.phoneBurner.createContact.bind(h.phoneBurner);
  let attempts = 0;
  h.phoneBurner.createContact = async (input) => {
    attempts += 1;
    if (attempts === 1) return { ok: false, status: "acceptance_unknown", reason: "test-timeout" };
    return createContact(input);
  };

  const first = await h.runtime.postTopOfQueue("bruce_allen", { count: 1 });
  assert.equal(first.status, "pending-provider-post");
  assert.equal(first.accepted, 0);
  assert.equal([...h.repository.items.values()].filter((item) => item.state === "packetized").length, 1);

  const second = await h.runtime.postTopOfQueue("bruce_allen", { count: 1 });
  assert.equal(second.status, "posted");
  assert.equal(second.accepted, 1);
  assert.equal(attempts, 2);
  assert.equal(acceptedItems(h.repository).length, 1);
  assert.equal([...h.repository.items.values()].filter((item) => item.state === "eligible").length, 1);
});

test("simple packet does not claim queue rows after the delivery window closes", async () => {
  const h = harness({
    rows: [sourceRow(1)],
    actionsEnabled: true,
    deliveryWindowEvaluator: () => false,
  });
  await h.runtime.ingestOnce();

  const result = await h.runtime.postTopOfQueue("bruce_allen", { count: 1 });

  assert.equal(result.status, "delivery-window-closed");
  assert.equal(result.accepted, 0);
  assert.equal([...h.repository.items.values()][0].state, "eligible");
  assert.equal(h.calls.length, 0);
});

test("simple Call End keeps its durable event retryable when the Pool count fails", async () => {
  const h = harness({
    rows: [sourceRow(1), sourceRow(2), sourceRow(3)],
    actionsEnabled: true,
    refillEnabled: true,
    providerInventoryAuthoritative: true,
    target: 1,
    refill: 0,
  });
  await ingestAndSeed(h);
  const completed = acceptedItems(h.repository)[0];
  const event = addDone(h.repository, completed, 1, "voicemail");
  const getFolderCount = h.phoneBurner.getFolderCount.bind(h.phoneBurner);
  h.phoneBurner.getFolderCount = async () => ({ ok: false, reason: "test-count-failed" });

  await h.runtime.drainEvents();

  assert.equal(h.repository.events.get(event._id).status, "failed");
  assert.equal(h.repository.events.get(event._id).lastError, "downstream-action-failed");
  assert.equal(h.calls.length, 1);

  h.phoneBurner.getFolderCount = getFolderCount;
  h.setClock(new Date(START.getTime() + 10 * 60_000));
  await h.runtime.drainEvents();

  assert.equal(h.repository.events.get(event._id).status, "completed");
  assert.equal(h.calls.length, 3);
});

test("provider-authoritative simple Call End refills when Pool reaches exactly five", async () => {
  const h = harness({
    rows: Array.from({ length: 20 }, (_, index) => sourceRow(index + 1)),
    actionsEnabled: true,
    refillEnabled: true,
    providerInventoryAuthoritative: true,
    deliveryWindowEvaluator: () => true,
    legacyOperatorSurfaceEnabled: false,
    simpleOperatorDirectAccessEnabled: false,
  });
  h.setClock("2026-07-10T14:50:00.000Z");
  const started = await h.runtime.tick();
  assert.equal(started.dayStart.status, "completed");
  assert.equal(h.calls.length, 20);
  await insertEligibleRows(
    h.repository,
    Array.from({ length: 20 }, (_, index) => sourceRow(index + 21)),
  );

  const initial = acceptedItems(h.repository).slice(0, 20);
  const completed = initial[0];
  const retained = new Set(initial.slice(1, 6).map((item) => item.providerContactId));
  for (const contactId of [...h.providerContacts.keys()]) {
    if (!retained.has(contactId)) h.providerContacts.delete(contactId);
  }
  assert.equal(h.providerContacts.size, 5);

  let poolReads = 0;
  const getFolderCount = h.phoneBurner.getFolderCount.bind(h.phoneBurner);
  h.phoneBurner.getFolderCount = async (...args) => {
    poolReads += 1;
    return getFolderCount(...args);
  };
  const event = addDone(h.repository, completed, 1, "voicemail");
  await h.runtime.drainCapturedEvent(event);

  assert.equal(h.repository.events.get(event._id).status, "completed");
  assert.equal(h.calls.length, 40);
  assert.equal(h.providerContacts.size, 25);
  assert.equal(poolReads, 2);
});

test("physical Pool watchdog restores an empty active-agent Pool without a Call End", async () => {
  const h = harness({
    rows: Array.from({ length: 20 }, (_, index) => sourceRow(index + 1)),
    actionsEnabled: true,
    refillEnabled: true,
    providerInventoryAuthoritative: true,
    deliveryWindowEvaluator: () => true,
    legacyOperatorSurfaceEnabled: false,
    simpleOperatorDirectAccessEnabled: false,
  });
  h.setClock("2026-07-10T14:50:00.000Z");
  const started = await h.runtime.tick();
  assert.equal(started.dayStart.status, "completed");
  assert.equal(h.calls.length, 20);
  await insertEligibleRows(
    h.repository,
    Array.from({ length: 20 }, (_, index) => sourceRow(index + 21)),
  );

  h.providerContacts.clear();
  h.setClock("2026-07-10T14:51:00.000Z");
  const repaired = await h.runtime.tick();

  assert.equal(h.calls.length, 40);
  assert.equal(h.providerContacts.size, 20);
  assert.equal(repaired.automatic.length, 1);
  assert.equal(repaired.automatic[0].trigger, "physical_pool_watchdog");
  assert.equal(repaired.automatic[0].physicalCount, 0);
});

test("physical Pool watchdog refreshes bounded canonical supply and refills on the next tick", async () => {
  const rows = Array.from({ length: 20 }, (_, index) => ({
    ...sourceRow(index + 1),
    receivedAt: new Date("2026-07-01T17:00:00.000Z"),
  }));
  const h = harness({
    rows,
    actionsEnabled: true,
    refillEnabled: true,
    providerInventoryAuthoritative: true,
    deliveryWindowEvaluator: () => true,
    legacyOperatorSurfaceEnabled: false,
    simpleOperatorDirectAccessEnabled: false,
  });
  h.setClock("2026-07-10T14:50:00.000Z");
  const started = await h.runtime.tick();
  assert.equal(started.dayStart.status, "completed");
  assert.equal(h.calls.length, 20);

  h.providerContacts.clear();
  rows.push(...Array.from({ length: 20 }, (_, index) => ({
    ...sourceRow(index + 21),
    receivedAt: new Date("2026-07-02T17:00:00.000Z"),
  })));
  h.setClock("2026-07-10T14:51:00.000Z");
  const refreshStarted = await h.runtime.tick();
  assert.match(refreshStarted.automatic[0].status, /^supply-refresh-/);
  for (let attempt = 0; attempt < 20 && h.runtime.getState().watchdogSupplyRefresh.inFlight; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const repaired = await h.runtime.tick();

  assert.equal(h.calls.length, 40);
  assert.equal(h.providerContacts.size, 20);
  assert.equal(repaired.automatic.length, 1);
  assert.equal(repaired.automatic[0].status, "posted");
  assert.equal(repaired.automatic[0].accepted, 20);
  assert.equal(h.runtime.getState().watchdogSupplyRefresh.status, "completed");
});

test("physical Pool supply refresh does not recycle unresolved review attempts", async () => {
  const rows = Array.from({ length: 20 }, (_, index) => ({
    ...sourceRow(index + 1),
    receivedAt: new Date("2026-07-01T17:00:00.000Z"),
  }));
  const h = harness({
    rows,
    actionsEnabled: true,
    refillEnabled: true,
    providerInventoryAuthoritative: true,
    deliveryWindowEvaluator: () => true,
    legacyOperatorSurfaceEnabled: false,
    simpleOperatorDirectAccessEnabled: false,
  });
  h.setClock("2026-07-10T14:50:00.000Z");
  await h.runtime.tick();
  assert.equal(h.calls.length, 20);

  rows.push(...Array.from({ length: 20 }, (_, index) => ({
    ...sourceRow(index + 21),
    receivedAt: new Date("2026-07-02T17:00:00.000Z"),
  })));
  await h.runtime.ingestOnce();
  for (const item of h.repository.items.values()) {
    if (Number(item.caseId) <= 20) continue;
    item.state = "review";
    item.lastOutcome = "review";
    item.totalAttemptCount = 1;
    item.activeAttempt = true;
    item.providerContactId = null;
  }
  h.providerContacts.clear();
  h.setClock("2026-07-10T14:51:00.000Z");
  const result = await h.runtime.tick();
  for (let attempt = 0; attempt < 20 && h.runtime.getState().watchdogSupplyRefresh.inFlight; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.equal(h.calls.length, 20);
  assert.equal(result.automatic.length, 1);
  assert.match(result.automatic[0].status, /^supply-refresh-/);
  assert.equal(result.automatic[0].accepted, 0);
  assert.equal(h.runtime.getState().watchdogSupplyRefresh.status, "completed");
});

test("physical Pool starvation refreshes status evidence and reclassifies the exact blocked leads", async () => {
  const rows = Array.from({ length: 20 }, (_, index) => sourceRow(index + 1));
  let statusRefreshCalls = 0;
  const h = harness({
    rows,
    actionsEnabled: true,
    refillEnabled: true,
    providerInventoryAuthoritative: true,
    deliveryWindowEvaluator: () => true,
    legacyOperatorSurfaceEnabled: false,
    simpleOperatorDirectAccessEnabled: false,
    refreshSourceStatuses: async () => {
      statusRefreshCalls += 1;
      const refreshedIdentities = [];
      for (const row of rows) {
        if (Number(row.caseId) <= 20) continue;
        row.eligibility = { ok: true };
        refreshedIdentities.push({ domain: row.domain, caseId: row.caseId });
      }
      return { refreshed: refreshedIdentities.length, failed: 0, refreshedIdentities };
    },
  });
  h.setClock("2026-07-10T14:50:00.000Z");
  await h.runtime.tick();
  assert.equal(h.calls.length, 20);

  rows.push(...Array.from({ length: 20 }, (_, index) => sourceRow(index + 21)));
  await h.runtime.ingestOnce();
  for (const row of rows) {
    if (Number(row.caseId) > 20) {
      row.eligibility = { ok: false, reason: "status-freshness-unproven" };
    }
  }
  await h.runtime.ingestOnce();
  assert.equal(
    [...h.repository.items.values()].filter((item) => item.state === "blocked").length,
    20,
  );
  h.providerContacts.clear();
  h.setClock("2026-07-10T14:51:00.000Z");
  const started = await h.runtime.tick();
  assert.match(started.automatic[0].status, /^supply-refresh-/);
  for (let attempt = 0; attempt < 40 && h.runtime.getState().watchdogSupplyRefresh.inFlight; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const state = h.runtime.getState().watchdogSupplyRefresh;
  assert.equal(statusRefreshCalls, 1);
  assert.equal(state.status, "completed");
  assert.equal(state.statusRefreshed, 20);
  assert.equal(state.statusFailed, 0);
  assert.equal(state.statusReclassified, 20);
  assert.equal(state.statusReevaluated, 20);
  assert.equal(state.statusStillBlocked, 0);

  const repaired = await h.runtime.tick();
  assert.equal(repaired.automatic[0].status, "posted");
  assert.equal(repaired.automatic[0].accepted, 20);
  assert.equal(h.providerContacts.size, 20);
});

test("physical Pool status-refresh failure remains background-safe and posts nothing", async () => {
  const h = harness({
    rows: [],
    actionsEnabled: true,
    refillEnabled: true,
    providerInventoryAuthoritative: true,
    deliveryWindowEvaluator: () => true,
    legacyOperatorSurfaceEnabled: false,
    simpleOperatorDirectAccessEnabled: false,
    refreshSourceStatuses: async () => {
      const error = new Error("status-api-unavailable");
      error.code = "STATUS_API_UNAVAILABLE";
      throw error;
    },
  });
  h.setClock("2026-07-10T14:50:00.000Z");
  await h.runtime.tick();
  h.setClock("2026-07-10T14:51:00.000Z");
  const started = await h.runtime.tick();
  assert.match(started.automatic[0].status, /^supply-refresh-/);
  for (let attempt = 0; attempt < 20 && h.runtime.getState().watchdogSupplyRefresh.inFlight; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(h.runtime.getState().watchdogSupplyRefresh.status, "failed");
  assert.equal(h.calls.length, 0);
  assert.equal(h.providerContacts.size, 0);
});

test("physical Pool watchdog refills before a later ingestion failure aborts the tick", async () => {
  const h = harness({
    rows: Array.from({ length: 20 }, (_, index) => sourceRow(index + 1)),
    actionsEnabled: true,
    refillEnabled: true,
    providerInventoryAuthoritative: true,
    deliveryWindowEvaluator: () => true,
    legacyOperatorSurfaceEnabled: false,
    simpleOperatorDirectAccessEnabled: false,
  });
  h.setClock("2026-07-10T14:50:00.000Z");
  const started = await h.runtime.tick();
  assert.equal(started.dayStart.status, "completed");
  assert.equal(h.calls.length, 20);
  await insertEligibleRows(
    h.repository,
    Array.from({ length: 20 }, (_, index) => sourceRow(index + 21)),
  );

  h.providerContacts.clear();
  h.source.readBatch = async () => {
    const error = new Error("later-stage-source-failure");
    error.code = "SOURCE_UNAVAILABLE";
    throw error;
  };
  h.setClock("2026-07-10T14:51:00.000Z");

  await assert.rejects(h.runtime.tick(), { code: "SOURCE_UNAVAILABLE" });
  assert.equal(h.calls.length, 40);
  assert.equal(h.providerContacts.size, 20);
});

test("physical Pool watchdog does not refill an operator-paused agent", async () => {
  const h = harness({
    rows: Array.from({ length: 20 }, (_, index) => sourceRow(index + 1)),
    actionsEnabled: true,
    refillEnabled: true,
    providerInventoryAuthoritative: true,
    deliveryWindowEvaluator: () => true,
  });
  h.setClock("2026-07-10T14:50:00.000Z");
  await h.runtime.tick();
  h.providerContacts.clear();
  const agent = await h.repository.getAgentById("bruce_allen");
  await h.repository.compareAndSetAgent({
    agentId: "bruce_allen",
    expectedVersion: agent.version,
    set: { operatorPaused: true, shiftEnabled: false },
  });
  h.setClock("2026-07-10T14:51:00.000Z");
  const paused = await h.runtime.tick();
  assert.equal(h.calls.length, 20);
  assert.deepEqual(paused.automatic, []);
});
test("automated day lifecycle builds before open, starts once at 7:50, drains results, stops at 5, and closes at 5:30", async () => {
  let untouchedRefreshes = 0;
  const h = harness({
    rows: Array.from({ length: 25 }, (_, index) => sourceRow(index + 1)),
    actionsEnabled: true,
    refillEnabled: true,
    providerInventoryAuthoritative: true,
    deliveryWindowEvaluator: isPacificDeliveryWindowOpen,
    refreshUntouchedSourceStatuses: async () => {
      untouchedRefreshes += 1;
      return { scanned: 25, refreshed: 25, eligible: 25, blocked: 0 };
    },
  });

  h.setClock("2026-07-10T14:49:00.000Z");
  const beforeOpen = await h.runtime.tick();
  assert.equal(beforeOpen.tickMode, "preopen_event_drain");
  assert.equal(beforeOpen.dayStart, undefined);
  assert.equal(h.calls.length, 0);

  h.setClock("2026-07-10T14:50:00.000Z");
  const opened = await h.runtime.tick();
  assert.equal(opened.dayStart.status, "completed");
  assert.equal(opened.dayStart.queueBuild.status, "ready");
  assert.equal(opened.dayStart.queueBuild.fullScan, true);
  assert.equal(opened.dayStart.morningStatusRefresh.status, "completed");
  assert.equal(untouchedRefreshes, 1);
  assert.equal(h.calls.length, 25);
  const startedAgent = await h.repository.getAgentById("bruce_allen");
  assert.equal(startedAgent.operatorPaused, false);
  assert.equal(startedAgent.shiftEnabled, true);
  assert.equal(startedAgent.metadata.simpleDayStart.status, "completed");

  h.setClock("2026-07-10T14:51:00.000Z");
  const secondTick = await h.runtime.tick();
  assert.equal(secondTick.dayStart.status, "already-completed");
  assert.equal(untouchedRefreshes, 1);
  assert.equal(h.calls.length, 25);

  const completed = acceptedItems(h.repository)[0];
  h.providerContacts.delete(completed.providerContactId);
  const event = addDone(h.repository, completed, 1, "voicemail", {
    receivedAt: new Date("2026-07-10T23:59:00.000Z"),
  });
  h.setClock("2026-07-10T23:59:00.000Z");
  const finalMinute = await h.runtime.tick();
  assert.equal(finalMinute.events.processed, 1);
  assert.equal(h.repository.events.get(event._id).status, "completed");
  assert.equal(h.calls.length, 25);

  h.setClock("2026-07-11T00:00:00.000Z");
  const closed = await h.runtime.tick();
  assert.equal(closed.tickMode, "postwindow_event_drain");
  assert.equal(closed.dayStart, undefined);
  assert.equal(h.calls.length, 25);

  h.setClock("2026-07-11T00:30:00.000Z");
  const drained = await h.runtime.tick();
  assert.equal(drained.endOfDayDrain.status, "completed");
  assert.equal(h.providerContacts.size, 0);
});

test("off-hours Call End completes without source, folder-capacity, refill, or fresh work", async () => {
  const h = harness({
    rows: Array.from({ length: 30 }, (_, index) => sourceRow(index + 1)),
    actionsEnabled: true,
    refillEnabled: true,
    providerInventoryAuthoritative: true,
    deliveryWindowEvaluator: isPacificDeliveryWindowOpen,
  });
  h.setClock("2026-07-10T14:50:00.000Z");
  await h.runtime.tick();
  const completed = acceptedItems(h.repository)[0];
  const event = addDone(h.repository, completed, 88, "voicemail", {
    receivedAt: new Date("2026-07-11T00:00:00.000Z"),
  });
  let sourceReads = 0;
  let folderReads = 0;
  const readBatch = h.source.readBatch.bind(h.source);
  const getFolderCount = h.phoneBurner.getFolderCount.bind(h.phoneBurner);
  h.source.readBatch = async (input) => { sourceReads += 1; return readBatch(input); };
  h.phoneBurner.getFolderCount = async (folderId) => {
    folderReads += 1;
    return getFolderCount(folderId);
  };
  const providerPostsBefore = h.calls.length;

  h.setClock("2026-07-11T00:00:00.000Z");
  const result = await h.runtime.tick();

  assert.equal(result.tickMode, "postwindow_event_drain");
  assert.equal(result.events.processed, 1);
  assert.equal(h.repository.events.get(event._id).status, "completed");
  assert.equal(sourceReads, 0);
  assert.equal(folderReads, 0);
  assert.equal(h.calls.length, providerPostsBefore);
  assert.equal(h.runtime.getState().sourceReadsSkippedOffHours, 1);
});

test("actions-disabled off-hours tick does not query the event backlog", async () => {
  const h = harness({
    rows: [sourceRow(1)],
    actionsEnabled: false,
    refillEnabled: false,
    deliveryWindowEvaluator: isPacificDeliveryWindowOpen,
  });
  let drainReads = 0;
  const listEventsForDrain = h.repository.listEventsForDrain.bind(h.repository);
  h.repository.listEventsForDrain = async (input) => {
    drainReads += 1;
    return listEventsForDrain(input);
  };
  h.setClock("2026-07-10T10:00:00.000Z");

  const result = await h.runtime.tick();

  assert.equal(result.tickMode, "preopen_event_drain");
  assert.equal(result.events.status, "actions-disabled");
  assert.equal(drainReads, 0);
});

test("late recording evidence updates the exact ledger attempt without replaying call effects", async () => {
  let cadenceWrites = 0;
  let dncWrites = 0;
  const h = harness({
    rows: [sourceRow(1)],
    actionsEnabled: true,
    target: 1,
    refill: 0,
    handlers: {
      record_daily_dial: async () => { cadenceWrites += 1; },
      logics_dnc: async () => { dncWrites += 1; },
    },
  });
  await ingestAndSeed(h);
  const item = acceptedItems(h.repository)[0];
  addDone(h.repository, item, 1, "dnc");
  await h.runtime.drainEvents();

  const afterInitial = await h.repository.getItemById(item._id);
  const initialAgent = await h.repository.getAgentById("bruce_allen");
  const initialDeletes = h.deletes.length;
  const persisted = h.repository.events.get("done-1");
  const upgrade = buildCapturedEventUpgrade(copy(persisted), {
    ...copy(persisted),
    status: "pending",
    safePayload: {
      ...(persisted.safePayload || {}),
      recordingUrl: "https://recordings.example.invalid/call/late.mp3",
    },
  });
  assert.ok(upgrade);
  mutate(persisted, upgrade);

  assert.equal((await h.runtime.drainCapturedEvent(copy(persisted))).status, "completed");
  const afterUpgrade = await h.repository.getItemById(item._id);
  const upgradedAgent = await h.repository.getAgentById("bruce_allen");
  assert.equal(cadenceWrites, 2, "only the exact DailyDial projection is replayed");
  assert.equal(dncWrites, 1, "DNC side effect is not replayed");
  assert.equal(h.deletes.length, initialDeletes, "provider cleanup is not replayed");
  assert.equal(afterUpgrade.totalAttemptCount, afterInitial.totalAttemptCount);
  assert.equal(afterUpgrade.dailyAttemptCount, afterInitial.dailyAttemptCount);
  assert.equal(upgradedAgent.providerCompletedCount, initialAgent.providerCompletedCount);
  assert.equal(upgradedAgent.estimatedOutstanding, initialAgent.estimatedOutstanding);
});

test("weekday off-hours matrix remains source-dark before open and before close", async () => {
  const cases = [
    ["2026-07-10T10:00:00.000Z", "preopen_event_drain"], // 03:00 PT
    ["2026-07-10T14:49:00.000Z", "preopen_event_drain"], // 07:49 PT
    ["2026-07-11T00:00:00.000Z", "postwindow_event_drain"], // 17:00 PT
    ["2026-07-11T00:29:00.000Z", "postwindow_event_drain"], // 17:29 PT
  ];
  for (const [at, expectedMode] of cases) {
    const h = harness({
      rows: [sourceRow(1)],
      actionsEnabled: false,
      refillEnabled: false,
      deliveryWindowEvaluator: isPacificDeliveryWindowOpen,
    });
    let sourceReads = 0;
    const readBatch = h.source.readBatch.bind(h.source);
    h.source.readBatch = async (input) => { sourceReads += 1; return readBatch(input); };
    h.setClock(at);
    const result = await h.runtime.tick();
    assert.equal(result.tickMode, expectedMode, at);
    assert.equal(sourceReads, 0, at);
    assert.equal(h.calls.length, 0, at);
  }
});

test("a completed 17:30 close uses the same-process fast path at 22:30", async () => {
  const h = harness({
    rows: [],
    actionsEnabled: true,
    refillEnabled: false,
    deliveryWindowEvaluator: isPacificDeliveryWindowOpen,
  });
  let sourceReads = 0;
  const readBatch = h.source.readBatch.bind(h.source);
  h.source.readBatch = async (input) => { sourceReads += 1; return readBatch(input); };
  h.setClock("2026-07-11T00:30:00.000Z");
  const closed = await h.runtime.tick();
  assert.equal(closed.tickMode, "close_due");
  assert.equal(closed.endOfDayDrain.status, "completed");
  h.setClock("2026-07-11T05:30:00.000Z");
  const later = await h.runtime.tick();
  assert.equal(later.tickMode, "close_complete_event_drain");
  assert.equal(later.endOfDayDrain, undefined);
  assert.equal(sourceReads, 0);
});

test("day start builds the full untouched source and distributes it evenly across five agents", async () => {
  const h = harness({
    rows: Array.from({ length: 1_000 }, (_, index) => sourceRow(index + 1)),
    actionsEnabled: true,
    refillEnabled: true,
    providerInventoryAuthoritative: true,
    configuration: fiveAgentConfig(),
    deliveryWindowEvaluator: isPacificDeliveryWindowOpen,
  });
  h.setClock("2026-07-10T14:50:00.000Z");
  let sourceReads = 0;
  const readBatch = h.source.readBatch.bind(h.source);
  h.source.readBatch = async (input) => {
    sourceReads += 1;
    return readBatch(input);
  };

  const opened = await h.runtime.tick();

  assert.equal(opened.dayStart.status, "completed");
  assert.equal(opened.dayStart.queueBuild.status, "ready");
  assert.equal(opened.dayStart.queueBuild.fullScan, true);
  assert.equal(opened.dayStart.queueBuild.done, true);
  assert.equal(sourceReads, 4);
  assert.equal(h.calls.length, 1_000);
  for (let index = 1; index <= 5; index += 1) {
    assert.equal(
      [...h.providerContacts.values()].filter((contact) => contact.folderId === `pool-${index}`).length,
      200,
    );
  }
  assert.equal(h.runtime.getState().sourceDone, true);
});

test("day start continues after an all-held page advances the repair cursor", async () => {
  const row = { ...sourceRow(1), createdAt: new Date("2026-07-10T14:40:00.000Z") };
  const h = harness({
    rows: [row],
    durableSourceState: true,
    actionsEnabled: true,
    refillEnabled: true,
    providerInventoryAuthoritative: true,
    configuration: fiveAgentConfig(),
    deliveryWindowEvaluator: isPacificDeliveryWindowOpen,
  });
  h.setClock("2026-07-10T14:50:00.000Z");
  let reads = 0;
  h.source.readBatch = async () => {
    reads += 1;
    if (reads === 1) {
      return {
        items: [],
        highWater: { createdAt: row.createdAt, id: "0" },
        nextCursor: { createdAt: row.createdAt, id: "recovery:held-page" },
        done: false,
      };
    }
    return { items: [row], nextCursor: null, done: true };
  };

  const opened = await h.runtime.tick();
  assert.equal(opened.dayStart.status, "completed");
  assert.equal(opened.dayStart.queueBuild.done, true);
  assert.equal(reads, 2, "zero admissions are progress when the durable cursor moved");
  assert.equal(h.calls.length, 1);
});

test("recovery paging identity stays private on the runtime health surface", async () => {
  const row = { ...sourceRow(1), createdAt: new Date("2026-07-10T14:40:00.000Z") };
  const h = harness({
    rows: [row],
    durableSourceState: true,
    actionsEnabled: false,
    refillEnabled: false,
  });
  h.setClock("2026-07-10T14:50:00.000Z");
  h.source.readBatch = async () => ({
    items: [],
    highWater: { createdAt: row.createdAt, id: "0" },
    nextCursor: {
      createdAt: new Date(0),
      id: "recovery:callrail-long-call-recovery:TAG:private-case:1",
    },
    done: false,
  });

  await h.runtime.ingestOnce();
  const exposed = h.runtime.getState().sourceCursor;
  assert.deepEqual(exposed, { kind: "recovery", positioned: true });
  assert.equal(JSON.stringify(exposed).includes("private-case"), false);
  assert.equal(JSON.stringify(exposed).includes("1970"), false);
});

test("a queued provider post is blocked when the clock crosses 5 PM before create", async () => {
  const cutoff = new Date("2026-07-11T00:00:00.000Z");
  const h = harness({
    rows: [sourceRow(1)],
    actionsEnabled: true,
    target: 1,
    refill: 0,
    deliveryWindowEvaluator: (value) => new Date(value).getTime() < cutoff.getTime(),
  });
  h.setClock(new Date(cutoff.getTime() - 100));
  await h.runtime.ingestOnce();
  const compareAndSetItem = h.repository.compareAndSetItem.bind(h.repository);
  h.repository.compareAndSetItem = async (input) => {
    const updated = await compareAndSetItem(input);
    if (updated && input?.set?.providerPostState === "posting") h.setClock(cutoff);
    return updated;
  };

  const result = await h.runtime.seedAgent("bruce_allen");

  const item = [...h.repository.items.values()][0];
  assert.equal(result.accepted, 0);
  assert.equal(h.calls.length, 0);
  assert.equal(item.state, "packetized");
  assert.equal(item.providerPostState, "prepared");
  assert.equal(item.providerPostLeaseId, null);
  assert.equal(item.providerPostLeaseExpiresAt, null);
});

test("a reused providerCallId counts distinct contact/external attempts and actions", async () => {
  const cadenceActions = [];
  const h = harness({
    rows: [sourceRow(1)],
    actionsEnabled: true,
    target: 1,
    refill: 0,
    handlers: {
      record_daily_dial: async (action) => { cadenceActions.push(copy(action)); },
    },
  });
  await ingestAndSeed(h);
  const firstAttempt = acceptedItems(h.repository)[0];
  const firstContactId = firstAttempt.providerContactId;
  const firstExternalLeadId = firstAttempt.providerExternalLeadId;
  addDone(h.repository, firstAttempt, 1, "voicemail", {
    providerCallId: "reused-session-call-id",
    receivedAt: new Date(START.getTime() + 1_000),
  });
  await h.runtime.drainEvents();
  h.setClock("2026-07-11T00:30:00.000Z");
  assert.equal((await h.runtime.runEndOfDayFolderDrain()).status, "completed");
  h.setClock("2026-07-13T14:50:00.000Z");
  assert.equal((await h.runtime.launchAgent("bruce_allen")).accepted, 1);
  const secondAttempt = await h.repository.getItemById(firstAttempt._id);
  assert.notEqual(secondAttempt.providerContactId, firstContactId);
  assert.notEqual(secondAttempt.providerExternalLeadId, firstExternalLeadId);
  const secondEvent = addDone(h.repository, secondAttempt, 2, "voicemail", {
    providerCallId: "reused-session-call-id",
    receivedAt: new Date("2026-07-13T14:51:00.000Z"),
  });

  await h.runtime.drainCapturedEvent(secondEvent);

  const completed = await h.repository.getItemById(firstAttempt._id);
  const agent = await h.repository.getAgentById("bruce_allen");
  assert.equal(completed.dailyAttemptCount, 1);
  assert.equal(completed.totalAttemptCount, 2);
  assert.equal(completed.lastCountedProviderCallId, "reused-session-call-id");
  assert.equal(agent.providerCompletedCount, 2);
  assert.equal(cadenceActions.length, 2);
  assert.equal(Boolean(cadenceActions[0].providerAttemptKey), true);
  assert.notEqual(cadenceActions[0].providerAttemptKey, cadenceActions[1].providerAttemptKey);
  assert.notEqual(cadenceActions[0].idempotencyKey, cadenceActions[1].idempotencyKey);
});

test("5:30 Pacific close drains every configured working folder and preserves late-call identity", async () => {
  const h = harness({
    rows: [sourceRow(1), sourceRow(2)],
    actionsEnabled: true,
    target: 2,
    refill: 0,
  });
  await ingestAndSeed(h);
  h.providerContacts.set("disabled-agent-contact", {
    contactId: "disabled-agent-contact",
    folderId: "pool-phil",
  });
  h.setClock("2026-07-11T00:29:59.999Z");
  const early = await h.runtime.runEndOfDayFolderDrain();
  assert.equal(early.status, "not-due");
  assert.equal(h.deletes.length, 0);

  h.setClock("2026-07-11T00:30:00.000Z");
  const closed = await h.runtime.runEndOfDayFolderDrain();
  assert.equal(closed.status, "completed");
  assert.equal(closed.deleted, 3);
  assert.equal(h.deletes.length, 3);
  assert.equal(h.providerContacts.has("disabled-agent-contact"), false);
  const agent = await h.repository.getAgentById("bruce_allen");
  assert.equal(agent.operatorPaused, true);
  assert.equal(agent.shiftEnabled, false);
  assert.equal(agent.estimatedOutstanding, 0);
  assert.equal(agent.metadata.workingFolderDrain.status, "completed");
  assert.equal(agent.metadata.workingFolderDrain.dateKey, "2026-07-10");
  assert.deepEqual(h.runtime.getState().endOfDayDrain.agentResults, [
    {
      agentId: "bruce_allen",
      status: "completed",
      deleted: 2,
      remaining: 0,
    },
    {
      agentId: "phil_olson",
      status: "completed",
      deleted: 1,
      remaining: 0,
    },
  ]);
  for (const item of acceptedItems(h.repository)) {
    assert.equal(item.dailyAttemptCount, 0);
    assert.equal(item.totalAttemptCount, 0);
    assert.equal(item.metadata.workingFolderDrain.status, "provider_absent");
    assert.equal(Boolean(item.providerContactId), true);
    assert.equal(Boolean(item.providerExternalLeadId), true);
  }
  assert.equal((await h.runtime.previewAgent("bruce_allen")).currentOutstanding, 0);

  const repeated = await h.runtime.runEndOfDayFolderDrain();
  assert.equal(repeated.status, "completed");
  assert.equal(repeated.deleted, 0);
  assert.equal(h.deletes.length, 3);
});

test("next-day launch releases end-of-day tombstones without counting and creates a new exact attempt", async () => {
  const h = harness({
    rows: [sourceRow(1)],
    actionsEnabled: true,
    target: 1,
    refill: 0,
  });
  await ingestAndSeed(h);
  const first = acceptedItems(h.repository)[0];
  const firstContactId = first.providerContactId;
  const firstExternalLeadId = first.providerExternalLeadId;
  h.setClock("2026-07-11T00:30:00.000Z");
  assert.equal((await h.runtime.runEndOfDayFolderDrain()).status, "completed");

  h.setClock("2026-07-13T14:50:00.000Z");
  const launched = await h.runtime.launchAgent("bruce_allen");
  const second = await h.repository.getItemById(first._id);
  assert.equal(launched.accepted, 1);
  assert.equal(second.state, "provider_accepted");
  assert.equal(second.providerAttemptSequence, 2);
  assert.notEqual(second.providerContactId, firstContactId);
  assert.notEqual(second.providerExternalLeadId, firstExternalLeadId);
  assert.equal(second.dailyAttemptCount, 0);
  assert.equal(second.totalAttemptCount, 0);
  assert.equal(second.metadata.workingFolderDrain.status, "released");
});

test("5:30 close defers an in-call contact until exact Call End completes", async () => {
  const h = harness({
    rows: [sourceRow(1)],
    actionsEnabled: true,
    target: 1,
    refill: 0,
  });
  await ingestAndSeed(h);
  const accepted = acceptedItems(h.repository)[0];
  h.repository.addEvent({
    _id: "begin-before-close",
    eventType: "call_begin",
    providerCallId: "call-before-close",
    providerContactId: accepted.providerContactId,
    providerExternalLeadId: accepted.providerExternalLeadId,
    normalizedOutcome: null,
  });
  await h.runtime.drainEvents();
  assert.equal((await h.repository.getItemById(accepted._id)).state, "in_call");

  h.setClock("2026-07-11T00:30:00.000Z");
  const partial = await h.runtime.runEndOfDayFolderDrain();
  assert.equal(partial.status, "partial");
  assert.equal(h.providerContacts.has(accepted.providerContactId), true);

  addDone(h.repository, await h.repository.getItemById(accepted._id), 2, "voicemail", {
    providerCallId: "call-before-close",
  });
  await h.runtime.drainEvents();
  const completed = await h.repository.getItemById(accepted._id);
  assert.equal(completed.dailyAttemptCount, 1);
  assert.equal(h.providerContacts.has(accepted.providerContactId), false);
  assert.equal((await h.runtime.runEndOfDayFolderDrain()).status, "completed");
});

test("5:30 close intent fences a concurrent Call Begin before provider deletion", async () => {
  const h = harness({
    rows: [sourceRow(1)],
    actionsEnabled: true,
    target: 1,
    refill: 0,
  });
  await ingestAndSeed(h);
  const accepted = acceptedItems(h.repository)[0];
  const realDelete = h.phoneBurner.deleteContact.bind(h.phoneBurner);
  let lateBegin = null;
  h.phoneBurner.deleteContact = async (contactId) => {
    lateBegin = h.repository.addEvent({
      _id: "begin-after-close-intent",
      eventType: "call_begin",
      providerCallId: "call-after-close-intent",
      providerContactId: accepted.providerContactId,
      providerExternalLeadId: accepted.providerExternalLeadId,
      normalizedOutcome: null,
      receivedAt: new Date("2026-07-11T00:30:00.001Z"),
    });
    const presence = await h.runtime.drainCapturedEvent(lateBegin);
    assert.equal(presence.status, "completed");
    const fenced = await h.repository.getItemById(accepted._id);
    assert.equal(fenced.state, "provider_accepted");
    assert.equal(fenced.metadata.workingFolderDrain.status, "delete_pending");
    return realDelete(contactId);
  };

  h.setClock("2026-07-11T00:30:00.000Z");
  const closed = await h.runtime.runEndOfDayFolderDrain();
  const after = await h.repository.getItemById(accepted._id);

  assert.equal(closed.status, "completed");
  assert.equal(h.providerContacts.has(accepted.providerContactId), false);
  assert.equal(after.state, "provider_accepted");
  assert.equal(after.metadata.workingFolderDrain.status, "provider_absent");
  assert.equal(
    after.providerAttemptHistory.some((entry) => entry.event === "call_begin"),
    false,
  );
  assert.equal(h.repository.events.get(lateBegin._id).status, "completed");
});

test("Call Begin winning the close boundary makes the close defer deletion", async () => {
  const h = harness({
    rows: [sourceRow(1)],
    actionsEnabled: true,
    target: 1,
    refill: 0,
  });
  await ingestAndSeed(h);
  const accepted = acceptedItems(h.repository)[0];
  const begin = h.repository.addEvent({
    _id: "begin-winning-close-boundary",
    eventType: "call_begin",
    providerCallId: "call-winning-close-boundary",
    providerContactId: accepted.providerContactId,
    providerExternalLeadId: accepted.providerExternalLeadId,
    normalizedOutcome: null,
    receivedAt: new Date("2026-07-11T00:30:00.000Z"),
  });
  const realCompareAndSetItem = h.repository.compareAndSetItem.bind(h.repository);
  let injected = false;
  h.repository.compareAndSetItem = async (args) => {
    const closeStatus = args?.set?.metadata?.workingFolderDrain?.status;
    if (!injected && closeStatus === "delete_pending") {
      injected = true;
      const presence = await h.runtime.drainCapturedEvent(begin);
      assert.equal(presence.status, "completed");
    }
    return realCompareAndSetItem(args);
  };

  h.setClock("2026-07-11T00:30:00.000Z");
  const partial = await h.runtime.runEndOfDayFolderDrain();
  const after = await h.repository.getItemById(accepted._id);

  assert.equal(injected, true);
  assert.equal(partial.status, "partial");
  assert.equal(after.state, "in_call");
  assert.equal(after.providerCallId, "call-winning-close-boundary");
  assert.equal(h.providerContacts.has(accepted.providerContactId), true);
  assert.equal(h.deletes.length, 0);
});

test("5:30 close retries a provider 429 and resumes a crash-after-delete intent", async () => {
  let providerClock = 0;
  const h = harness({
    rows: [sourceRow(1)],
    actionsEnabled: true,
    target: 1,
    refill: 0,
    providerPostClock: () => providerClock,
  });
  await ingestAndSeed(h);
  h.setClock("2026-07-11T00:30:00.000Z");
  const realDelete = h.phoneBurner.deleteContact.bind(h.phoneBurner);
  let rateLimited = true;
  h.phoneBurner.deleteContact = async (contactId) => {
    if (rateLimited) {
      rateLimited = false;
      return { ok: false, httpStatus: 429, retryAfterMs: 10, reason: "rate-limited" };
    }
    return realDelete(contactId);
  };
  const first = await h.runtime.runEndOfDayFolderDrain();
  assert.equal(first.status, "rate-limited");
  assert.equal(acceptedItems(h.repository)[0].metadata.workingFolderDrain.status, "delete_pending");

  providerClock = 60_000;
  let crashOnce = true;
  h.phoneBurner.deleteContact = async (contactId) => {
    const result = await realDelete(contactId);
    if (crashOnce) {
      crashOnce = false;
      throw new Error("simulated-process-loss-after-delete");
    }
    return result;
  };
  await assert.rejects(h.runtime.runEndOfDayFolderDrain(), /simulated-process-loss/);
  assert.equal(h.providerContacts.size, 0);
  h.phoneBurner.deleteContact = realDelete;
  providerClock = 120_000;
  const recovered = await h.runtime.runEndOfDayFolderDrain();
  assert.equal(recovered.status, "completed");
  const item = acceptedItems(h.repository)[0];
  assert.equal(item.metadata.workingFolderDrain.status, "provider_absent");
  assert.equal(item.dailyAttemptCount, 0);
});

test("the first 7:50 next-business-day tick resumes a crash, releases old identity, and starts fresh", async () => {
  const h = harness({
    rows: [sourceRow(1)],
    actionsEnabled: true,
    target: 1,
    refill: 0,
  });
  await ingestAndSeed(h);
  const accepted = acceptedItems(h.repository)[0];
  const oldContactId = accepted.providerContactId;
  const realDelete = h.phoneBurner.deleteContact.bind(h.phoneBurner);
  let crashOnce = true;
  h.phoneBurner.deleteContact = async (contactId) => {
    const result = await realDelete(contactId);
    if (crashOnce) {
      crashOnce = false;
      throw new Error("simulated-process-loss-after-delete");
    }
    return result;
  };
  h.setClock("2026-07-11T00:30:00.000Z");
  await assert.rejects(h.runtime.runEndOfDayFolderDrain(), /simulated-process-loss/);
  assert.equal(h.providerContacts.size, 0);
  assert.equal(
    (await h.repository.getItemById(accepted._id)).metadata.workingFolderDrain.status,
    "delete_pending",
  );

  h.phoneBurner.deleteContact = realDelete;
  h.setClock("2026-07-13T14:50:00.000Z");
  const tick = await h.runtime.tick();
  const recovered = await h.repository.getItemById(accepted._id);

  assert.equal(tick.priorDayDrainResume.status, "completed");
  assert.equal(tick.priorDayDrainResume.dateKey, "2026-07-10");
  assert.equal(tick.priorDayDrainRelease.released, 1);
  assert.equal(tick.dayStart.status, "completed");
  assert.equal(recovered.state, "provider_accepted");
  assert.equal(recovered.deliveryAgentId, "bruce_allen");
  assert.notEqual(recovered.providerContactId, oldContactId);
  assert.equal(recovered.totalAttemptCount, 0);
  const removal = recovered.providerAttemptHistory.find((entry) => (
    entry.event === "provider_removed" && Number(entry.attemptNumber) === 1
  ));
  assert.ok(removal);
  assert.equal(new Date(removal.occurredAt).toISOString(), "2026-07-11T00:30:00.000Z");
});

test("a 7:50 next-morning restart catches up a missed close before starting new work", async () => {
  const h = harness({
    rows: [sourceRow(1)],
    actionsEnabled: true,
    target: 1,
    refill: 0,
  });
  await ingestAndSeed(h);
  const accepted = acceptedItems(h.repository)[0];
  const oldContactId = accepted.providerContactId;
  const internalAgent = h.repository.agents.get("bruce_allen");
  internalAgent.createdAt = new Date("2026-07-10T16:00:00.000Z");
  assert.equal(internalAgent.metadata.workingFolderDrain, undefined);
  assert.equal(h.providerContacts.size, 1);

  // Model a service outage spanning the entire 5:30 close. The first next-day
  // tick must infer the missed close from the already-existing runtime owner,
  // drain before events/refill, and release the undialed item safely.
  h.setClock("2026-07-13T14:50:00.000Z");
  const tick = await h.runtime.tick();
  const recovered = await h.repository.getItemById(accepted._id);
  const agent = await h.repository.getAgentById("bruce_allen");

  assert.equal(tick.priorDayDrainResume.status, "completed");
  assert.equal(tick.priorDayDrainResume.dateKey, "2026-07-10");
  assert.equal(tick.priorDayDrainRelease.released, 1);
  assert.equal(tick.dayStart.status, "completed");
  assert.equal(h.providerContacts.size, 1);
  assert.equal(recovered.state, "provider_accepted");
  assert.notEqual(recovered.providerContactId, oldContactId);
  assert.equal(recovered.totalAttemptCount, 0);
  assert.equal(agent.operatorPaused, false);
  assert.equal(agent.shiftEnabled, true);
  assert.equal(agent.metadata.workingFolderDrain.status, "completed");
  assert.equal(agent.metadata.workingFolderDrain.dateKey, "2026-07-10");
  assert.equal(agent.metadata.simpleDayStart.status, "completed");
  assert.equal(agent.metadata.simpleDayStart.dateKey, "2026-07-13");
});

test("a late exact Call End after the 5:30 close counts once without reopening delivery", async () => {
  const h = harness({
    rows: [sourceRow(1)],
    actionsEnabled: true,
    target: 1,
    refill: 0,
  });
  await ingestAndSeed(h);
  const accepted = acceptedItems(h.repository)[0];
  const identity = {
    providerContactId: accepted.providerContactId,
    providerExternalLeadId: accepted.providerExternalLeadId,
  };

  h.setClock("2026-07-11T00:30:00.000Z");
  assert.equal((await h.runtime.runEndOfDayFolderDrain()).status, "completed");
  assert.equal((await h.repository.getAgentById("bruce_allen")).estimatedOutstanding, 0);

  // Even an accidental same-evening launch is clamped again by the completed
  // daily close marker; the repeated close remains idempotent.
  await h.runtime.launchAgent("bruce_allen");
  assert.equal((await h.repository.getAgentById("bruce_allen")).operatorPaused, false);
  assert.equal((await h.runtime.runEndOfDayFolderDrain()).status, "completed");
  assert.equal((await h.repository.getAgentById("bruce_allen")).operatorPaused, true);

  const late = h.repository.addEvent({
    _id: "late-call-end-after-close",
    eventType: "call_done",
    providerCallId: "call-finished-after-close",
    ...identity,
    normalizedOutcome: "voicemail",
    receivedAt: new Date("2026-07-11T00:31:00.000Z"),
  });
  const result = await h.runtime.drainCapturedEvent(late);
  const completed = await h.repository.getItemById(accepted._id);
  const agent = await h.repository.getAgentById("bruce_allen");

  assert.equal(result.status, "completed");
  assert.equal(completed.state, "follow_up_wait");
  assert.equal(completed.dailyAttemptCount, 1);
  assert.equal(completed.totalAttemptCount, 1);
  assert.equal(completed.providerContactId, null);
  assert.equal(agent.providerCompletedCount, 1);
  assert.equal(agent.estimatedOutstanding, 0);
  assert.equal(agent.operatorPaused, true);
  assert.equal(agent.shiftEnabled, false);
  assert.equal(agent.activeUntil, null);
  assert.equal(h.calls.length, 1);
  assert.equal(h.repository.events.get(late._id).status, "completed");
});

test("a post-midnight callback before release stays on the closed Pacific business day", async () => {
  const cadenceActions = [];
  const h = harness({
    rows: [sourceRow(1)],
    actionsEnabled: true,
    target: 1,
    refill: 0,
    handlers: {
      record_daily_dial: async (action) => { cadenceActions.push(copy(action)); },
    },
  });
  await ingestAndSeed(h);
  const accepted = acceptedItems(h.repository)[0];
  const identity = {
    providerContactId: accepted.providerContactId,
    providerExternalLeadId: accepted.providerExternalLeadId,
  };
  h.setClock("2026-07-11T00:30:00.000Z");
  assert.equal((await h.runtime.runEndOfDayFolderDrain()).status, "completed");

  // 00:01 Pacific is the next calendar day, but this exact attempt was removed
  // by the prior day's close and has not yet gone through next-day release.
  h.setClock("2026-07-11T07:01:00.000Z");
  const delayed = h.repository.addEvent({
    _id: "after-midnight-before-release",
    eventType: "call_done",
    providerCallId: "after-midnight-prior-day-call",
    ...identity,
    normalizedOutcome: "voicemail",
    receivedAt: new Date("2026-07-11T07:01:00.000Z"),
  });
  assert.equal((await h.runtime.drainCapturedEvent(delayed)).status, "completed");

  const after = await h.repository.getItemById(accepted._id);
  assert.equal(after.state, "follow_up_wait");
  assert.equal(after.dailyAttemptDateKey, "2026-07-10");
  assert.equal(after.dailyAttemptCount, 1);
  assert.equal(after.providerContactId, null);
  assert.equal(after.providerExternalLeadId, null);
  assert.equal(after.deliveryAgentId, null);
  assert.equal(after.metadata.workingFolderDrain.status, "released");
  assert.equal(cadenceActions.length, 1);
  assert.equal(cadenceActions[0].dailyAttemptDateKey, "2026-07-10");
  assert.equal(
    new Date(cadenceActions[0].completedAt).toISOString(),
    "2026-07-11T00:30:00.000Z",
  );
});

test("weekend preposition without call-begin counts on the later close day", async () => {
  const cadenceActions = [];
  const h = harness({
    rows: [sourceRow(1)],
    actionsEnabled: true,
    target: 1,
    refill: 0,
    handlers: {
      record_daily_dial: async (action) => { cadenceActions.push(copy(action)); },
    },
  });
  h.setClock("2026-07-12T16:00:00.000Z"); // Sunday 09:00 Pacific.
  await h.runtime.ingestOnce();
  await h.runtime.seedAgent("bruce_allen", { preposition: true });
  const accepted = acceptedItems(h.repository)[0];
  const identity = {
    providerContactId: accepted.providerContactId,
    providerExternalLeadId: accepted.providerExternalLeadId,
  };

  h.setClock("2026-07-14T00:30:00.000Z"); // Monday 17:30 Pacific.
  assert.equal((await h.runtime.runEndOfDayFolderDrain()).status, "completed");
  h.setClock("2026-07-14T14:00:00.000Z");
  const delayed = h.repository.addEvent({
    _id: "weekend-preposition-monday-close-call",
    providerCallId: "weekend-preposition-delayed-call",
    ...identity,
    normalizedOutcome: "voicemail",
    receivedAt: new Date("2026-07-14T14:00:00.000Z"),
  });
  assert.equal((await h.runtime.drainCapturedEvent(delayed)).status, "completed");

  const after = await h.repository.getItemById(accepted._id);
  assert.equal(after.dailyAttemptDateKey, "2026-07-13");
  assert.equal(after.dailyAttemptCount, 1);
  assert.equal(cadenceActions.length, 1);
  assert.equal(cadenceActions[0].dailyAttemptDateKey, "2026-07-13");
  assert.equal(
    new Date(cadenceActions[0].completedAt).toISOString(),
    "2026-07-14T00:30:00.000Z",
  );
});

test("a delayed call_begin cannot resurrect an attempt removed by the 5:30 close", async () => {
  const h = harness({
    rows: [sourceRow(1)],
    actionsEnabled: true,
    target: 1,
    refill: 0,
  });
  await ingestAndSeed(h);
  const accepted = acceptedItems(h.repository)[0];
  const identity = {
    providerContactId: accepted.providerContactId,
    providerExternalLeadId: accepted.providerExternalLeadId,
  };
  h.setClock("2026-07-11T00:30:00.000Z");
  assert.equal((await h.runtime.runEndOfDayFolderDrain()).status, "completed");

  const lateBegin = h.repository.addEvent({
    _id: "late-begin-after-daily-close",
    eventType: "call_begin",
    providerCallId: "late-session-after-close",
    ...identity,
    normalizedOutcome: null,
    receivedAt: new Date("2026-07-11T00:31:00.000Z"),
  });
  await h.runtime.drainCapturedEvent(lateBegin);
  const afterPresence = await h.repository.getItemById(accepted._id);
  assert.equal(afterPresence.state, "provider_accepted");
  assert.equal(afterPresence.metadata.workingFolderDrain.status, "provider_absent");
  assert.equal(h.repository.events.get(lateBegin._id).status, "completed");

  h.setClock("2026-07-13T14:50:00.000Z");
  await h.runtime.tick();
  const released = await h.repository.getItemById(accepted._id);
  assert.equal(released.state, "provider_accepted");
  assert.notEqual(released.providerContactId, identity.providerContactId);
  assert.equal(released.providerAttemptSequence, 2);
  assert.equal(released.totalAttemptCount, 0);
});

test("the 5:30 close drains large folders in bounded chunks instead of deadlocking", async () => {
  const h = harness({
    rows: [sourceRow(1), sourceRow(2), sourceRow(3)],
    actionsEnabled: true,
    target: 3,
    refill: 0,
    endOfDayMaxDeletesPerRun: 2,
  });
  await ingestAndSeed(h);
  h.setClock("2026-07-11T00:30:00.000Z");

  const first = await h.runtime.runEndOfDayFolderDrain();
  assert.equal(first.status, "partial");
  assert.equal(first.deleted, 2);
  assert.equal(h.providerContacts.size, 1);

  const second = await h.runtime.runEndOfDayFolderDrain();
  assert.equal(second.status, "completed");
  assert.equal(second.deleted, 1);
  assert.equal(h.providerContacts.size, 0);
  assert.equal(h.deletes.length, 3);
});

test("the first next-day tick releases every agent's undialed close tombstones", async () => {
  const h = harness({
    rows: [sourceRow(1)],
    actionsEnabled: true,
    target: 1,
    refill: 0,
  });
  await ingestAndSeed(h);
  h.setClock("2026-07-11T00:30:00.000Z");
  assert.equal((await h.runtime.runEndOfDayFolderDrain()).status, "completed");

  h.setClock("2026-07-13T14:50:00.000Z");
  const tick = await h.runtime.tick();
  const released = await h.repository.getItemById("item-1");

  assert.equal(tick.priorDayDrainRelease.status, "released");
  assert.equal(tick.priorDayDrainRelease.released, 1);
  assert.equal(released.state, "provider_accepted");
  assert.equal(released.deliveryAgentId, "bruce_allen");
  assert.equal(Boolean(released.providerContactId), true);
  assert.equal(released.providerAttemptSequence, 2);
  assert.equal(released.dailyAttemptCount, 0);
  assert.equal(released.totalAttemptCount, 0);
});

test("an exact prior-day DNC counts once and cancels a newer queued attempt without counting it", async () => {
  const cadenceActions = [];
  const dncActions = [];
  const h = harness({
    rows: [sourceRow(1)],
    actionsEnabled: true,
    target: 1,
    refill: 0,
    handlers: {
      record_daily_dial: async (action) => { cadenceActions.push(copy(action)); },
      logics_dnc: async (action) => { dncActions.push(copy(action)); },
    },
  });
  await ingestAndSeed(h);
  const first = acceptedItems(h.repository)[0];
  const firstIdentity = {
    providerContactId: first.providerContactId,
    providerExternalLeadId: first.providerExternalLeadId,
  };
  h.setClock("2026-07-11T00:30:00.000Z");
  assert.equal((await h.runtime.runEndOfDayFolderDrain()).status, "completed");

  h.setClock("2026-07-13T14:50:00.000Z");
  const openTick = await h.runtime.tick();
  assert.equal(openTick.priorDayDrainRelease.released, 1);
  const second = await h.repository.getItemById(first._id);
  assert.equal(second.state, "provider_accepted");
  const secondIdentity = {
    providerContactId: second.providerContactId,
    providerExternalLeadId: second.providerExternalLeadId,
  };
  assert.equal(second.providerAttemptSequence, 2);

  const late = h.repository.addEvent({
    _id: "prior-day-dnc-after-new-attempt",
    providerCallId: "prior-day-call-finished-late",
    ...firstIdentity,
    normalizedOutcome: "dnc",
    receivedAt: new Date("2026-07-13T14:51:00.000Z"),
  });
  const result = await h.runtime.drainCapturedEvent(late);
  const after = await h.repository.getItemById(first._id);
  const agent = await h.repository.getAgentById("bruce_allen");

  assert.equal(result.status, "completed");
  assert.equal(after.state, "terminal");
  assert.equal(after.activeAttempt, false);
  assert.equal(after.lastOutcome, "dnc");
  assert.equal(after.providerAttemptSequence, 2);
  assert.equal(after.providerContactId, null);
  assert.equal(after.providerExternalLeadId, null);
  assert.equal(after.dailyAttemptDateKey, "2026-07-13");
  assert.equal(after.dailyAttemptCount, 0);
  assert.equal(after.totalAttemptCount, 1);
  assert.equal(agent.providerCompletedCount, 1);
  assert.equal(agent.estimatedOutstanding, 0);
  assert.equal(h.providerContacts.has(secondIdentity.providerContactId), false);
  assert.equal(h.deletes.includes(secondIdentity.providerContactId), true);
  assert.equal(after.providerAttemptHistory.some((entry) => (
    Number(entry.attemptNumber) === 2
    && entry.event === "provider_removed"
    && entry.reason === "historical-terminal-cancel"
  )), true);
  assert.equal(cadenceActions.length, 1);
  assert.equal(cadenceActions[0].dailyAttemptDateKey, "2026-07-10");
  assert.equal(cadenceActions[0].dailyAttemptCount, 1);
  assert.equal(
    new Date(cadenceActions[0].completedAt).toISOString(),
    "2026-07-11T00:30:00.000Z",
  );
  assert.equal(dncActions.length, 1);
  assert.equal(dncActions[0].agentId, "bruce_allen");
});

test("cross-midnight historical completion preserves current-day counters and prior-day action context", async () => {
  const cadenceActions = [];
  const h = harness({
    rows: [sourceRow(1)],
    actionsEnabled: true,
    target: 1,
    refill: 0,
    handlers: {
      record_daily_dial: async (action) => { cadenceActions.push(copy(action)); },
    },
  });
  await ingestAndSeed(h);
  const first = acceptedItems(h.repository)[0];
  const firstIdentity = {
    providerContactId: first.providerContactId,
    providerExternalLeadId: first.providerExternalLeadId,
  };

  h.setClock("2026-07-11T00:30:00.000Z");
  assert.equal((await h.runtime.runEndOfDayFolderDrain()).status, "completed");

  h.setClock("2026-07-13T14:50:00.000Z");
  const openTick = await h.runtime.tick();
  assert.equal(openTick.priorDayDrainRelease.released, 1);
  const second = await h.repository.getItemById(first._id);
  assert.equal(second.state, "provider_accepted");
  const secondDone = h.repository.addEvent({
    _id: "current-day-second-attempt",
    providerCallId: "current-day-second-call",
    providerContactId: second.providerContactId,
    providerExternalLeadId: second.providerExternalLeadId,
    normalizedOutcome: "voicemail",
    receivedAt: new Date("2026-07-13T14:51:00.000Z"),
  });
  h.setClock("2026-07-13T14:51:00.000Z");
  assert.equal((await h.runtime.drainCapturedEvent(secondDone)).status, "completed");
  const afterSecond = await h.repository.getItemById(first._id);
  assert.equal(afterSecond.state, "follow_up_wait");
  assert.equal(afterSecond.dailyAttemptDateKey, "2026-07-13");
  assert.equal(afterSecond.dailyAttemptCount, 1);
  assert.equal(afterSecond.totalAttemptCount, 1);
  assert.equal(new Date(afterSecond.lastContactAt).toISOString(), "2026-07-13T14:51:00.000Z");
  assert.equal(new Date(afterSecond.nextContactAt).toISOString(), "2026-07-13T16:51:00.000Z");

  const delayedFirst = h.repository.addEvent({
    _id: "prior-day-first-attempt-delayed",
    providerCallId: "prior-day-first-call",
    ...firstIdentity,
    normalizedOutcome: "voicemail",
    receivedAt: new Date("2026-07-13T15:00:00.000Z"),
  });
  h.setClock("2026-07-13T15:00:00.000Z");
  const delayedResult = await h.runtime.drainCapturedEvent(delayedFirst);
  assert.equal(
    delayedResult.status,
    "completed",
    h.repository.events.get(delayedFirst._id)?.lastError || "delayed historical completion should complete",
  );

  const after = await h.repository.getItemById(first._id);
  const agent = await h.repository.getAgentById("bruce_allen");
  const historicalAction = cadenceActions.find((action) => (
    action.providerCallId === "prior-day-first-call"
  ));
  assert.ok(historicalAction);
  assert.equal(after.state, "follow_up_wait");
  assert.equal(after.providerAttemptSequence, 2);
  assert.equal(after.dailyAttemptDateKey, "2026-07-13");
  assert.equal(after.dailyAttemptCount, 1);
  assert.equal(after.totalAttemptCount, 2);
  assert.equal(new Date(after.lastContactAt).toISOString(), "2026-07-13T14:51:00.000Z");
  assert.equal(new Date(after.nextContactAt).toISOString(), "2026-07-13T16:51:00.000Z");
  assert.equal(agent.providerCompletedCount, 2);
  assert.equal(historicalAction.dailyAttemptDateKey, "2026-07-10");
  assert.equal(historicalAction.dailyAttemptCount, 1);
  assert.equal(
    new Date(historicalAction.completedAt).toISOString(),
    "2026-07-11T00:30:00.000Z",
  );
  assert.equal(
    new Date(historicalAction.nextContactAt).toISOString(),
    "2026-07-11T02:30:00.000Z",
  );
});

test("a historical completion cannot manufacture current agent activity", async () => {
  const h = harness({
    rows: [sourceRow(1)],
    actionsEnabled: true,
    target: 1,
    refill: 0,
  });
  await ingestAndSeed(h);
  const first = acceptedItems(h.repository)[0];
  const firstIdentity = {
    providerContactId: first.providerContactId,
    providerExternalLeadId: first.providerExternalLeadId,
  };
  h.setClock("2026-07-11T00:30:00.000Z");
  assert.equal((await h.runtime.runEndOfDayFolderDrain()).status, "completed");
  h.setClock("2026-07-13T14:50:00.000Z");
  assert.equal((await h.runtime.launchAgent("bruce_allen")).accepted, 1);
  const before = await h.repository.getAgentById("bruce_allen");
  assert.equal(new Date(before.activeUntil).toISOString(), "2026-07-13T15:00:00.000Z");

  h.setClock("2026-07-13T15:01:00.000Z");
  const delayed = h.repository.addEvent({
    _id: "historical-after-activity-expired",
    providerCallId: "historical-expired-agent-call",
    ...firstIdentity,
    normalizedOutcome: "voicemail",
    receivedAt: new Date("2026-07-13T15:01:00.000Z"),
  });
  assert.equal((await h.runtime.drainCapturedEvent(delayed)).status, "completed");
  const historicalEvent = h.repository.events.get(delayed._id);
  assert.equal(historicalEvent.domain, first.domain);
  assert.equal(historicalEvent.caseId, first.caseId);
  const after = await h.repository.getAgentById("bruce_allen");
  const item = await h.repository.getItemById(first._id);

  assert.equal(after.providerCompletedCount, 1);
  assert.equal(after.estimatedOutstanding, 1);
  assert.equal(after.shiftEnabled, before.shiftEnabled);
  assert.equal(new Date(after.activeUntil).toISOString(), new Date(before.activeUntil).toISOString());
  assert.deepEqual(after.lastProviderEvidenceAt, before.lastProviderEvidenceAt);
  assert.equal(item.state, "provider_accepted");
  assert.equal(item.providerAttemptSequence, 2);
});

test("a historical appointment cancels a newer queued attempt without counting it", async () => {
  const h = harness({
    rows: [sourceRow(1)],
    actionsEnabled: true,
    target: 1,
    refill: 0,
  });
  await ingestAndSeed(h);
  const first = acceptedItems(h.repository)[0];
  const firstIdentity = {
    providerContactId: first.providerContactId,
    providerExternalLeadId: first.providerExternalLeadId,
  };
  h.setClock("2026-07-11T00:30:00.000Z");
  assert.equal((await h.runtime.runEndOfDayFolderDrain()).status, "completed");
  h.setClock("2026-07-13T14:50:00.000Z");
  assert.equal((await h.runtime.launchAgent("bruce_allen")).accepted, 1);
  const second = await h.repository.getItemById(first._id);

  const historicalAppointment = h.repository.addEvent({
    _id: "historical-appointment-after-new-attempt",
    providerCallId: "historical-appointment-call",
    ...firstIdentity,
    normalizedOutcome: "appointment",
    receivedAt: new Date("2026-07-13T14:51:00.000Z"),
  });
  assert.equal((await h.runtime.drainCapturedEvent(historicalAppointment)).status, "completed");
  const after = await h.repository.getItemById(first._id);
  const agent = await h.repository.getAgentById("bruce_allen");

  assert.equal(after.state, "terminal");
  assert.equal(after.activeAttempt, false);
  assert.equal(after.lastOutcome, "appointment");
  assert.equal(after.providerAttemptSequence, 2);
  assert.equal(after.providerContactId, null);
  assert.equal(after.totalAttemptCount, 1);
  assert.equal(agent.providerCompletedCount, 1);
  assert.equal(agent.estimatedOutstanding, 0);
  assert.equal(h.providerContacts.has(second.providerContactId), false);
  assert.equal(h.deletes.includes(second.providerContactId), true);
});

test("a historical appointment defers through a newer in-call attempt and remains terminal", async () => {
  const cadenceActions = [];
  const h = harness({
    rows: [sourceRow(1)],
    actionsEnabled: true,
    target: 1,
    refill: 0,
    handlers: {
      record_daily_dial: async (action) => { cadenceActions.push(copy(action)); },
    },
  });
  await ingestAndSeed(h);
  const first = acceptedItems(h.repository)[0];
  const firstIdentity = {
    providerContactId: first.providerContactId,
    providerExternalLeadId: first.providerExternalLeadId,
  };
  h.setClock("2026-07-11T00:30:00.000Z");
  assert.equal((await h.runtime.runEndOfDayFolderDrain()).status, "completed");
  h.setClock("2026-07-13T14:50:00.000Z");
  assert.equal((await h.runtime.launchAgent("bruce_allen")).accepted, 1);
  const second = await h.repository.getItemById(first._id);
  const secondIdentity = {
    providerContactId: second.providerContactId,
    providerExternalLeadId: second.providerExternalLeadId,
  };
  const began = h.repository.addEvent({
    _id: "second-attempt-call-begin",
    eventType: "call_begin",
    providerCallId: "second-attempt-live-call",
    ...secondIdentity,
    normalizedOutcome: null,
    receivedAt: new Date("2026-07-13T14:50:30.000Z"),
  });
  h.setClock("2026-07-13T14:50:30.000Z");
  assert.equal((await h.runtime.drainCapturedEvent(began)).status, "completed");
  assert.equal((await h.repository.getItemById(first._id)).state, "in_call");

  const historical = h.repository.addEvent({
    _id: "historical-appointment-during-new-call",
    providerCallId: "historical-appointment-before-new-call",
    ...firstIdentity,
    normalizedOutcome: "appointment",
    receivedAt: new Date("2026-07-13T14:51:00.000Z"),
  });
  h.setClock("2026-07-13T14:51:00.000Z");
  assert.equal((await h.runtime.drainCapturedEvent(historical)).status, "completed");
  const deferred = await h.repository.getItemById(first._id);
  assert.equal(deferred.state, "in_call");
  assert.equal(deferred.metadata.historicalTerminalBlock.status, "in_call_deferred");
  assert.equal(h.providerContacts.has(secondIdentity.providerContactId), true);

  const currentDone = h.repository.addEvent({
    _id: "second-attempt-voicemail-after-historical-appointment",
    providerCallId: "second-attempt-live-call",
    ...secondIdentity,
    normalizedOutcome: "voicemail",
    receivedAt: new Date("2026-07-13T14:52:00.000Z"),
  });
  h.setClock("2026-07-13T14:52:00.000Z");
  assert.equal((await h.runtime.drainCapturedEvent(currentDone)).status, "completed");
  const after = await h.repository.getItemById(first._id);
  const agent = await h.repository.getAgentById("bruce_allen");

  assert.equal(after.state, "terminal");
  assert.equal(after.activeAttempt, false);
  assert.equal(after.lastOutcome, "appointment");
  assert.equal(after.totalAttemptCount, 2);
  assert.equal(after.metadata.historicalTerminalBlock.status, "enforced");
  assert.equal(after.providerContactId, null);
  assert.equal(h.providerContacts.has(secondIdentity.providerContactId), false);
  assert.equal(agent.providerCompletedCount, 2);
  assert.equal(agent.estimatedOutstanding, 0);
  const currentCadence = cadenceActions.find((action) => (
    action.providerCallId === "second-attempt-live-call"
  ));
  assert.ok(currentCadence);
  assert.equal(currentCadence.normalizedOutcome, "voicemail");
});

test("an older exact DNC completes after a later close marker and terminally cancels newer work", async () => {
  const cadenceActions = [];
  const dncActions = [];
  const h = harness({
    rows: [sourceRow(1)],
    actionsEnabled: true,
    target: 1,
    refill: 0,
    handlers: {
      record_daily_dial: async (action) => { cadenceActions.push(copy(action)); },
      logics_dnc: async (action) => { dncActions.push(copy(action)); },
    },
  });
  await ingestAndSeed(h);
  const first = acceptedItems(h.repository)[0];
  const firstIdentity = {
    providerContactId: first.providerContactId,
    providerExternalLeadId: first.providerExternalLeadId,
  };

  h.setClock("2026-07-11T00:30:00.000Z");
  assert.equal((await h.runtime.runEndOfDayFolderDrain()).status, "completed");
  h.setClock("2026-07-13T14:50:00.000Z");
  assert.equal((await h.runtime.launchAgent("bruce_allen")).accepted, 1);
  const second = await h.repository.getItemById(first._id);
  const secondIdentity = {
    providerContactId: second.providerContactId,
    providerExternalLeadId: second.providerExternalLeadId,
  };

  h.setClock("2026-07-14T00:30:00.000Z");
  assert.equal((await h.runtime.runEndOfDayFolderDrain()).status, "completed");
  const afterSecondClose = await h.repository.getItemById(first._id);
  assert.equal(afterSecondClose.metadata.workingFolderDrain.attemptNumber, 2);
  assert.equal(afterSecondClose.metadata.workingFolderDrain.dateKey, "2026-07-13");
  assert.equal(afterSecondClose.metadata.workingFolderDrain.status, "provider_absent");
  const deletesBeforeCallback = [...h.deletes];

  const delayedFirst = h.repository.addEvent({
    _id: "first-attempt-after-second-close",
    providerCallId: "first-call-after-second-close",
    ...firstIdentity,
    normalizedOutcome: "dnc",
    receivedAt: new Date("2026-07-14T14:00:00.000Z"),
  });
  h.setClock("2026-07-14T14:00:00.000Z");
  const result = await h.runtime.drainCapturedEvent(delayedFirst);
  const after = await h.repository.getItemById(first._id);
  const agent = await h.repository.getAgentById("bruce_allen");
  const historicalCompletions = after.providerAttemptHistory.filter((entry) => (
    Number(entry.attemptNumber) === 1
    && entry.event === "completed"
    && entry.outcome === "dnc"
  ));

  assert.equal(result.status, "completed");
  assert.equal(h.repository.events.get(delayedFirst._id).status, "completed");
  assert.equal(after.state, "terminal");
  assert.equal(after.activeAttempt, false);
  assert.equal(after.lastOutcome, "dnc");
  assert.equal(after.providerAttemptSequence, 2);
  assert.equal(after.providerContactId, null);
  assert.equal(after.providerExternalLeadId, null);
  assert.equal(after.metadata.workingFolderDrain.attemptNumber, 2);
  assert.equal(after.metadata.workingFolderDrain.dateKey, "2026-07-13");
  assert.equal(after.metadata.workingFolderDrain.status, "provider_absent");
  assert.equal(after.totalAttemptCount, 1);
  assert.equal(historicalCompletions.length, 1);
  assert.equal(agent.providerCompletedCount, 1);
  assert.equal(agent.estimatedOutstanding, 0);
  assert.deepEqual(h.deletes, deletesBeforeCallback);
  assert.equal(cadenceActions.length, 1);
  assert.equal(dncActions.length, 1);
  assert.equal(dncActions[0].agentId, "bruce_allen");
});

test("a historical review can strengthen to DNC without recounting", async () => {
  const cadenceActions = [];
  const dncActions = [];
  const h = harness({
    rows: [sourceRow(1)],
    actionsEnabled: true,
    target: 1,
    refill: 0,
    handlers: {
      record_daily_dial: async (action) => { cadenceActions.push(copy(action)); },
      logics_dnc: async (action) => { dncActions.push(copy(action)); },
    },
  });
  await ingestAndSeed(h);
  const first = acceptedItems(h.repository)[0];
  const firstIdentity = {
    providerContactId: first.providerContactId,
    providerExternalLeadId: first.providerExternalLeadId,
  };
  h.setClock("2026-07-11T00:30:00.000Z");
  assert.equal((await h.runtime.runEndOfDayFolderDrain()).status, "completed");
  const closed = await h.repository.getItemById(first._id);
  assert.equal(closed.metadata.workingFolderDrain.status, "provider_absent");
  assert.equal(closed.providerAttemptHistory.some((entry) => (
    entry.providerContactId === firstIdentity.providerContactId
    && entry.providerExternalLeadId === firstIdentity.providerExternalLeadId
  )), true);

  const weak = h.repository.addEvent({
    _id: "historical-review-then-dnc",
    providerCallId: "historical-review-call",
    ...firstIdentity,
    normalizedOutcome: "review",
    receivedAt: new Date("2026-07-11T00:31:00.000Z"),
  });
  h.setClock("2026-07-11T00:31:00.000Z");
  const weakResult = await h.runtime.drainCapturedEvent(weak);
  assert.equal(
    weakResult.status,
    "completed",
    h.repository.events.get(weak._id)?.lastError || "historical review should complete",
  );
  const afterWeak = await h.repository.getItemById(first._id);
  assert.equal(afterWeak.state, "follow_up_wait");
  assert.equal(afterWeak.totalAttemptCount, 1);
  assert.equal((await h.repository.getAgentById("bruce_allen")).providerCompletedCount, 1);

  const persistedEvent = h.repository.events.get(weak._id);
  const upgrade = buildCapturedEventUpgrade(copy(persistedEvent), {
    ...copy(persistedEvent),
    status: "pending",
    normalizedOutcome: "dnc",
    safePayload: {},
  });
  assert.ok(upgrade);
  mutate(persistedEvent, upgrade);
  assert.equal((await h.runtime.drainCapturedEvent(copy(persistedEvent))).status, "completed");

  const afterStrong = await h.repository.getItemById(first._id);
  const agent = await h.repository.getAgentById("bruce_allen");
  const dncHistory = afterStrong.providerAttemptHistory.filter((entry) => (
    Number(entry.attemptNumber) === 1 && entry.outcome === "dnc"
  ));
  assert.equal(afterStrong.state, "terminal");
  assert.equal(afterStrong.activeAttempt, false);
  assert.equal(afterStrong.lastOutcome, "dnc");
  assert.equal(afterStrong.totalAttemptCount, 1);
  assert.equal(afterStrong.dailyAttemptCount, 1);
  assert.equal(new Date(afterStrong.terminalAt).toISOString(), "2026-07-11T00:30:00.000Z");
  assert.equal(agent.providerCompletedCount, 1);
  assert.equal(dncHistory.length, 1);
  assert.equal(dncActions.length, 1);
  assert.equal(h.repository.events.get(weak._id).status, "completed");
  assert.equal(h.calls.length, 1);
  assert.equal(h.deletes.length, 1);
  assert.equal(new Set(cadenceActions.map((action) => action.idempotencyKey)).size, 1);
});

test("a late historical voicemail counts but cannot reopen a source-blocked item", async () => {
  const cadenceActions = [];
  const rows = [sourceRow(1)];
  const h = harness({
    rows,
    actionsEnabled: true,
    target: 1,
    refill: 0,
    handlers: {
      record_daily_dial: async (action) => { cadenceActions.push(copy(action)); },
    },
  });
  await ingestAndSeed(h);
  const first = acceptedItems(h.repository)[0];
  const firstIdentity = {
    providerContactId: first.providerContactId,
    providerExternalLeadId: first.providerExternalLeadId,
  };
  h.setClock("2026-07-11T00:30:00.000Z");
  assert.equal((await h.runtime.runEndOfDayFolderDrain()).status, "completed");

  Object.assign(rows[0], {
    sourceActive: false,
    callable: false,
    eligibility: { ok: false, reason: "source-dnc" },
  });
  // The EOD drain leaves the item `provider_absent` but still provider_accepted
  // — and sourceRefreshDecision PRESERVES provider_accepted on purpose (an item
  // already handed to the dialer is not the source sweep's to move). The
  // release of the prior-day tombstone belongs to the day-boundary seed, which
  // re-reads the source the moment it releases — and THAT is the path that
  // blocks a DNC'd item. This test used to expect tick() to do it, which was
  // the old owner.
  // 2026-07-11 is a SATURDAY, so the ordinary seed refuses (delivery window is
  // business-days-only). The preposition seed is the sanctioned off-window
  // entry, and the release sweep runs before any posting could happen — the
  // item blocks at the release's own source recheck, so there is nothing left
  // to post.
  h.setClock("2026-07-11T17:00:00.000Z");
  await h.runtime.seedAgent("bruce_allen", { preposition: true });
  const blocked = await h.repository.getItemById(first._id);
  assert.equal(blocked.state, "blocked");
  assert.equal(blocked.activeAttempt, false);
  assert.equal(blocked.sourcePool, null);
  assert.equal(blocked.providerAttemptHistory.some((entry) => (
    entry.providerContactId === firstIdentity.providerContactId
    && entry.providerExternalLeadId === firstIdentity.providerExternalLeadId
  )), true);
  const blockedReason = blocked.reservationReason;

  const late = h.repository.addEvent({
    _id: "late-voicemail-after-source-block",
    providerCallId: "late-voicemail-source-block-call",
    ...firstIdentity,
    normalizedOutcome: "voicemail",
    receivedAt: new Date("2026-07-11T07:01:00.000Z"),
  });
  h.setClock("2026-07-11T07:01:00.000Z");
  const lateResult = await h.runtime.drainCapturedEvent(late);
  assert.equal(
    lateResult.status,
    "completed",
    h.repository.events.get(late._id)?.lastError || "blocked historical call should complete",
  );

  const after = await h.repository.getItemById(first._id);
  const agent = await h.repository.getAgentById("bruce_allen");
  assert.equal(after.state, "blocked");
  assert.equal(after.activeAttempt, false);
  assert.equal(after.sourcePool, null);
  assert.equal(after.reservationReason, blockedReason);
  assert.equal(after.providerAttemptSequence, 1);
  assert.equal(after.providerContactId, null);
  assert.equal(after.providerExternalLeadId, null);
  assert.equal(after.metadata.workingFolderDrain.status, "released");
  assert.equal(after.totalAttemptCount, 1);
  assert.equal(after.providerAttemptHistory.some((entry) => (
    Number(entry.attemptNumber) === 1
    && entry.event === "completed"
    && entry.outcome === "voicemail"
  )), true);
  assert.equal(agent.providerCompletedCount, 1);
  assert.equal(agent.estimatedOutstanding, 0);
  assert.equal(cadenceActions.length, 1);
  assert.equal(h.repository.events.get(late._id).status, "completed");
  assert.equal((await h.runtime.seedAgent("bruce_allen")).accepted, 0);
  assert.equal(h.calls.length, 1);
  assert.equal(h.deletes.length, 1);
});

test("explicit preposition may refill a paused agent after the final daily close", async () => {
  const h = harness({
    rows: [sourceRow(1), sourceRow(2)],
    actionsEnabled: true,
    target: 1,
    refill: 0,
    deliveryWindowEvaluator: (value) => new Date(value).getTime() < new Date("2026-07-11T00:00:00.000Z").getTime(),
  });
  await ingestAndSeed(h);
  h.setClock("2026-07-11T00:30:00.000Z");
  assert.equal((await h.runtime.runEndOfDayFolderDrain()).status, "completed");

  const prepositioned = await h.runtime.seedAgent("bruce_allen", { preposition: true });
  const agent = await h.repository.getAgentById("bruce_allen");
  assert.equal(prepositioned.accepted, 1);
  assert.equal(h.providerContacts.size, 1);
  assert.equal(agent.operatorPaused, true);
  assert.equal(agent.shiftEnabled, false);

  // The completed close marker prevents the normal tick from deleting an
  // explicitly staged post-close packet.
  assert.equal((await h.runtime.runEndOfDayFolderDrain()).status, "completed");
  assert.equal(h.providerContacts.size, 1);
});
