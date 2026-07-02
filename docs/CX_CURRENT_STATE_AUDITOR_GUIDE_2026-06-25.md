# CX Current-State Auditor Guide - 2026-06-25

Purpose: give the next reviewer a precise map of the CX dial work as it exists now, with the places to simplify, harden, and smoke-test before another floor pilot.

This guide is scoped to the CX dial rails, RingCX handoff, terminal drain, appointment hold, and queue/refill behavior. The AI-bus branch is intentionally out of scope except where call summaries attach after the terminal drain.

## North Star

The system should be easy to reason about:

```text
RingCX owns the live call.
The app watches the live call.
The app displays only the call RingCX proves is active.
Buttons write one terminal outcome.
The drain writes counts / Logics / summary work after the call loop.
```

The active dial loop should not do Logics reads, AI calls, transcript work, summary writes, or case enrichment beyond what is needed to render the current lead.

## Current Architecture Shape

There are three UI/runtime modes:

- `legacy`: existing CX workspace path, kept as the live fallback.
- `slow_single`: cleaner single-send fallback under construction.
- `bulk_load`: buffered RingCX queue mode under active test.

The long-term target is not three unrelated systems. It is one shared backbone with only the RingCX delivery cadence swapped:

```text
lead pool / queue reservation
  -> RingCX delivery adapter (legacy / slow_single / bulk_load)
  -> account active-call watcher
  -> current-call projection
  -> terminal outbox
  -> drain / metrics / Logics / wrap-up
```

## Audit Order

Start here, in order. Do not begin in the UI.

1. `packages/shared-services/src/cxBulkLoadRuntimeService.js`
   - This is the core bulk orchestrator.
   - Audit `fillBuffer`, `maybeRefill`, `disposition`, `skip`, `kill`, and the now-read-only browser watch path.
   - Verify it has one job: reserve/publish/terminal/refill, not case enrichment or UI logic.

2. `packages/shared-services/src/cxAccountActiveCallWatcherService.js`
   - This is the preferred universal current-call projection direction.
   - Verify it reads RingCX once per account, fans out to sessions, matches only safe identities, and writes only when the projection changes.

3. `packages/shared-services/src/cxBulkLoadOutcomeAdapter.js`
   - This should remain the only bulk terminal outcome writer.
   - Verify all terminal paths use `queueItemId:uii` when a UII exists and do not fabricate duplicate writes.

4. `packages/shared-services/src/cxTerminalOutboxDrain.js`
   - This should drain terminal facts into existing cadence/counting paths.
   - Verify it does not block the call loop on Logics, AI, email, or summaries.

5. `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx`
   - This should be a view/controller only.
   - Verify the center panel is latched on the last confirmed UII and does not clear on `current = null`.

6. Appointment workbench:
   - `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx`
   - `packages/shared-services/src/cxBulkLoadRuntime.js`
   - `packages/shared-services/src/cxAppointmentService.js`
   - `packages/shared-services/src/cxWorkspaceService.js`
   - Verify appointment open pauses the agent to Working, submit/cancel resumes to Available, and Logics task/activity work is out of the hot dial loop.

7. Queue source and reservation:
   - `packages/shared-services/src/cxQueueReservationService.js`
   - `packages/shared-repositories/src/cxDialQueueRepository.js`
   - `packages/shared-services/src/cxBulkLoadLeadSourceService.js`
   - Verify bulk draws from the same policy-shaped pool as the floor queue without allowing fresh leads to jump directly into an active agent's RingCX buffer.

## File Map

### Routing and client API

- `apps/control-plane/src/routes/cxBulkLoad.js`
  - Thin route layer for `session`, `start`, `disposition`, `skip`, `get-leads`, `pause-progressive`, and `resume-progressive`.
  - Audit target: keep it auth + service call only.

- `apps/web-client/src/lib/api/queries/cxBulkLoad.ts`
  - React Query wrappers for bulk commands.
  - Audit target: no business decisions here; command names should map 1:1 to backend verbs.

- `apps/web-client/src/workspaces/cx/CXWorkspaceRouter.tsx`
  - Mode selection / rail routing.
  - Audit target: one flag selects a rail; no cross-rail partial behavior.

### Bulk state and runtime

- `packages/shared-models/src/CxBulkLoadSession.js`
  - Session document shape.
  - Audit target: state should describe queue buffer, current call, previous calls, and traces. Avoid UI-only fields and duplicate sources of truth.

- `packages/shared-repositories/src/cxBulkLoadSessionRepository.js`
  - Bulk session persistence.
  - Audit target: guarded updates, no blind clobber from concurrent writer paths, narrow update helpers where possible.

- `packages/shared-services/src/cxBulkLoadStateMachine.js`
  - Pure reducer.
  - Audit target: all important mutations should be expressible as state-machine events. Prefer improving this over scattering object mutation in services.

- `packages/shared-services/src/cxBulkLoadRuntimeService.js`
  - Main orchestration service.
  - Audit target: break down into small single-purpose helpers if any function owns unrelated responsibilities.

