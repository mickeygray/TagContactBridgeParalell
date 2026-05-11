"use strict";

const { getCompanyConfig, getCompanyKeys, getSharedConfig } = require("../../shared-config/src");
const {
  dispatchListRepository,
} = require("../../shared-repositories/src");
const {
  buildCampaignAudience,
} = require("./campaignAudienceService");
const { createLogicsFacade } = require("./logicsFacadeService");
const {
  queueDispatchList,
} = require("./dispatchListService");

const WEEKDAY_RULES = Object.freeze({
  1: { channel: "callfire", title: "Monday CallFire Blast" },
  2: { channel: "sms", title: "Tuesday SMS Blast" },
  3: { channel: "callfire", title: "Wednesday CallFire Blast" },
  4: { channel: "email", title: "Thursday Email Blast" },
  5: { channel: "callfire", title: "Friday CallFire Blast" },
});

const WEEKDAY_LABELS = Object.freeze([
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
]);

const SUPPORTED_BLAST_CHANNELS = new Set(["callfire", "sms", "email"]);

function normalizeDomain(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizeChannel(value) {
  return String(value || "").trim().toLowerCase();
}

function pad2(value) {
  return String(Number(value) || 0).padStart(2, "0");
}

function formatDateKey(date = new Date(), timeZone = "America/Los_Angeles") {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function getZonedParts(date = new Date(), timeZone = "America/Los_Angeles") {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
    hour12: false,
  });

  const parts = formatter.formatToParts(date);
  const mapped = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );

  const weekdayMap = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };

  return {
    year: Number(mapped.year),
    month: Number(mapped.month),
    day: Number(mapped.day),
    hour: Number(mapped.hour),
    minute: Number(mapped.minute),
    second: Number(mapped.second),
    weekday: weekdayMap[mapped.weekday] ?? -1,
  };
}

function normalizeDomains(domains) {
  const values = Array.isArray(domains) ? domains : [domains];
  const normalized = values
    .map(normalizeDomain)
    .filter(Boolean);
  return normalized.length > 0 ? [...new Set(normalized)] : getCompanyKeys();
}

function coerceNow(value) {
  const candidate = value instanceof Date ? value : new Date(value || Date.now());
  if (Number.isNaN(candidate.getTime())) {
    return new Date();
  }
  return candidate;
}

function normalizeScheduledBlastConfig(config = {}) {
  const raw = config.scheduledBlasts || config || {};

  return {
    enabled: Boolean(raw.enabled),
    timezone: raw.timezone || "America/Los_Angeles",
    hour: Math.max(0, Math.min(23, Number(raw.hour ?? 12))),
    minute: Math.max(0, Math.min(59, Number(raw.minute ?? 0))),
    domains: normalizeDomains(raw.domains),
    maxAudience: Math.max(1, Math.min(Number(raw.maxAudience) || 20000, 50000)),
    channels: {
      callfire: {
        templateKey: raw.channels?.callfire?.templateKey || null,
        content: raw.channels?.callfire?.content || null,
        ratePerMinute: raw.channels?.callfire?.ratePerMinute != null
          ? Number(raw.channels.callfire.ratePerMinute)
          : null,
        pulseSize: raw.channels?.callfire?.pulseSize != null
          ? Number(raw.channels.callfire.pulseSize)
          : null,
        pulseDelayMs: raw.channels?.callfire?.pulseDelayMs != null
          ? Number(raw.channels.callfire.pulseDelayMs)
          : null,
      },
      sms: {
        content: raw.channels?.sms?.content || null,
        trackingNumber: raw.channels?.sms?.trackingNumber || null,
        pulseSize: raw.channels?.sms?.pulseSize != null
          ? Number(raw.channels.sms.pulseSize)
          : null,
        pulseDelayMs: raw.channels?.sms?.pulseDelayMs != null
          ? Number(raw.channels.sms.pulseDelayMs)
          : null,
      },
      email: {
        subject: raw.channels?.email?.subject || null,
        content: raw.channels?.email?.content || null,
        templateKey: raw.channels?.email?.templateKey || null,
        pulseSize: raw.channels?.email?.pulseSize != null
          ? Number(raw.channels.email.pulseSize)
          : null,
        pulseDelayMs: raw.channels?.email?.pulseDelayMs != null
          ? Number(raw.channels.email.pulseDelayMs)
          : null,
      },
    },
  };
}

