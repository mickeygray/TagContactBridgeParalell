"use strict";

const {
  normalizeLeadQueueFamily,
} = require("../../shared-normalizers/src");
const {
  buildCxHourlyAttemptPatch,
  getCxHourlyPacingStatus,
} = require("./cxQueueFairnessService");

const QUEUE_TIMEZONE = "America/Los_Angeles";
const OPERATIONAL_TIMEZONE = "America/Los_Angeles";
const DEFAULT_LEAD_TIMEZONE = "America/Los_Angeles";
const DEFAULT_DIAL_START_HOUR = 8;
const DEFAULT_DIAL_END_HOUR = 20;
const DEFAULT_DIAL_DAILY_MAX = 3;
const DEFAULT_INITIAL_ACTIVE_BUSINESS_DAYS = 5;
const DEFAULT_INITIAL_UNANSWERED_ATTEMPT_MAX = 15;
const DEFAULT_CONTACT_EXTENSION_BUSINESS_DAY = 15;
const DEFAULT_SECOND_HALF_BUSINESS_DAY_MAX = 30;
const DEFAULT_SECOND_HALF_REQUIRED_CONTACTS = 2;
const DEFAULT_ENGAGEMENT_POLICY_EFFECTIVE_AT = "2026-05-28T00:00:00-07:00";
const GRANDFATHER_CONTACT_REQUIRED_BUSINESS_DAY = 10;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const STATE_TIMEZONES = Object.freeze({
  AL: "America/Chicago",
  AK: "America/Anchorage",
  AZ: "America/Phoenix",
  AR: "America/Chicago",
  CA: "America/Los_Angeles",
  CO: "America/Denver",
  CT: "America/New_York",
  DC: "America/New_York",
  DE: "America/New_York",
  FL: "America/New_York",
  GA: "America/New_York",
  HI: "Pacific/Honolulu",
  IA: "America/Chicago",
  ID: "America/Denver",
  IL: "America/Chicago",
  IN: "America/Indiana/Indianapolis",
  KS: "America/Chicago",
  KY: "America/New_York",
  LA: "America/Chicago",
  MA: "America/New_York",
  MD: "America/New_York",
  ME: "America/New_York",
  MI: "America/Detroit",
  MN: "America/Chicago",
  MO: "America/Chicago",
  MS: "America/Chicago",
  MT: "America/Denver",
  NC: "America/New_York",
  ND: "America/Chicago",
  NE: "America/Chicago",
  NH: "America/New_York",
  NJ: "America/New_York",
  NM: "America/Denver",
  NV: "America/Los_Angeles",
  NY: "America/New_York",
  OH: "America/New_York",
  OK: "America/Chicago",
  OR: "America/Los_Angeles",
  PA: "America/New_York",
  RI: "America/New_York",
  SC: "America/New_York",
  SD: "America/Chicago",
  TN: "America/Chicago",
  TX: "America/Chicago",
  UT: "America/Denver",
  VA: "America/New_York",
  VT: "America/New_York",
  WA: "America/Los_Angeles",
  WI: "America/Chicago",
  WV: "America/New_York",
  WY: "America/Denver",
});

