"use strict";

// SANDBOX — per-task cache policy, copied from the live invocations (see
// docs/AI_TASK_DICTIONARY.md cache map). The bus adapter consumes this shape:
//   { anthropic: { ephemeralSystem: true },
//     openai:    { promptCacheKey, retention, serviceTier } }
// Cache identity (the key strings) must survive a migration or the warm-prefix
// savings are lost. `{model}` / `{agentScope}` are runtime-substituted parts of
// the original keys (kept here as templates, not resolved).

const CACHE = {
  // Anthropic — stable system prefix rides as a cache_control:ephemeral block.
  "liveCoach.callStrategy": { anthropic: { ephemeralSystem: true } },
  "liveCoach.dialogComposer": { anthropic: { ephemeralSystem: true } }, // separate cache per model (Sonnet ticks vs Opus asks)
  "resolution.pitch": { anthropic: { ephemeralSystem: true } },
  "salesTrainer.liveTurn": { anthropic: { ephemeralSystem: true } }, // system (~26k) global + session header per-session
  "salesTrainer.generatePlaybook": { anthropic: { ephemeralSystem: true } },

  // OpenAI Responses — prompt_cache_key + in_memory retention + service_tier.
  "liveCoach.rollingDigest": {
    openai: { promptCacheKey: "live-coach-rolling-digest:digest-v2", retention: "in_memory", serviceTier: "priority" },
  },
  "liveCoach.contextJudge": {
    // original key: buildMiniContextJudgeCacheKey({model, metadata, scope}) ->
    // "live-coach-mini:live-coach-mini-context-v4:{model}:{agentScope}"
    openai: { promptCacheKey: "live-coach-mini:live-coach-mini-context-v4:{model}:{agentScope}", retention: "in_memory", serviceTier: "priority" },
  },
  "liveCoach.callGrader": {
    openai: { promptCacheKey: "live-coach-call-grader:live-coach-call-grader-v1:{model}", retention: "in_memory" },
  },

  // No cache today.
  "sms.classify": null,
  "activity.contactSafetyReview": null,
  "transcriptionScoring.transcribe": null,
  "transcriptionScoring.score": null,
  "salesTrainer.roleplayer": null,
  "salesTrainer.audioTranscribe": null,
  "salesTrainer.audioSynthesis": null,
  "salesTrainer.generateProfile": null,
  "salesTrainer.coachNarration": null,
  "blogger.write": null,
  "blogger.currentEvent": null,
  "blogger.failureRecovery": null,
  "blogger.image": null,
  "misc.caseNotesSummary": null,
};

module.exports = { CACHE };
