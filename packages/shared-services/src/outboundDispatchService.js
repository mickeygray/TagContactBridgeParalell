"use strict";

const { createEvent, processNextEvent } = require("../../event-core/src");
const { getCompanyKeys, getSharedConfig } = require("../../shared-config/src");
const {
  createDropClient,
  createNeverBounceClient,
  resolveCompanyByTrackingNumber,
} = require("../../shared-integrations/src");
const {
  caseProfileRepository,
  consentRecordRepository,
  dispatchListRepository,
  leadCadenceRepository,
  metricsSnapshotRepository,
  reviewQueueRepository,
} = require("../../shared-repositories/src");
const { sendOutboundText } = require("./outboundTextService");
const { sendOutboundEmail } = require("./outboundEmailService");
const { sendOutboundRvm } = require("./outboundRvmService");
const { sendOutboundCallFireDial, sendOutboundCallFireDialBatch } = require("./outboundCallFireService");
const { requestPhoneBurnerDispatch } = require("./outboundPhoneBurnerService");
const {
  resolveCadenceEmailContent,
  resolveCadenceSmsContent,
} = require("./cadenceContentService");
const {
  evaluateChannelContactTime,
  evaluateFrequencyCap,
} = require("./contactTimingPolicyService");
const { createLogicsFacade } = require("./logicsFacadeService");
const { resolveCaseContactEligibility } = require("./contactEligibilityService");
const { evaluateOutboundRateLimit } = require("./outboundRateShaperService");
const { recordWorkflowStage } = require("./workflowStateService");
const { emitHourlyJobEvent } = require("./hourlyJobEventService");
const { classifyDropDisposition } = require("./outboundFailureClassifier");

const OUTBOUND_EVENT_TYPES = Object.freeze({
  TEXT_ROUND_REQUESTED: "outbound.text.round.requested",
  EMAIL_ROUND_REQUESTED: "outbound.email.round.requested",
  RVM_ROUND_REQUESTED: "outbound.rvm.round.requested",
  CX_ROUND_REQUESTED: "outbound.cx.round.requested",
  PHONEBURNER_ROUND_REQUESTED: "outbound.phoneburner.round.requested",
  TEXT_MANUAL_REQUESTED: "outbound.text.manual.requested",
  EMAIL_MANUAL_REQUESTED: "outbound.email.manual.requested",
  RVM_MANUAL_REQUESTED: "outbound.rvm.manual.requested",
  PHONEBURNER_MANUAL_REQUESTED: "outbound.phoneburner.manual.requested",
  CALLFIRE_MANUAL_REQUESTED: "outbound.callfire.manual.requested",
});

const neverBounceClient = createNeverBounceClient();
const PHONE_DISPATCH_CHANNELS = new Set(["sms", "rvm", "callfire", "phoneburner"]);

function normalizeDomain(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits.slice(-10);
}

function trimTrailingSlash(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function resolveRvmAudioUrl(domain, templateKey, explicitUrl = null) {
  const provided = String(explicitUrl || "").trim();
  if (provided) return provided;

  const key = String(templateKey || "").trim();
  if (!key || !/^prospect-rvm-\d+$/i.test(key)) return "";

  const base = trimTrailingSlash(process.env.RVM_AUDIO_BASE_URL || process.env.DROP_RVM_AUDIO_URL || "");
  if (!base) return "";

  const company = normalizeDomain(domain);
  return `${base}/${encodeURIComponent(company)}/${encodeURIComponent(key)}.wav`;
}

function isProspectCadenceTemplate(templateKey) {
  const value = String(templateKey || "").trim().toLowerCase();
  if (!value) return false;
  return (
    value === "prospect-welcome-email" ||
    value === "prospect-first-text" ||
    /^prospect-follow-up-\d+-email$/.test(value) ||
    /^prospect-follow-up-text-\d+$/.test(value)
  );
}

function resolveLeadCompanyByTrackingNumber(lead = {}) {
  const lockedContactDomain = normalizeDomain(
    lead.attributionContext?.contactDomain ||
      lead.payloadSnapshot?.contactDomain ||
      lead.domain,
  );
  if (
    lockedContactDomain &&
    (lead.attributionContext?.lockContactDomain || lead.payloadSnapshot?.lockContactDomain)
  ) {
    return lockedContactDomain;
  }

  const trackingCandidates = [
    lead.attributionContext?.trackingNumber,
    lead.payloadSnapshot?.trackingNumber,
    lead.trackingNumber,
    lead.destinationNumber,
  ];

  for (const candidate of trackingCandidates) {
    const normalized = normalizePhone(candidate);
    if (!normalized || normalized.length !== 10) continue;
    const resolved = resolveCompanyByTrackingNumber(normalized);
    if (resolved) return normalizeDomain(resolved);
  }

  return normalizeDomain(lead.domain);
}

function findLeadActionByKey(lead = {}, actionKey) {
  if (!actionKey) return null;
  return (lead.schedule?.actions || []).find(
    (entry) => String(entry?.key || "").trim() === String(actionKey).trim(),
  ) || null;
}

function hasPositiveConversationSignal(lead = {}) {
  return Boolean(
    lead?.cadenceState?.day0ConnectedAt ||
    lead?.cadenceState?.liveConversationAt ||
    lead?.cadenceState?.connectedConversationAt ||
    lead?.validationContext?.day0ConnectedAt ||
    lead?.payloadSnapshot?.day0ConnectedAt,
  );
}

function shouldSuppressProspectMessaging(companyKey, channel, templateKey) {
  return (
    normalizeDomain(companyKey) === "TAG" &&
    (channel === "sms" || channel === "email") &&
    isProspectCadenceTemplate(templateKey)
  );
}

function minuteBucketKey(date = new Date()) {
  return new Date(date.getTime() - (date.getSeconds() * 1000) - date.getMilliseconds())
    .toISOString()
    .slice(0, 16);
}

function logCallfireDebug(enabled, message, meta = {}) {
  if (!enabled) return;
  console.info(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: "info",
    scope: "outbound-gateway",
    message,
    meta,
  }));
}

function logOutboundProgress(message, meta = {}) {
  console.info(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: "info",
    scope: "outbound-gateway",
    message,
    meta,
  }));
}

