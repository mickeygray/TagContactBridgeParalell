"use strict";

const QUEUE_TIMEZONE = "America/Los_Angeles";

// Keep the stored queue-family key stable for existing data. The
// business meaning is now day 2 through day 15.
const QUEUE_FAMILY_SORT_RANKS = Object.freeze({
  "fresh-day1": 0,
  "fresh-day2to10": 1,
  aged: 2,
  unassigned: 3,
});

const QUEUE_FAMILY_POLICIES = Object.freeze({
  "fresh-day1": {
    key: "fresh-day1",
    label: "New",
    claimMinutes: 15,
    cooldownMinutes: 15,
    dailyMax: null,
  },
  "fresh-day2to10": {
    key: "fresh-day2to10",
    label: "2-15",
    claimMinutes: 30,
    cooldownMinutes: 25,
    dailyMax: 20,
  },
  aged: {
    key: "aged",
    label: "Aged",
    claimMinutes: 60,
    cooldownMinutes: 60,
    dailyMax: 3,
  },
  unassigned: {
    key: "unassigned",
    label: "Other",
    claimMinutes: 30,
    cooldownMinutes: 30,
    dailyMax: null,
  },
});

const CX_QUEUE_TIER_POLICIES = Object.freeze({
  no_leads: {
    tier: "no_leads",
    label: "No leads",
    enabled: false,
    fresh: { eligible: false, targetOpen: 0, priorityWeight: 0 },
    day2to15: { targetOpen: 0 },
    aged: { targetOpen: 0 },
  },
  red_only: {
    tier: "red_only",
    label: "Red only",
    enabled: true,
    fresh: { eligible: false, targetOpen: 0, priorityWeight: 0 },
    day2to15: { targetOpen: 0 },
    aged: { targetOpen: 20 },
  },
  old_balanced: {
    tier: "old_balanced",
    label: "Old balanced",
    enabled: true,
    fresh: { eligible: false, targetOpen: 0, priorityWeight: 0 },
    day2to15: { targetOpen: 10 },
    aged: { targetOpen: 10 },
  },
  fresh_capped: {
    tier: "fresh_capped",
    label: "Fresh capped",
    enabled: true,
    fresh: { eligible: true, targetOpen: 1, priorityWeight: 50 },
    day2to15: { targetOpen: 15 },
    aged: { targetOpen: 5 },
  },
  fresh_priority: {
    tier: "fresh_priority",
    label: "Fresh priority",
    enabled: true,
    fresh: { eligible: true, targetOpen: 5, priorityWeight: 100 },
    day2to15: { targetOpen: 15 },
    aged: { targetOpen: 5 },
  },
});

function readPolicyNumber(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : fallback;
}

function resolveAccountQueuePolicy(account = null) {
  const hasAccount = account && typeof account === "object" && Object.keys(account).length > 0;
  const rawPolicy = hasAccount && account.cxQueuePolicy && typeof account.cxQueuePolicy === "object"
    ? account.cxQueuePolicy
    : {};
  const explicitTier = String(rawPolicy.tier || "").trim();
  const defaultTier =
    !hasAccount || account.status === "disabled"
      ? "no_leads"
      : account.role === "admin" || account.audience === "admin"
        ? "no_leads"
        : "fresh_priority";
  const base = CX_QUEUE_TIER_POLICIES[explicitTier] || CX_QUEUE_TIER_POLICIES[defaultTier];
  const enabled = rawPolicy.enabled === false ? false : Boolean(base.enabled);
  if (!enabled) return CX_QUEUE_TIER_POLICIES.no_leads;

  const freshEligible =
    rawPolicy.fresh?.eligible == null
      ? Boolean(base.fresh.eligible)
      : Boolean(rawPolicy.fresh.eligible);

  return {
    tier: base.tier,
    label: base.label,
    enabled: true,
    fresh: {
      eligible: freshEligible,
      targetOpen: freshEligible
        ? readPolicyNumber(rawPolicy.fresh?.targetOpen, base.fresh.targetOpen)
        : 0,
      hourlyCap: readPolicyNumber(rawPolicy.fresh?.hourlyCap, base.fresh.hourlyCap ?? null),
      priorityWeight: readPolicyNumber(rawPolicy.fresh?.priorityWeight, base.fresh.priorityWeight),
    },
    day2to15: {
      targetOpen: readPolicyNumber(rawPolicy.day2to15?.targetOpen, base.day2to15.targetOpen),
    },
    aged: {
      targetOpen: readPolicyNumber(rawPolicy.aged?.targetOpen, base.aged.targetOpen),
    },
  };
}

