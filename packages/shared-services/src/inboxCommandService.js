"use strict";

const {
  caseProfileRepository,
  conversationMessageRepository,
  conversationWorkflowRepository,
  reviewQueueRepository,
} = require("../../shared-repositories/src");
const { createCallrailClient } = require("../../shared-integrations/src");
const { recordWorkflowStage } = require("./workflowStateService");
const { enforceReplyConstraints } = require("./smsAutoResponderService");

function normalizeDomain(domain) {
  return String(domain || "").trim().toUpperCase();
}

function toCaseId(value) {
  const next = Number(value);
  return Number.isFinite(next) ? next : null;
}

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

function buildProviderThreadKey(domain, phone, workflowId) {
  return `${normalizeDomain(domain)}:sms-inbox:${workflowId || normalizePhone(phone) || "unknown"}`;
}

// How long a soft-lock from a rep's outbound stays "fresh" before it
// auto-expires. Belt-and-suspenders for the inbound-clears-lock path:
// if the prospect never replies, the lock evaporates 15 min after the
// last outbound so the thread isn't permanently held.
const SMS_LOCK_FRESH_MS = 15 * 60 * 1000;

function userIdForLock(user) {
  return String(user?.id || user?._id || user?.email || "unknown");
}

function userNameForLock(user) {
  return String(user?.name || user?.email || "rep");
}

/**
 * Throws a 409 if another rep currently holds the soft-lock on this
 * thread. Admins and the lock owner pass through. Caller can opt out
 * by passing body.override: true (used by an explicit "Take over"
 * affordance in the UI).
 */
function assertSmsLockAvailable(workflow, user, body = {}) {
  if (body?.override === true) return;
  if (user?.role === "admin") return;
  const lockedBy = workflow.smsLockedByAgentId;
  if (!lockedBy) return;
  const currentUserId = userIdForLock(user);
  if (lockedBy === currentUserId) return;
  const lockedAt = workflow.smsLockedAt ? new Date(workflow.smsLockedAt).getTime() : 0;
  if (!lockedAt || Date.now() - lockedAt > SMS_LOCK_FRESH_MS) return;
  const error = new Error(
    `${workflow.smsLockedByAgentName || "Another rep"} is currently replying to this thread. Wait for the next inbound or use the "Take over" override.`,
  );
  error.status = 409;
  error.code = "sms-lock-held";
  error.lockedByName = workflow.smsLockedByAgentName || null;
  throw error;
}

function stampSmsLockUpdate(user) {
  return {
    smsLockedByAgentId: userIdForLock(user),
    smsLockedByAgentName: userNameForLock(user),
    smsLockedAt: new Date(),
  };
}

async function loadWorkflow(domain, workflowId) {
  const normalizedDomain = normalizeDomain(domain);
  const workflow = await conversationWorkflowRepository.findConversationWorkflowById(workflowId);
  if (!workflow || workflow.domain !== normalizedDomain) {
    const error = new Error("Conversation workflow not found");
    error.status = 404;
    throw error;
  }
  return workflow;
}

async function recordInboxReviewItem(domain, workflow, action, user, body, severity = "info") {
  return reviewQueueRepository.createReviewQueueItem({
    domain,
    caseId: toCaseId(workflow.caseId),
    sourceService: "control-plane",
    workflow: "sms-inbox",
    category: action,
    severity,
    status: "reviewed",
    title: `Inbox ${action}`,
    summary: body.note || body.reason || null,
    customerName: workflow.metadata?.customerName || null,
    primaryPhone: workflow.phone || null,
    happenedAt: new Date(),
    resolvedAt: new Date(),
    resolutionNote: body.note || body.reason || null,
    payload: {
      workflowId: String(workflow._id),
      action,
      actorEmail: user?.email || null,
      actorName: user?.name || null,
      note: body.note || body.reason || null,
      draft: body.draft || null,
      sleepUntil: body.sleepUntil || null,
    },
    tags: ["sms", "inbox", action],
  });
}

