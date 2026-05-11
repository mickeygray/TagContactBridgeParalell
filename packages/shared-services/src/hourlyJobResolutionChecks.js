"use strict";

/**
 * Built-in resolution checks for the hourly retry system. Each check
 * is a cheap read that answers "did the underlying issue self-heal?"
 * so the sweeper can mark the job completed without re-running the
 * (potentially expensive, potentially duplicative) handler.
 *
 * Requiring this module registers all built-in checks. The server boot
 * path requires it once so the registry is populated before the first
 * sweeper tick fires.
 *
 * Add a new check:
 *   1. Write an async function `(job) => { resolved, note }`.
 *   2. `registerResolutionCheck("your-key", yourCheckFn)` below.
 *   3. Emitters pass `resolutionCheckKey: "your-key"` on emit.
 */

const {
  createLogicsClient,
} = require("../../shared-integrations/src");
const {
  CallLog,
  ConversationMessage,
  ConversationWorkflow,
  LeadCadence,
  PaymentLedger,
} = require("../../shared-models/src");
const {
  register: registerResolutionCheck,
} = require("./hourlyJobResolutionCheckRegistry");

// How recently a PaymentLedger row must have been touched for us to
// consider a case "freshly reconciled" and skip the handler. 30min
// assumes the hourly sweep + manual CX actions each keep the ledger
// warm; tune if parallel paths take longer.
const PAYMENT_LEDGER_FRESH_WINDOW_MS = 30 * 60 * 1000;

/**
 * "logics-case-visible": case updates and creates can fail with Logics
 * lag or a 5xx; an hour later the case is often indexed. If getCaseInfo
 * returns a real StatusID, the original write most likely succeeded on
 * a later reindex (or a parallel flow), and retrying the write would
 * duplicate it. Mark resolved.
 */
async function logicsCaseVisible(job) {
  const caseId = Number(job?.caseId);
  const domain = String(job?.domain || "TAG").toUpperCase();
  if (!Number.isFinite(caseId) || caseId <= 0) {
    return { resolved: false, note: "no-caseId-on-job" };
  }

  const client = createLogicsClient(domain);
  const payload = await client.getCaseInfo(caseId);

  // Logics envelope can be `{ data: {...} }`, `{ Data: {...} }`, or raw.
  const raw =
    payload?.data !== undefined && payload.data !== null
      ? payload.data
      : payload?.Data !== undefined && payload.Data !== null
        ? payload.Data
        : payload;
  const data = typeof raw === "string" ? safeParseJson(raw) : raw;

  const statusId = Number(data?.StatusID ?? data?.Status ?? null);
  if (Number.isFinite(statusId) && statusId > 0) {
    return {
      resolved: true,
      note: `case ${caseId} visible at StatusID=${statusId}`,
    };
  }
  return {
    resolved: false,
    note: `case ${caseId} not visible yet`,
  };
}

function safeParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * "payment-ledger-fresh": an hourly payment-reconcile failed because
 * Logics was flaky, but a parallel path (manual CX action, another
 * sweep worker, nightly backfill) may have already refreshed the case's
 * ledger rows. If any row for this case was touched in the last
 * `PAYMENT_LEDGER_FRESH_WINDOW_MS`, treat it as reconciled and skip the
 * retry.
 *
 * Uses `updatedAt` (set by mongoose `timestamps`) so a re-upsert that
 * only flipped `transactionStatus` still counts as "fresh" — the ledger
 * *did* change even if `paymentDate` stayed put.
 */
async function paymentLedgerFresh(job) {
  const caseId = Number(job?.caseId);
  const domain = String(job?.domain || "").toUpperCase();
  if (!Number.isFinite(caseId) || caseId <= 0) {
    return { resolved: false, note: "no-caseId-on-job" };
  }
  if (!domain) {
    return { resolved: false, note: "no-domain-on-job" };
  }

  const newest = await PaymentLedger.findOne({ domain, caseId })
    .sort({ updatedAt: -1 })
    .select({ updatedAt: 1, recordedAt: 1 })
    .lean();

  if (!newest) {
    return { resolved: false, note: "no-ledger-rows-yet" };
  }

  const touchedAt = newest.updatedAt || newest.recordedAt;
  if (!touchedAt) {
    return { resolved: false, note: "ledger-row-missing-timestamp" };
  }

  const ageMs = Date.now() - new Date(touchedAt).getTime();
  if (ageMs < PAYMENT_LEDGER_FRESH_WINDOW_MS) {
    return {
      resolved: true,
      note: `ledger fresh (${Math.round(ageMs / 60000)}m since last touch)`,
    };
  }
  return {
    resolved: false,
    note: `ledger stale (${Math.round(ageMs / 60000)}m since last touch)`,
  };
}

