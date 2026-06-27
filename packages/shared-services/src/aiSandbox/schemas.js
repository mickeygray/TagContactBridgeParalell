"use strict";

// SANDBOX — the tool/output schemas (the contracts), as real JS objects pulled
// from the live invocations + docs/AI_TASK_DICTIONARY.md. These become the bus
// task contracts. `strictReady` flags whether the shape already fits OpenAI's
// strict structured-output subset (all-required, enums, no loose keywords).

// ── sms.classify — Anthropic tool_use (forced) ───────────────────────────────
const SMS_CLASSIFY_TOOL = {
  name: "classify_sms",
  description: "Classify an inbound SMS and (when appropriate) draft a compliant reply.",
  input_schema: {
    type: "object",
    properties: {
      intent: { type: "string", description: "Short label, e.g. opt_out, do_not_contact, has_representation, doesnt_owe_taxes, taxes_already_filed, wrong_number, asked_cost, asked_process, irs_notice, gave_callback_time, requesting_callback, hostile, spam, other" },
      tier: { type: "string", enum: ["hard_stop", "dnc_confirm", "soft_defer", "callback_prompt", "needs_human"], description: "Action tier. hard_stop = bare carrier opt-out only. dnc_confirm = permanent lead-wide DNC. soft_defer = not-now/vague disinterest. callback_prompt = engaged, buying signal. needs_human = no reply; human owns it." },
      prospect_state: { type: "string", enum: ["scared", "shopping", "skeptical", "resigned", "ready", "in_progress", "defer", "partial_clear", "investigating", "closing", "hostile", "unclear"], description: "Emotional/situational state aligned with the tier." },
      suggested_reply: { type: "string", description: "Exact SMS draft <=320 chars, ends with ' - Wynn Tax Solutions'; empty when no reply." },
      callback_window: { type: "string", description: "Free-text callback window (e.g. Monday morning, after 5pm); empty when none." },
      confidence: { type: "number", description: "0..1 that the tier is correct; low confidence routes to human review." },
      rationale: { type: "string", description: "One sentence <=180 chars explaining the decisive signal; logged for audit." },
      hot_intent_detected: { type: "boolean", description: "True when the prospect shows ANY interest in tax help. Err HIGH." },
      hot_intent_reason: { type: "string", description: "4-12 word rep-facing fragment. Empty when false." },
    },
    required: ["intent", "tier", "prospect_state", "suggested_reply", "callback_window", "confidence", "rationale", "hot_intent_detected", "hot_intent_reason"],
  },
  strictReady: true,
};

// ── activity.contactSafetyReview — JSON ──────────────────────────────────────
const ACTIVITY_REVIEW_SCHEMA = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["allow_contact", "pause_contact", "stop_contact", "manual_review"] },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    recommendedAction: { type: "string", description: "<=160 chars" },
    rationale: { type: "string", description: "<=1200 chars" },
    concerns: { type: "array", items: { type: "string" }, description: "max 8, each <=180" },
    positiveNotes: { type: "array", items: { type: "string" }, description: "max 8" },
    evidence: { type: "array", items: { type: "string" }, description: "max 8, each <=260" },
    riskFlags: { type: "array", items: { type: "string" }, description: "max 8, each <=80" },
  },
  required: ["status", "confidence"],
  strictReady: true,
};

// ── liveCoach.contextJudge — OpenAI Responses JSON ───────────────────────────
const CONTEXT_JUDGE_SCHEMA = {
  type: "object",
  properties: {
    shouldCompose: { type: "boolean" },
    completeThought: { type: "boolean" },
    approvedKeys: { type: "array", items: { type: "object", properties: { key: { type: "string" }, confidence: { type: "number" }, reason: { type: "string" }, snippet: { type: "string" } } } },
    rejected: { type: "array", items: { type: "object", properties: { key: { type: "string" }, reason: { type: "string" } } } },
    contextBrief: { type: "string" },
    thoughtVadIds: { type: "array", items: { type: "string" } },
    actionReason: { type: "string" },
    confidence: { type: "number" },
  },
  required: ["shouldCompose"],
  strictReady: false, // optional-presence snippet/reason, variable arrays — needs massaging for strict
};

