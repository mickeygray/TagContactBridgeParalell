# CX Bulk Workspace Polish + Component Collapse Plan - 2026-06-26

## Purpose

This document turns the current CX bulk mode work into a focused polish plan.

The goal is not to add more protective booleans or client tricks. The goal is to collapse the workspace into simple, testable pieces:

- one backend-owned bulk call cycle
- one backend-owned refill point
- one backend-owned terminal/wrap/Logics side-effect path
- one browser projection of the confirmed/held call
- small UI components that render state and send commands

Bulk is the forward path. Legacy behavior should not be made to coexist inside bulk by adding exceptions. If a behavior belongs to legacy and causes bulk side effects, remove it from the bulk rail.

## Non-Negotiable Rules

### 1. The client does not own call truth

The browser may display and request. It does not decide that a call is current, completed, released, counted, refilled, or safely advanced.

Truth sources:

- RingCX active-call watcher proves current call.
- Backend bulk session stores current, buffer, completed, review hold, and refill state.
- Terminal outbox/drain writes cadence events, call notes, CaseProfile, and Logics side effects.

### 2. Button click is intent, not completion

A disposition button means "try to close this call." It is not the moment the old call disappears from the middle panel.

The old call should leave the center panel only when:

- a different confirmed RingCX UII becomes current, or
- the bulk session is stopped/killed, or
- the user leaves bulk mode.

### 3. Refill has one owner

No UI-triggered refill. No "maybe refill here, definitely refill there."

The backend bulk apply path owns this rule:

```text
After watcher/session mutation consumes or releases a lead:
  if live accepted buffer <= refillAt:
    fill to targetBufferSize
```

`maybeRefill` is called only from backend-owned lifecycle points, never from React effects.

### 4. Logics writes go through wrap/drain services

No Logics writes in the active-call watcher hot path.

No scattered client-side Logics orchestration beyond sending a clear command/payload.

The desired final service boundary is:

```text
completeCurrentCallWrap({
  sessionId,
  uii,
  queueItemId,
  outcome,
  appointment,
  dnc,
  interviewSnapshot,
  coachSummary,
  notes
})
```

That service writes one terminal row, then lets the drain and wrap writers fan out to Mongo, LeadCadence, CaseProfile, and Logics.

## Source Anchors

### Browser bulk workspace

- [CXWorkspaceBulkLoad.tsx](C:/code/TagContactBridgeParalell/apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:3973) - bulk display state, auto-review state, latched call, current call projection.
- [CXWorkspaceBulkLoad.tsx](C:/code/TagContactBridgeParalell/apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:4447) - bulk empty-display effect that clears served selection/case panel.
- [CXWorkspaceBulkLoad.tsx](C:/code/TagContactBridgeParalell/apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:4455) - bulk display candidate projected into selected/form/served queue state.
- [CXWorkspaceBulkLoad.tsx](C:/code/TagContactBridgeParalell/apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:4500) - preview get-leads/start-next function.
- [CXWorkspaceBulkLoad.tsx](C:/code/TagContactBridgeParalell/apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:5337) - legacy recent workflow terminal effect.
- [CXWorkspaceBulkLoad.tsx](C:/code/TagContactBridgeParalell/apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:5701) - `submitQueueDisposition`.
- [CXWorkspaceBulkLoad.tsx](C:/code/TagContactBridgeParalell/apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:5797) - appointment modal open/pause.
- [CXWorkspaceBulkLoad.tsx](C:/code/TagContactBridgeParalell/apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:5824) - appointment submit flow.
- [CXWorkspaceBulkLoad.tsx](C:/code/TagContactBridgeParalell/apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:6488) - terminal and appointment action buttons.
- [CXWorkspaceBulkLoad.tsx](C:/code/TagContactBridgeParalell/apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:6603) - transition banner and auto-review banner.
- [CXWorkspaceBulkLoad.tsx](C:/code/TagContactBridgeParalell/apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:6943) - live coach bridge.
- [CXWorkspaceBulkLoad.tsx](C:/code/TagContactBridgeParalell/apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:7005) - interview snapshot card.
- [CXWorkspaceBulkLoad.tsx](C:/code/TagContactBridgeParalell/apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:7045) - Logics context card.

