# CX Bulk-First Unification Prep Audit - 2026-06-24

## Purpose

This is the narrow, code-grounded audit for the next CX rewrite step.

The goal is not to add another patch on top of bulk mode. The goal is to identify the exact code surfaces that matter, separate the single-purpose pieces, and define the rewrites/tests needed to make bulk the first landing place for the universal rail model:

```text
lead pool -> rail policy -> RingCX publish -> account active-call watcher
  -> current-call projection -> terminal intent/outbox -> drain
```

The existing broader plan is still the strategy document:

- [CX_RAIL_UNIFICATION_PLAN_2026-06-23.md](C:/code/TagContactBridgeParalell/docs/CX_RAIL_UNIFICATION_PLAN_2026-06-23.md)
- [CX_DIAL_RAIL_FINALIZATION_PLAN_2026-06-23.md](C:/code/TagContactBridgeParalell/docs/CX_DIAL_RAIL_FINALIZATION_PLAN_2026-06-23.md)
- [CX_DUAL_RAIL_CLEAN_CODE_PLAN.md](C:/code/TagContactBridgeParalell/docs/CX_DUAL_RAIL_CLEAN_CODE_PLAN.md)

This document is the implementation audit: what code exists, what each file currently owns, what should be rewritten, and what tests must prove before the next floor trial.

## Relevant Code Map

### Client Mode Router

File: [CXWorkspaceRouter.tsx](C:/code/TagContactBridgeParalell/apps/web-client/src/workspaces/cx/CXWorkspaceRouter.tsx)

Current responsibility:

- Reads `VITE_CX_WORKSPACE_MODE`.
- Chooses `legacy_emergency`, `slow_single`, or `bulk_load`.
- This is a good coarse rollback switch.

Rewrite stance:

- Keep this as the build-level rollback switch for now.
- Do not add business logic here.
- Long term, this should choose a rail policy or workspace controller, not three unrelated brains.

### Bulk Client Workspace

File: [CXWorkspaceBulkLoad.tsx](C:/code/TagContactBridgeParalell/apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx)

Important current surfaces:

- Lines 1-99: imports legacy workspace hooks, simple-loop hooks, bulk hooks, lookup hooks, appointment hooks, coach, and side-panel utilities into one file.
- Lines 3806-3885: still initializes legacy queue data plus simple-loop session/watch logic.
- Lines 3936-3960: initializes bulk session/watch/disposition/skip/kill hooks.
- Lines 4309-4354: mirrors `bulkCurrent` into legacy-ish `selected`, `form`, and served queue state.
- Lines 4356-4394: browser-driven 1 second POST `/watch` mutation loop.
- Lines 5460-5527: terminal button handler sends `/bulk-load/disposition`, clears center state, then refetches.
- Lines 5921-5935: simple-loop panel can still render inside the bulk workspace.
- Lines 6079-6169: bulk terminal buttons are rendered directly in this large workspace.

What works:

- The UI uses `bulkCurrent` as the active call source while bulk is running.
- It blocks legacy lookup/form overwrite while bulk is running.
- It has a visible "finishing/loading next lead" transition.
- Button clicks go through one bulk disposition command.

What is not clean yet:

- This file is 6,353 lines and still carries legacy queue serving, simple-loop harness, dial-any, next-call handoff, phone lookup, and form enrichment code.
- Bulk state is projected into old `selected/form/servedQueue*` state instead of a small rail-current DTO.
- Browser code still drives active-call observation with a mutation endpoint.
- The bulk workspace imports `useCxBulkLoadStart` nowhere, so local/floor setup depends on external scripts or server-side prebuilds rather than the workspace owning an explicit start/preload action.
- `bulkBlockedReason` exists but is effectively only reset in the inspected paths; the retry counters clamp but do not appear to produce a clear actionable pause state.

Rewrite stance:

- Do not keep growing this component.
- Extract a rail-neutral `CallRailShell` presentational component that receives:
  - current call projection
  - pending buffer projection
  - terminal button state
  - transition overlay state
  - side-panel case identity
- Keep bulk's controller small: query projection, send terminal command, render shell.
- Remove simple-loop UI/harness from bulk workspace before calling bulk ready for floor.
- Keep Logics enrichment out of middle-panel identity. It can load side panels after `caseId/domain` are known.

### Bulk Client API Hooks

File: [cxBulkLoad.ts](C:/code/TagContactBridgeParalell/apps/web-client/src/lib/api/queries/cxBulkLoad.ts)

Current responsibility:

- Reads `/api/cx/bulk-load/session` every 1s.
- Provides command hooks for `start`, `watch`, `disposition`, `skip`, and `kill`.

What works:

- The response shape is narrow enough to use as a projection seed.
- Query invalidation is simple.

What is not clean yet:

- `watch` is modeled as a client mutation, which makes the browser part of active-call truth.
- Session polling and watch mutation both exist, which creates avoidable HTTP churn.

Rewrite stance:

- Keep `session` as read-only.
- Retire client `watch` after account watcher worker is authoritative.
- Add a rail projection query, or add `projection` beside the raw session response.

### Bulk HTTP Routes

File: [cxBulkLoad.js](C:/code/TagContactBridgeParalell/apps/control-plane/src/routes/cxBulkLoad.js)

Current responsibility:

- Thin route layer for session/start/watch/disposition/skip/kill.
- Auth -> command -> sanitized result.

What works:

- This route layer is appropriately boring.

Rewrite stance:

- Keep routes thin.
- When active-call watch becomes worker-owned, remove or quarantine `/watch` from client use.
- Add no call-state decisions here.

### Bulk Session Model And Repository

Files:

- [CxBulkLoadSession.js](C:/code/TagContactBridgeParalell/packages/shared-models/src/CxBulkLoadSession.js)
- [cxBulkLoadSessionRepository.js](C:/code/TagContactBridgeParalell/packages/shared-repositories/src/cxBulkLoadSessionRepository.js)

