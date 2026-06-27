# Live-Coach Cockpit — Backend Wiring Implementation Guide

**Created 2026-06-26.** Grounded in a multi-agent code audit (37 candidate gaps → 36 verified)
followed by an 8-area ground-truth extraction; every file:line below was read, not recalled. The
audit's `scripts/…` citations were stale — **all real source is under `packages/shared-services/src/`
and `apps/ai-bus/src/`**; corrected throughout.

> **Companion docs:** the *design target* is [AI_LIVE_COACH_COCKPIT_DESIGN_2026-06-26.md](AI_LIVE_COACH_COCKPIT_DESIGN_2026-06-26.md);
> the two-tier runner map is [AI_LIVE_COACH_TWO_TIER_RUNNER_2026-06-26.md](AI_LIVE_COACH_TWO_TIER_RUNNER_2026-06-26.md).
> This guide is the *how-to-finish-the-backend* so the client component is no longer blind.

---

## 0. TL;DR — why the component can't be built yet, and the shape of the fix

The deep pull (Opus, ~60s) **computes the full cockpit state** every tick —
`currentSection / beats / remember / says / priorFlags` — and then **throws all of it away except
`callStrategy`** at the bus writeback. So there is no SSE event, no snapshot field, and no client
type carrying the spine + 3 columns + say-zone. The model does the work; the wire to the client was
never connected.

```
 PRODUCED (good)                          DROPPED (the gap)                 NEEDED (the wires)
 ┌────────────────────────┐   updates[]   ┌─────────────────────────┐       ┌──────────────────────┐
 │ reduceDeepPullSteering │ ────────────▶ │ applyDeepSteering       │       │ session.latest.cockpit│
 │ coachBatchRunner.js    │   {currentSec,│ liveCoachBusService.js  │  ───▶ │ + emit('coach.cockpit')│ ──▶ SSE ──▶ component
 │ :542-565               │    beats,     │ :3184-3190              │ WIRE1 │ (rides serializeSession│
 │ says[],remember,flags} │   says[]...}  │ writes ONLY callStrategy│       │  via latest:1120 free) │
 └────────────────────────┘               └─────────────────────────┘       └──────────────────────┘
```

**Three wires unblock everything; the rest sharpen specific columns:**

| Wire | What | Blocks | Hard blocker? |
|---|---|---|---|
| **WIRE 1** | Persist deep state → `session.latest.cockpit` + emit `coach.cockpit` | say-zone, spine, all columns, freshness | **YES — do first** |
| **DEVPATH** | Stub transport + dev-inject route + v2 fixture | developing the component at all without model spend | **YES — do early, parallel** |
| **WIRE 3** | Rolling-summary sidecar tick (the missing producer) | SUMMARY tax-memory, CASE factsCaptured | **YES** (else those fields are empty) |
| WIRE 4 | Structured `TAX_GROUP_SECTIONS` catalog + `SCRIPT_SECTION_IDS` | SCRIPT column has nothing static | YES for SCRIPT column |
| WIRE 5 | `beatId` join + `currentSection` enum | status-by-id binding, no fuzzy match | YES for SCRIPT column |
| WIRE 6 | Per-section contract decision + per-section summary | spine re-binding prior sections | DECISION — recommend client-accumulate |
| WIRE 2 | Normalize `facts[]`/`taxFacts[]` on `serializeSession` | clean typed contract | NO — data already rides `latest`/`factLedger` |
| WIRE 7 | Reactor typed say on `dialog` + `KNOWN` facts loop | typed say-zone, record-a-fact loop | improvement |
| WIRE 8 | Per-section interview capture state | CASE form-slice persistence | improvement |
| WIRE 10 | `stream.ts` client types | typed component | follows WIRE 1/3/6 |

---

## 1. What's already in place — DO NOT REBUILD

The foundation is genuinely strong. Lean on all of this:

- **The model produces the right state.** `reduceDeepPullSteering` ([coachBatchRunner.js:542-565](../packages/shared-services/src/coachBatchRunner.js)) already returns the full per-session `{currentSection, beats, remember, says, priorFlags}` + a synthesized `callStrategy` (the `rec` say). Only the last-mile persist/emit is missing.
- **The say-zone contract matches the design 1:1.** `SAY_ITEM_SCHEMA` ([:104-114](../packages/shared-services/src/coachBatchRunner.js)) — `{type:'objection'|'tactic'|'line', tag, rec, text}`, shared by deep `says[]` and reactor `say`; `ensureOneRec` ([:391-396](../packages/shared-services/src/coachBatchRunner.js)) guarantees exactly one `rec`.
- **The repair layer is comprehensive and fail-closed** — `repairGuidanceRow`/`repairBeats`/`repairSays` coerce every row to canonical, clamp enums, never throw. Extending it is mechanical.
- **The SSE transport is fully wired and battle-tested.** `emit(sessionId, type, payload)` ([liveCoachBusService.js:1069-1106](../packages/shared-services/src/liveCoachBusService.js)) appends to the events ring + ndjson, persists, and fans out to per-session subscribers. Two live SSE endpoints (dashboard `server.js:4082`, monitor/grpc via `writeCoachSessionEventStream` `:4145`) relay *every* bus event verbatim. **No new endpoint is needed** — every gap is a payload shape inside the existing pipe.
- **`serializeSession` returns `latest: session.latest` wholesale** ([:1120](../packages/shared-services/src/liveCoachBusService.js)). So **anything written under `session.latest.*` is replayed to a late-joining client for free** — this is the keystone that makes WIRE 1 a ~6-line change. `emitBatchGuidance` already exploits this for `session.latest.dialog` ([:3177-3179](../packages/shared-services/src/liveCoachBusService.js)) — copy that exact write-then-emit pattern.
- **The client SSE consumer is event-name-agnostic.** `streamLiveCoachEventsWithRetry` ([stream.ts:304-345](../apps/web-client/src/.../stream.ts)) reconnects with backoff + snapshot-seeding and switches on `event.type` (an open `string`, not a literal union) — **it receives a new `coach.cockpit` event with zero change.**
- **The whole rolling-summary pure pipeline exists and is unit-tested** — `liveCoachRollingSummaryService.js` exports `buildRollingSummaryBatchRequest / buildRollingSummaryPrompt / buildRollingSummarySchema / parseRollingSummaryResult / buildRollingSummaryApplyPlan / applyRollingSummaryToSession / buildRollingSummaryCursorFromApplyPlan / getPreviousRollingSummary / mergeAppendOnlySummary` (exports at `:612-629`). **Wire it; do not rebuild it.** Only the clock that drives it is missing.
- **`buildConversationProjection`** ([liveCoachBatchProjectionService.js:198-270](../packages/shared-services/src/liveCoachBatchProjectionService.js)) already returns `arrays.facts` (via `factRows`), `rollingSummary`, `callStrategy`, `callSummary` in normalized shape — reuse for WIRE 2.
- **The floor loop cadence skeleton** (`tickReactor` `coachFloorLoop.js:88-125`, `tickDeep` `:127-169`) — in-flight guard, firing gate, no-runner early-return-without-advancing, `modelFailure` check, try/catch-never-throw, `finally`-clear. Copy it for `tickSummary` (WIRE 3).
- **The synthetic harness exists** — `coachBatchEndToEnd.test.js:67-103` builds a fake transport + hand-authored guidance + drives `loop.tickReactor()` with no model/server/Mongo. Lift it into the dev injector (DEVPATH).
- **Default-off discipline is intact.** The whole floor-coach path is dormant unless `batchModelRunners.{runReactor,runDeep}` are injected (`startFloorCoach` returns null otherwise, `:3205`); `emitBatchGuidance`/`applyDeepSteering`/`batchModeSessions` all gate on `mode ∈ {batch,hybrid}`. Every wire below must preserve this.

