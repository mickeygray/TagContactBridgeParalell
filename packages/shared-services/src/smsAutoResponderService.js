"use strict";

const {
  createCallrailClient,
  createLogicsClient,
} = require("../../shared-integrations/src");
const { resolveExportStatus } = require("../../shared-config/src/statusMap");
const {
  caseProfileRepository,
  conversationMessageRepository,
  conversationWorkflowRepository,
  consentRecordRepository,
  leadCadenceRepository,
} = require("../../shared-repositories/src");
const { emitHourlyJobEvent } = require("./hourlyJobEventService");
const { createLogicsFacade } = require("./logicsFacadeService");

// Minimum gap between auto-replies to the same phone. Prevents the bot
// from chaining responses if a prospect double-texts or a webhook fires
// twice. Human approvals bypass this gate — they're intentional.
const AUTO_REPLY_COOLDOWN_MS = 10 * 60 * 1000; // 10 min

// Defensive cap. Matches the classifier's system-prompt constraint so
// a misbehaving model can't send a novel.
const MAX_SMS_BODY_CHARS = 320;

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

function normalizeDomain(value) {
  return String(value || "").trim().toUpperCase();
}

/**
 * Decide whether the classifier's output should actually trigger an
 * auto-send. Anything other than `hard_stop` / `dnc_confirm` /
 * `callback_prompt` routes to human review. Also enforces the
 * last-outbound cooldown and the no-two-in-a-row rule.
 *
 * Returns `{ shouldSend, reason }`. When `shouldSend` is false, callers
 * should queue for manual review (don't send anything automatically).
 */
async function evaluateAutoSendGates({
  domain,
  phone,
  classification,
  workflow,
}) {
  const tier = classification?.tier;

  // hard_stop = carrier / no-contact opt-out. No auto-reply at all
  // (sending any message after STOP can violate carrier policy). This
  // suppresses SMS only and must not update Logics DNC.
  if (tier === "hard_stop") {
    return { shouldSend: false, reason: "hard_stop-no-reply", suppress: true };
  }

  // Only two tiers trigger an outbound SMS.
  if (tier !== "dnc_confirm" && tier !== "callback_prompt") {
    return { shouldSend: false, reason: "tier-needs-human" };
  }

  // Classifier must have produced a non-empty reply.
  if (!classification.suggestedReply) {
    return { shouldSend: false, reason: "empty-suggested-reply" };
  }

  // Already opted out — never re-engage, even on a borderline dnc_confirm.
  if (workflow?.optOutDetected) {
    return { shouldSend: false, reason: "already-opted-out" };
  }

  // Cooldown gates only AUTO-responded outbound messages. A real
  // agent sending manually doesn't count — if the agent replied
  // intentionally 2 minutes ago and a new inbound arrives, the bot is
  // free to respond (subject to classifier tier, of course). This
  // prevents the agent's activity from starving the auto-responder.
  const lastAutoOutbound =
    await conversationMessageRepository.findLatestOutbound(domain, phone, {
      autoRespondedOnly: true,
    });
  if (lastAutoOutbound?.createdAt) {
    const ageMs = Date.now() - new Date(lastAutoOutbound.createdAt).getTime();
    if (ageMs < AUTO_REPLY_COOLDOWN_MS) {
      return {
        shouldSend: false,
        reason: `cooldown-${Math.round(ageMs / 1000)}s-since-last-auto`,
      };
    }
  }

  return { shouldSend: true, reason: "ok" };
}

function enforceReplyConstraintsLegacy(reply) {
  let body = String(reply || "").trim();
  if (!body) return "";
  if (body.length > MAX_SMS_BODY_CHARS) {
    body = body.slice(0, MAX_SMS_BODY_CHARS - 1).trim();
  }
  // Force the TAG sign-off. If the model forgot, append it — provided
  // there's room. If there isn't room, truncate body to make room.
  if (!/—\s*TAG\s*$/i.test(body)) {
    const suffix = " — TAG";
    const roomFor = MAX_SMS_BODY_CHARS - suffix.length;
    body = body.slice(0, roomFor).trim() + suffix;
  }
  return body;
}

function replySuffixForDomain(domain) {
  return normalizeDomain(domain) === "WYNN"
    ? " - Wynn Tax Solutions"
    : " - TAG";
}

