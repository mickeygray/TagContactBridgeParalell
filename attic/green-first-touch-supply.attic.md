# ATTIC — Green First-Touch Supply (bulk morning-coverage batches)

Retired by: WO-1 (2026-07-02) — bulk supply stays on the reserved family mix; the
first-touch morning-coverage batch feature was structurally inert (its materializer — the only
writer of the rows the planner counts — had zero callers, so the feature could not function
even flag-on) and `CX_GREEN_FIRST_TOUCH_BULK_ENABLED` was set in no environment, live box
verified 2026-07-01.

Applied to: reserving a finite 7:45 batch of zero-dial green (fresh day-1) leads ahead of the
normal family mix until touched/released — planner (`resolvePlan`), queue-row materializer,
repo claim filter (`applyFirstTouchClaimFilter` / `countReadyFirstTouchRows` /
`firstTouchOnly` / `firstTouchMaxAttempts` claim options), reservation release accounting
(`firstTouchReleasePatch` / `firstTouchAttempts` stamps), and the runtime-service plan
normalization (`normalizeFirstTouchSupplyPlan`).

Lived at (at move time): `packages/shared-services/src/cxGreenFirstTouchSupplyService.js`
(whole file), `packages/shared-services/src/cxGreenFirstTouchQueueMaterializerService.js`
(whole file), `packages/shared-repositories/src/cxDialQueueRepository.js` (five WO-1 blocks),
`packages/shared-services/src/cxQueueReservationService.js` (four WO-1 blocks),
`packages/shared-services/src/cxBulkLoadRuntimeService.js` + `cxBulkLoadRuntime.js` (plan
normalization + planner injection), `packages/shared-services/src/index.js` (barrel exports),
and the three dedicated test files
(`tests/cx-bulk-load/cxGreenFirstTouchSupplyService.test.js`,
`cxGreenFirstTouchQueueMaterializerService.test.js`, `cxDialQueueRepositoryFirstTouch.test.js`).

Replaced by: nothing — plain `reserveReadyRows` over the family mix is the whole supply path.
NOTE: the LIVE per-account policy concept `firstTouchEligible` (queue policy, load balancer,
user admin) is UNRELATED to this feature and was untouched; the per-agent First Touch
interrupt campaigns (2827–2831) are a separate live lane and also untouched.

Revive: restore the two service files and the repo/reservation/runtime blocks below; rewire
the barrel exports; re-enable via `CX_GREEN_FIRST_TOUCH_BULK_ENABLED`. Then consciously flip
back the WO-1 inverted negative pins (they now assert the feature is IGNORED):
"WO-1 legacy green first-touch planner is ignored by bulk reservation",
"WO-1 unscoped legacy first-touch planner injection is ignored" (cxBulkLoadRuntimeService.test.js),
"WO-1 reserveFromFamilyOrder ignores legacy first-touch claim options",
"WO-1 releaseReserved no longer stamps first-touch attempts",
"WO-1 releaseReserved ignores existing first-touch attempt snapshots"
(cxQueueReservationService.test.js). Also fix the known defect recorded in memory before
relying on it: the bulk rail never increments `placedCalls`/`dailyPlacedCalls`, so first-touch
debt never cleared on non-connects.

## packages/shared-services/src/cxGreenFirstTouchSupplyService.js (lines 1-341 at move time)

```js
"use strict";

// WO-1 pending delete: the bulk green-first-touch supply path is disabled for
// the alpha bulk-load rewrite. Keep the historical body below as a marked
// pending-delete block until Mickey approves permanent removal.
module.exports = Object.freeze({});

/*
WO-1 pending delete: original cxGreenFirstTouchSupplyService implementation.
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
*/

```

## packages/shared-services/src/cxGreenFirstTouchQueueMaterializerService.js (lines 1-398 at move time)