Current state:

```js
status
phase
agentEmail
agentExtensionId
cxAgentId
domain
ringcx
current
acceptedBuffer
prevActiveExternIds
completed
stats
trace
events
lastOutcome
lastError
```

What works:

- `acceptedBuffer/current/completed` matches the universal state idea.
- `prevActiveExternIds` is the right basis for detecting calls that appeared and disappeared between watcher ticks.
- Repository is thin and mostly dull.

What is not clean yet:

- `completed` is an in-session display/debug history. The per-session bulk watcher now writes a terminal observation for RingCX-proven released UIIs before reducing to completed, but account-watcher apply still needs the same writer before it can become authoritative.
- `prevActiveExternIds` and `trace.prevActiveCalls` are watcher memory stored on the session. That is useful for now, but should be treated as watcher health state, not domain state.
- Repository writes broad patches; later we should add narrow mutators for `setCurrent`, `appendAccepted`, `clearCurrent`, `appendCompleted`, and `patchTrace`.

Rewrite stance:

- Keep this model for bulk v1.
- Define its role clearly:
  - `acceptedBuffer`: RingCX accepted, not yet observed current.
  - `current`: RingCX active call matched by identity.
  - `completed`: UI/debug/history only.
  - `CxTerminalOutbox`: durable business trigger.
- Never let `completed` substitute for outbox.

### Bulk Reducer

File: [cxBulkLoadStateMachine.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadStateMachine.js)

Current responsibility:

- Pure reducer for session start, preload/refill, active match, terminal start/accept/fail, release, kill.

What works:

- This is the cleanest part of the bulk rail.
- It is pure and well covered.
- It already expresses the core shape: `acceptedBuffer -> current -> completed`.

Concern:

- `current.matched` with `completePrevious: true` writes the previous call into `completed`; the per-session watcher now writes the matching terminal observation first when RingCX provided a UII.
- `buffer.released` writes `completed`; the per-session watcher now writes the matching terminal observation first when RingCX provided a UII.
- `pushCompletedOnce` dedupes by `queueItemId + outcome`, while the outbox correctly dedupes by `queueItemId + uii` when UII exists. That is acceptable for a display log, but not for durable call accounting.

Rewrite stance:

- Keep reducer pure.
- Do not make reducer write outbox.
- Make watcher/orchestrator emit a separate terminal observation event when reducer returns a release/switch that closes a prior UII.
- Tests should assert reducer stays pure and an orchestrator layer writes outbox for release observations.

### Bulk Runtime Service

File: [cxBulkLoadRuntimeService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadRuntimeService.js)

Current responsibility:

- Creates/loads sessions.
- Reserves and publishes buffer rows.
- Checks off-hook.
- Observes active calls.
- Marks queue rows published/serving.
- Submits RingCX disposition.
- Writes terminal outcome.
- Clears terminal hold.
- Refills buffer.
- Persists session.
- Kills session and releases reservations.

What works:

- Reservation and publish path has important safety gates:
  - route-lock before publish
  - cross-pool sibling check
  - publish ownership stamp
  - serving ownership stamp
  - release reserved rows on publish failure
- `sanitizeSession` removes phone before returning to the client.
- Terminal failure keeps current visible/retryable.

What is not clean yet:

- This file is the biggest backend mixing point.
- `leadSource` and `listReadyQueueItems` are required dependencies but are not used by the current reservation-sourced refill path.
- `fillBuffer` does reservation, RingCX publish, queue ownership stamping, release-on-failure, and state reduction.
- `watchCxBulkLoadSession` reads RingCX, applies release diff, checks off-hook, marks serving, mutates current, and persists.
- `submitCxBulkLoadDisposition` calls RingCX disposition, writes terminal outcome, clears agent state, performs refill, persists, and returns. That means a terminal button can be delayed by business writes and up to a 30-lead refill.
- Release observations in `watchCxBulkLoadSession` now call the outcome adapter when RingCX provided UII evidence, so auto-advanced/no-answer calls enter the durable terminal pipeline as `did_not_connect`.
- `[DISPTRACE]` console logs are useful during local testing but should become structured trace or be removed before live.

Rewrite stance:

- Split into single-purpose use-case functions:
  - `prepareBulkBuffer`
  - `projectBulkActiveCall`
  - `submitBulkTerminalIntent`
  - `recordBulkTerminalObservation`
  - `refillBulkBufferIfNeeded`
  - `killBulkSession`
- The terminal command should not perform refill inline.
- The watcher should not write cadence/business data, but it must enqueue terminal observations for released UIIs.
- The refill worker should run from a worker/tick or explicit follow-up, not inside the button response.

### Bulk Runtime Wiring

File: [cxBulkLoadRuntime.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadRuntime.js)

Current responsibility:

- Resolves agent context.
- Applies server runtime gate.
- Resolves RingCX route/env.
- Wires real RingCX client/repositories/adapters.
- Maps app outcomes to RingCX dispositions.
- Wires queue state ownership stamps.
- Wires terminal outbox plus immediate cadence dispatch.

What works:

- Agent authorization/gating is explicit.
- RingCX outcome mapping is simple:
  - voicemail -> `VM DROP`
  - dnc/answered/no-answer -> `Auto Dispo`
- Queue item published/serving writes are ownership-guarded by `reservationSessionId`.

Critical concern:

- The outcome adapter is wired so `persistTerminalOutcome` inserts an outbox row and then immediately awaits `handleCxTerminalCallOutcome`. That means the live terminal button path still performs cadence/metrics/Logics-ish finalizer work inline. The outbox exists, but it is not yet the only business-write boundary.

Rewrite stance:

- Change the live adapter path to insert outbox only.
- Let `cxTerminalOutboxDrain` own `handleCxTerminalCallOutcome`.
- If immediate dispatch is temporarily kept, gate it behind a flag and default it off for the bulk rail trial.

### Active-Call Watcher

