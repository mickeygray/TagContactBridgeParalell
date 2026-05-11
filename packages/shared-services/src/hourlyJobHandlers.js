"use strict";

/**
 * Built-in handlers for the hourly retry system. Each handler is a
 * thin adapter that receives an `HourlyJobEvent` doc and delegates to
 * the service that owns the underlying action. Handlers MUST:
 *
 *   - Re-check state when their work is not idempotent (create-case,
 *     create-activity). The paired `resolutionCheckKey` should already
 *     catch most self-heals, but handlers must not blindly re-create.
 *
 *   - Throw on transient errors — the sweeper will decide retry vs
 *     dead-letter based on the job's `attemptCount` vs `maxAttempts`.
 *
 *   - Throw with `error.deadLetter = true` for permanent failures
 *     (missing payload, unknown subtype) so we don't burn retry slots.
 *
 * Requiring this module registers all built-in handlers. The server
 * boot path requires it once via shared-services/src/index.js.
 *
 * Lazy requires inside each handler keep load order safe — this module
 * is pulled in by the shared-services barrel, so we can't top-level
 * require cxWorkspaceService etc. without risking a partially-loaded
 * module at registration time.
 */

const { register } = require("./hourlyJobHandlerRegistry");

function permanent(message) {
  const err = new Error(message);
  err.deadLetter = true;
  return err;
}

function rebuildUser(job) {
  return {
    email: job?.payload?.actorEmail || "hourly-sweeper@control-plane",
    name: job?.payload?.actorName || "Hourly Retry",
  };
}

// ── syncCaseProfileFromLogics ─────────────────────────────────────────
// Air-tight retry for the post-CX-action CaseProfile sync. Emitted by
// `executeCxLogicsAction` when the inline sync fails after the Logics
// action has already succeeded. The Logics case is authoritative and
// already correct; we just need the parallel-side CaseProfile to
// catch up so the "refined list" stays accurate.
//
// Payload shape: { domain, caseId, originatingSubtype }
//
// Idempotent: `syncCaseProfileFromLogics` re-fetches the case from
// Logics and `caseProfileRepository.upsertCaseProfile` is upsert-by-
// (domain, caseId), so re-running on a row that was already synced by
// a later CX action is a no-op.
register("syncCaseProfileFromLogics", async (job) => {
  const cx = require("./cxWorkspaceService");
  const domain = job.domain;
  const caseId = job.caseId != null ? Number(job.caseId) : null;
  if (!domain) throw permanent("syncCaseProfileFromLogics: domain required");
  if (!Number.isFinite(caseId)) throw permanent("syncCaseProfileFromLogics: caseId required");

  const result = await cx.syncCaseProfileFromLogics(domain, caseId);
  if (!result) {
    // getCaseInfo returned no data — Logics doesn't know this case.
    // Permanent failure (no point retrying); dead-letter immediately.
    throw permanent(`syncCaseProfileFromLogics: Logics returned no data for ${domain}/${caseId}`);
  }
  return { domain, caseId, caseProfileId: String(result._id) };
});

// ── retryCxLogicsAction ───────────────────────────────────────────────
// Subtype dispatch over the full CX Logics executor surface. Payload
// shape (set by cxWorkspaceService.queueCxLogicsRetryJob):
//   { subtype, logicsPayload, requested, actorEmail, actorName, ... }
// `logicsPayload` is the original `input` that went to the executor.
register("retryCxLogicsAction", async (job) => {
  const cx = require("./cxWorkspaceService");
  const subtype = String(job.payload?.subtype || "").trim();
  const input = job.payload?.logicsPayload || job.payload?.requested || {};
  const user = rebuildUser(job);
  const domain = job.domain;

  switch (subtype) {
    case "logics-task":
      return cx.executeCxLogicsTask(domain, user, input);
    case "logics-create-case":
      return cx.executeCxLogicsCreateCase(domain, user, input);
    case "logics-find-match":
      return cx.executeCxLogicsFindMatch(domain, user, input);
    case "logics-create-activity":
    case "logics-update-activity":
      return cx.executeCxLogicsActivity(domain, user, input);
    case "logics-update-case":
      return cx.executeCxLogicsUpdateCase(domain, user, input);
    case "logics-create-invoice":
      return cx.executeCxLogicsInvoice(domain, user, input);
    case "logics-create-amortization":
      return cx.executeCxLogicsAmortization(domain, user, input);
    default:
      throw permanent(`retryCxLogicsAction: unknown subtype "${subtype}"`);
  }
});

