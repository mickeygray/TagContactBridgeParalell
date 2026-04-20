"use strict";

const {
  caseProfileRepository,
  conversationWorkflowRepository,
  qualityReviewRepository,
} = require("../../shared-repositories/src");

function normalizeDomain(domain) {
  return String(domain || "").trim().toUpperCase();
}

async function recordQualityReview(input = {}) {
  const domain = normalizeDomain(input.domain);
  const caseId = Number(input.caseId);
  const review = await qualityReviewRepository.createQualityReview({
    domain,
    caseId,
    provider: input.provider || "anthropic",
    reviewType: input.reviewType || "case-review",
    sourceService: input.sourceService || "control-plane",
    externalId: input.externalId || null,
    status: input.status || null,
    confidence: input.confidence || null,
    score: input.score != null ? Number(input.score) : null,
    summary: input.summary || null,
    positives: Array.isArray(input.positives) ? input.positives : [],
    concerns: Array.isArray(input.concerns) ? input.concerns : [],
    flags: Array.isArray(input.flags) ? input.flags : [],
    rawResponse: input.rawResponse || null,
    reviewedAt: input.reviewedAt ? new Date(input.reviewedAt) : new Date(),
  });

  await caseProfileRepository.upsertCaseProfile(domain, caseId, {
    qcSummary: {
      reviewId: review._id,
      status: review.status,
      confidence: review.confidence,
      score: review.score,
      summary: review.summary,
      positives: review.positives,
      concerns: review.concerns,
      flags: review.flags,
      reviewedAt: review.reviewedAt,
      reviewType: review.reviewType,
    },
  });

  return review;
}

async function recordConversationAi(input = {}) {
  const domain = normalizeDomain(input.domain);
  const phone = String(input.phone || "").replace(/\D/g, "");
  const workflow = await conversationWorkflowRepository.upsertConversationWorkflow(domain, phone, {
    caseId: input.caseId != null ? Number(input.caseId) : null,
    channel: input.channel || "sms",
    status: input.status || "observed",
    optOutDetected: Boolean(input.optOutDetected),
    optedOutAt: input.optedOutAt ? new Date(input.optedOutAt) : null,
    latestInboundText: input.latestInboundText || null,
    latestInboundAt: input.latestInboundAt ? new Date(input.latestInboundAt) : new Date(),
    aiRecommendedAction: input.aiRecommendedAction || null,
    aiDraftReply: input.aiDraftReply || null,
    aiConfidence: input.aiConfidence || null,
    aiFlags: Array.isArray(input.aiFlags) ? input.aiFlags : [],
    aiSummary: input.aiSummary || null,
    sourceService: input.sourceService || "control-plane",
    metadata: input.metadata || null,
  });

  if (workflow.caseId != null) {
    await caseProfileRepository.upsertCaseProfile(domain, workflow.caseId, {
      conversationAi: {
        workflowId: workflow._id,
        status: workflow.status,
        optOutDetected: workflow.optOutDetected,
        latestInboundAt: workflow.latestInboundAt,
        latestInboundText: workflow.latestInboundText,
        aiRecommendedAction: workflow.aiRecommendedAction,
        aiConfidence: workflow.aiConfidence,
        aiFlags: workflow.aiFlags,
        aiSummary: workflow.aiSummary,
      },
    });
  }

  return workflow;
}

module.exports = {
  recordConversationAi,
  recordQualityReview,
};
