"use strict";

const { processNextEvent, createEvent } = require("../../event-core/src");
const {
  caseProfileRepository,
  masterProspectRepository,
  metricsSnapshotRepository,
  paymentLedgerRepository,
  reviewQueueRepository,
} = require("../../shared-repositories/src");
const {
  recordConversationAi,
  recordQualityReview,
} = require("./caseIntelligenceService");
const { recordWorkflowStage } = require("./workflowStateService");

const CONTROL_PLANE_EVENT_TYPES = Object.freeze({
  LEAD_OBSERVED: "control-plane.lead.observed",
  CASE_PROFILE_OBSERVED: "control-plane.case-profile.observed",
  PAYMENT_OBSERVED: "control-plane.payment.observed",
  REVIEW_ITEM_OBSERVED: "control-plane.review-item.observed",
  METRIC_OBSERVED: "control-plane.metric.observed",
  ENRICHMENT_REQUESTED: "control-plane.enrichment.requested",
  SMS_INBOUND_FORWARDED: "sms.inbound.forwarded",
  RINGCENTRAL_TELEPHONY_FORWARDED: "ringcentral.telephony.forwarded",
  QC_REVIEW_OBSERVED: "control-plane.qc-review.observed",
  CONVERSATION_AI_OBSERVED: "control-plane.conversation-ai.observed",
});