```js
"use strict";

// WO-1 pending delete: the bulk green-first-touch materializer is disabled for
// the alpha bulk-load rewrite. Keep the historical body below as a marked
// pending-delete block until Mickey approves permanent removal.
module.exports = Object.freeze({});

/*
WO-1 pending delete: original cxGreenFirstTouchQueueMaterializerService implementation.
"use strict";

const { LeadCadence } = require("../../shared-models/src");
const { cxDialQueueRepository } = require("../../shared-repositories/src");
const { logCxAlpha } = require("./cxAlphaTraceService");
const { resolveMorningCoverageBatchWindow } = require("./cxGreenFirstTouchSupplyService");

const ACTIVE_QUEUE_STATES = Object.freeze(["queued", "ready", "claimed", "serving", "paused"]);
const TERMINAL_QUEUE_STATES = Object.freeze(["completed", "cancelled"]);
const ALL_QUEUE_STATES = Object.freeze([...ACTIVE_QUEUE_STATES, ...TERMINAL_QUEUE_STATES]);
const DEFAULT_SCAN_LIMIT = 500;
const DEFAULT_CREATE_LIMIT = 100;
const NON_DIALABLE_STAGE_PATTERN = /(dnc|dead|do\s*not\s*contact|do-not-contact|stop|client|closed|inactive)/i;

function str(value) {
  return String(value == null ? "" : value).trim();
}

function normalizeDomain(value) {
  return str(value).toUpperCase();
}

function normalizePhone(value) {
  const digits = str(value).replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : "";
}

function normalizeRouteCampaigns(value = null) {
  const raw = Array.isArray(value) ? value : str(value).split(",");
  return Array.from(new Set(raw.map((entry) => str(entry).toLowerCase()).filter(Boolean)));
}

function compactName(...parts) {
  return parts.map(str).filter(Boolean).join(" ").trim();
}

function pickLeadName(cadence = {}) {
  return compactName(cadence.name) || compactName(cadence.firstName, cadence.lastName) || null;
}

function pickLeadPhone(cadence = {}) {
  return normalizePhone(cadence.normalizedPhone || cadence.primaryPhone || cadence.phone);
}

function readNumber(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return 0;
}

function readDate(...values) {
  for (const value of values) {
    if (!value) continue;
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return null;
}

function readCxTouchProof(cadence = {}) {
  const counter = cadence.counterCadence && typeof cadence.counterCadence === "object"
    ? cadence.counterCadence
    : {};
  const counters = cadence.cadenceCounters && typeof cadence.cadenceCounters === "object"
    ? cadence.cadenceCounters
    : {};
  const totalCalls = Math.max(
    readNumber(counters.cx),
    readNumber(counter.cxDailyCalls),
    readNumber(counter.cxMonthlyCalls),
  );
  return {
    totalCalls,
    lastTouchedAt: readDate(cadence.lastTouched?.cx, counter.lastCxDialedAt),
    answeredContacts: readNumber(counter.cxAnsweredContacts),
    noAnswerCalls: readNumber(counter.cxNoAnswerCalls),
  };
}

function hasConfirmedCxTouch(cadence = {}) {
  const touch = readCxTouchProof(cadence);
  return touch.totalCalls > 0 || Boolean(touch.lastTouchedAt);
}

function isBlockedCadence(cadence = {}) {
  if (cadence.active === false) return "inactive";
  const stage = str(cadence.currentStage);
  if (stage && NON_DIALABLE_STAGE_PATTERN.test(stage)) return "non-dialable-stage";
  if (cadence.cadenceState?.channelDnc?.cx?.blocked === true) return "cx-dnc";
  if (cadence.dncCheckpoints?.hit === true) return "dnc-checkpoint-hit";
  return null;
}

function buildCadenceQuery({
  domain,
  windowStartAt,
  cutoffAt,
  routeCampaigns = null,
}) {
  const query = {
    domain: normalizeDomain(domain),
    active: true,
    createdAt: {
      $gte: windowStartAt,
      $lt: cutoffAt,
    },
    $or: [
      { normalizedPhone: { $nin: [null, ""] } },
      { primaryPhone: { $nin: [null, ""] } },
    ],
  };
  const routes = normalizeRouteCampaigns(routeCampaigns);
  if (routes.length) query.routeCampaignKey = { $in: routes };
  return query;
}

function resolveRingcxRoute(input = {}) {
  const ringcx = input.ringcx && typeof input.ringcx === "object" ? input.ringcx : {};
  return {
    accountId: str(input.rcxAccountId || ringcx.accountId),
    dialGroupId: str(input.rcxDialGroupId || ringcx.dialGroupId),
    campaignId: str(input.rcxCampaignId || ringcx.campaignId),
  };
}

function buildActionKey(batchId, domain, caseId) {
  return `cx-green-first-touch:${batchId}:${normalizeDomain(domain)}:${Number(caseId)}`;
}

function buildGreenFirstTouchQueueRow(cadence = {}, input = {}) {
  const now = input.now instanceof Date ? input.now : new Date(input.now || Date.now());
  const domain = normalizeDomain(input.domain || cadence.domain);
  const caseId = Number(cadence.caseId);
  const batchId = str(input.batchId);
  const queueLane = str(input.queueLane || "morningCoverage");
  const actionKey = buildActionKey(batchId, domain, caseId);
  const phone = pickLeadPhone(cadence);
  const ringcx = resolveRingcxRoute(input);
  const touch = readCxTouchProof(cadence);
  return {
    domain,
    caseId,
    leadCadenceId: cadence._id ? String(cadence._id) : null,
    phone,
    name: pickLeadName(cadence),
    intakeSource: cadence.intakeSource || "lead-cadence",
    intakeRoute: cadence.intakeRoute || "green-first-touch",
    sourceName: cadence.sourceName || cadence.vendorSourceName || null,
    rcxAccountId: ringcx.accountId || null,
    rcxDialGroupId: ringcx.dialGroupId || null,
    rcxCampaignId: ringcx.campaignId || null,
    state: "ready",
    queueFamily: "fresh-day1",
    queueFamilyRank: 0,
    queueTier: "day0",
    progressiveStageKey: "just-came-in",
    progressiveStageIndex: 0,
    progressiveStageLabel: "First touch",
    priorityScore: Number(input.priorityScore || 125),
    releaseAt: now,
    claimUntil: null,
    placedCalls: 0,
    lastPlacedAt: null,
    dailyPlacedDateKey: null,
    dailyPlacedCalls: 0,
    monthlyPlacedMonthKey: null,
    monthlyPlacedCalls: 0,
    callPlan: {
      phaseIndex: 0,
      delaysMinutes: [0],
      activeDay: 0,
      nextDelayMinutes: 0,
    },
    "metadata.actionKey": actionKey,
    "metadata.queueFamily": "fresh-day1",
    "metadata.queueLane": queueLane,
    "metadata.firstTouchOnly": true,
    "metadata.greenCoverageBatchId": batchId,
    "metadata.greenCoverageScope": str(input.greenCoverageScope || "shared"),
    "metadata.greenCoverageQueuedAt": now,
    "metadata.materializedBy": "cx-green-first-touch-materializer",
    "metadata.materializedFrom": "lead-cadence",
    "metadata.materializedAt": now,
    "metadata.routeCampaignKey": cadence.routeCampaignKey || null,
    "metadata.routeCampaignName": cadence.routeCampaignName || null,
    "metadata.leadCreatedAt": cadence.createdAt || null,
    "metadata.leadState": cadence.state || cadence.payloadSnapshot?.state || null,
    "metadata.cxTouchProofAtMaterialize": {
      totalCalls: touch.totalCalls,
      lastTouchedAt: touch.lastTouchedAt,
      answeredContacts: touch.answeredContacts,
      noAnswerCalls: touch.noAnswerCalls,
    },
  };
}

function createCxGreenFirstTouchQueueMaterializer({
  leadCadenceModel = LeadCadence,
  queueRepository = cxDialQueueRepository,
  logger = console,
  now = () => new Date(),
} = {}) {
  async function existingQueueRows(domain, caseId, actionKey) {
    if (!queueRepository || typeof queueRepository.listQueueItems !== "function") return [];
    return queueRepository.listQueueItems({
      domain,
      caseId,
      states: ALL_QUEUE_STATES,
      metadataActionKey: actionKey,
      limit: 5,
    });
  }

  async function materialize(input = {}) {
    const asOf = input.asOf instanceof Date ? input.asOf : new Date(input.asOf || now());
    const domain = normalizeDomain(input.domain);
    if (!domain) throw new Error("green first-touch materializer requires domain");
    const window = input.batchId && input.windowStartAt && input.cutoffAt
      ? {
        batchId: str(input.batchId),
        windowStartAt: new Date(input.windowStartAt),
        cutoffAt: new Date(input.cutoffAt),
      }
      : resolveMorningCoverageBatchWindow({
        domain,
        asOf,
        cutoffHour: input.cutoffHour,
        cutoffMinute: input.cutoffMinute,
      });
    const apply = input.apply === true || input.dryRun === false;
    const createLimit = Math.min(Math.max(Number(input.limit) || DEFAULT_CREATE_LIMIT, 1), 5000);
    const scanLimit = Math.min(Math.max(Number(input.scanLimit) || createLimit * 5 || DEFAULT_SCAN_LIMIT, createLimit), 10000);
    const ringcx = resolveRingcxRoute(input);
    const requireRingcxRoute = input.requireRingcxRoute !== false;
    const missingRoute = requireRingcxRoute && (!ringcx.accountId || !ringcx.campaignId);
    const query = buildCadenceQuery({
      domain,
      windowStartAt: window.windowStartAt,
      cutoffAt: window.cutoffAt,
      routeCampaigns: input.routeCampaigns,
    });
    const candidates = await leadCadenceModel.find(query)
      .sort({ createdAt: 1, updatedAt: 1, _id: 1 })
      .limit(scanLimit)
      .lean();

    const result = {
      ok: true,
      dryRun: !apply,
      domain,
      batchId: window.batchId,
      windowStartAt: window.windowStartAt,
      cutoffAt: window.cutoffAt,
      scanned: candidates.length,
      eligible: 0,
      alreadyQueued: 0,
      terminalQueued: 0,
      wouldCreate: 0,
      created: 0,
      scanLimitReached: candidates.length >= scanLimit,
      truncated: candidates.length >= scanLimit,
      remainingCandidateCount: 0,
      skipped: {},
      route: ringcx,
      rows: [],
    };

    if (missingRoute) {
      result.ok = false;
      result.skipped["missing-ringcx-route"] = candidates.length;
      result.reason = "missing-ringcx-route";
      return result;
    }

    for (const cadence of candidates) {
      if (result.created + result.wouldCreate >= createLimit) {
        result.truncated = true;
        result.remainingCandidateCount += 1;
        continue;
      }
      const caseId = Number(cadence.caseId);
      const phone = pickLeadPhone(cadence);
      let skipReason = null;
      if (!Number.isFinite(caseId)) skipReason = "invalid-case-id";
      else if (!phone) skipReason = "missing-phone";
      else skipReason = isBlockedCadence(cadence);
      if (!skipReason && hasConfirmedCxTouch(cadence)) skipReason = "already-touched";
      if (skipReason) {
        result.skipped[skipReason] = Number(result.skipped[skipReason] || 0) + 1;
        continue;
      }

      const actionKey = buildActionKey(window.batchId, domain, caseId);
      const existing = await existingQueueRows(domain, caseId, actionKey);
      if (existing.some((row) => !str(row.state) || ACTIVE_QUEUE_STATES.includes(str(row.state)))) {
        result.alreadyQueued += 1;
        continue;
      }
      if (existing.some((row) => TERMINAL_QUEUE_STATES.includes(str(row.state)))) {
        result.terminalQueued += 1;
        result.skipped["terminal-queue-row"] = Number(result.skipped["terminal-queue-row"] || 0) + 1;
        continue;
      }

      result.eligible += 1;
      const row = buildGreenFirstTouchQueueRow(cadence, {
        ...input,
        domain,
        now: asOf,
        batchId: window.batchId,
        ringcx,
      });
      const summary = {
        domain,
        caseId,
        actionKey,
        routeCampaignKey: cadence.routeCampaignKey || null,
        name: row.name || null,
      };
      if (!apply) {
        result.wouldCreate += 1;
        result.rows.push(summary);
        continue;
      }
      await queueRepository.upsertQueueItem(domain, caseId, row, { actionKey });
      result.created += 1;
      result.rows.push(summary);
    }

    logger.info?.("cx.green_first_touch.materialize", {
      domain: result.domain,
      batchId: result.batchId,
      dryRun: result.dryRun,
      scanned: result.scanned,
      eligible: result.eligible,
      alreadyQueued: result.alreadyQueued,
      terminalQueued: result.terminalQueued,
      wouldCreate: result.wouldCreate,
      created: result.created,
      truncated: result.truncated,
      scanLimitReached: result.scanLimitReached,
      remainingCandidateCount: result.remainingCandidateCount,
      skipped: result.skipped,
      route: result.route,
    });
    logCxAlpha("cx.alpha.queue.green_first_touch.materialized", {
      domain: result.domain,
      batchId: result.batchId,
      dryRun: result.dryRun,
      scanned: result.scanned,
      eligible: result.eligible,
      alreadyQueued: result.alreadyQueued,
      terminalQueued: result.terminalQueued,
      wouldCreate: result.wouldCreate,
      created: result.created,
      truncated: result.truncated,
      scanLimitReached: result.scanLimitReached,
      remainingCandidateCount: result.remainingCandidateCount,
      skipped: result.skipped,
      route: result.route,
    }, { logger });
    return result;
  }

  return { materialize };
}

const defaultMaterializer = createCxGreenFirstTouchQueueMaterializer();

async function materializeGreenFirstTouchQueueRows(input = {}) {
  return defaultMaterializer.materialize(input);
}

module.exports = {
  buildCadenceQuery,
  buildGreenFirstTouchQueueRow,
  createCxGreenFirstTouchQueueMaterializer,
  hasConfirmedCxTouch,
  isBlockedCadence,
  materializeGreenFirstTouchQueueRows,
  normalizeRouteCampaigns,
  pickLeadPhone,
  readCxTouchProof,
};
*/

```