// ── liveCoach.rollingDigest — OpenAI Responses JSON ──────────────────────────
const ROLLING_DIGEST_SCHEMA = {
  type: "object",
  properties: {
    relevantKeys: { type: "array", items: { type: "object", properties: { key: { type: "string" }, snippet: { type: "string" }, why: { type: "string" } } }, description: "max 5" },
    droppedKeys: { type: "array", items: { type: "string" } },
    brief: { type: "object", properties: { whatHappened: { type: "string" }, continueFrom: { type: "string" } } },
    read: { type: "string" },
    facts: { type: "array", items: { type: "object", properties: { key: { type: "string" }, value: { type: "string" } } }, description: "max 6, only new/changed" },
    callSummary: { type: "string" },
  },
  required: [],
  strictReady: false,
};

// ── liveCoach.callGrader — OpenAI Responses JSON ─────────────────────────────
const CALL_GRADER_SCHEMA = {
  type: "object",
  properties: {
    overallScore: { type: "number" },
    verdict: { type: "string" },
    callPhaseReached: { type: "string", enum: ["intro", "discovery", "expert_opinion", "pitch_fees", "closing", "unknown"] },
    outcome: { type: "string" },
    scores: { type: "object", properties: { rapport: { type: "number" }, discovery: { type: "number" }, control: { type: "number" }, taxComprehension: { type: "number" }, salesPivot: { type: "number" }, compliance: { type: "number" }, close: { type: "number" } } },
    whatWorked: { type: "array", items: { type: "string" } },
    missedOpportunities: { type: "array", items: { type: "string" } },
    coachingNotes: { type: "array", items: { type: "string" } },
    nextCallFocus: { type: "array", items: { type: "string" } },
    riskFlags: { type: "array", items: { type: "string" } },
    factsCaptured: { type: "array", items: { type: "string" } },
    summaryForAgent: { type: "string" },
  },
  required: ["overallScore"],
  strictReady: false,
};

// ── transcriptionScoring.score — Anthropic JSON ──────────────────────────────
const SCORING_SCHEMA = {
  type: "object",
  properties: {
    overall: { type: "number", description: "1-10" },
    dimensions: { type: "object", properties: { contactability: { type: "object" }, legitimacy: { type: "object" }, tax_issue_present: { type: "object" }, interest_level: { type: "object" }, qualification: { type: "object" } } },
    lead_verdict: { type: "string", enum: ["hot", "warm", "cold", "dead", "fake"] },
    summary: { type: "string" },
    red_flags: { type: "array", items: { type: "string" } },
    key_details: { type: "object", properties: { answered: { type: "boolean" }, voicemail: { type: "boolean" }, tax_type: { type: "string" }, tax_amount_mentioned: { type: ["string", "null"] }, employed: { type: "string" }, willing_to_proceed: { type: "string" } } },
  },
  required: ["overall", "lead_verdict"],
  strictReady: false,
};

// ── resolution.pitch — verdict fence JSON (parsed from a ```verdict block) ────
const RESOLUTION_VERDICT_SCHEMA = {
  type: "object",
  properties: {
    class: { type: "string", enum: ["PITCH_NOW", "DEVELOP", "NURTURE", "PASS"] },
    headline: { type: "string", description: "<=160" },
    plays: { type: "array", items: { type: "string" }, description: "max 8, each <=80" },
    angle: { type: "string", description: "<=280" },
    fee: { type: ["object", "null"], properties: { low: { type: ["number", "null"] }, high: { type: ["number", "null"] }, monthly: { type: ["number", "null"] }, path: { type: ["string", "null"] } } },
    clocks: { type: "array", items: { type: "object", properties: { what: { type: "string" }, by: { type: "string" } } } },
    missingDocs: { type: "array", items: { type: "string" } },
    citations: { type: "array", items: { type: "string" } },
  },
  required: ["class"],
  strictReady: false,
};