### Browser bulk API

- [cxBulkLoad.ts](C:/code/TagContactBridgeParalell/apps/web-client/src/lib/api/queries/cxBulkLoad.ts:91) - session polling.
- [cxBulkLoad.ts](C:/code/TagContactBridgeParalell/apps/web-client/src/lib/api/queries/cxBulkLoad.ts:146) - disposition/get-leads/start-next/pause/resume hooks.
- [cxBulkLoad.ts](C:/code/TagContactBridgeParalell/apps/web-client/src/lib/api/queries/cxBulkLoad.ts:159) - review outcome correction hook.

### Control-plane route boundary

- [cxBulkLoad.js](C:/code/TagContactBridgeParalell/apps/control-plane/src/routes/cxBulkLoad.js:44) - bulk session route.
- [cxBulkLoad.js](C:/code/TagContactBridgeParalell/apps/control-plane/src/routes/cxBulkLoad.js:52) - disposition route.
- [cxBulkLoad.js](C:/code/TagContactBridgeParalell/apps/control-plane/src/routes/cxBulkLoad.js:56) - review outcome route.
- [cxBulkLoad.js](C:/code/TagContactBridgeParalell/apps/control-plane/src/routes/cxBulkLoad.js:64) - get-leads route.
- [cxBulkLoad.js](C:/code/TagContactBridgeParalell/apps/control-plane/src/routes/cxBulkLoad.js:68) - pause progressive route.
- [cxBulkLoad.js](C:/code/TagContactBridgeParalell/apps/control-plane/src/routes/cxBulkLoad.js:72) - resume progressive route.

### Backend bulk runtime

- [cxBulkLoadRuntimeService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadRuntimeService.js:338) - `fillBuffer`.
- [cxBulkLoadRuntimeService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadRuntimeService.js:458) - `maybeRefill`.
- [cxBulkLoadRuntimeService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadRuntimeService.js:572) - read-only `watchCxBulkLoadSession`.
- [cxBulkLoadRuntimeService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadRuntimeService.js:582) - `submitCxBulkLoadDisposition`.
- [cxBulkLoadRuntimeService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadRuntimeService.js:953) - account active-call watcher apply path.

### Drain and wrap

- [cxTerminalOutboxDrain.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxTerminalOutboxDrain.js:9) - terminal outbox drain.
- [cxAgentCallNoteService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxAgentCallNoteService.js:175) - agent call note write from terminal.
- [cxCallWrapService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxCallWrapService.js:220) - CaseProfile and Logics call wrap writer.
- [server.js](C:/code/TagContactBridgeParalell/apps/control-plane/src/server.js:946) - enqueue call wrap from terminal payload.
- [server.js](C:/code/TagContactBridgeParalell/apps/control-plane/src/server.js:1031) - terminal outbox worker startup.
- [cxWorkspaceService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxWorkspaceService.js:8490) - call summary route service.

## Immediate Delete Or Quarantine List

## 2026-06-26 Attached Audit Triage

The follow-up audit agreed with the plan and sharpened the first execution order. Treat these as the current priority order:

1. Remove legacy terminal workflow advancement from bulk mode.
2. Release/prune coach only after backend disposition acceptance.
3. Stop clearing bulk served/case state on transient `current = null`.
4. Add one backend `appointment-wrap` command.
5. Move terminal buttons and appointment submit behind thin shell hooks.

First polish code pass status:

- Done: legacy `recentWorkflowStages` terminal effect now early-returns while `bulkRunning`.
- Done: coach release now runs after `bulkDisposition` returns an accepted result.
- Done: bulk served/case clear now keys off session-ended status instead of no display candidate.
- Not done yet: backend `appointment-wrap` command.

