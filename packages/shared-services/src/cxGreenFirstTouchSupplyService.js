"use strict";

const DEFAULT_CUTOFF_HOUR = 7;
const DEFAULT_CUTOFF_MINUTE = 45;
const DEFAULT_TIMEZONE = "UTC";
const DOMAIN_TIMEZONES = Object.freeze({
  TAG: "America/New_York",
  WYNN: "America/Los_Angeles",
});

function str(value) {
  return String(value == null ? "" : value).trim();
}

function toDate(value, fallback = new Date()) {
  const date = value instanceof Date ? value : new Date(value || fallback);
  return Number.isNaN(date.getTime()) ? new Date(fallback) : date;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function dateKey(date) {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

function localDateKey(parts) {
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

function normalizeTimezone(value, domain = null) {
  const explicit = str(value);
  const candidate = explicit || DOMAIN_TIMEZONES[str(domain).toUpperCase()] || DEFAULT_TIMEZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(new Date());
    return candidate;
  } catch (_) {
    return DEFAULT_TIMEZONE;
  }
}

function getZonedParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const out = {};
  for (const part of parts) {
    if (part.type !== "literal") out[part.type] = Number(part.value);
  }
  return {
    year: out.year,
    month: out.month,
    day: out.day,
    hour: out.hour,
    minute: out.minute,
    second: out.second,
  };
}

function getTimeZoneOffsetMs(date, timeZone) {
  const parts = getZonedParts(date, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    date.getUTCMilliseconds(),
  );
  return asUtc - date.getTime();
}

function zonedWallTimeToUtc(parts, timeZone) {
  const wallUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour || 0, parts.minute || 0, 0, 0);
  let instant = wallUtc - getTimeZoneOffsetMs(new Date(wallUtc), timeZone);
  // One refinement handles DST boundaries where the first offset guess crosses a wall-clock edge.
  instant = wallUtc - getTimeZoneOffsetMs(new Date(instant), timeZone);
  return new Date(instant);
}

function shiftLocalDateParts(parts, days) {
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + Number(days || 0), 12, 0, 0, 0));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function subtractUtcDays(date, days) {
  return new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate() - Math.max(Number(days) || 0, 0),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
    date.getUTCMilliseconds(),
  ));
}

function resolveMorningCoverageBatchWindow(input = {}) {
  const asOf = toDate(input.asOf);
  const domain = str(input.domain).toUpperCase() || "GLOBAL";
  const timezone = normalizeTimezone(input.timezone || input.timeZone, domain);
  const cutoffHour = Number.isFinite(Number(input.cutoffHour))
    ? Number(input.cutoffHour)
    : DEFAULT_CUTOFF_HOUR;
  const cutoffMinute = Number.isFinite(Number(input.cutoffMinute))
    ? Number(input.cutoffMinute)
    : DEFAULT_CUTOFF_MINUTE;
  const asOfLocal = getZonedParts(asOf, timezone);
  const todayLocal = { year: asOfLocal.year, month: asOfLocal.month, day: asOfLocal.day };
  const cutoffAt = zonedWallTimeToUtc({ ...todayLocal, hour: cutoffHour, minute: cutoffMinute }, timezone);
  const effectiveLocalDate = asOf < cutoffAt ? shiftLocalDateParts(todayLocal, -1) : todayLocal;
  const effectiveCutoff = zonedWallTimeToUtc({
    ...effectiveLocalDate,
    hour: cutoffHour,
    minute: cutoffMinute,
  }, timezone);
  const day = new Date(Date.UTC(
    effectiveLocalDate.year,
    effectiveLocalDate.month - 1,
    effectiveLocalDate.day,
  )).getUTCDay();
  const lookbackDays = day === 1 ? 3 : 1;
  const windowStartLocalDate = shiftLocalDateParts(effectiveLocalDate, -lookbackDays);
  const windowStartAt = zonedWallTimeToUtc({
    ...windowStartLocalDate,
    hour: cutoffHour,
    minute: cutoffMinute,
  }, timezone);
  return {
    batchId: `green-coverage-${localDateKey(effectiveLocalDate)}-${domain}`,
    cutoffAt: effectiveCutoff,
    windowStartAt,
    lookbackDays,
    timezone,
    reason: day === 1 ? "weekend-and-overnight-coverage" : "overnight-coverage",
  };
}

function normalizeCount(value) {
  return Math.max(Number(value) || 0, 0);
}

function buildNormalSupplyPlan({
  batchId = null,
  normalFamilyTargets = {},
  reason = "morning-coverage-complete",
  counts = {},
} = {}) {
  return {
    lane: "normal",
    batchId: str(batchId) || null,
    coverageOpen: false,
    firstTouchOnly: false,
    normalQueueCanBuildBehindBatch: true,
    familyTargets: { ...(normalFamilyTargets || {}) },
    claimFilter: { firstTouchOnly: false },
    counts: { ...(counts || {}), remaining: normalizeCount(counts?.remaining) },
    reason,
  };
}