## tests/cx-bulk-load/cxGreenFirstTouchSupplyService.test.js (lines 1-175 at move time)

```js
"use strict";

const { test: nodeTest } = require("node:test");
const assert = require("node:assert/strict");

// WO-1 pending delete: dedicated bulk green-first-touch tests are skipped while
// the feature path is inert during the alpha bulk-load rewrite.
const test = nodeTest.skip;

const {
  buildMorningCoverageSupplyPlan,
  createCxGreenFirstTouchSupplyPlanner,
  resolveMorningCoverageBatchWindow,
  summarizeMorningCoverageDebt,
} = require("../../packages/shared-services/src/cxGreenFirstTouchSupplyService");

test("Monday morning coverage window looks back across the weekend", () => {
  const window = resolveMorningCoverageBatchWindow({
    domain: "wynn",
    asOf: new Date("2026-06-29T15:00:00.000Z"),
    cutoffHour: 7,
    cutoffMinute: 45,
  });
  assert.equal(window.batchId, "green-coverage-2026-06-29-WYNN");
  assert.equal(window.lookbackDays, 3);
  assert.equal(window.reason, "weekend-and-overnight-coverage");
  assert.equal(window.timezone, "America/Los_Angeles");
  assert.equal(window.cutoffAt.toISOString(), "2026-06-29T14:45:00.000Z");
  assert.equal(window.windowStartAt.toISOString(), "2026-06-26T14:45:00.000Z");
});

test("TAG morning coverage cutoff resolves in Eastern time", () => {
  const window = resolveMorningCoverageBatchWindow({
    domain: "tag",
    asOf: new Date("2026-06-29T12:00:00.000Z"),
    cutoffHour: 7,
    cutoffMinute: 45,
  });
  assert.equal(window.batchId, "green-coverage-2026-06-29-TAG");
  assert.equal(window.timezone, "America/New_York");
  assert.equal(window.cutoffAt.toISOString(), "2026-06-29T11:45:00.000Z");
  assert.equal(window.windowStartAt.toISOString(), "2026-06-26T11:45:00.000Z");
});

test("coverage plan opens a finite first-touch claim for remaining debt", () => {
  const debt = summarizeMorningCoverageDebt({
    batchId: "green-coverage-2026-06-29-WYNN",
    eligible: 12,
    touched: 4,
    blocked: 1,
    queued: 5,
    missingQueueRows: 2,
  });
  const plan = buildMorningCoverageSupplyPlan({
    batchId: debt.batchId,
    debt,
    deficit: 3,
    normalFamilyTargets: { "fresh-day1": 15, aged: 5 },
  });
  assert.equal(plan.lane, "morningCoverage");
  assert.equal(plan.coverageOpen, true);
  assert.equal(plan.firstTouchOnly, true);
  assert.deepEqual(plan.familyTargets, { "fresh-day1": 3 });
  assert.deepEqual(plan.claimFilter, {
    firstTouchOnly: true,
    greenCoverageBatchId: "green-coverage-2026-06-29-WYNN",
    firstTouchMaxAttempts: 1,
  });
});

test("coverage plan returns normal mix when debt is gone", () => {
  const plan = buildMorningCoverageSupplyPlan({
    batchId: "green-coverage-2026-06-29-WYNN",
    debt: { remaining: 0 },
    normalFamilyTargets: { "fresh-day1": 10, aged: 5 },
  });
  assert.equal(plan.lane, "normal");
  assert.equal(plan.coverageOpen, false);
  assert.equal(plan.firstTouchOnly, false);
  assert.deepEqual(plan.familyTargets, { "fresh-day1": 10, aged: 5 });
  assert.deepEqual(plan.claimFilter, { firstTouchOnly: false });
});

test("supply planner is default-off and returns the normal family mix", async () => {
  const planner = createCxGreenFirstTouchSupplyPlanner({
    enabled: false,
    queueRepository: {
      async countReadyFirstTouchRows() {
        throw new Error("should-not-count-when-disabled");
      },
    },
  });

  const plan = await planner.resolvePlan({
    domain: "wynn",
    asOf: new Date("2026-06-29T15:00:00.000Z"),
    deficit: 4,
    normalFamilyTargets: { "fresh-day1": 15, aged: 5 },
  });

  assert.equal(plan.lane, "normal");
  assert.equal(plan.firstTouchOnly, false);
  assert.equal(plan.reason, "green-first-touch-disabled");
  assert.equal(plan.batchId, "green-coverage-2026-06-29-WYNN");
  assert.deepEqual(plan.familyTargets, { "fresh-day1": 15, aged: 5 });
});

test("supply planner counts ready first-touch rows for the finite coverage batch", async () => {
  const calls = [];
  const planner = createCxGreenFirstTouchSupplyPlanner({
    enabled: true,
    queueRepository: {
      async countReadyFirstTouchRows(input) {
        calls.push(input);
        return 6;
      },
    },
    cutoffHour: 7,
    cutoffMinute: 45,
  });

  const plan = await planner.resolvePlan({
    domain: "tag",
    asOf: new Date("2026-06-29T15:00:00.000Z"),
    deficit: 3,
    normalFamilyTargets: { "fresh-day1": 15, "fresh-day2to10": 10, aged: 5 },
    ringcx: { accountId: "acct1", campaignId: "camp1", dialGroupId: "dg1" },
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    domain: "tag",
    greenCoverageBatchId: "green-coverage-2026-06-29-TAG",
    rcxAccountId: "acct1",
    rcxCampaignId: "camp1",
    rcxDialGroupId: "dg1",
    firstTouchMaxAttempts: 1,
    now: new Date("2026-06-29T15:00:00.000Z"),
  });
  assert.equal(plan.lane, "morningCoverage");
  assert.equal(plan.firstTouchOnly, true);
  assert.equal(plan.batchId, "green-coverage-2026-06-29-TAG");
  assert.deepEqual(plan.familyTargets, { "fresh-day1": 3 });
  assert.deepEqual(plan.claimFilter, {
    firstTouchOnly: true,
    greenCoverageBatchId: "green-coverage-2026-06-29-TAG",
    firstTouchMaxAttempts: 1,
  });
  assert.equal(plan.counts.remaining, 6);
});

test("supply planner forwards configured first-touch max attempts to count and claim", async () => {
  const calls = [];
  const planner = createCxGreenFirstTouchSupplyPlanner({
    enabled: true,
    firstTouchMaxAttempts: 2,
    queueRepository: {
      async countReadyFirstTouchRows(input) {
        calls.push(input);
        return 4;
      },
    },
  });

  const plan = await planner.resolvePlan({
    domain: "wynn",
    asOf: new Date("2026-06-29T15:00:00.000Z"),
    deficit: 2,
    normalFamilyTargets: { "fresh-day1": 15 },
  });

  assert.equal(calls[0].firstTouchMaxAttempts, 2);
  assert.equal(plan.claimFilter.firstTouchMaxAttempts, 2);
});

```