Do not treat the first three as the final component extraction. They are the small risk-removal steps that make the larger extraction safer.

### A. Legacy workflow terminal effect must not run in bulk

Current source:

- [CXWorkspaceBulkLoad.tsx](C:/code/TagContactBridgeParalell/apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:5337)

Problem:

This effect watches `data.recentWorkflowStages`, matches terminal outcomes, suppresses current queue lead, clears served queue selection, clears case panel, and schedules autoserve.

That is legacy/slow-lane behavior. In bulk, the account active-call watcher and bulk session own the current call. The legacy effect can cause the exact symptoms bulk is being built to eliminate:

- middle panel clears before new UII
- queue item disappears/reappears
- old case panel gets wiped by stale workflow
- browser schedules an advance outside the bulk session

Target:

```ts
React.useEffect(() => {
  if (bulkRunning) return;
  // legacy terminal workflow effect
}, [...]);
```

Better final target:

- move this whole effect into the legacy workspace/hook
- do not keep it in the bulk component as a permanent guarded block

Test:

- In bulk mode, inject/refresh `recentWorkflowStages` with a terminal row for the current case.
- Assert no call to `clearServedQueueSelection`, `clearCasePanelForNextQueueLead`, or `scheduleAutoServe`.
- Assert center panel remains latched until new UII.

### B. Coach release must happen after terminal acceptance

Current source:

- [CXWorkspaceBulkLoad.tsx](C:/code/TagContactBridgeParalell/apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:5737)

Problem:

The client releases coach before `bulkDisposition.mutateAsync` resolves. If RingCX rejects the disposition, the call is still active/retryable but coach may already be pruned.

Target:

- `submitQueueDisposition` sends intent.
- Backend returns `dispositionOk: true`.
- Client then releases coach, or backend/drain triggers closeout by terminal evidence.

Preferred final target:

- remove direct client coach release from terminal button path
- let terminal outbox/drain or explicit closeout worker release/close coach by `uii`

Acceptable intermediate target:

```ts
const result = await bulkDisposition.mutateAsync(...);
if (result?.dispositionOk !== false) {
  releaseLiveCoachForCurrentCall(...);
}
```

Longer-term target:

- terminal outbox or closeout worker emits the coach release/closeout signal by `uii`
- browser stops owning coach pruning for call completion

### C. Bulk empty-display effect should be narrowed

Current source:

- [CXWorkspaceBulkLoad.tsx](C:/code/TagContactBridgeParalell/apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:4447)

Problem:

When bulk is running and no display candidate exists, it clears served selection and case panel. That is fine for true session stop/empty state, but dangerous during normal RingCX gaps if the latch ever fails.

Target:

- only clear when session is stopped/killed or bulk mode exits
- do not clear merely because `current` is temporarily null

Current intermediate implementation:

- clear on a non-running bulk session status for the active session
- do not clear just because `bulkDisplayCandidate` is null

Test:

- session running, no `current`, last outcome present or previous call latched
- assert case panel remains
- assert form remains until explicit stop/kill

### D. Appointment flow should not be a long client transaction

Current source:

- [CXWorkspaceBulkLoad.tsx](C:/code/TagContactBridgeParalell/apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:5797)
- [CXWorkspaceBulkLoad.tsx](C:/code/TagContactBridgeParalell/apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:5824)
- [AppointmentModal](C:/code/TagContactBridgeParalell/apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:1169)

Problem:

The browser currently coordinates:

- pause progressive
- open modal
- create appointment
- assign to me
- postdate
- bulk disposition
- close modal
- resume progressive
- refetch workspace/queue

That is too many partial failure points in the UI.

Target:

Create a backend command such as:

```text
POST /api/cx/bulk-load/appointment-wrap
```

The backend should handle:

- validate current session/current call
- pause or confirm paused if needed
- create appointment/task/activity
- persist terminal outcome
- enqueue call wrap payload
- resume only when requested and safe
- return one result object with side-effect statuses

