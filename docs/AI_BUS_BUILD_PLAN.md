# AI Bus Build Plan — the instruction list

Follow **this**, not memory. Check boxes as you complete steps; each step names files + a done criterion. When you resume, re-read this file and the two references before doing anything.

**References**
- `packages/shared-services/src/aiSandbox/` — **the build surface.** Real prompts (verbatim + cp'd .md), schemas, cache policy, rules, and assembled per-task descriptors, copied into one place so the bus is built around real material (not re-derived). `require(".../aiSandbox").getSandboxTask(id)`. Drift-managed copy; dictionary is the source-of-truth index.
- `docs/AI_TASK_DICTIONARY.md` — every task's prompt-ref + schema + cache + model (the migration lookup).
- `docs/AI_SPEND_UNIFICATION_PLAN.md` — the design + 6-phase migration spec.
- Memory: `project_ai_bus_unification`.

> Migration shortcut: each named-task wiring = take `getSandboxTask(id)` → freeze its `system`/`schema`/`cache`/`plumbing` into the registry task → point the service at `runAiTask(id, …)`. The sandbox already holds the material; no re-fetching from live services.

## Current state (2026-06-17)

Built + tested (**24 tests** green via `node --test tests/ai-bus/aiTaskRunner.test.js tests/ai-bus/aiPrimitives.test.js`), **UNWIRED** (nothing on 7000 calls it yet), all uncommitted:
- `packages/shared-integrations/src/openaiClient.js` — shared OpenAI client (Responses + transcribe + image + tts).
- `packages/shared-services/src/aiProviders.js` — dual-provider capability adapters (the only place a provider name lives).
- `packages/shared-services/src/aiTaskRegistry.js` — task table + `ai.*` primitive tasks + validators + `assertRegistryIntegrity` + `describeTask`.
- `packages/shared-services/src/aiTaskRunner.js` — `createAiTaskRunner` → `runAiTask` (bidirectional failover, kind/provider/model overrides, cache threading, fail-closed, telemetry hook).
- `packages/shared-services/src/aiPrimitives.js` — verbs `aiRead/aiWrite/aiJudge/aiScore/aiTranscribe/aiImage/aiSpeak` (+ aliases). Invocation `verb({ schema, prompt, model })`.

Invocation model: **schema** = plumbing descriptor (`output`, `cache`, `family`/`label`, `validate`, `next`*, `providerRules`*) — *=carried-not-executed. **prompt** = fed. **model**/`platform`/`pin` = used.

**Verification layer (the spec) — built; PULL it, don't re-write it. 60 ai-bus tests green:**
- `tests/ai-bus/sandboxHarness.js` — converts sandbox descriptors → runnable registry tasks + a schema-derived validator + spy providers (local, no network). *This conversion is what the real registry will do; the tests are the spec.*
- `tests/ai-bus/busContract.test.js` — per-task I/O: shape IN (request carries the real prompt+schema+cache+model) + shape OUT (valid→envelope, contract-invalid→failover, total-fail→fail-closed) for the 8 core tasks + modality + unknown.
- `tests/ai-bus/apiLocal.test.js` — the route contract over real HTTP (Node http): `POST /api/ai/tasks/:id/run` envelope, fail-closed over the wire, `forceProvider` routing, `GET /api/ai/tasks` catalog with no prompt leakage.
- Plus `aiTaskRunner` (28), `aiPrimitives` (10), `aiSandbox` (6).

⚠️ The contract tests currently run against the **harness's** sandbox→registry conversion (the real registry isn't wired yet). When Stage 1/Stage 5 build the real sandbox-backed registry, **swap `sandboxHarness.sandboxRegistry()` for the real registry and re-run** — the same assertions then verify the production thing. Keep the harness and the real registry in lockstep.

## Guardrails (apply to EVERY step)

- Box is READ-ONLY. Port **7000 (ai-bus) is restartable during floor hours**; **6001/4001 are NOT** — never restart those during the floor. Local-verify before any 7000 restart.
- Every change **additive + default-OFF**. Existing routes/behavior stay byte-identical until a task's env flag is explicitly flipped on.
- Run the FULL suite after each change (the `node --test tests/ai-bus/` directory form FAILS on this Node — pass all 7 files): `node --test tests/ai-bus/aiTaskRunner.test.js tests/ai-bus/aiPrimitives.test.js tests/ai-bus/aiSandbox.test.js tests/ai-bus/busContract.test.js tests/ai-bus/apiLocal.test.js tests/ai-bus/aiTaskClient.test.js tests/ai-bus/busWiring.test.js` → 69 pass.
- **Compliance tasks** (`sms.classify`) must fail-closed to `needs_human`; never auto-act on a failed-over/downgraded result unless the contract validator passed.
- **Live both-providers smoke** (force each provider) before trusting any migrated task. Compare to the legacy path; flip the env on only after parity.
- Auth: bus routes sit behind `requireInternalAccess` (header `x-service-secret`/`x-internal-secret` vs `INTERNAL_SERVICE_SECRET`).

## Stage 0 — Close the code-review findings ✅ DONE