Files:

- [cxBulkLoadActiveCallWatcher.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadActiveCallWatcher.js)
- [cxAccountActiveCallWatcherService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxAccountActiveCallWatcherService.js)

What works:

- Matching is identity-first: `externId`, then `queueItemId`.
- Phone-only matching is absent.
- `deriveReleasedCandidates` is the right idea for calls that appear and disappear between polls.
- Account watcher can call RingCX once per account and fan out to multiple sessions.

What is not clean yet:

- `cxAccountActiveCallWatcherService` is still bulk-named and bulk-shaped.
- `runCxAccountActiveCallWatchOnce` writes session projections but does not run the queue ownership `markCandidateServing` CAS used by the per-session runtime watcher.
- Account watcher projection now reports release `terminalObservations`, but apply mode still needs an injected writer before it can replace the per-session watch path.
- Browser `/watch` and account watcher are parallel ways to mutate current if both are enabled.

Rewrite stance:

- Make account watcher the only active-call observer.
- Before apply mode, give account watcher an injected `onCurrentMatched` ownership stamp and `onReleased` terminal observation writer, then verify it writes the same outbox payloads as the per-session watcher.
- Keep browser polling read-only.
- Rename only after behavior is proven; function names can stay bulk-ish temporarily if that reduces risk, but the API should be rail-neutral.

### Publisher

File: [cxBulkLoadRingcxPublisher.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadRingcxPublisher.js)

Current responsibility:

- Builds RingCX lead-loader payloads.
- Defaults priority to `NORMAL`.
- Loads leads to RingCX.
- Maps accepted/rejected results.
- Cancels buffered leads by externId.

What works:

- This is a good adapter.
- Payload mapping and result mapping are pure/testable.
- It drops drafts without phone or externId before calling RingCX.

Rewrite stance:

- Keep it thin.
- Consider renaming to a rail-neutral `ringcxLeadPublisher` once slow/legacy also use it.
- Do not let it reserve, mark queue rows, or update sessions.

### Reservation / Lead Pool

Files:

- [cxQueueReservationService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxQueueReservationService.js)
- [cxDialQueueRepository.js](C:/code/TagContactBridgeParalell/packages/shared-repositories/src/cxDialQueueRepository.js)
- [cxReserveModeService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxReserveModeService.js)

Current responsibility:

- Reserves ready rows by family into claimed rows.
- Releases reserved rows.
- Renews reserved claims.
- Applies family target policy.

What works:

- This should be the universal source for all rails.
- `reserveFromFamilyOrder` is the right shared primitive.
- Cross-pool interlock exists to prevent a case active in legacy UCQ from being bulk-reserved.

What is not clean yet:

- Bulk is closest to this contract; slow and legacy are not fully converted.
- New incoming greens must be prevented from jumping directly into active agent rails; they should enter pool/bucket state and be picked up by the next reservation cycle.

Rewrite stance:

- Build `reserveForRail({ railPolicy, agent, domain, sessionId })` as a small wrapper over this service.
- The only rail-specific values should be count/family targets/timing.

### Terminal Outbox And Drain

Files:

- [CxTerminalOutbox.js](C:/code/TagContactBridgeParalell/packages/shared-models/src/CxTerminalOutbox.js)
- [cxTerminalOutboxRepository.js](C:/code/TagContactBridgeParalell/packages/shared-repositories/src/cxTerminalOutboxRepository.js)
- [cxBulkLoadOutcomeAdapter.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadOutcomeAdapter.js)
- [cxTerminalOutboxDrain.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxTerminalOutboxDrain.js)
- [server.js](C:/code/TagContactBridgeParalell/apps/control-plane/src/server.js)

What works:

- Durable `idemKey` unique index is the right once-semantics.
- Drain worker exists and runs from control-plane.
- Idempotency by `queueItemId:uii` is correct for distinct redials.

What is not clean yet:

- Adapter is still bulk-named.
- Live path still immediately dispatches cadence finalizer after outbox insert.
- Per-session watcher release observations write through the outcome adapter; account-watcher apply still needs the same writer.
- Drain is generic enough, but the event shape should carry rail/source/buttonIntent/outcomeBucket clearly.

Rewrite stance:

- Generalize adapter name and payload.
- Make live path insert-only.
- Make drain the only caller of `handleCxTerminalCallOutcome`.
- Ensure DNC is handled in the drain, not the live loop.

## Current Bulk Flow

### Start / Preload

1. Route calls `startCxBulkLoadSession`.
2. Server resolves agent and runtime.
3. Runtime kills prior active sessions for the agent.
4. Runtime creates a new `CxBulkLoadSession`.
5. Runtime checks off-hook.
6. If off-hook, it calls `fillBuffer`.
7. `fillBuffer` reserves rows, publishes each row to RingCX one at a time, stamps queue ownership, and appends accepted rows to `acceptedBuffer`.

Important note:

- This does not currently support a pure 7am "preload before off-hook" shape, because `start` waits for off-hook before filling. If 7am prebuild remains a goal, separate `prepareBulkBuffer` from `startDialingWhenOffhook`.

### Active Call

1. Client has a 1s `bulkWatch` mutation loop.
2. Server reads RingCX active calls.
3. Watcher matches active calls to known candidates by externId/queue item.
4. Runtime marks the queue item as serving.
5. Reducer moves the candidate from `acceptedBuffer` to `current`.
6. Client mirrors `current` into the old form/selected state.

Important note:

- Account watcher can already do a better account-level fanout, but it does not yet enforce the serving CAS or terminal observation outbox writes.

### Terminal Button

1. Client button calls `submitQueueDisposition`.
2. UI clears the center panel and shows transition.
3. Server maps outcome to RingCX disposition.
4. Server calls `client.dispositionCall(uii, ...)`.
5. Server writes terminal outcome through outcome adapter.
6. Current is cleared.
7. Server calls `maybeRefill`.
8. Client waits for result/refetch and poller eventually shows next RingCX active call.