The modal becomes a form that calls one mutation.

## Appointment-Wrap Pre-Implementation Plan

Do not write this as another client-side sequence. The command should be one server command with one result object.

### Command contract

Endpoint:

```text
POST /api/cx/bulk-load/appointment-wrap
```

Client hook:

```ts
useCxBulkLoadAppointmentWrap()
```

Public shared-services entry:

```js
submitCxBulkLoadAppointmentWrap(input, { user, logger })
```

Input:

```ts
{
  sessionId: string;
  caseId: string | number;
  appointmentDate: string;
  appointmentTime: string;
  appointmentTimezone?: string;
  note?: string;
  assignToMe?: boolean;
  postdate?: boolean;
  queueItemId?: string;
  phone?: string;
  searchPhone?: string;
  prospectName?: string;
  sourceName?: string;
}
```

Output:

```ts
{
  ok: boolean;
  session: CxBulkLoadSession | null;
  appointment: { ok: boolean; result?: object; error?: string };
  workbench: { ok?: boolean; skipped?: boolean; task?: object; activity?: object; error?: string };
  assign: { ok?: boolean; skipped?: boolean; error?: string };
  postdate: { ok?: boolean; skipped?: boolean; error?: string };
  terminal: { ok?: boolean; dispositionOk?: boolean; error?: string; result?: object };
  resume: { ok?: boolean; skipped?: boolean; error?: string };
}
```

The result must be boring and explicit. The UI should not have to infer which side effect failed from thrown exceptions.

### Existing code to reuse

Appointment creation:

- [cxAppointmentService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxAppointmentService.js:385) `createCxAppointment(domain, user, input)`

Appointment Logics task/activity sync:

- [cxWorkspaceService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxWorkspaceService.js:8119) `executeCxAppointmentWorkbenchActions(domain, user, appointmentResult)`

Assign-to-me:

- [cxWorkspaceService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxWorkspaceService.js:8040) `requestCxAssignCaseToMe(domain, user, input)`

Postdate:

- [cxWorkspaceService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxWorkspaceService.js:8788) `executeCxLogicsUpdateCase(domain, user, input)` with `status: "post-date"` and `skipQueueFinalize: true`

Bulk terminal close:

- [cxBulkLoadRuntime.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadRuntime.js:1142) `submitCxBulkLoadDisposition(input, options)`
- [cxBulkLoadRuntimeService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadRuntimeService.js:582) service-side terminal path

Progressive pause/resume:

- [cxBulkLoadRuntime.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadRuntime.js:1215) `pauseCxBulkLoadProgressiveDialing`
- [cxBulkLoadRuntime.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadRuntime.js:1227) `resumeCxBulkLoadProgressiveDialing`

Route shape:

- [cxBulkLoad.js](C:/code/TagContactBridgeParalell/apps/control-plane/src/routes/cxBulkLoad.js:1) keep this route thin: auth, user, command call, response.

Browser API hook shape:

- [cxBulkLoad.ts](C:/code/TagContactBridgeParalell/apps/web-client/src/lib/api/queries/cxBulkLoad.ts:146) add the hook beside the other bulk command hooks.

Browser modal submit:

- [CXWorkspaceBulkLoad.tsx](C:/code/TagContactBridgeParalell/apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:5829) replace the current bulk branch only.

### Implementation sequence

1. Add `submitCxBulkLoadAppointmentWrap` in [cxBulkLoadRuntime.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadRuntime.js:1082).
   - Resolve agent context with the same bulk runtime gate as every other bulk command.
   - Resolve owned session id with the existing session resolver.
   - Read the current bulk session.
   - Require a running session and a current/displayed call identity.
   - Derive domain/case/queue item from current call first, then input.

2. Create the appointment.
   - Call `createCxAppointment`.
   - If appointment creation fails, stop immediately.
   - Do not terminal-disposition the call if the appointment itself was not saved.