const STATE_DIAL_RULES = Object.freeze({
  FL: { endHour: 20, sundayAllowed: false },
  OK: { endHour: 20 },
  WA: { endHour: 20 },
  TX: { startHour: 9, endHour: 21, sundayStartHour: 12 },
  LA: { endHour: 21, sundayAllowed: false, holidayBlackout: true },
  MD: { endHour: 20 },
  MS: { endHour: 20, holidayBlackout: true },
  AL: { endHour: 20, holidayBlackout: true },
  IN: { endHour: 21, sundayAllowed: false },
});

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
    dailyMax: DEFAULT_DIAL_DAILY_MAX,
  },
  "fresh-day2to10": {
    key: "fresh-day2to10",
    label: "3-15",
    claimMinutes: 30,
    cooldownMinutes: 120,
    dailyMax: DEFAULT_DIAL_DAILY_MAX,
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
    monthlyMax: null,
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
  aged: { targetOpen: 0, fillRemainder: false },
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

function readPolicyBoolean(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const raw = String(value || "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
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
    || hasPolicyValue(input.aged?.fillRemainder)
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
  const globalMax = readEnvNumber("RC_CX_DAILY_MAX", null);
  if (globalMax != null) return globalMax;
  const familyOverridesEnabled = readEnvBoolean("RC_CX_ALLOW_FAMILY_DAILY_MAX_OVERRIDES", false);
  if (!familyOverridesEnabled) return fallback;
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
  if (normalized.includes("ld-custom")) {
    if (!normalized.includes("ld-custom-2")) normalized.push("ld-custom-2");
    if (!normalized.includes("ld-custom-3")) normalized.push("ld-custom-3");
  }
  return normalized.length > 0 ? normalized : null;
}

// Route-campaign subscriptions are consumed by workspace refill only.
//
// Plan: read `account.cxQueuePolicy.routeCampaigns` (optional string[],
// e.g. ["ld-custom"] or ["ld-general", "organic"]) and surface it on
// the returned policy object as `routeCampaigns`. Empty / unset = "all"
// (back-compat for every existing agent). The intake path already
// stamps `routeCampaignKey` on every LeadCadence (see ROUTE_CAMPAIGNS
// in inboundIntakeService.js — `ld-custom`, `ld-custom-2`, `ld-custom-3`,
// and `ld-general` are live),
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
      fillRemainder: readPolicyBoolean(
        rawPolicy.aged?.fillRemainder,
        readEnvBoolean(["RC_CX_AGED_FILL_REMAINDER_ENABLED", "RC_CX_RED_FILL_REMAINDER_ENABLED"], false),
      ),
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

function isValidTimeZone(value) {
  const candidate = String(value || "").trim();
  if (!candidate) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function normalizeUsState(value) {
  const raw = String(value || "").trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(raw)) return raw;
  const compact = raw.replace(/[^A-Z]/g, "");
  const names = {
    ALABAMA: "AL",
    ALASKA: "AK",
    ARIZONA: "AZ",
    ARKANSAS: "AR",
    CALIFORNIA: "CA",
    COLORADO: "CO",
    CONNECTICUT: "CT",
    DELAWARE: "DE",
    FLORIDA: "FL",
    GEORGIA: "GA",
    HAWAII: "HI",
    IDAHO: "ID",
    ILLINOIS: "IL",
    INDIANA: "IN",
    IOWA: "IA",
    KANSAS: "KS",
    KENTUCKY: "KY",
    LOUISIANA: "LA",
    MAINE: "ME",
    MARYLAND: "MD",
    MASSACHUSETTS: "MA",
    MICHIGAN: "MI",
    MINNESOTA: "MN",
    MISSISSIPPI: "MS",
    MISSOURI: "MO",
    MONTANA: "MT",
    NEBRASKA: "NE",
    NEVADA: "NV",
    NEWHAMPSHIRE: "NH",
    NEWJERSEY: "NJ",
    NEWMEXICO: "NM",
    NEWYORK: "NY",
    NORTHCAROLINA: "NC",
    NORTHDAKOTA: "ND",
    OHIO: "OH",
    OKLAHOMA: "OK",
    OREGON: "OR",
    PENNSYLVANIA: "PA",
    RHODEISLAND: "RI",
    SOUTHCAROLINA: "SC",
    SOUTHDAKOTA: "SD",
    TENNESSEE: "TN",
    TEXAS: "TX",
    UTAH: "UT",
    VERMONT: "VT",
    VIRGINIA: "VA",
    WASHINGTON: "WA",
    WESTVIRGINIA: "WV",
    WISCONSIN: "WI",
    WYOMING: "WY",
    DISTRICTOFCOLUMBIA: "DC",
  };
  return names[compact] || null;
}

function resolveLeadState(item = {}) {
  const metadata = item.metadata && typeof item.metadata === "object" ? item.metadata : {};
  const payload = item.payloadSnapshot && typeof item.payloadSnapshot === "object" ? item.payloadSnapshot : {};
  const attribution = item.attributionContext && typeof item.attributionContext === "object" ? item.attributionContext : {};
  return normalizeUsState(
    metadata.leadState ||
      metadata.contactState ||
      metadata.state ||
      payload.state ||
      attribution.state ||
      item.leadState ||
      item.contactState,
  );
}

function resolveLeadTimeZone(item = {}) {
  const metadata = item.metadata && typeof item.metadata === "object" ? item.metadata : {};
  const payload = item.payloadSnapshot && typeof item.payloadSnapshot === "object" ? item.payloadSnapshot : {};
  const explicit =
    metadata.leadTimeZone ||
    metadata.leadTimezone ||
    metadata.timeZone ||
    metadata.timezone ||
    payload.timeZone ||
    payload.timezone ||
    item.leadTimeZone ||
    item.timeZone ||
    item.timezone;
  if (isValidTimeZone(explicit)) return String(explicit).trim();
  return STATE_TIMEZONES[resolveLeadState(item)] || DEFAULT_LEAD_TIMEZONE;
}

function getZonedParts(date = new Date(), timeZone = DEFAULT_LEAD_TIMEZONE) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(date));
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const hour = Number(lookup.hour);
  return {
    year: Number(lookup.year),
    month: Number(lookup.month),
    day: Number(lookup.day),
    weekday: weekdayMap[lookup.weekday] ?? -1,
    hour: hour === 24 ? 0 : hour,
    minute: Number(lookup.minute),
    second: Number(lookup.second),
  };
}

