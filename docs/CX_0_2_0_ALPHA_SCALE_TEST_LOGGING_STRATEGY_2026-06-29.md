# CX 0.2.0 Alpha Scale-Test Logging Strategy - 2026-06-29

Purpose: make the first alpha tests diagnosable while several agents are dialing. When someone says
"my lead disappeared", "buttons are gone", "it dialed the wrong person", "the call did not count", or
"coach is stale", logs should answer the question without guessing.

This is not a request to spam raw payloads. The rule is: log every state handoff and every external
side effect with the same correlation keys, redacted values, and before/after state summary.

## Logging Principles

1. **One event taxonomy.**
   - Use structured event names, not ad hoc `console.log` strings.
   - Prefer `cx.alpha.<area>.<event>` for new alpha logs.
   - Existing `[CXBULK]` traces can stay, but should include the same required fields.

2. **One correlation shape.**
   Every interaction-point log should include:
   - `rail`: `bulk_load`, `slow_single`, or `legacy_emergency`
   - `modeSource`: env override, user override, fallback, unknown
   - `domain`
   - `agentEmail`
   - `agentExtensionId`
   - `sessionId`
   - `queueItemId`
   - `caseId`
   - `externId`
   - `uii`
   - `rcxAccountId`
   - `rcxCampaignId`
   - `rcxDialGroupId`
   - `correlationId`
   - `requestId` when available
   - `at`

3. **Never log sensitive payloads.**
   - No full phone numbers.
   - No SSNs.
   - No raw transcript bodies in normal logs.
   - No API keys, bearer tokens, cookies, or full RingCX request URLs containing secrets.
   - Phone fields should be `phoneLast4`, `phoneHash`, or omitted.

4. **Log the state transition, not the whole state.**
   Use compact summaries:
   - `oldPhase`, `newPhase`
   - `oldCurrentQueueItemId`, `newCurrentQueueItemId`
   - `oldCurrentUii`, `newCurrentUii`
   - `bufferCountBefore`, `bufferCountAfter`
   - `completedCountBefore`, `completedCountAfter`
   - `reviewHoldUntil`
   - `busy`
   - `version`, `expectedVersion`, `savedVersion`

5. **Every external call logs start and finish.**
   Finish must include:
   - `ok`
   - `statusCode`
   - `elapsedMs`
   - `retryable`
   - `rateLimited`
   - `reason`
   - `errorClass`

6. **Heartbeat logs should be compact and periodic.**
   Per-tick logs are too noisy unless filtered. Use:
   - summary every N ticks,
   - full logs only on transition, skip, error, stale, or mismatch,
   - agent filter env for emergency deep tracing.

## Env Controls

Use these as the logging control surface:

- `CX_ALPHA_TRACE_ENABLED=false` by default.
- `CX_ALPHA_TRACE_AGENT=` optional email/extension/session filter.
- `CX_ALPHA_TRACE_SAMPLE_EVERY=30` for periodic heartbeat summaries.
- `CX_BULK_LOAD_FLOW_TRACE=true` keeps current bulk trace behavior.
- `CX_BULK_LOAD_FLOW_TRACE_AGENT=` keeps current targeted trace behavior.
- `CX_BULK_LOAD_DISPOSITION_TRACE=true` only during button/debug tests.
- `CX_ACCOUNT_ACTIVE_CALL_WATCHER_VERBOSE=false` by default; true only for floor-wide watch tests.
- `CX_TERMINAL_OUTBOX_DRAIN_VERBOSE=false` by default; true only for drain validation.
- `LIVE_COACH_TRACE_ENABLED=false` by default; true only for coach batch tests.

Implementation note: new logs should route through one helper such as `logCxAlpha(event, payload)`.
That helper should redact known sensitive keys and honor the agent filter.

## Required Interaction Logs

### 1. Mode Resolution And Login

Files:

- `packages/shared-services/src/cxDialRuntimeModeService.js`
- `apps/web-client/src/workspaces/cx/CXWorkspaceRouter.tsx`
- `packages/shared-services/src/cxWorkspaceService.js`