## tests/cx-bulk-load/cxGreenFirstTouchQueueMaterializerService.test.js (lines 1-372 at move time)

```js
"use strict";

const { test: nodeTest } = require("node:test");
const assert = require("node:assert/strict");

// WO-1 pending delete: dedicated bulk green-first-touch tests are skipped while
// the feature path is inert during the alpha bulk-load rewrite.
const test = nodeTest.skip;

const {
  buildCadenceQuery,
  buildGreenFirstTouchQueueRow,
  createCxGreenFirstTouchQueueMaterializer,
  hasConfirmedCxTouch,
  normalizeRouteCampaigns,
  pickLeadPhone,
} = require("../../packages/shared-services/src/cxGreenFirstTouchQueueMaterializerService");

function makeLeadCadenceModel(rows) {
  const state = {
    lastQuery: null,
    sortValue: null,
    limitValue: null,
  };
  return {
    state,
    find(query) {
      state.lastQuery = query;
      const chain = {
        sort(value) {
          state.sortValue = value;
          return chain;
        },
        limit(value) {
          state.limitValue = value;
          return chain;
        },
        async lean() {
          return rows;
        },
      };
      return chain;
    },
  };
}

function makeQueueRepository(existingActionKeys = []) {
  return {
    existingActionKeys: new Set(existingActionKeys),
    listCalls: [],
    writes: [],
    async listQueueItems(input) {
      this.listCalls.push(input);
      return this.existingActionKeys.has(input.metadataActionKey)
        ? [{ _id: input.metadataActionKey }]
        : [];
    },
    async upsertQueueItem(domain, caseId, row, options) {
      this.writes.push({ domain, caseId, row, options });
      return { _id: options.actionKey, ...row };
    },
  };
}

test("normalizes route campaigns and phones for first-touch inputs", () => {
  assert.deepEqual(normalizeRouteCampaigns("WYNN:Green, wynn:green, TAG:Blue"), [
    "wynn:green",
    "tag:blue",
  ]);
  assert.equal(pickLeadPhone({ primaryPhone: "(714) 555-1122" }), "7145551122");
  assert.equal(pickLeadPhone({ normalizedPhone: "17145553333" }), "7145553333");
});

test("touch proof blocks any cadence row with prior cx proof", () => {
  assert.equal(hasConfirmedCxTouch({ counterCadence: { cxDailyCalls: 0, cxMonthlyCalls: 1 } }), true);
  assert.equal(hasConfirmedCxTouch({ cadenceCounters: { cx: 1 } }), true);
  assert.equal(hasConfirmedCxTouch({ lastTouched: { cx: "2026-06-29T14:00:00.000Z" } }), true);
  assert.equal(hasConfirmedCxTouch({ counterCadence: { cxDailyCalls: 0, cxMonthlyCalls: 0 } }), false);
});

test("cadence query scopes the finite morning window and route campaigns", () => {
  const windowStartAt = new Date("2026-06-26T07:45:00.000Z");
  const cutoffAt = new Date("2026-06-29T07:45:00.000Z");
  const query = buildCadenceQuery({
    domain: "wynn",
    windowStartAt,
    cutoffAt,
    routeCampaigns: ["WYNN:Fresh", "wynn:fresh", "WYNN:Blue"],
  });

  assert.equal(query.domain, "WYNN");
  assert.equal(query.active, true);
  assert.deepEqual(query.createdAt, { $gte: windowStartAt, $lt: cutoffAt });
  assert.deepEqual(query.routeCampaignKey, { $in: ["wynn:fresh", "wynn:blue"] });
  assert.deepEqual(query.$or, [
    { normalizedPhone: { $nin: [null, ""] } },
    { primaryPhone: { $nin: [null, ""] } },
  ]);
});

test("dry run reports eligible first-touch rows without writing queue rows", async () => {
  const rows = [
    {
      _id: "cadence-1",
      domain: "WYNN",
      caseId: 101,
      firstName: "Fresh",
      lastName: "Green",
      normalizedPhone: "7145550001",
      routeCampaignKey: "wynn:fresh",
      createdAt: new Date("2026-06-28T18:00:00.000Z"),
      cadenceCounters: { cx: 0 },
    },
    {
      _id: "cadence-2",
      domain: "WYNN",
      caseId: 102,
      firstName: "Already",
      lastName: "Touched",
      normalizedPhone: "7145550002",
      routeCampaignKey: "wynn:fresh",
      createdAt: new Date("2026-06-28T18:10:00.000Z"),
      counterCadence: { cxMonthlyCalls: 1 },
    },
    {
      _id: "cadence-3",
      domain: "WYNN",
      caseId: 103,
      firstName: "Blocked",
      lastName: "Lead",
      normalizedPhone: "7145550003",
      routeCampaignKey: "wynn:fresh",
      createdAt: new Date("2026-06-28T18:20:00.000Z"),
      cadenceState: { channelDnc: { cx: { blocked: true } } },
    },
    {
      _id: "cadence-4",
      domain: "WYNN",
      caseId: 104,
      firstName: "No",
      lastName: "Phone",
      routeCampaignKey: "wynn:fresh",
      createdAt: new Date("2026-06-28T18:30:00.000Z"),
    },
  ];
  const leadCadenceModel = makeLeadCadenceModel(rows);
  const queueRepository = makeQueueRepository();
  const materializer = createCxGreenFirstTouchQueueMaterializer({
    leadCadenceModel,
    queueRepository,
    logger: {},
    now: () => new Date("2026-06-29T15:00:00.000Z"),
  });

  const result = await materializer.materialize({
    domain: "wynn",
    routeCampaigns: ["wynn:fresh"],
    ringcx: { accountId: "acct1", campaignId: "camp1", dialGroupId: "dg1" },
    asOf: new Date("2026-06-29T15:00:00.000Z"),
  });

  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.batchId, "green-coverage-2026-06-29-WYNN");
  assert.equal(result.scanned, 4);
  assert.equal(result.eligible, 1);
  assert.equal(result.wouldCreate, 1);
  assert.equal(result.created, 0);
  assert.equal(result.skipped["already-touched"], 1);
  assert.equal(result.skipped["cx-dnc"], 1);
  assert.equal(result.skipped["missing-phone"], 1);
  assert.equal(queueRepository.writes.length, 0);
  assert.equal(queueRepository.listCalls.length, 1);
  assert.deepEqual(leadCadenceModel.state.lastQuery.routeCampaignKey, { $in: ["wynn:fresh"] });
});

test("apply writes a scoped first-touch queue row with RingCX route and idempotency key", async () => {
  const rows = [{
    _id: "cadence-201",
    domain: "TAG",
    caseId: 201,
    name: "Case Ready",
    primaryPhone: "714-555-0201",
    routeCampaignKey: "tag:fresh",
    routeCampaignName: "TAG Fresh",
    createdAt: new Date("2026-06-28T16:00:00.000Z"),
  }];
  const queueRepository = makeQueueRepository();
  const materializer = createCxGreenFirstTouchQueueMaterializer({
    leadCadenceModel: makeLeadCadenceModel(rows),
    queueRepository,
    logger: {},
  });

  const result = await materializer.materialize({
    domain: "tag",
    apply: true,
    asOf: new Date("2026-06-29T15:00:00.000Z"),
    ringcx: { accountId: "acct1", campaignId: "camp1", dialGroupId: "dg1" },
    routeCampaigns: ["tag:fresh"],
  });

  assert.equal(result.ok, true);
  assert.equal(result.dryRun, false);
  assert.equal(result.created, 1);
  assert.equal(queueRepository.writes.length, 1);

  const write = queueRepository.writes[0];
  assert.equal(write.domain, "TAG");
  assert.equal(write.caseId, 201);
  assert.equal(write.options.actionKey, "cx-green-first-touch:green-coverage-2026-06-29-TAG:TAG:201");
  assert.equal(write.row.state, "ready");
  assert.equal(write.row.queueFamily, "fresh-day1");
  assert.equal(write.row.phone, "7145550201");
  assert.equal(write.row.rcxAccountId, "acct1");
  assert.equal(write.row.rcxCampaignId, "camp1");
  assert.equal(write.row.rcxDialGroupId, "dg1");
  assert.equal(write.row["metadata.firstTouchOnly"], true);
  assert.equal(write.row["metadata.greenCoverageBatchId"], "green-coverage-2026-06-29-TAG");
  assert.equal(write.row["metadata.queueLane"], "morningCoverage");
  assert.equal(write.row["metadata.actionKey"], write.options.actionKey);
  assert.equal(write.row["metadata.cxTouchProofAtMaterialize"].totalCalls, 0);
});

test("existing active queue row dedupes by action key", async () => {
  const actionKey = "cx-green-first-touch:green-coverage-2026-06-29-WYNN:WYNN:301";
  const queueRepository = makeQueueRepository([actionKey]);
  const materializer = createCxGreenFirstTouchQueueMaterializer({
    leadCadenceModel: makeLeadCadenceModel([{
      _id: "cadence-301",
      domain: "WYNN",
      caseId: 301,
      primaryPhone: "7145550301",
      createdAt: new Date("2026-06-28T18:00:00.000Z"),
    }]),
    queueRepository,
    logger: {},
  });

  const result = await materializer.materialize({
    domain: "wynn",
    apply: true,
    asOf: new Date("2026-06-29T15:00:00.000Z"),
    ringcx: { accountId: "acct1", campaignId: "camp1" },
  });

  assert.equal(result.ok, true);
  assert.equal(result.alreadyQueued, 1);
  assert.equal(result.created, 0);
  assert.equal(queueRepository.writes.length, 0);
});

test("existing terminal queue row blocks first-touch resurrection", async () => {
  const queueRepository = {
    writes: [],
    async listQueueItems() {
      return [{ _id: "terminal-row", state: "completed" }];
    },
    async upsertQueueItem(domain, caseId, row, options) {
      this.writes.push({ domain, caseId, row, options });
      return { _id: options.actionKey, ...row };
    },
  };
  const materializer = createCxGreenFirstTouchQueueMaterializer({
    leadCadenceModel: makeLeadCadenceModel([{
      _id: "cadence-302",
      domain: "WYNN",
      caseId: 302,
      primaryPhone: "7145550302",
      createdAt: new Date("2026-06-28T18:00:00.000Z"),
    }]),
    queueRepository,
    logger: {},
  });

  const result = await materializer.materialize({
    domain: "wynn",
    apply: true,
    asOf: new Date("2026-06-29T15:00:00.000Z"),
    ringcx: { accountId: "acct1", campaignId: "camp1" },
  });

  assert.equal(result.ok, true);
  assert.equal(result.terminalQueued, 1);
  assert.equal(result.skipped["terminal-queue-row"], 1);
  assert.equal(result.created, 0);
  assert.equal(queueRepository.writes.length, 0);
});

test("materializer reports truncation when create limit is reached", async () => {
  const rows = [1, 2, 3].map((n) => ({
    _id: `cadence-60${n}`,
    domain: "WYNN",
    caseId: 600 + n,
    primaryPhone: `714555060${n}`,
    createdAt: new Date("2026-06-28T18:00:00.000Z"),
  }));
  const materializer = createCxGreenFirstTouchQueueMaterializer({
    leadCadenceModel: makeLeadCadenceModel(rows),
    queueRepository: makeQueueRepository(),
    logger: {},
  });

  const result = await materializer.materialize({
    domain: "wynn",
    limit: 1,
    scanLimit: 10,
    asOf: new Date("2026-06-29T15:00:00.000Z"),
    ringcx: { accountId: "acct1", campaignId: "camp1" },
  });

  assert.equal(result.ok, true);
  assert.equal(result.truncated, true);
  assert.equal(result.scanLimitReached, false);
  assert.equal(result.wouldCreate, 1);
  assert.equal(result.remainingCandidateCount, 2);
});

test("missing RingCX route fails closed before creating queue rows", async () => {
  const queueRepository = makeQueueRepository();
  const materializer = createCxGreenFirstTouchQueueMaterializer({
    leadCadenceModel: makeLeadCadenceModel([{
      _id: "cadence-401",
      domain: "WYNN",
      caseId: 401,
      primaryPhone: "7145550401",
      createdAt: new Date("2026-06-28T18:00:00.000Z"),
    }]),
    queueRepository,
    logger: {},
  });

  const result = await materializer.materialize({
    domain: "wynn",
    apply: true,
    asOf: new Date("2026-06-29T15:00:00.000Z"),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "missing-ringcx-route");
  assert.equal(result.created, 0);
  assert.equal(result.skipped["missing-ringcx-route"], 1);
  assert.equal(queueRepository.writes.length, 0);
});

test("queue row builder keeps the shape consumed by first-touch reservation", () => {
  const row = buildGreenFirstTouchQueueRow({
    _id: "cadence-501",
    domain: "WYNN",
    caseId: 501,
    firstName: "Shape",
    lastName: "Check",
    primaryPhone: "7145550501",
    routeCampaignKey: "wynn:fresh",
  }, {
    domain: "wynn",
    batchId: "green-coverage-2026-06-29-WYNN",
    now: new Date("2026-06-29T15:00:00.000Z"),
    ringcx: { accountId: "acct1", campaignId: "camp1", dialGroupId: "dg1" },
  });

  assert.equal(row.domain, "WYNN");
  assert.equal(row.caseId, 501);
  assert.equal(row.name, "Shape Check");
  assert.equal(row.phone, "7145550501");
  assert.equal(row.queueFamily, "fresh-day1");
  assert.equal(row.placedCalls, 0);
  assert.equal(row.dailyPlacedCalls, 0);
  assert.equal(row["metadata.firstTouchOnly"], true);
  assert.equal(row["metadata.greenCoverageScope"], "shared");
});

```