- `packages/shared-services/src/cxBulkLoadRuntime.js`
  - Production adapter wiring and RingCX terminal execution.
  - Audit target: keep RingCX I/O here, not inside the reducer or UI.

### RingCX publishing and watching

- `packages/shared-services/src/cxBulkLoadRingcxPublisher.js`
  - Builds RingCX lead payloads and interprets publish responses.
  - Audit target: accepted means RingCX actually accepted the lead, not merely "no exception."

- `packages/shared-services/src/cxBulkLoadActiveCallWatcher.js`
  - Pure active-call matching helpers.
  - Audit target: no phone/name guessing. Safe identities only: externId, queue item, UII, scoped proof.

- `packages/shared-services/src/cxAccountActiveCallWatcherService.js`
  - Account-level watcher.
  - Audit target: this should become the universal call-state projection spine for all rails.

- `packages/shared-integrations/src/ringcxVoiceClient.js`
  - RingCX HTTP client.
  - Audit target: normalize response shapes and rate-limit behavior in one place.

### Terminal outcome and drain

- `packages/shared-services/src/cxBulkLoadOutcomeAdapter.js`
  - Single terminal outbox writer for bulk.

- `packages/shared-models/src/CxTerminalOutbox.js`
  - Durable terminal row.

- `packages/shared-services/src/cxTerminalOutboxDrain.js`
  - Replays terminal rows into cadence/counting.

- `packages/shared-services/src/cxCadenceService.js`
  - Existing call outcome/cadence finalizer.

Audit target: terminal outcome, count update, Logics side effects, and summary work should not be four independent writers for the same call.

### Appointment and Logics workbench

- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx`
  - Appointment modal open/submit/cancel.
  - Audit target: pause/resume state must bracket the form without blanking the current call card.

- `packages/shared-services/src/cxBulkLoadRuntime.js`
  - `pauseRingcxProgressiveDialing` and `resumeRingcxProgressiveDialing`.
  - Audit target: missing state IDs must fail loudly enough for operators, but not crash the session.

- `packages/shared-services/src/cxAppointmentService.js`
  - Canonical appointment record.

- `packages/shared-services/src/cxWorkspaceService.js`
  - `executeCxAppointmentWorkbenchActions` and `executeCxCallSummary`.
  - Audit target: these are workbench/post-call effects, not live dial loop dependencies.

- `apps/control-plane/src/routes/commandsCx.js`
  - Appointment and call-summary routes.
  - Audit target: route should not accidentally trigger legacy dial behavior while in bulk.

## Simplification Targets

### 1. One current-call owner

Preferred shape:

```text
RingCX active-call snapshot
  -> cxAccountActiveCallWatcherService
  -> CxBulkLoadSession.current
  -> UI reads session
```

Things to remove or prevent:

- Browser poll path writing current independently.
- UI staging a lead from its own queue guess.
- Phone/name lookup mutating the middle section.
- Any alternate "current call" field competing with `session.current`.

### 2. One terminal outcome writer

Preferred shape:

```text
button click or watcher release
  -> cxBulkLoadOutcomeAdapter.persistTerminalOutcome
  -> CxTerminalOutbox
  -> cxTerminalOutboxDrain
  -> cxCadenceService.handleCxTerminalCallOutcome
```

Things to remove or prevent:

- Counting in the UI.
- Counting inside the active-call watcher without outbox.
- Logics writes before the terminal fact is durable.
- Multiple idempotency keys for the same `queueItemId:uii`.

### 3. One refill owner

Preferred shape:

```text
session buffer below threshold
  -> reserve rows
  -> publish to RingCX one at a time
  -> only accepted/stamped rows enter buffer
```

Things to verify:

- Refill target is 35 for normal floor use.
- Threshold refill occurs at the configured low-water mark.
- Family order is deterministic.
- New greens enter the shared pool, not an already-running agent buffer.
- Failed publishes release their reservation.

### 4. Appointment is a held workbench action

Preferred shape:

```text
open appointment
  -> RingCX agent state: Working
  -> agent fills form
  -> save appointment + task/activity
  -> RingCX agent state: Available
```

Things to verify:

- Cancel resumes.
- Submit resumes in `finally`.
- Failed Logics task/activity does not wedge the dial session.
- The middle call remains visible until a new UII arrives.

### 5. UI is a projector, not an owner

Preferred shape:

```text
bulk session current with UII
  -> displayed middle card
current disappears
  -> keep latched previous card
new UII arrives
  -> replace card
