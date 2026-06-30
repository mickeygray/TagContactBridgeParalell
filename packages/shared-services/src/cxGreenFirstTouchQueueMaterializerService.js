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