/**
 * "cx-logics-action-state": emitted when a CX Logics action failed
 * with no `caseId` in context (typically `logics-find-match` or a
 * read operation). There's no cheap read that fully proves the action
 * succeeded — but we can skip the retry when the *request workflow*
 * already moved to a terminal state, meaning a parallel path handled
 * it. Falls through to handler when uncertain.
 */
async function cxLogicsActionState(job) {
  const workflowId = job?.sourceWorkflowId;
  if (!workflowId) {
    return { resolved: false, note: "no-source-workflow" };
  }
  try {
    const {
      workflowRecordRepository,
    } = require("../../shared-repositories/src");
    const wf = await workflowRecordRepository.findWorkflowRecordById(workflowId);
    if (!wf) return { resolved: false, note: "workflow-missing" };
    const terminal = ["completed", "cancelled", "succeeded"];
    if (terminal.includes(String(wf.status || "").toLowerCase())) {
      return { resolved: true, note: `workflow ${wf.status}` };
    }
    return { resolved: false, note: `workflow ${wf.status}` };
  } catch (error) {
    return { resolved: false, note: `check-threw:${error.message.slice(0, 80)}` };
  }
}

/**
 * "outbound-delivery-state": did a delivery-status callback from the
 * carrier land since the retry was emitted? Check the paired outbound
 * ConversationMessage row for a terminal provider status.
 */
async function outboundDeliveryState(job) {
  const messageId =
    job?.payload?.conversationMessageId || job?.payload?.outboundMessageId;
  if (!messageId) {
    return { resolved: false, note: "no-message-id-on-payload" };
  }
  const doc = await ConversationMessage.findById(messageId)
    .select({ providerStatus: 1 })
    .lean();
  if (!doc) return { resolved: false, note: "message-missing" };
  // "delivered" is the only truly resolved state. "failed"/"undelivered"
  // are terminal but confirm the retry *did* need to fire (don't
  // short-circuit those — the cancel handler should still run).
  if (doc.providerStatus === "delivered") {
    return { resolved: true, note: "provider delivered" };
  }
  return { resolved: false, note: `provider ${doc.providerStatus || "unknown"}` };
}

/**
 * "recording-ready-state": transcription pipeline retries wait for
 * RC to publish the recording. Treat as resolved when the CallLog
 * has a `transcription.text` populated — someone (this service or a
 * parallel run) already ran it through Whisper.
 */
async function recordingReadyState(job) {
  const sessionId =
    job?.payload?.telephonySessionId ||
    job?.payload?.sessionId ||
    job?.aggregateId;
  if (!sessionId) {
    return { resolved: false, note: "no-session-id" };
  }
  const callLog = await CallLog.findOne({ telephonySessionId: String(sessionId) })
    .select({ "transcription.text": 1, "transcription.status": 1 })
    .lean();
  if (!callLog) return { resolved: false, note: "calllog-missing" };
  if (callLog.transcription?.text) {
    return { resolved: true, note: "transcript present" };
  }
  if (callLog.transcription?.status === "abandoned") {
    return { resolved: true, note: "marked abandoned — stop retrying" };
  }
  return {
    resolved: false,
    note: `transcript status ${callLog.transcription?.status || "none"}`,
  };
}

/**
 * "recording-archive-ready-state": long-call archive retries should stop
 * once the Drive upload completed, or once the archive path hit a
 * terminal non-retry state (skipped/no-group-match/abandoned).
 */
async function recordingArchiveReadyState(job) {
  const sessionId =
    job?.payload?.telephonySessionId ||
    job?.payload?.sessionId ||
    job?.aggregateId;
  if (!sessionId) {
    return { resolved: false, note: "no-session-id" };
  }
  const callLog = await CallLog.findOne({ telephonySessionId: String(sessionId) })
    .select({ "recordingArchive.status": 1, "recordingArchive.driveFileId": 1 })
    .lean();
  if (!callLog) return { resolved: false, note: "calllog-missing" };
  if (callLog.recordingArchive?.status === "completed") {
    return {
      resolved: true,
      note: `drive-file:${callLog.recordingArchive?.driveFileId || "uploaded"}`,
    };
  }
  if (["no_group_match", "skipped", "abandoned"].includes(String(callLog.recordingArchive?.status || ""))) {
    return {
      resolved: true,
      note: `terminal:${callLog.recordingArchive?.status}`,
    };
  }
  return {
    resolved: false,
    note: `archive status ${callLog.recordingArchive?.status || "none"}`,
  };
}

