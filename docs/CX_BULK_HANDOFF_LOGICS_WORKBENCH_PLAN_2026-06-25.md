# CX Bulk Handoff + Logics Workbench Plan - 2026-06-25

## Purpose

Bulk mode is now close enough that the next work should be written down before more code gets layered on.

There are two connected goals:

1. Keep the bulk/progressive handoff visually stable.
2. Make the CX workspace earn its keep as a Logics-backed agent workbench.

The important operational observation from the latest test is that RingCX appears to respect the progressive delay/counter between dials. If that remains true, the app does not need a heavy custom review layer in the hot path. The safer rule is simpler:

> The middle call panel only releases or changes when RingCX reports a new active call with a new UII.

The counter can run. The agent can see the last call. The app should not blank, eject, or swap the middle section until the active-call watcher proves the next call.

## Current Local State

Relevant surfaces:

- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx`
- `packages/shared-services/src/cxAccountActiveCallWatcherService.js`
- `packages/shared-services/src/cxBulkLoadStateMachine.js`
- `packages/shared-services/src/cxBulkLoadRuntimeService.js`
- `packages/shared-services/src/cxBulkLoadRuntime.js`
- `packages/shared-services/src/cxBulkLoadOutcomeAdapter.js`
- `packages/shared-models/src/CxBulkLoadSession.js`
- `packages/shared-models/src/CxTerminalOutbox.js`

Current behavior from the latest local pass:

- RingCX accepted bulk-loaded leads before dialing.
- A lead did not get a UII merely by being accepted into RingCX.
- The UII appeared only when RingCX surfaced/dialed the active call.
- The watcher matched the call by safe identity (`externId` / queue item / UII), not phone/name.
- The UI has a local latch so the last confirmed bulk call can stay visible while `current` is null.
- The UI clears the "loading next lead" transition only when a refreshed session has `current.uii`.
- `Set appointment` can be opened from the held middle card and calls the bulk pause route.
- Bulk pause uses the configured Working state first:
  - `RINGCX_VOICE_AUX_WORKING_STATE_ID`
  - then resume uses `RINGCX_VOICE_AUX_AVAILABLE_STATE_ID`.

## Non-Negotiable Handoff Rule

The bulk center panel must behave like a latch.

Allowed:

- New confirmed `bulkCurrent.uii` replaces the displayed lead.
- Session stop/kill clears the panel.
- Explicit mode switch away from bulk clears the panel.

Not allowed:

- Server response to disposition clears the middle panel by itself.
- `current = null` clears the middle panel by itself.
- Countdown expiry clears the middle panel by itself.
- Query refetch with no current clears the middle panel by itself.
- Manual "No answer" click blanks the panel before RingCX reports the next UII.

Implementation principle:

```text
displayedCall = confirmedCurrentWithUii || latchedPreviousCall
```

If there is no confirmed new UII, the old call remains visible.

## Immediate Verification Checklist

Run this before treating the bulk counter/handoff as stable:

1. Load a known ordered test queue for one local agent.
2. Confirm RingCX delay/counter runs between progressive dials.
3. Confirm the middle card remains visible after:
   - manual No answer
   - DNC
   - Answer
   - Voicemail, if enabled
   - auto-advance/no-answer from RingCX
4. Confirm the middle card only changes when the watcher sees a different active UII.
5. Confirm the buttons do not disappear just because `bulk.data.current` becomes null.
6. Confirm `Set appointment` from the held card changes agent state to Working/pause.
7. Confirm closing/submitting appointment resumes the agent to Available.
8. Confirm no Logics writes happen in the active-call watcher hot path.
9. Confirm the terminal outbox/cadence event still gets one row per `queueItemId:uii`.
10. Confirm refresh/reload of the browser does not strand the agent in a blank panel while RingCX is between calls.

Useful checks:

- Bulk session document:
  - `controlplanecxbulkloadsessions.current`
  - `lastOutcome`
  - `acceptedBuffer.length`
  - `completed[]`
  - `reviewHoldUntil`
  - `trace.accountActiveCallWatcher`
- Control-plane logs:
  - `control-plane.cx_account_active_call_watcher.tick`
  - `progressive_pause.set`
  - `progressive_pause.resumed`
  - `disposition.finished`
- UI logs:
  - `[disp] PRESS`
  - `[disp] disposition RESOLVED`
  - `[bulk-preview] START_NEXT`

## What To Remove Or Avoid

If RingCX delay remains reliable, avoid building a modal-heavy auto-review loop into the hot path.

Keep:

- one-second account active-call watcher
- UII-grounded middle-panel latch
- terminal outbox for durable outcomes
- optional review/backlog later only for true exceptions

Avoid:

- modal per auto-advanced call
- Logics calls while advancing calls
- client-side guessing based on phone/name
- clearing form/case state before a new UII
- adding booleans to patch every symptom

## Logics Workbench Direction

The CX workspace should become the place where agents work a case while the app quietly posts useful work back to Logics and to the lead source.

The side panel stays compact, but Logics writes should be baked into the actions agents already take:

- Set appointment
- Interview/form save
- Call summary/call notes
- DNC/postdate/answered terminal outcomes
- contact/context hydration when the lead returns

This should make the app feel like a Logics tool, not just a RingCX wrapper.

## Core Architecture Rule

Do not let Logics writes slow the dialer loop.

Hot path:

```text
RingCX active call -> current UII projection -> terminal outbox -> next call projection
```

Workbench path:

```text
agent action / call summary / interview -> local action packet -> durable worker/outbox -> Logics + source update
```

Logics calls should run out of band and be idempotent. If Logics is slow or down, the call loop should continue.

## Proposed Action Packet Shape

Use one normalized packet for these side effects:

```json
{
  "domain": "WYNN",
  "caseId": 101617,
  "queueItemId": "mongo-id",
  "uii": "ringcx-uii",
  "agentEmail": "agent@example.com",
  "agentExtensionId": "21018",
  "sourceType": "leadCadence",
  "sourceId": "mongo-id",
  "actionType": "appointment.set",
  "payload": {},
  "idemKey": "appointment.set:WYNN:101617:queueItemId:uii"
}
```

Actions should be narrow:

- `appointment.set`
- `appointment.release`
- `interview.snapshot.saved`
- `call.summary.ready`
- `terminal.dnc`
- `terminal.answered`
- `terminal.did_not_connect`
- `source.context.patch`

## Feature 1: Appointment Card To Logics

Goal:

When the agent sets an appointment in the app, Logics should also receive a task/activity with the same date/time context.

Desired flow:

1. Agent clicks `Set appointment`.
2. Bulk mode pauses the agent state to Working.
3. Agent enters appointment date/time/timezone/note.
4. App saves canonical CX appointment.
5. Worker creates a Logics task assigned to the mapped Logics user.
6. Worker creates a sparse Logics activity:
   - appointment set
   - requested time
   - agent
   - short note
7. Worker patches lead source metadata:
   - appointmentId
   - appointmentAt
   - appointmentTimezone
   - appointmentAgent
   - lastAction summary
8. Agent returns to Available when form closes/submits.

Existing useful code:

- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx`
  - `AppointmentModal`
  - `handleAppointmentModalOpen`
  - `handleAppointmentSubmit`
  - `handleAppointmentModalClose`