Important note:

- Step 5 currently includes immediate cadence finalizer dispatch, and step 7 can publish many leads. Both are heavier than the button path should be.

### Auto Advance / No Button

1. RingCX can advance from one active call to another without an app button.
2. Watcher sees active call switch or release diff.
3. Reducer appends the previous/released candidate to `completed` as `did_not_connect`.
4. The per-session bulk watcher writes terminal observations through the outcome adapter when RingCX provided a UII. The account-level watcher only reports those observations for now.

Important note:

- The biggest remaining correctness gap is moving the same terminal-observation writer into the account-level watcher apply path, so browser `/watch` can become read-only.

## Rewrite Proposal

### Rewrite 1: Define A Bulk Rail Projection Adapter

Create `packages/shared-services/src/cxCallRailProjectionService.js`.

First functions:

```js
projectBulkLoadRailState(session)
projectRailStateForUi(state)
```

Output shape:

```js
{
  rail: "bulk_load",
  sessionId,
  agentEmail,
  agentExtensionId,
  phase,
  current,
  pending,
  terminalBuffer,
  stats,
  health
}
```

Rules:

- No phone identity.
- `current` requires queue identity and RingCX identity.
- `pending` comes from `acceptedBuffer`.
- `terminalBuffer` can include `completed` for display, but durable truth remains the outbox.

Why first:

- Lets client stop knowing bulk internals before we replace the watcher.
- Gives tests a single object to compare.

### Rewrite 2: Make Terminal Outbox Insert-Only In The Live Path

Change the bulk runtime wiring so `persistTerminalOutcome` does not await `handleCxTerminalCallOutcome`.

Target:

```text
button/release observation -> insert terminal outbox row -> return fast
drain worker -> handleCxTerminalCallOutcome -> mark drained/failed
```

Rules:

- DNC Logics propagation happens in the drain.
- Cadence spacing/count updates happen in the drain.
- Button request should only wait on RingCX disposition plus outbox insert.

### Rewrite 3: Treat Watcher Releases As Terminal Observations

Add an orchestrator step around release observations:

```text
deriveReleasedCandidates -> insertTerminalObservationOnce -> reduce buffer.released
current switch with completePrevious -> insertTerminalObservationOnce -> reduce current.matched
```

Rules:

- Watcher still does not call Logics/cadence.
- Watcher may insert tiny outbox rows because that is the durable trigger.
- Observation defaults to `did_not_connect` only when prior active call had a UII.
- If a manual button already wrote the same `queueItemId:uii`, outbox dedupe wins.

### Rewrite 4: Move Refill Out Of The Button Response

Current button path:

```text
dispose RingCX -> write outcome -> clear current -> maybeRefill -> persist -> return
```

Target button path:

```text
dispose RingCX -> insert outbox -> clear current -> persist -> return
```

Then:

```text
refill worker/tick -> if live slots <= 5 -> reserve/publish deficit -> persist
```

Why:

- Avoids a button waiting on up to 30 RingCX publish calls.
- Makes "terminal" and "refill" separate concerns.
- Makes the "5 left, load 30" behavior testable without pushing it into every button path.

### Rewrite 5: Promote Account Watcher Carefully

Target:

```text
one activeCalls/list per account per tick
  -> project all active rail sessions
  -> ownership CAS for new current
  -> outbox observation for releases
  -> write only changed sessions
```

Required before apply mode:

- Account watcher must call the same serving ownership guard as current per-session watcher.
- Account watcher must write terminal observation outbox rows for releases/switches.
- Browser `/watch` must become read-only or disabled to avoid competing writers.

### Rewrite 6: Thin Bulk Client To The Universal Shell

Keep the visual layout, but remove mixed lifecycle ownership.

Bulk client should do only:

```text
read projection
render current/pending/transition
send one terminal command per button
render side-panel Logics data for current case
```

It should not:

- call simple-loop hooks
- call legacy `dialAny`
- compute legacy `queueItems` for serving while bulk is running
- phone-match the middle panel
- own active-call watch mutation after account watcher exists

## Risk Register

### P0: Auto-advance can update session without durable terminal outcome

Evidence:

- `cxBulkLoadStateMachine` adds `completed` on `current.matched` with `completePrevious`.
- `cxBulkLoadStateMachine` adds `completed` on `buffer.released`.
- `cxBulkLoadRuntimeService.watchCxBulkLoadSession` now calls `outcomeAdapter.persistTerminalOutcome` for RingCX-proven released UIIs before applying those reducer events.
- Tests now assert watcher release observations write exactly one terminal outcome keyed by queue item + UII.

Impact:

- RingCX can correctly move to the next lead while cadence/metrics/counts miss the prior call.

Fix:

- Watcher/orchestrator writes a terminal observation outbox row for released UIIs.

### P0: Live terminal path still performs business finalizer inline

Evidence:

- `cxBulkLoadRuntime.js` outbox writer inserts once, then immediately awaits `handleCxTerminalCallOutcome`.

Impact:

- Button latency and reliability still depend on cadence/metrics/Logics finalizer behavior.

Fix:

- Live path inserts outbox only. Drain performs finalizer work.

### P1: Refill happens inside terminal button response

Evidence:

- `submitCxBulkLoadDisposition` calls `maybeRefill` before returning.
- Refill can publish 30 rows one at a time.

Impact:

- A button can feel slow or stuck when the actual call disposition already completed.

Fix:

- Move refill to a worker/tick or explicit post-terminal background job.

### P1: Account watcher bypasses queue serving ownership stamp

Evidence:

- Per-session watcher calls `queueStateAdapter.markCandidateServing`.
- Account watcher projection writes sessions directly through repository.

Impact:

- If account watcher becomes authoritative as-is, it can promote a current lead without proving the queue row is still owned by that session.

Fix:

- Inject ownership CAS into account watcher apply path before writing `current`.

