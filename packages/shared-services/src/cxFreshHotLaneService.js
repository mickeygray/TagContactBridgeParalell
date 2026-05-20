"use strict";

const { cxDialQueueRepository, userAccountRepository } = require("../../shared-repositories/src");
const {
  getQueueFamilyTargetOpen,
  resolveAccountQueuePolicy,
} = require("./cxQueuePolicyService");

const HOT_LANE_TIMEZONE = "America/Los_Angeles";
const DEFAULT_DOMAINS = Object.freeze(["WYNN", "TAG"]);
const HOT_LANE_ACTIVE_STATES = Object.freeze(["queued", "ready", "claimed", "serving", "paused"]);

const hotLaneCache = {
  generatedAt: null,
  windowStart: null,
  windowEnd: null,
  domains: [],
  itemsById: new Map(),
};
let allocatorRunning = false;

function normalizeDomain(value) {
  return String(value || "").trim().toUpperCase();
}

function parseDomains(value = null) {
  const raw = value || process.env.RC_CX_FRESH_HOT_LANE_DOMAINS || "";
  const domains = String(raw || "")
    .split(",")
    .map(normalizeDomain)
    .filter(Boolean);
  return Array.from(new Set(domains.length ? domains : DEFAULT_DOMAINS));
}

function getZonedParts(date = new Date(), timeZone = HOT_LANE_TIMEZONE) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(date));
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const hour = Number(lookup.hour);
  return {
    year: Number(lookup.year),
    month: Number(lookup.month),
    day: Number(lookup.day),
    hour: hour === 24 ? 0 : hour,
    minute: Number(lookup.minute),
    second: Number(lookup.second),
  };
}

function getZonedOffsetMs(date = new Date(), timeZone = HOT_LANE_TIMEZONE) {
  const parts = getZonedParts(date, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return asUtc - new Date(date).getTime();
}

function makeZonedDate(year, month, day, hour = 0, minute = 0, second = 0, timeZone = HOT_LANE_TIMEZONE) {
  let utcMs = Date.UTC(year, month - 1, day, hour, minute, second, 0);
  for (let index = 0; index < 3; index += 1) {
    utcMs = Date.UTC(year, month - 1, day, hour, minute, second, 0)
      - getZonedOffsetMs(new Date(utcMs), timeZone);
  }
  return new Date(utcMs);
}

function computeFreshHotLaneWindow(asOf = new Date(), options = {}) {
  const timeZone = options.timeZone || HOT_LANE_TIMEZONE;
  const rolloverHour = Math.min(Math.max(Number(options.rolloverHour ?? process.env.RC_CX_FRESH_HOT_LANE_ROLLOVER_HOUR) || 15, 0), 23);
  const rolloverMinute = Math.min(Math.max(Number(options.rolloverMinute ?? process.env.RC_CX_FRESH_HOT_LANE_ROLLOVER_MINUTE) || 30, 0), 59);
  const parts = getZonedParts(asOf, timeZone);
  const afterRollover =
    parts.hour > rolloverHour ||
    (parts.hour === rolloverHour && parts.minute >= rolloverMinute);
  const startDayOffset = afterRollover ? 0 : -1;
  const noonGuess = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + startDayOffset, 12, 0, 0, 0));
  const startParts = getZonedParts(noonGuess, timeZone);
  const windowStart = makeZonedDate(
    startParts.year,
    startParts.month,
    startParts.day,
    rolloverHour,
    rolloverMinute,
    0,
    timeZone,
  );
  return {
    timeZone,
    rolloverHour,
    rolloverMinute,
    windowStart,
    windowEnd: new Date(asOf),
  };
}

function summarizeItem(item = {}) {
  return {
    id: item._id ? String(item._id) : null,
    domain: item.domain || null,
    caseId: Number(item.caseId || 0) || null,
    state: item.state || null,
    queueFamily: item.queueFamily || null,
    releaseAt: item.releaseAt || null,
    claimUntil: item.claimUntil || null,
    assignedExtensionId: item.assignment?.extensionId || null,
    assignedAgentName: item.assignment?.agentName || null,
    createdAt: item.createdAt || null,
    phone: item.phone || null,
    name: item.name || null,
  };
}

