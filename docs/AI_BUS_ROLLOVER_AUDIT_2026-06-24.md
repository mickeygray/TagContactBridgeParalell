# AI Bus / Provider-Rollover Audit (2026-06-24)

> Lens: **v1 = all-Anthropic via headless Max agents (`claude -p`) by default; metered API
> (Anthropic + OpenAI) as armed-but-rare rollover; continuity across ALL services on rollover.**
> Method: 6 finder dimensions over the machinery, **every finding adversarially verified against the
> code** (Sonnet verifiers). 35 findings, 33 confirmed, 1 plausible, 1 refuted — 5 critical, 16 high.
> Full output: `tasks/wm4f68etz.output`. The bus code itself (`aiProviders`/`aiTaskRunner`) is *good*;
> the problem is what does **not** route through it.

## The one-paragraph reality check

The substrate the unified-brain plan assumes is **partly aspirational in the code.** The agent
(`claude -p`) substrate — the stated v1 default — **is not built**: the bus knows only `anthropic`
and `openai`, both metered-API. The blogger and every live-coach service **bypass the bus** with
hand-rolled single-provider `fetch` calls that have **no failover at all**. And there are **two task
registries that have already drifted** (the one you'd edit is the dead one). So "agent-first v1 with
API-rollover continuity" is not a wiring job — it's: **(1) build the agent provider, (2) actually
route every service through the runner, (3) collapse to one registry + one validator, (4) thread
idempotency + telemetry.** That *is* the v1 substrate build.

---

## Theme 1 — The agent substrate is unbuilt (CRITICAL)

| # | Finding | File:line | Fix |
|---|---|---|---|
| 1.1 | **Max agent is not a bus provider.** `createAiProviders({anthropic, openai})` has exactly two branches, no `agent`. Every call site injects only `{anthropic, openai}`. The runner's failover walk can never resolve an `agent` step. | `aiProviders.js:164-169`; wired `server.js:3575` | Add `createAgentAdapter` implementing the same `{id, supports, run}→{text\|json, model, usage, provider:'agent'}` contract by shelling `claude -p --output-format json` with the task schema; register under `agent`; head of `providerOrder` for reasoning kinds. |
| 1.2 | **No `claude -p` anywhere in the repo.** Blogger uses `@anthropic-ai/sdk` + hard-required `ANTHROPIC_API_KEY`, pins `SONNET_MODEL`, no provider switch. Repo-wide grep for `claude -p`/`--output-format`/`BLOG_CURRENT_EVENT_PROVIDER` = 0 active hits. | `scripts/blogger-current-event.js:12,176-231` | Treat the agent substrate as **NOT-YET-BUILT**; the shipped default is the metered API. (Correct the "PROVEN+WIRED" memory.) |
| 1.3 | **No central substrate lever.** No `AI_DEFAULT_SUBSTRATE=agent\|api`; substrate is per-script env, which the bus never sees. | `aiTaskRunner.js:120-131`; `server.js:3575` | One global env honored by `resolveOrder`, so "all-agent default" and "API rollover" are one switch. |

## Theme 2 — The bus is unadopted; services bypass the runner (CRITICAL)

| # | Finding | File:line | Fix |
|---|---|---|---|
| 2.1 | **Every live-coach service does raw single-provider `fetch` with NO failover.** Grader→OpenAI, composer/strategist/pitch→Anthropic, each `throw` on error. The failover-capable `aiBusRunner` is built at `server.js:3574` but mounted only on the default-OFF `/api/ai/tasks/:id/run`. | `server.js:341-1189` (six factories); runner `:3574` | Route each through `runAiTask` via its task id, so a provider failure rolls over with the same context, contract validation, fail-closed shape, and telemetry. |
| 2.2 | **Blogger calls the metered Anthropic SDK directly** — the highest-spend reasoning task runs outside the bus with no failover and invisible to telemetry. | `blogger-current-event.js:175-231`; `blogger-daily-runner.js:265` | Route blog gen through the bus as a `compose`/`json+web_search` task. |
| 2.3 | **SMS classifier calls Anthropic directly, one attempt, `needs_human` on fail** — a `sms.classify` descriptor exists but the live service ignores it. | `smsClassifierService.js:17,594-616` | Route through the runner via `sms.classify` (keep regex fast-paths local). |
| 2.4 | **Live grader is OpenAI-`gpt-5.4`-only — nothing to roll over to.** Single `callGrader(payload)`, no Anthropic peer; on OpenAI outage grading just fails. | `server.js:634-752,3432`; `liveCoachCloseoutService.js:719-736` | Inject an Anthropic grader / route through the bus task; **set default to Sonnet** per the validated map (the lenient-grader defect). |

## Theme 3 — Two registries, already drifted (CRITICAL)

| # | Finding | File:line | Fix |
|---|---|---|---|
| 3.1 | **`buildBusRegistry` pulls only `family:"primitive"` from `aiTaskRegistry`** and rebuilds every *named* task from `aiSandbox`. So the named tasks in `aiTaskRegistry` (sms.classify, liveCoach.callGrade, resolution.pitch, translate, activity review) are **dead config** — editing their model ladders is a no-op on the floor. | `aiBusRegistry.js:151-160`; `aiTaskRegistry.js:108-241` | Pick ONE source of named tasks. Delete the dead named TASKS from `aiTaskRegistry` (keep primitives + validators) OR have the bus derive from it. Add a boot assert that ids match. |
| 3.2 | **Task-ID drift: `liveCoach.callGrade` (registry) vs `liveCoach.callGrader` (sandbox)** — differ by a trailing `r`, same job; env pins target the wrong/absent task. | `aiTaskRegistry.js:166` vs `aiSandbox/tasks.js:42`, `rules.js:47` | Canonicalize one id; rename the other; boot-assert. |
| 3.3 | **Two `validateAgainstSchema` of different strictness; the live bus uses the WEAKER one** (passes arrays as objects, only checks number/boolean). | `aiBusRegistry.js:26-39` vs `aiTaskRunner.js:55-83` | Export the runner's stricter validator; have the bus import it. One validator = identical contract enforcement on every rollover hop. |

## Theme 4 — Continuity invariants unmet even where failover exists (HIGH)

| # | Finding | File:line | Fix |
|---|---|---|---|
| 4.1 | **No idempotency key across rollover.** The loop re-issues `adapter.run` on the next provider with the same `request`, no dedupe. Read tasks = double-charge; side-effecting (blog publish, future agent that writes) = double-post. | `aiTaskRunner.js:207-231` | Thread `options.idempotencyKey`; agent adapter treats completed-but-unreturned as non-retryable; keep side effects (publish) in the keyed caller, not in `adapter.run`. |
| 4.2 | **Split-brain telemetry.** Runner emits one `ai_task.run` row; the live single-provider services log bespoke shapes with no `label`/`taskId`. The spend governor sees almost none of the real spend. | `server.js:3569-3573` vs `:724/:597/:406` | Drop bespoke logs; emit the runner's `{label,taskId,provider,model,usage}` row (agent adapter must return a `usage` estimate). |
| 4.3 | **Temperature default diverges.** Omitted temperature → `0` on Anthropic, model-default on OpenAI. A `json`/`classify` rollover silently changes determinism. | `anthropicClient.js:90-91` vs `openaiClient.js:136` | Resolve temperature once in the neutral request so both adapters get the same explicit value. |
| 4.4 | **Grader result-envelope mismatch.** Live grader returns `{grade}`; the bus task returns `{result}`, enforces a one-field contract, and its `buildRequest` doesn't carry the static prompt. A rollover to the bus task would drop the prompt + change the shape. | `aiTaskRegistry.js:166-186`; `server.js:732-738` | Inline the static prompt + full schema into the task `buildRequest`; have the closeout adapter read `result`. |
| 4.5 | **Client fail-over conditions are asymmetric** (the two clients fail over on different non-JSON conditions). | `anthropicClient.js` / `openaiClient.js` | Normalize the retryable/unsupported classification across both clients. |

## Theme 5 — Config stale vs the validated model map (HIGH/MEDIUM)

| # | Finding | File:line | Fix |
|---|---|---|---|
| 5.1 | **Grader ladder is OpenAI-`gpt-5.4`-first**, Claude only as failover, no agent — even when the bus owns grading it can't run on Claude/agent. Validated map: **grader = Sonnet** (cheap/lenient graders confabulate). | `aiSandbox/rules.js:47`; `aiTaskRegistry.js:170-171`; `liveCoachModelPolicy.js:34` (COACH_ALLOW openai-only) | Flip to Anthropic-Sonnet-first; align the policy gate to allow Claude; add `agent` to the order once 1.1 lands. |
| 5.2 | **SMS classifier pinned to stale `claude-opus-4-6`** (vs opus-4-8 elsewhere); validated map says **SMS = Haiku**. | `smsClassifierService.js:17` | Refresh id; align to the validated map. |
| 5.3 | **Blogger pins a dated Sonnet snapshot** `claude-sonnet-4-5-20250929`, diverging from the registry `claude-sonnet-4-6`. | `blogger-current-event.js:14`, `blogger-claude-writer.js:17` | Fold blogger into the bus; keep model ids only in the registry ladders. |
| 5.4 | **Duplicate hand-rolled Anthropic tool-forcing + `splitBodyIntoBlocks`** across blogger files, already diverged from the adapter (adapter sets `.retryable`; blogger throws hard). | `blogger-claude-writer.js:110-138`, `blogger-current-event.js:162,244-259` vs `aiProviders.js:76-102` | Consolidate onto the bus `json` path; extract `splitBodyIntoBlocks` to one module. |

## The unification (resolves most of the above) = the v1 substrate build

1. **Build the `agent` adapter** in `aiProviders` (Theme 1.1) — `claude -p` behind the existing
   `{supports, run}` contract, returning the same normalized shape + `usage` + error classification.
2. **One registry, one validator** (Theme 3) — collapse `aiTaskRegistry` named tasks vs `aiSandbox`;
   import the stricter validator everywhere; boot-assert id/contract parity.
3. **Route every service through `runAiTask`** (Theme 2) — grader, composer, digest, judge,
   strategist, pitch, blogger, SMS. This is where continuity actually gets enforced.
4. **Thread idempotency + one telemetry row** (Theme 4.1-4.2) before any side-effecting task is on
   the agent.
5. **Set `providerOrder: ["agent","anthropic","openai"]` + a global `AI_DEFAULT_SUBSTRATE` lever**
   and load the validated model map into the one registry (Theme 5).

Then "all-Anthropic-Max default" and "API rollover with continuity" are the **same** code path — the
runner — and continuity is *by construction*, because the rollover is one mechanism, not N.