---

## 2. The ONE contract decision to make before WIRE 6 — flat vs section-keyed

The cockpit design wants the **section spine to re-bind all 3 columns to the selected section**,
including *prior* sections with their own beats/remember/summary. The implemented deep schema is
**FLAT** — one `beats[]` / `remember[]` / `says[]` for the **current** section only (confirmed:
`DEEP_SHAPE` `:49-58`, `buildGuidanceSchema` `:116-169`, `repairGuidanceRow` `:462-482`,
`reduceDeepPullSteering` `:542-565` — **no `sections{}` map anywhere**).

Two ways to close it:

- **Option A — section-keyed schema (model re-evaluates all sections each tick).** Change all four
  layers to `sections{'<id>':{beats,remember,summary}}`. Richer, but more tokens per tick and a
  4-layer schema/repair/reducer change.
- **Option B — client accumulates flat current-section state (RECOMMENDED).** Backend stays flat.
  The cockpit keys each tick's current-section state under `currentSection` and accumulates a
  `Map<sectionId, sectionState>` as `currentSection` advances. Prior sections show their last-seen
  state (exactly the history you want); cross-section issues already arrive via `priorFlags`.
  **Zero backend schema churn** — the only backend need is a stable `currentSection` id (WIRE 5) so
  the client keys correctly.

**Recommendation: Option B.** The model only ever assesses the live section per tick anyway; let the
client be the accumulator. This guide's WIRE 6 assumes B (and notes the per-section *summary* it still
needs from the model). Revisit A only if the user wants every section re-scored every minute.

---

## 3. The wires

Each wire: **current state (anchored) · the change · sketch · gotchas · test · done-check.** Sketches
are faithful to the verified anchors; treat them as the diff skeleton, not copy-paste.

### WIRE 1 — Deep cockpit state → `session.latest.cockpit` + `coach.cockpit` event ⭐ THE UNBLOCKER

**Current state.** `applyDeepSteering` ([liveCoachBusService.js:3184-3190](../packages/shared-services/src/liveCoachBusService.js)) receives the full deep `updates[]` (each carrying `says/beats/remember/priorFlags/currentSection`) but writes **only** `if (update.callStrategy) session.callStrategy = update.callStrategy`. Everything else is dropped; nothing is emitted.

**The change.** ① In `reduceDeepPullSteering`, carry `generatedAt`. ② In `applyDeepSteering`, persist the cockpit object under `session.latest.cockpit` (so it rides `serializeSession` for free) and emit a dedicated `coach.cockpit` event.

```js
// coachBatchRunner.js — reduceDeepPullSteering (:542-565): carry generatedAt
const generatedAt = parsed.generatedAt || null;        // parseBatchGuidance surfaces it at :515
// ...inside updates.push({...}):
  priorFlags: row.priorFlags || [],
  generatedAt,                                          // NEW
  ...(callStrategy ? { callStrategy } : {}),
```
```js
// liveCoachBusService.js — applyDeepSteering (:3184-3190): persist + emit (mirror the dialog pattern :3177-3179)
if (update.callStrategy) session.callStrategy = update.callStrategy;   // existing
if (Array.isArray(update.says)) {                                       // NEW — deep state present
  session.latest = session.latest || {};
  session.latest.cockpit = {
    currentSection: update.currentSection || null,
    beats: update.beats || [],
    remember: update.remember || [],
    says: update.says || [],
    priorFlags: update.priorFlags || [],
    generatedAt: update.generatedAt || null,
    at: new Date().toISOString(),
  };
  emit(session.id, "coach.cockpit", { cockpit: session.latest.cockpit });
}
```

**Gotchas.**
- **Use a SEPARATE event (`coach.cockpit`), not the `dialog` path.** `emitBatchGuidance` returns early when its flattened `say` is empty (`:3166`) and is shaped for the legacy Read/Steer/Try card — the typed `says[]` choice-set belongs on its own channel. This also sidesteps the empty-say guard.
- **Write under `session.latest.cockpit`, NOT a top-level `session.cockpit`.** Top-level fields are invisible to reconnecting clients — that's the exact mistake `applyDeepSteering` makes with the top-level `session.callStrategy` (never serialized; the client only ever sees `session.metadata.callStrategy` from `attachCallStrategy` `:2640`). `latest.*` is what `serializeSession` ships (`:1120`).
- `emit()` **spreads** the payload (`event = {type, at, sessionId, ...payload}`), so `emit(id,'coach.cockpit',{cockpit})` yields `event.cockpit` — the client reads `event.cockpit`, not `event.payload.cockpit`.
- The events ring caps at 200 and `serializeSession` replays only the last 50 (`:1126`) — durable repaint **must** come from `session.latest.cockpit`, never from replaying events.
- This only fires when the floor loop is live (batch mode). It will not paint on a purely deterministic floor — correct for now.

**Test.** Extend `coachBatchEndToEnd.test.js`: drive a **deep** tick (add a `loop.tickDeep()` path with a stub deep runner returning a v2 deep row), assert `bus` emitted `coach.cockpit` for the batch session with the full `cockpit` payload, and assert `serializeSession(session).latest.cockpit` carries it (snapshot replay). Assert a deterministic-mode session gets nothing.

**Done-check.** A deep tick produces an SSE `coach.cockpit` event AND a reconnecting snapshot carries `latest.cockpit` with `says[]/beats/remember/currentSection/priorFlags/generatedAt`.

---

### DEVPATH — Stub transport + dev-inject route + v2 fixture ⭐ DO EARLY (parallel)

So a front-end dev can see the cockpit render against live-shaped data with **no model spend**.

**Current state.** The only no-model batch injection lives *inside* a unit test. `emitBatchGuidance` is a private closure (not on the returned bus object). The batch loop is default-off; `createReactorTransport` returns null without `LIVE_COACH_REACTOR_ANTHROPIC_API_KEY`; `createDeepPullTransport` spawns real `claude -p` (Max credits). `POST /grpc/batch-guidance-dispatch-plan` (`server.js:4266-4272`) only *returns* a plan, never emits.

**The change.** Three small additions:

① **Stub transport** in `coachBatchTransports.js` (after `createReactorTransport :140`, add to exports `:142`):
```js
function createStubTransport({ logger = null, kind = "reactor", guidance } = {}) {
  const json = { schemaVersion: "live-coach.batch-guidance.v2",
    generatedAt: new Date().toISOString(), guidance: guidance || [] };
  return async function runStub(_req) {       // satisfies async(req)=>{ok,json,text,usage}
    logger?.info?.("coach_stub.run", { kind });
    return { ok: true, json, text: JSON.stringify(json), usage: null, model: `stub-${kind}` };
  };
}
module.exports = { createDeepPullTransport, createReactorTransport, createStubTransport, fastSettingsPath };
```
② **Env-selectable runners** at the `batchModelRunners` construction site (`server.js:3465-3472`):
```js
const stubMode = String(process.env.LIVE_COACH_BATCH_TRANSPORT || "").toLowerCase() === "stub";
const batchModelRunners = liveCoachBatchEnabled
  ? (stubMode
      ? { runReactor: createStubTransport({ logger, kind: "reactor", guidance: STUB_REACTOR }),
          runDeep:    createStubTransport({ logger, kind: "deep",    guidance: STUB_DEEP }) }
      : { runReactor: createReactorTransport({ logger }), runDeep: createDeepPullTransport({ logger }) })
  : null;
```
③ **Dev inject route** beside the batch routes (`server.js`, after `:4272`), gated by `NODE_ENV` + `requireInternalAccess` (which already fails open in dev, locked in prod, `:974-997`):
```js
const DEV_INJECT_ENABLED = String(process.env.NODE_ENV || "").toLowerCase() !== "production";
app.post("/api/ai/live-coach/dev/inject", requireInternalAccess, (req, res) => {
  if (!DEV_INJECT_ENABLED) return res.status(404).json({ ok: false, error: "not found" });
  const r = coachBus.emitDevCockpit(req.body?.sessionId, req.body?.cockpit); // new mode-agnostic seam
  return res.json({ ok: r?.ok !== false, result: r });
});
```
…and expose a tiny `emitDevCockpit(sessionId, cockpit)` on the bus return object (`:3242-3269`) that writes `session.latest.cockpit` + `emit('coach.cockpit', {cockpit})` with no mode gate (dev only). ④ Commit one captured real deep-pull v2 object to `scripts/fixtures/coach-batch-guidance.v2.sample.json` for the injector/stub to read.

**Gotchas.** `buildBatchGuidanceDispatchPlan` is READ-ONLY (returns, never emits) — don't expect hitting it to paint. The runner contract is permissive — `coachBatchRunner.coerceResponse` (`:336-351`) accepts `{guidance:[]}`/`{items:[]}`/arrays, so the stub's `{ok,json:{guidance}}` is fine. A stub avoids the `claude -p` Max spend that `LIVE_COACH_RUNTIME_MODE_BATCH_ENABLED` alone would incur via the deep runner.

**Done-check.** With `NODE_ENV=development LIVE_COACH_RUNTIME_MODE_BATCH_ENABLED=1 LIVE_COACH_BATCH_TRANSPORT=stub`, a `curl` to `/api/ai/live-coach/dev/inject` paints a `coach.cockpit` event on a live SSE subscriber — no keys, no model.

---

### WIRE 3 — Rolling-summary sidecar tick (the missing producer)

**Current state.** `applyRollingSummaryToSession` is invoked only at call-*end* by closeout — **never live**. The floor loop has `tickReactor`/`tickDeep` and **no summary cadence**. `LIVE_COACH_ROLLING_SUMMARY_ENABLED` exists **only in docs**, never in code. So `session.latest.rollingSummary` is **null on every live call**, and the SUMMARY column's `taxIssues` + CASE column's `factsCaptured` have nothing to bind to.

**The change.** Add a third, slow cadence mirroring `tickDeep`, gated behind a new env flag, default-off. Keep `coachFloorLoop` transport-free (inject the bound build/run/apply fns as deps, per its header doctrine).

```js
// coachFloorLoop.js — new tickSummary (model on tickDeep :127-169); deps: runSummary, buildSummaryBatch,
// applySummary, summaryIntervalMs=120000; locals: summaryInFlight, summaryHandle, summaryCursor=null
async function tickSummary() {
  if (summaryInFlight) return { tier: "summary", skipped: "in-flight" };
  summaryInFlight = true;
  try {
    const conversations = buildSummaryBatch({ ...batchOptions });     // capture ONCE this tick
    const req = buildRollingSummaryBatchRequest(conversations, { cursor: summaryCursor, cadenceMs: summaryIntervalMs });
    if (!req.calls.length) return { tier: "summary", fired: false, reason: "no-calls" };
    if (!runSummary)       return { tier: "summary", fired: false, reason: "no-runner" }; // do NOT advance cursor
    const res = await runSummary(buildRollingSummaryPrompt(req));
    if (modelFailure(res)) return { tier: "summary", fired: false, reason: "model-failed" };
    const parsed = parseRollingSummaryResult(res, { batchId: req.batchId, generatedAt: req.generatedAt });
    const plan = buildRollingSummaryApplyPlan(conversations, parsed, { batchRequest: req }); // SAME conversations + batchRequest
    applySummary(plan);
    summaryCursor = buildRollingSummaryCursorFromApplyPlan(plan);     // advance ONLY after apply
    return { tier: "summary", fired: true, applyCount: plan.applyCount };
  } catch (error) { log("warn", "coach_floor.summary_error", { error: error.message });
    return { tier: "summary", fired: false, error: error.message }; }
  finally { summaryInFlight = false; }
}
```
```js
// liveCoachBusService.js — new writeback next to applyDeepSteering (:3190); decide callSummary ownership (gotcha)
function applyRollingSummary(applyPlan) {
  for (const apply of (Array.isArray(applyPlan?.applies) ? applyPlan.applies : [])) {
    const session = sessions.get(String(apply.target?.sessionId || ""));
    if (!session || TERMINAL_SESSION_STATUSES.includes(session.status)) continue;
    applyRollingSummaryToSession(session, apply.payload, { mutate: true }); // ⚠ see callSummary gotcha
  }
}
// startFloorCoach createCoachFloorLoop({...}) (:3211-3230): add
//   buildSummaryBatch: (input) => buildActiveLiveCoachBatch(batchModeSessions(), input),
//   runSummary: runners.runSummary || null, applySummary: applyRollingSummary,
//   summaryIntervalMs: cfg.summaryIntervalMs || 120000,
```
```js
// server.js — gate the runner behind the new flag (copy the :853 crossCallMemoryEnabled idiom), default-off
const summaryEnabled = /^(1|true|yes|on)$/i.test(String(process.env.LIVE_COACH_ROLLING_SUMMARY_ENABLED || "").trim());
// runners.runSummary = summaryEnabled ? makeSummaryRunner(process.env.LIVE_COACH_ROLLING_SUMMARY_SUBSTRATE) : null;
```

**Gotchas — read before coding.**
- **`callSummary` ownership race (CRITICAL).** `applyRollingSummaryToSession` writes `session.callSummary` (`:163`), but the **rolling DIGEST scribe also owns `callSummary`** (`:1997-1998`), and `applyDeepSteering` deliberately avoids it (comment `:3182-3183`). If both run, they fight. **The summary tick should write only `session.latest.rollingSummary` + `session.memory.rollingSummary` and NOT `callSummary`.** `applyRollingSummaryToSession` has no suppress flag — either add an option (`{writeCallSummary:false}`) or call a narrower writeback. Decide this explicitly.
- **Pass the SAME `conversations` + `options.batchRequest`** to `buildRollingSummaryApplyPlan` (for identity re-resolution + cursor computation). Rebuilding the batch between request and apply → a call that ended mid-tick is rejected and its cursor never advances → permanent reprocessing.
- **Cursor discipline:** advance only after a successful apply. On no-runner / model-fail, leave the cursor so rows retry (append-only merge dedups, but a dropped advance = wasted model spend forever).
- **The flag is brand-new** — `LIVE_COACH_ROLLING_SUMMARY_ENABLED` (+ `_SUBSTRATE=codex|api|off`) does not exist in code; create it default-off. Don't confuse this tick with the existing per-turn rolling DIGEST (`scheduleRollingDigest :1928-2018`) — different mechanism.
- `startFloorCoach` returns dormant unless `runReactor||runDeep` is set (`:3205`). If summary should run independently, widen that guard to also check `runSummary`.
- Keep `coachFloorLoop` require-free (inject deps); reuse the injected `startInterval` (with `unref`, `:3223-3227`).