function getPolicyBucketForQueueFamily(policy = null, queueFamily = null) {
  const resolved = policy && typeof policy === "object" && policy.tier
    ? policy
    : resolveAccountQueuePolicy(policy);
  switch (normalizeQueueFamily(queueFamily)) {
    case "fresh-day1":
      return resolved.fresh || {};
    case "fresh-day2to10":
      return resolved.day2to15 || {};
    case "aged":
      return resolved.aged || {};
    default:
      return {};
  }
}

function getQueueFamilyTargetOpen(policy = null, queueFamily = null) {
  const resolved = policy && typeof policy === "object" && policy.tier
    ? policy
    : resolveAccountQueuePolicy(policy);
  if (!resolved.enabled) return 0;
  const normalizedFamily = normalizeQueueFamily(queueFamily);
  if (normalizedFamily === "fresh-day1" && !resolved.fresh?.eligible) return 0;
  const bucket = getPolicyBucketForQueueFamily(resolved, normalizedFamily);
  return Math.max(Number(bucket.targetOpen || 0) || 0, 0);
}

function isQueueFamilyAllowedForAccountPolicy(policy = null, queueFamily = null) {
  const resolved = policy && typeof policy === "object" && policy.tier
    ? policy
    : resolveAccountQueuePolicy(policy);
  if (!resolved.enabled) return false;
  const normalizedFamily = normalizeQueueFamily(queueFamily);
  if (normalizedFamily === "unassigned") return true;
  return getQueueFamilyTargetOpen(resolved, normalizedFamily) > 0;
}

function normalizeQueueFamily(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (
    normalized === "fresh-day1"
    || normalized === "day0"
    || normalized === "first-day"
    || normalized === "fresh"
    || normalized === "hot"
    || normalized === "new"
  ) {
    return "fresh-day1";
  }
  if (
    normalized === "fresh-day2to10"
    || normalized === "fresh-day2to15"
    || normalized === "day2to10"
    || normalized === "day2to15"
    || normalized === "day2-10"
    || normalized === "day2-15"
    || normalized === "day 2-10"
    || normalized === "day 2-15"
    || normalized === "day1"
    || normalized === "day10"
    || normalized === "day15"
    || normalized === "later"
    || normalized.includes("2-10")
    || normalized.includes("2-15")
  ) {
    return "fresh-day2to10";
  }
  if (normalized === "aged" || normalized.includes("aged") || normalized.includes("prospect")) return "aged";
  return "unassigned";
}

function getQueueFamilySortRank(value) {
  const normalized = normalizeQueueFamily(value);
  return Number(QUEUE_FAMILY_SORT_RANKS[normalized] ?? QUEUE_FAMILY_SORT_RANKS.unassigned);
}

function getQueueFamilyPolicy(value) {
  const normalized = normalizeQueueFamily(value);
  return QUEUE_FAMILY_POLICIES[normalized] || QUEUE_FAMILY_POLICIES.unassigned;
}

function getPacificDateKey(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: QUEUE_TIMEZONE,
  }).format(new Date(date));
}

function getPacificParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: QUEUE_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(date));
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(lookup.year),
    month: Number(lookup.month),
    day: Number(lookup.day),
    hour: Number(lookup.hour),
    minute: Number(lookup.minute),
    second: Number(lookup.second),
  };
}

function getPacificOffsetMs(date = new Date()) {
  const parts = getPacificParts(date);
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

function makePacificDate(year, month, day, hour = 0, minute = 0, second = 0) {
  let utcMs = Date.UTC(year, month - 1, day, hour, minute, second, 0);
  for (let index = 0; index < 3; index += 1) {
    utcMs = Date.UTC(year, month - 1, day, hour, minute, second, 0)
      - getPacificOffsetMs(new Date(utcMs));
  }
  return new Date(utcMs);
}

function getNextPacificDayStart(date = new Date()) {
  const parts = getPacificParts(date);
  const nextNoonGuess = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1, 12, 0, 0, 0));
  const nextParts = getPacificParts(nextNoonGuess);
  return makePacificDate(nextParts.year, nextParts.month, nextParts.day, 0, 5, 0);
}