## tests/cx-bulk-load/cxDialQueueRepositoryFirstTouch.test.js (lines 1-112 at move time)

```js
"use strict";

const { test: nodeTest } = require("node:test");
const assert = require("node:assert/strict");

// WO-1 pending delete: dedicated bulk first-touch repository tests are skipped
// while the feature path is inert during the alpha bulk-load rewrite.
const test = nodeTest.skip;

const {
  buildReadyClaimQuery,
  buildReadyReservationQuery,
} = require("../../packages/shared-repositories/src/cxDialQueueRepository");

function hasOrClause(query, field, predicate) {
  const clauses = Array.isArray(query.$and) ? query.$and : [];
  return clauses.some((clause) => {
    const parts = Array.isArray(clause.$or) ? clause.$or : [];
    return parts.some((part) => predicate(part[field]));
  });
}

test("firstTouchOnly adds zero-dial proof filters and finite batch scope", () => {
  const query = buildReadyClaimQuery("wynn", {
    queueFamily: "fresh-day1",
    routeCampaigns: ["wynn:camp1"],
    firstTouchOnly: true,
    greenCoverageBatchId: "green-coverage-2026-06-29-WYNN",
  });

  assert.equal(query.state, "ready");
  assert.equal(query.domain, "WYNN");
  assert.deepEqual(query.queueFamily, { $in: ["fresh-day1"] });
  assert.deepEqual(query["metadata.routeCampaignKey"], { $in: ["wynn:camp1"] });
  assert.ok(hasOrClause(query, "placedCalls", (value) => value && value.$lte === 0));
  assert.ok(hasOrClause(query, "dailyPlacedCalls", (value) => value && value.$lte === 0));
  assert.ok(hasOrClause(query, "progressiveStageIndex", (value) => value && value.$lte === 0));
  assert.ok(hasOrClause(query, "metadata.firstTouchAttempts", (value) => value && value.$lt === 1));
  assert.ok(query.$and.some((clause) => clause["metadata.greenCoverageBatchId"] === "green-coverage-2026-06-29-WYNN"));
});

test("normal ready claim query does not add first-touch filters", () => {
  const query = buildReadyClaimQuery("tag", { queueFamily: "fresh-day1" });
  assert.equal(query.domain, "TAG");
  assert.deepEqual(query.queueFamily, { $in: ["fresh-day1"] });
  assert.equal(query.$and, undefined);
});

test("first-touch reservation query keeps route and batch scope together", () => {
  const now = new Date("2026-06-29T15:00:00.000Z");
  const query = buildReadyReservationQuery("tag", "fresh-day1", {
    firstTouchOnly: true,
    greenCoverageBatchId: "green-coverage-2026-06-29-TAG",
    rcxAccountId: "acct1",
    rcxCampaignId: "camp1",
    rcxDialGroupId: "dg1",
  }, now);

  assert.equal(query.state, "ready");
  assert.equal(query.domain, "TAG");
  assert.equal(query.queueFamily, "fresh-day1");
  assert.deepEqual(query.releaseAt, { $lte: now });
  assert.deepEqual(query["metadata.appointmentId"], { $in: [null, ""] });
  assert.equal(query.rcxAccountId, "acct1");
  assert.equal(query.rcxCampaignId, "camp1");
  assert.equal(query.rcxDialGroupId, "dg1");
  assert.ok(hasOrClause(query, "placedCalls", (value) => value && value.$lte === 0));
  assert.ok(hasOrClause(query, "metadata.firstTouchAttempts", (value) => value && value.$lt === 1));
  assert.ok(query.$and.some((clause) => clause["metadata.greenCoverageBatchId"] === "green-coverage-2026-06-29-TAG"));
});

test("firstTouchOnly honors an explicit max-attempt bound", () => {
  const query = buildReadyReservationQuery("tag", "fresh-day1", {
    firstTouchOnly: true,
    greenCoverageBatchId: "green-coverage-2026-06-29-TAG",
    firstTouchMaxAttempts: 2,
  }, new Date("2026-06-29T15:00:00.000Z"));

  assert.ok(hasOrClause(query, "metadata.firstTouchAttempts", (value) => value && value.$lt === 2));
});

test("firstTouchOnly treats null max attempts as the default one-attempt bound", () => {
  const query = buildReadyReservationQuery("tag", "fresh-day1", {
    firstTouchOnly: true,
    greenCoverageBatchId: "green-coverage-2026-06-29-TAG",
    firstTouchMaxAttempts: null,
  }, new Date("2026-06-29T15:00:00.000Z"));

  assert.ok(hasOrClause(query, "metadata.firstTouchAttempts", (value) => value && value.$lt === 1));
  assert.equal(query.$and.some((clause) => clause._id && clause._id.$exists === false), false);
});

test("firstTouchOnly with zero max attempts fails closed", () => {
  const query = buildReadyReservationQuery("tag", "fresh-day1", {
    firstTouchOnly: true,
    greenCoverageBatchId: "green-coverage-2026-06-29-TAG",
    firstTouchMaxAttempts: 0,
  }, new Date("2026-06-29T15:00:00.000Z"));

  assert.ok(query.$and.some((clause) => clause._id && clause._id.$exists === false));
});

test("firstTouchOnly fails closed without finite batch or lane scope", () => {
  const query = buildReadyClaimQuery("wynn", {
    queueFamily: "fresh-day1",
    firstTouchOnly: true,
  });

  assert.ok(hasOrClause(query, "placedCalls", (value) => value && value.$lte === 0));
  assert.ok(query.$and.some((clause) => clause._id && clause._id.$exists === false));
});

```