**Reuse.** The entire pure pipeline (`liveCoachRollingSummaryService.js`) + the barrel re-exports (`packages/shared-services/src/index.js:713-724`) + existing terminal-payload enrichers that already READ `session.*.rollingSummary` (`:725-730`) — a producer that writes those fields feeds them with zero extra wiring. The runner is the same injected `async(req)=>res` shape as reactor/deep, so `buildRollingSummaryPrompt`'s `{system,prompt,schema}` drops straight into the ai-bus / `claudeAgentJson` substrate seam (this is the **Codex** substrate per the 3-substrate split — isolated `CODEX_HOME`, `OPENAI_API_KEY` stripped).

**Test.** Drive `tickSummary` with a stub `runSummary` returning a canned `rolling-summary-result.v1`; assert `session.latest.rollingSummary` populated, `callSummary` **unchanged** (digest still owns it), and the cursor advanced (a 2nd tick with no new rows → `no-calls`).

**Done-check.** With the flag on + a stub substrate, a live session gets `latest.rollingSummary.{taxIssues,factsCaptured,objections,openQuestions,nextBestFocus}` mid-call; `callSummary` untouched.

---

### WIRE 4 — Structured `TAX_GROUP_SECTIONS` catalog for the SCRIPT column

**Current state.** `taxGroupScript.js` exports a single prose template-literal `TAX_GROUP_SCRIPT` (export `:65`). The 8 sections (`1,2,3,4,4B,5,6,7`) exist only as prose headings — no machine-readable beats, no ids. The client has nothing static to render or toggle.

**The change.** Add a structured source of truth and **derive** the prose string from it so model + client share one id-space.
```js
// taxGroupScript.js — before the existing const (:10); replace export (:65)
const TAX_GROUP_SECTIONS = [
  { id: "1", title: "INTRODUCTION", beats: [
    { id: "inbound_greeting", point: "Inbound greeting", detail: "\"Thank you for calling The Tax Group…\"" },
    { id: "who_we_are",       point: "Who we are",        detail: "a LICENSED TAX REPRESENTATION FIRM…" } ] },
  // 2 CASE-BUILDING, 3 EXPERT, 4 PITCH, 4B PAYMENT/CLOSE (preserve its 1)…5) numbered ladder in `detail`),
  // 5 INFO, 6 THINK-IT-OVER, 7 CLOSE …
];
const SCRIPT_SECTION_IDS = TAX_GROUP_SECTIONS.map((s) => s.id);        // ['1','2','3','4','4B','5','6','7']
const TAX_GROUP_SCRIPT = [HEADER, "", ...TAX_GROUP_SECTIONS.map((s) =>
  `${s.id}. ${s.title}\n` + s.beats.map((b) => `- ${b.detail || b.point}`).join("\n"))].join("\n\n");
module.exports = { TAX_GROUP_SCRIPT, TAX_GROUP_SECTIONS, SCRIPT_SECTION_IDS };
```

**Gotchas.**
- **`TAX_GROUP_SCRIPT` must stay byte-identical** — it feeds the live model via `coachReferenceLibrary.buildReferenceBody` (`:44-54`). Section **4B has a numbered `1)…5)` payment-ladder sub-list** a naive `- ${detail}` join won't reproduce — keep that numbering inside the `detail` strings. **Add a snapshot test pinning `TAX_GROUP_SCRIPT` before/after the refactor.**
- **Two id-spaces — do not conflate.** Script ids are numeric (`1,2,3,4,4B,5,6,7`, 8 incl. `4B`); `coachPhaseSteps` `PHASE_STEPS` are name-keyed (`intro,discovery,…`, 7, no `4B`). `4B`≈`payment`; numeric `6` (think-it-over) has no phase key. Don't wire the new catalog into `STEP_MARKERS`/`recognizeSteps` unless asked.
- `coachBatchRunner.js` does **not** import `taxGroupScript` today; the model gets section ids from inline literals in `DEEP_SHAPE`/`TIER_INSTRUCTION` **and** the prose body — kept in sync by hand. WIRE 5 unifies them.

**Done-check.** `TAX_GROUP_SECTIONS` renders the SCRIPT column statically (point + collapsible detail); `TAX_GROUP_SCRIPT` snapshot test passes (prompt unchanged).

---

### WIRE 5 — `beatId` join + `currentSection` enum (status-by-id, not fuzzy text)

**Current state.** The deep schema makes `beats[].point` a free string (`:143`) and `currentSection` a free string with no enum (`:136`); `priorFlags[].section` likewise (`:162`). The model never receives stable beat ids; there is no server-side join. The client would be forced to fuzzy-match free text — which the design forbids.

**The change.** Feed `SCRIPT_SECTION_IDS` + the current section's beat ids into the prompt; emit `beatId` on each beat; enum-clamp `currentSection`.
```js
// coachBatchRunner.js
// require taxGroupScript ABOVE the DEEP_SHAPE const; interpolate at TIER_CONTRACT assembly (DEEP_SHAPE is a
//   plain const literal today — convert the section-id hint to a builder or inject where TIER_CONTRACT is built)
// buildGuidanceSchema deep branch:
currentSection: { type: "string", enum: ["1","2","3","4","4B","5","6","7"] },     // :136 (case-sensitive — keeps "4B")
// beats item properties (:143): add beatId
properties: { beatId: { type: "string" }, point: { type: "string" }, status: { type: "string", enum: ["hit","pending","fumbled"] } },
// repairBeats (:406-418): thread beatId through both return paths
return point ? { point, status: oneOf(b.status, ENUM.status, "pending"), beatId: cleanText(b.beatId, 80) || null } : null;
```

**Gotchas.**
- **`oneOf` lowercases** (`cleanText(...).toLowerCase()`, `:368-371`) → it would turn `"4B"` into `"4b"`. Enum-clamp `currentSection` at the **schema** level (case-sensitive, no problem) and write a **case-preserving** clamp in repair, OR store the enum lowercased and accept `"4b"` everywhere. Don't blindly route `currentSection` through `oneOf`.
- `additionalProperties:false` is set on the deep item (`:132`), beats item (`:141`), and `SAY_ITEM_SCHEMA` (`:106`) — any new field (`beatId`) **must** be added to the schema or strict validation rejects the model output.
- `reduceDeepPullSteering` forwards `row.beats` verbatim — adding `beatId` in `repairBeats` lands it in cockpit state with **no reducer change**.
- Decide whether `priorFlags[].section` also needs the enum (currently free, `:162`/`repairPriorFlags :435`) — clamping only `currentSection` leaves them inconsistent.

**Done-check.** Each deep beat carries `{beatId, point, status}`; `currentSection` is one of the 8 ids; the client overlays status onto static beats by id with no fuzzy match.

---

### WIRE 6 — Per-section summary (assuming Option B from §2)

**Current state.** No producer segments the whole-call `summaryText` into the 7 sections; rolling-summary entries have a fixed `kind` set but no `section` field. The deep schema emits no `summary` key (correct — Codex owns whole-call summary), but nothing supplies a **per-section** "what happened in THIS part."

