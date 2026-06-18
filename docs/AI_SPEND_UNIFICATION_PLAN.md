# AI Spend Unification Plan

Date: 2026-06-16

## Goal

Move AI spending behind one controllable service boundary, preferably the existing `7000` AI bus, so the app can manage quality, latency, caching, fallbacks, kill switches, and cost by named task instead of scattered provider calls.

This is not just a model swap. The end state is:

```text
app / worker / script
  -> ai-bus task endpoint on :7000
  -> task registry chooses provider, model, timeout, cache policy, max tokens
  -> provider adapter executes
  -> usage + latency + result metadata are logged consistently
```

The core design rule: callers should say what kind of thinking they need. The AI bus decides the cheapest model that can do that job adequately.

## Current Spend Map

### Already On Or Near 7000

| Area | Current files | Current behavior | Migration posture |
| --- | --- | --- | --- |
| Live coach stream, session, dashboard | `apps/ai-bus/src/server.js`, `packages/shared-services/src/liveCoachBusService.js`, `packages/shared-services/src/liveCoachSanitizedPipeline.js` | `7000` owns live coach sessions, mini context judge, rolling digest, Sonnet/Opus composer, call strategy, closeout grader hooks | Keep here. Make it the reference implementation. |
| Coach strategy from interview form | `apps/ai-bus/src/server.js` | Anthropic call strategist uses cached Universal Sales Script prefix | Keep, but register as a named task with a default cheaper fallback. |
| Resolution pitch / upsellerator agent | `apps/ai-bus/src/server.js`, `apps/control-plane/src/routes/resolutionIntelligence.js` | Control plane proxies to `7000` for `/api/ai/resolution/pitch`; Anthropic adaptive thinking on full dossier | Keep on `7000`; add tiered mode for first-read vs follow-up. |
| Live coach closeout grader | `apps/ai-bus/src/server.js`, `packages/shared-services/src/liveCoachCloseoutService.js` | OpenAI JSON grader; recent gate prevents empty calls from emailing/grading | Keep on `7000`; tighten evidence gates and downgrade model by default after quality test. |

### Still Direct Provider Calls

| Area | Current files | Current behavior | Risk / cost issue | Target |
| --- | --- | --- | --- | --- |
| SMS classifier / auto responder | `packages/shared-services/src/smsClassifierService.js` | Regex fast paths, then Anthropic tool-use classifier | Compliance-sensitive, direct model config, no central spend ledger | Move to `ai.task.sms.classify`. Keep regex prefilters local or share them as deterministic bus helpers. |
| Logics activity AI review | `packages/shared-services/src/activityAiReviewService.js`, `packages/shared-services/src/logicsActivityReviewService.js` | Anthropic JSON review per case, capped by max cases/concurrency | Batch spend can fan out during reviews; direct model defaults | Move to `ai.task.activity.contactSafetyReview`. Batch-only, cheap model first. |
| Call transcription and vendor lead scoring | `packages/shared-services/src/transcriptionScoringService.js` | OpenAI audio transcription plus Anthropic lead-quality scoring | Direct Whisper + Claude path; batch scoring can become expensive | Move to `ai.task.call.transcribe` and `ai.task.call.vendorScore`. |
| Sales trainer | `packages/shared-services/src/taxResolutionSalesTrainerService.js`, `apps/control-plane/src/routes/salesTrainer.js` | Direct OpenAI Responses, STT, TTS, Anthropic profile/playbook/narrator | Many independent model knobs; useful but not floor-critical | Migrate after live-floor items. Keep UI route stable, but call `7000` for each task. |
| Blogger text and image generation | `scripts/blogger-claude-writer.js`, `scripts/blogger-current-event.js`, `scripts/blogger-failure-recovery.js`, `scripts/blogger-post-pipeline.js` | Direct Anthropic writer/current-event and OpenAI image generation | Daily batch cost, hard-coded model ids in scripts | Keep script orchestration local for now, but route generation/image calls through `7000` later. |
| One-off research/test scripts | `scripts/prospect-coach-repl.js`, `scripts/eval-speaker-label-models.js`, `scripts/transcribe-ex-monitor-capture.js`, `scripts/test-openai-image.js`, older `rc-ex-live-trainer-oneoff*` | Direct provider calls for experiments | Can confuse audits and accidentally spend if reused | Leave untracked/test-only. Add a note that production patches do not depend on these. |