3. Run appointment workbench actions fail-soft.
   - Call `executeCxAppointmentWorkbenchActions`.
   - Capture task/activity result.
   - Failure here does not block terminal disposition because the appointment is already saved and the workbench can be retried from appointment metadata.

4. Run optional assign/postdate fail-soft.
   - `assignToMe`: call `requestCxAssignCaseToMe`.
   - `postdate`: call `executeCxLogicsUpdateCase` with `skipQueueFinalize: true`.
   - Capture errors in the result object.
   - Do not let either of these directly mutate bulk session state.

5. Close the current bulk call through the existing terminal path.
   - Call `submitCxBulkLoadDisposition({ sessionId, disposition: "answered", notes })`.
   - Do not write another terminal outbox row.
   - Do not call `maybeRefill` directly.
   - Let the existing disposition path decide terminal accepted/rejected and backend refill.

6. Resume progressive only after accepted terminal close.
   - If `terminal.dispositionOk === false`, do not auto-resume. Return a retryable status and leave the current call visible.
   - If accepted, call `resumeCxBulkLoadProgressiveDialing({ sessionId, reason: "bulk-appointment-wrap-complete" })`.
   - Capture resume failure without hiding the appointment/terminal success.

7. Export and route it.
   - Export from [cxBulkLoadRuntime.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadRuntime.js:1256).
   - Re-export from [index.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/index.js:1047).
   - Import in [cxBulkLoad.js](C:/code/TagContactBridgeParalell/apps/control-plane/src/routes/cxBulkLoad.js:1).
   - Add `POST /appointment-wrap`.
   - Consider adding `auth.requirePermission("queue.dispose")` to this route because it performs appointment + terminal work. Do not add `auth.requireCxOAuth`; bulk is server/JWT-driven like the other bulk commands.

8. Add browser hook and replace bulk modal submit.
   - Add `useCxBulkLoadAppointmentWrap` in [cxBulkLoad.ts](C:/code/TagContactBridgeParalell/apps/web-client/src/lib/api/queries/cxBulkLoad.ts:146).
   - In [CXWorkspaceBulkLoad.tsx](C:/code/TagContactBridgeParalell/apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:5829), replace only the `if (bulkRunning)` branch.
   - The non-bulk branch stays legacy until the legacy workspace is extracted.
   - The UI should show one status summary from the returned object.
   - The UI should close the modal only when appointment creation succeeded.
   - The center panel still holds until the watcher proves a new UII.

### Failure rules

- Appointment create fails: no terminal disposition, no resume, modal stays open with error.
- Workbench task/activity fails: appointment still saved; terminal can proceed; response shows `workbench.ok:false`.
- Assign/postdate fails: appointment still saved; terminal can proceed; response shows warnings.
- Terminal disposition fails/rejects: do not resume automatically; keep current call visible and retryable.
- Resume fails after terminal success: terminal stays counted; UI warns agent to set available manually.

### Tests to add before floor use

Service tests:

- successful appointment-wrap calls appointment, workbench, optional assign/postdate, terminal disposition, resume in order.
- appointment create failure stops before terminal disposition.
- workbench failure is captured and does not stop terminal disposition.
- assign/postdate failures are captured and do not stop terminal disposition.
- terminal rejection returns `terminal.dispositionOk:false` and does not resume.
- resume failure returns terminal success plus `resume.ok:false`.

Route/hook tests:

- `/api/cx/bulk-load/appointment-wrap` calls the shared service entry and returns structured result.
- `useCxBulkLoadAppointmentWrap` invalidates the bulk session key and CX query family.

Browser smoke:

- Open appointment from a current bulk call.
- Confirm agent is paused/Working by the existing open-modal pause path.
- Submit appointment.
- Confirm modal closes only after appointment save.
- Confirm old middle call remains visible until new UII.
- Confirm task/activity appears in Logics or returned workbench failure is visible.
- Confirm terminal outbox has one row for the call.