**The change (smallest, design line 217).** Add a deep RULE telling Opus to write a 1-line `summary` for the **current** section, and a `summary` string to the deep output; the client accumulates it under `currentSection` (Option B). I.e. extend `DEEP_SHAPE` + `buildGuidanceSchema` (add `summary: { type:"string" }` to the deep item) + `reduceDeepPullSteering` (carry `summary`) + `repairGuidanceRow` (clamp). Fallback if skipped: client renders whole-call `callSummary` in every section (degraded).

**Done-check.** Deep output carries a current-section `summary`; cockpit shows per-section summaries that persist as the section advances.

---

### WIRE 2 — Normalize `facts[]` / `taxFacts[]` on the snapshot (OPTIONAL — clean contract)

**Current state.** `serializeSession` ships **raw** `factLedger` (a `Record`, `:1122`) and `callSummary` (string, `:1123`). The normalized `arrays.facts` ([{key,text}]) and a `taxFacts[]` are not surfaced. **But** `rollingSummary` already rides to the client indirectly because `serializeSession` ships `latest`/`memory` wholesale — so once WIRE 3 writes `session.latest.rollingSummary`, the client *can* read `snapshot.latest.rollingSummary.taxIssues/factsCaptured` directly. **This makes WIRE 2 a nicety, not a blocker.**

**The change (if you want a clean typed shape).** Import `buildConversationProjection` and add normalized fields to `serializeSession` (after `:1122`):
```js
const projection = buildConversationProjection(session);
// in the return object:
facts: projection.arrays.facts,                          // [{key,text}]
rollingSummary: projection.rollingSummary,               // normalized memory obj or null
taxFacts: (projection.rollingSummary?.taxIssues || []).map((t) => cleanText(t, 240)).filter(Boolean),
callSummary: projection.callSummary || session.callSummary || "",   // keep the fallback
```

**Gotcha — PERF.** `serializeSession` is called ~30× across the file, incl. `getSessions()` mapping over **all** sessions; `buildConversationProjection` runs the *full* projection (all transcript/context/guidance arrays) each call. Either cap the projection options, memoize per `updatedAt`, or skip WIRE 2 and let the client derive `facts[]` from the already-shipped `factLedger` + read `latest.rollingSummary`. `factRows`/`rollingSummaryFromSession` are **not individually exported** — reusing them directly means widening the module exports (`:420-427`). **Recommendation: defer WIRE 2; let the client derive, revisit if the typed contract demands it.**

---

### WIRE 7 — Reactor typed say on `dialog` + `KNOWN` agent-facts loop (improvement)

**Reactor typed say.** The reactor `say{type,tag,rec,text}` survives repair but is flattened to a `Read/Steer/Try` string twice (`normalizeGuidanceItem :42-69` → `buildGuidancePayload :113-130` → `emitBatchGuidance` `say` string). The typed object is reachable via `item.raw.say`. Add a `sayItem` field **additively** so the legacy card is untouched:
```js
// liveCoachBatchGuidanceDispatchService.js buildGuidancePayload (:113-130): add
sayItem: item.raw && typeof item.raw.say === "object" ? item.raw.say : null,
// liveCoachBusService.js emitBatchGuidance dialog literal (:3167-3176): add sibling key
sayItem: payload.sayItem || null,   // legacy card still reads dialog.say; new channel reads dialog.sayItem
```

**KNOWN facts loop.** `renderConversation` renders `arrays.transcript` but **not** `arrays.facts` (the agent-recorded factLedger — distinct from `rollingSummary.factsCaptured` which IS rendered now). So an agent-recorded fact dies in the projection. Add a `KNOWN (agent-recorded):` block before `TRANSCRIPT:` in `renderConversation`, gated to the deep tier like the `rollingDetail` block added 2026-06-26.

---

### WIRE 8 — Per-section interview capture state (improvement)

The CASE column's per-section form-slice needs section-bound persisted state. Add `session.interview = { '<sectionId>': {…fields} }` populated from the capture flow and surfaced in `serializeSession`. The persist-at-call-end guarantee already rides `buildInterviewActivityNote` (`CXWorkspace.tsx:2905`).

---

### WIRE 10 — Client types in `stream.ts` (follows WIRE 1/3/6)

