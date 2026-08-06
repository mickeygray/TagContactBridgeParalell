"use strict";

const { getCompanyKeys } = require("../../shared-config/src");
const { createDropClient } = require("../../shared-integrations/src");
const { LeadCadence } = require("../../shared-models/src");
const { leadCadenceRepository } = require("../../shared-repositories/src");
const { classifyDropDisposition } = require("./outboundFailureClassifier");
const { recordWorkflowStage } = require("./workflowStateService");

const TIMEZONE = process.env.COUNTER_CADENCE_TIMEZONE || "America/Los_Angeles";
const DAILY_HOUR = Math.max(0, Math.min(23, Number(process.env.COUNTER_CADENCE_DAILY_HOUR) || 9));
const DAILY_WINDOW_MINUTES = Math.max(Number(process.env.COUNTER_CADENCE_DAILY_WINDOW_MINUTES) || 180, 1);
const AGE_RELATIVE_TEXT_2_MS = Math.max(Number(process.env.COUNTER_CADENCE_TEXT_2_DELAY_MS) || 2 * 60 * 60 * 1000, 1);
const DAILY_MIN_GAP_MS = Math.max(Number(process.env.COUNTER_CADENCE_DAILY_MIN_GAP_MS) || 20 * 60 * 60 * 1000, 1);
const CLAIM_TTL_MS = Math.max(Number(process.env.COUNTER_CADENCE_CLAIM_TTL_MS) || 10 * 60 * 1000, 60 * 1000);
const DEFAULT_SCAN_LIMIT = Math.max(Number(process.env.COUNTER_CADENCE_SCAN_LIMIT) || 2000, 100);
const ACTIVE_WEEKDAYS = String(process.env.COUNTER_CADENCE_ACTIVE_WEEKDAYS || "1,2,3,4,5")
  .split(",")
  .map((value) => Number(String(value).trim()))
  .filter((value) => Number.isInteger(value) && value >= 0 && value <= 6);

const CHAINS = Object.freeze({
  sms: [
    "prospect-first-text",
    "prospect-follow-up-text-2",
    "prospect-follow-up-text-3",
    "prospect-follow-up-text-4",
    "prospect-follow-up-text-5",
  ],
  email: [
    "prospect-welcome-email",
    "prospect-follow-up-2-email",
    "prospect-follow-up-3-email",
    "prospect-follow-up-4-email",
    "prospect-follow-up-5-email",
    "prospect-follow-up-6-email",
    "prospect-follow-up-7-email",
    "prospect-follow-up-8-email",
    "prospect-follow-up-9-email",
    "prospect-follow-up-10-email",
  ],
  rvm: [
    "prospect-rvm-1",
    "prospect-rvm-2",
    "prospect-rvm-3",
    "prospect-rvm-4",
    "prospect-rvm-5",
    "prospect-rvm-6",
    "prospect-rvm-7",
    "prospect-rvm-8",
    "prospect-rvm-9",
    "prospect-rvm-10",
    "prospect-rvm-11",
    "prospect-rvm-12",
  ],
});

const DAY_OFFSETS = Object.freeze({
  sms: [0, 0, 1, 3, 5],
  email: [0, 1, 3, 5, 7, 9, 14, 21, 28, 37],
  rvm: [0, 0, 1, 1, 2, 3, 6, 7, 8, 9, 10, 13],
});

const DAILY_START_INDEX = Object.freeze({
  sms: 3,
  email: 2,
  rvm: 1,
});

function normalizeDomain(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizeChannel(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "text") return "sms";
  if (normalized === "sms" || normalized === "email" || normalized === "rvm" || normalized === "cx") {
    return normalized;
  }
  return "";
}

function parseDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function numberOrZero(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? Math.max(parsed, 0) : 0;
}

function formatDateInZone(date, timeZone = TIMEZONE) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function getTimezoneParts(date, timeZone = TIMEZONE) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(date);
  const weekdayLabel = parts.find((part) => part.type === "weekday")?.value || "";
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    weekday: weekdayMap[weekdayLabel] ?? -1,
    hour: Number(parts.find((part) => part.type === "hour")?.value || 0),
    minute: Number(parts.find((part) => part.type === "minute")?.value || 0),
  };
}