### P1: Bulk start cannot yet represent 7am preload cleanly

Evidence:

- `startCxBulkLoadSession` fills buffer only if off-hook.

Impact:

- It conflicts with a 7am "prepare the RingCX queue before agents log in/off-hook" plan.

Fix:

- Split `prepareBulkBuffer` from `start/watch agent activity`.

### P2: Bulk UI still carries legacy/simple-loop brains

Evidence:

- `CXWorkspaceBulkLoad.tsx` imports and initializes legacy queue, simple-loop, dial-any, and lookup paths.

Impact:

- More places can accidentally mutate or stage call state.
- Harder to reason about what controls the middle panel.

Fix:

- Extract a smaller bulk controller and shared presentational shell.

## Test Targets

### Existing Useful Tests

Already present:

- [cxBulkLoadStateMachine.test.js](C:/code/TagContactBridgeParalell/tests/cx-bulk-load/cxBulkLoadStateMachine.test.js)
- [cxBulkLoadActiveCallWatcher.test.js](C:/code/TagContactBridgeParalell/tests/cx-bulk-load/cxBulkLoadActiveCallWatcher.test.js)
- [cxBulkLoadRuntimeService.test.js](C:/code/TagContactBridgeParalell/tests/cx-bulk-load/cxBulkLoadRuntimeService.test.js)
- [cxBulkLoadOutcomeAdapter.test.js](C:/code/TagContactBridgeParalell/tests/cx-bulk-load/cxBulkLoadOutcomeAdapter.test.js)
- [cxTerminalOutboxDrain.test.js](C:/code/TagContactBridgeParalell/tests/cx-bulk-load/cxTerminalOutboxDrain.test.js)
- [cxAccountActiveCallWatcherService.test.js](C:/code/TagContactBridgeParalell/tests/cx-bulk-load/cxAccountActiveCallWatcherService.test.js)
- [cxQueueReservationService.test.js](C:/code/TagContactBridgeParalell/tests/cx-bulk-load/cxQueueReservationService.test.js)
- [cxBulkLoadRingcxPublisher.test.js](C:/code/TagContactBridgeParalell/tests/cx-bulk-load/cxBulkLoadRingcxPublisher.test.js)

### Tests To Add Before The Next Real Bulk Trial

1. **Watcher release writes terminal observation**
   - Given q1 was active last tick with UII and is gone this tick.
   - Expect one outbox insert for q1/u1.
   - Expect q1 removed from buffer/completed for display.
   - Expect no Logics/cadence direct call.

2. **Current switch writes previous terminal observation**
   - Given q1 current with UII and q2 becomes active.
   - Expect q1 outbox insert as `did_not_connect`.
   - Expect q2 current.
   - Duplicate manual q1 button event should dedupe by `queueItemId:uii`.

3. **Button path is insert-only**
   - Given terminal button succeeds.
   - Expect RingCX `dispositionCall` called.
   - Expect outbox insert called.
   - Expect `handleCxTerminalCallOutcome` not called in request path.
   - Expect current cleared quickly.

4. **Refill worker owns threshold**
   - Given live slots drop to 5.
   - Worker reserves/publishes deficit toward 35.
   - Terminal command does not call publisher.

5. **Account watcher apply uses ownership CAS**
   - Given active call matches q1 but `markCandidateServing` returns null.
   - Expect no current promotion.
   - Expect health trace says ownership-stamp-miss.

6. **Bulk projection renders without legacy fields**
   - Given raw `CxBulkLoadSession`.
   - Projection contains current/pending/terminal/health.
   - Projection excludes full phone.
   - UI shell can render from projection alone.

7. **7am preload split**
   - `prepareBulkBuffer` can reserve/publish accepted rows without requiring off-hook.
   - `start/watch` can wait for off-hook/current call separately.

## Recommended Next Implementation Order

1. Add `cxCallRailProjectionService` for bulk only.
2. Add projection tests.
3. Change bulk session response to include `projection` beside existing raw shape.
4. Change terminal adapter wiring to insert-only behind a flag, then default insert-only for bulk.
5. Add release-observation outbox writer around watcher transitions.
6. Move refill to an explicit worker/function and stop calling it in button response.
7. Harden account watcher apply with ownership CAS.
8. Replace bulk browser `/watch` mutation with read-only projection polling.
9. Thin `CXWorkspaceBulkLoad.tsx` by extracting `CallRailShell`.

## One-Sentence Design Rule

Bulk should be boring: RingCX decides who is live, the watcher proves identity, the UI displays that proof, buttons write intent, and every expensive business consequence drains later.

## Next-Level Fixes - Line-By-Line Implementation Plan

This section is the next audit layer after the first bulk-load tests. The current code is close enough to keep, but the next patch should remove the remaining places where one function owns more than one job.

Recent verification baseline:

```text
node --test tests/cx-bulk-load/*.test.js tests/cx-dial-runtime/*.test.js tests/cx-simple-loop/*.test.js
node --test tests/queue/*.test.js
node --test tests/cx-call-state-guard/*.test.js tests/cx-handoff/*.test.js tests/cx-morning-prep/*.test.js tests/cadence/*.test.js
```

Observed baseline from the latest local run: 396 passing tests, 0 failures. The bulk runtime tests still emit unconditional `[DISPTRACE]` logs; remove or gate those before a serious smoke run.

### Fix 1 - Make terminal writes insert-only on the live loop

Code today:

- [cxBulkLoadRuntimeService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadRuntimeService.js:459) starts the button terminal path.
- [cxBulkLoadRuntimeService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadRuntimeService.js:477) calls the RingCX terminal executor.
- [cxBulkLoadRuntimeService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadRuntimeService.js:503) writes terminal outcome.
- [cxBulkLoadRuntime.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadRuntime.js:219) inserts the terminal outbox row, then still calls `dispatchCadenceEvent`.
- [cxBulkLoadRuntime.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadRuntime.js:247) dispatches `handleCxTerminalCallOutcome` inline and marks the row drained.
- [server.js](C:/code/TagContactBridgeParalell/apps/control-plane/src/server.js:859) already has the terminal outbox worker.
- [server.js](C:/code/TagContactBridgeParalell/apps/control-plane/src/server.js:877) wires the drain to `handleCxTerminalCallOutcome`.

