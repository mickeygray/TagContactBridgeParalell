"use strict";

const {
  conversationWorkflowRepository,
  reviewQueueRepository,
} = require("../../shared-repositories/src");
const { recordWorkflowStage } = require("./workflowStateService");

function normalizeDomain(domain) {
  return String(domain || "").trim().toUpperCase();
}

function toCaseId(value) {
  const next = Number(value);
  return Number.isFinite(next) ? next : null;
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
  const nextDraft = body.draft != null ? String(body.draft).trim() : workflow.aiDraftReply || null;

  const updated = await conversationWorkflowRepository.updateConversationWorkflowById(workflowId, {
    status: "drafted",
    aiDraftReply: nextDraft,
    aiRecommendedAction: "approve-send",
    metadata: {
      ...(workflow.metadata || {}),
      inboxState: "approved",
      lastInboxAction: "approve",
      lastInboxActionAt: new Date(),
      lastInboxActionBy: user?.email || null,
    },
  });

  const reviewItem = await recordInboxReviewItem(normalizedDomain, workflow, "approve", user, body);
  const workflowRecord = await completeInboxAction({
    domain: normalizedDomain,
    workflow,
    action: "approve",
    stage: "completed",
    title: "Inbox draft approved",
    summary: "Draft approved for outbound send handling",
    payload: {
      actorEmail: user?.email || null,
      note: body.note || null,
      draft: nextDraft,
    },
    result: {
      status: updated?.status || "drafted",
      reviewItemId: String(reviewItem._id),
    },
  });

  return {
    domain: normalizedDomain,
    workflowId: String(workflow._id),
    action: "approve",
    status: updated?.status || "drafted",
    reviewItemId: String(reviewItem._id),
    workflowRecordId: String(workflowRecord._id),
    draft: updated?.aiDraftReply || null,
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
  const nextDraft = String(body.draft || "").trim();
  if (!nextDraft) {
    const error = new Error("Draft is required");
    error.status = 400;
    throw error;
  }

  const updated = await conversationWorkflowRepository.updateConversationWorkflowById(workflowId, {
    status: "drafted",
    aiDraftReply: nextDraft,
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
      draft: nextDraft,
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
    draft: updated?.aiDraftReply || null,
  };
}

async function regenerateInboxWorkflow(domain, workflowId, user, body = {}) {
  const normalizedDomain = normalizeDomain(domain);
  const workflow = await loadWorkflow(normalizedDomain, workflowId);
  const seed = String(body.seed || body.note || "").trim();
  const nextDraft = seed
    ? `${workflow.aiDraftReply || workflow.latestInboundText || ""}\n\n${seed}`.trim()
    : workflow.aiDraftReply || workflow.latestInboundText || "";

  const updated = await conversationWorkflowRepository.updateConversationWorkflowById(workflowId, {
    status: "manual-review",
    aiDraftReply: nextDraft || workflow.aiDraftReply || null,
    aiRecommendedAction: "regenerate",
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

module.exports = {
  approveInboxWorkflow,
  cancelInboxWorkflow,
  dncInboxWorkflow,
  editSendInboxWorkflow,
  regenerateInboxWorkflow,
  sleepInboxWorkflow,
  wakeInboxWorkflow,
};