/**
 * "social-reply-state": FB/IG comment or DM reply retry. No cheap
 * read proves Meta delivered; we skip retry only when the operator
 * explicitly marked the responder conversation "closed" in the admin
 * UI. Conservative — most retries will fall through to the handler.
 */
async function socialReplyState(job) {
  const threadKey = job?.payload?.threadKey || job?.payload?.senderId;
  if (!threadKey) {
    return { resolved: false, note: "no-thread-key" };
  }
  // Until a dedicated SocialConversation table exists, we can't reliably
  // probe for resolution. Return `false` so the handler always runs —
  // the handler's own dup-check is responsible for avoiding double-posts.
  return {
    resolved: false,
    note: "no-state-probe-available-yet",
  };
}

/**
 * "telephony-session-attributed": attribution retries succeed once
 * the CallLog has a `sourceCanonicalId` written. The resolver backs
 * off retries when attribution has already landed via a parallel
 * lookup path (legs, CallRail recon, etc.).
 */
async function telephonySessionAttributed(job) {
  const sessionId =
    job?.payload?.telephonySessionId ||
    job?.payload?.candidate?.telephonySessionId ||
    job?.aggregateId;
  if (!sessionId) {
    return { resolved: false, note: "no-session-id" };
  }
  const callLog = await CallLog.findOne({ telephonySessionId: String(sessionId) })
    .select({ sourceCanonicalId: 1, attribution: 1 })
    .lean();
  if (!callLog) return { resolved: false, note: "calllog-missing" };
  if (callLog.sourceCanonicalId) {
    return {
      resolved: true,
      note: `attributed via ${callLog.attribution?.matchedBy || "unknown"}`,
    };
  }
  return { resolved: false, note: "no-attribution-yet" };
}

/**
 * "auto-responder-delivery-state": SMS auto-responder cleanup retries
 * resolve once the paired ConversationWorkflow has been manually
 * touched — if an operator opened and dispositioned the thread, the
 * automated cleanup is redundant.
 */
async function autoResponderDeliveryState(job) {
  const workflowId = job?.payload?.workflowId || job?.sourceWorkflowId;
  if (!workflowId) {
    return { resolved: false, note: "no-workflow-id" };
  }
  const wf = await ConversationWorkflow.findById(workflowId)
    .select({ status: 1, metadata: 1 })
    .lean();
  if (!wf) return { resolved: false, note: "workflow-missing" };
  if (wf.metadata?.lastInboxAction) {
    return {
      resolved: true,
      note: `operator-touched:${wf.metadata.lastInboxAction}`,
    };
  }
  if (wf.metadata?.autoReplySuppressed) {
    return { resolved: true, note: "already-suppressed" };
  }
  if (wf.status === "closed" || wf.status === "suppressed") {
    return { resolved: true, note: `terminal:${wf.status}` };
  }
  return { resolved: false, note: `wf status ${wf.status}` };
}

async function lexisDailyDropSent(job) {
  const { isLexisDailyDropDelivered } = require("./lexisDailyDropService");
  const domain = String(job?.domain || "TAG").toUpperCase();
  const dateKey =
    job?.payload?.dateKey ||
    String(job?.aggregateId || "").split(":").slice(1).join(":");
  if (!dateKey) {
    return { resolved: false, note: "no-date-key" };
  }
  if (isLexisDailyDropDelivered(domain, dateKey)) {
    return { resolved: true, note: `daily-drop-sent:${dateKey}` };
  }
  return { resolved: false, note: `daily-drop-pending:${dateKey}` };
}

// Register all built-in checks on module load.
registerResolutionCheck("logics-case-visible", logicsCaseVisible);
registerResolutionCheck("payment-ledger-fresh", paymentLedgerFresh);
registerResolutionCheck("cx-logics-action-state", cxLogicsActionState);
registerResolutionCheck("outbound-delivery-state", outboundDeliveryState);
registerResolutionCheck("recording-ready-state", recordingReadyState);
registerResolutionCheck("recording-archive-ready-state", recordingArchiveReadyState);
registerResolutionCheck("social-reply-state", socialReplyState);
registerResolutionCheck("telephony-session-attributed", telephonySessionAttributed);
registerResolutionCheck("auto-responder-delivery-state", autoResponderDeliveryState);
registerResolutionCheck("lexis-daily-drop-sent", lexisDailyDropSent);

module.exports = {
  PAYMENT_LEDGER_FRESH_WINDOW_MS,
  autoResponderDeliveryState,
  cxLogicsActionState,
  lexisDailyDropSent,
  logicsCaseVisible,
  outboundDeliveryState,
  paymentLedgerFresh,
  recordingArchiveReadyState,
  recordingReadyState,
  socialReplyState,
  telephonySessionAttributed,
};
