# AI Button-Up Coordination - 2026-06-25

Purpose: give the next AI pass a small, concrete map so Claude can work around the current WIP without accidentally assuming the future architecture is already live.

## Current State On Disk

The AI work is real, but not finished.

- `aiProviders.js` now has an Anthropic-only `search` kind for the current-event blogger. It runs a bounded `web_search -> submit tool` loop inside the Anthropic adapter and returns the submit payload as normal bus JSON.
- `anthropicClient.js` now treats `toolChoice === false` as "omit tool_choice." This is load-bearing for Anthropic server-side web search. Do not simplify it away.
- `blogger-current-event.js` no longer owns its own raw Anthropic SDK loop. It builds an in-process `createAiTaskRunner` and runs `blogger.currentEvent`.
- `aiTaskRunner.js` exports the stricter `validateAgainstSchema`; `aiBusRegistry.js` and the sandbox harness now share it.
- `aiBusRegistry.js` has stricter boot assertions and builds bus-visible tasks from `aiSandbox` plus primitive `ai.*` tasks.
- `liveCoachTranscriptTranslator.js` exists as a fail-open sidecar around `liveCoach.translate`; it should not become a required live-reaction step.

What is still not done:

- There is no `agent` provider yet. `claude -p` / Max account execution is still aspirational, not a bus substrate.
- There is still a task-source split. `aiBusRegistry` builds from `aiSandbox` plus primitives, while `aiTaskRegistry` still carries named descriptors such as `liveCoach.translate` and `blogger.currentEvent`. Do not assume adding a named task to `aiTaskRegistry` makes it visible on the 7000 bus.
- Live coach hot-path calls in `apps/ai-bus/src/server.js` still have direct OpenAI/Anthropic factories for rolling digest, context judge, call grader, and dialog composer. Those are not fully on the bus yet.
- Spend telemetry is still split. The blogger pilot now emits a bus-shaped row to console, but that is not the same as a durable `AiTaskRun` sink.
- Real provider proof is still thin. Offline tests prove wiring; they do not prove the real Anthropic web-search loop, OpenAI strict JSON behavior, cache hits, or Max-agent rollover.

## Collision Rules For Claude

If you are working on CX queue / appointment / Logics work:

- Do not touch AI registry/provider files unless the task explicitly says AI.
- Do not route call-summary or appointment work through a model yet. Keep those as deterministic routes and data writes until the summary form/coach contract is final.
- Do not restart or patch AI-bus because CX code changed.

If you are working on coach v2:

- Use the new coach modules as the revamp surface, but do not wire them into the hot path until their DTO contracts are stable.
- Keep transcript repair as an annotation sidecar: raw final -> deterministic/semantic coach path; raw final -> async correction annotation. No correction output should create a second compose trigger.
- Leave the current live coach factories alone unless the migration task is specifically about wrapping one with bus telemetry/config.

If you are working on AI bus:

- Verify bus visibility with `buildBusRegistry().getTask(taskId)`, not by reading `aiTaskRegistry.js`.
- Keep provider attempts pure. Adapters may generate text/JSON/audio; they must not publish blogs, send SMS, write Logics, or commit metrics.
- Keep side effects in callers or drain workers, behind idempotency keys.
- Keep task output contract-neutral, not provider-neutral at any cost. Anthropic/OpenAI internals may differ; the returned DTO must not.

## Button-Up Sequence

### 1. Freeze the catalog ownership first

Pick one canonical source for production named tasks before migrating more services.

Recommended shape:

- `aiSandbox` / `aiBusRegistry` owns bus-visible production tasks.
- `aiTaskRegistry` either becomes primitives + validators only, or every named task in it gets promoted into the sandbox-backed source.
- Add a test that fails if a named task exists in one catalog but not the other, unless explicitly marked `localOnly`.

Known id drift to resolve in this step:

- `liveCoach.callGrade` vs `liveCoach.callGrader`
- `blogger.currentEvent` in `aiTaskRegistry` vs `aiSandbox` promptTodo stub
- `liveCoach.translate` local in-process descriptor vs bus-visible registry expectations

Done when a reviewer can answer one question with one command:

```powershell
node -e "const { buildBusRegistry } = require('./packages/shared-services/src/aiBusRegistry'); console.log(buildBusRegistry().listTasks().map(t=>t.id).sort().join('\n'))"
```

### 2. Keep the blogger migration as the pilot, not the pattern for everything

The current-event blogger is a good first bus pilot because it is batch, timeout-tolerant, and already has a static fallback.

Button it up by:

- Running the existing blogger bus tests.
- Running one real Anthropic web-search smoke on a non-floor box.
- Confirming failure still throws so `blogger-daily-runner` static fallback fires.
- Moving only the stable shared helpers into common modules; do not move the publish side effect into the adapter.

Do not use the blogger's in-process runner as the default shape for web app features. App features should eventually call the mounted bus route or a shared service client, with one telemetry sink.

### 3. Add the `agent` provider once, centrally

Do not bolt `claude -p` onto blogger, grader, SMS, and coach separately.

Build one `agent` adapter under `aiProviders` with the same contract as the others:

```text
supports(kind)
run(kind, request, opts) -> { text | json | audio, model, usage, provider:"agent" }
```

Then use provider order:

```text
["agent", "anthropic", "openai"]
```

Only after that should we flip Max/account-based execution for background tasks.

### 4. Put telemetry and idempotency before more side effects

Before SMS, blogger publish recovery, grader emails, or Logics-writing AI tasks ride through rollover:

- Add `AiTaskRun` or equivalent durable run records.
- Record `taskId`, `family`, `label`, `caller`, `domain`, `caseId`, `sessionId`, `provider`, `model`, `status`, `elapsedMs`, `usage`, and `errorCode`.
- Add an idempotency key option to callers that can cause side effects downstream.
- Make telemetry async and non-blocking.

This is how we avoid "it rolled over, charged twice, and nobody knows which provider wrote the answer."

### 5. Migrate low-risk tasks before live coach

Suggested order:

1. `activity.contactSafetyReview` - batch, strict JSON, no hot UI dependency.
2. `sms.classify` - keep regex/DNC fast paths local, only model branch goes bus, fail closed to `needs_human`.
3. Blogger write/image/failure recovery - batch, but image is OpenAI modality-specific.
4. `liveCoach.translate` - sidecar only, off the immediate reaction path.
5. Call grader - longer calls only, Sonnet/agent default, no fake grade on failure.
6. Live coach context/guidance - wrap for config and telemetry first; do not force a full provider-neutral rewrite until coach v2 contracts are settled.

### 6. Cache and prompt shape come after the catalog is stable

Prompt caching only helps if the static part is actually identical.

For coach v2, structure prompts as:

```text
stable system / role packet
stable skill catalog
stable output contract
small dynamic packet: transcript beat, phase state, selected context keys
```

Do not chase cache wins before the task ids, provider ladders, and DTOs stop moving.

## Tests To Run Before Calling AI Work Buttoned Up

Syntax:

```powershell
node --check packages/shared-services/src/aiProviders.js
node --check packages/shared-services/src/aiTaskRunner.js
node --check packages/shared-services/src/aiTaskRegistry.js
node --check packages/shared-services/src/aiBusRegistry.js
node --check packages/shared-integrations/src/anthropicClient.js
node --check scripts/blogger-current-event.js
```

Unit suites:

```powershell
node --test tests/ai-bus/aiTaskRunner.test.js tests/ai-bus/aiPrimitives.test.js tests/ai-bus/aiSandbox.test.js tests/ai-bus/busContract.test.js tests/ai-bus/apiLocal.test.js tests/ai-bus/aiTaskClient.test.js tests/ai-bus/busWiring.test.js tests/ai-bus/registryFailover.test.js tests/ai-bus/anthropicSampling.test.js
node --test tests/blogger/blogger-current-event-bus.test.js
node --test tests/livecoach-translator/liveCoachTranscriptTranslator.test.js
```

Real smoke before production flip:

- One tiny Anthropic JSON/tool call through the bus.
- One tiny OpenAI JSON call through the bus.
- One real `blogger.currentEvent` web-search call in a safe environment.
- One `liveCoach.translate` sidecar call with translator disabled/enabled comparison.

## What Claude Can Safely Work Around Today

- Treat AI bus as WIP and keep it out of CX queue patching.
- Use deterministic DTO routes for appointment, call summary, and communications work.
- If a route needs future AI, create a dormant route with a stable payload/response contract but do not invoke a model yet.
- If adding coach v2 code, keep it behind explicit local/test flags and do not remove the existing live coach factories.
- If adding new AI tasks, add them only after deciding whether they live in `aiSandbox`/bus registry or are explicitly `localOnly`.

## Short Version

The safe button-up is not "move more calls to the bus." It is:

```text
one catalog
one validator
one provider seam
one telemetry sink
pure provider attempts
idempotent side effects
real smoke before flags
```

Until those are true, Claude should work around the AI WIP by keeping CX/Logics changes deterministic and by treating new AI routes as contracts, not active model calls.
