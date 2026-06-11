"use strict";

const { processNextEvent, createEvent } = require("../../event-core/src");
const {
  caseProfileRepository,
  conversationMessageRepository,
  conversationWorkflowRepository,
  masterProspectRepository,
  metricsSnapshotRepository,
  paymentLedgerRepository,
  reviewQueueRepository,
} = require("../../shared-repositories/src");
const {
  resolveCompanyByTrackingNumber,
} = require("../../shared-integrations/src");
const { env, getCompanyConfig, getInternalFromEmail } = require("../../shared-config/src");
const {
  recordConversationAi,
  recordQualityReview,
} = require("./caseIntelligenceService");
const { recordWorkflowStage } = require("./workflowStateService");
const { classifySms, fastStopCheck } = require("./smsClassifierService");
const { runAutoResponder } = require("./smsAutoResponderService");
const { autoRouteHotInboundWorkflow } = require("./hotIntentRouterService");
const { sendPlainEmail } = require("./sendgridMailService");

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
  // Demo event types. Kept here — and in the same handler map — so the
  // control-plane worker is the single source of truth for event processing.
  // These fire via /api/ring/events on 6101 (smoke tests) and similar.
  DEMO_INBOUND_RECEIVED: "inbound.demo.received",
  DEMO_OUTBOUND_REQUESTED: "outbound.demo.requested",
  DEMO_RING_RECEIVED: "ring.demo.received",
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