async function recordManualSmsSend({
  domain,
  workflow,
  user,
  draft,
  providerStatus,
  providerMessageId = null,
  providerError = null,
}) {
  const workflowId = String(workflow._id || workflow.id || "");
  const caseId = toCaseId(workflow.caseId);
  const outbound = await conversationMessageRepository.createOutboundMessage({
    workflowId,
    domain,
    phone: workflow.phone,
    caseId,
    channel: "sms",
    body: draft,
    provider: "callrail",
    providerMessageId,
    providerStatus,
    providerError,
    autoResponded: false,
    approvedByEmail: user?.email || null,
  });

  if (caseId) {
    await caseProfileRepository
      .appendCommunicationThread(domain, caseId, "sms", {
        provider: "callrail",
        providerMessageId,
        providerError,
        threadKey: providerMessageId || buildProviderThreadKey(domain, workflow.phone, workflowId),
        direction: "outbound",
        phone: workflow.phone,
        body: draft,
        status: providerStatus,
        workflowId,
        conversationMessageId: outbound?.id || null,
        sentAt: outbound?.createdAt || new Date(),
        source: "sms-inbox-manual",
        actorEmail: user?.email || null,
        actorName: user?.name || user?.email || null,
        metadata: {
          inboxAction: "approve",
          autoResponded: false,
        },
      })
      .catch(() => null);
  }

  return outbound;
}

async function sendApprovedSmsReply(domain, workflow, user, draft) {
  const phone = normalizePhone(workflow.phone);
  if (!phone) {
    const error = new Error("Conversation phone is missing");
    error.status = 400;
    throw error;
  }
  const client = createCallrailClient(domain);
  let sendResult = null;
  let sendError = null;
  try {
    sendResult = await client.sendSms({ phone, text: draft });
  } catch (error) {
    sendError = error;
  }

  const providerMessageId = sendResult?.providerMessageId || null;
  const providerStatus = sendError ? "failed" : "sent";
  const outbound = await recordManualSmsSend({
    domain,
    workflow,
    user,
    draft,
    providerStatus,
    providerMessageId,
    providerError: sendError?.message || null,
  });

  return {
    ok: !sendError,
    response: sendResult || null,
    error: sendError,
    providerMessageId,
    providerStatus,
    outboundMessageId: outbound?.id || null,
  };
}

async function completeInboxAction({
  domain,
  workflow,
  action,
  stage,
  title,
  summary,
  payload,
  result,
  sourceService = "control-plane",
}) {
  return recordWorkflowStage({
    domain,
    family: "conversation",
    subtype: action,
    stage,
    aggregateType: "conversation-workflow",
    aggregateId: String(workflow._id),
    caseId: toCaseId(workflow.caseId),
    sourceService,
    title,
    summary,
    payload,
    result,
  });
}