## packages/shared-repositories/src/cxDialQueueRepository.js (lines 829-829 at move time)

```js
  // WO-1 pending delete: countReadyFirstTouchRows,
```

## packages/shared-repositories/src/cxDialQueueRepository.js (lines 504-526 at move time)

```js
/*
WO-1 pending delete: bulk green-first-touch ready-row count disabled.
async function countReadyFirstTouchRows({
  domain = null,
  greenCoverageBatchId = null,
  queueLane = null,
  firstTouchMaxAttempts = null,
  rcxAccountId = null,
  rcxCampaignId = null,
  rcxDialGroupId = null,
  now = new Date(),
} = {}) {
  return CxDialQueue.countDocuments(buildReadyReservationQuery(domain, "fresh-day1", {
    firstTouchOnly: true,
    greenCoverageBatchId,
    queueLane,
    firstTouchMaxAttempts,
    rcxAccountId,
    rcxCampaignId,
    rcxDialGroupId,
  }, now instanceof Date ? now : new Date(now)));
}
*/
```

## packages/shared-repositories/src/cxDialQueueRepository.js (lines 176-177 at move time)

```js
  // WO-1 pending delete: bulk green-first-touch claim filtering disabled.
  // applyFirstTouchClaimFilter(query, options);
```

## packages/shared-repositories/src/cxDialQueueRepository.js (lines 135-136 at move time)