function resolveScheduledBlastRule(now = new Date(), timeZone = "America/Los_Angeles", forcedChannel = null) {
  const channel = normalizeChannel(forcedChannel);
  if (channel && !SUPPORTED_BLAST_CHANNELS.has(channel)) {
    return {
      invalid: true,
      channel,
    };
  }

  const parts = getZonedParts(coerceNow(now), timeZone);
  const rule = channel
    ? {
        channel,
        title: `${channel.toUpperCase()} Blast`,
      }
    : WEEKDAY_RULES[parts.weekday];

  if (!rule) return null;

  return {
    ...rule,
    dateKey: `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`,
    weekday: parts.weekday,
    weekdayLabel: WEEKDAY_LABELS[parts.weekday] || "Unknown",
    localHour: parts.hour,
    localMinute: parts.minute,
    localSecond: parts.second,
  };
}

function isPastScheduledWindow(rule, config) {
  if (!rule) return false;
  if (rule.localHour > config.hour) return true;
  if (rule.localHour < config.hour) return false;
  return rule.localMinute >= config.minute;
}

function buildScheduledBlastKey({ domain, channel, dateKey }) {
  return `scheduled-blast:${normalizeDomain(domain)}:${normalizeChannel(channel)}:${String(dateKey || "").trim()}`;
}

function buildDispatchTitle(domain, rule) {
  return `${normalizeDomain(domain)} ${rule.weekdayLabel} ${String(rule.channel || "").toUpperCase()} Noon Blast`;
}

function buildDispatchDescription(rule) {
  return `${rule.weekdayLabel} noon blast for active lead cadence recipients`;
}

function resolveScheduledBlastInstructions(domain, channel, config = {}) {
  const normalizedChannel = normalizeChannel(channel);
  const company = getCompanyConfig(domain);
  const channelConfig = config.channels?.[normalizedChannel] || {};

  return {
    templateKey: channelConfig.templateKey || null,
    subject: channelConfig.subject || null,
    content: channelConfig.content || null,
    trackingNumber:
      channelConfig.trackingNumber ||
      company.integrations?.callrail?.trackingNumber ||
      null,
    ratePerMinute: channelConfig.ratePerMinute != null ? Number(channelConfig.ratePerMinute) : null,
    pulseSize: channelConfig.pulseSize != null ? Number(channelConfig.pulseSize) : null,
    pulseDelayMs: channelConfig.pulseDelayMs != null ? Number(channelConfig.pulseDelayMs) : null,
  };
}

function validateScheduledBlastInstructions(channel, instructions = {}) {
  const normalizedChannel = normalizeChannel(channel);
  const blockingIssues = [];
  const warnings = [];

  if (normalizedChannel === "sms") {
    if (!String(instructions.content || "").trim()) {
      blockingIssues.push("sms-content-missing");
    }
    if (!String(instructions.trackingNumber || "").trim()) {
      blockingIssues.push("sms-tracking-number-missing");
    }
  }

  if (normalizedChannel === "email") {
    if (!String(instructions.subject || "").trim()) {
      blockingIssues.push("email-subject-missing");
    }
    if (!String(instructions.content || "").trim()) {
      blockingIssues.push("email-content-missing");
    }
  }

  if (normalizedChannel === "callfire" && !String(instructions.content || "").trim()) {
    warnings.push("callfire-will-use-template-or-env-audio");
  }

  return {
    ok: blockingIssues.length === 0,
    blockingIssues,
    warnings,
  };
}

function normalizeCaseIds(values = []) {
  return [
    ...new Set(
      (Array.isArray(values) ? values : [values])
        .map((value) => Number(value))
        .filter(Number.isFinite),
    ),
  ];
}

