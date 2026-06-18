# AI Bus — Audit Guide (cold-reviewer handoff)

Orientation for someone reviewing the AI bus without having built it. Read this first; it tells you what exists, what's proven, what isn't, and where to look.

## Status (set expectations)

The bus is a **complete, unit-tested library that is NOT yet live.** No real OpenAI/Anthropic call has ever gone through it — every test uses fakes/`dryRun`/loopback. It is **not mounted** on the live 7000 (a 3-line mount is staged, proven to construct). Treat it as "all parts machined and bench-fit," not "engine running."

## The map

**Core (provider-neutral runner + transport):**
| File | Role |
|---|---|
| `packages/shared-integrations/src/openaiClient.js` | Shared OpenAI client (Responses + transcribe + image + tts), same-provider model ladder |
| `packages/shared-services/src/aiProviders.js` | **The only place a provider name lives** — anthropic (tool_use) + openai (Responses) adapters; `supports(kind)` |
| `packages/shared-services/src/aiTaskRegistry.js` | Task table + `ai.*` primitive tasks + validators + `assertRegistryIntegrity` + `describeTask` |
| `packages/shared-services/src/aiTaskRunner.js` | `runAiTask` — bidirectional failover, kind/provider/model precedence, cache threading, fail-closed, telemetry hook |
| `packages/shared-services/src/aiPrimitives.js` | Verbs `aiRead/Write/Judge/Score/Transcribe/Image/Speak` (+aliases); `verb({schema,prompt,model})` |
| `packages/shared-services/src/aiTaskClient.js` | **Sender** (5001→7000 loopback POST + `x-service-secret` + timeout + fail-closed + timing) |
| `apps/ai-bus/src/aiTaskRoutes.js` | **Destination** route handlers (`runTask`/`listTasks`/`getTaskInfo` + express `mountAiTaskRoutes`); stamps `busMs` |

