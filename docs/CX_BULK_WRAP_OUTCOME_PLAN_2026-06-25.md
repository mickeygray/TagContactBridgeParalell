# CX Bulk Wrap Outcome Plan - 2026-06-25

## 2026-06-25 Revision: Drain-Attached Review First

The safest first version is not a queue-state change. The queue/poller is finally healthy enough
that the next patch should leave it alone and attach correction to the durable terminal drain.

New first-pass user flow:

1. The account active-call watcher sees a UII disappear or switch.
2. It inserts the normal terminal outbox row immediately so the live loop keeps moving.
3. If evidence suggests RingCX auto-dispositioned an answered-ish call, the outbox row is marked
   `reviewStatus: "pending"` with a default outcome and a short review window.
4. The client shows a non-blocking modal:
   `This call was autodispositioned. Please select a more accurate outcome if necessary.`
5. Buttons:
   - `DNC`: correct the outbox payload to `dnc` and let the drain apply DNC/cadence/Logics later.
   - `Appointment`: open the existing appointment flow and attach the appointment result to the row.
   - close/dismiss: accept the default inferred outcome.
6. If the agent ignores it, the row remains available in an `Autodispositioned Calls` workflow under
   appointments until it is resolved or expires to the default outcome.

This avoids making the left queue carry another lifecycle. The current call can continue to advance,
the 1-second poller keeps doing one job, and business writes still happen out of band through the
terminal outbox drain.

## Recommendation

Do Lane A first: drain-attached review. It is additive, reversible, and does not require changing
RingCX campaign behavior. Use it to solve the "caller hung up before the agent clicked DNC or
appointment" gap.

Treat Lane B as a read-only/test-campaign investigation: preview-only or non-timing auto-dispo
settings may produce a cleaner system, but they are RingCX behavior changes. Prove them on one test
campaign before they become a floor mode.

## Lane A - Drain-Attached Autodisposition Review

### Files To Touch

- `packages/shared-services/src/cxBulkLoadActiveCallWatcher.js`
  - Add a pure classifier:
    `classifyAutoDispositionReview({ candidate, previousActiveCall, releaseReason, durationSec })`.
  - Return one of:
    - `did_not_connect`: no review; drain normally.
    - `answered_default`: drain as answered unless corrected.
    - `answered_review`: hold for review, then default to answered.
  - Keep this helper pure and covered by unit tests.

- `packages/shared-services/src/cxAccountActiveCallWatcherService.js`
  - Keep it as the only watcher writer.
  - When building `terminalObservations`, attach review metadata from the classifier.
  - Do not mutate queue state for review. The only durable output is the terminal outbox row.

- `packages/shared-services/src/cxBulkLoadOutcomeAdapter.js`
  - Allow `persistTerminalOutcome` to accept:
    - `reviewStatus`
    - `reviewReason`
    - `reviewUntil`
    - `defaultOutcome`
    - `evidence`
  - Store corrected/default payload fields in one place so the drain does not reconstruct intent.

- `packages/shared-models/src/CxTerminalOutbox.js`
  - Add indexed review fields:
    - `reviewStatus`: `none | pending | accepted | corrected | expired`
    - `reviewUntil`
    - `defaultOutcome`
    - `correction`
    - `reviewReason`
  - Do not store full phone numbers in the new review fields.

- `packages/shared-repositories/src/cxTerminalOutboxRepository.js`
  - Update `listPendingForDrain` to skip rows where `reviewStatus === "pending"` and
    `reviewUntil > now`.
  - Add narrow helpers:
    - `listPendingReviewForAgent(agentEmail, limit)`
    - `acceptReviewDefault(idemKey, actor)`
    - `applyReviewCorrection(idemKey, correction, actor)`
    - `expireDueReviews(now)`

- `packages/shared-services/src/cxTerminalOutboxDrain.js`
  - Drain accepted/corrected/expired rows.
  - If corrected, replay the corrected payload.
  - If expired, replay the default payload.
  - Keep each row independent so one Logics or cadence failure does not block the batch.