Events:

- `cx.alpha.mode.resolved`
- `cx.alpha.login.workspace_loaded`
- `cx.alpha.login.session_recovered`
- `cx.alpha.login.session_missing`

Fields:

- required correlation shape
- `requestedMode`
- `resolvedMode`
- `fallbackMode`
- `reason`
- `bulkEnabled`
- `slowEnabled`
- `legacyEnabled`
- `existingSessionId`
- `hasActiveCurrent`
- `visibleQueueCount`

Questions answered:

- Did the agent enter the intended rail?
- Did fallback happen silently?
- Was a stale/current session recovered at login?

### 2. Queue Source And First-Touch Materialization

Files:

- `packages/shared-services/src/cxBulkLoadLeadSourceService.js`
- `packages/shared-services/src/cxGreenFirstTouchQueueMaterializerService.js`
- `packages/shared-services/src/cxGreenFirstTouchSupplyService.js`
- `packages/shared-services/src/cxReserveModeService.js`
- `packages/shared-repositories/src/cxDialQueueRepository.js`

Events:

- `cx.alpha.queue.materialize.started`
- `cx.alpha.queue.materialize.finished`
- `cx.alpha.queue.materialize.skipped`
- `cx.alpha.queue.plan.resolved`
- `cx.alpha.queue.pool.snapshot`

Fields:

- `batchId`
- `queueLane`
- `routeCampaignKey`
- `familyTargets`
- `claimFilter`
- `scanned`
- `eligible`
- `created`
- `wouldCreate`
- `alreadyQueued`
- `skippedByReason`
- `greenCoverageOpen`
- `firstTouchOnly`

Questions answered:

- Why was a new green included or excluded?
- Did first-touch mode narrow the queue safely?
- Did we accidentally starve normal queue building?

### 3. Reservation And Buffer Fill

Files:

- `packages/shared-services/src/cxQueueReservationService.js`
- `packages/shared-services/src/cxBulkLoadRuntimeService.js`
- `packages/shared-repositories/src/cxDialQueueRepository.js`

Events:

- `cx.alpha.reserve.started`
- `cx.alpha.reserve.finished`
- `cx.alpha.reserve.row_selected`
- `cx.alpha.reserve.row_released`
- `cx.alpha.reserve.row_cancelled`
- `cx.alpha.reserve.cross_pool_blocked`
- `cx.alpha.buffer.fill.started`
- `cx.alpha.buffer.fill.finished`

Fields:

- required correlation shape
- `sessionId`
- `reservationSessionId`
- `familyTargets`
- `reservedCount`
- `missingCount`
- `releasedCount`
- `cancelledCount`
- `reason`
- `bufferCountBefore`
- `bufferCountAfter`
- `targetBuffer`
- `refillThreshold`
- `deficit`

Questions answered:

- Which exact rows did the session reserve?
- Did a row vanish because it was blocked, released, cancelled, or published?
- Did refill run twice or with the wrong deficit?

### 4. RingCX Publish / Cancel / Route Lock

Files:

- `packages/shared-services/src/cxBulkLoadRingcxPublisher.js`
- `packages/shared-services/src/ringcxLeadServingService.js`
- `packages/shared-integrations/src/ringcxVoiceClient.js`
- `packages/shared-services/src/cxBulkLoadRuntimeService.js`

Events:

- `cx.alpha.ringcx.publish.started`
- `cx.alpha.ringcx.publish.accepted`
- `cx.alpha.ringcx.publish.rejected`
- `cx.alpha.ringcx.publish.failed`
- `cx.alpha.ringcx.cancel.started`
- `cx.alpha.ringcx.cancel.finished`
- `cx.alpha.ringcx.route_mismatch`

Fields:

- required correlation shape
- `dialPriority`
- `leadCount`
- `acceptedCount`
- `rejectedCount`
- `rejectedExternIds`
- `leadsInserted`
- `statusCode`
- `elapsedMs`
- `rateLimited`
- `retryAfterMs`
- `routeRowCampaignId`
- `routeSessionCampaignId`

