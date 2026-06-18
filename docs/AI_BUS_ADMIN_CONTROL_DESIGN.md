# AI Bus — Runtime Admin Control (per-component model / provider / prompt-mode)

Status: **design, corrected after adversarial review.** Default-off, additive,
floor-safe. Nothing here changes live behavior until an admin creates a policy row.

## Goal

Client-side / admin-surface control of the AI bus, **by component**, with **no
service restart**:

1. Swap the **model** per component at runtime (blogger → Opus instead of Sonnet;
   coach → gpt-5.4 instead of gpt-5.4-mini).
2. Swap the **provider** per component at runtime (Claude ↔ OpenAI) — soft by
   default so failover is preserved; a hard pin is an explicit break-glass.
3. Insert a **prompt mode** in production (verbose / narrow / …) per component.
4. **Throttle per-call cost** (model tier + maxTokens cap) and **guide output**,
   all from the admin surface.

## Decision

- **5001 (control-plane) owns authoring + persistence.** One Mongo singleton doc
  (`AiPolicy`, db `tagcontactbridge_parallel`), modeled on the existing
  `PacingConfig` pattern (singleton, history subdoc, `lastUpdatedBy`).
- **7000 (ai-bus) owns execution.** A thin **async** decorator wraps
  `runAiTask`, reads a hot-reloadable in-memory policy cache, and **merges the
  policy into `options`** — so the *existing* precedence ladder
  (`resolveOrder` / `resolveModels`) consumes it with **zero edits to the ladder
  math**.
- **A change reaches the runner with no forbidden restart:** 5001 writes Mongo +
  POSTs a loopback `invalidate` to the already-running bus; the next call
  re-reads and merges fresh. This is the exact no-restart shape already proven by
  `setComposerTier` (server.js ~1006/3935), which the floor flips mid-day.
- **Modes** are named overlays **declared in code** (reviewed prompt fragments),
  selected at runtime by name; appended after the frozen system prefix so the
  prompt cache stays warm.
- **Prerequisite (DONE):** the registry placeholder-model bug is fixed —
  `toRegistryTask` now resolves real models for both providers, so a soft pin's
  failover actually works. See `tests/ai-bus/registryFailover.test.js`.

## Data model — `AiPolicy` (singleton, owned by 5001)

```
{ singletonKey:'global',
  rev:Number,                       // monotonic; the cache-invalidation + drift token
  components:{ [componentKey]: ComponentPolicy },
  modes:{ [componentKey]:{ [modeName]: ModeOverlay } },
  history:[{at,by,patch}], lastUpdatedBy:{email,name} }

ComponentPolicy = {
  enabled:Boolean,                  // a row with enabled:false is a no-op (per-row default-off)
  provider:'anthropic'|'openai'|null,
  model:String|null,
  hard:Boolean,                     // false=soft (keep failover); true=hard pin (no failover)
  tier:String|null,                 // -> options.qualityMode (cheap/standard/premium)
  maxTokens:Number|null,            // per-call cost ceiling (clamped at the destination)
  mode:String|null }                // active mode name

ModeOverlay = { systemSuffix:String, userSuffix:String|null, maxTokens:Number|null }
```