function parseEmailList(value) {
  return String(value || "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function maskPhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length < 4) return digits || "unknown";
  return `***${digits.slice(-4)}`;
}

function inboxActionForSmsClassification(classification = {}) {
  if (classification.tier === "hard_stop") return "suppress_contact";
  if (classification.tier === "dnc_confirm") {
    return "auto_dnc_confirm";
  }
  if (classification.tier === "soft_defer") {
    return classification.callbackWindow ? "soft_defer_callback" : "auto_soft_defer";
  }
  if (classification.tier === "callback_prompt") {
    return "auto_callback_prompt";
  }
  return "needs_human";
}

function inboxStatusForSmsClassification(classification = {}) {
  if (classification.tier === "needs_human") return "manual-review";
  if (classification.suggestedReply) return "drafted";
  if (classification.tier === "dnc_confirm") return "suppressed";
  return "observed";
}

function inboxFlagsForSmsClassification(classification = {}) {
  const flags = [];
  if (classification.tier) flags.push(`tier:${classification.tier}`);
  if (classification.intent) flags.push(`intent:${classification.intent}`);
  if (classification.prospectState) flags.push(`state:${classification.prospectState}`);
  if (classification.callbackWindow) flags.push("callback-window");
  if (classification.hotIntent?.detected) flags.push("hot-intent");
  return flags;
}

function smsAlertSubject({ domain, phone, classification = {} }) {
  const reason = classification.hotIntent?.reason || classification.rationale || "unclear";
  const window = classification.callbackWindow || "no window given";
  const prospect = maskPhone(phone);
  switch (classification.tier) {
    case "callback_prompt":
      return `[${domain} SMS] Callback queued: ${prospect} - ${reason}`;
    case "soft_defer":
      return `[${domain} SMS] Soft defer: ${prospect} - ${window}`;
    case "dnc_confirm":
      return `[${domain} SMS] DNC fired: ${prospect} - ${reason}`;
    case "needs_human":
      return `[${domain} SMS] Reply needed: ${prospect} - ${reason}`;
    case "hard_stop":
      return `[${domain} SMS] STOP received: ${prospect}`;
    default:
      return `[${domain} SMS] Reply from ${prospect}`;
  }
}

function resolveSmsAlertRecipients() {
  // Inbound SMS reply alerts are ops-sensitive and should not follow
  // stale per-domain, assigned-rep, or client-team recipient env. Route
  // every text response to the internal Mickey inbox for now.
  return parseEmailList(getInternalFromEmail());
}

async function sendClientSmsAlert({ domain, phone, body, payload, workflowId, inboundMessageId, classification, hotRoutingResult, autoResult }) {
  const normalizedDomain = normalizeDomain(domain);
  const company = getCompanyConfig(normalizedDomain);

  // Per-domain recipient resolution. Order of preference:
  //   1. {DOMAIN}_SMS_ALERT_EMAIL  e.g. WYNN_SMS_ALERT_EMAIL / TAG_SMS_ALERT_EMAIL
  //   2. CLIENT_SMS_ALERT_EMAIL    (legacy; still honored — used for TAG today)
  //   3. company.alertEmail        (from per-company config)
  //   4. company.toEmail           (last-resort fallback)
  //
  // WYNN is prospecting — alerts go to lead-handlers (ogleads etc.) so a
  // rep can claim the conversation and reply manually before the AI
  // auto-fallback runs. TAG is client traffic — alerts go to the
  // designated client-team escalation list.
  const recipients = resolveSmsAlertRecipients();
  if (recipients.length === 0) {
    return { ok: false, skipped: true, reason: "no-client-sms-alert-recipients" };
  }

  const classificationLine = classification
    ? `Classification: ${classification.tier || "unknown"} (${classification.intent || "-"}, conf ${classification.confidence ?? "-"})`
    : null;
  const stateLine = classification?.prospectState
    ? `Prospect state: ${classification.prospectState}`
    : null;
  const callbackWindowLine = classification?.callbackWindow
    ? `Callback window: ${classification.callbackWindow}`
    : null;
  const replyLine = classification?.suggestedReply
    ? `Opus reply: ${classification.suggestedReply}`
    : "Opus reply: (none)";
  const autoLine = autoResult
    ? `Action result: ${autoResult.action || "unknown"} (${autoResult.reason || autoResult.policy || "ok"})`
    : null;

  const hotIntent = classification?.hotIntent?.detected === true;
  let hotIntentLine = null;
  if (hotIntent) {
    if (hotRoutingResult?.routed && hotRoutingResult.agent?.name) {
      hotIntentLine = `HOT INTENT: ${classification.hotIntent.reason || "buying signal"} - routed to ${hotRoutingResult.agent.name}.`;
    } else if (hotRoutingResult?.skipReason === "already-routed-and-fresh") {
      hotIntentLine = `HOT INTENT: ${classification.hotIntent.reason || "buying signal"} - already with ${hotRoutingResult.agent?.name || "assigned rep"}.`;
    } else if (hotRoutingResult?.skipReason === "no-available-agents") {
      hotIntentLine = `HOT INTENT: ${classification.hotIntent.reason || "buying signal"} - UNASSIGNED (no agents available right now).`;
    } else {
      hotIntentLine = `HOT INTENT: ${classification.hotIntent.reason || "buying signal"}.`;
    }
  }

  const footerLine = normalizedDomain === "TAG"
    ? "AI auto-response is disabled for TAG - please reply via the inbox."
    : normalizedDomain === "WYNN"
      ? "WYNN: Opus is first-line on SMS. This alert is the rep brief for callback/follow-through."
      : null;

  const text = [
    `Inbound SMS received on the ${normalizedDomain} line.`,
    hotIntentLine,
    footerLine,
    classificationLine,
    stateLine,
    callbackWindowLine,
    autoLine,
    "",
    `From: ${phone || "unknown"}`,
    `To: ${payload?.destination_number || "unknown"}`,
    `Workflow: ${workflowId || "none"}`,
    `Message: ${inboundMessageId || "none"}`,
    "",
    "Body:",
    body || "(empty)",
    "",
    replyLine,
    "",
    "Rationale:",
    classification?.rationale || "(none)",
    "",
    "Raw Opus tool call:",
    JSON.stringify(classification || {}, null, 2),
  ]
    .filter((line) => line !== null)
    .join("\n");
  return sendPlainEmail(normalizedDomain, {
    personalizations: [
      {
        to: recipients.map((email) => ({ email })),
      },
    ],
    // Internal alert → always send from the Parallel-internal sender
    // (mgray@ by default) so replies land somewhere a human reads.
    // The brand-aware `${normalizedDomain} SMS Alerts` name still
    // tells the recipient which line the inbound hit.
    from: {
      email: getInternalFromEmail(),
      name: `${normalizedDomain} SMS Alerts`,
    },
    subject: smsAlertSubject({ domain: normalizedDomain, phone, classification }),
    content: [{ type: "text/plain", value: text }],
  });
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
      sourceName: payload.sourceName || null,
      sourceChannel: payload.sourceChannel || null,
      routeCampaignKey: payload.routeCampaignKey || null,
      routeCampaignName: payload.routeCampaignName || null,
      vendorSourceName: payload.vendorSourceName || null,
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
  const successful = payments.filter(
    (payment) =>
      String(payment.transactionStatus || "").trim().toUpperCase() === "SUCCESS",
  );
  const paymentIds = successful.map((payment) => payment._id);
  const totalPaid = successful.reduce(
    (sum, payment) => sum + (Number(payment.amount) || 0),
    0,
  );
  const sorted = successful
    .slice()
    .sort((left, right) => {
      const leftTime = new Date(left.paymentDate).getTime();
      const rightTime = new Date(right.paymentDate).getTime();
      if (leftTime !== rightTime) {
        return leftTime - rightTime;
      }
      return (Number(left.casePaymentId) || 0) - (Number(right.casePaymentId) || 0);
    });
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
  const body = String(payload.content || payload.message || "").trim();

  // Resolve company from the destination tracking number first, then
  // fall back to the payload hint, then TAG. Getting this right matters:
  // campaign eligibility is scoped per company, so a mis-stamped inbound
  // could re-engage a Wynn DNC as a TAG prospect.
  const resolvedByTracking = resolveCompanyByTrackingNumber(
    payload.destination_number,
  );
  const resolvedCompany =
    resolvedByTracking || payload.domain || payload.company || "TAG";
  const domain = normalizeDomain(resolvedCompany);

  // If nothing matched our known tracking numbers AND no hint was given,
  // we're silently falling through to "TAG". That's wrong for Wynn-bound
  // inbound and downstream DNC/campaign logic will mis-attribute. Queue
  // a review-queue item so ops can see it — never just default silently.
  if (!resolvedByTracking && !payload.domain && !payload.company) {
    try {
      await reviewQueueRepository.createReviewQueueItem({
        domain,
        sourceService: event.sourceService || "control-plane",
        workflow: "event-intake",
        category: "sms-inbound-unknown-tracking",
        severity: "warning",
        title: "Inbound SMS on unrecognized tracking number",
        summary: `destination=${payload.destination_number || "?"} defaulted to TAG; please verify company`,
        primaryPhone: digits || null,
        happenedAt: new Date(),
        payload,
        tags: ["sms", "unknown-tracking", "needs-config"],
      });
    } catch {
      // Non-fatal — ingest continues under the TAG fallback.
    }
  }

  // Record the thread-level summary. Status stays "observed" — the
  // auto-responder does NOT flip status automatically; operators set it
  // via per-message buttons in the inbox UI.
  await recordConversationAi({
    domain,
    caseId: payload.caseId != null ? Number(payload.caseId) : null,
    phone: digits,
    channel: "sms",
    status: "observed",
    latestInboundText: body || null,
    latestInboundAt: new Date(),
    sourceService: event.sourceService || "control-plane",
    aiSummary: "Inbound SMS observed",
    metadata: payload,
  });

  // Fetch the workflow row we just upserted so we can key the per-turn
  // ConversationMessage row to it (workflowId is the parent pointer).
  let workflow = await conversationWorkflowRepository.findConversationWorkflow(
    domain,
    digits,
    "sms",
  );
  // `findConversationWorkflow` uses .lean() → raw `_id`, not `id`.
  const workflowId = workflow?._id ? String(workflow._id) : null;

  // TAG is a client line right now: log it, alert humans, but do not
  // run AI classification or send AI text. Wynn remains the only
  // AI-supported SMS auto-response lane.
  if (domain !== "WYNN") {
    const classification = fastStopCheck(body)
      ? {
          intent: "opt_out",
          tier: "hard_stop",
          suggestedReply: "",
          confidence: 1,
          rationale: "Regex-matched carrier STOP keyword on alert-only client line.",
          model: "regex-fast-path",
        }
      : {
          intent: "client_sms_alert",
          tier: "needs_human",
          suggestedReply: "",
          confidence: 1,
          rationale: "Client line has AI auto-response disabled.",
          model: null,
        };

    let inboundMessage = null;
    if (workflowId) {
      inboundMessage = await conversationMessageRepository.createInboundMessage({
        workflowId,
        domain,
        phone: digits,
        caseId: payload.caseId != null ? Number(payload.caseId) : null,
        channel: "sms",
        body,
        aiClassification: {
          intent: classification.intent,
          tier: classification.tier,
          prospectState: classification.prospectState || null,
          suggestedReply: classification.suggestedReply,
          callbackWindow: classification.callbackWindow || null,
          confidence: classification.confidence,
          rationale: classification.rationale,
          model: classification.model,
          validationError: classification.validationError || null,
        },
        rawPayload: payload,
      });
    }

    const inboundCaseId =
      payload.caseId != null && Number.isFinite(Number(payload.caseId))
        ? Number(payload.caseId)
        : null;
    if (inboundCaseId) {
      await caseProfileRepository
        .appendCommunicationThread(domain, inboundCaseId, "sms", {
          provider: payload.provider || "callrail",
          threadKey: workflowId || `${domain}:${digits}`,
          direction: "inbound",
          phone: digits,
          body: body || null,
          status: "received",
          workflowId: workflowId || null,
          conversationMessageId: inboundMessage?.id || null,
          sentAt: new Date(),
          source: "sms-inbound",
          metadata: {
            aiDisabled: true,
            aiTier: classification.tier || null,
            aiIntent: classification.intent || null,
            aiConfidence: classification.confidence || null,
            providerMessageId: payload.providerMessageId || null,
          },
        })
        .catch(() => null);
    }

    let alertResult = null;
    try {
      alertResult = await sendClientSmsAlert({
        domain,
        phone: digits,
        body,
        payload,
        workflowId,
        inboundMessageId: inboundMessage?.id || null,
      });
    } catch (error) {
      alertResult = { ok: false, error: error.message };
    }

    await recordWorkflowStage({
      domain,
      family: "conversation",
      subtype: "sms",
      stage: "observed",
      aggregateType: "sms-conversation",
      aggregateId: String(event.aggregateId || digits || "unknown"),
      caseId: payload.caseId != null ? Number(payload.caseId) : null,
      sourceService: event.sourceService,
      summary: `Inbound SMS alert-only on ${domain}; AI disabled`,
      payload: {
        classification,
        alertResult,
        inboundMessageId: inboundMessage?.id || null,
      },
    });

    await reviewQueueRepository.createReviewQueueItem({
      domain,
      caseId: payload.caseId != null ? Number(payload.caseId) : null,
      sourceService: event.sourceService || "control-plane",
      workflow: "sms-inbox",
      category: "tag-sms-alert",
      severity: alertResult?.ok === false ? "warning" : "info",
      title: "Client SMS reply received",
      summary: body.slice(0, 240) || null,
      primaryPhone: digits || null,
      happenedAt: new Date(),
      payload: {
        raw: payload,
        classification,
        workflowId,
        inboundMessageId: inboundMessage?.id || null,
        alertResult,
      },
      tags: ["sms", "client-line", "ai-disabled", domain.toLowerCase()],
    });

    return {
      classification,
      autoResult: {
        action: "alert_only",
        sent: false,
        reason: "ai-disabled-for-client-line",
      },
      alertResult,
      inboundMessageId: inboundMessage?.id || null,
    };
  }

  // Pull recent turns so the classifier has conversational context.
  const history = workflowId
    ? await conversationMessageRepository.listMessagesForWorkflow(workflowId, {
        limit: 8,
      })
    : [];

  // Resolve the outbound tracking number for reply-phrasing context.
  let trackingNumber = null;
  try {
    const { getCompanyConfig } = require("../../shared-config/src/companyConfig");
    trackingNumber = getCompanyConfig(domain)?.integrations?.callrail?.trackingNumber || null;
  } catch {
    trackingNumber = null;
  }

  // Classify with Sonnet (fast regex short-circuit lives inside).
  const classification = await classifySms({
    text: body,
    fromPhone: digits,
    company: domain,
    trackingNumber,
    history: history.map((msg) => ({
      direction: msg.direction,
      body: msg.body,
      createdAt: msg.createdAt,
    })),
  });

  workflow = await recordConversationAi({
    domain,
    caseId: payload.caseId != null ? Number(payload.caseId) : null,
    phone: digits,
    channel: "sms",
    status: inboxStatusForSmsClassification(classification),
    latestInboundText: body || null,
    latestInboundAt: new Date(),
    sourceService: event.sourceService || "control-plane",
    aiRecommendedAction: inboxActionForSmsClassification(classification),
    aiDraftReply: classification.suggestedReply || null,
    aiConfidence: classification.confidence != null ? String(classification.confidence) : null,
    aiFlags: inboxFlagsForSmsClassification(classification),
    aiSummary: classification.rationale || null,
    clearSmsLock: false,
    metadata: {
      ...(payload || {}),
      classification,
      aiModel: classification.model || null,
      prospectState: classification.prospectState || null,
      callbackWindow: classification.callbackWindow || null,
    },
  });

  // Per-turn inbound row. Stores the snapshot of what the classifier
  // decided at ingest time — critical for audit when we later change
  // the prompt or the model.
  let inboundMessage = null;
  if (workflowId) {
    inboundMessage = await conversationMessageRepository.createInboundMessage({
      workflowId,
      domain,
      phone: digits,
      caseId: payload.caseId != null ? Number(payload.caseId) : null,
      channel: "sms",
      body,
      aiClassification: {
        intent: classification.intent,
        tier: classification.tier,
        prospectState: classification.prospectState || null,
        suggestedReply: classification.suggestedReply,
        callbackWindow: classification.callbackWindow || null,
        confidence: classification.confidence,
        rationale: classification.rationale,
        model: classification.model,
        validationError: classification.validationError || null,
      },
      rawPayload: payload,
    });
  }

  // Mirror the inbound onto the case profile's communicationThreads.sms
  // so the unified comm log (cxCommLogService) shows the reply alongside
  // outbound texts on a converted case. Skip when there's no caseId yet
  // — for prospect-stage inbounds the comm log reads ConversationMessage
  // directly via phone, so the data still surfaces, just from a
  // different source.
  const inboundCaseId =
    payload.caseId != null && Number.isFinite(Number(payload.caseId))
      ? Number(payload.caseId)
      : null;
  if (inboundCaseId) {
    await caseProfileRepository
      .appendCommunicationThread(domain, inboundCaseId, "sms", {
        provider: payload.provider || "callrail",
        threadKey: workflowId || `${domain}:${digits}`,
        direction: "inbound",
        phone: digits,
        body: body || null,
        status: "received",
        workflowId: workflowId || null,
        conversationMessageId: inboundMessage?.id || null,
        sentAt: new Date(),
        source: "sms-inbound",
        metadata: {
          aiTier: classification.tier || null,
          aiIntent: classification.intent || null,
          aiProspectState: classification.prospectState || null,
          callbackWindow: classification.callbackWindow || null,
          aiConfidence: classification.confidence || null,
          providerMessageId: payload.providerMessageId || null,
        },
      })
      .catch(() => null); // non-fatal: ConversationMessage is the source of truth
  }

  // Hot-intent stamp. Callback routing happens after the SMS send
  // succeeds so a failed provider send does not put a callback on a
  // rep's plate before the prospect ever sees our reply.
  //
  // - Classifier sets classification.hotIntent.detected when the
  //   prospect shows buying intent.
  // - On a hot inbound we stamp aiHotIntent/Reason/DetectedAt on
  //   the workflow, then route only if the outbound send succeeds.
  // - If no agent is available (everyone toggled off / shift over),
  //   the workflow still carries aiHotIntent=true so it surfaces in
  //   the inbox with a "HOT - unassigned" indicator. The next rep to
  //   log in sees it pinned.
  let hotRoutingResult = null;
  const shouldRouteCallback =
    classification.hotIntent?.detected ||
    classification.tier === "callback_prompt" ||
    (classification.tier === "soft_defer" && Boolean(classification.callbackWindow));
  if (shouldRouteCallback) {
    await recordConversationAi({
      domain,
      caseId: payload.caseId != null ? Number(payload.caseId) : null,
      phone: digits,
      channel: "sms",
      status: inboxStatusForSmsClassification(classification),
      latestInboundText: body || null,
      latestInboundAt: new Date(),
      sourceService: event.sourceService || "control-plane",
      aiRecommendedAction: inboxActionForSmsClassification(classification),
      aiDraftReply: classification.suggestedReply || null,
      aiConfidence: classification.confidence != null ? String(classification.confidence) : null,
      aiFlags: inboxFlagsForSmsClassification(classification),
      aiSummary: classification.rationale || "Inbound SMS observed (hot intent)",
      aiHotIntent: Boolean(classification.hotIntent?.detected),
      aiHotIntentReason: classification.hotIntent?.reason || classification.callbackWindow || null,
      clearSmsLock: false,
      metadata: {
        ...(payload || {}),
        classification,
        prospectState: classification.prospectState || null,
        callbackWindow: classification.callbackWindow || null,
      },
    });
  }

  // Run the auto-responder. It enforces cooldown + the "only two tiers
  // auto-send" rule + writes outbound ConversationMessage row + DNC
  // consent record when applicable. Safe to call on needs_human — it
  // no-ops and leaves the thread for manual review.
  const autoResult = await runAutoResponder({
    domain,
    phone: digits,
    workflowId,
    workflow,
    classification,
    rawPayload: payload,
    threadHistory: history,
  });

  if (shouldRouteCallback) {
    if (autoResult.sent) {
      try {
        hotRoutingResult = await autoRouteHotInboundWorkflow({
          workflowId,
          domain,
          reason: classification.hotIntent?.reason || classification.callbackWindow || null,
          callbackWindow: classification.callbackWindow || "",
          classification,
        });
      } catch (error) {
        hotRoutingResult = { routed: false, skipReason: `error:${error.message}` };
      }
    } else {
      hotRoutingResult = { routed: false, skipReason: "sms-not-sent" };
    }
  }

  // Alert after the action path runs so the email is a true rep brief:
  // inbound, Opus decision, sent/skipped/DNC result, and callback route.
  let wynnAlertResult = null;
  try {
    wynnAlertResult = await sendClientSmsAlert({
      domain,
      phone: digits,
      body,
      payload,
      workflowId,
      inboundMessageId: inboundMessage?.id || null,
      classification,
      hotRoutingResult,
      autoResult,
    });
  } catch (error) {
    wynnAlertResult = { ok: false, error: error.message };
  }

  await recordWorkflowStage({
    domain,
    family: "conversation",
    subtype: "sms",
    // Stage here is a workflow-stage ledger entry (audit-only), not a
    // status flip on the thread. Keep it descriptive without implying
    // suppression — the thread status stays "observed" until an
    // operator touches it.
    stage: autoResult.sent
      ? "completed"
      : autoResult.dncResult?.ok
        ? "completed"
      : classification.tier === "hard_stop"
        ? "skipped"
        : "observed",
    aggregateType: "sms-conversation",
    aggregateId: String(event.aggregateId || digits || "unknown"),
    caseId: payload.caseId != null ? Number(payload.caseId) : null,
    sourceService: event.sourceService,
    summary: `Inbound SMS classified ${classification.tier} (${classification.intent})`,
    payload: {
      classification,
      autoResult,
      inboundMessageId: inboundMessage?.id || null,
    },
  });

  // Only queue a review item when a human actually needs to look at it.
  //   - hard_stop is resolved by CallRail (carrier block) + our cadence
  //     prune; thread still shows in the inbox list but doesn't demand
  //     attention, so no review-queue item.
  //   - dnc_confirm with a successful auto-reply is resolved — the
  //     outbound bubble + ConsentRecord are the audit trail.
  //   - Anything else (needs_human, send failures, etc.) queues an item.
  const bottedClean =
    classification.tier === "hard_stop" ||
    (classification.tier === "dnc_confirm" && autoResult.dncResult?.ok) ||
    (classification.tier === "soft_defer" && autoResult.sent) ||
    (classification.tier === "callback_prompt" && autoResult.sent);

  if (!bottedClean) {
    return reviewQueueRepository.createReviewQueueItem({
      domain,
      caseId: payload.caseId != null ? Number(payload.caseId) : null,
      sourceService: event.sourceService || "control-plane",
      workflow: "sms-inbox",
      category: "sms-inbound-needs-human",
      severity: classification.intent === "hostile" ? "warning" : "info",
      title: "Inbound SMS needs human review",
      summary: body.slice(0, 240) || null,
      primaryPhone: digits || null,
      happenedAt: new Date(),
      payload: {
        raw: payload,
        classification,
        workflowId,
        inboundMessageId: inboundMessage?.id || null,
      },
      tags: ["sms", "inbox", "needs-human", classification.intent || "other"],
    });
  }

  return {
    classification,
    autoResult,
    alertResult: wynnAlertResult,
    inboundMessageId: inboundMessage?.id || null,
  };
}

// No-op handler: RC telephony envelopes used to materialize a review-
// queue item + a workflow-stage row per envelope. That produced ~69K
// `telephony.ringcentral.observed` workflow rows of pure firehose with
// zero signal — actual telephony processing happens via
// `processTelephonySessionCandidate` and the RC subscription native
// sweep, neither of which depend on these audit rows. Real failure
// modes (RC 429s, CX-down, subscription stalled) flow through
// `recordServiceAlert` / the subscription watchdog and are unaffected
// by this no-op. Kept registered so any in-flight queued events from
// before deploy don't crash on dequeue.
async function handleRingcentralTelephonyForwarded(_event) {
  return null;
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

async function handleDemoEvent(event) {
  if (event.payload?.forceError) {
    throw new Error(`Forced demo failure: ${event.eventType}`);
  }
  // Demo events are observed for smoke-test visibility; nothing to persist.
  return { observed: true, eventType: event.eventType, aggregateId: event.aggregateId };
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
    [CONTROL_PLANE_EVENT_TYPES.DEMO_INBOUND_RECEIVED]: handleDemoEvent,
    [CONTROL_PLANE_EVENT_TYPES.DEMO_OUTBOUND_REQUESTED]: handleDemoEvent,
    [CONTROL_PLANE_EVENT_TYPES.DEMO_RING_RECEIVED]: handleDemoEvent,
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
