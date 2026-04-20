"use strict";

const {
  dispatchListRepository,
  leadCadenceRepository,
} = require("../../shared-repositories/src");
const { OUTBOUND_EVENT_TYPES, createOutboundEvent } = require("./outboundDispatchService");
const { recordWorkflowStage } = require("./workflowStateService");

function normalizeDomain(value) {
  return String(value || "").trim().toUpperCase();
}

function mapChannelToOutboundEventType(channel, mode = "manual") {
  const manual = mode === "manual" || mode === "one-off";
  const mappings = {
    sms: manual ? OUTBOUND_EVENT_TYPES.TEXT_MANUAL_REQUESTED : OUTBOUND_EVENT_TYPES.TEXT_ROUND_REQUESTED,
    email: manual ? OUTBOUND_EVENT_TYPES.EMAIL_MANUAL_REQUESTED : OUTBOUND_EVENT_TYPES.EMAIL_ROUND_REQUESTED,
    rvm: manual ? OUTBOUND_EVENT_TYPES.RVM_MANUAL_REQUESTED : OUTBOUND_EVENT_TYPES.RVM_ROUND_REQUESTED,
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

  if (Array.isArray(input.caseIds) && input.caseIds.length > 0) {
    return leadCadenceRepository.listLeadCadenceByCaseIds(domain, input.caseIds);
  }

  return leadCadenceRepository.listDueLeadCadenceByChannel(domain, {
    channel,
    actionType: input.actionType || null,
    limit: input.maxCount || input.limit || 100,
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
