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
  "fresh-day16to30": 2,
  aged: 3,
  dead: 4,
  unassigned: 5,
});

const QUEUE_FAMILY_POLICIES = Object.freeze({
  "fresh-day1": {
    key: "fresh-day1",
    label: "New",
    claimMinutes: 15,
    cooldownMinutes: 90,
    dailyMax: 5,
  },
  "fresh-day2to10": {
    key: "fresh-day2to10",
    label: "3-15",
    claimMinutes: 30,
    cooldownMinutes: 120,
    dailyMax: 3,
  },
  "fresh-day16to30": {
    key: "fresh-day16to30",
    label: "16-30",
    claimMinutes: 60,
    cooldownMinutes: 24 * 60,
    dailyMax: 1,
  },
  aged: {
    key: "aged",
    label: "31-120",
    claimMinutes: 60,
    cooldownMinutes: 14 * 24 * 60,
    dailyMax: 1,
    monthlyMax: 2,
  },
  dead: {
    key: "dead",
    label: "Dead",
    claimMinutes: 60,
    cooldownMinutes: 0,
    dailyMax: 0,
    monthlyMax: 0,
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
  routeCampaigns: null,
  totalOpen: 0,
  fresh: { eligible: false, firstTouchEligible: false, targetOpen: 0, hourlyCap: null, priorityWeight: 0 },
  day2to15: { targetOpen: 0 },
  day16to30: { targetOpen: 0 },
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
    || hasPolicyValue(input.day16to30?.targetOpen)
    || hasPolicyValue(input.aged?.targetOpen)
    || hasPolicyValue(input.totalOpen)
    || hasPolicyValue(input.routeCampaigns)
  );
}

function cloneNoLeadsPolicy() {
  return {
    ...MANUAL_NO_LEADS_POLICY,
    fresh: { ...MANUAL_NO_LEADS_POLICY.fresh },
    day2to15: { ...MANUAL_NO_LEADS_POLICY.day2to15 },
    day16to30: { ...MANUAL_NO_LEADS_POLICY.day16to30 },
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
      && policy.day16to30
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
  if (normalizedFamily === "fresh-day16to30") {
    return readEnvNumber(["RC_CX_YELLOW_DAILY_MAX", "RC_CX_DAY16TO30_DAILY_MAX"], fallback);
  }
  if (normalizedFamily === "aged") {
    return readEnvNumber(["RC_CX_RED_DAILY_MAX", "RC_CX_AGED_DAILY_MAX"], fallback);
  }
  if (normalizedFamily === "dead") return 0;
  return fallback;
}

function resolveQueueFamilyCooldownMinutes(queueFamily, fallback) {
  const normalizedFamily = normalizeQueueFamily(queueFamily);
  if (normalizedFamily === "fresh-day1") {
    return readEnvNumber(["RC_CX_FRESH_COOLDOWN_MINUTES", "RC_CX_GREEN_COOLDOWN_MINUTES"], fallback);
  }
  if (normalizedFamily === "fresh-day2to10") {
    return readEnvNumber(["RC_CX_DAY2TO15_COOLDOWN_MINUTES", "RC_CX_BLUE_COOLDOWN_MINUTES"], fallback);
  }
  if (normalizedFamily === "fresh-day16to30") {
    return readEnvNumber(["RC_CX_DAY16TO30_COOLDOWN_MINUTES", "RC_CX_YELLOW_COOLDOWN_MINUTES"], fallback);
  }
  if (normalizedFamily === "aged") {
    return readEnvNumber(["RC_CX_AGED_COOLDOWN_MINUTES", "RC_CX_RED_COOLDOWN_MINUTES"], fallback);
  }
  return fallback;
}

function normalizeRouteCampaigns(value) {
  if (value === null || value === undefined || value === "") return null;
  const raw = Array.isArray(value) ? value : String(value).split(",");
  const normalized = Array.from(
    new Set(
      raw
        .map((entry) => String(entry || "").trim().toLowerCase())
        .filter(Boolean),
    ),
  );
  return normalized.length > 0 ? normalized : null;
}

// Route-campaign subscriptions are consumed by workspace refill only.
//
// Plan: read `account.cxQueuePolicy.routeCampaigns` (optional string[],
// e.g. ["ld-custom"] or ["ld-general", "organic"]) and surface it on
// the returned policy object as `routeCampaigns`. Empty / unset = "all"
// (back-compat for every existing agent). The intake path already
// stamps `routeCampaignKey` on every LeadCadence (see ROUTE_CAMPAIGNS
// in inboundIntakeService.js — `ld-custom` and `ld-general` are live),
// so the filter consumer just needs to read the policy field. No
// schema migration required — cxQueuePolicy is Mixed.
//
// Consumed by: materializeQueueSupplyForAgent (cxWorkspaceService.js)
// and any future "is this lead eligible for this agent" gate. Buckets
// are subscription-based, NOT lead-side partitioning — a lead can
// surface to anyone whose subscription includes its routeCampaignKey.
function resolveAccountQueuePolicy(account = null) {
  const hasAccount = account && typeof account === "object" && Object.keys(account).length > 0;
  const rawPolicy = hasAccount && account.cxQueuePolicy && typeof account.cxQueuePolicy === "object"
    ? account.cxQueuePolicy
    : {};
  if (!hasAccount || account.status === "disabled") return cloneNoLeadsPolicy();
  if (!hasManualQueuePolicy(rawPolicy)) return cloneNoLeadsPolicy();

  const hasFreshTarget = hasPolicyValue(rawPolicy.fresh?.targetOpen);
  const hasDay2to15Target = hasPolicyValue(rawPolicy.day2to15?.targetOpen);
  const hasDay16to30Target = hasPolicyValue(rawPolicy.day16to30?.targetOpen);
  const hasAgedTarget = hasPolicyValue(rawPolicy.aged?.targetOpen);
  const hasAnyFamilyTarget =
    hasFreshTarget || hasDay2to15Target || hasDay16to30Target || hasAgedTarget;
  const freshTargetOpen = readPolicyNumber(rawPolicy.fresh?.targetOpen, 0);
  const day2to15TargetOpen = readPolicyNumber(rawPolicy.day2to15?.targetOpen, 0);
  const day16to30TargetOpen = readPolicyNumber(rawPolicy.day16to30?.targetOpen, 0);
  const agedTargetOpen = readPolicyNumber(rawPolicy.aged?.targetOpen, 0);
  const legacyTotalOpen = freshTargetOpen + day2to15TargetOpen + day16to30TargetOpen + agedTargetOpen;
  const totalOpen = hasPolicyValue(rawPolicy.totalOpen)
    ? readPolicyNumber(rawPolicy.totalOpen, 0)
    : (legacyTotalOpen > 0 ? legacyTotalOpen : readEnvNumber("RC_CX_TOTAL_OPEN_DEFAULT", 25));
  const routeCampaigns = normalizeRouteCampaigns(rawPolicy.routeCampaigns);

  const firstTouchEligible =
    rawPolicy.fresh?.firstTouchEligible == null
      ? Boolean(rawPolicy.fresh?.eligible)
      : Boolean(rawPolicy.fresh.firstTouchEligible);
  const resolvedFreshTarget = hasFreshTarget
    ? freshTargetOpen
    : (!hasAnyFamilyTarget && firstTouchEligible ? totalOpen : 0);
  const resolvedDay2to15Target = hasDay2to15Target
    ? day2to15TargetOpen
    : (!hasAnyFamilyTarget && !firstTouchEligible ? totalOpen : 0);
  const resolvedDay16to30Target = hasDay16to30Target ? day16to30TargetOpen : 0;
  const resolvedAgedTarget = hasAgedTarget ? agedTargetOpen : 0;
  const freshEligible =
    resolvedFreshTarget > 0
    || firstTouchEligible
    || (!hasFreshTarget && Boolean(rawPolicy.fresh?.eligible));
  const enabled =
    rawPolicy.enabled !== false
    && (
      totalOpen > 0
      || freshTargetOpen > 0
      || day2to15TargetOpen > 0
      || day16to30TargetOpen > 0
      || agedTargetOpen > 0
      || firstTouchEligible
    );
  if (!enabled) return cloneNoLeadsPolicy();

  return {
    tier: null,
    label: "Manual",
    enabled: true,
    routeCampaigns,
    totalOpen,
    fresh: {
      eligible: freshEligible,
      firstTouchEligible: freshEligible && firstTouchEligible,
      targetOpen: freshEligible ? resolvedFreshTarget : 0,
      hourlyCap: readPolicyNumber(rawPolicy.fresh?.hourlyCap, null),
      priorityWeight: readPolicyNumber(
        rawPolicy.fresh?.priorityWeight,
        freshEligible ? 100 : 0,
      ),
    },
    day2to15: {
      targetOpen: resolvedDay2to15Target,
    },
    day16to30: {
      targetOpen: resolvedDay16to30Target,
    },
    aged: {
      targetOpen: resolvedAgedTarget,
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
    case "fresh-day16to30":
      return resolved.day16to30 || {};
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
  if (normalizedFamily === "dead") return false;
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
    cooldownMinutes: resolveQueueFamilyCooldownMinutes(normalized, policy.cooldownMinutes),
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

function getGreenRolloverHour() {
  return readEnvNumber(["RC_CX_GREEN_ROLLOVER_HOUR", "RC_CX_FRESH_ROLLOVER_HOUR"], 15);
}

function getGreenRolloverMinute() {
  return readEnvNumber(["RC_CX_GREEN_ROLLOVER_MINUTE", "RC_CX_FRESH_ROLLOVER_MINUTE"], 30);
}

function getPacificBusinessDayParts(
  date = new Date(),
  rolloverHour = getGreenRolloverHour(),
  rolloverMinute = getGreenRolloverMinute(),
) {
  const parts = getPacificParts(date);
  const afterRollover =
    parts.hour > rolloverHour ||
    (parts.hour === rolloverHour && parts.minute >= rolloverMinute);
  if (afterRollover) {
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

function getPacificBusinessDayStart(
  date = new Date(),
  rolloverHour = getGreenRolloverHour(),
  rolloverMinute = getGreenRolloverMinute(),
) {
  const parts = getPacificBusinessDayParts(date, rolloverHour, rolloverMinute);
  return makePacificDate(parts.year, parts.month, parts.day, rolloverHour, rolloverMinute, 0);
}

function getPacificFreshExpiry(
  date = new Date(),
  rolloverHour = getGreenRolloverHour(),
  graceEndHour = null,
  rolloverMinute = getGreenRolloverMinute(),
) {
  const parts = getPacificBusinessDayParts(date, rolloverHour, rolloverMinute);
  const nextDayGuess = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1, 12, 0, 0, 0));
  const nextParts = getPacificParts(nextDayGuess);
  const endHour = graceEndHour == null ? rolloverHour : graceEndHour;
  const endMinute = graceEndHour == null ? rolloverMinute : 0;
  return makePacificDate(nextParts.year, nextParts.month, nextParts.day, endHour, endMinute, 0);
}

function getPacificBusinessDaySerial(
  date = new Date(),
  rolloverHour = getGreenRolloverHour(),
  rolloverMinute = getGreenRolloverMinute(),
) {
  const parts = getPacificBusinessDayParts(date, rolloverHour, rolloverMinute);
  return Math.floor(Date.UTC(parts.year, parts.month - 1, parts.day) / (24 * 60 * 60 * 1000));
}

function getPacificBusinessDayAge(
  createdAt,
  asOf = new Date(),
  rolloverHour = getGreenRolloverHour(),
  graceEndHour = null,
  rolloverMinute = getGreenRolloverMinute(),
) {
  const created = createdAt ? new Date(createdAt) : null;
  const now = asOf ? new Date(asOf) : new Date();
  if (!created || Number.isNaN(created.getTime()) || Number.isNaN(now.getTime())) return null;
  const freshExpiresAt = getPacificFreshExpiry(created, rolloverHour, graceEndHour, rolloverMinute);
  if (now.getTime() < freshExpiresAt.getTime()) return 0;
  return Math.max(
    getPacificBusinessDaySerial(now, rolloverHour, rolloverMinute) -
      getPacificBusinessDaySerial(created, rolloverHour, rolloverMinute),
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
    1,
  );
}

function getTouchAgeFreshMaxCalls() {
  return readEnvNumber(
    [
      "RC_CX_TOUCH_AGE_FRESH_MAX_CALLS",
      "RC_CX_FIRST_TOUCH_GREEN_MAX_CALLS",
    ],
    7,
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
      input.rolloverMinute,
    );
  if (!Number.isFinite(businessAge)) return null;

  const ageFamily = deriveQueueFamilyFromAgeDays(businessAge);
  if (!isTouchAgeBucketingEnabled() || ageFamily === "aged" || ageFamily === "dead") return ageFamily;

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
  if (ageFamily === "fresh-day1" && placedCalls > freshMaxCalls) {
    return "fresh-day2to10";
  }

  return ageFamily;
}

function getNextPacificDayStart(date = new Date()) {
  const parts = getPacificParts(date);
  const nextNoonGuess = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1, 12, 0, 0, 0));
  const nextParts = getPacificParts(nextNoonGuess);
  return makePacificDate(nextParts.year, nextParts.month, nextParts.day, 8, 0, 0);
}

function getPacificMonthKey(date = new Date()) {
  const parts = getPacificParts(date);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}`;
}

function getDailyPlacedCalls(item = {}, asOf = new Date()) {
  const dateKey = getPacificDateKey(asOf);
  const itemDateKey = String(item.dailyPlacedDateKey || item.metadata?.dailyPlacedDateKey || "").trim();
  if (itemDateKey !== dateKey) return 0;
  return Math.max(Number(item.dailyPlacedCalls ?? item.metadata?.dailyPlacedCalls ?? 0) || 0, 0);
}

function buildCallAttemptPatch(item = {}, placedAt = new Date()) {
  const dateKey = getPacificDateKey(placedAt);
  const monthKey = getPacificMonthKey(placedAt);
  const priorDateKey = String(item.dailyPlacedDateKey || item.metadata?.dailyPlacedDateKey || "").trim();
  const priorMonthKey = String(item.monthlyPlacedMonthKey || item.metadata?.monthlyPlacedMonthKey || "").trim();
  const priorDailyCount = priorDateKey === dateKey
    ? Math.max(Number(item.dailyPlacedCalls ?? item.metadata?.dailyPlacedCalls ?? 0) || 0, 0)
    : 0;
  const priorMonthlyCount = priorMonthKey === monthKey
    ? Math.max(Number(item.monthlyPlacedCalls ?? item.metadata?.monthlyPlacedCalls ?? 0) || 0, 0)
    : 0;
  const nextDailyCount = priorDailyCount + 1;
  const nextMonthlyCount = priorMonthlyCount + 1;
  const nextTotalCount = Math.max(Number(item.placedCalls || 0) || 0, 0) + 1;
  return {
    placedCalls: nextTotalCount,
    lastPlacedAt: placedAt,
    dailyPlacedDateKey: dateKey,
    dailyPlacedCalls: nextDailyCount,
    monthlyPlacedMonthKey: monthKey,
    monthlyPlacedCalls: nextMonthlyCount,
    "metadata.dailyPlacedDateKey": dateKey,
    "metadata.dailyPlacedCalls": nextDailyCount,
    "metadata.monthlyPlacedMonthKey": monthKey,
    "metadata.monthlyPlacedCalls": nextMonthlyCount,
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

function readContactWindowStartHour() {
  return readEnvNumber(["RC_CX_WORKING_START_HOUR", "RC_CX_CONTACT_START_HOUR"], 8);
}

function readContactWindowEndHour() {
  return readEnvNumber(["RC_CX_WORKING_END_HOUR", "RC_CX_CONTACT_END_HOUR"], 17);
}

function addWorkingMinutes(date = new Date(), minutes = 0) {
  let remainingMs = Math.max(Number(minutes) || 0, 0) * 60 * 1000;
  let cursor = new Date(date);
  if (remainingMs <= 0) return cursor;

  const startHour = readContactWindowStartHour();
  const endHour = Math.max(readContactWindowEndHour(), startHour + 1);

  for (let guard = 0; guard < 366 && remainingMs > 0; guard += 1) {
    const parts = getPacificParts(cursor);
    const dayStart = makePacificDate(parts.year, parts.month, parts.day, startHour, 0, 0);
    const dayEnd = makePacificDate(parts.year, parts.month, parts.day, endHour, 0, 0);

    if (cursor.getTime() < dayStart.getTime()) cursor = dayStart;
    if (cursor.getTime() >= dayEnd.getTime()) {
      const nextDayGuess = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1, 12, 0, 0, 0));
      const nextParts = getPacificParts(nextDayGuess);
      cursor = makePacificDate(nextParts.year, nextParts.month, nextParts.day, startHour, 0, 0);
      continue;
    }

    const availableMs = Math.max(dayEnd.getTime() - cursor.getTime(), 0);
    if (remainingMs <= availableMs) return new Date(cursor.getTime() + remainingMs);

    remainingMs -= availableMs;
    const nextDayGuess = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1, 12, 0, 0, 0));
    const nextParts = getPacificParts(nextDayGuess);
    cursor = makePacificDate(nextParts.year, nextParts.month, nextParts.day, startHour, 0, 0);
  }

  return cursor;
}

function getCooldownReleaseAt(item = {}, now = new Date()) {
  const policy = getQueueFamilyPolicy(item.queueFamily || item.metadata?.queueFamily);
  const placedAt = item.lastPlacedAt || item.metadata?.lastQueueAttemptAt || null;
  const base = placedAt ? new Date(placedAt) : new Date(now);
  if (Number.isNaN(base.getTime())) return new Date(now);
  return addWorkingMinutes(base, Math.max(Number(policy.cooldownMinutes) || 0, 0));
}

function resolveQueueDialability(item = {}, now = new Date()) {
  const policy = getQueueFamilyPolicy(item.queueFamily || item.metadata?.queueFamily);
  const dailyCount = getDailyPlacedCalls(item, now);
  const monthKey = getPacificMonthKey(now);
  const itemMonthKey = String(item.monthlyPlacedMonthKey || item.metadata?.monthlyPlacedMonthKey || "").trim();
  const monthlyCount = itemMonthKey === monthKey
    ? Math.max(Number(item.monthlyPlacedCalls ?? item.metadata?.monthlyPlacedCalls ?? 0) || 0, 0)
    : 0;
  const nextByCooldown = getCooldownReleaseAt(item, now);
  if (policy.key === "dead") {
    return {
      ok: false,
      reason: "dead-lead",
      detail: "Lead is outside the active CX dialing window",
      nextEligibleAt: null,
      dailyCount,
      dailyMax: policy.dailyMax,
      monthlyCount,
      monthlyMax: policy.monthlyMax,
      policy,
    };
  }
  if (policy.dailyMax != null && dailyCount >= Number(policy.dailyMax)) {
    return {
      ok: false,
      reason: "daily-cap-reached",
      detail: `${policy.label} daily contact cap reached`,
      nextEligibleAt: getNextPacificDayStart(now),
      dailyCount,
      dailyMax: Number(policy.dailyMax),
      monthlyCount,
      monthlyMax: policy.monthlyMax,
      policy,
    };
  }

  if (policy.monthlyMax != null && monthlyCount >= Number(policy.monthlyMax)) {
    const parts = getPacificParts(now);
    const nextMonth = makePacificDate(parts.year, parts.month + 1, 1, 8, 0, 0);
    return {
      ok: false,
      reason: "monthly-cap-reached",
      detail: `${policy.label} monthly contact cap reached`,
      nextEligibleAt: nextMonth,
      dailyCount,
      dailyMax: policy.dailyMax,
      monthlyCount,
      monthlyMax: Number(policy.monthlyMax),
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
      monthlyCount,
      monthlyMax: policy.monthlyMax,
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
      monthlyCount,
      monthlyMax: policy.monthlyMax,
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
    monthlyCount,
    monthlyMax: policy.monthlyMax,
    policy,
  };
}

function deriveQueueFamilyFromAgeDays(ageDays) {
  const numericAge = Number(ageDays);
  if (!Number.isFinite(numericAge)) return "fresh-day1";
  if (numericAge <= 1) return "fresh-day1";
  if (numericAge <= 14) return "fresh-day2to10";
  if (numericAge <= 29) return "fresh-day16to30";
  if (numericAge <= 120) return "aged";
  return "dead";
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
  normalizeRouteCampaigns,
  normalizeQueueFamily,
  normalizePlacedCallCount,
  resolveAccountQueuePolicy,
  resolveQueueDialability,
  QUEUE_FAMILY_POLICIES,
  QUEUE_TIMEZONE,
};