function getDailyPlacedCalls(item = {}, asOf = new Date()) {
  const dateKey = getPacificDateKey(asOf);
  const itemDateKey = String(item.dailyPlacedDateKey || item.metadata?.dailyPlacedDateKey || "").trim();
  if (itemDateKey !== dateKey) return 0;
  return Math.max(Number(item.dailyPlacedCalls ?? item.metadata?.dailyPlacedCalls ?? 0) || 0, 0);
}

function buildCallAttemptPatch(item = {}, placedAt = new Date()) {
  const dateKey = getPacificDateKey(placedAt);
  const priorDateKey = String(item.dailyPlacedDateKey || item.metadata?.dailyPlacedDateKey || "").trim();
  const priorDailyCount = priorDateKey === dateKey
    ? Math.max(Number(item.dailyPlacedCalls ?? item.metadata?.dailyPlacedCalls ?? 0) || 0, 0)
    : 0;
  const nextDailyCount = priorDailyCount + 1;
  const nextTotalCount = Math.max(Number(item.placedCalls || 0) || 0, 0) + 1;
  return {
    placedCalls: nextTotalCount,
    lastPlacedAt: placedAt,
    dailyPlacedDateKey: dateKey,
    dailyPlacedCalls: nextDailyCount,
    "metadata.dailyPlacedDateKey": dateKey,
    "metadata.dailyPlacedCalls": nextDailyCount,
    "metadata.lastQueueAttemptAt": placedAt,
  };
}

function getCooldownReleaseAt(item = {}, now = new Date()) {
  const policy = getQueueFamilyPolicy(item.queueFamily || item.metadata?.queueFamily);
  const placedAt = item.lastPlacedAt || item.metadata?.lastQueueAttemptAt || null;
  const base = placedAt ? new Date(placedAt) : new Date(now);
  if (Number.isNaN(base.getTime())) return new Date(now);
  return new Date(base.getTime() + Math.max(Number(policy.cooldownMinutes) || 0, 0) * 60 * 1000);
}

function resolveQueueDialability(item = {}, now = new Date()) {
  const policy = getQueueFamilyPolicy(item.queueFamily || item.metadata?.queueFamily);
  const dailyCount = getDailyPlacedCalls(item, now);
  if (policy.dailyMax != null && dailyCount >= Number(policy.dailyMax)) {
    return {
      ok: false,
      reason: "daily-cap-reached",
      detail: `${policy.label} daily contact cap reached`,
      nextEligibleAt: getNextPacificDayStart(now),
      dailyCount,
      dailyMax: Number(policy.dailyMax),
      policy,
    };
  }

  const nextByCooldown = getCooldownReleaseAt(item, now);
  if (item.lastPlacedAt && nextByCooldown.getTime() > new Date(now).getTime()) {
    return {
      ok: false,
      reason: "cooldown-active",
      detail: `${policy.label} cooldown is still active`,
      nextEligibleAt: nextByCooldown,
      dailyCount,
      dailyMax: policy.dailyMax,
      policy,
    };
  }

  return {
    ok: true,
    reason: "dialable",
    nextEligibleAt: null,
    dailyCount,
    dailyMax: policy.dailyMax,
    policy,
  };
}

function deriveQueueFamilyFromAgeDays(ageDays) {
  const numericAge = Number(ageDays);
  if (!Number.isFinite(numericAge)) return "fresh-day1";
  if (numericAge <= 1) return "fresh-day1";
  if (numericAge <= 15) return "fresh-day2to10";
  return "aged";
}

module.exports = {
  buildCallAttemptPatch,
  CX_QUEUE_TIER_POLICIES,
  deriveQueueFamilyFromAgeDays,
  getCooldownReleaseAt,
  getDailyPlacedCalls,
  getPacificDateKey,
  getQueueFamilyPolicy,
  getQueueFamilySortRank,
  getQueueFamilyTargetOpen,
  isQueueFamilyAllowedForAccountPolicy,
  normalizeQueueFamily,
  resolveAccountQueuePolicy,
  resolveQueueDialability,
  QUEUE_FAMILY_POLICIES,
  QUEUE_TIMEZONE,
};