- `apps/web-client/src/lib/api/queries/cx.ts`
  - `useCxCreateAppointment`
  - `useCxLogicsTask`
  - `useCxLogicsActivity`
- `packages/shared-services/src/cxAppointmentService.js`
- `packages/shared-services/src/cxWorkspaceService.js`
  - `executeCxLogicsTask`
  - `executeCxLogicsActivity`
- `apps/control-plane/src/routes/commandsCx.js`
  - `/:domain/appointments`
  - `/:domain/logics/task`
  - `/:domain/logics/activity`

Implementation note:

Do not have the browser call task/activity directly after appointment submit. Prefer the appointment service to enqueue or execute the Logics side effects so retry/idempotency is centralized.

Acceptance checks:

- duplicate submit does not create duplicate Logics tasks
- missing Logics user mapping shows a recoverable warning, not a broken appointment
- Logics failure leaves a retryable local action
- appointment still saves if activity creation fails
- no full SSN or sensitive financial detail is written to task/activity text

## Feature 2: Interview/Form To Logics Activity

Goal:

The interview improves guidance during the call and becomes a durable case note after the call.

Current partial behavior already exists:

- `CXWorkspaceBulkLoad.tsx` builds an interview activity note.
- `cxWorkspaceService.js` has `executeCxInterviewSnapshot`.
- It saves to LeadCadence and posts a Logics activity.

Next hardening:

1. Make interview save use the same action packet/outbox pattern.
2. Keep the Logics activity sparse.
3. Keep the richer structured snapshot in app/source context.
4. Hydrate future calls from the saved structured snapshot.
5. Ensure the interview activity is tied to the same queue source when possible.

Sparse Logics activity example:

```text
CX interview captured.
Issue: CP504 / IRS balance concern.
Need: wants payment relief, worried about levy.
Next step: appointment set for June 26, 2026 10:00 AM PT.
```

Store internally:

- structured issue/facts
- notice type
- urgency
- balance range
- pain points
- objections
- next step
- coach summary keys

Acceptance checks:

- form save does not block call advancement
- Logics activity posts once
- source row contains structured snapshot
- future call can read and display the snapshot
- redaction rules remain intact

## Feature 3: Call Notes / Summary

Goal:

At the end of a substantive call, the app should preserve a useful call summary in two places:

1. App/contact/source context, richer and useful for future coaching.
2. Logics activity, sparse and safe.

This should not be the same as the agent grader email. The agent email can be detailed. Logics should get a concise business record.

Inputs:

- transcript/semantic coach summary
- interview snapshot
- terminal outcome
- appointment/DNC/postdate actions
- queue source metadata

Outputs:

- `contactContext.lastCallSummary`
- `sourceContext.lastCallSummary`
- `CaseProfile.communications[]` call entry
- Logics activity
- optional call log summary field

Do not post:

- full transcript
- internal score/rubric
- sensitive financial detail beyond what belongs in Logics
- hallucinated or low-confidence summary

Acceptance checks:

- no transcript/no substance means no detailed Logics summary
- longer/substantive calls produce a summary packet
- summary survives future lead hydration
- communication array gets a brief, readable call note when someone actually talked to the prospect
- Logics post is retryable and idempotent

### Backend-Only Coach Summary Route