**componentKey is the stable bus/sandbox task id** (`describeTask().id`), **not**
the free-text `options.label`. *(Review fix — see Hardening #2.)* `options.label`
may act as an *optional narrower sub-key* only when it appears in an enumerated
component registry shipped in Stage 0; an unrecognized key is ignored.

**Declaration lives in code (frozen), not the doc.** Each controllable sandbox
descriptor gains optional blocks copied onto the runnable task by
`toRegistryTask` and surfaced by `describeTask`:

```
overridable:{ provider:{ allow:[...], hardPinAllowed:Boolean },
              model:{ allow:{ anthropic:[realIds], openai:[realIds] } },
              maxTokens:{ min, max }, tier:{ allow:[...] } }
quality:{ cheap:'claude-haiku-4-5', standard:'claude-sonnet-4-6', premium:'claude-opus-4-8' }
modes:{ verbose:{systemSuffix,maxTokens}, narrow:{systemSuffix,maxTokens} }
```

A task with no `overridable` block is **closed** (rendered read-only in the UI).

## Precedence ladder (unchanged math; policy maps onto existing option keys)

Provider order (`resolveOrder`, later assignment wins):
1. registry default `task.providerOrder`
2. env `AI_TASK_<ID>_PROVIDER_ORDER` (csv) replaces the order
3. **admin soft** → `options.preferProvider` (unshift, failover kept)
4. per-call `options.preferProvider`
5. env `AI_TASK_<ID>_PROVIDER` single-pin → collapses to `[envPin]` (ops authority)
6. **admin hard** → `options.forceProvider` → collapses to `[force]` (break-glass)
7. per-call `options.forceProvider`

Model per provider (`resolveModels`, first match wins):
- A. `options.forceModel` → `[forceModel]` (admin hard also sets `forceProvider`)
- B. `options.preferProvider===provider && options.preferModel` → preferred first,
  same provider's ladder behind it; **the other provider keeps its own real
  ladder** (failover preserved — now that the ladder is real)
- C. env `AI_TASK_<ID>_<PROVIDER>_MODEL`
- D. `options.qualityMode` + `task.quality[mode]` prepended (admin **tier**)
- E. registry default `task.models[provider]`

**Default-off:** with no row (or `enabled:false`), `mergePolicy` sets **none** of
those keys → the ladder runs byte-identical to today. **Soft preserves failover**
(order length > 1); **hard is the only path that collapses to one entry**, and
only when the admin explicitly chose it on a `hardPinAllowed` component.

**Env-pin vs admin-hard (product rule — recommended default):** an ops env pin
(`AI_TASK_<ID>_PROVIDER`, used during incidents) should **win** over an admin
choice. Since the ladder currently lets admin-hard (step 6) override the env pin
(step 5), `describeTask`/`effective` will **surface that an env pin is active**
and the UI will require an explicit confirm before a hard pin can override it.
*(Review fix — see Hardening #6.)*

## Prompt-mode overlay

Modes are declared per descriptor (`descriptor.modes`) and selected by the
policy's active mode name. `mergePolicy` (which holds the cached doc) resolves the
overlay and stamps `options.systemSuffix` / `options.userSuffix` /
`options.maxTokensOverride` (clamped). The single net-new wiring:
`aiBusRegistry.js:108` closure becomes `(payload, options) => buildRequestFor(t,
payload, options)`, and `buildRequestFor`:
- appends `options.systemSuffix` **after** the frozen `t.system` prefix (cache-safe);
- appends `options.userSuffix` after the user content;
- applies `options.maxTokensOverride`, **clamped at this destination** to
  `overridable.maxTokens.max`, and **refuses** an override on a task with no
  declared bound (falls back to plumbing default). *(Review fix — Hardening #4.)*

**Scope:** mode overlays apply to **sandbox-backed named tasks only**
(`buildRequestFor`). `ai.*` primitives use the base-registry `buildRequest` and
are **out of mode scope**; a mode set on a primitive label is a no-op (asserted by
test). *(Review fix — Hardening #5.)*

With no active mode, no suffix is stamped → prompt + maxTokens byte-identical.

## Admin API

control-plane (5001), gated `requireAdmin`:
- `GET /api/admin/ai-policy` → `{ policy, components }` where `components` is the
  bus `describeTask` list (proxied) enriched with `overridable` + `modes` + the
  active override (never prompt bodies).
- `PUT /api/admin/ai-policy/:componentKey` → validate+**clamp** to the
  component's `overridable` allow-set, persist (bump `rev`, `$push` history), then
  POST the bus invalidate; return after ack.
- `POST /api/admin/ai-policy/:componentKey/preview` → zero-spend dry run; proxies
  the bus run with `dryRun:true` **and `ignoreEnabled:true`** so a not-yet-enabled
  component still resolves its candidate provider/model. *(Review fix — #7.)*
- `DELETE /api/admin/ai-policy/:componentKey` → revert to default-off + invalidate.

ai-bus (7000), gated **dashboard-or-internal (secret-required)** not the dev
no-op: *(Review fix — #8.)*
- `POST /api/ai/policy/invalidate` → bust the in-memory cache (body carries `rev`).
- `GET /api/ai/policy/effective` → currently-cached policy + `rev` (read-only) for
  the "Live on bus vN vs Mongo vN" drift banner.
- `GET /api/ai/tasks` (existing) → extended to surface `overridable` + `modes` +
  active override + **whether an env pin is currently set**. *(Net-new projection
  work, Stage 1 — not "already returns".)* *(Review fix — #3.)*

## Admin UI

New `ai-control` admin workspace in web-client (3001), **one card per component**,
grouped by family (live-coach / blogger / resolution / sms / activity /
primitives). Each card: provider Select (from `overridable.provider.allow` +
"Registry default"), hard-pin checkbox (disabled when `hardPinAllowed:false`, with
a "turns off failover" warning), model Select (scoped to
`overridable.model.allow[provider]` — only real ids), tier Select (the primary
spend throttle), maxTokens slider (bounded by `overridable.maxTokens`), mode Select
(`Object.keys(descriptor.modes)` with a read-only suffix preview), a **Preview
(dry run)** button, Save, Reset-to-default, and a top "Live on bus vN vs Mongo vN"
drift banner. **Components not on the generic bus** (coach composer/grader/
strategist, resolution pitch, blogger CLI) render **read-only "boot-pinned —
migrate-to-bus pending"** so the surface never claims control it lacks.

## Staged build plan (each stage has a failable check)

- **S0 — declarations + data/service (zero runtime effect).** `overridable` /
  `quality` / `modes` blocks on the ~8 ready descriptors; `toRegistryTask` copies
  them; `describeTask` surfaces them. `AiPolicy` model + repo + service (mirror
  PacingConfig; **async** `getConfig({force})`, ~20-30s TTL, `updateConfig` bumps
  `rev` + busts cache). Enumerated component registry (label→taskId). `providerOf`
  helper. **Check:** `describeTask` exposes the blocks; service bumps rev/busts/
  `$push`es; `providerOf('gpt-5.4')==='openai'`. Nothing reads policy yet.
- **S1 — `mergePolicy` resolver (async, default-off, no surface).** Key on stable
  task id; no row / `enabled:false` → return options unchanged; else clamp to
  `overridable` and map: soft model → `preferProvider+preferModel`; hard model →
  `forceProvider+forceModel` (**never forceModel alone**); tier → `qualityMode`;
  mode → suffixes. **Spread call options LAST (call wins).** **Check:** empty/
  disabled → deep-equal input; soft keeps order length>1 with a real failover
  model; hard collapses to length 1; out-of-allow dropped; `hardPinAllowed:false`
  downgraded to soft; **`mergePolicy` returns a Promise** and the first
  post-invalidate call still resolves the new pin. *(Async — Hardening #1.)*
- **S2 — prompt-mode seam (default-off).** `aiBusRegistry.js:108` closure threads
  `options`; `buildRequestFor` appends suffixes after the frozen prefix and clamps
  maxTokens at the destination. **Check:** no mode → byte-identical; `narrow` →
  `req.system === t.system + '\n\n' + suffix`, maxTokens == narrow cap; mode on a
  primitive label → ignored.
- **S3 — bus cache + async decorator + endpoints (inert).** Wrap the runner:
  `async (taskId,payload,options) => base.runAiTask(taskId, payload, await
  mergePolicy(taskId, options))`. Module-level cache; **cold-load OUTSIDE the
  mount try/catch, fail-open if Mongo down, fail-loud if a doc exists but load
  fails.** Add invalidate + effective (secret-gated). **Check:** empty doc →
  byte-identical dryRun; invalidate→effective shows new rev; restart with a seeded
  doc cold-loads it; Mongo-down boot still mounts `/api/ai/tasks` with empty
  policy. *(Hardening #1, #5-floor.)*
- **S4 — control-plane authoring API.** GET/PUT/DELETE/preview, validate+clamp,
  push invalidate, re-push full policy on 5001 boot **and** on bus-health
  reconnect. **Check:** out-of-allow PUT → 400 no write; legal PUT → bus effective
  reflects within one call; preview → resolved provider/model, **zero** AiTaskRun
  spend; DELETE → dryRun back to default.
- **S5 — web-client UI + honest coverage marking.** **Check (non-floor):** soft-
  swap blogger→Opus in UI → banner revs match, dryRun resolves `claude-opus-4-8`
  with anthropic still present as failover; hard-pin disabled on a
  `hardPinAllowed:false` card; a 3001 rebuild ships the UI, no other restart for
  later edits.
- **S6 — extend coverage (follow-on, the floor-relevant part).** Migrate the
  bespoke direct-call components (`createAnthropicDialogComposer`,
  `createOpenAiCallGrader`, `createOpusCallStrategist`) and resolution.pitch onto
  `runAiTask` so the policy governs them; thread policy into `bloggerEnv()` at
  spawn (next-run, never mid-run). Land the `telemetry.record` spend sink
  (`telemetry:null` today) for a per-component spend readout. **Check:** a runtime
  model swap of the coach grader changes the model on the next grade (dryRun + a
  real telemetry row).

## Test plan (shapes in → resolution out)

Default-off deep-equal; soft model keeps real bidirectional failover; hard pin
collapses + never `forceModel`-alone; soft provider swap injects the real failover
model; allow-set clamp (+ PUT 400); `hardPinAllowed` gate; tier → qualityMode
prepend; mode injection after the frozen prefix (+ maxTokens) and no-mode byte-
identical; per-call force beats admin hard (same ladder rung); ops env pin beats
admin soft; **async** invalidate → next call resolves the new pin; restart cold-
load re-applies; preview of an `enabledDefault:false` task returns the resolved
model (not `disabled`); a mode on a primitive label no-ops.

## Floor-safety

Pure-Mongo writes (no disk) → safe on a read-only box. No process restart for a
policy change (5001 stays up; 7000 cache-flip is the proven `setComposerTier`
shape; 3001 needs no rebuild for an edit). Across the one floor-allowed 7000
restart the bus cold-loads the same 5001-owned doc (`connectMongo` at boot), so
the cache is never the source of truth; TTL + boot/health re-push self-heal a
dropped invalidate; the drift banner makes any lag visible. maxTokens clamps +
declared modes bound spend/output within the descriptor envelope.

## Default-off guarantee (four independent gates)

(1) no doc at rollout; (2) `mergePolicy` returns options unchanged for any
unconfigured/disabled component; (3) closed descriptors (no `overridable`) can
have nothing applied; (4) `buildRequestFor` appends a suffix only when one is
present. Matches the existing posture (named tasks `enabledDefault:false`,
primitives forced off). The model, cache, endpoints, decorator, and closure all
exist but do nothing until an admin creates and enables a row.

## Hardening fixes adopted from adversarial review

1. **Decorator + `mergePolicy` are async** (the mirrored config service does a
   Mongo round-trip on the forced post-invalidate cache miss; a sync merge would
   return a Promise and silently apply nothing on the first post-flip call).
2. **Key on stable task id**, not free-text `options.label` (a family-shared label
   would silently govern sibling calls — an opt-in-scope leak).
3. **`describeTask` extension is net-new** load-bearing work (S0/S1), not existing.
4. **Clamp maxTokens at `buildRequestFor`** (the destination), and refuse an
   override on an unbounded task — not only at authoring time.
5. **Cold-load is fail-open** (Mongo down → mount empty policy = today's behavior,
   never drop `/api/ai/tasks`) and **fail-loud** (doc exists but load failed →
   alarm, don't silently serve pricier registry defaults).
6. **Env pin (ops incident) wins; hard-pin-over-env-pin requires explicit
   confirm** and env-pin-active is surfaced in `describeTask`/`effective`.
7. **Preview passes `ignoreEnabled:true`** so a not-yet-enabled component resolves
   its candidate pin instead of returning `disabled`.
8. **Invalidate/effective endpoints require a secret** (dashboard-or-internal),
   not the dev no-op middleware.
- **Prereq cleared:** registry placeholder-model failover bug fixed + regression-
  tested before any provider/soft-model swap can emit those options.

## Open / sequencing note (the important one)

The components the user named first — **the live coach and the blogger** — are
**not on the generic bus today**. The coach composer/grader/strategist are
bespoke direct calls (server.js) and the blogger is a spawned CLI; none route
through `runAiTask`, so the policy decorator never sees them. **The control
machinery (S0–S5) gives by-component runtime control of the ~8 ready bus tasks +
primitives, but the marquee floor components stay boot-pinned until the S6
migration.** Two viable sequences:
- **Generic-first** (S0→S5 then S6): proves the whole mechanism end-to-end on
  local synthetic data first; the foundation either way.
- **Marquee-first**: front-load migrating one high-value bespoke component
  (resolution.pitch is easiest — it already has a sandbox descriptor; the coach is
  hardest — streaming + dual-model) so the surface controls something operators
  care about sooner.

## Coach addendum — DECIDED (coach-first), in progress

**Decision (supersedes the boot-pinned/S6 posture above, for the coach):** the
coach is controlled NOT by migrating it onto `runAiTask`, but by an **in-factory
per-turn model read** that clones the proven `setComposerTier`/`getComposerTier`
no-restart pattern. This was chosen after a coach-specific map + adversarial
review: all five coach reasoning calls execute **in-process inside the ai-bus
(7000)** via bespoke `fetch()`; the only axis still frozen at boot is the model id
(effort/thinking "tier" is already read live per turn). Routing the **streaming**
dialog composer through `runAiTask` (request/response, no stream shape) would break
the SSE coach line — so the bus-migration path is explicitly rejected for the
coach. This is strictly safer than S6: **zero transport change**.

**Mechanism:** `apps/ai-bus/src/liveCoachModelPolicy.js` — a synchronous,
in-process model-override cache. `resolveCoachModel(key, role, envDefault)` is read
on the turn path (no `await`, no Mongo), returns `envDefault` when no policy row is
set (byte-identical), and **clamps at read time** to a per-component allow-set so a
bad/cross-provider/typo id falls back to the env default instead of failing every
turn. Fed by `applyCoachPolicy()` from the dashboard endpoint + (pending) the 5001
boot cold-load.

**Component keys + allow-sets** (declared in code, the reviewable surface):
`liveCoach.rollingDigest`, `liveCoach.callGrader`, `liveCoach.contextJudge`
(openai), `liveCoach.callStrategy` (anthropic), `liveCoach.dialogComposer` with
**tick/ask sub-roles** (anthropic). Cross-provider swaps are out of scope where no
alternate-provider path exists (e.g. there is no OpenAI streaming composer).

**Endpoints (7000, `requireDashboardAccess`, sibling of composer-tier):**
`GET/POST /api/ai/live-coach/dashboard/model-policy` — GET returns the live cache +
allow-sets (so the UI renders only legal choices); POST replaces the cache.

**Honest coverage:** several coach factories are null when disabled
(`dialogComposer` is default-OFF via `LIVE_COACH_ANTHROPIC_COMPOSER_ENABLED`,
`callGrader`/`contextJudge` gated, `callStrategist` needs a key). When a factory is
null there is no turn closure to read the override — the admin UI must render those
rows read-only "boot-pinned/disabled".

**Coach build order (each stage default-off, failable check):**
- **S0 — DONE:** `liveCoachModelPolicy.js` module + 11 unit tests (sync, default-off
  byte-identical, read-time clamp, tick/ask roles). Full ai-bus suite 89/89.
- **S1 — DONE:** wired the fastest first win — `liveCoach.rollingDigest`
  (`gpt-5.4-mini` → `gpt-5.4`) to the live read; added the `model-policy`
  GET/POST endpoints. Bus boots clean (21 tasks mounted, `listening`), digest still
  initializes on the env default.
- **S2 — DONE:** wired `callGrader` + `contextJudge` (off the live latency path;
  both also re-key their OpenAI prompt cache, which embeds the model).
- **S3 — DONE:** wired `callStrategist` (anthropic same-provider). All four
  non-streaming coach seams now read the model live. Suite 89/89, boots clean.
- **S4 — next, CHECKPOINT:** wire the streaming `dialogComposer` tick+ask (the one
  seam on the live-latency path — at the existing `requestModel` assignment beside
  the per-turn tier read; assert `onDelta` still fires post-swap, no SSE regression).
- **S5:** 5001 authoring (`AiPolicy` Mongo doc + cold-load so an override survives
  the one floor-allowed 7000 restart) + the web-client admin card. NOTE until this
  lands, an override lives only in the 7000 in-memory cache and is forgotten on a
  restart (reverting to the env default = today's behavior — a safe direction).

**Remaining box-only proof:** observe the actual OpenAI request `body.model` flip
on a live digest after a POST — needs real keys + the dashboard token, like the
activity smoke. The mechanism is proven in-process (module tests + clean boot).

## Cross-review fixes applied (generic bus hardening)

From the second agent's review of the bus. All fixed + tested (suite 92/92, boots
clean in `secret-required` mode on the box):

- **P1 — `ignoreEnabled` HTTP bypass:** `runTask` now strips privileged
  server-only options (`ignoreEnabled`, `validate`) from wire-supplied options, so
  a client can't run a default-off task or inject a broken validator. In-process
  callers keep full control via `runner.runAiTask`. (aiTaskRoutes.js)
- **P1 — auth fail-open:** the generic AI task routes now fail **closed** without
  `INTERNAL_SERVICE_SECRET` regardless of `NODE_ENV` (7000 is tunnelable);
  `AI_BUS_ALLOW_INSECURE_LOCAL=true` re-opens for local dev. Scoped at the mount so
  other internal endpoints are unaffected. The live box already runs
  `secret-required`, so no live behavior change. (server.js mount)
- **P1/P2 — caller-abort doesn't cancel spend:** the POST handler wires
  `req.on("close")` → `AbortController`; the runner checks `options.signal` before
  each provider attempt and short-circuits to `caller_aborted`, bounding wasted
  spend to the in-flight attempt. (aiTaskRoutes.js + aiTaskRunner.js) — full
  mid-flight cancellation still needs adapter-level signal support (follow-on).
- **P2 — telemetry was `null`:** the mount now passes a telemetry recorder that
  logs one structured `ai_task.run` row per attempt (taskId/provider/model/status/
  latency/usage). First spend control loop; a durable AiTaskRun sink can subscribe
  to the same `record()` shape later. (server.js mount)
- **P2 — test overstated prod wiring:** `busWiring.test.js` comment corrected, and
  a new test asserts every `ai.*` primitive is default-OFF in `buildBusRegistry()`
  (the real prod registry), plus the `ignoreEnabled`-strip boundary.
- **P2 — binary modalities over JSON (deferred, noted):** transcribe/image/tts
  need a multipart/base64/object-store contract before routing through generic
  `/api/ai/tasks`. They are default-OFF today so cannot be invoked accidentally;
  no contract is defined yet — do NOT enable them on the generic route until one is.