```

Things to remove or prevent:

- Clearing the middle section on button response.
- Clearing on `current = null`.
- Hiding buttons because RingCX is between calls.
- Letting right-side Logics enrichment overwrite the center card identity.

## Hardening Questions For The Auditor

Answer these with code references before approving a pilot:

1. Can two paths write the same session document at the same time?
2. If RingCX returns a malformed 200 body, do we clear a real call?
3. If an agent clicks DNC while the watcher sees an auto-release, which outcome wins?
4. If a call appears and disappears between watcher ticks, how is it recovered?
5. If disposition transport fails, is the current call still visible and retryable?
6. If Logics fails while setting an appointment, does RingCX resume the agent?
7. If publish says accepted but RingCX inserted zero rows, does the buffer lie?
8. If refill starts twice, can the same row be published twice?
9. If the browser refreshes mid-call, does the middle card rebuild from RingCX/session state?
10. If the control plane restarts, do reserved rows get reconciled without double-dialing?

## Minimum Smoke Tests

Run these before any floor test:

```powershell
node --test tests/cx-bulk-load/cxBulkLoadStateMachine.test.js
node --test tests/cx-bulk-load/cxBulkLoadActiveCallWatcher.test.js
node --test tests/cx-bulk-load/cxAccountActiveCallWatcherService.test.js
node --test tests/cx-bulk-load/cxBulkLoadOutcomeAdapter.test.js
node --test tests/cx-bulk-load/cxTerminalOutboxDrain.test.js
node --test tests/cx-bulk-load/cxBulkLoadRuntimeService.test.js
node --test tests/cx-bulk-load/cxBulkLoadRingcxPublisher.test.js
node --test tests/cx-bulk-load/cxQueueReservationService.test.js
node --test tests/cx-bulk-load/cxReserveModeService.test.js
node --test tests/cx-dial-runtime/cxDialRuntimeModeService.test.js
node --test tests/queue/cxTerminalOutcome.test.js
node --test tests/queue/dispositionMap.test.js
```

Then run one local agent test:

1. Drain the test RingCX campaign.
2. Load a small ordered queue.
3. Confirm RingCX dials the same lead the middle section shows.
4. Click each button path: No Answer, Voicemail, Answer, DNC, Appointment.
5. Confirm the middle card stays visible until a new active UII arrives.
6. Confirm appointment pauses to Working and resumes to Available.
7. Confirm outbox rows are written once per UII-bearing call.
8. Confirm refill triggers only at threshold and publishes only accepted rows.

## Live/Pilot Observability

Watch these logs:

- `control-plane.cx_account_active_call_watcher.tick`
- `control-plane.cx_terminal_outbox.tick`
- `[cx-bulk-load] progressive_pause.set`
- `[cx-bulk-load] progressive_pause.resumed`
- `fill.publish_accepted`
- `fill.publish_failed`
- `disposition.finished`
- `terminalExecutor (HANGUP) START`
- `persistTerminalOutcome (DB WRITE) DONE`

Watch these Mongo shapes:

- `controlplanecxbulkloadsessions.current`
- `controlplanecxbulkloadsessions.buffer`
- `controlplanecxbulkloadsessions.completed`
- `controlplanecxbulkloadsessions.lastOutcome`
- `controlplanecxbulkloadsessions.trace`
- `cxterminaloutboxes.status`
- `controlplanecxdialqueues.state`
- `controlplanecxdialqueues.metadata.reservationSessionId`
- `controlplanecxdialqueues.metadata.lastRingcxPublishedExternId`
- `controlplanecxdialqueues.metadata.servingAt`

## Environment Checks

For appointment hold:

- `RINGCX_VOICE_AUX_WORKING_STATE_ID` must be set.
- `RINGCX_VOICE_AUX_AVAILABLE_STATE_ID` must be set.
- `CX_BULK_LOAD_PROGRESSIVE_PAUSE_ENABLED` defaults to true.
- `CX_BULK_LOAD_PROGRESSIVE_PAUSE_MS` defaults to 3000ms.

For workers:

- `CX_ACCOUNT_ACTIVE_CALL_WATCHER_ENABLED` defaults to true.
- `CX_ACCOUNT_ACTIVE_CALL_WATCHER_INTERVAL_MS` defaults to 1000ms.
- `CX_TERMINAL_OUTBOX_DRAIN_ENABLED` defaults to true.
- `CX_TERMINAL_OUTBOX_DRAIN_INTERVAL_MS` defaults to 15000ms.

## Boundaries

Do not simplify by merging rail-specific delivery behavior back into one multipurpose function. The shared code should be:

- current-call projection;
- terminal outcome outbox;
- queue reservation/refill;
- Logics/call-wrap side effects after terminal.

The rail-specific code should be only:

- how leads are handed to RingCX;
- how quickly the next call is allowed to happen;
- whether the agent must click between calls.

## Auditor Verdict Template

Use this shape for the review output:

```text
Verdict:
- Pilot-ready / not pilot-ready.

Blocking:
- [file:line] issue, concrete failure, proposed fix.

Hardening:
- [file:line] issue, concrete failure, proposed fix.

Simplification:
- [file:line] code can be deleted or split because...

Smoke tests run:
- command/result.

Manual test result:
- agent, campaign, number of calls, button outcomes, refill behavior, outbox count.
```
