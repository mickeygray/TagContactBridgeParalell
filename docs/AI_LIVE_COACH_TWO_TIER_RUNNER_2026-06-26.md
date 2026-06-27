# Live Coach — Two-Tier Batch Runner (groundwork) — 2026-06-26

Author: Claude. Status: pure seam built + tested (unwired, zero blast radius). This
is the work log for the whole-floor two-tier coach runner that sits between the
services Codex built today (`AI_LIVE_COACH_ACTIVE_BATCH_OBJECT_2026-06-26.md`).

## The whole space (IN → COACH → OUT → DRAIN)

```
RingCX audio / gRPC
  → STT (provisional deltas + VAD finals)
  → liveCoachBus.appendInput()            session.memory arrays grow
  ───────────────────────────────────────────────────────────────── IN
  → buildActiveLiveCoachBatch()           conversations[]            (full, ~once/min)
  → buildActiveLiveCoachChangeSet()       changedConversations[] + activeConversationCount + hasChanges (cheap, 2–5s)
        liveCoachBatchProjectionService.js  (pure projector — Codex)
  ───────────────────────────────────────────────────────────────── COACH  ← THIS GROUNDWORK
  → coachBatchRunner.buildBatchGuidanceRequest()   {system(cached ref+contract), prompt(live calls), schema}
  → <model>  (DEEP_PULL = Opus on claude -p/Max pool ;  REACTOR = Haiku on a separate metered Anthropic key)
  → coachBatchRunner.parseBatchGuidance()          live-coach.batch-guidance.v1  { guidance[] }
  ───────────────────────────────────────────────────────────────── OUT → CLIENT
  → buildLiveCoachGuidanceDispatchPlan(batch, parsed)   dispatches[] / rejected[]   (routes per agent — Codex)
        liveCoachBatchGuidanceDispatchService.js
  → SSE  /api/ai/live-coach/dashboard/sessions/:id/events
  ───────────────────────────────────────────────────────────────── DRAIN (separate from live UI)
  on terminal/ended:  closeoutWorker.enqueue(serializeSession(session))
        → liveCoachCloseoutService.js   (persist + grade)
  steering writeback:  reduceDeepPullSteering(parsed) → session.callStrategy / session.callSummary
        (callSummary is also what the rolling digest scribe maintains and what the drain reads)
```

## What Codex already built (do not rebuild)

| Concern | Function | File |
| --- | --- | --- |
| IN — full batch | `buildActiveLiveCoachBatch` | liveCoachBatchProjectionService.js |
| IN — cheap loop + **gate signals** | `buildActiveLiveCoachChangeSet` → `activeConversationCount`, `hasChanges`, `changedConversations[]`, `endedConversations[]`, caller-owned `cursor` | same |
| "active" definition | `shouldIncludeSession` (not terminal: stopped/stale/voicemail_rejected/released/pruned; not idle >10min; gRPC source) | same |
| OUT — **divide** | `buildLiveCoachGuidanceDispatchPlan` + `resolveGuidanceTarget` (sessionId → uii must match → agentEmail must match; uii-only routes iff exactly one match; empty/ambiguous/stale → rejected) | liveCoachBatchGuidanceDispatchService.js |
| Routes | `GET grpc/active-conversation-batch`, `POST grpc/active-conversation-changes`, `POST grpc/batch-guidance-dispatch-plan` | apps/ai-bus/src/server.js:4193–4214 |
| DRAIN | `closeoutWorker.enqueue` / closeout, rolling digest (`session.callSummary`), call grader | liveCoachBusService.js + liveCoachCloseoutService.js |

The **only** gap was the model runner: `conversations[]` → `batch-guidance.v1`. That is this file's deliverable.

## What this groundwork added — `packages/shared-services/src/coachBatchRunner.js`

Pure (no model call, no DB, no session mutation). One batch contract, two tiers:

- `buildBatchGuidanceRequest(batchOrChangeSet, { tier, reference })` → `{ system, prompt, schema, tier, conversationCount }`.
  - **Cache discipline:** `system` = tier instruction + the stable coach **reference** + output contract → set the cache breakpoint at its end. `prompt` = the live calls (volatile) → after the breakpoint. This is the cacheable-prefix win.
  - **DEEP_PULL** (Opus, ~once/min, full `conversations[]`): strategic — sets the spine (phase/completed/next) + refreshes the steering (strategy/summary). Schema includes `strategy`+`summary`.
  - **REACTOR** (Haiku, cheap-loop, `changedConversations[]` only): fast — reacts to the latest turn, **aimed by** the `callStrategy`/`callSummary` already on the projection. No separate steering channel — it rides the projection fields.
- `parseBatchGuidance(res)` → `live-coach.batch-guidance.v1` (robust to fenced JSON strings). Exactly the `modelResponse` shape the dispatch plan consumes.
- `shouldFireCoach(changeSet, { tier })` → **THE GATE.** Never fires when `activeConversationCount === 0` ("no one on the phone"). REACTOR additionally requires `hasChanges`; DEEP_PULL fires on its clock whenever any call is live.
- `reduceDeepPullSteering(parsed)` → per-session `{ sessionId, uii, callStrategy, callSummary }` writeback — closes the two-tier loop (deep writes steering → projection carries it → reactor + drain read it).

## Proof (tests/live-coach/coachBatchRunner.test.js — 7 green)