async function rebuildFreshHotLane(options = {}) {
  const asOf = options.asOf ? new Date(options.asOf) : new Date();
  const window = options.windowStart && options.windowEnd
    ? {
      windowStart: new Date(options.windowStart),
      windowEnd: new Date(options.windowEnd),
      timeZone: options.timeZone || HOT_LANE_TIMEZONE,
      rolloverHour: Number(options.rolloverHour || 15),
      rolloverMinute: Number(options.rolloverMinute || 30),
    }
    : computeFreshHotLaneWindow(asOf, options);
  const domains = parseDomains(options.domains);
  const limit = Math.min(Math.max(Number(options.limit) || 1000, 1), 5000);

  const rows = [];
  for (const domain of domains) {
    const items = await cxDialQueueRepository.listQueueItems({
      domain,
      states: HOT_LANE_ACTIVE_STATES,
      queueFamilies: ["fresh-day1"],
      createdAtGte: window.windowStart,
      createdAtLte: window.windowEnd,
      limit,
    });
    rows.push(...items);
  }

  hotLaneCache.generatedAt = asOf;
  hotLaneCache.windowStart = window.windowStart;
  hotLaneCache.windowEnd = window.windowEnd;
  hotLaneCache.domains = domains;
  hotLaneCache.itemsById = new Map(rows.map((item) => [String(item._id), summarizeItem(item)]));

  const byState = {};
  for (const item of rows) {
    const state = String(item.state || "unknown");
    byState[state] = Number(byState[state] || 0) + 1;
  }

  return {
    ok: true,
    generatedAt: asOf,
    windowStart: window.windowStart,
    windowEnd: window.windowEnd,
    domains,
    count: rows.length,
    byState,
    items: rows.map(summarizeItem),
  };
}

async function rebalanceFreshHotLaneOverflow({
  domains = [],
  window = {},
  maxOpenAssignments = 5,
  now = new Date(),
  releaseCxQueueItem,
} = {}) {
  if (typeof releaseCxQueueItem !== "function") {
    return { ok: false, released: 0, reason: "release-function-required" };
  }
  const cap = Math.max(Number(maxOpenAssignments) || 5, 1);
  const grouped = new Map();
  const capByExtension = new Map();

  for (const domain of domains) {
    const items = await cxDialQueueRepository.listQueueItems({
      domain,
      states: ["claimed"],
      queueFamilies: ["fresh-day1"],
      assignedOnly: true,
      limitAll: true,
    });
    for (const item of items) {
      const extensionId = String(item?.assignment?.extensionId || "").trim();
      if (!extensionId) continue;
      if (!grouped.has(extensionId)) grouped.set(extensionId, []);
      grouped.get(extensionId).push(item);
    }
  }

  const released = [];
  for (const [extensionId, items] of grouped.entries()) {
    if (!capByExtension.has(extensionId)) {
      const account = await userAccountRepository.findUserAccountByExtensionId(extensionId).catch(() => null);
      const policy = resolveAccountQueuePolicy(account);
      const policyCap = getQueueFamilyTargetOpen(policy, "fresh-day1");
      capByExtension.set(extensionId, Math.max(Math.min(cap, policyCap || 0), 0));
    }
    const extensionCap = capByExtension.get(extensionId);
    if (items.length <= extensionCap) continue;
    const sorted = [...items].sort((left, right) => {
      const leftTime = new Date(
        left.assignment?.assignedAt || left.lastClaimedAt || left.createdAt || 0,
      ).getTime();
      const rightTime = new Date(
        right.assignment?.assignedAt || right.lastClaimedAt || right.createdAt || 0,
      ).getTime();
      return leftTime - rightTime;
    });
    const overflow = sorted.slice(extensionCap);
    for (const item of overflow) {
      const result = await releaseCxQueueItem({
        queueItemId: String(item._id),
        now,
        releaseAt: now,
        reason: "fresh-hot-lane-overflow-rebalance",
        extraUpdate: {
          metadata: {
            rebalanceReleasedAt: now,
            rebalanceReleasedExtensionId: extensionId,
            rebalanceMaxOpenAssignments: extensionCap,
          },
        },
      });
      if (result?.mutated) {
        released.push({
          queueItemId: String(item._id),
          domain: item.domain || null,
          caseId: Number(item.caseId || 0) || null,
          extensionId,
        });
      }
    }
  }

  return {
    ok: true,
    cap,
    released: released.length,
    items: released,
  };
}

async function runFreshHotLaneAllocator(options = {}) {
  if (allocatorRunning && options.allowConcurrent !== true) {
    const snapshot = getFreshHotLaneSnapshot();
    return {
      ok: true,
      skipped: true,
      reason: "fresh-hot-lane-already-running",
      mode: options.mode || "manual",
      generatedAt: new Date(),
      windowStart: snapshot.windowStart,
      windowEnd: snapshot.windowEnd,
      domains: snapshot.domains,
      assigned: 0,
      before: { count: snapshot.count, byState: {} },
      sweep: null,
      assignments: [],
      after: { count: snapshot.count, byState: {} },
    };
  }
  allocatorRunning = true;
  try {
    return await runFreshHotLaneAllocatorUnsafe(options);
  } finally {
    allocatorRunning = false;
  }
}