async function approveInboxWorkflow(domain, workflowId, user, body = {}) {
  const normalizedDomain = normalizeDomain(domain);
  const workflow = await loadWorkflow(normalizedDomain, workflowId);
  assertSmsLockAvailable(workflow, user, body);
  const rawDraft = body.draft != null ? String(body.draft).trim() : workflow.aiDraftReply || null;
  if (!rawDraft) {
    const error = new Error("Draft is required");
    error.status = 400;
    throw error;
  }
  const nextDraft = enforceReplyConstraints(rawDraft, normalizedDomain);
  if (workflow.optOutDetected) {
    const error = new Error("This conversation is opted out. Do not send SMS.");
    error.status = 409;
    throw error;
  }

  const sendResult = await sendApprovedSmsReply(normalizedDomain, workflow, user, nextDraft);

  const updated = await conversationWorkflowRepository.updateConversationWorkflowById(workflowId, {
    status: sendResult.ok ? "sent" : "manual-review",
    aiDraftReply: nextDraft,
    aiRecommendedAction: sendResult.ok ? "manual_approved_send" : "manual_send_failed",
    ...stampSmsLockUpdate(user),
    metadata: {
      ...(workflow.metadata || {}),
      inboxState: sendResult.ok ? "sent" : "send-failed",
      lastInboxAction: "approve",
      lastInboxActionAt: new Date(),
      lastInboxActionBy: user?.email || null,
      provider: "callrail",
      providerMessageId: sendResult.providerMessageId || null,
      outboundMessageId: sendResult.outboundMessageId || null,
      sendError: sendResult.error?.message || null,
    },
  });

  const reviewItem = await recordInboxReviewItem(
    normalizedDomain,
    workflow,
    sendResult.ok ? "approve-send" : "approve-send-failed",
    user,
    body,
    sendResult.ok ? "info" : "warning",
  );
  const workflowRecord = await completeInboxAction({
    domain: normalizedDomain,
    workflow,
    action: "approve",
    stage: sendResult.ok ? "completed" : "failed",
    title: sendResult.ok ? "Inbox reply sent" : "Inbox reply failed",
    summary: sendResult.ok
      ? "Approved SMS reply sent through CallRail"
      : `Approved SMS reply failed: ${sendResult.error?.message || "unknown error"}`,
    payload: {
      actorEmail: user?.email || null,
      note: body.note || null,
      draft: nextDraft,
    },
    result: {
      status: updated?.status || (sendResult.ok ? "sent" : "manual-review"),
      reviewItemId: String(reviewItem._id),
      outboundMessageId: sendResult.outboundMessageId || null,
      providerMessageId: sendResult.providerMessageId || null,
      providerStatus: sendResult.providerStatus,
      error: sendResult.error?.message || null,
    },
  });

  if (!sendResult.ok) {
    const error = new Error(sendResult.error?.message || "SMS send failed");
    error.status = sendResult.error?.status || 502;
    error.details = {
      workflowId: String(workflow._id),
      reviewItemId: String(reviewItem._id),
      workflowRecordId: String(workflowRecord._id),
      outboundMessageId: sendResult.outboundMessageId || null,
    };
    throw error;
  }

  return {
    domain: normalizedDomain,
    workflowId: String(workflow._id),
    action: "approve",
    status: updated?.status || "sent",
    completed: true,
    reviewItemId: String(reviewItem._id),
    workflowRecordId: String(workflowRecord._id),
    draft: updated?.aiDraftReply || null,
    outboundMessageId: sendResult.outboundMessageId || null,
    providerMessageId: sendResult.providerMessageId || null,
  };
}

async function cancelInboxWorkflow(domain, workflowId, user, body = {}) {
  const normalizedDomain = normalizeDomain(domain);
  const workflow = await loadWorkflow(normalizedDomain, workflowId);
  const updated = await conversationWorkflowRepository.updateConversationWorkflowById(workflowId, {
    status: "closed",
    metadata: {
      ...(workflow.metadata || {}),
      inboxState: "cancelled",
      lastInboxAction: "cancel",
      lastInboxActionAt: new Date(),
      lastInboxActionBy: user?.email || null,
    },
  });
  const reviewItem = await recordInboxReviewItem(normalizedDomain, workflow, "cancel", user, body, "warning");
  const workflowRecord = await completeInboxAction({
    domain: normalizedDomain,
    workflow,
    action: "cancel",
    stage: "completed",
    title: "Inbox workflow cancelled",
    summary: body.note || "Conversation closed from inbox",
    payload: {
      actorEmail: user?.email || null,
      note: body.note || null,
    },
    result: {
      status: updated?.status || "closed",
      reviewItemId: String(reviewItem._id),
    },
  });

  return {
    domain: normalizedDomain,
    workflowId: String(workflow._id),
    action: "cancel",
    status: updated?.status || "closed",
    reviewItemId: String(reviewItem._id),
    workflowRecordId: String(workflowRecord._id),
  };
}