```js
  // WO-1 pending delete: bulk green-first-touch claim filtering disabled.
  // return applyFirstTouchClaimFilter(query, options);
```

## packages/shared-repositories/src/cxDialQueueRepository.js (lines 68-119 at move time)

```js
/*
WO-1 pending delete: bulk green-first-touch claim narrowing is disabled.
function zeroOrMissing(field) {
  return {
    $or: [
      { [field]: { $exists: false } },
      { [field]: null },
      { [field]: { $lte: 0 } },
    ],
  };
}

function applyFirstTouchClaimFilter(query, options = {}) {
  if (options.firstTouchOnly !== true) return query;
  const batchId = String(options.greenCoverageBatchId || "").trim();
  const lane = String(options.queueLane || "").trim();
  const rawMaxAttempts = options.firstTouchMaxAttempts;
  const hasMaxAttempts =
    rawMaxAttempts !== undefined &&
    rawMaxAttempts !== null &&
    String(rawMaxAttempts).trim() !== "";
  const maxAttempts = hasMaxAttempts && Number.isFinite(Number(rawMaxAttempts))
    ? Math.max(Number(rawMaxAttempts), 0)
    : 1;
  const clauses = [
    zeroOrMissing("placedCalls"),
    zeroOrMissing("dailyPlacedCalls"),
    zeroOrMissing("progressiveStageIndex"),
  ];
  if (maxAttempts <= 0) {
    clauses.push({ _id: { $exists: false } });
  } else {
    clauses.push({
      $or: [
        { "metadata.firstTouchAttempts": { $exists: false } },
        { "metadata.firstTouchAttempts": null },
        { "metadata.firstTouchAttempts": { $lt: maxAttempts } },
      ],
    });
  }
  if (batchId) {
    clauses.push({ "metadata.greenCoverageBatchId": batchId });
  }
  if (lane) {
    clauses.push({ "metadata.queueLane": lane });
  }
  if (!batchId && !lane) {
    clauses.push({ _id: { $exists: false } });
  }
  return appendAndClauses(query, clauses);
}
*/
```

## packages/shared-services/src/cxQueueReservationService.js (lines 165-165 at move time)

```js
            // WO-1 pending delete: firstTouchReleasePatch(row, releasedAt, reason),
```

## packages/shared-services/src/cxQueueReservationService.js (lines 90-94 at move time)

```js
        // WO-1 pending delete: legacy bulk first-touch reserve options disabled.
        // firstTouchOnly,
        // greenCoverageBatchId,
        // queueLane,
        // firstTouchMaxAttempts,
```

## packages/shared-services/src/cxQueueReservationService.js (lines 64-68 at move time)

