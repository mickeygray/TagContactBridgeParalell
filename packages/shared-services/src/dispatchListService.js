"use strict";

const {
  dispatchListRepository,
  leadCadenceRepository,
} = require("../../shared-repositories/src");
const { WorkflowRecord } = require("../../shared-models/src");
const { OUTBOUND_EVENT_TYPES, createOutboundEvent } = require("./outboundDispatchService");
const { recordWorkflowStage } = require("./workflowStateService");
const { buildTimezoneDateWindow } = require("./timezoneDateWindowService");

const DEFAULT_DISPATCH_TIMEZONE = "America/Los_Angeles";

function normalizeDomain(value) {
  return String(value || "").trim().toUpperCase();
}

function formatDateKeyInZone(date = new Date(), timeZone = DEFAULT_DISPATCH_TIMEZONE) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function boolFromQuery(value, fallback = false) {
  if (value == null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

async function listRecentlyCompletedOutboundCaseIds(domain, channel, input = {}) {
  const normalizedDomain = normalizeDomain(domain);
  const normalizedChannel = String(channel || "").trim().toLowerCase();
  if (!normalizedDomain || !normalizedChannel) return new Set();
  if (boolFromQuery(input.includeRecentlyContacted, false)) return new Set();

  const timezone = input.timezone || DEFAULT_DISPATCH_TIMEZONE;
  const dateKey = input.excludeCompletedDateKey || formatDateKeyInZone(new Date(), timezone);
  const { start, end } = buildTimezoneDateWindow(dateKey, timezone);
  const rows = await WorkflowRecord.find({
    domain: normalizedDomain,
    family: "outbound",
    subtype: `${normalizedChannel}-lead`,
    stage: { $in: ["completed", "skipped"] },
    caseId: { $ne: null },
    createdAt: { $gte: start, $lte: end },
  })
    .select("caseId")
    .lean();

  return new Set(rows.map((row) => Number(row.caseId)).filter(Number.isFinite));
}

function mapChannelToOutboundEventType(channel, mode = "manual") {
  const manual = mode === "manual" || mode === "one-off";
  const mappings = {
    sms: manual ? OUTBOUND_EVENT_TYPES.TEXT_MANUAL_REQUESTED : OUTBOUND_EVENT_TYPES.TEXT_ROUND_REQUESTED,
    email: manual ? OUTBOUND_EVENT_TYPES.EMAIL_MANUAL_REQUESTED : OUTBOUND_EVENT_TYPES.EMAIL_ROUND_REQUESTED,
    rvm: manual ? OUTBOUND_EVENT_TYPES.RVM_MANUAL_REQUESTED : OUTBOUND_EVENT_TYPES.RVM_ROUND_REQUESTED,
    callfire: manual ? OUTBOUND_EVENT_TYPES.CALLFIRE_MANUAL_REQUESTED : null,
    phoneburner: manual ? OUTBOUND_EVENT_TYPES.PHONEBURNER_MANUAL_REQUESTED : OUTBOUND_EVENT_TYPES.PHONEBURNER_ROUND_REQUESTED,
  };

  return mappings[channel] || null;
}

function buildDispatchItem(lead, index) {
  return {
    caseId: Number(lead.caseId),
    leadCadenceId: lead._id ? String(lead._id) : null,
    masterProspectId: lead.masterProspectId ? String(lead.masterProspectId) : null,
    name: lead.name || [lead.firstName, lead.lastName].filter(Boolean).join(" ") || null,
    email: lead.email || null,
    primaryPhone: lead.primaryPhone || null,
    normalizedPhone: lead.normalizedPhone || null,
    priority: index + 1,
    metadata: {
      intakeSource: lead.intakeSource || null,
      intakeRoute: lead.intakeRoute || null,
      currentStage: lead.currentStage || null,
      sourceName: lead.sourceName || null,
    },
  };
}

async function resolveDispatchTargets(input = {}) {
  const domain = normalizeDomain(input.domain);
  const channel = String(input.channel || "").trim();
  const audienceSource = String(input.audienceSource || "").trim().toLowerCase();
  const maxCount = Math.max(Number(input.maxCount) || 0, 0) || null;

  if (Array.isArray(input.caseIds) && input.caseIds.length > 0) {
    const targets = await leadCadenceRepository.listLeadCadenceByCaseIds(domain, input.caseIds);
    const completedCaseIds = channel === "callfire"
      ? await listRecentlyCompletedOutboundCaseIds(domain, channel, input)
      : new Set();
    const unsentTargets = targets.filter((target) => !completedCaseIds.has(Number(target.caseId)));
    return maxCount ? unsentTargets.slice(0, maxCount) : unsentTargets;
  }

  return leadCadenceRepository.listDueLeadCadenceByChannel(domain, {
    channel,
    actionType: input.actionType || null,
    limit: maxCount || input.limit || 100,
    now: input.now || new Date(),
  });
}

async function buildDispatchList(input = {}) {
  const domain = normalizeDomain(input.domain);
  const channel = String(input.channel || "").trim();
  const mode = input.mode || "manual";
  const family = input.family || "dispatch";
  const targets = await resolveDispatchTargets(input);
  const items = targets.map(buildDispatchItem);
  if (domain === "WYNN" && channel === "callfire") {
    console.info(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "info",
      scope: "control-plane",
      message: "dispatch.callfire.build_counts",
      meta: {
        audienceSource: String(input.audienceSource || "").trim().toLowerCase() || null,
        requestedCaseIds: Array.isArray(input.caseIds) ? input.caseIds.length : 0,
        hydratedTargets: targets.length,
        persistedItems: items.length,
        mode,
      },
    }));
  }

  const list = await dispatchListRepository.createDispatchList({
    domain,
    family,
    subtype: input.subtype || `${channel}-${mode}`,
    channel,
    mode,
    sourceService: input.sourceService || "control-plane",
    consumerService: input.consumerService || null,
    title: input.title || `${domain} ${channel} dispatch`,
    description: input.description || null,
    actionType: input.actionType || null,
    templateKey: input.templateKey || null,
    priorityRule: input.priorityRule || null,
    ratePerMinute: input.ratePerMinute != null ? Number(input.ratePerMinute) : null,
    maxCount: input.maxCount != null ? Number(input.maxCount) : items.length,
    pulseSize: input.pulseSize != null ? Number(input.pulseSize) : null,
    pulseDelayMs: input.pulseDelayMs != null ? Number(input.pulseDelayMs) : null,
    selectors: input.selectors || {
      caseIds: input.caseIds || null,
      statusCategory: input.statusCategory || null,
      sourceKey: input.sourceKey || null,
    },
    instructions: input.instructions || {
      content: input.content || null,
      subject: input.subject || null,
      audioUrl: input.audioUrl || null,
      trackingNumber: input.trackingNumber || null,
    },
    items,
    stats: {
      selectedCount: items.length,
      attemptedCount: 0,
      successCount: 0,
      failedCount: 0,
    },
    expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
  });

  await recordWorkflowStage({
    domain,
    family,
    subtype: list.subtype,
    stage: "built",
    aggregateType: "dispatch-list",
    aggregateId: String(list._id),
    sourceService: input.sourceService || "control-plane",
    title: list.title,
    summary: `${items.length} item(s) selected`,
    payload: {
      channel,
      mode,
      selectedCount: items.length,
    },
  });

  return list;
}