Leave this off the coach UI for now. The coach UI is close but not ready to own another visible surface, and the summary flow should not become a second frontend project while the dial rails are still being stabilized.

The right shape is an unused backend route/contract that says, effectively:

```text
coach call summary goes here
```

Proposed route:

```http
POST /api/commands/cx/:domain/coach/call-summary
```

Proposed body:

```json
{
  "caseId": 101617,
  "queueItemId": "mongo-id",
  "uii": "ringcx-uii",
  "callLogId": "optional",
  "coachSessionId": "optional",
  "terminalOutcome": "answered",
  "interviewSnapshot": {},
  "sourceType": "leadCadence",
  "sourceId": "mongo-id",
  "reason": "terminal-outbox-drained"
}
```

Initial behavior:

- accept and validate the identity packet
- do not render anything in the coach UI
- do not block the dialer loop
- enqueue or proxy into the existing AI-bus live coach closeout lane when `coachSessionId` exists
- otherwise persist a sparse "summary requested / pending coach artifact" marker for later worker pickup

Do not create a second summarizer. Existing useful closeout code already lives in:

- `packages/shared-services/src/liveCoachCloseoutService.js`
- `packages/shared-services/src/liveCoachBusService.js`
- `apps/ai-bus/src/server.js`

The durable communication target already exists:

- `packages/shared-repositories/src/caseProfileRepository.js`
  - `appendCommunicationEntry(domain, caseId, "call", entry)`
- `packages/shared-models/src/CaseProfile.js`
  - `communications[]`

The communication entry should be short and operational:

```json
{
  "channel": "call",
  "direction": "outbound",
  "status": "answered",
  "provider": "live-coach",
  "threadKey": "live-coach:session-id",
  "subject": "CX call summary",
  "body": "Brief summary of what was discussed and the agreed next step.",
  "source": "live-coach-closeout",
  "metadata": {
    "sessionId": "session-id",
    "uii": "ringcx-uii",
    "queueItemId": "mongo-id",
    "durationSec": 245,
    "transcriptArtifactPath": "optional-runtime-or-storage-pointer",
    "contextKeys": ["price_objection", "cp504"]
  }
}
```

The transcript should not be pasted into the communication body. If transcript access is needed, store a pointer to the coach artifact/session/transcript and render that from the richer coach/case context later.

This route is a bridge from CX terminal/workbench events into that existing closeout system. The frontend can consume the result later as a right-panel "last call summary" or coach panel artifact, but not in this first pass.

### CaseProfile Access Boundary

Do not assume the queue/workspace load already has full CaseProfile data.

Current loading shape:

- `buildCxWorkspace` calls `buildCxQueueItems`.
- `buildCxQueueItems` reads active `CxDialQueue` rows and enriches them with matching `LeadCadence` docs.
- The served queue item carries `caseId`, phone/name/lead body, `payloadSnapshot`, and cadence context.
- It does **not** load full `CaseProfile.communications[]` for every queue row.

That is correct for speed. Loading every visible queue item's CaseProfile/communications during the workspace load would turn queue refresh into a heavy fan-out.

CaseProfile data is available through case-specific readers after a case is known:

- `useCxCommLog` calls `/api/read/cx/case/:domain/:caseId/comm-log`.
- `buildCxCommLog` resolves identity from CaseProfile / MasterProspect / LeadCadence.
- It then fans in `CaseProfile.communications[]`, `CallLog`, `ConversationMessage`, and `LeadCadence.schedule.actions`.

Write rule:

- The summary worker only needs `domain` + `caseId` to append a communication entry.
- `caseProfileRepository.appendCommunicationEntry(domain, caseId, "call", entry)` upserts if the profile does not already exist.
- The communication entry will show in the side panel on the next `comm-log` read.
- If the summary worker needs richer profile details, it should read CaseProfile inside the worker, not in the queue/watcher hot path.

## Feature 4: Persist Back To Queue Source

Goal:

If a lead came from LeadCadence, its useful call context must be written back there so the next serve starts warm.

For each source row, store compact context:

```json
{
  "cxContext": {
    "lastCallAt": "2026-06-25T21:22:54.671Z",
    "lastUii": "202606251720290830000440994229",
    "lastOutcome": "did_not_connect",
    "lastAgentEmail": "agent@example.com",
    "lastSummary": "Short safe summary",
    "lastInterviewSnapshotId": "optional",
    "appointmentId": "optional",
    "appointmentAt": "optional",
    "flags": ["cp504", "price_objection"]
  }
}
```

Source persistence must work for:

- LeadCadence
- CxDialQueue row metadata
- CaseProfile/client profile where available
- future source types

Implementation surfaces:

- `packages/shared-repositories/src/leadCadenceRepository.js`
- `packages/shared-services/src/cxWorkspaceService.js`
- `packages/shared-services/src/cxCadenceService.js`
- `packages/shared-services/src/cxBulkLoadOutcomeAdapter.js`
- `packages/shared-services/src/cxTerminalOutboxDrain.js`

Acceptance checks:

- source update is idempotent by `queueItemId:uii:actionType`
- DNC blocks future serving from the same source
- appointment hold prevents normal pool re-entry
- no source update can bring a DNC/blocked lead back into queue
- hydration pulls this context back into the center/side panels

## Feature 5: Side Panel Shape