Problem:

- The live call loop still does business finalization in the button request. That means a disposition click can pay for RingCX, Mongo outbox, cadence/Logics/counting, and refill before the UI gets its answer.
- This violates the backbone rule: buttons write intent; expensive consequences drain later.

Patch:

1. In [cxBulkLoadRuntime.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadRuntime.js:219), split the adapter into two named effects:
   - `insertTerminalOutbox(event)` inserts once and returns `{ written, idemKey, status: "pending" | "duplicate" }`.
   - `dispatchTerminalOutbox(event)` is used only by [cxTerminalOutboxDrain.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxTerminalOutboxDrain.js:19) or a test harness.
2. Make `recordCadenceEvent` in the bulk outcome adapter call insert-only for live runtime. Do not call `dispatchCadenceEvent` from [cxBulkLoadRuntime.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadRuntime.js:247).
3. Keep [cxTerminalOutboxRepository.js](C:/code/TagContactBridgeParalell/packages/shared-repositories/src/cxTerminalOutboxRepository.js:15) as the durable dedup boundary. The unique key remains the business guarantee.
4. Keep [server.js](C:/code/TagContactBridgeParalell/apps/control-plane/src/server.js:859) as the only place that replays pending rows.

Acceptance tests:

- Existing `cxBulkLoadOutcomeAdapter.test.js` still passes.
- Existing `cxTerminalOutboxDrain.test.js` still passes.
- Add/update runtime test: disposition click calls RingCX disposition and outbox insert, but does not call `handleCxTerminalCallOutcome` or publisher.
- Add integration smoke: after a button click, one row lands in `ControlPlaneCxTerminalOutbox` as `pending`, then the worker drains it.

### Fix 2 - Pull refill out of the terminal button response

Code today:

- [cxBulkLoadRuntimeService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadRuntimeService.js:275) defines `maybeRefill`.
- [cxBulkLoadRuntimeService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadRuntimeService.js:515) runs `maybeRefill` inside the successful disposition response.
- [cxBulkLoadRuntimeService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadRuntimeService.js:535) does the same inside skip.
- [cxBulkLoadRuntimeService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadRuntimeService.js:176) `fillBuffer` reserves rows, route-locks rows, checks active sibling claims, publishes to RingCX, stamps ownership, and mutates state.

Problem:

- Refill is a background buffer maintenance concern, not part of an agent's button click.
- Today the button can return late because it is also trying to publish more leads.
- `fillBuffer` itself is doing too many jobs, but it can be split after the behavior is stable.

Patch:

1. Keep `fillBuffer` behavior intact for this pass, but move the call site.
2. Add `refillBulkLoadSessionIfNeeded({ sessionId, reason })` in [cxBulkLoadRuntimeService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadRuntimeService.js) or a new `cxBulkLoadRefillService.js`.
3. Have `submitCxBulkLoadDisposition` stop after:
   - RingCX disposition accepted.
   - terminal outbox inserted.
   - current cleared through `terminal.accepted`.
   - session persisted.
4. Trigger refill from a worker/tick, or from the account watcher after it finishes applying current/release projections. Do not await refill before returning from `/disposition`.
5. Keep the threshold math: refill when live slots are `<= 5`, target `35`.

Acceptance tests:

- Button path does not call publisher.
- Refill worker calls publisher only when live slots are at or below threshold.
- Refill worker reserves and publishes to 35 without duplicating current/completed/accepted rows.
- A failed refill does not block or revert terminal completion.

### Fix 3 - Make released-call observations durable, not just display-state changes

Code today:

- [cxBulkLoadActiveCallWatcher.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadActiveCallWatcher.js:131) detects prior active externIds that disappeared.
- [cxBulkLoadRuntimeService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadRuntimeService.js:377) derives released candidates in browser-driven watch.
- [cxBulkLoadRuntimeService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadRuntimeService.js:384) reduces each released candidate to `buffer.released`.
- [cxBulkLoadStateMachine.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadStateMachine.js:244) moves released candidates to `completed`.
- [cxAccountActiveCallWatcherService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxAccountActiveCallWatcherService.js:91) derives the same release diff in the account watcher.
- [cxAccountActiveCallWatcherService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxAccountActiveCallWatcherService.js:99) reduces release to completed state only.

Problem:

- In the per-session watcher, a released call with UII now enters the terminal outbox before becoming visually completed. The account-watcher apply path still needs that same writer.
- This is exactly the no-answer/auto-advance class: RingCX can move on without an agent button, but our counts still need one durable terminal record keyed by `queueItemId:uii`.

Patch:

1. Add a small `buildReleasedTerminalEvents({ before, after, releaseDiff, transition })` helper.
2. For each released candidate with UII, call `outcomeAdapter.persistTerminalOutcome({ source: "active-call-release", outcome: "did_not_connect" })`.
3. For a current switch where `completePrevious === true`, write the previous current to outbox before applying the new current.
4. Keep `buffer.released` as display-state only; do not let it be the only count.
5. Never write an outbox row for a release that lacks UII, unless an explicit manual terminal input supplied the terminal event. No phantom counts.

Acceptance tests:

- Previous active q1/u1 disappears between polls: one outbox row q1/u1, q1 removed from buffer.
- Current q1/u1 switches to q2/u2: one outbox row q1/u1, q2 becomes current.
- Duplicate button click for q1/u1 dedupes against the release outbox row.
- Release without UII updates trace/health but does not count.

### Fix 4 - Make the account watcher the only mutating active-call observer

Code today:

- [cxBulkLoadRuntimeService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadRuntimeService.js:353) has per-session browser-triggered watch.
- [CXWorkspaceBulkLoad.tsx](C:/code/TagContactBridgeParalell/apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:4356) posts `/watch` every second from the browser.
- [cxAccountActiveCallWatcherService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxAccountActiveCallWatcherService.js:240) can already run account-scoped observation across active bulk sessions.
- [cxAccountActiveCallWatcherService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxAccountActiveCallWatcherService.js:261) applies whole-session patches directly.

Problem:

- There are two mutating observers: client `/watch` and account watcher.
- The browser should read projection, not mutate state.
- The account watcher apply path writes the whole projected session and does not currently run the same serving ownership CAS as [cxBulkLoadRuntime.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadRuntime.js:292).

Patch:

1. Keep [cxBulkLoadActiveCallWatcher.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadActiveCallWatcher.js) pure and reusable.
2. Move all state mutation to account watcher or a shared `applyBulkActiveCallProjection` helper.
3. Before promoting current in account watcher, call the same `markCandidateServing` ownership stamp used by the runtime.
4. Change [cxAccountActiveCallWatcherService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxAccountActiveCallWatcherService.js:267) from whole-session update to guarded narrow update:
   - match current `sessionId`.
   - match expected `updatedAt` or a version field when practical.
   - preserve unrelated fields that a terminal button may have changed.
5. Make `/api/cx/bulk-load/watch` dev/test-only or read-only after the account watcher is on.
6. Change [cxBulkLoad.ts](C:/code/TagContactBridgeParalell/apps/web-client/src/lib/api/queries/cxBulkLoad.ts:83) so the UI no longer has a mutation hook for watch in production mode.

Acceptance tests:

- Account watcher updates five sessions from one account snapshot.
- If `markCandidateServing` returns null, current is not promoted.
- Client session polling alone does not change server state.
- A terminal button and watcher tick racing on the same session cannot resurrect a cleared current.

### Fix 5 - Add a rail projection DTO before thinning the UI

Code today:

- [CXWorkspaceBulkLoad.tsx](C:/code/TagContactBridgeParalell/apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:4309) mirrors `bulkCurrent` into `selected`, `form`, and served queue state.
- [CXWorkspaceBulkLoad.tsx](C:/code/TagContactBridgeParalell/apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:4318) requires numeric `caseId` before it will populate the visible active case.
- [CXWorkspaceBulkLoad.tsx](C:/code/TagContactBridgeParalell/apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:4330) intentionally blanks phone in the middle panel.
- [cxBulkLoad.ts](C:/code/TagContactBridgeParalell/apps/web-client/src/lib/api/queries/cxBulkLoad.ts:23) exposes raw session shape to the client.

Problem:

- The UI still renders bulk by adapting it into legacy workspace state.
- That makes stale lookup/form/servedQueue behavior hard to reason about.
- We need the side panels to load case data, but the middle section should be driven only by the active RingCX-matched queue row.

Patch:

1. Add `cxCallRailProjectionService.js` with a pure function:
   - input: `CxBulkLoadSession`.
   - output: `{ mode, sessionId, status, phase, current, pending, terminal, health }`.
2. `current` should include:
   - `queueItemId`, `domain`, `caseId`, `displayName`, `uii`, `externId`, `activeAt`, `matchReasons`.
   - no phone unless explicitly needed for a dialer/debug-only panel.
3. Add `projection` beside the current raw session response; do not remove raw fields in the first patch.
4. Update [CXWorkspaceBulkLoad.tsx](C:/code/TagContactBridgeParalell/apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:4318) to consume `projection.current` first.
5. Keep Logics/client-detail side panels case-scoped by `projection.current.domain/caseId`.
6. Do not run phone/name lookup to decide the middle section in bulk mode.

Acceptance tests:

- Projection from active session renders correct current case without Logics lookup.
- Projection from no-current running session shows transition/idle state without stale lead.
- Projection excludes full phone.
- UI can switch current from q1 to q2 by projection alone.

### Fix 6 - Remove bulk-mirror/simple-loop code from bulk workspace

Code today:

- [CXWorkspaceBulkLoad.tsx](C:/code/TagContactBridgeParalell/apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:3810) still initializes simple-loop panel state.
- [CXWorkspaceBulkLoad.tsx](C:/code/TagContactBridgeParalell/apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:3840) can run a simple-loop bulk-mirror watch loop.
- [CXWorkspaceBulkLoad.tsx](C:/code/TagContactBridgeParalell/apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:5915) can render the simple-loop panel inside bulk workspace.
- [cxSimpleCallLoopService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxSimpleCallLoopService.js:59) still recognizes `bulk-mirror`.
- [cxSimpleCallLoopService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxSimpleCallLoopService.js:1247) still has dead service-side bulk mirror publishing/capture code.
- [cxSimpleCallLoopService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxSimpleCallLoopService.js:1353) branches into bulk-mirror on advance.

Problem:

- Bulk mode is supposed to be its own rail. Keeping simple-loop bulk-mirror around creates another path that can mutate, capture, and count calls.
- It also makes test results confusing: a UI can look like bulk while calling simple-loop.

Patch:

1. Remove simple-loop panel/harness from `CXWorkspaceBulkLoad.tsx`.
2. Keep simple-loop service for slow/single only.
3. Mark `bulk-mirror` as unsupported or remove it after confirming no live flag points to it.
4. Delete or isolate `mirrorBulkQueue`, `captureBulkCurrent`, and `bulk.publish.*` cases behind tests showing no route reaches them.

Acceptance tests:

- Bulk workspace imports no `cxSimpleLoop` query hooks.
- `advanceCxSimpleLoopSession` cannot enter `bulk-mirror`.
- Existing simple single tests still pass.
- `VITE_CX_WORKSPACE_MODE=bulk_load` can only call `/api/cx/bulk-load/*`.

