"use strict";

const {
  normalizeLeadQueueFamily,
} = require("../../shared-normalizers/src");
const {
  buildCxHourlyAttemptPatch,
  getCxHourlyPacingStatus,
} = require("./cxQueueFairnessService");

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
    dailyMax: 5,
  },
  "fresh-day2to10": {
    key: "fresh-day2to10",
    label: "2-15",
    claimMinutes: 30,
    cooldownMinutes: 25,
    dailyMax: 3,
  },
  aged: {
    key: "aged",
    label: "Aged",
    claimMinutes: 60,
    cooldownMinutes: 60,
    dailyMax: 1,
  },
  unassigned: {
    key: "unassigned",
    label: "Other",
    claimMinutes: 30,
    cooldownMinutes: 30,
    dailyMax: null,
  },
});

const MANUAL_NO_LEADS_POLICY = Object.freeze({
  tier: null,
  label: "Manual",
  enabled: false,
  fresh: { eligible: false, firstTouchEligible: false, targetOpen: 0, hourlyCap: null, priorityWeight: 0 },
  day2to15: { targetOpen: 0 },
  aged: { targetOpen: 0 },
});

function readPolicyNumber(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : fallback;
}

function readEnvNumber(names, fallback) {
  const list = Array.isArray(names) ? names : [names];
  for (const name of list) {
    if (!Object.prototype.hasOwnProperty.call(process.env, name)) continue;
    const number = Number(process.env[name]);
    if (Number.isFinite(number) && number >= 0) return Math.trunc(number);
  }
  return fallback;
}

function readEnvBoolean(names, fallback) {
  const list = Array.isArray(names) ? names : [names];
  for (const name of list) {
    if (!Object.prototype.hasOwnProperty.call(process.env, name)) continue;
    const raw = String(process.env[name] || "").trim().toLowerCase();
    if (!raw) continue;
    if (["1", "true", "yes", "on"].includes(raw)) return true;
    if (["0", "false", "no", "off"].includes(raw)) return false;
  }
  return fallback;
}

function hasPolicyValue(value) {
  return value !== null && value !== undefined && value !== "";
}

function hasManualQueuePolicy(input = null) {
  if (!input || typeof input !== "object") return false;
  return (
    input.enabled === false
    || hasPolicyValue(input.fresh?.eligible)
    || hasPolicyValue(input.fresh?.firstTouchEligible)
    || hasPolicyValue(input.fresh?.targetOpen)
    || hasPolicyValue(input.day2to15?.targetOpen)
    || hasPolicyValue(input.aged?.targetOpen)
  );
}

function cloneNoLeadsPolicy() {
  return {
    ...MANUAL_NO_LEADS_POLICY,
    fresh: { ...MANUAL_NO_LEADS_POLICY.fresh },
    day2to15: { ...MANUAL_NO_LEADS_POLICY.day2to15 },
    aged: { ...MANUAL_NO_LEADS_POLICY.aged },
  };
}

function isResolvedQueuePolicy(policy = null) {
  return Boolean(
    policy
      && typeof policy === "object"
      && Object.prototype.hasOwnProperty.call(policy, "label")
      && Object.prototype.hasOwnProperty.call(policy, "enabled")
      && policy.fresh
      && policy.day2to15
      && policy.aged,
  );
}

function resolveQueueFamilyDailyMax(queueFamily, fallback) {
  const normalizedFamily = normalizeQueueFamily(queueFamily);
  if (normalizedFamily === "fresh-day1") {
    return readEnvNumber(["RC_CX_GREEN_DAILY_MAX", "RC_CX_FRESH_DAILY_MAX"], fallback);
  }
  if (normalizedFamily === "fresh-day2to10") {
    return readEnvNumber(["RC_CX_BLUE_DAILY_MAX", "RC_CX_DAY2TO15_DAILY_MAX"], fallback);
  }
  if (normalizedFamily === "aged") {
    return readEnvNumber(["RC_CX_RED_DAILY_MAX", "RC_CX_AGED_DAILY_MAX"], fallback);
  }
  return fallback;
}