function isWeekdayBatchTime(now = new Date()) {
  const parts = getTimezoneParts(now);
  if (!ACTIVE_WEEKDAYS.includes(parts.weekday)) return false;
  const minutes = parts.hour * 60 + parts.minute;
  const start = DAILY_HOUR * 60;
  return minutes >= start && minutes < start + DAILY_WINDOW_MINUTES;
}

function getReceiptDate(lead = {}, now = new Date()) {
  return (
    parseDate(lead.payloadSnapshot?.createdAt) ||
    parseDate(lead.attributionContext?.receivedAt) ||
    parseDate(lead.createdAt) ||
    now
  );
}

function daysSinceReceipt(lead = {}, now = new Date()) {
  const receivedAt = getReceiptDate(lead, now);
  return Math.floor((now.getTime() - receivedAt.getTime()) / (24 * 60 * 60 * 1000));
}

function msSince(date, now = new Date()) {
  const parsed = parseDate(date);
  if (!parsed) return Infinity;
  return now.getTime() - parsed.getTime();
}

function getCounterCadenceTemplateKey(channel, templateIndex) {
  const normalizedChannel = normalizeChannel(channel);
  const chain = CHAINS[normalizedChannel] || [];
  const index = Number(templateIndex);
  if (!Number.isInteger(index) || index < 1) return null;
  return chain[index - 1] || null;
}

function getCounterCadenceCounters(lead = {}) {
  return {
    sms: numberOrZero(
      lead.cadenceCounters?.sms ??
      lead.cadenceState?.completedByChannel?.sms ??
      lead.payloadSnapshot?.legacyCounters?.textsSent,
    ),
    email: numberOrZero(
      lead.cadenceCounters?.email ??
      lead.cadenceState?.completedByChannel?.email ??
      lead.payloadSnapshot?.legacyCounters?.emailsSent,
    ),
    rvm: numberOrZero(
      lead.cadenceCounters?.rvm ??
      lead.cadenceState?.completedByChannel?.rvm ??
      lead.payloadSnapshot?.legacyCounters?.rvmsSent,
    ),
    cx: numberOrZero(
      lead.cadenceCounters?.cx ??
      lead.cadenceState?.completedByChannel?.cx ??
      lead.payloadSnapshot?.legacyCounters?.callsMade,
    ),
  };
}

function getCounterCadenceLastTouched(lead = {}) {
  return {
    sms:
      parseDate(lead.lastTouched?.sms) ||
      parseDate(lead.cadenceState?.lastCompletedAtByChannel?.sms) ||
      parseDate(lead.payloadSnapshot?.legacyLastTouched?.lastTextedAt),
    email:
      parseDate(lead.lastTouched?.email) ||
      parseDate(lead.cadenceState?.lastCompletedAtByChannel?.email) ||
      parseDate(lead.payloadSnapshot?.legacyLastTouched?.lastEmailedAt),
    rvm:
      parseDate(lead.lastTouched?.rvm) ||
      parseDate(lead.cadenceState?.lastCompletedAtByChannel?.rvm) ||
      parseDate(lead.payloadSnapshot?.legacyLastTouched?.lastRvmedAt),
    cx:
      parseDate(lead.lastTouched?.cx) ||
      parseDate(lead.cadenceState?.lastCompletedAtByChannel?.cx) ||
      parseDate(lead.payloadSnapshot?.legacyLastTouched?.lastCalledAt),
  };
}

function isChannelBlocked(lead = {}, channel) {
  const block = lead.cadenceState?.channelDnc?.[channel];
  return Boolean(block?.blocked);
}

function hasChannelContactPoint(lead = {}, channel) {
  if (channel === "email") return Boolean(lead.email);
  if (channel === "sms") return Boolean(lead.primaryPhone || lead.normalizedPhone);
  if (channel === "rvm") return Boolean(lead.primaryPhone || lead.normalizedPhone);
  return false;
}

function validationAllowsChannel(lead = {}, channel) {
  const validation = lead.validationContext || {};
  if (channel === "email") return validation.emailCanSend !== false;
  if (channel === "sms") return validation.phoneCanText !== false;
  if (channel === "rvm") return validation.phoneCanCall !== false;
  return true;
}

function deferUntilForChannel(lead = {}, channel) {
  return parseDate(lead.counterCadence?.deferUntil?.[channel]);
}

