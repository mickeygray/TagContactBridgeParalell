"use strict";

const { createEvent, processNextEvent } = require("../../event-core/src");
const {
  dispatchListRepository,
  leadCadenceRepository,
  reviewQueueRepository,
} = require("../../shared-repositories/src");
const { sendOutboundText } = require("./outboundTextService");
const { sendOutboundEmail } = require("./outboundEmailService");
const { sendOutboundRvm } = require("./outboundRvmService");
const { requestPhoneBurnerDispatch } = require("./outboundPhoneBurnerService");
const { recordWorkflowStage } = require("./workflowStateService");

const OUTBOUND_EVENT_TYPES = Object.freeze({
  TEXT_ROUND_REQUESTED: "outbound.text.round.requested",
  EMAIL_ROUND_REQUESTED: "outbound.email.round.requested",
  RVM_ROUND_REQUESTED: "outbound.rvm.round.requested",
  PHONEBURNER_ROUND_REQUESTED: "outbound.phoneburner.round.requested",
  TEXT_MANUAL_REQUESTED: "outbound.text.manual.requested",
  EMAIL_MANUAL_REQUESTED: "outbound.email.manual.requested",
  RVM_MANUAL_REQUESTED: "outbound.rvm.manual.requested",
  PHONEBURNER_MANUAL_REQUESTED: "outbound.phoneburner.manual.requested",
});

function normalizeDomain(value) {
  return String(value || "").trim().toUpperCase();
}

async function createOutboundEvent(input = {}) {
  return createEvent({
    eventType: input.eventType,
    sourceService: input.sourceService || "outbound-gateway",
    aggregateType: input.aggregateType || "outbound",
    aggregateId: String(input.aggregateId || input.payload?.domain || "outbound"),
    dedupeKey: input.dedupeKey || null,
    payload: input.payload || {},
  });
}

async function listTargetsForRound(payload, channel) {
  if (payload.dispatchListId) {
    const dispatchList = await dispatchListRepository.findDispatchListById(payload.dispatchListId);
    if (!dispatchList) return [];

    return leadCadenceRepository.listLeadCadenceByCaseIds(
      dispatchList.domain,
      dispatchList.items.map((item) => item.caseId),
    );
  }

  return leadCadenceRepository.listDueLeadCadenceByChannel(payload.domain, {
    channel,
    actionType: payload.actionType || null,
    limit: payload.limit || 100,
  });
}

async function listTargetsForManual(payload) {
  if (payload.dispatchListId) {
    const dispatchList = await dispatchListRepository.findDispatchListById(payload.dispatchListId);
    if (!dispatchList) return [];

    return leadCadenceRepository.listLeadCadenceByCaseIds(
      dispatchList.domain,
      dispatchList.items.map((item) => item.caseId),
    );
  }

  return leadCadenceRepository.listLeadCadenceByCaseIds(payload.domain, payload.caseIds || []);
}

function pickAction(lead, channel, actionType = null) {
  return (lead.schedule?.actions || []).find((entry) => {
    if (entry.channel !== channel) return false;
    if (entry.status !== "pending" && entry.status !== "requested") return false;
    if (actionType && entry.type !== actionType) return false;
    return true;
  });
}

async function recordOutboundFailure({ domain, caseId, title, summary, payload }) {
  return reviewQueueRepository.createReviewQueueItem({
    domain: normalizeDomain(domain),
    caseId: Number(caseId),
    sourceService: "outbound-gateway",
    workflow: "outbound-dispatch",
    category: "outbound-failure",
    severity: "warning",
    title,
    summary,
    happenedAt: new Date(),
    payload,
    tags: ["outbound", "failure"],
  });
}