function enforceReplyConstraints(reply, domain = "WYNN") {
  let body = String(reply || "").trim();
  if (!body) return "";
  if (body.length > MAX_SMS_BODY_CHARS) {
    body = body.slice(0, MAX_SMS_BODY_CHARS - 1).trim();
  }

  const suffix = replySuffixForDomain(domain);
  const escapedSuffix = suffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!new RegExp(`${escapedSuffix}\\s*$`, "i").test(body)) {
    const roomFor = MAX_SMS_BODY_CHARS - suffix.length;
    body = body.slice(0, roomFor).trim() + suffix;
  }
  return body;
}

/**
 * Write a negative ConsentRecord. Used ONLY for `dnc_confirm` — the
 * prospect explicitly said they don't need the service, which is
 * lead-wide across SMS / email / call / RVM.
 *
 * `hard_stop` (carrier STOP keyword) does NOT trigger this: CallRail
 * handles the carrier channel block, but the lead may still respond to
 * email or a phone call later, so we don't want to stamp a lead-wide
 * DNC that would pull them from email campaigns too.
 */
async function recordNegativeConsent({ domain, phone, reason, rawPayload }) {
  try {
    return await consentRecordRepository.createConsentRecord({
      domain: normalizeDomain(domain),
      phone: normalizePhone(phone) || null,
      source: "sms-auto-responder",
      intakeRoute: "sms",
      intakeSource: "callrail-inbound",
      receivedAt: new Date(),
      payloadSnapshot: {
        ...(rawPayload || {}),
        dncReason: reason,
        recordType: "negative-consent",
      },
    });
  } catch (error) {
    return { error: error.message };
  }
}

/**
 * Update the lead's cadence row so the scheduler stops trying these
 * channels. Fire-and-forget semantics — if the lead isn't in cadence
 * (some inbounds come from prospects we never carded), we silently
 * return null.
 */
async function optOutCadenceChannels({ domain, phone, channels, reason, logger }) {
  try {
    const updated = await leadCadenceRepository.markCadenceChannelsOptedOut({
      domain,
      phone,
      channels,
      reason,
    });
    if (!updated) {
      logger?.info?.("sms.auto.cadence_miss", { domain, phone, channels });
    }
    return updated;
  } catch (error) {
    logger?.warn?.("sms.auto.cadence_opt_out_failed", {
      domain,
      phone,
      channels,
      error: error.message,
    });
    return null;
  }
}

async function resolveCaseIdForSmsDnc({ domain, phone, workflow, logger }) {
  const workflowCaseId = Number(workflow?.caseId);
  if (Number.isFinite(workflowCaseId) && workflowCaseId > 0) {
    return { caseId: workflowCaseId, source: "conversation-workflow" };
  }

  try {
    const cadence = await leadCadenceRepository.findLeadCadenceByPhone(domain, phone);
    const cadenceCaseId = Number(cadence?.caseId);
    if (Number.isFinite(cadenceCaseId) && cadenceCaseId > 0) {
      return { caseId: cadenceCaseId, source: "lead-cadence" };
    }
  } catch (error) {
    logger?.warn?.("sms.auto.dnc_cadence_lookup_failed", {
      domain,
      phone,
      error: error.message,
    });
  }

  try {
    const facade = createLogicsFacade(domain);
    const result = await facade.findCaseByPhone(phone);
    const match = Array.isArray(result?.matches) ? result.matches[0] : null;
    const logicsCaseId = Number(match?.caseId);
    if (Number.isFinite(logicsCaseId) && logicsCaseId > 0) {
      return { caseId: logicsCaseId, source: "logics-phone-lookup" };
    }
  } catch (error) {
    logger?.warn?.("sms.auto.dnc_logics_lookup_failed", {
      domain,
      phone,
      error: error.message,
    });
  }

  return { caseId: null, source: "unresolved" };
}