- `apps/control-plane/src/routes/cxBulkLoad.js` or a new thin review route
  - Add routes:
    - `GET /api/cx/autodisposition-reviews`
    - `POST /api/cx/autodisposition-reviews/:idemKey/accept`
    - `POST /api/cx/autodisposition-reviews/:idemKey/dnc`
    - `POST /api/cx/autodisposition-reviews/:idemKey/appointment`
  - Route layer stays auth, scope, service call, response.

- `apps/web-client/src/lib/api/queries/cxBulkLoad.ts`
  - Add review query/mutations. Do not tie them to the hot `session` query.

- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx`
  - Add a non-blocking review modal triggered by pending reviews for the logged-in agent.
  - Add a persistent `Autodispositioned Calls` section under appointments for ignored modal rows.
  - Do not disable current-call buttons while a review exists.
  - Do not remove or reshuffle the visible queue from review actions.

### Lane A Acceptance Checks

- A RingCX auto-advance creates exactly one outbox row keyed by `queueItemId:uii`.
- A pending review does not block the next call or active-call poller.
- Closing the modal drains default answered.
- DNC correction drains as DNC and blocks future contact.
- Appointment correction creates/updates appointment state and drains as answered with appointment metadata.
- Repeated clicks on the modal do not duplicate cadence events.
- Restarting control-plane preserves unresolved review rows.
- The drain can replay failed rows without creating duplicate counts.

### Backpressure Rules: No Modal Pile-Up, No Hot-Loop Traffic Jam

The review workflow must be designed as a queue, not as a modal-per-event system.

- The client may show only one autodisposition review modal at a time.
- Additional review rows stay in the durable outbox/review backlog and surface as a badge/count:
  `3 autodispositioned calls need review`.
- Closing or resolving the visible modal advances to the next oldest review row.
- The modal is never required before the current call can continue.
- The hot call loop only inserts the outbox row. It does not call Logics, update DNC, create
  appointments, or drain the review row inline.
- Logics/cadence/appointment work runs through the drain/review commands on a bounded worker.
- The drain should process a small batch with low concurrency, retry failed rows later, and never
  block active-call polling or bulk session projection.
- Pending review rows should be indexed by `agentEmail`, `reviewStatus`, and `reviewUntil` so the
  client query is cheap even if several calls auto-advance in a minute.
- If the backlog grows beyond a small visible threshold, the UI should stop opening the modal
  automatically and leave the agent in the `Autodispositioned Calls` workflow until they catch up.

This keeps worst-case behavior boring: five auto-advanced calls become five durable review rows,
one modal, one badge, and zero extra work in the call handoff path.

## Lane B - Preview / Non-Progressive Investigation

The local RingCX client currently exposes:

- `dispositionCall(uii, ...)`
- `hangupCall(uii)`
- `placeManualCall({ username, destination, callerId, ringDuration })`
- `listActiveCalls(...)`

`placeManualCall` is a real surface, but it is not proven to be the same as "dial next campaign lead
from a preloaded preview queue." Before designing around it, prove these points in a test campaign:

1. Can preview mode keep the agent on a stable lead until our app clicks?
2. Can an API call advance/dial the next campaign lead without the agent clicking inside RingCX?
3. Does the resulting UII include enough `externId` / lead identity to match our queue?
4. Does it preserve campaign metrics and disposition requirements?
5. Does it keep the between-call speed close enough for the floor?

If the answer to those is yes, preview-only could become the scale-stable rail. Until then, it is too
large a production behavior change to use as the first fix.

### API Reading Notes

Official RingCX docs describe the distinction this way:

- Dial groups choose the dialing mode. The documented dial modes include `PREDICTIVE` and `PREVIEW`.
- Preview dialing is one lead to one agent, with time to review lead details before the call is placed.
- Progressive mode is a preview-mode setting (`progressiveEnabled`) that automatically dials after a
  configured `progressiveCallDelay`.
- `maxLeadsReturned` controls how many preview leads the agent can receive at a time, up to 50.
- `requireFetchedLeadsCalled` can force agents to call fetched leads before fetching more.
- Lead loader supports `dialPriority: IMMEDIATE | NORMAL`; this controls where uploaded leads land in
  the dialer cache, not whether the next call is manually or automatically started.
- Active-call management exposes `createManualAgentCall`, which dials a destination from an available
  agent seat. It returns a boolean success value. It is not documented as "dial the next fetched
  campaign lead."
- Lead actions expose `MANUAL_LEADS`, but the docs describe it as adding a manual pass count and
  agent disposition update to selected leads. That may help reconciliation, but it is not documented
  as placing the next preview call.

Implication:

The clean preview experiment is not "swap bulk to placeManualCall" yet. It is:

1. Configure one test dial group/campaign as `PREVIEW`, `progressiveEnabled: false`.
2. Load leads with `NORMAL` priority and stable `externId`.
3. Have the agent fetch/review leads in RingCX.
4. Verify whether RingCX exposes a campaign-owned active call with the same `externalId` when the
   agent initiates the preview call.
5. Separately test `createManualAgentCall` and confirm whether it creates a campaign/lead-owned call
   or just an ad hoc manual call.

Only if step 5 preserves campaign lead identity should the app use `placeManualCall` as the "dial
next" primitive. If it is an ad hoc manual call, it belongs in appointments/manual calls, not the bulk
campaign rail.

## Goal

Bulk mode cannot rely on the agent clicking a terminal button before RingCX advances. If the caller hangs up first, the app must keep moving, infer the basic call class quickly, and leave only the optional exceptions for the agent.

The intended user flow:

1. RingCX active-call poller sees a new `uii`: mark that queue row active.
2. RingCX active-call poller sees that `uii` disappear or switch: immediately create a provisional terminal outcome.
3. If the call evidence says answered, keep the row visible in the queue as a soft wrap row.
4. The wrap row has only exception actions:
   - `X`: accept default answered/cadence and clear the wrap row.
   - `DNC`: stop future contact and clear the wrap row.
   - `Appointment`: open appointment flow, then clear or keep according to appointment result.
5. Timer expiry does the same thing as `X`.

No extra RingCX call should happen from the wrap row. RingCX is already done with that call.

## Invariants

- The active-call watcher is the only source of "who is on the phone now."
- A terminal outbox row is the durable source for "this UII ended."
- The live click path must stay fast: RingCX disposition plus durable outbox insert only.
- DNC and appointment are business corrections/enrichments on a completed call, not RingCX dispositions.
- Full phones must not be added to new client payloads. Use existing sanitized candidate projection.
- Agent scope must stay enforced by the bulk session route/service ownership checks.

## Current Surfaces

### Poller and Terminal Detection

- `packages/shared-services/src/cxAccountActiveCallWatcherService.js`
  - `projectBulkSessionFromAccountSnapshot(...)`
  - Builds `terminalObservations` when active calls disappear or switch.
  - Today it defaults released calls to `did_not_connect`.
  - This is the right place to classify caller-hung-up rows as provisional answered when evidence supports it.

- `packages/shared-services/src/cxBulkLoadActiveCallWatcher.js`
  - `deriveCurrentTransition(...)`
  - Today a switch uses `previousOutcome: "did_not_connect"`.
  - This needs a pure helper to infer previous outcome from active-call evidence.

- `packages/shared-services/src/cxBulkLoadStateMachine.js`
  - `current.matched`
  - `current.released`
  - `buffer.released`
  - Today completed calls go into `completed`.
  - Add a separate `wrapQueue` for answered provisional rows that need optional agent action.

### Durable Outcome and Drain

- `packages/shared-services/src/cxBulkLoadOutcomeAdapter.js`
  - `makeOutcomeIdemKey(...)`
  - `persistTerminalOutcome(...)`
  - Keep idempotency keyed by `queueItemId:uii`.
  - Add support for `status: review_pending` or a payload field like `reviewUntil`.

- `packages/shared-models/src/CxTerminalOutbox.js`
  - Add fields only if needed:
    - `reviewStatus`: `none | pending | accepted | corrected`
    - `reviewUntil`
    - `correction`
  - Prefer payload changes if they are enough, but indexed `reviewUntil/status` may be useful for drain efficiency.

- `packages/shared-repositories/src/cxTerminalOutboxRepository.js`
  - `insertOnce(...)`
  - `listPendingForDrain(...)`
  - Add read/update helpers:
    - `markReviewPending(idemKey, reviewUntil)`
    - `applyCorrection(idemKey, correction)`
    - `acceptReviewDefault(idemKey)`
  - `listPendingForDrain` must skip review-pending rows until `reviewUntil <= now`.

- `packages/shared-services/src/cxTerminalOutboxDrain.js`
  - `drainOnce(...)`
  - Do not drain review-held rows early.
  - If a correction exists, replay the corrected payload.

- `apps/control-plane/src/server.js`
  - `startCxTerminalOutboxWorker(...)`
  - Already runs the drain worker.
  - Keep it as the only place where heavy cadence/Logics/DNC writes occur after terminal insert.

### Bulk Runtime API

- `packages/shared-services/src/cxBulkLoadRuntimeService.js`
  - `sanitizeSession(...)`
  - Add sanitized `wrapQueue`.
  - `submitCxBulkLoadDisposition(...)`
  - Explicit current-call buttons still work as they do now.
  - Add wrap actions as separate service functions, not branches inside current disposition:
    - `acceptCxBulkLoadWrapDefault`
    - `dncCxBulkLoadWrap`
    - `appointmentCxBulkLoadWrap`

- `packages/shared-services/src/cxBulkLoadRuntime.js`
  - Export entry functions for wrap actions.
  - Resolve agent/session ownership exactly like existing bulk commands.
  - Do not let one agent update another agent's wrap row.

- `apps/control-plane/src/routes/cxBulkLoad.js`
  - Add narrow routes:
    - `POST /api/cx/bulk-load/wrap/accept`
    - `POST /api/cx/bulk-load/wrap/dnc`
    - `POST /api/cx/bulk-load/wrap/appointment`
  - Route layer remains auth plus service call only.

### Bulk Client UI

- `apps/web-client/src/lib/api/queries/cxBulkLoad.ts`
  - Extend `CxBulkLoadSession` with `wrapQueue?: CxBulkLoadWrapItem[]`.
  - Add mutation hooks:
    - `useCxBulkLoadWrapAccept`
    - `useCxBulkLoadWrapDnc`
    - `useCxBulkLoadWrapAppointment`

- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx`
  - Current relevant code:
    - `bulk.data?.remainingQueue`
    - `bulkCurrent`
    - `submitQueueDisposition(...)`
    - terminal buttons around the middle form
  - Display queue rows by lifecycle:
    - white: accepted buffer / waiting
    - green: `bulkCurrent`
    - soft neutral: `wrapQueue` answered provisional
    - warm/urgent: wrap row near expiry
  - Add only three wrap actions:
    - `X`: accept default and remove row from visible wrap queue.
    - `DNC`: correct terminal payload to DNC and remove row.
    - `Appointment`: open appointment modal seeded from wrap row.
  - Do not disable the current call buttons when a wrap row exists.
  - Do not clear the whole queue when a wrap action is clicked.