## Proposed AI Bus Task Registry

Add a small registry module under `apps/ai-bus/src` or `packages/shared-services/src/aiTaskRegistry.js` with one entry per allowed AI job.

Example shape:

```js
{
  id: "liveCoach.contextJudge",
  owner: "live-coach",
  latencyClass: "hot",
  defaultProvider: "openai",
  defaultModel: "gpt-5.4-mini",
  fallbackModel: "gpt-5-mini",
  maxOutputTokens: 500,
  timeoutMs: 5000,
  cache: {
    enabled: true,
    keyPrefix: "live-coach-context",
    retention: "in_memory"
  },
  spendPolicy: {
    maxCallsPerMinutePerSession: 20,
    maxInputChars: 8000,
    logUsage: true
  }
}
```

The registry should answer three questions before any model call:

1. Is this task enabled?
2. Which provider/model/tier is allowed right now?
3. What usage, latency, and result metadata must be logged?

## Task Classes And Cheapest Adequate Defaults

| Task class | Example jobs | Default strategy |
| --- | --- | --- |
| Deterministic | voicemail phrases, stop words, exact tax/source keywords, spammy SMS fast paths | No model. Shared JS modules first. |
| Tiny classification | complete thought, voicemail vs human if deterministic misses, low-risk routing | Cheapest nano-class model only if deterministic cannot do it. Timeout under 2s. |
| Mini reasoning / filtering | live coach key relevance, SMS reply classification, activity contact-safety review | Mini-class model with strict JSON. Cache static prompt. Hard cap output. |
| Strong composer | live coach guideposts/reactions/asks, sales trainer simulated prospect response | Sonnet-class model only after prefiltering. Stream when user is waiting. |
| High-context analyst | resolution pitch, deep call grade, profile/playbook generation | Opus/strong model only for click-and-wait or batch work, never accidental hot path. |
| STT | live coach, call review, sales trainer mic | Live floor uses the fastest accurate STT that behaves well. Batch can use cheaper/slower model. |
| Image | blogger hero image | Lowest acceptable image quality/size by default. Keep outside hot path. |

## Specific Migration Plan

### Phase 1 - Add Governance Without Moving Everything

Do this first because it gives visibility immediately.

- Add an AI task registry and a generic `runAiTask(taskId, payload, options)` helper on `7000`.
- Add structured logging for every task:
  - `taskId`
  - provider
  - requested model
  - actual model
  - elapsed ms
  - input chars or token estimate
  - output chars or tokens
  - usage object when provider returns it
  - cache key / cache hit fields when available
  - caller service and domain/case/session identifiers when safe
- Add per-task env overrides:
  - `AI_TASK_<TASK>_ENABLED`
  - `AI_TASK_<TASK>_MODEL`
  - `AI_TASK_<TASK>_MAX_OUTPUT_TOKENS`
  - `AI_TASK_<TASK>_TIMEOUT_MS`
  - `AI_TASK_<TASK>_SERVICE_TIER`
- Keep existing routes working. In this phase, `7000` gains a governor, but callers do not all move yet.

### Phase 2 - Normalize Live Coach First

Live coach is the best proving ground because it has real latency pressure.

- Keep STT/stream ingestion in the existing coach path.
- Register these as named tasks:
  - `liveCoach.contextJudge`
  - `liveCoach.rollingDigest`
  - `liveCoach.dialogCompose`
  - `liveCoach.askCoach`
  - `liveCoach.callStrategy`
  - `liveCoach.callGrade`
- Confirm each task has:
  - cacheable static prompt separated from dynamic call data
  - timeout shorter than the upstream client timeout
  - usage logging
  - per-session rate caps where relevant
  - skip gates for empty/non-substantive content
- Make the composer tier toggle update registry state, not a one-off global variable.

### Phase 3 - Move Compliance-Sensitive Classifiers

Move next because these can mutate contactability and should be consistent.

- `smsClassifierService.js` should stop calling Anthropic directly.
- Replace the direct call with `POST /api/ai/tasks/sms.classify`.
- Keep existing regex fast paths in `smsClassifierService.js` initially, because they prevent model calls and protect DNC/STOP handling.
- Bus task should return the same normalized classification shape the service already expects.
- Default model should be mini-class, not Opus/Sonnet, unless live tests show compliance degradation.
- Fail closed to `needs_human`, not auto-action, on timeout or invalid JSON.