```js
    // WO-1 pending delete: legacy bulk first-touch reserve options are ignored.
    // firstTouchOnly = false,
    // greenCoverageBatchId = null,
    // queueLane = null,
    // firstTouchMaxAttempts = null,
```

## packages/shared-services/src/cxQueueReservationService.js (lines 19-41 at move time)

```js
/*
WO-1 pending delete: bulk green-first-touch release accounting is disabled.
function isFirstTouchReservation(row = {}) {
  const metadata = row && typeof row.metadata === "object" ? row.metadata : {};
  return metadata.firstTouchOnly === true || Boolean(metadata.greenCoverageBatchId);
}

function shouldCountFirstTouchRelease(reason = "") {
  const value = String(reason || "").trim().toLowerCase();
  return value !== "session-killed";
}

function firstTouchReleasePatch(row = {}, at = new Date(), reason = "") {
  if (!isFirstTouchReservation(row)) return {};
  if (!shouldCountFirstTouchRelease(reason)) return {};
  const metadata = row && typeof row.metadata === "object" ? row.metadata : {};
  const attempts = Math.max(Number(metadata.firstTouchAttempts) || 0, 0) + 1;
  return {
    "metadata.firstTouchAttempts": attempts,
    "metadata.firstTouchLastAttemptAt": at,
  };
}
*/
```

## packages/shared-services/src/cxBulkLoadRuntimeService.js (lines 530-534 at move time)

```js
      // WO-1 pending delete: legacy bulk green-first-touch reserve options disabled.
      // firstTouchOnly: firstTouchPlan.firstTouchOnly === true,
      // greenCoverageBatchId: claimFilter.greenCoverageBatchId || firstTouchPlan.batchId || null,
      // queueLane: claimFilter.queueLane || firstTouchPlan.queueLane || null,
      // firstTouchMaxAttempts: claimFilter.firstTouchMaxAttempts ?? null,
```

## packages/shared-services/src/cxBulkLoadRuntimeService.js (lines 347-347 at move time)

```js
    // WO-1 pending delete: greenFirstTouchPlanner = null,
```

## packages/shared-services/src/cxBulkLoadRuntimeService.js (lines 170-215 at move time)

```js
/*
WO-1 pending delete: bulk green-first-touch supply planning is disabled.
function normalizeFirstTouchSupplyPlan(plan = null, normalFamilyTargets = {}) {
  if (!plan || typeof plan !== "object") {
    return {
      lane: "normal",
      familyTargets: { ...(normalFamilyTargets || {}) },
      firstTouchOnly: false,
      claimFilter: { firstTouchOnly: false },
      reason: "no-first-touch-plan",
    };
  }
  const claimFilter = plan.claimFilter && typeof plan.claimFilter === "object" ? plan.claimFilter : {};
  const batchId = str(claimFilter.greenCoverageBatchId || plan.batchId);
  const queueLane = str(claimFilter.queueLane || plan.queueLane);
  const firstTouchOnly = plan.firstTouchOnly === true || claimFilter.firstTouchOnly === true;
  const firstTouchMaxAttempts = Number.isFinite(Number(claimFilter.firstTouchMaxAttempts ?? plan.firstTouchMaxAttempts))
    ? Math.max(Number(claimFilter.firstTouchMaxAttempts ?? plan.firstTouchMaxAttempts), 0)
    : null;
  const scoped = Boolean(batchId || queueLane);
  if (firstTouchOnly && !scoped) {
    return {
      lane: "normal",
      familyTargets: { ...(normalFamilyTargets || {}) },
      firstTouchOnly: false,
      claimFilter: { firstTouchOnly: false },
      counts: plan.counts || {},
      reason: "first-touch-plan-unscoped",
    };
  }
  return {
    ...plan,
    familyTargets: plan.familyTargets && typeof plan.familyTargets === "object"
      ? plan.familyTargets
      : { ...(normalFamilyTargets || {}) },
    firstTouchOnly,
    claimFilter: {
      ...claimFilter,
      firstTouchOnly,
      greenCoverageBatchId: batchId || null,
      queueLane: queueLane || null,
      ...(firstTouchMaxAttempts != null ? { firstTouchMaxAttempts } : {}),
    },
  };
}
*/
```

## packages/shared-services/src/cxBulkLoadRuntime.js (lines 1299-1306 at move time)

```js
    // WO-1 pending delete: bulk green-first-touch planner disabled.
    // greenFirstTouchPlanner: createCxGreenFirstTouchSupplyPlanner({
    //   enabled: readBooleanEnv("CX_GREEN_FIRST_TOUCH_BULK_ENABLED", false),
    //   queueRepository: cxDialQueueRepository,
    //   cutoffHour: readIntegerEnv("CX_GREEN_FIRST_TOUCH_CUTOFF_HOUR", 7, 0, 23),
    //   cutoffMinute: readIntegerEnv("CX_GREEN_FIRST_TOUCH_CUTOFF_MINUTE", 45, 0, 59),
    //   firstTouchMaxAttempts: readIntegerEnv("CX_GREEN_FIRST_TOUCH_MAX_ATTEMPTS", 1, 1, 10),
    // }),
```

## packages/shared-services/src/cxBulkLoadRuntime.js (lines 32-33 at move time)

```js
// WO-1 pending delete: bulk green-first-touch supply planner disabled.
// const { createCxGreenFirstTouchSupplyPlanner } = require("./cxGreenFirstTouchSupplyService");
```

## packages/shared-services/src/index.js (lines 1160-1161 at move time)

```js
  // WO-1 pending delete: resolveMorningCoverageBatchWindow,
  // WO-1 pending delete: summarizeMorningCoverageDebt,
```

## packages/shared-services/src/index.js (lines 1149-1155 at move time)

```js
  // WO-1 pending delete: buildMorningCoverageSupplyPlan,
  // WO-1 pending delete: buildNormalSupplyPlan,
  // WO-1 pending delete: createCxGreenFirstTouchSupplyPlanner,
  // WO-1 pending delete: buildGreenFirstTouchCadenceQuery,
  // WO-1 pending delete: buildGreenFirstTouchQueueRow,
  // WO-1 pending delete: createCxGreenFirstTouchQueueMaterializer,
  // WO-1 pending delete: materializeGreenFirstTouchQueueRows,
```

## packages/shared-services/src/index.js (lines 346-359 at move time)

```js
// WO-1 pending delete: bulk green-first-touch services disabled and no longer re-exported.
// const {
//   buildMorningCoverageSupplyPlan,
//   buildNormalSupplyPlan,
//   createCxGreenFirstTouchSupplyPlanner,
//   resolveMorningCoverageBatchWindow,
//   summarizeMorningCoverageDebt,
// } = require("./cxGreenFirstTouchSupplyService");
// const {
//   buildCadenceQuery: buildGreenFirstTouchCadenceQuery,
//   buildGreenFirstTouchQueueRow,
//   createCxGreenFirstTouchQueueMaterializer,
//   materializeGreenFirstTouchQueueRows,
// } = require("./cxGreenFirstTouchQueueMaterializerService");
```