9-angle review (run `w5vds3xag`: 86 agents → 49 candidates → 15 surfaced). Suite now **28 green** (24 + 4 regressions).

Fixed (3 real):
- [x] **#5 undefined adapter result** (`aiTaskRunner`) — an adapter returning no `json`/`text`/`audio` now triggers failover (`empty_result`) and never ships `ok:true, result:undefined`.
- [x] **#3 skip-reason conflation** (`aiTaskRunner`) — `provider-not-configured` vs `unsupported-kind:<kind>` now distinct in `attempts`.
- [x] **#4 empty provider order** (`aiTaskRunner`) — fails closed with code `no_providers_configured`.
- [x] **#2/#6 cleanup** (`aiProviders`) — `res.json ?? {}` (nullish); removed dead `request.promptCacheKey` read.

Deferred / by-design (NOT bugs — recorded so they aren't re-flagged):
- **#13** `activityAiReview` hardcodes Anthropic → that IS Stage 3.2 (un-migrated).
- **caching off for named tasks** → expected until Stage 5.1 cache backfill.
- **#1** `openaiClient` throws on 5xx/429 → intentional: fail fast to the OTHER provider beats churning same-provider models; mirrors `anthropicClient`.
- **#8/#9** timeout falsy-zero → moot (`Math.max(…,1000)` floors it). **#7** env=0 → 0 isn't a valid max-tokens.
- **#11** 3× `record()` duplication, **#10** model-ladder naming, **#12** modality env-per-call → low cleanup, optional.
- **#14 (caller contract):** `sms.classify` fail-closed is `{tier:needs_human, confidence:0, viaFailClosed:true}` returned as `safeFallback` on `ok:false`. Callers MUST branch on `ok:false`/`safeFallback` — never read `result.confidence` on a failed call. **Enforce at Stage 4.**
- **#15 (caller contract):** `liveCoach.callGrade` has `failClosed:null` (correct — no fake grade). The coach caller MUST handle `ok:false` by skipping the grade. **Enforce at the callGrade migration.**

## Stage 1 — Wire the bus onto 7000 (make it callable)

**Plumbing BUILT + tested (69 ai-bus tests green — current verified total; per-stage counts earlier in this doc are historical):** `packages/shared-services/src/aiTaskClient.js` (the sender — loopback POST + `x-service-secret` + timeout + fail-closed + timing), `apps/ai-bus/src/aiTaskRoutes.js` (route handlers, stamp `busMs`), and the production wiring proven by `tests/ai-bus/busWiring.test.js` (real clients → providers → runner → real registry → route serve a `dryRun`). **Transport measured** — `docs/AI_BUS_DELIVERY.md` + `scripts/ai-bus-transport-bench.js`: ~0.3ms/call on loopback, negligible vs model time. Remaining = the 3-line mount, applied + **boot-tested ON THE BOX** (live-floor file — don't edit blind here):

```js
// server.js, near the other /api/ai routes, after requireInternalAccess exists:
const { createOpenAiClient } = require("../../../packages/shared-integrations/src/openaiClient");
const aiTaskRegistry = require("../../../packages/shared-services/src/aiTaskRegistry");
const { createAiProviders } = require("../../../packages/shared-services/src/aiProviders");
const { createAiTaskRunner } = require("../../../packages/shared-services/src/aiTaskRunner");
const { mountAiTaskRoutes } = require("./aiTaskRoutes");
const aiBusRunner = createAiTaskRunner({
  providers: createAiProviders({ anthropic: createAnthropicClient(), openai: createOpenAiClient() }),
  registry: aiTaskRegistry, telemetry: null, // AiTaskRun recorder = Stage 2
});
mountAiTaskRoutes(app, { runner: aiBusRunner, registry: aiTaskRegistry, auth: requireInternalAccess });
```

- [x] 1.1 (built) runner-singleton + route wiring — proven by `busWiring.test.js`; apply the snippet above + boot-test on the box.
- [ ] 1.2 Mount `GET /api/ai/tasks` → `registry.listTasks().map(t => describeTask(t, process.env))` and `GET /api/ai/tasks/:taskId` → `describeTask(getTask(id))`. Behind `requireInternalAccess`. **Assert no prompt bodies / secrets leak** (describeTask already trims).
- [ ] 1.3 Mount `POST /api/ai/tasks/:taskId/run` — body `{ payload, options }` → `aiTaskRunner.runAiTask(taskId, payload, options)`. Return the envelope verbatim. Behind `requireInternalAccess`.
- [ ] 1.4 (optional) `POST /api/ai/primitives/:verb` thin wrapper over `createAiPrimitives({ runner })`.
- [ ] 1.5 Local smoke: boot 7000 locally, `curl /api/ai/tasks`, `runAiTask` a primitive with `{dryRun:true}`. **Do not restart the floor 7000 until local-verified.**
- [ ] Done when: `/api/ai/tasks` lists every task and a `dryRun` run returns the resolved request, locally.

## Stage 2 — App-side client + spend telemetry

- [ ] 2.1 `packages/shared-services/src/aiTaskClient.js` — `runAiTask(taskId, payload, opts)` POSTs to `AI_BUS_BASE_URL` (default `http://127.0.0.1:7000`) with `x-service-secret`; upstream timeout SHORTER than the caller's route timeout; returns `result` or `safeFallback`. Add `useAi(tier, taskId, payload)` convenience.
- [ ] 2.2 `packages/shared-models/src/AiTaskRun.js` — `{ taskId, family, label, caller, domain, caseId, sessionId, provider, model, status, elapsedMs, inputChars, outputChars, usage, errorCode, createdAt }`; TTL or monthly prune; register on the ai-bus mongoose connection.
- [ ] 2.3 Telemetry recorder into the runner singleton (Stage 1.1) that writes `AiTaskRun` **async, never awaited** in the task path (the runner already wraps `telemetry.record` in try/catch).
- [ ] 2.4 `GET /api/ai/spend/today` — rollup by `family` and `label`.
- [ ] Done when: a run writes an `AiTaskRun` row and `/api/ai/spend/today` returns per-family totals.

## Stage 3 — First migration: `activity.contactSafetyReview` (safest)

Chosen because: batch, bounded, JSON-only, strict-ready, no cache.
- [ ] 3.1 Confirm the named task schema vs `docs/AI_TASK_DICTIONARY.md` (already inlined in the registry).
- [ ] 3.2 In `packages/shared-services/src/activityAiReviewService.js`, behind `AI_TASK_ACTIVITY_CONTACTSAFETYREVIEW_ENABLED` (default off): swap the direct `createAnthropicClient` call for `aiTaskClient.runAiTask("activity.contactSafetyReview", { domain, caseId, activities })`; keep the existing result normalization.
- [ ] 3.3 Contract tests: valid JSON, timeout fallback, disabled fallback, malformed→failover→fail-closed, cross-provider parity.
- [ ] 3.4 LIVE both-providers smoke on a real case; compare to legacy; flip env on only after parity.
- [ ] Done when: the env-on path matches legacy output on a real case for BOTH providers.

## Stage 4 — `sms.classify` (compliance-critical)

- [ ] 4.1 Re-house the 475-line system prompt + `classify_sms` tool schema (full enum set in the dictionary) into the named task.
- [ ] 4.2 Keep the regex fast-paths LOCAL in `smsClassifierService.js` (they prevent model calls + protect DNC/STOP). Only the LLM branch goes through `runAiTask`.
- [ ] 4.3 DNC contract tests: every `tier` enum, fail-closed to `needs_human` on any failure/invalid, both providers.
- [ ] 4.4 LIVE smoke; flip env on only after DNC parity proven.
- [ ] Done when: DNC/STOP handling is provably identical to legacy on a fixture battery + a live smoke.

## Stage 5 — Cache + strict-schema hardening

- [ ] 5.1 Backfill `cache` config into the on-bus named tasks from the dictionary cache map (anthropic-ephemeral: callStrategy, dialogComposer [per-model], resolution.pitch, trainer.liveTurn, trainer.playbook; openai prompt_cache_key: rollingDigest, contextJudge, callGrader).
- [ ] 5.2 Add OpenAI native strict `json_schema` structured output to `openaiClient.createResponse` — **verify the Responses `text.format` field shape against the live API first**; then convert contextJudge/callGrader/rollingDigest schemas to the strict subset (all fields required-or-nullable, `additionalProperties:false`, char caps → prompt).
- [ ] 5.3 Verify caching warms live (`cache_read` tokens > 0) before trusting savings.
- [ ] Done when: a cached task shows cache-read hits live, and the strict-schema tasks validate on both providers.

## Stage 6 — Remaining migrations (low-risk first, per dictionary)

- [ ] 6.1 `transcriptionScoring.transcribe` (aiTranscribe) + `.score` (aiScore).
- [ ] 6.2 `blogger.write` / `blogger.image` / `blogger.failureRecovery` (batch).
- [ ] 6.3 `misc.caseNotesSummary`.
- [ ] 6.4 Sales-trainer surfaces (respond/transcribe/tts/profile/playbook/narration) — LAST; most model knobs. Keep control-plane routes + frontend stable; route internally to `runAiTask`.
- [ ] 6.5 `resolution.pitch` — route via `runAiTask("resolution.pitch")` as `compose`; keep the verdict-fence parse caller-side.

## Deferred (do NOT do in the first pass)

- **Agentic `tool-loop` kind** for `blogger.currentEvent` (`web_search` ≤8-turn loop) — needs a new kind.
- **`next` pipeline execution** + **`providerRules`** (thinking/effort) wiring — orchestrator phase.
- **Live-coach floor-hot** `contextJudge`/`dialogComposer` — WRAP for config+telemetry only; do NOT force-migrate (tightly provider-coupled, latency-bound).

## Done criteria (whole effort)

- Every dictionary task is either on-bus via `runAiTask` or explicitly deferred with a reason.
- No direct `createAnthropicClient` / `api.openai.com` fetch in **production services** (scripts may keep theirs until migrated).
- `AiTaskRun` logging live; `/api/ai/spend/today` answers per-family.
- All `tests/ai-bus/*` green; a live both-providers smoke passed per migrated task.