async function dispatchForLead(lead, {
  channel,
  actionType = null,
  templateKey = null,
  content = null,
  subject = null,
  trackingNumber = null,
  audioUrl = null,
  updateCadence = true,
}) {
  const action = updateCadence ? pickAction(lead, channel, actionType) : null;
  const actionKey = action?.key || `${channel}-${actionType || "manual"}`;
  const domain = lead.domain;
  const caseId = lead.caseId;

  let result = null;
  if (channel === "sms") {
    result = await sendOutboundText({
      domain,
      toPhone: lead.primaryPhone || lead.normalizedPhone,
      trackingNumber: trackingNumber || lead.attributionContext?.trackingNumber || null,
      content: content || `Hi ${lead.firstName || lead.name || "there"}, we're following up on your recent inquiry.`,
    });
  } else if (channel === "email") {
    result = await sendOutboundEmail({
      domain,
      toEmail: lead.email,
      subject,
      text: content,
      name: lead.firstName || lead.name,
    });
  } else if (channel === "rvm") {
    result = await sendOutboundRvm({
      domain,
      toPhone: lead.primaryPhone || lead.normalizedPhone,
      caseId,
      name: lead.name,
      source: templateKey || "cadence",
      audioUrl,
    });
  } else if (channel === "phoneburner") {
    result = await requestPhoneBurnerDispatch({
      domain,
      caseId,
      phone: lead.primaryPhone || lead.normalizedPhone,
      name: lead.name,
    });
  } else {
    result = { ok: false, skipped: true, reason: `unsupported-channel:${channel}` };
  }

  if (result.ok) {
    if (action) {
      await leadCadenceRepository.markScheduledActionStatus(domain, caseId, actionKey, "completed", {
        currentStage: `${channel}-sent`,
      });
    }
    return { caseId, ok: true, result };
  }

  if (action) {
    await leadCadenceRepository.markScheduledActionStatus(domain, caseId, actionKey, "failed", {
      currentStage: `${channel}-failed`,
    });
  }
  await recordOutboundFailure({
    domain,
    caseId,
    title: `${channel.toUpperCase()} dispatch needs review`,
    summary: result.reason || result.error || "Outbound dispatch failed",
    payload: {
      channel,
      result,
      caseId,
    },
  });
  return { caseId, ok: false, result };
}

async function runRound(payload, channel) {
  if (payload.dispatchListId) {
    await dispatchListRepository.markDispatchListConsuming(payload.dispatchListId);
    await recordWorkflowStage({
      domain: payload.domain,
      family: "dispatch",
      subtype: `${channel}-round`,
      stage: "consuming",
      aggregateType: "dispatch-list",
      aggregateId: String(payload.dispatchListId),
      sourceService: "outbound-gateway",
      summary: `Consuming ${channel} round`,
      payload: { channel, mode: "round" },
    });
  }
  const leads = await listTargetsForRound(payload, channel);
  const results = [];

  for (const lead of leads) {
    results.push(
      await dispatchForLead(lead, {
        channel,
        actionType: payload.actionType || null,
        templateKey: payload.templateKey || null,
        content: payload.content || null,
        subject: payload.subject || null,
        trackingNumber: payload.trackingNumber || null,
        audioUrl: payload.audioUrl || null,
        updateCadence: true,
      }),
    );
  }

  const summary = {
    channel,
    mode: "round",
    selected: leads.length,
    sent: results.filter((entry) => entry.ok).length,
    failed: results.filter((entry) => !entry.ok).length,
    results,
  };

  if (payload.dispatchListId) {
    if (summary.failed > 0) {
      await dispatchListRepository.markDispatchListFailed(payload.dispatchListId, {
        attemptedCount: summary.selected,
        successCount: summary.sent,
        failedCount: summary.failed,
        channel,
        mode: "round",
      });
      await recordWorkflowStage({
        domain: payload.domain,
        family: "dispatch",
        subtype: `${channel}-round`,
        stage: "failed",
        aggregateType: "dispatch-list",
        aggregateId: String(payload.dispatchListId),
        sourceService: "outbound-gateway",
        summary: `${summary.failed} failed in ${channel} round`,
        result: summary,
      });
    } else {
      await dispatchListRepository.markDispatchListCompleted(payload.dispatchListId, {
        attemptedCount: summary.selected,
        successCount: summary.sent,
        failedCount: summary.failed,
        channel,
        mode: "round",
      });
      await recordWorkflowStage({
        domain: payload.domain,
        family: "dispatch",
        subtype: `${channel}-round`,
        stage: "completed",
        aggregateType: "dispatch-list",
        aggregateId: String(payload.dispatchListId),
        sourceService: "outbound-gateway",
        summary: `${summary.sent} completed in ${channel} round`,
        result: summary,
      });
    }
  }

  return summary;
}