function resolveAccountQueuePolicy(account = null) {
  const hasAccount = account && typeof account === "object" && Object.keys(account).length > 0;
  const rawPolicy = hasAccount && account.cxQueuePolicy && typeof account.cxQueuePolicy === "object"
    ? account.cxQueuePolicy
    : {};
  if (!hasAccount || account.status === "disabled") return cloneNoLeadsPolicy();
  if (!hasManualQueuePolicy(rawPolicy)) return cloneNoLeadsPolicy();

  const freshTargetOpen = readPolicyNumber(rawPolicy.fresh?.targetOpen, 0);
  const day2to15TargetOpen = readPolicyNumber(rawPolicy.day2to15?.targetOpen, 0);
  const agedTargetOpen = readPolicyNumber(rawPolicy.aged?.targetOpen, 0);

  const firstTouchEligible =
    rawPolicy.fresh?.firstTouchEligible == null
      ? Boolean(rawPolicy.fresh?.eligible)
      : Boolean(rawPolicy.fresh.firstTouchEligible);
  const freshEligible =
    freshTargetOpen > 0
    || firstTouchEligible
    || Boolean(rawPolicy.fresh?.eligible);
  const enabled =
    rawPolicy.enabled !== false
    && (freshTargetOpen > 0 || day2to15TargetOpen > 0 || agedTargetOpen > 0 || firstTouchEligible);
  if (!enabled) return cloneNoLeadsPolicy();

  return {
    tier: null,
    label: "Manual",
    enabled: true,
    fresh: {
      eligible: freshEligible,
      firstTouchEligible: freshEligible && firstTouchEligible,
      targetOpen: freshEligible ? freshTargetOpen : 0,
      hourlyCap: readPolicyNumber(rawPolicy.fresh?.hourlyCap, null),
      priorityWeight: readPolicyNumber(
        rawPolicy.fresh?.priorityWeight,
        freshEligible ? 100 : 0,
      ),
    },
    day2to15: {
      targetOpen: day2to15TargetOpen,
    },
    aged: {
      targetOpen: agedTargetOpen,
    },
  };
}

function getPolicyBucketForQueueFamily(policy = null, queueFamily = null) {
  const resolved = isResolvedQueuePolicy(policy)
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
  const resolved = isResolvedQueuePolicy(policy)
    ? policy
    : resolveAccountQueuePolicy(policy);
  if (!resolved.enabled) return 0;
  const normalizedFamily = normalizeQueueFamily(queueFamily);
  if (normalizedFamily === "fresh-day1" && !resolved.fresh?.eligible) return 0;
  const bucket = getPolicyBucketForQueueFamily(resolved, normalizedFamily);
  return Math.max(Number(bucket.targetOpen || 0) || 0, 0);
}

function isQueueFamilyAllowedForAccountPolicy(policy = null, queueFamily = null) {
  const resolved = isResolvedQueuePolicy(policy)
    ? policy
    : resolveAccountQueuePolicy(policy);
  if (!resolved.enabled) return false;
  const normalizedFamily = normalizeQueueFamily(queueFamily);
  if (normalizedFamily === "unassigned") return true;
  return getQueueFamilyTargetOpen(resolved, normalizedFamily) > 0;
}

function normalizeQueueFamily(value) {
  return normalizeLeadQueueFamily(value);
}

function getQueueFamilySortRank(value) {
  const normalized = normalizeQueueFamily(value);
  return Number(QUEUE_FAMILY_SORT_RANKS[normalized] ?? QUEUE_FAMILY_SORT_RANKS.unassigned);
}

function getQueueFamilyPolicy(value) {
  const normalized = normalizeQueueFamily(value);
  const policy = QUEUE_FAMILY_POLICIES[normalized] || QUEUE_FAMILY_POLICIES.unassigned;
  return {
    ...policy,
    dailyMax: resolveQueueFamilyDailyMax(normalized, policy.dailyMax),
  };
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

function getPacificBusinessDayParts(date = new Date(), rolloverHour = 16) {
  const parts = getPacificParts(date);
  if (parts.hour >= rolloverHour) {
    return {
      year: parts.year,
      month: parts.month,
      day: parts.day,
    };
  }
  const previousDayGuess = new Date(Date.UTC(parts.year, parts.month - 1, parts.day - 1, 12, 0, 0, 0));
  const previousParts = getPacificParts(previousDayGuess);
  return {
    year: previousParts.year,
    month: previousParts.month,
    day: previousParts.day,
  };
}

function getPacificBusinessDayStart(date = new Date(), rolloverHour = 16) {
  const parts = getPacificBusinessDayParts(date, rolloverHour);
  return makePacificDate(parts.year, parts.month, parts.day, rolloverHour, 0, 0);
}

function getPacificFreshExpiry(date = new Date(), rolloverHour = 16, graceEndHour = 18) {
  const parts = getPacificBusinessDayParts(date, rolloverHour);
  const nextDayGuess = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1, 12, 0, 0, 0));
  const nextParts = getPacificParts(nextDayGuess);
  return makePacificDate(nextParts.year, nextParts.month, nextParts.day, graceEndHour, 0, 0);
}

function getPacificBusinessDaySerial(date = new Date(), rolloverHour = 16) {
  const parts = getPacificBusinessDayParts(date, rolloverHour);
  return Math.floor(Date.UTC(parts.year, parts.month - 1, parts.day) / (24 * 60 * 60 * 1000));
}

function getPacificBusinessDayAge(createdAt, asOf = new Date(), rolloverHour = 16, graceEndHour = 18) {
  const created = createdAt ? new Date(createdAt) : null;
  const now = asOf ? new Date(asOf) : new Date();
  if (!created || Number.isNaN(created.getTime()) || Number.isNaN(now.getTime())) return null;
  const freshExpiresAt = getPacificFreshExpiry(created, rolloverHour, graceEndHour);
  if (now.getTime() < freshExpiresAt.getTime()) return 0;
  return Math.max(
    getPacificBusinessDaySerial(now, rolloverHour) - getPacificBusinessDaySerial(created, rolloverHour),
    1,
  );
}