function sleep(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeValidationWords(value) {
  return String(value || "").trim().toLowerCase();
}

function hasWord(haystack, word) {
  return new RegExp(`(^|\\b)${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\b|$)`, "i").test(haystack);
}

function isTrustedOptInLead(lead = {}) {
  const haystack = [
    lead.intakeSource,
    lead.intakeRoute,
    lead.sourceName,
    lead.attributionContext?.sourceName,
    lead.metadata?.intakeSource,
    lead.metadata?.sourceName,
  ]
    .filter(Boolean)
    .map(normalizeValidationWords)
    .join(" ");

  if (!haystack) return false;
  return (
    hasWord(haystack, "ld") ||
    haystack.includes("lead data") ||
    haystack.includes("ld-posting") ||
    haystack.includes("affiliate") ||
    haystack.includes("landing") ||
    haystack.includes("form")
  );
}

function hasEmbeddedConsentEvidence(lead = {}) {
  return Boolean(
    lead?.trustedFormCertUrl ||
    lead?.jornayaLeadId ||
    lead?.payloadSnapshot?.trustedFormCertUrl ||
    lead?.payloadSnapshot?.jornayaLeadId ||
    lead?.metadata?.trustedFormCertUrl ||
    lead?.metadata?.jornayaLeadId,
  );
}

async function hasStoredConsentEvidence(lead = {}) {
  const domain = normalizeDomain(lead.domain);
  if (!domain) return false;

  const queries = [];
  if (lead.caseId != null && Number.isFinite(Number(lead.caseId))) {
    queries.push(consentRecordRepository.countConsentRecords({
      domain,
      caseId: Number(lead.caseId),
      limit: 1,
    }));
  }
  if (lead.email) {
    queries.push(consentRecordRepository.countConsentRecords({
      domain,
      email: String(lead.email),
      limit: 1,
    }));
  }
  if (lead.primaryPhone || lead.normalizedPhone) {
    queries.push(consentRecordRepository.countConsentRecords({
      domain,
      phone: lead.primaryPhone || lead.normalizedPhone,
      limit: 1,
    }));
  }

  if (queries.length === 0) return false;
  const counts = await Promise.allSettled(queries);
  return counts.some((entry) => entry.status === "fulfilled" && Number(entry.value || 0) > 0);
}

function firstObject(...candidates) {
  return candidates.find((value) => value && typeof value === "object") || null;
}

function readCachedPhoneValidation(lead = {}) {
  const direct = firstObject(
    lead.validationContext?.phone,
    lead.payloadSnapshot?.validation?.phone,
    lead.payloadSnapshot?.validationContext?.phone,
    lead.metadata?.validation?.phone,
  );
  if (direct) {
    return {
      ...direct,
      phone: direct.phone || normalizePhone(lead.primaryPhone || lead.normalizedPhone),
      source: direct.source || "cached-intake-validation",
    };
  }

  const validation = firstObject(
    lead.validationContext,
    lead.payloadSnapshot?.validation,
    lead.payloadSnapshot?.validationContext,
  );
  if (
    validation &&
    (
      validation.phoneValid != null ||
      validation.phoneIsCell != null ||
      validation.phoneCanCall != null ||
      validation.phoneCanText != null
    )
  ) {
    return {
      phone: normalizePhone(lead.primaryPhone || lead.normalizedPhone),
      status: validation.phoneValid === false ? "invalid" : "cached",
      isConnected: validation.phoneValid !== false,
      isCell: validation.phoneIsCell === true,
      isLitigator: false,
      canCall:
        validation.phoneCanCall != null
          ? Boolean(validation.phoneCanCall)
          : validation.phoneValid != null
            ? Boolean(validation.phoneValid)
            : null,
      canText:
        validation.phoneCanText != null
          ? Boolean(validation.phoneCanText)
          : validation.phoneIsCell != null
            ? Boolean(validation.phoneIsCell)
            : null,
      source: "cached-validation-flags",
    };
  }

  const dncResult = firstObject(
    lead.cadenceState?.dncCheck?.lastResult,
    lead.cadenceState?.dncCheck?.initialResult,
    lead.payloadSnapshot?.dncCheck?.lastResult,
    lead.payloadSnapshot?.dncCheck?.initialResult,
  );
  if (dncResult) {
    return {
      mode: "dnc-only-cache",
      phone: normalizePhone(lead.primaryPhone || lead.normalizedPhone),
      status: "cached-dnc-only",
      isConnected: null,
      isCell: dncResult.isCell === true,
      onNationalDNC: Boolean(dncResult.onDnc || dncResult.onNationalDNC),
      onStateDNC: Boolean(dncResult.onStateDnc || dncResult.onStateDNC),
      isLitigator: Boolean(dncResult.isLitigator),
      canCall: dncResult.isLitigator ? false : null,
      canText: dncResult.isCell === false ? false : null,
      source: dncResult.source || "cached-dnc-check",
    };
  }

  return null;
}

function evaluateCachedPhoneValidation(lead, channel) {
  const normalizedChannel = String(channel || "").toLowerCase();
  const phone = normalizePhone(lead?.primaryPhone || lead?.normalizedPhone);
  if (!phone || phone.length !== 10) {
    return {
      ok: false,
      skipped: true,
      reason: "invalid-phone",
      detail: "Lead has no valid 10-digit phone number",
      validation: { phone: { phone: phone || null, status: "invalid" } },
    };
  }

  const phoneValidation = readCachedPhoneValidation(lead);
  if (!phoneValidation) {
    return {
      ok: true,
      validation: {
        phone: {
          phone,
          skipped: true,
          reason: "outbound-realvalidation-disabled",
          source: "intake-or-monthly-dnc-only",
        },
      },
    };
  }

  const explicitCanUse =
    normalizedChannel === "sms"
      ? phoneValidation.canText
      : phoneValidation.canCall;
  if (phoneValidation.isLitigator || explicitCanUse === false) {
    return {
      ok: false,
      skipped: true,
      reason: "phone-validation-failed",
      detail: phoneValidation.error || phoneValidation.status || null,
      validation: { phone: phoneValidation },
    };
  }

  return {
    ok: true,
    validation: { phone: phoneValidation },
  };
}

async function validateLeadForDispatch(lead, channel) {
  const normalizedChannel = String(channel || "").toLowerCase();
  const phone = lead?.primaryPhone || lead?.normalizedPhone || null;
  const email = lead?.email || null;
  const trustedOptIn =
    isTrustedOptInLead(lead) &&
    (hasEmbeddedConsentEvidence(lead) || await hasStoredConsentEvidence(lead));

  if (normalizedChannel === "email") {
    const emailValidation = await neverBounceClient.validateEmail(email);
    if (!emailValidation.canSend) {
      return {
        ok: false,
        skipped: true,
        reason: "email-validation-failed",
        detail: emailValidation.result || emailValidation.error || null,
        validation: { email: emailValidation },
      };
    }
    return {
      ok: true,
      validation: { email: emailValidation },
    };
  }

  if (PHONE_DISPATCH_CHANNELS.has(normalizedChannel) && !trustedOptIn) {
    return evaluateCachedPhoneValidation({ ...lead, primaryPhone: phone }, normalizedChannel);
  }

  return {
    ok: true,
    validation: {
      phone: trustedOptIn
        ? {
            skipped: true,
            reason: "trusted-opt-in-source",
          }
        : null,
    },
  };
}

function isLeadSuppressed(lead, caseProfile, dncStatusIds = []) {
  const dncStatusSet = new Set(dncStatusIds.map((value) => Number(value)));
  const aiStatus = String(caseProfile?.aiActivityReview?.status || "").toLowerCase();
  return (
    dncStatusSet.has(Number(lead.statusId)) ||
    Boolean(caseProfile?.conversationAi?.optOutDetected) ||
    aiStatus === "stop_contact" ||
    aiStatus === "pause_contact"
  );
}

function summarizeResults(results = []) {
  return {
    attempted: results.length,
    sent: results.filter((entry) => entry.ok).length,
    failed: results.filter((entry) => !entry.ok && !entry.result?.skipped).length,
    skipped: results.filter((entry) => entry.result?.skipped).length,
  };
}

async function updateDispatchProgress(dispatchListId, payload = {}) {
  if (!dispatchListId) return null;
  return dispatchListRepository.updateDispatchList(dispatchListId, {
    "stats.attemptedCount": Number(payload.attemptedCount || 0),
    "stats.successCount": Number(payload.successCount || 0),
    "stats.failedCount": Number(payload.failedCount || 0),
    lastResult: payload.lastResult || null,
  });
}

async function verifyCallfireLeadEligibility(domain, lead, expectedStatusId) {
  const facade = createLogicsFacade(domain);
  const fresh = await facade.fetchCaseInfo(lead.caseId);
  if (!fresh.ok) {
    return {
      ok: false,
      reason: "logics-status-check-failed",
      detail: fresh.error || "Unable to verify case status",
    };
  }

  const freshStatusId = Number(fresh.status);
  if (expectedStatusId != null && Number.isFinite(Number(expectedStatusId))) {
    const expected = Number(expectedStatusId);
    if (freshStatusId !== expected) {
      return {
        ok: false,
        reason: "status-mismatch",
        detail: `Expected status ${expected}, got ${freshStatusId}`,
        freshStatusId,
      };
    }
  }

  return {
    ok: true,
    freshStatusId,
  };
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

async function createCadenceSweepEvents({
  sourceService = "outbound-gateway",
  domains = getCompanyKeys(),
  now = new Date(),
} = {}) {
  const normalizedDomains = domains.map(normalizeDomain).filter(Boolean);
  const checks = [
    { channel: "sms", eventType: OUTBOUND_EVENT_TYPES.TEXT_ROUND_REQUESTED },
    { channel: "email", eventType: OUTBOUND_EVENT_TYPES.EMAIL_ROUND_REQUESTED },
    { channel: "rvm", eventType: OUTBOUND_EVENT_TYPES.RVM_ROUND_REQUESTED },
    { channel: "cx", eventType: OUTBOUND_EVENT_TYPES.CX_ROUND_REQUESTED },
  ];
  const bucket = minuteBucketKey(now);
  const accepted = [];

  for (const domain of normalizedDomains) {
    for (const check of checks) {
      const dueCount = await leadCadenceRepository.countDueLeadCadenceByChannel(domain, {
        channel: check.channel,
        now,
        statuses: check.channel === "cx" ? ["pending"] : ["pending", "requested"],
      });
      if (dueCount <= 0) continue;

      const result = await createOutboundEvent({
        eventType: check.eventType,
        sourceService,
        aggregateType: "outbound-cadence-sweep",
        aggregateId: `${domain}:${check.channel}`,
        dedupeKey: `cadence-sweep:${domain}:${check.channel}:${bucket}`,
        payload: {
          domain,
          mode: "round",
          channel: check.channel,
          dueCount,
          requestedAt: now.toISOString(),
        },
      });

      if (!result.deduped) {
        accepted.push({
          domain,
          channel: check.channel,
          dueCount,
          eventId: String(result.event?._id || result._id || ""),
        });
      }
    }
  }

  return {
    checkedDomains: normalizedDomains,
    accepted,
    bucket,
  };
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
    statuses: channel === "cx" ? ["pending"] : ["pending", "requested"],
  });
}

