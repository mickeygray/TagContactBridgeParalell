# AI Bus Sandbox

One place that holds the **real** background material — prompts, tool/output schemas, cache policy, rules, plumbing — **copied** out of the live services so the AI bus can be built and tested around it without reaching into the live code or reconstructing from memory.

**Duplication is intentional.** This is a build surface, not the source of truth. If a live prompt changes, sync the copy here. The `docs/AI_TASK_DICTIONARY.md` is the index that maps each task to its live source (`file:line + const`).

## Layout

```
aiSandbox/
  prompts/
    universalSalesScript.md        cp ← packages/shared-services/src/universalSalesScript.md
    resolutionPitchDoctrine.md     cp ← packages/shared-services/src/resolutionPitchDoctrine.md
    salesTrainer.full.md           cp ← taxResolutionSalesTrainerPrompt.md
    salesTrainer.liveTurn.md       cp ← taxResolutionSalesTrainerPrompt.liveTurn.md
    files.js        loads the 4 .md above
    liveCoach.js    CONTEXT_JUDGE / ROLLING_DIGEST / CALL_GRADER / CALL_STRATEGIST_INSTRUCTIONS (verbatim)
    compliance.js   SMS_CLASSIFIER_SYSTEM + ACTIVITY_REVIEW_SYSTEM + buildActivityReviewUser (verbatim)
    scoring.js      SCORING_SYSTEM_PROMPT (verbatim)
  schemas.js   tool/output schemas as JS objects (the contracts) + strictReady flags
  cache.js     per-task cache policy (anthropic ephemeralSystem / openai promptCacheKey+tier)
  rules.js     enums, output formats (Read/Steer/Try, verdict fence), voicemail phrases, model ladders, formatActivities
  tasks.js     assembled per-task descriptors: prompt + schema + cache + plumbing
  index.js     one require: { prompts, schemas, cache, rules, tasks, getSandboxTask, listSandboxTasks }
```

## What's verbatim vs stub

- **Verbatim prompts (copied in full):** the 4 live-coach prompts, SMS classifier system, activity review, scoring, + the 4 `.md` files (universal sales script, resolution doctrine, sales trainer full + live-turn).
- **Schema/cache/plumbing:** present for (nearly) all tasks.
- **`promptTodo` stubs (prose prompt not yet copied — source ref only):** `dialogComposer` (floor-hot, wrap-not-migrate), sales-trainer profile/playbook/narration, blogger write/currentEvent/failureRecovery/image, caseNotesSummary. Schema + plumbing are present; copy the prose at migration time.

## Use

```js
const sandbox = require("packages/shared-services/src/aiSandbox");
const t = sandbox.getSandboxTask("activity.contactSafetyReview");
// t.system (prompt), t.schema (contract), t.cache, t.plumbing, t.failClosed, t.source
```

A bus named-task is just one of these with its fields frozen and wired to `runAiTask`.
