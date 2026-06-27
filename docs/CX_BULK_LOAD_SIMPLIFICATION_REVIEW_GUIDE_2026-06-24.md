# CX Bulk Load Simplification Review Guide

Purpose: give the next Codex pass a clear way to audit the bulk rail without reintroducing shared writers, legacy queue assumptions, or patchy boolean gates. The goal is simple, atomic code: one function, one job, one owner for each state transition.

## North Star

Bulk mode should be driven by one session state object.

- RingCX receives buffered leads.
- The account active-call watcher reads who RingCX says is currently active.
- The reducer projects that into `current`, `acceptedBuffer`, `completed`, and refill state.
- Buttons only submit terminal intent for the current call.
- Terminal writes go through the terminal/outcome path exactly once.
- `/watch` is read-only for the browser.

If a function both reads RingCX and mutates session state from the browser path, treat it as suspect.

## Review Order

1. Read the state model first.
   - `packages/shared-models/src/CxBulkLoadSession.js`
   - `packages/shared-services/src/cxBulkLoadStateMachine.js`

2. Read the single-writer path.
   - `packages/shared-services/src/cxAccountActiveCallWatcherService.js`
   - `packages/shared-services/src/cxBulkLoadActiveCallWatcher.js`
   - `packages/shared-services/src/cxBulkLoadRuntimeService.js`

3. Read the queue/refill source.
   - `packages/shared-services/src/cxBulkLoadLeadSourceService.js`
   - `packages/shared-services/src/cxQueueReservationService.js`
   - `packages/shared-services/src/cxBulkLoadRingcxPublisher.js`

4. Read terminal/outcome durability.
   - `packages/shared-services/src/cxBulkLoadOutcomeAdapter.js`
   - `packages/shared-services/src/cxTerminalOutboxDrain.js`
   - `packages/shared-services/src/cxTerminalRectificationService.js`

5. Read the client last.
   - `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx`
   - `apps/web-client/src/lib/api/queries/cxBulkLoad.ts`
   - `apps/control-plane/src/routes/cxBulkLoad.js`

## What To Check

### State Ownership

- `watchCxBulkLoadSession` must stay read-only.
- `watchAccountActiveCalls` is the only active-call projection writer.
- Button commands may write terminal intent/results, but must not guess the next visible lead.
- No function should full-document overwrite a session without version/update-time guarding.
- Per-session mutations should go through the runtime mutation queue, not ad hoc `busy` booleans.

### Active Call Matching

- Matching must be identity-first: `externId` or `queueItemId`.
- No phone-only promotion to current.
- Unexpected RingCX active-call response shapes should fail closed, not look like an empty active-call list.
- Account-level polling should fan out to agents from one account read where possible.
- A failed account read should not clear current calls.

### Terminal Outcomes

- Manual buttons and auto-advance should converge on the same terminal outcome writer.
- A released UII should be counted once by idempotency key.
- No terminal write without either a UII or an intentional no-UII fallback key.
- If RingCX advances away from a current call and no button outcome exists, default to `did_not_connect`.
- DNC remains special only in its downstream effects; it should not fork the live state loop.

### Refill

- Refill should be based on live slots: `current + acceptedBuffer`.
- Refill should trigger at threshold and top up toward target.
- Refill must reserve/claim rows before publishing to RingCX.
- If a projection is stale, skip refill instead of publishing against old state.
- Do not live-insert new greens directly into an agent bulk session; they belong in the source pool for the next refill.

### UI

- Bulk UI should mirror the legacy look, not invent a new workflow.
- Between calls, show transition/loading state; do not show stale lead fields as active.
- Buttons should be disabled only while their command is in-flight or the transition state is blocking.
- Error overlays must auto-clear or allow recovery; no permanent blocking state.
- Appointment/legacy next-dial paths must not fire while bulk mode owns call flow.
- Middle panel should not enrich by phone or Logics lookup just to decide the active lead. The active lead comes from RingCX identity.

## Red Flags

- Any browser-triggered endpoint that reads active calls and writes current.
- Any branch named like `legacy`, `simpleLoop`, `slowLane`, or `nextDial` inside bulk command flow unless it is an explicit adapter boundary.
- Any new boolean flag used to paper over ordering instead of moving logic into one owner.
- Any catch block that clears current, empties the buffer, or marks terminal without proof.
- Any phone-number match that changes `current`.
- Any Mongo update that writes the whole session without a version guard.
- Any refill that can publish leads before proving the session projection is still current.

## Smoke Test Plan

Run in this order:

1. Syntax:
   - `node --check packages/shared-services/src/cxBulkLoadRuntimeService.js`
   - `node --check packages/shared-services/src/cxAccountActiveCallWatcherService.js`
   - `node --check packages/shared-services/src/cxBulkLoadActiveCallWatcher.js`
   - `node --check packages/shared-repositories/src/cxBulkLoadSessionRepository.js`

2. Focused tests:
   - `node --test tests/cx-bulk-load/*.test.js`

3. Client:
   - `npm.cmd run typecheck --workspace=web-client`

4. Local agent test:
   - Drain the test agent's RingCX campaign.
   - Start a bulk session with a small known queue.
   - Confirm RingCX active call promotes the matching candidate to the middle panel.
   - Press each terminal button once: Answer, Voicemail, DNC, No answer.
   - Confirm buttons return when the next RingCX active call is detected.
   - Confirm auto-advance without a button creates a terminal buffer/write as `did_not_connect`.
   - Confirm refill occurs when live slots hit the threshold.

## Acceptance Criteria

- The browser cannot mutate active-call projection.
- Account watcher can follow multiple agents without cross-agent churn.
- A malformed RingCX active-call read does not clear everyone.
- Buttons do not hang the UI if RingCX rejects or times out.
- Terminal outcomes are idempotent and UII-grounded where available.
- Refill works from the same queue source as production serving rules.
- Bulk mode can be turned on for a real agent without changing their visible workflow.

## How To Patch

Patch one concern at a time:

1. State ownership.
2. Active-call projection.
3. Terminal/outcome write.
4. Refill.
5. UI recovery.

After each concern, rerun the focused bulk tests. Do not bundle unrelated AI, metrics, or legacy rail cleanup into this pass.