function normalizeDomain(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizePhones(payload = {}) {
  return [
    payload.cellPhone,
    payload.homePhone,
    payload.workPhone,
    payload.primaryPhone,
  ]
    .map((value) => String(value || "").replace(/\D/g, ""))
    .filter(Boolean);
}

function requirePayloadFields(payload, fields) {
  const missing = fields.filter((field) => {
    const value = payload?.[field];
    return value === undefined || value === null || value === "";
  });

  if (missing.length > 0) {
    throw new Error(`Missing required payload fields: ${missing.join(", ")}`);
  }
}

async function createControlPlaneEvent(input = {}) {
  requirePayloadFields(input, ["eventType", "aggregateType", "aggregateId"]);

  return createEvent({
    eventType: input.eventType,
    sourceService: input.sourceService || "control-plane",
    aggregateType: input.aggregateType,
    aggregateId: String(input.aggregateId),
    dedupeKey: input.dedupeKey || null,
    payload: input.payload || {},
  });
}

async function handleLeadObserved(event) {
  const payload = event.payload || {};
  requirePayloadFields(payload, ["domain", "caseId"]);

  const domain = normalizeDomain(payload.domain);
  const caseId = Number(payload.caseId);
  const prospect = await masterProspectRepository.upsertMasterProspect(domain, caseId, {
    statusId: payload.statusId != null ? Number(payload.statusId) : null,
    statusLabelRaw: payload.statusLabelRaw || null,
    statusCategory: payload.statusCategory || "prospect",
    sourceId: payload.sourceId != null ? Number(payload.sourceId) : null,
    firstName: payload.firstName || null,
    lastName: payload.lastName || null,
    name: payload.name || null,
    email: payload.email || null,
    cellPhone: payload.cellPhone || null,
    homePhone: payload.homePhone || null,
    workPhone: payload.workPhone || null,
    normalizedPhones: normalizePhones(payload),
    lastSeenAt: new Date(),
    lastStatusCheckAt: payload.statusId != null ? new Date() : null,
    needsStatusRefresh: payload.needsStatusRefresh !== undefined ? Boolean(payload.needsStatusRefresh) : true,
    needsSourceRefresh: payload.needsSourceRefresh !== undefined ? Boolean(payload.needsSourceRefresh) : true,
    metadata: {
      intakeSource: payload.intakeSource || payload.sourceService || event.sourceService || null,
      lastImportBatch: payload.importBatch || null,
      notes: Array.isArray(payload.notes) ? payload.notes : [],
    },
  });
  await recordWorkflowStage({
    domain,
    family: "lead",
    subtype: payload.intakeSource || "observed",
    stage: "observed",
    aggregateType: "case",
    aggregateId: String(caseId),
    caseId,
    sourceService: event.sourceService,
    summary: "Lead observed by control plane",
    payload,
  });
  return prospect;
}

async function handleCaseProfileObserved(event) {
  const payload = event.payload || {};
  requirePayloadFields(payload, ["domain", "caseId"]);

  const domain = normalizeDomain(payload.domain);
  const caseId = Number(payload.caseId);

  const profile = await caseProfileRepository.upsertCaseProfile(domain, caseId, {
    masterProspectId: payload.masterProspectId || null,
    sourceCanonicalId: payload.sourceCanonicalId || null,
    firstName: payload.firstName || null,
    lastName: payload.lastName || null,
    name: payload.name || null,
    email: payload.email || null,
    primaryPhone: payload.primaryPhone || payload.cellPhone || null,
    normalizedPhones: normalizePhones(payload),
    statusId: payload.statusId != null ? Number(payload.statusId) : null,
    statusCategory: payload.statusCategory || "client",
    convertedAt: payload.convertedAt ? new Date(payload.convertedAt) : null,
    attribution: payload.attribution || undefined,
  });

  await recordWorkflowStage({
    domain,
    family: "case-profile",
    subtype: payload.statusCategory || "observed",
    stage: "observed",
    aggregateType: "case",
    aggregateId: String(caseId),
    caseId,
    sourceService: event.sourceService,
    summary: "Case profile observed by control plane",
    payload,
  });

  return profile;
}

async function syncCaseProfilePaymentSummary(domain, caseId) {
  const payments = await paymentLedgerRepository.listPaymentsForCase(domain, caseId);
  const paymentIds = payments.map((payment) => payment._id);
  const totalPaid = payments.reduce((sum, payment) => sum + (Number(payment.amount) || 0), 0);
  const sorted = payments
    .slice()
    .sort((left, right) => new Date(left.paymentDate).getTime() - new Date(right.paymentDate).getTime());
  const first = sorted[0] || null;
  const last = sorted[sorted.length - 1] || null;

  return caseProfileRepository.upsertCaseProfile(domain, caseId, {
    paymentIds,
    paymentsCount: payments.length,
    totalPaid,
    initialPayment: first ? Number(first.amount) || 0 : 0,
    firstPaymentDate: first ? new Date(first.paymentDate) : null,
    lastPaymentDate: last ? new Date(last.paymentDate) : null,
    lastPaymentAmount: last ? Number(last.amount) || 0 : 0,
    convertedAt: first ? new Date(first.paymentDate) : null,
  });
}

async function handlePaymentObserved(event) {
  const payload = event.payload || {};
  requirePayloadFields(payload, ["domain", "caseId", "casePaymentId", "paymentDate"]);

  const domain = normalizeDomain(payload.domain);
  const caseId = Number(payload.caseId);
  const casePaymentId = Number(payload.casePaymentId);

  await paymentLedgerRepository.upsertPaymentLedger(casePaymentId, {
    domain,
    caseId,
    caseProfileId: payload.caseProfileId || null,
    masterProspectId: payload.masterProspectId || null,
    sourceCanonicalId: payload.sourceCanonicalId || null,
    paymentDate: new Date(payload.paymentDate),
    paymentDateKey: String(payload.paymentDate).slice(0, 10),
    amount: Number(payload.amount || 0),
    paymentType: payload.paymentType || "unknown",
    transactionStatus: payload.transactionStatus || "SUCCESS",
    needsSourceReview: Boolean(payload.needsSourceReview),
    reviewReason: payload.reviewReason || null,
    raw: payload.raw || payload,
  });

  await recordWorkflowStage({
    domain,
    family: "payment",
    subtype: payload.paymentType || "observed",
    stage: "observed",
    aggregateType: "payment",
    aggregateId: String(casePaymentId),
    caseId,
    sourceService: event.sourceService,
    summary: `Payment observed for case ${caseId}`,
    payload: {
      amount: Number(payload.amount || 0),
      paymentDate: payload.paymentDate,
      transactionStatus: payload.transactionStatus || "SUCCESS",
    },
  });

  return syncCaseProfilePaymentSummary(domain, caseId);
}

async function handleReviewItemObserved(event) {
  const payload = event.payload || {};
  requirePayloadFields(payload, ["domain", "title"]);

  const item = await reviewQueueRepository.createReviewQueueItem({
    domain: normalizeDomain(payload.domain),
    caseId: payload.caseId != null ? Number(payload.caseId) : null,
    sourceService: payload.sourceService || event.sourceService || "control-plane",
    workflow: payload.workflow || "event-intake",
    category: payload.category || "general",
    severity: payload.severity || "info",
    title: payload.title,
    summary: payload.summary || null,
    customerName: payload.customerName || null,
    primaryPhone: payload.primaryPhone || null,
    sourceName: payload.sourceName || null,
    sourceChannel: payload.sourceChannel || null,
    happenedAt: payload.happenedAt ? new Date(payload.happenedAt) : new Date(),
    payload: payload.payload || payload,
    tags: Array.isArray(payload.tags) ? payload.tags : [],
  });

  await recordWorkflowStage({
    domain: normalizeDomain(payload.domain),
    family: "review",
    subtype: payload.category || "general",
    stage: "observed",
    aggregateType: "review-item",
    aggregateId: String(item._id),
    caseId: payload.caseId != null ? Number(payload.caseId) : null,
    sourceService: payload.sourceService || event.sourceService || "control-plane",
    title: payload.title,
    summary: payload.summary || "Review item observed",
  });

  return item;
}

async function handleMetricObserved(event) {
  const payload = event.payload || {};
  requirePayloadFields(payload, ["domain", "metricName"]);

  const result = await metricsSnapshotRepository.recordMetricEvent(payload.domain, {
    metricName: String(payload.metricName),
    sourceKey: payload.sourceKey ? String(payload.sourceKey) : null,
    amount: Number(payload.amount || 1),
    caseId: payload.caseId != null ? Number(payload.caseId) : null,
    title: payload.title || null,
    eventType: event.eventType,
    happenedAt: payload.happenedAt ? new Date(payload.happenedAt) : new Date(),
  });

  await recordWorkflowStage({
    domain: normalizeDomain(payload.domain),
    family: "metric",
    subtype: String(payload.metricName),
    stage: "observed",
    aggregateType: "metric",
    aggregateId: String(payload.metricName),
    caseId: payload.caseId != null ? Number(payload.caseId) : null,
    sourceService: event.sourceService,
    summary: payload.title || `Metric observed: ${payload.metricName}`,
    payload: {
      sourceKey: payload.sourceKey || null,
      amount: Number(payload.amount || 1),
    },
  });

  return result;
}

async function handleEnrichmentRequested(event) {
  const payload = event.payload || {};
  requirePayloadFields(payload, ["domain", "caseId", "title"]);

  await reviewQueueRepository.createReviewQueueItem({
    domain: normalizeDomain(payload.domain),
    caseId: Number(payload.caseId),
    sourceService: payload.sourceService || event.sourceService || "control-plane",
    workflow: payload.workflow || "enrichment-request",
    category: payload.category || "enrichment-requested",
    severity: payload.severity || "info",
    title: payload.title,
    summary: payload.summary || null,
    customerName: payload.customerName || null,
    primaryPhone: payload.primaryPhone || null,
    sourceName: payload.sourceName || null,
    sourceChannel: payload.sourceChannel || null,
    happenedAt: payload.happenedAt ? new Date(payload.happenedAt) : new Date(),
    payload: payload.payload || payload,
    tags: Array.isArray(payload.tags) ? payload.tags : ["enrichment"],
  });

  await recordWorkflowStage({
    domain: normalizeDomain(payload.domain),
    family: "enrichment",
    subtype: payload.category || "requested",
    stage: "requested",
    aggregateType: "case",
    aggregateId: String(payload.caseId),
    caseId: Number(payload.caseId),
    sourceService: event.sourceService,
    title: payload.title,
    summary: payload.summary || "Enrichment requested",
  });

  return metricsSnapshotRepository.recordMetricEvent(payload.domain, {
    metricName: "enrichment_requested",
    sourceKey: payload.sourceKey || payload.sourceChannel || "unknown",
    amount: 1,
    caseId: Number(payload.caseId),
    title: payload.title,
    eventType: event.eventType,
    happenedAt: payload.happenedAt ? new Date(payload.happenedAt) : new Date(),
  });
}

async function handleSmsInboundForwarded(event) {
  const payload = event.payload || {};
  const digits = String(payload.source_number || "").replace(/\D/g, "");
  const optOutDetected = /\b(stop|unsubscribe|do not text|dont text|remove me)\b/i.test(
    String(payload.content || payload.message || ""),
  );

  await recordConversationAi({
    domain: normalizeDomain(payload.domain || payload.company || "TAG"),
    caseId: payload.caseId != null ? Number(payload.caseId) : null,
    phone: digits,
    channel: "sms",
    status: optOutDetected ? "suppressed" : "observed",
    optOutDetected,
    optedOutAt: optOutDetected ? new Date() : null,
    latestInboundText: String(payload.content || payload.message || "").trim() || null,
    latestInboundAt: new Date(),
    sourceService: event.sourceService || "control-plane",
    aiRecommendedAction: optOutDetected ? "suppress_contact" : null,
    aiSummary: optOutDetected ? "Inbound STOP-like message detected" : "Inbound SMS observed",
    aiFlags: optOutDetected ? ["opt_out"] : [],
    metadata: payload,
  });

  await recordWorkflowStage({
    domain: normalizeDomain(payload.domain || payload.company || "TAG"),
    family: "conversation",
    subtype: "sms",
    stage: "observed",
    aggregateType: "sms-conversation",
    aggregateId: String(event.aggregateId || digits || "unknown"),
    caseId: payload.caseId != null ? Number(payload.caseId) : null,
    sourceService: event.sourceService,
    summary: "Inbound SMS observed",
    payload,
  });

  return reviewQueueRepository.createReviewQueueItem({
    domain: normalizeDomain(payload.domain || payload.company || "TAG"),
    caseId: payload.caseId != null ? Number(payload.caseId) : null,
    sourceService: event.sourceService || "control-plane",
    workflow: "event-intake",
    category: "sms-inbound-forwarded",
    severity: "info",
    title: "Inbound SMS forwarded to control plane",
    summary: String(payload.content || payload.message || "").slice(0, 240) || null,
    primaryPhone: digits || null,
    happenedAt: new Date(),
    payload,
    tags: ["sms", "forwarded"],
  });
}

async function handleRingcentralTelephonyForwarded(event) {
  const payload = event.payload || {};
  const envelope = payload.envelope || {};
  const telephonySessionId = String(
    envelope.body?.telephonySessionId || envelope.body?.sessionId || event.aggregateId || "",
  ).trim();

  const item = await reviewQueueRepository.createReviewQueueItem({
    domain: normalizeDomain(payload.domain || "TAG"),
    sourceService: event.sourceService || "control-plane",
    workflow: "event-intake",
    category: "ringcentral-session-forwarded",
    severity: "info",
    title: "RingCentral telephony session forwarded",
    summary: telephonySessionId || "Telephony session envelope received",
    happenedAt: envelope.body?.eventTime ? new Date(envelope.body.eventTime) : new Date(),
    payload,
    tags: ["ringcentral", "telephony-session"],
  });

  await recordWorkflowStage({
    domain: normalizeDomain(payload.domain || "TAG"),
    family: "telephony",
    subtype: "ringcentral",
    stage: "observed",
    aggregateType: "telephony-session",
    aggregateId: telephonySessionId,
    sourceService: event.sourceService,
    title: "RingCentral telephony session forwarded",
    summary: telephonySessionId || "Telephony session envelope received",
    payload: {
      reviewItemId: String(item._id),
      candidatesCount: Array.isArray(payload.candidates) ? payload.candidates.length : 0,
    },
  });

  return item;
}

async function handleQcReviewObserved(event) {
  const payload = event.payload || {};
  requirePayloadFields(payload, ["domain", "caseId", "reviewType"]);

  const review = await recordQualityReview({
    domain: normalizeDomain(payload.domain),
    caseId: Number(payload.caseId),
    provider: payload.provider || "anthropic",
    reviewType: payload.reviewType,
    sourceService: payload.sourceService || event.sourceService || "control-plane",
    externalId: payload.externalId || null,
    status: payload.status || null,
    confidence: payload.confidence || null,
    score: payload.score != null ? Number(payload.score) : null,
    summary: payload.summary || null,
    positives: Array.isArray(payload.positives) ? payload.positives : [],
    concerns: Array.isArray(payload.concerns) ? payload.concerns : [],
    flags: Array.isArray(payload.flags) ? payload.flags : [],
    rawResponse: payload.rawResponse || payload,
    reviewedAt: payload.reviewedAt ? new Date(payload.reviewedAt) : new Date(),
  });

  return recordWorkflowStage({
    domain: normalizeDomain(payload.domain),
    family: "qc",
    subtype: payload.reviewType,
    stage: "completed",
    aggregateType: "case",
    aggregateId: String(payload.caseId),
    caseId: Number(payload.caseId),
    sourceService: event.sourceService,
    summary: payload.summary || "QC review observed",
    result: {
      reviewId: String(review._id),
      score: review.score,
      status: review.status,
    },
  });
}

async function handleConversationAiObserved(event) {
  const payload = event.payload || {};
  requirePayloadFields(payload, ["domain", "phone"]);

  const workflow = await recordConversationAi({
    domain: normalizeDomain(payload.domain),
    phone: payload.phone,
    caseId: payload.caseId != null ? Number(payload.caseId) : null,
    channel: payload.channel || "sms",
    status: payload.status || "drafted",
    optOutDetected: Boolean(payload.optOutDetected),
    optedOutAt: payload.optedOutAt ? new Date(payload.optedOutAt) : null,
    latestInboundText: payload.latestInboundText || null,
    latestInboundAt: payload.latestInboundAt ? new Date(payload.latestInboundAt) : new Date(),
    aiRecommendedAction: payload.aiRecommendedAction || null,
    aiDraftReply: payload.aiDraftReply || null,
    aiConfidence: payload.aiConfidence || null,
    aiFlags: Array.isArray(payload.aiFlags) ? payload.aiFlags : [],
    aiSummary: payload.aiSummary || null,
    sourceService: payload.sourceService || event.sourceService || "control-plane",
    metadata: payload.metadata || payload,
  });

  return recordWorkflowStage({
    domain: workflow.domain,
    family: "conversation",
    subtype: workflow.channel,
    stage: workflow.status === "sent" ? "completed" : "requested",
    aggregateType: "conversation",
    aggregateId: String(workflow._id),
    caseId: workflow.caseId,
    sourceService: event.sourceService,
    summary: workflow.aiSummary || "Conversation AI observed",
    result: {
      workflowId: String(workflow._id),
      status: workflow.status,
      optOutDetected: workflow.optOutDetected,
    },
  });
}

function buildControlPlaneEventHandlers() {
  return {
    [CONTROL_PLANE_EVENT_TYPES.LEAD_OBSERVED]: handleLeadObserved,
    [CONTROL_PLANE_EVENT_TYPES.CASE_PROFILE_OBSERVED]: handleCaseProfileObserved,
    [CONTROL_PLANE_EVENT_TYPES.PAYMENT_OBSERVED]: handlePaymentObserved,
    [CONTROL_PLANE_EVENT_TYPES.REVIEW_ITEM_OBSERVED]: handleReviewItemObserved,
    [CONTROL_PLANE_EVENT_TYPES.METRIC_OBSERVED]: handleMetricObserved,
    [CONTROL_PLANE_EVENT_TYPES.ENRICHMENT_REQUESTED]: handleEnrichmentRequested,
    [CONTROL_PLANE_EVENT_TYPES.SMS_INBOUND_FORWARDED]: handleSmsInboundForwarded,
    [CONTROL_PLANE_EVENT_TYPES.RINGCENTRAL_TELEPHONY_FORWARDED]: handleRingcentralTelephonyForwarded,
    [CONTROL_PLANE_EVENT_TYPES.QC_REVIEW_OBSERVED]: handleQcReviewObserved,
    [CONTROL_PLANE_EVENT_TYPES.CONVERSATION_AI_OBSERVED]: handleConversationAiObserved,
  };
}

async function processNextControlPlaneEvent(options = {}) {
  return processNextEvent({
    workerName: options.workerName || "control-plane-worker",
    handlers: buildControlPlaneEventHandlers(),
    maxAttempts: options.maxAttempts || 3,
  });
}

async function processControlPlaneEventBatch(options = {}) {
  const maxCount = Math.min(Number(options.maxCount) || 10, 100);
  const results = [];

  for (let index = 0; index < maxCount; index += 1) {
    const result = await processNextControlPlaneEvent(options);
    results.push(result);
    if (!result.claimed) {
      break;
    }
  }

  return {
    processed: results.filter((result) => result.claimed).length,
    handled: results.filter((result) => result.handled).length,
    results,
  };
}

module.exports = {
  CONTROL_PLANE_EVENT_TYPES,
  buildControlPlaneEventHandlers,
  createControlPlaneEvent,
  processControlPlaneEventBatch,
  processNextControlPlaneEvent,
};