function dailyAlreadyTouched(lead = {}, channel, dateKey) {
  return String(lead.counterCadence?.lastDailyBatchKey?.[channel] || "") === String(dateKey || "");
}

function baseDueItem(lead, channel, nextIndex, reason, now) {
  return {
    lead,
    domain: normalizeDomain(lead.domain),
    caseId: Number(lead.caseId),
    channel,
    templateIndex: nextIndex,
    templateKey: getCounterCadenceTemplateKey(channel, nextIndex),
    actionType: `counter-${channel}-${nextIndex}`,
    reason,
    dueAt: now,
    nextCounterValue: nextIndex,
  };
}

// CHANNELS SPLIT ACROSS PASSES.
//
// Mickey 2026-08-06: "all the texts and emails at 8 and all the rvms at noon
// kinda thing." So a caller must be able to ask for a subset of the chain
// without the others firing.
//
// `channels: null` is today's behaviour EXACTLY — every existing caller passes
// nothing and every existing caller keeps its full three-channel sweep. The
// filter is applied at the push, not at the candidate query, so the per-channel
// counters, per-channel locks and per-channel daily keys all keep their meaning.
const normalizeChannelFilter = (channels) => {
  if (channels == null) return null;
  const set = new Set(
    (Array.isArray(channels) ? channels : [channels])
      .map((c) => String(c || "").trim().toLowerCase())
      .filter(Boolean),
  );
  return set.size ? set : null;
};

function evaluateCounterCadenceDueItems(lead = {}, {
  now = new Date(),
  includeAgeRelative = true,
  includeDaily = true,
  forceDaily = false,
  channels = null,
} = {}) {
  const channelFilter = normalizeChannelFilter(channels);
  const channelAllowed = (channel) => !channelFilter || channelFilter.has(channel);
  const counters = getCounterCadenceCounters(lead);
  const lastTouched = getCounterCadenceLastTouched(lead);
  const receivedAt = getReceiptDate(lead, now);
  const ageDays = daysSinceReceipt(lead, now);
  const dateKey = formatDateInZone(now);
  const due = [];
  const dailyAllowed = forceDaily || (includeDaily && isWeekdayBatchTime(now));

  if (
    includeAgeRelative &&
    channelAllowed("sms") &&
    counters.sms === 1 &&
    hasChannelContactPoint(lead, "sms") &&
    validationAllowsChannel(lead, "sms") &&
    !isChannelBlocked(lead, "sms") &&
    (!deferUntilForChannel(lead, "sms") || deferUntilForChannel(lead, "sms") <= now) &&
    msSince(receivedAt, now) >= AGE_RELATIVE_TEXT_2_MS &&
    msSince(lastTouched.sms, now) >= AGE_RELATIVE_TEXT_2_MS
  ) {
    due.push(baseDueItem(lead, "sms", 2, "text-2-age-relative", now));
  }

  if (!dailyAllowed) return due.filter((item) => item.templateKey);

  for (const channel of ["sms", "email", "rvm"]) {
    if (!channelAllowed(channel)) continue;
    if (!hasChannelContactPoint(lead, channel)) continue;
    if (!validationAllowsChannel(lead, channel)) continue;
    if (isChannelBlocked(lead, channel)) continue;
    if (dailyAlreadyTouched(lead, channel, dateKey)) continue;
    const deferUntil = deferUntilForChannel(lead, channel);
    if (deferUntil && deferUntil > now) continue;

    const nextIndex = counters[channel] + 1;
    if (nextIndex < DAILY_START_INDEX[channel]) continue;
    const templateKey = getCounterCadenceTemplateKey(channel, nextIndex);
    if (!templateKey) continue;
    const requiredAgeDays = Number(DAY_OFFSETS[channel]?.[nextIndex - 1]);
    if (!Number.isFinite(requiredAgeDays) || ageDays < requiredAgeDays) continue;
    if (msSince(lastTouched[channel], now) < DAILY_MIN_GAP_MS) continue;

    due.push(baseDueItem(lead, channel, nextIndex, "daily-time-of-day", now));
  }

  return due.filter((item) => item.templateKey);
}

function buildCandidateQuery(domain) {
  return {
    domain: normalizeDomain(domain),
    active: true,
    $or: [
      { cadenceMode: "legacy-time-count" },
      { "payloadSnapshot.migratedMode": "legacy-time-count" },
    ],
  };
}