Questions answered:

- Did RingCX actually accept the lead?
- Did we believe a phantom accepted lead was in the queue?
- Was the row aimed at the wrong campaign?

### 5. Account Active-Call Watcher

Files:

- `packages/shared-services/src/cxAccountActiveCallWatcherService.js`
- `packages/shared-services/src/cxBulkLoadActiveCallWatcher.js`
- `apps/control-plane/src/server.js`

Events:

- `cx.alpha.watch.tick.summary`
- `cx.alpha.watch.account.read_started`
- `cx.alpha.watch.account.read_finished`
- `cx.alpha.watch.session.projected`
- `cx.alpha.watch.session.skipped`
- `cx.alpha.watch.current.matched`
- `cx.alpha.watch.current.same`
- `cx.alpha.watch.current.switched`
- `cx.alpha.watch.current.released`
- `cx.alpha.watch.current.unmatched`
- `cx.alpha.watch.version_miss`
- `cx.alpha.watch.serving_stamp_miss`

Fields:

- required correlation shape
- `tickId`
- `accountReadCount`
- `sessionCount`
- `activeCallCount`
- `relevantActiveCallCount`
- `matchStatus`
- `transitionKind`
- `matchReasons`
- `releasedCount`
- `currentReleased`
- `terminalObservationCount`
- `busy`
- `skipReason`
- `retriedVersionMiss`
- `elapsedMs`

Questions answered:

- Did the account poll see the current call?
- Did the watcher match by externId/queueItem/UII?
- Did it skip because the session was busy or stale?
- Did it detect a release and write terminal evidence?

### 6. Current Projection And Serving Stamp

Files:

- `packages/shared-services/src/cxAccountActiveCallWatcherService.js`
- `packages/shared-services/src/cxBulkLoadRuntime.js`
- `packages/shared-services/src/cxBulkLoadStateMachine.js`
- `packages/shared-repositories/src/cxDialQueueRepository.js`

Events:

- `cx.alpha.current.promote.started`
- `cx.alpha.current.promote.accepted`
- `cx.alpha.current.promote.rejected`
- `cx.alpha.current.cleared`
- `cx.alpha.serving.stamp.started`
- `cx.alpha.serving.stamp.accepted`
- `cx.alpha.serving.stamp.missed`

Fields:

- required correlation shape
- `oldCurrentQueueItemId`
- `newCurrentQueueItemId`
- `oldCurrentUii`
- `newCurrentUii`
- `oldPhase`
- `newPhase`
- `candidateQueueItemId`
- `candidateExternId`
- `servingAt`
- `wrapUpRequired`
- `expectedVersion`
- `savedVersion`
- `casMatched`
- `reason`

Questions answered:

- Why did the middle panel change?
- Did the queue row get stamped serving before UI current changed?
- Did a stale projection try to adopt a row it no longer owned?

### 7. Client UI Buttons, Holds, And Overlay State

Files:

- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx`
- `apps/web-client/src/lib/api/queries/cxBulkLoad.ts`
- `apps/web-client/src/workspaces/cx/slow-single/CXWorkspaceSlowSingle.tsx`

Events:

- `cx.alpha.client.session.render`
- `cx.alpha.client.current.render`
- `cx.alpha.client.button.press`
- `cx.alpha.client.button.blocked`
- `cx.alpha.client.command.started`
- `cx.alpha.client.command.finished`
- `cx.alpha.client.overlay.set`
- `cx.alpha.client.overlay.cleared`
- `cx.alpha.client.review_hold.started`
- `cx.alpha.client.review_hold.ended`

Fields:

- required correlation shape
- `button`
- `outcome`
- `disabledReason`
- `overlayKind`
- `overlayBlocking`
- `autoClearMs`
- `reviewHoldUntil`
- `hasCurrent`
- `hasUii`
- `remainingQueueCount`
- `elapsedMs`
- `httpStatus`

Questions answered:

- Did the user click a button?
- Was it blocked by client state or server state?
- Did overlay/hold hide or eject the lead?
- Did the client render a stale current after the server moved on?

### 8. Terminal Outcome And Idempotency

Files:

- `packages/shared-services/src/cxBulkLoadRuntimeService.js`
- `packages/shared-services/src/cxBulkLoadOutcomeAdapter.js`
- `packages/shared-repositories/src/cxTerminalOutboxRepository.js`
- `packages/shared-services/src/cxTerminalRectificationService.js`

Events:

- `cx.alpha.terminal.started`
- `cx.alpha.terminal.ringcx_result`
- `cx.alpha.terminal.outbox_insert.started`
- `cx.alpha.terminal.outbox_insert.finished`
- `cx.alpha.terminal.duplicate`
- `cx.alpha.terminal.deferred`
- `cx.alpha.terminal.rectification.preview`
- `cx.alpha.terminal.rectification.inserted`

Fields:

- required correlation shape
- `outcome`
- `source`
- `eventType`
- `idemKey`
- `terminalEvidenceKeys`
- `duplicate`
- `inserted`
- `terminalRecordDeferred`
- `ringcxOk`
- `ringcxReason`
- `elapsedMs`

Questions answered:

- Did this call count?
- Was it deduped correctly?
- Did a watcher no-answer beat the user’s real disposition?
- Did terminal write fail but session still advance?

### 9. Terminal Outbox Drain, LeadCadence, And Logics

Files:

- `packages/shared-services/src/cxTerminalOutboxDrain.js`
- `packages/shared-services/src/cxCadenceService.js`
- `packages/shared-services/src/cxCallWrapService.js`
- `packages/shared-services/src/cxAgentCallNoteService.js`
- `apps/control-plane/src/server.js`

Events:

- `cx.alpha.drain.tick.started`
- `cx.alpha.drain.tick.finished`
- `cx.alpha.drain.row.started`
- `cx.alpha.drain.row.replayed`
- `cx.alpha.drain.row.failed`
- `cx.alpha.drain.call_note.written`
- `cx.alpha.drain.call_wrap.enqueued`
- `cx.alpha.logics.activity.started`
- `cx.alpha.logics.activity.finished`
- `cx.alpha.lead_cadence.touch.written`

Fields:

- required correlation shape
- `idemKey`
- `pendingCount`
- `scanned`
- `replayed`
- `failed`
- `duplicates`
- `outcome`
- `logicsCaseId`
- `logicsActivityId`
- `callNoteKey`
- `threadKey`
- `hasCallSummary`
- `hasInterviewSnapshot`
- `elapsedMs`
- `reason`

Questions answered:

- Did terminal evidence make it from outbox into business writes?
- Did Logics fail while Mongo succeeded?
- Is a call summary available for grading/nightly email?

### 10. Appointment / Call Wrap-Up

Files:

- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx`
- `packages/shared-services/src/cxBulkLoadRuntime.js`
- `packages/shared-services/src/cxCallWrapService.js`
- `packages/shared-services/src/cxWorkspaceService.js`

Events:

- `cx.alpha.wrap.appointment.started`
- `cx.alpha.wrap.appointment.step`
- `cx.alpha.wrap.appointment.finished`
- `cx.alpha.wrap.agent_status.started`
- `cx.alpha.wrap.agent_status.finished`
- `cx.alpha.wrap.partial_failure`

Fields:

- required correlation shape
- `step`
- `stepOk`
- `stepSkipped`
- `stepReason`
- `terminalOk`
- `workbenchOk`
- `assignOk`
- `postDateOk`
- `agentStatusFrom`
- `agentStatusTo`
- `elapsedMs`

Questions answered:

- Which appointment wrap step failed?
- Did the agent get moved to working/available?
- Did a partial appointment still terminalize the call?

### 11. Coach / STT / Summary Handoff

Files:

- `packages/shared-services/src/liveCoachBusService.js`
- `packages/shared-services/src/liveCoachRuntimeModeService.js`
- `packages/shared-services/src/cxCallWrapService.js`
- `packages/shared-services/src/cxAgentCallNoteService.js`
- `apps/control-plane/src/server.js`

