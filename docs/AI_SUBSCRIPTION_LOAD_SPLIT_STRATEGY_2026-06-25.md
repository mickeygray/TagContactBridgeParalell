# AI Subscription Load Split Strategy - 2026-06-25

## Purpose

This note synthesizes the coach/cost discussion after the newer finding that the
Claude/agentic lane is not a flat unlimited production backend. The practical
goal is to use the paid subscriptions we already have without turning them into
surprise metered API spend.

The split is:

- Claude Max subscription: protected for high-value live coach turns.
- ChatGPT/Codex subscription: slow internal agentic jobs on a trusted worker.
- OpenAI API: STT plus cheap, low-latency, structured service calls.
- Anthropic/OpenAI metered APIs: explicit fallback only, never silent rollover.

## Official Codex Boundary

The official Codex docs matter here because Codex has two very different billing
and runtime shapes:

- Codex can authenticate with ChatGPT for subscription access, or with an API
  key for usage-based access.
- API-key Codex usage is billed through the OpenAI Platform at standard API
  rates.
- `codex exec` exists for non-interactive scripts, scheduled jobs, CI-style
  workflows, JSON output, and schema-constrained output.
- ChatGPT-managed auth on trusted runners is possible, but it is an advanced
  path. The auth cache is a secret and must be treated like a password.

Interpretation for this app:

Codex subscription is viable as a trusted internal worker that consumes durable
jobs and writes structured results back. It is not a replacement for the OpenAI
API on request/response service paths, and it should not sit in the live coach
hot loop.

## Short Verdict

Claude's corrected direction is right, with one important narrowing:

Codex should soak slow background thinking, not routine 12-second live coach
ticks. The biggest savings still come from tiering the coach itself:

```text
STT / hot cheap JSON / transcript repair -> OpenAI API cheap lane
routine coach classification              -> OpenAI mini/nano or Haiku
high-stakes live coach writing            -> Claude Max Opus/fast
slow background agentic work              -> Codex subscription worker
```

Offloading grader/blogger/audits to Codex protects the Claude pool, but it does
not solve the whole coach bill by itself. The live coach hot loop is the spend
driver. The coach has to decide which turns deserve Opus.

## Load Split

| Workload | Latency | Primary route | Fallback | Notes |
| --- | --- | --- | --- | --- |
| Live STT / transcription | realtime | `openai.api.stt` | none/degraded coach | Subscription agents cannot replace STT. Optimize gating and retention, not provider. |
| Transcript repair / semantic cleanup | seconds | `openai.api.cheap_json` | raw transcript annotation | Cheap structured API lane. Do not block reactions on repair. |
| Rolling call summary | seconds to 1 min | `openai.api.cheap_json` | delayed Codex closeout | Feeds the hot prompt with bounded "call so far"; also becomes closeout seed. |
| Floor routine coach tick | about 12s | `openai.api.cheap_json` or `anthropic.api.haiku` | skip tick | Classify seven calls at once. Most ticks should not touch Opus. |
| High-stakes coach response | about 12s | `claude.max.opus_fast` | `openai.api.strong` only if armed | Objection, fee, close, hostility, compliance-sensitive guidance. Alert on metered fallback. |
| Rich coach `{spine, packets}` slow pass | 30s+ if non-blocking | `codex.sub.agent` or `anthropic.api.sonnet` | queued result | Codex is acceptable only if the UI can live without it immediately. |
| Ask the coach, agent waiting | interactive | same tiering as live coach | fail closed to "try again" | Do not use Codex subscription if the agent is waiting for an answer. |
| End-of-call grader | async | `codex.sub.agent` | cheap/strong API after deadline | Deterministic evidence gate first. Codex writes grade JSON and email body draft. |
| Agent coaching email | async | `codex.sub.agent` | skip or API if urgent | Mailer sends only after schema validation and outlier rules. |
| Blogger/current event | async/off-hours | `codex.sub.agent` | static fallback or API | Great fit for agentic research/writing, but publish remains outside provider adapter. |
| Client health flags / notice digest | nightly | `codex.sub.agent` | API batch | Deterministic data pull first, agent writes narrative/advisory result. |
| Upsellerator pitch design | click vs batch dependent | API if user waits; Codex if precomputed | queue/degrade | Split into precompute and on-click variants. |
| CX/log/code audits | async/internal | `codex.sub.agent` | none | Ideal subscription-agent lane. |

## Coach V2 Cost Shape

The stable prompt/playbook should be used for caching, but the runtime should be
tiered:

1. STT produces transcript turns.
2. Cheap transcript repair annotates the transcript, but does not trigger a
   second live reaction.
3. A cheap batched classifier sees all active calls and returns:
   - `guideDelta`
   - `completedGuideItems`
   - `candidateReaction`
   - `stakesLevel`
   - `needsWriter`
   - `needsOpus`
   - `reason`