function buildAudienceSubset(audience = {}, allowedCaseIds = []) {
  const allowed = new Set(normalizeCaseIds(allowedCaseIds));
  const sourceCaseIds = normalizeCaseIds(audience.caseIds);
  const caseIds = sourceCaseIds.filter((caseId) => allowed.has(caseId));
  const sample = Array.isArray(audience.sample)
    ? audience.sample.filter((row) => allowed.has(Number(row?.caseId))).slice(0, 25)
    : [];
  const removedCount = Math.max(sourceCaseIds.length - caseIds.length, 0);

  return {
    ...audience,
    returned: caseIds.length,
    truncated: Boolean(audience.truncated || removedCount > 0),
    excludedCount: Number(audience.excludedCount || 0) + removedCount,
    caseIds,
    sample,
  };
}

async function collectLogicsStatusCaseIds(facade, statusIds = []) {
  const normalizedStatusIds = [
    ...new Set(
      (Array.isArray(statusIds) ? statusIds : [statusIds])
        .map((value) => Number(value))
        .filter(Number.isFinite),
    ),
  ];
  const caseIds = new Set();
  const failedStatusIds = [];

  for (const statusId of normalizedStatusIds) {
    try {
      const rows = await facade.getCasesByStatus(statusId);
      for (const caseId of normalizeCaseIds(rows)) {
        caseIds.add(caseId);
      }
    } catch {
      failedStatusIds.push(statusId);
    }
  }

  return {
    caseIds: [...caseIds],
    failedStatusIds,
  };
}

function buildBlastValidation(baseValidation = {}, scrub = null) {
  if (!scrub?.ok) {
    return {
      ...baseValidation,
      ok: false,
      blockingIssues: [
        ...(Array.isArray(baseValidation.blockingIssues) ? baseValidation.blockingIssues : []),
        scrub?.reason || "logics-scrub-failed",
      ],
    };
  }
  return baseValidation;
}

async function scrubScheduledBlastAudience(domain, audience = {}) {
  const rawAudience = audience && typeof audience === "object" ? audience : {};
  const candidateCaseIds = normalizeCaseIds(rawAudience.caseIds);
  if (candidateCaseIds.length === 0) {
    return {
      ok: true,
      reason: null,
      audience: buildAudienceSubset(rawAudience, []),
      diagnostics: {
        checkedCount: 0,
        eligibleCount: 0,
        removedCount: 0,
        blockedStatusCount: 0,
        statusMismatchCount: 0,
        allowedStatusIds: [],
        blockedStatusIds: [],
        failedStatusIds: [],
      },
    };
  }

  const sharedConfig = getSharedConfig();
  const allowedStatusIds = normalizeCaseIds(sharedConfig.logicsProspectStatusIds);
  const blockedStatusIds = normalizeCaseIds(sharedConfig.logicsDncStatusIds);
  if (allowedStatusIds.length === 0) {
    return {
      ok: false,
      reason: "logics-prospect-statuses-missing",
      audience: rawAudience,
      diagnostics: {
        checkedCount: candidateCaseIds.length,
        eligibleCount: 0,
        removedCount: candidateCaseIds.length,
        blockedStatusCount: 0,
        statusMismatchCount: candidateCaseIds.length,
        allowedStatusIds,
        blockedStatusIds,
        failedStatusIds: [],
      },
    };
  }

  const facade = createLogicsFacade(domain);
  const [allowedCases, blockedCases] = await Promise.all([
    collectLogicsStatusCaseIds(facade, allowedStatusIds),
    collectLogicsStatusCaseIds(facade, blockedStatusIds),
  ]);
  const failedStatusIds = [...new Set([
    ...allowedCases.failedStatusIds,
    ...blockedCases.failedStatusIds,
  ])];
  if (failedStatusIds.length > 0) {
    return {
      ok: false,
      reason: "logics-status-refresh-failed",
      audience: rawAudience,
      diagnostics: {
        checkedCount: candidateCaseIds.length,
        eligibleCount: 0,
        removedCount: candidateCaseIds.length,
        blockedStatusCount: 0,
        statusMismatchCount: candidateCaseIds.length,
        allowedStatusIds,
        blockedStatusIds,
        failedStatusIds,
      },
    };
  }

  const allowedSet = new Set(allowedCases.caseIds);
  const blockedSet = new Set(blockedCases.caseIds);
  const eligibleCaseIds = [];
  let blockedStatusCount = 0;
  let statusMismatchCount = 0;

  for (const caseId of candidateCaseIds) {
    if (blockedSet.has(caseId)) {
      blockedStatusCount += 1;
      continue;
    }
    if (!allowedSet.has(caseId)) {
      statusMismatchCount += 1;
      continue;
    }
    eligibleCaseIds.push(caseId);
  }

  return {
    ok: true,
    reason: null,
    audience: buildAudienceSubset(rawAudience, eligibleCaseIds),
    diagnostics: {
      checkedCount: candidateCaseIds.length,
      eligibleCount: eligibleCaseIds.length,
      removedCount: candidateCaseIds.length - eligibleCaseIds.length,
      blockedStatusCount,
      statusMismatchCount,
      allowedStatusIds,
      blockedStatusIds,
      failedStatusIds: [],
    },
  };
}