`LiveCoachEvent.type` is an open `string` — receiving `coach.cockpit` needs no type change. **Add** (don't rebuild):
```ts
export type LiveCoachCockpitState = {
  currentSection?: string | null;
  beats?: Array<{ beatId?: string | null; point?: string | null; status?: "hit"|"pending"|"fumbled" }> | null;
  remember?: Array<{ text?: string | null; kind?: "watch"|"key" }> | null;
  says?: Array<{ type?: "objection"|"tactic"|"line"; tag?: string|null; rec?: boolean|null; text?: string|null }> | null;
  priorFlags?: Array<{ section?: string|null; issue?: string|null }> | null;
  summary?: string | null;          // per-section (WIRE 6)
  generatedAt?: string | null;
  at?: string | null;
};
// LiveCoachSession (before closing brace ~:139):  cockpit?: LiveCoachCockpitState | null;
// LiveCoachEvent (after callSummary ~:171):       cockpit?: LiveCoachCockpitState | null;
```
Mirror the backend shape 1:1. `LiveCoachDialog` stays as-is; cockpit state is additive. **Only after this** begin rendering the component against the typed SSE/snapshot.

---

## 4. Recommended sequencing

```
Track A (transport — critical path):   WIRE 1 ──▶ WIRE 10 (client types) ──▶ build component
Track B (parallel, no deps):           DEVPATH  ──────────────────────────▶ unblocks dev today
Track C (data producer):               WIRE 3 ──▶ (WIRE 2 optional)
Track D (script column, parallel):     WIRE 4 ──▶ WIRE 5 ──▶ WIRE 6
Track E (improvements, anytime):       WIRE 7, WIRE 8
```

**Minimum to start the component without churn or blindness:** WIRE 1 + DEVPATH + WIRE 10. Add WIRE 3
before the SUMMARY/CASE columns can show real tax-memory/facts; WIRE 4+5 before the SCRIPT column.

## 5. Test & safety discipline (fable-code — non-negotiable)

- **Everything stays default-off.** New env flags (`LIVE_COACH_ROLLING_SUMMARY_ENABLED`,
  `LIVE_COACH_BATCH_TRANSPORT=stub`) default off; the floor loop stays dormant without injected runners.
  The deterministic floor must never fire the model or paint cockpit events.
- **Each wire ships with a test** alongside it (the `tests/live-coach/*.test.js` suite, currently **288
  green**) — exercise the error path, not just the happy path. WIRE 1/3 get end-to-end tests through
  the real bus + a stub transport (no model, no Mongo, no server).
- **Smallest diff; read callers first.** `serializeSession` has ~30 callers and a persistence sibling
  (`serializeSessionForPersistence :981`) + a lighter `serializeSessionSummary :1130` — adding fields
  to one does not flow to the others; decide per-caller.
- **Preserve the legacy card.** `dialog.say` is parsed as `Read:/Steer:/Try:` by the existing panel —
  keep it byte-identical; only ADD sibling keys (`sayItem`) and NEW events (`coach.cockpit`).
- **Validate prompt changes with a real pull** (`scripts/coach-prompt-validate.js`) whenever WIRE 5/6
  touch `DEEP_SHAPE`/schema — confirm the model still fills the object and honors the new fields.

## 6. Appendix — verified anchor table

| Symbol | File:line | Role |
|---|---|---|
| `applyDeepSteering` | liveCoachBusService.js:3184-3190 | **the drop point** — writes only `callStrategy` |
| callSummary-ownership comment | liveCoachBusService.js:3182-3183 | digest owns `callSummary`; don't race it |
| `serializeSession` | liveCoachBusService.js:1108-1128 | snapshot; returns `latest:` wholesale (:1120) |
| `emit` | liveCoachBusService.js:1069-1106 | SSE push; spreads payload into event |
| `emitBatchGuidance` | liveCoachBusService.js:3151-3180 | write-`latest.dialog`-then-emit pattern (:3177-3179) |
| bus constructor opts | liveCoachBusService.js:841-848 | `batchModelRunners`/`resolveRuntimeMode`/`floorCoach` (default null) |
| `startFloorCoach` | liveCoachBusService.js:3202-3240 | injects `applySteering=applyDeepSteering` (:3216); dormant w/o runners (:3205) |
| env-flag idiom | liveCoachBusService.js:853 | `crossCallMemoryEnabled` — copy for the new flag |
| `reduceDeepPullSteering` | coachBatchRunner.js:542-565 | builds the full cockpit update (no `generatedAt` today) |
| `DEEP_SHAPE` | coachBatchRunner.js:49-58 | prompt skeleton; section ids prose-only |
| `SAY_ITEM_SCHEMA` | coachBatchRunner.js:104-114 | shared say contract |
| `buildGuidanceSchema` | coachBatchRunner.js:116-169 | FLAT; `currentSection` :136, beats :143, priorFlags.section :162 |
| `repairGuidanceRow`/`repairBeats`/`oneOf`/`ENUM` | coachBatchRunner.js:462-482 / 406-418 / 368-371 / 361-366 | repair funnel (oneOf lowercases) |
| `buildConversationProjection`/`factRows`/`rollingSummaryFromSession` | liveCoachBatchProjectionService.js:198-270 / 173-189 / 191-196 | normalized facts + rollingSummary (reuse) |
| rolling-summary pipeline | liveCoachRollingSummaryService.js:151-610 (exports :612-629) | build/prompt/schema/parse/applyPlan/applyToSession/cursor |
| `tickReactor`/`tickDeep` | coachFloorLoop.js:88-125 / 127-169 | cadence skeleton to copy for `tickSummary` |
| `TAX_GROUP_SCRIPT` export | taxGroupScript.js:65 | prose string; add `TAX_GROUP_SECTIONS`/`SCRIPT_SECTION_IDS` |
| `coachReferenceLibrary.buildReferenceBody` | coachReferenceLibrary.js:44-54 | the prompt injection seam (keep prose identical) |
| SSE endpoints | server.js:4082 / 4145 | dashboard + monitor/grpc (subscribers only) |
| batch routes / transport construction | server.js:4266-4272 / 3465-3472 | dispatch-plan (read-only) / `batchModelRunners` ternary |
| `requireInternalAccess` | server.js:3610 (mw 974-997) | dev route guard (fails open in dev) |
| transports | coachBatchTransports.js:51-140 (exports :142) | `createDeepPullTransport`/`createReactorTransport`; add `createStubTransport` |
| client SSE consumer / types | stream.ts:304-345 / 55-66 / ~139 / 141 / 143-171 | event-name-agnostic; add `LiveCoachCockpitState` |
| synthetic harness | coachBatchEndToEnd.test.js:67-103 | fake transport + `loop.tickReactor()` — lift to dev injector |
## 7. Line-by-line simplification audit (production-safe, atomic edits only)

Use this as the execution script. Every item is one minimal touch and can be merged separately.

### 7.1 Unblocker: make deep payload observable

#### packages/shared-services/src/liveCoachBusService.js :: applyDeepSteering (:3184-3190)

- `session.callStrategy` is already written, but `session.latest.cockpit` is never populated.
- Simplify to two writes in one place:
  - persist cockpit snapshot under `session.latest.cockpit`
  - emit `coach.cockpit` with payload `{ cockpit }`
- Preserve `emitBatchGuidance` and the legacy dialog path unchanged.
- Done-check:
  - `coach.cockpit` stream event appears.
  - reconnect snapshot includes `latest.cockpit`.

#### packages/shared-services/src/coachBatchRunner.js :: reduceDeepPullSteering (:542-565)

- Add only `generatedAt` passthrough from parsed guidance when present.
- No reducer schema changes here.
- Done-check:
  - `applyDeepSteering` receives `generatedAt` and keeps it in `session.latest.cockpit`.

---

### 7.2 DEVPATH: no-spend cockpit preview

#### apps/ai-bus/src/coachBatchTransports.js (:51-142)

- Add `createStubTransport({ kind, guidance })`.
- Return the same contract shape as existing transports: `{ ok, json, text, usage, model }`.

#### apps/control-plane/src/server.js :: batch runner + routes (:3465-3472, :4266-4272)

- Select stub runner under one env gate.
- Keep `buildBatchGuidanceDispatchPlan` behavior exactly read-only.

#### apps/control-plane/src/server.js :: dev route (adjacent to batch routes)

- Add one dev-only POST route that calls `coachBus.emitDevCockpit(sessionId, cockpit)`.
- Guard via existing internal access pattern and env-mode controls.
- Done-check: dev curl injects into stream without any Claude/API credentials.

---

### 7.3 Missing producer: rolling summary

#### packages/shared-services/src/coachFloorLoop.js (:88-169)

- Add `tickSummary` sibling to `tickDeep`.
- Copy `tickReactor/tickDeep` control shape exactly (guard, try/finally, failure path semantics).

#### packages/shared-services/src/liveCoachRollingSummaryService.js

- Reuse existing pure service; no redesign.
- Producer writes only `session.latest.rollingSummary` and `session.memory.rollingSummary`, never `callSummary`.
- Done-check:
  - cursor advances only on successful apply.
  - SUMMARY / CASE columns get real tax-memory mid-call.

---

### 7.4 Script + status binding (smallest schema changes)

#### packages/shared-services/src/taxGroupScript.js

- Introduce structured `TAX_GROUP_SECTIONS` + derived script string.
- Keep `TAX_GROUP_SCRIPT` bytes stable via snapshot test, including `4B` numbering behavior.

#### packages/shared-services/src/coachBatchRunner.js :: DEEP_SHAPE / schema / repair

- Add `beatId` to deep beat schema and repair path.
- Clamp `currentSection` with the canonical set `['1','2','3','4','4B','5','6','7']`.
- Avoid feeding case-sensitive enum values through lowercase normalizers.
- Done-check: no additionalProperties validation failures.

---

### 7.5 Thin client typing pass

#### apps/web-client/src/lib/liveCoach/stream.ts

- Add additive type `LiveCoachCockpitState`.
- Add optional `cockpit?: LiveCoachCockpitState | null` on `LiveCoachSession` and `LiveCoachEvent`.
- Keep `LiveCoachEvent.type` as string union open to future event names.
- Done-check: legacy panel remains unchanged; cockpit payload can be typed safely.

---

### 7.6 Optional cleanup (next pass)

- Add normalized snapshot fields (`facts[]`, `taxFacts[]`) only after confirming payload contract need, because `serializeSession` is hot path.
- Add typed `sayItem` sibling only if downstream renderer needs it; keep `dialog.say` exact.
- Add section form persistence only when CASE interaction requires live binding.

---

### 7.7 Delivery order (atomic)

1) WIRE 1 (`reduceDeepPullSteering` + `applyDeepSteering`)
2) `stream.ts` cockpit types
3) DEVPATH transport/route/fixture
4) rolling summary tick (`coachFloorLoop` + floor wiring)
5) script + beat/section id schema fixes
6) optional WIRE 2/7/8