async function listTargetsForManual(payload) {
  if (payload.dispatchListId) {
    const dispatchList = await dispatchListRepository.findDispatchListById(payload.dispatchListId);
    if (!dispatchList) return [];

    return (dispatchList.items || []).map((item) => ({
      domain: dispatchList.domain,
      caseId: Number(item.caseId),
      _id: item.leadCadenceId || null,
      masterProspectId: item.masterProspectId || null,
      name: item.name || null,
      firstName: item.name ? String(item.name).trim().split(/\s+/)[0] : null,
      email: item.email || null,
      primaryPhone: item.primaryPhone || null,
      normalizedPhone: item.normalizedPhone || null,
      intakeSource: item.metadata?.intakeSource || null,
      intakeRoute: item.metadata?.intakeRoute || null,
      currentStage: item.metadata?.currentStage || null,
      sourceName: item.metadata?.sourceName || null,
      schedule: { actions: [] },
    }));
  }

  return leadCadenceRepository.listControlPlaneLeadCadenceByCaseIds(payload.domain, payload.caseIds || []);
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

async function recordOutboundLeadStage({
  domain,
  caseId,
  channel,
  stage,
  summary,
  payload,
}) {
  return recordWorkflowStage({
    domain: normalizeDomain(domain),
    family: "outbound",
    subtype: `${channel}-lead`,
    stage,
    aggregateType: "lead-cadence",
    aggregateId: String(caseId),
    caseId: Number(caseId),
    sourceService: "outbound-gateway",
    summary,
    payload,
  });
}

async function recordCallfireLeadStep({
  domain,
  caseId,
  stage,
  summary,
  payload,
}) {
  return recordOutboundLeadStage({
    domain,
    caseId,
    channel: "callfire",
    stage,
    summary,
    payload,
  });
}

function summarizeCallfireResults(results = []) {
  const skippedByReason = {};
  const failedByReason = {};
  const broadcastIds = new Set();
  let verified = 0;
  let dispatched = 0;

  for (const entry of results) {
    const reason = String(entry?.result?.reason || entry?.result?.error || "unknown");
    if (entry?.result?.freshStatusId != null) {
      verified += 1;
    }
    if (entry?.ok) {
      dispatched += 1;
      if (entry?.result?.broadcastId) {
        broadcastIds.add(String(entry.result.broadcastId));
      }
      continue;
    }
    if (entry?.result?.skipped) {
      skippedByReason[reason] = (skippedByReason[reason] || 0) + 1;
      continue;
    }
    failedByReason[reason] = (failedByReason[reason] || 0) + 1;
  }

  return {
    verified,
    dispatched,
    skippedByReason,
    failedByReason,
    broadcastIds: [...broadcastIds],
  };
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
  queueDepth = 1,
}) {
  const action = updateCadence ? pickAction(lead, channel, actionType) : null;
  const actionKey = action?.key || `${channel}-${actionType || "manual"}`;
  const effectiveTemplateKey = templateKey || action?.templateKey || null;
  const domain = lead.domain;
  const contactDomain = resolveLeadCompanyByTrackingNumber(lead) || domain;
  const caseId = lead.caseId;

  if (action && action.status && action.status !== "pending") {
    const result = {
      ok: false,
      skipped: true,
      reason: "action-already-claimed",
      detail: `Cadence action ${actionKey} is already ${action.status}`,
    };
    await recordOutboundLeadStage({
      domain,
      caseId,
      channel,
      stage: "skipped",
      summary: result.detail,
      payload: {
        actionType,
        actionKey,
        result,
      },
    });
    return { caseId, ok: false, result };
  }

  if (action?.contingentOnActionKey) {
    const contingentAction = findLeadActionByKey(lead, action.contingentOnActionKey);
    if (contingentAction && (contingentAction.status === "pending" || contingentAction.status === "requested")) {
      await leadCadenceRepository.rescheduleScheduledAction(
        domain,
        caseId,
        actionKey,
        new Date(Date.now() + 5 * 60 * 1000),
        { currentStage: `${channel}-waiting-on-${contingentAction.key}` },
      );
      const result = {
        ok: false,
        skipped: true,
        reason: "waiting-on-contingent-action",
        detail: `${actionKey} deferred until ${contingentAction.key} resolves`,
        contingentOnActionKey: action.contingentOnActionKey,
      };
      await recordOutboundLeadStage({
        domain,
        caseId,
        channel,
        stage: "deferred",
        summary: result.detail,
        payload: {
          actionType,
          actionKey,
          result,
        },
      });
      return { caseId, ok: false, result };
    }

    if (action.contingencyMode === "skip-if-connected" && hasPositiveConversationSignal(lead)) {
      await leadCadenceRepository.markScheduledActionStatus(
        domain,
        caseId,
        actionKey,
        "cancelled",
        { currentStage: `${channel}-skipped-after-connection` },
      );
      const result = {
        ok: false,
        skipped: true,
        reason: "connected-before-contingent-followup",
        detail: `${actionKey} cancelled because a live conversation signal exists`,
        contingentOnActionKey: action.contingentOnActionKey,
      };
      await recordOutboundLeadStage({
        domain,
        caseId,
        channel,
        stage: "skipped",
        summary: result.detail,
        payload: {
          actionType,
          actionKey,
          result,
        },
      });
      return { caseId, ok: false, result };
    }
  }

  // Per-channel DNC gate. Set by `markChannelDnc` after a permanent
  // provider rejection (CallRail "opted out", Drop national-DNC,
  // SendGrid hard bounce, etc.). Lead is NOT deactivated — only this
  // channel is blocked. Other channels keep firing per their own
  // schedules. Distinct from `resolveCaseContactEligibility` which is
  // lead-level and shuts everything down.
  const channelDnc = leadCadenceRepository.evaluateChannelDnc(lead.cadenceState, channel);
  if (channelDnc.blocked) {
    if (action) {
      // Cancel this pending action so the scheduler stops offering it
      // every tick. The DNC flag itself is the durable signal — the
      // action cancellation is just bookkeeping so the queue stays
      // clean. Lead remains active.
      await leadCadenceRepository.markScheduledActionStatus(
        domain,
        caseId,
        actionKey,
        "cancelled",
        { currentStage: `${channel}-channel-dnc` },
      );
    }
    const result = {
      ok: false,
      skipped: true,
      reason: "channel-dnc",
      detail: `${channel} disabled for this lead: ${channelDnc.reason || "unknown"}`,
      channelDnc,
    };
    await recordOutboundLeadStage({
      domain,
      caseId,
      channel,
      stage: "skipped",
      summary: result.detail,
      payload: {
        actionType,
        actionKey,
        result,
      },
    });
    return { caseId, ok: false, result };
  }

  if (shouldSuppressProspectMessaging(contactDomain, channel, effectiveTemplateKey)) {
    if (action) {
      await leadCadenceRepository.markScheduledActionStatus(
        domain,
        caseId,
        actionKey,
        "cancelled",
        { currentStage: `${channel}-disabled-for-company` },
      );
    }
    const result = {
      ok: false,
      skipped: true,
      reason: "company-channel-disabled",
      detail: `${channel} cadence is disabled for ${contactDomain}`,
      contactDomain,
    };
    await recordOutboundLeadStage({
      domain,
      caseId,
      channel,
      stage: "skipped",
      summary: result.detail,
      payload: {
        actionType,
        actionKey,
        templateKey: effectiveTemplateKey,
        result,
      },
    });
    return { caseId, ok: false, result };
  }

  // Eligibility check MUST run before claiming — otherwise a case that
  // hit stop-contact between sweep and dispatch leaves the action
  // stuck in `requested` with no rollback. Check first, cancel the
  // action if blocked (terminal for this case), only claim when
  // downstream dispatch is actually going to run.
  const eligibility = await resolveCaseContactEligibility(domain, caseId, {
    enforceStop: true,
    requireFreshLogicsStatus: true,
    currentStage: "contact-blocked",
    sourceService: "outbound-gateway",
  });
  if (!eligibility.ok) {
    if (action) {
      // Contact-stop is terminal — cancel the pending action so the
      // scheduler stops offering it, rather than leaving it floating
      // in pending status.
      await leadCadenceRepository.markScheduledActionStatus(
        domain,
        caseId,
        actionKey,
        "cancelled",
        { currentStage: `${channel}-blocked` },
      );
    }
    const result = {
      ok: false,
      skipped: true,
      reason: eligibility.reason,
      detail: eligibility.detail || null,
    };
    await recordOutboundLeadStage({
      domain,
      caseId,
      channel,
      stage: "skipped",
      summary: eligibility.detail || "Contact blocked before dispatch",
      payload: {
        actionType,
        actionKey,
        result,
      },
    });
    return { caseId, ok: false, result };
  }

  const rateLimit = evaluateOutboundRateLimit({
    domain,
    channel,
    now: new Date(),
    queueDepth,
    consume: false,
  });
  if (!rateLimit.allowed) {
    if (action) {
      await leadCadenceRepository.rescheduleScheduledAction(
        domain,
        caseId,
        actionKey,
        rateLimit.nextAllowedAt || new Date(Date.now() + 60 * 1000),
        { currentStage: `${channel}-rate-limited` },
      );
    }
    const result = {
      ok: false,
      skipped: true,
      reason: "rate-limited",
      detail:
        `Deferred until ${rateLimit.nextAllowedAt?.toISOString() || "later"} ` +
        `(${channel} ${rateLimit.remainingTokens}/${rateLimit.capacity} tokens left)`,
      rateLimit,
    };
    await recordOutboundLeadStage({
      domain,
      caseId,
      channel,
      stage: "deferred",
      summary: result.detail,
      payload: {
        actionType,
        actionKey,
        result,
      },
    });
    return { caseId, ok: false, result };
  }

  if (action && updateCadence) {
    const claimed = await leadCadenceRepository.claimScheduledAction(domain, caseId, actionKey, {
      currentStage: `${channel}-requested`,
    });
    if (!claimed) {
      const result = {
        ok: false,
        skipped: true,
        reason: "action-claim-conflict",
        detail: `Cadence action ${actionKey} was claimed by another worker`,
      };
      await recordOutboundLeadStage({
        domain,
        caseId,
        channel,
        stage: "skipped",
        summary: result.detail,
        payload: {
          actionType,
          actionKey,
          result,
        },
      });
      return { caseId, ok: false, result };
    }
  }

  // Per-lead opt-in bypass of the contact-timing gate. The smoke harness
  // (and any future internal test) sets this flag on a marked
  // LeadCadence row so a single SMS/email can fire outside the normal
  // quiet-hours window. The global timing policy in
  // contactTimingPolicyService is UNCHANGED — only leads with this
  // explicit per-lead opt-in skip the gate.
  const bypassMap = (lead && lead.cadenceState && lead.cadenceState.bypassChannelTiming) || {};
  const bypassTiming = Boolean(bypassMap[channel] || bypassMap.all);

  const timing = bypassTiming
    ? {
        allowed: true,
        restricted: false,
        timezone: null,
        channel,
        nextAllowedAt: new Date(),
        reason: "bypass-test-lead",
        policy: {},
      }
    : evaluateChannelContactTime(domain, channel, new Date());
  if (!timing.allowed) {
    if (action) {
      await leadCadenceRepository.rescheduleScheduledAction(
        domain,
        caseId,
        actionKey,
        timing.nextAllowedAt,
        { currentStage: `${channel}-deferred` },
      );
    }
    const result = {
      ok: false,
      skipped: true,
      reason: timing.reason,
      detail: `Deferred until ${timing.nextAllowedAt.toISOString()} (${timing.timezone})`,
      deferUntil: timing.nextAllowedAt,
      timezone: timing.timezone,
    };
    await recordOutboundLeadStage({
      domain,
      caseId,
      channel,
      stage: "deferred",
      summary: result.detail,
      payload: {
        actionType,
        actionKey,
        result,
      },
    });
    return { caseId, ok: false, result };
  }

  // Frequency-cap guard — enforce per-channel weekly/total caps stored
  // in `cadenceState.caps`. Computed AFTER the quiet-hours check so a
  // temporarily-deferred action doesn't count against the cap.
  const frequencyCheck = evaluateFrequencyCap(lead.cadenceState, channel);
  if (!frequencyCheck.allowed) {
    if (action) {
      await leadCadenceRepository.markScheduledActionStatus(
        domain,
        caseId,
        actionKey,
        "cancelled",
        { currentStage: `${channel}-cap-exhausted` },
      );
    }
    const result = {
      ok: false,
      skipped: true,
      reason: frequencyCheck.reason,
      detail: `Channel "${channel}" cap hit (${frequencyCheck.remaining} remaining)`,
    };
    await recordOutboundLeadStage({
      domain,
      caseId,
      channel,
      stage: "cap-exhausted",
      summary: result.detail,
      payload: { actionType, actionKey, result, cap: lead.cadenceState?.caps?.[channel] },
    });
    return { caseId, ok: false, result };
  }

  const validation = await validateLeadForDispatch(lead, channel);
  if (!validation.ok) {
    if (action) {
      await leadCadenceRepository.markScheduledActionStatus(domain, caseId, actionKey, "failed", {
        currentStage: `${channel}-failed`,
      });
    }
    await recordOutboundLeadStage({
      domain,
      caseId,
      channel,
      stage: validation.skipped ? "skipped" : "failed",
      summary: validation.detail || validation.reason || `${channel} validation failed`,
      payload: {
        actionType,
        actionKey,
        result: validation,
      },
    });
    return { caseId, ok: false, result: validation };
  }

  const committedRateLimit = evaluateOutboundRateLimit({
    domain,
    channel,
    now: new Date(),
    queueDepth,
    consume: true,
  });
  if (!committedRateLimit.allowed) {
    if (action) {
      await leadCadenceRepository.rescheduleScheduledAction(
        domain,
        caseId,
        actionKey,
        committedRateLimit.nextAllowedAt || new Date(Date.now() + 60 * 1000),
        { currentStage: `${channel}-rate-limited` },
      );
    }
    const result = {
      ok: false,
      skipped: true,
      reason: "rate-limited",
      detail:
        `Deferred until ${committedRateLimit.nextAllowedAt?.toISOString() || "later"} ` +
        `(${channel} ${committedRateLimit.remainingTokens}/${committedRateLimit.capacity} tokens left)`,
      rateLimit: committedRateLimit,
    };
    await recordOutboundLeadStage({
      domain,
      caseId,
      channel,
      stage: "deferred",
      summary: result.detail,
      payload: {
        actionType,
        actionKey,
        result,
      },
    });
    return { caseId, ok: false, result };
  }

  await recordOutboundLeadStage({
    domain,
    caseId,
    channel,
    stage: "attempting",
    summary: `Attempting ${channel} dispatch`,
    payload: {
      actionType,
      actionKey,
      updateCadence,
      templateKey: effectiveTemplateKey,
      rateLimit: committedRateLimit,
    },
  });

  let result = null;
  try {
    if (channel === "sms") {
      const smsContent =
        content ||
        resolveCadenceSmsContent({
          domain: contactDomain,
          templateKey: effectiveTemplateKey,
          name: lead.firstName || lead.name || "",
        }) ||
        `Hi ${lead.firstName || lead.name || "there"}, we're following up on your recent inquiry.`;
      result = await sendOutboundText({
        domain: contactDomain,
        toPhone: lead.primaryPhone || lead.normalizedPhone,
        trackingNumber: trackingNumber || lead.attributionContext?.trackingNumber || null,
        content: smsContent,
        actionKey,
        caseId,
      });
    } else if (channel === "email") {
      const cadenceEmail =
        resolveCadenceEmailContent({
          domain: contactDomain,
          templateKey: effectiveTemplateKey,
          name: lead.firstName || lead.name || "",
        }) || null;
      result = await sendOutboundEmail({
        domain: contactDomain,
        toEmail: lead.email,
        subject: subject || cadenceEmail?.subject,
        text: content || cadenceEmail?.text,
        html: cadenceEmail?.html,
        name: lead.firstName || lead.name,
        attachments: cadenceEmail?.attachments || [],
      });
    } else if (channel === "rvm") {
      const resolvedAudioUrl = resolveRvmAudioUrl(domain, effectiveTemplateKey, audioUrl);
      result = await sendOutboundRvm({
        domain,
        toPhone: lead.primaryPhone || lead.normalizedPhone,
        caseId,
        name: lead.name,
        source: effectiveTemplateKey || "cadence",
        audioUrl: resolvedAudioUrl,
        actionKey,
      });
    } else if (channel === "phoneburner") {
      result = await requestPhoneBurnerDispatch({
        domain,
        caseId,
        phone: lead.primaryPhone || lead.normalizedPhone,
        name: lead.name,
      });
    } else if (channel === "callfire") {
      result = await sendOutboundCallFireDial({
        toPhone: lead.primaryPhone || lead.normalizedPhone,
        name: lead.name,
        caseId,
        broadcastName: effectiveTemplateKey || null,
        messageText: content || null,
      });
    } else if (channel === "cx") {
      const cxEvent = await createEvent({
        eventType: "cx.dial.requested",
        sourceService: "outbound-gateway",
        aggregateType: "case",
        aggregateId: String(caseId),
        dedupeKey: `${domain}:${caseId}:${actionKey}:cx-dial`,
        payload: {
          domain,
          caseId,
          leadCadenceId: lead?._id ? String(lead._id) : null,
          actionKey,
          phone: lead.primaryPhone || lead.normalizedPhone || null,
          name: lead.name || null,
          intakeSource: lead.intakeSource || null,
          intakeRoute: lead.intakeRoute || null,
          sourceName: lead.sourceName || null,
          state: lead.state || lead.payloadSnapshot?.state || null,
          timezone:
            lead.cadenceState?.timezone ||
            lead.cadenceState?.timeZone ||
            lead.payloadSnapshot?.timezone ||
            lead.payloadSnapshot?.timeZone ||
            null,
          requestedBy: "cadence-engine",
          executionOwner: "ringcentral-cx",
          futureAdapterPort: 6101,
        },
      });
      result = {
        ok: true,
        queued: true,
        eventId: String(cxEvent?.event?._id || cxEvent?._id || ""),
        reason: "cx-dial-requested",
      };
    } else {
      result = { ok: false, skipped: true, reason: `unsupported-channel:${channel}` };
    }
  } catch (error) {
    result = {
      ok: false,
      error: error.message,
      reason: "dispatch-exception",
    };
  }

  if (result.ok) {
    const queuedForCx = channel === "cx" && result.queued;
    await recordOutboundLeadStage({
      domain,
      caseId,
      channel,
      stage: queuedForCx ? "requested" : "completed",
      summary: queuedForCx ? `${channel} dispatch queued` : `${channel} dispatch completed`,
      payload: {
        actionType,
        actionKey,
        result,
      },
    });
    if (action) {
      // For rvm: stamp the Drop activity token onto the action so the
      // disposition poller can later look it up and resolve the actual
      // outcome. Drop's /delivery/ POST returns 1038 ("API Post
      // Accepted") immediately, but the actual disposition (delivered
      // / DNC-rejected / number-disconnected) only surfaces via
      // VMDropStatus polling minutes-to-hours later.
      let actionPatch = null;
      if (channel === "rvm" && result?.response?.ActivityToken) {
        actionPatch = {
          providerDelivery: {
            provider: "drop",
            activityToken: String(result.response.ActivityToken),
            statusUrl: result.response.VmDropStatusUrl || null,
            postedAt: new Date(),
            lastPolledAt: null,
            pollAttempts: 0,
            disposition: null,
          },
        };
      }
      await leadCadenceRepository.markScheduledActionStatus(domain, caseId, actionKey, queuedForCx ? "requested" : "completed", {
        currentStage: queuedForCx ? `${channel}-queued` : `${channel}-sent`,
        ...(actionPatch ? { actionPatch } : {}),
      });
      await leadCadenceRepository.syncLeadCadenceState(domain, caseId);
    }
    if (!queuedForCx) {
      await metricsSnapshotRepository.recordMetricEvent(domain, {
        metricName: "contacts_sent",
        sourceKey: channel,
        amount: 1,
        caseId,
        title: `${channel} contact sent`,
        eventType: `outbound.${channel}.completed`,
        happenedAt: new Date(),
      });
    }
    return { caseId, ok: true, result };
  }

  if (action) {
    await leadCadenceRepository.markScheduledActionStatus(domain, caseId, actionKey, "failed", {
      currentStage: `${channel}-failed`,
    });
    await leadCadenceRepository.syncLeadCadenceState(domain, caseId);
  }

  // Emit an hourly cleanup job so delivery failures have a retry/cancel
  // path identical to SMS and RVM. The handler flips the pending
  // action to cancelled; we never blindly re-dial. Channels without a
  // dedicated handler fall through to a generic cancel.
  const handlerByChannel = {
    sms: "cancelFailedOutboundText",
    rvm: "cancelFailedOutboundRvm",
    callfire: "cancelFailedOutboundCallfireDial",
  };
  const handlerKey = handlerByChannel[channel];
  if (action && handlerKey && !result?.skipped) {
    try {
      await emitHourlyJobEvent({
        lane: "hourly",
        domain,
        eventType: `outbound.${channel}.reconcile`,
        targetService: "outbound-gateway",
        handlerKey,
        aggregateType: "lead-cadence-action",
        aggregateId: String(actionKey),
        caseId,
        payload: {
          actionKey,
          channel,
          reason: result?.reason || null,
          providerError: result?.error || null,
          phone: lead.primaryPhone || lead.normalizedPhone || null,
          notifyOnResolution: false,
        },
        resolutionCheckKey: "outbound-delivery-state",
        dedupeKey: `${domain}:outbound-fail:${caseId}:${actionKey}`,
        emittedBy: "outbound-gateway",
        priority: 60,
        severity: "warning",
        firstError: result?.error || result?.reason || `${channel} dispatch failed`,
        notes: `${channel} dispatch failure reconcile`,
        notify: false,
      });
    } catch {
      // Emission is best-effort; the review item below is the primary
      // operator-visible artifact of this failure.
    }
  }

  if (result?.skipped) {
    await recordOutboundLeadStage({
      domain,
      caseId,
      channel,
      stage: "skipped",
      summary: result.reason || `${channel} dispatch skipped`,
      payload: {
        actionType,
        actionKey,
        result,
      },
    });
    return { caseId, ok: false, result };
  }
  await recordOutboundLeadStage({
    domain,
    caseId,
    channel,
    stage: "failed",
    summary: result.reason || result.error || `${channel} dispatch failed`,
    payload: {
      actionType,
      actionKey,
      result,
    },
  });
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
  await metricsSnapshotRepository.recordMetricEvent(domain, {
    metricName: "contacts_failed",
    sourceKey: channel,
    amount: 1,
    caseId,
    title: `${channel} contact failed`,
    eventType: `outbound.${channel}.failed`,
    happenedAt: new Date(),
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

  for (let index = 0; index < leads.length; index += 1) {
    const lead = leads[index];
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
        queueDepth: Math.max(leads.length - index, 1),
      }),
    );
  }

  const summary = {
    channel,
    mode: "round",
    selected: leads.length,
    sent: results.filter((entry) => entry.ok).length,
    failed: results.filter((entry) => !entry.ok && !entry.result?.skipped).length,
    skipped: results.filter((entry) => entry.result?.skipped).length,
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
  const config = getSharedConfig();
  const caseProfiles = await caseProfileRepository.listCaseProfilesByCaseIds(
    payload.domain,
    leads.map((lead) => lead.caseId),
  );
  const caseProfileByCaseId = new Map(caseProfiles.map((profile) => [Number(profile.caseId), profile]));
  const results = [];
  const callfireDebugEnabled = channel === "callfire" && Boolean(config.outboundCallfireDebug);
  const ratePerMinute = Math.max(Number(payload.ratePerMinute) || 0, 0);

  logCallfireDebug(callfireDebugEnabled, "outbound.callfire.manual.start", {
    dispatchListId: payload.dispatchListId || null,
    domain: payload.domain,
    leadCount: leads.length,
    statusId: payload.statusId ?? null,
    ratePerMinute: ratePerMinute || null,
  });

  if (channel === "callfire") {
    const approvedRecipients = [];

    for (const lead of leads) {
      const caseProfile = caseProfileByCaseId.get(Number(lead.caseId)) || null;
      logCallfireDebug(callfireDebugEnabled, "outbound.callfire.manual.lead_selected", {
        caseId: lead.caseId,
        phone: lead.primaryPhone || lead.normalizedPhone || null,
        sourceName: lead.sourceName || null,
      });
      await recordCallfireLeadStep({
        domain: payload.domain,
        caseId: lead.caseId,
        stage: "selected",
        summary: "CallFire lead selected for manual dialer run",
        payload: {
          expectedStatusId: payload.statusId ?? null,
          intakeSource: lead.intakeSource || null,
          currentStage: lead.currentStage || null,
        },
      });
      await recordCallfireLeadStep({
        domain: payload.domain,
        caseId: lead.caseId,
        stage: "checking-suppression",
        summary: "Checking suppression and DNC state before CallFire dial",
        payload: {
          statusId: lead.statusId ?? null,
        },
      });

      const caseEligibility = await resolveCaseContactEligibility(payload.domain, lead.caseId, {
        enforceStop: true,
        requireFreshLogicsStatus: true,
        currentStage: "contact-blocked",
        sourceService: "outbound-gateway",
      });
      if (!caseEligibility.ok) {
        logCallfireDebug(callfireDebugEnabled, "outbound.callfire.manual.lead_skipped", {
          caseId: lead.caseId,
          reason: caseEligibility.reason,
          detail: caseEligibility.detail || null,
        });
        await recordCallfireLeadStep({
          domain: payload.domain,
          caseId: lead.caseId,
          stage: "skipped",
          summary: caseEligibility.detail || "CallFire skipped after case-level contact check",
          payload: {
            reason: caseEligibility.reason,
          },
        });
        results.push({
          caseId: lead.caseId,
          ok: false,
          result: {
            ok: false,
            skipped: true,
            reason: caseEligibility.reason,
            detail: caseEligibility.detail || null,
          },
        });
        continue;
      }

      if (isLeadSuppressed(lead, caseProfile, config.logicsDncStatusIds)) {
        logCallfireDebug(callfireDebugEnabled, "outbound.callfire.manual.lead_skipped", {
          caseId: lead.caseId,
          reason: "suppressed-or-dnc",
        });
        await recordCallfireLeadStep({
          domain: payload.domain,
          caseId: lead.caseId,
          stage: "skipped",
          summary: "CallFire skipped due to suppression or DNC",
          payload: {
            reason: "suppressed-or-dnc",
            statusId: lead.statusId ?? null,
            optOutDetected: Boolean(caseProfile?.conversationAi?.optOutDetected),
            aiActivityStatus: caseProfile?.aiActivityReview?.status || null,
          },
        });
        results.push({
          caseId: lead.caseId,
          ok: false,
          result: { ok: false, skipped: true, reason: "suppressed-or-dnc" },
        });
        continue;
      }

      const validation = await validateLeadForDispatch(lead, channel);
      if (!validation.ok) {
        logCallfireDebug(callfireDebugEnabled, "outbound.callfire.manual.lead_skipped", {
          caseId: lead.caseId,
          reason: validation.reason,
          detail: validation.detail || null,
        });
        await recordCallfireLeadStep({
          domain: payload.domain,
          caseId: lead.caseId,
          stage: "skipped",
          summary: validation.detail || "CallFire skipped after phone validation",
          payload: {
            reason: validation.reason,
            validation: validation.validation || null,
          },
        });
        results.push({
          caseId: lead.caseId,
          ok: false,
          result: validation,
        });
        continue;
      }

      await recordCallfireLeadStep({
        domain: payload.domain,
        caseId: lead.caseId,
        stage: "verifying",
        summary: "Verifying current Logics status before CallFire dial",
        payload: {
          expectedStatusId: payload.statusId ?? null,
        },
      });
      const eligibility = await verifyCallfireLeadEligibility(payload.domain, lead, payload.statusId);
      if (!eligibility.ok) {
        logCallfireDebug(callfireDebugEnabled, "outbound.callfire.manual.lead_skipped", {
          caseId: lead.caseId,
          reason: eligibility.reason,
          detail: eligibility.detail || null,
          freshStatusId: eligibility.freshStatusId ?? null,
        });
        await recordCallfireLeadStep({
          domain: payload.domain,
          caseId: lead.caseId,
          stage: "skipped",
          summary: eligibility.detail || "CallFire skipped after Logics status check",
          payload: {
            reason: eligibility.reason,
            expectedStatusId: payload.statusId ?? null,
            freshStatusId: eligibility.freshStatusId ?? null,
          },
        });
        results.push({
          caseId: lead.caseId,
          ok: false,
          result: {
            ok: false,
            skipped: true,
            reason: eligibility.reason,
            detail: eligibility.detail || null,
            freshStatusId: eligibility.freshStatusId ?? null,
          },
        });
        continue;
      }

      await recordCallfireLeadStep({
        domain: payload.domain,
        caseId: lead.caseId,
        stage: "verified",
        summary: "Logics status verified for CallFire dial",
        payload: {
          expectedStatusId: payload.statusId ?? null,
          freshStatusId: eligibility.freshStatusId ?? null,
        },
      });
      approvedRecipients.push({
        caseId: lead.caseId,
        toPhone: lead.primaryPhone || lead.normalizedPhone,
        name: lead.name,
      });
    }

    if (approvedRecipients.length > 0) {
      logCallfireDebug(callfireDebugEnabled, "outbound.callfire.manual.batch_dispatching", {
        dispatchListId: payload.dispatchListId || null,
        recipientCount: approvedRecipients.length,
        ratePerMinute: ratePerMinute || null,
      });
      const batchResult = await sendOutboundCallFireDialBatch({
        recipients: approvedRecipients,
        broadcastName: payload.templateKey || null,
        messageText: payload.content || null,
        maxActive: ratePerMinute || 1,
      });

      for (const recipient of approvedRecipients) {
        if (batchResult.ok) {
          await recordOutboundLeadStage({
            domain: payload.domain,
            caseId: recipient.caseId,
            channel,
            stage: "completed",
            summary: `${channel} dispatch completed`,
            payload: {
              actionType: payload.actionType || null,
              actionKey: `${channel}-manual`,
              result: {
                ok: true,
                broadcastId: batchResult.broadcastId,
              },
            },
          });
          await metricsSnapshotRepository.recordMetricEvent(payload.domain, {
            metricName: "contacts_sent",
            sourceKey: channel,
            amount: 1,
            caseId: recipient.caseId,
            title: `${channel} contact sent`,
            eventType: `outbound.${channel}.completed`,
            happenedAt: new Date(),
          });
          results.push({
            caseId: recipient.caseId,
            ok: true,
            result: {
              ok: true,
              broadcastId: batchResult.broadcastId,
            },
          });
        } else {
          await recordOutboundLeadStage({
            domain: payload.domain,
            caseId: recipient.caseId,
            channel,
            stage: "failed",
            summary: batchResult.reason || batchResult.error || `${channel} dispatch failed`,
            payload: {
              actionType: payload.actionType || null,
              actionKey: `${channel}-manual`,
              result: batchResult,
            },
          });
          await recordOutboundFailure({
            domain: payload.domain,
            caseId: recipient.caseId,
            title: `${channel.toUpperCase()} dispatch needs review`,
            summary: batchResult.reason || batchResult.error || "Outbound dispatch failed",
            payload: {
              channel,
              result: batchResult,
              caseId: recipient.caseId,
            },
          });
          results.push({
            caseId: recipient.caseId,
            ok: false,
            result: batchResult,
          });
        }
      }
    }

    const summary = {
      channel,
      mode: "manual",
      selected: leads.length,
      sent: results.filter((entry) => entry.ok).length,
      failed: results.filter((entry) => !entry.ok && !entry.result?.skipped).length,
      skipped: results.filter((entry) => entry.result?.skipped).length,
      results,
    };

    summary.callfireSummary = summarizeCallfireResults(results);
    logCallfireDebug(callfireDebugEnabled, "outbound.callfire.manual.complete", {
      dispatchListId: payload.dispatchListId || null,
      selected: summary.selected,
      sent: summary.sent,
      failed: summary.failed,
      skipped: summary.skipped,
      ...summary.callfireSummary,
    });

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

  const pulseSize = Math.max(Number(payload.pulseSize) || 0, 0) || leads.length || 1;
  const pulseDelayMs = Math.max(Number(payload.pulseDelayMs) || 0, 0);

  for (let start = 0; start < leads.length; start += pulseSize) {
    const pulse = leads.slice(start, start + pulseSize);

    for (const lead of pulse) {
    const caseProfile = caseProfileByCaseId.get(Number(lead.caseId)) || null;
    if (channel === "callfire") {
      logCallfireDebug(callfireDebugEnabled, "outbound.callfire.manual.lead_selected", {
        caseId: lead.caseId,
        phone: lead.primaryPhone || lead.normalizedPhone || null,
        sourceName: lead.sourceName || null,
      });
      await recordCallfireLeadStep({
        domain: payload.domain,
        caseId: lead.caseId,
        stage: "selected",
        summary: "CallFire lead selected for manual dialer run",
        payload: {
          expectedStatusId: payload.statusId ?? null,
          intakeSource: lead.intakeSource || null,
          currentStage: lead.currentStage || null,
        },
      });
      await recordCallfireLeadStep({
        domain: payload.domain,
        caseId: lead.caseId,
        stage: "checking-suppression",
        summary: "Checking suppression and DNC state before CallFire dial",
        payload: {
          statusId: lead.statusId ?? null,
        },
      });
    }
    const caseEligibility = await resolveCaseContactEligibility(payload.domain, lead.caseId, {
      enforceStop: true,
      requireFreshLogicsStatus: true,
      currentStage: "contact-blocked",
      sourceService: "outbound-gateway",
    });
    if (!caseEligibility.ok) {
      if (channel === "callfire") {
        logCallfireDebug(callfireDebugEnabled, "outbound.callfire.manual.lead_skipped", {
          caseId: lead.caseId,
          reason: caseEligibility.reason,
          detail: caseEligibility.detail || null,
        });
        await recordCallfireLeadStep({
          domain: payload.domain,
          caseId: lead.caseId,
          stage: "skipped",
          summary: caseEligibility.detail || "CallFire skipped after case-level contact check",
          payload: {
            reason: caseEligibility.reason,
          },
        });
      }
      results.push({
        caseId: lead.caseId,
        ok: false,
        result: {
          ok: false,
          skipped: true,
          reason: caseEligibility.reason,
          detail: caseEligibility.detail || null,
        },
      });
      continue;
    }
    if (channel === "callfire" && isLeadSuppressed(lead, caseProfile, config.logicsDncStatusIds)) {
      logCallfireDebug(callfireDebugEnabled, "outbound.callfire.manual.lead_skipped", {
        caseId: lead.caseId,
        reason: "suppressed-or-dnc",
      });
      await recordCallfireLeadStep({
        domain: payload.domain,
        caseId: lead.caseId,
        stage: "skipped",
        summary: "CallFire skipped due to suppression or DNC",
        payload: {
          reason: "suppressed-or-dnc",
          statusId: lead.statusId ?? null,
          optOutDetected: Boolean(caseProfile?.conversationAi?.optOutDetected),
          aiActivityStatus: caseProfile?.aiActivityReview?.status || null,
        },
      });
      results.push({
        caseId: lead.caseId,
        ok: false,
        result: { ok: false, skipped: true, reason: "suppressed-or-dnc" },
      });
      continue;
    }
    if (channel === "callfire") {
      await recordCallfireLeadStep({
        domain: payload.domain,
        caseId: lead.caseId,
        stage: "verifying",
        summary: "Verifying current Logics status before CallFire dial",
        payload: {
          expectedStatusId: payload.statusId ?? null,
        },
      });
      const eligibility = await verifyCallfireLeadEligibility(payload.domain, lead, payload.statusId);
      if (!eligibility.ok) {
        logCallfireDebug(callfireDebugEnabled, "outbound.callfire.manual.lead_skipped", {
          caseId: lead.caseId,
          reason: eligibility.reason,
          detail: eligibility.detail || null,
          freshStatusId: eligibility.freshStatusId ?? null,
        });
        await recordCallfireLeadStep({
          domain: payload.domain,
          caseId: lead.caseId,
          stage: "skipped",
          summary: eligibility.detail || "CallFire skipped after Logics status check",
          payload: {
            reason: eligibility.reason,
            expectedStatusId: payload.statusId ?? null,
            freshStatusId: eligibility.freshStatusId ?? null,
          },
        });
        results.push({
          caseId: lead.caseId,
          ok: false,
          result: {
            ok: false,
            skipped: true,
            reason: eligibility.reason,
            detail: eligibility.detail || null,
            freshStatusId: eligibility.freshStatusId ?? null,
          },
        });
        continue;
      }
      await recordCallfireLeadStep({
        domain: payload.domain,
        caseId: lead.caseId,
        stage: "verified",
        summary: "Logics status verified for CallFire dial",
        payload: {
          expectedStatusId: payload.statusId ?? null,
          freshStatusId: eligibility.freshStatusId ?? null,
        },
      });
      await recordCallfireLeadStep({
        domain: payload.domain,
        caseId: lead.caseId,
        stage: "dispatching",
        summary: "Submitting lead to CallFire outbound dialer",
        payload: {
          templateKey: payload.templateKey || null,
        },
      });
      logCallfireDebug(callfireDebugEnabled, "outbound.callfire.manual.lead_dispatching", {
        caseId: lead.caseId,
        phone: lead.primaryPhone || lead.normalizedPhone || null,
      });
    }
    const leadResult = await dispatchForLead(lead, {
      channel,
      actionType: payload.actionType || null,
      templateKey: payload.templateKey || null,
      content: payload.content || null,
      subject: payload.subject || null,
      trackingNumber: payload.trackingNumber || null,
      audioUrl: payload.audioUrl || null,
      updateCadence: false,
    });
    if (channel === "callfire") {
      logCallfireDebug(callfireDebugEnabled, "outbound.callfire.manual.lead_result", {
        caseId: lead.caseId,
        ok: leadResult.ok,
        skipped: Boolean(leadResult.result?.skipped),
        reason: leadResult.result?.reason || leadResult.result?.error || null,
        broadcastId: leadResult.result?.broadcastId || null,
      });
    }
    results.push(leadResult);
    }

    const progress = summarizeResults(results);
    await updateDispatchProgress(payload.dispatchListId, {
      attemptedCount: progress.attempted,
      successCount: progress.sent,
      failedCount: progress.failed,
      lastResult: {
        channel,
        mode: "manual",
        selected: leads.length,
        ...progress,
        pulseSize,
        pulseDelayMs,
        inProgress: (start + pulse.length) < leads.length,
      },
    });

    if (channel !== "callfire") {
      logOutboundProgress("outbound.manual.pulse", {
        dispatchListId: payload.dispatchListId || null,
        channel,
        pulseNumber: Math.floor(start / pulseSize) + 1,
        pulseSize: pulse.length,
        processedSoFar: progress.attempted,
        selected: leads.length,
        sent: progress.sent,
        failed: progress.failed,
        skipped: progress.skipped,
      });
    }

    if ((start + pulse.length) < leads.length && pulseDelayMs > 0) {
      await sleep(pulseDelayMs);
    }
  }

  const summary = {
    channel,
    mode: "manual",
    selected: leads.length,
    sent: results.filter((entry) => entry.ok).length,
    failed: results.filter((entry) => !entry.ok && !entry.result?.skipped).length,
    skipped: results.filter((entry) => entry.result?.skipped).length,
    results,
  };

  if (channel === "callfire") {
    summary.callfireSummary = summarizeCallfireResults(results);
    logCallfireDebug(callfireDebugEnabled, "outbound.callfire.manual.complete", {
      dispatchListId: payload.dispatchListId || null,
      selected: summary.selected,
      sent: summary.sent,
      failed: summary.failed,
      skipped: summary.skipped,
      ...summary.callfireSummary,
    });
  } else {
    logOutboundProgress("outbound.manual.complete", {
      dispatchListId: payload.dispatchListId || null,
      channel,
      selected: summary.selected,
      sent: summary.sent,
      failed: summary.failed,
      skipped: summary.skipped,
      pulseSize,
      pulseDelayMs,
    });
  }

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
    [OUTBOUND_EVENT_TYPES.CX_ROUND_REQUESTED]: (event) => runRound(event.payload || {}, "cx"),
    [OUTBOUND_EVENT_TYPES.PHONEBURNER_ROUND_REQUESTED]: (event) => runRound(event.payload || {}, "phoneburner"),
    [OUTBOUND_EVENT_TYPES.TEXT_MANUAL_REQUESTED]: (event) => runManual(event.payload || {}, "sms"),
    [OUTBOUND_EVENT_TYPES.EMAIL_MANUAL_REQUESTED]: (event) => runManual(event.payload || {}, "email"),
    [OUTBOUND_EVENT_TYPES.RVM_MANUAL_REQUESTED]: (event) => runManual(event.payload || {}, "rvm"),
    [OUTBOUND_EVENT_TYPES.PHONEBURNER_MANUAL_REQUESTED]: (event) => runManual(event.payload || {}, "phoneburner"),
    [OUTBOUND_EVENT_TYPES.CALLFIRE_MANUAL_REQUESTED]: (event) => runManual(event.payload || {}, "callfire"),
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

/**
 * Async-disposition poller for Drop.co RVM. Drop's /delivery/ POST
 * returns 1038 ("API Post Accepted") immediately, but the actual
 * outcome (delivered / DNC-rejected / number-disconnected /
 * no-voicemail-box) only surfaces minutes-to-hours later via the
 * VMDropStatus endpoint. This worker polls outstanding tokens,
 * classifies the disposition when terminal, and marks the rvm
 * channel DNC on permanent rejections.
 *
 * Designed to run on the existing outbound-gateway tick (no separate
 * cron). The lookup is rate-limited per token (5 min between polls,
 * 24-attempt cap, 24h age cap) so we don't hammer Drop. `limit`
 * caps how many tokens get polled per tick — keep modest so a tick
 * with thousands of outstanding RVMs doesn't stall the cadence sweep.
 */
async function pollOutboundRvmDispositions({ now = new Date(), limit = 25 } = {}) {
  const due = await leadCadenceRepository.listRvmActionsAwaitingDisposition({
    now,
    limit,
  });
  if (due.length === 0) {
    return { polled: 0, terminal: 0, markedDnc: 0, results: [] };
  }

  const results = [];
  let terminalCount = 0;
  let dncCount = 0;

  for (const entry of due) {
    const { domain, caseId, actionKey, providerDelivery } = entry;
    const token = providerDelivery?.activityToken;
    if (!token) continue;

    let dropResponse = null;
    let pollError = null;
    try {
      const drop = createDropClient(domain);
      dropResponse = await drop.getDropStatus(token);
    } catch (error) {
      pollError = error.message;
    }

    const classification = pollError
      ? { terminal: false, statusCode: null, statusMessage: null, pollError }
      : classifyDropDisposition(dropResponse);

    // Persist on the action's providerDelivery — increments
    // pollAttempts + lastPolledAt regardless of terminal state, and
    // overwrites disposition when we have one.
    const dispositionRecord = {
      ...classification,
      checkedAt: now,
      raw: dropResponse || null,
    };
    await leadCadenceRepository.recordRvmDispositionPoll(
      domain,
      caseId,
      actionKey,
      dispositionRecord,
    ).catch(() => null);

    if (classification.terminal) terminalCount += 1;

    // Permanent reject → mark RVM channel DNC for this lead. Lead
    // stays active; only rvm channel is shut off going forward.
    if (classification.terminal && classification.permanent) {
      await leadCadenceRepository.markChannelDnc(
        domain,
        caseId,
        "rvm",
        classification.reason || "drop-permanent-reject",
      ).catch(() => null);
      dncCount += 1;
    }

    results.push({
      domain,
      caseId,
      actionKey,
      classification,
      pollError,
    });
  }

  return {
    polled: results.length,
    terminal: terminalCount,
    markedDnc: dncCount,
    results,
  };
}

module.exports = {
  OUTBOUND_EVENT_TYPES,
  buildOutboundHandlers,
  createCadenceSweepEvents,
  createOutboundEvent,
  // Exported for the in-process first-contact path used by
  // inboundIntakeService.fireImmediateContact — fires a single channel
  // for a single lead without going through the round-sweep poller.
  dispatchForLead,
  pollOutboundRvmDispositions,
  processNextOutboundEvent,
  processOutboundEventBatch,
};