Keep the right panel small and useful.

Sections:

- Appointments
- Logics info
- Tasks
- Activities
- Last call context

Do not make the side panel a second dashboard. The middle panel is for the live call. The side panel is supporting case context and follow-up work.

Expected UI improvements:

- Appointment card can create Logics task/activity.
- Last call context appears as a compact note.
- Activities/tasks update after background write completes.
- Failed background writes show a small retryable status, not a blocking modal.

## Implementation Phases

### Phase 0 - Prove The Handoff Latch

Files:

- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx`
- `packages/shared-services/src/cxAccountActiveCallWatcherService.js`

Tasks:

- test all terminal buttons under progressive delay
- verify middle panel changes only on new UII
- remove or disable any remaining clear-on-null behavior
- document exact RingCX delay setting used in the test campaign

Exit criteria:

- no blank middle card between dials
- no stale wrong lead after next UII
- no button disappearance before next UII

### Phase 1 - Appointment To Logics Task

Files:

- `packages/shared-services/src/cxAppointmentService.js`
- `packages/shared-services/src/cxWorkspaceService.js`
- `apps/control-plane/src/routes/commandsCx.js`
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx`

Tasks:

- build `appointment.set` packet
- create Logics task from appointment payload
- create appointment activity note
- persist appointment metadata to source
- add retry/idempotency

Exit criteria:

- one appointment creates one local appointment and one Logics task
- Logics failure does not lose appointment
- source row is patched

### Phase 2 - Interview Activity Hardening

Files:

- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx`
- `packages/shared-services/src/cxWorkspaceService.js`
- `packages/shared-repositories/src/leadCadenceRepository.js`

Tasks:

- move/keep rich data in source context
- keep Logics note sparse
- add idempotent action key
- hydrate future call from saved interview context

Exit criteria:

- interview appears on return call
- Logics activity posts once
- no PII regression

### Phase 3 - Call Summary Packet

Files:

- coach/end-of-call summary service
- `packages/shared-services/src/cxTerminalOutboxDrain.js`
- `packages/shared-services/src/cxWorkspaceService.js`
- `packages/shared-repositories/src/leadCadenceRepository.js`

Tasks:

- define summary threshold
- build sparse Logics summary formatter
- store richer app/contact summary
- connect to terminal drain or post-call worker

Exit criteria:

- no summary for empty/non-substantive calls
- substantive call creates app summary and sparse Logics activity
- retry is safe

### Phase 4 - Contact Panel Hydration

Files:

- `apps/control-plane/src/routes/readCx.js`
- `packages/shared-services/src/cxWorkspaceService.js`
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx`

Tasks:

- read latest context from source/profile/call log
- render compact last-call context
- keep Logics side panel as supporting details

Exit criteria:

- returning lead shows last useful context
- stale context is timestamped
- no expensive Logics read is required on every poll

## Line-By-Line Code Audit Implementation Guide

This section is the implementation audit checklist. It is written from the current local tree and should be followed before adding more behavior.

### A. Bulk Handoff Latch And No-Eject Rule

Files:

- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx`
- `packages/shared-services/src/cxBulkLoadRuntimeService.js`
- `packages/shared-services/src/cxBulkLoadStateMachine.js`
- `packages/shared-services/src/cxBulkLoadRuntime.js`

Current code to preserve:

- `CXWorkspaceBulkLoad.tsx:3959-3966` wires the bulk query/mutations. Keep this as the only browser bulk command surface.
- `CXWorkspaceBulkLoad.tsx:3970-3991` defines `bulkLatchedCall`, `bulkConfirmedCurrent`, `bulkDisplayCandidate`, and `bulkDisplayIsCurrent`. This is the core latch. Do not replace it with phone/name lookup or legacy current-call state.
- `CXWorkspaceBulkLoad.tsx:4360-4379` resets the latch only on session change/non-running, then refreshes it from a confirmed `current.uii`. This is the correct visual bridge over RingCX's between-call gap.
- `CXWorkspaceBulkLoad.tsx:5678-5750` sends disposition to the bulk endpoint and only clears the loading transition when a refetched session has `current.uii`.
- `cxBulkLoadRuntimeService.js:566-658` is the server terminal path: load state, call RingCX disposition, persist one terminal outcome, reduce `terminal.accepted`, maybe refill, return.
- `cxBulkLoadStateMachine.js:218-234` intentionally clears `state.current` on `terminal.accepted`. Keep this. Server truth should say "no active call" after disposition; the browser latch handles visual continuity.
- `cxBulkLoadRuntime.js:879-948` maps button outcome to RingCX disposition, sends `dispositionCall`, starts progressive pause, and verifies release. Do not add browser-side hangup logic.

Current code to tighten:

- `CXWorkspaceBulkLoad.tsx:4443-4448` clears served selection and case panel when bulk is running but `bulkDisplayCandidate` is absent. This is the risky line. It must only run for a true empty/ended session, not during a normal RingCX release gap.
  - Preferred change: replace the effect with an explicit `if (!bulkRunning && !bulkConfirmedCurrent && !bulkLatchedCall)` clear, or remove it after proving session stop/kill already clears via `bulkSessionId` reset.
  - Do not let `current = null` alone blank the middle card.
- `CXWorkspaceBulkLoad.tsx:4418-4440` auto-review countdown currently clears the review banner on new confirmed current or expiry. That is fine, but it must never clear `bulkLatchedCall` or selected/form state.
- `CXWorkspaceBulkLoad.tsx:4451-4490` projects `bulkDisplayCandidate` into `selected`, `form`, `servedQueueActionKey`, and `servedQueueTicketId`. Keep this projection UII/queue-item driven. Do not enrich or replace the center identity by phone/case lookup.
- `CXWorkspaceBulkLoad.tsx:6471-6537` terminal buttons are rendered only when `bulkCanDispositionCurrent` is true. This is correct for DNC/Answer/No Answer/Voicemail because those buttons must send a RingCX disposition for the active `current.uii`.
- `CXWorkspaceBulkLoad.tsx:6471-6477` Set appointment can remain available for `bulkDisplayCandidate`, including a held call, because it is a workbench action. Make sure it uses the displayed call's case/queue identity, not `bulkCurrent` only.

Implementation steps:

1. Leave backend `current` clearing alone.
2. Make the browser display selector the only place that holds the previous call visually.
3. Guard every UI clear behind either session stop/kill or confirmed replacement UII.
4. Keep terminal buttons bound to `bulkCurrent.uii`; keep appointment workbench actions bound to `bulkDisplayCandidate`.
5. Add a tiny unit helper later if this grows:

```ts
function selectBulkDisplayCall(confirmedCurrent, reviewCandidate, latchedCall, lastOutcome, running) {
  return confirmedCurrent || reviewCandidate || latchedCall || (running ? lastOutcome : null);
}
```

Do not add more booleans for "between calls"; derive it from `bulkRunning && bulkDisplayCandidate && !bulkDisplayIsCurrent`.

### B. Bulk HTTP/API Boundary

Files:

- `apps/web-client/src/lib/api/queries/cxBulkLoad.ts`
- `apps/control-plane/src/routes/cxBulkLoad.js`

Current code to preserve:

- `cxBulkLoad.ts:78-91` polls `/api/cx/bulk-load/session` every second with previous data kept. This is the browser's read loop.
- `cxBulkLoad.ts:98-113` centralizes command mutation/invalidation. Keep all bulk commands on this hook shape.
- `cxBulkLoad.js:36-76` is intentionally thin: auth, command call, sanitized result. Keep it free of call-state decisions.

Implementation steps:

1. Do not add special-case route logic for appointment, no-answer, or held-call display.
2. If a new command is needed, add one command route and one service function; do not branch in the route.
3. Keep all bulk command responses as sanitized session snapshots or small explicit result objects.
4. Do not read Logics from any `/api/cx/bulk-load/*` route.

### C. Terminal Outcome, Drain, And Counting

Files:

- `packages/shared-services/src/cxBulkLoadOutcomeAdapter.js`
- `packages/shared-repositories/src/cxTerminalOutboxRepository.js`
- `packages/shared-services/src/cxTerminalOutboxDrain.js`
- `apps/control-plane/src/server.js`
- `packages/shared-services/src/cxCadenceService.js`

Current code to preserve:

- `cxBulkLoadOutcomeAdapter.js:30-37` builds the idempotency key. With UII present, the key is `queueItemId:uii`; this is the right identity for one real call attempt.
- `cxBulkLoadOutcomeAdapter.js:39-52` builds the cadence event with session, domain, queue item, case, extern id, UII, outcome, source, and timestamp.
- `cxBulkLoadOutcomeAdapter.js:64-83` is the single terminal writer from bulk runtime into `recordCadenceEvent`.
- `cxTerminalOutboxRepository.js:15-26` inserts once and treats duplicate keys as already handled.
- `cxTerminalOutboxRepository.js:58-88` can update a pending row's outcome by identity. This is useful only before the drain has consumed the row.
- `cxTerminalOutboxDrain.js:19-44` drains pending/failed rows independently and marks each row drained or failed.
- `server.js:876-930` schedules the outbox drain. Keep this worker enabled unless explicitly testing failure.
- `cxCadenceService.js:2670-2967` is the heavy business outcome handler: classify, update counters, complete/reschedule queue item, upsert call log, clear agent state safely, record workflow.

Implementation steps:

1. Do not create a second terminal outcome writer for bulk. Extend this outbox if terminal-side effects need more payload.
2. If DNC correction from a held/review call remains needed, use `updatePendingOutcomeByIdentity` while status is `pending` or `failed`; if the row is already drained, create a separate correction action, not a duplicate terminal event.
3. Put all Mongo/logics-heavy post-call work in the drain or a worker, not in `submitCxBulkLoadDisposition`.
4. Add tests around:
   - duplicate `queueItemId:uii` writes return duplicate/no-op
   - retry from `failed` drains once
   - `dnc` correction only changes pending/failed rows
   - drained rows require an explicit correction action

Audit warning:

- `cxCadenceService.js:2914-2938` clears agent state and may kick eligibility. This path must never serve a new lead if clear was skipped due to an active different UII. The existing skip guard is important; keep it.

### D. Appointment To Logics

Files:

- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx`
- `apps/web-client/src/lib/api/queries/cx.ts`
- `apps/control-plane/src/routes/commandsCx.js`
- `packages/shared-services/src/cxAppointmentService.js`
- `packages/shared-services/src/cxWorkspaceService.js`

Current code to preserve:

- `CXWorkspaceBulkLoad.tsx:1149-1180` defines `AppointmentModal`.
- `CXWorkspaceBulkLoad.tsx:5774-5793` opens the modal and pauses bulk progressive dialing with `holdUntilResume`.
- `CXWorkspaceBulkLoad.tsx:5796-5799` closes the modal and resumes.
- `CXWorkspaceBulkLoad.tsx:5801-5880` saves appointment in bulk mode and resumes in `finally`.
- `CXWorkspaceBulkLoad.tsx:7031-7048` renders the modal.
- `cx.ts:239-264` has appointment read/create hooks.
- `commandsCx.js:391-421` exposes appointment create/release/call-now routes.
- `cxAppointmentService.js:385-526` creates the canonical appointment, updates queue item hold, mirrors agent appointment, patches LeadCadence appointment hold, and records workflow stage.
- `cxAppointmentService.js:1094-1157` resolves appointment after disposition.
- `cxWorkspaceService.js:8060-8137` creates a Logics task.
- `cxWorkspaceService.js:8239-8308` creates/updates a Logics activity.

Current code to change carefully:

- `CXWorkspaceBulkLoad.tsx:5801-5880` should continue to submit the canonical appointment only. Do not add browser-side `useCxLogicsTask` / `useCxLogicsActivity` calls here.
- `cxAppointmentService.js:497` currently calls `upsertLeadAppointmentHold`. After this point is the right place to enqueue `appointment.set` side effects.
- Do not import `cxWorkspaceService.js` into `cxAppointmentService.js`; `cxWorkspaceService.js` already imports appointment service, so that would create a circular dependency.

Implementation steps:

1. Extract Logics task/activity helpers from `cxWorkspaceService.js:8060-8308` into a small shared service, for example `cxLogicsWorkbenchService.js`.
2. Re-export those helpers from `cxWorkspaceService.js` so existing routes keep working.
3. Add a narrow appointment side-effect function, for example:

```js
async function enqueueAppointmentWorkbenchActions({ domain, user, appointment, queueItem }) {}
```

4. Call it after `cxAppointmentService.js:497`, after the appointment and LeadCadence hold are already durable.
5. Use an idempotency key like `appointment.set:${domain}:${caseId}:${appointmentId}`.
6. Create:
   - one Logics task assigned with tenant-specific user id
   - one sparse Logics activity
   - one source metadata patch
7. If task/activity fails, appointment must still remain saved and visible.

Acceptance checks:

- Duplicate submit creates one appointment and one task.
- Missing Logics user mapping returns a workbench-action failure, not an appointment failure.
- Closing the modal without submit resumes the agent.
- Submitting the modal resumes the agent even if Logics is down.

### E. Interview Snapshot And Source Hydration

Files:

- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx`
- `apps/web-client/src/lib/api/queries/cx.ts`
- `apps/control-plane/src/routes/commandsCx.js`
- `packages/shared-services/src/cxWorkspaceService.js`
- `packages/shared-repositories/src/leadCadenceRepository.js`

Current code to preserve:

- `CXWorkspaceBulkLoad.tsx:2778-2826` builds the interview activity note.
- `CXWorkspaceBulkLoad.tsx:2939-3018` manages local form state and saves through `useCxInterviewSnapshot`.
- `cx.ts:780-782` exposes `useCxLogicsTask`, `useCxLogicsActivity`, and `useCxInterviewSnapshot`.
- `commandsCx.js:504-512` posts interview snapshot to the service.
- `cxWorkspaceService.js:8330-8390` builds the server snapshot, saves to LeadCadence, then posts Logics activity.
- `leadCadenceRepository.js:143-164` stores `interviewSnapshot`.

Current code to change carefully:

- `CXWorkspaceBulkLoad.tsx:2778-2826` is too rich to post blindly forever. Keep richer data in app/source context; keep the Logics note sparse.
- `leadCadenceRepository.js:143-164` stores the snapshot at the top-level `interviewSnapshot`. For future hydration, add a dedicated `payloadSnapshot.cxContext.interviewSnapshot` or `cxContext.interview` copy so the queue source has one predictable read path.
- `cxWorkspaceService.js:8372-8378` posts to Logics immediately. This is acceptable because it is a manual save, not the call-advance hot path. If failures become noisy, move it to the same workbench action outbox as appointments.

Implementation steps:

1. Add a pure formatter:

```js
function buildSparseInterviewLogicsNote(snapshotPayload) {}
```

2. Add a pure source patch builder:

```js
function buildInterviewSourceContextPatch(snapshotPayload) {}
```

3. Update `saveLeadCadenceInterviewSnapshot` to set both:
   - `interviewSnapshot`
   - `payloadSnapshot.cxContext.interviewSnapshot`
4. Include `queue.itemId`, `queue.actionKey`, and `updatedBy` so future calls can tie context to the original source when possible.
5. Add read-side hydration in the workspace read path so the center/side panel can show the saved context without a Logics read.

Acceptance checks:

- Save posts one sparse Logics activity.
- Save stores rich structured source context.
- Refreshing or returning to the same lead hydrates the interview context.
- No full transcript or sensitive financial dump is posted to Logics.

### F. Call Summary / Last Call Context

Files:

- `packages/shared-services/src/cxTerminalOutboxDrain.js`
- `packages/shared-services/src/cxCadenceService.js`
- `packages/shared-repositories/src/leadCadenceRepository.js`
- `packages/shared-repositories/src/caseProfileRepository.js`
- `packages/shared-services/src/liveCoachCloseoutService.js`
- `packages/shared-services/src/liveCoachBusService.js`
- `apps/ai-bus/src/server.js`
- `apps/control-plane/src/routes/commandsCx.js`
- `apps/control-plane/src/routes/readCx.js`
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx`

Current code to preserve:

- `cxCadenceService.js:2901-2919` upserts a call log row keyed by UII.
- `cxCadenceService.js:2941-2967` records a sparse workflow stage.
- `liveCoachBusService.js:1018-1046` already enqueues closeout work for a coach session.
- `liveCoachCloseoutService.js:741-763` already writes artifacts, LeadCadence summary, Logics activity, and agent email after evidence gates.
- `liveCoachCloseoutService.js:562-591` already appends a `call` communication to `CaseProfile.communications[]` when case profile communication closeout is enabled.
- `caseProfileRepository.js:783-815` already exposes `appendCommunicationEntry(domain, caseId, "call", entry)`.
- `CaseProfile.js:260-286` defines the communication array shape and supports `metadata` for UII/session/artifact pointers.
- `cxWorkspaceService.js:4039-4170` builds workspace queue rows from `CxDialQueue` plus `LeadCadence`, not full CaseProfile communications.
- `cxCommLogService.js:60-122` resolves CaseProfile only for the case/phone-specific communication reader.
- `apps/ai-bus/src/server.js:3427-3450` wires the closeout worker into the AI bus.
- `apps/ai-bus/src/server.js:4014-4018` exposes closeout stats for dashboard inspection.
- `readCx.js:1161-1185` reads live Logics info for side panel only.
- `readCx.js:1323-1360` reads Logics tasks for side panel only.

Implementation steps:

1. Add a source context patch helper to `leadCadenceRepository.js`, not a loose `$set` in random services:

```js
async function patchLeadCadenceCxContext(domain, caseId, patch = {}, options = {}) {}
```

2. From the summary worker, write compact app context:

```json
{
  "payloadSnapshot.cxContext.lastCall": {
    "uii": "...",
    "outcome": "answered",
    "agentEmail": "...",
    "at": "...",
    "summary": "short internal summary",
    "flags": ["cp504", "price_objection"]
  }
}
```

3. Only post a sparse Logics activity when the call meets the substantive threshold.
4. Never perform summary generation in the active-call watcher or bulk disposition request.
5. Read this context into the workspace alongside the queue/current call data and render it under the right panel's supporting context area.
6. Append one brief call note to `CaseProfile.communications[]` when the call has substantive talk evidence:
   - channel: `call`
   - subject: `CX call summary`
   - body: brief summary + next step only
   - metadata: `sessionId`, `uii`, `queueItemId`, `durationSec`, `contextKeys`, optional transcript artifact pointer
7. Gate communication writes the same way as closeout evidence:
   - do not write detailed notes for no-answer/voicemail/no transcript
   - do write for answered/substantive calls even if Logics activity is disabled
   - keep this idempotent by `threadKey` or `queueItemId:uii`
8. Keep CaseProfile reads out of queue load and watcher loops:
   - queue load may use `LeadCadence` context
   - communication display uses the existing comm-log route
   - summary worker may read or upsert CaseProfile after the call
9. Add the route only as a backend command/contract first:

```http
POST /api/commands/cx/:domain/coach/call-summary
```

10. Keep the route thin:
   - auth/user/permission
   - validate `caseId`, `queueItemId`, `uii`, `terminalOutcome`
   - call a single service function such as `enqueueCxCoachCallSummary`
   - return `{ ok: true, queued: true, status: "pending" }`
11. Put `enqueueCxCoachCallSummary` in shared services, not in the route. It should decide:
   - if a `coachSessionId` maps to an AI-bus session, enqueue closeout through the existing live coach closeout lane
   - if no coach session is available, write a sparse pending marker to source context/call log for later summary generation
12. Do not add a coach UI button, tab, chip, or visible panel yet. This route is unused until the backend contract has a clean worker and evidence gates.

Acceptance checks:

- No transcript/no substance produces no detailed Logics summary.
- A substantive call creates a source summary and a sparse Logics activity.
- A substantive call appends one brief `call` entry to `CaseProfile.communications[]`.
- The next serve of the same case shows last-call context without waiting on Logics.
- Summary failure does not affect dialing.
- Calling the route without a coach session creates a pending marker only, not a fake summary.
- Calling the route twice for the same `queueItemId:uii` is idempotent.
- Nothing in `CXWorkspaceBulkLoad.tsx` or the live coach UI invokes this route until the coach summary surface is intentionally designed.

### G. Queue Source Persistence And Refill Safety

Files:

- `packages/shared-repositories/src/leadCadenceRepository.js`
- `packages/shared-repositories/src/cxDialQueueRepository.js`
- `packages/shared-services/src/cxBulkLoadRuntimeService.js`
- `packages/shared-services/src/cxCadenceService.js`

Current code to preserve:

- `cxBulkLoadRuntimeService.js:442-459` is the refill boundary. It should only refill from the buffer/source rules; it should not do Logics or contact enrichment.
- `cxBulkLoadRuntimeService.js:649-651` calls refill after terminal acceptance.
- `cxCadenceService.js:2781-2818` updates cadence counters and DNC/no-answer/answered state.
- `cxCadenceService.js:2848-2887` completes or reschedules the queue item based on outcome and policy.

Implementation steps:

1. Keep one source-of-truth queue state per lead:
   - pending source pool
   - accepted RingCX buffer
   - current UII
   - terminal outbox/completed
2. Do not let "new green came in" insert directly into a running agent's accepted buffer in bulk mode.
3. Let new leads enter the shared source pool; bulk refill chooses the next batch when threshold is reached.
4. Add a source-context exclusion check before refill accepts rows:
   - DNC
   - active appointment hold
   - exhausted cadence
   - already accepted/published in current session
5. Keep `maybeRefill` single purpose: reserve/publish more leads only.

Acceptance checks:

- Refill at threshold publishes the correct target count.
- Refill does not pull DNC or appointment-held leads.
- Refill does not duplicate a row already in accepted buffer/current/completed.
- Newly arrived greens are eligible for the next refill, not an immediate mid-buffer jump.

### H. Logics Side Panel

Files:

- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx`
- `apps/control-plane/src/routes/readCx.js`

Current code to preserve:

- `CXWorkspaceBulkLoad.tsx:7006-7023` keeps appointments and Logics context in the right rail.
- `readCx.js:934-948` lists appointments.
- `readCx.js:1161-1185` reads Logics info.
- `readCx.js:1323-1360` reads Logics tasks.

Implementation steps:

1. Keep the side panel read-only except for explicit agent actions.
2. Add a compact "Last call context" section sourced from local source/context first.
3. Show background workbench write failures as small retryable statuses, not blocking modals.
4. Do not make the side panel drive the dialer state.

### I. Suggested Patch Order

1. Harden the latch clear guard in `CXWorkspaceBulkLoad.tsx:4443-4448`.
2. Add pure tests for the display selector and state machine terminal clear.
3. Add `patchLeadCadenceCxContext` to `leadCadenceRepository.js`.
4. Harden interview save to write source context and sparse Logics note.
5. Extract Logics task/activity helpers out of `cxWorkspaceService.js` if appointment side effects are added server-side.
6. Add appointment workbench side effects behind an idempotent queue/action.
7. Add last-call summary source patching from a worker, not from the watcher.
8. Add the backend-only coach summary route contract, but do not wire it to the coach UI.
9. Add right-panel local context rendering.
10. Run real-agent smoke on bulk with progressive delay enabled.

### J. Test Matrix For The Code Auditor

Audit each row against the exact files above:

| Scenario | Expected owner | Must not happen |
| --- | --- | --- |
| RingCX releases current, next UII not seen yet | Browser latch | Middle panel blanks |
| Agent clicks No answer | Bulk runtime + terminal outbox | Browser clears case before next UII |
| Agent clicks DNC | Bulk runtime + terminal outbox + drain | Duplicate terminal event |
| Agent opens appointment | Browser modal + progressive pause | Dial loop keeps firing while form is open |
| Appointment saved | Appointment service + workbench action | Appointment lost because Logics task failed |
| Interview saved | Workspace service | Full rich data dumped to Logics activity |
| Call summary ready | Background worker | Summary generation blocks next call |
| Refill threshold hit | Bulk runtime refill | New greens jump into current buffer outside refill |

## Testing Plan

Unit tests:

- latch selector chooses `confirmedCurrentWithUii` before latched previous
- latch does not clear on `current = null`
- appointment packet idempotency key
- interview summary redaction
- source patch merge behavior

Integration tests:

- appointment submit with Logics task success
- appointment submit with Logics task failure
- interview save posts activity once
- terminal outbox drains source context once
- source hydration returns context to workspace

Local real-agent smoke:

- 10 leads loaded
- progressive delay visible
- No answer keeps middle card until next UII
- Set appointment pauses agent state
- close appointment resumes
- submit appointment persists locally and queues Logics task/activity

Failure tests:

- Logics 500
- duplicate appointment click
- browser refresh during between-call delay
- control-plane restart with pending Logics action
- RingCX watcher has no active call for several seconds

## Open Questions

- Which Logics task type/category should appointment tasks use by default?
- Should appointment task assignment use tenant-specific Logics user id every time, or fall back to generic owner?
- Should call summary Logics activity wait for coach summary, or create a sparse terminal activity first and append summary later?
- What is the minimum call duration/substance threshold for call summary?
- Should DNC from held/previous call be a correction on terminal outbox, or a direct source/Logics action?
- Should unresolved Logics action failures appear in the side panel, admin panel, or both?

## Bottom Line

The bulk handoff rule is simple: **do not release the middle section until a new UII is detected.**

If RingCX's progressive delay/counter is reliable, keep the hot loop boring and move complexity into durable workbench actions:

- appointment creates Logics task/activity
- interview creates sparse activity and rich source context
- call summary survives to contact/source context and posts a safe activity
- source rows carry the memory that future calls need

That gives the floor a stable dialer and makes the app meaningfully better than using RingCX and Logics separately.