async function listCounterCadenceCandidates({ domain, scanLimit = DEFAULT_SCAN_LIMIT } = {}) {
  return LeadCadence.find(buildCandidateQuery(domain))
    .sort({ "counterCadence.lastDispatchAt": 1, createdAt: 1, caseId: 1 })
    .limit(Math.min(Math.max(Number(scanLimit) || DEFAULT_SCAN_LIMIT, 1), 10000))
    .lean();
}

async function claimCounterCadenceItem(item, {
  now = new Date(),
  claimTtlMs = CLAIM_TTL_MS,
  runKey = null,
} = {}) {
  const channel = normalizeChannel(item.channel);
  const claimUntilPath = `counterCadence.locks.${channel}.claimUntil`;
  const token = runKey || `counter:${item.domain}:${item.caseId}:${channel}:${Date.now()}`;
  return LeadCadence.findOneAndUpdate(
    {
      _id: item.lead._id,
      active: true,
      $or: [
        { [claimUntilPath]: { $exists: false } },
        { [claimUntilPath]: null },
        { [claimUntilPath]: { $lte: now } },
      ],
    },
    {
      $set: {
        [`counterCadence.locks.${channel}`]: {
          token,
          reason: item.reason,
          templateIndex: item.templateIndex,
          claimedAt: now,
          claimUntil: new Date(now.getTime() + claimTtlMs),
        },
        "counterCadence.lastSweepAt": now,
      },
    },
    { new: true },
  ).lean();
}

function buildProviderDeliveryRecord(item, result, now = new Date()) {
  if (item.channel !== "rvm" || !result?.response?.ActivityToken) return null;
  return {
    provider: "drop",
    actionKey: item.actionType,
    templateIndex: item.templateIndex,
    activityToken: String(result.response.ActivityToken),
    statusUrl: result.response.VmDropStatusUrl || null,
    postedAt: now,
    lastPolledAt: null,
    pollAttempts: 0,
    disposition: null,
  };
}

async function recordCounterCadenceTouch({
  domain,
  caseId,
  channel,
  templateIndex,
  reason = "counter-cadence",
  result = null,
  now = new Date(),
  dailyBatchKey = null,
} = {}) {
  const normalizedChannel = normalizeChannel(channel);
  const nextCounterValue = Number(templateIndex);
  if (!normalizedChannel || !Number.isFinite(nextCounterValue)) return null;
  const set = {
    cadenceMode: "legacy-time-count",
    currentStage: `${normalizedChannel}-counter-sent`,
    [`cadenceCounters.${normalizedChannel}`]: nextCounterValue,
    [`lastTouched.${normalizedChannel}`]: now,
    [`cadenceState.completedByChannel.${normalizedChannel}`]: nextCounterValue,
    [`cadenceState.lastCompletedAtByChannel.${normalizedChannel}`]: now,
    "cadenceState.lastEvaluatedAt": now,
    "counterCadence.lastDispatchAt": now,
    [`counterCadence.lastResult.${normalizedChannel}`]: {
      ok: true,
      reason,
      templateIndex: nextCounterValue,
      at: now,
      provider: result?.provider || null,
    },
  };
  if (dailyBatchKey) {
    set[`counterCadence.lastDailyBatchKey.${normalizedChannel}`] = dailyBatchKey;
  }
  const update = {
    $set: set,
    $unset: {
      [`counterCadence.locks.${normalizedChannel}`]: "",
      [`counterCadence.deferUntil.${normalizedChannel}`]: "",
    },
  };
  const deliveryRecord = buildProviderDeliveryRecord(
    {
      channel: normalizedChannel,
      templateIndex: nextCounterValue,
      actionType: `counter-${normalizedChannel}-${nextCounterValue}`,
    },
    result,
    now,
  );
  if (deliveryRecord) {
    update.$push = { "counterCadence.rvmDeliveries": deliveryRecord };
  }

  return LeadCadence.findOneAndUpdate(
    { domain: normalizeDomain(domain), caseId: Number(caseId) },
    update,
    { new: true },
  ).lean();
}