## Component Collapse Strategy

The current [CXWorkspaceBulkLoad.tsx](C:/code/TagContactBridgeParalell/apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx) should become a shell. The shell wires data and layout only.

### Target file layout

```text
apps/web-client/src/workspaces/cx/bulk/
  CXWorkspaceBulkLoad.tsx
  bulkCallProjection.ts
  useBulkDisplayedCall.ts
  useBulkServedContactProjection.ts
  useBulkDispositionActions.ts
  useBulkAppointmentWrap.ts
  useBulkCoachBridge.ts
  BulkQueuePanel.tsx
  BulkCallPanel.tsx
  BulkTerminalControls.tsx
  BulkTransitionBanner.tsx
  BulkAutoReviewBanner.tsx
  BulkCoachWorkbench.tsx
  BulkLogicsWorkbench.tsx
```

### 1. `useBulkDisplayedCall`

Extract from:

- [CXWorkspaceBulkLoad.tsx](C:/code/TagContactBridgeParalell/apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:3973)

Inputs:

- bulk session
- local auto-review state
- latched call state

Outputs:

```ts
{
  running,
  sessionId,
  current,
  confirmedCurrent,
  displayedCall,
  displayedKey,
  displayIsCurrent,
  showingHeldCall,
  canDispositionCurrent,
  remainingQueue,
  queueDebugLine
}
```

Rules:

- no API calls
- no toasts
- no Logics lookup
- no form mutation
- no queue mutation
- no phone-only matching

### 2. `useBulkServedContactProjection`

Extract from:

- [CXWorkspaceBulkLoad.tsx](C:/code/TagContactBridgeParalell/apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:4455)

Purpose:

Project `displayedCall` into the old form/selected shape only because the current UI still needs that shape.

Rules:

- use displayed call case/domain/name/queueItemId only
- no phone lookup
- no Logics enrichment
- no queue advance
- clear only on explicit stop/kill/mode exit

This hook is temporary. The final component tree should render from `displayedCall` directly and stop backfilling the old form object.

### 3. `BulkQueuePanel`

Extract from:

- [CXWorkspaceBulkLoad.tsx](C:/code/TagContactBridgeParalell/apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:4014)
- [CXWorkspaceBulkLoad.tsx](C:/code/TagContactBridgeParalell/apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:6347)
- [CXWorkspaceBulkLoad.tsx](C:/code/TagContactBridgeParalell/apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:6399)

Inputs:

- `remainingQueue`
- `bufferCount`
- `completedCount`
- `status`

Outputs:

- renders queue only
- emits `onStartSession`, `onKillSession`, `onGetLeads`, if those controls remain

Rules:

- no current-call state mutation
- no Logics lookup
- no terminal writes
- no refill decision

### 4. `BulkTerminalControls`

Extract from:

- [CXWorkspaceBulkLoad.tsx](C:/code/TagContactBridgeParalell/apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:6488)

Inputs:

- displayed call
- `canDispositionCurrent`
- pending flags
- command callbacks

Rules:

- render buttons
- call `onDisposition(outcome)`
- no side effects other than the callback
- no coach release
- no queue clearing

### 5. `useBulkDispositionActions`

Extract from:

- [CXWorkspaceBulkLoad.tsx](C:/code/TagContactBridgeParalell/apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:5701)

Target behavior:

```text
onDisposition:
  send backend disposition intent
  if rejected:
    keep current call visible
    show retryable message
  if accepted:
    show "waiting for RingCX"
    do not clear the call
    let watcher/session refetch replace the panel on next UII
```

Rules:

- no local refill
- no autoserve
- no case-panel clear
- no coach release before accepted terminal

### 6. `BulkTransitionBanner`

Extract from:

- [CXWorkspaceBulkLoad.tsx](C:/code/TagContactBridgeParalell/apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:6603)

Purpose:

Render the transition state. It does not decide transition state.

### 7. `BulkAutoReviewBanner`

