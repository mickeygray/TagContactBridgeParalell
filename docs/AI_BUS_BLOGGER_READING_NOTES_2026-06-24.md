# Reading Notes — AI Bus + Blogger changes (2026-06-24)

> For the person doing a **simplification pass**. This orients you through the code changed this
> session, names the **contracts/invariants you must preserve**, and flags what is **genuinely
> redundant (fair game)** vs **intentional-but-pending** (leave alone — there's a planned follow-up).
> Tests: `tests/ai-bus/*.test.js` (103) + `tests/blogger/blogger-current-event-bus.test.js` (9) +
> `tests/livecoach-translator/*.test.js` (8). Run them after any change; they are the safety net.

## The two threads changed this session

1. **Blogger → AI bus migration** — the current-event blogger stopped calling the Anthropic SDK
   directly and now runs through the bus runner as a task.
2. **Registry hardening** — collapsed three copies of the schema validator to one, and added
   boot-time invariants to the bus registry.

Nothing here changes live behavior on production traffic: the named bus tasks are **default-off**,
and the blogger change preserves its existing caller contract exactly.

---

## Background you need first (read this before the diffs)

The AI bus is a **provider-neutral task runner**. A *task* declares `{ kind, providerOrder, models,
contract, buildRequest, failClosed }` and never names a provider in its logic. The runner
(`aiTaskRunner.js`) walks the provider order, calls `adapter.run(kind, request, {model})`, validates
the output against the task's `contract`, fails over to the next provider on error/timeout/bad-shape,
and returns a fail-closed shape if all fail. Two adapters exist today: `anthropic` and `openai`
(`aiProviders.js`), both metered-API.

**The golden rule for simplification:** a task must stay provider-neutral, the runner must stay
single-shot per provider attempt (it loops over providers/models, not over tool-turns), and a
malformed answer must never ship (it fails over, then fails closed). Don't collapse anything that
breaks those three.

---

## Reading order (fastest path to understanding)

1. `packages/shared-services/src/aiTaskRunner.js` — the spine. Read `runAiTask` once. Note it now
   **exports `validateAgainstSchema`** (the one canonical validator).
2. `packages/shared-services/src/aiProviders.js` — the adapters. Read `createAnthropicAdapter`, then
   the new `search` kind (`SEARCH_KINDS`, `runAnthropicSearch`).
3. `packages/shared-services/src/aiTaskRegistry.js` — find `blogger.currentEvent` + `validateBlogDraft`.
4. `scripts/blogger-current-event.js` — `generateCurrentEventBlog` (the consumer).
5. `packages/shared-services/src/aiBusRegistry.js` — `buildBusRegistry` + `assertBusRegistryIntegrity`.

---

## File-by-file: what it does, what to preserve, what's fair game

### `aiProviders.js` — the `search` kind (NEW)

- **What:** `search` is an **agentic web_search loop** that runs *inside* `adapter.run` and returns
  the final `submit` tool's input as `{ json }`. It exists so the runner can stay single-shot — the
  multi-turn loop is hidden in the adapter, not leaked into the runner. Only Anthropic supports it
  (`supports("search")` is false on OpenAI); only the blogger uses it today.
- **Preserve (load-bearing):**
  - `runAnthropicSearch` calls `client.createMessage` with **`toolChoice: false`** — that means
    *omit `tool_choice` entirely*, which the proven blogger loop requires (forcing a tool every turn
    breaks Anthropic's server-side web_search). Do **not** "simplify" `toolChoice: false` to a falsy
    default — see the anthropicClient note below.
  - The loop has a **total-deadline + per-request 45s cap** and a **max-turns** bound. Both are
    intentional (mirrors the original `BLOGGER_CURRENT_EVENT_TIMEOUT_MS` semantics). Don't drop them.
  - Error classification: it throws with `.retryable`/`.unsupported` set so the runner fails over
    correctly. Keep those flags.
  - It must return the same normalized shape as the other adapters: `{ json, model, usage,
    provider:"anthropic" }`.
- **Fair game:** the loop is verbose; you can tidy structure as long as the four behaviors above hold.
  `SEARCH_KINDS` is a one-element Set — fine to keep as a Set for symmetry with `REASONING_KINDS`.

### `anthropicClient.js` — the `toolChoice` omit (1-line behavior change)

- **What:** `createMessage` now treats **`toolChoice === false` as "omit `tool_choice`"** (previously
  it always defaulted to `{type:"any"}` when tools were present).
- **Preserve:** this is the only thing letting the `search` loop omit tool_choice. Existing callers
  pass `undefined` (→ default `{type:"any"}`) or a real object — both unchanged. **Don't** rewrite the
  `if (toolChoice !== false)` guard; it's load-bearing for the blogger.

### `aiTaskRegistry.js` — `blogger.currentEvent` + `validateBlogDraft` (NEW)

- **What:** the blogger task descriptor (`kind:"search"`, `providerOrder:["anthropic"]`,
  `models:{anthropic:["claude-sonnet-4-6"]}`, `contract:"blogDraft"`, `failClosed:null`,
  `enabledDefault:true`) and its contract validator.
- **Preserve:**
  - `providerOrder:["anthropic"]` is **single-provider on purpose** — OpenAI can't do server-side
    web_search. (When the `agent` provider lands it becomes `["agent","anthropic"]`.) Don't add
    `openai`; it would fail `supports("search")` and is a dead entry.
  - `temperature: 1` in `buildRequest` is **deliberate** — the bus client defaults temperature to 0,
    but blog writing needs the model default (1). Don't delete it.
  - `failClosed:null` + `enabledDefault:true` are both intentional (caller throws on `!ok`; the
    daily-runner invoking it is the intent to run). The boot assertion now requires `failClosed` to be
    *present* (even null) — keep the key.
- **Fair game:** none of this is redundant; it's the minimal descriptor.

### `scripts/blogger-current-event.js` — `generateCurrentEventBlog` (REWIRED)

- **What:** was a direct `@anthropic-ai/sdk` web_search loop; now builds a lazy **in-process runner**
  (Anthropic-only) and calls `runAiTask("blogger.currentEvent", payload, {label})`, then maps the
  result to the canonical draft.
- **Preserve (caller contract — a downstream consumer depends on it):**
  - On `!res.ok` it **throws** — `blogger-daily-runner.js:259` catches that and falls back to a static
    draft. If you change this to return null/empty, the fallback never fires. Keep the throw.
  - The returned **draft shape** (`{id, title, teaser, contentTitle, contentBody[], category, slide,
    sourceNotes, sourcesUsed, generatedBy, generatedAt}`) is consumed by the daily-runner / publish
    path. Keep every field.
  - The `<5 blocks` guard on `splitBodyIntoBlocks` is a real quality gate. Keep it.
  - `options.runner` injection is the test seam (the 9 tests pass a fake runner). Keep it.
  - It's an **in-process runner**, not the 7000 HTTP bus — on purpose (a script, latency-tolerant,
    90s web_search). Don't "simplify" it to an HTTP call to 7000.
- **Fair game:** `splitBodyIntoBlocks`, `buildSystemPrompt`, `buildUserPrompt`, `SUBMIT_TOOL`,
  `ALLOWED_DOMAINS`, `WEB_SEARCH_TOOL` are plain content/helpers — readable as-is.
- **Note the still-existing dup:** `scripts/blogger-claude-writer.js` is a **separate** hand-rolled
  Anthropic tool-forced-JSON writer (the *other* blogger path, not migrated). It duplicates
  `splitBodyIntoBlocks` and the tool-forcing logic. That **is** a legit consolidation target, but it's
  out of this session's scope — flag it, don't silently fold it in.

### `aiTaskRunner.js` / `aiBusRegistry.js` / `tests/ai-bus/sandboxHarness.js` — one validator (CONSOLIDATED)

- **What:** there were **three** copies of `validateAgainstSchema` (runner = strict; bus = weak;
  harness = weak). Now there is **one** (the runner's strict one), exported from the runner and
  imported by the bus and the harness.
- **Preserve:** keep it as a single source. The strict version (rejects arrays-as-objects, handles
  null/string/multi-type) is the correct one — do not reintroduce a local "lighter" copy anywhere.
- **Fair game / still-duplicated:** `aiBusRegistry.toRegistryTask` and
  `sandboxHarness.toRegistryTask` are **still parallel copies** (only the validator was unified). That
  duplication is a real simplification target — unify `toRegistryTask` next (have the harness import
  the bus's). The memory note for this is "aiBusRegistry conversion DUPLICATES sandboxHarness — unify
  next." Safe to do; the 103 tests will catch a divergence.

### `aiBusRegistry.js` — `assertBusRegistryIntegrity` (NEW)

- **What:** boot-time invariants that **throw at registry build**: no id collision between sandbox and
  primitives, every task declares a `failClosed` policy (even `null`), every `contract` resolves to a
  real validator, every provider in a `providerOrder` has a non-empty model ladder (the "dead ladder"
  bug guard).
- **Preserve:** these are intentional fail-loud guards. If a simplification trips one (e.g. removes a
  task's `failClosed` key, or leaves a provider with an empty ladder), **boot breaks on purpose** —
  that's the assertion doing its job, not a bug to delete. Fix the task, don't weaken the assertion.

---

## Invariants a simplification pass must NOT break

1. Tasks stay provider-neutral; the runner stays single-shot per provider attempt; a malformed answer
   fails over then fails closed.
2. **One** `validateAgainstSchema` (don't re-fork it).
3. `anthropicClient` `toolChoice:false` = omit (the search loop needs it).
4. The blogger's caller contract: **throw on failure**, return the full canonical draft shape, in-
   process runner, single-provider `["anthropic"]`.
5. The boot assertions stay strict (fix the data, not the guard).
6. Side-effect boundary: **no adapter publishes/sends/writes** — generation is pure, the side effect
   (blog publish) happens downstream in the caller. Keep it that way.

## Intentional-but-pending (don't "simplify" these away — they have a planned follow-up)

- **Two task sources** (`aiTaskRegistry` named tasks are currently dead config; the live bus builds
  named tasks from `aiSandbox`). This split is a *known* issue with a planned **catalog-combination**
  (see `docs/UNIFIED_AGENT_BRAIN_PLAN_2026-06-24.md` §9A). Do **not** delete `aiTaskRegistry`'s named
  tasks blindly, and do **not** delete the sandbox — the combination decides ownership. (My
  `blogger.currentEvent` lives in `aiTaskRegistry` because the blogger uses an in-process runner whose
  default registry is `aiTaskRegistry`; that's correct, not a mistake.)
- **`callGrade` vs `callGrader` id drift** between the two sources — a real bug, but fix it as part of
  the catalog combination, not as a one-off rename (the rename target depends on which source becomes
  canonical).

## Verified vs unverified

- **Verified offline (unit tests):** the blogger wiring, the `search` loop control, the contract +
  result mapping, the `toolChoice` omit, the registry boot assertions, the single validator. 103 + 9
  + 8 tests green.
- **NOT verified in this environment (needs one real run on a box with `ANTHROPIC_API_KEY`):** the
  live Anthropic `web_search` call through the bus, and that `claude-sonnet-4-6` supports the
  `web_search_20250305` tool. The offline tests prove the wiring, not the live search.