async function recordCounterCadenceFailure(item, result = {}, now = new Date()) {
  const channel = normalizeChannel(item.channel);
  const reason = result?.reason || result?.result?.reason || result?.error || "dispatch-failed";
  let deferUntil =
    parseDate(result?.deferUntil) ||
    parseDate(result?.rateLimit?.nextAllowedAt) ||
    parseDate(result?.result?.deferUntil) ||
    parseDate(result?.result?.rateLimit?.nextAllowedAt);
  if (!deferUntil && reason === "missing-tracking-number") {
    deferUntil = new Date(now.getTime() + 60 * 60 * 1000);
  }
  const set = {
    currentStage: `${channel}-counter-failed`,
    "counterCadence.lastFailureAt": now,
    [`counterCadence.lastResult.${channel}`]: {
      ok: false,
      reason,
      templateIndex: item.templateIndex,
      at: now,
      skipped: Boolean(result?.skipped || result?.result?.skipped),
    },
  };
  if (deferUntil) set[`counterCadence.deferUntil.${channel}`] = deferUntil;
  return LeadCadence.findOneAndUpdate(
    { _id: item.lead._id },
    {
      $set: set,
      $inc: { [`cadenceState.failedByChannel.${channel}`]: 1 },
      $unset: { [`counterCadence.locks.${channel}`]: "" },
    },
    { new: true },
  ).lean();
}

async function dispatchCounterCadenceItem(item, {
  now = new Date(),
  queueDepth = 1,
  dryRun = false,
} = {}) {
  const dailyBatchKey = item.reason === "daily-time-of-day" ? formatDateInZone(now) : null;
  if (dryRun) {
    return { ok: true, dryRun: true, item: summarizeDueItem(item) };
  }
  const claimed = await claimCounterCadenceItem(item, { now });
  if (!claimed) {
    return {
      ok: false,
      skipped: true,
      reason: "claim-conflict",
      item: summarizeDueItem(item),
    };
  }

  const { dispatchForLead } = require("./outboundDispatchService");
  const dispatchResult = await dispatchForLead(
    {
      ...item.lead,
      cadenceMode: "legacy-time-count",
    },
    {
      channel: item.channel,
      actionType: item.actionType,
      templateKey: item.templateKey,
      updateCadence: false,
      queueDepth,
    },
  );

  if (dispatchResult.ok) {
    await recordCounterCadenceTouch({
      domain: item.domain,
      caseId: item.caseId,
      channel: item.channel,
      templateIndex: item.templateIndex,
      reason: item.reason,
      result: dispatchResult.result || dispatchResult,
      now,
      dailyBatchKey,
    });
    return {
      ok: true,
      item: summarizeDueItem(item),
      result: dispatchResult.result || dispatchResult,
    };
  }

  await recordCounterCadenceFailure(item, dispatchResult.result || dispatchResult, now);
  return {
    ok: false,
    item: summarizeDueItem(item),
    result: dispatchResult.result || dispatchResult,
  };
}

function summarizeDueItem(item = {}) {
  return {
    domain: item.domain,
    caseId: item.caseId,
    channel: item.channel,
    templateIndex: item.templateIndex,
    templateKey: item.templateKey,
    reason: item.reason,
  };
}

async function selectCounterCadenceDueItems({
  domains = null,
  domain = null,
  now = new Date(),
  includeAgeRelative = true,
  includeDaily = true,
  forceDaily = false,
  channels = null,
  scanLimit = DEFAULT_SCAN_LIMIT,
  limit = 100,
} = {}) {
  const selectedDomains = Array.isArray(domains) && domains.length > 0
    ? domains.map(normalizeDomain).filter(Boolean)
    : domain
      ? [normalizeDomain(domain)]
      : getCompanyKeys().map(normalizeDomain).filter(Boolean);
  const due = [];
  for (const selectedDomain of selectedDomains) {
    const candidates = await listCounterCadenceCandidates({ domain: selectedDomain, scanLimit });
    for (const lead of candidates) {
      const items = evaluateCounterCadenceDueItems(lead, {
        now,
        includeAgeRelative,
        includeDaily,
        forceDaily,
        channels,
      });
      for (const item of items) {
        due.push(item);
        if (due.length >= limit) return due;
      }
    }
  }
  return due;
}