// ── cancelFailedOutboundText ──────────────────────────────────────────
// Minor housekeeping: flip the single scheduled action that failed to
// `cancelled` so the cadence scheduler doesn't pick it up again. Does
// NOT touch channel-level exhaustion or ConsentRecord — DNC decisions
// live on the human-in-the-loop path (auto-responder + inbox buttons).
//
// Payload shape: { actionKey, reason?, providerError?, phone? }
register("cancelFailedOutboundText", async (job) => {
  const { leadCadenceRepository } = require("../../shared-repositories/src");
  const actionKey = job.payload?.actionKey;
  const caseId = job.caseId != null ? Number(job.caseId) : null;
  if (!actionKey) throw permanent("cancelFailedOutboundText: payload.actionKey required");
  if (!Number.isFinite(caseId)) throw permanent("cancelFailedOutboundText: caseId required");

  return leadCadenceRepository.markScheduledActionStatus(
    job.domain,
    caseId,
    actionKey,
    "cancelled",
    {
      "cadenceState.lastEvaluatedAt": new Date(),
    },
  );
});

// -- Recontact event landing pad -------------------------------------
// The call queue is still settling its final event contract. Keep these
// handler keys registered now so the scheduler has a stable target to
// emit at; once the payload shape is finalized, replace the pending
// review item below with the real lead-cadence refire dispatch.
function normalizeRecontactEvent(job) {
  const payload = job.payload || {};
  const caseId = Number(
    job.caseId ??
      payload.caseId ??
      payload.logicsCaseId ??
      payload.case?.caseId,
  );
  return {
    domain: job.domain,
    caseId: Number.isFinite(caseId) ? caseId : null,
    actionKey:
      payload.actionKey ||
      payload.scheduledActionKey ||
      payload.contactActionKey ||
      null,
    channel: payload.channel || payload.contactChannel || payload.kind || null,
    scheduledFor: payload.scheduledFor || payload.nextAttemptAt || null,
    reason: payload.reason || payload.triggerReason || null,
    sourceEventType: job.eventType || null,
    aggregateId: job.aggregateId || null,
    payload,
  };
}

async function acceptPendingRecontactEvent(job) {
  const { reviewQueueRepository } = require("../../shared-repositories/src");
  const event = normalizeRecontactEvent(job);
  await reviewQueueRepository.createReviewQueueItem({
    domain: event.domain,
    caseId: event.caseId,
    sourceService: "hourly-sweeper",
    workflow: "recontact-event",
    category: "cadence",
    severity: "info",
    title: "Recontact event received",
    summary:
      "A queued recontact event reached the control plane. Dispatch is intentionally parked until the final event contract is provided.",
    happenedAt: new Date(),
    payload: event,
    tags: ["recontact", "cadence", event.domain],
  }).catch(() => null);

  return {
    accepted: true,
    pendingImplementation: true,
    event: {
      domain: event.domain,
      caseId: event.caseId,
      actionKey: event.actionKey,
      channel: event.channel,
      scheduledFor: event.scheduledFor,
      reason: event.reason,
    },
  };
}

register("scheduleRecontactAttempt", acceptPendingRecontactEvent);
register("recontactAttempt", acceptPendingRecontactEvent);
register("refireContactAttempt", acceptPendingRecontactEvent);