4. If `needsWriter=false`, the UI gets checklist/guide updates only.
5. If `needsWriter=true` and `needsOpus=false`, the cheap lane can write a small
   response.
6. If `needsOpus=true`, the Claude Max lane writes the response using the stable
   playbook plus only the relevant dynamic packet.
7. Every written response is stored as a call memory item so the grader and later
   coach turns can reference what was already suggested.

The prompt cache win comes from keeping these sections byte-stable:

- role and output contract
- sales/tax playbook
- objection/tax/sales-opportunity catalog
- tool/result schema

Only the bottom packet should change:

- transcript beat
- rolling summary
- active guide state
- selected context keys
- active caller metadata

## Why Codex Does Not Own The Hot Loop

Codex can run headless, but it is shaped like an agent job:

- startup/auth/session behavior has more moving parts than a direct API call
- task execution is less predictable than a small JSON API request
- subscription limits are not the same thing as API throughput
- outputs should be validated from files/stdout, not trusted as an inline app
  response

That is fine for a grader, audit, blogger, or nightly digest. It is a bad fit
for a 12-second all-floor loop that has to return structured guidance while an
agent is actively in a call.

## Required Bus Concept: Route, Not Provider

The current AI bus thinks mostly in provider/model terms. It needs a routing
unit that includes account and billing substrate:

```js
{
  routeId: "codex.pro.background",
  substrate: "subscription_agent", // api | subscription_agent | local
  provider: "codex",
  accountProfile: "codex-pro-worker",
  billingBucket: "chatgpt_subscription",
  model: "default",
  latencyClass: "async",
  supports: ["compose", "json"],
  maxRuntimeMs: 300000,
  metered: false,
  fallbackRouteIds: ["openai.api.cheap_json"],
  fallbackPolicy: "queue_first" // queue_first | degrade | metered_with_alert | fail_closed
}
```

Each task should declare allowed routes, not just provider order:

```js
{
  taskId: "liveCoach.callGrade",
  latencyClass: "async",
  outputContract: "callGrade.v2",
  sideEffects: false,
  idempotencyRequired: true,
  allowedRoutes: [
    "codex.pro.background",
    "anthropic.api.sonnet",
    "openai.api.strong_json"
  ],
  defaultFallbackPolicy: "queue_first"
}
```

This prevents a dead subscription worker from silently falling through to a
metered model unless the task explicitly allows it.

## Codex Agent Runner Shape

There is already a prototype at:

- `scripts/codex-agent/codexMcpClient.js`
- `scripts/codex-agent/smoke-codex.js`
- `scripts/codex-agent/probe-mcp.js`

Keep it experimental until the runner is hardened. The first production-shaped
runner should be boring and job-based:

```text
durable job row
  -> codexAgentRunner
  -> isolated CODEX_HOME
  -> no OPENAI_API_KEY in child env
  -> read-only/default sandbox
  -> prompt + JSON payload + schema
  -> output file
  -> schema validation
  -> result row / failure row
```

Minimum contract:

```js
runCodexAgentJob({
  taskId,
  jobId,
  inputRef,
  payload,
  schema,
  promptVersion,
  deadlineMs,
  cwd,
  sandbox: "read-only"
}) -> {
  ok,
  json,
  text,
  routeId: "codex.pro.background",
  elapsedMs,
  usageEstimate,
  outputPath,
  errorCode
}
```

Guardrails:

- Use a dedicated `CODEX_HOME` for the worker account.
- Strip `OPENAI_API_KEY`, `OPENAI_BASE_URL`, and any alternate API key envs from
  the child process when the goal is subscription auth.
- Prefer device-code login or a securely seeded auth cache on the Linux box.
- Treat `auth.json` like a password.
- Never let the runner perform customer-visible side effects.
- Validate output before any mail, Logics write, blog publish, or DB mutation.
- On timeout, mark the job delayed/failed. Do not auto-spend API unless the
  task policy explicitly says `metered_with_alert`.

## AI Bus Changes Needed

### 1. Collapse The Registry Split

Current problem: `aiTaskRegistry.js` and `aiBusRegistry.js` can disagree. Some
named tasks in `aiTaskRegistry.js` are not the bus-visible tasks. That makes
rollover dangerous because the "right-looking" config might not affect the live
surface.

Target:

- one canonical production task catalog
- one validator
- one command to list the live bus-visible tasks
- boot failure if task ids drift
- explicit `localOnly` marker for anything not bus-visible

### 2. Add Route-Aware Task Policy

Add a route registry beside the task catalog:

- account profile
- substrate
- billing bucket
- route budget
- supported kinds
- latency class
- fallback policy

`aiTaskRunner` should resolve:

```text
task -> allowed routes -> route availability -> budget state -> provider adapter
```

not:

```text
task -> provider string -> model ladder
```

### 3. Add `codexAgent` As An Adapter, But Only For Async Kinds

`packages/shared-services/src/aiProviders.js` should eventually expose a
subscription-agent adapter with the same normalized return shape:

```js
{
  id: "codexAgent",
  supports(kind) {
    return kind === "compose" || kind === "json";
  },
  run(kind, request, opts) {
    // enqueue or execute a controlled Codex job, validate, normalize
  }
}
```

Do not let it support:

- `transcribe`
- `image`
- `tts`
- live low-latency classify unless separately proven

### 4. Add One Spend/Fallback Ledger

Every AI attempt should write the same telemetry shape:

```js
{
  taskId,
  routeId,
  substrate,
  billingBucket,
  provider,
  model,
  accountProfile,
  caller,
  domain,
  sessionId,
  caseId,
  idempotencyKey,
  status,
  elapsedMs,
  usage,
  estimatedCostUsd,
  fallbackFromRouteId,
  meteredFallthrough,
  errorCode
}
```

Rules:

- Any metered fallthrough from a subscription route emits an alert.
- Any task with side effects requires an idempotency key.
- Provider adapters stay pure. Side effects live in callers/drains after a
  validated result.

### 5. Default Fallback Policies

| Task class | Default failure behavior |
| --- | --- |
| STT | degrade coach / mark unavailable |
| live routine coach tick | skip tick |
| live high-stakes coach | try alternate strong route only if armed; otherwise show delayed/unavailable |
| ask coach | fail closed to retry |
| grader | queue, retry, then optional API if deadline/outlier policy requires |
| blogger | static fallback or retry next run |
| nightly health/upsell | queue/retry |
| audits | fail and report |

## Concrete Migration Order

### Phase 0 - Measurement and guardrails

- Add durable `AiTaskRun` telemetry if not already present.
- Label all current direct calls by `taskId`.
- Add `meteredFallthrough` logging before any subscription-agent fallback work.
- Confirm no hot-path route can silently call a metered strong model.

### Phase 1 - Codex worker proof, one task only

First task: `liveCoach.callGrade` or `call.closeoutSummary`.

Why:

- async
- internal
- schema-constrained
- already needs evidence gating
- easy to compare against the current API grader

Acceptance:

- runs on Linux with ChatGPT/Codex auth
- proves it is not using `OPENAI_API_KEY`
- writes schema-valid JSON
- times out cleanly
- queues rather than falls into metered API

### Phase 2 - Collapse task ownership

- Resolve `aiTaskRegistry.js` vs `aiBusRegistry.js`.
- Canonicalize `liveCoach.callGrade` vs `liveCoach.callGrader`.
- Promote or delete dead named tasks.
- Add boot asserts and tests.

### Phase 3 - Route-aware runner

- Introduce route registry.
- Add route budget states: `green`, `yellow`, `red`, `exhausted`.
- Route by task policy and budget, not provider only.
- Add `AI_ALLOW_METERED_FALLBACK=false` default.

### Phase 4 - Move async background work to Codex

Order:

1. call grader / closeout summary
2. agent coaching email draft
3. blogger current-event draft
4. client health flags / notice digest
5. upsellerator precomputed strategy
6. internal CX/metrics audits

### Phase 5 - Coach tiering

- Keep all-floor batching.
- Add cheap classifier/router.
- Escalate only high-stakes turns to Claude Opus.
- Store generated responses as call memory.
- Measure Opus calls per hour, not just total tokens.

## What Not To Do

- Do not put Codex in the 12-second live coach loop.
- Do not replace STT with any subscription agent.
- Do not let `claude -p` or Codex failure silently fall to OpenAI API.
- Do not leave `OPENAI_API_KEY` in the Codex worker env when testing
  subscription billing.
- Do not let an adapter publish blogs, send emails, write Logics, mark DNC, or
  mutate metrics.
- Do not optimize prompt caching before the task ids, DTOs, and output contracts
  are stable.
- Do not assume the ChatGPT/Codex subscription behaves like an API quota. Prove
  throughput and limits with a real Linux worker smoke.

## Final Split

Use the subscriptions where they are strongest:

```text
Claude Max:
  high-stakes live coach writing
  high-quality coach synthesis when it truly matters

Codex subscription:
  async internal agentic work
  graders, summaries, blogger, audits, health reports, patch reviews

OpenAI API:
  STT
  cheap structured JSON
  transcript repair
  routine classifier/router
  explicit metered fallback when armed
```

That split gives the floor the quality it needs without pretending a
subscription agent is a production API. It also makes spend observable: every
task knows which route it used, which account it burned, and whether it crossed
into metered money.