### Phase 4 - Move Batch Reviews And Scoring

These do not need hot latency, so they should be cheaper and heavily capped.

- Move `activityAiReviewService.js` to `activity.contactSafetyReview`.
- Move `transcriptionScoringService.js` to:
  - `call.transcribe`
  - `call.vendorLeadScore`
- Add batch controls:
  - max cases per run
  - max concurrent model calls
  - daily spend ceiling
  - resume markers
  - structured skipped reasons
- Default to the cheapest model that can return reliable JSON. Escalate only on low confidence or contract violation.

### Phase 5 - Move Sales Trainer

Sales trainer has the most model surfaces, so migrate it after the floor-critical paths.

Split into tasks:

- `trainer.respond`
- `trainer.transcribeMic`
- `trainer.tts`
- `trainer.generateProfile`
- `trainer.generatePlaybook`
- `trainer.coachNarration`

Keep the current control-plane routes and frontend API stable. Internally, those routes call `7000`.

Model policy:

- `trainer.respond`: Sonnet-class only if the simulated prospect quality requires it; otherwise mini/fast model for cheaper drill mode.
- `trainer.transcribeMic`: mini transcription unless accuracy requires larger transcription.
- `trainer.tts`: cheapest acceptable voice model.
- `trainer.generateProfile` and `trainer.generatePlaybook`: batch/click path, can use stronger model but should be cached and stored.
- `trainer.coachNarration`: downgrade from Opus by default; this is analysis/prose polish, not live compliance.

### Phase 6 - Move Blogger Last

Blogger is batch and already has a different operational rhythm.

- Keep `scripts/blogger-daily-runner.js` and site build/deploy logic where it is.
- Replace direct Anthropic/OpenAI calls inside blogger scripts with bus calls:
  - `blogger.currentEvent`
  - `blogger.writeDraft`
  - `blogger.recoverFailure`
  - `blogger.renderHeroImage`
- Use a batch model profile:
  - longer timeout
  - low concurrency
  - cheap image quality by default
  - explicit fallback to static post when model work fails

## 7000 Route Shape

Add a generic internal task route:

```text
POST /api/ai/tasks/:taskId/run
```

Request:

```json
{
  "caller": "control-plane.sms",
  "domain": "WYNN",
  "caseId": 12345,
  "sessionId": "optional",
  "payload": {},
  "options": {
    "forceModel": null,
    "dryRun": false,
    "qualityMode": "cheap|balanced|best"
  }
}
```

Response:

```json
{
  "ok": true,
  "taskId": "sms.classify",
  "provider": "anthropic",
  "model": "actual-model-id",
  "elapsedMs": 842,
  "usage": {},
  "result": {}
}
```

Errors should be boring and consistent:

```json
{
  "ok": false,
  "taskId": "sms.classify",
  "code": "model_timeout",
  "retryable": true,
  "safeFallback": { "tier": "needs_human" }
}
```

## Target Developer API

The codebase should not grow more direct calls like:

```js
fetch("https://api.openai.com/v1/responses", ...)
client.messages.create(...)
```

Instead, every app service should call one internal AI client. The service says what it needs done; the AI bus decides which provider/model/tier executes it.

Proposed app-side helper:

```js
const { runAiTask } = require("../../shared-services/src/aiTaskClient");

const result = await runAiTask("sms.classify", {
  domain,
  text,
  history,
  trackingNumber,
});
```

For places where we still want a model-tier shorthand, keep it as a convenience wrapper over a named task:

```js
await useAi("mini", "sms.classify", payload);
await useAi("sonnet", "liveCoach.dialogCompose", payload);
await useAi("opus", "resolution.pitch", payload);
```

The shorthand should never mean "call OpenAI directly from here." It should resolve to a task config on `7000`.

### What The Helper Does

`runAiTask()` should:

1. Normalize the task id.
2. Attach safe caller metadata:
   - caller service
   - domain
   - case id
   - session id
   - agent id when relevant
3. POST to `http://127.0.0.1:7000/api/ai/tasks/:taskId/run`.
4. Add the internal service secret.
5. Enforce an upstream timeout shorter than the caller route timeout.
6. Return only the task result plus model metadata.
7. Convert transport failures into the task's safe fallback shape.

Example implementation sketch:

```js
async function runAiTask(taskId, payload = {}, options = {}) {
  const response = await fetch(`${AI_BUS_BASE_URL}/api/ai/tasks/${taskId}/run`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-service-secret": INTERNAL_SERVICE_SECRET,
    },
    body: JSON.stringify({
      caller: options.caller,
      domain: options.domain || payload.domain,
      caseId: options.caseId || payload.caseId,
      sessionId: options.sessionId || payload.sessionId,
      payload,
      options: {
        qualityMode: options.qualityMode || "balanced",
        forceModel: options.forceModel || null,
        dryRun: Boolean(options.dryRun),
      },
    }),
    signal: options.signal,
  });

  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.ok) {
    return body?.safeFallback || { ok: false, error: body?.error || "ai-task-failed" };
  }
  return body.result;
}
```

### What The AI Bus Does

For each task request, `7000` should:

1. Look up the task in the registry.
2. Check enabled/disabled state.
3. Pick model from:
   - explicit allowed override
   - task quality mode
   - env override
   - registry default
4. Apply cache policy.
5. Run deterministic prefilters when the task has them.
6. Call OpenAI/Anthropic/other provider through a shared adapter.
7. Validate output against the task contract.
8. Log usage/latency.
9. Return a normalized result to the caller.

That means the provider-specific logic sits in one place:

```text
shared app code
  -> runAiTask("sms.classify", payload)
  -> ai-bus task registry
  -> provider adapter
  -> model
  -> normalized task result
```

The caller never needs to know whether `sms.classify` ran on Claude Haiku, GPT mini, Sonnet, or a regex fast path.

## Migration Examples

### SMS

Today:

```text
smsClassifierService
  -> regex fast paths
  -> createAnthropicClient()
  -> Claude tool call
  -> normalized classification
```

Target:

```text
smsClassifierService
  -> regex fast paths
  -> runAiTask("sms.classify", payload)
  -> normalized classification
```

The AI bus task owns:

- model selection,
- tool schema,
- timeout,
- JSON validation,
- fallback to `needs_human`,
- usage logging.

### Resolution

Today:

```text
resolutionIntelligence route
  -> fetch 7000 /api/ai/resolution/pitch
  -> parse verdict
  -> persist thread
```

Target:

```text
resolutionIntelligence route
  -> runAiTask("resolution.pitch", dossier/thread/ask)
  -> parse verdict
  -> persist thread
```

The existing `7000` pitch route can stay as a compatibility shim while the generic task route becomes the canonical path.

### Activity Review

Today:

```text
activityAiReviewService
  -> fetch Logics activities
  -> createAnthropicClient()
  -> JSON review
  -> persist review/profile
```

Target:

```text
activityAiReviewService
  -> fetch Logics activities
  -> runAiTask("activity.contactSafetyReview", activities)
  -> persist review/profile
```

This is a good first migration because it is batch, bounded, JSON-only, and not latency-sensitive.

### Sales Trainer

Today the sales trainer has several direct model surfaces. Target split:

```text
trainer.respond
trainer.transcribeMic
trainer.tts
trainer.generateProfile
trainer.generatePlaybook
trainer.coachNarration
```

The current control-plane routes should remain stable for the frontend. Internally they should call `runAiTask()`.

### Blogger

Keep the operational runner where it is, but route the expensive model pieces:

```text
blogger.currentEvent
blogger.writeDraft
blogger.recoverFailure
blogger.renderHeroImage
```

This gives the daily blog loop the same spend logging and model downgrade controls as the app.

## Spend Controls

### Required

- Per-task enabled flag.
- Per-task model override.
- Per-task max output token cap.
- Per-task timeout.
- Per-task daily usage log.
- Per-session or per-case rate caps for live coach and ask-the-coach.
- Fail-safe fallback for compliance tasks.
- No raw secrets in logs.

### Strongly Recommended

- Daily rollup by task family:
  - live coach
  - resolution
  - SMS
  - activity review
  - call scoring
  - sales trainer
  - blogger
- A dashboard endpoint:

```text
GET /api/ai/spend/today
GET /api/ai/tasks
GET /api/ai/tasks/:taskId
POST /api/ai/tasks/:taskId/config
```

- Lightweight Mongo collection for task runs:

```js
AiTaskRun {
  taskId,
  family,
  caller,
  domain,
  caseId,
  sessionId,
  provider,
  model,
  status,
  elapsedMs,
  inputChars,
  outputChars,
  usage,
  errorCode,
  createdAt
}
```

Use TTL or monthly pruning. Do not store full transcripts by default. Store pointers to artifacts when needed.

## Caching Rules

1. Stable prompts should be separated from dynamic payloads.
2. Cache keys should include task id, prompt version, model, and tenant/company when the prompt differs by company.
3. OpenAI tasks should use `prompt_cache_key` where available.
4. Anthropic tasks with long stable instructions should use `cache_control: { type: "ephemeral" }`.
5. Cache does not cross models. A Sonnet cached prefix and an Opus cached prefix are separate.
6. Do not cache large per-call transcript blobs as static prompt. Summaries and selected keys should ride as dynamic payload.

## Quality Ladder

Each task should define three modes:

| Mode | Meaning | Use |
| --- | --- | --- |
| `cheap` | Lowest model likely to satisfy contract | Batch, background, low-risk classification |
| `balanced` | Default production mode | Most daily work |
| `best` | Strong model / priority tier | Live floor tuning, high-value click-and-wait work |

Example policy:

```js
sms.classify = {
  cheap: "mini",
  balanced: "mini",
  best: "sonnet"
}

liveCoach.dialogCompose = {
  cheap: "sonnet-low-thinking",
  balanced: "sonnet-no-thinking-or-low",
  best: "sonnet-high-thinking"
}

resolution.pitch = {
  cheap: "sonnet",
  balanced: "opus-low/adaptive",
  best: "opus-high"
}
```

The names above should map to actual provider model ids in config, not hard-coded throughout the app.

## Tomorrow Checklist

1. Add a read-only AI call inventory script that reports direct provider calls by file.
2. Add `docs/AI_SPEND_UNIFICATION_PLAN.md` to the working plan and keep it current as code moves.
3. Create a first-pass task registry with only existing `7000` tasks.
4. Add logging wrappers around current `7000` provider calls without changing behavior.
5. Add a `/api/ai/tasks` read endpoint showing task config, enabled state, model, timeout, and max tokens.
6. Pick one low-risk migration target:
   - recommended first: `activityAiReviewService.js`
   - second: `smsClassifierService.js` after contract tests
7. Write contract tests per migrated task:
   - valid JSON
   - timeout fallback
   - disabled fallback
   - malformed model output fallback
8. Do not move blogger or sales trainer until the registry and telemetry prove useful on smaller paths.

## Open Questions

- Should `7000` own all provider API keys, or should some batch scripts keep direct keys until they migrate?
- Do we want one `AiTaskRun` collection for all AI usage, or separate hot-path event logs for live coach?
- Which tasks are allowed to use priority service tier by default?
- What is the daily spend ceiling that should trip a downgrade or kill switch?
- Should high-risk compliance tasks fail to human review on any model downgrade, or allow mini fallback?

## Recommended First Implementation Slice

Build the registry around existing `7000` calls first, then expose it read-only.

That gives us immediate visibility without touching the riskiest workflows. Once the registry exists, migrate `activityAiReviewService.js` because it is batch, bounded, and returns strict JSON. If that works cleanly, migrate `smsClassifierService.js` with stronger contract tests because it can affect DNC/contact decisions.

## Design Correction (2026-06-17): provider is NOT a task property

The original plan had a same-provider `fallbackModel`. The hard requirement is stronger: **every reasoning task must run on EITHER provider and fail over in both directions** — swap the brain to OpenAI if Claude is down, swap the grader to Claude if OpenAI is down. There is no "this is an OpenAI task." A provider name appears in exactly one layer (the adapter), never in task logic.

Mechanism — capability-typed tasks:

- Each task declares a `kind`: `compose` | `json` | `classify` (reasoning, implemented by BOTH providers) or `transcribe` | `image` | `tts` (modality — only providers that physically can, via `adapter.supports(kind)`; Claude has no audio/image API, so those skip it honestly).
- A task carries a provider-neutral request (`system`/`user`/`schema`) + an ordered list of *capable* providers (default preference only) + a per-provider model ladder + a contract validator + a fail-closed shape.
- The runner walks providers, failing over on transport error / 5xx / timeout / **contract-validation failure**, in whichever order config dictates. Failover guarantees a *contract-valid* answer, not a bit-identical one (Anthropic emits JSON via forced `tool_use`; OpenAI via the Responses API) — which is exactly why compliance tasks keep the strict validator + `needs_human` fail-closed.