// ── cancelFailedOutboundRvm ───────────────────────────────────────────
register("cancelFailedOutboundRvm", async (job) => {
  const { leadCadenceRepository } = require("../../shared-repositories/src");
  const actionKey = job.payload?.actionKey;
  const caseId = job.caseId != null ? Number(job.caseId) : null;
  if (!actionKey) throw permanent("cancelFailedOutboundRvm: payload.actionKey required");
  if (!Number.isFinite(caseId)) throw permanent("cancelFailedOutboundRvm: caseId required");

  return leadCadenceRepository.markScheduledActionStatus(
    job.domain,
    caseId,
    actionKey,
    "cancelled",
    {
      "cadenceState.lastEvaluatedAt": new Date(),
    },
  );
});

// ── cancelFailedOutboundCallfireDial ──────────────────────────────────
// CallFire dial failures: broadcast-create-failed, missing template,
// bad phone, etc. Same surgical cancel pattern as SMS/RVM — no redial.
register("cancelFailedOutboundCallfireDial", async (job) => {
  const { leadCadenceRepository } = require("../../shared-repositories/src");
  const actionKey = job.payload?.actionKey;
  const caseId = job.caseId != null ? Number(job.caseId) : null;
  if (!actionKey) {
    throw permanent("cancelFailedOutboundCallfireDial: payload.actionKey required");
  }
  if (!Number.isFinite(caseId)) {
    throw permanent("cancelFailedOutboundCallfireDial: caseId required");
  }

  return leadCadenceRepository.markScheduledActionStatus(
    job.domain,
    caseId,
    actionKey,
    "cancelled",
    {
      "cadenceState.lastEvaluatedAt": new Date(),
    },
  );
});

// ── retryCallRecordingPipeline ────────────────────────────────────────
// Transcription/scoring timing: recording might not have been available
// when the call first ended (RC lags the upload). By the next sweep
// tick, it usually is. Idempotent — processCallLogRecording short-
// circuits when transcription/score are already present.
register("retryCallRecordingPipeline", async (job) => {
  const { processCallLogRecording } = require("./transcriptionScoringService");
  const sessionId =
    job.payload?.telephonySessionId ||
    job.payload?.sessionId ||
    job.aggregateId;
  if (!sessionId) {
    throw permanent("retryCallRecordingPipeline: telephonySessionId required");
  }
  return processCallLogRecording({
    domain: job.domain,
    telephonySessionId: String(sessionId),
    lane: job.lane,
  });
});

// ── retryCallRecordingArchive ───────────────────────────────────────────────
// Download long-call audio for human review and upload it into the
// configured Google Drive folder keyed off the terminal RC agent group.
register("retryCallRecordingArchive", async (job) => {
  const { processCallRecordingArchive } = require("./recordingArchiveService");
  const sessionId =
    job.payload?.telephonySessionId ||
    job.payload?.sessionId ||
    job.aggregateId;
  if (!sessionId) {
    throw permanent("retryCallRecordingArchive: telephonySessionId required");
  }
  return processCallRecordingArchive({
    domain: job.domain,
    telephonySessionId: String(sessionId),
  });
});

// ── reconcileTelephonySessionAttribution ──────────────────────────────
// Re-run attribution resolution for a session candidate. Upstream
// lookup may have 429'd or hit empty windows that now have records.
register("reconcileTelephonySessionAttribution", async (job) => {
  const { processTelephonySessionCandidate } = require("./ringcentralAttributionService");
  const candidate = job.payload?.candidate || job.payload?.session;
  if (!candidate) {
    throw permanent(
      "reconcileTelephonySessionAttribution: payload.candidate required",
    );
  }
  // Second arg is the logger — pass null, attribution service tolerates it.
  return processTelephonySessionCandidate(candidate, null, {
    fromHourlySweep: true,
  });
});