async function previewScheduledBlast(options = {}) {
  const config = normalizeScheduledBlastConfig(options.config);
  const now = coerceNow(options.now);
  const domain = normalizeDomain(options.domain);
  const rule = resolveScheduledBlastRule(now, config.timezone, options.forceChannel);

  if (!domain) {
    return {
      ok: false,
      skipped: true,
      reason: "missing-domain",
    };
  }

  if (!rule) {
    return {
      ok: true,
      skipped: true,
      reason: "no-scheduled-channel-for-day",
      domain,
      timeZone: config.timezone,
      now,
    };
  }

  if (rule.invalid) {
    return {
      ok: false,
      skipped: true,
      reason: "unsupported-channel",
      domain,
      channel: rule.channel,
    };
  }

  const instructions = resolveScheduledBlastInstructions(domain, rule.channel, config);
  const validation = validateScheduledBlastInstructions(rule.channel, instructions);
  const scheduledBlastKey = buildScheduledBlastKey({
    domain,
    channel: rule.channel,
    dateKey: rule.dateKey,
  });

  const existingDispatchList = await dispatchListRepository.findLatestDispatchListByScheduledBlastKey(
    domain,
    scheduledBlastKey,
  );

  const audience = await buildCampaignAudience(domain, {
    audienceSource: "lead-cadence",
    channel: rule.channel,
    maxSize: options.maxAudience || config.maxAudience,
  });
  const scrub = await scrubScheduledBlastAudience(domain, audience);
  const validationWithScrub = buildBlastValidation(validation, scrub);

  return {
    ok: true,
    domain,
    channel: rule.channel,
    dateKey: rule.dateKey,
    weekday: rule.weekday,
    weekdayLabel: rule.weekdayLabel,
    title: rule.title,
    timeZone: config.timezone,
    scheduledAt: {
      hour: config.hour,
      minute: config.minute,
    },
    now,
    scheduledBlastKey,
    rawAudience: audience,
    audience: scrub.audience,
    instructions,
    validation: validationWithScrub,
    logicsScrub: scrub,
    existingDispatchList: existingDispatchList
      ? {
          id: String(existingDispatchList._id),
          status: existingDispatchList.status,
          builtAt: existingDispatchList.builtAt,
          queuedAt: existingDispatchList.queuedAt,
          consumedAt: existingDispatchList.consumedAt,
          title: existingDispatchList.title || null,
        }
      : null,
    alreadyQueued: Boolean(existingDispatchList),
    readyToQueue:
      !existingDispatchList &&
      scrub.audience.returned > 0 &&
      validationWithScrub.ok,
  };
}

