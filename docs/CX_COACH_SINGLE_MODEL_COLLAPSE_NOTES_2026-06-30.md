# Live-Coach → Single-Model / Single-Prompt Collapse — Implementation Notes (2026-06-30)

Goal: collapse the batch coach's **three model lanes + three cadences** down to **one model
(Sonnet 5) on one prompt**, driven by the **existing 1s CX active-call poller** instead of its own
timers. These notes cite how it works *today* so the change is contained.

> Scope: the **batch/floor coach** (`coachFloorLoop` + `coachBatchTransports`), not the separate
> staged-emit transcript coach (tasks 30-42). This is the lane with reactor/deep/summary prompts.

---

## 1. How it works today (cited)

### Three model lanes — `apps/ai-bus/src/coachBatchTransports.js`
- **`createReactorTransport`** ([:109](apps/ai-bus/src/coachBatchTransports.js#L109)) — Haiku 4.5, metered API, **only the live dispatched line.**
- **`createDeepPullTransport`** ([:79](apps/ai-bus/src/coachBatchTransports.js#L79)) — Opus on `claude -p` (Max), produces **cockpit STATE**, not a live line.
- **`createSummaryTransport`** ([:185](apps/ai-bus/src/coachBatchTransports.js#L185)) — Codex substrate, rolling memory compaction.

### Three cadences — `apps/ai-bus/src/server.js:3528-3530`
```
reactorIntervalMs = LIVE_COACH_REACTOR_INTERVAL_MS || 4000   // 4s tick
deepIntervalMs    = LIVE_COACH_DEEP_INTERVAL_MS    || 60000  // 60s
summaryIntervalMs = LIVE_COACH_SUMMARY_INTERVAL_MS || 120000 // 120s
composeDedupWindowMs = 4000
```

### The loop — `packages/shared-services/src/coachFloorLoop.js`
- `start()` ([:256](packages/shared-services/src/coachFloorLoop.js#L256)) sets **three independent `setInterval`s** (reactor/deep/summary), each only if its runner is non-null.
- **`tickReactor`** ([:108](packages/shared-services/src/coachFloorLoop.js#L108)): `buildChanges(cursor)` → **`shouldFireCoach(changes, REACTOR)`** gate ([:113](packages/shared-services/src/coachFloorLoop.js#L113)) → only then `runReactor(req)` → dispatch+emit. `reactorInFlight` guard ([:109](packages/shared-services/src/coachFloorLoop.js#L109)) prevents overlap; cursor advances only after an accepted+dispatched pass.
- **`tickDeep`** ([:147](packages/shared-services/src/coachFloorLoop.js#L147)): builds the batch, gates, runs Opus → **`reduceDeepPullSteering(parsed)` → `applySteering(updates)`** ([:174](packages/shared-services/src/coachFloorLoop.js#L174)). It writes `session.callStrategy` + cockpit (currentSection/beats/remember/says/priorFlags) and **does NOT emit** — "the reactor owns the live say" (comment at :172).

### VERIFIED pacing (this was the open question)
**The reactor is NOT once a second.** It's a **4s tick that is change-gated** — `shouldFireCoach`
returns `fire:false` when there's no active call or no meaningful change since the cursor, so on a
quiet line **zero** model calls fire. Realistic rate during active talk ≈ a few to ≤15/min, not 1/s.

### The 1s CX poller (the clock you want) — `apps/control-plane/src/server.js`
- **`startCxAccountActiveCallWatcherWorker`** ([:1154](apps/control-plane/src/server.js#L1154)), interval `CX_ACCOUNT_ACTIVE_CALL_WATCHER_INTERVAL_MS || 1_000` ([:1156](apps/control-plane/src/server.js#L1156)) → **1s tick**.
- It does **one account-level RingCX active-call read per tick** (not one per agent) and already resolves which calls/UIIs/agents are live (current-call projection for the bulk rail). Logs `control-plane.cx_account_active_call_watcher.tick` ([:1198](apps/control-plane/src/server.js#L1198)).

---

## 2. Why the long tail exists (the thing the collapse removes)

The three lanes are **scaffolding around Haiku's context-poverty**, not fundamental:
- The **deep pull** exists to periodically re-establish strategic state (currentSection/beats/play) and feed it to the reactor, because **Haiku can't hold the whole call** — it reacts to the latest change in near-isolation.
- The **summary** exists to compact memory so the cheap lanes don't drown in transcript.

A **single Sonnet 5 holding the call in cached context never loses the thread**, so:
- The periodic deep **re-read is redundant** — nothing to re-establish.
- The rolling **summary is unnecessary** for a single call (~5-15k tokens fits).

---

## 3. The collapse — one model, one prompt, CX-poller-driven

### 3a. One model / one prompt
- Replace the three runners with **one Sonnet 5 streaming-API runner**. Keep the `coachBatchRunner` request/parse contract (`buildBatchGuidanceRequest`/`parseBatchGuidance`) — just one tier.
- The single prompt's **output carries both layers**, decided by the model per check:
  - always: the live line (or "stay silent");
  - when the model detects a phase-shift: the strategic re-orient (what today's `reduceDeepPullSteering` produces).
- So `tickDeep`'s separate state pass disappears; the strategic state becomes a field the one prompt emits when warranted, and it's applied via the existing `applySteering` writeback (keep that seam — the cockpit still wants the state).

### 3b. Fan out off the 1s CX poller every N ticks (your idea — do NOT call the coach at 1s)
The coach cadence must NOT equal the poll cadence. The poller already does the expensive work (the
1s account read + matching live calls → sessions); the coach just **fans out off that match every Nth
tick** via a counter — no second timer, no second "who's live" computation.

Inside the `cxAccountActiveCallWatcher` tick ([control-plane server.js:1154](apps/control-plane/src/server.js#L1154)), AFTER it has matched active calls → sessions:
```js
tickCount++;
if (tickCount % COACH_TICK_DIVISOR === 0) {     // default 4 -> ~4s; env LIVE_COACH_TICK_DIVISOR
  const coachable = matchedActiveCalls.filter(c => c.coachSessionId && c.hasNewSpeech);
  for (const call of coachable) setImmediate(() => updateCoach(call)); // FAN OUT, never awaited inline
}
```
- **Divisor decouples cadence from poll.** `=4` → detect ~4s (matches today's reactor); dial to 8/10 without touching the 1s poll.
- **Fan out non-blocking.** The poller tick is latency-critical (it projects the live UII into the middle card — the §5 path). `updateCoach` MUST be `setImmediate`/queued, **never `await`ed inline**, so the coach rides the poller's *result* and adds 0ms to the poller's own path.
- Fixes a structural smell: today the coach's "which calls are live" (its gate) and the CX rail's "which calls are live" (the watcher) are computed **twice, separately**. This makes the watcher the one source of truth.

### 3b-1. PRIMARY design: one Sonnet 5, growth-gated, mostly cached (Sonnet self-gates)
The model is its own detector. Fire ~every 10s (`COACH_TICK_DIVISOR=10`) but **only if the transcript
grew** since the last call; the prompt is **entirely cached except the new transcript delta**; Sonnet
reads the new speech and decides "coach or stay quiet" itself.
```js
async function updateCoach(call) {
  const session = getSession(call.sessionId);
  // WARM-UP: stay silent for the first 3 min — skips the opening/rapport AND filters the short-call
  // tail (no-answers/quick-hangups never reach 3 min, never get coached). Duration comes from the
  // COACH SESSION clock (session.createdAt, liveCoachBusService.js:1165), NOT the poller — the poller's
  // only time field (dequeueTime) is unreliable/often-null. First call past the gate reads the whole
  // cached transcript-so-far, so it catches up on the opening; it loses early EMITS, not context.
  if (now - Date.parse(session.createdAt) < COACH_WARMUP_MS) return;    // COACH_WARMUP_MS = 180_000
  if (!transcriptGrewSince(call.sessionId, call.lastCoachAt)) return;   // free string-length gate; skip silence
  const res = await runUnified(buildReq(call));   // [cached reference]+[cached transcript]+[new delta] -> Sonnet decides
  if (sessionCurrentUii(call.sessionId) !== call.uii) return;
  if (parse(res).say) emitGuidance({ sessionId: call.sessionId, uii: call.uii, ...parse(res) }); // may be "stay silent"
}
```
The 3-min warm-up is the time-based sibling of the existing engagement gate (task #12) and feeds the
coachState `phaseLane` (5-min phase model, task #40). It pulls the ~$400 estimate toward ~$250-300.

**First-engagement behavior (the 3-min orient + phase audit):** STT runs continuously, so the full
opening transcript exists by min 3. The first `updateCoach` prompt = [reference] + [full transcript] +
[phase + `pendingSteps`]. The phase checklists + recovery are ALREADY ENCODED in
`packages/shared-services/src/coachPhaseSteps.js` (phases intro→discovery→expert→pitch→payment→info→close;
"phase 1" = intro+discovery: identify self/firm/prospect + balance/unfiled/collection-status/income/
ability-to-pay). `recognizeSteps`+`capturedFacts` → `pendingSteps(phase, done)` ([:114]) is the orchestrator
input ("you haven't named the firm yet"). So the first pass: orient → audit the phase you should have
finished → push the missing essentials → coach forward. `phaseLane` gives the *time* expectation,
`pendingSteps` the *completion* reality; the gap is the signal. CAVEAT: the spine is demo-grade + unwired
and the `STEP_MARKERS` regexes ([:63]) are first-pass — wire it + tune markers against real transcripts.
- **Cost ~$400/mo** at 500 call-hrs (every-10s, growth-gated). Only the transcript delta is fresh tokens; reference + prior transcript are cache-reads.
- **Why this over a deterministic signal layer:** (a) RECALL — Sonnet reading the whole transcript catches subtle moments (hesitation, tone, buried objection) a keyword `signalExtractor` would miss; (b) MAINTENANCE — one prompt to own, no detector to tune/keep-in-sync. Don't pre-decide *what's coachable* with regex.
- Single-flight-per-session, dedup + compliance brakes still live inside `updateCoach`, off the hot path.

### 3b-1b. OPTIONAL cost lever (only if ~$400 hurts at scale) — pre-filter to skip "nothing happening" calls
If volume makes $400/mo painful, bolt a cheap pre-filter in FRONT of the Sonnet call so it only fires
on likely-coachable deltas (the existing `signalExtractor`/`phaseMachine` spine, deterministic, $0):
```js
if (!likelyCoachable(call)) return;   // optional: cuts ~80-90% of calls -> ~$80-125/mo
```
- Drops cost ~5x (writes scale with coachable moments, not ticks: ~25k writes/mo = Sonnet 5 ≈ $83).
- TRADEOFF: the pre-filter can MISS subtle moments Sonnet would catch — you buy money with recall. Add it ONLY after the few-days bill proves you need it; do not build preemptively.

### 3b-2. Resolve → deliver → staleness guard (the async round-trip)
`updateCoach` is fire-and-forget off the tick, so the result returns OUT OF BAND ~1-2s later — it does
**NOT** come back to the spawning tick. Delivery is **session-keyed, not tick-keyed**: the call's
`{sessionId, uii}` is captured in the closure at fan-out, and on resolve the line is emitted through the
bus's `sessionId → agent SSE/cockpit` channel (`emitGuidance`, [coachFloorLoop.js:85](packages/shared-services/src/coachFloorLoop.js#L85)).

CRITICAL guard: by resolve time the call may have ended or advanced to the next UII. Emitting against
the 2s-stale UII would coach a dead call or **misroute onto the now-current call (the 2026-06-17
false-projection class).** So re-validate against CURRENT truth before emit:
```js
async function updateCoach(call) {
  const targetUii = call.uii;                                   // captured at fan-out
  const res = await runUnified(req);                            // ~1-2s, out of band
  if (sessionCurrentUii(call.sessionId) !== targetUii) return;  // call moved on -> DROP, do not misroute
  emitGuidance({ sessionId: call.sessionId, uii: targetUii, ...parse(res) });
}
```
The re-check is free — the 1s poller keeps the current-call projection fresh, so `sessionCurrentUii`
is just reading the watcher's latest result. This is the same reject-on-mismatch the current design
already does via `buildDispatchPlan(activeBatch, response)` + `rejectedCount` (cf. the summary tick's
"a call that ends mid-tick is rejected, not misrouted", [coachFloorLoop.js:200-202](packages/shared-services/src/coachFloorLoop.js#L200)). Net: the result returns to **now's current-call
truth**, never to the tick that spawned it.

### 3c. What you KEEP (none of it is "the long tail")
- **`shouldFireCoach`** change/active gate ([coachFloorLoop.js:113](packages/shared-services/src/coachFloorLoop.js#L113)) — but fed by the poller's active set.
- **`reactorInFlight`-style single-flight guard** — a 1s tick must never overlap a slower model call.
- **`composeDedupWindowMs` + the per-minute compose cap + the compliance pre-filter** — the brakes that stop one chatty model from over-talking.
- The **deterministic state spine** (`phaseMachine`/`signalExtractor`/coachState — the coach-state-contract work) as **cheap prompt context** into the one Sonnet 5. This *aligns*: deterministic tracking in, one feedback line out.
- The **injected-runner seam** in `coachFloorLoop` (`runReactor`/`runDeep` are injected) — keep it so the one runner can A/B models and do the **API↔claude-p Max failover** (burn the $200 pool first, then metered API; see `reference_coach_model_economics`).

---

## 4. Migration (incremental, default-off)

1. **Add a single-model runner** to `coachBatchTransports` (`createUnifiedTransport`) = streaming Sonnet 5 API, thinking off (`effort:low`), prompt-cached reference+transcript. Returns the same `{ok,json,text}` contract.
2. **Add a unified-tick path** to `coachFloorLoop` behind a flag (`LIVE_COACH_UNIFIED=1`): one `tickUnified` that does `buildChanges → shouldFireCoach → runUnified → (emit line) + (applySteering when state present)`. Leave the 3-lane path intact for rollback.
3. **Wire the tick to the CX poller**: have `startCxAccountActiveCallWatcherWorker`'s tick (or a thin subscriber to it) call `tickUnified(activeSet)` instead of `coachFloorLoop` owning its timers. Keep the floor-loop's own `setInterval` as a fallback when the poller isn't the driver.
4. **Default-off → pilot one agent** (the runtime-mode allow-list already gates per agent), measure, then widen.
5. Once stable, retire `createDeepPullTransport` + `createSummaryTransport` + their cadences from the wiring (leave the code until the pilot proves out).

---

## 5. Risks / open

- **Per-turn cost of the unified prompt**: it does more than the old lean reactor. If the few-days API bill is high, split into a lean frequent pass + an occasional re-orient pass — **both on the same cached-context Sonnet 5** (the re-orient is a cache-hit with a different output instruction), not a second model. Decide AFTER the bill.
- **Single-flight under a 1s clock**: a Sonnet 5 call (~1.3s TTFT, ~2.4s full) can straddle two 1s ticks — the in-flight guard must drop the overlapping tick, not queue it.
- **State writeback timing**: today deep writes state every 60s; if the unified prompt only emits state on phase-shift, make sure the cockpit still gets a baseline state early in the call (emit state on the first check).
- **Two callers of the active set**: confirm the coach reading the poller's active set doesn't add latency to the poller's own (latency-critical) current-call projection — subscribe to its result, don't block it.

---

## 6. Current → Target diff + change plan (code-mapped 2026-06-30, 6 parallel readers)

### 6.0 Two realities the diff surfaced (the design above glossed these)
1. **CROSS-PROCESS.** Poller = control-plane :5001 (`startCxAccountActiveCallWatcherWorker`, [server.js:1154](apps/control-plane/src/server.js#L1154)). Coach bus + cockpit SSE = ai-bus :7000 (`createLiveCoachBus`; `emit(sessionId)` [liveCoachBusService.js:1070](packages/shared-services/src/liveCoachBusService.js#L1070), SSE endpoints ai-bus server.js ~:4150). The poller cannot call the coach in-process → see decision 6.2.
2. **The coachState spine is UNWIRED.** `coachSignalExtractor`/`coachPhaseMachine`/`coachPhaseSteps`/`coachState` + driver `coachOrchestrator` have **zero `apps/` imports** (only tests + `scripts/coach-demo-replay.js`). "Keep the spine" = "newly WIRE it." `coachOrchestrator` is the *realtime/staged-emit* coach (tasks 30-42), distinct from the batch coach (`coachFloorLoop`); its regex match-bank self-labels "demo/first pass" — validate before trusting (it's the optional pre-filter anyway).

### 6.1 Per-subsystem diff (cited)
| Subsystem | KEEP | MODIFY | DELETE | ADD |
|---|---|---|---|---|
| **Transports** (`coachBatchTransports.js`) | `createReactorTransport` (template/fallback); the `{ok,json,text,usage}` contract | stub: add a `unified` kind | `createDeepPullTransport`, `createSummaryTransport` (+ server.js:3494/3497 sites, runSummary.stop() :4596) | **`createUnifiedTransport`** = streaming Sonnet 5 API, thinking off, prompt-cached, metered key |
| **Floor loop** (`coachFloorLoop.js`) | `shouldFireCoach` gate ([coachBatchRunner.js:561]), `reduceDeepPullSteering`, single-flight guards (:73-75), cursor-after-dispatch | factory exposes `tickUnified` not tick{Reactor,Deep,Summary}; one injected `runUnified` | `tickDeep` (:147-189), `tickSummary` (:196-254), their flags/cursors, the 3 setInterval branches in start() (:256-282) | `tickUnified(activeSet)` (growth-gated, single-flight) + `unifiedInFlight` + lastCoachAt/len cursor |
| **Bus assembly** (`liveCoachBusService.js` + ai-bus server.js) | `emitBatchGuidance` (:3152), `applyDeepSteering` (:3186), `buildActiveLiveCoachChangeSet`/`buildBatch`, injected-runner seam | `batchModelRunners` 3→1 (server.js:3483); `floorCoach` config drops deep/summaryIntervalMs (:3526-3530); startFloorCoach liveness 3→1 (:3254); inject 1 runner (:3262) | `runDeep`/`runSummary`/`buildSummaryBatch`/`applySummary` (`applyRollingSummary` :3271) injection | `LIVE_COACH_UNIFIED` flag branch; `LIVE_COACH_TICK_DIVISOR` |
| **CX poller** (control-plane server.js + `cxAccountActiveCallWatcherService.js`) | the 1s interval, re-entrancy/mongo guards (:1168/:1170), `runCxAccountActiveCallWatchOnce` + projection shape (already carries session↔call↔UII↔agent, :427+) | — | the 3 coach setInterval lanes (now poller-driven) | tick counter + every-`DIVISOR`-ticks fan-out off the **RAW** result (:1184, NOT the summarized one which strips `projections[]` at :1185); `setImmediate(.catch!)` push to coach |
| **coachState spine** | all 4 pure reducers unchanged | rework `coachOrchestrator` per-turn-Haiku → feeds the unified prompt as context | — | optional `likelyCoachable()` pre-filter; **first wiring** into the live path |
| **Emit/dispatch** (`liveCoachBusService.js`) | session-keyed channel: `emit` (:1070), `subscribe` (:3114), subscribers Map (:857), SSE endpoints | collapse `emitBatchGuidance` into a per-call emit | DEEP+SUMMARY emit/apply lanes (`applyDeepSteering` cockpit emit :3221, `applyRollingSummary` :3230) | **emit-time uii re-check** (read FRESH `session.currentUii` after the await; right key per `callIdentityKeys` :179-199) |

### 6.2 The one decision: where does `updateCoach` run?
- **Option A (recommended) — coach stays in ai-bus, poller pushes.** Every `DIVISOR` ticks the control-plane poller POSTs the **raw** matched active-set to an ai-bus endpoint; ai-bus runs `tickUnified`. Keeps the coach next to the session state + SSE channel; cost is one small ~1-per-10s cross-process call.
- **Option B — coach moves to control-plane.** Runs in-process with the poller but still has to reach the ai-bus SSE to paint the cockpit → same cross-process hop, reversed, plus it splits the coach state across processes. Worse.

### 6.3 Sequenced plan (default-off, rollback-safe — do NOT delete the 3-lane path until the pilot proves out)
1. **ADD** `createUnifiedTransport` (streaming Sonnet 5, metered key, contract-identical).
2. **ADD** `tickUnified` to `coachFloorLoop` behind `LIVE_COACH_UNIFIED` — leave `tickDeep`/`tickSummary` intact (that's the rollback).
3. **ADD** the emit-time uii re-check (fresh read, correct identity key).
4. **ADD** baseline-state emit on the first check (today `tickDeep` seeds cockpit state every 60s; unified must seed at call-open or the cockpit stays blank).
5. **WIRE** the driver (Option A): poller → every-`DIVISOR` raw-result ticks → `setImmediate(.catch())` → POST active-set → ai-bus `tickUnified`. Keep the ai-bus fallback `setInterval`; single-flight drops the overlap if both fire.
6. **PILOT** one agent (runtime-mode allow-list; reconcile `batchModeSessions` :3246 with the poller's active-set).
7. **MEASURE** the few-days bill, then **RETIRE** deep+summary transports/lanes + the rolling-summary writeback.

### 6.4 Consolidated risks
- **Unhandled-rejection crash**: the `setImmediate` fan-out is never awaited — every `updateCoach` MUST `.catch()` or a coach error takes down the control-plane process.
- **Raw-vs-summarized result**: fan out off the RAW poller result (:1184); the summarize step (:1185) strips the `projections[]` the coach needs.
- **Stale uii at emit**: re-check must read the LIVE session fresh on the ai-bus side after the Sonnet await — not the snapshot the poller pushed; `uii` identity is fuzzy (`metadata.uii` vs binding vs queueItemId).
- **No cockpit baseline state** if the unified prompt only emits state on phase-shift (mitigated by step 4).
- **Summary deletion** drops the rolling-memory writeback — fine if the transcript fits in cache; verify for unusually long calls.
- **Spine is first-wire** and demo-grade — only rely on it for the optional pre-filter, after validation.