## Build Log — 2026-06-17 (Day 1: dual-provider spine, tested, unwired)

Shipped (all additive, default-OFF, no live route touches yet — floor untouched):

- `packages/shared-integrations/src/openaiClient.js` — the missing shared OpenAI client (Responses API + audio transcribe + image + TTS), mirroring `anthropicClient.js` (same-provider model ladder, timeout, `ExternalServiceError` shapes).
- `packages/shared-services/src/aiProviders.js` — the capability seam. `createAnthropicAdapter` / `createOpenAiAdapter`, each with `supports(kind)` + `run(kind, request, {model})`. The ONLY place a provider name lives.
- `packages/shared-services/src/aiTaskRegistry.js` — provider-neutral task table (`activity.contactSafetyReview` fully inlined as the proof migration; `sms.classify`, `liveCoach.callGrade`, `resolution.pitch` registered with delegated prompts), contract validators, `describeTask` (read-only, no prompt/secret leakage).
- `packages/shared-services/src/aiTaskRunner.js` — `createAiTaskRunner({providers, registry, telemetry, env})` → `runAiTask(taskId, payload, options)`. Bidirectional failover; provider/model precedence: `forceProvider` > `AI_TASK_<ID>_PROVIDER` > `AI_TASK_<ID>_PROVIDER_ORDER` > registry default; `forceModel` > `AI_TASK_<ID>_<PROVIDER>_MODEL` > quality tier > ladder. `dryRun` + fail-closed.
- `tests/ai-bus/aiTaskRunner.test.js` — 14 tests green: both swap directions, force/env override, contract-fail failover, fail-closed, disabled short-circuit, modality skip, dryRun, an integration test running the same JSON task on Claude (tool_use) and OpenAI (Responses) identically, plus 3 regressions.

Hardened after a 2-agent adversarial review (3 HIGH bugs fixed before any wiring): (1) `buildRequest` throwing now fails closed instead of crashing the call; (2) a typo'd `contract` name now throws at registry load instead of silently shipping unvalidated output (`assertRegistryIntegrity`); (3) `openaiClient` non-JSON output now walks the model ladder instead of throwing out of it. Deferred (flagged for the live-smoke step): switch the OpenAI json path from text-parse to native Responses `json_schema` structured output — the more robust form, but it needs a live API to verify the field shape, so it was not added blind.

### Primitive layer (`aiPrimitives.js`) — atomic verbs

The intended developer surface is a handful of atomic verbs, not 20 named tasks. Each parent system (coach, blogger, scrubber, text messenger, upsell planner) composes from:

- `aiRead` / `aiJudge` / `aiScore` (structured comprehension — same `json`/`classify` machine, differ by schema + default tier)
- `aiWrite` (text out; `aiReact`/`aiRespond`/`aiGuide` are aliases)
- `aiTranscribe` / `aiImage` (modality)

Atomic invocation: `verb({ prompt, platform, model, ...extras })`. `prompt` is a string or `{system,user}`; `platform` is a **preference** (tried first, the other stays as failover) with `pin:true` for a hard no-failover pin; `model` is the preferred model for the chosen platform. `schema` (read/judge/score), `audio` (transcribe), `label` (per-system spend attribution), and `validate` are optional extras. Defaults (which platforms/models/caps) live in the registry `ai.*` tasks — set there or via `AI_TASK_AI_*` env for "from one place"; the invocation overrides per call. A named task (e.g. `sms.classify`) is just one of these verbs with its prompt + contract + caps frozen and given an id. 23 tests green across the spine + primitives.

So a parent collapses to, e.g. — blogger: `const draft = await aiWrite({ prompt: blogPrompt, label: "blogger.write" }); const hero = await aiImage({ prompt: heroPrompt, label: "blogger.image" });`

Next (not yet done): mount `GET /api/ai/tasks` + `POST /api/ai/tasks/:taskId/run` on 7000 with real clients behind `requireInternalAccess`; `aiTaskClient.js` (`runAiTask`/`useAi` app-side helper); `AiTaskRun` telemetry model; cut `activityAiReviewService.js` over behind its env flag with a live smoke; then `sms.classify` with the full prompt + DNC contract tests.