---

## 8. Codex review pass - final push notes (2026-06-26)

This pass re-read the guide against the current code and checked the actual coach wiring surfaces, not just the prose plan. The important finding is that the guide's main diagnosis is still correct: the deep pull already produces cockpit state, but the bus boundary is the first place where that state becomes invisible to the client unless WIRE 1 is applied.

### 8.1 What is crucial before client cockpit work

#### WIRE 1 is the first required patch

Current code state verified:

- `packages/shared-services/src/coachBatchRunner.js` already parses and repairs deep rows into `{ currentSection, beats, remember, says, priorFlags }`.
- `packages/shared-services/src/coachFloorLoop.js` already treats deep output as state and routes it through `applySteering(updates)`.
- `packages/shared-services/src/liveCoachBusService.js` still only persists `session.callStrategy` in `applyDeepSteering`.
- `serializeSession()` already returns `latest` wholesale, so `session.latest.cockpit` is the lowest-risk durable replay slot.

Recommended minimal patch:

- In `reduceDeepPullSteering`, carry `parsed.generatedAt` into each update.
- In `applyDeepSteering`, build one `cockpit` object from the deep update, write it to `session.latest.cockpit`, and emit `coach.cockpit` with `{ cockpit }`.
- Keep `callSummary` untouched. The rolling-summary/digest path owns summary text.
- Keep `dialog` untouched. Reactor/legacy batch dialog still owns the old visible Read/Steer/Try card.

This is not optional. Without this patch, the new cockpit component will either be blind or will be forced to rebuild state from the wrong stream.

#### Client stream typing should ship with WIRE 1

The SSE transport does not require a new endpoint, but the client needs the shape:

- Add `LiveCoachCockpitState` in `apps/web-client/src/lib/liveCoach/stream.ts`.
- Add `latest.cockpit?: LiveCoachCockpitState | null`.
- Add event-level `cockpit?: LiveCoachCockpitState`.
- Leave `LiveCoachEvent.type` open.

This is a type-only bridge. It should not change legacy rendering.

### 8.2 Proof patch shape already validated locally

A narrow local proof patch for WIRE 1 + client typing was applied and tested during this review. Treat this as the reference implementation shape if another agent reworks it:

- `coachBatchRunner.reduceDeepPullSteering` carries `generatedAt`.
- `liveCoachBusService.applyDeepSteering` persists `session.latest.cockpit` and emits `coach.cockpit`.
- `stream.ts` has additive cockpit types.
- `tests/live-coach/coachBatchRunner.test.js` asserts generatedAt survives reducer output.
- `tests/live-coach/coachBatchEndToEnd.test.js` asserts a deep tick emits `coach.cockpit` only for the batch agent and snapshot-replays `latest.cockpit`.

Verification run:

```bash
node --test tests/live-coach/*.test.js
```

Result from this pass: `289/289` live-coach tests passed.

### 8.3 What should not be done in the first client-unblock patch

Do not combine WIRE 1 with any of these unless the client is already rendering against the basic cockpit object:

- Do not restructure the deep schema into section-keyed output.
- Do not add normalized `facts[]` / `taxFacts[]` to `serializeSession` yet. That function is hot and called in broad listing paths.
- Do not rewrite `dialog.say` or batch dialog formatting. Legacy coach cards depend on that string shape.
- Do not add rolling-summary clock behavior in the same patch as WIRE 1 unless it is separately flagged and tested. WIRE 1 unblocks rendering; WIRE 3 creates more data.

### 8.4 Next blockers after the cockpit is visible

#### WIRE 3 - rolling summary sidecar

This is the next real data blocker, but it is a second patch. The current rolling-summary service is good enough to reuse. The missing piece is the loop clock and bus application:

- Add summary cadence to `coachFloorLoop` as a sibling of `tickDeep`, not as logic inside deep.
- Inject `buildSummaryBatch`, `runSummary`, and `applySummary` dependencies.
- Advance the summary cursor only after a successful apply.
- Write only `session.latest.rollingSummary` and `session.memory.rollingSummary`.

Do not let summary own `callSummary` directly in the live cockpit loop. `callSummary` is still end/drain-closeout territory.

#### WIRE 4/5 - script catalog and stable beat ids

These are necessary for a polished script column, but not necessary for the first cockpit paint. Do them after WIRE 1 is proven in the client.

Rules for this pass:

- Keep the rendered `TAX_GROUP_SCRIPT` prompt text byte-stable.
- Add snapshot coverage before changing the source shape.
- Preserve case-sensitive `"4B"`. Do not run section ids through the lowercase `oneOf` helper.
- Add `beatId` to schema and repair together. Because `additionalProperties:false` is active, schema and repair must move in the same patch.

### 8.5 Auditor checklist for the next implementation pass

Before marking the cockpit backend "wired," verify:

- A deep tick produces exactly one `coach.cockpit` event for the intended batch/hybrid session.
- A deterministic-only floor still gates before any model runner is called.
- `bus.getSession(sessionId).latest.cockpit` contains the same state as the emitted event.
- Reconnecting snapshots can render from `latest.cockpit` without replaying old events.
- Terminal sessions do not receive cockpit writes.
- The legacy `dialog` event and `latest.dialog` behavior remain unchanged.
- `node --test tests/live-coach/*.test.js` passes.

Before enabling WIRE 3 later, verify:

- Summary ticks do not overlap.
- Missing runner does not advance the cursor.
- Model failure does not advance the cursor.
- Apply failure is logged and retried without poisoning existing summary state.
- A live call with no new transcript does not create empty summary churn.

### 8.6 Final recommendation

Ship this in two clean backend steps:

1. **Cockpit visibility patch:** WIRE 1 + `stream.ts` types + the end-to-end event/snapshot tests.
2. **Cockpit memory patch:** WIRE 3 summary cadence + summary apply tests.

Only after those two are green should the team do script catalog / beat id binding. That sequencing keeps the first client component from being blocked by model prompt surgery.

---

## 9. Claude implementation pass — WIRE 3 + DEVPATH stub (2026-06-26)

Picked up after Codex's Step-1 (WIRE 1 + `stream.ts` types + tests, 289 green). Completed Codex's
recommended **Step-2 (WIRE 3)** plus the **DEVPATH stub**. All landed default-OFF; **292 live-coach +
103 ai-bus + 5 rolling-summary tests green**.