async function editSendInboxWorkflow(domain, workflowId, user, body = {}) {
  const normalizedDomain = normalizeDomain(domain);
  const workflow = await loadWorkflow(normalizedDomain, workflowId);
  assertSmsLockAvailable(workflow, user, body);
  const nextDraft = String(body.draft || "").trim();
  if (!nextDraft) {
    const error = new Error("Draft is required");
    error.status = 400;
    throw error;
  }
  const constrainedDraft = enforceReplyConstraints(nextDraft, normalizedDomain);

  const updated = await conversationWorkflowRepository.updateConversationWorkflowById(workflowId, {
    status: "drafted",
    aiDraftReply: constrainedDraft,
    ...stampSmsLockUpdate(user),
    metadata: {
      ...(workflow.metadata || {}),
      inboxState: "edited",
      lastInboxAction: "edit-send",
      lastInboxActionAt: new Date(),
      lastInboxActionBy: user?.email || null,
    },
  });
  const reviewItem = await recordInboxReviewItem(normalizedDomain, workflow, "edit-send", user, body);
  const workflowRecord = await completeInboxAction({
    domain: normalizedDomain,
    workflow,
    action: "edit-send",
    stage: "completed",
    title: "Inbox draft edited",
    summary: "Draft updated for outbound send handling",
    payload: {
      actorEmail: user?.email || null,
      draft: constrainedDraft,
      note: body.note || null,
    },
    result: {
      status: updated?.status || "drafted",
      reviewItemId: String(reviewItem._id),
    },
  });

  return {
    domain: normalizedDomain,
    workflowId: String(workflow._id),
    action: "edit-send",
    status: updated?.status || "drafted",
    reviewItemId: String(reviewItem._id),
    workflowRecordId: String(workflowRecord._id),
    draft: updated?.aiDraftReply || constrainedDraft,
  };
}

async function regenerateInboxWorkflow(domain, workflowId, user, body = {}) {
  const normalizedDomain = normalizeDomain(domain);
  const workflow = await loadWorkflow(normalizedDomain, workflowId);
  assertSmsLockAvailable(workflow, user, body);
  const seed = String(body.seed || body.note || "").trim();
  const nextDraft = seed
    ? `${workflow.aiDraftReply || workflow.latestInboundText || ""}\n\n${seed}`.trim()
    : workflow.aiDraftReply || workflow.latestInboundText || "";

  const updated = await conversationWorkflowRepository.updateConversationWorkflowById(workflowId, {
    status: "manual-review",
    aiDraftReply: nextDraft || workflow.aiDraftReply || null,
    aiRecommendedAction: "regenerate",
    ...stampSmsLockUpdate(user),
    metadata: {
      ...(workflow.metadata || {}),
      inboxState: "regeneration-requested",
      lastInboxAction: "regenerate",
      lastInboxActionAt: new Date(),
      lastInboxActionBy: user?.email || null,
    },
  });
  const reviewItem = await recordInboxReviewItem(normalizedDomain, workflow, "regenerate", user, body, "warning");
  const workflowRecord = await completeInboxAction({
    domain: normalizedDomain,
    workflow,
    action: "regenerate",
    stage: "requested",
    title: "Inbox regeneration requested",
    summary: "Conversation moved back to manual review for a new draft",
    payload: {
      actorEmail: user?.email || null,
      seed,
    },
    result: {
      status: updated?.status || "manual-review",
      reviewItemId: String(reviewItem._id),
    },
  });

  return {
    domain: normalizedDomain,
    workflowId: String(workflow._id),
    action: "regenerate",
    status: updated?.status || "manual-review",
    reviewItemId: String(reviewItem._id),
    workflowRecordId: String(workflowRecord._id),
    draft: updated?.aiDraftReply || null,
  };
}

async function sleepInboxWorkflow(domain, workflowId, user, body = {}) {
  const normalizedDomain = normalizeDomain(domain);
  const workflow = await loadWorkflow(normalizedDomain, workflowId);
  const sleepUntil = body.sleepUntil ? new Date(body.sleepUntil) : new Date(Date.now() + 2 * 3600000);
  const updated = await conversationWorkflowRepository.updateConversationWorkflowById(workflowId, {
    status: "manual-review",
    metadata: {
      ...(workflow.metadata || {}),
      inboxState: "sleeping",
      sleepUntil,
      lastInboxAction: "sleep",
      lastInboxActionAt: new Date(),
      lastInboxActionBy: user?.email || null,
    },
  });
  const reviewItem = await recordInboxReviewItem(normalizedDomain, workflow, "sleep", user, {
    ...body,
    sleepUntil,
  });
  const workflowRecord = await completeInboxAction({
    domain: normalizedDomain,
    workflow,
    action: "sleep",
    stage: "completed",
    title: "Conversation snoozed",
    summary: `Conversation snoozed until ${sleepUntil.toISOString()}`,
    payload: {
      actorEmail: user?.email || null,
      sleepUntil,
      note: body.note || null,
    },
    result: {
      status: updated?.status || "manual-review",
      reviewItemId: String(reviewItem._id),
    },
  });

  return {
    domain: normalizedDomain,
    workflowId: String(workflow._id),
    action: "sleep",
    status: updated?.status || "manual-review",
    reviewItemId: String(reviewItem._id),
    workflowRecordId: String(workflowRecord._id),
    sleepUntil,
  };
}