function normalizePlacedCallCount(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const number = Number(value);
    if (Number.isFinite(number)) return Math.max(Math.trunc(number), 0);
  }
  return null;
}

function getTouchAgeFreshWindowDays() {
  return readEnvNumber(
    [
      "RC_CX_TOUCH_AGE_FRESH_WINDOW_DAYS",
      "RC_CX_FIRST_TOUCH_WINDOW_DAYS",
    ],
    5,
  );
}

function getTouchAgeFreshMaxCalls() {
  return readEnvNumber(
    [
      "RC_CX_TOUCH_AGE_FRESH_MAX_CALLS",
      "RC_CX_FIRST_TOUCH_GREEN_MAX_CALLS",
    ],
    Math.max(readEnvNumber(["RC_CX_GREEN_DAILY_MAX", "RC_CX_FRESH_DAILY_MAX"], 5) - 1, 0),
  );
}

function isTouchAgeBucketingEnabled() {
  return readEnvBoolean(
    [
      "RC_CX_TOUCH_AGE_ENABLED",
      "RC_CX_FIRST_TOUCH_AGE_ENABLED",
    ],
    true,
  );
}

function deriveQueueFamilyFromLeadTouchState(input = {}) {
  const asOf = input.asOf || new Date();
  const numericAge = Number(input.ageDays);
  const businessAge = Number.isFinite(numericAge)
    ? numericAge
    : getPacificBusinessDayAge(
      input.createdAt,
      asOf,
      input.rolloverHour,
      input.graceEndHour,
    );
  if (!Number.isFinite(businessAge)) return null;

  const ageFamily = deriveQueueFamilyFromAgeDays(businessAge);
  if (!isTouchAgeBucketingEnabled() || ageFamily === "aged") return ageFamily;

  const placedCalls = normalizePlacedCallCount(
    input.placedCalls,
    input.totalPlacedCalls,
    input.totalCalls,
    input.callCount,
  );
  if (placedCalls == null) return ageFamily;

  const freshWindowDays = Math.max(getTouchAgeFreshWindowDays(), 0);
  const freshMaxCalls = Math.max(getTouchAgeFreshMaxCalls(), 0);
  if (businessAge <= freshWindowDays && placedCalls <= freshMaxCalls) {
    return "fresh-day1";
  }

  return ageFamily;
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
    ...buildCxHourlyAttemptPatch(item, placedAt),
  };
}

function maxDate(...dates) {
  const times = dates
    .map((date) => date ? new Date(date).getTime() : Number.NaN)
    .filter((time) => Number.isFinite(time));
  if (times.length === 0) return null;
  return new Date(Math.max(...times));
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
  const nextByCooldown = getCooldownReleaseAt(item, now);
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

  const hourlyPacing = getCxHourlyPacingStatus(item, now);
  if (hourlyPacing.capped) {
    return {
      ok: false,
      reason: "hourly-cap-reached",
      detail: `${policy.label} hourly contact cap reached`,
      nextEligibleAt: maxDate(hourlyPacing.nextEligibleAt, nextByCooldown),
      dailyCount,
      dailyMax: policy.dailyMax,
      hourlyCount: hourlyPacing.count,
      hourlyMax: hourlyPacing.cap,
      hourlyPacing,
      policy,
    };
  }

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
    hourlyCount: hourlyPacing.count,
    hourlyMax: hourlyPacing.cap,
    policy,
  };
}

function deriveQueueFamilyFromAgeDays(ageDays) {
  const numericAge = Number(ageDays);
  if (!Number.isFinite(numericAge)) return "fresh-day1";
  if (numericAge <= 0) return "fresh-day1";
  if (numericAge <= 14) return "fresh-day2to10";
  return "aged";
}

function deriveQueueFamilyFromLeadCreatedAt(createdAt, asOf = new Date(), options = {}) {
  return deriveQueueFamilyFromLeadTouchState({
    ...options,
    createdAt,
    asOf,
  });
}

module.exports = {
  buildCallAttemptPatch,
  deriveQueueFamilyFromAgeDays,
  deriveQueueFamilyFromLeadCreatedAt,
  deriveQueueFamilyFromLeadTouchState,
  getCooldownReleaseAt,
  getDailyPlacedCalls,
  getPacificBusinessDayAge,
  getPacificBusinessDayStart,
  getPacificDateKey,
  getPacificFreshExpiry,
  getQueueFamilyPolicy,
  getQueueFamilySortRank,
  getQueueFamilyTargetOpen,
  hasManualQueuePolicy,
  getTouchAgeFreshMaxCalls,
  getTouchAgeFreshWindowDays,
  isQueueFamilyAllowedForAccountPolicy,
  isTouchAgeBucketingEnabled,
  normalizeQueueFamily,
  normalizePlacedCallCount,
  resolveAccountQueuePolicy,
  resolveQueueDialability,
  QUEUE_FAMILY_POLICIES,
  QUEUE_TIMEZONE,
};
