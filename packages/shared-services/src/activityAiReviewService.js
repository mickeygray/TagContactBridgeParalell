"use strict";

const { createAnthropicClient } = require("../../shared-integrations/src");
const { activityAiReviewRepository, caseProfileRepository } = require("../../shared-repositories/src");
const { createLogicsFacade } = require("./logicsFacadeService");

const PROMPT_VERSION = "v1";
const REVIEW_TYPE = "contact-safety";

function trimText(value, maxLength = 600) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function formatActivitiesForPrompt(activities = []) {
  return activities
    .slice(0, 40)
    .map((activity, index) => {
      const createdDate = activity.CreatedDate || activity.ModifiedDate || "";
      const subject = trimText(activity.Subject || "");
      const comment = trimText(activity.Comment || "");
      const activityType = trimText(activity.ActivityType || "");
      return [
        `Activity ${index + 1}:`,
        `Created: ${createdDate || "unknown"}`,
        `Type: ${activityType || "unknown"}`,
        `Subject: ${subject || "none"}`,
        `Comment: ${comment || "none"}`,
      ].join("\n");
    })
    .join("\n\n");
}

function buildSystemPrompt() {
  return [
    "You review CRM case activities for future contact safety.",
    "Focus on whether the business should continue contacting the person.",
    "Pay special attention to signals like do not call, stop texting, cease and desist, hostile threats, attorney representation, wrong person, deceased, fraud claims, language barrier, already signed elsewhere, or explicit lack of consent.",
    "Return strict JSON only.",
    'Use this schema: {"status":"allow_contact|pause_contact|stop_contact|manual_review","confidence":"low|medium|high","recommendedAction":"short string","rationale":"short paragraph","concerns":["short concern"],"positiveNotes":["short positive note"],"evidence":["quote or paraphrase"],"riskFlags":["flag"]}',
  ].join(" ");
}

function buildUserPrompt(domain, caseId, activities) {
  return [
    `Domain: ${domain}`,
    `Case ID: ${caseId}`,
    `Review type: ${REVIEW_TYPE}`,
    "Task: Determine whether future contact should continue based on the activities below.",
    "If the notes show strong negative consent or legal risk, prefer stop_contact.",
    "If the notes are mixed or unclear, prefer manual_review.",
    "Activities:",
    formatActivitiesForPrompt(activities),
  ].join("\n\n");
}

function parseReviewJson(text) {
  const raw = String(text || "").trim();
  if (!raw) {
    throw new Error("Anthropic returned empty review text");
  }

  const fenced = raw.match(/```json\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : raw;
  return JSON.parse(candidate);
}

function normalizeReview(review, activities) {
  const allowedStatuses = new Set([
    "allow_contact",
    "pause_contact",
    "stop_contact",
    "manual_review",
  ]);
  const allowedConfidence = new Set(["low", "medium", "high"]);

  const status = allowedStatuses.has(review.status) ? review.status : "manual_review";
  const confidence = allowedConfidence.has(review.confidence)
    ? review.confidence
    : "medium";

  const createdDates = activities
    .map((activity) => new Date(activity.CreatedDate || activity.ModifiedDate || null))
    .filter((date) => !Number.isNaN(date.getTime()))
    .sort((a, b) => a.getTime() - b.getTime());

  return {
    reviewType: REVIEW_TYPE,
    status,
    confidence,
    recommendedAction: trimText(review.recommendedAction || "", 160) || null,
    rationale: trimText(review.rationale || "", 1200) || null,
    concerns: Array.isArray(review.concerns)
      ? review.concerns.map((item) => trimText(item, 180)).filter(Boolean).slice(0, 8)
      : [],
    positiveNotes: Array.isArray(review.positiveNotes)
      ? review.positiveNotes.map((item) => trimText(item, 180)).filter(Boolean).slice(0, 8)
      : [],
    evidence: Array.isArray(review.evidence)
      ? review.evidence.map((item) => trimText(item, 260)).filter(Boolean).slice(0, 8)
      : [],
    riskFlags: Array.isArray(review.riskFlags)
      ? review.riskFlags.map((item) => trimText(item, 80)).filter(Boolean).slice(0, 8)
      : [],
    activityCount: activities.length,
    activityWindow: {
      oldestAt: createdDates[0] || null,
      newestAt: createdDates[createdDates.length - 1] || null,
    },
    promptVersion: PROMPT_VERSION,
  };
}

async function reviewCaseActivities(domain, caseId, options = {}) {
  const normalizedDomain = String(domain || "").toUpperCase();
  const numericCaseId = Number(caseId);
  const facade = createLogicsFacade(normalizedDomain);
  const client = createAnthropicClient();

  const activities = await facade.fetchActivities(numericCaseId);
  if (!Array.isArray(activities) || activities.length === 0) {
    return {
      ok: false,
      domain: normalizedDomain,
      caseId: numericCaseId,
      reason: "no-activities",
    };
  }

  const response = await client.createMessage({
    system: buildSystemPrompt(),
    messages: [
      {
        role: "user",
        content: buildUserPrompt(normalizedDomain, numericCaseId, activities),
      },
    ],
    model: options.model,
    maxTokens: options.maxTokens,
    temperature: options.temperature,
  });

  const rawResponseText = client.extractTextBlocks(response);
  const parsed = parseReviewJson(rawResponseText);
  const normalized = normalizeReview(parsed, activities);

  const record = await activityAiReviewRepository.createActivityAiReview({
    domain: normalizedDomain,
    caseId: numericCaseId,
    model: response.model || client.config.model,
    provider: "anthropic",
    rawResponseText,
    rawResponseJson: parsed,
    reviewedAt: new Date(),
    ...normalized,
  });

  await caseProfileRepository.upsertCaseProfile(normalizedDomain, numericCaseId, {
    aiActivityReview: {
      reviewId: record._id,
      status: normalized.status,
      confidence: normalized.confidence,
      recommendedAction: normalized.recommendedAction,
      rationale: normalized.rationale,
      concerns: normalized.concerns,
      positiveNotes: normalized.positiveNotes,
      riskFlags: normalized.riskFlags,
      reviewedAt: record.reviewedAt,
      activityCount: normalized.activityCount,
    },
  });

  return {
    ok: true,
    domain: normalizedDomain,
    caseId: numericCaseId,
    activityCount: activities.length,
    review: {
      reviewId: record._id,
      status: normalized.status,
      confidence: normalized.confidence,
      recommendedAction: normalized.recommendedAction,
      rationale: normalized.rationale,
      concerns: normalized.concerns,
      positiveNotes: normalized.positiveNotes,
      evidence: normalized.evidence,
      riskFlags: normalized.riskFlags,
      reviewedAt: record.reviewedAt,
      model: response.model || client.config.model,
    },
  };
}

module.exports = {
  REVIEW_TYPE,
  reviewCaseActivities,
};