// ── cancelFailedAutoResponderText ─────────────────────────────────────
// Auto-responder send failure. Mark the workflow metadata so the next
// classifier tick doesn't loop the bot on the same thread. Admin can
// still manually reply from the inbox UI; we only suppress the AUTO
// path for this workflow.
//
// Payload shape: { workflowId, conversationMessageId?, providerError? }
register("cancelFailedAutoResponderText", async (job) => {
  const {
    conversationWorkflowRepository,
  } = require("../../shared-repositories/src");
  const workflowId = job.payload?.workflowId || job.sourceWorkflowId;
  if (!workflowId) {
    throw permanent("cancelFailedAutoResponderText: workflowId required");
  }
  const existing =
    await conversationWorkflowRepository.findConversationWorkflowById(workflowId);
  if (!existing) {
    throw permanent("cancelFailedAutoResponderText: workflow not found");
  }
  return conversationWorkflowRepository.updateConversationWorkflowById(workflowId, {
    metadata: {
      ...(existing.metadata || {}),
      autoReplySuppressed: true,
      autoReplySuppressedReason: job.payload?.providerError || job.lastError || null,
      autoReplySuppressedAt: new Date(),
    },
  });
});

// ── retrySocialReply ──────────────────────────────────────────────────
// FB/IG comment-reply or DM-send failure. Four emission flavors feed
// this handler, all via the same handlerKey — we route by step+platform.
//
// eventType shape (from socialResponderService emissions):
//   social.facebook.comment.reply.retry
//   social.facebook.message.reply.retry
//   social.instagram.comment.reply.retry
//   social.instagram.message.reply.retry
//
// Payload shape: { platform?, step?, args: {...} }
// `platform` and `step` are preferred when present; otherwise we parse
// them out of `eventType` so Codex's emissions don't need to duplicate
// the routing info.
//
// step values we recognize:
//   "comment-reply" / "comment" → social.replyToComment
//   "dm-send"       / "message" → social.sendDirectMessage
const EVENT_TYPE_STEP_PATTERN = /^social\.(facebook|instagram)\.(comment|message)\.reply\.retry$/i;

function resolveSocialRouting(job) {
  const payloadPlatform = String(job.payload?.platform || "").toLowerCase();
  const payloadStepRaw = String(job.payload?.step || "").toLowerCase();

  let platform = payloadPlatform === "facebook" || payloadPlatform === "instagram"
    ? payloadPlatform
    : null;
  let stepCanonical = null;
  if (payloadStepRaw === "comment-reply" || payloadStepRaw === "comment") {
    stepCanonical = "comment-reply";
  } else if (payloadStepRaw === "dm-send" || payloadStepRaw === "message") {
    stepCanonical = "dm-send";
  }

  if (!platform || !stepCanonical) {
    const match = EVENT_TYPE_STEP_PATTERN.exec(String(job.eventType || ""));
    if (match) {
      platform = platform || match[1].toLowerCase();
      if (!stepCanonical) {
        stepCanonical = match[2].toLowerCase() === "comment" ? "comment-reply" : "dm-send";
      }
    }
  }

  return { platform, step: stepCanonical };
}

register("retrySocialReply", async (job) => {
  const social = require("./socialResponderService");
  const { platform, step } = resolveSocialRouting(job);
  const args = job.payload?.args || {};

  if (!platform || !step) {
    throw permanent(
      `retrySocialReply: cannot resolve platform/step from payload or eventType "${job.eventType || ""}"`,
    );
  }

  if (step === "comment-reply") {
    if (typeof social.replyToComment !== "function") {
      throw permanent("retrySocialReply: replyToComment not exported");
    }
    const { pageToken, commentId, message } = args;
    if (!pageToken || !commentId || !message) {
      throw permanent("retrySocialReply: missing pageToken/commentId/message");
    }
    return social.replyToComment(pageToken, commentId, message, platform);
  }

  // step === "dm-send"
  if (typeof social.sendDirectMessage !== "function") {
    throw permanent("retrySocialReply: sendDirectMessage not exported");
  }
  const { pageToken, recipientId, message } = args;
  if (!pageToken || !recipientId || !message) {
    throw permanent("retrySocialReply: missing pageToken/recipientId/message");
  }
  return social.sendDirectMessage(pageToken, recipientId, message);
});