### Fix 7 - Make refill/list building rail-neutral but policy-specific

Code today:

- [cxBulkLoadRuntimeService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadRuntimeService.js:184) reserves by family order.
- [cxBulkLoadRuntimeService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadRuntimeService.js:188) computes residual family deficits from live buffer composition.
- [cxBulkLoadRuntimeService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadRuntimeService.js:225) builds `externId` directly in the runtime even though [cxBulkLoadLeadSourceService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadLeadSourceService.js:29) already has `buildExternId`.
- [cxBulkLoadRingcxPublisher.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadRingcxPublisher.js:23) normalizes priority to `NORMAL` or `IMMEDIATE`.

Problem:

- Queue formation should be universal. The only difference between rails should be handoff policy:
  - slow single: one lead at a time, wait for RingCX acceptance.
  - bulk load: keep buffer at target, RingCX owns call order.
  - legacy emergency: existing stable flow.
- Today bulk owns too much of its own queue construction.

Patch:

1. Extract a `cxRailLeadPoolService` later, but first make bulk call the existing `buildExternId`.
2. Keep family pool targets and order as explicit policy input:
   - initial target 35.
   - refill threshold 5.
   - refill target 35.
   - family ratio/order: green, blue, yellow, red as configured by policy.
3. Ensure new inbound greens enter the eligible pool, not a running agent buffer. The next refill should pick them up.
4. Keep route/campaign lock at publish time.

Acceptance tests:

- Given 15 green, 10 blue, 5 yellow, 5 red available, refill builds the expected family mix.
- If yellow/red are exhausted, deficit rolls forward without exceeding target.
- New green added during active session does not jump into active buffer until next refill.
- Same queue item cannot be reserved by two rails.

### Fix 8 - Keep button semantics simple and honest

Code today:

- [cxBulkLoadRuntime.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadRuntime.js:363) says dispositioning the active call is what ends it.
- [CXWorkspaceBulkLoad.tsx](C:/code/TagContactBridgeParalell/apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:6079) renders DNC.
- [CXWorkspaceBulkLoad.tsx](C:/code/TagContactBridgeParalell/apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:6094) renders Answer.
- [CXWorkspaceBulkLoad.tsx](C:/code/TagContactBridgeParalell/apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:6110) renders No answer.
- [CXWorkspaceBulkLoad.tsx](C:/code/TagContactBridgeParalell/apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:6126) renders Voicemail.

Problem:

- In progressive/bulk behavior, RingCX may auto-advance no-answer style outcomes without a button.
- DNC/answer/voicemail are still meaningful agent intents.
- No-answer is sometimes an intent, sometimes just the inferred outcome of a released UII.

Patch:

1. Keep all four buttons available while there is a current UII.
2. Button click sends one terminal intent: `{ sessionId, queueItemId, uii, outcome }`.
3. Do not try to call RingCX hangup separately in bulk. Disposition call is the terminal command.
4. If RingCX auto-advances and no button intent exists, release-observation writes `did_not_connect`.
5. If button intent exists and release happens shortly after, outbox dedupe keeps the button outcome.
6. DNC-specific Logics/cadence consequences happen in the drain, not the button loop.

Acceptance tests:

- DNC button -> RingCX disposition -> outbox `dnc`.
- Voicemail button -> RingCX disposition -> outbox `voicemail`.
- No button, q1/u1 disappears -> outbox `did_not_connect`.
- Button q1/u1 then watcher release q1/u1 -> one outbox row, button outcome wins.

### Implementation Order For The Next Patch

1. Remove/gate debug logs:
   - `[DISPTRACE]` in [cxBulkLoadRuntimeService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadRuntimeService.js:461).
   - `[DISPTRACE]` in [cxBulkLoadRuntime.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadRuntime.js:371).
   - `[disp]` console logs in [CXWorkspaceBulkLoad.tsx](C:/code/TagContactBridgeParalell/apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:5467).
2. Make terminal outbox insert-only in the live request path.
3. Add release-observation outbox writes for watcher release/switch.
4. Extract refill worker/function and remove refill from disposition/skip responses.
5. Move mutating active-call observation to account watcher only.
6. Add projection DTO and return it beside raw session.
7. Update bulk UI to render from projection.
8. Remove simple-loop/bulk-mirror harness from bulk UI.
9. Remove dead service-side bulk-mirror path once tests prove no active route depends on it.

### Smoke Test Checklist

Before local real-agent test:

- Drain the test RingCX campaign manually or by explicit cancel script.
- Confirm `VITE_CX_WORKSPACE_MODE=bulk_load`.
- Confirm the visible workspace calls only `/api/cx/bulk-load/session`, `/disposition`, `/kill`, and read-only projection/session polling.
- Confirm account watcher is running or manually ticking.
- Confirm terminal outbox drain is enabled.

Local real-agent test:

1. Preload 6 leads.
2. Let RingCX dial current.
3. Confirm middle panel matches `projection.current`.
4. Click voicemail and confirm UI clears/loads next without waiting on refill.
5. Let one no-answer auto-advance without clicking.
6. Confirm release-observation writes one pending outbox row.
7. Cross threshold and confirm refill tops buffer back toward 35.
8. Confirm no duplicate rows for the same `queueItemId:uii`.

Live shadow/readiness test:

1. Run account watcher against active agents for one hour at 1000ms.
2. Record changed UII events, released UII events, no-UII releases, and ownership CAS misses.
3. Repeat at 750ms only if 1000ms shows no 429s or watcher backlog.
4. Do not turn bulk on for the floor until account watcher can track active/current/release without browser `/watch`.

No-go criteria:

- Any terminal event writes directly to Logics/cadence inside the button request.
- Any active-call promotion uses phone-only matching.
- Any watcher can promote current without queue ownership proof.
- Any current lead can visually render from Logics lookup instead of RingCX-matched projection.
- Any no-UII auto-release is counted as a real call.
