"use strict";

// SANDBOX — the assembled per-task descriptors: prompt + schema + cache +
// plumbing in one object, built from real material. This is the "build around"
// surface: a named bus task is one of these with its fields frozen. Tasks whose
// prose prompt isn't copied yet carry `promptTodo` (source ref) but still hold
// the real schema/cache/plumbing.
//
// READ THIS: `status` describes the LIVE source (e.g. 'direct' = currently a
// direct provider call in the app), NOT sandbox readiness. A task with
// `system:null` + `promptTodo` is NOT invoke-ready — its prose must be copied
// first. These are BUILD descriptors, not production routes; nothing here is
// wired to live traffic. Only the 8 core tasks (sandbox smoke) are fully populated.

const liveCoach = require("./prompts/liveCoach");
const compliance = require("./prompts/compliance");
const scoring = require("./prompts/scoring");
const files = require("./prompts/files");
const schemas = require("./schemas");
const { CACHE } = require("./cache");
const { TASK_PLUMBING } = require("./rules");

const TASKS = {
  "liveCoach.callStrategy": {
    id: "liveCoach.callStrategy", status: "on-bus", verb: "aiWrite", kind: "compose", provider: "anthropic",
    system: [files.UNIVERSAL_SALES_SCRIPT, liveCoach.CALL_STRATEGIST_INSTRUCTIONS].join("\n\n"),
    schema: null, cache: CACHE["liveCoach.callStrategy"], plumbing: TASK_PLUMBING["liveCoach.callStrategy"],
    source: "apps/ai-bus/src/server.js createOpusCallStrategist",
  },
  "liveCoach.rollingDigest": {
    id: "liveCoach.rollingDigest", status: "on-bus", verb: "aiRead", kind: "json", provider: "openai",
    system: liveCoach.ROLLING_DIGEST_PROMPT, schema: schemas.ROLLING_DIGEST_SCHEMA,
    cache: CACHE["liveCoach.rollingDigest"], plumbing: TASK_PLUMBING["liveCoach.rollingDigest"],
    source: "apps/ai-bus/src/server.js createOpenAiRollingDigest",
  },
  "liveCoach.contextJudge": {
    id: "liveCoach.contextJudge", status: "on-bus", verb: "aiJudge", kind: "json", provider: "openai",
    system: liveCoach.CONTEXT_JUDGE_PROMPT, schema: schemas.CONTEXT_JUDGE_SCHEMA,
    cache: CACHE["liveCoach.contextJudge"], plumbing: TASK_PLUMBING["liveCoach.contextJudge"],
    source: "apps/ai-bus/src/server.js createOpenAiSemanticContextJudge",
  },
  "liveCoach.callGrader": {
    id: "liveCoach.callGrader", status: "on-bus", verb: "aiScore", kind: "json", provider: "openai",
    system: liveCoach.CALL_GRADER_PROMPT, schema: schemas.CALL_GRADER_SCHEMA,
    cache: CACHE["liveCoach.callGrader"], plumbing: TASK_PLUMBING["liveCoach.callGrader"],
    source: "apps/ai-bus/src/server.js createOpenAiCallGrader",
  },
  "liveCoach.dialogComposer": {
    id: "liveCoach.dialogComposer", status: "on-bus", verb: "aiWrite", kind: "compose", provider: "anthropic",
    system: null, promptTodo: "packages/shared-services/src/liveCoachSanitizedPipeline.js SONNET_PROSPECT_SYSTEM_PROMPT + FIXED_PROSPECT_COMPOSER_INSTRUCTIONS (floor-hot; wrap-not-migrate)",
    schema: null, cache: CACHE["liveCoach.dialogComposer"], plumbing: TASK_PLUMBING["liveCoach.dialogComposer"],
    source: "apps/ai-bus/src/server.js createAnthropicDialogComposer",
  },
  "sms.classify": {
    id: "sms.classify", status: "direct", verb: "aiJudge", kind: "classify", provider: "anthropic",
    system: compliance.SMS_CLASSIFIER_SYSTEM, schema: schemas.SMS_CLASSIFY_TOOL, tool: "classify_sms",
    cache: CACHE["sms.classify"], plumbing: TASK_PLUMBING["sms.classify"],
    failClosed: { tier: "needs_human", confidence: 0, viaFailClosed: true },
    source: "packages/shared-services/src/smsClassifierService.js (regex fast-paths stay local)",
  },
  "activity.contactSafetyReview": {
    id: "activity.contactSafetyReview", status: "direct", verb: "aiJudge", kind: "json", provider: "anthropic",
    system: compliance.ACTIVITY_REVIEW_SYSTEM, userBuilder: compliance.buildActivityReviewUser,
    schema: schemas.ACTIVITY_REVIEW_SCHEMA, cache: CACHE["activity.contactSafetyReview"], plumbing: TASK_PLUMBING["activity.contactSafetyReview"],
    failClosed: { status: "manual_review", confidence: "low", viaFailClosed: true },
    source: "packages/shared-services/src/activityAiReviewService.js",
  },
  "resolution.pitch": {
    id: "resolution.pitch", status: "on-bus", verb: "aiWrite", kind: "compose+fence", provider: "anthropic",
    system: files.RESOLUTION_PITCH_DOCTRINE, schema: schemas.RESOLUTION_VERDICT_SCHEMA, fence: "verdict",
    cache: CACHE["resolution.pitch"], plumbing: TASK_PLUMBING["resolution.pitch"],
    source: "apps/ai-bus/src/server.js createOpusResolutionPitchAgent",
  },
  "transcriptionScoring.transcribe": {
    id: "transcriptionScoring.transcribe", status: "direct", verb: "aiTranscribe", kind: "transcribe", provider: "openai",
    system: null, schema: null, cache: null, plumbing: TASK_PLUMBING["transcriptionScoring.transcribe"],
    source: "packages/shared-services/src/transcriptionScoringService.js transcribeWithWhisper",
  },
  "transcriptionScoring.score": {
    id: "transcriptionScoring.score", status: "direct", verb: "aiScore", kind: "json", provider: "anthropic",
    system: scoring.SCORING_SYSTEM_PROMPT, schema: schemas.SCORING_SCHEMA, cache: null, plumbing: TASK_PLUMBING["transcriptionScoring.score"],
    source: "packages/shared-services/src/transcriptionScoringService.js scoreWithClaude",
  },
  "salesTrainer.liveTurn": {
    id: "salesTrainer.liveTurn", status: "direct", verb: "aiWrite", kind: "compose", provider: "anthropic",
    system: files.SALES_TRAINER_LIVE_TURN, schema: null, cache: CACHE["salesTrainer.liveTurn"],
    source: "packages/shared-services/src/taxResolutionSalesTrainerService.js liveInCharacterTurn",
  },
  "salesTrainer.roleplayer": {
    id: "salesTrainer.roleplayer", status: "direct", verb: "aiWrite", kind: "compose", provider: "openai",
    system: files.SALES_TRAINER_FULL, schema: null, cache: null,
    source: "packages/shared-services/src/taxResolutionSalesTrainerService.js callOpenAiResponses",
  },
  // ── Schema/plumbing present, prose prompt not yet copied (source-ref stubs) ──
  "salesTrainer.generateProfile": { id: "salesTrainer.generateProfile", status: "direct", verb: "aiWrite", kind: "json", provider: "anthropic", system: null, schema: schemas.SUBMIT_CALLER_PROFILE, promptTodo: "taxResolutionSalesTrainerService.js buildProfilePrompt + CALLER_PROFILE_TOOL", cache: null },
  "salesTrainer.generatePlaybook": { id: "salesTrainer.generatePlaybook", status: "direct", verb: "aiWrite", kind: "json", provider: "anthropic", system: null, schema: schemas.SUBMIT_CALLER_PLAYBOOK, promptTodo: "taxResolutionSalesTrainerService.js buildPlaybookPrompt + CALLER_PLAYBOOK_TOOL", cache: CACHE["salesTrainer.generatePlaybook"] },
  "salesTrainer.coachNarration": { id: "salesTrainer.coachNarration", status: "direct", verb: "aiWrite", kind: "compose", provider: "anthropic", system: null, schema: null, promptTodo: "taxResolutionSalesTrainerService.js COACHING_NARRATOR_SYSTEM_PROMPT", cache: null },
  "salesTrainer.audioTranscribe": { id: "salesTrainer.audioTranscribe", status: "direct", verb: "aiTranscribe", kind: "transcribe", provider: "openai", system: null, schema: null, cache: null },
  "salesTrainer.audioSynthesis": { id: "salesTrainer.audioSynthesis", status: "direct", verb: "aiSpeak", kind: "tts", provider: "openai", system: null, schema: null, cache: null },
  "blogger.write": { id: "blogger.write", status: "direct", verb: "aiWrite", kind: "json", provider: "anthropic", system: null, schema: schemas.SUBMIT_BLOG_DRAFT, promptTodo: "scripts/blogger-claude-writer.js buildSystemPrompt/buildUserPrompt", cache: null },
  "blogger.currentEvent": { id: "blogger.currentEvent", status: "direct", verb: "aiWrite", kind: "json+web_search", provider: "anthropic", system: null, schema: schemas.SUBMIT_CURRENT_EVENT_BLOG, promptTodo: "scripts/blogger-current-event.js (AGENTIC web_search loop — deferred kind)", cache: null },
  "blogger.failureRecovery": { id: "blogger.failureRecovery", status: "direct", verb: "aiJudge", kind: "classify", provider: "anthropic", system: null, schema: schemas.PROPOSE_RECOVERY_PLAN, promptTodo: "scripts/blogger-failure-recovery.js SYSTEM_PROMPT", cache: null },
  "blogger.image": { id: "blogger.image", status: "direct", verb: "aiImage", kind: "image", provider: "openai", system: null, schema: null, promptTodo: "scripts/blogger-post-pipeline.js buildOpenAiImagePrompt", cache: null },
  "misc.caseNotesSummary": { id: "misc.caseNotesSummary", status: "direct", verb: "aiRead", kind: "classify", provider: "anthropic", system: null, schema: schemas.SUMMARIZE_CASE, promptTodo: "scripts/case-notes-summary.js SYSTEM", cache: null },
};

function getSandboxTask(id) {
  return TASKS[id] || null;
}
function listSandboxTasks() {
  return Object.values(TASKS);
}

module.exports = { TASKS, getSandboxTask, listSandboxTasks };
