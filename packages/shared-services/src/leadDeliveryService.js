"use strict";

// Provider-neutral lead-delivery decision owner.
//
// The decision functions remain pure. The runtime at the bottom of this file
// coordinates only injected persistence, source, clock, scheduler, provider,
// and downstream action ports; it reads no environment or legacy queue state.

const { createHash, randomUUID } = require("crypto");
const { resolveStatus, STATUS_TABLES } = require("../../shared-config/src/statusMap");

// Pure locator policy. Reads no environment: the allowlist is injected by the
// caller exactly like every other configuration input in this file.
const {
  resolveRecordingLocator,
} = require("./recordingReferencePromotionService");

const PACIFIC_TIME_ZONE = "America/Los_Angeles";
const POOLS = Object.freeze({
  NEW_TODAY: "new_today",
  OVERNIGHT: "overnight",
  OLDER_AVAILABLE: "older_available",
  FOLLOW_UP_DUE: "follow_up_due",
});
const POOL_VALUES = Object.freeze(Object.values(POOLS));
const DEFAULT_FALLBACK_POOL_ORDER = Object.freeze([
  POOLS.OVERNIGHT,
  POOLS.FOLLOW_UP_DUE,
  POOLS.OLDER_AVAILABLE,
]);
const SIMPLE_POOL_LOW_WATER = 5;
const SIMPLE_PACKET_SIZE = 20;
const SIMPLE_POOL_SUPPLY_REFRESH_MAX_BATCHES = 5;
const PRODUCTIVITY_REBALANCE_INTERVAL_MS = 15 * 60 * 1000;
const PRODUCTIVITY_REBALANCE_CUSHION_SIZE = 6;
const PRODUCTIVITY_REBALANCE_MINIMUM_CUSHION_AGE_DAYS = 17;
const CALL_RECOVERY_CONTACT_POLICY_ID = "long_call_recovery_120d_2x";
const CALL_RECOVERY_DNC_POLICY_ID = "full_dnc_loadin_30_60_90_logics_daily_v1";
const CALL_RECOVERY_LOGICS_POLICY_ID = "tag_active_prospect_only_v1";
// Spelled exactly as the work order §16 specifies. It was "call_recovery" here,
// which nothing would have caught until CR-6 started persisting it onto
// LeadDeliveryItem — at which point the stored inventory class and the contract
// that documents it would have disagreed forever, in live rows.
const CALL_RECOVERY_INVENTORY_CLASS = "callrail_long_call_recovery";
const CALL_RECOVERY_MAXIMUM_DAILY_ATTEMPTS = 2;
const CALL_RECOVERY_MINIMUM_RETRY_MINUTES = 120;
const CALL_RECOVERY_MAXIMUM_PROGRAM_AGE_DAYS = 120;
const SIMPLE_PROVIDER_STOP_STATUSES = new Set([
  "rate-limited",
  "provider-backpressure",
  "provider-lane-unavailable",
  "provider-lane-stopped",
]);
const SIMPLE_REFILL_RETRY_STATUSES = new Set([
  ...SIMPLE_PROVIDER_STOP_STATUSES,
  "pending-provider-post",
  "pool-operation-busy",
]);
const MAX_PRELOAD_WINDOW_CONTACTS = 5_000;
const END_OF_DAY_DRAIN_HOUR = 17;
const END_OF_DAY_DRAIN_MINUTE = 30;
const END_OF_DAY_DELETE_INTERVAL_MS = 750;
const END_OF_DAY_MAX_DELETES_PER_RUN = 500;
const END_OF_DAY_DRAIN_METADATA_KEY = "workingFolderDrain";
const PRODUCTIVITY_REBALANCE_METADATA_KEY = "productivityRebalance";
const DAY_START_METADATA_KEY = "simpleDayStart";
const DAY_START_MAX_SOURCE_BATCHES = 100;
const AGENT_POOL_OPERATION_KINDS = Object.freeze([
  "ordinary_refill",
  "immediate_fresh",
  "productivity",
  "day_start",
  "day_close",
]);
const AGENT_POOL_OPERATION_KIND_SET = new Set(AGENT_POOL_OPERATION_KINDS);
const NON_POOL_STATES = new Set([
  "reserved",
  "packetized",
  "provider_accepted",
  "in_call",
  "terminal",
  "blocked",
  "delivery_failed",
  "review",
]);
const RETRYABLE_OUTCOMES = new Set([
  "no_answer",
  "voicemail",
  "busy",
  "congestion",
  "intercept",
]);
const TERMINAL_OUTCOMES = new Set([
  "dnc",
  "bad_lead",
  "appointment",
  "client",
]);
// Logics status ids that must never be delivered, regardless of per-domain
// policy. 173 = "[Bad/Inactive]-DO NOT CALL" (WYNN 137190, 2026-07-24).
// Policy may widen this list but can no longer silently empty it.
const DEFAULT_DNC_STATUS_IDS = Object.freeze([173]);

// Phase 9: pre-serve authority is LeadCadence plus a fresh Logics status
// mirror. Keep the former CaseProfile veto block intact for the no-delete
// proof window, but make it unreachable in production admission.
const CASE_PROFILE_SOURCE_ELIGIBILITY_ENABLED = false;
const ACTIVE_ATTEMPT_STATES = new Set([
  "eligible",
  "reserved",
  "packetized",
  "provider_accepted",
  "in_call",
  "follow_up_wait",
  "delivery_failed",
  "review",
]);
const INACTIVE_ATTEMPT_STATES = new Set(["terminal", "blocked"]);
const OUTCOME_ALIASES = Object.freeze({
  noanswer: "no_answer",
  "no answer": "no_answer",
  voicemail: "voicemail",
  "left message": "voicemail",
  "left voicemail": "voicemail",
  "voicemail left": "voicemail",
  busy: "busy",
  "busy phone": "busy",
  "busy signal": "busy",
  congestion: "congestion",
  intercept: "intercept",
  dnc: "dnc",
  "do not call": "dnc",
  // An opt-out IS a do-not-call. Without these, a provider disposition of
  // "opt out" / "remove me" normalized to `review` — which stopped the dialling
  // (fail-closed, so nobody was harmed) but never recorded DURABLE suppression,
  // so the request died with the work item instead of outliving it. Found while
  // sweeping the recovery outcome matrix 2026-07-31; it applies to every lead,
  // not just recovery, which is why it belongs in the shared alias map.
  optout: "dnc",
  "opt out": "dnc",
  "opted out": "dnc",
  "remove me": "dnc",
  unsubscribe: "dnc",
  badlead: "bad_lead",
  "bad lead": "bad_lead",
  badnumber: "bad_lead",
  "bad number": "bad_lead",
  wrongnumber: "bad_lead",
  "wrong number": "bad_lead",
  appointment: "appointment",
  appointmentneedstime: "appointment",
  "appointment needs time": "appointment",
  client: "client",
  answered: "answered",
  answer: "answered",
});

function canMutateAgentPool({
  agent,
  operationKind,
  operationId = null,
  dayCloseDue = false,
  now = new Date(),
} = {}) {
  const kind = String(operationKind || "").trim().toLowerCase();
  if (!AGENT_POOL_OPERATION_KIND_SET.has(kind)) {
    throw new TypeError(`unsupported agent Pool operation kind ${kind || "<blank>"}`);
  }
  const at = parseDate(now, "now");
  const currentOperationId = String(agent?.poolOperationId || "").trim() || null;
  const currentOperationKind = String(agent?.poolOperationKind || "").trim().toLowerCase() || null;
  const requestedOperationId = String(operationId || "").trim() || null;
  const leaseExpiresAt = parseDate(agent?.poolOperationLeaseExpiresAt, "poolOperationLeaseExpiresAt", {
    nullable: true,
  });
  if (currentOperationId
    && leaseExpiresAt
    && leaseExpiresAt.getTime() > at.getTime()
    && currentOperationId !== requestedOperationId) {
    return {
      allowed: false,
      reason: "pool-operation-busy",
      currentOperationKind,
    };
  }
  if (dayCloseDue === true && kind !== "day_close") {
    return { allowed: false, reason: "day-close-precedence", currentOperationKind };
  }
  return { allowed: true, reason: "allowed", currentOperationKind };
}

function clone(value) {
  if (value == null || typeof value !== "object") return value;
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return value.map(clone);
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clone(entry)]));
}

function validateLeadDeliveryConfiguration(config = {}) {
  const errors = [];
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return { valid: false, errors: ["config must be an object"], enabledAgentIds: [] };
  }
  const topLevelFields = new Set(["defaults", "curatorFolders", "agents"]);
  const curatorFolderFields = new Set(["callbacksFolderId", "expiredDailyContactsFolderId"]);
  const defaultFields = new Set([
    "providerBufferTarget",
    "refillAtOrBelow",
    "freshReservationRange",
    "freshReservationMinutes",
    "activeEvidenceMinutes",
    "maxPendingFreshReservations",
  ]);
  const agentFields = new Set([
    "enabled",
    "displayName",
    "provider",
    "phoneBurnerMemberId",
    "phoneBurnerUsername",
    "applicationAccountEmail",
    "distributionFolderId",
    "receivingFolderId",
    "leadStreamId",
    "subscribedPools",
    "packetAllowances",
  ]);
  for (const field of Object.keys(config)) {
    if (!topLevelFields.has(field)) errors.push(`config contains unknown field ${field}`);
  }
  const defaults = config.defaults;
  if (!defaults || typeof defaults !== "object" || Array.isArray(defaults)) {
    errors.push("defaults must be an object");
  } else {
    for (const field of Object.keys(defaults)) {
      if (!defaultFields.has(field)) errors.push(`defaults contains unknown field ${field}`);
    }
    const integerRules = [
      ["providerBufferTarget", 1],
      ["refillAtOrBelow", 0],
      ["freshReservationRange", 0],
      ["freshReservationMinutes", 1],
      ["activeEvidenceMinutes", 1],
      ["maxPendingFreshReservations", 1],
    ];
    for (const [field, minimum] of integerRules) {
      if (!Number.isSafeInteger(defaults[field]) || defaults[field] < minimum) {
        errors.push(`defaults.${field} must be an integer >= ${minimum}`);
      }
    }
    if (Number.isSafeInteger(defaults.freshReservationMinutes)
      && defaults.freshReservationMinutes !== 15) {
      errors.push("defaults.freshReservationMinutes must remain 15");
    }
    if (Number.isSafeInteger(defaults.refillAtOrBelow)
      && Number.isSafeInteger(defaults.providerBufferTarget)
      && defaults.refillAtOrBelow >= defaults.providerBufferTarget) {
      errors.push("defaults.refillAtOrBelow must be below providerBufferTarget");
    }
    if (Number.isSafeInteger(defaults.freshReservationRange)
      && Number.isSafeInteger(defaults.providerBufferTarget)
      && defaults.freshReservationRange > defaults.providerBufferTarget) {
      errors.push("defaults.freshReservationRange cannot exceed providerBufferTarget");
    }
  }

  const agents = config.agents;
  if (!agents || typeof agents !== "object" || Array.isArray(agents)) {
    errors.push("agents must be an object");
    return { valid: false, errors, enabledAgentIds: [] };
  }

  const enabledAgentIds = [];
  const seenAgentIds = new Set();
  const uniqueValues = {
    folder: new Map(),
    leadStreamId: new Map(),
  };
  function remember(kind, value, agentId) {
    const normalized = String(value || "").trim().toLowerCase();
    if (!normalized) return;
    const prior = uniqueValues[kind].get(normalized);
    if (prior && prior !== agentId) errors.push(`${kind} is shared by ${prior} and ${agentId}`);
    else uniqueValues[kind].set(normalized, agentId);
  }

  const curatorFolders = config.curatorFolders;
  if (curatorFolders != null) {
    if (!curatorFolders || typeof curatorFolders !== "object" || Array.isArray(curatorFolders)) {
      errors.push("curatorFolders must be an object");
    } else {
      for (const field of Object.keys(curatorFolders)) {
        if (!curatorFolderFields.has(field)) errors.push(`curatorFolders contains unknown field ${field}`);
      }
      const callbacksFolderId = String(curatorFolders.callbacksFolderId || "").trim();
      const expiredFolderId = String(curatorFolders.expiredDailyContactsFolderId || "").trim();
      if (!/^[1-9]\d*$/.test(callbacksFolderId)) {
        errors.push("curatorFolders.callbacksFolderId must be a positive provider ID");
      }
      if (!/^[1-9]\d*$/.test(expiredFolderId)) {
        errors.push("curatorFolders.expiredDailyContactsFolderId must be a positive provider ID");
      }
      if (callbacksFolderId && expiredFolderId && callbacksFolderId === expiredFolderId) {
        errors.push("curatorFolders must use two different folders");
      }
      remember("folder", callbacksFolderId, "curatorFolders.callbacks");
      remember("folder", expiredFolderId, "curatorFolders.expiredDailyContacts");
    }
  }

  for (const [rawAgentId, entry] of Object.entries(agents).sort(([a], [b]) => a.localeCompare(b))) {
    const agentId = String(rawAgentId || "").trim().toLowerCase();
    const prefix = `agents.${rawAgentId}`;
    if (!agentId || !/^[a-z0-9][a-z0-9_-]*$/.test(agentId)) {
      errors.push(`${prefix} has an invalid agent key`);
      continue;
    }
    if (seenAgentIds.has(agentId)) errors.push(`${prefix} duplicates normalized agent key ${agentId}`);
    seenAgentIds.add(agentId);
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`${prefix} must be an object`);
      continue;
    }
    for (const field of Object.keys(entry)) {
      if (!agentFields.has(field)) errors.push(`${prefix} contains unknown field ${field}`);
    }
    if (typeof entry.enabled !== "boolean") errors.push(`${prefix}.enabled must be a boolean`);
    const enabled = entry.enabled === true;
    if (enabled) enabledAgentIds.push(agentId);
    if (String(entry.provider || "").trim().toLowerCase() !== "phoneburner") {
      errors.push(`${prefix}.provider must be phoneburner`);
    }

    const memberId = String(entry.phoneBurnerMemberId || "").trim();
    const username = String(entry.phoneBurnerUsername || "").trim();
    const applicationAccountEmail = String(entry.applicationAccountEmail || "").trim().toLowerCase();
    const distributionFolderId = String(entry.distributionFolderId || "").trim();
    const receivingFolderId = String(entry.receivingFolderId || "").trim();
    const leadStreamId = String(entry.leadStreamId || "").trim();
    remember("folder", distributionFolderId, agentId);
    remember("folder", receivingFolderId, agentId);
    remember("leadStreamId", leadStreamId, agentId);
    if (distributionFolderId && receivingFolderId
      && distributionFolderId.toLowerCase() === receivingFolderId.toLowerCase()) {
      errors.push(`${prefix} must use different distribution and receiving folders`);
    }
    if (memberId && username) errors.push(`${prefix} may configure at most one PhoneBurner owner identity`);
    if (applicationAccountEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(applicationAccountEmail)) {
      errors.push(`${prefix}.applicationAccountEmail must be an email when supplied`);
    }

    const subscriptions = Array.isArray(entry.subscribedPools)
      ? entry.subscribedPools.map((pool) => String(pool).trim().toLowerCase())
      : null;
    if (!subscriptions) errors.push(`${prefix}.subscribedPools must be an array`);
    const uniqueSubscriptions = subscriptions ? new Set(subscriptions) : new Set();
    if (subscriptions && uniqueSubscriptions.size !== subscriptions.length) {
      errors.push(`${prefix}.subscribedPools contains duplicates`);
    }
    for (const pool of uniqueSubscriptions) {
      if (!POOL_VALUES.includes(pool)) errors.push(`${prefix}.subscribedPools contains unknown pool ${pool}`);
    }
    const allowances = entry.packetAllowances;
    if (!allowances || typeof allowances !== "object" || Array.isArray(allowances)) {
      errors.push(`${prefix}.packetAllowances must be an object`);
    } else {
      for (const [pool, allowance] of Object.entries(allowances)) {
        if (!POOL_VALUES.includes(pool)) errors.push(`${prefix}.packetAllowances contains unknown pool ${pool}`);
        if (!Number.isSafeInteger(allowance) || allowance < 0) {
          errors.push(`${prefix}.packetAllowances.${pool} must be a non-negative integer`);
        }
      }
      for (const pool of uniqueSubscriptions) {
        if ((allowances[pool] ?? 0) <= 0) errors.push(`${prefix}.packetAllowances.${pool} must be positive when subscribed`);
      }
    }

    if (enabled) {
      if (!String(entry.displayName || "").trim()) errors.push(`${prefix}.displayName is required when enabled`);
      if (!distributionFolderId) errors.push(`${prefix}.distributionFolderId is required when enabled`);
      if (!receivingFolderId) errors.push(`${prefix}.receivingFolderId is required when enabled`);
      if (!uniqueSubscriptions.size) errors.push(`${prefix} requires at least one subscribed pool when enabled`);
    }
  }
  return { valid: errors.length === 0, errors, enabledAgentIds };
}

function parseDate(value, fieldName, { nullable = false } = {}) {
  if (value == null || value === "") {
    if (nullable) return null;
    throw new TypeError(`${fieldName} is required`);
  }
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError(`${fieldName} must be a valid date`);
  return date;
}

function nonNegativeInteger(value, fieldName) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || !Number.isInteger(number)) {
    throw new TypeError(`${fieldName} must be a non-negative integer`);
  }
  return number;
}

function positiveInteger(value, fieldName) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || !Number.isInteger(number)) {
    throw new TypeError(`${fieldName} must be a positive integer`);
  }
  return number;
}

function zonedParts(value, timeZone = PACIFIC_TIME_ZONE) {
  const date = parseDate(value, "date");
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "longOffset",
  }).formatToParts(date);
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const zoneName = String(lookup.timeZoneName || "");
  const match = zoneName.match(/^GMT(?:(?<offset>[+-]\d{2}:\d{2})|$)/);
  const offset = match?.groups?.offset || "+00:00";
  return {
    year: lookup.year,
    month: lookup.month,
    day: lookup.day,
    hour: lookup.hour,
    minute: lookup.minute,
    second: lookup.second,
    offset,
  };
}

function getPacificDateKey(value) {
  const parts = zonedParts(value, PACIFIC_TIME_ZONE);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function isPacificBusinessDay(value = new Date()) {
  const date = parseDate(value, "value");
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: PACIFIC_TIME_ZONE,
    weekday: "short",
  }).format(date);
  return weekday !== "Sat" && weekday !== "Sun";
}

function getPacificHourKey(value) {
  const parts = zonedParts(value, PACIFIC_TIME_ZONE);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}${parts.offset}`;
}

function pacificLocalDateTime(year, month, day, hour, minute) {
  const desiredAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let candidate = desiredAsUtc;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = zonedParts(new Date(candidate), PACIFIC_TIME_ZONE);
    const renderedAsUtc = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
      0,
    );
    const delta = desiredAsUtc - renderedAsUtc;
    candidate += delta;
    if (delta === 0) break;
  }
  return new Date(candidate);
}

function resolvePacificMorningBatchWindow(value, {
  cutoffHour = 7,
  cutoffMinute = 50,
} = {}) {
  const at = parseDate(value, "value");
  const hour = nonNegativeInteger(cutoffHour, "cutoffHour");
  const minute = nonNegativeInteger(cutoffMinute, "cutoffMinute");
  if (hour > 23 || minute > 59) throw new RangeError("morning cutoff must be a valid Pacific time");
  const parts = zonedParts(at, PACIFIC_TIME_ZONE);
  let cutoffAt = pacificLocalDateTime(
    Number(parts.year),
    Number(parts.month),
    Number(parts.day),
    hour,
    minute,
  );
  if (at.getTime() < cutoffAt.getTime()) {
    cutoffAt = pacificLocalDateTime(
      Number(parts.year),
      Number(parts.month),
      Number(parts.day) - 1,
      hour,
      minute,
    );
  }
  return {
    batchKey: getPacificDateKey(cutoffAt),
    cutoffAt,
  };
}

function assignPacificMorningBatch(item = {}, {
  now,
  cutoffHour = 7,
  cutoffMinute = 50,
} = {}) {
  if (item.lastContactAt != null && item.lastContactAt !== "") return null;
  if (nonNegativeInteger(item.totalAttemptCount ?? 0, "totalAttemptCount") > 0) return null;
  const receivedAt = parseDate(item.receivedAt, "receivedAt");
  const window = resolvePacificMorningBatchWindow(now, { cutoffHour, cutoffMinute });
  if (receivedAt.getTime() >= window.cutoffAt.getTime()) return null;
  return {
    overnightBatchKey: window.batchKey,
    // Smaller means newer. Persisting the age-at-cutoff gives deterministic
    // newest-first order without depending on Mongo scan order.
    overnightOrder: Math.max(0, window.cutoffAt.getTime() - receivedAt.getTime()),
  };
}

function isPacificDeliveryWindowOpen(value, {
  startHour = 7,
  startMinute = 50,
  endHour = 17,
  endMinute = 0,
} = {}) {
  if (!isPacificBusinessDay(value)) return false;
  const parts = zonedParts(value, PACIFIC_TIME_ZONE);
  const minuteOfDay = (Number(parts.hour) * 60) + Number(parts.minute);
  const start = (nonNegativeInteger(startHour, "startHour") * 60)
    + nonNegativeInteger(startMinute, "startMinute");
  const end = (nonNegativeInteger(endHour, "endHour") * 60)
    + nonNegativeInteger(endMinute, "endMinute");
  if (start >= end || end > 24 * 60) throw new RangeError("delivery window must be within one day");
  return minuteOfDay >= start && minuteOfDay < end;
}

function resolvePacificEndOfDayDrain(value, {
  hour = END_OF_DAY_DRAIN_HOUR,
  minute = END_OF_DAY_DRAIN_MINUTE,
} = {}) {
  const at = parseDate(value, "value");
  const closeHour = nonNegativeInteger(hour, "hour");
  const closeMinute = nonNegativeInteger(minute, "minute");
  if (closeHour > 23 || closeMinute > 59) {
    throw new RangeError("end-of-day drain must be a valid Pacific time");
  }
  const parts = zonedParts(at, PACIFIC_TIME_ZONE);
  const minuteOfDay = (Number(parts.hour) * 60) + Number(parts.minute);
  return {
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    due: minuteOfDay >= (closeHour * 60) + closeMinute,
    minuteOfDay,
  };
}

function resolveLeadDeliveryTickMode(value, {
  deliveryWindowEvaluator = isPacificDeliveryWindowOpen,
  closeHour = END_OF_DAY_DRAIN_HOUR,
  closeMinute = END_OF_DAY_DRAIN_MINUTE,
  completedCloseDateKey = null,
} = {}) {
  const at = parseDate(value, "value");
  if (!isPacificBusinessDay(at)) return "weekend_idle";
  if (deliveryWindowEvaluator(at) === true) return "delivery_open";
  const close = resolvePacificEndOfDayDrain(at, { hour: closeHour, minute: closeMinute });
  if (close.due) {
    return completedCloseDateKey === close.dateKey
      ? "close_complete_event_drain"
      : "close_due";
  }
  const parts = zonedParts(at, PACIFIC_TIME_ZONE);
  const minuteOfDay = (Number(parts.hour) * 60) + Number(parts.minute);
  return minuteOfDay < (7 * 60) + 50
    ? "preopen_event_drain"
    : "postwindow_event_drain";
}

function stableWorkItemId(item = {}) {
  const explicit = String(item.workItemId || item._id || item.id || "").trim();
  if (explicit) return explicit;
  const domain = String(item.domain || "").trim().toUpperCase();
  const caseId = String(item.caseId ?? "").trim();
  if (domain && caseId) return `${domain}:${caseId}`;
  throw new TypeError("work item requires a stable identity");
}

function canonicalSourceIdentity(item = {}) {
  const domain = String(item.domain || "").trim().toUpperCase();
  const caseId = String(item.caseId ?? "").trim();
  if (!domain || !caseId) throw new TypeError("work item requires canonical source identity");
  return { domain, caseId };
}

function isActiveAttemptState(value) {
  const state = String(value || "").trim().toLowerCase();
  if (ACTIVE_ATTEMPT_STATES.has(state)) return true;
  if (INACTIVE_ATTEMPT_STATES.has(state)) return false;
  throw new TypeError(`unknown lead-delivery state: ${state || "missing"}`);
}

function buildProviderAttemptKey(input = {}) {
  const provider = String(input.provider || "phoneburner").trim().toLowerCase();
  const callId = String(input.providerCallId || "").trim();
  const contactId = String(input.providerContactId || "").trim();
  const externalId = String(input.providerExternalLeadId || "").trim();
  if (!provider || !callId || !contactId || !externalId) {
    throw new TypeError("provider attempt requires call, contact, and external identity");
  }
  return `v1:${createHash("sha256")
    .update(["provider-attempt", provider, callId, contactId, externalId].join("|"))
    .digest("hex")}`;
}

function existingCountedProviderAttemptKey(item = {}) {
  const explicit = String(item.lastCountedProviderAttemptKey || "").trim();
  if (explicit) return explicit;
  const countedCallId = String(item.lastCountedProviderCallId || "").trim();
  if (!countedCallId) return null;
  const history = Array.isArray(item.providerAttemptHistory)
    ? [...item.providerAttemptHistory].reverse()
    : [];
  const completed = history.find((entry) => (
    String(entry?.event || "").trim().toLowerCase() === "completed"
    && String(entry?.providerCallId || "").trim() === countedCallId
    && String(entry?.providerContactId || "").trim()
    && String(entry?.providerExternalLeadId || "").trim()
  ));
  if (!completed) return null;
  try {
    return buildProviderAttemptKey({
      provider: completed.provider || item.provider,
      providerCallId: completed.providerCallId,
      providerContactId: completed.providerContactId,
      providerExternalLeadId: completed.providerExternalLeadId,
    });
  } catch {
    return null;
  }
}

function buildEventDedupeKey(input = {}) {
  const provider = String(input.provider || "").trim().toLowerCase();
  const eventType = String(input.eventType || "").trim().toLowerCase();
  if (!provider) throw new TypeError("provider is required");
  if (!eventType) throw new TypeError("eventType is required");
  const providerEventId = String(input.providerEventId || "").trim();
  const providerCallId = String(input.providerCallId || "").trim();
  const providerContactId = String(input.providerContactId || "").trim();
  const providerExternalLeadId = String(input.providerExternalLeadId || "").trim();
  const status = String(input.status || "").trim().toLowerCase();
  const payloadDigest = String(input.payloadDigest || "").trim().toLowerCase();
  let material;
  if (providerCallId && providerContactId && providerExternalLeadId) {
    // A call is the physical attempt. Its type-scoped identity wins even when
    // two PhoneBurner hook configurations attach different callback IDs.
    material = `provider-call-event|${buildProviderAttemptKey(input)}|${eventType}`;
  } else if (providerEventId) {
    material = `provider-event|${provider}|${providerEventId}`;
  } else {
    if (status === "review" && /^[a-f0-9]{64}$/.test(payloadDigest)) {
      // A malformed/observational callback may have no occurrence identity.
      // It is safe to retain for review by payload digest, but this key must
      // never make the event processable or eligible to mutate a work item.
      material = [
        "review-payload",
        provider,
        eventType,
        providerContactId,
        providerExternalLeadId,
        payloadDigest,
      ].join("|");
    } else {
      throw new TypeError("providerEventId or providerCallId is required for a processable event");
    }
  }
  return `v1:${createHash("sha256").update(material).digest("hex")}`;
}

function classifyCapturedProviderEvent(event = {}) {
  const eventType = String(event.eventType || "").trim().toLowerCase();
  const providerEventId = String(event.providerEventId || "").trim();
  const providerCallId = String(event.providerCallId || "").trim();
  const providerContactId = String(event.providerContactId || "").trim();
  const providerExternalLeadId = String(event.providerExternalLeadId || "").trim();
  const hasLeadIdentity = Boolean(providerContactId || providerExternalLeadId);
  const occurrenceIdentity = providerEventId || providerCallId;
  const identityStrength = providerCallId && providerContactId && providerExternalLeadId
    ? "call-contact-external"
    : providerCallId && hasLeadIdentity
      ? "call-and-lead"
      : providerEventId && hasLeadIdentity
        ? "event-and-lead"
        : hasLeadIdentity
          ? "lead-only"
          : occurrenceIdentity
            ? "occurrence-only"
            : "none";

  if (!["contact_displayed", "call_begin", "call_done"].includes(eventType)) {
    return {
      status: "review",
      normalizedOutcome: null,
      reason: "unsupported-event-type",
      identityStrength,
    };
  }
  if (!hasLeadIdentity) {
    return {
      status: "review",
      normalizedOutcome: eventType === "call_done" ? normalizeOutcome(event.rawDisposition) : null,
      reason: "missing-hard-provider-identity",
      identityStrength,
    };
  }
  if (!occurrenceIdentity) {
    return {
      status: "review",
      normalizedOutcome: eventType === "call_done" ? normalizeOutcome(event.rawDisposition) : null,
      reason: "missing-provider-occurrence-identity",
      identityStrength,
    };
  }
  if (["call_begin", "call_done"].includes(eventType) && !providerCallId) {
    return {
      status: "review",
      normalizedOutcome: eventType === "call_done" ? normalizeOutcome(event.rawDisposition) : null,
      reason: "missing-provider-call-identity",
      identityStrength,
    };
  }
  if (["call_begin", "call_done"].includes(eventType)
    && (!providerContactId || !providerExternalLeadId)) {
    return {
      status: "review",
      normalizedOutcome: normalizeOutcome(event.rawDisposition),
      reason: "incomplete-provider-attempt-identity",
      identityStrength,
    };
  }
  const normalizedOutcome = eventType === "call_done"
    ? normalizeOutcome(event.rawDisposition)
    : null;
  return {
    status: "pending",
    normalizedOutcome,
    reason: "captured-for-replay",
    identityStrength,
  };
}

function buildCapturedEventUpgrade(existing = {}, incoming = {}, { allowedRecordingHosts = [] } = {}) {
  const existingStatus = String(existing.status || "").trim();
  const existingOutcome = normalizeOutcome(existing.normalizedOutcome);
  const incomingOutcome = normalizeOutcome(incoming.normalizedOutcome);
  // A retained provider reference counts as recording evidence on exactly the
  // same terms as a validated URL, but only ever at the weaker rank — so an
  // arriving reference can fill an empty slot or be strengthened by a later
  // validated URL, and can never overwrite one.
  const existingRecording = resolveRecordingLocator(existing.safePayload, {
    allowedHosts: allowedRecordingHosts,
  });
  const incomingRecording = resolveRecordingLocator(incoming.safePayload, {
    allowedHosts: allowedRecordingHosts,
  });
  const recordingEvidenceUpgrade = Boolean(incomingRecording.recordingUrl)
    && incomingRecording.rank > existingRecording.rank;
  const recordingEvidenceConflict = Boolean(
    existingRecording.recordingUrl
      && incomingRecording.recordingUrl
      && incomingRecording.rank === existingRecording.rank
      && existingRecording.recordingUrl !== incomingRecording.recordingUrl,
  );
  const strongerCallDoneOutcome = String(existing.eventType || "").trim().toLowerCase() === "call_done"
    && ["answered", "review"].includes(existingOutcome)
    && !["answered", "review"].includes(incomingOutcome);
  const upgradeableWeakStatus = ["pending", "processing", "failed", "completed"].includes(existingStatus)
    && (strongerCallDoneOutcome || recordingEvidenceUpgrade || recordingEvidenceConflict);
  if (existingStatus !== "review" && !upgradeableWeakStatus) return null;
  if (String(incoming.status || "").trim() !== "pending") return null;
  if (String(existing.provider || "").trim().toLowerCase()
    !== String(incoming.provider || "").trim().toLowerCase()) return null;
  if (String(existing.eventType || "").trim().toLowerCase()
    !== String(incoming.eventType || "").trim().toLowerCase()) return null;
  const fields = ["providerCallId", "providerContactId", "providerExternalLeadId"];
  const set = {};
  for (const field of fields) {
    const before = String(existing[field] || "").trim();
    const after = String(incoming[field] || "").trim();
    if (before && after && before !== after) return null;
    if (!before && after) set[field] = after;
  }
  if (recordingEvidenceConflict) {
    return {
      expected: { status: existingStatus },
      set: {
        ...set,
        status: "review",
        nextAttemptAt: null,
        processingLeaseId: null,
        processingLeaseExpiresAt: null,
        lastError: "recording-evidence-conflict",
      },
    };
  }
  if (!strongerCallDoneOutcome && !recordingEvidenceUpgrade) return null;
  const outcome = strongerCallDoneOutcome ? incomingOutcome : existingOutcome;
  const safePayload = clone(existing.safePayload || {});
  for (const [key, value] of Object.entries(incoming.safePayload || {})) {
    if (value != null) safePayload[key] = clone(value);
  }
  return {
    expected: { status: existingStatus },
    set: {
      ...set,
      status: "pending",
      normalizedOutcome: outcome,
      safePayload,
      nextAttemptAt: null,
      localAppliedAt: strongerCallDoneOutcome ? null : (existing.localAppliedAt || null),
      // A recording-only upgrade reopens only the exact DailyDial evidence
      // projection. Preserving the prior downstream marker lets the drain
      // distinguish that narrow replay from an outcome upgrade or a failed
      // downstream attempt, both of which still need the normal action path.
      downstreamAppliedAt: recordingEvidenceUpgrade && !strongerCallDoneOutcome
        ? (existing.downstreamAppliedAt || null)
        : null,
      processedAt: null,
      processingLeaseId: null,
      processingLeaseExpiresAt: null,
      lastError: null,
    },
  };
}

function providerAttemptScopes(candidate = {}) {
  const fields = ["providerExternalLeadId", "providerContactId", "providerCallId"];
  const scopes = new Map();
  function merge(key, source) {
    if (!source || typeof source !== "object") return;
    const attemptMatch = String(key).match(/^attempt:(\d+)$/);
    const scope = scopes.get(key) || {
      conflict: false,
      attemptNumber: attemptMatch ? Number(attemptMatch[1]) : null,
    };
    for (const field of fields) {
      const value = String(source[field] || "").trim();
      if (!value) continue;
      if (scope[field] && scope[field] !== value) scope.conflict = true;
      else scope[field] = value;
    }
    scopes.set(key, scope);
  }
  const currentSequence = nonNegativeInteger(
    candidate.providerAttemptSequence ?? 0,
    "providerAttemptSequence",
  );
  merge(currentSequence > 0 ? `attempt:${currentSequence}` : "current", candidate);
  for (const event of Array.isArray(candidate.providerAttemptHistory)
    ? candidate.providerAttemptHistory
    : []) {
    let attemptNumber;
    try {
      attemptNumber = positiveInteger(event?.attemptNumber, "providerAttemptHistory.attemptNumber");
    } catch {
      continue;
    }
    merge(`attempt:${attemptNumber}`, event);
  }
  return [...scopes.values()];
}

function candidateContainsProvider(candidate = {}, provider) {
  const expected = String(provider || "").trim().toLowerCase();
  if (!expected) return false;
  if (String(candidate.provider || "").trim().toLowerCase() === expected) return true;
  return (Array.isArray(candidate.providerAttemptHistory) ? candidate.providerAttemptHistory : [])
    .some((entry) => String(entry?.provider || "").trim().toLowerCase() === expected);
}

function providerAttemptContext(item = {}, event = {}, attemptNumber) {
  const number = Number(attemptNumber || 0);
  if (!Number.isInteger(number) || number < 1) return null;
  const provider = String(event.provider || "").trim().toLowerCase();
  const contactId = String(event.providerContactId || "").trim();
  const externalId = String(event.providerExternalLeadId || "").trim();
  if (!provider || !contactId || !externalId) return null;
  const entries = (Array.isArray(item.providerAttemptHistory) ? item.providerAttemptHistory : [])
    .filter((entry) => Number(entry?.attemptNumber || 0) === number);
  const identityEntries = entries.filter((entry) => (
    String(entry?.provider || "").trim().toLowerCase() === provider
    && String(entry?.providerContactId || "").trim() === contactId
    && String(entry?.providerExternalLeadId || "").trim() === externalId
  ));
  if (!identityEntries.length) return null;
  const accepted = [...identityEntries].reverse().find((entry) => (
    ["accepted", "call_begin", "completed"].includes(String(entry?.event || "").trim().toLowerCase())
  ));
  if (!accepted) return null;
  const agentEntry = [...identityEntries].reverse().find((entry) => (
    String(entry?.deliveryAgentId || "").trim()
  ));
  const deliveryAgentId = String(agentEntry?.deliveryAgentId || "").trim().toLowerCase();
  if (!deliveryAgentId) return null;
  function latestOccurredAt(eventName) {
    const entry = [...identityEntries].reverse().find((candidate) => (
      String(candidate?.event || "").trim().toLowerCase() === eventName
    ));
    if (!entry?.occurredAt) return null;
    try {
      return parseDate(entry.occurredAt, `providerAttemptHistory.${eventName}.occurredAt`);
    } catch {
      return null;
    }
  }
  return {
    attemptNumber: number,
    provider,
    providerContactId: contactId,
    providerExternalLeadId: externalId,
    deliveryAgentId,
    packetId: String(agentEntry?.packetId || "").trim() || null,
    entries: identityEntries,
    acceptedAt: latestOccurredAt("accepted"),
    callBeginAt: latestOccurredAt("call_begin"),
    providerRemovedAt: latestOccurredAt("provider_removed"),
    completedAt: latestOccurredAt("completed"),
  };
}

function completedProviderAttemptKey(context = {}) {
  for (const entry of Array.isArray(context.entries) ? context.entries : []) {
    if (String(entry?.event || "").trim().toLowerCase() !== "completed") continue;
    try {
      return buildProviderAttemptKey({
        provider: entry.provider || context.provider,
        providerCallId: entry.providerCallId,
        providerContactId: entry.providerContactId,
        providerExternalLeadId: entry.providerExternalLeadId,
      });
    } catch {
      return "conflict";
    }
  }
  return null;
}

function resolveProviderEventItem(candidates = [], event = {}) {
  if (!Array.isArray(candidates)) throw new TypeError("candidates must be an array");
  const provider = String(event.provider || "").trim().toLowerCase();
  if (!provider) throw new TypeError("event.provider is required");
  const identityFields = [
    "providerExternalLeadId",
    "providerContactId",
    "providerCallId",
  ];
  const supplied = identityFields
    .map((field) => [field, String(event[field] || "").trim()])
    .filter(([, value]) => Boolean(value));
  if (!supplied.length) return { status: "unresolved", reason: "provider-identity-missing", item: null };

  // PhoneBurner's Call End payload uses a session-scoped call identifier that
  // can repeat across contacts in one dial session. The contact ID plus our
  // unique external lead ID are the exact physical-attempt identity. When that
  // pair agrees, it is authoritative and a reused call ID cannot veto it.
  const incomingExternalId = String(event.providerExternalLeadId || "").trim();
  const incomingContactId = String(event.providerContactId || "").trim();
  if (incomingExternalId && incomingContactId) {
    const currentPairMatches = candidates.filter((candidate) => (
      String(candidate?.provider || "").trim().toLowerCase() === provider
      && String(candidate?.providerExternalLeadId || "").trim() === incomingExternalId
      && String(candidate?.providerContactId || "").trim() === incomingContactId
      && candidate?.activeAttempt === true
      && ["provider_accepted", "in_call"].includes(String(candidate?.state || "").trim().toLowerCase())
    ));
    if (currentPairMatches.length === 1) {
      return {
        status: "resolved",
        reason: "provider-current-contact-external-match",
        item: currentPairMatches[0],
        attemptNumber: Number(currentPairMatches[0].providerAttemptSequence || 0) || null,
      };
    }
    const exactPairMatches = [];
    for (const candidate of candidates) {
      if (!candidateContainsProvider(candidate, provider)) continue;
      for (const scope of providerAttemptScopes(candidate)) {
        if (scope.conflict === true) continue;
        if (String(scope.providerExternalLeadId || "").trim() === incomingExternalId
          && String(scope.providerContactId || "").trim() === incomingContactId) {
          const key = `${stableWorkItemId(candidate)}:${scope.attemptNumber ?? "current"}`;
          if (!exactPairMatches.some((match) => match.key === key)) {
            exactPairMatches.push({ key, item: candidate, attemptNumber: scope.attemptNumber });
          }
        }
      }
    }
    if (exactPairMatches.length === 1) {
      return {
        status: "resolved",
        reason: "provider-contact-external-match",
        item: exactPairMatches[0].item,
        attemptNumber: exactPairMatches[0].attemptNumber,
      };
    }
    if (exactPairMatches.length > 1) {
      return { status: "conflict", reason: "multiple-compatible-provider-identities", item: null };
    }
  }

  const compatible = [];
  let anyIdentityMatch = false;
  let contradictoryMatch = false;
  for (const candidate of candidates) {
    if (!candidateContainsProvider(candidate, provider)) continue;
    const compatibleAttempts = [];
    for (const scope of providerAttemptScopes(candidate)) {
      let matched = 0;
      let contradicted = scope.conflict === true;
      for (const [field, incoming] of supplied) {
        const stored = String(scope?.[field] || "").trim();
        if (stored === incoming) {
          matched += 1;
          anyIdentityMatch = true;
        } else if (stored) {
          contradicted = true;
        }
      }
      if (matched > 0 && contradicted) contradictoryMatch = true;
      if (matched > 0 && !contradicted) {
        compatibleAttempts.push(scope.attemptNumber);
      }
    }
    if (compatibleAttempts.length > 1) contradictoryMatch = true;
    if (compatibleAttempts.length === 1) {
      compatible.push({ item: candidate, attemptNumber: compatibleAttempts[0] });
    }
  }
  if (compatible.length === 1 && !contradictoryMatch) {
    return {
      status: "resolved",
      reason: "provider-identity-match",
      item: compatible[0].item,
      attemptNumber: compatible[0].attemptNumber,
    };
  }
  if (compatible.length > 1) {
    return { status: "conflict", reason: "multiple-compatible-provider-identities", item: null };
  }
  return anyIdentityMatch || contradictoryMatch
    ? { status: "conflict", reason: "provider-identities-contradict", item: null }
    : { status: "unresolved", reason: "provider-identity-not-found", item: null };
}

function getEffectiveDailyAttemptCount(item = {}, now) {
  const today = getPacificDateKey(now);
  const storedKey = String(item.dailyAttemptDateKey || "").trim();
  const storedCount = nonNegativeInteger(item.dailyAttemptCount ?? 0, "dailyAttemptCount");
  if (!storedKey && storedCount > 0) {
    throw new TypeError("dailyAttemptDateKey is required when dailyAttemptCount is positive");
  }
  const keyMatch = storedKey.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const keyDate = keyMatch
    ? new Date(Date.UTC(Number(keyMatch[1]), Number(keyMatch[2]) - 1, Number(keyMatch[3]), 12))
    : null;
  const roundTripKey = keyDate && Number.isFinite(keyDate.getTime())
    ? `${keyDate.getUTCFullYear()}-${String(keyDate.getUTCMonth() + 1).padStart(2, "0")}-${String(keyDate.getUTCDate()).padStart(2, "0")}`
    : null;
  if (storedKey && roundTripKey !== storedKey) {
    throw new TypeError("dailyAttemptDateKey must use YYYY-MM-DD");
  }
  if (storedKey > today) throw new TypeError("dailyAttemptDateKey cannot be in the future");
  if (storedKey !== today) return 0;
  return storedCount;
}

function leadAgeInPacificDays(item = {}, now) {
  const received = parseDate(item.receivedAt, "receivedAt");
  const at = parseDate(now, "now");
  const ordinal = (value) => {
    const [year, month, day] = getPacificDateKey(value).split("-").map(Number);
    return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
  };
  return Math.max(0, ordinal(at) - ordinal(received));
}

function planProductivityPoolCull(items = [], {
  now,
  cushionSize = PRODUCTIVITY_REBALANCE_CUSHION_SIZE,
  minimumCushionAgeDays = PRODUCTIVITY_REBALANCE_MINIMUM_CUSHION_AGE_DAYS,
} = {}) {
  const at = parseDate(now, "now");
  const requestedCushion = positiveInteger(cushionSize, "cushionSize");
  const minimumAge = nonNegativeInteger(minimumCushionAgeDays, "minimumCushionAgeDays");
  const rows = Array.isArray(items) ? items : [];
  const unresolved = rows.filter((item) => !String(item?.providerContactId || "").trim());
  if (unresolved.length > 0) {
    return { status: "identity-unresolved", retained: [], removed: [], unresolvedCount: unresolved.length };
  }
  if (rows.some((item) => String(item?.state || "").trim().toLowerCase() === "in_call")) {
    return { status: "in-call", retained: [], removed: [], unresolvedCount: 0 };
  }
  const aged = rows
    .filter((item) => leadAgeInPacificDays(item, at) >= minimumAge)
    .sort((left, right) => {
      const ageDelta = leadAgeInPacificDays(right, at) - leadAgeInPacificDays(left, at);
      return ageDelta || compareStable(left, right);
    });
  const retainedIds = new Set(aged.slice(0, requestedCushion).map(stableWorkItemId));
  return {
    status: "planned",
    retained: rows.filter((item) => retainedIds.has(stableWorkItemId(item))),
    removed: rows.filter((item) => !retainedIds.has(stableWorkItemId(item))),
    unresolvedCount: 0,
    agedCount: aged.length,
    missingCushionCount: Math.max(0, requestedCushion - aged.length),
  };
}

function dailyAttemptLimitForLeadAge(item = {}, { now, maximum = 3 } = {}) {
  const configuredMaximum = positiveInteger(maximum, "maximum");
  const ageDays = leadAgeInPacificDays(item, now);
  if (ageDays <= 1) return Math.min(configuredMaximum, 3);
  if (ageDays <= 16) return Math.min(configuredMaximum, 2);
  if (ageDays <= 31) return Math.min(configuredMaximum, 1);
  return Math.min(configuredMaximum, 1);
}

function retryDelayMinutesForLeadAge(item = {}, { now } = {}) {
  return leadAgeInPacificDays(item, now) >= 32 ? 15 * 24 * 60 : 120;
}

function getPacificWeekday(value) {
  const label = new Intl.DateTimeFormat("en-US", {
    timeZone: PACIFIC_TIME_ZONE,
    weekday: "short",
  }).format(parseDate(value, "value"));
  return { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[label] ?? -1;
}

function resolveRecoveryEpisodeTiming(firstQualifyingCallAt, {
  startHour = 7,
  startMinute = 50,
  maximumProgramAgeDays = CALL_RECOVERY_MAXIMUM_PROGRAM_AGE_DAYS,
  activeWeekdays = [1, 2, 3, 4, 5],
} = {}) {
  const firstAt = parseDate(firstQualifyingCallAt, "firstQualifyingCallAt");
  const hour = nonNegativeInteger(startHour, "startHour");
  const minute = nonNegativeInteger(startMinute, "startMinute");
  const ageDays = positiveInteger(maximumProgramAgeDays, "maximumProgramAgeDays");
  if (hour > 23 || minute > 59) throw new RangeError("recovery start must be a valid Pacific time");
  const weekdays = [...new Set(activeWeekdays.map((value) => nonNegativeInteger(value, "activeWeekday")))];
  if (weekdays.length === 0 || weekdays.some((value) => value > 6)) {
    throw new RangeError("activeWeekdays must contain Pacific weekdays 0 through 6");
  }

  const firstParts = zonedParts(firstAt, PACIFIC_TIME_ZONE);
  let eligibleFrom = null;
  for (let offset = 1; offset <= 14; offset += 1) {
    const candidate = pacificLocalDateTime(
      Number(firstParts.year),
      Number(firstParts.month),
      Number(firstParts.day) + offset,
      hour,
      minute,
    );
    if (weekdays.includes(getPacificWeekday(candidate))) {
      eligibleFrom = candidate;
      break;
    }
  }
  if (!eligibleFrom) throw new Error("could not resolve the next Pacific business window");

  const expiresAt = pacificLocalDateTime(
    Number(firstParts.year),
    Number(firstParts.month),
    Number(firstParts.day) + ageDays,
    Number(firstParts.hour),
    Number(firstParts.minute),
  );
  expiresAt.setTime(
    expiresAt.getTime()
      + Number(firstParts.second || 0) * 1000
      + firstAt.getUTCMilliseconds(),
  );

  return {
    eligibleFrom,
    expiresAt,
    timeZone: PACIFIC_TIME_ZONE,
  };
}

function isCallRecoveryItem(item = {}) {
  return String(item.contactPolicyId || item.contactPolicy || "").trim().toLowerCase()
    === CALL_RECOVERY_CONTACT_POLICY_ID;
}

function observableSourceCursor(cursor) {
  if (!cursor) return null;
  // The composite recovery source deliberately encodes its paging position as
  // `recovery:<episode id>` with Date(0). That sentinel is valid internally,
  // but the episode id can contain case identity and the epoch timestamp looks
  // like a dead runtime on health dashboards. Keep the codec private.
  if (String(cursor.id || "").startsWith("recovery:")) {
    return { kind: "recovery", positioned: true };
  }
  return clone(cursor);
}

/**
 * Recovery's own current-Logics policy.
 *
 * The ordinary cadence accepts a configured list of prospect status ids. This
 * program must not inherit that list: it is a TAG-only recovery program and
 * the current Logics state is a claim-time safety gate. A mapped Active
 * Prospect is callable, a proved DNC/non-prospect is terminal, and missing,
 * unmapped, or contradictory evidence holds.
 */
function resolveCallRecoveryLogicsEligibility({
  domain,
  statusId = null,
  statusText = null,
} = {}) {
  const normalizedDomain = String(domain || "").trim().toUpperCase();
  const base = {
    logicsPolicyId: CALL_RECOVERY_LOGICS_POLICY_ID,
    allowedProspectStatus: null,
    entityDnc: null,
    decision: "hold",
  };
  if (normalizedDomain !== "TAG") {
    return { ...base, reason: "recovery-tenant-unproven" };
  }

  const numericStatusId = Number(statusId);
  const hasStatusId = statusId != null && statusId !== "" && Number.isFinite(numericStatusId);
  const table = STATUS_TABLES[normalizedDomain] || {};
  const idMapped = hasStatusId
    && Object.prototype.hasOwnProperty.call(table, numericStatusId);
  const idCategory = idMapped ? resolveStatus(normalizedDomain, numericStatusId).category : null;

  const text = String(statusText || "").trim();
  const bracketGroup = (text.match(/^\s*\[([^\]]+)\]/) || [])[1] || null;
  const normalizedGroup = bracketGroup ? bracketGroup.trim().toLowerCase() : null;
  let textCategory = null;
  if (normalizedGroup === "active prospect") textCategory = "prospect";
  else if (normalizedGroup === "bad/inactive" || /\b(?:dnc|do not call)\b/i.test(text)) {
    textCategory = "dnc";
  } else if (normalizedGroup) textCategory = "other";

  // DNC outranks a stale or conflicting prospect label.
  if (idCategory === "dnc" || textCategory === "dnc") {
    return {
      ...base,
      allowedProspectStatus: false,
      entityDnc: true,
      decision: "terminal",
      reason: "logics-dnc",
    };
  }
  if (idCategory && textCategory && idCategory !== textCategory) {
    return { ...base, reason: "logics-status-conflict" };
  }

  const category = idCategory || textCategory;
  if (!category) return { ...base, reason: "logics-status-unproven" };
  if (category === "prospect") {
    return {
      ...base,
      allowedProspectStatus: true,
      entityDnc: false,
      decision: "allow",
      reason: "active-prospect",
    };
  }
  return {
    ...base,
    allowedProspectStatus: false,
    entityDnc: false,
    decision: "terminal",
    reason: "not-active-prospect",
  };
}

function resolveLeadDeliveryContactPolicy(item = {}, { now = new Date() } = {}) {
  const at = parseDate(now, "now");
  if (!isCallRecoveryItem(item)) {
    return {
      contactPolicyId: null,
      maximumDailyAttempts: dailyAttemptLimitForLeadAge(item, { now: at, maximum: 3 }),
      minimumRetryMinutes: retryDelayMinutesForLeadAge(item, { now: at }),
      maximumProgramAgeDays: null,
      allowed: true,
      reason: "ordinary-age-policy",
      nextEligibleAt: null,
    };
  }

  const expiresAt = parseDate(item.expiresAt, "expiresAt", { nullable: true });
  if (!expiresAt) {
    return {
      contactPolicyId: CALL_RECOVERY_CONTACT_POLICY_ID,
      maximumDailyAttempts: CALL_RECOVERY_MAXIMUM_DAILY_ATTEMPTS,
      minimumRetryMinutes: CALL_RECOVERY_MINIMUM_RETRY_MINUTES,
      maximumProgramAgeDays: CALL_RECOVERY_MAXIMUM_PROGRAM_AGE_DAYS,
      allowed: false,
      reason: "recovery-expiration-unproven",
      nextEligibleAt: null,
    };
  }
  if (at.getTime() >= expiresAt.getTime()) {
    return {
      contactPolicyId: CALL_RECOVERY_CONTACT_POLICY_ID,
      maximumDailyAttempts: CALL_RECOVERY_MAXIMUM_DAILY_ATTEMPTS,
      minimumRetryMinutes: CALL_RECOVERY_MINIMUM_RETRY_MINUTES,
      maximumProgramAgeDays: CALL_RECOVERY_MAXIMUM_PROGRAM_AGE_DAYS,
      allowed: false,
      reason: "recovery-expired",
      nextEligibleAt: null,
    };
  }

  const eligibleFrom = parseDate(item.eligibleFrom, "eligibleFrom", { nullable: true });
  if (!eligibleFrom) {
    return {
      contactPolicyId: CALL_RECOVERY_CONTACT_POLICY_ID,
      maximumDailyAttempts: CALL_RECOVERY_MAXIMUM_DAILY_ATTEMPTS,
      minimumRetryMinutes: CALL_RECOVERY_MINIMUM_RETRY_MINUTES,
      maximumProgramAgeDays: CALL_RECOVERY_MAXIMUM_PROGRAM_AGE_DAYS,
      allowed: false,
      reason: "recovery-start-unproven",
      nextEligibleAt: null,
    };
  }
  if (eligibleFrom.getTime() > at.getTime()) {
    return {
      contactPolicyId: CALL_RECOVERY_CONTACT_POLICY_ID,
      maximumDailyAttempts: CALL_RECOVERY_MAXIMUM_DAILY_ATTEMPTS,
      minimumRetryMinutes: CALL_RECOVERY_MINIMUM_RETRY_MINUTES,
      maximumProgramAgeDays: CALL_RECOVERY_MAXIMUM_PROGRAM_AGE_DAYS,
      allowed: false,
      reason: "recovery-not-started",
      nextEligibleAt: eligibleFrom,
    };
  }

  const answeredAt = parseDate(item.lastHumanAnsweredAt, "lastHumanAnsweredAt", { nullable: true });
  if (answeredAt && getPacificDateKey(answeredAt) === getPacificDateKey(at)) {
    return {
      contactPolicyId: CALL_RECOVERY_CONTACT_POLICY_ID,
      maximumDailyAttempts: CALL_RECOVERY_MAXIMUM_DAILY_ATTEMPTS,
      minimumRetryMinutes: CALL_RECOVERY_MINIMUM_RETRY_MINUTES,
      maximumProgramAgeDays: CALL_RECOVERY_MAXIMUM_PROGRAM_AGE_DAYS,
      allowed: false,
      reason: "recovery-human-answered-today",
      nextEligibleAt: null,
    };
  }

  const daily = canAttemptToday(item, {
    now: at,
    maxDailyAttempts: CALL_RECOVERY_MAXIMUM_DAILY_ATTEMPTS,
    ageBasedDailyCaps: false,
  });
  if (!daily.allowed) {
    return {
      contactPolicyId: CALL_RECOVERY_CONTACT_POLICY_ID,
      maximumDailyAttempts: daily.maximum,
      minimumRetryMinutes: CALL_RECOVERY_MINIMUM_RETRY_MINUTES,
      maximumProgramAgeDays: CALL_RECOVERY_MAXIMUM_PROGRAM_AGE_DAYS,
      allowed: false,
      reason: daily.reason,
      nextEligibleAt: null,
    };
  }

  const lastContactAt = parseDate(item.lastContactAt, "lastContactAt", { nullable: true });
  const retryAt = lastContactAt
    ? new Date(lastContactAt.getTime() + CALL_RECOVERY_MINIMUM_RETRY_MINUTES * 60_000)
    : null;
  if (retryAt && retryAt.getTime() > at.getTime()) {
    return {
      contactPolicyId: CALL_RECOVERY_CONTACT_POLICY_ID,
      maximumDailyAttempts: daily.maximum,
      minimumRetryMinutes: CALL_RECOVERY_MINIMUM_RETRY_MINUTES,
      maximumProgramAgeDays: CALL_RECOVERY_MAXIMUM_PROGRAM_AGE_DAYS,
      allowed: false,
      reason: "recovery-retry-not-due",
      nextEligibleAt: retryAt,
    };
  }

  return {
    contactPolicyId: CALL_RECOVERY_CONTACT_POLICY_ID,
    maximumDailyAttempts: daily.maximum,
    minimumRetryMinutes: CALL_RECOVERY_MINIMUM_RETRY_MINUTES,
    maximumProgramAgeDays: CALL_RECOVERY_MAXIMUM_PROGRAM_AGE_DAYS,
    allowed: true,
    reason: "recovery-attempt-available",
    nextEligibleAt: null,
  };
}

function canAttemptToday(item = {}, {
  now,
  maxDailyAttempts = 3,
  ageBasedDailyCaps = false,
} = {}) {
  const maximum = ageBasedDailyCaps
    ? dailyAttemptLimitForLeadAge(item, { now, maximum: maxDailyAttempts })
    : positiveInteger(maxDailyAttempts, "maxDailyAttempts");
  const count = getEffectiveDailyAttemptCount(item, now);
  return {
    allowed: count < maximum,
    count,
    maximum,
    reason: count < maximum ? "daily-attempt-available" : "daily-attempt-limit",
  };
}

function classifyPool(item = {}, {
  now,
  currentOvernightBatchKey = null,
  maxDailyAttempts = 3,
  ageBasedDailyCaps = false,
  eligibility = null,
} = {}) {
  const at = parseDate(now, "now");
  const domain = String(item.domain || "").trim();
  const caseId = String(item.caseId ?? "").trim();
  if (!domain || !caseId) {
    return { pool: null, reason: "missing-domain-case-identity", retryable: false };
  }
  const phone = String(item.normalizedPhone || "").trim();
  if (!/^\d{10}$/.test(phone)) {
    return { pool: null, reason: "normalized-phone-not-proven", retryable: true };
  }
  let identity;
  try {
    identity = stableWorkItemId(item);
  } catch (error) {
    return { pool: null, reason: "missing-stable-identity", retryable: false };
  }
  if (!eligibility || eligibility.ok !== true || item.callable === false) {
    return {
      pool: null,
      reason: eligibility?.reason || "eligibility-not-proven",
      retryable: eligibility?.retryable !== false,
      identity,
    };
  }
  const state = String(item.state || "").trim().toLowerCase();
  if (!state) return { pool: null, reason: "missing-state", retryable: true, identity };
  if (NON_POOL_STATES.has(state) || !["eligible", "follow_up_wait"].includes(state)) {
    return { pool: null, reason: `state-${state || "missing"}`, retryable: false, identity };
  }
  let daily;
  try {
    daily = canAttemptToday(item, { now: at, maxDailyAttempts, ageBasedDailyCaps });
  } catch (error) {
    return { pool: null, reason: "invalid-daily-attempt-state", retryable: true, identity };
  }
  if (!daily.allowed) {
    return { pool: null, reason: daily.reason, retryable: true, identity };
  }

  let cadenceMinimumAt = null;
  if (ageBasedDailyCaps && item.lastContactAt != null && item.lastContactAt !== "") {
    try {
      cadenceMinimumAt = new Date(
        parseDate(item.lastContactAt, "lastContactAt").getTime()
        + retryDelayMinutesForLeadAge(item, { now: at }) * 60_000,
      );
    } catch (error) {
      return { pool: null, reason: "invalid-last-contact-at", retryable: true, identity };
    }
    if (cadenceMinimumAt.getTime() > at.getTime()) {
      return {
        pool: null,
        reason: "follow-up-not-due",
        retryable: true,
        identity,
        nextEligibleAt: cadenceMinimumAt,
      };
    }
  }

  let nextContactAt = null;
  if (item.nextContactAt != null && item.nextContactAt !== "") {
    try {
      nextContactAt = parseDate(item.nextContactAt, "nextContactAt");
    } catch (error) {
      return { pool: null, reason: "invalid-next-contact-at", retryable: true, identity };
    }
    if (nextContactAt.getTime() > at.getTime()) {
      return { pool: null, reason: "follow-up-not-due", retryable: true, identity };
    }
    return { pool: POOLS.FOLLOW_UP_DUE, reason: "follow-up-due", retryable: false, identity };
  }
  if (state === "follow_up_wait") {
    return { pool: null, reason: "follow-up-missing-due-time", retryable: true, identity };
  }

  let receivedAt;
  try {
    receivedAt = parseDate(item.receivedAt, "receivedAt");
  } catch (error) {
    return { pool: null, reason: "invalid-received-at", retryable: true, identity };
  }
  if (receivedAt.getTime() > at.getTime()) {
    return { pool: null, reason: "received-in-future", retryable: true, identity };
  }
  const batchKey = String(item.overnightBatchKey || "").trim();
  const currentBatch = String(currentOvernightBatchKey || "").trim();
  if (batchKey && currentBatch && batchKey === currentBatch) {
    return { pool: POOLS.OVERNIGHT, reason: "current-overnight-batch", retryable: false, identity };
  }
  if (getPacificDateKey(receivedAt) === getPacificDateKey(at)) {
    return { pool: POOLS.NEW_TODAY, reason: "received-today", retryable: false, identity };
  }
  return { pool: POOLS.OLDER_AVAILABLE, reason: "older-callable", retryable: false, identity };
}

function compareStable(left, right) {
  return stableWorkItemId(left).localeCompare(stableWorkItemId(right));
}

function nullableTime(value, fieldName) {
  if (value == null || value === "") return Number.NEGATIVE_INFINITY;
  return parseDate(value, fieldName).getTime();
}

function comparePoolItems(pool, left, right) {
  if (!POOL_VALUES.includes(pool)) throw new TypeError(`unknown pool: ${pool}`);
  if (pool === POOLS.NEW_TODAY) {
    const delta = parseDate(right.receivedAt, "receivedAt").getTime()
      - parseDate(left.receivedAt, "receivedAt").getTime();
    return delta || compareStable(left, right);
  }
  if (pool === POOLS.FOLLOW_UP_DUE) {
    const dueDelta = parseDate(left.nextContactAt, "nextContactAt").getTime()
      - parseDate(right.nextContactAt, "nextContactAt").getTime();
    if (dueDelta) return dueDelta;
    const contactDelta = nullableTime(left.lastContactAt, "lastContactAt")
      - nullableTime(right.lastContactAt, "lastContactAt");
    return contactDelta || compareStable(left, right);
  }
  if (pool === POOLS.OVERNIGHT) {
    const leftOrder = nonNegativeInteger(left.overnightOrder ?? left.metadata?.overnightOrder, "overnightOrder");
    const rightOrder = nonNegativeInteger(right.overnightOrder ?? right.metadata?.overnightOrder, "overnightOrder");
    return (leftOrder - rightOrder) || compareStable(left, right);
  }
  const contactDelta = nullableTime(left.lastContactAt, "lastContactAt")
    - nullableTime(right.lastContactAt, "lastContactAt");
  if (contactDelta) return contactDelta;
  const receivedDelta = parseDate(left.receivedAt, "receivedAt").getTime()
    - parseDate(right.receivedAt, "receivedAt").getTime();
  return receivedDelta || compareStable(left, right);
}

/**
 * SELECTION RANK — which candidate an agent should be handed next.
 *
 * Mickey 2026-07-31, on where mail recovery belongs: "below brand new 0 contact
 * but above same day 1 contact until it gets contacted."
 *
 * That rule is CROSS-POOL, which is why it cannot live in the pool precedence
 * list: an uncontacted recovery case has to beat a follow_up_due retry while
 * still losing to a virgin new_today lead, and those are two different pools.
 * So pool MEMBERSHIP stays exactly as the contract defines it — four pools, a
 * recovery case is ordinary `older_available` work — and this adds a ranking
 * lens on top for the moment of selection.
 *
 * Lower is picked first:
 *
 *   0  overnight            first-contact barrier; recovery may never bypass it
 *   1  new_today, 0 touches  a lead nobody has ever called still wins
 *   2  RECOVERY, 0 touches   a 15-minute conversation outranks a second dial
 *   3  anything touched      follow_up_due retries, and recovery once contacted
 *   4  generic aged filler
 *
 * The "until it gets contacted" half is the important one: the elevation is
 * granted by the UNANSWERED conversation, not by membership. The moment the
 * episode has an attempt against it, it drops to tier 3 and competes on the
 * same terms as every other retry — otherwise a recovery case would hold the
 * front of the line all day on the strength of a call it already got.
 */
function resolveSelectionRank(item = {}, { now = new Date() } = {}) {
  const pool = String(item.sourcePool || "").trim().toLowerCase();
  const touched = nonNegativeInteger(item.totalAttemptCount ?? 0, "totalAttemptCount") > 0
    || Boolean(item.lastContactAt);
  if (pool === POOLS.OVERNIGHT) return 0;
  if (pool === POOLS.NEW_TODAY && !touched) return 1;
  if (!touched) return 2;
  if (touched) return 3;
  return 3;
}

/**
 * Order a MERGED candidate set across pools by the rank above.
 *
 * ONE ORDERING KEY PER TIER — never "the pool's comparator when the pools match,
 * a stable id otherwise". That was the first attempt and it is not a valid
 * comparator: mixing two orderings inside one tier breaks transitivity, and a
 * brute force over 1320 triples found 36 violations
 * (e.g. aaa/follow_up_due < mmm/new_today < zzz/follow_up_due, yet
 * aaa > zzz because the outer pair fell to a different rule than the inner
 * ones). `Array.prototype.sort` with an inconsistent comparator is
 * implementation-defined, so the line an agent is handed could vary between
 * runs for no visible reason — the worst kind of ordering bug to chase.
 *
 * Each tier is homogeneous in MEANING, so each gets the one key that means
 * something for it, and every key is defined for every item in that tier
 * regardless of which pool the item belongs to.
 */
function compareSelectionCandidates(left, right, { now = new Date() } = {}) {
  const at = parseDate(now, "now");
  const leftRank = resolveSelectionRank(left, { now: at });
  const rightRank = resolveSelectionRank(right, { now: at });
  if (leftRank !== rightRank) return leftRank - rightRank;

  switch (leftRank) {
    case 0: { // overnight — the curated first-contact order
      const delta = nonNegativeInteger(left.overnightOrder ?? left.metadata?.overnightOrder ?? 0, "overnightOrder")
        - nonNegativeInteger(right.overnightOrder ?? right.metadata?.overnightOrder ?? 0, "overnightOrder");
      return delta || compareStable(left, right);
    }
    case 1: { // brand new, never touched — newest first
      const delta = nullableTime(right.receivedAt, "receivedAt") - nullableTime(left.receivedAt, "receivedAt");
      return delta || compareStable(left, right);
    }
    case 2: { // uncontacted recovery — §16: earliest expiry, then oldest call
      const leftRecovery = String(left?.inventoryClass || "").trim().toLowerCase()
        === CALL_RECOVERY_INVENTORY_CLASS;
      const rightRecovery = String(right?.inventoryClass || "").trim().toLowerCase()
        === CALL_RECOVERY_INVENTORY_CLASS;
      if (leftRecovery && rightRecovery) {
        const expiryDelta = nullableTime(left.expiresAt, "expiresAt") - nullableTime(right.expiresAt, "expiresAt");
        if (expiryDelta) return expiryDelta;
        const callDelta = nullableTime(left.firstQualifyingCallAt, "firstQualifyingCallAt")
          - nullableTime(right.firstQualifyingCallAt, "firstQualifyingCallAt");
        return callDelta || compareStable(left, right);
      }
      if (leftRecovery !== rightRecovery) return leftRecovery ? -1 : 1;
      const receiptDelta = nullableTime(right.receivedAt, "receivedAt")
        - nullableTime(left.receivedAt, "receivedAt");
      return receiptDelta || compareStable(left, right);
    }
    case 3: { // anything already touched — most overdue first, across pools
      const dueDelta = nullableTime(left.nextContactAt, "nextContactAt")
        - nullableTime(right.nextContactAt, "nextContactAt");
      if (dueDelta) return dueDelta;
      const contactDelta = nullableTime(left.lastContactAt, "lastContactAt")
        - nullableTime(right.lastContactAt, "lastContactAt");
      return contactDelta || compareStable(left, right);
    }
    default: { // generic aged filler — coldest first
      const contactDelta = nullableTime(left.lastContactAt, "lastContactAt")
        - nullableTime(right.lastContactAt, "lastContactAt");
      if (contactDelta) return contactDelta;
      const receivedDelta = nullableTime(left.receivedAt, "receivedAt")
        - nullableTime(right.receivedAt, "receivedAt");
      return receivedDelta || compareStable(left, right);
    }
  }
}

function compareRecoveryPoolItems(pool, left, right) {
  if (!POOL_VALUES.includes(pool)) throw new TypeError(`unknown pool: ${pool}`);
  if (pool === POOLS.OLDER_AVAILABLE) {
    const leftRecovery = String(left?.inventoryClass || "").trim().toLowerCase()
      === CALL_RECOVERY_INVENTORY_CLASS;
    const rightRecovery = String(right?.inventoryClass || "").trim().toLowerCase()
      === CALL_RECOVERY_INVENTORY_CLASS;
    if (leftRecovery !== rightRecovery) return leftRecovery ? -1 : 1;
  }
  return comparePoolItems(pool, left, right);
}

function orderPoolItems(pool, items = []) {
  if (!Array.isArray(items)) throw new TypeError("items must be an array");
  return [...items].sort((left, right) => comparePoolItems(pool, left, right));
}

function nextFairPick({
  agentOrder = [],
  lastPickedAgentId = null,
  excludedAgentIds = [],
} = {}) {
  if (!Array.isArray(agentOrder)) throw new TypeError("agentOrder must be an array");
  if (!Array.isArray(excludedAgentIds)) throw new TypeError("excludedAgentIds must be an array");
  const ring = [...new Set(agentOrder
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean))];
  if (!ring.length) return null;
  const excluded = new Set(excludedAgentIds
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean));
  const last = String(lastPickedAgentId || "").trim().toLowerCase();
  const lastIndex = ring.indexOf(last);
  const startIndex = lastIndex >= 0 ? lastIndex : ring.length - 1;
  for (let offset = 1; offset <= ring.length; offset += 1) {
    const agentId = ring[(startIndex + offset) % ring.length];
    if (!excluded.has(agentId)) return agentId;
  }
  return null;
}

async function claimNextFairPick({
  repository,
  workType,
  agentOrder = [],
  excludedAgentIds = [],
  maximumAttempts = 5,
} = {}) {
  if (typeof repository?.getOrCreateFairPickCursor !== "function") {
    throw new TypeError("repository.getOrCreateFairPickCursor is required");
  }
  if (typeof repository?.compareAndSetFairPickCursor !== "function") {
    throw new TypeError("repository.compareAndSetFairPickCursor is required");
  }
  const key = String(workType || "").trim().toLowerCase();
  if (!key) throw new TypeError("workType is required");
  const attempts = positiveInteger(maximumAttempts, "maximumAttempts");
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const cursor = await repository.getOrCreateFairPickCursor(key, { agentOrder });
    const agentId = nextFairPick({
      agentOrder: cursor?.agentOrder,
      lastPickedAgentId: cursor?.lastPickedAgentId,
      excludedAgentIds,
    });
    if (!agentId) return { status: "no-eligible-agent", workType: key, agentId: null };
    const committed = await repository.compareAndSetFairPickCursor({
      workType: key,
      expectedVersion: cursor.version,
      expectedLastPickedAgentId: cursor.lastPickedAgentId,
      lastPickedAgentId: agentId,
    });
    if (committed) {
      return {
        status: "picked",
        workType: key,
        agentId,
        version: committed.version,
      };
    }
  }
  return { status: "cursor-conflict", workType: key, agentId: null };
}

function fairnessTieBreaker(hourKey, agentId) {
  const key = String(hourKey || "").trim();
  const id = String(agentId || "").trim();
  if (!key || !id) throw new TypeError("hourKey and agentId are required");
  return createHash("sha256").update(`${key}|${id}`).digest("hex");
}

function normalizeAgentFairnessHour(agent = {}, { now } = {}) {
  const hourKey = getPacificHourKey(now);
  const agentId = String(agent.agentId || agent.id || "").trim();
  if (!agentId) throw new TypeError("agentId is required");
  const priorKey = String(agent.fairnessHourKey || "").trim();
  const reset = priorKey !== hourKey;
  return {
    ...clone(agent),
    agentId,
    fairnessHourKey: hourKey,
    fairnessTieBreaker: fairnessTieBreaker(hourKey, agentId),
    freshReservedThisHour: reset
      ? 0
      : nonNegativeInteger(agent.freshReservedThisHour ?? 0, "freshReservedThisHour"),
  };
}

function hasProviderConfiguration(agent = {}) {
  if (agent.providerConfigurationComplete === true) return true;
  const config = agent.providerConfig || {};
  return Boolean(
    String(config.distributionFolderId || "").trim()
    && String(config.receivingFolderId || "").trim()
  );
}

function evaluateFreshAgentEligibility(agent = {}, {
  now,
} = {}) {
  const at = parseDate(now, "now");
  const agentId = String(agent.agentId || agent.id || "").trim();
  if (!agentId) return { eligible: false, reason: "missing-agent-id" };
  if (agent.enabled !== true) return { eligible: false, reason: "agent-disabled", agentId };
  if (agent.shiftEnabled !== true) return { eligible: false, reason: "shift-disabled", agentId };
  let activeUntil;
  try {
    activeUntil = parseDate(agent.activeUntil, "activeUntil");
  } catch (error) {
    return { eligible: false, reason: "activity-not-proven", agentId };
  }
  if (activeUntil.getTime() <= at.getTime()) return { eligible: false, reason: "agent-inactive", agentId };
  if (!hasProviderConfiguration(agent)) return { eligible: false, reason: "provider-config-incomplete", agentId };
  const subscriptions = Array.isArray(agent.subscribedPools) ? agent.subscribedPools : [];
  if (!subscriptions.includes(POOLS.NEW_TODAY)) return { eligible: false, reason: "not-subscribed-new-today", agentId };
  const allowance = Number(agent.packetAllowances?.[POOLS.NEW_TODAY] ?? 0);
  if (!Number.isInteger(allowance) || allowance <= 0) return { eligible: false, reason: "new-today-allowance-invalid", agentId };
  // Fresh work is an immediate lane. Bulk depth and refill bookkeeping are
  // deliberately absent: an active agent stays eligible even when an old
  // estimate or a full ordinary packet says otherwise.
  return { eligible: true, reason: "eligible", agentId };
}

function lastFreshTime(value) {
  if (value == null || value === "") return Number.NEGATIVE_INFINITY;
  return parseDate(value, "lastFreshReservedAt").getTime();
}

function rankFreshAgents(agents = [], options = {}) {
  if (!Array.isArray(agents)) throw new TypeError("agents must be an array");
  return agents
    .map((agent) => normalizeAgentFairnessHour(agent, options))
    .filter((agent) => evaluateFreshAgentEligibility(agent, options).eligible)
    .sort((left, right) => {
      const countDelta = left.freshReservedThisHour - right.freshReservedThisHour;
      if (countDelta) return countDelta;
      const timeDelta = lastFreshTime(left.lastFreshReservedAt) - lastFreshTime(right.lastFreshReservedAt);
      if (timeDelta) return timeDelta;
      const tie = String(left.fairnessTieBreaker).localeCompare(String(right.fairnessTieBreaker));
      return tie || left.agentId.localeCompare(right.agentId);
    });
}

function buildFreshReservationPatch(agent = {}, { now } = {}) {
  const at = parseDate(now, "now");
  const normalized = normalizeAgentFairnessHour(agent, { now: at });
  return {
    fairnessHourKey: normalized.fairnessHourKey,
    fairnessTieBreaker: normalized.fairnessTieBreaker,
    freshReservedThisHour: normalized.freshReservedThisHour + 1,
    pendingFreshCount: nonNegativeInteger(normalized.pendingFreshCount ?? 0, "pendingFreshCount") + 1,
    lastFreshReservedAt: at,
  };
}

function calculateFreshLease({
  receivedAt,
  reservedAt,
  leaseMinutes = 15,
} = {}) {
  const received = parseDate(receivedAt, "receivedAt");
  const reserved = parseDate(reservedAt, "reservedAt");
  if (reserved.getTime() < received.getTime()) throw new RangeError("reservedAt cannot precede receivedAt");
  const minutes = positiveInteger(leaseMinutes, "leaseMinutes");
  const freshDeadlineAt = new Date(received.getTime() + 15 * 60_000);
  const leaseEnd = new Date(reserved.getTime() + minutes * 60_000);
  const reservationExpiresAt = new Date(Math.min(freshDeadlineAt.getTime(), leaseEnd.getTime()));
  return {
    canProtect: reserved.getTime() < freshDeadlineAt.getTime(),
    freshDeadlineAt,
    reservationExpiresAt,
    reason: reserved.getTime() < freshDeadlineAt.getTime() ? "protected" : "fresh-deadline-reached",
  };
}

function isFreshReservationProtected(item = {}, now) {
  const at = parseDate(now, "now");
  const expiry = parseDate(item.reservationExpiresAt, "reservationExpiresAt");
  const deadline = parseDate(item.freshDeadlineAt, "freshDeadlineAt");
  return expiry.getTime() > at.getTime() && deadline.getTime() > at.getTime();
}

function calculatePacketDeficit({ providerBufferTarget = 5, currentOutstanding, acceptedInFlight = 0 } = {}) {
  const target = positiveInteger(providerBufferTarget, "providerBufferTarget");
  const outstanding = nonNegativeInteger(currentOutstanding, "currentOutstanding");
  const inFlight = nonNegativeInteger(acceptedInFlight, "acceptedInFlight");
  return Math.max(0, target - outstanding - inFlight);
}

function shouldRequestRefill({ refillAtOrBelow = 1, currentOutstanding, openRefillRequest = false } = {}) {
  const lowWater = nonNegativeInteger(refillAtOrBelow, "refillAtOrBelow");
  const outstanding = nonNegativeInteger(currentOutstanding, "currentOutstanding");
  if (openRefillRequest === true) return { shouldRequest: false, reason: "refill-already-open" };
  return outstanding <= lowWater
    ? { shouldRequest: true, reason: "at-or-below-low-water" }
    : { shouldRequest: false, reason: "above-low-water" };
}

function computeRefillDecision(input = {}) {
  const target = positiveInteger(input.providerBufferTarget ?? 5, "providerBufferTarget");
  const lowWater = nonNegativeInteger(input.refillAtOrBelow ?? 1, "refillAtOrBelow");
  if (lowWater >= target) throw new RangeError("refillAtOrBelow must be below providerBufferTarget");
  const projection = input.projection;
  if (!projection || projection.reliable !== true) {
    return {
      shouldRequest: false,
      shouldOpenRefill: false,
      reason: projection ? "projection-unreliable" : "projection-not-proven",
      deficit: 0,
    };
  }
  const currentOutstanding = nonNegativeInteger(
    projection.estimatedOutstanding,
    "projection.estimatedOutstanding",
  );
  const countedInput = { ...input, currentOutstanding };
  const trigger = shouldRequestRefill(countedInput);
  const deficit = calculatePacketDeficit(countedInput);
  return {
    ...trigger,
    deficit,
    shouldOpenRefill: trigger.shouldRequest && deficit > 0,
    reason: trigger.shouldRequest && deficit === 0 ? "no-deficit" : trigger.reason,
  };
}

function reconstructAgentProjection(items = [], { agentId = null } = {}) {
  if (!Array.isArray(items)) throw new TypeError("items must be an array");
  const owner = agentId == null ? null : String(agentId).trim();
  const outstandingItemIds = [];
  const anomalies = [];
  for (const item of items) {
    const identity = stableWorkItemId(item);
    if (owner && String(item.deliveryAgentId || "").trim() !== owner) continue;
    const drainMarker = item.metadata?.[END_OF_DAY_DRAIN_METADATA_KEY];
    if (drainMarker?.status === "provider_absent"
      && Number(drainMarker?.attemptNumber || 0) === Number(item.providerAttemptSequence || 0)) continue;
    const state = String(item.state || "").trim();
    const acceptedTimestamp = Boolean(
      item.providerAcceptedAt
      && Number.isFinite(new Date(item.providerAcceptedAt).getTime()),
    );
    const retainedRecycleState = state === "follow_up_wait"
      && RETRYABLE_OUTCOMES.has(normalizeOutcome(item.lastOutcome))
      && Boolean(String(item.providerContactId || "").trim())
      && Boolean(String(item.providerExternalLeadId || "").trim());
    const acceptedState = ["provider_accepted", "in_call"].includes(state) || retainedRecycleState;
    if (!acceptedState && !acceptedTimestamp) continue;
    const identityComplete = Boolean(
      String(item.provider || "").trim()
      &&
      String(item.providerExternalLeadId || "").trim()
      && String(item.providerContactId || "").trim()
      && acceptedTimestamp,
    );
    if (!identityComplete) {
      anomalies.push({ identity, reason: "accepted-provider-identity-incomplete" });
    }
    const callId = String(item.providerCallId || "").trim();
    const completedTimestamp = Boolean(
      item.providerCompletedAt
      && Number.isFinite(new Date(item.providerCompletedAt).getTime()),
    );
    if (completedTimestamp && !callId && !retainedRecycleState) {
      anomalies.push({ identity, reason: "completion-identity-incomplete" });
    }
    if (!(callId && completedTimestamp)) {
      outstandingItemIds.push(identity);
      if (!acceptedState) anomalies.push({ identity, reason: "accepted-state-inconsistent" });
    }
  }
  return {
    estimatedOutstanding: outstandingItemIds.length,
    outstandingItemIds,
    anomalies,
    reliable: anomalies.length === 0,
  };
}

function takeUnique({ source, count, selected, output, pool, selectionType }) {
  let taken = 0;
  while (source.length && taken < count) {
    const item = source.shift();
    const identity = stableWorkItemId(item);
    if (selected.has(identity)) continue;
    selected.add(identity);
    output.push({ item, identity, pool, selectionType });
    taken += 1;
  }
  return taken;
}

function composePacketRecipe({
  agentId,
  now,
  needed,
  reservedFreshItems = [],
  forcedExpiredFreshItems = [],
  poolsByName = {},
  subscribedPools = [],
  packetAllowances = {},
  packetPoolOrder = DEFAULT_FALLBACK_POOL_ORDER,
  blockAgedForOvernightFirstContact = false,
} = {}) {
  const at = parseDate(now, "now");
  const requested = nonNegativeInteger(needed, "needed");
  const owner = String(agentId || "").trim();
  if (!owner) throw new TypeError("agentId is required");
  const subscriptions = [...new Set((subscribedPools || []).map(String))]
    .filter((pool) => POOL_VALUES.includes(pool));
  const validatedAllowances = Object.fromEntries(subscriptions.map((pool) => [
    pool,
    nonNegativeInteger(packetAllowances?.[pool] ?? 0, `packetAllowances.${pool}`),
  ]));
  const allowedPools = subscriptions.filter((pool) => (
    validatedAllowances[pool] > 0
    && !(blockAgedForOvernightFirstContact === true && pool === POOLS.OLDER_AVAILABLE)
  ));
  const selected = new Set();
  const output = [];
  const excluded = [];

  const protectedFresh = orderPoolItems(
    POOLS.NEW_TODAY,
    (reservedFreshItems || []).filter((item) => {
      if (String(item.state || "").trim() !== "reserved") {
        excluded.push({ identity: stableWorkItemId(item), reason: "protected-fresh-not-reserved" });
        return false;
      }
      if (String(item.reservedAgentId || "").trim() !== owner) {
        excluded.push({ identity: stableWorkItemId(item), reason: "reserved-for-other-agent" });
        return false;
      }
      if (!isFreshReservationProtected(item, at)) {
        excluded.push({ identity: stableWorkItemId(item), reason: "reservation-expired" });
        return false;
      }
      return subscriptions.includes(POOLS.NEW_TODAY);
    }),
  );
  takeUnique({
    source: protectedFresh,
    count: requested - output.length,
    selected,
    output,
    pool: POOLS.NEW_TODAY,
    selectionType: "protected-fresh",
  });

  const canReceiveFresh = subscriptions.includes(POOLS.NEW_TODAY)
    && validatedAllowances[POOLS.NEW_TODAY] > 0;
  const forcedFresh = (canReceiveFresh ? [...(forcedExpiredFreshItems || [])] : [])
    .filter((item) => {
      if (String(item.state || "").trim() !== "reserved") return false;
      if (String(item.speedOverrideAgentId || "").trim() !== owner) return false;
      const deadline = parseDate(item.freshDeadlineAt, "freshDeadlineAt");
      return deadline.getTime() <= at.getTime();
    })
    .sort((left, right) => {
      const delta = parseDate(left.receivedAt, "receivedAt").getTime()
        - parseDate(right.receivedAt, "receivedAt").getTime();
      return delta || compareStable(left, right);
    });
  takeUnique({
    source: forcedFresh,
    count: requested - output.length,
    selected,
    output,
    pool: POOLS.NEW_TODAY,
    selectionType: "expired-fresh-speed-override",
  });

  const sources = {};
  for (const pool of allowedPools) {
    const candidates = pool === POOLS.NEW_TODAY
      ? (poolsByName[pool] || []).filter((item) => (
        String(item.state || "").trim() === "reserved"
        &&
        String(item.reservedAgentId || "").trim() === owner
        && isFreshReservationProtected(item, at)
      ))
      : (poolsByName[pool] || []).filter((item) => {
        const state = String(item.state || "").trim();
        return state === "eligible" || (pool === POOLS.FOLLOW_UP_DUE && state === "follow_up_wait");
      });
    sources[pool] = orderPoolItems(pool, candidates);
  }

  // Morning first-contact is a barrier, not a quota. Protected post-cutoff
  // fresh work may interrupt it, but ordinary follow-up/aged inventory cannot
  // bleed into a packet while the current morning batch still has candidates.
  if (allowedPools.includes(POOLS.OVERNIGHT) && sources[POOLS.OVERNIGHT]?.length) {
    takeUnique({
      source: sources[POOLS.OVERNIGHT],
      count: requested - output.length,
      selected,
      output,
      pool: POOLS.OVERNIGHT,
      selectionType: "morning-first-contact",
    });
  }

  const dealOrder = [...new Set((packetPoolOrder || []).map(String))]
    .filter((pool) => allowedPools.includes(pool));
  for (const pool of dealOrder) {
    if (output.length >= requested || !allowedPools.includes(pool)) continue;
    const allowance = validatedAllowances[pool];
    takeUnique({
      source: sources[pool],
      count: Math.min(allowance, requested - output.length),
      selected,
      output,
      pool,
      selectionType: "allowance",
    });
  }

  let progressed = true;
  while (output.length < requested && progressed) {
    progressed = false;
    for (const pool of dealOrder) {
      if (output.length >= requested) break;
      const took = takeUnique({
        source: sources[pool],
        count: 1,
        selected,
        output,
        pool,
        selectionType: "fallback",
      });
      if (took) progressed = true;
    }
  }

  const countsByPool = Object.fromEntries(POOL_VALUES.map((pool) => [pool, 0]));
  for (const row of output) countsByPool[row.pool] += 1;
  return {
    agentId: owner,
    requested,
    items: output.map((row) => row.item),
    selections: output,
    countsByPool,
    unfilled: Math.max(0, requested - output.length),
    excluded,
  };
}

function buildProviderAttemptPreparation(item = {}, {
  now,
  provider = "phoneburner",
} = {}) {
  const at = parseDate(now, "now");
  const state = String(item.state || "").trim().toLowerCase();
  if (state !== "packetized") throw new Error(`provider attempt requires packetized state, received ${state || "missing"}`);
  const itemId = stableWorkItemId(item);
  const providerName = String(provider || "").trim().toLowerCase();
  if (!providerName) throw new TypeError("provider is required");
  const currentSequence = nonNegativeInteger(
    item.providerAttemptSequence ?? 0,
    "providerAttemptSequence",
  );
  const currentExternalId = String(item.providerExternalLeadId || "").trim();
  const history = Array.isArray(item.providerAttemptHistory) ? item.providerAttemptHistory : [];
  const currentEvents = history.filter((event) => Number(event?.attemptNumber) === currentSequence);
  const lastCurrentEvent = currentEvents.at(-1) || null;
  const currentPostState = String(item.providerPostState || "").trim().toLowerCase();
  const replayablePrepared = currentSequence > 0
    && currentExternalId
    && (
      String(lastCurrentEvent?.event || "").trim() === "prepared"
      || (
        String(lastCurrentEvent?.event || "").trim() === "review"
        && ["prepared", "reconcile_required"].includes(currentPostState)
      )
    )
    && !String(item.providerContactId || "").trim()
    && !item.providerAcceptedAt;
  if (replayablePrepared) {
    return {
      attemptNumber: currentSequence,
      providerExternalLeadId: currentExternalId,
      replay: true,
      requiresReconciliation: ["posting", "reconcile_required"].includes(
        String(item.providerPostState || "").trim().toLowerCase(),
      ),
      mutation: null,
    };
  }
  const attemptNumber = currentSequence + 1;
  const digest = createHash("sha256")
    .update(`${providerName}|${itemId}|${attemptNumber}`)
    .digest("hex")
    .slice(0, 32);
  const providerExternalLeadId = `ld-v1-${digest}-${attemptNumber}`;
  return {
    attemptNumber,
    providerExternalLeadId,
    replay: false,
    requiresReconciliation: false,
    mutation: {
      set: {
        provider: providerName,
        providerExternalLeadId,
        providerContactId: null,
        providerAcceptedAt: null,
        providerCompletedAt: null,
        providerCallId: null,
        providerAttemptSequence: attemptNumber,
        providerPostState: "prepared",
        providerPostLeaseId: null,
        providerPostLeaseExpiresAt: null,
        providerPostAttemptCount: 0,
      },
      append: {
        providerAttemptHistory: [{
          attemptNumber,
          event: "prepared",
          provider: providerName,
          providerExternalLeadId,
          providerContactId: null,
          providerCallId: null,
          occurredAt: at,
          outcome: null,
          reason: null,
        }],
      },
    },
  };
}

function buildProviderPostLease(item = {}, {
  now,
  leaseId,
  leaseMs = 60_000,
} = {}) {
  const at = parseDate(now, "now");
  const token = String(leaseId || "").trim();
  if (!token) throw new TypeError("leaseId is required");
  const duration = positiveInteger(leaseMs, "leaseMs");
  const state = String(item.state || "").trim().toLowerCase();
  if (state !== "packetized") throw new Error(`provider post lease requires packetized state, received ${state || "missing"}`);
  const postState = String(item.providerPostState || "").trim().toLowerCase();
  if (!["prepared", "posting", "reconcile_required"].includes(postState)) {
    return { acquired: false, reason: "provider-post-not-claimable", mutation: null };
  }
  const currentLeaseExpiry = item.providerPostLeaseExpiresAt
    ? parseDate(item.providerPostLeaseExpiresAt, "providerPostLeaseExpiresAt")
    : null;
  if (postState === "posting" && currentLeaseExpiry && currentLeaseExpiry.getTime() > at.getTime()) {
    return { acquired: false, reason: "provider-post-lease-live", mutation: null };
  }
  const reconcileBeforePost = postState === "reconcile_required" || postState === "posting";
  return {
    acquired: true,
    reason: reconcileBeforePost ? "provider-post-reconcile-lease" : "provider-post-fresh-lease",
    reconcileBeforePost,
    leaseId: token,
    leaseExpiresAt: new Date(at.getTime() + duration),
    expected: {
      state: "packetized",
      providerPostState: postState,
      providerPostLeaseId: item.providerPostLeaseId ?? null,
    },
    mutation: {
      set: {
        providerPostState: "posting",
        providerPostLeaseId: token,
        providerPostLeaseExpiresAt: new Date(at.getTime() + duration),
      },
      increment: { providerPostAttemptCount: 1 },
    },
  };
}

function buildProviderAcceptanceTransition(item = {}, {
  providerContactId,
  acceptedAt,
  providerPostLeaseId,
} = {}) {
  const at = parseDate(acceptedAt, "acceptedAt");
  const state = String(item.state || "").trim().toLowerCase();
  if (state !== "packetized") throw new Error(`provider acceptance requires packetized state, received ${state || "missing"}`);
  const contactId = String(providerContactId || "").trim();
  if (!contactId) throw new TypeError("providerContactId is required");
  const externalLeadId = String(item.providerExternalLeadId || "").trim();
  if (!externalLeadId) throw new TypeError("providerExternalLeadId is required");
  const attemptNumber = positiveInteger(item.providerAttemptSequence, "providerAttemptSequence");
  const provider = String(item.provider || "").trim().toLowerCase();
  if (!provider) throw new TypeError("provider is required");
  const leaseId = String(providerPostLeaseId || "").trim();
  if (!leaseId || leaseId !== String(item.providerPostLeaseId || "").trim()) {
    throw new Error("provider acceptance requires the current post lease");
  }
  if (String(item.providerPostState || "").trim() !== "posting") {
    throw new Error("provider acceptance requires posting state");
  }
  return {
    set: {
      state: "provider_accepted",
      activeAttempt: true,
      providerContactId: contactId,
      providerAcceptedAt: at,
      providerPostState: "accepted",
      providerPostLeaseId: null,
      providerPostLeaseExpiresAt: null,
    },
    append: {
      providerAttemptHistory: [{
        attemptNumber,
        event: "accepted",
        provider,
        providerExternalLeadId: externalLeadId,
        providerContactId: contactId,
        providerCallId: null,
        deliveryAgentId: String(item.deliveryAgentId || "").trim().toLowerCase() || null,
        packetId: String(item.packetId || "").trim() || null,
        occurredAt: at,
        outcome: null,
        reason: null,
      }],
    },
  };
}

function buildProviderDeliveryFailureTransition(item = {}, {
  failedAt,
  reason = "provider-rejected",
  providerPostLeaseId,
  ambiguous = false,
  retryable = false,
} = {}) {
  const at = parseDate(failedAt, "failedAt");
  const state = String(item.state || "").trim().toLowerCase();
  if (state !== "packetized") throw new Error(`provider failure requires packetized state, received ${state || "missing"}`);
  const attemptNumber = positiveInteger(item.providerAttemptSequence, "providerAttemptSequence");
  const provider = String(item.provider || "").trim().toLowerCase();
  const externalLeadId = String(item.providerExternalLeadId || "").trim();
  if (!provider || !externalLeadId) throw new TypeError("prepared provider identity is required");
  const leaseId = String(providerPostLeaseId || "").trim();
  if (!leaseId || leaseId !== String(item.providerPostLeaseId || "").trim()) {
    throw new Error("provider failure requires the current post lease");
  }
  if (String(item.providerPostState || "").trim() !== "posting") {
    throw new Error("provider failure requires posting state");
  }
  const safeReason = String(reason || "provider-rejected").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").slice(0, 64)
    || "provider-rejected";
  const shouldRetry = ambiguous === true || retryable === true;
  return {
    set: {
      state: shouldRetry ? "packetized" : "delivery_failed",
      activeAttempt: true,
      providerPostState: ambiguous ? "reconcile_required" : retryable ? "prepared" : "failed",
      providerPostLeaseId: null,
      providerPostLeaseExpiresAt: null,
    },
    append: {
      providerAttemptHistory: [{
        attemptNumber,
        event: shouldRetry ? "review" : "delivery_failed",
        provider,
        providerExternalLeadId: externalLeadId,
        providerContactId: null,
        providerCallId: null,
        deliveryAgentId: String(item.deliveryAgentId || "").trim().toLowerCase() || null,
        packetId: String(item.packetId || "").trim() || null,
        occurredAt: at,
        outcome: null,
        reason: safeReason,
      }],
    },
  };
}

function normalizeOutcome(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "review";
  const compact = raw.replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  if (OUTCOME_ALIASES[raw]) return OUTCOME_ALIASES[raw];
  if (OUTCOME_ALIASES[compact]) return OUTCOME_ALIASES[compact];
  if (RETRYABLE_OUTCOMES.has(raw)) return raw;
  return "review";
}

function projectAttemptCompletion(item = {}, {
  attemptedAt,
  completedAt,
  providerCallId,
  providerAttemptKey = null,
  attemptAlreadyCounted = false,
} = {}) {
  const completed = parseDate(completedAt, "completedAt");
  const requestedCallId = String(providerCallId || "").trim();
  if (!requestedCallId) throw new TypeError("providerCallId is required");
  const existingProviderCallId = String(item.providerCallId || "").trim();
  const countedCallId = String(item.lastCountedProviderCallId || "").trim();
  const priorRetainedCallFinished = String(item.state || "").trim().toLowerCase() === "follow_up_wait"
    && existingProviderCallId
    && existingProviderCallId === countedCallId;
  if (existingProviderCallId && existingProviderCallId !== requestedCallId && !priorRetainedCallFinished) {
    throw new Error("providerCallId does not match the delivered work item");
  }
  const requestedAttemptKey = String(providerAttemptKey || "").trim();
  const countedAttemptKey = existingCountedProviderAttemptKey(item);
  const sameCountedCall = requestedAttemptKey
    ? Boolean(countedAttemptKey && requestedAttemptKey === countedAttemptKey)
    : countedCallId === requestedCallId;
  if (attemptAlreadyCounted && !sameCountedCall) {
    throw new Error("attemptAlreadyCounted requires the same providerCallId");
  }
  const attempted = parseDate(
    attemptedAt || (sameCountedCall ? item.attemptedAt : null) || completed,
    "attemptedAt",
  );
  const dateKey = getPacificDateKey(attempted);
  const priorDaily = getEffectiveDailyAttemptCount(item, attempted);
  const priorTotal = nonNegativeInteger(item.totalAttemptCount ?? 0, "totalAttemptCount");
  const increment = sameCountedCall ? 0 : 1;
  return {
    providerCallId: requestedCallId,
    lastCountedProviderCallId: requestedCallId,
    lastCountedProviderAttemptKey: requestedAttemptKey || countedAttemptKey || null,
    attemptedAt: attempted,
    providerCompletedAt: sameCountedCall && item.providerCompletedAt
      ? parseDate(item.providerCompletedAt, "providerCompletedAt")
      : completed,
    dailyAttemptDateKey: dateKey,
    dailyAttemptCount: priorDaily + increment,
    totalAttemptCount: priorTotal + increment,
    lastContactAt: sameCountedCall && item.lastContactAt
      ? parseDate(item.lastContactAt, "lastContactAt")
      : completed,
    attemptCounted: increment === 1,
  };
}

function shouldRetainCompletedProviderContact(item = {}, {
  now = new Date(),
  evaluatedAt = now,
  maximumDailyAttempts = 3,
} = {}) {
  const completedAt = parseDate(now, "now");
  const policyAt = parseDate(evaluatedAt, "evaluatedAt");
  if (String(item.state || "").trim().toLowerCase() !== "follow_up_wait") return false;
  if (!RETRYABLE_OUTCOMES.has(normalizeOutcome(item.lastOutcome))) return false;
  if (!String(item.providerContactId || "").trim()) return false;
  if (!String(item.providerExternalLeadId || "").trim()) return false;
  if (getPacificDateKey(completedAt) !== getPacificDateKey(policyAt)) return false;
  if (resolvePacificEndOfDayDrain(policyAt).due) return false;
  const dailyLimit = dailyAttemptLimitForLeadAge(item, {
    now: completedAt,
    maximum: Math.max(1, positiveInteger(maximumDailyAttempts, "maximumDailyAttempts")),
  });
  return getEffectiveDailyAttemptCount(item, completedAt) < dailyLimit;
}

function decideOutcomeState({
  normalizedOutcome,
  completedAt,
  dailyAttemptCount,
  maxDailyAttempts = 3,
  retryDelayMinutes = 120,
} = {}) {
  const outcome = normalizeOutcome(normalizedOutcome);
  const completed = parseDate(completedAt, "completedAt");
  const count = nonNegativeInteger(dailyAttemptCount, "dailyAttemptCount");
  const maximum = positiveInteger(maxDailyAttempts, "maxDailyAttempts");
  const retryMinutes = positiveInteger(retryDelayMinutes, "retryDelayMinutes");
  if (RETRYABLE_OUTCOMES.has(outcome)) {
    const normalDueAt = new Date(completed.getTime() + retryMinutes * 60_000);
    const dailyHold = count >= maximum;
    const dueAt = dailyHold ? null : normalDueAt;
    return {
      state: "follow_up_wait",
      activeAttempt: isActiveAttemptState("follow_up_wait"),
      lastOutcome: outcome,
      nextContactAt: dueAt,
      terminalAt: null,
      actions: [],
      reason: dailyHold ? "daily-attempt-limit" : "retry-scheduled",
      policyViolation: count > maximum ? "daily-attempt-limit-exceeded" : null,
    };
  }
  if (outcome === "dnc" || outcome === "bad_lead") {
    return {
      state: "terminal",
      activeAttempt: isActiveAttemptState("terminal"),
      lastOutcome: outcome,
      nextContactAt: null,
      terminalAt: completed,
      actions: [{ type: "logics_dnc", reason: outcome }],
      reason: "terminal-dnc-path",
      policyViolation: count > maximum ? "daily-attempt-limit-exceeded" : null,
    };
  }
  if (outcome === "appointment") {
    return {
      state: "terminal",
      activeAttempt: isActiveAttemptState("terminal"),
      lastOutcome: outcome,
      nextContactAt: null,
      terminalAt: completed,
      actions: [],
      reason: "terminal-appointment",
      policyViolation: count > maximum ? "daily-attempt-limit-exceeded" : null,
    };
  }
  if (outcome === "client") {
    return {
      state: "terminal",
      activeAttempt: isActiveAttemptState("terminal"),
      lastOutcome: outcome,
      nextContactAt: null,
      terminalAt: completed,
      actions: [],
      reason: "terminal-client",
      policyViolation: count > maximum ? "daily-attempt-limit-exceeded" : null,
    };
  }
  if (outcome === "review") {
    const dailyHold = count >= maximum;
    return {
      state: "follow_up_wait",
      activeAttempt: isActiveAttemptState("follow_up_wait"),
      lastOutcome: "review",
      nextContactAt: dailyHold ? null : new Date(completed.getTime() + retryMinutes * 60_000),
      terminalAt: null,
      actions: [],
      reason: dailyHold ? "daily-attempt-limit" : "unclassified-call-retry-scheduled",
      policyViolation: count > maximum ? "daily-attempt-limit-exceeded" : null,
    };
  }
  return {
    state: "review",
    activeAttempt: isActiveAttemptState("review"),
    lastOutcome: outcome === "answered" ? "answered" : "review",
    nextContactAt: null,
    terminalAt: null,
    actions: [],
    reason: outcome === "answered" ? "answered-needs-explicit-resolution" : "unknown-outcome",
    policyViolation: count > maximum ? "daily-attempt-limit-exceeded" : null,
  };
}

function decideRecoveryOutcomeState({
  normalizedOutcome,
  completedAt,
  dailyAttemptCount,
} = {}) {
  const outcome = normalizeOutcome(normalizedOutcome);
  const completed = parseDate(completedAt, "completedAt");
  const count = nonNegativeInteger(dailyAttemptCount, "dailyAttemptCount");
  if (outcome === "answered") {
    return {
      state: "follow_up_wait",
      activeAttempt: isActiveAttemptState("follow_up_wait"),
      lastOutcome: "answered",
      lastHumanAnsweredAt: completed,
      nextContactAt: null,
      terminalAt: null,
      actions: [],
      reason: "recovery-human-answered-day-hold",
      policyViolation: count > CALL_RECOVERY_MAXIMUM_DAILY_ATTEMPTS
        ? "daily-attempt-limit-exceeded"
        : null,
    };
  }
  const decision = decideOutcomeState({
    normalizedOutcome: outcome,
    completedAt: completed,
    dailyAttemptCount: count,
    maxDailyAttempts: CALL_RECOVERY_MAXIMUM_DAILY_ATTEMPTS,
    retryDelayMinutes: CALL_RECOVERY_MINIMUM_RETRY_MINUTES,
  });
  if (outcome !== "review") return decision;
  return {
    ...decision,
    state: "review",
    activeAttempt: isActiveAttemptState("review"),
    nextContactAt: null,
    reason: "recovery-outcome-review",
  };
}

function transitionCompletedAttempt(item = {}, outcome, options = {}) {
  const priorState = String(item.state || "").trim().toLowerCase();
  if (["terminal", "blocked"].includes(priorState)) {
    throw new Error(`cannot transition completed attempt from ${priorState}`);
  }
  const incomingCallId = String(options.providerCallId || "").trim();
  const countedCallId = String(item.lastCountedProviderCallId || "").trim();
  const incomingAttemptKey = String(options.providerAttemptKey || "").trim();
  const countedAttemptKey = existingCountedProviderAttemptKey(item);
  const sameCountedCall = incomingAttemptKey
    ? Boolean(countedAttemptKey && incomingAttemptKey === countedAttemptKey)
    : Boolean(incomingCallId && countedCallId && incomingCallId === countedCallId);
  const unresolvedRetry = priorState === "follow_up_wait"
    && String(item.lastOutcome || "").trim().toLowerCase() === "review";
  if (sameCountedCall && priorState !== "review" && !unresolvedRetry) {
    throw new Error(`same-call resolution requires review state, received ${priorState || "missing"}`);
  }
  const retainedProviderRetry = priorState === "follow_up_wait"
    && RETRYABLE_OUTCOMES.has(normalizeOutcome(item.lastOutcome))
    && Boolean(String(item.providerContactId || "").trim())
    && Boolean(String(item.providerExternalLeadId || "").trim());
  if (!sameCountedCall && !["provider_accepted", "in_call"].includes(priorState) && !retainedProviderRetry) {
    throw new Error(`first completion requires provider_accepted or in_call state, received ${priorState || "missing"}`);
  }
  const attempt = projectAttemptCompletion(item, options);
  const decision = decideOutcomeState({
    normalizedOutcome: outcome,
    completedAt: attempt.lastContactAt,
    dailyAttemptCount: attempt.dailyAttemptCount,
    maxDailyAttempts: options.maxDailyAttempts,
    retryDelayMinutes: options.retryDelayMinutes,
  });
  return {
    ...clone(item),
    ...attempt,
    ...decision,
  };
}

function createLeadDeliveryCadenceSource({
  repository,
  domains,
  policyForDomain = () => ({}),
  contactWindowEvaluator = null,
  overnightBatchResolver = null,
  retryDelayMinutes = 120,
  // Max age of the Logics status mirror before a lead is HELD instead of
  // delivered (2026-07-24 DNC incident — see the freshness gate in
  // sourceEligibility).
  //
  // Defaults to 0 = DISABLED, deliberately: the gate fails closed, and on
  // 2026-07-24 the live queue was ~94% stale, so arming it before the
  // status backfill lands would hold nearly every lead and stop the floor.
  // Run the queue status refresh first, then set
  // LEAD_DELIVERY_STATUS_MAX_AGE_HOURS=24 to arm it.
  statusMaxAgeMs = Math.max(
    0,
    Number(process.env.LEAD_DELIVERY_STATUS_MAX_AGE_HOURS ?? 0) * 60 * 60 * 1000,
  ),
} = {}) {
  for (const method of ["readSourceBatch", "readSourceLead", "readLegacyDailyAttemptFloor"]) {
    if (typeof repository?.[method] !== "function") {
      throw new TypeError(`repository.${method} is required`);
    }
  }
  if (!Array.isArray(domains) || domains.length === 0) {
    throw new TypeError("domains must be a non-empty array");
  }
  const sourceDomains = [...new Set(domains.map((domain) => String(domain || "").trim().toUpperCase()).filter(Boolean))];
  if (!sourceDomains.length) throw new TypeError("domains must contain a domain");
  if (typeof policyForDomain !== "function") throw new TypeError("policyForDomain must be a function");
  if (contactWindowEvaluator != null && typeof contactWindowEvaluator !== "function") {
    throw new TypeError("contactWindowEvaluator must be a function");
  }
  const legacyRetryDelayMinutes = positiveInteger(retryDelayMinutes, "retryDelayMinutes");
  if (overnightBatchResolver != null && typeof overnightBatchResolver !== "function") {
    throw new TypeError("overnightBatchResolver must be a function");
  }

  function normalizedPhone(row) {
    const raw = String(row?.normalizedPhone || row?.primaryPhone || "").replace(/\D/g, "");
    if (raw.length === 11 && raw.startsWith("1")) return raw.slice(1);
    return raw.length === 10 ? raw : "";
  }

  function receiptAt(row) {
    for (const value of [
      row?.payloadSnapshot?.createdAt,
      row?.attributionContext?.receivedAt,
      row?.createdAt,
    ]) {
      if (value == null || value === "") continue;
      const parsed = new Date(value);
      if (Number.isFinite(parsed.getTime())) return parsed;
    }
    return null;
  }

  function sourceEligibility(row, at, { requireContactWindow = false } = {}) {
    const domain = String(row?.domain || "").trim().toUpperCase();
    const caseProfile = CASE_PROFILE_SOURCE_ELIGIBILITY_ENABLED
      && row?.caseProfile && typeof row.caseProfile === "object"
      ? row.caseProfile
      : {};
    const policy = policyForDomain(domain) || {};
    const allowedStatuses = new Set(
      (Array.isArray(policy.allowedProspectStatusIds) ? policy.allowedProspectStatusIds : [1, 2])
        .map(Number).filter(Number.isFinite),
    );
    // DEFAULT_DNC_STATUS_IDS makes the DNC rule real: this list was empty
    // by default, so `logics-dnc-status` was dead code and DNC was only
    // caught incidentally by the allowedProspectStatusIds whitelist
    // (2026-07-24). 173 = "[Bad/Inactive]-DO NOT CALL".
    const dncStatuses = new Set(
      (Array.isArray(policy.dncStatusIds) && policy.dncStatusIds.length > 0
        ? policy.dncStatusIds
        : DEFAULT_DNC_STATUS_IDS)
        .map(Number).filter(Number.isFinite),
    );
    const cadenceStatusId = Number(row?.statusId);
    const statusIds = Number.isFinite(cadenceStatusId) ? [cadenceStatusId] : [];
    if (!domain || row?.caseId == null || String(row.caseId).trim() === "") {
      return { ok: false, reason: "missing-domain-case-identity", retryable: false };
    }
    if (!normalizedPhone(row)) return { ok: false, reason: "normalized-phone-not-proven", retryable: true };
    if (!receiptAt(row)) return { ok: false, reason: "received-at-not-proven", retryable: true };
    if (row.active === false) return { ok: false, reason: "cadence-inactive", retryable: false };
    if (row?.cadenceState?.channelDnc?.cx?.blocked === true) {
      return { ok: false, reason: "voice-channel-dnc", retryable: false };
    }
    if (row?.counterCadence?.lastCxDncAt != null
      && row.counterCadence.lastCxDncAt !== "") {
      return { ok: false, reason: "voice-dnc-recorded", retryable: false };
    }
    if (row?.dncCheckpoints?.hit === true) {
      return { ok: false, reason: "dnc-checkpoint-hit", retryable: false };
    }
    if (row?.activeAppointment && typeof row.activeAppointment === "object") {
      return { ok: false, reason: "appointment-active", retryable: false };
    }
    if (String(row.currentStage || "").trim().toLowerCase() === "cx-appointment-scheduled"
      || (row?.payloadSnapshot?.cxAppointment
        && typeof row.payloadSnapshot.cxAppointment === "object")) {
      return { ok: false, reason: "appointment-scheduled", retryable: false };
    }
    if (!statusIds.length) return { ok: false, reason: "status-not-proven", retryable: true };
    // FRESHNESS GATE (2026-07-24, WYNN 137190): the status we judge on is a
    // mirror of Logics, and nothing kept it fresh — the live queue was ~94%
    // stale (1,720 never checked, 6,966 older than a week). A case could go
    // DNC in Logics and keep being delivered because we never re-asked.
    // Fail CLOSED and retryable: a lead whose status age we cannot prove is
    // held, not dialed, until a refresh proves it.
    //
    // LeadCadence owns both the current Logics status and the timestamp that
    // proves when Logics supplied it. CaseProfile is not queried or inspected
    // by pre-serve admission.
    const voiceTouched = Math.max(
      nonNegativeInteger(row?.totalAttemptCount ?? 0, "totalAttemptCount"),
      nonNegativeInteger(row?.cadenceCounters?.cx ?? 0, "cadenceCounters.cx"),
    ) > 0 || [
      row?.lastContactAt,
      row?.lastTouched?.cx,
      row?.counterCadence?.lastCxDialedAt,
    ].some((value) => value != null && value !== "");
    if (statusMaxAgeMs > 0 && voiceTouched) {
      const checkedAt = Date.parse(row?.logicsStatusCheckedAt ?? "");
      if (!Number.isFinite(checkedAt)) {
        return { ok: false, reason: "status-freshness-unproven", retryable: true };
      }
      const invalidatedAt = Date.parse(row?.logicsStatusInvalidatedAt ?? "");
      if (Number.isFinite(invalidatedAt) && invalidatedAt > checkedAt) {
        return { ok: false, reason: "status-invalidated-after-touch", retryable: true };
      }
      if (at.getTime() - checkedAt > statusMaxAgeMs) {
        return { ok: false, reason: "status-stale", retryable: true };
      }
    }
    if (row?.logicsProspectEligible === false) {
      return { ok: false, reason: "logics-nonprospect-status", retryable: false };
    }
    if (statusIds.some((statusId) => dncStatuses.has(statusId))) {
      return { ok: false, reason: "logics-dnc-status", retryable: false };
    }
    if (statusIds.some((statusId) => !allowedStatuses.has(statusId))) {
      return { ok: false, reason: "logics-nonprospect-status", retryable: false };
    }
    if (caseProfile.convertedAt
      || caseProfile.firstPaymentDate
      || Number(caseProfile.paymentsCount || 0) > 0
      || Number(caseProfile.totalPaid || 0) > 0) {
      return { ok: false, reason: "payment-or-converted", retryable: false };
    }
    if (caseProfile?.conversationAi?.optOutDetected === true) {
      return { ok: false, reason: "opt-out-detected", retryable: false };
    }
    const reviewStatus = String(caseProfile?.aiActivityReview?.status || "").trim().toLowerCase();
    if (["pause_contact", "stop_contact"].includes(reviewStatus)) {
      return { ok: false, reason: reviewStatus.replace("_", "-"), retryable: reviewStatus === "pause_contact" };
    }
    if (caseProfile?.aiCaseReview?.nextEligibleAt) {
      const nextEligibleAt = new Date(caseProfile.aiCaseReview.nextEligibleAt);
      if (!Number.isFinite(nextEligibleAt.getTime())) {
        return { ok: false, reason: "case-review-date-invalid", retryable: true };
      }
      if (nextEligibleAt.getTime() > at.getTime()) {
        return { ok: false, reason: "case-review-hold", retryable: true, nextEligibleAt };
      }
    }
    const lifecycle = [row.currentStage, caseProfile.scrubSummary?.status, caseProfile.statusCategory]
      .filter(Boolean).join(" | ").toLowerCase();
    if ([
      "bad inactive", "bad-inactive", "changed mind", "default payment",
      "do not contact", "dnc", "opt out", "retained", "closed", "pause", "stop",
    ].some((token) => lifecycle.includes(token))) {
      return { ok: false, reason: "blocked-lifecycle", retryable: false };
    }
    // An answer is not a retryable no-connect. Until a human/system outcome moves
    // the case into one of the explicit terminal/hold paths above, keep it out of
    // automatic delivery for the rest of the Pacific business day.
    if (row?.counterCadence?.lastCxAnsweredAt != null
      && row.counterCadence.lastCxAnsweredAt !== "") {
      const answeredAt = new Date(row.counterCadence.lastCxAnsweredAt);
      if (!Number.isFinite(answeredAt.getTime())) {
        return { ok: false, reason: "answered-at-invalid", retryable: true };
      }
      if (getPacificDateKey(answeredAt) === getPacificDateKey(at)) {
        return { ok: false, reason: "answered-today-needs-resolution", retryable: true };
      }
    }
    if (requireContactWindow) {
      if (!contactWindowEvaluator) {
        return { ok: false, reason: "contact-window-not-configured", retryable: true };
      }
      let window;
      try {
        window = contactWindowEvaluator(row, at);
      } catch {
        return { ok: false, reason: "contact-window-read-failed", retryable: true };
      }
      if (!window || window.allowed !== true) {
        return {
          ok: false,
          reason: String(window?.reason || "contact-window-closed").slice(0, 80),
          retryable: true,
          nextEligibleAt: window?.nextAllowedAt || null,
        };
      }
    }
    return { ok: true, reason: "contactable", retryable: false };
  }

  function pacificMidnight(year, month, day) {
    let utcMs = Date.UTC(year, month - 1, day, 8, 0, 0, 0);
    for (let index = 0; index < 3; index += 1) {
      const parts = zonedParts(new Date(utcMs), PACIFIC_TIME_ZONE);
      const [hours, minutes] = parts.offset.slice(1).split(":").map(Number);
      const sign = parts.offset.startsWith("-") ? -1 : 1;
      const offsetMs = sign * ((hours * 60) + minutes) * 60_000;
      utcMs = Date.UTC(year, month - 1, day, 0, 0, 0, 0) - offsetMs;
    }
    return new Date(utcMs);
  }

  function pacificDayBounds(at) {
    const parts = zonedParts(at, PACIFIC_TIME_ZONE);
    const year = Number(parts.year);
    const month = Number(parts.month);
    const day = Number(parts.day);
    return {
      dateKey: `${parts.year}-${parts.month}-${parts.day}`,
      dayStart: pacificMidnight(year, month, day),
      dayEnd: pacificMidnight(year, month, day + 1),
    };
  }

  function newestSourceContactAt(...values) {
    return values.reduce((latest, value) => {
      if (value == null || value === "") return latest;
      const candidate = parseDate(value, "lastContactAt");
      return !latest || candidate.getTime() > latest.getTime() ? candidate : latest;
    }, null);
  }

  async function normalizeRow(row, at, { includeLegacyFloor = false, requireContactWindow = false } = {}) {
    if (!row) return null;
    const domain = String(row.domain || "").trim().toUpperCase();
    const bounds = pacificDayBounds(at);
    const cadenceDailyCount = String(row?.counterCadence?.cxDailyDateKey || "") === bounds.dateKey
      ? nonNegativeInteger(row?.counterCadence?.cxDailyCalls ?? 0, "counterCadence.cxDailyCalls")
      : 0;
    let dailyAttemptCount = cadenceDailyCount;
    if (includeLegacyFloor) {
      const evidence = await repository.readLegacyDailyAttemptFloor({
        domain,
        caseId: row.caseId,
        ...bounds,
      });
      dailyAttemptCount = Math.max(
        cadenceDailyCount,
        nonNegativeInteger(evidence?.cadenceDailyCount ?? 0, "cadenceDailyCount"),
        nonNegativeInteger(evidence?.terminalOutboxCallCount ?? 0, "terminalOutboxCallCount"),
        nonNegativeInteger(evidence?.callLogSessionCount ?? 0, "callLogSessionCount"),
        nonNegativeInteger(evidence?.mpiFillerDailyAttempts ?? 0, "mpiFillerDailyAttempts"),
      );
    }
    const receivedAt = receiptAt(row);
    const firstName = String(row.firstName || "").trim();
    const lastName = String(row.lastName || "").trim();
    const explicitName = String(row.name || "").trim();
    const phone = normalizedPhone(row);
    const lastContactAt = newestSourceContactAt(
      row?.lastContactAt,
      row?.counterCadence?.lastCxDialedAt,
      row?.lastTouched?.cx,
    );
    let nextContactAt = null;
    if (dailyAttemptCount > 0 && lastContactAt != null && lastContactAt !== "") {
      const lastVoiceTouch = parseDate(lastContactAt, "lastContactAt");
      const cadenceDelayMinutes = retryDelayMinutesForLeadAge({ receivedAt }, { now: at });
      nextContactAt = new Date(
        lastVoiceTouch.getTime() + Math.max(legacyRetryDelayMinutes, cadenceDelayMinutes) * 60_000,
      );
    }
    const totalAttemptCount = Math.max(
      dailyAttemptCount,
      nonNegativeInteger(row?.totalAttemptCount ?? 0, "totalAttemptCount"),
      nonNegativeInteger(row?.cadenceCounters?.cx ?? 0, "cadenceCounters.cx"),
    );
    const overnightBatch = overnightBatchResolver
      ? overnightBatchResolver({ receivedAt, lastContactAt, totalAttemptCount }, at)
      : null;
    return {
      domain,
      caseId: String(row.caseId ?? "").trim(),
      leadCadenceId: row._id == null ? null : String(row._id),
      normalizedPhone: phone,
      firstName: firstName || null,
      lastName: lastName || null,
      displayName: explicitName || [firstName, lastName].filter(Boolean).join(" ") || null,
      stateCode: String(row.state || row?.payloadSnapshot?.state || "").trim().toUpperCase() || null,
      timeZone: String(row?.payloadSnapshot?.timeZone || row?.payloadSnapshot?.timezone || "").trim() || null,
      receivedAt,
      overnightBatchKey: String(overnightBatch?.overnightBatchKey || "").trim() || null,
      overnightOrder: overnightBatch?.overnightOrder == null
        ? null
        : nonNegativeInteger(overnightBatch.overnightOrder, "overnightOrder"),
      nextContactAt,
      dailyAttemptDateKey: bounds.dateKey,
      dailyAttemptCount,
      totalAttemptCount,
      lastContactAt,
      lastOutcome: null,
      state: nextContactAt ? "follow_up_wait" : "eligible",
      activeAttempt: true,
      callable: true,
      sourceActive: row.active === true,
      eligibility: sourceEligibility(row, at, { requireContactWindow }),
    };
  }

  async function readBatch({ cursor = null, limit = 250, now = new Date() } = {}) {
    const at = parseDate(now, "now");
    const cap = positiveInteger(limit, "limit");
    const scan = await repository.readSourceBatch({
      cursor,
      limit: cap,
      domains: sourceDomains,
    });
    const rows = Array.isArray(scan?.items) ? scan.items : [];
    const items = [];
    for (const row of rows) {
      const normalized = await normalizeRow(row, at);
      if (normalized) items.push(normalized);
    }
    return {
      items,
      highWater: scan?.highWater ?? null,
      nextCursor: scan?.nextCursor ?? null,
      done: scan?.done === true,
    };
  }

  async function readNewerBatch({ after, limit = 250, now = new Date() } = {}) {
    if (typeof repository.readSourceNewerBatch !== "function") {
      throw new TypeError("repository.readSourceNewerBatch is required for source high-water repair");
    }
    const at = parseDate(now, "now");
    const scan = await repository.readSourceNewerBatch({
      after,
      limit: positiveInteger(limit, "limit"),
      domains: sourceDomains,
    });
    const items = [];
    for (const row of Array.isArray(scan?.items) ? scan.items : []) {
      const normalized = await normalizeRow(row, at);
      if (normalized) items.push(normalized);
    }
    return {
      items,
      nextHighWater: scan?.nextHighWater ?? after,
      done: scan?.done === true,
    };
  }

  async function readOne({
    domain,
    caseId,
    now = new Date(),
    deliveryIntent = "dial_ready",
    includeLegacyFloor = true,
  } = {}) {
    const at = parseDate(now, "now");
    const row = await repository.readSourceLead({ domain, caseId });
    return normalizeRow(row, at, {
      includeLegacyFloor: includeLegacyFloor !== false,
      // Explicit weekend pre-positioning only places a contact in a dormant,
      // shallow provider pool. Every dial-ready path (including unknown
      // intents) retains the current-clock contact-window gate.
      requireContactWindow: deliveryIntent !== "preposition",
    });
  }

  async function readWindowBatch({
    cursor = null,
    limit = 250,
    now = new Date(),
    receivedFrom,
    receivedBefore,
  } = {}) {
    if (typeof repository.readSourceWindowBatch !== "function") {
      throw new TypeError("repository.readSourceWindowBatch is required for preload windows");
    }
    const at = parseDate(now, "now");
    const from = parseDate(receivedFrom, "receivedFrom");
    const before = parseDate(receivedBefore, "receivedBefore");
    if (before.getTime() <= from.getTime()) {
      throw new TypeError("receivedBefore must be after receivedFrom");
    }
    const batch = await repository.readSourceWindowBatch({
      cursor,
      limit: positiveInteger(limit, "limit"),
      domains: sourceDomains,
      receivedFrom: from,
      receivedBefore: before,
    });
    const items = [];
    for (const row of Array.isArray(batch?.items) ? batch.items : []) {
      const normalized = await normalizeRow(row, at);
      if (!normalized || normalized.sourceActive !== true) continue;
      const receivedAt = parseDate(normalized.receivedAt, "receivedAt");
      if (receivedAt.getTime() < from.getTime() || receivedAt.getTime() >= before.getTime()) continue;
      items.push(normalized);
    }
    return {
      items,
      nextCursor: batch?.nextCursor ?? null,
      done: batch?.done === true,
    };
  }

  return { readBatch, readNewerBatch, readOne, readWindowBatch };
}

function createLeadDeliveryRuntime({
  repository,
  source = null,
  phoneBurner = null,
  actionHandlers = {},
  scheduler = null,
  logger = null,
  now = () => new Date(),
  configuration,
  enabled = false,
  actionsEnabled = false,
  refillEnabled = false,
  provider = "phoneburner",
  tickIntervalMs = 5_000,
  ingestBatchSize = 250,
  eventBatchSize = 50,
  eventLeaseMs = 300_000,
  refillLeaseMs = 300_000,
  agentPoolOperationLeaseMs = 300_000,
  actionRetryMs = 60_000,
  providerPostLeaseMs = 60_000,
  providerPostMinimumIntervalMs = 6_000,
  providerPostLaneLeaseMs = 300_000,
  providerPostSlotHeartbeatMs = 60_000,
  providerPostSlotPollMs = 100,
  providerRateLimitCooldownMs = 30_000,
  providerRateLimitMaximumCooldownMs = 86_400_000,
  acquireProviderPostSlot = null,
  extendProviderPostSlot = null,
  releaseProviderPostSlot = null,
  providerPostSleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  providerPostClock = () => Date.now(),
  currentOvernightBatchKey = null,
  packetPoolOrder = DEFAULT_FALLBACK_POOL_ORDER,
  maxDailyAttempts = 3,
  retryDelayMinutes = 120,
  deliveryWindowEvaluator = null,
  providerInventoryAuthoritative = false,
  endOfDayDrainHour = END_OF_DAY_DRAIN_HOUR,
  endOfDayDrainMinute = END_OF_DAY_DRAIN_MINUTE,
  endOfDayDeleteIntervalMs = END_OF_DAY_DELETE_INTERVAL_MS,
  endOfDayMaxDeletesPerRun = END_OF_DAY_MAX_DELETES_PER_RUN,
  // Compatibility only. Production leaves both switches false so the only
  // PhoneBurner writers are runDayStart, exact Call End refill, and daily
  // close. Old tests may opt in until the approved physical-deletion pass.
  legacyOperatorSurfaceEnabled = false,
  simpleOperatorDirectAccessEnabled = false,
  productivityRebalanceEnabled = false,
  persistDailyDialOutcomes = null,
  reconcileDailyDialCalls = null,
  providerConsumptionOrder = null,
  refreshSourceStatuses = null,
  refreshUntouchedSourceStatuses = null,
  onSourceItemPersisted = null,
  onProviderAccepted = null,
  onAttemptCompleted = null,
  // Non-secret exact provider media hosts. Injected, never read from the
  // environment here. Blank means no retained reference is ever promoted,
  // which is the correct fail-closed default for a fresh runtime.
  allowedRecordingHosts = [],
} = {}) {
  if (!repository || typeof repository !== "object") {
    throw new TypeError("repository is required");
  }
  const requiredRepositoryMethods = [
    "acquireAgentPoolOperation",
    "acquireEventProcessingLease",
    "acquireRefillRequest",
    "compareAndSetAgent",
    "compareAndSetEvent",
    "compareAndSetItem",
    "countAgentCompletedAttempts",
    "findItemBySourceIdentity",
    "getAgentById",
    "getItemById",
    "hasUnconsumedOvernightFirstContact",
    "insertActiveItemOnce",
    "listAgentDeliveryItems",
    "listAgentProjectionItems",
    "listAgents",
    "listEventsForDrain",
    "listImmediateFreshItems",
    "listPacketCandidateItems",
    "listProviderIdentityCandidates",
    "releaseRefillRequest",
    "releaseAgentPoolOperation",
    "renewAgentPoolOperation",
    "upsertAgentConfiguration",
  ];
  for (const method of requiredRepositoryMethods) {
    if (typeof repository[method] !== "function") {
      throw new TypeError(`repository.${method} is required`);
    }
  }
  if (source != null && typeof source?.readBatch !== "function") {
    throw new TypeError("source.readBatch is required when source is supplied");
  }
  const durableSourceStateEnabled = source != null
    && typeof source?.readNewerBatch === "function"
    && typeof repository.insertSourceRepairCheckpointOnce === "function"
    && typeof repository.getSourceRepairCheckpoint === "function"
    && typeof repository.compareAndSetSourceRepairCheckpoint === "function";
  const normalizedProviderConsumptionOrder = providerConsumptionOrder == null
    ? null
    : String(providerConsumptionOrder).trim().toLowerCase();
  if (normalizedProviderConsumptionOrder != null
    && !["oldest_first", "newest_first"].includes(normalizedProviderConsumptionOrder)) {
    throw new TypeError("providerConsumptionOrder must be oldest_first or newest_first");
  }
  if (actionsEnabled === true && typeof source?.readOne !== "function") {
    throw new TypeError("source.readOne is required when actions are enabled");
  }
  if (actionsEnabled === true && typeof phoneBurner?.createContact !== "function") {
    throw new TypeError("phoneBurner.createContact is required when actions are enabled");
  }
  if (actionsEnabled === true && typeof phoneBurner?.deleteContact !== "function") {
    throw new TypeError("phoneBurner.deleteContact is required when actions are enabled");
  }
  if (refreshSourceStatuses != null && typeof refreshSourceStatuses !== "function") {
    throw new TypeError("refreshSourceStatuses must be a function when supplied");
  }
  if (refreshUntouchedSourceStatuses != null && typeof refreshUntouchedSourceStatuses !== "function") {
    throw new TypeError("refreshUntouchedSourceStatuses must be a function when supplied");
  }
  if (onSourceItemPersisted != null && typeof onSourceItemPersisted !== "function") {
    throw new TypeError("onSourceItemPersisted must be a function when supplied");
  }
  if (onProviderAccepted != null && typeof onProviderAccepted !== "function") {
    throw new TypeError("onProviderAccepted must be a function when supplied");
  }
  if (onAttemptCompleted != null && typeof onAttemptCompleted !== "function") {
    throw new TypeError("onAttemptCompleted must be a function when supplied");
  }
  if (actionsEnabled === true && typeof phoneBurner?.listFolderContacts !== "function") {
    throw new TypeError("phoneBurner.listFolderContacts is required when actions are enabled");
  }
  if (refillEnabled === true && actionsEnabled !== true) {
    throw new TypeError("refillEnabled requires actionsEnabled");
  }
  if (productivityRebalanceEnabled === true
    && typeof repository.countAgentCompletedAttemptsSince !== "function") {
    throw new TypeError("productivityRebalanceEnabled requires repository.countAgentCompletedAttemptsSince");
  }
  if (productivityRebalanceEnabled === true && actionsEnabled === true
    && typeof phoneBurner?.getContact !== "function") {
    throw new TypeError("productivityRebalanceEnabled requires phoneBurner.getContact");
  }
  if (productivityRebalanceEnabled === true && actionsEnabled === true
    && typeof phoneBurner?.moveContact !== "function") {
    throw new TypeError("productivityRebalanceEnabled requires phoneBurner.moveContact");
  }
  if (providerInventoryAuthoritative === true
    && typeof phoneBurner?.getFolderCount !== "function") {
    throw new TypeError("providerInventoryAuthoritative requires phoneBurner.getFolderCount");
  }
  if (typeof now !== "function") throw new TypeError("now must be a function");
  if (persistDailyDialOutcomes != null && typeof persistDailyDialOutcomes !== "function") {
    throw new TypeError("persistDailyDialOutcomes must be a function");
  }
  if (reconcileDailyDialCalls != null && typeof reconcileDailyDialCalls !== "function") {
    throw new TypeError("reconcileDailyDialCalls must be a function");
  }
  if (!configuration || typeof configuration !== "object") {
    throw new TypeError("configuration is required");
  }
  const validation = validateLeadDeliveryConfiguration(configuration);
  if (!validation.valid) {
    throw new TypeError(`invalid lead-delivery configuration: ${validation.errors.join("; ")}`);
  }
  const providerName = String(provider || "").trim().toLowerCase();
  if (!providerName) throw new TypeError("provider is required");
  // ONE resolver for the whole runtime. The link an attempt receives is either
  // the validated capture URL or a retained provider reference that passed the
  // exact-host promotion policy — never anything else, and never a value this
  // runtime went and fetched.
  const recordingLocatorOf = (event) => resolveRecordingLocator(event?.safePayload, {
    allowedHosts: allowedRecordingHosts,
  }).recordingUrl;
  const intervalMs = positiveInteger(tickIntervalMs, "tickIntervalMs");
  const sourceLimit = positiveInteger(ingestBatchSize, "ingestBatchSize");
  const drainLimit = positiveInteger(eventBatchSize, "eventBatchSize");
  const eventLeaseDuration = positiveInteger(eventLeaseMs, "eventLeaseMs");
  const refillLeaseDuration = positiveInteger(refillLeaseMs, "refillLeaseMs");
  const retryDuration = positiveInteger(actionRetryMs, "actionRetryMs");
  const postLeaseDuration = positiveInteger(providerPostLeaseMs, "providerPostLeaseMs");
  const postMinimumInterval = positiveInteger(providerPostMinimumIntervalMs, "providerPostMinimumIntervalMs");
  const postLaneLeaseDuration = positiveInteger(providerPostLaneLeaseMs, "providerPostLaneLeaseMs");
  const postSlotHeartbeatDuration = positiveInteger(
    providerPostSlotHeartbeatMs,
    "providerPostSlotHeartbeatMs",
  );
  const postSlotPollDuration = positiveInteger(providerPostSlotPollMs, "providerPostSlotPollMs");
  const rateLimitCooldownDuration = positiveInteger(providerRateLimitCooldownMs, "providerRateLimitCooldownMs");
  const rateLimitMaximumCooldownDuration = positiveInteger(
    providerRateLimitMaximumCooldownMs,
    "providerRateLimitMaximumCooldownMs",
  );
  if (postLaneLeaseDuration < postMinimumInterval) {
    throw new TypeError("providerPostLaneLeaseMs must cover providerPostMinimumIntervalMs");
  }
  if (postSlotHeartbeatDuration >= postLaneLeaseDuration) {
    throw new TypeError("providerPostSlotHeartbeatMs must be below providerPostLaneLeaseMs");
  }
  if (rateLimitMaximumCooldownDuration < rateLimitCooldownDuration) {
    throw new TypeError("providerRateLimitMaximumCooldownMs must cover providerRateLimitCooldownMs");
  }
  const suppliedProviderPostSlotPorts = [
    acquireProviderPostSlot,
    extendProviderPostSlot,
    releaseProviderPostSlot,
  ].filter((port) => port != null).length;
  if (![0, 3].includes(suppliedProviderPostSlotPorts)) {
    throw new TypeError("provider post slot acquire, extend, and release ports must be supplied together");
  }
  if (acquireProviderPostSlot != null && typeof acquireProviderPostSlot !== "function") {
    throw new TypeError("acquireProviderPostSlot must be a function");
  }
  if (releaseProviderPostSlot != null && typeof releaseProviderPostSlot !== "function") {
    throw new TypeError("releaseProviderPostSlot must be a function");
  }
  if (extendProviderPostSlot != null && typeof extendProviderPostSlot !== "function") {
    throw new TypeError("extendProviderPostSlot must be a function");
  }
  if (typeof providerPostSleep !== "function") throw new TypeError("providerPostSleep must be a function");
  if (typeof providerPostClock !== "function") throw new TypeError("providerPostClock must be a function");
  const maximumDailyAttempts = positiveInteger(maxDailyAttempts, "maxDailyAttempts");
  const followUpDelayMinutes = positiveInteger(retryDelayMinutes, "retryDelayMinutes");
  const poolOperationLeaseDurationMs = positiveInteger(
    agentPoolOperationLeaseMs,
    "agentPoolOperationLeaseMs",
  );
  const closeHour = nonNegativeInteger(endOfDayDrainHour, "endOfDayDrainHour");
  const closeMinute = nonNegativeInteger(endOfDayDrainMinute, "endOfDayDrainMinute");
  resolvePacificEndOfDayDrain(new Date(), { hour: closeHour, minute: closeMinute });
  const closeDeleteInterval = positiveInteger(
    endOfDayDeleteIntervalMs,
    "endOfDayDeleteIntervalMs",
  );
  const closeDeleteLimit = positiveInteger(
    endOfDayMaxDeletesPerRun,
    "endOfDayMaxDeletesPerRun",
  );
  const deliveryWindowOpen = typeof deliveryWindowEvaluator === "function"
    ? deliveryWindowEvaluator
    : isPacificDeliveryWindowOpen;
  if (currentOvernightBatchKey != null
    && typeof currentOvernightBatchKey !== "string"
    && typeof currentOvernightBatchKey !== "function") {
    throw new TypeError("currentOvernightBatchKey must be a string or function");
  }
  const schedule = scheduler || {
    setInterval: (work, delay) => setInterval(work, delay),
    clearInterval: (handle) => clearInterval(handle),
    setTimeout: (work, delay) => setTimeout(work, delay),
    clearTimeout: (handle) => clearTimeout(handle),
  };
  if (typeof schedule.setInterval !== "function" || typeof schedule.clearInterval !== "function") {
    throw new TypeError("scheduler requires setInterval and clearInterval");
  }
  const runtimeState = {
    running: false,
    sourceCursor: null,
    sourceDone: false,
    sourceBusinessDate: null,
    sourceRepairStatus: durableSourceStateEnabled ? "not-run" : "legacy-cursor",
    sourceLane: durableSourceStateEnabled ? "repair" : "legacy",
    tickMode: enabled === true ? "not-run" : "disabled",
    offHoursTicks: 0,
    sourceReadsSkippedOffHours: 0,
    lastTickAt: null,
    lastErrorCode: null,
    ticks: 0,
    ingested: 0,
    accepted: 0,
    completed: 0,
    freshDispatchAttempts: 0,
    freshDispatchAccepted: 0,
    freshDispatchLastAt: null,
    freshDispatchLastStatus: "not-run",
    providerPostQueueDepth: 0,
    providerPostInFlight: 0,
    providerPostStarts: 0,
    providerPostRateLimited: 0,
    providerPostSlotWaits: 0,
    providerPostLastStartedAt: null,
    providerPostLastCompletedAt: null,
    providerPostNextAllowedAt: null,
    providerPostCooldownUntil: null,
    providerInventoryCooldownUntil: null,
    providerPostCircuitOpen: false,
    dayStartDateKey: null,
    dayStartStatus: "not-due",
    dayStartLastAttemptAt: null,
    dayStartLastCompletedAt: null,
    dayStartAgentResults: [],
    endOfDayDrainDateKey: null,
    endOfDayDrainStatus: "not-due",
    endOfDayDrainLastAttemptAt: null,
    endOfDayDrainLastCompletedAt: null,
    endOfDayDrainDeletedCount: 0,
    endOfDayDrainRemainingCount: null,
    endOfDayDrainAgentResults: [],
    endOfDayCallLogProjection: {
      status: "not-run",
      rows: 0,
      attempts: 0,
      reconciled: 0,
      rejected: 0,
      agentUnmapped: 0,
    },
    productivityRebalanceStatus: productivityRebalanceEnabled === true ? "warming" : "disabled",
    productivityRebalanceLastAttemptAt: null,
    productivityRebalanceLastCompletedAt: null,
    productivityRebalanceLastWindowKey: null,
    productivityRebalanceRemovedCount: 0,
    productivityRebalanceRedistributedCount: 0,
    productivityRebalanceAgentResults: [],
    watchdogSupplyRefreshStatus: "idle",
    watchdogSupplyRefreshBatches: 0,
    watchdogSupplyRefreshLastCompletedAt: null,
    watchdogStatusRefreshRefreshed: 0,
    watchdogStatusRefreshFailed: 0,
    watchdogStatusRefreshReclassified: 0,
    watchdogStatusRefreshReevaluated: 0,
    watchdogStatusRefreshStillBlocked: 0,
  };
  let timerHandle = null;
  let tickInFlight = null;
  let ingestInFlight = null;
  let watchdogSupplyRefreshInFlight = null;
  let freshDispatchInFlight = null;
  let providerPostTail = Promise.resolve();
  let providerPostAccepting = true;
  let providerPostLastStartedAtMs = null;
  let consecutiveProviderRateLimits = 0;
  let providerInventoryCooldownUntilMs = 0;
  let endOfDayDrainInFlight = null;
  let priorDayDrainReleaseDateKey = null;
  let productivityRebalanceStartedAt = null;
  let productivityRebalanceInFlight = null;
  let productivityRebalanceLastWindowKey = null;
  let priorCloseAuditDateKey = null;
  const backgroundRefills = new Set();
  const backgroundRefillsByAgent = new Map();
  const physicalRefreshesByAgent = new Map();
  const topUpInFlightByAgent = new Map();
  const poolOperationTailsByAgent = new Map();

  function legacyOperatorDisabled(agentId = null) {
    return {
      status: "legacy-operator-disabled",
      agentId: agentId == null ? null : String(agentId || "").trim().toLowerCase(),
      accepted: 0,
    };
  }

  async function listPendingProviderPosts(agentId) {
    const items = typeof repository.listAgentPendingProviderPosts === "function"
      ? await repository.listAgentPendingProviderPosts(agentId)
      // Compatibility only for test/in-memory repositories. Production uses
      // the narrow Mongo query rather than scanning a day's active cadence rows.
      : await repository.listAgentDeliveryItems(agentId);
    const observedAt = atNow().getTime();
    return items.filter((item) => {
      const postState = String(item.providerPostState || "").trim().toLowerCase();
      const leaseExpiresAt = item.providerPostLeaseExpiresAt
        ? new Date(item.providerPostLeaseExpiresAt).getTime()
        : Number.NaN;
      const recoverablePostState = ["", "prepared", "reconcile_required"].includes(postState)
        || (postState === "posting" && (!Number.isFinite(leaseExpiresAt) || leaseExpiresAt <= observedAt));
      return (
      String(item.state || "") === "packetized"
      && !String(item.providerContactId || "").trim()
      && recoverablePostState
      );
    });
  }

  function atNow() {
    return parseDate(now(), "now()");
  }

  function enqueueAgentPoolOperation(agentId, work) {
    const id = String(agentId || "").trim().toLowerCase();
    const prior = poolOperationTailsByAgent.get(id) || Promise.resolve();
    const result = prior.catch(() => {}).then(work);
    const tail = result.catch(() => {}).finally(() => {
      if (poolOperationTailsByAgent.get(id) === tail) poolOperationTailsByAgent.delete(id);
    });
    poolOperationTailsByAgent.set(id, tail);
    return result;
  }

  async function withAgentPoolOperation(agentId, operationKind, work, options = {}) {
    const id = String(agentId || "").trim().toLowerCase();
    if (!id) throw new TypeError("agentId is required");
    if (typeof work !== "function") throw new TypeError("agent Pool operation work is required");
    const kind = String(operationKind || "").trim().toLowerCase();
    if (!AGENT_POOL_OPERATION_KIND_SET.has(kind)) {
      throw new TypeError(`unsupported agent Pool operation kind ${kind || "<blank>"}`);
    }
    const operationId = String(options.operationId || `${kind}-${randomUUID()}`).trim();
    return enqueueAgentPoolOperation(id, async () => {
      const startedAt = atNow();
      let agent = await repository.getAgentById(id);
      if (!agent && agentPolicy(id)) {
        await syncConfiguredAgents();
        agent = await repository.getAgentById(id);
      }
      if (!agent) return { status: "unknown-agent", agentId: id, accepted: 0 };
      const dayCloseDue = options.dayCloseDue === true
        || resolvePacificEndOfDayDrain(startedAt, { hour: closeHour, minute: closeMinute }).due;
      const permission = canMutateAgentPool({
        agent,
        operationKind: kind,
        operationId,
        dayCloseDue,
        now: startedAt,
      });
      if (!permission.allowed) {
        return { status: permission.reason, agentId: id, accepted: 0 };
      }
      let owned = await repository.acquireAgentPoolOperation({
        agentId: id,
        expectedVersion: agent.version,
        operationId,
        operationKind: kind,
        now: startedAt,
        leaseMs: poolOperationLeaseDurationMs,
      });
      if (!owned) return { status: "pool-operation-busy", agentId: id, accepted: 0 };
      const lostPoolOperation = () => {
        const error = new Error(`lost ${kind} Pool operation for ${id}`);
        error.code = "pool-operation-lease-lost";
        throw error;
      };
      const renew = async () => {
        const current = await repository.getAgentById(id);
        if (!current
          || current.poolOperationId !== operationId
          || current.poolOperationKind !== kind) return lostPoolOperation();
        const renewed = await repository.renewAgentPoolOperation({
          agentId: id,
          expectedVersion: current.version,
          operationId,
          operationKind: kind,
          now: atNow(),
          leaseMs: poolOperationLeaseDurationMs,
        });
        if (!renewed) return lostPoolOperation();
        if (renewed) owned = renewed;
        return renewed;
      };
      try {
        return await work({ operationId, operationKind: kind, agent: owned, renew });
      } finally {
        const current = await repository.getAgentById(id);
        if (current
          && current.poolOperationId === operationId
          && current.poolOperationKind === kind) {
          await repository.releaseAgentPoolOperation({
            agentId: id,
            expectedVersion: current.version,
            operationId,
            operationKind: kind,
          });
        }
      }
    });
  }

  function withAgentPoolOperations(agentIds, operationKind, work, options = {}) {
    const ids = [...new Set((agentIds || [])
      .map((agentId) => String(agentId || "").trim().toLowerCase())
      .filter(Boolean))].sort();
    const acquireNext = (index, operations) => {
      if (index >= ids.length) return work(operations);
      return withAgentPoolOperation(ids[index], operationKind, (operation) => (
        acquireNext(index + 1, [...operations, operation])
      ), options);
    };
    return acquireNext(0, []);
  }

  function noteProviderInventoryBackpressure(result) {
    const rateLimited = Number(result?.httpStatus) === 429
      || Number.isFinite(Number(result?.retryAfterMs));
    if (!rateLimited) return;
    const requested = Number(result?.retryAfterMs);
    const delay = Math.min(
      rateLimitMaximumCooldownDuration,
      Math.max(rateLimitCooldownDuration, Number.isFinite(requested) ? requested : 0),
    );
    providerInventoryCooldownUntilMs = Math.max(
      providerInventoryCooldownUntilMs,
      providerPostClock() + delay,
    );
    runtimeState.providerInventoryCooldownUntil = new Date(providerInventoryCooldownUntilMs);
  }

  function overnightBatchKeyAt(at) {
    const value = typeof currentOvernightBatchKey === "function"
      ? currentOvernightBatchKey(at)
      : currentOvernightBatchKey;
    return String(value || "").trim() || null;
  }

  function log(level, event, fields = {}) {
    if (!logger) return;
    const safe = {
      agentId: fields.agentId == null ? undefined : String(fields.agentId),
      count: Number.isFinite(fields.count) ? Number(fields.count) : undefined,
      reason: fields.reason == null ? undefined : String(fields.reason).slice(0, 80),
    };
    const payload = Object.fromEntries(Object.entries(safe).filter(([, value]) => value !== undefined));
    if (typeof logger === "function") logger(level, event, payload);
    else if (typeof logger[level] === "function") logger[level](event, payload);
  }

  const providerPostLaneKey = `lead-delivery:${providerName}:contact-post`;

  function providerPostClockMs() {
    const value = Number(providerPostClock());
    if (!Number.isFinite(value)) throw new TypeError("providerPostClock must return a finite millisecond value");
    return value;
  }

  async function waitForProviderPost(delayMs) {
    const duration = Math.max(0, Math.ceil(Number(delayMs) || 0));
    if (duration > 0) await providerPostSleep(duration);
  }

  async function acquireDurableProviderPostSlot() {
    if (!acquireProviderPostSlot) return null;
    while (providerPostAccepting) {
      const slot = await acquireProviderPostSlot({
        laneKey: providerPostLaneKey,
        leaseMs: postLaneLeaseDuration,
      });
      if (slot) return slot;
      runtimeState.providerPostSlotWaits += 1;
      await waitForProviderPost(postSlotPollDuration);
    }
    return null;
  }

  function providerRateLimitDelay(result) {
    consecutiveProviderRateLimits += 1;
    const requested = Number(result?.retryAfterMs);
    if (Number.isFinite(requested) && requested >= 0) {
      return Math.min(
        Math.max(requested, postMinimumInterval),
        rateLimitMaximumCooldownDuration,
      );
    }
    const exponent = Math.min(consecutiveProviderRateLimits - 1, 4);
    const fallback = rateLimitCooldownDuration * (2 ** exponent);
    return Math.min(fallback, rateLimitMaximumCooldownDuration);
  }

  async function runProviderPostTurn(work) {
    runtimeState.providerPostQueueDepth += 1;
    const previous = providerPostTail.catch(() => {});
    let releaseTurn;
    providerPostTail = new Promise((resolve) => {
      releaseTurn = resolve;
    });
    await previous;
    runtimeState.providerPostQueueDepth = Math.max(0, runtimeState.providerPostQueueDepth - 1);

    let durableSlot = null;
    let durableSlotHeartbeat = null;
    let durableSlotHeartbeatInFlight = null;
    let durableSlotLost = false;
    let providerStartedAtMs = null;
    let providerCompletedAtMs = null;
    let result;
    try {
      if (runtimeState.providerPostCircuitOpen) {
        return { status: "provider-lane-unavailable", accepted: false };
      }
      if (!providerPostAccepting) return { status: "provider-lane-stopped", accepted: false };
      const observedAtMs = providerPostClockMs();
      if (runtimeState.providerPostCooldownUntil
        && runtimeState.providerPostCooldownUntil.getTime() > observedAtMs) {
        return { status: "provider-backpressure", accepted: false };
      }
      if (runtimeState.providerPostCooldownUntil) {
        runtimeState.providerPostCooldownUntil = null;
      }
      const intervalBoundary = providerPostLastStartedAtMs == null
        ? observedAtMs
        : providerPostLastStartedAtMs + postMinimumInterval;
      const localStartBoundary = Math.max(observedAtMs, intervalBoundary);
      await waitForProviderPost(localStartBoundary - observedAtMs);
      if (!providerPostAccepting) return { status: "provider-lane-stopped", accepted: false };

      durableSlot = await acquireDurableProviderPostSlot();
      if (acquireProviderPostSlot && !durableSlot) {
        return { status: "provider-lane-stopped", accepted: false };
      }
      if (!providerPostAccepting) return { status: "provider-lane-stopped", accepted: false };
      if (durableSlot) {
        durableSlotHeartbeat = schedule.setInterval(() => {
          if (durableSlotHeartbeatInFlight || durableSlotLost) return;
          durableSlotHeartbeatInFlight = Promise.resolve(extendProviderPostSlot({
            laneKey: providerPostLaneKey,
            slot: durableSlot,
            leaseMs: postLaneLeaseDuration,
          })).then((extended) => {
            if (!extended) {
              durableSlotLost = true;
              runtimeState.providerPostCircuitOpen = true;
              log("error", "lead_delivery.provider_post_slot_lost", { reason: "slot-heartbeat-rejected" });
              return;
            }
            durableSlot = extended;
          }).catch(() => {
            durableSlotLost = true;
            runtimeState.providerPostCircuitOpen = true;
            log("error", "lead_delivery.provider_post_slot_lost", { reason: "slot-heartbeat-failed" });
          }).finally(() => {
            durableSlotHeartbeatInFlight = null;
          });
        }, postSlotHeartbeatDuration);
        if (typeof durableSlotHeartbeat?.unref === "function") durableSlotHeartbeat.unref();
      }

      providerStartedAtMs = Math.max(providerPostClockMs(), localStartBoundary);
      providerPostLastStartedAtMs = providerStartedAtMs;
      runtimeState.providerPostInFlight = 1;
      runtimeState.providerPostStarts += 1;
      runtimeState.providerPostLastStartedAt = new Date(providerStartedAtMs);
      runtimeState.providerPostNextAllowedAt = new Date(providerStartedAtMs + postMinimumInterval);

      result = await work();
      providerCompletedAtMs = Math.max(providerPostClockMs(), providerStartedAtMs);
      runtimeState.providerPostLastCompletedAt = new Date(providerCompletedAtMs);
      if (String(result?.status || "").trim().toLowerCase() === "rate-limited") {
        const cooldownMs = providerRateLimitDelay(result);
        runtimeState.providerPostRateLimited += 1;
        runtimeState.providerPostCooldownUntil = new Date(providerCompletedAtMs + cooldownMs);
        runtimeState.providerPostNextAllowedAt = new Date(Math.max(
          runtimeState.providerPostNextAllowedAt.getTime(),
          runtimeState.providerPostCooldownUntil.getTime(),
        ));
        log("warn", "lead_delivery.provider_rate_limited", {
          count: runtimeState.providerPostRateLimited,
          reason: "provider-backpressure",
        });
      } else {
        consecutiveProviderRateLimits = 0;
        if (runtimeState.providerPostCooldownUntil
          && runtimeState.providerPostCooldownUntil.getTime() <= providerCompletedAtMs) {
          runtimeState.providerPostCooldownUntil = null;
        }
      }

      return result;
    } finally {
      if (providerStartedAtMs != null && providerCompletedAtMs == null) {
        providerCompletedAtMs = Math.max(
          providerPostClockMs(),
          providerStartedAtMs,
        );
        runtimeState.providerPostLastCompletedAt = new Date(providerCompletedAtMs);
      }
      runtimeState.providerPostInFlight = 0;
      if (durableSlotHeartbeat != null) schedule.clearInterval(durableSlotHeartbeat);
      if (durableSlotHeartbeatInFlight) await durableSlotHeartbeatInFlight.catch(() => {});
      if (durableSlot) {
        const rateLimited = String(result?.status || "").trim().toLowerCase() === "rate-limited";
        if (rateLimited && runtimeState.providerPostCooldownUntil) {
          const remainingCooldownMs = Math.max(
            postMinimumInterval,
            runtimeState.providerPostCooldownUntil.getTime() - providerPostClockMs(),
          );
          try {
            const extended = await extendProviderPostSlot({
              laneKey: providerPostLaneKey,
              slot: durableSlot,
              leaseMs: remainingCooldownMs,
            });
            if (!extended) {
              runtimeState.providerPostCircuitOpen = true;
              log("error", "lead_delivery.provider_post_slot_lost", { reason: "cooldown-extension-rejected" });
            }
          } catch {
            runtimeState.providerPostCircuitOpen = true;
            log("error", "lead_delivery.provider_post_slot_lost", { reason: "cooldown-extension-failed" });
          }
          // The durable lock itself is the cross-process cooldown. Do not
          // delete it; expiry makes the next provider turn eligible.
        } else if (!durableSlotLost) {
          const holdUntilMs = providerStartedAtMs == null
            ? 0
            : providerStartedAtMs + postMinimumInterval;
          try {
            await waitForProviderPost(holdUntilMs - providerPostClockMs());
            await releaseProviderPostSlot({ laneKey: providerPostLaneKey, slot: durableSlot });
          } catch {
            log("warn", "lead_delivery.provider_post_slot_release_failed", { reason: "slot-release-failed" });
          }
        }
      }
      releaseTurn();
    }
  }

  function agentPolicy(agentId) {
    const id = String(agentId || "").trim().toLowerCase();
    const entry = configuration.agents[id];
    if (!entry) return null;
    return {
      agentId: id,
      enabled: entry.enabled === true,
      displayName: String(entry.displayName || "").trim() || id,
      applicationAccountEmail: String(entry.applicationAccountEmail || "").trim().toLowerCase() || null,
      provider: String(entry.provider || providerName).trim().toLowerCase(),
      providerConfig: {
        distributionFolderId: String(entry.distributionFolderId || "").trim(),
        receivingFolderId: String(entry.receivingFolderId || "").trim(),
        ownerId: String(entry.phoneBurnerMemberId || "").trim() || null,
        ownerUsername: String(entry.phoneBurnerUsername || "").trim() || null,
      },
      subscribedPools: [...entry.subscribedPools],
      packetAllowances: { ...entry.packetAllowances },
      providerBufferTarget: configuration.defaults.providerBufferTarget,
      refillAtOrBelow: configuration.defaults.refillAtOrBelow,
      freshReservationRange: configuration.defaults.freshReservationRange,
      freshReservationMinutes: configuration.defaults.freshReservationMinutes,
      activeEvidenceMinutes: configuration.defaults.activeEvidenceMinutes,
      maxPendingFreshReservations: configuration.defaults.maxPendingFreshReservations,
    };
  }

  function fairAgentOrder() {
    return Object.keys(configuration.agents)
      .map((agentId) => String(agentId || "").trim().toLowerCase())
      .filter((agentId) => agentPolicy(agentId)?.enabled === true);
  }

  async function claimFairAgent(workType, eligibleAgentIds) {
    const ring = fairAgentOrder();
    const eligible = new Set((eligibleAgentIds || [])
      .map((agentId) => String(agentId || "").trim().toLowerCase())
      .filter(Boolean));
    return claimNextFairPick({
      repository,
      workType,
      agentOrder: ring,
      excludedAgentIds: ring.filter((agentId) => !eligible.has(agentId)),
    });
  }

  async function readNextFairAgent(workType, eligibleAgentIds) {
    const ring = fairAgentOrder();
    const eligible = new Set((eligibleAgentIds || [])
      .map((agentId) => String(agentId || "").trim().toLowerCase())
      .filter(Boolean));
    const cursor = await repository.getOrCreateFairPickCursor(workType, { agentOrder: ring });
    const agentId = nextFairPick({
      agentOrder: cursor.agentOrder,
      lastPickedAgentId: cursor.lastPickedAgentId,
      excludedAgentIds: ring.filter((id) => !eligible.has(id)),
    });
    return agentId
      ? { status: "picked", agentId, cursor }
      : { status: "no-eligible-agent", agentId: null, cursor };
  }

  async function commitAcceptedFairAgent(workType, pick) {
    if (!pick?.agentId || !pick?.cursor) return null;
    return repository.compareAndSetFairPickCursor({
      workType,
      expectedVersion: pick.cursor.version,
      expectedLastPickedAgentId: pick.cursor.lastPickedAgentId,
      lastPickedAgentId: pick.agentId,
    });
  }

  function dailyCloseAgentIds() {
    return Object.keys(configuration.agents)
      .map((agentId) => String(agentId || "").trim().toLowerCase())
      .filter((agentId) => {
        const policy = agentPolicy(agentId);
        return Boolean(
          policy?.providerConfig?.distributionFolderId
          && policy?.providerConfig?.receivingFolderId,
        );
      });
  }

  async function syncConfiguredAgents() {
    const rows = [];
    for (const agentId of Object.keys(configuration.agents).sort()) {
      const policy = agentPolicy(agentId);
      rows.push(await repository.upsertAgentConfiguration({
        agentId,
        displayName: policy.displayName,
        enabled: policy.enabled,
        configuration: {
          provider: policy.provider,
          applicationAccountEmail: policy.applicationAccountEmail,
          providerConfig: clone(policy.providerConfig),
          subscribedPools: [...policy.subscribedPools],
          packetAllowances: clone(policy.packetAllowances),
          providerBufferTarget: policy.providerBufferTarget,
          refillAtOrBelow: policy.refillAtOrBelow,
          freshReservationRange: policy.freshReservationRange,
          freshReservationMinutes: policy.freshReservationMinutes,
          activeEvidenceMinutes: policy.activeEvidenceMinutes,
          maxPendingFreshReservations: policy.maxPendingFreshReservations,
        },
      }));
    }
    return rows;
  }

                      function mergedAgent(persisted, policy) {
    if (!persisted || !policy) return null;
    return {
      ...clone(persisted),
      ...clone(policy),
      enabled: policy.enabled === true && persisted.enabled === true,
      providerConfigurationComplete: Boolean(
        policy.providerConfig.distributionFolderId
        && policy.providerConfig.receivingFolderId
      ),
    };
  }

  function sourceItemForInsert(row, classification) {
    const state = classification.pool === POOLS.FOLLOW_UP_DUE ? "follow_up_wait" : "eligible";
    return {
      domain: String(row.domain || "").trim().toUpperCase(),
      caseId: String(row.caseId ?? "").trim(),
      leadCadenceId: row.leadCadenceId == null ? null : String(row.leadCadenceId),
      normalizedPhone: String(row.normalizedPhone || "").trim(),
      displayName: String(row.displayName || "").trim() || null,
      inventoryClass: String(row.inventoryClass || "").trim().toLowerCase() || null,
      contactPolicyId: String(row.contactPolicyId || "").trim().toLowerCase() || null,
      eligibleFrom: row.eligibleFrom == null ? null : parseDate(row.eligibleFrom, "eligibleFrom"),
      expiresAt: row.expiresAt == null ? null : parseDate(row.expiresAt, "expiresAt"),
      firstQualifyingCallAt: row.firstQualifyingCallAt == null
        ? null
        : parseDate(row.firstQualifyingCallAt, "firstQualifyingCallAt"),
      episodeId: String(row.episodeId || "").trim() || null,
      lastHumanAnsweredAt: row.lastHumanAnsweredAt == null
        ? null
        : parseDate(row.lastHumanAnsweredAt, "lastHumanAnsweredAt"),
      sourcePool: classification.pool,
      receivedAt: parseDate(row.receivedAt, "receivedAt"),
      overnightBatchKey: String(row.overnightBatchKey || "").trim() || null,
      overnightOrder: row.overnightOrder == null ? null : nonNegativeInteger(row.overnightOrder, "overnightOrder"),
      nextContactAt: row.nextContactAt == null ? null : parseDate(row.nextContactAt, "nextContactAt"),
      dailyAttemptDateKey: String(row.dailyAttemptDateKey || "").trim() || null,
      dailyAttemptCount: nonNegativeInteger(row.dailyAttemptCount ?? 0, "dailyAttemptCount"),
      totalAttemptCount: nonNegativeInteger(row.totalAttemptCount ?? 0, "totalAttemptCount"),
      lastContactAt: row.lastContactAt == null ? null : parseDate(row.lastContactAt, "lastContactAt"),
      lastOutcome: String(row.lastOutcome || "").trim() || null,
      state,
      activeAttempt: true,
      version: 0,
      metadata: {
        firstName: String(row.firstName || "").trim() || null,
        lastName: String(row.lastName || "").trim() || null,
        stateCode: String(row.stateCode || "").trim().toUpperCase() || null,
        timeZone: String(row.timeZone || "").trim() || null,
      },
    };
  }

  function newestProvenDate(left, right, fieldName) {
    const values = [left, right]
      .filter((value) => value != null && value !== "")
      .map((value) => parseDate(value, fieldName));
    if (!values.length) return null;
    return new Date(Math.max(...values.map((value) => value.getTime())));
  }

  function sourceRefreshDecision(existing, row, at) {
    const state = String(existing?.state || "").trim().toLowerCase();
    if (["packetized", "provider_accepted", "in_call", "terminal", "review", "delivery_failed"].includes(state)) {
      return { preserve: true, reason: `state-${state}` };
    }
    if (!["eligible", "follow_up_wait", "reserved", "blocked"].includes(state)) {
      return { preserve: true, reason: "state-not-refreshable" };
    }
    const dateKey = getPacificDateKey(at);
    const existingCount = String(existing.dailyAttemptDateKey || "") === dateKey
      ? nonNegativeInteger(existing.dailyAttemptCount ?? 0, "dailyAttemptCount")
      : 0;
    const sourceCount = String(row.dailyAttemptDateKey || "") === dateKey
      ? nonNegativeInteger(row.dailyAttemptCount ?? 0, "source dailyAttemptCount")
      : 0;
    const dailyAttemptCount = Math.max(existingCount, sourceCount);
    const dailyAttempt = canAttemptToday({
      ...existing,
      dailyAttemptDateKey: dateKey,
      dailyAttemptCount,
    }, {
      now: at,
      maxDailyAttempts: maximumDailyAttempts,
      ageBasedDailyCaps: true,
    });
    const lastContactAt = newestProvenDate(existing.lastContactAt, row.lastContactAt, "lastContactAt");
    let nextContactAt = existing.nextContactAt == null || existing.nextContactAt === ""
      ? (row.nextContactAt == null || row.nextContactAt === ""
        ? null
        : parseDate(row.nextContactAt, "nextContactAt"))
      : parseDate(existing.nextContactAt, "nextContactAt");
    if (row.nextContactAt != null && row.nextContactAt !== "") {
      const sourceNext = parseDate(row.nextContactAt, "source nextContactAt");
      const sourceLast = row.lastContactAt == null || row.lastContactAt === ""
        ? null
        : parseDate(row.lastContactAt, "source lastContactAt");
      const existingLast = existing.lastContactAt == null || existing.lastContactAt === ""
        ? null
        : parseDate(existing.lastContactAt, "existing lastContactAt");
      if (!nextContactAt || (sourceLast && (!existingLast || sourceLast.getTime() > existingLast.getTime()))) {
        nextContactAt = sourceNext;
      }
    }
    if (!dailyAttempt.allowed) nextContactAt = null;
    const eligibility = row.eligibility;
    const commonSet = {
      overnightBatchKey: String(row.overnightBatchKey || "").trim() || null,
      overnightOrder: row.overnightOrder == null
        ? null
        : nonNegativeInteger(row.overnightOrder, "overnightOrder"),
      dailyAttemptDateKey: dateKey,
      dailyAttemptCount,
      totalAttemptCount: Math.max(
        nonNegativeInteger(existing.totalAttemptCount ?? 0, "totalAttemptCount"),
        nonNegativeInteger(row.totalAttemptCount ?? 0, "source totalAttemptCount"),
        dailyAttemptCount,
      ),
      lastContactAt,
      nextContactAt,
    };
    if (!eligibility || eligibility.ok !== true || row.callable === false) {
      return {
        preserve: false,
        releaseReservation: state === "reserved",
        reason: eligibility?.reason || "source-eligibility-not-proven",
        set: {
          ...commonSet,
          state: "blocked",
          activeAttempt: false,
          sourcePool: null,
          reservedAgentId: null,
          speedOverrideAgentId: null,
          reservedAt: null,
          reservationExpiresAt: null,
          freshDeadlineAt: null,
          reservationReason: `source-blocked-${String(eligibility?.reason || "unknown").slice(0, 64)}`,
        },
      };
    }
    const classification = classifyPool({
      ...existing,
      ...commonSet,
      state: nextContactAt ? "follow_up_wait" : "eligible",
      callable: row.callable,
    }, {
      now: at,
      currentOvernightBatchKey: overnightBatchKeyAt(at),
      maxDailyAttempts: maximumDailyAttempts,
      ageBasedDailyCaps: true,
      eligibility,
    });
    const deferredFollowUp = classification.reason === "follow-up-not-due" && nextContactAt;
    const targetPool = deferredFollowUp ? POOLS.FOLLOW_UP_DUE : classification.pool;
    if (!targetPool) {
      return { preserve: true, reason: classification.reason, set: commonSet };
    }
    const targetState = targetPool === POOLS.FOLLOW_UP_DUE ? "follow_up_wait" : "eligible";
    const keepFreshReservation = state === "reserved" && targetPool === POOLS.NEW_TODAY;
    return {
      preserve: false,
      releaseReservation: state === "reserved" && !keepFreshReservation,
      reason: deferredFollowUp ? "follow-up-deferred" : classification.reason,
      set: {
        ...commonSet,
        state: keepFreshReservation ? "reserved" : targetState,
        activeAttempt: true,
        sourcePool: targetPool,
        ...(keepFreshReservation ? {} : {
          reservedAgentId: null,
          speedOverrideAgentId: null,
          reservedAt: null,
          reservationExpiresAt: null,
          freshDeadlineAt: null,
          reservationReason: `source-refreshed-${deferredFollowUp ? "follow-up-deferred" : classification.reason}`,
        }),
      },
    };
  }

  async function decrementPendingFresh(agentId) {
    const id = String(agentId || "").trim().toLowerCase();
    if (!id) return null;
    const agent = await repository.getAgentById(id);
    if (!agent || nonNegativeInteger(agent.pendingFreshCount ?? 0, "pendingFreshCount") === 0) return agent;
    return repository.compareAndSetAgent({
      agentId: id,
      expectedVersion: agent.version,
      expected: { pendingFreshCount: { $gte: 1 } },
      increment: { pendingFreshCount: -1 },
    });
  }

  async function holdItemAtDailyCap(item, at) {
    const verdict = canAttemptToday(item, {
      now: at,
      maxDailyAttempts: maximumDailyAttempts,
      ageBasedDailyCaps: true,
    });
    if (verdict.allowed) return { held: false, item, verdict };
    const state = String(item.state || "").trim().toLowerCase();
    const sourcePool = String(item.sourcePool || "").trim().toLowerCase();
    const owner = String(item.reservedAgentId || "").trim().toLowerCase() || null;
    const expected = { state, sourcePool };
    if (state === "reserved") expected.reservedAgentId = owner;
    const held = await repository.compareAndSetItem({
      itemId: stableWorkItemId(item),
      expectedVersion: item.version,
      expected,
      set: {
        state: "follow_up_wait",
        activeAttempt: true,
        sourcePool: POOLS.FOLLOW_UP_DUE,
        nextContactAt: null,
        reservedAgentId: null,
        speedOverrideAgentId: null,
        reservedAt: null,
        reservationExpiresAt: null,
        freshDeadlineAt: null,
        reservationReason: "daily-attempt-limit",
      },
    });
    if (held && state === "reserved" && owner) await decrementPendingFresh(owner);
    return { held: true, item: held, verdict };
  }

  async function refreshExistingSourceItem(existing, row, at) {
    const decision = sourceRefreshDecision(existing, row, at);
    if (decision.preserve && !decision.set) return { status: "preserved", item: existing, reason: decision.reason };
    const owner = String(existing.reservedAgentId || "").trim().toLowerCase();
    const updated = await repository.compareAndSetItem({
      itemId: stableWorkItemId(existing),
      expectedVersion: existing.version,
      expected: { state: existing.state },
      set: decision.set,
    });
    if (!updated) return { status: "conflict", item: null, reason: "source-refresh-conflict" };
    if (decision.releaseReservation && owner) await decrementPendingFresh(owner);
    return { status: updated.state === "blocked" ? "blocked" : "refreshed", item: updated, reason: decision.reason };
  }

  async function runLifecycleHook(hook, eventName, input) {
    if (typeof hook !== "function") return;
    try {
      await hook(input);
    } catch (error) {
      log("warn", `lead_delivery.${eventName}_hook_failed`, {
        reason: String(error?.code || error?.name || "hook-failed").slice(0, 80),
      });
    }
  }

  async function processSourceRows(rows, at) {
    const existingRows = typeof repository.findItemsBySourceIdentities === "function"
      ? await repository.findItemsBySourceIdentities(rows)
      : [];
    const existingBySourceIdentity = new Map((existingRows || []).map((item) => [
      String(item?.sourceIdentity || `${String(item?.domain || "").toUpperCase()}:${String(item?.caseId || "")}`),
      item,
    ]));
    let inserted = 0;
    let skipped = 0;
    let refreshed = 0;
    let blocked = 0;
    for (const row of rows) {
      let classification = classifyPool(row, {
        now: at,
        currentOvernightBatchKey: overnightBatchKeyAt(at),
        maxDailyAttempts: maximumDailyAttempts,
        ageBasedDailyCaps: true,
        eligibility: row.eligibility,
      });
      if (!classification.pool && classification.reason === "follow-up-not-due" && row.nextContactAt) {
        classification = { ...classification, pool: POOLS.FOLLOW_UP_DUE, deferred: true };
      }
      const sourceIdentity = `${String(row?.domain || "").toUpperCase()}:${String(row?.caseId || "")}`;
      const existing = existingBySourceIdentity.get(sourceIdentity) || (
        typeof repository.findItemsBySourceIdentities === "function"
          ? null
          : await repository.findItemBySourceIdentity({ domain: row.domain, caseId: row.caseId })
      );
      if (existing) {
        const result = await refreshExistingSourceItem(existing, row, at);
        if (result.item) {
          await runLifecycleHook(onSourceItemPersisted, "source_item_persisted", {
            row: clone(row), item: clone(result.item), created: false,
          });
        }
        if (result.status === "refreshed") refreshed += 1;
        else if (result.status === "blocked") blocked += 1;
        else skipped += 1;
        continue;
      }
      if (!classification.pool) {
        skipped += 1;
        continue;
      }
      const created = await repository.insertActiveItemOnce(
        sourceItemForInsert(row, classification),
      );
      if (created) {
        inserted += 1;
        await runLifecycleHook(onSourceItemPersisted, "source_item_persisted", {
          row: clone(row), item: clone(created), created: true,
        });
      }
      else {
        const raced = await repository.findItemBySourceIdentity({
          domain: row.domain,
          caseId: row.caseId,
        });
        if (raced) {
          const result = await refreshExistingSourceItem(raced, row, at);
          if (result.item) {
            await runLifecycleHook(onSourceItemPersisted, "source_item_persisted", {
              row: clone(row), item: clone(result.item), created: false,
            });
          }
          if (result.status === "refreshed") refreshed += 1;
          else if (result.status === "blocked") blocked += 1;
          else skipped += 1;
        } else skipped += 1;
      }
    }
    runtimeState.ingested += inserted;
    // Fresh is not packet inventory. Every source pass wakes the independent
    // immediate lane, including an empty pass after agents become active.
    const freshDispatch = await dispatchImmediateFresh();
    return {
      read: rows.length,
      inserted,
      refreshed,
      blocked,
      skipped,
      freshDispatch,
    };
  }

  async function loadDailySourceState(at) {
    const businessDate = getPacificDateKey(at);
    const checkpointKey = `source-repair:${providerName}:${businessDate}`;
    let state = await repository.getSourceRepairCheckpoint(checkpointKey);
    if (!state) {
      await repository.insertSourceRepairCheckpointOnce({
        checkpointKey,
        provider: providerName,
        source: "leadcadence",
        businessDate,
      });
      state = await repository.getSourceRepairCheckpoint(checkpointKey);
    }
    if (!state) throw new Error("lead-delivery source state unavailable after insert");
    return { checkpointKey, state, businessDate };
  }

  async function ingestDurableSourceOnce({ limit, at }) {
    const cap = positiveInteger(limit, "limit");
    const { checkpointKey, state, businessDate } = await loadDailySourceState(at);
    const highWater = state.highWaterCreatedAt && state.highWaterId
      ? { createdAt: state.highWaterCreatedAt, id: state.highWaterId }
      : null;
    const repairCursor = state.repairCursorCreatedAt && state.repairCursorId
      ? { createdAt: state.repairCursorCreatedAt, id: state.repairCursorId }
      : null;
    const useNewArrivalLane = highWater && (
      state.status === "completed"
    );
    const lane = useNewArrivalLane ? "new-arrivals" : "daily-repair";
    const batch = useNewArrivalLane
      ? await source.readNewerBatch({ after: highWater, limit: cap, now: at })
      : await source.readBatch({ cursor: repairCursor, limit: cap, now: at });
    const rows = Array.isArray(batch?.items) ? batch.items : [];
    const outcome = await processSourceRows(rows, at);
    const set = { lastRunAt: at, lastErrorCode: null };
    if (lane === "new-arrivals") {
      if (batch?.nextHighWater) {
        set.highWaterCreatedAt = batch.nextHighWater.createdAt;
        set.highWaterId = batch.nextHighWater.id;
      }
    } else {
      if (batch?.done !== true && !batch?.nextCursor) {
        throw new Error("lead-delivery daily repair returned an incomplete page without a cursor");
      }
      set.status = batch?.done === true ? "completed" : "running";
      set.repairCursorCreatedAt = batch?.done === true ? null : batch?.nextCursor?.createdAt;
      set.repairCursorId = batch?.done === true ? null : batch?.nextCursor?.id;
      if (!highWater && batch?.highWater) {
        set.highWaterCreatedAt = batch.highWater.createdAt;
        set.highWaterId = batch.highWater.id;
      } else if (!highWater && batch?.done === true) {
        // An empty active source still needs a durable boundary; otherwise a
        // completed empty repair would restart on every minute tick. New full
        // leads retain their direct intake path, and this strict lower-bound
        // cursor repairs any later source row without rereading the hot head.
        set.highWaterCreatedAt = at;
        set.highWaterId = "000000000000000000000000";
      }
      if (batch?.done === true) set.completedAt = at;
    }
    const updated = await repository.compareAndSetSourceRepairCheckpoint({
      checkpointKey,
      expectedVersion: state.version,
      set,
      increment: {
        scannedCount: outcome.read,
        admittedCount: outcome.inserted + outcome.refreshed + outcome.blocked,
        skippedCount: outcome.skipped,
      },
    });
    if (!updated) return { status: "source-state-conflict", lane, ...outcome };
    runtimeState.sourceBusinessDate = businessDate;
    runtimeState.sourceRepairStatus = updated.status;
    runtimeState.sourceLane = updated.status === "completed" ? "new-arrivals" : "daily-repair";
    runtimeState.sourceDone = updated.status === "completed";
    runtimeState.sourceCursor = updated.repairCursorCreatedAt && updated.repairCursorId
      ? { createdAt: updated.repairCursorCreatedAt, id: updated.repairCursorId }
      : null;
    return {
      status: "ok",
      lane,
      done: runtimeState.sourceDone,
      // A repair page can legitimately admit zero rows while still advancing
      // past held or terminal source records. Day-start must distinguish that
      // from a source which returned neither work nor a continuation cursor.
      progressed: lane === "daily-repair"
        ? batch?.done === true || Boolean(batch?.nextCursor)
        : Boolean(batch?.nextHighWater),
      ...outcome,
    };
  }

  async function ingestOnce({ limit = sourceLimit } = {}) {
    if (enabled !== true) return { status: "disabled", read: 0, inserted: 0, skipped: 0 };
    if (!source) return { status: "source-unavailable", read: 0, inserted: 0, skipped: 0 };
    const at = atNow();
    if (durableSourceStateEnabled) return ingestDurableSourceOnce({ limit, at });
    const batch = await source.readBatch({
      cursor: runtimeState.sourceCursor,
      limit: positiveInteger(limit, "limit"),
      now: at,
    });
    const rows = Array.isArray(batch?.items) ? batch.items : [];
    const outcome = await processSourceRows(rows, at);
    runtimeState.sourceDone = batch?.done === true;
    runtimeState.sourceCursor = runtimeState.sourceDone
      ? null
      : (batch?.nextCursor ?? runtimeState.sourceCursor);
    return { status: "ok", done: runtimeState.sourceDone, ...outcome };
  }

  async function ingestSerial(options = {}) {
    if (ingestInFlight) return ingestInFlight;
    ingestInFlight = ingestOnce(options).finally(() => {
      ingestInFlight = null;
    });
    return ingestInFlight;
  }

  function launchWatchdogSupplyRefresh() {
    if (watchdogSupplyRefreshInFlight) return { started: false };
    runtimeState.watchdogSupplyRefreshStatus = "running";
    runtimeState.watchdogSupplyRefreshBatches = 0;
    runtimeState.watchdogStatusRefreshRefreshed = 0;
    runtimeState.watchdogStatusRefreshFailed = 0;
    runtimeState.watchdogStatusRefreshReclassified = 0;
    runtimeState.watchdogStatusRefreshReevaluated = 0;
    runtimeState.watchdogStatusRefreshStillBlocked = 0;
    const work = (async () => {
      if (refreshSourceStatuses) {
        const statusRefresh = await refreshSourceStatuses();
        const identities = Array.isArray(statusRefresh?.refreshedIdentities)
          ? statusRefresh.refreshedIdentities.slice(0, 1000)
          : [];
        runtimeState.watchdogStatusRefreshRefreshed = nonNegativeInteger(
          statusRefresh?.refreshed ?? identities.length,
          "statusRefresh.refreshed",
        );
        runtimeState.watchdogStatusRefreshFailed = nonNegativeInteger(
          statusRefresh?.failed ?? 0,
          "statusRefresh.failed",
        );
        for (const identity of identities) {
          const row = await source.readOne({
            domain: identity?.domain,
            caseId: identity?.caseId,
            now: atNow(),
            deliveryIntent: "dial_ready",
            includeLegacyFloor: false,
          });
          if (!row) continue;
          const existing = await repository.findItemBySourceIdentity({
            domain: row.domain,
            caseId: row.caseId,
          });
          if (!existing) continue;
          const result = await refreshExistingSourceItem(existing, row, atNow());
          runtimeState.watchdogStatusRefreshReevaluated += 1;
          if (result.status === "refreshed") {
            runtimeState.watchdogStatusRefreshReclassified += 1;
          } else if (result.status === "blocked") {
            runtimeState.watchdogStatusRefreshStillBlocked += 1;
          }
        }
      }
      for (let batch = 1; batch <= SIMPLE_POOL_SUPPLY_REFRESH_MAX_BATCHES; batch += 1) {
        const ingestion = await ingestSerial();
        runtimeState.watchdogSupplyRefreshBatches = batch;
        if (ingestion?.done === true || Number(ingestion?.read || 0) === 0) break;
      }
      runtimeState.watchdogSupplyRefreshStatus = "completed";
      runtimeState.watchdogSupplyRefreshLastCompletedAt = atNow();
    })().catch((error) => {
      runtimeState.watchdogSupplyRefreshStatus = "failed";
      log("error", "lead_delivery.supply_refresh_failed", {
        count: runtimeState.watchdogSupplyRefreshBatches,
        reason: String(error?.code || error?.name || "supply-refresh-failed").slice(0, 80),
      });
    }).finally(() => {
      if (watchdogSupplyRefreshInFlight === work) watchdogSupplyRefreshInFlight = null;
    });
    watchdogSupplyRefreshInFlight = work;
    return { started: true };
  }

  async function listFreshWorkCandidates() {
    return repository.listImmediateFreshItems({ limit: 5000 });
  }

  async function freshEligibleAgents(at, { prepositionAgentId = null } = {}) {
    const prepositionId = String(prepositionAgentId || "").trim().toLowerCase();
    const persisted = await repository.listAgents({ enabledOnly: true });
    return persisted
      .map((agent) => mergedAgent(agent, agentPolicy(agent.agentId)))
      .filter(Boolean)
      .filter((agent) => !prepositionId || agent.agentId === prepositionId)
      .map((agent) => (prepositionId ? {
        ...agent,
        shiftEnabled: true,
        activeUntil: new Date(at.getTime() + 1),
      } : agent))
      .filter((agent) => evaluateFreshAgentEligibility(agent, {
        now: at,
        freshReservationRange: prepositionId
          ? configuration.defaults.providerBufferTarget
          : configuration.defaults.freshReservationRange,
        maxPendingFreshReservations: configuration.defaults.maxPendingFreshReservations,
      }).eligible);
  }

  async function immediateFreshAgents(at) {
    const persisted = await repository.listAgents({ enabledOnly: true });
    return persisted
      .filter((agent) => canMutateAgentPool({
        agent,
        operationKind: "immediate_fresh",
        now: at,
      }).allowed)
      .map((agent) => mergedAgent(agent, agentPolicy(agent.agentId)))
      .filter(Boolean)
      .filter((agent) => agent.operatorPaused !== true)
      .filter((agent) => {
        let evidenceAt;
        try {
          evidenceAt = parseDate(agent.lastProviderEvidenceAt, "lastProviderEvidenceAt", { nullable: true });
        } catch {
          return false;
        }
        if (!evidenceAt) return false;
        let evidenceMinutes;
        try {
          evidenceMinutes = positiveInteger(
            agent.activeEvidenceMinutes || configuration.defaults.activeEvidenceMinutes,
            "activeEvidenceMinutes",
          );
        } catch {
          return false;
        }
        if (evidenceAt.getTime() + evidenceMinutes * 60_000 <= at.getTime()) return false;
        try {
          return evaluateFreshAgentEligibility(agent, { now: at }).eligible;
        } catch {
          return false;
        }
      });
  }

  async function releaseFreshReservation(item, reason) {
    const owner = String(item.reservedAgentId || "").trim().toLowerCase();
    const released = await repository.compareAndSetItem({
      itemId: stableWorkItemId(item),
      expectedVersion: item.version,
      expected: {
        state: "reserved",
        reservedAgentId: owner || null,
        reservationExpiresAt: item.reservationExpiresAt,
      },
      set: {
        state: "eligible",
        activeAttempt: true,
        reservedAgentId: null,
        speedOverrideAgentId: null,
        reservedAt: null,
        reservationExpiresAt: null,
        reservationReason: reason,
      },
    });
    if (released && owner) await decrementPendingFresh(owner);
    return released;
  }

  async function finalizeFreshReservation(item, agent, at) {
    let currentAgent = agent;
    const reservedAt = parseDate(item.reservedAt, "reservedAt");
    const alreadyCounted = currentAgent.lastFreshReservedAt
      && parseDate(currentAgent.lastFreshReservedAt, "lastFreshReservedAt").getTime() === reservedAt.getTime()
      && nonNegativeInteger(currentAgent.pendingFreshCount ?? 0, "pendingFreshCount") > 0;
    if (!alreadyCounted) {
      const patch = buildFreshReservationPatch(currentAgent, { now: at });
      currentAgent = await repository.compareAndSetAgent({
        agentId: currentAgent.agentId,
        expectedVersion: currentAgent.version,
        set: patch,
      });
      if (!currentAgent) {
        await releaseFreshReservation(item, "fresh-agent-cas-conflict");
        return null;
      }
    }
    const finalized = await repository.compareAndSetItem({
      itemId: stableWorkItemId(item),
      expectedVersion: item.version,
      expected: {
        state: "reserved",
        reservedAgentId: currentAgent.agentId,
        reservationReason: "fresh-fairness-pending",
      },
      set: { reservationReason: "fresh-fairness" },
    });
    if (finalized) {
      log("info", "lead_delivery.fresh_reserved", {
        agentId: currentAgent.agentId,
        count: 1,
        reason: "least-served",
      });
    }
    return finalized;
  }

  async function reserveFreshForAgent(item, agent, at, { allowBacklog = false } = {}) {
    let lease = calculateFreshLease({
      receivedAt: item.receivedAt,
      reservedAt: at,
      leaseMinutes: configuration.defaults.freshReservationMinutes,
    });
    if (!lease.canProtect) {
      if (!allowBacklog) return null;
      const reservationExpiresAt = new Date(
        at.getTime() + configuration.defaults.freshReservationMinutes * 60_000,
      );
      lease = {
        canProtect: true,
        freshDeadlineAt: reservationExpiresAt,
        reservationExpiresAt,
      };
    }
    const pending = await repository.compareAndSetItem({
      itemId: stableWorkItemId(item),
      expectedVersion: item.version,
      expected: { state: "eligible", sourcePool: POOLS.NEW_TODAY, reservedAgentId: null },
      set: {
        state: "reserved",
        activeAttempt: true,
        reservedAgentId: agent.agentId,
        speedOverrideAgentId: null,
        reservedAt: at,
        reservationExpiresAt: lease.reservationExpiresAt,
        freshDeadlineAt: lease.freshDeadlineAt,
        reservationReason: "fresh-fairness-pending",
      },
    });
    if (!pending) return null;
    return finalizeFreshReservation(pending, agent, at);
  }

  async function reserveExpiredFreshForRequester(item, requester, at) {
    if (!requester) return null;
    const deadline = new Date(parseDate(item.receivedAt, "receivedAt").getTime() + 15 * 60_000);
    if (deadline.getTime() > at.getTime()) return null;
    return repository.compareAndSetItem({
      itemId: stableWorkItemId(item),
      expectedVersion: item.version,
      expected: { state: "eligible", sourcePool: POOLS.NEW_TODAY, reservedAgentId: null },
      set: {
        state: "reserved",
        activeAttempt: true,
        reservedAgentId: null,
        speedOverrideAgentId: requester.agentId,
        reservedAt: at,
        reservationExpiresAt: new Date(at.getTime() + Math.min(60_000, postLeaseDuration)),
        freshDeadlineAt: deadline,
        reservationReason: "fresh-deadline-speed-override",
      },
    });
  }

  async function repairPendingFreshCounts(candidates) {
    const counts = new Map();
    for (const item of candidates) {
      if (String(item.state || "") !== "reserved") continue;
      if (String(item.reservationReason || "") !== "fresh-fairness") continue;
      const owner = String(item.reservedAgentId || "").trim().toLowerCase();
      if (!owner) continue;
      counts.set(owner, (counts.get(owner) || 0) + 1);
    }
    for (const agentId of Object.keys(configuration.agents).sort()) {
      const agent = await repository.getAgentById(agentId);
      if (!agent) continue;
      const actual = counts.get(agentId) || 0;
      if (nonNegativeInteger(agent.pendingFreshCount ?? 0, "pendingFreshCount") === actual) continue;
      await repository.compareAndSetAgent({
        agentId,
        expectedVersion: agent.version,
        set: { pendingFreshCount: actual },
      });
    }
  }

  async function reserveFreshWork({
    at = atNow(),
    requestingAgentId = null,
    prepositionAgentId = null,
  } = {}) {
    const reservationAt = parseDate(at, "at");
    let candidates = await listFreshWorkCandidates();
    await repairPendingFreshCounts(candidates);
    const requestId = String(requestingAgentId || "").trim().toLowerCase();
    let eligibleAgents = await freshEligibleAgents(reservationAt, { prepositionAgentId });
    let reserved = 0;
    let released = 0;
    let overridden = 0;
    let reservationSequence = 0;

    for (let candidate of candidates) {
      if (String(candidate.state || "") !== "reserved") continue;
      const expiry = candidate.reservationExpiresAt
        ? parseDate(candidate.reservationExpiresAt, "reservationExpiresAt")
        : new Date(0);
      if (expiry.getTime() <= reservationAt.getTime()) {
        const fresh = await releaseFreshReservation(candidate, "fresh-reservation-expired");
        if (!fresh) continue;
        released += 1;
        continue;
      }
      if (String(candidate.reservationReason || "") === "fresh-fairness-pending") {
        const ownerId = String(candidate.reservedAgentId || "").trim().toLowerCase();
        const owner = await repository.getAgentById(ownerId);
        const merged = mergedAgent(owner, agentPolicy(ownerId));
        if (merged && await finalizeFreshReservation(candidate, merged, reservationAt)) reserved += 1;
      }
    }

    candidates = await listFreshWorkCandidates();
    for (const candidate of candidates) {
      if (String(candidate.state || "") !== "eligible") continue;
      const candidateReservationAt = new Date(reservationAt.getTime() + reservationSequence);
      reservationSequence += 1;
      const deadline = new Date(parseDate(candidate.receivedAt, "receivedAt").getTime() + 15 * 60_000);
      eligibleAgents = await freshEligibleAgents(candidateReservationAt, { prepositionAgentId });
      const requester = eligibleAgents.find((agent) => agent.agentId === requestId) || null;
      let selectedAgent = null;
      let requesterClaim = false;
      if (deadline.getTime() <= candidateReservationAt.getTime() && requester) {
        // Once the original fair hold expires, the active agent asking for a
        // packet owns this attempt through the same ordinary reservation shape.
        // No speed-override identity or second packet path is involved.
        selectedAgent = requester;
        requesterClaim = true;
      } else {
        const fairPick = await claimFairAgent(
          "fresh",
          eligibleAgents.map((agent) => agent.agentId),
        );
        if (fairPick.status !== "picked") break;
        selectedAgent = eligibleAgents.find((agent) => agent.agentId === fairPick.agentId);
      }
      if (!selectedAgent) break;
      if (await reserveFreshForAgent(candidate, selectedAgent, candidateReservationAt, {
        allowBacklog: deadline.getTime() <= candidateReservationAt.getTime(),
      })) {
        reserved += 1;
        if (requesterClaim) overridden += 1;
      }
    }
    return { reserved, released, overridden };
  }

  function candidateGroups(items, agentId, at) {
    const poolsByName = Object.fromEntries(POOL_VALUES.map((pool) => [pool, []]));
    const reservedFreshItems = [];
    const forcedExpiredFreshItems = [];
    for (const item of items) {
      let attempt;
      try {
        attempt = canAttemptToday(item, {
          now: at,
          maxDailyAttempts: maximumDailyAttempts,
          ageBasedDailyCaps: true,
        });
      } catch {
        continue;
      }
      if (!attempt.allowed) continue;
      if (String(item.state || "") === "follow_up_wait") {
        let dueAt;
        try {
          dueAt = parseDate(item.nextContactAt, "nextContactAt");
        } catch {
          continue;
        }
        if (dueAt.getTime() > at.getTime()) continue;
      }
      if (POOL_VALUES.includes(item.sourcePool)) poolsByName[item.sourcePool].push(item);
      if (item.sourcePool !== POOLS.NEW_TODAY || String(item.state || "") !== "reserved") continue;
      if (String(item.reservedAgentId || "").trim().toLowerCase() === agentId) {
        reservedFreshItems.push(item);
      }
      if (String(item.speedOverrideAgentId || "").trim().toLowerCase() === agentId) {
        forcedExpiredFreshItems.push(item);
      }
    }
    for (const pool of POOL_VALUES) poolsByName[pool] = orderPoolItems(pool, poolsByName[pool]);
    reservedFreshItems.splice(
      0,
      reservedFreshItems.length,
      ...orderPoolItems(POOLS.NEW_TODAY, reservedFreshItems),
    );
    return { poolsByName, reservedFreshItems, forcedExpiredFreshItems };
  }

  async function previewAgent(agentId, { neededOverride = null } = {}) {
    const id = String(agentId || "").trim().toLowerCase();
    const policy = agentPolicy(id);
    if (!policy) return { status: "unknown-agent", agentId: id, needed: 0, recipe: null };
    const persisted = await repository.getAgentById(id);
    if (!persisted) return { status: "agent-state-missing", agentId: id, needed: 0, recipe: null };
    const agent = mergedAgent(persisted, policy);
    const deliveryItems = providerInventoryAuthoritative === true
      ? await listPendingProviderPosts(id)
      : await repository.listAgentDeliveryItems(id);
    const projection = providerInventoryAuthoritative === true
      ? {
        reliable: true,
        estimatedOutstanding: nonNegativeInteger(
          persisted.estimatedOutstanding ?? 0,
          "estimatedOutstanding",
        ),
        anomalies: [],
      }
      : reconstructAgentProjection(deliveryItems, { agentId: id });
    const acceptedInFlight = providerInventoryAuthoritative === true
      ? deliveryItems.length
      : deliveryItems.filter((item) => (
        String(item.state || "") === "packetized"
        && !String(item.providerContactId || "").trim()
      )).length;
    const forcedNeeded = neededOverride == null
      ? null
      : nonNegativeInteger(neededOverride, "neededOverride");
    const needed = projection.reliable
      ? forcedNeeded ?? calculatePacketDeficit({
        providerBufferTarget: policy.providerBufferTarget,
        currentOutstanding: projection.estimatedOutstanding,
        acceptedInFlight,
      })
      : 0;
    const candidates = needed > 0
      ? (await Promise.all(policy.subscribedPools.map((pool) => (
        repository.listPacketCandidateItems({
          agentId: id,
          sourcePools: [pool],
          now: atNow(),
          limit: Math.max(25, needed * 4),
        })
      )))).flat()
      : [];
    const previewAt = atNow();
    const blockAgedForOvernightFirstContact = needed > 0
      ? await repository.hasUnconsumedOvernightFirstContact()
      : false;
    const grouped = candidateGroups(candidates, id, previewAt);
    const recipe = composePacketRecipe({
      agentId: id,
      now: previewAt,
      needed,
      ...grouped,
      subscribedPools: policy.subscribedPools,
      packetAllowances: policy.packetAllowances,
      packetPoolOrder,
      blockAgedForOvernightFirstContact,
    });
    return {
      status: projection.reliable ? "preview" : "projection-unreliable",
      agentId: id,
      enabled: agent.enabled === true,
      shiftEnabled: agent.shiftEnabled === true,
      currentOutstanding: projection.estimatedOutstanding,
      acceptedInFlight,
      needed,
      recipe,
      anomalies: projection.anomalies,
    };
  }

  async function claimPacketSelection(
    agentId,
    selection,
    packetId,
    claimedAt,
    {
      preposition = false,
      requireSourceActive = false,
      receivedFrom = null,
      receivedBefore = null,
    } = {},
  ) {
    const item = selection.item;
    const currentSource = await source.readOne({
      domain: item.domain,
      caseId: item.caseId,
      now: claimedAt,
      deliveryIntent: preposition === true ? "preposition" : "dial_ready",
    });
    if (!currentSource) return null;
    if (requireSourceActive === true && currentSource.sourceActive !== true) return null;
    if (receivedFrom != null || receivedBefore != null) {
      if (receivedFrom == null || receivedBefore == null) return null;
      let currentReceipt;
      try {
        currentReceipt = parseDate(currentSource.receivedAt, "receivedAt");
      } catch {
        return null;
      }
      const from = parseDate(receivedFrom, "receivedFrom");
      const before = parseDate(receivedBefore, "receivedBefore");
      if (currentReceipt.getTime() < from.getTime() || currentReceipt.getTime() >= before.getTime()) return null;
    }
    if (String(currentSource.domain || "").trim().toUpperCase() !== String(item.domain || "").trim().toUpperCase()
      || String(currentSource.caseId ?? "").trim() !== String(item.caseId ?? "").trim()
      || String(currentSource.normalizedPhone || "").trim() !== String(item.normalizedPhone || "").trim()) {
      return null;
    }
    const claimDateKey = getPacificDateKey(claimedAt);
    const canonicalCount = String(item.dailyAttemptDateKey || "") === claimDateKey
      ? nonNegativeInteger(item.dailyAttemptCount ?? 0, "dailyAttemptCount")
      : 0;
    const sourceFloor = String(currentSource.dailyAttemptDateKey || "") === claimDateKey
      ? nonNegativeInteger(currentSource.dailyAttemptCount ?? 0, "source dailyAttemptCount")
      : 0;
    const canonicalLastContact = item.lastContactAt == null || item.lastContactAt === ""
      ? null
      : parseDate(item.lastContactAt, "lastContactAt");
    const sourceLastContact = currentSource.lastContactAt == null || currentSource.lastContactAt === ""
      ? null
      : parseDate(currentSource.lastContactAt, "source lastContactAt");
    const mergedLastContact = newestProvenDate(
      canonicalLastContact,
      sourceLastContact,
      "lastContactAt",
    );
    let mergedNextContact = item.nextContactAt == null || item.nextContactAt === ""
      ? null
      : parseDate(item.nextContactAt, "nextContactAt");
    if (currentSource.nextContactAt != null && currentSource.nextContactAt !== ""
      && sourceLastContact
      && (!canonicalLastContact || sourceLastContact.getTime() > canonicalLastContact.getTime())) {
      mergedNextContact = parseDate(currentSource.nextContactAt, "source nextContactAt");
    }
    const mergedDailyCount = Math.max(canonicalCount, sourceFloor);
    const mergedTotalCount = Math.max(
      nonNegativeInteger(item.totalAttemptCount ?? 0, "totalAttemptCount"),
      nonNegativeInteger(currentSource.totalAttemptCount ?? 0, "source totalAttemptCount"),
      mergedDailyCount,
    );
    const currentClassification = classifyPool({
      ...item,
      state: mergedNextContact ? "follow_up_wait" : "eligible",
      dailyAttemptDateKey: claimDateKey,
      dailyAttemptCount: mergedDailyCount,
      totalAttemptCount: mergedTotalCount,
      lastContactAt: mergedLastContact,
      nextContactAt: mergedNextContact,
      callable: currentSource.callable,
    }, {
      now: claimedAt,
      currentOvernightBatchKey: overnightBatchKeyAt(claimedAt),
      maxDailyAttempts: maximumDailyAttempts,
      ageBasedDailyCaps: true,
      eligibility: currentSource.eligibility,
    });
    if (!currentClassification.pool || currentClassification.pool !== selection.pool) {
      await refreshExistingSourceItem(item, currentSource, claimedAt);
      return null;
    }
    const state = String(item.state || "").trim();
    const expected = { state, sourcePool: selection.pool };
    if (state === "reserved") {
      if (selection.selectionType === "expired-fresh-speed-override") {
        expected.speedOverrideAgentId = agentId;
      } else {
        expected.reservedAgentId = agentId;
      }
    }
    const claimed = await repository.compareAndSetItem({
      itemId: stableWorkItemId(item),
      expectedVersion: item.version,
      expected,
      set: {
        state: "packetized",
        activeAttempt: true,
        packetId,
        deliveryAgentId: agentId,
        reservedAgentId: null,
        speedOverrideAgentId: null,
        reservedAt: null,
        reservationExpiresAt: null,
        reservationReason: `packet-${selection.selectionType}`,
        provider: providerName,
        dailyAttemptDateKey: claimDateKey,
        dailyAttemptCount: mergedDailyCount,
        totalAttemptCount: mergedTotalCount,
        lastContactAt: mergedLastContact,
        nextContactAt: mergedNextContact,
      },
    });
    if (claimed && selection.selectionType === "protected-fresh") {
      await decrementPendingFresh(agentId);
    }
    return claimed;
  }

  function providerContactInput(item, policy, preparation, reconcileBeforePost) {
    const input = {
      folderId: policy.providerConfig.distributionFolderId,
      reconciliationFolderIds: [
        policy.providerConfig.distributionFolderId,
        policy.providerConfig.receivingFolderId,
      ],
      externalLeadId: preparation.providerExternalLeadId,
      phone: String(item.normalizedPhone || "").trim(),
      firstName: String(item.metadata?.firstName || "").trim() || undefined,
      lastName: String(item.metadata?.lastName || "").trim() || undefined,
      customFields: [
        { name: "Logics Database", type: 1, value: String(item.domain || "").trim().toUpperCase() },
        { name: "Case ID", type: 1, value: String(item.caseId || "").trim() },
      ],
      reconcileBeforePost,
    };
    if (policy.providerConfig.ownerId) input.ownerId = policy.providerConfig.ownerId;
    if (policy.providerConfig.ownerUsername) input.ownerUsername = policy.providerConfig.ownerUsername;
    return input;
  }

  async function recirculateCompletedProviderContact(item, policy) {
    const contactId = String(item.providerContactId || "").trim();
    const externalLeadId = String(item.providerExternalLeadId || "").trim();
    if (!contactId || !externalLeadId || !item.providerCompletedAt) return null;
    if (typeof phoneBurner?.getContact !== "function" || typeof phoneBurner?.moveContact !== "function") {
      return { status: "provider-recirculation-unavailable", accepted: false };
    }
    const targetFolderId = String(policy.providerConfig.distributionFolderId || "").trim();
    const read = await phoneBurner.getContact(contactId);
    if (!read?.ok || String(read.contact?.contactId || "").trim() !== contactId) {
      return { status: "provider-recirculation-read-failed", accepted: false };
    }
    if (String(read.contact.folderId || "").trim() !== targetFolderId) {
      const moved = await phoneBurner.moveContact(contactId, targetFolderId);
      if (!moved?.ok || String(moved.contactId || "").trim() !== contactId) {
        return { status: "provider-recirculation-move-failed", accepted: false };
      }
    }
    const acceptedAt = atNow();
    const attemptNumber = positiveInteger(item.providerAttemptSequence, "providerAttemptSequence") + 1;
    const acceptedItem = await repository.compareAndSetItem({
      itemId: stableWorkItemId(item),
      expectedVersion: item.version,
      expected: {
        state: "packetized",
        providerContactId: contactId,
        providerExternalLeadId: externalLeadId,
        providerCompletedAt: item.providerCompletedAt,
      },
      set: {
        state: "provider_accepted",
        activeAttempt: true,
        providerAcceptedAt: acceptedAt,
        providerCompletedAt: null,
        providerCallId: null,
        providerAttemptSequence: attemptNumber,
        providerPostState: "accepted",
        providerPostLeaseId: null,
        providerPostLeaseExpiresAt: null,
      },
      append: {
        providerAttemptHistory: [{
          attemptNumber,
          event: "recirculated",
          provider: providerName,
          providerExternalLeadId: externalLeadId,
          providerContactId: contactId,
          providerCallId: null,
          deliveryAgentId: String(item.deliveryAgentId || "").trim().toLowerCase() || null,
          packetId: String(item.packetId || "").trim() || null,
          occurredAt: acceptedAt,
          outcome: null,
          reason: "backend-timer-due",
        }],
      },
    });
    if (!acceptedItem) return { status: "provider-recirculation-commit-conflict", accepted: false };
    const freshAgent = await repository.getAgentById(policy.agentId);
    if (freshAgent) {
      await repository.compareAndSetAgent({
        agentId: policy.agentId,
        expectedVersion: freshAgent.version,
        increment: { providerAcceptedCount: 1, estimatedOutstanding: 1 },
        set: { lastPacketAt: acceptedAt },
      });
    }
    runtimeState.accepted += 1;
    return { status: "recirculated", accepted: true, item: acceptedItem };
  }

  async function postPacketItemInsideLane(item, policy, { allowClosedWindow = false } = {}) {
    const preparedAt = atNow();
    if (allowClosedWindow !== true && deliveryWindowOpen(preparedAt) !== true) {
      return { status: "delivery-window-closed", accepted: false };
    }
    let current = await repository.getItemById(stableWorkItemId(item));
    if (!current || String(current.state || "").trim().toLowerCase() !== "packetized") {
      return { status: "provider-item-no-longer-packetized", accepted: false };
    }
    // The former exact-contact recirculation path remains available for
    // deletion after floor proof, but is intentionally dark. One provider
    // contact now represents one physical attempt; a due follow-up receives a
    // fresh provider identity and contact from the canonical backend item.
    let preparation = buildProviderAttemptPreparation(current, { now: preparedAt, provider: providerName });
    if (preparation.mutation) {
      current = await repository.compareAndSetItem({
        itemId: stableWorkItemId(current),
        expectedVersion: current.version,
        expected: { state: "packetized" },
        ...preparation.mutation,
      });
      if (!current) return { status: "prepare-conflict", accepted: false };
      preparation = buildProviderAttemptPreparation(current, { now: preparedAt, provider: providerName });
    }
    if (allowClosedWindow !== true && deliveryWindowOpen(atNow()) !== true) {
      return { status: "delivery-window-closed", accepted: false };
    }
    const leaseId = randomUUID();
    const lease = buildProviderPostLease(current, {
      now: atNow(),
      leaseId,
      leaseMs: postLeaseDuration,
    });
    if (!lease.acquired) return { status: lease.reason, accepted: false };
    current = await repository.compareAndSetItem({
      itemId: stableWorkItemId(current),
      expectedVersion: current.version,
      expected: lease.expected,
      ...lease.mutation,
    });
    if (!current) return { status: "post-lease-conflict", accepted: false };

    if (allowClosedWindow !== true && deliveryWindowOpen(atNow()) !== true) {
      await repository.compareAndSetItem({
        itemId: stableWorkItemId(current),
        expectedVersion: current.version,
        expected: { state: "packetized", providerPostLeaseId: leaseId },
        set: {
          providerPostState: "prepared",
          providerPostLeaseId: null,
          providerPostLeaseExpiresAt: null,
        },
      });
      return { status: "delivery-window-closed", accepted: false };
    }

    let result;
    try {
      result = await phoneBurner.createContact(providerContactInput(
        current,
        policy,
        preparation,
        lease.reconcileBeforePost || preparation.requiresReconciliation,
      ));
    } catch {
      result = { ok: false, status: "acceptance_unknown", reason: "transport-error" };
    }
    if (result?.ok === true && String(result.contactId || "").trim()) {
      const acceptedAt = atNow();
      const transition = buildProviderAcceptanceTransition(current, {
        providerContactId: result.contactId,
        acceptedAt,
        providerPostLeaseId: leaseId,
      });
      const acceptedItem = await repository.compareAndSetItem({
        itemId: stableWorkItemId(current),
        expectedVersion: current.version,
        expected: {
          state: "packetized",
          providerPostState: "posting",
          providerPostLeaseId: leaseId,
        },
        ...transition,
      });
      if (!acceptedItem) return { status: "acceptance-commit-conflict", accepted: false };
      await runLifecycleHook(onProviderAccepted, "provider_accepted", {
        item: clone(acceptedItem), acceptedAt,
      });
      const freshAgent = await repository.getAgentById(policy.agentId);
      if (freshAgent) {
        await repository.compareAndSetAgent({
          agentId: policy.agentId,
          expectedVersion: freshAgent.version,
          increment: { providerAcceptedCount: 1, estimatedOutstanding: 1 },
          set: { lastPacketAt: acceptedAt },
        });
      }
      runtimeState.accepted += 1;
      return { status: "accepted", accepted: true, item: acceptedItem };
    }
    const resultStatus = String(result?.status || "").trim().toLowerCase();
    const ambiguous = resultStatus === "acceptance_unknown";
    const rateLimited = resultStatus === "rate_limited";
    const failure = buildProviderDeliveryFailureTransition(current, {
      failedAt: atNow(),
      reason: result?.reason || result?.status || "provider-rejected",
      providerPostLeaseId: leaseId,
      ambiguous,
      retryable: rateLimited,
    });
    await repository.compareAndSetItem({
      itemId: stableWorkItemId(current),
      expectedVersion: current.version,
      expected: { state: "packetized", providerPostLeaseId: leaseId },
      ...failure,
    });
    if (rateLimited) {
      return {
        status: "rate-limited",
        accepted: false,
        ...(Number.isFinite(Number(result?.retryAfterMs)) ? { retryAfterMs: Number(result.retryAfterMs) } : {}),
      };
    }
    return { status: ambiguous ? "acceptance-unknown" : "provider-rejected", accepted: false };
  }

  function postPacketItem(item, policy, options = {}) {
    return runProviderPostTurn(() => postPacketItemInsideLane(item, policy, options));
  }

  async function recordAcceptedFreshTurn(agentId, at) {
    const id = String(agentId || "").trim().toLowerCase();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const agent = await repository.getAgentById(id);
      if (!agent) return null;
      const normalized = normalizeAgentFairnessHour(agent, { now: at });
      const updated = await repository.compareAndSetAgent({
        agentId: id,
        expectedVersion: agent.version,
        set: {
          fairnessHourKey: normalized.fairnessHourKey,
          fairnessTieBreaker: normalized.fairnessTieBreaker,
          freshReservedThisHour: normalized.freshReservedThisHour + 1,
          lastFreshReservedAt: at,
        },
      });
      if (updated) return updated;
    }
    return null;
  }

  async function pendingImmediateFreshPosts() {
    const rows = [];
    for (const agentId of fairAgentOrder()) {
      for (const item of await listPendingProviderPosts(agentId)) {
        if (String(item.sourcePool || "").trim().toLowerCase() !== POOLS.NEW_TODAY) continue;
        if (String(item.reservationReason || "").trim().toLowerCase() !== "immediate-fresh") continue;
        rows.push(item);
      }
    }
    return orderPoolItems(POOLS.NEW_TODAY, rows);
  }

    async function runImmediateFreshDispatch() {
    const startedAt = atNow();
    runtimeState.freshDispatchAttempts += 1;
    runtimeState.freshDispatchLastAt = startedAt;
    if (enabled !== true) return { status: "disabled", accepted: 0 };
    if (actionsEnabled !== true) return { status: "actions-disabled", accepted: 0 };
    if (deliveryWindowOpen(startedAt) !== true) return { status: "delivery-window-closed", accepted: 0 };

    let accepted = 0;
    while (providerPostAccepting) {
      const pending = await pendingImmediateFreshPosts();
      let item = pending[0] || null;
      let pick;
      if (item) {
        const owner = String(item.deliveryAgentId || "").trim().toLowerCase();
        if (!owner) return { status: "pending-owner-missing", accepted };
        pick = await readNextFairAgent("fresh", [owner]);
      } else {
        const candidates = await listFreshWorkCandidates();
        item = candidates[0] || null;
        if (!item) return { status: accepted > 0 ? "posted" : "queue-empty", accepted };
        const agents = await immediateFreshAgents(atNow());
        pick = await readNextFairAgent("fresh", agents.map((agent) => agent.agentId));
        if (pick.status !== "picked") {
          return { status: accepted > 0 ? "posted-partial-no-active-agent" : "no-active-agent", accepted };
        }
      }
      const result = await withAgentPoolOperation(pick.agentId, "immediate_fresh", async () => {
        let current = await repository.getItemById(stableWorkItemId(item));
        if (!current) return { status: "fresh-item-missing", accepted: false };
        const dailyCap = await holdItemAtDailyCap(current, atNow());
        if (dailyCap.held) return { status: "daily-cap-held", accepted: false, held: true };
        const currentState = String(current.state || "").trim().toLowerCase();
        const pendingForOwner = currentState === "packetized"
          && String(current.reservationReason || "").trim().toLowerCase() === "immediate-fresh"
          && String(current.deliveryAgentId || "").trim().toLowerCase() === pick.agentId;
        if (!pendingForOwner) {
          const priorOwner = String(current.reservedAgentId || "").trim().toLowerCase() || null;
          if (!["eligible", "reserved"].includes(currentState)) {
            return { status: "fresh-claim-conflict", accepted: false };
          }
          const expected = { state: currentState, sourcePool: POOLS.NEW_TODAY };
          if (currentState === "reserved") expected.reservedAgentId = priorOwner;
          else expected.reservedAgentId = null;
          const receivedAt = parseDate(current.receivedAt, "receivedAt");
          current = await repository.compareAndSetItem({
            itemId: stableWorkItemId(current),
            expectedVersion: current.version,
            expected,
            set: {
              state: "packetized",
              activeAttempt: true,
              packetId: `fresh-${randomUUID()}`,
              deliveryAgentId: pick.agentId,
              reservedAgentId: null,
              speedOverrideAgentId: null,
              reservedAt: null,
              reservationExpiresAt: null,
              freshDeadlineAt: new Date(receivedAt.getTime() + 15 * 60_000),
              reservationReason: "immediate-fresh",
              provider: providerName,
            },
          });
          if (!current) return { status: "fresh-claim-conflict", accepted: false };
          if (currentState === "reserved" && priorOwner) await decrementPendingFresh(priorOwner);
        }
        const policy = agentPolicy(pick.agentId);
        if (!policy?.enabled) return { status: "selected-agent-disabled", accepted: false };
        return postPacketItem(current, policy);
      });
      if (result?.held === true || result?.status === "fresh-claim-conflict") continue;
      if (result?.accepted !== true) {
        return { status: String(result?.status || "provider-rejected"), accepted };
      }
      const committed = await commitAcceptedFairAgent("fresh", pick);
      if (!committed) {
        log("error", "lead_delivery.fresh_cursor_commit_failed", {
          agentId: pick.agentId,
          reason: "accepted-cursor-conflict",
        });
        return { status: "accepted-cursor-conflict", accepted: accepted + 1 };
      }
      await recordAcceptedFreshTurn(pick.agentId, atNow());
      accepted += 1;
      runtimeState.freshDispatchAccepted += 1;
      log("info", "lead_delivery.fresh_posted", { agentId: pick.agentId, count: 1 });
    }
    return { status: "provider-lane-stopped", accepted };
  }

  function dispatchImmediateFresh() {
    if (freshDispatchInFlight) return freshDispatchInFlight;
    const work = runImmediateFreshDispatch()
      .then((result) => {
        runtimeState.freshDispatchLastStatus = String(result?.status || "unknown");
        return result;
      })
      .catch((error) => {
        runtimeState.freshDispatchLastStatus = String(error?.code || error?.name || "fresh-dispatch-failed");
        log("error", "lead_delivery.fresh_dispatch_failed", {
          reason: runtimeState.freshDispatchLastStatus,
        });
        throw error;
      })
      .finally(() => {
        if (freshDispatchInFlight === work) freshDispatchInFlight = null;
      });
    freshDispatchInFlight = work;
    return work;
  }

  function wakeImmediateFresh() {
    // Call End owns activity evidence, not provider latency. Signal the one
    // fresh worker and let the webhook finish after its durable event work.
    // dispatchImmediateFresh is already single-flight, so repeated Call Ends
    // coalesce without creating a second allocator or provider writer.
    void Promise.resolve()
      .then(() => dispatchImmediateFresh())
      .catch(() => {});
    return { status: "scheduled", accepted: 0 };
  }

  async function fillAgent(agentId, {
    explicit = false,
    preposition = false,
    reason = "seed",
    onWorkDurable = null,
    recoverOnly = false,
    requestedCount = null,
  } = {}) {
    const id = String(agentId || "").trim().toLowerCase();
    if (legacyOperatorSurfaceEnabled !== true) return legacyOperatorDisabled(id);
    if (enabled !== true) return { status: "disabled", agentId: id, accepted: 0 };
    if (actionsEnabled !== true) return { status: "actions-disabled", agentId: id, accepted: 0 };
    if (preposition !== true && deliveryWindowOpen(atNow()) !== true) {
      return { status: "delivery-window-closed", agentId: id, accepted: 0 };
    }
    const policy = agentPolicy(id);
    if (!policy) return { status: "unknown-agent", agentId: id, accepted: 0 };
    // Prior-day tombstone release belongs to the guarded startup/day-boundary
    // tick. Repeating that historical scan on every Call End made an empty
    // agent wait behind unrelated cleanup before a refill could even claim.
    if (reason !== "call-end-pulse") {
      await releasePriorDayWorkingFolderDrains(id, atNow());
    }
    const persisted = await repository.getAgentById(id);
    const agent = mergedAgent(persisted, policy);
    if (!agent || agent.enabled !== true) return { status: "agent-disabled", agentId: id, accepted: 0 };
    const closeMarker = agent.metadata?.[END_OF_DAY_DRAIN_METADATA_KEY];
    const postClosePreposition = preposition === true
      && closeMarker?.status === "completed"
      && closeMarker?.dateKey === getPacificDateKey(atNow());
    if (agent.operatorPaused === true && postClosePreposition !== true) {
      return { status: "operator-paused", agentId: id, accepted: 0 };
    }
    if (!explicit && recoverOnly !== true) {
      const activeUntil = agent.activeUntil ? parseDate(agent.activeUntil, "activeUntil") : null;
      if (agent.shiftEnabled !== true || !activeUntil || activeUntil.getTime() <= atNow().getTime()) {
        return { status: "activity-not-proven", agentId: id, accepted: 0 };
      }
    }
    const recoverable = await listPendingProviderPosts(id);
    const results = [];
    let accepted = 0;
    const forcedRequest = requestedCount == null
      ? null
      : positiveInteger(requestedCount, "requestedCount");
    let providerBackpressure = false;
    const isProviderBackpressure = (status) => [
      "rate-limited",
      "provider-backpressure",
      "provider-lane-unavailable",
      "provider-lane-stopped",
    ].includes(String(status || ""));
    let workDurableNotified = false;
    const notifyWorkDurable = async (details) => {
      if (workDurableNotified) return;
      workDurableNotified = true;
      if (typeof onWorkDurable === "function") await onWorkDurable(details);
    };
    const postItems = [...recoverable];
    const packetIds = [];
    let claimedCount = 0;
    let firstRequested = null;
    let finalPreview = null;
    const maxRounds = Math.max(policy.providerBufferTarget, forcedRequest || 0);
    for (let round = 0; recoverOnly !== true && round <= maxRounds; round += 1) {
      const remainingRequested = forcedRequest == null
        ? null
        : Math.max(0, forcedRequest - claimedCount);
      const beforeReservation = await previewAgent(id, { neededOverride: remainingRequested });
      finalPreview = beforeReservation;
      if (beforeReservation.status !== "preview") {
        if (!postItems.length) {
          return { status: beforeReservation.status, agentId: id, accepted, results, preview: beforeReservation };
        }
        break;
      }
      if (firstRequested == null) firstRequested = beforeReservation.needed;
      if (beforeReservation.needed === 0) break;
      // The retired reservation path remains below for deletion after the
      // proof window. Legacy seed/fill cannot claim fresh work; only the
      // immediate lane owns new_today.
      const preview = await previewAgent(id, { neededOverride: remainingRequested });
      finalPreview = preview;
      if (preview.status !== "preview") {
        if (!postItems.length) return { status: preview.status, agentId: id, accepted, results, preview };
        break;
      }
      if (preview.needed === 0 || preview.recipe.items.length === 0) break;
      const packetId = `packet-${randomUUID()}`;
      const claimed = [];
      for (const selection of preview.recipe.selections) {
        const item = await claimPacketSelection(id, selection, packetId, atNow(), { preposition });
        if (item) claimed.push(item);
      }
      // A stale packet preview is not proof that inventory is exhausted.
      // Claim-time source revalidation may refresh every offered row out of
      // its old pool; continue to the next bounded round so the agent reaches
      // the valid rows behind that stale front layer.
      if (!claimed.length) continue;
      packetIds.push(packetId);
      claimedCount += claimed.length;
      postItems.push(...claimed);
      log("info", "lead_delivery.packet_built", { agentId: id, count: claimed.length, reason });
    }
    if (postItems.length === 0) {
      return {
        status: finalPreview?.needed === 0 ? "at-target" : "no-candidates",
        agentId: id,
        accepted: 0,
        results,
        preview: finalPreview,
      };
    }
    await notifyWorkDurable({
      atTarget: finalPreview?.needed === 0,
      durableItemCount: postItems.length,
    });
    for (const item of postItems) {
      const result = await postPacketItem(item, policy, { allowClosedWindow: preposition === true });
      results.push({ status: result.status, accepted: result.accepted });
      if (result.accepted) accepted += 1;
      if (isProviderBackpressure(result.status)) {
        providerBackpressure = true;
        break;
      }
    }
    return {
      status: providerBackpressure
        ? "provider-backpressure"
        : accepted === claimedCount + recoverable.length ? "posted" : "partial",
      agentId: id,
      packetId: packetIds.at(-1) || null,
      packetIds,
      requested: firstRequested ?? 0,
      claimed: claimedCount,
      accepted,
      results,
    };
  }

  async function seedAgent(agentId, { preposition = false } = {}) {
    // An ordinary seed is explicit operator bootstrap evidence. Weekend
    // pre-positioning is deliberately weaker: it may restore the shallow
    // provider buffer, but it must not manufacture agent activity evidence.
    // Both paths still re-read the source at claim time. Only pre-positioning
    // skips the current-clock window because folder placement is not a call;
    // automatic runtime paths retain that gate and prove shift/activity.
    const id = String(agentId || "").trim().toLowerCase();
    if (legacyOperatorSurfaceEnabled !== true) return legacyOperatorDisabled(id);
    const isPreposition = preposition === true;
    const policy = agentPolicy(id);
    if (!policy) return { status: "unknown-agent", agentId: id, accepted: 0 };
    await repository.upsertAgentConfiguration({
      agentId: id,
      displayName: policy.displayName,
      enabled: policy.enabled,
      configuration: {
        provider: policy.provider,
        applicationAccountEmail: policy.applicationAccountEmail,
        providerConfig: clone(policy.providerConfig),
        subscribedPools: [...policy.subscribedPools],
        packetAllowances: clone(policy.packetAllowances),
        providerBufferTarget: policy.providerBufferTarget,
        refillAtOrBelow: policy.refillAtOrBelow,
        freshReservationRange: policy.freshReservationRange,
        freshReservationMinutes: policy.freshReservationMinutes,
        activeEvidenceMinutes: policy.activeEvidenceMinutes,
        maxPendingFreshReservations: policy.maxPendingFreshReservations,
      },
    });
    const agent = await repository.getAgentById(id);
    if (!isPreposition
      && enabled === true
      && actionsEnabled === true
      && policy.enabled === true
      && agent?.enabled === true) {
      const at = atNow();
      const shifted = await repository.compareAndSetAgent({
        agentId: id,
        expectedVersion: agent.version,
        set: {
          operatorPaused: false,
          operatorChangedAt: at,
          shiftEnabled: true,
          activeUntil: new Date(at.getTime() + policy.activeEvidenceMinutes * 60_000),
        },
      });
      if (!shifted) return { status: "shift-evidence-conflict", agentId: id, accepted: 0 };
    }
    return fillAgent(id, {
      explicit: true,
      preposition: isPreposition,
      reason: isPreposition ? "explicit-preposition" : "explicit-seed",
    });
  }

  async function launchAgent(agentId) {
    if (legacyOperatorSurfaceEnabled !== true) return legacyOperatorDisabled(agentId);
    const result = await seedAgent(agentId);
    const agent = await repository.getAgentById(String(agentId || "").trim().toLowerCase());
    return {
      ...result,
      shiftEnabled: agent?.shiftEnabled === true && agent?.operatorPaused !== true,
      activeUntil: agent?.activeUntil || null,
    };
  }

  async function appendAgentPacket(agentId, { count = 4 } = {}) {
    if (legacyOperatorSurfaceEnabled !== true) return legacyOperatorDisabled(agentId);
    const requested = positiveInteger(count, "count");
    let result = await fillAgent(agentId, {
      explicit: true,
      reason: "call-end-pulse",
      requestedCount: requested,
    });
    if (String(result?.status || "") !== "no-candidates") return result;

    // A dry provider pool cannot produce another Call End to wake itself up.
    // Walk the active source immediately instead of waiting for the periodic
    // inventory tick. The single-flight wrapper prevents simultaneous agent
    // pulses from racing the shared source cursor.
    const maxOnDemandBatches = 25;
    let scannedBatches = 0;
    for (let batch = 1; batch <= maxOnDemandBatches; batch += 1) {
      scannedBatches = batch;
      const ingestion = await ingestSerial();
      result = await fillAgent(agentId, {
        explicit: true,
        reason: "call-end-pulse",
        requestedCount: requested,
      });
      if (String(result?.status || "") !== "no-candidates") {
        return { ...result, inventoryScanBatches: batch };
      }
      if (ingestion?.done === true) break;
    }
    return { ...result, status: "inventory-exhausted", inventoryScanBatches: scannedBatches };
  }

  async function postTopOfQueueOnce(agentId, {
    count = SIMPLE_PACKET_SIZE,
    untouchedOnly = false,
  } = {}) {
    const id = String(agentId || "").trim().toLowerCase();
    const requested = positiveInteger(count, "count");
    if (enabled !== true || actionsEnabled !== true) {
      return { status: "disabled", agentId: id, requested, accepted: 0 };
    }
    if (deliveryWindowOpen(atNow()) !== true) {
      return { status: "delivery-window-closed", agentId: id, requested, accepted: 0 };
    }
    const policy = agentPolicy(id);
    if (!policy?.enabled) return { status: "unknown-agent", agentId: id, requested, accepted: 0 };
    const results = [];
    let accepted = 0;

    // A previous partial packet may have a durable provider identity but no
    // accepted contact yet. Finish that exact work before claiming anything
    // new, otherwise a timeout or 429 can silently strand a lead and overfill
    // the agent on the next Call End.
    const pending = (await listPendingProviderPosts(id)).filter((item) => (
      String(item.state || "").trim().toLowerCase() === "packetized"
      && !String(item.providerContactId || "").trim()
      && String(item.sourcePool || "").trim().toLowerCase() !== POOLS.NEW_TODAY
      && (untouchedOnly !== true || (
        Number(item.totalAttemptCount || 0) === 0
        && item.lastContactAt == null
      ))
    ));
    for (const item of pending) {
      if (accepted >= requested) break;
      const dailyCap = await holdItemAtDailyCap(item, atNow());
      if (dailyCap.held) continue;
      const posted = await postPacketItem(item, policy);
      results.push({ status: posted.status, accepted: posted.accepted === true, recovered: true });
      if (posted.accepted === true) {
        accepted += 1;
        continue;
      }
      if (posted.status === "provider-rejected" || posted.status === "provider-item-no-longer-packetized") {
        continue;
      }
      return {
        status: SIMPLE_PROVIDER_STOP_STATUSES.has(posted.status)
          ? "provider-backpressure"
          : "pending-provider-post",
        agentId: id,
        requested,
        accepted,
        results,
      };
    }

    const packetAt = atNow();

    // Read the non-fresh pools as one candidate line. Walking pools one at a
    // time let a retry jump ahead of an untouched lead in a later pool.
    const ordinaryPools = packetPoolOrder.filter((pool) => pool !== POOLS.NEW_TODAY);
    const candidateLimit = Math.min(5000, Math.max(requested * 10, 250));
    const untouchedCandidates = await repository.listPacketCandidateItems({
      agentId: id,
      sourcePools: ordinaryPools,
      untouchedOnly: true,
      now: packetAt,
      limit: candidateLimit,
    });
    let candidates = untouchedCandidates;
    if (untouchedOnly !== true && untouchedCandidates.length < requested) {
      const fallbackCandidates = await repository.listPacketCandidateItems({
        agentId: id,
        sourcePools: ordinaryPools,
        untouchedOnly: false,
        now: packetAt,
        limit: candidateLimit,
      });
      const seen = new Set(untouchedCandidates.map((item) => stableWorkItemId(item)));
      candidates = [
        ...untouchedCandidates,
        ...fallbackCandidates.filter((item) => !seen.has(stableWorkItemId(item))),
      ];
    }
    candidates = [...candidates]
      .sort((left, right) => compareSelectionCandidates(left, right, { now: packetAt }));
    for (const item of candidates) {
      if (accepted >= requested) break;
      const pool = String(item.sourcePool || "").trim().toLowerCase();
      if (!ordinaryPools.includes(pool)) continue;
      const dailyCap = await holdItemAtDailyCap(item, packetAt);
      if (dailyCap.held) continue;
      const state = String(item.state || "").trim().toLowerCase();
      const expected = { state, sourcePool: pool };
      if (state === "reserved") expected.reservedAgentId = id;
      const packetId = `packet-${randomUUID()}`;
      const claimed = await repository.compareAndSetItem({
        itemId: stableWorkItemId(item),
        expectedVersion: item.version,
        expected,
        set: {
          state: "packetized",
          activeAttempt: true,
          packetId,
          deliveryAgentId: id,
          reservedAgentId: null,
          speedOverrideAgentId: null,
          reservedAt: null,
          reservationExpiresAt: null,
          reservationReason: "top-of-queue-post",
          provider: providerName,
        },
      });
      if (!claimed) continue;
      const posted = await postPacketItem(claimed, policy);
      results.push({ status: posted.status, accepted: posted.accepted === true });
      if (posted.accepted === true) accepted += 1;
      if (posted.accepted !== true && posted.status !== "provider-rejected") {
        return {
          status: SIMPLE_PROVIDER_STOP_STATUSES.has(posted.status)
            ? "provider-backpressure"
            : "pending-provider-post",
          agentId: id,
          requested,
          accepted,
          results,
        };
      }
    }
    return {
      status: accepted === requested ? "posted" : "queue-exhausted",
      agentId: id,
      requested,
      accepted,
      results,
    };
  }

  function postTopOfQueue(agentId, options = {}) {
    const id = String(agentId || "").trim().toLowerCase();
    const existing = topUpInFlightByAgent.get(id);
    if (existing) return existing;
    const operationKind = String(options.operationKind || "ordinary_refill").trim().toLowerCase();
    const work = Promise.resolve()
      .then(() => withAgentPoolOperation(
        id,
        operationKind,
        () => postTopOfQueueOnce(id, options),
      ))
      .finally(() => {
        if (topUpInFlightByAgent.get(id) === work) topUpInFlightByAgent.delete(id);
      });
    topUpInFlightByAgent.set(id, work);
    return work;
  }

  async function appendWeightedAgentPacket({ count = 4 } = {}) {
    if (legacyOperatorSurfaceEnabled !== true) return legacyOperatorDisabled();
    const requested = positiveInteger(count, "count");
    const ranked = rankFreshAgents(await freshEligibleAgents(atNow()), {
      now: atNow(),
      freshReservationRange: configuration.defaults.freshReservationRange,
      maxPendingFreshReservations: configuration.defaults.maxPendingFreshReservations,
    });
    if (!ranked.length) return { status: "no-active-agent", accepted: 0, agentId: null };
    return appendAgentPacket(ranked[0].agentId, { count: requested });
  }

  async function cancelAgent(agentId) {
    const id = String(agentId || "").trim().toLowerCase();
    const policy = agentPolicy(id);
    if (!policy) return { status: "unknown-agent", agentId: id, cancelled: false };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const agent = await repository.getAgentById(id);
      if (!agent) return { status: "agent-state-missing", agentId: id, cancelled: false };
      if (agent.operatorPaused === true && agent.shiftEnabled !== true) {
        return {
          status: "already-cancelled",
          agentId: id,
          cancelled: true,
          estimatedOutstanding: agent.estimatedOutstanding,
        };
      }
      const cancelled = await repository.compareAndSetAgent({
        agentId: id,
        expectedVersion: agent.version,
        set: {
          operatorPaused: true,
          operatorChangedAt: atNow(),
          shiftEnabled: false,
          activeUntil: null,
        },
      });
      if (cancelled) {
        return {
          status: "cancelled",
          agentId: id,
          cancelled: true,
          estimatedOutstanding: cancelled.estimatedOutstanding,
        };
      }
    }
    return { status: "cancel-conflict", agentId: id, cancelled: false };
  }

  function normalizePreloadWindowRequest(input = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new TypeError("preload window input must be an object");
    }
    const allowedFields = new Set([
      "receivedFrom",
      "receivedBefore",
      "agentIds",
      "maxContacts",
      "dryRun",
      "onProgress",
      "checkpointKey",
    ]);
    for (const field of Object.keys(input)) {
      if (!allowedFields.has(field)) throw new TypeError(`preload window contains unknown field ${field}`);
    }
    const receivedFrom = parseDate(input.receivedFrom, "receivedFrom");
    const receivedBefore = parseDate(input.receivedBefore, "receivedBefore");
    if (receivedBefore.getTime() <= receivedFrom.getTime()) {
      throw new TypeError("receivedBefore must be after receivedFrom");
    }
    if (!Array.isArray(input.agentIds) || input.agentIds.length === 0) {
      throw new TypeError("preload window requires at least one agentId");
    }
    const agentIds = input.agentIds.map((value, index) => {
      const id = String(value || "").trim().toLowerCase();
      if (!id) throw new TypeError(`agentIds[${index}] is required`);
      return id;
    });
    if (new Set(agentIds).size !== agentIds.length) throw new TypeError("preload window agentIds must be distinct");
    agentIds.sort();
    const maxContacts = positiveInteger(input.maxContacts, "maxContacts");
    if (maxContacts > MAX_PRELOAD_WINDOW_CONTACTS) {
      throw new RangeError(`maxContacts cannot exceed ${MAX_PRELOAD_WINDOW_CONTACTS}`);
    }
    if (input.dryRun != null && typeof input.dryRun !== "boolean") {
      throw new TypeError("dryRun must be a boolean");
    }
    if (input.onProgress != null && typeof input.onProgress !== "function") {
      throw new TypeError("onProgress must be a function");
    }
    const preloadKey = `preload-v1-${createHash("sha256")
      .update([
        receivedFrom.toISOString(),
        receivedBefore.toISOString(),
        agentIds.join(","),
        String(maxContacts),
      ].join("|"))
      .digest("hex")
      .slice(0, 32)}`;
    const checkpointKey = String(input.checkpointKey || `cutover-${preloadKey}`).trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._:-]{0,127}$/.test(checkpointKey)) {
      throw new TypeError("checkpointKey is invalid");
    }
    return {
      receivedFrom,
      receivedBefore,
      agentIds,
      maxContacts,
      dryRun: input.dryRun !== false,
      onProgress: input.onProgress || null,
      preloadKey,
      checkpointKey,
      agentSetDigest: createHash("sha256")
        .update(`lead-delivery-checkpoint-agents-v1\0${agentIds.join("\0")}`)
        .digest("hex"),
    };
  }

  function checkpointContract(request) {
    return {
      checkpointKey: request.checkpointKey,
      kind: "source_cutover",
      source: "lead_cadence",
      windowStartAt: request.receivedFrom,
      cutoffAt: request.receivedBefore,
      preloadPredicate: "received_at_lt_cutoff",
      continuationPredicate: "received_at_gte_cutoff",
      sortContract: "received_at_desc_source_identity_asc_v1",
      preloadKey: request.preloadKey,
      maxContacts: request.maxContacts,
      agentSetDigest: request.agentSetDigest,
    };
  }

  function checkpointContractMatches(checkpoint, contract) {
    if (!checkpoint) return false;
    const sameDate = (left, right) => {
      try { return parseDate(left, "checkpoint date").getTime() === right.getTime(); } catch { return false; }
    };
    return String(checkpoint._id || "") === contract.checkpointKey
      && String(checkpoint.kind || "") === contract.kind
      && String(checkpoint.source || "") === contract.source
      && sameDate(checkpoint.windowStartAt, contract.windowStartAt)
      && sameDate(checkpoint.cutoffAt, contract.cutoffAt)
      && String(checkpoint.preloadPredicate || "") === contract.preloadPredicate
      && String(checkpoint.continuationPredicate || "") === contract.continuationPredicate
      && String(checkpoint.sortContract || "") === contract.sortContract
      && String(checkpoint.preloadKey || "") === contract.preloadKey
      && Number(checkpoint.maxContacts) === contract.maxContacts
      && String(checkpoint.agentSetDigest || "") === contract.agentSetDigest;
  }

  function checkpointIdentityDigest(item) {
    const identity = String(item?.sourceIdentity || "").trim()
      || `${String(item?.domain || "").trim().toUpperCase()}:${String(item?.caseId || "").trim()}`;
    if (!identity || identity === ":") throw new TypeError("checkpoint item identity is missing");
    return createHash("sha256")
      .update(`lead-delivery-checkpoint-item-v1\0${identity}`)
      .digest("hex");
  }

  function checkpointSetDigest(digests) {
    const ordered = [...digests].sort();
    const hash = createHash("sha256");
    hash.update(`lead-delivery-checkpoint-set-v1\0${ordered.length}\0`);
    for (const digest of ordered) hash.update(`${digest.length}:${digest}`);
    return hash.digest("hex");
  }

  function strictProviderAccepted(item) {
    return String(item?.state || "").trim().toLowerCase() !== "delivery_failed"
      && item?.providerAcceptedAt != null
      && Boolean(String(item?.providerContactId || "").trim())
      && Boolean(String(item?.providerExternalLeadId || "").trim());
  }

  function latestCheckpointAnchor(items) {
    let winner = null;
    for (const item of items) {
      const receivedAt = parseDate(item.receivedAt, "checkpoint item receivedAt");
      const identityDigest = checkpointIdentityDigest(item);
      if (!winner
        || receivedAt.getTime() > winner.receivedAt.getTime()
        || (receivedAt.getTime() === winner.receivedAt.getTime()
          && identityDigest.localeCompare(winner.identityDigest) < 0)) {
        winner = { receivedAt, identityDigest };
      }
    }
    return winner;
  }

  async function checkpointLedgerSnapshot(request, scan, { status, completedAt = null, lastErrorCode = null } = {}) {
    const items = await repository.listItemsByPacketId(request.preloadKey);
    const admittedDigests = items.map(checkpointIdentityDigest);
    const acceptedItems = items.filter(strictProviderAccepted);
    const acceptedDigests = acceptedItems.map(checkpointIdentityDigest);
    const failedCount = items.filter((item) => String(item.state || "").trim().toLowerCase() === "delivery_failed").length;
    const acceptedCount = acceptedItems.length;
    const admittedCount = items.length;
    const pendingCount = Math.max(0, admittedCount - acceptedCount - failedCount);
    const admittedAnchor = latestCheckpointAnchor(items);
    const acceptedAnchor = latestCheckpointAnchor(acceptedItems);
    const fairness = preloadSummaryCounts({
      total: admittedCount,
      countsByAgent: items.reduce((counts, item) => {
        const agentId = String(item.deliveryAgentId || "").trim().toLowerCase();
        counts[agentId] = (counts[agentId] || 0) + 1;
        return counts;
      }, {}),
    }, request);
    return {
      status,
      scannedCount: nonNegativeInteger(scan?.scanned ?? 0, "checkpoint.scannedCount"),
      eligibleCount: nonNegativeInteger(scan?.rows?.length ?? 0, "checkpoint.eligibleCount"),
      admittedCount,
      acceptedCount,
      pendingCount,
      failedCount,
      conflictCount: fairness.conflictCount,
      // A source-row count above the cap is not proof that an additional row
      // remains claimable at claim time. The operator preview carries that
      // warning; the durable checkpoint is marked capped only by proven
      // assignment evidence, never by a stale scan estimate.
      capReached: false,
      admittedDigest: checkpointSetDigest(admittedDigests),
      acceptedDigest: checkpointSetDigest(acceptedDigests),
      latestAdmittedReceivedAt: admittedAnchor?.receivedAt || null,
      latestAdmittedIdentityDigest: admittedAnchor?.identityDigest || null,
      latestAcceptedReceivedAt: acceptedAnchor?.receivedAt || null,
      latestAcceptedIdentityDigest: acceptedAnchor?.identityDigest || null,
      completedAt,
      lastErrorCode,
    };
  }

  function safeCheckpointSummary(checkpoint) {
    if (!checkpoint) return null;
    return {
      status: String(checkpoint.status || "unknown"),
      cutoffAt: checkpoint.cutoffAt ? parseDate(checkpoint.cutoffAt, "checkpoint.cutoffAt") : null,
      admitted: nonNegativeInteger(checkpoint.admittedCount ?? 0, "checkpoint.admittedCount"),
      accepted: nonNegativeInteger(checkpoint.acceptedCount ?? 0, "checkpoint.acceptedCount"),
      pending: nonNegativeInteger(checkpoint.pendingCount ?? 0, "checkpoint.pendingCount"),
      failed: nonNegativeInteger(checkpoint.failedCount ?? 0, "checkpoint.failedCount"),
      conflicts: nonNegativeInteger(checkpoint.conflictCount ?? 0, "checkpoint.conflictCount"),
      capReached: checkpoint.capReached === true,
      completedAt: checkpoint.completedAt ? parseDate(checkpoint.completedAt, "checkpoint.completedAt") : null,
    };
  }

  function isCheckpointReadyForContinuation(checkpoint) {
    if (!checkpoint || String(checkpoint.status || "") !== "completed") return false;
    const admitted = Number(checkpoint.admittedCount || 0);
    const accepted = Number(checkpoint.acceptedCount || 0);
    return checkpoint.continuationPredicate === "received_at_gte_cutoff"
      && checkpoint.preloadPredicate === "received_at_lt_cutoff"
      && checkpoint.capReached !== true
      && Number.isSafeInteger(admitted)
      && admitted >= 0
      && accepted === admitted
      && Number(checkpoint.pendingCount || 0) === 0
      && Number(checkpoint.failedCount || 0) === 0
      && Number(checkpoint.conflictCount || 0) === 0
      && String(checkpoint.admittedDigest || "") !== ""
      && checkpoint.admittedDigest === checkpoint.acceptedDigest
      && checkpoint.completedAt != null;
  }

  function preloadSummaryCounts(summary, request) {
    const countsByAgent = Object.fromEntries(request.agentIds.map((agentId) => [agentId, 0]));
    let selectedTotal = 0;
    for (const [rawAgentId, rawCount] of Object.entries(summary?.countsByAgent || {})) {
      const agentId = String(rawAgentId || "").trim().toLowerCase();
      const count = nonNegativeInteger(rawCount ?? 0, `countsByAgent.${agentId || "unknown"}`);
      if (Object.hasOwn(countsByAgent, agentId)) {
        countsByAgent[agentId] += count;
        selectedTotal += count;
      }
    }
    const values = Object.values(countsByAgent);
    return {
      countsByAgent,
      conflictCount: Math.max(0, nonNegativeInteger(summary?.total ?? 0, "summary.total") - selectedTotal),
      spread: values.length ? Math.max(...values) - Math.min(...values) : 0,
    };
  }

  function leastServedPreloadAgent(countsByAgent, request) {
    return [...request.agentIds].sort((left, right) => {
      const countDelta = countsByAgent[left] - countsByAgent[right];
      if (countDelta) return countDelta;
      const leftTie = createHash("sha256").update(`${request.preloadKey}|${left}`).digest("hex");
      const rightTie = createHash("sha256").update(`${request.preloadKey}|${right}`).digest("hex");
      return leftTie.localeCompare(rightTie) || left.localeCompare(right);
    })[0];
  }

  function orderPreloadRows(rows) {
    return [...rows].sort((left, right) => {
      const receiptDelta = parseDate(right.receivedAt, "receivedAt").getTime()
        - parseDate(left.receivedAt, "receivedAt").getTime();
      return receiptDelta || stableWorkItemId(left).localeCompare(stableWorkItemId(right));
    });
  }

  function isPreloadCandidateItem(item, at) {
    if (!item || item.activeAttempt !== true) return false;
    if (!["eligible", "follow_up_wait"].includes(String(item.state || "").trim().toLowerCase())) return false;
    if (!POOL_VALUES.includes(String(item.sourcePool || "").trim().toLowerCase())) return false;
    if (String(item.packetId || "").trim() || String(item.deliveryAgentId || "").trim()) return false;
    let attempt;
    try {
      attempt = canAttemptToday(item, {
        now: at,
        maxDailyAttempts: maximumDailyAttempts,
        ageBasedDailyCaps: true,
      });
    } catch {
      return false;
    }
    if (!attempt.allowed) return false;
    if (String(item.state || "").trim().toLowerCase() === "follow_up_wait") {
      try {
        if (parseDate(item.nextContactAt, "nextContactAt").getTime() > at.getTime()) return false;
      } catch {
        return false;
      }
    }
    return true;
  }

  async function readPreloadWindowRows(request) {
    if (typeof source?.readWindowBatch !== "function") {
      throw new TypeError("source.readWindowBatch is required for preload windows");
    }
    const rowsByIdentity = new Map();
    const seenCursors = new Set();
    let cursor = null;
    let scanned = 0;
    let skipped = 0;
    while (true) {
      const batch = await source.readWindowBatch({
        cursor,
        limit: sourceLimit,
        now: atNow(),
        receivedFrom: request.receivedFrom,
        receivedBefore: request.receivedBefore,
      });
      for (const row of Array.isArray(batch?.items) ? batch.items : []) {
        scanned += 1;
        if (row?.sourceActive !== true) {
          skipped += 1;
          continue;
        }
        const classification = classifyPool(row, {
          now: atNow(),
          currentOvernightBatchKey: overnightBatchKeyAt(atNow()),
          maxDailyAttempts: maximumDailyAttempts,
          ageBasedDailyCaps: true,
          eligibility: row.eligibility,
        });
        if (!classification.pool) {
          skipped += 1;
          continue;
        }
        rowsByIdentity.set(stableWorkItemId(row), {
          ...clone(row),
          sourcePool: classification.pool,
        });
      }
      if (batch?.done === true) break;
      const nextCursor = batch?.nextCursor;
      if (nextCursor == null) throw new Error("preload source cursor missing before completion");
      const cursorKey = JSON.stringify(nextCursor);
      if (seenCursors.has(cursorKey)) throw new Error("preload source cursor did not advance");
      seenCursors.add(cursorKey);
      cursor = nextCursor;
    }
    return {
      scanned,
      skipped,
      rows: orderPreloadRows([...rowsByIdentity.values()]),
    };
  }

  async function preparePreloadCandidate(row, request) {
    const at = atNow();
    let item = await repository.findItemBySourceIdentity({ domain: row.domain, caseId: row.caseId });
    if (item) {
      if (String(item.packetId || "").trim() === request.preloadKey) return null;
      const refreshed = await refreshExistingSourceItem(item, row, at);
      item = refreshed.item;
    } else {
      const classification = classifyPool(row, {
        now: at,
        currentOvernightBatchKey: overnightBatchKeyAt(at),
        maxDailyAttempts: maximumDailyAttempts,
        ageBasedDailyCaps: true,
        eligibility: row.eligibility,
      });
      if (!classification.pool) return null;
      item = await repository.insertActiveItemOnce(sourceItemForInsert(row, classification));
      if (!item) item = await repository.findItemBySourceIdentity({ domain: row.domain, caseId: row.caseId });
    }
    return isPreloadCandidateItem(item, at) ? item : null;
  }

  function isProviderBackpressureStatus(status) {
    return [
      "rate-limited",
      "provider-backpressure",
      "provider-lane-unavailable",
      "provider-lane-stopped",
    ].includes(String(status || "").trim().toLowerCase());
  }

  async function summarizePreloadWindow(request, scan, status, details = {}) {
    const summary = await repository.summarizePacketAssignments(request.preloadKey);
    const fairness = preloadSummaryCounts(summary, request);
    return {
      status,
      dryRun: request.dryRun,
      preloadKey: request.preloadKey,
      scanned: scan.scanned,
      eligible: scan.rows.length,
      skipped: scan.skipped,
      selected: summary.total,
      assigned: Number(details.assigned || 0),
      accepted: summary.accepted,
      recovered: Number(details.recovered || 0),
      pending: summary.pending,
      failed: summary.failed,
      countsByAgent: fairness.countsByAgent,
      fairnessSpread: fairness.spread,
      backpressure: details.backpressure === true,
      conflictCount: fairness.conflictCount,
      checkpoint: safeCheckpointSummary(details.checkpoint),
    };
  }

  async function emitPreloadProgress(request, scan, acceptedThisRun, assignedThisRun) {
    const summary = await repository.summarizePacketAssignments(request.preloadKey);
    if (summary.accepted <= 0 || summary.accepted % 25 !== 0) return;
    const checkpoint = await persistPreloadCheckpoint(request, scan, "running");
    const fairness = preloadSummaryCounts(summary, request);
    const progress = {
      status: "running",
      preloadKey: request.preloadKey,
      scanned: scan.scanned,
      eligible: scan.rows.length,
      selected: summary.total,
      assigned: assignedThisRun,
      accepted: summary.accepted,
      countsByAgent: fairness.countsByAgent,
      fairnessSpread: fairness.spread,
    };
    log("info", "lead_delivery.preload_progress", {
      count: summary.accepted,
      reason: "preload-window",
    });
    if (request.onProgress) {
      try { await request.onProgress(progress); } catch {
        log("warn", "lead_delivery.preload_progress_failed", { reason: "progress-callback-failed" });
      }
    }
  }

  async function ensurePreloadCheckpointRunning(request) {
    for (const method of ["insertCheckpointOnce", "getCheckpointByKey", "compareAndSetCheckpoint"]) {
      if (typeof repository[method] !== "function") {
        throw new TypeError(`repository.${method} is required for applied preload windows`);
      }
    }
    const contract = checkpointContract(request);
    const inserted = await repository.insertCheckpointOnce({
      ...contract,
      status: "scheduled",
    });
    let checkpoint = inserted || await repository.getCheckpointByKey(request.checkpointKey);
    if (!checkpointContractMatches(checkpoint, contract)) {
      const error = new Error("preload checkpoint contract conflict");
      error.code = "checkpoint-contract-conflict";
      throw error;
    }
    if (String(checkpoint.status || "") === "completed") return checkpoint;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const status = String(checkpoint.status || "");
      if (!["scheduled", "running", "partial", "failed"].includes(status)) {
        const error = new Error("preload checkpoint status conflict");
        error.code = "checkpoint-status-conflict";
        throw error;
      }
      const updated = await repository.compareAndSetCheckpoint({
        checkpointKey: request.checkpointKey,
        expectedVersion: checkpoint.version,
        expected: { status },
        set: {
          status: "running",
          completedAt: null,
          lastErrorCode: null,
        },
      });
      if (updated) return updated;
      checkpoint = await repository.getCheckpointByKey(request.checkpointKey);
      if (!checkpointContractMatches(checkpoint, contract)) {
        const error = new Error("preload checkpoint contract conflict");
        error.code = "checkpoint-contract-conflict";
        throw error;
      }
      if (String(checkpoint.status || "") === "completed") return checkpoint;
    }
    const error = new Error("preload checkpoint compare-and-set conflict");
    error.code = "checkpoint-cas-conflict";
    throw error;
  }

  async function persistPreloadCheckpoint(request, scan, targetStatus, { lastErrorCode = null } = {}) {
    const contract = checkpointContract(request);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const current = await repository.getCheckpointByKey(request.checkpointKey);
      if (!checkpointContractMatches(current, contract)) {
        const error = new Error("preload checkpoint contract conflict");
        error.code = "checkpoint-contract-conflict";
        throw error;
      }
      if (String(current.status || "") === "completed") return current;
      const snapshot = await checkpointLedgerSnapshot(request, scan, {
        status: targetStatus,
        completedAt: targetStatus === "completed" ? atNow() : null,
        lastErrorCode,
      });
      if (targetStatus === "completed" && !isCheckpointReadyForContinuation({
        ...contract,
        ...snapshot,
      })) {
        const error = new Error("preload checkpoint is not complete");
        error.code = "checkpoint-incomplete";
        throw error;
      }
      const updated = await repository.compareAndSetCheckpoint({
        checkpointKey: request.checkpointKey,
        expectedVersion: current.version,
        expected: { status: current.status },
        set: snapshot,
      });
      if (updated) return updated;
    }
    const error = new Error("preload checkpoint compare-and-set conflict");
    error.code = "checkpoint-cas-conflict";
    throw error;
  }

  async function failPreloadCheckpoint(request, scan, error) {
    const safeCode = [
      "checkpoint-contract-conflict",
      "checkpoint-status-conflict",
      "checkpoint-cas-conflict",
      "checkpoint-incomplete",
      "preload-state-conflict",
    ].includes(String(error?.code || "")) ? String(error.code) : "preload-apply-failed";
    try {
      return await persistPreloadCheckpoint(request, scan, "failed", { lastErrorCode: safeCode });
    } catch {
      return null;
    }
  }

  async function preloadWindow(input = {}) {
    if (legacyOperatorSurfaceEnabled !== true) return legacyOperatorDisabled();
    const request = normalizePreloadWindowRequest(input);
    const emptyScan = { scanned: 0, skipped: 0, rows: [] };
    if (typeof repository.listItemsByPacketId !== "function") {
      throw new TypeError("repository.listItemsByPacketId is required for preload windows");
    }
    if (typeof repository.summarizePacketAssignments !== "function") {
      throw new TypeError("repository.summarizePacketAssignments is required for preload windows");
    }
    if (enabled !== true) return summarizePreloadWindow(request, emptyScan, "disabled");
    if (request.dryRun !== true && actionsEnabled !== true) {
      return summarizePreloadWindow(request, emptyScan, "actions-disabled");
    }
    if (request.dryRun !== true && refillEnabled === true) {
      return summarizePreloadWindow(request, emptyScan, "refill-must-be-disabled");
    }
    const configuredEnabled = [...validation.enabledAgentIds].sort();
    if (configuredEnabled.length !== request.agentIds.length
      || configuredEnabled.some((agentId, index) => agentId !== request.agentIds[index])) {
      return summarizePreloadWindow(request, emptyScan, "agent-policy-mismatch");
    }
    for (const agentId of request.agentIds) {
      const policy = agentPolicy(agentId);
      if (!policy || policy.enabled !== true
        || !policy.providerConfig.distributionFolderId
        || !policy.providerConfig.receivingFolderId) {
        return summarizePreloadWindow(request, emptyScan, "agent-policy-incomplete");
      }
    }

    const beforeAssignments = await repository.listItemsByPacketId(request.preloadKey);
    const beforeSummary = await repository.summarizePacketAssignments(request.preloadKey);
    const beforeFairness = preloadSummaryCounts(beforeSummary, request);
    if (beforeFairness.conflictCount > 0 || beforeFairness.spread > 1
      || beforeSummary.total > request.maxContacts) {
      return summarizePreloadWindow(request, emptyScan, "preload-state-conflict");
    }
    const scan = await readPreloadWindowRows(request);

    if (request.dryRun) {
      const simulatedCounts = { ...beforeFairness.countsByAgent };
      let selected = beforeSummary.total;
      for (const row of scan.rows) {
        if (selected >= request.maxContacts) break;
        const existing = await repository.findItemBySourceIdentity({ domain: row.domain, caseId: row.caseId });
        if (existing && String(existing.packetId || "").trim() === request.preloadKey) continue;
        if (existing && !isPreloadCandidateItem(existing, atNow())) continue;
        const winner = leastServedPreloadAgent(simulatedCounts, request);
        simulatedCounts[winner] += 1;
        selected += 1;
      }
      const values = Object.values(simulatedCounts);
      return {
        status: "preview",
        dryRun: true,
        preloadKey: request.preloadKey,
        scanned: scan.scanned,
        eligible: scan.rows.length,
        skipped: scan.skipped,
        selected,
        assigned: 0,
        accepted: beforeSummary.accepted,
        recovered: 0,
        pending: beforeSummary.pending,
        failed: beforeSummary.failed,
        countsByAgent: simulatedCounts,
        fairnessSpread: values.length ? Math.max(...values) - Math.min(...values) : 0,
        backpressure: false,
        conflictCount: 0,
        checkpoint: null,
      };
    }

    let checkpoint = await ensurePreloadCheckpointRunning(request);
    if (String(checkpoint.status || "") === "completed") {
      const ledger = await checkpointLedgerSnapshot(request, scan, {
        status: "completed",
        completedAt: checkpoint.completedAt,
      });
      const evidenceFields = [
        "admittedCount", "acceptedCount", "pendingCount", "failedCount", "conflictCount",
        "capReached", "admittedDigest", "acceptedDigest",
      ];
      const evidenceMatches = evidenceFields.every((field) => checkpoint[field] === ledger[field]);
      if (!evidenceMatches || !isCheckpointReadyForContinuation(checkpoint)) {
        const error = new Error("completed preload checkpoint evidence mismatch");
        error.code = "checkpoint-evidence-mismatch";
        throw error;
      }
      return summarizePreloadWindow(request, scan, "completed", { checkpoint });
    }

    try {
      let assigned = 0;
      let recovered = 0;
      let acceptedThisRun = 0;
      let backpressure = false;
      const recoverable = orderPreloadRows(beforeAssignments.filter((item) => (
      String(item.state || "").trim().toLowerCase() === "packetized"
      && !String(item.providerContactId || "").trim()
      && ["", "prepared", "posting", "reconcile_required"].includes(String(item.providerPostState || ""))
      )));
      for (const item of recoverable) {
        const policy = agentPolicy(item.deliveryAgentId);
        const result = await postPacketItem(item, policy);
        if (result.accepted) {
          recovered += 1;
          acceptedThisRun += 1;
          await emitPreloadProgress(request, scan, acceptedThisRun, assigned);
        }
        if (isProviderBackpressureStatus(result.status)) {
          backpressure = true;
          break;
        }
        if (!result.accepted && String(result.status || "") !== "provider-rejected") break;
      }

      if (!backpressure) {
        for (const row of scan.rows) {
        const currentSummary = await repository.summarizePacketAssignments(request.preloadKey);
        if (currentSummary.total >= request.maxContacts) break;
        const prepared = await preparePreloadCandidate(row, request);
        if (!prepared) continue;
        const result = await runProviderPostTurn(async () => {
          const latest = await repository.getItemById(stableWorkItemId(prepared));
          if (!isPreloadCandidateItem(latest, atNow())) {
            return { status: "candidate-unavailable", accepted: false, preloadAssigned: false };
          }
          const liveSummary = await repository.summarizePacketAssignments(request.preloadKey);
          if (liveSummary.total >= request.maxContacts) {
            return { status: "preload-cap-reached", accepted: false, preloadAssigned: false };
          }
          const fairness = preloadSummaryCounts(liveSummary, request);
          if (fairness.conflictCount > 0 || fairness.spread > 1) {
            return { status: "preload-state-conflict", accepted: false, preloadAssigned: false };
          }
          const winner = leastServedPreloadAgent(fairness.countsByAgent, request);
          const claimed = await claimPacketSelection(
            winner,
            {
              item: latest,
              pool: latest.sourcePool,
              selectionType: "preload-window",
            },
            request.preloadKey,
            atNow(),
            {
              preposition: true,
              requireSourceActive: true,
              receivedFrom: request.receivedFrom,
              receivedBefore: request.receivedBefore,
            },
          );
          if (!claimed) return { status: "candidate-unavailable", accepted: false, preloadAssigned: false };
          const posted = await postPacketItemInsideLane(claimed, agentPolicy(winner));
          return { ...posted, preloadAssigned: true };
        });
        if (result.preloadAssigned === true) assigned += 1;
        if (result.accepted === true) {
          acceptedThisRun += 1;
          await emitPreloadProgress(request, scan, acceptedThisRun, assigned);
        }
        if (isProviderBackpressureStatus(result.status)) {
          backpressure = true;
          break;
        }
          if (String(result.status || "") === "preload-state-conflict") {
            checkpoint = await persistPreloadCheckpoint(request, scan, "partial", {
              lastErrorCode: "preload-state-conflict",
            });
            return summarizePreloadWindow(request, scan, "preload-state-conflict", {
              assigned,
              recovered,
              checkpoint,
            });
          }
        }
      }

      const finalSummary = await repository.summarizePacketAssignments(request.preloadKey);
      const finalFairness = preloadSummaryCounts(finalSummary, request);
      const pending = finalSummary.pending > 0;
      const failed = finalSummary.failed > 0;
      const status = backpressure
        ? "provider-backpressure"
        : finalFairness.conflictCount > 0 || finalFairness.spread > 1
          ? "preload-state-conflict"
          : pending
              ? "resumable"
              : failed
                ? "partial"
                : finalSummary.accepted !== finalSummary.total
                  ? "resumable"
                  : "completed";
      checkpoint = await persistPreloadCheckpoint(
        request,
        scan,
        status === "completed" ? "completed" : "partial",
        { lastErrorCode: status === "completed" ? null : status },
      );
      return summarizePreloadWindow(request, scan, status, {
        assigned,
        recovered,
        backpressure,
        checkpoint,
      });
    } catch (error) {
      await failPreloadCheckpoint(request, scan, error);
      throw error;
    }
  }

  function completionMutation(item, transition, event, attemptNumber, completedAt) {
    return {
      set: {
        state: transition.state,
        activeAttempt: transition.activeAttempt,
        sourcePool: transition.state === "follow_up_wait" ? POOLS.FOLLOW_UP_DUE : item.sourcePool,
        providerCallId: transition.providerCallId,
        lastCountedProviderCallId: transition.lastCountedProviderCallId,
        lastCountedProviderAttemptKey: transition.lastCountedProviderAttemptKey,
        attemptedAt: transition.attemptedAt,
        providerCompletedAt: transition.providerCompletedAt,
        dailyAttemptDateKey: transition.dailyAttemptDateKey,
        dailyAttemptCount: transition.dailyAttemptCount,
        totalAttemptCount: transition.totalAttemptCount,
        lastContactAt: transition.lastContactAt,
        lastOutcome: transition.lastOutcome,
        nextContactAt: transition.nextContactAt,
        terminalAt: transition.terminalAt,
      },
      append: {
        providerAttemptHistory: [{
          attemptNumber,
          event: "completed",
          provider: providerName,
          providerExternalLeadId: String(item.providerExternalLeadId || ""),
          providerContactId: String(item.providerContactId || "") || null,
          providerCallId: String(event.providerCallId || ""),
          deliveryAgentId: String(item.deliveryAgentId || "").trim().toLowerCase() || null,
          packetId: String(item.packetId || "").trim() || null,
          occurredAt: completedAt,
          outcome: transition.lastOutcome,
          reason: transition.reason,
        }],
      },
    };
  }

  function eventActionNames(outcome) {
    const actions = ["record_daily_dial"];
    if (["dnc", "bad_lead"].includes(outcome)) return [...actions, "logics_dnc"];
    return actions;
  }

  async function markEventReview(event, reason) {
    return repository.compareAndSetEvent({
      eventId: String(event._id),
      expectedVersion: event.version,
      expected: {
        status: "processing",
        processingLeaseId: event.processingLeaseId,
      },
      set: {
        status: "review",
        nextAttemptAt: null,
        processingLeaseId: null,
        processingLeaseExpiresAt: null,
        lastError: String(reason || "review").slice(0, 120),
      },
    });
  }

  async function repairAgentAfterCompletion(agentId, at, {
    refreshActivity = true,
    completedItemId = null,
  } = {}) {
    const policy = agentPolicy(agentId);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const agent = await repository.getAgentById(agentId);
      if (!agent) throw new Error("agent-state-missing");
      const completedCount = await repository.countAgentCompletedAttempts(agentId);
      const set = { providerCompletedCount: completedCount };
      if (providerInventoryAuthoritative !== true) {
        const items = await repository.listAgentDeliveryItems(agentId);
        const projectionItems = completedItemId
          ? items.filter((candidate) => stableWorkItemId(candidate) !== completedItemId)
          : items;
        const projection = reconstructAgentProjection(projectionItems, { agentId });
        if (!projection.reliable) throw new Error("completion-projection-unreliable");
        set.estimatedOutstanding = projection.estimatedOutstanding;
      }
      if (refreshActivity === true) {
        Object.assign(set, {
          shiftEnabled: agent.operatorPaused !== true,
          lastProviderEvidenceAt: at,
          activeUntil: agent.operatorPaused === true
            ? null
            : new Date(at.getTime() + policy.activeEvidenceMinutes * 60_000),
        });
      }
      const updated = await repository.compareAndSetAgent({
        agentId,
        expectedVersion: agent.version,
        set,
      });
      if (updated) return updated;
    }
    return null;
  }

  async function recoverCountedCompletion(event, item, resolution, at) {
    const agentId = String(item.deliveryAgentId || "").trim().toLowerCase();
    if (!agentId) return { status: "review", event: await markEventReview(event, "delivery-agent-missing") };
    const agent = await repairAgentAfterCompletion(agentId, at, {
      completedItemId: stableWorkItemId(item),
    });
    if (!agent) throw new Error("completion-agent-repair-conflict");
    const updatedEvent = await repository.compareAndSetEvent({
      eventId: String(event._id),
      expectedVersion: event.version,
      expected: {
        status: "processing",
        processingLeaseId: event.processingLeaseId,
      },
      set: {
        ...canonicalSourceIdentity(item),
        resolvedItemId: stableWorkItemId(item),
        resolvedAttemptNumber: resolution.attemptNumber || item.providerAttemptSequence || 0,
        effectContext: {
          historicalAttempt: false,
          actionOutcome: String(item.lastOutcome || event.normalizedOutcome || "review"),
        },
        localAppliedAt: at,
        lastError: null,
      },
    });
    if (!updatedEvent) throw new Error("completion-event-recovery-conflict");
    const refill = computeRefillDecision({
      providerBufferTarget: agentPolicy(agentId).providerBufferTarget,
      refillAtOrBelow: agentPolicy(agentId).refillAtOrBelow,
      projection: { reliable: true, estimatedOutstanding: agent.estimatedOutstanding },
      openRefillRequest: agent.openRefillRequest === true,
    });
    return {
      status: "locally-recovered",
      event: updatedEvent,
      item,
      agent,
      actions: eventActionNames(String(item.lastOutcome || event.normalizedOutcome || "")),
      needsRefill: refill.shouldOpenRefill,
    };
  }

  function buildHistoricalEffectContext(item, context, marker, outcome) {
    const attemptNumber = Number(context?.attemptNumber || 0);
    const markerMatches = Number(marker?.attemptNumber || 0) === attemptNumber;
    const markerAt = markerMatches
      ? parseDate(marker?.removedAt || marker?.requestedAt, "workingFolderDrain.removedAt", { nullable: true })
      : null;
    const acceptedAt = context?.acceptedAt || null;
    const removedAt = context?.providerRemovedAt || markerAt || null;
    const acceptancePrecededRemovalDay = acceptedAt && removedAt
      && getPacificDateKey(acceptedAt) !== getPacificDateKey(removedAt);
    const attemptedAt = context?.callBeginAt
      || (acceptancePrecededRemovalDay ? removedAt : acceptedAt)
      || removedAt
      || context?.completedAt;
    if (!attemptedAt) return null;
    const attemptedDateKey = getPacificDateKey(attemptedAt);
    let completedAt = context?.providerRemovedAt || markerAt;
    if (!completedAt && context?.completedAt
      && getPacificDateKey(context.completedAt) === attemptedDateKey) {
      completedAt = context.completedAt;
    }
    if (!completedAt) {
      const parts = zonedParts(attemptedAt, PACIFIC_TIME_ZONE);
      const closeAt = pacificLocalDateTime(
        Number(parts.year),
        Number(parts.month),
        Number(parts.day),
        closeHour,
        closeMinute,
      );
      completedAt = closeAt.getTime() < attemptedAt.getTime() ? attemptedAt : closeAt;
    }

    const completedAttempts = new Set();
    for (const entry of Array.isArray(item.providerAttemptHistory) ? item.providerAttemptHistory : []) {
      if (String(entry?.event || "").trim().toLowerCase() !== "completed") continue;
      const number = Number(entry?.attemptNumber || 0);
      if (!Number.isInteger(number) || number < 1 || !entry?.occurredAt) continue;
      try {
        if (getPacificDateKey(entry.occurredAt) === attemptedDateKey) completedAttempts.add(number);
      } catch {
        // Malformed history cannot be allowed to move a valid historical event
        // into the webhook receipt day.
      }
    }
    const storedDaily = String(item.dailyAttemptDateKey || "") === attemptedDateKey
      ? nonNegativeInteger(item.dailyAttemptCount ?? 0, "dailyAttemptCount")
      : 0;
    const dailyAttemptCount = Math.max(
      storedDaily,
      completedAttempts.size + (completedAttempts.has(attemptNumber) ? 0 : 1),
    );
    const normalizedOutcome = normalizeOutcome(outcome);
    const decision = decideOutcomeState({
      normalizedOutcome,
      completedAt,
      dailyAttemptCount,
      maxDailyAttempts: Math.max(1, dailyAttemptLimitForLeadAge(item, {
        now: attemptedAt,
        maximum: maximumDailyAttempts,
      })),
      retryDelayMinutes: Math.max(
        followUpDelayMinutes,
        retryDelayMinutesForLeadAge(item, { now: attemptedAt }),
      ),
    });
    return {
      historicalAttempt: true,
      attemptNumber,
      deliveryAgentId: context.deliveryAgentId,
      attemptedAt,
      completedAt,
      dailyAttemptDateKey: attemptedDateKey,
      dailyAttemptCount,
      nextContactAt: decision.nextContactAt,
      normalizedOutcome,
      originPool: String(item.sourcePool || POOLS.FOLLOW_UP_DUE),
      decision,
    };
  }

  function historicalCounterMutation(item, effectContext, { incrementTotal }) {
    const set = {
      totalAttemptCount: nonNegativeInteger(item.totalAttemptCount ?? 0, "totalAttemptCount")
        + (incrementTotal ? 1 : 0),
    };
    const currentLastContactAt = parseDate(item.lastContactAt, "lastContactAt", { nullable: true });
    set.lastContactAt = currentLastContactAt
      && currentLastContactAt.getTime() > effectContext.completedAt.getTime()
      ? currentLastContactAt
      : effectContext.completedAt;
    const storedKey = String(item.dailyAttemptDateKey || "").trim();
    if (!storedKey || storedKey < effectContext.dailyAttemptDateKey) {
      set.dailyAttemptDateKey = effectContext.dailyAttemptDateKey;
      set.dailyAttemptCount = effectContext.dailyAttemptCount;
    } else if (storedKey === effectContext.dailyAttemptDateKey) {
      set.dailyAttemptDateKey = storedKey;
      set.dailyAttemptCount = Math.max(
        nonNegativeInteger(item.dailyAttemptCount ?? 0, "dailyAttemptCount"),
        effectContext.dailyAttemptCount,
      );
    }
    return set;
  }

  function historicalLifecycleIsOwned(item, marker, attemptNumber, effectContext) {
    if (Number(item.providerAttemptSequence || 0) !== Number(attemptNumber || 0)) return false;
    if (Number(marker?.attemptNumber || 0) !== Number(attemptNumber || 0)) return false;
    if (!["provider_absent", "released"].includes(String(marker?.status || ""))) return false;
    if (!["provider_accepted", "eligible", "follow_up_wait", "review"].includes(String(item.state || "").trim())) return false;
    const currentLastContactAt = parseDate(item.lastContactAt, "lastContactAt", { nullable: true });
    if (currentLastContactAt
      && currentLastContactAt.getTime() > effectContext.completedAt.getTime()) return false;
    const currentDailyKey = String(item.dailyAttemptDateKey || "").trim();
    const currentDailyCount = nonNegativeInteger(item.dailyAttemptCount ?? 0, "dailyAttemptCount");
    return !currentDailyKey
      || currentDailyKey <= effectContext.dailyAttemptDateKey
      || currentDailyCount === 0;
  }

  async function applyReleasedHistoricalCallDone(event, item, resolution, at, attemptKey) {
    const attemptNumber = Number(resolution.attemptNumber || 0);
    const marker = item.metadata?.[END_OF_DAY_DRAIN_METADATA_KEY];
    const context = providerAttemptContext(item, event, attemptNumber);
    if (!context) return null;
    const latestSequence = Number(item.providerAttemptSequence || 0);
    const markerOwnsAttempt = ["provider_absent", "released"].includes(String(marker?.status || ""))
      && Number(marker?.attemptNumber || 0) === attemptNumber;
    // The latest daily-close marker is mutable and may already name attempt N+1.
    // Exact immutable provider history remains sufficient evidence for an older
    // attempt; the current marker is required only when this is still sequence N.
    const immutableReleaseEvidence = Boolean(context.providerRemovedAt);
    if (!markerOwnsAttempt
      && !(attemptNumber < latestSequence && immutableReleaseEvidence)) return null;
    const effect = buildHistoricalEffectContext(
      item,
      context,
      markerOwnsAttempt ? marker : null,
      event.normalizedOutcome,
    );
    if (!effect) {
      return { status: "review", event: await markEventReview(event, "historical-attempt-time-missing") };
    }
    const { decision, ...durableEffectContext } = effect;
    const completedKey = completedProviderAttemptKey(context);
    if (completedKey && completedKey !== attemptKey) {
      return { status: "review", event: await markEventReview(event, "historical-attempt-already-completed") };
    }
    if (completedKey === attemptKey) {
      const existingCompletion = [...context.entries].reverse().find((entry) => (
        String(entry?.event || "").trim().toLowerCase() === "completed"
      ));
      const existingOutcome = normalizeOutcome(existingCompletion?.outcome);
      const incomingOutcome = normalizeOutcome(event.normalizedOutcome);
      const strengthensReview = ["answered", "review"].includes(existingOutcome)
        && !["answered", "review"].includes(incomingOutcome);
      let updatedItem = item;
      if (strengthensReview && historicalLifecycleIsOwned(item, marker, attemptNumber, effect)) {
        const strengthened = await repository.compareAndSetItem({
          itemId: stableWorkItemId(item),
          expectedVersion: item.version,
          expected: {
            state: item.state,
            providerAttemptSequence: item.providerAttemptSequence,
            providerContactId: item.providerContactId ?? null,
            providerExternalLeadId: item.providerExternalLeadId ?? null,
            lastCountedProviderAttemptKey: item.lastCountedProviderAttemptKey ?? null,
          },
          set: {
            ...historicalCounterMutation(item, effect, { incrementTotal: false }),
            state: decision.state,
            activeAttempt: decision.activeAttempt,
            sourcePool: decision.state === "follow_up_wait"
              ? POOLS.FOLLOW_UP_DUE
              : decision.state === "terminal" ? null : item.sourcePool,
            providerCallId: String(event.providerCallId || ""),
            lastCountedProviderCallId: String(event.providerCallId || ""),
            lastCountedProviderAttemptKey: attemptKey,
            attemptedAt: effect.attemptedAt,
            providerCompletedAt: effect.completedAt,
            lastOutcome: decision.lastOutcome,
            nextContactAt: decision.nextContactAt,
            terminalAt: decision.terminalAt,
          },
          append: {
            providerAttemptHistory: [{
              attemptNumber,
              event: "completed",
              provider: context.provider,
              providerExternalLeadId: context.providerExternalLeadId,
              providerContactId: context.providerContactId,
              providerCallId: String(event.providerCallId || ""),
              deliveryAgentId: context.deliveryAgentId,
              packetId: context.packetId,
              occurredAt: effect.completedAt,
              outcome: incomingOutcome,
              reason: "historical-disposition-strengthened",
            }],
          },
        });
        if (!strengthened) throw new Error("historical-strengthening-item-conflict");
        updatedItem = strengthened;
      }
      const agent = await repairAgentAfterCompletion(context.deliveryAgentId, at, {
        refreshActivity: false,
      });
      if (!agent) throw new Error("historical-completion-agent-repair-conflict");
      const updatedEvent = await repository.compareAndSetEvent({
        eventId: String(event._id),
        expectedVersion: event.version,
        expected: { status: "processing", processingLeaseId: event.processingLeaseId },
        set: {
          ...canonicalSourceIdentity(item),
          resolvedItemId: stableWorkItemId(item),
          resolvedAttemptNumber: attemptNumber,
          effectContext: durableEffectContext,
          localAppliedAt: at,
          lastError: null,
        },
      });
      if (!updatedEvent) throw new Error("historical-completion-event-recovery-conflict");
      return {
        status: "locally-recovered",
        event: updatedEvent,
        item: updatedItem,
        agent,
        effectAgentId: context.deliveryAgentId,
        attemptContext: { ...context, ...durableEffectContext },
        effectContext: durableEffectContext,
        actions: eventActionNames(normalizeOutcome(event.normalizedOutcome)),
        needsRefill: false,
        historicalAttempt: true,
      };
    }

    const newerAttemptExists = Number(item.providerAttemptSequence || 0) > attemptNumber;
    const set = historicalCounterMutation(item, effect, { incrementTotal: true });
    const ownsLifecycle = !newerAttemptExists
      && historicalLifecycleIsOwned(item, marker, attemptNumber, effect);
    if (ownsLifecycle) {
      Object.assign(set, {
        state: decision.state,
        activeAttempt: decision.activeAttempt,
        sourcePool: decision.state === "follow_up_wait"
          ? POOLS.FOLLOW_UP_DUE
          : decision.state === "terminal" ? null : item.sourcePool,
        reservedAgentId: null,
        speedOverrideAgentId: null,
        reservedAt: null,
        reservationExpiresAt: null,
        freshDeadlineAt: null,
        reservationReason: "historical-completion-after-daily-close",
        packetId: null,
        deliveryAgentId: null,
        provider: null,
        providerContactId: null,
        providerExternalLeadId: null,
        providerAcceptedAt: null,
        providerCompletedAt: null,
        providerCallId: null,
        providerPostState: null,
        providerPostLeaseId: null,
        providerPostLeaseExpiresAt: null,
        lastCountedProviderCallId: String(event.providerCallId || ""),
        lastCountedProviderAttemptKey: attemptKey,
        attemptedAt: effect.attemptedAt,
        lastOutcome: decision.lastOutcome,
        nextContactAt: decision.nextContactAt,
        terminalAt: decision.terminalAt,
        metadata: withWorkingFolderDrainMetadata(item, {
          status: "released",
          releasedAt: at,
          completionOutcome: decision.lastOutcome,
        }),
      });
    }
    const updatedItem = await repository.compareAndSetItem({
      itemId: stableWorkItemId(item),
      expectedVersion: item.version,
      expected: {
        state: item.state,
        providerAttemptSequence: item.providerAttemptSequence,
        providerContactId: item.providerContactId ?? null,
        providerExternalLeadId: item.providerExternalLeadId ?? null,
        lastCountedProviderCallId: item.lastCountedProviderCallId ?? null,
        lastCountedProviderAttemptKey: item.lastCountedProviderAttemptKey ?? null,
      },
      set,
      append: {
        providerAttemptHistory: [{
          attemptNumber,
          event: "completed",
          provider: context.provider,
          providerExternalLeadId: context.providerExternalLeadId,
          providerContactId: context.providerContactId,
          providerCallId: String(event.providerCallId || ""),
          deliveryAgentId: context.deliveryAgentId,
          packetId: context.packetId,
          occurredAt: effect.completedAt,
          outcome: normalizeOutcome(event.normalizedOutcome),
          reason: ownsLifecycle ? decision.reason : "delayed-after-daily-close",
        }],
      },
    });
    if (!updatedItem) throw new Error("historical-completion-item-conflict");
    const agent = await repairAgentAfterCompletion(context.deliveryAgentId, at, {
      refreshActivity: false,
    });
    if (!agent) throw new Error("historical-completion-agent-conflict");
    const updatedEvent = await repository.compareAndSetEvent({
      eventId: String(event._id),
      expectedVersion: event.version,
      expected: { status: "processing", processingLeaseId: event.processingLeaseId },
      set: {
        ...canonicalSourceIdentity(item),
        resolvedItemId: stableWorkItemId(item),
        resolvedAttemptNumber: attemptNumber,
        effectContext: durableEffectContext,
        localAppliedAt: at,
        lastError: null,
      },
    });
    if (!updatedEvent) throw new Error("historical-completion-event-conflict");
    runtimeState.completed += 1;
    return {
      status: "locally-applied",
      event: updatedEvent,
      item: updatedItem,
      agent,
      effectAgentId: context.deliveryAgentId,
      attemptContext: { ...context, ...durableEffectContext },
      effectContext: durableEffectContext,
      actions: eventActionNames(normalizeOutcome(event.normalizedOutcome)),
      needsRefill: false,
      historicalAttempt: true,
    };
  }

        async function applyCallDoneLocally(event, item, resolution, at) {
    const callId = String(event.providerCallId || "").trim();
    if (!callId) return { status: "review", event: await markEventReview(event, "missing-provider-call-id") };
    let attemptKey;
    try {
      attemptKey = buildProviderAttemptKey(event);
    } catch {
      return { status: "review", event: await markEventReview(event, "missing-provider-attempt-identity") };
    }
    const countedAttemptKey = existingCountedProviderAttemptKey(item);
    const sameCountedCall = Boolean(countedAttemptKey && countedAttemptKey === attemptKey);
    const resolvedAttemptNumber = Number(resolution.attemptNumber || item.providerAttemptSequence || 0);
    const exactCurrentAttempt = resolvedAttemptNumber === Number(item.providerAttemptSequence || 0)
      && String(item.providerContactId || "").trim() === String(event.providerContactId || "").trim()
      && String(item.providerExternalLeadId || "").trim() === String(event.providerExternalLeadId || "").trim();
    const currentCloseMarker = item.metadata?.[END_OF_DAY_DRAIN_METADATA_KEY];
    const resolvedAttemptContext = providerAttemptContext(item, event, resolvedAttemptNumber);
    const providerRemovedBeforeCallback = Boolean(resolvedAttemptContext?.providerRemovedAt)
      || (
        Number(currentCloseMarker?.attemptNumber || 0) === resolvedAttemptNumber
        && ["provider_absent", "released"].includes(String(currentCloseMarker?.status || ""))
      );
    if (!exactCurrentAttempt || providerRemovedBeforeCallback) {
      const historical = await applyReleasedHistoricalCallDone(
        event,
        item,
        resolution,
        at,
        attemptKey,
      );
      if (historical) return historical;
      if (!sameCountedCall) {
        return { status: "review", event: await markEventReview(event, "stale-provider-attempt") };
      }
    }
    const unresolvedState = String(item.state || "").trim();
    const sameUnresolvedAttempt = unresolvedState === "review"
      || (unresolvedState === "follow_up_wait"
        && String(item.lastOutcome || "").trim().toLowerCase() === "review");
    if (sameCountedCall && !exactCurrentAttempt && !sameUnresolvedAttempt) {
      return { status: "review", event: await markEventReview(event, "stale-counted-attempt") };
    }
    const incomingOutcome = normalizeOutcome(event.normalizedOutcome);
    const strengthensReview = sameCountedCall
      && sameUnresolvedAttempt
      && !["answered", "review"].includes(incomingOutcome);
    if (sameCountedCall && !strengthensReview) {
      return recoverCountedCompletion(event, item, resolution, at);
    }
    const agentId = String(item.deliveryAgentId || "").trim().toLowerCase();
    if (!agentId) return { status: "review", event: await markEventReview(event, "delivery-agent-missing") };
    const agent = await repository.getAgentById(agentId);
    if (!agent) return { status: "review", event: await markEventReview(event, "agent-state-missing") };
    let transition;
    try {
      transition = transitionCompletedAttempt(item, event.normalizedOutcome, {
        attemptedAt: at,
        completedAt: at,
        providerCallId: callId,
        providerAttemptKey: attemptKey,
        maxDailyAttempts: Math.max(1, dailyAttemptLimitForLeadAge(item, {
          now: at,
          maximum: maximumDailyAttempts,
        })),
        retryDelayMinutes: Math.max(
          followUpDelayMinutes,
          retryDelayMinutesForLeadAge(item, { now: at }),
        ),
      });
    } catch {
      return { status: "review", event: await markEventReview(event, "completion-transition-rejected") };
    }
    const attemptNumber = resolution.attemptNumber || positiveInteger(
      item.providerAttemptSequence,
      "providerAttemptSequence",
    );
    const updatedItem = await repository.compareAndSetItem({
      itemId: stableWorkItemId(item),
      expectedVersion: item.version,
      expected: {
        state: item.state,
        providerCallId: item.providerCallId ?? null,
        lastCountedProviderCallId: item.lastCountedProviderCallId ?? null,
        lastCountedProviderAttemptKey: item.lastCountedProviderAttemptKey ?? null,
      },
      ...completionMutation(item, transition, event, attemptNumber, at),
    });
    if (!updatedItem) throw new Error("completion-item-conflict");
    const updatedAgent = await repairAgentAfterCompletion(agentId, at, {
      completedItemId: stableWorkItemId(updatedItem),
    });
    if (!updatedAgent) throw new Error("completion-agent-conflict");
    const updatedEvent = await repository.compareAndSetEvent({
      eventId: String(event._id),
      expectedVersion: event.version,
      expected: {
        status: "processing",
        processingLeaseId: event.processingLeaseId,
      },
      set: {
        ...canonicalSourceIdentity(item),
        resolvedItemId: stableWorkItemId(item),
        resolvedAttemptNumber: attemptNumber,
        effectContext: {
          historicalAttempt: false,
          actionOutcome: transition.lastOutcome,
          originPool: String(item.sourcePool || "unknown"),
        },
        localAppliedAt: at,
        lastError: null,
      },
    });
    if (!updatedEvent) throw new Error("completion-event-conflict");
    await runLifecycleHook(onAttemptCompleted, "attempt_completed", {
      item: clone(updatedItem),
      event: clone(updatedEvent),
      transition: clone(transition),
      attemptNumber,
      completedAt: at,
    });
    const committed = { item: updatedItem, agent: updatedAgent, event: updatedEvent };
    runtimeState.completed += 1;
    const refill = computeRefillDecision({
      providerBufferTarget: agentPolicy(agentId).providerBufferTarget,
      refillAtOrBelow: agentPolicy(agentId).refillAtOrBelow,
      projection: {
        reliable: true,
        estimatedOutstanding: committed.agent.estimatedOutstanding,
      },
      openRefillRequest: committed.agent.openRefillRequest === true,
    });
    return {
      status: "locally-applied",
      ...committed,
      actions: eventActionNames(transition.lastOutcome),
      actionOutcome: transition.lastOutcome,
      needsRefill: refill.shouldOpenRefill,
    };
  }

  async function applyPresenceEventLocally(event, item, resolution, at) {
    const agentId = String(item.deliveryAgentId || "").trim().toLowerCase();
    if (!agentId) return { status: "review", event: await markEventReview(event, "delivery-agent-missing") };
    const policy = agentPolicy(agentId);
    const agent = await repository.getAgentById(agentId);
    if (!policy || !agent) return { status: "review", event: await markEventReview(event, "agent-state-missing") };
    const activeUntil = new Date(at.getTime() + policy.activeEvidenceMinutes * 60_000);
    const callId = String(event.providerCallId || "").trim() || null;
    const attemptNumber = resolution.attemptNumber || item.providerAttemptSequence || 0;
    const currentAttemptNumber = Number(item.providerAttemptSequence || 0);
    const eventContactId = String(event.providerContactId || "").trim();
    const eventExternalId = String(event.providerExternalLeadId || "").trim();
    const currentContactId = String(item.providerContactId || "").trim();
    const currentExternalId = String(item.providerExternalLeadId || "").trim();
    const sameCurrentAttempt = Number(attemptNumber) === currentAttemptNumber
      && (!eventContactId || eventContactId === currentContactId)
      && (!eventExternalId || eventExternalId === currentExternalId);
    const closeMarker = item.metadata?.[END_OF_DAY_DRAIN_METADATA_KEY];
    const exactAttemptContext = event.eventType === "call_begin"
      ? providerAttemptContext(item, event, attemptNumber)
      : null;
    const providerUnavailableOrClosing = Boolean(exactAttemptContext?.providerRemovedAt)
      || (
        Number(closeMarker?.attemptNumber || 0) === Number(attemptNumber || 0)
        && ["delete_pending", "provider_absent", "released"].includes(String(closeMarker?.status || ""))
      );
    const state = String(item.state || "").trim();
    const repeatsCompletedCall = state === "follow_up_wait"
      && callId
      && callId === String(item.lastCountedProviderCallId || "").trim();
    if (event.eventType === "call_begin" && (
      !sameCurrentAttempt
      || providerUnavailableOrClosing
      || repeatsCompletedCall
      || !["provider_accepted", "in_call", "follow_up_wait"].includes(state)
      || (state === "in_call" && String(item.providerCallId || "") !== callId)
    )) {
      // PhoneBurner may deliver presence after completion. Presence is weaker
      // evidence than Call End and may never resurrect a completed attempt.
      const staleEvent = await repository.compareAndSetEvent({
        eventId: String(event._id),
        expectedVersion: event.version,
        expected: { status: "processing", processingLeaseId: event.processingLeaseId },
        set: {
          status: "completed",
          resolvedItemId: stableWorkItemId(item),
          resolvedAttemptNumber: attemptNumber,
          localAppliedAt: at,
          downstreamAppliedAt: at,
          processedAt: at,
          processingLeaseId: null,
          processingLeaseExpiresAt: null,
          nextAttemptAt: null,
          lastError: null,
        },
      });
      if (!staleEvent) throw new Error("stale-presence-event-conflict");
      return {
        status: "completed",
        item,
        agent,
        event: staleEvent,
        actions: [],
        needsRefill: false,
      };
    }
    let updatedItem = item;
    if (event.eventType === "call_begin" && !(
      String(item.state || "") === "in_call"
      && String(item.providerCallId || "") === callId
    )) {
      if (!callId) throw new Error("call-begin-identity-missing");
      updatedItem = await repository.compareAndSetItem({
        itemId: stableWorkItemId(item),
        expectedVersion: item.version,
        expected: { state: item.state },
        set: { state: "in_call", activeAttempt: true, providerCallId: callId },
        append: {
          providerAttemptHistory: [{
            attemptNumber,
            event: "call_begin",
            provider: providerName,
          providerExternalLeadId: String(event.providerExternalLeadId || item.providerExternalLeadId || ""),
          providerContactId: String(event.providerContactId || item.providerContactId || "") || null,
            providerCallId: callId,
            deliveryAgentId: agentId,
            packetId: String(item.packetId || "") || null,
            occurredAt: at,
            outcome: null,
            reason: null,
          }],
        },
      });
      if (!updatedItem) throw new Error("presence-item-conflict");
    }
    const freshAgent = await repository.getAgentById(agentId);
    const updatedAgent = await repository.compareAndSetAgent({
      agentId,
      expectedVersion: freshAgent.version,
      set: {
        shiftEnabled: freshAgent.operatorPaused !== true,
        lastProviderEvidenceAt: at,
        activeUntil: freshAgent.operatorPaused === true ? null : activeUntil,
      },
    });
    if (!updatedAgent) throw new Error("presence-agent-conflict");
    const updatedEvent = await repository.compareAndSetEvent({
      eventId: String(event._id),
      expectedVersion: event.version,
      expected: { status: "processing", processingLeaseId: event.processingLeaseId },
      set: {
        status: "completed",
        resolvedItemId: stableWorkItemId(item),
        resolvedAttemptNumber: attemptNumber,
        localAppliedAt: at,
        downstreamAppliedAt: at,
        processedAt: at,
        processingLeaseId: null,
        processingLeaseExpiresAt: null,
        nextAttemptAt: null,
        lastError: null,
      },
    });
    if (!updatedEvent) throw new Error("presence-event-conflict");
    const committed = { item: updatedItem, agent: updatedAgent, event: updatedEvent };
    return { status: "completed", ...committed, actions: [], needsRefill: false };
  }

  async function applyEventLocally(event) {
    if (event.localAppliedAt) {
      const item = event.resolvedItemId
        ? await repository.getItemById(event.resolvedItemId)
        : null;
      const attemptContext = item && event.eventType === "call_done"
        ? providerAttemptContext(item, event, event.resolvedAttemptNumber)
        : null;
      const closeMarker = item?.metadata?.[END_OF_DAY_DRAIN_METADATA_KEY];
      const recomputedHistoricalAttempt = Boolean(attemptContext && (
        Number(event.resolvedAttemptNumber || 0) < Number(item.providerAttemptSequence || 0)
        || (
          Number(closeMarker?.attemptNumber || 0) === Number(event.resolvedAttemptNumber || 0)
          && ["provider_absent", "released"].includes(String(closeMarker?.status || ""))
          && (
            String(item.providerContactId || "").trim() !== String(event.providerContactId || "").trim()
            || String(item.providerExternalLeadId || "").trim() !== String(event.providerExternalLeadId || "").trim()
          )
        )
      ));
      let effectContext = event.effectContext || null;
      const historicalAttempt = effectContext?.historicalAttempt === true
        || recomputedHistoricalAttempt;
      if (historicalAttempt && !effectContext && attemptContext) {
        const rebuilt = buildHistoricalEffectContext(
          item,
          attemptContext,
          closeMarker,
          event.normalizedOutcome,
        );
        if (rebuilt) {
          const { decision: _decision, ...durable } = rebuilt;
          effectContext = durable;
        }
      }
      return {
        status: "local-already-applied",
        event,
        item,
        agent: (attemptContext?.deliveryAgentId || item?.deliveryAgentId)
          ? await repository.getAgentById(attemptContext?.deliveryAgentId || item.deliveryAgentId)
          : null,
        effectAgentId: attemptContext?.deliveryAgentId || item?.deliveryAgentId || null,
        attemptContext: attemptContext && effectContext
          ? { ...attemptContext, ...effectContext }
          : attemptContext,
        effectContext,
        historicalAttempt,
        actionOutcome: effectContext?.actionOutcome
          || (historicalAttempt ? event.normalizedOutcome : item?.lastOutcome)
          || event.normalizedOutcome,
        actions: item ? eventActionNames(String(
          historicalAttempt ? event.normalizedOutcome : (item.lastOutcome || event.normalizedOutcome || ""),
        )) : [],
        needsRefill: false,
      };
    }
    const candidates = await repository.listProviderIdentityCandidates(event);
    const resolution = resolveProviderEventItem(candidates, event);
    if (resolution.status !== "resolved") {
      return { status: "review", event: await markEventReview(event, resolution.reason) };
    }
    const item = await repository.getItemById(stableWorkItemId(resolution.item));
    if (!item) return { status: "review", event: await markEventReview(event, "resolved-item-missing") };
    const at = parseDate(event.receivedAt || atNow(), "event.receivedAt");
    if (event.eventType === "call_done") {
      return applyCallDoneLocally(event, item, resolution, at);
    }
    return applyPresenceEventLocally(event, item, resolution, at);
  }

  async function cancelNewerAttemptForHistoricalTerminal(event, local) {
    const outcome = normalizeOutcome(event.normalizedOutcome);
    if (local.historicalAttempt !== true || !TERMINAL_OUTCOMES.has(outcome)
      || !local.item) return local;
    const itemId = stableWorkItemId(local.item);
    let current = await repository.getItemById(itemId);
    const historicalAttemptNumber = Number(event.resolvedAttemptNumber || 0);
    if (!current || Number(current.providerAttemptSequence || 0) <= historicalAttemptNumber) return local;
    if (["terminal", "blocked"].includes(String(current.state || "").trim())) {
      return { ...local, item: current };
    }
    const evidenceAt = parseDate(
      local.effectContext?.completedAt || event.receivedAt || atNow(),
      "historical terminal completedAt",
    );
    const metadata = current.metadata && typeof current.metadata === "object"
      && !Array.isArray(current.metadata)
      ? clone(current.metadata)
      : {};
    metadata.historicalTerminalBlock = {
      outcome,
      sourceAttemptNumber: historicalAttemptNumber,
      observedAt: evidenceAt,
      deferredProviderContactId: String(current.providerContactId || "").trim() || null,
      deferredProviderExternalLeadId: String(current.providerExternalLeadId || "").trim() || null,
      status: String(current.state || "") === "in_call" ? "in_call_deferred" : "cancel_pending",
    };
    if (String(current.state || "") === "in_call") {
      const deferred = await repository.compareAndSetItem({
        itemId,
        expectedVersion: current.version,
        expected: {
          state: "in_call",
          providerAttemptSequence: current.providerAttemptSequence,
          providerContactId: current.providerContactId,
          providerExternalLeadId: current.providerExternalLeadId,
        },
        set: { metadata },
      });
      if (!deferred) throw new Error("historical-terminal-in-call-conflict");
      return { ...local, item: deferred };
    }

    const contactId = String(current.providerContactId || "").trim();
    const externalId = String(current.providerExternalLeadId || "").trim();
    const deliveryAgentId = String(current.deliveryAgentId || "").trim().toLowerCase();
    if (contactId) {
      const intended = await repository.compareAndSetItem({
        itemId,
        expectedVersion: current.version,
        expected: {
          state: current.state,
          providerAttemptSequence: current.providerAttemptSequence,
          providerContactId: contactId,
          providerExternalLeadId: current.providerExternalLeadId,
        },
        set: { metadata },
      });
      if (!intended) throw new Error("historical-terminal-cancel-intent-conflict");
      current = intended;
      const removed = await phoneBurner.deleteContact(contactId);
      if (removed?.ok !== true && Number(removed?.httpStatus) !== 404) {
        noteProviderInventoryBackpressure(removed);
        const error = new Error("historical-terminal-provider-delete-failed");
        if (Number.isFinite(Number(removed?.retryAfterMs))) {
          error.retryAfterMs = Number(removed.retryAfterMs);
        }
        throw error;
      }
    }

    const completedMetadata = clone(current.metadata || metadata);
    completedMetadata.historicalTerminalBlock = {
      ...metadata.historicalTerminalBlock,
      status: "cancelled",
      cancelledAt: atNow(),
    };
    const terminated = await repository.compareAndSetItem({
      itemId,
      expectedVersion: current.version,
      expected: {
        state: current.state,
        providerAttemptSequence: current.providerAttemptSequence,
        providerContactId: current.providerContactId ?? null,
        providerExternalLeadId: current.providerExternalLeadId ?? null,
      },
      set: {
        state: "terminal",
        activeAttempt: false,
        sourcePool: null,
        reservedAgentId: null,
        speedOverrideAgentId: null,
        reservedAt: null,
        reservationExpiresAt: null,
        freshDeadlineAt: null,
        reservationReason: "historical-terminal-outcome",
        packetId: null,
        deliveryAgentId: null,
        provider: null,
        providerContactId: null,
        providerExternalLeadId: null,
        providerAcceptedAt: null,
        providerCompletedAt: null,
        providerCallId: null,
        providerPostState: null,
        providerPostLeaseId: null,
        providerPostLeaseExpiresAt: null,
        lastOutcome: outcome,
        nextContactAt: null,
        terminalAt: evidenceAt,
        metadata: completedMetadata,
      },
      ...(contactId && externalId ? {
        append: {
          providerAttemptHistory: [{
            attemptNumber: current.providerAttemptSequence,
            event: "provider_removed",
            provider: String(current.provider || providerName).trim().toLowerCase(),
            providerExternalLeadId: externalId,
            providerContactId: contactId,
            providerCallId: String(current.providerCallId || "") || null,
            deliveryAgentId: deliveryAgentId || null,
            packetId: String(current.packetId || "") || null,
            occurredAt: atNow(),
            outcome: null,
            reason: "historical-terminal-cancel",
          }],
        },
      } : {}),
    });
    if (!terminated) {
      const latest = await repository.getItemById(itemId);
      if (!["terminal", "blocked"].includes(String(latest?.state || "").trim())) {
        throw new Error("historical-terminal-cancel-commit-conflict");
      }
      current = latest;
    } else {
      current = terminated;
    }
    if (deliveryAgentId) {
      const agent = await repository.getAgentById(deliveryAgentId);
      if (agent) {
        await repository.compareAndSetAgent({
          agentId: deliveryAgentId,
          expectedVersion: agent.version,
          set: { estimatedOutstanding: Math.max(0, Number(agent.estimatedOutstanding || 0) - 1) },
        });
      }
    }
    return { ...local, item: current };
  }

  async function enforceDeferredHistoricalTerminalBlock(local) {
    if (local.historicalAttempt === true || !local.item) return local;
    const itemId = stableWorkItemId(local.item);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await repository.getItemById(itemId);
      const metadata = current?.metadata && typeof current.metadata === "object"
        && !Array.isArray(current.metadata)
        ? clone(current.metadata)
        : {};
      const block = metadata.historicalTerminalBlock;
      const outcome = normalizeOutcome(block?.outcome);
      if (!current || block?.status !== "in_call_deferred" || !TERMINAL_OUTCOMES.has(outcome)) {
        return { ...local, item: current || local.item };
      }
      if (Number(current.providerAttemptSequence || 0) <= Number(block.sourceAttemptNumber || 0)) {
        throw new Error("historical-terminal-block-attempt-invalid");
      }
      metadata.historicalTerminalBlock = {
        ...block,
        status: "enforced",
        enforcedAt: atNow(),
      };
      const terminalAt = parseDate(
        block.observedAt || current.lastContactAt || atNow(),
        "historicalTerminalBlock.observedAt",
      );
      // The ordinary Call Done cleanup runs before this enforcement pass and
      // may already have cleared the current provider identity. Preserve the
      // exact deferred identity on the block so the newer physical contact is
      // still removed before the historical terminal result wins.
      const contactId = String(
        current.providerContactId || block.deferredProviderContactId || "",
      ).trim();
      if (contactId) {
        const removed = await phoneBurner.deleteContact(contactId);
        if (removed?.ok !== true && Number(removed?.httpStatus) !== 404) {
          noteProviderInventoryBackpressure(removed);
          const error = new Error("historical-terminal-provider-delete-failed");
          if (Number.isFinite(Number(removed?.retryAfterMs))) {
            error.retryAfterMs = Number(removed.retryAfterMs);
          }
          throw error;
        }
      }
      const terminated = await repository.compareAndSetItem({
        itemId,
        expectedVersion: current.version,
        expected: {
          state: current.state,
          providerAttemptSequence: current.providerAttemptSequence,
          providerContactId: current.providerContactId ?? null,
          providerExternalLeadId: current.providerExternalLeadId ?? null,
        },
        set: {
          state: "terminal",
          activeAttempt: false,
          sourcePool: null,
          reservedAgentId: null,
          speedOverrideAgentId: null,
          reservedAt: null,
          reservationExpiresAt: null,
          freshDeadlineAt: null,
          reservationReason: "historical-terminal-outcome-enforced",
          packetId: null,
          deliveryAgentId: null,
          provider: null,
          providerContactId: null,
          providerExternalLeadId: null,
          providerAcceptedAt: null,
          providerCompletedAt: null,
          providerCallId: null,
          providerPostState: null,
          providerPostLeaseId: null,
          providerPostLeaseExpiresAt: null,
          lastOutcome: outcome,
          nextContactAt: null,
          terminalAt,
          metadata,
        },
      });
      if (terminated) {
        const deliveryAgentId = String(current.deliveryAgentId || "").trim().toLowerCase();
        if (deliveryAgentId) {
          const agent = await repository.getAgentById(deliveryAgentId);
          if (agent) {
            await repository.compareAndSetAgent({
              agentId: deliveryAgentId,
              expectedVersion: agent.version,
              set: { estimatedOutstanding: Math.max(0, Number(agent.estimatedOutstanding || 0) - 1) },
            });
          }
        }
        return { ...local, item: terminated };
      }
    }
    throw new Error("historical-terminal-block-enforcement-conflict");
  }

  async function completeDownstream(event, local, { onProviderCleanup = null } = {}) {
    if (local.status === "duplicate") return local.event;
    let currentEvent = local.event;
    const actions = local.actions || [];
    try {
      const providerAttemptKey = currentEvent.eventType === "call_done"
        ? buildProviderAttemptKey(currentEvent)
        : null;
      const effectContext = local.effectContext || currentEvent.effectContext || null;
      if (local.historicalAttempt === true && !effectContext) {
        throw new Error("historical-effect-context-missing");
      }
      if (currentEvent.eventType === "call_done" && local.item && local.historicalAttempt !== true) {
        const itemId = stableWorkItemId(local.item);
        const currentItem = await repository.getItemById(itemId);
        const contactId = String(currentEvent.providerContactId || "").trim();
        const externalId = String(currentEvent.providerExternalLeadId || "").trim();
        const currentContactId = String(currentItem?.providerContactId || "").trim();
        const currentExternalId = String(currentItem?.providerExternalLeadId || "").trim();
        const currentAttemptNumber = Number(currentItem?.providerAttemptSequence || 0);
        if (contactId
          && externalId
          && currentContactId === contactId
          && currentExternalId === externalId
          && currentAttemptNumber === Number(currentEvent.resolvedAttemptNumber || 0)) {
          // Production lets PhoneBurner recycle an ordinary nonterminal contact
          // while another same-day attempt remains. Terminal/capped/ineligible
          // contacts are removed here by exact provider identity. The legacy
          // estimate-only compatibility surface cannot account for native
          // recycling, so it retains its old delete/repost lifecycle.
          const retainForNativeRecycle = providerInventoryAuthoritative === true
            && shouldRetainCompletedProviderContact(currentItem, {
              now: local.effectContext?.completedAt || currentEvent.receivedAt || atNow(),
              evaluatedAt: atNow(),
              maximumDailyAttempts,
            });
          if (!retainForNativeRecycle) {
            const removed = await runProviderPostTurn(() => phoneBurner.deleteContact(contactId));
            if (removed?.ok !== true && Number(removed?.httpStatus) !== 404) {
              noteProviderInventoryBackpressure(removed);
              const error = new Error("provider-contact-delete-failed");
              if (Number.isFinite(Number(removed?.retryAfterMs))) {
                error.retryAfterMs = Number(removed.retryAfterMs);
              }
              throw error;
            }
          }
          const clearedProviderFields = retainForNativeRecycle
            ? { providerCallId: null }
            : {
              providerContactId: null,
              providerExternalLeadId: null,
              providerAcceptedAt: null,
              providerCompletedAt: null,
              providerCallId: null,
              providerPostState: null,
              providerPostLeaseId: null,
              providerPostLeaseExpiresAt: null,
            };
          const cleared = await repository.compareAndSetItem({
            itemId,
            expectedVersion: currentItem.version,
            expected: {
              ...(retainForNativeRecycle ? {
                state: "follow_up_wait",
                providerExternalLeadId: externalId,
                providerCallId: currentItem.providerCallId ?? null,
              } : {}),
              providerContactId: contactId,
              providerAttemptSequence: currentEvent.resolvedAttemptNumber,
            },
            set: clearedProviderFields,
          });
          if (!cleared) {
            const latest = await repository.getItemById(itemId);
            const latestContactId = String(latest?.providerContactId || "").trim();
            const latestExternalId = String(latest?.providerExternalLeadId || "").trim();
            const newerRetainedCallOwnsIdentity = retainForNativeRecycle
              && latestContactId === contactId
              && latestExternalId === externalId
              && String(latest?.providerCallId || "").trim()
                !== String(currentItem.providerCallId || "").trim();
            if (newerRetainedCallOwnsIdentity || !latestContactId) {
              local = { ...local, item: latest };
            } else if (latestContactId !== contactId
              || Number(latest?.providerAttemptSequence || 0) !== Number(currentEvent.resolvedAttemptNumber || 0)) {
              throw new Error("provider-contact-delete-commit-conflict");
            } else {
              const retriedClear = await repository.compareAndSetItem({
                itemId,
                expectedVersion: latest.version,
                expected: {
                  ...(retainForNativeRecycle ? {
                    state: "follow_up_wait",
                    providerExternalLeadId: externalId,
                    providerCallId: latest.providerCallId ?? null,
                  } : {}),
                  providerContactId: contactId,
                  providerAttemptSequence: currentEvent.resolvedAttemptNumber,
                },
                set: clearedProviderFields,
              });
              if (!retriedClear) throw new Error("provider-contact-delete-commit-conflict");
              local = { ...local, item: retriedClear };
            }
          } else {
            local = { ...local, item: cleared };
          }
        }
      }
      if (typeof onProviderCleanup === "function" && local.historicalAttempt !== true) {
        await onProviderCleanup({
          agentId: String(local.item?.deliveryAgentId || "").trim().toLowerCase() || null,
          item: local.item,
          event: currentEvent,
        });
      }
      local = await cancelNewerAttemptForHistoricalTerminal(currentEvent, local);
      local = await enforceDeferredHistoricalTerminalBlock(local);
      for (const actionName of actions) {
        const handler = actionHandlers[actionName];
        if (typeof handler !== "function") throw new Error("action-handler-missing");
        const attemptContext = local.attemptContext || providerAttemptContext(
          local.item || {},
          currentEvent,
          currentEvent.resolvedAttemptNumber,
        );
        await handler({
          action: actionName,
          itemId: local.item ? stableWorkItemId(local.item) : currentEvent.resolvedItemId,
          domain: local.item?.domain,
          caseId: local.item?.caseId,
          agentId: local.effectAgentId || local.item?.deliveryAgentId,
          provider: providerName,
          providerCallId: currentEvent.providerCallId,
          providerAttemptKey,
          normalizedOutcome: local.actionOutcome || currentEvent.normalizedOutcome,
          connected: currentEvent.safePayload?.connected === true
            ? true
            : currentEvent.safePayload?.connected === false ? false : null,
          historicalAttempt: local.historicalAttempt === true,
          resolvedAttemptNumber: Number(currentEvent.resolvedAttemptNumber || 0),
          completedAt: local.historicalAttempt === true
            ? effectContext.completedAt
            : (local.item?.lastContactAt || currentEvent.receivedAt),
          dailyAttemptDateKey: local.historicalAttempt === true
            ? effectContext.dailyAttemptDateKey
            : local.item?.dailyAttemptDateKey,
          dailyAttemptCount: local.historicalAttempt === true
            ? effectContext.dailyAttemptCount
            : local.item?.dailyAttemptCount,
          totalAttemptCount: local.item?.totalAttemptCount,
          nextContactAt: local.historicalAttempt === true
            ? effectContext.nextContactAt
            : local.item?.nextContactAt,
          leadReceivedAt: local.item?.receivedAt,
          normalizedPhone: local.item?.normalizedPhone,
          firstName: local.item?.metadata?.firstName || null,
          lastName: local.item?.metadata?.lastName || null,
          originPool: effectContext?.originPool || local.item?.sourcePool || "unknown",
          callStartedAt: attemptContext?.callBeginAt || attemptContext?.acceptedAt || null,
          durationSeconds: currentEvent.safePayload?.durationSeconds ?? null,
          recordingUrl: recordingLocatorOf(currentEvent),
          idempotencyKey: `${providerName}:${providerAttemptKey}:${actionName}`,
        });
      }
      const appliedAt = atNow();
      return repository.compareAndSetEvent({
        eventId: String(currentEvent._id),
        expectedVersion: currentEvent.version,
        expected: {
          status: "processing",
          processingLeaseId: currentEvent.processingLeaseId,
          localAppliedAt: { $ne: null },
        },
        set: {
          status: "completed",
          downstreamAppliedAt: appliedAt,
          processedAt: appliedAt,
          nextAttemptAt: null,
          processingLeaseId: null,
          processingLeaseExpiresAt: null,
          lastError: null,
        },
      });
    } catch (error) {
      const retryAfterMs = Number(error?.retryAfterMs);
      const delay = Number.isFinite(retryAfterMs)
        ? Math.max(retryDuration, retryAfterMs)
        : retryDuration;
      return repository.compareAndSetEvent({
        eventId: String(currentEvent._id),
        expectedVersion: currentEvent.version,
        expected: {
          status: "processing",
          processingLeaseId: currentEvent.processingLeaseId,
          localAppliedAt: { $ne: null },
        },
        set: {
          status: "failed",
          nextAttemptAt: new Date(atNow().getTime() + delay),
          processingLeaseId: null,
          processingLeaseExpiresAt: null,
          lastError: "downstream-action-failed",
        },
      });
    }
  }

  async function refillAgent(agentId, {
    onWorkDurable = null,
    physicalOutstanding = null,
  } = {}) {
    const id = String(agentId || "").trim().toLowerCase();
    if (legacyOperatorSurfaceEnabled !== true) return legacyOperatorDisabled(id);
    if (enabled !== true || actionsEnabled !== true || refillEnabled !== true) {
      return { status: "refill-disabled", agentId: id, accepted: 0 };
    }
    const policy = agentPolicy(id);
    const agent = policy ? await repository.getAgentById(id) : null;
    if (!policy || !agent || policy.enabled !== true || agent.enabled !== true) {
      return { status: "agent-disabled", agentId: id, accepted: 0 };
    }
    const activeUntil = agent.activeUntil ? parseDate(agent.activeUntil, "activeUntil") : null;
    if (agent.shiftEnabled !== true || !activeUntil || activeUntil.getTime() <= atNow().getTime()) {
      return { status: "activity-not-proven", agentId: id, accepted: 0 };
    }
    const physicalCount = physicalOutstanding == null
      ? null
      : nonNegativeInteger(physicalOutstanding, "physicalOutstanding");
    const items = physicalCount == null
      ? await repository.listAgentDeliveryItems(id)
      : await listPendingProviderPosts(id);
    const projection = physicalCount == null
      ? reconstructAgentProjection(items, { agentId: id })
      : { reliable: true, estimatedOutstanding: physicalCount };
    const acceptedInFlight = physicalCount == null
      ? items.filter((item) => (
        String(item.state || "") === "packetized"
        && !String(item.providerContactId || "").trim()
      )).length
      : items.length;
    let liveRefillRequest = agent.openRefillRequest === true;
    if (liveRefillRequest && agent.refillLeaseExpiresAt) {
      try {
        liveRefillRequest = parseDate(
          agent.refillLeaseExpiresAt,
          "refillLeaseExpiresAt",
        ).getTime() > atNow().getTime();
      } catch {
        liveRefillRequest = true;
      }
    }
    const decision = computeRefillDecision({
      providerBufferTarget: policy.providerBufferTarget,
      refillAtOrBelow: policy.refillAtOrBelow,
      projection: physicalCount == null
        ? projection
        : { reliable: true, estimatedOutstanding: physicalCount },
      acceptedInFlight,
      openRefillRequest: liveRefillRequest,
    });
    if (!decision.shouldOpenRefill) {
      return { status: decision.reason, agentId: id, accepted: 0, deficit: decision.deficit };
    }
    const refillRequestId = `refill-${randomUUID()}`;
    const leased = await repository.acquireRefillRequest({
      agentId: id,
      expectedVersion: agent.version,
      refillRequestId,
      requestedAt: atNow(),
      leaseMs: refillLeaseDuration,
    });
    if (!leased) return { status: "refill-lock-busy", agentId: id, accepted: 0 };
    let result;
    let refillReleased = false;
    const releaseOwnedRefill = async () => {
      if (refillReleased) return true;
      const latest = await repository.getAgentById(id);
      if (latest?.openRefillRequest !== true || latest.refillRequestId !== refillRequestId) {
        return false;
      }
      const released = await repository.releaseRefillRequest({
        agentId: id,
        expectedVersion: latest.version,
        refillRequestId,
      });
      refillReleased = Boolean(released);
      return refillReleased;
    };
    try {
      result = await fillAgent(id, {
        explicit: false,
        reason: "low-water-refill",
        requestedCount: physicalCount == null ? null : decision.deficit,
        onWorkDurable: async (details) => {
          if (details?.atTarget === true && !await releaseOwnedRefill()) {
            throw new Error("refill lock release conflict");
          }
          if (typeof onWorkDurable === "function") await onWorkDurable(details);
        },
      });
      return result;
    } finally {
      await releaseOwnedRefill();
    }
  }

  async function readAgentProviderOutstanding(agentId, { repairEstimate = true } = {}) {
    const id = String(agentId || "").trim().toLowerCase();
    const policy = agentPolicy(id);
    if (!policy) return { status: "unknown-agent", agentId: id, reliable: false, count: null };
    if (typeof phoneBurner?.getFolderCount !== "function") {
      return { status: "folder-count-unavailable", agentId: id, reliable: false, count: null };
    }
    const inventoryClock = providerPostClock();
    if (inventoryClock < providerInventoryCooldownUntilMs) {
      return { status: "provider-backpressure", agentId: id, reliable: false, count: null };
    }
    if (providerInventoryCooldownUntilMs > 0) {
      providerInventoryCooldownUntilMs = 0;
      runtimeState.providerInventoryCooldownUntil = null;
    }
    // Capture the CAS version before the provider read. A concurrent Call End
    // or acceptance must win instead of being overwritten by this older
    // physical snapshot.
    const estimateSnapshot = repairEstimate === true
      ? await repository.getAgentById(id)
      : null;
    const readPool = () => phoneBurner.getFolderCount(policy.providerConfig.distributionFolderId);
    const distribution = await readPool();
    if (distribution?.ok !== true) {
      noteProviderInventoryBackpressure(distribution);
      return { status: "folder-count-failed", agentId: id, reliable: false, count: null };
    }
    // Only the Pool is callable inventory. Consumer may still contain rows
    // PhoneBurner has already pulled into a session, so counting it here can
    // leave an agent visibly empty while suppressing refill.
    let count = nonNegativeInteger(Number(distribution.count || 0), "provider pool count");
    if (count <= SIMPLE_POOL_LOW_WATER) {
      // At the refill boundary, require two agreeing Pool reads. Consumer is
      // intentionally irrelevant: PhoneBurner owns it after pulling a contact
      // from Pool into a dial session.
      const confirmedDistribution = await readPool();
      if (confirmedDistribution?.ok !== true) {
        noteProviderInventoryBackpressure(confirmedDistribution);
        return { status: "folder-count-confirmation-failed", agentId: id, reliable: false, count: null };
      }
      const confirmedCount = nonNegativeInteger(
        Number(confirmedDistribution.count || 0),
        "confirmed provider pool count",
      );
      if (confirmedCount !== count) {
        return { status: "folder-count-unstable", agentId: id, reliable: false, count: null };
      }
      count = confirmedCount;
    }
    let repaired = false;
    if (repairEstimate === true && estimateSnapshot) {
      if (Number(estimateSnapshot.estimatedOutstanding || 0) === count) repaired = true;
      else repaired = Boolean(await repository.compareAndSetAgent({
        agentId: id,
        expectedVersion: estimateSnapshot.version,
        set: { estimatedOutstanding: count },
      }));
    }
    return {
      status: repairEstimate === true && !repaired ? "estimate-repair-conflict" : "counted",
      agentId: id,
      reliable: repairEstimate !== true || repaired,
      count,
      repaired,
    };
  }

  function refreshAgentCapacity(agentId, {
    waitForCompletion = true,
    requireActiveShift = false,
    trigger = "manual",
  } = {}) {
    const id = String(agentId || "").trim().toLowerCase();
    const existing = physicalRefreshesByAgent.get(id);
    if (existing) return waitForCompletion ? existing.completion : existing.durable;
    let durableResolved = false;
    let resolveDurable;
    const durable = new Promise((resolve) => {
      resolveDurable = (value) => {
        if (durableResolved) return;
        durableResolved = true;
        resolve(value);
      };
    });
    const handle = { durable, completion: null };
    handle.completion = (async () => {
      const result = await withAgentPoolOperation(
        id,
        "ordinary_refill",
        async ({ agent, renew }) => {
          if (refillEnabled !== true || providerInventoryAuthoritative !== true) {
            return { status: "physical-refill-disabled", agentId: id, accepted: 0 };
          }
          if (agent.enabled !== true || agent.operatorPaused === true) {
            return { status: "agent-not-refillable", agentId: id, accepted: 0 };
          }
          if (requireActiveShift === true && agent.shiftEnabled !== true) {
            return { status: "agent-shift-disabled", agentId: id, accepted: 0 };
          }
          const physical = await readAgentProviderOutstanding(id, { repairEstimate: true });
          if (physical.reliable !== true) {
            return {
              status: physical.status,
              agentId: id,
              accepted: 0,
              reliable: false,
              retryable: true,
            };
          }
          if (Number(physical.count) > SIMPLE_POOL_LOW_WATER) {
            return {
              status: "pool-above-low-water",
              agentId: id,
              accepted: 0,
              physicalCount: physical.count,
            };
          }
          await renew();
          const posted = await postTopOfQueueOnce(id, { count: SIMPLE_PACKET_SIZE });
          return { ...posted, trigger, physicalCount: physical.count };
        },
      );
      resolveDurable(result);
      return result;
    })().catch((error) => {
      const result = {
        status: "capacity-refresh-failed",
        agentId: id,
        accepted: 0,
        reliable: false,
        retryable: true,
      };
      resolveDurable(result);
      log("error", "lead_delivery.capacity_refresh_failed", {
        agentId: id,
        reason: String(error?.code || error?.name || "capacity-refresh-failed").slice(0, 80),
      });
      return result;
    }).finally(() => {
      if (physicalRefreshesByAgent.get(id) === handle) physicalRefreshesByAgent.delete(id);
    });
    physicalRefreshesByAgent.set(id, handle);
    return waitForCompletion ? handle.completion : handle.durable;
  }

  function launchBackgroundRefill(agentId) {
    const id = String(agentId || "").trim().toLowerCase();
    if (legacyOperatorSurfaceEnabled !== true) {
      const result = legacyOperatorDisabled(id);
      const completion = Promise.resolve(result);
      return { requestedAgain: false, durable: completion, completion };
    }
    const existing = backgroundRefillsByAgent.get(id);
    if (existing) {
      existing.requestedAgain = true;
      return existing;
    }
    let durableResolved = false;
    let resolveDurable;
    const durable = new Promise((resolve) => {
      resolveDurable = () => {
        if (durableResolved) return;
        durableResolved = true;
        resolve();
      };
    });
    const handle = { durable, completion: null, requestedAgain: false };
    const completion = Promise.resolve().then(() => refillAgent(id, {
      onWorkDurable: resolveDurable,
    })).catch(() => {
      log("error", "lead_delivery.background_refill_failed", {
        agentId: id,
        reason: "background-refill-failed",
      });
      return { status: "background-refill-failed", agentId: id, accepted: 0 };
    }).finally(() => {
      resolveDurable();
      backgroundRefills.delete(completion);
      if (backgroundRefillsByAgent.get(id) === handle) backgroundRefillsByAgent.delete(id);
      if (handle.requestedAgain && providerPostAccepting) launchBackgroundRefill(id);
    });
    handle.completion = completion;
    backgroundRefills.add(completion);
    backgroundRefillsByAgent.set(id, handle);
    return handle;
  }

  async function completeRecordingEvidenceOnly(event, local) {
    const handler = actionHandlers.record_daily_dial;
    const providerAttemptKey = buildProviderAttemptKey(event);
    const effectContext = local.effectContext || event.effectContext || null;
    const attemptContext = local.attemptContext || providerAttemptContext(
      local.item || {},
      event,
      event.resolvedAttemptNumber,
    );
    try {
      if (typeof handler !== "function") throw new Error("record-daily-dial-handler-missing");
      await handler({
        action: "record_daily_dial",
        itemId: local.item ? stableWorkItemId(local.item) : event.resolvedItemId,
        domain: local.item?.domain,
        caseId: local.item?.caseId,
        agentId: local.effectAgentId || local.item?.deliveryAgentId,
        provider: providerName,
        providerCallId: event.providerCallId,
        providerAttemptKey,
        normalizedOutcome: local.actionOutcome || event.normalizedOutcome,
        connected: event.safePayload?.connected === true
          ? true
          : event.safePayload?.connected === false ? false : null,
        historicalAttempt: local.historicalAttempt === true,
        resolvedAttemptNumber: Number(event.resolvedAttemptNumber || 0),
        completedAt: local.historicalAttempt === true
          ? effectContext?.completedAt
          : (local.item?.lastContactAt || event.receivedAt),
        dailyAttemptDateKey: local.historicalAttempt === true
          ? effectContext?.dailyAttemptDateKey
          : local.item?.dailyAttemptDateKey,
        dailyAttemptCount: local.historicalAttempt === true
          ? effectContext?.dailyAttemptCount
          : local.item?.dailyAttemptCount,
        totalAttemptCount: local.item?.totalAttemptCount,
        nextContactAt: local.historicalAttempt === true
          ? effectContext?.nextContactAt
          : local.item?.nextContactAt,
        leadReceivedAt: local.item?.receivedAt,
        normalizedPhone: local.item?.normalizedPhone,
        firstName: local.item?.metadata?.firstName || null,
        lastName: local.item?.metadata?.lastName || null,
        originPool: effectContext?.originPool || local.item?.sourcePool || "unknown",
        callStartedAt: attemptContext?.callBeginAt || attemptContext?.acceptedAt || null,
        durationSeconds: event.safePayload?.durationSeconds ?? null,
        recordingUrl: recordingLocatorOf(event),
        idempotencyKey: `${providerName}:${providerAttemptKey}:record_daily_dial`,
      });
      const processedAt = atNow();
      const completed = await repository.compareAndSetEvent({
        eventId: String(event._id),
        expectedVersion: event.version,
        expected: {
          status: "processing",
          processingLeaseId: event.processingLeaseId,
          localAppliedAt: { $ne: null },
          downstreamAppliedAt: { $ne: null },
        },
        set: {
          status: "completed",
          processedAt,
          nextAttemptAt: null,
          processingLeaseId: null,
          processingLeaseExpiresAt: null,
          lastError: null,
        },
      });
      return { status: completed?.status || "conflict" };
    } catch (error) {
      const retryAfterMs = Number(error?.retryAfterMs);
      const delay = Number.isFinite(retryAfterMs)
        ? Math.max(retryDuration, retryAfterMs)
        : retryDuration;
      await repository.compareAndSetEvent({
        eventId: String(event._id),
        expectedVersion: event.version,
        expected: {
          status: "processing",
          processingLeaseId: event.processingLeaseId,
          localAppliedAt: { $ne: null },
          downstreamAppliedAt: { $ne: null },
        },
        set: {
          status: "failed",
          nextAttemptAt: new Date(atNow().getTime() + delay),
          processingLeaseId: null,
          processingLeaseExpiresAt: null,
          lastError: "recording-evidence-projection-failed",
        },
      });
      return { status: "failed" };
    }
  }

  async function processLeasedEvent(event, {
    waitForRefillCompletion = true,
    allowProviderCapacityWork = true,
    deferAsyncCapacityWork = false,
    deferredCapacity = null,
  } = {}) {
    let local;
    try {
      local = await applyEventLocally(event);
    } catch (error) {
      log("error", "lead_delivery.local_application_failed", {
        reason: String(error?.message || error?.code || error?.name || "local-application-failed"),
      });
      await repository.compareAndSetEvent({
        eventId: String(event._id),
        expectedVersion: event.version,
        expected: { status: "processing", processingLeaseId: event.processingLeaseId },
        set: {
          status: "failed",
          nextAttemptAt: new Date(atNow().getTime() + retryDuration),
          processingLeaseId: null,
          processingLeaseExpiresAt: null,
          lastError: "local-application-failed",
        },
      });
      return { status: "local-failed" };
    }
    if (local.status === "review") return { status: "review" };
    if (local.status === "completed") return { status: "completed" };
    if (event.eventType === "call_done"
      && event.localAppliedAt
      && event.downstreamAppliedAt
      && recordingLocatorOf(event)) {
      return completeRecordingEvidenceOnly(event, local);
    }
    const completedEvent = await completeDownstream(local.event, local, {
      // In provider-authoritative mode, PhoneBurner removes the completed
      // attempt first. Only then may this owner count that agent's Pool and
      // decide whether to refill. The URL route never chooses the agent.
      onProviderCleanup: allowProviderCapacityWork === true && providerInventoryAuthoritative === true
        ? async ({ agentId }) => {
          if (!agentId) {
            const error = new Error("simple-refill-delivery-agent-missing");
            error.code = "SIMPLE_REFILL_AGENT_MISSING";
            throw error;
          }
          const refill = await refreshAgentCapacity(agentId, { trigger: "call_end" });
          if (refill?.retryable === true
            || SIMPLE_REFILL_RETRY_STATUSES.has(String(refill?.status || ""))) {
            const error = new Error(`simple-refill-${refill.status}`);
            error.code = refill?.reliable === false
              ? "SIMPLE_REFILL_COUNT_FAILED"
              : "SIMPLE_REFILL_POST_FAILED";
            throw error;
          }
          return refill;
        }
        : null,
    });
    const refillAgentId = allowProviderCapacityWork === true
      && local.needsRefill
      && providerInventoryAuthoritative !== true
      ? String(local.item.deliveryAgentId || "").trim().toLowerCase()
      : null;
    const backgroundRefill = refillAgentId && deferAsyncCapacityWork !== true
      ? launchBackgroundRefill(refillAgentId)
      : null;
    // The caller may return once replacement work is durably packetized; it
    // never has to wait through provider latency. stop() still drains the full
    // tracked completion before shutdown.
    if (backgroundRefill) await backgroundRefill.durable;
    if (backgroundRefill && waitForRefillCompletion) await backgroundRefill.completion;
    // A real Call End is fresh activity evidence. Wake the independent fresh
    // lane after the attempt is durable; ordinary refill success or failure
    // does not own this decision.
    const freshDispatchNeeded = allowProviderCapacityWork === true;
    const freshDispatch = freshDispatchNeeded && deferAsyncCapacityWork !== true
      ? wakeImmediateFresh()
      : null;
    if (deferAsyncCapacityWork === true) {
      if (!(deferredCapacity?.refillAgentIds instanceof Set)) {
        throw new TypeError("deferred capacity collector is required");
      }
      if (refillAgentId) deferredCapacity.refillAgentIds.add(refillAgentId);
      deferredCapacity.freshDispatch ||= freshDispatchNeeded;
    }
    return { status: completedEvent?.status || "conflict", freshDispatch };
  }

  async function drainEvents({
    limit = drainLimit,
    waitForRefillCompletion = true,
    allowProviderCapacityWork = true,
  } = {}) {
    if (enabled !== true) return { status: "disabled", seen: 0, processed: 0 };
    if (actionsEnabled !== true) {
      return { status: "actions-disabled", seen: 0, processed: 0 };
    }
    const events = await repository.listEventsForDrain({
      provider: providerName,
      limit: positiveInteger(limit, "limit"),
      now: atNow(),
    });
    let processed = 0;
    const results = [];
    const deferredCapacity = { refillAgentIds: new Set(), freshDispatch: false };
    for (const candidate of events) {
      const leased = await repository.acquireEventProcessingLease({
        eventId: String(candidate._id),
        expectedVersion: candidate.version,
        leaseId: `event-${randomUUID()}`,
        now: atNow(),
        leaseMs: eventLeaseDuration,
      });
      if (!leased) continue;
      const result = await processLeasedEvent(leased, {
        waitForRefillCompletion,
        allowProviderCapacityWork,
        // Finish every exact completion cleanup before replacement provider
        // work enters the shared writer lane. Otherwise one slow refill post
        // can sit ahead of the next event's exact contact deletion.
        deferAsyncCapacityWork: true,
        deferredCapacity,
      });
      results.push(result);
      processed += 1;
    }
    const refillHandles = [...deferredCapacity.refillAgentIds]
      .map((agentId) => launchBackgroundRefill(agentId));
    if (refillHandles.length) {
      await Promise.all(refillHandles.map((handle) => handle.durable));
      if (waitForRefillCompletion) {
        await Promise.all(refillHandles.map((handle) => handle.completion));
      }
    }
    if (deferredCapacity.freshDispatch) wakeImmediateFresh();
    return { status: "ok", seen: events.length, processed, results };
  }

  async function drainCapturedEvent(event, {
    waitForRefillCompletion = false,
    allowProviderCapacityWork = null,
  } = {}) {
    if (enabled !== true) return { status: "disabled", seen: 1, processed: 0 };
    if (actionsEnabled !== true) return { status: "actions-disabled", seen: 1, processed: 0 };
    const eventId = String(event?._id || "").trim();
    const expectedVersion = Number(event?.version);
    if (!eventId || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
      return { status: "invalid-event", seen: 1, processed: 0 };
    }
    const leased = await repository.acquireEventProcessingLease({
      eventId,
      expectedVersion,
      leaseId: `event-${randomUUID()}`,
      now: atNow(),
      leaseMs: eventLeaseDuration,
    });
    if (!leased) return { status: "lease-not-acquired", seen: 1, processed: 0 };
    const result = await processLeasedEvent(leased, {
      waitForRefillCompletion,
      allowProviderCapacityWork: allowProviderCapacityWork == null
        ? deliveryWindowOpen(atNow()) === true
        : allowProviderCapacityWork === true,
    });
    return { status: result.status, seen: 1, processed: 1, results: [result] };
  }

  function withDayStartMetadata(entity, patch) {
    const metadata = entity?.metadata && typeof entity.metadata === "object" && !Array.isArray(entity.metadata)
      ? clone(entity.metadata)
      : {};
    const existing = metadata[DAY_START_METADATA_KEY]
      && typeof metadata[DAY_START_METADATA_KEY] === "object"
      && !Array.isArray(metadata[DAY_START_METADATA_KEY])
      ? metadata[DAY_START_METADATA_KEY]
      : {};
    metadata[DAY_START_METADATA_KEY] = { ...existing, ...clone(patch) };
    return metadata;
  }

  async function setAgentDayStartState(agentId, dateKey, status, at, details = {}) {
    const id = String(agentId || "").trim().toLowerCase();
    const policy = agentPolicy(id);
    const activeUntil = new Date(
      at.getTime() + positiveInteger(
        policy?.activeEvidenceMinutes || configuration.defaults.activeEvidenceMinutes,
        "activeEvidenceMinutes",
      ) * 60_000,
    );
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const agent = await repository.getAgentById(id);
      if (!agent || agent.enabled !== true) return null;
      const marker = agent.metadata?.[DAY_START_METADATA_KEY];
      if (marker?.dateKey === dateKey && marker?.status === "completed") return agent;
      const completed = status === "completed";
      const updated = await repository.compareAndSetAgent({
        agentId: id,
        expectedVersion: agent.version,
        set: {
          operatorPaused: false,
          operatorChangedAt: at,
          shiftEnabled: true,
          activeUntil,
          openRefillRequest: false,
          refillRequestId: null,
          refillLeaseExpiresAt: null,
          metadata: withDayStartMetadata(agent, {
            dateKey,
            status,
            lastAttemptAt: at,
            ...(completed ? { completedAt: at } : {}),
            reason: details.reason == null ? null : String(details.reason).slice(0, 64),
            accepted: nonNegativeInteger(details.accepted ?? 0, "day start accepted"),
          }),
        },
      });
      if (updated) return updated;
    }
    return null;
  }

  async function buildDayQueue() {
    // The 7:50 build intentionally completes the bounded source scan before
    // distributing untouched work. This prevents rows beyond the first page
    // from being permanently stranded while the minute tick remains bounded.
    const summary = {
      status: "building",
      batches: 0,
      read: 0,
      inserted: 0,
      refreshed: 0,
      blocked: 0,
      skipped: 0,
    };
    for (let batchNumber = 1; batchNumber <= DAY_START_MAX_SOURCE_BATCHES; batchNumber += 1) {
      const batch = await ingestSerial();
      summary.batches = batchNumber;
      summary.read += Number(batch?.read || 0);
      summary.inserted += Number(batch?.inserted || 0);
      summary.refreshed += Number(batch?.refreshed || 0);
      summary.blocked += Number(batch?.blocked || 0);
      summary.skipped += Number(batch?.skipped || 0);
      if (String(batch?.status || "") !== "ok") {
        return { ...summary, status: String(batch?.status || "queue-build-failed") };
      }
      if (batch?.done === true) return { ...summary, status: "built", done: true };
      if (Number(batch?.read || 0) === 0 && batch?.progressed !== true) {
        return { ...summary, status: "queue-build-stalled", done: false };
      }
    }
    return { ...summary, status: "queue-build-batch-limit", done: false };
  }

  async function dispatchMorningUntouched(agentIds) {
    const available = [...new Set(agentIds.map((value) => String(value || "").trim().toLowerCase()).filter(Boolean))];
    const exhausted = new Set();
    const countsByAgent = Object.fromEntries(available.map((agentId) => [agentId, 0]));
    let accepted = 0;
    const maximum = 5_000;
    while (accepted < maximum && exhausted.size < available.length) {
      const eligible = available.filter((agentId) => !exhausted.has(agentId));
      const pick = await readNextFairAgent("morning-untouched", eligible);
      if (pick.status !== "picked") break;
      const result = await postTopOfQueue(pick.agentId, {
        count: 1,
        untouchedOnly: true,
        operationKind: "day_start",
      });
      const posted = nonNegativeInteger(result?.accepted ?? 0, "morning untouched accepted");
      if (posted > 0) {
        countsByAgent[pick.agentId] += posted;
        const committed = await commitAcceptedFairAgent("morning-untouched", pick);
        if (!committed) {
          return {
            status: "accepted-cursor-conflict",
            accepted: accepted + posted,
            countsByAgent,
          };
        }
        accepted += posted;
        continue;
      }
      if (["queue-exhausted", "no-candidates"].includes(String(result?.status || ""))) {
        exhausted.add(pick.agentId);
        continue;
      }
      return {
        status: String(result?.status || "morning-post-failed"),
        accepted,
        countsByAgent,
      };
    }
    return {
      status: accepted >= maximum ? "bounded" : "completed",
      accepted,
      countsByAgent,
    };
  }

  async function runDayStart(value = atNow()) {
    const at = parseDate(value, "value");
    const dateKey = getPacificDateKey(at);
    runtimeState.dayStartDateKey = dateKey;
    runtimeState.dayStartLastAttemptAt = at;
    if (deliveryWindowOpen(at) !== true) {
      runtimeState.dayStartStatus = "outside-delivery-window";
      runtimeState.dayStartAgentResults = [];
      return { status: "outside-delivery-window", dateKey, agentResults: [] };
    }
    if (enabled !== true || actionsEnabled !== true) {
      runtimeState.dayStartStatus = "disabled";
      runtimeState.dayStartAgentResults = [];
      return { status: "disabled", dateKey, agentResults: [] };
    }

    // Morning launch owns only the new business day. Prior-day reporting
    // reconciliation belongs to day close and must never delay queue creation.
    const priorDayPersistence = {
      status: "not-run-morning",
      rows: 0,
      persisted: 0,
      attempts: 0,
    };

    await syncConfiguredAgents();
    const agentIds = [...validation.enabledAgentIds];
    const persisted = await Promise.all(agentIds.map((agentId) => repository.getAgentById(agentId)));
    const incompleteIds = persisted
      .filter((agent) => agent?.metadata?.[DAY_START_METADATA_KEY]?.dateKey !== dateKey
        || agent?.metadata?.[DAY_START_METADATA_KEY]?.status !== "completed")
      .map((agent) => String(agent?.agentId || "").trim().toLowerCase())
      .filter(Boolean);
    if (incompleteIds.length === 0) {
      runtimeState.dayStartStatus = "completed";
      runtimeState.dayStartLastCompletedAt = at;
      runtimeState.dayStartAgentResults = [];
      return {
        status: "already-completed",
        dateKey,
        priorDayPersistence,
        agentResults: [],
      };
    }

    const activatedIds = [];
    const agentResults = [];
    for (const agentId of incompleteIds) {
      const activated = await setAgentDayStartState(agentId, dateKey, "building", at, {
        reason: "queue-build",
      });
      if (activated) activatedIds.push(agentId);
      else agentResults.push({ agentId, status: "activation-conflict", accepted: 0 });
    }
    if (activatedIds.length === 0) {
      runtimeState.dayStartStatus = "activation-conflict";
      runtimeState.dayStartAgentResults = clone(agentResults);
      return { status: "activation-conflict", dateKey, priorDayPersistence, agentResults };
    }

    // 7:50 owns the untouched intake sweep. LeadCadence says whether a voice
    // touch exists; Logics status membership supplies current eligibility.
    // CaseProfile is deliberately not a prerequisite for a first call.
    let morningStatusRefresh = { status: "not-configured", scanned: 0, refreshed: 0 };
    if (refreshUntouchedSourceStatuses) {
      try {
        morningStatusRefresh = {
          status: "completed",
          ...await refreshUntouchedSourceStatuses({ now: at }),
        };
      } catch (error) {
        runtimeState.dayStartStatus = "morning-status-refresh-failed";
        runtimeState.dayStartAgentResults = clone(agentResults);
        return {
          status: "morning-status-refresh-failed",
          dateKey,
          priorDayPersistence,
          morningStatusRefresh: { status: "failed" },
          agentResults,
        };
      }
    }
    const sourceRefresh = await buildDayQueue();
    if (sourceRefresh.status !== "built") {
      runtimeState.dayStartStatus = sourceRefresh.status;
      runtimeState.dayStartAgentResults = clone(agentResults);
      return {
        status: sourceRefresh.status,
        dateKey,
        priorDayPersistence,
        morningStatusRefresh,
        queueBuild: { ...sourceRefresh, fullScan: true },
        agentResults,
      };
    }
    const queueBuild = { ...sourceRefresh, status: "ready", fullScan: true };
    const morningUntouched = await dispatchMorningUntouched(activatedIds);
    if (morningUntouched.status !== "completed") {
      runtimeState.dayStartStatus = `morning-untouched-${morningUntouched.status}`;
      runtimeState.dayStartAgentResults = clone(agentResults);
      return {
        status: runtimeState.dayStartStatus,
        dateKey,
        priorDayPersistence,
        morningStatusRefresh,
        morningUntouched,
        queueBuild,
        agentResults,
      };
    }

    for (const agentId of activatedIds) {
      const morningAccepted = nonNegativeInteger(
        morningUntouched.countsByAgent?.[agentId] ?? 0,
        "morning untouched agent accepted",
      );
      const physical = await readAgentProviderOutstanding(agentId, { repairEstimate: false });
      if (physical.reliable !== true) {
        agentResults.push({ agentId, status: physical.status, accepted: morningAccepted });
        continue;
      }
      if (Number(physical.count) > SIMPLE_POOL_LOW_WATER) {
        const marked = await setAgentDayStartState(agentId, dateKey, "completed", at, {
          reason: "already-stocked",
        });
        agentResults.push({
          agentId,
          status: marked ? "already-stocked" : "marker-conflict",
          accepted: morningAccepted,
        });
        continue;
      }
      const refill = await postTopOfQueue(agentId, {
        count: SIMPLE_PACKET_SIZE,
        operationKind: "day_start",
      });
      const refillAccepted = nonNegativeInteger(refill?.accepted ?? 0, "day start refill accepted");
      const accepted = morningAccepted + refillAccepted;
      const successful = refill?.status === "posted"
        || refill?.status === "queue-exhausted";
      if (!successful) {
        agentResults.push({ agentId, status: String(refill?.status || "start-refill-failed"), accepted });
        continue;
      }
      const marked = await setAgentDayStartState(agentId, dateKey, "completed", at, {
        reason: "morning-packet-posted",
        accepted,
      });
      agentResults.push({ agentId, status: marked ? "started" : "marker-conflict", accepted });
    }

    const verified = await Promise.all(agentIds.map((agentId) => repository.getAgentById(agentId)));
    const completed = verified.filter((agent) => (
      agent?.metadata?.[DAY_START_METADATA_KEY]?.dateKey === dateKey
      && agent?.metadata?.[DAY_START_METADATA_KEY]?.status === "completed"
    )).length;
    const status = completed === agentIds.length ? "completed" : "partial";
    runtimeState.dayStartStatus = status;
    runtimeState.dayStartAgentResults = clone(agentResults);
    if (status === "completed") runtimeState.dayStartLastCompletedAt = at;
    return {
      status,
      dateKey,
      priorDayPersistence,
      morningStatusRefresh,
      morningUntouched,
      queueBuild,
      completedAgents: completed,
      agentResults,
    };
  }

  function contactExternalIds(contact) {
    return new Set([
      String(contact?.leadId || "").trim(),
      ...(Array.isArray(contact?.customFields)
        ? contact.customFields.map((field) => String(field?.value || "").trim())
        : []),
      ...(Array.isArray(contact?.externalCrmData)
        ? contact.externalCrmData.map((entry) => String(entry?.externalId || "").trim())
        : []),
    ].filter(Boolean));
  }

  async function readAllFolderContacts(folderId) {
    if (typeof phoneBurner?.listFolderContacts !== "function") {
      return { ok: false, reason: "folder-read-unavailable", contacts: [] };
    }
    const contacts = [];
    let page = 1;
    let totalPages = null;
    while (totalPages == null || page <= totalPages) {
      const result = await phoneBurner.listFolderContacts(folderId, { page, pageSize: 100 });
      if (!result?.ok) {
        return {
          ok: false,
          reason: result?.reason || "folder-read-failed",
          httpStatus: Number(result?.httpStatus || 0),
          retryAfterMs: Number.isFinite(Number(result?.retryAfterMs))
            ? Number(result.retryAfterMs)
            : null,
          contacts: [],
        };
      }
      if (totalPages == null) totalPages = result.totalPages;
      else if (result.totalPages !== totalPages) return { ok: false, reason: "folder-read-changed", contacts: [] };
      contacts.push(...result.contacts);
      if (totalPages === 0 || page >= totalPages) break;
      page += 1;
    }
    return { ok: true, contacts };
  }

  function withProductivityRebalanceMetadata(entity, patch) {
    const metadata = entity?.metadata && typeof entity.metadata === "object" && !Array.isArray(entity.metadata)
      ? clone(entity.metadata)
      : {};
    const existing = metadata[PRODUCTIVITY_REBALANCE_METADATA_KEY]
      && typeof metadata[PRODUCTIVITY_REBALANCE_METADATA_KEY] === "object"
      && !Array.isArray(metadata[PRODUCTIVITY_REBALANCE_METADATA_KEY])
      ? metadata[PRODUCTIVITY_REBALANCE_METADATA_KEY]
      : {};
    metadata[PRODUCTIVITY_REBALANCE_METADATA_KEY] = { ...existing, ...clone(patch) };
    return metadata;
  }

  async function moveProductivityContact(item, sourceAgentId, targetAgentId, at, windowKey) {
    const sourcePolicy = agentPolicy(sourceAgentId);
    const targetPolicy = agentPolicy(targetAgentId);
    if (!sourcePolicy?.enabled || !targetPolicy?.enabled) return { status: "agent-configuration-missing" };
    const contactId = String(item?.providerContactId || "").trim();
    if (!contactId) return { status: "identity-unresolved" };
    const sourceFolderId = String(sourcePolicy.providerConfig.distributionFolderId || "").trim();
    const targetFolderId = String(targetPolicy.providerConfig.distributionFolderId || "").trim();
    const moveId = `productivity-${randomUUID()}`;
    const intended = await repository.compareAndSetItem({
      itemId: stableWorkItemId(item),
      expectedVersion: item.version,
      expected: {
        state: item.state,
        deliveryAgentId: sourceAgentId,
        providerContactId: contactId,
        providerExternalLeadId: item.providerExternalLeadId,
      },
      set: {
        metadata: withProductivityRebalanceMetadata(item, {
          moveId,
          windowKey,
          status: "move_pending",
          sourceAgentId,
          targetAgentId,
          requestedAt: at,
        }),
      },
    });
    if (!intended) return { status: "move-intent-conflict" };

    const moved = await runProviderPostTurn(async () => {
      const current = await phoneBurner.getContact(contactId);
      if (current?.ok !== true || String(current.contact?.contactId || "").trim() !== contactId) {
        return { status: "contact-read-failed", accepted: false };
      }
      if (String(current.contact?.folderId || "").trim() !== sourceFolderId) {
        return { status: "contact-left-source-pool", accepted: false };
      }
      const result = await phoneBurner.moveContact(contactId, targetFolderId);
      if (result?.ok === true && String(result.contactId || "").trim() === contactId) {
        return { status: "moved", accepted: true };
      }
      return {
        status: Number(result?.httpStatus) === 429 ? "rate-limited" : "provider-move-failed",
        accepted: false,
        ...(Number.isFinite(Number(result?.retryAfterMs))
          ? { retryAfterMs: Number(result.retryAfterMs) }
          : {}),
      };
    });
    if (moved?.accepted !== true) {
      await repository.compareAndSetItem({
        itemId: stableWorkItemId(intended),
        expectedVersion: intended.version,
        expected: { deliveryAgentId: sourceAgentId, providerContactId: contactId },
        set: {
          metadata: withProductivityRebalanceMetadata(intended, {
            status: moved?.status || "provider-move-failed",
            completedAt: atNow(),
          }),
        },
      });
      return { status: moved?.status || "provider-move-failed" };
    }

    const completedAt = atNow();
    const committed = await repository.compareAndSetItem({
      itemId: stableWorkItemId(intended),
      expectedVersion: intended.version,
      expected: {
        state: intended.state,
        deliveryAgentId: sourceAgentId,
        providerContactId: contactId,
        providerExternalLeadId: intended.providerExternalLeadId,
      },
      set: {
        deliveryAgentId: targetAgentId,
        packetId: moveId,
        reservationReason: "productivity-rebalance",
        metadata: withProductivityRebalanceMetadata(intended, {
          status: "moved",
          completedAt,
        }),
      },
      append: {
        providerAttemptHistory: [{
          attemptNumber: positiveInteger(intended.providerAttemptSequence, "providerAttemptSequence"),
          event: "provider_moved",
          provider: String(intended.provider || providerName).trim().toLowerCase(),
          providerExternalLeadId: String(intended.providerExternalLeadId || ""),
          providerContactId: contactId,
          providerCallId: String(intended.providerCallId || "") || null,
          deliveryAgentId: targetAgentId,
          packetId: moveId,
          occurredAt: completedAt,
          outcome: null,
          reason: "productivity-rebalance",
        }],
      },
    });
    if (committed) return { status: "moved", item: committed };

    const rollback = await runProviderPostTurn(async () => {
      const current = await phoneBurner.getContact(contactId);
      if (current?.ok !== true || String(current.contact?.contactId || "").trim() !== contactId) {
        return { status: "rollback-read-failed", accepted: false };
      }
      if (String(current.contact?.folderId || "").trim() !== targetFolderId) {
        return { status: "rollback-target-changed", accepted: false };
      }
      const result = await phoneBurner.moveContact(contactId, sourceFolderId);
      return result?.ok === true && String(result.contactId || "").trim() === contactId
        ? { status: "rolled-back", accepted: true }
        : { status: "rollback-failed", accepted: false };
    });
    return { status: rollback?.accepted === true ? "ownership-conflict-rolled-back" : "ownership-conflict" };
  }

  async function postProductivityAgedCushion(agentId, count, at) {
    const requested = positiveInteger(count, "count");
    const policy = agentPolicy(agentId);
    if (!policy?.enabled) return { status: "agent-configuration-missing", accepted: 0 };
    const candidates = [];
    for (const pool of [POOLS.FOLLOW_UP_DUE, POOLS.OLDER_AVAILABLE]) {
      const rows = await repository.listPacketCandidateItems({
        agentId,
        sourcePools: [pool],
        now: at,
        limit: 5000,
      });
      candidates.push(...rows.filter((item) => (
        leadAgeInPacificDays(item, at) >= PRODUCTIVITY_REBALANCE_MINIMUM_CUSHION_AGE_DAYS
      )));
    }
    candidates.sort((left, right) => {
      const ageDelta = leadAgeInPacificDays(right, at) - leadAgeInPacificDays(left, at);
      return ageDelta || compareStable(left, right);
    });
    let accepted = 0;
    const results = [];
    for (const item of candidates) {
      if (accepted >= requested) break;
      const state = String(item.state || "").trim().toLowerCase();
      const sourcePool = String(item.sourcePool || "").trim().toLowerCase();
      const expected = { state, sourcePool };
      if (state === "reserved") expected.reservedAgentId = agentId;
      const packetId = `productivity-cushion-${randomUUID()}`;
      const claimed = await repository.compareAndSetItem({
        itemId: stableWorkItemId(item),
        expectedVersion: item.version,
        expected,
        set: {
          state: "packetized",
          activeAttempt: true,
          packetId,
          deliveryAgentId: agentId,
          reservedAgentId: null,
          speedOverrideAgentId: null,
          reservedAt: null,
          reservationExpiresAt: null,
          reservationReason: "productivity-cushion",
          provider: providerName,
        },
      });
      if (!claimed) continue;
      const posted = await postPacketItem(claimed, policy);
      results.push({ status: posted.status, accepted: posted.accepted === true });
      if (posted.accepted === true) {
        accepted += 1;
        continue;
      }
      if (posted.status === "provider-rejected") continue;
      break;
    }
    return {
      status: accepted === requested ? "posted" : "cushion-incomplete",
      accepted,
      requested,
      results,
    };
  }

  async function cullAgentProductivityPool(agentId, targetAgentIds, at, windowKey, targetOffset) {
    const policy = agentPolicy(agentId);
    if (!policy?.enabled) return { status: "agent-configuration-missing", moved: 0, targetOffset };
    const localItems = await repository.listAgentDeliveryItems(agentId);
    if (localItems.some((item) => String(item.state || "").trim().toLowerCase() === "in_call")) {
      return { status: "in-call", moved: 0, targetOffset };
    }
    const folder = await readAllFolderContacts(policy.providerConfig.distributionFolderId);
    if (!folder.ok) {
      noteProviderInventoryBackpressure(folder);
      return { status: folder.reason || "folder-read-failed", moved: 0, targetOffset };
    }
    const localByContactId = new Map(localItems
      .map((item) => [String(item.providerContactId || "").trim(), item])
      .filter(([contactId]) => Boolean(contactId)));
    const poolItems = [];
    for (const contact of folder.contacts) {
      const contactId = String(contact?.contactId || "").trim();
      const item = localByContactId.get(contactId);
      if (!contactId || !item || String(item.deliveryAgentId || "").trim().toLowerCase() !== agentId) {
        return { status: "identity-unresolved", moved: 0, targetOffset };
      }
      poolItems.push(item);
    }
    const plan = planProductivityPoolCull(poolItems, { now: at });
    if (plan.status !== "planned") return { status: plan.status, moved: 0, targetOffset };
    if (plan.missingCushionCount === 0 && plan.removed.length === 0) {
      return { status: "already-cushioned", moved: 0, targetOffset };
    }
    let cushionAdded = 0;
    if (plan.missingCushionCount > 0) {
      const cushion = await postProductivityAgedCushion(agentId, plan.missingCushionCount, at);
      cushionAdded = cushion.accepted;
      if (cushion.accepted !== plan.missingCushionCount) {
        return {
          status: "cushion-incomplete",
          moved: 0,
          cushionAdded,
          cushionNeeded: plan.missingCushionCount,
          targetOffset,
        };
      }
    }
    let movedCount = 0;
    let offset = targetOffset;
    const results = [];
    for (const item of plan.removed) {
      const fairPick = await claimFairAgent("redistribution", targetAgentIds);
      if (fairPick.status !== "picked") {
        results.push({ status: fairPick.status, targetAgentId: null });
        break;
      }
      const targetAgentId = fairPick.agentId;
      const result = await moveProductivityContact(item, agentId, targetAgentId, at, windowKey);
      results.push({ status: result.status, targetAgentId });
      if (result.status === "moved") {
        movedCount += 1;
        continue;
      }
      if (["rate-limited", "provider-move-failed", "ownership-conflict"].includes(result.status)) break;
    }
    return {
      status: movedCount === plan.removed.length ? "culled" : "partial",
      moved: movedCount,
      retained: plan.retained.length,
      cushionAdded,
      targetOffset: offset,
      results,
    };
  }

  async function runProductivityRebalanceOnce(value = atNow(), { ignoreWarmup = false } = {}) {
    const at = parseDate(value, "value");
    if (productivityRebalanceEnabled !== true) return { status: "disabled", moved: 0 };
    if (enabled !== true || actionsEnabled !== true || refillEnabled !== true) {
      return { status: "delivery-disabled", moved: 0 };
    }
    if (deliveryWindowOpen(at) !== true) return { status: "delivery-window-closed", moved: 0 };
    if (ignoreWarmup !== true) {
      if (!productivityRebalanceStartedAt) return { status: "not-started", moved: 0 };
      if (at.getTime() - productivityRebalanceStartedAt.getTime() < PRODUCTIVITY_REBALANCE_INTERVAL_MS) {
        return { status: "warming", moved: 0 };
      }
    }
    const windowNumber = Math.floor(at.getTime() / PRODUCTIVITY_REBALANCE_INTERVAL_MS);
    const windowKey = String(windowNumber);
    if (productivityRebalanceLastWindowKey === windowKey) {
      return { status: "already-run", windowKey, moved: 0 };
    }
    runtimeState.productivityRebalanceStatus = "running";
    runtimeState.productivityRebalanceLastAttemptAt = at;
    const since = new Date(at.getTime() - PRODUCTIVITY_REBALANCE_INTERVAL_MS);
    const configuredAgents = (await repository.listAgents({ enabledOnly: true }))
      .filter((agent) => agentPolicy(agent.agentId)?.enabled === true)
      .filter((agent) => agent.operatorPaused !== true);
    const activity = [];
    for (const agent of configuredAgents) {
      const agentId = String(agent.agentId || "").trim().toLowerCase();
      const completed = await repository.countAgentCompletedAttemptsSince(agentId, since, { until: at });
      activity.push({ agentId, completed: nonNegativeInteger(completed, "completed") });
    }
    const targetAgentIds = activity
      .filter((entry) => entry.completed > 0)
      .sort((left, right) => right.completed - left.completed || left.agentId.localeCompare(right.agentId))
      .map((entry) => entry.agentId);
    if (targetAgentIds.length === 0) {
      productivityRebalanceLastWindowKey = windowKey;
      runtimeState.productivityRebalanceStatus = "no-active-targets";
      runtimeState.productivityRebalanceLastWindowKey = windowKey;
      runtimeState.productivityRebalanceLastCompletedAt = at;
      runtimeState.productivityRebalanceAgentResults = [];
      return { status: "no-active-targets", windowKey, moved: 0 };
    }
    const inactiveAgentIds = activity
      .filter((entry) => entry.completed === 0)
      .map((entry) => entry.agentId);
    let moved = 0;
    let targetOffset = 0;
    const agentResults = [];
    for (const agentId of inactiveAgentIds) {
      const result = await withAgentPoolOperations(
        [agentId, ...targetAgentIds],
        "productivity",
        async (operations) => {
          for (const operation of operations) await operation.renew();
          return cullAgentProductivityPool(agentId, targetAgentIds, at, windowKey, targetOffset);
        },
      );
      targetOffset = result.targetOffset;
      moved += Number(result.moved || 0);
      agentResults.push({
        agentId,
        status: result.status,
        moved: Number(result.moved || 0),
        cushionAdded: Number(result.cushionAdded || 0),
        cushionNeeded: Number(result.cushionNeeded || 0),
      });
    }
    productivityRebalanceLastWindowKey = windowKey;
    runtimeState.productivityRebalanceStatus = agentResults.some((entry) => (
      entry.status === "partial" || entry.status === "cushion-incomplete"
    ))
      ? "partial"
      : "completed";
    runtimeState.productivityRebalanceLastWindowKey = windowKey;
    runtimeState.productivityRebalanceLastCompletedAt = atNow();
    runtimeState.productivityRebalanceRemovedCount += moved;
    runtimeState.productivityRebalanceRedistributedCount += moved;
    runtimeState.productivityRebalanceAgentResults = clone(agentResults);
    return {
      status: runtimeState.productivityRebalanceStatus,
      windowKey,
      moved,
      activeAgents: targetAgentIds.length,
      inactiveAgents: inactiveAgentIds.length,
      agentResults,
    };
  }

  function runProductivityRebalance(value = atNow(), options = {}) {
    if (productivityRebalanceInFlight) return productivityRebalanceInFlight;
    const work = runProductivityRebalanceOnce(value, options).finally(() => {
      if (productivityRebalanceInFlight === work) productivityRebalanceInFlight = null;
    });
    productivityRebalanceInFlight = work;
    return work;
  }

  function withWorkingFolderDrainMetadata(entity, patch) {
    const metadata = entity?.metadata && typeof entity.metadata === "object" && !Array.isArray(entity.metadata)
      ? clone(entity.metadata)
      : {};
    const existing = metadata[END_OF_DAY_DRAIN_METADATA_KEY]
      && typeof metadata[END_OF_DAY_DRAIN_METADATA_KEY] === "object"
      && !Array.isArray(metadata[END_OF_DAY_DRAIN_METADATA_KEY])
      ? metadata[END_OF_DAY_DRAIN_METADATA_KEY]
      : {};
    metadata[END_OF_DAY_DRAIN_METADATA_KEY] = { ...existing, ...clone(patch) };
    return metadata;
  }

    async function pauseAgentForEndOfDayDrain(agentId, at) {
    const id = String(agentId || "").trim().toLowerCase();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const agent = await repository.getAgentById(id);
      if (!agent || agent.enabled !== true) return agent;
      const alreadyPaused = agent.operatorPaused === true
        && agent.shiftEnabled !== true
        && agent.activeUntil == null
        && agent.openRefillRequest !== true
        && agent.refillRequestId == null
        && agent.refillLeaseExpiresAt == null;
      if (alreadyPaused) return agent;
      const updated = await repository.compareAndSetAgent({
        agentId: id,
        expectedVersion: agent.version,
        set: {
          operatorPaused: true,
          operatorChangedAt: at,
          shiftEnabled: false,
          activeUntil: null,
          openRefillRequest: false,
          refillRequestId: null,
          refillLeaseExpiresAt: null,
        },
      });
      if (updated) return updated;
    }
    return null;
  }

  async function setAgentWorkingFolderDrainState(agentId, dateKey, status, at, details = {}) {
    const id = String(agentId || "").trim().toLowerCase();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const agent = await repository.getAgentById(id);
      if (!agent) return null;
      const marker = agent.metadata?.[END_OF_DAY_DRAIN_METADATA_KEY];
      if (marker?.dateKey === dateKey && marker?.status === "completed") return agent;
      const completed = status === "completed";
      const updated = await repository.compareAndSetAgent({
        agentId: id,
        expectedVersion: agent.version,
        set: {
          operatorPaused: true,
          operatorChangedAt: at,
          shiftEnabled: false,
          activeUntil: null,
          openRefillRequest: false,
          refillRequestId: null,
          refillLeaseExpiresAt: null,
          ...(completed ? { estimatedOutstanding: 0 } : {}),
          metadata: withWorkingFolderDrainMetadata(agent, {
            dateKey,
            status,
            lastAttemptAt: at,
            ...(completed ? { completedAt: at } : {}),
            deletedCount: nonNegativeInteger(details.deletedCount ?? 0, "deletedCount"),
            remainingCount: details.remainingCount == null
              ? null
              : nonNegativeInteger(details.remainingCount, "remainingCount"),
            reason: details.reason == null ? null : String(details.reason).slice(0, 64),
          }),
        },
      });
      if (updated) return updated;
    }
    return null;
  }

  async function releasePriorDayWorkingFolderDrains(agentId, at) {
    const id = String(agentId || "").trim().toLowerCase();
    const currentDateKey = getPacificDateKey(at);
    const items = await repository.listAgentDeliveryItems(id);
    let released = 0;
    let conflicts = 0;
    for (const item of items) {
      const marker = item.metadata?.[END_OF_DAY_DRAIN_METADATA_KEY];
      if (marker?.status !== "provider_absent"
        || Number(marker?.attemptNumber || 0) !== Number(item.providerAttemptSequence || 0)
        || !/^\d{4}-\d{2}-\d{2}$/.test(String(marker.dateKey || ""))
        || String(marker.dateKey) >= currentDateKey
        || !["provider_accepted", "follow_up_wait"].includes(String(item.state || ""))) {
        continue;
      }
      const updated = await repository.compareAndSetItem({
        itemId: stableWorkItemId(item),
        expectedVersion: item.version,
        expected: {
          state: item.state,
          deliveryAgentId: id,
          providerContactId: item.providerContactId ?? null,
          providerExternalLeadId: item.providerExternalLeadId ?? null,
          providerAttemptSequence: item.providerAttemptSequence,
        },
        set: {
          state: "eligible",
          activeAttempt: true,
          reservedAgentId: null,
          speedOverrideAgentId: null,
          reservedAt: null,
          reservationExpiresAt: null,
          freshDeadlineAt: null,
          reservationReason: "prior-day-provider-release",
          packetId: null,
          deliveryAgentId: null,
          provider: null,
          providerContactId: null,
          providerExternalLeadId: null,
          providerAcceptedAt: null,
          providerCompletedAt: null,
          providerCallId: null,
          providerPostState: null,
          providerPostLeaseId: null,
          providerPostLeaseExpiresAt: null,
          attemptedAt: null,
          metadata: withWorkingFolderDrainMetadata(item, {
            status: "released",
            releasedAt: at,
          }),
        },
      });
      if (!updated) {
        conflicts += 1;
        continue;
      }
      released += 1;
      if (source?.readOne) {
        const currentSource = await source.readOne({
          domain: updated.domain,
          caseId: updated.caseId,
          now: at,
          deliveryIntent: "dial_ready",
        });
        if (currentSource) await refreshExistingSourceItem(updated, currentSource, at);
      }
    }
    return { status: conflicts ? "partial" : "released", agentId: id, released, conflicts };
  }

  async function releaseAllPriorDayWorkingFolderDrains(at) {
    const dateKey = getPacificDateKey(at);
    if (priorDayDrainReleaseDateKey === dateKey) {
      return { status: "already-checked", dateKey, released: 0, conflicts: 0 };
    }
    let released = 0;
    let conflicts = 0;
    const persistedAgents = await repository.listAgents({ enabledOnly: false });
    const agentIds = [...new Set([
      ...validation.enabledAgentIds,
      ...persistedAgents.map((agent) => String(agent?.agentId || "").trim().toLowerCase()).filter(Boolean),
    ])];
    for (const agentId of agentIds) {
      const result = await releasePriorDayWorkingFolderDrains(agentId, at);
      released += Number(result.released || 0);
      conflicts += Number(result.conflicts || 0);
    }
    if (conflicts === 0) priorDayDrainReleaseDateKey = dateKey;
    return {
      status: conflicts > 0 ? "partial" : "released",
      dateKey,
      released,
      conflicts,
    };
  }

  async function runEndOfDayFolderDrain(value = atNow(), options = {}) {
    const at = parseDate(value, "value");
    const naturalWindow = resolvePacificEndOfDayDrain(at, { hour: closeHour, minute: closeMinute });
    const forcedDateKey = options?.dateKey == null ? null : String(options.dateKey).trim();
    if (forcedDateKey && !/^\d{4}-\d{2}-\d{2}$/.test(forcedDateKey)) {
      throw new TypeError("end-of-day drain dateKey must use YYYY-MM-DD");
    }
    const window = {
      ...naturalWindow,
      dateKey: forcedDateKey || naturalWindow.dateKey,
      due: forcedDateKey ? true : naturalWindow.due,
    };
    const requestedAgentIds = Array.isArray(options?.agentIds)
      ? options.agentIds
      : dailyCloseAgentIds();
    const targetAgentIds = [...new Set(requestedAgentIds
      .map((agentId) => String(agentId || "").trim().toLowerCase())
      .filter((agentId) => Boolean(agentId) && Boolean(agentPolicy(agentId))))];
    if (!window.due) return { status: "not-due", dateKey: window.dateKey, deleted: 0, remaining: null };
    if (enabled !== true || actionsEnabled !== true) {
      return { status: "disabled", dateKey: window.dateKey, deleted: 0, remaining: null };
    }
    if (runtimeState.endOfDayDrainDateKey === window.dateKey
      && runtimeState.endOfDayDrainStatus === "completed") {
      // Reassert the safety posture even after the destructive portion has
      // completed. An accidental same-evening launch must not defeat the close
      // merely because the folder work is already idempotently finished.
      await syncConfiguredAgents();
      for (const agentId of targetAgentIds) await pauseAgentForEndOfDayDrain(agentId, at);
      return {
        status: "completed",
        dateKey: window.dateKey,
        deleted: 0,
        remaining: 0,
      };
    }
    await syncConfiguredAgents();
    if (endOfDayDrainInFlight) return endOfDayDrainInFlight;
    runtimeState.endOfDayDrainDateKey = window.dateKey;
    runtimeState.endOfDayDrainStatus = "running";
    runtimeState.endOfDayDrainLastAttemptAt = at;

    const closeWorkingFolders = async () => withAgentPoolOperations(
      targetAgentIds,
      "day_close",
      async (operations) => {
      const poolOperationByAgent = new Map(operations.map((operation) => [
        String(operation.agent?.agentId || "").trim().toLowerCase(),
        operation,
      ]));
      // Persist the close intent and pause in the same CAS before waiting on the
      // provider lane. A restart can therefore resume the entire prior floor
      // close even if the process dies while another mutation owns the lane.
      const intentFailures = new Set();
      for (const agentId of targetAgentIds) {
        const intended = await setAgentWorkingFolderDrainState(agentId, window.dateKey, "pending", at, {
          remainingCount: null,
          reason: "awaiting-provider-lane",
        });
        if (!intended) {
          intentFailures.add(agentId);
          continue;
        }
        await pauseAgentForEndOfDayDrain(agentId, at);
      }
      let deleted = 0;
      let remaining = 0;
      let completedAgents = 0;
      let deleteBudget = closeDeleteLimit;
      const agentResults = [];
      for (const agentId of targetAgentIds) {
        await poolOperationByAgent.get(agentId)?.renew();
        if (intentFailures.has(agentId)) {
          agentResults.push({ agentId, status: "agent-close-intent-conflict", deleted: 0, remaining: null });
          continue;
        }
        let agent = await repository.getAgentById(agentId);
        if (!agent) continue;
        const existingMarker = agent.metadata?.[END_OF_DAY_DRAIN_METADATA_KEY];
        if (existingMarker?.dateKey === window.dateKey && existingMarker?.status === "completed") {
          completedAgents += 1;
          agentResults.push({ agentId, status: "already-completed", deleted: 0, remaining: 0 });
          continue;
        }
        agent = await setAgentWorkingFolderDrainState(agentId, window.dateKey, "running", at);
        if (!agent) {
          agentResults.push({ agentId, status: "agent-close-conflict", deleted: 0, remaining: null });
          continue;
        }

        const policy = agentPolicy(agentId);
        if (!policy) {
          agentResults.push({ agentId, status: "agent-configuration-missing", deleted: 0, remaining: null });
          continue;
        }
        const localItems = await repository.listAgentDeliveryItems(agentId);
        const localByContactId = new Map(localItems
          .map((item) => [String(item.providerContactId || "").trim(), item])
          .filter(([contactId]) => Boolean(contactId)));
        const folderContacts = new Map();
        let folderReadFailed = null;
        for (const folderId of [
          policy.providerConfig.distributionFolderId,
          policy.providerConfig.receivingFolderId,
        ]) {
          const folder = await readAllFolderContacts(folderId);
          if (!folder.ok) {
            folderReadFailed = folder;
            break;
          }
          for (const contact of folder.contacts) {
            const contactId = String(contact?.contactId || "").trim();
            if (contactId) folderContacts.set(contactId, contact);
          }
        }
        if (folderReadFailed) {
          noteProviderInventoryBackpressure(folderReadFailed);
          const status = Number(folderReadFailed.httpStatus) === 429 ? "rate-limited" : "folder-read-failed";
          await setAgentWorkingFolderDrainState(agentId, window.dateKey, "partial", at, {
            deletedCount: 0,
            remainingCount: null,
            reason: status,
          });
          agentResults.push({ agentId, status, deleted: 0, remaining: null });
          const result = {
            status,
            accepted: false,
            deleted,
            remaining,
            agentResults,
            ...(Number.isFinite(Number(folderReadFailed.retryAfterMs))
              ? { retryAfterMs: Number(folderReadFailed.retryAfterMs) }
              : {}),
          };
          return result;
        }
        let agentDeleted = 0;
        let deferred = 0;
        const deletableContactIds = [...folderContacts.keys()].filter((contactId) => (
          String(localByContactId.get(contactId)?.state || "").trim() !== "in_call"
        ));
        deferred += folderContacts.size - deletableContactIds.length;
        for (const contactId of deletableContactIds.slice(0, deleteBudget)) {
          await poolOperationByAgent.get(agentId)?.renew();
          let item = localByContactId.get(contactId) || null;
          const itemState = String(item?.state || "").trim();
          if (itemState === "in_call") {
            deferred += 1;
            continue;
          }
          if (["provider_accepted", "follow_up_wait"].includes(itemState)) {
            const intended = await repository.compareAndSetItem({
              itemId: stableWorkItemId(item),
              expectedVersion: item.version,
              expected: {
                state: itemState,
                deliveryAgentId: agentId,
                providerContactId: contactId,
                providerExternalLeadId: item.providerExternalLeadId,
                providerAttemptSequence: item.providerAttemptSequence,
              },
              set: {
                metadata: withWorkingFolderDrainMetadata(item, {
                  dateKey: window.dateKey,
                  status: "delete_pending",
                  attemptNumber: item.providerAttemptSequence,
                  requestedAt: at,
                }),
              },
            });
            if (!intended) {
              deferred += 1;
              continue;
            }
            item = intended;
          }
          const removed = await runProviderPostTurn(() => phoneBurner.deleteContact(contactId));
          if (removed?.ok !== true && Number(removed?.httpStatus) !== 404) {
            noteProviderInventoryBackpressure(removed);
            const status = Number(removed?.httpStatus) === 429 ? "rate-limited" : "contact-delete-failed";
            await setAgentWorkingFolderDrainState(agentId, window.dateKey, "partial", at, {
              deletedCount: agentDeleted,
              remainingCount: folderContacts.size - agentDeleted,
              reason: status,
            });
            agentResults.push({
              agentId,
              status,
              deleted: agentDeleted,
              remaining: folderContacts.size - agentDeleted,
            });
            return {
              status,
              accepted: false,
              deleted: deleted + agentDeleted,
              remaining: remaining + folderContacts.size - agentDeleted,
              agentResults,
              ...(Number.isFinite(Number(removed?.retryAfterMs))
                ? { retryAfterMs: Number(removed.retryAfterMs) }
                : {}),
            };
          }
          agentDeleted += 1;
          if (["provider_accepted", "follow_up_wait"].includes(itemState)) {
            await repository.compareAndSetItem({
              itemId: stableWorkItemId(item),
              expectedVersion: item.version,
              expected: {
                state: itemState,
                deliveryAgentId: agentId,
                providerContactId: contactId,
                providerExternalLeadId: item.providerExternalLeadId,
                providerAttemptSequence: item.providerAttemptSequence,
              },
              set: {
                metadata: withWorkingFolderDrainMetadata(item, {
                  status: "provider_absent",
                  removedAt: at,
                }),
              },
              append: {
                providerAttemptHistory: [{
                  attemptNumber: item.providerAttemptSequence,
                  event: "provider_removed",
                  provider: String(item.provider || providerName).trim().toLowerCase(),
                  providerExternalLeadId: String(item.providerExternalLeadId || ""),
                  providerContactId: contactId,
                  providerCallId: String(item.providerCallId || "") || null,
                  deliveryAgentId: agentId,
                  packetId: String(item.packetId || "") || null,
                  occurredAt: at,
                  outcome: null,
                  reason: "daily-close",
                }],
              },
            });
          }
          await waitForProviderPost(closeDeleteInterval);
        }
        deleteBudget = Math.max(0, deleteBudget - agentDeleted);
        deleted += agentDeleted;

        const physical = await readAgentProviderOutstanding(agentId, { repairEstimate: false });
        if (physical.reliable !== true || physical.count !== 0 || deferred > 0) {
          const agentRemaining = physical.reliable === true ? physical.count : null;
          if (agentRemaining != null) remaining += agentRemaining;
          await setAgentWorkingFolderDrainState(agentId, window.dateKey, "partial", at, {
            deletedCount: agentDeleted,
            remainingCount: agentRemaining,
            reason: deferred > 0 ? "active-or-concurrent-attempt" : physical.status,
          });
          agentResults.push({
            agentId,
            status: deferred > 0 ? "active-or-concurrent-attempt" : physical.status,
            deleted: agentDeleted,
            remaining: agentRemaining,
          });
          continue;
        }

        const afterItems = await repository.listAgentDeliveryItems(agentId);
        let localConflict = false;
        for (const item of afterItems) {
          const state = String(item.state || "").trim();
          if (state === "in_call") {
            localConflict = true;
            continue;
          }
          if (["provider_accepted", "follow_up_wait"].includes(state)) {
            const contactId = String(item.providerContactId || "").trim();
            const externalId = String(item.providerExternalLeadId || "").trim();
            if (state === "follow_up_wait" && !contactId && !externalId) continue;
            if (!contactId || !externalId) {
              localConflict = true;
              continue;
            }
            const marker = item.metadata?.[END_OF_DAY_DRAIN_METADATA_KEY];
            if (marker?.dateKey === window.dateKey
              && marker?.status === "provider_absent"
              && Number(marker?.attemptNumber || 0) === Number(item.providerAttemptSequence || 0)) continue;
            const removalEvidenceAt = marker?.dateKey === window.dateKey
              ? (parseDate(marker?.requestedAt, "workingFolderDrain.requestedAt", { nullable: true }) || at)
              : at;
            const tombstoned = await repository.compareAndSetItem({
              itemId: stableWorkItemId(item),
              expectedVersion: item.version,
              expected: {
                state,
                deliveryAgentId: agentId,
                providerContactId: contactId,
                providerExternalLeadId: externalId,
                providerAttemptSequence: item.providerAttemptSequence,
              },
              set: {
                metadata: withWorkingFolderDrainMetadata(item, {
                  dateKey: window.dateKey,
                  status: "provider_absent",
                  attemptNumber: item.providerAttemptSequence,
                  requestedAt: removalEvidenceAt,
                  removedAt: removalEvidenceAt,
                }),
              },
              append: {
                providerAttemptHistory: [{
                  attemptNumber: item.providerAttemptSequence,
                  event: "provider_removed",
                  provider: String(item.provider || providerName).trim().toLowerCase(),
                  providerExternalLeadId: externalId,
                  providerContactId: contactId,
                  providerCallId: String(item.providerCallId || "") || null,
                  deliveryAgentId: agentId,
                  packetId: String(item.packetId || "") || null,
                  occurredAt: removalEvidenceAt,
                  outcome: null,
                  reason: "daily-close-reconciled",
                }],
              },
            });
            if (!tombstoned) localConflict = true;
            continue;
          }
          if (state === "packetized") {
            const released = await repository.compareAndSetItem({
              itemId: stableWorkItemId(item),
              expectedVersion: item.version,
              expected: { state: "packetized", deliveryAgentId: agentId },
              set: {
                state: "eligible",
                activeAttempt: true,
                reservedAgentId: null,
                speedOverrideAgentId: null,
                reservedAt: null,
                reservationExpiresAt: null,
                freshDeadlineAt: null,
                reservationReason: "end-of-day-unposted-release",
                packetId: null,
                deliveryAgentId: null,
                provider: null,
                providerContactId: null,
                providerExternalLeadId: null,
                providerAcceptedAt: null,
                providerCompletedAt: null,
                providerCallId: null,
                providerPostState: null,
                providerPostLeaseId: null,
                providerPostLeaseExpiresAt: null,
                metadata: withWorkingFolderDrainMetadata(item, {
                  dateKey: window.dateKey,
                  status: "released_unposted",
                  releasedAt: at,
                }),
              },
            });
            if (!released) localConflict = true;
          }
        }
        if (localConflict) {
          await setAgentWorkingFolderDrainState(agentId, window.dateKey, "partial", at, {
            deletedCount: agentDeleted,
            remainingCount: 0,
            reason: "local-release-conflict",
          });
          agentResults.push({ agentId, status: "local-release-conflict", deleted: agentDeleted, remaining: 0 });
          continue;
        }
        const completed = await setAgentWorkingFolderDrainState(agentId, window.dateKey, "completed", at, {
          deletedCount: agentDeleted,
          remainingCount: 0,
        });
        if (!completed) {
          agentResults.push({ agentId, status: "agent-completion-conflict", deleted: agentDeleted, remaining: 0 });
          continue;
        }
        completedAgents += 1;
        agentResults.push({ agentId, status: "completed", deleted: agentDeleted, remaining: 0 });
      }
      return {
        status: completedAgents === targetAgentIds.length ? "completed" : "partial",
        accepted: false,
        dateKey: window.dateKey,
        deleted,
        remaining,
        agentResults,
      };
      },
      { dayCloseDue: true },
    );

    endOfDayDrainInFlight = closeWorkingFolders().then(async (result) => {
      let dailyDialPersistence = { status: "not-run", rows: 0, persisted: 0, attempts: 0 };
      if (result?.status === "completed" && persistDailyDialOutcomes) {
        try {
          dailyDialPersistence = await persistDailyDialOutcomes({ dateKey: window.dateKey });
        } catch (error) {
          dailyDialPersistence = {
            status: "failed",
            errorCode: String(error?.code || error?.name || "daily-dial-persistence-failed").slice(0, 80),
          };
          log("error", "lead_delivery.end_of_day.daily_dial_persistence_failed", {
            reason: dailyDialPersistence.errorCode,
          });
        }
      }
      let dailyDialCallLogProjection = {
        status: "not-run",
        rows: 0,
        attempts: 0,
        reconciled: 0,
        rejected: 0,
      };
      if (result?.status === "completed" && reconcileDailyDialCalls) {
        try {
          dailyDialCallLogProjection = await reconcileDailyDialCalls({ dateKey: window.dateKey });
        } catch (error) {
          dailyDialCallLogProjection = {
            status: "failed",
            errorCode: String(error?.code || error?.name || "daily-dial-call-log-failed").slice(0, 80),
          };
          log("error", "lead_delivery.end_of_day.daily_dial_call_log_failed", {
            reason: dailyDialCallLogProjection.errorCode,
          });
        }
      }
      result = {
        ...result,
        dailyDialPersistence,
        dailyDialCallLogProjection,
      };
      runtimeState.endOfDayCallLogProjection = {
        status: String(dailyDialCallLogProjection?.status || "unknown"),
        rows: Number(dailyDialCallLogProjection?.rows || 0),
        attempts: Number(dailyDialCallLogProjection?.attempts || 0),
        reconciled: Number(dailyDialCallLogProjection?.reconciled || 0),
        rejected: Number(dailyDialCallLogProjection?.rejected || 0),
        agentUnmapped: Number(dailyDialCallLogProjection?.agentUnmapped || 0),
      };
      runtimeState.endOfDayDrainStatus = String(result?.status || "failed");
      runtimeState.endOfDayDrainDeletedCount = Number(result?.deleted || 0);
      runtimeState.endOfDayDrainRemainingCount = result?.remaining == null
        ? null
        : Number(result.remaining);
      runtimeState.endOfDayDrainAgentResults = Array.isArray(result?.agentResults)
        ? result.agentResults.map((entry) => ({
          agentId: String(entry?.agentId || "").trim().toLowerCase(),
          status: String(entry?.status || "unknown").slice(0, 64),
          deleted: Number(entry?.deleted || 0),
          remaining: entry?.remaining == null ? null : Number(entry.remaining),
        }))
        : [];
      if (result?.status === "completed") {
        runtimeState.endOfDayDrainLastCompletedAt = atNow();
        log("info", "lead_delivery.end_of_day_drain_completed", {
          count: runtimeState.endOfDayDrainDeletedCount,
          reason: "working-folders-empty",
        });
      } else {
        log("warn", "lead_delivery.end_of_day_drain_partial", {
          count: runtimeState.endOfDayDrainRemainingCount,
          reason: runtimeState.endOfDayDrainStatus,
        });
      }
      return result;
    }).catch((error) => {
      runtimeState.endOfDayDrainStatus = "failed";
      runtimeState.endOfDayDrainRemainingCount = null;
      runtimeState.endOfDayDrainAgentResults = [];
      log("error", "lead_delivery.end_of_day_drain_failed", {
        reason: String(error?.code || error?.name || "end-of-day-drain-failed").slice(0, 64),
      });
      throw error;
    }).finally(() => {
      endOfDayDrainInFlight = null;
    });
    return endOfDayDrainInFlight;
  }

  async function resumeIncompletePriorDayFolderDrain(value = atNow()) {
    const at = parseDate(value, "value");
    const currentDateKey = getPacificDateKey(at);
    const agents = await repository.listAgents({ enabledOnly: false });
    const currentParts = zonedParts(at, PACIFIC_TIME_ZONE);
    let priorCloseAt = null;
    for (let offset = 1; offset <= 7; offset += 1) {
      const candidate = pacificLocalDateTime(
        Number(currentParts.year),
        Number(currentParts.month),
        Number(currentParts.day) - offset,
        closeHour,
        closeMinute,
      );
      if (isPacificBusinessDay(candidate)) {
        priorCloseAt = candidate;
        break;
      }
    }
    if (!priorCloseAt) return { status: "none", dateKey: null, deleted: 0, remaining: 0 };
    const priorDateKey = getPacificDateKey(priorCloseAt);
    const incomplete = agents.map((agent) => {
      const marker = agent?.metadata?.[END_OF_DAY_DRAIN_METADATA_KEY];
      const markerDateKey = /^\d{4}-\d{2}-\d{2}$/.test(String(marker?.dateKey || ""))
        ? String(marker.dateKey)
        : null;
      if (!agentPolicy(agent.agentId)) return null;
      let dateKey = markerDateKey
        && markerDateKey < currentDateKey
        && String(marker.status || "") !== "completed"
        ? markerDateKey
        : null;
      const createdAt = parseDate(agent.createdAt, "agent.createdAt", { nullable: true });
      const priorCloseMissing = createdAt
        && createdAt.getTime() <= priorCloseAt.getTime()
        && !(markerDateKey === priorDateKey && String(marker?.status || "") === "completed")
        && (!markerDateKey || markerDateKey < priorDateKey);
      if (priorCloseMissing) dateKey = priorDateKey;
      return dateKey ? { agent, dateKey } : null;
    }).filter(Boolean);
    if (!incomplete.length) {
      return { status: "none", dateKey: null, deleted: 0, remaining: 0 };
    }
    const dateKey = incomplete
      .map((entry) => entry.dateKey)
      .sort()
      .at(-1);
    // One durable incomplete marker is the floor-close intent. Include every
    // currently enabled owner so a crash during the initial intent pass cannot
    // leave a later agent's old working folder live the next morning.
    const agentIds = [...new Set([
      ...validation.enabledAgentIds,
      ...dailyCloseAgentIds(),
      ...incomplete.map((entry) => String(entry.agent.agentId || "").trim().toLowerCase()),
    ])];
    const result = await runEndOfDayFolderDrain(at, { dateKey, agentIds });
    return { ...result, resumed: true };
  }

  async function reconcileAgent(agentId) {
    const id = String(agentId || "").trim().toLowerCase();
    const policy = agentPolicy(id);
    if (!policy) return { status: "unknown-agent", agentId: id, repaired: false };
    const [distribution, receiving, items, agent] = await Promise.all([
      readAllFolderContacts(policy.providerConfig.distributionFolderId),
      readAllFolderContacts(policy.providerConfig.receivingFolderId),
      repository.listAgentProjectionItems(id),
      repository.getAgentById(id),
    ]);
    if (!distribution.ok || !receiving.ok || !agent) {
      return { status: "read-unreliable", agentId: id, repaired: false };
    }
    const providerExternalIds = new Set();
    for (const contact of [...distribution.contacts, ...receiving.contacts]) {
      for (const externalId of contactExternalIds(contact)) providerExternalIds.add(externalId);
    }
    const accepted = items.filter((item) => (
      ["provider_accepted", "in_call", "follow_up_wait"].includes(String(item.state || ""))
      && Boolean(String(item.providerContactId || "").trim())
    ));
    const activeLocalIds = accepted.map((item) => String(item.providerExternalLeadId || "").trim());
    const allLocalPostedIds = new Set(items
      .filter((item) => item.providerAcceptedAt)
      .map((item) => String(item.providerExternalLeadId || "").trim())
      .filter(Boolean));
    const incomplete = activeLocalIds.some((value) => !value);
    const missing = activeLocalIds.filter((value) => value && !providerExternalIds.has(value));
    const knownIds = allLocalPostedIds;
    const unexplained = [...providerExternalIds].filter((value) => !knownIds.has(value));
    if (incomplete || missing.length || unexplained.length) {
      log("warn", "lead_delivery.reconcile_failed", { agentId: id, count: missing.length + unexplained.length, reason: "identity-difference" });
      return {
        status: "identity-difference",
        agentId: id,
        repaired: false,
        localMissingCount: missing.length,
        providerUnexplainedCount: unexplained.length,
      };
    }
    if (actionsEnabled !== true) {
      return { status: "preview", agentId: id, repaired: false, estimatedOutstanding: accepted.length };
    }
    const repaired = await repository.compareAndSetAgent({
      agentId: id,
      expectedVersion: agent.version,
      set: { estimatedOutstanding: accepted.length },
    });
    return {
      status: repaired ? "reconciled" : "repair-conflict",
      agentId: id,
      repaired: Boolean(repaired),
      estimatedOutstanding: accepted.length,
    };
  }

  async function runPhysicalPoolWatchdog(at) {
    const automatic = [];
    const starved = [];
    // SIMPLE OPERATOR MODE: Call End and this bounded watchdog share one
    // physical-Pool decision helper and one durable per-agent operation lock.
    // The watchdog is repair-only: it never counts an attempt and never uses
    // Consumer inventory or the local outstanding estimate as capacity truth.
    if (actionsEnabled === true
      && refillEnabled === true
      && providerInventoryAuthoritative === true
      && deliveryWindowOpen(at) === true) {
      const agents = await repository.listAgents({ enabledOnly: true });
      for (const persisted of agents) {
        const id = String(persisted?.agentId || "").trim().toLowerCase();
        const policy = agentPolicy(id);
        if (!policy?.enabled
          || persisted?.enabled !== true
          || persisted?.operatorPaused === true
          || persisted?.shiftEnabled !== true) continue;
        const result = await refreshAgentCapacity(id, {
          requireActiveShift: true,
          trigger: "physical_pool_watchdog",
        });
        // A healthy capacity decision can still post zero when the durable
        // packet ledger has not yet walked far enough through the canonical
        // source to expose due/unused work. Refill that supply cursor outside
        // the per-agent Pool lock, then retry the same physical decision once.
        // Review, DNC, cap, and claim-time eligibility rules remain unchanged.
        const index = automatic.push(result) - 1;
        if (String(result?.status || "") === "queue-exhausted"
          && Number(result?.accepted || 0) === 0
          && Number(result?.physicalCount) <= SIMPLE_POOL_LOW_WATER) {
          starved.push({ id, index });
        }
      }
      if (starved.length > 0) {
        // Advance the shared source cursor once for the whole floor without
        // holding the minute tick open. Completed batches become eligible for
        // the next watchdog pass; a single owner prevents five empty agents
        // from launching five copies of the same scan.
        const refresh = launchWatchdogSupplyRefresh();
        for (const entry of starved) {
          automatic[entry.index] = {
            ...automatic[entry.index],
            status: refresh.started ? "supply-refresh-started" : "supply-refresh-in-flight",
            supplyRefreshBatches: runtimeState.watchdogSupplyRefreshBatches,
            retryable: true,
          };
        }
      }
    }
    return automatic;
  }

  async function runTick() {
    if (enabled !== true) return { status: "disabled" };
    const at = atNow();
    const dateKey = getPacificDateKey(at);
    const completedCloseDateKey = runtimeState.endOfDayDrainStatus === "completed"
      ? runtimeState.endOfDayDrainDateKey
      : null;
    const tickMode = resolveLeadDeliveryTickMode(at, {
      deliveryWindowEvaluator: deliveryWindowOpen,
      closeHour,
      closeMinute,
      completedCloseDateKey,
    });
    runtimeState.tickMode = tickMode;

    let priorDayDrainResume = { status: "not-audited", dateKey: null, deleted: 0, remaining: 0 };
    if (isPacificBusinessDay(at) && priorCloseAuditDateKey !== dateKey) {
      priorDayDrainResume = await resumeIncompletePriorDayFolderDrain(at);
      if (["none", "completed", "already-completed"].includes(String(priorDayDrainResume.status || ""))) {
        priorCloseAuditDateKey = dateKey;
      }
      if (priorDayDrainResume.status !== "none") priorDayDrainReleaseDateKey = null;
    }

    const recordTick = (payload) => {
      runtimeState.lastTickAt = at;
      runtimeState.lastErrorCode = null;
      runtimeState.ticks += 1;
      if (tickMode !== "delivery_open") {
        runtimeState.offHoursTicks += 1;
        runtimeState.sourceReadsSkippedOffHours += 1;
      }
      return { status: "ok", tickMode, priorDayDrainResume, ...payload };
    };

    // Weekend intake is owned upstream and has already persisted the cadence
    // row, sent only the initial SMS/email, and enrolled the lead for Monday.
    // This runtime must not scan source/provider state or even drain callbacks
    // on Saturday/Sunday; those durable events wait for the next business day.
    if (tickMode === "weekend_idle") {
      return recordTick({
        events: { status: "weekend-paused", seen: 0, processed: 0 },
      });
    }

    if (tickMode !== "delivery_open" && tickMode !== "close_due") {
      const events = await drainEvents({
        waitForRefillCompletion: false,
        allowProviderCapacityWork: false,
      });
      return recordTick({ events });
    }

    if (tickMode === "close_due") {
      const events = await drainEvents({
        waitForRefillCompletion: false,
        allowProviderCapacityWork: false,
      });
      const endOfDayDrain = await runEndOfDayFolderDrain(at);
      return recordTick({ events, endOfDayDrain });
    }

    await syncConfiguredAgents();
    const priorDayDrainRelease = await releaseAllPriorDayWorkingFolderDrains(at);
    // Prior-day drain safety remains first. Once that boundary is reconciled,
    // repair the physical Pools before unrelated ingestion, event, or
    // productivity work can fail this tick. A later failure is still surfaced
    // by tick(), but it can no longer suppress the bounded refill watchdog.
    const automatic = await runPhysicalPoolWatchdog(at);
    const events = await drainEvents({
      waitForRefillCompletion: false,
      allowProviderCapacityWork: true,
    });
    const dayStart = await runDayStart(at);
    const ingestion = dayStart.queueBuild || (watchdogSupplyRefreshInFlight
      ? { status: "supply-refresh-in-flight", done: false }
      : await ingestSerial());
    const productivityRebalance = await runProductivityRebalance(at);
    const endOfDayDrain = await runEndOfDayFolderDrain(at);
    // The former preview / weighted / estimate-driven refill loop remains
    // below as a reference during the no-delete proof window.
    /* if (actionsEnabled === true) {
      const agents = await repository.listAgents({ enabledOnly: true });
      for (const persisted of agents) {
        const policy = agentPolicy(persisted.agentId);
        if (!policy?.enabled) continue;
        if (persisted.operatorPaused === true) continue;
        if (backgroundRefillsByAgent.has(String(persisted.agentId || "").trim().toLowerCase())) continue;
        const preview = await previewAgent(persisted.agentId);
        if (preview.acceptedInFlight > 0) {
          automatic.push(await fillAgent(persisted.agentId, {
            explicit: false,
            reason: "packet-recovery",
            recoverOnly: true,
          }));
          continue;
        }
        if (persisted.shiftEnabled !== true) continue;
        const activeUntil = persisted.activeUntil ? parseDate(persisted.activeUntil, "activeUntil") : null;
        if (!activeUntil || activeUntil.getTime() <= at.getTime()) continue;
        if (refillEnabled === true && providerInventoryAuthoritative === true) {
          automatic.push(await refreshAgentCapacity(persisted.agentId));
          continue;
        }
        if (refillEnabled === true
          && preview.currentOutstanding === 0
          && preview.acceptedInFlight === 0
          && preview.needed > 0) {
          automatic.push(await fillAgent(persisted.agentId, { explicit: false, reason: "shift-bootstrap" }));
        } else if (refillEnabled === true) {
          automatic.push(await refillAgent(persisted.agentId));
        }
      }
    } */
    return recordTick({
      priorDayDrainRelease,
      events,
      ingestion,
      dayStart,
      productivityRebalance,
      endOfDayDrain,
      automatic,
    });
  }

  async function tick() {
    if (tickInFlight) return tickInFlight;
    tickInFlight = runTick()
      .catch((error) => {
        runtimeState.lastErrorCode = String(error?.code || error?.name || "tick-failed").slice(0, 80);
        log("error", "lead_delivery.tick_failed", { reason: runtimeState.lastErrorCode });
        throw error;
      })
      .finally(() => {
        tickInFlight = null;
      });
    return tickInFlight;
  }

  async function start() {
    if (runtimeState.running) return getState();
    providerPostAccepting = true;
    productivityRebalanceStartedAt = atNow();
    runtimeState.running = true;
    await syncConfiguredAgents();
    timerHandle = schedule.setInterval(() => {
      void tick().catch(() => {});
    }, intervalMs);
    if (typeof timerHandle?.unref === "function") timerHandle.unref();
    // Opening the control-plane callback port must not wait for queue building,
    // provider reads, or provider posts. A slow first tick used to leave the
    // Node process alive but port 5001 unopened, turning every Call End into a
    // 502 and preventing the simple low-water refill from ever running.
    void tick().catch(() => {});
    return getState();
  }

  async function stop() {
    providerPostAccepting = false;
    if (timerHandle != null) schedule.clearInterval(timerHandle);
    timerHandle = null;
    runtimeState.running = false;
    if (tickInFlight) await tickInFlight.catch(() => {});
    if (freshDispatchInFlight) await freshDispatchInFlight.catch(() => {});
    if (backgroundRefills.size > 0) {
      await Promise.allSettled([...backgroundRefills]);
    }
    if (physicalRefreshesByAgent.size > 0) {
      await Promise.allSettled([...physicalRefreshesByAgent.values()].map((entry) => entry.completion));
    }
    if (productivityRebalanceInFlight) await productivityRebalanceInFlight.catch(() => {});
    await providerPostTail.catch(() => {});
    // stop() halts ownership and drains work already queued. Production's
    // direct operator writers remain disabled after stop as well.
    providerPostAccepting = true;
    return getState();
  }

  function getState() {
    return {
      running: runtimeState.running,
      enabled: enabled === true,
      actionsEnabled: actionsEnabled === true,
      refillEnabled: actionsEnabled === true && refillEnabled === true,
      operatorMode: "simple-loop-only",
      legacyOperatorSurfaceEnabled: legacyOperatorSurfaceEnabled === true,
      simpleOperatorDirectAccessEnabled: simpleOperatorDirectAccessEnabled === true,
      providerInventoryAuthoritative: providerInventoryAuthoritative === true,
      provider: providerName,
      sourceCursor: observableSourceCursor(runtimeState.sourceCursor),
      sourceDone: runtimeState.sourceDone,
      sourceBusinessDate: runtimeState.sourceBusinessDate,
      sourceRepairStatus: runtimeState.sourceRepairStatus,
      sourceLane: runtimeState.sourceLane,
      tickMode: runtimeState.tickMode,
      offHoursTicks: runtimeState.offHoursTicks,
      sourceReadsSkippedOffHours: runtimeState.sourceReadsSkippedOffHours,
      lastTickAt: clone(runtimeState.lastTickAt),
      lastErrorCode: runtimeState.lastErrorCode,
      ticks: runtimeState.ticks,
      ingested: runtimeState.ingested,
      accepted: runtimeState.accepted,
      completed: runtimeState.completed,
      freshDispatch: {
        inFlight: freshDispatchInFlight != null,
        attempts: runtimeState.freshDispatchAttempts,
        accepted: runtimeState.freshDispatchAccepted,
        lastAt: clone(runtimeState.freshDispatchLastAt),
        lastStatus: runtimeState.freshDispatchLastStatus,
      },
      watchdogSupplyRefresh: {
        status: runtimeState.watchdogSupplyRefreshStatus,
        inFlight: watchdogSupplyRefreshInFlight != null,
        batches: runtimeState.watchdogSupplyRefreshBatches,
        lastCompletedAt: clone(runtimeState.watchdogSupplyRefreshLastCompletedAt),
        statusRefreshed: runtimeState.watchdogStatusRefreshRefreshed,
        statusFailed: runtimeState.watchdogStatusRefreshFailed,
        statusReclassified: runtimeState.watchdogStatusRefreshReclassified,
        statusReevaluated: runtimeState.watchdogStatusRefreshReevaluated,
        statusStillBlocked: runtimeState.watchdogStatusRefreshStillBlocked,
      },
      providerPostConcurrency: 1,
      providerPostMinimumIntervalMs: postMinimumInterval,
      providerPostQueueDepth: runtimeState.providerPostQueueDepth,
      providerPostInFlight: runtimeState.providerPostInFlight,
      providerPostStarts: runtimeState.providerPostStarts,
      providerPostRateLimited: runtimeState.providerPostRateLimited,
      providerPostSlotWaits: runtimeState.providerPostSlotWaits,
      providerPostLastStartedAt: clone(runtimeState.providerPostLastStartedAt),
      providerPostLastCompletedAt: clone(runtimeState.providerPostLastCompletedAt),
      providerPostNextAllowedAt: clone(runtimeState.providerPostNextAllowedAt),
      providerPostCooldownUntil: clone(runtimeState.providerPostCooldownUntil),
      providerInventoryCooldownUntil: clone(runtimeState.providerInventoryCooldownUntil),
      providerPostCircuitOpen: runtimeState.providerPostCircuitOpen,
      backgroundRefillCount: backgroundRefills.size,
      productivityRebalance: {
        enabled: productivityRebalanceEnabled === true,
        status: runtimeState.productivityRebalanceStatus,
        lastAttemptAt: clone(runtimeState.productivityRebalanceLastAttemptAt),
        lastCompletedAt: clone(runtimeState.productivityRebalanceLastCompletedAt),
        lastWindowKey: runtimeState.productivityRebalanceLastWindowKey,
        movedCount: runtimeState.productivityRebalanceRedistributedCount,
        agentResults: clone(runtimeState.productivityRebalanceAgentResults),
        inFlight: productivityRebalanceInFlight != null,
      },
      dayStart: {
        dateKey: runtimeState.dayStartDateKey,
        status: runtimeState.dayStartStatus,
        lastAttemptAt: clone(runtimeState.dayStartLastAttemptAt),
        lastCompletedAt: clone(runtimeState.dayStartLastCompletedAt),
        agentResults: clone(runtimeState.dayStartAgentResults),
      },
      endOfDayDrain: {
        dateKey: runtimeState.endOfDayDrainDateKey,
        status: runtimeState.endOfDayDrainStatus,
        lastAttemptAt: clone(runtimeState.endOfDayDrainLastAttemptAt),
        lastCompletedAt: clone(runtimeState.endOfDayDrainLastCompletedAt),
        deletedCount: runtimeState.endOfDayDrainDeletedCount,
        remainingCount: runtimeState.endOfDayDrainRemainingCount,
        agentResults: clone(runtimeState.endOfDayDrainAgentResults),
        callLogProjection: clone(runtimeState.endOfDayCallLogProjection),
        inFlight: endOfDayDrainInFlight != null,
      },
    };
  }

  return {
    start,
    stop,
    tick,
    ingestOnce,
    previewAgent,
    seedAgent,
    launchAgent,
    appendAgentPacket,
    // Direct calls bypass the physical Pool decision and therefore stay dark
    // in production. The internal day-start and Call End owners call the
    // closure above directly.
    postTopOfQueue: simpleOperatorDirectAccessEnabled === true
      ? postTopOfQueue
      : async (agentId) => ({
        status: "direct-post-disabled",
        agentId: String(agentId || "").trim().toLowerCase(),
        accepted: 0,
      }),
    appendWeightedAgentPacket,
    dispatchImmediateFresh,
    refillAgent,
    readAgentProviderOutstanding,
    refreshAgentCapacity,
    cancelAgent,
    preloadWindow,
    checkpointReadyForContinuation: isCheckpointReadyForContinuation,
    drainEvents,
    drainCapturedEvent,
    runDayStart,
    runProductivityRebalance,
    runEndOfDayFolderDrain,
    reconcileAgent,
    getState,
  };
}

module.exports = {
  AGENT_POOL_OPERATION_KINDS,
  CALL_RECOVERY_CONTACT_POLICY_ID,
  CALL_RECOVERY_DNC_POLICY_ID,
  CALL_RECOVERY_INVENTORY_CLASS,
  CALL_RECOVERY_LOGICS_POLICY_ID,
  CALL_RECOVERY_MAXIMUM_DAILY_ATTEMPTS,
  CALL_RECOVERY_MAXIMUM_PROGRAM_AGE_DAYS,
  CALL_RECOVERY_MINIMUM_RETRY_MINUTES,
  DEFAULT_DNC_STATUS_IDS,
  DEFAULT_FALLBACK_POOL_ORDER,
  END_OF_DAY_DELETE_INTERVAL_MS,
  END_OF_DAY_DRAIN_HOUR,
  END_OF_DAY_DRAIN_MINUTE,
  PRODUCTIVITY_REBALANCE_CUSHION_SIZE,
  PRODUCTIVITY_REBALANCE_INTERVAL_MS,
  PRODUCTIVITY_REBALANCE_MINIMUM_CUSHION_AGE_DAYS,
  PACIFIC_TIME_ZONE,
  POOLS,
  assignPacificMorningBatch,
  buildEventDedupeKey,
  buildProviderAttemptKey,
  buildCapturedEventUpgrade,
  buildProviderAcceptanceTransition,
  buildProviderAttemptPreparation,
  buildProviderDeliveryFailureTransition,
  buildProviderPostLease,
  classifyCapturedProviderEvent,
  buildFreshReservationPatch,
  calculateFreshLease,
  calculatePacketDeficit,
  canAttemptToday,
  canMutateAgentPool,
  classifyPool,
  claimNextFairPick,
  comparePoolItems,
  compareRecoveryPoolItems,
  compareSelectionCandidates,
  resolveSelectionRank,
  composePacketRecipe,
  createLeadDeliveryCadenceSource,
  createLeadDeliveryRuntime,
  computeRefillDecision,
  decideOutcomeState,
  decideRecoveryOutcomeState,
  dailyAttemptLimitForLeadAge,
  evaluateFreshAgentEligibility,
  fairnessTieBreaker,
  getEffectiveDailyAttemptCount,
  getPacificDateKey,
  getPacificHourKey,
  isPacificBusinessDay,
  isPacificDeliveryWindowOpen,
  leadAgeInPacificDays,
  isFreshReservationProtected,
  isActiveAttemptState,
  normalizeAgentFairnessHour,
  normalizeOutcome,
  nextFairPick,
  orderPoolItems,
  planProductivityPoolCull,
  projectAttemptCompletion,
  rankFreshAgents,
  reconstructAgentProjection,
  retryDelayMinutesForLeadAge,
  resolvePacificMorningBatchWindow,
  resolvePacificEndOfDayDrain,
  resolveLeadDeliveryTickMode,
  resolveLeadDeliveryContactPolicy,
  resolveCallRecoveryLogicsEligibility,
  resolveRecoveryEpisodeTiming,
  resolveProviderEventItem,
  shouldRequestRefill,
  shouldRetainCompletedProviderContact,
  stableWorkItemId,
  transitionCompletedAttempt,
  validateLeadDeliveryConfiguration,
};