// ── retryNcoaCreateCase ───────────────────────────────────────────────
// Dup-risk retry: NCOA blind retries can double-create cases. Before
// retrying, check whether a case already exists for the phone/email.
// Payload shape: { row, domain } — `row` is a normalized NCOA row.
register("retryNcoaCreateCase", async (job) => {
  const { uploadNcoaRows } = require("./ncoaUploadService");
  const row = job.payload?.row;
  if (!row) throw permanent("retryNcoaCreateCase: payload.row required");
  // `uploadNcoaRows` handles the dup check internally (normalizeNcoaRow
  // + findCaseByPhone lookup before createCase). Passing a single row
  // array is the minimum invocation.
  const result = await uploadNcoaRows([row], {
    domain: job.domain,
    importBatch: job.payload?.importBatch,
    sourceService: "hourly-sweeper",
    emitRetryOnFailure: false,
  });
  if (Number(result?.failed || 0) > 0) {
    const firstFailure = Array.isArray(result?.results)
      ? result.results.find((item) => item && !item.ok)
      : null;
    throw new Error(firstFailure?.error || "NCOA retry failed");
  }
  return {
    total: Number(result?.total || 0),
    succeeded: Number(result?.succeeded || 0),
    failed: Number(result?.failed || 0),
  };
});

// ── reconcileCasePayments ─────────────────────────────────────────────
register("reconcileCasePayments", async (job) => {
  const { reconcilePaymentsForCase } = require("./paymentReconcileService");
  const {
    walkAttributionLoop,
    applyAttributionUpdates,
  } = require("./attributionLoopService");
  const caseId = job.caseId != null ? Number(job.caseId) : null;
  if (!Number.isFinite(caseId)) {
    throw permanent("reconcileCasePayments: caseId required");
  }
  const reconcile = await reconcilePaymentsForCase({
    domain: job.domain,
    caseId,
    lane: job.lane,
  });

  // After every hourly payment reconcile, re-walk the attribution loop
  // for the case so any Logics correction made since the last refresh
  // (CallRail → RC legs → Logics → SourceCanonical) lands on
  // CaseProfile + PaymentLedger immediately. The nightly close runs
  // the same loop in bulk; doing it inline here means corrections are
  // visible within the hour instead of waiting for nightly.
  let attribution = null;
  try {
    const walk = await walkAttributionLoop(job.domain, caseId);
    attribution = await applyAttributionUpdates(job.domain, caseId, walk, {
      updatePaymentLedger: true,
    });
  } catch (error) {
    // Best-effort: a Logics or CallRail outage shouldn't fail the
    // payment reconcile job. Surface in the result for the audit trail.
    attribution = { error: error.message };
  }
  return { reconcile, attribution };
});

// ── retryInboundLogicsCreate ──────────────────────────────────────────
// Same dup-risk pattern as NCOA: before retrying, verify the inbound
// lead didn't already create a case in Logics. Dispatches on intake
// route so the right intake* function runs.
//
// Payload shape: { intakeRoute, normalizedLead }
register("retryInboundLogicsCreate", async (job) => {
  const intake = require("./inboundIntakeService");
  const route = String(job.payload?.intakeRoute || "").trim();
  const lead = job.payload?.normalizedLead || job.payload?.payload;
  if (!lead) throw permanent("retryInboundLogicsCreate: normalizedLead required");

  const routeFn = {
    "affiliate": intake.intakeAffiliateLead,
    "website": intake.intakeWebsiteLead,
    "ld": intake.intakeLdLead,
    "facebook": intake.intakeFacebookLead,
    "instagram": intake.intakeInstagramLead,
    "tiktok": intake.intakeTikTokLead,
    "vf-landing": intake.intakeVfLandingLead,
    "organic-landing": intake.intakeOrganicLandingLead,
    "normalized": intake.intakeNormalizedLead,
  }[route];

  if (typeof routeFn !== "function") {
    throw permanent(`retryInboundLogicsCreate: unsupported intakeRoute "${route}"`);
  }
  // Intake handlers are idempotent — they check existing lead/case
  // records before creating. Re-running is safe.
  return routeFn(lead, { fromHourlyRetry: true });
});