## Implementation Order

### Step 1 - Add Pure Outcome Inference

Create a pure helper, likely in `cxBulkLoadActiveCallWatcher.js`:

```js
inferReleasedOutcome({ candidate, previousActiveCall, activeDurationSec })
```

Rules:

- Explicit non-contact evidence from RingCX: `did_not_connect`.
- If accepted with real UII and duration >= threshold, return `answered_inferred`.
- If accepted with real UII but no reliable duration, return `answered_review`.
- Otherwise return `did_not_connect`.

Use env-configurable threshold, default `30s`.

### Step 2 - Add Wrap Queue to Session State

In `cxBulkLoadStateMachine.js`:

- Initialize `wrapQueue` as an array.
- `current.released`:
  - If outcome is answered-ish (`answered_inferred`, `answered_review`), push to `wrapQueue`.
  - Else push to `completed`.
- `current.matched` with `completePrevious`:
  - Same rule for the departing current.
- `buffer.released`:
  - Same rule for buffered calls that appeared and disappeared between polls.
- Add reducer events:
  - `wrap.accepted`
  - `wrap.corrected`
  - `wrap.expired`

Keep `completed` as history, not the UI action surface.

### Step 3 - Mark Review-Held Outbox Rows

In `cxBulkLoadOutcomeAdapter.js`:

- Add optional payload fields:
  - `reviewRequired`
  - `reviewUntil`
  - `defaultOutcome`
  - `confidence`
  - `evidence`

In `cxTerminalOutboxRepository.js`:

- Add helper to update a pending row by `idemKey`.
- Add filtering in `listPendingForDrain`:
  - rows with `reviewUntil > now` are not returned.

This gives the agent a short correction window without blocking the current call.

### Step 4 - Add Wrap Service Commands

In `cxBulkLoadRuntimeService.js`:

- `acceptWrap({ sessionId, queueItemId, uii })`
  - reducer event: `wrap.accepted`
  - outbox update: accept default payload

- `dncWrap({ sessionId, queueItemId, uii })`
  - reducer event: `wrap.corrected`
  - outbox update: outcome `dnc`, source `wrap-dnc`
  - no RingCX disposition call

- `appointmentWrap({ sessionId, queueItemId, uii, appointment })`
  - create/schedule appointment through existing appointment service
  - outbox update: outcome `answered`, source `wrap-appointment`
  - optional payload note: `appointmentId`

Important: these should not call `terminalExecutor`.

### Step 5 - Expose Routes

In `apps/control-plane/src/routes/cxBulkLoad.js`:

- Add three POST routes.
- Keep `sendBulkCommand` pattern.
- Do not implement business logic in routes.