async function markLogicsDncForSms({
  domain,
  phone,
  workflow,
  classification,
  rawPayload,
  logger,
}) {
  const normalizedDomain = normalizeDomain(domain);
  if (normalizedDomain !== "WYNN") {
    return {
      ok: false,
      skipped: true,
      reason: "logics-sms-dnc-wynn-only",
    };
  }

  const resolvedStatus = resolveExportStatus(normalizedDomain, "dnc");
  const statusId = Number(resolvedStatus?.statusId);
  if (!Number.isFinite(statusId)) {
    logger?.warn?.("sms.auto.dnc_status_missing", { domain: normalizedDomain });
    return { ok: false, reason: "dnc-status-missing" };
  }

  const resolvedCase = await resolveCaseIdForSmsDnc({
    domain: normalizedDomain,
    phone,
    workflow,
    logger,
  });
  const caseId = Number(resolvedCase.caseId);
  if (!Number.isFinite(caseId) || caseId <= 0) {
    logger?.warn?.("sms.auto.dnc_case_unresolved", {
      domain: normalizedDomain,
      phone,
      reason: classification?.rationale || null,
    });
    return { ok: false, reason: "case-unresolved", source: resolvedCase.source };
  }

  const note = [
    "SMS DNC from inbound reply.",
    classification?.rationale ? `Reason: ${classification.rationale}` : null,
    rawPayload?.content || rawPayload?.message
      ? `Inbound: ${String(rawPayload.content || rawPayload.message).slice(0, 240)}`
      : null,
  ]
    .filter(Boolean)
    .join(" ");

  try {
    const client = createLogicsClient(normalizedDomain);
    const response = await client.updateCase({
      caseId,
      CaseID: caseId,
      StatusID: statusId,
      Notes: note.slice(0, 500),
    });

    await caseProfileRepository
      .upsertCaseProfile(normalizedDomain, caseId, {
        statusId,
        statusCategory: "dnc",
        lastStatusCheckAt: new Date(),
        statusLastChangedAt: new Date(),
        "conversationAi.status": "suppressed",
        "conversationAi.optOutDetected": true,
        "conversationAi.aiRecommendedAction": "logics-dnc",
        "conversationAi.aiConfidence": String(classification?.confidence ?? ""),
        "conversationAi.aiSummary": classification?.rationale || "SMS DNC confirmed.",
      })
      .catch(() => null);

    logger?.info?.("sms.auto.logics_dnc_updated", {
      domain: normalizedDomain,
      phone,
      caseId,
      statusId,
      source: resolvedCase.source,
    });

    return {
      ok: true,
      caseId,
      statusId,
      source: resolvedCase.source,
      response,
    };
  } catch (error) {
    logger?.warn?.("sms.auto.logics_dnc_failed", {
      domain: normalizedDomain,
      phone,
      caseId,
      statusId,
      error: error.message,
    });
    return {
      ok: false,
      caseId,
      statusId,
      reason: error.message,
    };
  }
}

async function applyDncConfirmSideEffects({
  domain,
  phone,
  workflow,
  classification,
  rawPayload,
  logger,
}) {
  await recordNegativeConsent({
    domain,
    phone,
    reason: classification?.rationale || "dnc_confirm",
    rawPayload,
  });
  await optOutCadenceChannels({
    domain,
    phone,
    channels: ["sms", "email", "rvm", "call"],
    reason: "dnc-confirm",
    logger,
  });
  return markLogicsDncForSms({
    domain,
    phone,
    workflow,
    classification,
    rawPayload,
    logger,
  });
}

/**
 * Main entrypoint. Called after an inbound message has been classified
 * and written to the message log. Policy:
 *
 *   hard_stop     → no reply (CallRail handles carrier block), no
 *                   ConsentRecord (lead may still respond to email/
 *                   calls later), update LeadCadence to mark the SMS
 *                   channel exhausted so the scheduler stops scheduling
 *                   blocked sends.
 *   dnc_confirm   → auto-reply (polite confirmation), ConsentRecord
 *                   negative (lead-wide DNC), update LeadCadence to
 *                   exhaust ALL engagement channels (sms/email/rvm).
 *   callback_prompt → auto-reply (short "call us back"), nothing else.
 *   needs_human   → no-op.
 *
 * NOTE: we never flip `workflow.status` automatically. Status is
 * operator-driven via per-message action buttons in the inbox UI. This
 * keeps the admin's mental model simple — they decide when a thread is
 * "closed," not the bot.
 *
 * Returns a summary object the caller logs; never throws on send failure
 * (degrades to manual review instead).
 */