async function runCounterCadenceSweep({
  domains = null,
  domain = null,
  now = new Date(),
  maxDispatches = 25,
  scanLimit = DEFAULT_SCAN_LIMIT,
  dryRun = false,
  forceDaily = false,
  // THESE TWO USED TO BE HARDCODED `true` INSIDE THIS FUNCTION.
  //
  // The selector has accepted them for a long time, but the sweep overrode
  // whatever a caller asked for. So `runCounterCadenceSweep({includeDaily:
  // false})` compiled, read correctly, changed nothing, and would have passed a
  // smoke test — the worst shape a flag can have. Defaulting them true here
  // keeps every existing caller byte-identical while making the option real.
  includeAgeRelative = true,
  includeDaily = true,
  channels = null,
  logger = null,
  sourceService = "outbound-gateway",
} = {}) {
  const dueItems = await selectCounterCadenceDueItems({
    domains,
    domain,
    now,
    includeAgeRelative,
    includeDaily,
    forceDaily,
    channels,
    scanLimit,
    limit: Math.max(Number(maxDispatches) || 25, 1),
  });
  const results = [];
  for (let index = 0; index < dueItems.length; index += 1) {
    const item = dueItems[index];
    try {
      const result = await dispatchCounterCadenceItem(item, {
        now,
        dryRun,
        queueDepth: Math.max(dueItems.length - index, 1),
      });
      results.push(result);
      await recordWorkflowStage({
        domain: item.domain,
        family: "outbound",
        subtype: "counter-cadence",
        stage: result.ok ? (dryRun ? "previewed" : "completed") : "failed",
        aggregateType: "lead-cadence",
        aggregateId: String(item.caseId),
        caseId: item.caseId,
        sourceService,
        summary: `${item.channel} counter cadence ${result.ok ? "sent" : "failed"} (${item.templateKey})`,
        payload: {
          item: summarizeDueItem(item),
          dryRun: Boolean(dryRun),
          result: result.result || result,
        },
      }).catch(() => null);
    } catch (error) {
      logger?.warn?.("counter_cadence.item_failed", {
        domain: item.domain,
        caseId: item.caseId,
        channel: item.channel,
        error: error.message,
      });
      results.push({ ok: false, item: summarizeDueItem(item), error: error.message });
    }
  }
  return {
    ok: true,
    checkedAt: now,
    dailyWindow: isWeekdayBatchTime(now),
    // What this sweep was ASKED for, so a pass that selected nothing can be told
    // apart from a pass that was never allowed to look. `dailyWindow` above is
    // the raw clock and says nothing about forceDaily or a channel filter.
    asked: {
      channels: normalizeChannelFilter(channels) ? [...normalizeChannelFilter(channels)] : null,
      includeAgeRelative: Boolean(includeAgeRelative),
      includeDaily: Boolean(includeDaily),
      forceDaily: Boolean(forceDaily),
    },
    selected: dueItems.length,
    sent: results.filter((entry) => entry.ok && !entry.dryRun).length,
    failed: results.filter((entry) => !entry.ok && !entry.skipped).length,
    skipped: results.filter((entry) => entry.skipped).length,
    dryRun: Boolean(dryRun),
    results,
  };
}