### Step 6 - Render Wrap Rows in Bulk UI

In `CXWorkspaceBulkLoad.tsx`:

- Merge display list:
  - `bulkCurrent`
  - `bulk.data.remainingQueue`
  - `bulk.data.wrapQueue`
- Do not mix wrap rows into the active-call middle panel.
- Render wrap rows inside the left queue list with different state classes.
- Add urgency color based on `reviewUntil`.
- Wire buttons to new hooks.

Suggested row state names:

```ts
type BulkQueueRowState =
  | "waiting"
  | "active"
  | "wrap-soft"
  | "wrap-urgent";
```

### Step 7 - Drain Behavior

In `cxTerminalOutboxDrain.js`:

- If row is review-pending and not expired, skip it.
- If expired, replay default payload.
- If corrected, replay corrected payload.

This keeps DNC/appointment cleanup off the live handoff.

## Tests To Add

### Pure Watcher Tests

- Caller hang-up with duration over threshold becomes `answered_inferred`.
- No-answer/intercept evidence remains `did_not_connect`.
- UII switch creates one terminal observation for previous call and one current promotion for next call.

### State Machine Tests

- `current.released` answered-ish pushes to `wrapQueue`.
- `current.released` did-not-connect pushes to `completed`.
- `wrap.accepted` removes from `wrapQueue`.
- `wrap.corrected` removes from `wrapQueue` and records last correction.
- `session.killed` clears `wrapQueue`.

### Outbox Tests

- Review-pending row is not drained before `reviewUntil`.
- Expired review row drains with default answered payload.
- DNC correction updates payload before drain.
- Duplicate correction on same `queueItemId:uii` is idempotent.

### Service Tests

- `dncWrap` requires owned session.
- `dncWrap` never calls RingCX disposition.
- `appointmentWrap` does not block current-call state.
- `acceptWrap` is fast and idempotent.

### UI Smoke Tests

- Active row remains green while prior wrap row exists.
- Wrap row shows only `X`, `DNC`, `Appointment`.
- Clicking `X` removes only that wrap row.
- Clicking DNC does not clear current call or the visible accepted queue.
- Timer expiry visually clears wrap row after next refetch.

## What Not To Do

- Do not add a full disposition menu to wrap rows.
- Do not call RingCX from wrap actions.
- Do not block the active call waiting for the wrap row.
- Do not double-write terminal outcomes outside the `queueItemId:uii` idempotency path.
- Do not put full phone numbers into client payloads.
- Do not let legacy queue maintenance mutate bulk wrap rows.