async function runAutoResponder({
  domain,
  phone,
  workflowId,
  workflow,
  classification,
  rawPayload = null,
  logger = null,
}) {
  // hard_stop: carrier-level opt-out for SMS only. We do NOT reply
  // (sending anything after STOP can violate carrier policy + CallRail
  // would block it anyway). We do NOT DNC the lead. We just prune the
  // SMS channel from their cadence so the scheduler stops burning
  // blocked sends.
  if (classification.tier === "hard_stop") {
    const cadence = await optOutCadenceChannels({
      domain,
      phone,
      channels: ["sms"],
      reason: "carrier-stop",
      logger,
    });
    logger?.info?.("sms.auto.carrier_stop_recorded", {
      domain,
      phone,
      cadenceMatched: Boolean(cadence),
    });
    return {
      action: "carrier_stop",
      tier: "hard_stop",
      sent: false,
      reason: "carrier-handles-block",
      cadenceMatched: Boolean(cadence),
    };
  }

  const gate = await evaluateAutoSendGates({
    domain,
    phone,
    classification,
    workflow,
  });

  if (!gate.shouldSend) {
    const dncResult = classification.tier === "dnc_confirm"
      ? await applyDncConfirmSideEffects({
          domain,
          phone,
          workflow,
          classification,
          rawPayload,
          logger,
        })
      : null;
    logger?.info?.("sms.auto.skipped", {
      domain,
      phone,
      tier: classification.tier,
      reason: gate.reason,
    });
    return {
      action: "skipped",
      tier: classification.tier,
      sent: false,
      reason: gate.reason,
      dncResult,
    };
  }

  const replyBody = enforceReplyConstraints(classification.suggestedReply, domain);

  let sendResult;
  let sendError = null;
  try {
    const client = createCallrailClient(normalizeDomain(domain));
    sendResult = await client.sendSms({ phone, text: replyBody });
  } catch (error) {
    sendError = error;
    logger?.warn?.("sms.auto.send_failed", {
      domain,
      phone,
      tier: classification.tier,
      error: error.message,
    });
  }

  // Always write an outbound row — even on failure — so the admin sees
  // a "failed" bubble in the thread and can manually retry.
  const outbound = await conversationMessageRepository.createOutboundMessage({
    workflowId,
    domain,
    phone,
    channel: "sms",
    body: replyBody,
    provider: "callrail",
    providerMessageId: sendResult?.providerMessageId || null,
    providerStatus: sendError ? "failed" : "sent",
    providerError: sendError?.message || null,
    autoResponded: true,
  });

  const caseId = workflow?.caseId != null && Number.isFinite(Number(workflow.caseId))
    ? Number(workflow.caseId)
    : null;
  if (caseId) {
    await caseProfileRepository
      .appendCommunicationThread(domain, caseId, "sms", {
        provider: "callrail",
        providerMessageId: outbound.providerMessageId || null,
        providerError: sendError?.message || null,
        threadKey: outbound.providerMessageId || workflowId || `${domain}:${phone}`,
        direction: "outbound",
        phone,
        body: replyBody,
        status: sendError ? "failed" : "sent",
        workflowId,
        conversationMessageId: outbound.id || null,
        sentAt: outbound.createdAt || new Date(),
        source: "sms-auto-responder",
        metadata: {
          autoResponded: true,
          aiTier: classification.tier || null,
          aiIntent: classification.intent || null,
        },
      })
      .catch(() => null);
  }
  if (sendError) {
    await emitHourlyJobEvent({
      lane: "hourly",
      domain,
      eventType: "sms.auto-responder.reconcile",
      targetService: "control-plane",
      handlerKey: "cancelFailedAutoResponderText",
      aggregateType: "conversation-workflow",
      aggregateId: workflowId || phone,
      caseId: workflow?.caseId != null ? Number(workflow.caseId) : null,
      payload: {
        workflowId,
        phone,
        tier: classification.tier,
        body: replyBody,
        outboundMessageId: outbound.id,
      },
      resolutionCheckKey: "auto-responder-delivery-state",
      resolutionContext: {
        workflowId,
        phone,
      },
      dedupeKey: `${normalizeDomain(domain)}:sms-auto:${workflowId || phone}`,
      emittedBy: "control-plane",
      priority: 40,
      severity: "warning",
      alertSummary: "Auto-responder send failed; hourly cleanup queued",
      immediateRetryAttempts: 1,
      immediateRetryDelayMs: 500,
      provideSummary: false,
      firstError: sendError.message,
      notify: false,
    }).catch(() => null);
  }

  let dncResult = null;

  // dnc_confirm side-effects are based on the inbound reply itself, not
  // on whether our confirmation text delivered. The prospect explained
  // why they do not need help, so Wynn gets a Logics DNC and the local
  // cadence stops all engagement channels.
  if (classification.tier === "dnc_confirm") {
    dncResult = await applyDncConfirmSideEffects({
      domain,
      phone,
      workflow,
      classification,
      rawPayload,
      logger,
    });
  }

  logger?.info?.("sms.auto.sent", {
    domain,
    phone,
    tier: classification.tier,
    providerStatus: outbound.providerStatus,
  });

  return {
    action: sendError ? "send_failed" : "sent",
    tier: classification.tier,
    sent: !sendError,
    outboundMessageId: outbound.id,
    providerMessageId: outbound.providerMessageId,
    body: replyBody,
    dncResult,
  };
}

module.exports = {
  runAutoResponder,
  evaluateAutoSendGates,
  enforceReplyConstraints,
  AUTO_REPLY_COOLDOWN_MS,
};