function buildMorningCoverageSupplyPlan(input = {}) {
  const normalFamilyTargets = input.normalFamilyTargets && typeof input.normalFamilyTargets === "object"
    ? input.normalFamilyTargets
    : {};
  const debt = input.debt && typeof input.debt === "object" ? input.debt : {};
  const batchId = str(input.batchId || debt.batchId);
  const remaining = normalizeCount(
    debt.remaining ??
      debt.unresolved ??
      debt.debt ??
      (normalizeCount(debt.queued) + normalizeCount(debt.missingQueueRows)),
  );
  const target = normalizeCount(input.target || input.deficit || remaining);
  const firstTouchMaxAttempts = Math.max(Number(input.firstTouchMaxAttempts) || 1, 1);
  if (remaining <= 0 || target <= 0) {
    return buildNormalSupplyPlan({
      batchId,
      normalFamilyTargets,
      counts: { ...debt, remaining },
    });
  }
  const take = Math.min(target, remaining);
  return {
    lane: "morningCoverage",
    batchId,
    coverageOpen: true,
    firstTouchOnly: true,
    normalQueueCanBuildBehindBatch: true,
    familyTargets: { "fresh-day1": take },
    claimFilter: {
      firstTouchOnly: true,
      greenCoverageBatchId: batchId || null,
      firstTouchMaxAttempts,
    },
    counts: { ...debt, remaining },
    reason: "morning-coverage-open",
  };
}

function summarizeMorningCoverageDebt(input = {}) {
  const eligible = normalizeCount(input.eligible);
  const touched = normalizeCount(input.touched);
  const blocked = normalizeCount(input.blocked);
  const queued = normalizeCount(input.queued);
  const missingQueueRows = normalizeCount(input.missingQueueRows);
  const remaining = Math.max(eligible - touched - blocked, 0);
  return {
    batchId: str(input.batchId) || null,
    eligible,
    touched,
    blocked,
    queued,
    missingQueueRows,
    remaining,
    coverageOpen: remaining > 0,
  };
}

function createCxGreenFirstTouchSupplyPlanner({
  enabled = false,
  queueRepository = null,
  cutoffHour = DEFAULT_CUTOFF_HOUR,
  cutoffMinute = DEFAULT_CUTOFF_MINUTE,
  firstTouchMaxAttempts = 1,
  now = () => new Date(),
  logger = console,
} = {}) {
  async function resolvePlan(input = {}) {
    const normalFamilyTargets = input.normalFamilyTargets && typeof input.normalFamilyTargets === "object"
      ? input.normalFamilyTargets
      : {};
    const asOf = toDate(input.asOf || now());
    const window = resolveMorningCoverageBatchWindow({
      domain: input.domain,
      asOf,
      timezone: input.timezone || input.timeZone,
      cutoffHour,
      cutoffMinute,
    });
    if (!enabled) {
      return buildNormalSupplyPlan({
        batchId: window.batchId,
        normalFamilyTargets,
        reason: "green-first-touch-disabled",
      });
    }
    if (!queueRepository || typeof queueRepository.countReadyFirstTouchRows !== "function") {
      return buildNormalSupplyPlan({
        batchId: window.batchId,
        normalFamilyTargets,
        reason: "green-first-touch-count-unavailable",
      });
    }
    const ringcx = input.ringcx && typeof input.ringcx === "object" ? input.ringcx : {};
    try {
      const readyFirstTouchRows = await queueRepository.countReadyFirstTouchRows({
        domain: input.domain,
        greenCoverageBatchId: window.batchId,
        rcxAccountId: ringcx.accountId || input.rcxAccountId || null,
        rcxCampaignId: ringcx.campaignId || input.rcxCampaignId || null,
        rcxDialGroupId: ringcx.dialGroupId || input.rcxDialGroupId || null,
        firstTouchMaxAttempts,
        now: asOf,
      });
      const debt = summarizeMorningCoverageDebt({
        batchId: window.batchId,
        eligible: readyFirstTouchRows,
        queued: readyFirstTouchRows,
        missingQueueRows: 0,
        touched: 0,
        blocked: 0,
      });
      return {
        ...buildMorningCoverageSupplyPlan({
          batchId: window.batchId,
          debt,
          deficit: input.deficit,
          normalFamilyTargets,
          firstTouchMaxAttempts,
        }),
        cutoffAt: window.cutoffAt,
        windowStartAt: window.windowStartAt,
        windowReason: window.reason,
        timezone: window.timezone,
      };
    } catch (error) {
      logger.warn?.("cxGreenFirstTouchSupplyPlanner failed", {
        domain: str(input.domain) || null,
        batchId: window.batchId,
        error: error && error.message ? error.message : String(error),
      });
      return buildNormalSupplyPlan({
        batchId: window.batchId,
        normalFamilyTargets,
        reason: "green-first-touch-count-failed",
      });
    }
  }

  return { resolvePlan };
}

module.exports = {
  buildMorningCoverageSupplyPlan,
  buildNormalSupplyPlan,
  createCxGreenFirstTouchSupplyPlanner,
  resolveMorningCoverageBatchWindow,
  summarizeMorningCoverageDebt,
  _test: {
    dateKey,
    getZonedParts,
    normalizeTimezone,
    subtractUtcDays,
    zonedWallTimeToUtc,
  },
};
