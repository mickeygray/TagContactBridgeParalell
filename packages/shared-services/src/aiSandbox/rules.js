"use strict";

// SANDBOX — the structures, enums, plumbing constants, and deterministic helpers
// that surround the prompts. Copied from the live services/docs so the bus can be
// built around them without reaching back. (See docs/AI_TASK_DICTIONARY.md.)

// ── Enums (the controlled vocabularies the schemas validate against) ──────────
const SMS_TIERS = ["hard_stop", "dnc_confirm", "soft_defer", "callback_prompt", "needs_human"];
const SMS_PROSPECT_STATES = [
  "scared", "shopping", "skeptical", "resigned", "ready", "in_progress",
  "defer", "partial_clear", "investigating", "closing", "hostile", "unclear",
];
const ACTIVITY_STATUSES = ["allow_contact", "pause_contact", "stop_contact", "manual_review"];
const CONFIDENCE_LEVELS = ["low", "medium", "high"];
const LEAD_VERDICTS = ["hot", "warm", "cold", "dead", "fake"];
const CALL_PHASES = ["intro", "discovery", "expert_opinion", "pitch_fees", "closing", "unknown"];
const RESOLUTION_VERDICT_CLASSES = ["PITCH_NOW", "DEVELOP", "NURTURE", "PASS"];

// ── Output formats (prose contracts that aren't JSON schemas) ─────────────────
// Live coach dialog composer (Read/Steer/Try). Words are soft caps.
const COACH_DIALOG_FORMAT = {
  read: { label: "Read", maxWords: 12, meaning: "moment-level reaction to what the prospect just said" },
  steer: { label: "Steer", maxWords: 25, meaning: "the long-tail guidepost / where to take it next" },
  try: { label: "Try", maxWords: 35, optional: true, meaning: "exact words to say — only when wording is the hard part" },
  maxOutputWordsTick: 80,
  maxOutputWordsAsk: 130,
  waitSentinel: "WAIT", // composer emits this to hold for an incomplete thought
};

// resolution.pitch ends every reply with a ```verdict fenced JSON block.
const RESOLUTION_VERDICT_FENCE = { open: "```verdict", close: "```", parse: "best-effort; malformed -> verdict:null while prose still flows" };

// ── Deterministic voicemail / system-prompt filter (pre-model gate) ───────────
// If the FIRST transcript item strongly matches, clear call state, skip AI.
const VOICEMAIL_PHRASES = [
  "forwarded", "message", "tone", "record", "name and number",
  "can't take your call now", "at the tone", "please record your message",
];

// ── Model ladders + timeouts (the plumbing; env names are the live overrides) ─
// kind: compose | json | classify | transcribe | image | tts
const TASK_PLUMBING = {
  "liveCoach.callStrategy": { provider: "anthropic", kind: "compose", modelEnv: "LIVE_COACH_STRATEGY_MODEL", modelDefault: "claude-opus-4-8", timeoutMs: 30000, timeoutEnv: "LIVE_COACH_STRATEGY_TIMEOUT_MS", maxTokens: 900 },
  "liveCoach.dialogComposer": { provider: "anthropic", kind: "compose", stream: true, modelEnvTick: "LIVE_COACH_ANTHROPIC_MODEL", modelDefaultTick: "claude-sonnet-4-6", modelEnvAsk: "LIVE_COACH_ASK_MODEL", modelDefaultAsk: "claude-opus-4-8", timeoutMsTick: 15000, timeoutMsAsk: 30000 },
  "liveCoach.rollingDigest": { provider: "openai", kind: "json", api: "responses", modelEnv: "LIVE_COACH_MINI_DIGEST_MODEL", modelDefault: "gpt-5.4-mini", timeoutMs: 5000, maxOutputTokens: 500, serviceTier: "priority" },
  "liveCoach.contextJudge": { provider: "openai", kind: "json", api: "responses", modelEnv: "LIVE_COACH_CONTEXT_JUDGE_MODEL", modelDefault: "gpt-5.4-mini", timeoutMs: 6000, maxOutputTokens: 550, serviceTier: "priority" },
  "liveCoach.callGrader": { provider: "openai", kind: "json", api: "responses", modelEnv: "LIVE_COACH_CALL_GRADER_MODEL", modelDefault: "gpt-5.4", timeoutMs: 45000, maxOutputTokens: 950 },
  "sms.classify": { provider: "anthropic", kind: "classify", tool: "classify_sms", modelEnv: "SMS_CLASSIFIER_MODEL", modelDefault: "claude-opus-4-6", maxTokens: 900, temperature: 0 },
  "activity.contactSafetyReview": { provider: "anthropic", kind: "json", modelEnv: "LOGICS_ACTIVITY_REVIEW_AI_MODEL", modelDefault: "claude-haiku-4-5", maxTokens: 1200, temperature: 0, batchCapEnv: "LOGICS_ACTIVITY_REVIEW_AI_MAX_CASES", batchCapDefault: 75, concurrency: 1 },
  "resolution.pitch": { provider: "anthropic", kind: "compose", thinking: "adaptive", modelEnv: "RESOLUTION_AGENT_MODEL", modelDefault: "claude-opus-4-8", timeoutMs: 75000, maxTokens: 8000 },
  "transcriptionScoring.transcribe": { provider: "openai", kind: "transcribe", modelEnv: "WHISPER_MODEL", modelDefault: "whisper-1", responseFormat: "verbose_json", timeoutMs: 120000 },
  "transcriptionScoring.score": { provider: "anthropic", kind: "json", modelEnv: "CLAUDE_SCORING_MODEL", modelDefault: "claude-sonnet-4-5", maxTokens: 1000, timeoutMs: 30000 },
};

// ── Deterministic helper: format Logics activities for the review prompt ──────
// BYTE-EXACT mirror of activityAiReviewService.formatActivitiesForPrompt (first
// 40; "Activity N:" / "Created:" / "Type:" / "Subject:" / "Comment:"; 600-char
// trim). The parity test in tests/ai-bus/activityMigration.test.js asserts this
// equals live, so the bus and legacy prompts are identical — required for the
// migration to show a clean both-providers parity smoke.
function trimActivityText(value, maxLength = 600) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}
function formatActivities(activities = []) {
  return activities
    .slice(0, 40)
    .map((activity, index) => {
      const createdDate = activity.CreatedDate || activity.ModifiedDate || "";
      const subject = trimActivityText(activity.Subject || "");
      const comment = trimActivityText(activity.Comment || "");
      const activityType = trimActivityText(activity.ActivityType || "");
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

module.exports = {
  SMS_TIERS,
  SMS_PROSPECT_STATES,
  ACTIVITY_STATUSES,
  CONFIDENCE_LEVELS,
  LEAD_VERDICTS,
  CALL_PHASES,
  RESOLUTION_VERDICT_CLASSES,
  COACH_DIALOG_FORMAT,
  RESOLUTION_VERDICT_FENCE,
  VOICEMAIL_PHRASES,
  TASK_PLUMBING,
  formatActivities,
};