**Sandbox (real material, copied):** `packages/shared-services/src/aiSandbox/` — `prompts/` (4 cp'd `.md` + verbatim `liveCoach.js`/`compliance.js`/`scoring.js`), `schemas.js`, `cache.js`, `rules.js`, `tasks.js`, `index.js`, `README.md`. *Duplication is intentional; see its README.*

**Verification layer (the spec):** `tests/ai-bus/` — `sandboxHarness.js` (builds a runner from sandbox descriptors), `busContract.test.js` (per-task I/O), `apiLocal.test.js` (route over real http), `aiTaskClient.test.js`, `busWiring.test.js`, plus `aiTaskRunner`/`aiPrimitives`/`aiSandbox`. `scripts/ai-bus-transport-bench.js` (transport timing).

**Docs:** `AI_SPEND_UNIFICATION_PLAN.md` (design), `AI_TASK_DICTIONARY.md` (per-task prompt/schema/cache index), `AI_BUS_BUILD_PLAN.md` (the step list), `AI_BUS_DELIVERY.md` (transport flow + measured numbers).

## Architecture in one breath

`caller → aiPrimitives (verb) → aiTaskClient (5001) → HTTP → aiTaskRoutes (7000) → aiTaskRunner → aiProviders adapter → provider`. Provider lives **only** in the adapter; tasks are provider-neutral and fail over both ways; `schema` = plumbing descriptor (output/cache/family/validate), `prompt` = fed, `model`/`platform` = used.

## Design principles (implementation lens)

The bus should be a **governor and execution boundary**, not a second copy of the whole app's business brain. The clean ownership split is:

```text
5001 / app features
  Own business state, user intent, permissions, case/lead context, and UI timing.

7000 / AI bus
  Own model policy, task contracts, prompt/cache versions, provider failover,
  quality tiers, spend controls, and structured AI result envelopes.

shared packages
  Own deterministic parsing, schemas, context shaping helpers, DTOs, and tests
  that both 5001 and 7000 need to agree on.
```

The most important design rule: **centralize model execution, not all business logic. Centralize spend control, not every decision.** If 7000 starts deciding lead ownership, contactability state, queue semantics, or UI navigation, the app has only moved spaghetti from one pot to another.

### Named tasks over generic primitives

Use named tasks for production behavior:

```js
runAiTask("sms.classify", payload)
runAiTask("activity.contactSafetyReview", payload)
runAiTask("liveCoach.contextJudge", payload)
runAiTask("resolution.pitch", payload)
```

The primitive verbs (`ai.write`, `ai.judge`, `ai.read`, etc.) are useful as a development surface and for controlled one-offs, but they should not become the normal production interface. A generic `useAi("mini", "sms")` style API is convenient, but too easy to abuse: it hides whether the caller is doing compliance classification, prose generation, grading, or a hot-path coach tick. Named tasks let the bus enforce a fixed contract, safe fallback, model ladder, timeout, cache policy, and spend label.

### Three-part task shape

Every AI task should be designed as:

```text
1. deterministic prep
   No model. Keyword matching, eligibility checks, stop-word stripping,
   context slicing, candidate-key lookup, dedupe, rate gates.

2. model call
   Smallest adequate model. Stable cached system prompt. Compact dynamic payload.
   Strict JSON where possible. Streaming only when a human is waiting.

3. render contract
   A DTO that 5001/UI can trust without interpreting prose.
```

The bus should receive a task-shaped packet, not a junk drawer. Prefer:

```json
{
  "transcript": "I owe the IRS and they sent me a levy notice",
  "candidateKeys": [
    { "key": "irs_debt", "summary": "Federal tax balance" },
    { "key": "levy", "summary": "Enforcement/seizure pressure" }
  ],
  "memoryBrief": "Prospect is worried, early discovery phase."
}
```

Avoid sending the entire case, entire playbook, entire transcript, and full activity history unless that task truly needs it. Loopback transport is cheap; model tokens are not.

### Provider-neutrality is useful, but not absolute

Provider-neutral tasks are realistic for simple `compose`, `json`, and `classify` jobs. They become less honest around:

- Anthropic tool-use vs OpenAI structured output.
- Anthropic cache blocks vs OpenAI prompt cache keys.
- OpenAI STT/TTS/image modalities.
- Realtime/audio behavior.
- Web-search/tool-loop tasks.
- Thinking/effort/service-tier controls.

So the right target is **contract-neutral**, not provider-religious. The caller should receive the same `result` shape either way; the bus may still need provider-specific internals to get that result fast, cheap, and valid.

### Efficiency bias

- Optimize model calls before optimizing transport. The measured 5001->7000 hop is sub-millisecond; token size, provider latency, retries, and over-calling dominate.
- Put deterministic gates before models, especially in hot paths.
- Use cacheable static prompts and compact dynamic payloads.
- Prefer fail-closed JSON over clever prose parsing for compliance and workflow decisions.
- Keep hot-path live coach work in-process on 7000 when possible; use the registry/governor concepts without adding unnecessary HTTP hops inside the bus.
- Add spend labels at the task boundary, not at random call sites.

### What may not work as advertised

- Green tests do not prove provider compatibility; most tests use fakes, dry-run, or loopback.
- A task that looks provider-neutral in the registry can still be prompt/provider-sensitive in production.
- Default-on primitives can become a spend leak if exposed without strict internal auth and telemetry.
- Sandbox prompts are copied material. Without drift checks, the bus can slowly stop matching the live system it claims to represent.
- Generic primitives can hide business-critical behavior unless promoted into named tasks with contracts.
- Failover is only safe when the second provider is contract-compatible and quality-compatible, not merely API-compatible.

## Recommended testing order

1. **Static contract suite**: keep the 69-file-list test command green. This proves the local abstraction did not break.
2. **Route mount smoke, dry-run only**: mount `/api/ai/tasks` on local 7000 behind `requireInternalAccess`, hit `GET /api/ai/tasks`, then `POST /api/ai/tasks/ai.read/run` with `{ dryRun:true }`.
3. **Auth smoke**: prove no secret returns 401 in production-like config, and a valid `x-service-secret` succeeds. Do this before any real provider call.
4. **Real provider micro-smoke**: one tiny JSON task through OpenAI, one tiny JSON/tool task through Anthropic. Do not migrate a feature until both adapters have made one real call.
5. **Telemetry smoke**: prove a task run writes or emits `taskId`, family/label, provider, model, elapsed, usage if available, status, and failure code. Without this, spend is still fog.
6. **First migrated task: `activity.contactSafetyReview`**. It is batch, bounded, strict JSON, no hot UI dependency. Compare legacy vs bus on real cases.
7. **Second migrated task: `sms.classify`**. Only after the activity path proves stable. Keep deterministic regex fast paths local and fail closed to `needs_human`.
8. **Batch/non-hot migrations**: transcription scoring, case notes, blogger write/image/failure recovery.
9. **Sales trainer migrations**: last among app features because it has many model surfaces and many quality knobs.
10. **Live coach governance**: keep the hot path on 7000, but gradually pull its config, cache policy, spend logging, rate limits, and named-task contracts under the same registry discipline.

At every migration step, run legacy and bus side by side first, compare result shape, then flip the task env flag. Never replace a direct caller only because the bus abstraction is prettier.

## How to run everything

```bash
# full bus suite (69 tests) — NOTE: the `node --test tests/ai-bus/` directory form FAILS on this Node; pass files:
node --test tests/ai-bus/aiTaskRunner.test.js tests/ai-bus/aiPrimitives.test.js tests/ai-bus/aiSandbox.test.js \
  tests/ai-bus/busContract.test.js tests/ai-bus/apiLocal.test.js tests/ai-bus/aiTaskClient.test.js tests/ai-bus/busWiring.test.js
# transport benchmark (real loopback numbers)
node scripts/ai-bus-transport-bench.js
```

## Proven vs UNPROVEN (the honest line)

**Proven (by 69 tests, with fakes):** bidirectional failover; contract-invalid→failover→fail-closed; kind/provider/model precedence; `preferProvider` keeps failover vs `forceProvider`/`pin` hard; empty-result guard; registry integrity; openaiClient json ladder-retry; primitive `{schema,prompt,model}` incl. `aiSpeak` + `aiWrite+schema→json` + `schema.cache→cacheable system`; sandbox loads + core tasks fully populated + cache keys preserved; per-task I/O contract (8 core tasks); route envelope over real http + fail-closed over wire + catalog no-prompt-leak; client timing math + transport-failure fail-closed + timeout/http-error mapping; production wiring constructs + serves a dryRun.

**UNPROVEN (must be flagged to any reviewer):**
- **No real model call has EVER run through the bus.** All providers are fakes.
- `openaiClient.transcribeAudio` / `generateImage` / `synthesizeSpeech` — real HTTP, **no test**.
- Route is **not mounted** on the live 7000; no real 5001 service calls the client.
- Named tasks are **default-off and not sandbox-backed**; the contract tests run against the **harness** registry, not the production registry (a swap is required — see build plan).
- **No `AiTaskRun` telemetry**, **no 401/auth-path test**, **no OpenAI strict `json_schema`** (text-parse today).
- Sandbox prompts are a **manual copy** of live constants → drift risk; **no fidelity test** vs the live source.

## Where to look for X

- Failover + precedence rules → `aiTaskRunner.js` (`resolveOrder`/`resolveModels` + the provider loop).
- The provider seam (the only provider-specific code) → `aiProviders.js`.
- Real prompts/schemas/caches → `aiSandbox/` (the dictionary indexes them to live source).
- The I/O contract (what's verified) → `tests/ai-bus/busContract.test.js` + `sandboxHarness.js`.
- Transport cost + flow → `AI_BUS_DELIVERY.md`.

## Suggested review focus

1. **Failover correctness** — does the runner honor the stated contract (both directions; contract-fail triggers failover; fail-closed shape on exhaustion)?
2. **No leakage** — `describeTask`/catalog/logs never emit prompt bodies or secrets.
3. **Compliance fail-closed** — `sms.classify`/`activity` return `ok:false`+`safeFallback`, never a fabricated answer.
4. **Harness ↔ real-registry parity** — the contract tests pass against the harness; will the production registry build the same shapes? (This is the biggest "tests are green but unproven against prod" risk.)
5. **Sandbox fidelity** — spot-check the copied prompts against live source for drift.
6. **Default-on primitives** — can `ai.*` (enabledDefault:true) cause unintended spend before any task is explicitly enabled?

## Known issues (from the self-audit, run `w748b93yx`, 6 agents → 48 findings)

**Fixed in this pass (suite stays 69/69):**
- Package exports — `createOpenAiClient` now exported from `shared-integrations/index.js`; the bus modules (`createAiTaskRunner`/`createAiProviders`/`createAiPrimitives`/`createAiTaskClient`/`aiTaskRegistry`) now exported from `shared-services/index.js` (were import-by-direct-path only).
- Auth fail-safe — `mountAiTaskRoutes` now **throws** if no `auth` middleware is passed (unless `allowUnauthenticated:true` for local/test). No more silent open routes.
- Honesty — `formatActivities` comment + sandbox README now state it's a **simplified, non-byte-exact** helper (the live `formatActivitiesForPrompt` is canonical); `tasks.js` now states `status` = live-source state and `system:null`+`promptTodo` = **not invoke-ready**; the primitives' `enabledDefault:true` now carries its spend-safety rationale.
- Doc counts corrected to the verified **69**.

**Open — flagged for the reviewer (real, not a cheap fix):**
- **HIGH — nothing is live-verified.** No real OpenAI/Anthropic call has run through the bus; `openaiClient.transcribeAudio/generateImage/synthesizeSpeech` (real HTTP) and the Anthropic `createMessage` path are **untested**. → needs the live both-providers smoke.
- **HIGH — not mounted** on the live 7000 (3-line snippet staged in the build plan).
- **HIGH/MED — auth is dev-OPEN.** `buildInternalAccessMiddleware` allows unauthenticated access when `INTERNAL_SERVICE_SECRET` is unset and `NODE_ENV!=production`. Production **must** set the secret (consider failing boot if missing).
- **HIGH/MED — `ai.*` primitives default-ON.** Defensible (route is internal-auth-gated; calling a verb *is* intent to spend), but a reviewer may prefer `enabledDefault:false`. **Your call.**
- **MED — contract tests run against the HARNESS registry, not the production registry.** This is the biggest "green but unproven against prod" gap — swap `sandboxHarness.sandboxRegistry()` for the real registry and re-run when it's built.
- **MED** — no `AiTaskRun` telemetry (busMs returned but not logged; no test asserts `telemetry.record` fires); no 401/auth-path test (route + client); `err.message` is returned to the (internal) caller — sanitize at wiring if desired; three divergent `formatActivities` impls (live / registry placeholder / sandbox helper) to consolidate at migration.
- **LOW** — `ignoreEnabled` is test-only (don't use in prod); `toCall` exported as a test seam; `describeTask` exposes the `enabled` flag (fine while auth-gated); `resolution.pitch` fence parsing is tested in the resolution suite, not the bus suite.

**Audit errors worth knowing (calibrate trust in the auditor too):**
- The audit reported "51 tests" — **wrong; it's 69.** It statically counted `test(` literals and missed the `for…of` loop-generated tests in `busContract`/`apiLocal`. *Run the suite; don't trust a static count.*
- It flagged the dictionary's blogger model `claude-sonnet-4-5-20250929` as nonexistent — but that **is** what `blogger-claude-writer.js` uses (scoring uses the undated `claude-sonnet-4-5`). No fix needed.