// ── renewRingcentralSubscription ──────────────────────────────────────
// Triggered from the RC subscription watchdog when it can't renew or
// create a subscription on its own. The handler just re-runs the
// watchdog with `emitOnFailure:false` (we're already inside a retry —
// don't infinite-loop the emission). On success, the resolution-check
// system would normally short-circuit, but subscription state isn't a
// cheap read; the handler itself does the work.
//
// Payload shape: { reason, address, hasWebhookSecret }
// The actual webhookAddress + webhookSecret are resolved from config
// at handler-run time, not from the payload (secrets stay out of the
// job record).
register("renewRingcentralSubscription", async (job) => {
  const {
    runSubscriptionWatchdog,
  } = require("./ringcentralSubscriptionWatchdogService");
  // Pull address + secret the same way the ringcentral-cx service
  // does — lazy-require so we don't circular-import at boot.
  const {
    getRingCentralConfig,
  } = require("../../shared-config/src");
  const rcConfig = getRingCentralConfig();
  // Respect the global opt-in gate. If an older emission is still
  // sitting in the queue from before the killswitch flipped off, we
  // dead-letter it rather than silently managing a subscription the
  // operator explicitly turned off.
  if (!rcConfig?.subscriptionWatchdogEnabled) {
    throw permanent(
      "renewRingcentralSubscription: watchdog disabled (RC_SUBSCRIPTION_WATCHDOG_ENABLED=false)",
    );
  }
  const composedAddress = rcConfig?.webhookBaseUrl
    ? `${String(rcConfig.webhookBaseUrl).replace(/\/+$/, "")}/webhook/ringcentral/session-events`
    : null;
  const address = job.payload?.address || composedAddress;
  const webhookSecret = rcConfig?.webhookSecret || null;
  if (!address) {
    throw permanent(
      "renewRingcentralSubscription: webhook address unknown (set NGROK_DOMAIN or RING_CENTRAL_WEBHOOK_BASE_URL)",
    );
  }
  const result = await runSubscriptionWatchdog({
    webhookAddress: address,
    webhookSecret,
    minRemainingMinutes: 15,
    emitOnFailure: false, // avoid re-emit; we ARE the retry.
  });
  if (result.action === "error") {
    // Throw without deadLetter → normal retry rules apply.
    throw new Error(
      `renewRingcentralSubscription: ${result.reason}${result.error ? " — " + result.error : ""}`,
    );
  }
  return result;
});

// ── investigateRingcentralSilence ─────────────────────────────────────
// Observational emission from the silence checker. Can't be auto-
// resolved — requires a human to confirm the webhook pipe is intact.
// Handler just dead-letters with context so it doesn't burn retry slots.
register("investigateRingcentralSilence", async (job) => {
  throw permanent(
    `investigateRingcentralSilence: RC event silence of ${job.payload?.silentForMs}ms — subscription ${job.payload?.subscriptionId || "?"} last event ${job.payload?.lastEventAt || "never"}. Manual check required (ngrok? webhook route? RC console?).`,
  );
});

register("retryLexisDailyDrop", async (job) => {
  const { sendLexisDailyDropMail } = require("./lexisDailyDropService");
  const payload = job.payload || {};
  return sendLexisDailyDropMail({
    domain: job.domain,
    sourceService: "hourly-sweeper",
    scheduled: true,
    emitRetryOnFailure: false,
    force: payload.force,
    dateKey: payload.dateKey,
    recipients: payload.recipients,
    alertRecipients: payload.alertRecipients,
    subject: payload.subject,
    text: payload.text,
    alertSubject: payload.alertSubject,
    alertText: payload.alertText,
    ignoreConfiguredRecipients: payload.ignoreConfiguredRecipients,
    ignoreConfiguredAlertRecipients: payload.ignoreConfiguredAlertRecipients,
    host: payload.host,
    port: payload.port,
    username: payload.username,
    password: payload.password,
    remoteDir: payload.remoteDir,
    zipPassword: payload.zipPassword,
  });
});

module.exports = {
  // Re-exported for tests; the registration side effect is the
  // interesting part.
  permanent,
};