Events:

- `cx.alpha.coach.session.bound`
- `cx.alpha.coach.transcript.delta_received`
- `cx.alpha.coach.batch.started`
- `cx.alpha.coach.batch.finished`
- `cx.alpha.coach.guidance.dispatched`
- `cx.alpha.coach.summary.ready`
- `cx.alpha.coach.summary.attached_to_terminal`
- `cx.alpha.coach.summary.missing`
- `cx.alpha.coach.model.skipped`
- `cx.alpha.coach.model.failed`

Fields:

- required correlation shape
- `coachSessionId`
- `batchId`
- `activeConversationCount`
- `changedConversationCount`
- `transcriptDeltaCount`
- `summaryArrayLength`
- `guidanceCount`
- `modelProvider`
- `modelName`
- `cachedInputTokens`
- `inputTokens`
- `outputTokens`
- `elapsedMs`
- `reason`

Questions answered:

- Was the coach bound to the right UII/case/agent?
- Did new transcript data reach the coach?
- Was a summary available when the terminal drain ran?
- Did the model call happen, skip, or fail?

### 12. Nightly / Deferred Work

Files:

- `apps/control-plane/src/services/cxNightlyCallGradeRuntime.js`
- `packages/shared-services/src/cxAgentCallNoteService.js`
- `docs/AI_HEADLESS_AGENT_COACH_WIRING_IMPL_2026-06-26.md`

Events:

- `cx.alpha.nightly.grade.started`
- `cx.alpha.nightly.grade.agent_started`
- `cx.alpha.nightly.grade.agent_finished`
- `cx.alpha.nightly.grade.call_skipped`
- `cx.alpha.nightly.grade.email_sent`
- `cx.alpha.nightly.grade.failed`

Fields:

- `agentEmail`
- `callNoteCount`
- `gradeCandidateCount`
- `skippedByReason`
- `durationThresholdSeconds`
- `modelRunner`
- `elapsedMs`
- `emailOk`
- `errorClass`

Questions answered:

- Did call notes become grade candidates?
- Which calls were skipped and why?
- Did the nightly grade/email finish?

## High-Signal Heartbeats

These should emit periodically during a scale test, even when nothing is wrong.

### Account Watcher Heartbeat

Event: `cx.alpha.watch.heartbeat`

Interval: every 30 ticks or every 30 seconds.

Fields:

- `tickCount`
- `accountReadCount`
- `sessionCount`
- `activeCallCount`
- `writeCount`
- `terminalWriteCount`
- `skippedCount`
- `errorCount`
- `rateLimitCount`
- `maxReadElapsedMs`
- `avgReadElapsedMs`

### Per-Session Heartbeat

Event: `cx.alpha.session.heartbeat`

Interval: every 30 seconds per running session, or on unchanged current for more than 60 seconds.

Fields:

- required correlation shape
- `phase`
- `status`
- `currentAgeMs`
- `sameCurrentTicks`
- `sameCurrentSeconds`
- `bufferCount`
- `lastWatchAt`
- `lastTransitionKind`
- `lastTerminalOutcomeAt`
- `lastError`

### Drain Heartbeat

Event: `cx.alpha.drain.heartbeat`

Interval: every drain tick where `pendingCount > 0`, plus every 60 seconds while enabled.

Fields:

- `pendingCount`
- `oldestPendingAgeMs`
- `scanned`
- `replayed`
- `failed`
- `callWrapReady`
- `callNoteWritten`
- `logicsFailures`

## Complaint Triage Queries

For any agent complaint, grep in this order:

1. `agentEmail` or `agentExtensionId`
2. `sessionId`
3. `queueItemId`
4. `externId`
5. `uii`
6. `caseId`

Common questions:

- **Lead disappeared:** check `reserve`, `publish`, `current`, `client.render`, `terminal`, `drain`.
- **Wrong lead in middle:** check `watch.current.matched`, `matchReasons`, `serving.stamp`, `client.current.render`.
- **Buttons missing:** check `client.button.blocked`, `client.overlay.set`, `review_hold`, `hasCurrent`, `hasUii`.
- **Call did not count:** check `terminal.outbox_insert`, `drain.row.replayed`, `lead_cadence.touch.written`.
- **Same lead came back:** check `terminal.duplicate`, `reservation.release`, `stale_serving`, `first_touch` filters.
- **Coach stale:** check `coach.session.bound`, `transcript.delta_received`, `coach.summary.ready`, `summary.attached_to_terminal`.

## Implementation Order

1. Add `logCxAlpha(event, payload)` helper with redaction and agent filtering.
2. Normalize existing `[CXBULK]` trace payloads to include the required correlation shape.
3. Add account watcher heartbeat and transition logs.
4. Add terminal/outbox/drain logs.
5. Add client button/overlay logs.
6. Add coach/session/summary handoff logs.
7. Add first-touch/materializer logs.
8. Add stale-serving diagnostic hardening logs.

## Implementation Ledger - 2026-06-29 Pass

Implemented now:

- `packages/shared-services/src/cxAlphaTraceService.js`
  - Adds `logCxAlpha(event, payload, options)`.
  - Default-off behind `CX_ALPHA_TRACE_ENABLED`.
  - Supports `CX_ALPHA_TRACE_AGENT` filtering across agent/session/current identifiers.
  - Redacts phone/ANI/DNIS, customer/contact email fields, transcript, recording/audio, auth, token, cookie, password, secret, API key, SSN-style keys.
  - Preserves agent correlation keys such as `agentEmail` and `agentExtensionId` for grep-based triage.
  - Catches logger failures and returns `false`; no application path depends on log completion.

- `packages/shared-services/src/cxBulkLoadRuntimeService.js`
  - Existing `traceBulkFlow(...)` now also emits `cx.alpha.bulk.<stage>` when alpha trace is enabled.
  - Existing `[CXBULK]` behavior and `CX_BULK_LOAD_FLOW_TRACE` remain unchanged.

- `packages/shared-services/src/cxAccountActiveCallWatcherService.js`
  - Emits account read start/finish timing.
  - Emits per-session projection summaries.
  - Emits watcher tick summary/applied summary.
  - Emits serving-stamp accepted/missed, version-miss recovered/unrecovered, session persisted/skipped.
  - Emits terminal observation skipped and terminal outbox insert finished.

- `packages/shared-services/src/cxTerminalOutboxDrain.js`
  - Emits drain scan/tick start/tick finish.
  - Emits row replay, row skip/failure, call-note finish/failure, call-wrap finish/failure.
  - Does not change drain ordering or failure behavior.

- `packages/shared-services/src/cxGreenFirstTouchQueueMaterializerService.js`
  - Emits first-touch materializer summary as `cx.alpha.queue.green_first_touch.materialized`.

Verification added:

- `tests/cx-bulk-load/cxAlphaTraceService.test.js`
  - Proves default-off behavior.
  - Proves redaction.
  - Proves logger failures are swallowed.
  - Proves agent filtering and payload bounds.

Still intentionally not done in this pass:

- Client render/button telemetry.
- Coach/transcript telemetry.
- Periodic heartbeat aggregation/sampling beyond the per-event watcher/drain summaries.
- RingCX publisher adapter-level start/finish logs.

## Acceptance Bar Before Scale Test

Before putting more than one real agent on alpha:

- For a single test call, logs show:
  1. queue row selected,
  2. reservation owner,
  3. RingCX publish accepted,
  4. active-call watcher match,
  5. serving stamp accepted,
  6. client current rendered,
  7. button or auto-release terminal outcome,
  8. outbox insert,
  9. drain replay,
  10. LeadCadence/Logics/call-note result.
- A grep by one `uii` or `queueItemId` reconstructs the whole lifecycle.
- A grep by one `agentEmail` shows mode, session, current, buffer, skipped watcher ticks, button presses,
  terminal writes, and drain status.
- No log contains full phone, SSN, token, raw transcript, or credentials.