Extract from:

- [CXWorkspaceBulkLoad.tsx](C:/code/TagContactBridgeParalell/apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:6628)
- [CXWorkspaceBulkLoad.tsx](C:/code/TagContactBridgeParalell/apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:4948)

Decision:

Keep it optional and narrow.

It should correct an already-created terminal row before drain when possible. It should not block the hot path or become a modal queue. If it gets complex, move it out of the call panel and into an "Autodisposition review" worklist.

### 8. `useBulkAppointmentWrap`

Extract from:

- [CXWorkspaceBulkLoad.tsx](C:/code/TagContactBridgeParalell/apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:5797)
- [CXWorkspaceBulkLoad.tsx](C:/code/TagContactBridgeParalell/apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:5824)

Target behavior:

The hook should become thin once the backend command exists.

Inputs:

- session id
- displayed call
- payload from modal

Output:

- one result object with `appointment`, `terminal`, `logics`, `caseProfile`, `resume` statuses

Rules:

- no direct `dialAny`
- no legacy next-call payload
- no autoserve fallback
- no multiple independent mutations from the component

### 9. `BulkCoachWorkbench`

Extract from:

- [CXWorkspaceBulkLoad.tsx](C:/code/TagContactBridgeParalell/apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:6943)

Inputs:

- displayed call identity
- current confirmed UII
- queue item id
- case id
- release signal from backend/terminal acceptance

Rules:

- coach binds to current call identity
- coach release is keyed by terminal acceptance or confirmed call replacement
- interview save can send data to wrap service

### 10. `BulkLogicsWorkbench`

Extract from:

- [CXWorkspaceBulkLoad.tsx](C:/code/TagContactBridgeParalell/apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:7045)

Inputs:

- resolved case id
- domain
- phone if known

Rules:

- side panel can read Logics
- writes should go through call wrap / appointment wrap / interview routes
- the side panel should not decide call lifecycle

## Backend Service Polish

### `fillBuffer` should stay single-purpose

Current source:

- [cxBulkLoadRuntimeService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadRuntimeService.js:338)

Allowed:

- offhook check
- compute deficit
- reserve rows
- route-lock
- cross-pool active sibling check
- publish one row at a time to RingCX
- stamp ownership
- append accepted rows
- release failed reservations

Not allowed:

- terminal outcome writes
- Logics writes
- coach release
- client projection decisions

### `maybeRefill` is the only refill gate

Current source:

- [cxBulkLoadRuntimeService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadRuntimeService.js:458)

Target:

Rename eventually to `refillIfBelowThreshold` to make the rule explicit.

Inputs:

- state

Outputs:

- state

Rules:

- if not running, no-op
- if live slots above threshold, no-op
- if at/below threshold, call `fillBuffer`
- no external side effects except reservation/publish/stamp/release through `fillBuffer`

### Watcher apply path owns current-call projection

Current source:

- [cxBulkLoadRuntimeService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadRuntimeService.js:953)

This is the right place to connect:

- RingCX account snapshot
- session projection
- release/current transition
- terminal auto outcome for released UIIs
- refill after projection

Concern to keep testing:

- no overlapping watcher ticks can double-reserve for the same session
- session apply/refill must be per-session serialized

### Terminal outbox owns call counting and post-call work

Current sources:

- [cxTerminalOutboxDrain.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxTerminalOutboxDrain.js:9)
- [cxAgentCallNoteService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxAgentCallNoteService.js:175)
- [cxCallWrapService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxCallWrapService.js:220)

Target:

The terminal row is the durable handoff.

The drain should be the only place that converts terminal records into:

- cadence count
- lead attempt state
- agent call note
- CaseProfile communication
- Logics activity/task where applicable
- coach closeout/grade candidate

## Logics Interweaving Checklist

### Exists now