// ── Blogger + trainer + ops tool schemas (field lists from the dictionary) ────
const SUBMIT_BLOG_DRAFT = { name: "submit_blog_draft", input_schema: { type: "object", properties: { teaser: { type: "string", description: "200-280 chars" }, contentTitle: { type: "string" }, bodyHtml: { type: "string", description: "block elements newline-separated; first=disclaimer, last=Bottom line" } }, required: ["teaser", "contentTitle", "bodyHtml"] } };
// Authoritative current-event blog tool def — the SINGLE source. `scripts/blogger-current-event.js`
// imports this rather than re-declaring it. The detailed slide sub-schema + field descriptions are
// what guide the model to fill every slide field, so keep them here (don't flatten back to a loose
// `slide:{type:object}`).
const SUBMIT_CURRENT_EVENT_BLOG = {
  name: "submit_current_event_blog",
  description:
    "Submit the finished current-event blog draft. bodyHtml must be the complete blog body as one HTML string with each block element on its own line, separated by newlines.",
  input_schema: {
    type: "object",
    required: ["id", "title", "teaser", "contentTitle", "bodyHtml", "slide", "sourcesUsed"],
    properties: {
      id: { type: "string", description: "kebab-case slug, includes a date hint (e.g., 'foo-bar-april-2026')." },
      title: { type: "string" },
      teaser: { type: "string" },
      contentTitle: { type: "string" },
      bodyHtml: { type: "string", description: "Complete body HTML, block elements separated by single newlines. First element is disclaimer; last is Bottom line." },
      slide: {
        type: "object",
        required: ["eyebrow", "headline1", "headline2", "badgeTop", "badgeCenter", "badgeBottom", "subhead1", "subhead2"],
        properties: {
          eyebrow: { type: "string" },
          headline1: { type: "string" },
          headline2: { type: "string" },
          badgeTop: { type: "string" },
          badgeCenter: { type: "string" },
          badgeBottom: { type: "string" },
          subhead1: { type: "string" },
          subhead2: { type: "string" },
        },
      },
      sourcesUsed: { type: "array", items: { type: "string" }, description: "URLs of the sources used to support the post." },
    },
  },
};
const PROPOSE_RECOVERY_PLAN = { name: "propose_recovery_plan", input_schema: { type: "object", properties: { classification: { type: "string", enum: ["rollback-aftermath", "dirty-state", "build-failure", "deploy-failure", "unknown"] }, confidence: { type: "string", enum: ["high", "medium", "low"] }, diagnosis: { type: "string" }, actions: { type: "array", items: { type: "object", properties: { type: { type: "string", enum: ["git-restore"] }, repo: { type: "string", enum: ["wynn", "tag"] }, paths: { type: "array", items: { type: "string" } }, reason: { type: "string" } } } }, autoExecutable: { type: "boolean" }, manualSteps: { type: "string" } }, required: ["classification", "confidence", "actions"] } };
const SUMMARIZE_CASE = { name: "summarize_case", input_schema: { type: "object", properties: { workProduct: { type: "string" }, servicesPitched: { type: "string" }, lastThingPitched: { type: "string" }, clientTemperature: { type: "string", enum: ["hot", "warm", "cold", "unknown"] }, temperamentSignals: { type: "string" } } } };
// Trainer profile/playbook tools — partial (full field set in taxResolutionSalesTrainerService.js CALLER_PROFILE_TOOL / CALLER_PLAYBOOK_TOOL; copy on migration).
const SUBMIT_CALLER_PROFILE = { name: "submit_caller_profile", _partial: true, note: "full schema: firstName,lastName,age,sex,ethnicity,education,affluency,spouseStatus,employmentCategory,city,mood,taxStack,openingLine,voiceHints — server overwrites locked demographics" };
const SUBMIT_CALLER_PLAYBOOK = { name: "submit_caller_playbook", _partial: true, note: "callerSummary; objectionQueue[3-16]{phase,trigger,verbatim,underlyingConcern}; hiddenFacts[1-5]{fact,revealsWhen,revealLine}; tellLines; trustArc; phaseGuidance{phase1,phase2,phase3}" };

module.exports = {
  SMS_CLASSIFY_TOOL,
  ACTIVITY_REVIEW_SCHEMA,
  CONTEXT_JUDGE_SCHEMA,
  ROLLING_DIGEST_SCHEMA,
  CALL_GRADER_SCHEMA,
  SCORING_SCHEMA,
  RESOLUTION_VERDICT_SCHEMA,
  SUBMIT_BLOG_DRAFT,
  SUBMIT_CURRENT_EVENT_BLOG,
  PROPOSE_RECOVERY_PLAN,
  SUMMARIZE_CASE,
  SUBMIT_CALLER_PROFILE,
  SUBMIT_CALLER_PLAYBOOK,
};