async function queueDispatchList(input = {}) {
  const list = await buildDispatchList(input);
  const eventType = mapChannelToOutboundEventType(list.channel, list.mode);

  if (!eventType) {
    await recordWorkflowStage({
      domain: list.domain,
      family: list.family || "dispatch",
      subtype: list.subtype,
      stage: "failed",
      aggregateType: "dispatch-list",
      aggregateId: String(list._id),
      sourceService: input.sourceService || "control-plane",
      title: list.title,
      summary: `No consumer event type for ${list.channel}`,
      result: {
        reason: `unsupported-channel:${list.channel}`,
      },
    });
    return {
      list,
      event: null,
      queued: false,
      reason: `unsupported-channel:${list.channel}`,
    };
  }

  const eventResult = await createOutboundEvent({
    eventType,
    sourceService: input.sourceService || "control-plane",
    aggregateType: "dispatch-list",
    aggregateId: String(list._id),
    dedupeKey: input.dedupeKey || `dispatch-list:${list._id}`,
    payload: {
      domain: list.domain,
      dispatchListId: String(list._id),
      channel: list.channel,
      mode: list.mode,
      actionType: list.actionType || null,
      templateKey: list.templateKey || null,
      content: list.instructions?.content || null,
      subject: list.instructions?.subject || null,
      audioUrl: list.instructions?.audioUrl || null,
      trackingNumber: list.instructions?.trackingNumber || null,
      ratePerMinute: list.ratePerMinute || null,
      pulseSize: list.pulseSize || null,
      pulseDelayMs: list.pulseDelayMs || null,
    },
  });

  await dispatchListRepository.markDispatchListQueued(
    list._id,
    eventResult?.event?._id || null,
  );

  await recordWorkflowStage({
    domain: list.domain,
    family: list.family || "dispatch",
    subtype: list.subtype,
    stage: "requested",
    aggregateType: "dispatch-list",
    aggregateId: String(list._id),
    sourceService: input.sourceService || "control-plane",
    title: list.title,
    summary: `Queued for ${list.channel}`,
    payload: {
      channel: list.channel,
      mode: list.mode,
      dispatchListId: String(list._id),
      eventId: eventResult?.event?._id ? String(eventResult.event._id) : null,
    },
  });

  return {
    list,
    event: eventResult.event,
    queued: true,
    deduped: eventResult.deduped,
  };
}

async function getDispatchList(id) {
  return dispatchListRepository.findDispatchListById(id);
}

async function listDispatchLists(domain, filters = {}) {
  return dispatchListRepository.listDispatchLists(domain, filters);
}

module.exports = {
  buildDispatchList,
  getDispatchList,
  listDispatchLists,
  mapChannelToOutboundEventType,
  queueDispatchList,
  resolveDispatchTargets,
};
