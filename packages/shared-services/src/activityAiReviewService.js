"use strict";

const { createAnthropicClient } = require("../../shared-integrations/src");
const { activityAiReviewRepository, caseProfileRepository } = require("../../shared-repositories/src");
const { createLogicsFacade } = require("./logicsFacadeService");
const { createAiTaskClient } = require("./aiTaskClient");

const PROMPT_VERSION = "v1";
const REVIEW_TYPE = "contact-safety";
const ACTIVITY_TASK_ID = "activity.contactSafetyReview";

// Lazy bus client (control-plane 5001 -> ai-bus 7000), built once per process.
let _aiTaskClient = null;
function getAiTaskClient() {
  if (!_aiTaskClient) _aiTaskClient = createAiTaskClient();
  return _aiTaskClient;
}

// Same flag the bus uses to enable the task — one switch turns the whole
// 5001->7000 round-trip on. Default OFF = byte-identical to legacy behavior.
function activityBusEnabled() {
  return ["1", "true", "yes", "on"].includes(
    String(process.env.AI_TASK_ACTIVITY_CONTACTSAFETYREVIEW_ENABLED || "").trim().toLowerCase(),
  );
}

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

// ── Model execution step (the only part that moves to the bus) ────────────────
// Routes through the AI bus (5001 -> 7000 -> 5001) when the task flag is on, and
// falls back to the legacy direct Anthropic call on ANY bus miss (disabled,
// contract failure, or transport error) so a down/slow bus never breaks a batch.
// Returns { parsed (review JSON), rawResponseText, model, provider }.
async function runActivityModel({ domain, caseId, activities, options = {}, deps = {} }) {
  const enabled = deps.activityBusEnabled ? deps.activityBusEnabled() : activityBusEnabled();
  if (enabled) {
    const client = deps.aiTaskClient || getAiTaskClient();
    try {
      const bus = await client.runAiTask(
        ACTIVITY_TASK_ID,
        { domain, caseId, activities },
        { caller: "control-plane.activity-review" },
      );
      if (bus && bus.ok && bus.result && typeof bus.result === "object") {
        return {
          parsed: bus.result,
          rawResponseText: JSON.stringify(bus.result),
          model: bus.model || null,
          provider: bus.provider || "bus",
          via: "bus",
        };
      }
      // bus disabled / contract miss / transport failure -> fall through to legacy
    } catch {
      // never let the bus break the batch
    }
  }
  return runLegacyActivityModel({ domain, caseId, activities, options, deps });
}

async function runLegacyActivityModel({ domain, caseId, activities, options = {}, deps = {} }) {
  const makeClient = deps.createAnthropicClient || createAnthropicClient;
  const client = makeClient();
  const response = await client.createMessage({
    system: buildSystemPrompt(),
    messages: [{ role: "user", content: buildUserPrompt(domain, caseId, activities) }],
    model: options.model,
    maxTokens: options.maxTokens,
    temperature: options.temperature,
  });
  const rawResponseText = client.extractTextBlocks(response);
  return {
    parsed: parseReviewJson(rawResponseText),
    rawResponseText,
    model: response.model || client.config.model,
    provider: "anthropic",
    via: "legacy",
  };
}

async function reviewCaseActivities(domain, caseId, options = {}, deps = {}) {
  const normalizedDomain = String(domain || "").toUpperCase();
  const numericCaseId = Number(caseId);
  const facade = deps.facade || createLogicsFacade(normalizedDomain);
  const repos = deps.repositories || { activityAiReviewRepository, caseProfileRepository };

  const activities = await facade.fetchActivities(numericCaseId);
  if (!Array.isArray(activities) || activities.length === 0) {
    return {
      ok: false,
      domain: normalizedDomain,
      caseId: numericCaseId,
      reason: "no-activities",
    };
  }

  const { parsed, rawResponseText, model, provider, via } = await runActivityModel({
    domain: normalizedDomain,
    caseId: numericCaseId,
    activities,
    options,
    deps,
  });
  const normalized = normalizeReview(parsed, activities);

  const record = await repos.activityAiReviewRepository.createActivityAiReview({
    domain: normalizedDomain,
    caseId: numericCaseId,
    model,
    provider,
    rawResponseText,
    rawResponseJson: parsed,
    reviewedAt: new Date(),
    ...normalized,
  });

  await repos.caseProfileRepository.upsertCaseProfile(normalizedDomain, numericCaseId, {
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
    via,
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
      model,
    },
  };
}

module.exports = {
  REVIEW_TYPE,
  reviewCaseActivities,
  // exported for the prompt-parity test + reuse
  buildSystemPrompt,
  buildUserPrompt,
  formatActivitiesForPrompt,
  activityBusEnabled,
};