function getZonedOffsetMs(date = new Date(), timeZone = DEFAULT_LEAD_TIMEZONE) {
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

function makeZonedDate(year, month, day, hour = 0, minute = 0, second = 0, timeZone = DEFAULT_LEAD_TIMEZONE) {
  let utcMs = Date.UTC(year, month - 1, day, hour, minute, second, 0);
  for (let index = 0; index < 3; index += 1) {
    utcMs = Date.UTC(year, month - 1, day, hour, minute, second, 0)
      - getZonedOffsetMs(new Date(utcMs), timeZone);
  }
  return new Date(utcMs);
}

function formatDateKeyInZone(date = new Date(), timeZone = DEFAULT_LEAD_TIMEZONE) {
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date(date));
}

function readOperationalStartHour() {
  return readEnvNumber("RC_CX_OPERATIONAL_START_HOUR", 7);
}

function readOperationalEndHour() {
  return readEnvNumber("RC_CX_OPERATIONAL_END_HOUR", 17);
}

function nextWindowStart(date, timeZone, startHour) {
  const parts = getZonedParts(date, timeZone);
  return makeZonedDate(parts.year, parts.month, parts.day + 1, startHour, 0, 0, timeZone);
}

function evaluateDailyWindow(date, {
  timeZone,
  startHour,
  endHour,
  activeWeekdays = [1, 2, 3, 4, 5],
} = {}) {
  const target = new Date(date);
  const parts = getZonedParts(target, timeZone);
  const allowedWeekday = activeWeekdays.includes(parts.weekday);
  if (!allowedWeekday) {
    let cursor = target;
    for (let guard = 0; guard < 10; guard += 1) {
      const cursorParts = getZonedParts(cursor, timeZone);
      const next = makeZonedDate(cursorParts.year, cursorParts.month, cursorParts.day + 1, startHour, 0, 0, timeZone);
      const nextParts = getZonedParts(next, timeZone);
      if (activeWeekdays.includes(nextParts.weekday)) {
        return { allowed: false, reason: "off-weekday", nextAllowedAt: next };
      }
      cursor = next;
    }
  }
  if (parts.hour < startHour) {
    return {
      allowed: false,
      reason: "before-window",
      nextAllowedAt: makeZonedDate(parts.year, parts.month, parts.day, startHour, 0, 0, timeZone),
    };
  }
  if (parts.hour >= endHour) {
    return {
      allowed: false,
      reason: "after-window",
      nextAllowedAt: nextWindowStart(target, timeZone, startHour),
    };
  }
  return { allowed: true, reason: null, nextAllowedAt: target };
}