async function runManual(payload, channel) {
  if (payload.dispatchListId) {
    await dispatchListRepository.markDispatchListConsuming(payload.dispatchListId);
    await recordWorkflowStage({
      domain: payload.domain,
      family: "dispatch",
      subtype: `${channel}-manual`,
      stage: "consuming",
      aggregateType: "dispatch-list",
      aggregateId: String(payload.dispatchListId),
      sourceService: "outbound-gateway",
      summary: `Consuming ${channel} manual send`,
      payload: { channel, mode: "manual" },
    });
  }
  const leads = await listTargetsForManual(payload);
  const results = [];

  for (const lead of leads) {
    results.push(
      await dispatchForLead(lead, {
        channel,
        actionType: payload.actionType || null,
        templateKey: payload.templateKey || null,
        content: payload.content || null,
        subject: payload.subject || null,
        trackingNumber: payload.trackingNumber || null,
        audioUrl: payload.audioUrl || null,
        updateCadence: false,
      }),
    );
  }

  const summary = {
    channel,
    mode: "manual",
    selected: leads.length,
    sent: results.filter((entry) => entry.ok).length,
    failed: results.filter((entry) => !entry.ok).length,
    results,
  };

  if (payload.dispatchListId) {
    if (summary.failed > 0) {
      await dispatchListRepository.markDispatchListFailed(payload.dispatchListId, {
        attemptedCount: summary.selected,
        successCount: summary.sent,
        failedCount: summary.failed,
        channel,
        mode: "manual",
      });
      await recordWorkflowStage({
        domain: payload.domain,
        family: "dispatch",
        subtype: `${channel}-manual`,
        stage: "failed",
        aggregateType: "dispatch-list",
        aggregateId: String(payload.dispatchListId),
        sourceService: "outbound-gateway",
        summary: `${summary.failed} failed in ${channel} manual send`,
        result: summary,
      });
    } else {
      await dispatchListRepository.markDispatchListCompleted(payload.dispatchListId, {
        attemptedCount: summary.selected,
        successCount: summary.sent,
        failedCount: summary.failed,
        channel,
        mode: "manual",
      });
      await recordWorkflowStage({
        domain: payload.domain,
        family: "dispatch",
        subtype: `${channel}-manual`,
        stage: "completed",
        aggregateType: "dispatch-list",
        aggregateId: String(payload.dispatchListId),
        sourceService: "outbound-gateway",
        summary: `${summary.sent} completed in ${channel} manual send`,
        result: summary,
      });
    }
  }

  return summary;
}

function buildOutboundHandlers() {
  return {
    [OUTBOUND_EVENT_TYPES.TEXT_ROUND_REQUESTED]: (event) => runRound(event.payload || {}, "sms"),
    [OUTBOUND_EVENT_TYPES.EMAIL_ROUND_REQUESTED]: (event) => runRound(event.payload || {}, "email"),
    [OUTBOUND_EVENT_TYPES.RVM_ROUND_REQUESTED]: (event) => runRound(event.payload || {}, "rvm"),
    [OUTBOUND_EVENT_TYPES.PHONEBURNER_ROUND_REQUESTED]: (event) => runRound(event.payload || {}, "phoneburner"),
    [OUTBOUND_EVENT_TYPES.TEXT_MANUAL_REQUESTED]: (event) => runManual(event.payload || {}, "sms"),
    [OUTBOUND_EVENT_TYPES.EMAIL_MANUAL_REQUESTED]: (event) => runManual(event.payload || {}, "email"),
    [OUTBOUND_EVENT_TYPES.RVM_MANUAL_REQUESTED]: (event) => runManual(event.payload || {}, "rvm"),
    [OUTBOUND_EVENT_TYPES.PHONEBURNER_MANUAL_REQUESTED]: (event) => runManual(event.payload || {}, "phoneburner"),
  };
}

async function processNextOutboundEvent(options = {}) {
  return processNextEvent({
    workerName: options.workerName || "outbound-gateway-worker",
    handlers: buildOutboundHandlers(),
    maxAttempts: options.maxAttempts || 3,
  });
}

async function processOutboundEventBatch(options = {}) {
  const maxCount = Math.min(Number(options.maxCount) || 10, 100);
  const results = [];

  for (let index = 0; index < maxCount; index += 1) {
    const result = await processNextOutboundEvent(options);
    results.push(result);
    if (!result.claimed) break;
  }

  return {
    processed: results.filter((entry) => entry.claimed).length,
    handled: results.filter((entry) => entry.handled).length,
    results,
  };
}

module.exports = {
  OUTBOUND_EVENT_TYPES,
  buildOutboundHandlers,
  createOutboundEvent,
  processNextOutboundEvent,
  processOutboundEventBatch,
};