async function pollCounterCadenceRvmDispositions({
  now = new Date(),
  maxAgeMs = 24 * 60 * 60 * 1000,
  minIntervalMs = 5 * 60 * 1000,
  maxAttempts = 24,
  limit = 25,
} = {}) {
  const ageCutoff = new Date(now.getTime() - maxAgeMs);
  const intervalCutoff = new Date(now.getTime() - minIntervalMs);
  const docs = await LeadCadence.find({
    "counterCadence.rvmDeliveries": {
      $elemMatch: {
        provider: "drop",
        activityToken: { $exists: true, $ne: null },
        postedAt: { $gte: ageCutoff },
        pollAttempts: { $lt: maxAttempts },
        $or: [
          { disposition: null },
          { "disposition.terminal": false },
        ],
        $and: [
          {
            $or: [
              { lastPolledAt: null },
              { lastPolledAt: { $lt: intervalCutoff } },
            ],
          },
        ],
      },
    },
  })
    .limit(Math.min(Math.max(Number(limit) || 25, 1), 200))
    .lean();

  let polled = 0;
  let terminal = 0;
  let markedDnc = 0;
  const results = [];
  for (const doc of docs) {
    const deliveries = Array.isArray(doc.counterCadence?.rvmDeliveries)
      ? doc.counterCadence.rvmDeliveries
      : [];
    const delivery = deliveries.find((entry) => (
      entry?.provider === "drop" &&
      entry?.activityToken &&
      !entry?.disposition?.terminal &&
      (!entry?.lastPolledAt || new Date(entry.lastPolledAt) < intervalCutoff) &&
      Number(entry?.pollAttempts || 0) < maxAttempts
    ));
    if (!delivery) continue;
    polled += 1;

    let dropResponse = null;
    let classification = null;
    try {
      dropResponse = await createDropClient(doc.domain).getDropStatus(delivery.activityToken);
      classification = classifyDropDisposition(dropResponse);
    } catch (error) {
      classification = {
        terminal: false,
        statusCode: null,
        statusMessage: null,
        pollError: error.message,
      };
    }
    if (classification.terminal) terminal += 1;
    if (classification.terminal && classification.permanent) {
      await leadCadenceRepository.markChannelDnc(
        doc.domain,
        doc.caseId,
        "rvm",
        classification.reason || "drop-permanent-reject",
      ).catch(() => null);
      markedDnc += 1;
    }

    const nextDeliveries = deliveries.map((entry) => {
      if (entry.activityToken !== delivery.activityToken) return entry;
      return {
        ...entry,
        lastPolledAt: now,
        pollAttempts: Number(entry.pollAttempts || 0) + 1,
        disposition: {
          ...classification,
          checkedAt: now,
          raw: dropResponse || null,
        },
      };
    });
    await LeadCadence.updateOne(
      { _id: doc._id },
      { $set: { "counterCadence.rvmDeliveries": nextDeliveries } },
    );
    results.push({
      domain: doc.domain,
      caseId: doc.caseId,
      activityToken: delivery.activityToken,
      classification,
    });
  }
  return { polled, terminal, markedDnc, results };
}

/**
 * Run the sweep REPEATEDLY until the day's backlog is drained.
 *
 * One sweep selects at most `maxDispatches` items — the selector returns
 * mid-loop the moment it hits that limit. A pass that calls the sweep once and
 * completes its durable day therefore sends one batch and silently postpones
 * the rest of the backlog to tomorrow: 900 due sms/email items meant 200 sent
 * and 700 deferred with nothing saying so.
 *
 * The loop is safe because every successful dispatch stamps the lead's
 * per-channel lastDailyBatchKey, so the next round selects DIFFERENT leads.
 * Two independent stops guard the pathological cases:
 *  - a round that sends nothing ends the loop (persistent failures must not
 *    spin — the failed items are still due, and retrying them in a tight loop
 *    against a failing provider is the RC-429 shape all over again);
 *  - maxRounds bounds the wall clock inside the pass's lease.
 */
async function drainCounterCadenceSweep({ maxRounds = 20, ...options } = {}) {
  const totals = {
    ok: true, rounds: 0, selected: 0, sent: 0, failed: 0, skipped: 0,
    drained: false, roundResults: [],
  };
  const perRound = Math.max(Number(options.maxDispatches) || 25, 1);
  for (let round = 0; round < Math.max(1, maxRounds); round += 1) {
    const r = await runCounterCadenceSweep(options);
    totals.rounds += 1;
    totals.selected += Number(r?.selected) || 0;
    totals.sent += Number(r?.sent) || 0;
    totals.failed += Number(r?.failed) || 0;
    totals.skipped += Number(r?.skipped) || 0;
    totals.roundResults.push({
      selected: r?.selected ?? 0, sent: r?.sent ?? 0, failed: r?.failed ?? 0,
    });
    // Fewer selected than the cap means the selector ran out of due items:
    // the backlog is drained.
    if ((Number(r?.selected) || 0) < perRound) { totals.drained = true; break; }
    // A full selection that sent nothing is a stuck provider, not a backlog.
    if ((Number(r?.sent) || 0) === 0 && !options.dryRun) break;
  }
  return totals;
}

module.exports = {
  CHAINS,
  DAY_OFFSETS,
  DAILY_START_INDEX,
  evaluateCounterCadenceDueItems,
  formatDateInZone,
  getCounterCadenceCounters,
  getCounterCadenceLastTouched,
  getCounterCadenceTemplateKey,
  isWeekdayBatchTime,
  pollCounterCadenceRvmDispositions,
  recordCounterCadenceTouch,
  drainCounterCadenceSweep,
  runCounterCadenceSweep,
  selectCounterCadenceDueItems,
};