function resolveLeadDialRules(state, parts = null) {
  const base = {
    startHour: DEFAULT_DIAL_START_HOUR,
    endHour: DEFAULT_DIAL_END_HOUR,
    activeWeekdays: [1, 2, 3, 4, 5],
  };
  const overlay = STATE_DIAL_RULES[state] || {};
  const weekday = parts?.weekday;
  const isSunday = weekday === 0;
  const activeWeekdays = overlay.sundayAllowed === false
    ? [1, 2, 3, 4, 5, 6]
    : base.activeWeekdays;
  return {
    ...base,
    ...overlay,
    activeWeekdays,
    startHour: isSunday && overlay.sundayStartHour ? overlay.sundayStartHour : (overlay.startHour || base.startHour),
    endHour: overlay.endHour || base.endHour,
  };
}

function resolveQueueDialTimeWindow(item = {}, now = new Date()) {
  const state = resolveLeadState(item);
  const timeZone = resolveLeadTimeZone(item);
  let cursor = new Date(now);

  for (let guard = 0; guard < 20; guard += 1) {
    const operational = evaluateDailyWindow(cursor, {
      timeZone: OPERATIONAL_TIMEZONE,
      startHour: readOperationalStartHour(),
      endHour: Math.max(readOperationalEndHour(), readOperationalStartHour() + 1),
      activeWeekdays: [1, 2, 3, 4, 5],
    });
    const leadParts = getZonedParts(cursor, timeZone);
    const leadRules = resolveLeadDialRules(state, leadParts);
    const lead = evaluateDailyWindow(cursor, {
      timeZone,
      startHour: leadRules.startHour,
      endHour: leadRules.endHour,
      activeWeekdays: leadRules.activeWeekdays,
    });
    if (operational.allowed && lead.allowed) {
      const target = new Date(now);
      const allowedNow = cursor.getTime() <= target.getTime() + 1000;
      return {
        allowed: allowedNow,
        reason: allowedNow ? null : (cursor.policyReason || "future-window"),
        nextAllowedAt: cursor,
        state,
        timeZone,
        localDateKey: formatDateKeyInZone(cursor, timeZone),
        operationalTimeZone: OPERATIONAL_TIMEZONE,
        policy: {
          operationalStartHour: readOperationalStartHour(),
          operationalEndHour: readOperationalEndHour(),
          leadStartHour: leadRules.startHour,
          leadEndHour: leadRules.endHour,
          leadActiveWeekdays: leadRules.activeWeekdays,
        },
      };
    }
    const nextAllowedAt = maxDate(operational.nextAllowedAt, lead.nextAllowedAt) || cursor;
    cursor = new Date(nextAllowedAt.getTime() + 1000);
    if (!operational.allowed) {
      cursor.policyReason = operational.reason;
    } else if (!lead.allowed) {
      cursor.policyReason = lead.reason;
    }
  }

  return {
    allowed: false,
    reason: "queue-window-unresolved",
    nextAllowedAt: cursor,
    state,
    timeZone,
    localDateKey: formatDateKeyInZone(cursor, timeZone),
    operationalTimeZone: OPERATIONAL_TIMEZONE,
    policy: {},
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
  return getWeekdayOrdinalFromParts(parts);
}

function getUtcDayOfWeek(serialDay) {
  return new Date(serialDay * MS_PER_DAY).getUTCDay();
}

function normalizeWeekendSerialDay(serialDay) {
  let cursor = serialDay;
  for (let guard = 0; guard < 3; guard += 1) {
    const day = getUtcDayOfWeek(cursor);
    if (day === 6) {
      cursor -= 1;
      continue;
    }
    if (day === 0) {
      cursor -= 2;
      continue;
    }
    return cursor;
  }
  return cursor;
}

function getWeekdayOrdinalFromParts(parts = {}) {
  const rawSerial = Math.floor(Date.UTC(parts.year, parts.month - 1, parts.day) / MS_PER_DAY);
  const serial = normalizeWeekendSerialDay(rawSerial);
  const fullWeeks = Math.floor(serial / 7);
  let weekdays = fullWeeks * 5;
  const remainder = ((serial % 7) + 7) % 7;
  for (let i = 0; i < remainder; i += 1) {
    const day = (4 + i) % 7; // 1970-01-01 was a Thursday.
    if (day !== 0 && day !== 6) weekdays += 1;
  }
  return weekdays;
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
  const totalMax = readEnvNumber(
    [
      "RC_CX_GREEN_TOTAL_MAX_CALLS",
      "RC_CX_FRESH_TOTAL_MAX_CALLS",
    ],
    8,
  );
  // deriveQueueFamilyFromLeadTouchState receives the number of calls
  // already placed. A ceiling of 7 lets the eighth green call go out,
  // then promotes the lead to blue for the next attempt.
  return Math.max(totalMax - 1, 0);
}

function getInitialActiveBusinessDays() {
  return readEnvNumber("RC_CX_INITIAL_ACTIVE_BUSINESS_DAYS", DEFAULT_INITIAL_ACTIVE_BUSINESS_DAYS);
}

function getInitialUnansweredAttemptMax() {
  return readEnvNumber(
    ["RC_CX_INITIAL_UNANSWERED_MAX", "RC_CX_INITIAL_ATTEMPT_MAX", "RC_CX_LIFETIME_ATTEMPT_MAX"],
    DEFAULT_INITIAL_UNANSWERED_ATTEMPT_MAX,
  );
}

function getContactExtensionBusinessDay() {
  return readEnvNumber("RC_CX_CONTACT_EXTENSION_BUSINESS_DAY", DEFAULT_CONTACT_EXTENSION_BUSINESS_DAY);
}

function getSecondHalfBusinessDayMax() {
  return readEnvNumber("RC_CX_SECOND_HALF_BUSINESS_DAY_MAX", DEFAULT_SECOND_HALF_BUSINESS_DAY_MAX);
}

function getSecondHalfRequiredContacts() {
  return readEnvNumber("RC_CX_SECOND_HALF_REQUIRED_CONTACTS", DEFAULT_SECOND_HALF_REQUIRED_CONTACTS);
}

function getEngagementPolicyEffectiveAt() {
  const raw = String(process.env.RC_CX_ENGAGEMENT_POLICY_EFFECTIVE_AT || DEFAULT_ENGAGEMENT_POLICY_EFFECTIVE_AT).trim();
  const date = raw ? new Date(raw) : null;
  return date && !Number.isNaN(date.getTime()) ? date : new Date(DEFAULT_ENGAGEMENT_POLICY_EFFECTIVE_AT);
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

  const freshWindowDays = Math.max(getTouchAgeFreshWindowDays(), 0);
  if (businessAge <= freshWindowDays) {
    return "fresh-day1";
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

function getQueueDailyDateKey(item = {}, asOf = new Date()) {
  return formatDateKeyInZone(asOf, resolveLeadTimeZone(item));
}

function getNextQueueDialDayStart(item = {}, asOf = new Date()) {
  const timeZone = resolveLeadTimeZone(item);
  const state = resolveLeadState(item);
  const parts = getZonedParts(asOf, timeZone);
  const nextNoon = makeZonedDate(parts.year, parts.month, parts.day + 1, 12, 0, 0, timeZone);
  const nextParts = getZonedParts(nextNoon, timeZone);
  const rules = resolveLeadDialRules(state, nextParts);
  const nextLocalStart = makeZonedDate(
    nextParts.year,
    nextParts.month,
    nextParts.day,
    rules.startHour,
    0,
    0,
    timeZone,
  );
  return resolveQueueDialTimeWindow(item, nextLocalStart).nextAllowedAt || nextLocalStart;
}

function pickQueueLeadCreatedAt(item = {}) {
  return (
    item.metadata?.leadCreatedAt ||
    item.payloadSnapshot?.createdAt ||
    item.leadCreatedAt ||
    item.createdAt ||
    null
  );
}

function isGrandfatheredEngagementPolicyLead(item = {}) {
  const createdAt = pickQueueLeadCreatedAt(item);
  if (!createdAt) return false;
  const created = new Date(createdAt);
  const effectiveAt = getEngagementPolicyEffectiveAt();
  if (Number.isNaN(created.getTime()) || Number.isNaN(effectiveAt.getTime())) return false;
  return created.getTime() < effectiveAt.getTime();
}

function getQueueLeadBusinessAge(item = {}, asOf = new Date()) {
  const createdAt = pickQueueLeadCreatedAt(item);
  if (!createdAt) return null;
  const age = getPacificBusinessDayAge(
    createdAt,
    asOf,
    item.rolloverHour,
    item.graceEndHour,
    item.rolloverMinute,
  );
  return Number.isFinite(age) ? age : null;
}

function getQueueUnansweredAttempts(item = {}) {
  return Math.max(Number(
    item.unansweredCalls
      ?? item.metadata?.unansweredCalls
      ?? item.metadata?.noAnswerCalls
      ?? item.metadata?.didNotAnswerCalls
      ?? item.metadata?.cxNoAnswerCalls
      ?? 0,
  ) || 0, 0);
}

function getQueueAnsweredContacts(item = {}) {
  return Math.max(Number(
    item.answeredContacts
      ?? item.metadata?.answeredContacts
      ?? item.metadata?.cxAnsweredContacts
      ?? item.metadata?.answeredCalls
      ?? item.metadata?.contactCount
      ?? 0,
  ) || 0, 0);
}

function getQueueBusinessAgeStart(item = {}, targetAge = 0, asOf = new Date()) {
  const createdAt = pickQueueLeadCreatedAt(item);
  if (!createdAt) return null;
  let cursor = new Date(createdAt);
  const now = new Date(asOf);
  if (Number.isNaN(cursor.getTime()) || Number.isNaN(now.getTime())) return null;
  if (cursor.getTime() > now.getTime()) cursor = now;
  for (let guard = 0; guard < 90; guard += 1) {
    const age = getQueueLeadBusinessAge(item, cursor);
    if (Number.isFinite(age) && age >= targetAge) {
      return resolveQueueDialTimeWindow(item, getPacificBusinessDayStart(cursor)).nextAllowedAt;
    }
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
  }
  return null;
}

function resolveQueueLifecycleHold(item = {}, now = new Date()) {
  const businessAge = getQueueLeadBusinessAge(item, now);
  const queueFamily = normalizeQueueFamily(item.queueFamily || item.metadata?.queueFamily);
  if (!Number.isFinite(businessAge)) {
    return {
      held: false,
      businessAge: null,
      unansweredAttempts: getQueueUnansweredAttempts(item),
      answeredContacts: getQueueAnsweredContacts(item),
    };
  }
  const initialActiveDays = Math.max(getInitialActiveBusinessDays(), 0);
  const unansweredMax = Math.max(getInitialUnansweredAttemptMax(), 0);
  const contactExtensionDay = Math.max(getContactExtensionBusinessDay(), initialActiveDays + 1);
  const secondHalfDayMax = Math.max(getSecondHalfBusinessDayMax(), contactExtensionDay + 1);
  const secondHalfRequiredContacts = Math.max(getSecondHalfRequiredContacts(), 0);
  const unansweredAttempts = getQueueUnansweredAttempts(item);
  const answeredContacts = getQueueAnsweredContacts(item);
  const hasFirstContact = answeredContacts >= 1;
  const hasSecondHalfContactUnlock = answeredContacts >= secondHalfRequiredContacts;
  const grandfathered = isGrandfatheredEngagementPolicyLead(item);

  if (queueFamily === "aged") {
    return {
      held: false,
      businessAge,
      unansweredAttempts,
      answeredContacts,
      unansweredMax,
      initialActiveDays,
      contactExtensionDay,
      secondHalfDayMax,
      secondHalfRequiredContacts,
      grandfathered,
    };
  }

  if (grandfathered) {
    if (
      businessAge >= GRANDFATHER_CONTACT_REQUIRED_BUSINESS_DAY &&
      businessAge < contactExtensionDay &&
      !hasFirstContact
    ) {
      return {
        held: true,
        reason: "grandfather-contact-required",
        detail: `Grandfathered ${GRANDFATHER_CONTACT_REQUIRED_BUSINESS_DAY}-${contactExtensionDay} day lead needs at least one contact`,
        nextEligibleAt: null,
        businessAge,
        unansweredAttempts,
        answeredContacts,
        unansweredMax,
        initialActiveDays,
        contactExtensionDay,
        secondHalfDayMax,
        secondHalfRequiredContacts,
        grandfathered,
        terminal: true,
      };
    }
    if (businessAge >= contactExtensionDay) {
      return {
        held: false,
        businessAge,
        unansweredAttempts,
        answeredContacts,
        unansweredMax,
        initialActiveDays,
        contactExtensionDay,
        secondHalfDayMax,
        secondHalfRequiredContacts,
        grandfathered,
      };
    }
    return {
      held: false,
      businessAge,
      unansweredAttempts,
      answeredContacts,
      unansweredMax,
      initialActiveDays,
      contactExtensionDay,
      secondHalfDayMax,
      secondHalfRequiredContacts,
      grandfathered,
    };
  }

  if (!hasFirstContact && unansweredMax > 0 && unansweredAttempts >= unansweredMax) {
    return {
      held: true,
      reason: "no-answer-budget-exhausted",
      detail: `No-answer attempt budget reached (${unansweredAttempts}/${unansweredMax})`,
      nextEligibleAt: null,
      businessAge,
      unansweredAttempts,
      answeredContacts,
      unansweredMax,
      initialActiveDays,
      contactExtensionDay,
      secondHalfDayMax,
      secondHalfRequiredContacts,
      grandfathered,
      terminal: true,
    };
  }

  if (!hasFirstContact && businessAge >= initialActiveDays) {
    return {
      held: true,
      reason: "initial-window-complete",
      detail: `Initial ${initialActiveDays}-business-day no-answer dial window is complete`,
      nextEligibleAt: null,
      businessAge,
      unansweredAttempts,
      answeredContacts,
      unansweredMax,
      initialActiveDays,
      contactExtensionDay,
      secondHalfDayMax,
      secondHalfRequiredContacts,
      grandfathered,
      terminal: true,
    };
  }

  if (hasFirstContact && !hasSecondHalfContactUnlock && businessAge >= contactExtensionDay) {
    return {
      held: true,
      reason: "single-contact-window-complete",
      detail: `Lead had one contact but did not reach ${secondHalfRequiredContacts} contacts before day ${contactExtensionDay}`,
      nextEligibleAt: null,
      businessAge,
      unansweredAttempts,
      answeredContacts,
      unansweredMax,
      initialActiveDays,
      contactExtensionDay,
      secondHalfDayMax,
      secondHalfRequiredContacts,
      grandfathered,
      terminal: true,
    };
  }

  if (hasSecondHalfContactUnlock && businessAge >= secondHalfDayMax) {
    return {
      held: true,
      reason: "second-half-window-complete",
      detail: `Second-half contact window is complete at day ${secondHalfDayMax}`,
      nextEligibleAt: null,
      businessAge,
      unansweredAttempts,
      answeredContacts,
      unansweredMax,
      initialActiveDays,
      contactExtensionDay,
      secondHalfDayMax,
      secondHalfRequiredContacts,
      grandfathered,
      terminal: true,
    };
  }

  return {
    held: false,
    businessAge,
    unansweredAttempts,
    answeredContacts,
    unansweredMax,
    initialActiveDays,
    contactExtensionDay,
    secondHalfDayMax,
    secondHalfRequiredContacts,
    grandfathered,
  };
}

function getDailyPlacedCalls(item = {}, asOf = new Date()) {
  const dateKey = getQueueDailyDateKey(item, asOf);
  const pacificDateKey = getPacificDateKey(asOf);
  const itemDateKey = String(item.dailyPlacedDateKey || item.metadata?.dailyPlacedDateKey || "").trim();
  if (itemDateKey !== dateKey && itemDateKey !== pacificDateKey) return 0;
  return Math.max(Number(item.dailyPlacedCalls ?? item.metadata?.dailyPlacedCalls ?? 0) || 0, 0);
}

function buildCallAttemptPatch(item = {}, placedAt = new Date()) {
  const leadTimeZone = resolveLeadTimeZone(item);
  const dateKey = formatDateKeyInZone(placedAt, leadTimeZone);
  const monthKey = getPacificMonthKey(placedAt);
  const priorDateKey = String(item.dailyPlacedDateKey || item.metadata?.dailyPlacedDateKey || "").trim();
  const priorMonthKey = String(item.monthlyPlacedMonthKey || item.metadata?.monthlyPlacedMonthKey || "").trim();
  const priorDailyCount = (priorDateKey === dateKey || priorDateKey === getPacificDateKey(placedAt))
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
    "metadata.dailyPlacedTimezone": leadTimeZone,
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
  const cooldownMinutes = Math.max(Number(policy.cooldownMinutes) || 0, 0);
  if (cooldownMinutes <= 0) return base;
  if (policy.key === "fresh-day1" || policy.key === "fresh-day2to10") {
    return addWorkingMinutes(base, cooldownMinutes);
  }
  return new Date(base.getTime() + cooldownMinutes * 60 * 1000);
}

function resolveQueueDialability(item = {}, now = new Date()) {
  const policy = getQueueFamilyPolicy(item.queueFamily || item.metadata?.queueFamily);
  const dailyCount = getDailyPlacedCalls(item, now);
  const timeWindow = resolveQueueDialTimeWindow(item, now);
  const lifecycleHold = resolveQueueLifecycleHold(item, now);
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

  if (lifecycleHold.held) {
    return {
      ok: false,
      reason: lifecycleHold.reason,
      detail: lifecycleHold.detail,
      nextEligibleAt: lifecycleHold.nextEligibleAt,
      dailyCount,
      dailyMax: policy.dailyMax,
      monthlyCount,
      monthlyMax: policy.monthlyMax,
      lifecycleHold,
      policy,
    };
  }

  if (policy.dailyMax != null && dailyCount >= Number(policy.dailyMax)) {
    return {
      ok: false,
      reason: "daily-cap-reached",
      detail: `${policy.label} daily contact cap reached`,
      nextEligibleAt: getNextQueueDialDayStart(item, now),
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

  const lastPlacedAt = item.lastPlacedAt || item.metadata?.lastQueueAttemptAt || null;
  if (lastPlacedAt && nextByCooldown.getTime() > new Date(now).getTime()) {
    return {
      ok: false,
      reason: "cooldown-active",
      detail: `${policy.label} cooldown is still active`,
      nextEligibleAt: maxDate(nextByCooldown, timeWindow.nextAllowedAt),
      dailyCount,
      dailyMax: policy.dailyMax,
      monthlyCount,
      monthlyMax: policy.monthlyMax,
      policy,
    };
  }

  if (!timeWindow.allowed) {
    return {
      ok: false,
      reason: "queue-contact-window",
      detail: `Lead-local or operational contact window is closed (${timeWindow.timeZone})`,
      nextEligibleAt: timeWindow.nextAllowedAt,
      dailyCount,
      dailyMax: policy.dailyMax,
      hourlyCount: hourlyPacing.count,
      hourlyMax: hourlyPacing.cap,
      monthlyCount,
      monthlyMax: policy.monthlyMax,
      leadState: timeWindow.state,
      leadTimeZone: timeWindow.timeZone,
      timeWindow,
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
  getNextQueueDialDayStart,
  getPacificMonthKey,
  getPacificBusinessDayAge,
  getPacificBusinessDayStart,
  getPacificDateKey,
  getPacificFreshExpiry,
  getQueueFamilyPolicy,
  getQueueFamilySortRank,
  getQueueFamilyTargetOpen,
  getQueueDailyDateKey,
  hasManualQueuePolicy,
  getTouchAgeFreshMaxCalls,
  getTouchAgeFreshWindowDays,
  getInitialActiveBusinessDays,
  getInitialUnansweredAttemptMax,
  getQueueAnsweredContacts,
  getQueueLeadBusinessAge,
  getQueueUnansweredAttempts,
  getContactExtensionBusinessDay,
  getEngagementPolicyEffectiveAt,
  getSecondHalfBusinessDayMax,
  getSecondHalfRequiredContacts,
  isQueueFamilyAllowedForAccountPolicy,
  isTouchAgeBucketingEnabled,
  normalizeRouteCampaigns,
  normalizeQueueFamily,
  normalizePlacedCallCount,
  resolveAccountQueuePolicy,
  resolveQueueDialability,
  resolveQueueDialTimeWindow,
  resolveQueueLifecycleHold,
  resolveLeadState,
  resolveLeadTimeZone,
  QUEUE_FAMILY_POLICIES,
  QUEUE_TIMEZONE,
};