### 9.1 WIRE 3 — rolling-summary sidecar cadence (DONE)
- **`applyRollingSummaryToSession`** ([liveCoachRollingSummaryService.js:151](../packages/shared-services/src/liveCoachRollingSummaryService.js)) gained a `writeCallSummary` option (default `true` — closeout/drain keeps writing it). The live loop passes `false`, so the digest's `callSummary` is never raced/poisoned. The module's own 5 tests still pass (default path unchanged).
- **`coachFloorLoop.tickSummary`** — a third cadence, sibling of `tickDeep`: `buildSummaryBatch → buildRollingSummaryBatchRequest(cursor) → runSummary → parseRollingSummaryResult → buildRollingSummaryApplyPlan(SAME batch, {batchRequest}) → applySummary → advance cursor`. In-flight guard; cursor advances ONLY after a clean apply (no-runner / model-fail / apply-throw all retry next tick); `no-calls` short-circuits before any model call. Injected deps: `buildSummaryBatch`, `runSummary`, `applySummary`, `summaryIntervalMs` (default 120 000). Exposes `tickSummary` + `getSummaryCursor`.
- **Bus** ([liveCoachBusService.js](../packages/shared-services/src/liveCoachBusService.js)): new `applyRollingSummary(plan)` writeback (iterate applies → live `sessions.get` → skip terminals → `applyRollingSummaryToSession(session, payload, {mutate:true, writeCallSummary:false})` → emit **`coach.summary`** `{rollingSummary}` for live repaint, riding `latest.rollingSummary` for snapshot replay). `startFloorCoach` wires the summary deps and widens the dormancy guard to `!runReactor && !runDeep && !runSummary`.
- **Transport + gate**: `createSummaryTransport` ([coachBatchTransports.js](../apps/ai-bus/src/coachBatchTransports.js)) — substrate selector (`LIVE_COACH_ROLLING_SUMMARY_SUBSTRATE`, default `codex`). `api` is a real, rate-isolated Anthropic-fetch runner on its own key (`LIVE_COACH_SUMMARY_ANTHROPIC_API_KEY`); `codex` returns null + logs (the Codex/OpenAI MCP runner is the intended home and a **documented follow-up seam** — drop it into the same `runSummary` slot). `server.js` gates it behind `LIVE_COACH_ROLLING_SUMMARY_ENABLED` (default-OFF; needs batch on too).
- **Test** (`coachBatchEndToEnd.test.js`): a summary tick fills `latest.rollingSummary` (taxIssues/factsCaptured) and emits `coach.summary`, **proves `callSummary` is NOT overwritten**, the cursor advances (2nd tick = `no-calls`, no 2nd model call), and a no-`runSummary` bus never fires.

### 9.2 DEVPATH — stub transport (DONE); HTTP inject route (deferred)
- **`createStubTransport`** ([coachBatchTransports.js](../apps/ai-bus/src/coachBatchTransports.js), `kind:'deep'|'reactor'`) — a no-spend dev runner that parses the live routing keys (`sessionId/uii/agent`) out of the request prompt and echoes a canned guidance row per active call, so it routes to **whatever real sessions are live** (no fixture-session coupling). `server.js`: `LIVE_COACH_BATCH_TRANSPORT=stub` swaps the paid reactor/deep runners for stubs. Enabling `LIVE_COACH_RUNTIME_MODE_BATCH_ENABLED=1 LIVE_COACH_BATCH_TRANSPORT=stub` + a synthetic session drives the **whole real pipeline** (loop → dispatch/steering → SSE) emitting real `coach.cockpit` + `dialog` events — no keys, no model.
- **Test**: the stub drives `tickDeep`→`coach.cockpit` (with `rec` say + beats) and `tickReactor`→`dialog` (Read/Steer/Try) for the live session.
- **Deferred (optional):** the `POST /api/ai/live-coach/dev/inject` route. The stub transport already gives a working no-spend dev path; the inject route would add on-demand single-state painting but needs a synthetic-session bootstrap — add it if the client dev wants instant, specific states rather than timer-driven canned ones.

### 9.3 Still open (Codex's sequencing — do after the client renders WIRE 1/3)
WIRE 4 (structured `TAX_GROUP_SECTIONS` + `SCRIPT_SECTION_IDS`), WIRE 5 (`beatId` + `currentSection`
enum), WIRE 6 (per-section summary), WIRE 2 (normalized `facts[]`/`taxFacts[]` — still optional), WIRE
7/8, WIRE 10 client cockpit render. The Codex/OpenAI summary substrate is the one follow-up inside
WIRE 3 (swap into the `runSummary` seam).

### 9.4 Adversarial review + fixes (2026-06-26)
A 4-angle adversarial review (cursor/concurrency, callSummary race, prod-safety, integration drift) returned
**fix-then-ship**. Clean-bill (verified holds): default-OFF on both flags, no `callSummary` race, cursor
fail-closed on transient/model/apply failures, single-flight `summaryInFlight`, mid-tick set captured once so
a call ending mid-tick is rejected not misrouted. **Two real bugs were found and FIXED:**
- **Cursor was wholesale-replaced each tick (MAJOR).** `buildRollingSummaryCursorFromApplyPlan` built a fresh
  `{conversations:{}}` from only this tick's applies, so any session the model omitted / the plan rejected /
  that went quiet **lost its cursor and re-sent its entire transcript every tick** (the exact waste the cadence
  prevents). Fix: the builder now takes `{previousCursor, onlySessionIds}` and MERGES onto the prior cursor;
  `applyRollingSummary` returns the sessionIds it actually wrote, and only those advance (also closes the
  terminal-skip note — a session skipped by the writeback no longer advances). Regression tests added.
- **Dev stub had no prod guard (MAJOR).** `LIVE_COACH_BATCH_TRANSPORT=stub` was a pure string compare in every
  env — a leftover var in prod would silently replace the live coach with canned lines. Fix: server gates it on
  `NODE_ENV!=='production'` (+ warns if requested-but-suppressed) AND `createStubTransport` itself returns null
  under production (defense in depth).
- **Deferred (review agreed):** the summary identity gate requires `agentExtension` (reactor/deep don't), so a
  session with a blank extension gets a silent summary no-op. Relax to `sessionId+uii` or add a distinct
  `summary.dropped_no_extension` warning — a design item, not a quick patch (it touches identity resolution).

Post-fix: **403 tests green** (live-coach 292 + ai-bus 103 + rolling-summary 9, incl. 4 new cursor/writeback
regression tests).

## 10. WIRE 4/5/6 — script catalog + beat-id binding + per-section summary (DONE 2026-06-26)
Completed the backend contract so the SCRIPT column + section spine bind cleanly (no fuzzy-matching).
- **WIRE 4** — `taxGroupScript.js` gained `TAX_GROUP_SECTIONS` (`[{id,title,beats:[{id,point,detail}]}]`, the 8 ids `1,2,3,4,4B,5,6,7`) + `SCRIPT_SECTION_IDS`. The prose `TAX_GROUP_SCRIPT` is **byte-identical** (still the live model reference) — the structured catalog is an additive parallel view (nondisruption over the guide's "derive the string" idea).
- **WIRE 5** — `coachBatchRunner` now feeds a compact `SCRIPT BEATS BY SECTION` catalog (id=point per section) into the **deep** system; `DEEP_SHAPE`/schema/repair carry `beatId` per beat; `currentSection` + `priorFlags.section` are enum-clamped to `SCRIPT_SECTION_IDS`; a **case-preserving `clampSection`** keeps `4B` (the lowercasing `oneOf` would have made `4b`). The reactor stays lean (no catalog).
- **WIRE 6** — deep output carries a per-section `summary` (one line on *this* section, not the whole call — the rolling summary owns that); threaded through schema/repair/`reduceDeepPullSteering`/`applyDeepSteering`→`coach.cockpit.summary`. Client type already had `summary?`.
- **Real-pull validated** (`coach-prompt-validate.js`): Opus emitted catalog `beatId`s verbatim (`state_fee_pause`/`anchor_full`/… for 4B), valid sections (4B/2/6, case-preserved), and crisp per-section summaries. **298 live-coach tests green** (+6 new). The cockpit's SCRIPT column can overlay status by `beatId`, the spine selects by section id, every column binds to a stable contract.