The tests run our output through Codex's **real** projector and **real** dispatch plan, not copies:
- reference sits in the cached system; the live turn does **not** leak into it.
- deep vs reactor schema/render differ correctly.
- **DIVIDE:** parsed guidance → `buildLiveCoachGuidanceDispatchPlan` → Sean's row lands on coach-A/uii-A, Dana's on coach-B; a uii-mismatch and a ghost session are rejected (`uii-mismatch`, `session-not-active`).
- **GATE:** empty floor → no fire (either tier); steady (no-change) tick → reactor quiet, deep still allowed.
- steering reduces to a per-session writeback; fenced-JSON parse is robust.

## Wiring plan (NOT built yet — the next increment)

```
cheap loop (every 2–5s):
  changes = POST /grpc/active-conversation-changes { cursor }
  gate = shouldFireCoach(changes, { tier: REACTOR })
  if (!gate.fire) { save changes.cursor; continue }          // ← stop firing if no one's on the phone / nothing changed
  req  = buildBatchGuidanceRequest(changes, { tier: REACTOR, reference })
  res  = haikuRunner(req)                                     // separate metered Anthropic key (rate-limit isolation)
  plan = POST /grpc/batch-guidance-dispatch-plan { response: parseBatchGuidance(res) }
  deliver plan.dispatches[] over SSE ; save changes.cursor

deep clock (every ~60s, two-clock: also on a stakes flag):
  batch = GET /grpc/active-conversation-batch
  if (!shouldFireCoach(batch, { tier: DEEP_PULL }).fire) continue
  res  = opusRunner(buildBatchGuidanceRequest(batch, { tier: DEEP_PULL, reference }))   // claude -p / Max pool
  parsed = parseBatchGuidance(res)
  applySteering(reduceDeepPullSteering(parsed))              // writeback → sessions → next projection + drain
  deliver dispatch-plan(parsed) guideposts over SSE
```

Open wiring items: the two model runners (injected transport — Opus/Max + Haiku/metered), `applySteering` reducer onto live sessions, and `endedConversations[]` → closeout (drain) hand-off (ended calls are **not** live dispatch targets — Codex's rule, already honored by the gate + the dispatch's `session-not-active` reject).

## WIRED END-TO-END (2026-06-26, default-OFF)

The loop is now connected through the live bus behind a default-off runtime mode. With the flag unset, nothing changes — the per-turn deterministic path is byte-identical.

**New modules (all tested):**
- `packages/shared-services/src/liveCoachRuntimeModeService.js` — `resolveLiveCoachRuntimeMode({agentEmail}, env)` → `deterministic|batch|hybrid`. Default `deterministic`; batch/hybrid degrade to default unless `LIVE_COACH_RUNTIME_MODE_BATCH_ENABLED`. Mirrors `cxDialRuntimeModeService`.
- `packages/shared-services/src/coachFloorLoop.js` — pure orchestrator: `tickReactor`/`tickDeep` (gate → request → injected runner → parse → dispatch-plan → emit; deep also applies steering), in-flight guards, cursor advances only after an accepted+dispatched pass, injected scheduler.
- `apps/ai-bus/src/coachBatchTransports.js` — `createDeepPullTransport` (Opus on `claude -p`/Max via `claudeAgentRunner`) + `createReactorTransport` (Haiku on a **separate** `LIVE_COACH_REACTOR_ANTHROPIC_API_KEY`; null if unset — never falls back to the shared key).

**Bus integration (`liveCoachBusService.js`):** new options `batchModelRunners` / `resolveRuntimeMode` / `floorCoach` (all default null). Inside the closure: `emitBatchGuidance` composes the dispatch delta into the `dialog` event both cockpits already render (`Read:/Steer:/Try:`) and routes it to that agent's session stream (per-agent gated, terminal-skipped, sets `latest.dialog` for snapshot replay); `applyDeepSteering` writes **`callStrategy` only** (callSummary stays digest-owned); `batchModeSessions()` filters the loop's input to batch/hybrid agents so a deterministic floor never fires the model; `startFloorCoach`/`stopFloorCoach` on the public API. `requestDialogComposition` skips the per-turn composer for `batch`-mode agents (mutual exclusion); default resolver → never skips.

**Server (`apps/ai-bus/src/server.js`):** transports + resolver + reference built only when `LIVE_COACH_RUNTIME_MODE_BATCH_ENABLED`; loop started after construction; stopped in `shutdown()` next to the stale-sweep timer.

**Bug fixed (exposed by the integration):** `liveCoachBatchProjectionService.transcriptRow` crashed on a real session's `latest.transcript=null` (the `row={}` default doesn't catch `null`). One-line guard `if (!row) return null;` — behavior-preserving for every non-null input.

**Proof:** `tests/live-coach/coachBatchEndToEnd.test.js` boots the real bus, pushes synthetic transcripts, flips one agent to `batch`, drives a tick through a fake transport, and asserts batch guidance reaches that agent's SSE subscriber while the deterministic agent gets nothing and the default-off bus stays dormant. Full live-coach suite: **272 green.**

**Env flags:** `LIVE_COACH_RUNTIME_MODE_BATCH_ENABLED` (master gate), `LIVE_COACH_RUNTIME_MODE_AGENT_OVERRIDES` (`email:batch,...`), `LIVE_COACH_RUNTIME_MODE_DEFAULT`, `LIVE_COACH_REACTOR_ANTHROPIC_API_KEY` (separate metered key), `LIVE_COACH_REACTOR_INTERVAL_MS` (4000), `LIVE_COACH_DEEP_INTERVAL_MS` (60000), `LIVE_COACH_DEEP_MODEL` (opus), `LIVE_COACH_REACTOR_MODEL` (claude-haiku-4-5).

**Still open (next):** `endedConversations[]` → closeout drain hand-off; the hybrid-mode `latest.dialog` race (batch + per-turn both write it — fine in pure `batch` mode which skips the composer); a real floor smoke against a booted ai-bus with real keys.