async function wakeInboxWorkflow(domain, workflowId, user, body = {}) {
  const normalizedDomain = normalizeDomain(domain);
  const workflow = await loadWorkflow(normalizedDomain, workflowId);
  const updated = await conversationWorkflowRepository.updateConversationWorkflowById(workflowId, {
    status: "observed",
    metadata: {
      ...(workflow.metadata || {}),
      inboxState: "awake",
      sleepUntil: null,
      lastInboxAction: "wake",
      lastInboxActionAt: new Date(),
      lastInboxActionBy: user?.email || null,
    },
  });
  const reviewItem = await recordInboxReviewItem(normalizedDomain, workflow, "wake", user, body);
  const workflowRecord = await completeInboxAction({
    domain: normalizedDomain,
    workflow,
    action: "wake",
    stage: "completed",
    title: "Conversation reactivated",
    summary: "Conversation moved back into active inbox review",
    payload: {
      actorEmail: user?.email || null,
      note: body.note || null,
    },
    result: {
      status: updated?.status || "observed",
      reviewItemId: String(reviewItem._id),
    },
  });

  return {
    domain: normalizedDomain,
    workflowId: String(workflow._id),
    action: "wake",
    status: updated?.status || "observed",
    reviewItemId: String(reviewItem._id),
    workflowRecordId: String(workflowRecord._id),
  };
}

async function dncInboxWorkflow(domain, workflowId, user, body = {}) {
  const normalizedDomain = normalizeDomain(domain);
  const workflow = await loadWorkflow(normalizedDomain, workflowId);
  const updated = await conversationWorkflowRepository.updateConversationWorkflowById(workflowId, {
    status: "suppressed",
    optOutDetected: true,
    optedOutAt: new Date(),
    metadata: {
      ...(workflow.metadata || {}),
      inboxState: "dnc",
      suppressionReason: body.reason || body.note || "Inbox DNC action",
      lastInboxAction: "dnc",
      lastInboxActionAt: new Date(),
      lastInboxActionBy: user?.email || null,
    },
  });
  const reviewItem = await recordInboxReviewItem(normalizedDomain, workflow, "dnc", user, body, "critical");
  const workflowRecord = await completeInboxAction({
    domain: normalizedDomain,
    workflow,
    action: "dnc",
    stage: "completed",
    title: "Conversation suppressed",
    summary: "Contact marked do-not-contact from inbox",
    payload: {
      actorEmail: user?.email || null,
      reason: body.reason || body.note || null,
    },
    result: {
      status: updated?.status || "suppressed",
      reviewItemId: String(reviewItem._id),
    },
  });

  return {
    domain: normalizedDomain,
    workflowId: String(workflow._id),
    action: "dnc",
    status: updated?.status || "suppressed",
    reviewItemId: String(reviewItem._id),
    workflowRecordId: String(workflowRecord._id),
  };
}

// Manual "send to my campaign" was removed when the inbox shifted from
// rep-pull to AI-push routing. The hot-intent classifier + round-robin
// in hotIntentRouterService.js now stamp routedToAgentId at ingest time,
// so reps don't claim — they consume. See ConversationWorkflow.aiHotIntent
// and routedToAgentId for the new ownership model.

module.exports = {
  approveInboxWorkflow,
  cancelInboxWorkflow,
  dncInboxWorkflow,
  editSendInboxWorkflow,
  regenerateInboxWorkflow,
  sleepInboxWorkflow,
  wakeInboxWorkflow,
};