- Logics side panel reads case context.
- Interview snapshot route writes LeadCadence plus CaseProfile/Logics activity.
- Coach closeout can write CaseProfile communication, Logics activity, LeadCadence, and agent call note.
- Terminal outbox can write agent call notes and optionally enqueue call wrap.
- Appointment modal creates appointment and can assign/postdate.

### Needs consolidation

- Appointment should become a call-wrap command, not a sequence of client mutations.
- DNC correction should feed the same terminal/wrap path.
- Interview snapshot should attach to the same call identity and terminal payload when possible.
- Coach summary should be stored as call note material for nightly grading, not only displayed live.
- Logics task/activity writes should return explicit statuses so the UI can say saved, pending, failed, or skipped.

## Refactor Order

### Pass 1 - Remove bulk/legacy crossovers

1. Guard or move the legacy recent workflow terminal effect out of bulk. First guard is in place; final target is moving it out of the bulk component entirely.
2. Stop clearing the case panel on bulk `current=null` unless session stopped/killed. First session-ended gate is in place; final target is a mode-exit/session-end cleanup hook.
3. Move coach release after terminal acceptance. First accepted-result gate is in place; final target is backend/terminal closeout ownership.
4. Remove legacy `dialAny` next-call fallback from bulk appointment flow.

### Pass 2 - Extract pure projection

1. Add `bulkCallProjection.ts`.
2. Move displayed-call selection and keys out of the component.
3. Unit test:
   - confirmed current wins
   - review candidate wins over latch while review active
   - latched call holds during current null
   - lastOutcome only used when running and no better display exists

### Pass 3 - Extract UI pieces

1. `BulkQueuePanel`
2. `BulkCallPanel`
3. `BulkTerminalControls`
4. `BulkTransitionBanner`
5. `BulkAutoReviewBanner`
6. `BulkCoachWorkbench`
7. `BulkLogicsWorkbench`

Each component should be prop-only and have no direct query/mutation imports unless it is explicitly a command hook boundary.

### Pass 4 - Collapse appointment/wrap

1. Add backend appointment-wrap command.
2. Move pause/create/assign/postdate/disposition/resume into one service.
3. Return structured statuses.
4. Update the modal hook to call one mutation.
5. Add tests for partial failures:
   - appointment succeeds, disposition fails
   - pause fails, appointment still allowed or blocked by explicit rule
   - Logics task fails, terminal outcome still counted
   - resume fails, UI shows agent action needed

### Pass 5 - Operational proof

Run with one real agent:

1. Load bulk session.
2. Let RingCX auto-progress through no-answer cases.
3. Confirm center panel holds until next UII.
4. Click Answer, DNC, No answer, Voicemail if enabled.
5. Open appointment, confirm agent status changes to Working.
6. Submit appointment, confirm resume to Available.
7. Confirm terminal outbox rows are inserted once.
8. Confirm drain writes call note once.
9. Confirm Logics/CaseProfile writes have visible statuses.
10. Confirm refill at threshold happens from backend only.

## What "Done" Looks Like

Bulk mode is ready when these statements are true:

- The client never advances because a workflow row refreshed.
- The client never clears the middle call before a new UII or session stop.
- The client never refills the queue.
- The client never writes Logics directly as part of call advancement.
- Button clicks send one command and wait for backend truth.
- Appointment wrap is one backend command.
- Coach release is tied to terminal acceptance or confirmed call replacement.
- Refill is backend-only and serialized per session.
- Every terminal call has one durable terminal row.
- Every enriched call has one call note and one optional CaseProfile/Logics wrap path.

## Design Direction

The long-term CX workplace is not three implementations. It is one call-cycle engine with different RingCX pacing.

```text
Shared:
  source pool
  reservation
  active-call watcher
  current-call projection
  terminal outbox
  call note
  Logics wrap
  coach closeout
  refill worker

Different:
  how many leads are handed to RingCX
  how long RingCX waits between calls
  whether the agent must click between calls
```

Bulk should be the first clean implementation of that future. Legacy should remain a fallback, not a source of shared client-side side effects.