async function runFreshHotLaneAllocatorUnsafe(options = {}) {
  const asOf = options.asOf ? new Date(options.asOf) : new Date();
  const domains = parseDomains(options.domains);
  const maxCount = Math.min(Math.max(Number(options.maxCount) || 50, 1), 500);
  const claimMinutes = Math.max(Number(options.claimMinutes) || 15, 1);
  const maxOpenAssignments = Math.max(
    Number(options.maxOpenAssignments)
      || Number(process.env.RC_CX_FRESH_HOT_LANE_MAX_OPEN_ASSIGNMENTS)
      || Number(process.env.RC_CX_FRESH_OPEN_ASSIGNMENTS)
      || 5,
    1,
  );
  const requestKeyPrefix = String(
    options.requestKeyPrefix || `fresh-hot-lane:${asOf.toISOString()}`,
  ).trim();
  const candidateExtensionIds = Array.isArray(options.candidateExtensionIds)
    ? options.candidateExtensionIds
      .map((value) => String(value || "").trim())
      .filter(Boolean)
    : [];
  const window = computeFreshHotLaneWindow(asOf, options);

  const before = await rebuildFreshHotLane({
    ...options,
    asOf,
    domains,
    windowStart: window.windowStart,
    windowEnd: window.windowEnd,
  });

  // Lazy require to avoid loading cxCadenceService before its exports exist.
  // Mongo still owns the state transitions; memory only wakes the allocator.
  // eslint-disable-next-line global-require
  const {
    assignCxQueueBatch,
    releaseCxQueueItem,
    releaseCxQueueBatch,
  } = require("./cxCadenceService");

  const sweep = await releaseCxQueueBatch({
    now: asOf,
    limit: Math.max(maxCount, 50),
  });
  const rebalanceEnabled =
    String(process.env.RC_CX_FRESH_HOT_LANE_REBALANCE_ENABLED || "true").toLowerCase() !== "false";
  const rebalance = rebalanceEnabled
    ? await rebalanceFreshHotLaneOverflow({
      domains,
      window,
      maxOpenAssignments,
      now: asOf,
      releaseCxQueueItem,
    })
    : {
      ok: true,
      skipped: true,
      reason: "fresh-hot-lane-rebalance-disabled",
      cap: maxOpenAssignments,
      released: 0,
      items: [],
    };

  const assignments = [];
  for (const domain of domains) {
    const result = await assignCxQueueBatch({
      domain,
      maxCount,
      claimMinutes,
      queueFamilies: ["fresh-day1"],
      routeCampaigns: Array.isArray(options.routeCampaigns) ? options.routeCampaigns : [],
      candidateExtensionIds,
      maxOpenAssignments,
      maxOpenAssignmentsScope: "queue-family",
      ignoreActivityState: options.ignoreActivityState === true,
      ignoreDrainBeforeRefill: options.ignoreDrainBeforeRefill === true,
      assignmentPackId: options.assignmentPackId || null,
      assignmentPackFamily: options.assignmentPackFamily || null,
      assignmentPackTarget: options.assignmentPackTarget || null,
      assignmentPackCreatedAt: options.assignmentPackCreatedAt || null,
      assignmentPackSource: options.assignmentPackSource || null,
      createdAtGte: window.windowStart,
      createdAtLte: window.windowEnd,
      requestKeyPrefix: `${requestKeyPrefix}:${domain}`,
    });
    assignments.push({ domain, ...result });
  }

  const after = await rebuildFreshHotLane({
    ...options,
    asOf: new Date(),
    domains,
    windowStart: window.windowStart,
    windowEnd: new Date(),
  });

  return {
    ok: true,
    mode: options.mode || "manual",
    generatedAt: new Date(),
    windowStart: window.windowStart,
    windowEnd: window.windowEnd,
    domains,
    before: {
      count: before.count,
      byState: before.byState,
    },
    sweep,
    rebalance,
    assignments,
    assigned: assignments.reduce((sum, entry) => sum + Number(entry.assigned || 0), 0),
    after: {
      count: after.count,
      byState: after.byState,
    },
  };
}

function getFreshHotLaneSnapshot() {
  return {
    generatedAt: hotLaneCache.generatedAt,
    windowStart: hotLaneCache.windowStart,
    windowEnd: hotLaneCache.windowEnd,
    domains: hotLaneCache.domains,
    count: hotLaneCache.itemsById.size,
    items: Array.from(hotLaneCache.itemsById.values()),
  };
}

module.exports = {
  computeFreshHotLaneWindow,
  getFreshHotLaneSnapshot,
  rebuildFreshHotLane,
  runFreshHotLaneAllocator,
};