async function queueScheduledBlast(options = {}) {
  const preview = await previewScheduledBlast(options);

  if (!preview.ok || preview.skipped) {
    return preview;
  }

  if (preview.alreadyQueued) {
    return {
      ok: true,
      skipped: true,
      reason: "scheduled-blast-already-queued",
      preview,
    };
  }

  if (!preview.validation.ok) {
    return {
      ok: false,
      skipped: true,
      reason: "scheduled-blast-misconfigured",
      preview,
    };
  }

  if (!Array.isArray(preview.audience.caseIds) || preview.audience.caseIds.length === 0) {
    return {
      ok: true,
      skipped: true,
      reason: "scheduled-blast-empty-audience",
      preview,
    };
  }

  const listResult = await queueDispatchList({
    domain: preview.domain,
    channel: preview.channel,
    audienceSource: "lead-cadence",
    caseIds: preview.audience.caseIds,
    family: "dispatch",
    subtype: `scheduled-blast-${preview.channel}`,
    mode: "one-off",
    sourceService: options.sourceService || "outbound-gateway",
    consumerService: "outbound-gateway",
    title: buildDispatchTitle(preview.domain, preview),
    description: buildDispatchDescription(preview),
    templateKey: preview.instructions.templateKey || null,
    ratePerMinute: preview.instructions.ratePerMinute,
    pulseSize: preview.instructions.pulseSize,
    pulseDelayMs: preview.instructions.pulseDelayMs,
    selectors: {
      scheduledBlastKey: preview.scheduledBlastKey,
      scheduledBlastDate: preview.dateKey,
      scheduledBlastWeekday: preview.weekdayLabel,
      scheduledBlastChannel: preview.channel,
      audienceSource: "lead-cadence",
    },
    instructions: {
      content: preview.instructions.content || null,
      subject: preview.instructions.subject || null,
      trackingNumber: preview.instructions.trackingNumber || null,
      scheduledBlastKey: preview.scheduledBlastKey,
    },
    dedupeKey: `dispatch:${preview.scheduledBlastKey}`,
  });

  return {
    ok: true,
    queued: Boolean(listResult?.queued),
    deduped: Boolean(listResult?.deduped),
    preview,
    dispatchListId: listResult?.list?._id ? String(listResult.list._id) : null,
    eventId: listResult?.event?._id ? String(listResult.event._id) : null,
  };
}

async function runScheduledBlastSweep(options = {}) {
  const config = normalizeScheduledBlastConfig(options.config);
  const now = coerceNow(options.now);
  const rule = resolveScheduledBlastRule(now, config.timezone, options.forceChannel);

  if (!rule) {
    return {
      ok: true,
      skipped: true,
      reason: "no-scheduled-channel-for-day",
      timeZone: config.timezone,
      now,
    };
  }

  if (rule.invalid) {
    return {
      ok: false,
      skipped: true,
      reason: "unsupported-channel",
      channel: rule.channel,
      timeZone: config.timezone,
      now,
    };
  }

  if (!options.ignoreScheduleWindow && !isPastScheduledWindow(rule, config)) {
    return {
      ok: true,
      skipped: true,
      reason: "before-scheduled-window",
      rule,
      scheduledAt: {
        hour: config.hour,
        minute: config.minute,
      },
      now,
    };
  }

  const domains = normalizeDomains(options.domains && options.domains.length ? options.domains : config.domains);
  const results = [];

  for (const domain of domains) {
    const result = options.previewOnly
      ? await previewScheduledBlast({
          domain,
          config,
          now,
          forceChannel: rule.channel,
          maxAudience: options.maxAudience,
        })
      : await queueScheduledBlast({
          domain,
          config,
          now,
          forceChannel: rule.channel,
          maxAudience: options.maxAudience,
          sourceService: options.sourceService,
        });
    results.push(result);
  }

  return {
    ok: true,
    rule,
    scheduledAt: {
      hour: config.hour,
      minute: config.minute,
    },
    timeZone: config.timezone,
    previewOnly: Boolean(options.previewOnly),
    results,
    queuedCount: results.filter((entry) => entry?.queued).length,
    skippedCount: results.filter((entry) => entry?.skipped).length,
    failedCount: results.filter((entry) => entry && entry.ok === false && !entry.skipped).length,
  };
}

function buildScheduledBlastRuntimeSnapshot(config = {}, state = {}) {
  const normalizedConfig = normalizeScheduledBlastConfig(config);
  return {
    enabled: normalizedConfig.enabled,
    domains: normalizedConfig.domains,
    timezone: normalizedConfig.timezone,
    hour: normalizedConfig.hour,
    minute: normalizedConfig.minute,
    maxAudience: normalizedConfig.maxAudience,
    lastCheckedAt: state.lastCheckedAt || null,
    lastResult: state.lastResult || null,
    lastError: state.lastError || null,
  };
}

module.exports = {
  buildScheduledBlastRuntimeSnapshot,
  normalizeScheduledBlastConfig,
  previewScheduledBlast,
  queueScheduledBlast,
  resolveScheduledBlastRule,
  runScheduledBlastSweep,
};
