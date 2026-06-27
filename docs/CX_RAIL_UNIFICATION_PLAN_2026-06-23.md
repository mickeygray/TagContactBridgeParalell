# CX Rail Unification Plan

## Goal

Unify the CX dialing system so there is one call-control architecture and the only meaningful difference between modes is serving speed.

```text
lead pool
  -> reservation
  -> rail handoff policy
  -> RingCX active-call truth
  -> universal current-call projection
  -> terminal button/outbox
  -> cadence/metrics/Logics drain
```

The rail decides how fast leads are handed to RingCX. Everything else should be universal.

## Reality Check

This app started as a Logics/RingCX integration, but the practical source of truth for live calls is RingCX, not Logics and not the browser.

Logics should remain:

- case context
- side-panel detail
- DNC/status write target after terminal decisions
- activity/payment/profile enrichment

Logics should not be:

- the identity source for the middle call panel
- the thing that decides who is currently on the phone
- a live-loop dependency for every call transition

The live loop should be RingCX-proofed first, then Logics should be updated from durable terminal events.

## Universal System

### 1. Lead Pool

All rails should pull from the same pool/reservation contract.

Universal responsibilities:

- keep queue rows in family buckets
- enforce DNC/contactability/Logics suppression before reservation
- reserve rows atomically
- release rows safely if publish fails
- never directly assign surprise new greens into a running agent rail

Rail-specific responsibilities:

- how many rows to request
- when to request them

Target policy examples:

| Rail | Reservation size | RingCX publish style | Refill |
| --- | ---: | --- | --- |
| `slow_single` | 1 | one at a time, wait accepted | after terminal |
| `next_call_send` | 1 next lead | send next after terminal | after terminal |
| `bulk_load` | 35 target | publish accepted rows one by one | when remaining reaches 5, load 30 |

### 2. Rail Handoff Policy

Rail handoff should be a policy object, not a separate system.

```js
{
  rail: "bulk_load",
  targetBuffer: 35,
  refillThreshold: 5,
  refillSize: 30,
  publishPriority: "NORMAL",
  publishTiming: "preload",
  terminalBehavior: "button-outbox",
}
```

The rail owns only these questions:

- How many leads should be loaded?
- When should RingCX receive the next lead?
- What priority should the RingCX lead use?
- Should the next lead be preloaded or sent after terminal?

It should not own active-call truth, terminal persistence, Logics updates, or cadence counting.

### 3. Active-Call Truth

The shared source of live call truth is the account active-call watcher:

- [CX_ACCOUNT_ACTIVE_CALL_WATCHER_PLAN_2026-06-23.md](C:/code/TagContactBridgeParalell/docs/CX_ACCOUNT_ACTIVE_CALL_WATCHER_PLAN_2026-06-23.md)
- [cxAccountActiveCallWatcherService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxAccountActiveCallWatcherService.js)

One RingCX account snapshot fans out to every active local rail session for that account.

The watcher may update:

- current UII
- current externId
- current queue item identity
- active call summary
- first-seen/last-seen trace

The watcher must not:

- select leads
- refill queues
- call Logics
- write cadence counts
- mark DNC
- infer identity by phone

This is the core desync-proofing move.

### 4. Universal Current-Call Projection

Every rail should expose the same current-call shape to the UI.

```js
{
  rail,
  phase,
  agentEmail,
  agentExtensionId,
  domain,
  accountId,
  campaignId,
  queueItemId,
  caseId,
  name,
  externId,
  uii,
  activeAt,
  releasedAt,
  terminalOutcome,
  terminalIntent,
  activeCallSummary,
  bufferCount,
  completedCount,
}
```

The UI should not need to know whether the call came from slow, next-send, or bulk.

The UI needs only:

- `waiting`
- `active`
- `releasing`
- `refilling`
- `blocked`

### 5. Universal Terminal Path

All buttons and RingCX auto-advance observations should become terminal events with the same durable shape.

```js
{
  rail,
  sessionId,
  agentEmail,
  agentExtensionId,
  domain,
  queueItemId,
  caseId,
  externId,
  uii,
  outcome,
  source,
  reason,
  occurredAt,
}
```

Button outcomes:

- `answered`
- `voicemail`
- `dnc`
- `did_not_connect`

Auto-advance outcome:

- default to `did_not_connect` only when RingCX proves a UII/externalId was released and no button terminal event exists.

The live loop should not call Logics or cadence directly. It should write the terminal outbox and move on.

### 6. Universal Drain

The drain is where expensive or non-time-critical side effects happen.

Drain responsibilities:

- cadence attempt count
- monthly/day spacing
- DNC propagation
- Logics status/update where needed
- metrics
- call summary/grader side effects
- retries and dedupe

This keeps the live call transition fast and stable.

## Current System Map

The current app is not one rail with different pacing. It is three runtime shapes plus legacy workspace state.

### Shared Inventory: `CxDialQueue`

Current owner:

- [CxDialQueue.js](C:/code/TagContactBridgeParalell/packages/shared-models/src/CxDialQueue.js)
- [cxDialQueueRepository.js](C:/code/TagContactBridgeParalell/packages/shared-repositories/src/cxDialQueueRepository.js)
- [cxQueueReservationService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxQueueReservationService.js)

What it does well today:

- stores the durable lead inventory
- separates active states: `queued`, `ready`, `claimed`, `serving`, `completed`, `cancelled`, `paused`
- carries family/rank/progressive counters for green/blue/yellow/red style ordering
- supports atomic `ready -> claimed` reservation by session
- carries RingCX route metadata and reservation ownership metadata

What it should become:

- the only source of reservable lead inventory
- not the live current-call object
- not the UI queue by itself
- not the terminal outcome writer

### Legacy Workspace Rail

Current owners:

- [CXWorkspace.tsx](C:/code/TagContactBridgeParalell/apps/web-client/src/workspaces/cx/CXWorkspace.tsx)
- [readCx.js](C:/code/TagContactBridgeParalell/apps/control-plane/src/routes/readCx.js)
- [commandsCx.js](C:/code/TagContactBridgeParalell/apps/control-plane/src/routes/commandsCx.js)
- [cxWorkspaceService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxWorkspaceService.js)
- [ringcxDialExecutionService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/ringcxDialExecutionService.js)
- [ringcxAgentMonitorService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/ringcxAgentMonitorService.js)
- [AgentState.js](C:/code/TagContactBridgeParalell/packages/shared-models/src/AgentState.js)

Current state shape:

```js
AgentState.currentCall        // legacy middle-panel truth
AgentState.cxCall             // shadow canonical lifecycle
AgentState.cxCallBuckets      // shadow queue/current/completion bucket
workspace.callQueue           // built from CX queue items for the side list
```

Current behavior:

- `buildCxWorkspace` returns `ex.currentCall` from `AgentState.currentCall`.
- `buildCxCallQueue` returns the visible queue from current workspace context.
- `ringcxAgentMonitorService.markAgentCxActive` writes `AgentState.currentCall`, shadow `cxCall`, and queue metadata when RingCX sees an active CX call.
- Legacy terminal and next-dial behavior still pass through command/workspace services and can clear or advance `AgentState.currentCall`.
- The UI still has local transition guards, suppression maps, next-dial timing refs, and phone/Logics fallback paths.

Migration role:

- keep as the safe fallback while new object readers prove out
- adapt `AgentState.cxCallBuckets` into the unified queue object first
- stop treating `AgentState.currentCall` as authoritative once the account watcher projection is clean
- retire legacy-specific button and current-call logic last

### Bulk Load Rail

Current owners:

- [CXWorkspaceBulkLoad.tsx](C:/code/TagContactBridgeParalell/apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx)
- [cxBulkLoad.js](C:/code/TagContactBridgeParalell/apps/control-plane/src/routes/cxBulkLoad.js)
- [CxBulkLoadSession.js](C:/code/TagContactBridgeParalell/packages/shared-models/src/CxBulkLoadSession.js)
- [cxBulkLoadRuntimeService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadRuntimeService.js)
- [cxBulkLoadStateMachine.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadStateMachine.js)
- [cxBulkLoadOutcomeAdapter.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadOutcomeAdapter.js)

Current state shape:

```js
CxBulkLoadSession.acceptedBuffer
CxBulkLoadSession.current
CxBulkLoadSession.completed
CxBulkLoadSession.prevActiveExternIds
CxBulkLoadSession.stats.targetSize
CxBulkLoadSession.stats.refillThreshold
```

Current behavior:

- start creates one running session per agent
- `fillBuffer` reserves rows from `CxDialQueue`, publishes them one at a time to RingCX, and appends accepted rows to `acceptedBuffer`
- browser/server `watch` observes active calls and moves accepted rows into `current`
- terminal buttons call RingCX disposition/hangup, write terminal outbox, clear current, and call `maybeRefill`
- this is the closest rail to the desired model, but the watcher and refill still live inside the rail runtime

Migration role:

- use as the reference implementation for accepted-buffer semantics
- extract buffer/refill math into the universal queue object
- extract current-call projection into the account watcher
- keep the outbox adapter shape, then generalize its name and inputs beyond bulk

### Slow Single Rail

Current owners:

- [CXWorkspaceSlowSingle.tsx](C:/code/TagContactBridgeParalell/apps/web-client/src/workspaces/cx/slow-single/CXWorkspaceSlowSingle.tsx)
- [cxSlowSingle.js](C:/code/TagContactBridgeParalell/apps/control-plane/src/routes/cxSlowSingle.js)
- [CxSlowLaneSession.js](C:/code/TagContactBridgeParalell/packages/shared-models/src/CxSlowLaneSession.js)
- [cxSlowLaneService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxSlowLaneService.js)
- [cxSlowLaneStateMachine.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxSlowLaneStateMachine.js)

Current state shape:

```js
CxSlowLaneSession.current
CxSlowLaneSession.phase
CxSlowLaneSession.lastOutcome
```

Current behavior:

- start reserves one row through the reservation service
- publishes it to RingCX
- confirms active UII with a private watch command
- terminal outcome calls RingCX hangup/disposition and then directly calls cadence/finalizer logic

Migration role:

- keep the strict one-at-a-time UX as the emergency rail
- replace private watch with account watcher projection
- replace direct cadence/finalizer calls with terminal outbox
- add optional next-call-send pacing only after the watcher projection is authoritative

### Simple Loop / Test Harness

Current owners:

- [CxSimpleLoopSession.js](C:/code/TagContactBridgeParalell/packages/shared-models/src/CxSimpleLoopSession.js)
- [cxSimpleLoop.js](C:/code/TagContactBridgeParalell/apps/control-plane/src/routes/cxSimpleLoop.js)
- [cxSimpleCallLoopService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxSimpleCallLoopService.js)
- legacy harness code inside [CXWorkspace.tsx](C:/code/TagContactBridgeParalell/apps/web-client/src/workspaces/cx/CXWorkspace.tsx)

Current behavior:

- useful as a proving ground for reducer ideas
- still overlaps with bulk mirror, slow start/watch, and legacy commands
- carries old experiment paths that should not become another production rail

Migration role:

- preserve only tests or pure reducer lessons that are still useful
- do not keep as a fourth runtime mode
- delete or quarantine after slow/bulk/legacy can all project through the unified object

### Terminal Persistence

Current owners:

- [CxTerminalOutbox.js](C:/code/TagContactBridgeParalell/packages/shared-models/src/CxTerminalOutbox.js)
- [cxTerminalOutboxDrain.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxTerminalOutboxDrain.js)
- [cxBulkLoadOutcomeAdapter.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadOutcomeAdapter.js)
- direct terminal paths in [cxSlowLaneService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxSlowLaneService.js), [cxSimpleCallLoopService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxSimpleCallLoopService.js), and legacy workspace services

Current behavior:

- bulk writes a replayable outbox row
- slow and legacy still have direct cadence/Logics/finalizer calls in the hot path
- drain exists, but the migration still needs to make it the only durable side-effect path

Migration role:

- rename/generalize bulk outcome adapter to terminal outbox adapter
- all manual buttons and auto-release observations write this outbox
- drain owns cadence counts, metrics, DNC propagation, Logics updates, and retries

### UI Routing

Current owner:

- [CXWorkspaceRouter.tsx](C:/code/TagContactBridgeParalell/apps/web-client/src/workspaces/cx/CXWorkspaceRouter.tsx)

Current behavior:

```ts
VITE_CX_WORKSPACE_MODE = legacy_emergency | slow_single | bulk_load
```

- the mode is a client-build/runtime env switch
- each mode renders a separate workspace component
- each component owns different button, watch, and loading behavior

Migration role:

- keep this router as the coarse fallback switch during migration
- build a shared rail projection and button component underneath it
- eventually make the selector choose policy, not a different workspace brain

## Migration From Current State To One Queue Object

The target object should be written and read through adapters while the old rails continue working.

```js
AgentQueueState = {
  agent: { email, extensionId, cxAgentId, accountId },
  rail: { mode, targetBuffer, refillThreshold, refillSize, publishPriority, publishTiming },
  pending: [],
  current: null,
  terminalBuffer: [],
  refill: { inFlight: false, lastAttemptAt: null, lastResult: null },
  health: { lastWatcherAt: null, lastRingcxError: null, lastProjectionMismatch: null }
}
```

Mapping from today:

| Unified field | Legacy source today | Bulk source today | Slow source today |
| --- | --- | --- | --- |
| `pending` | `AgentState.cxCallBuckets.newCalls` / `workspace.callQueue` | `CxBulkLoadSession.acceptedBuffer` | empty or one reserved row before publish |
| `current` | `AgentState.currentCall` and `cxCallBuckets.currentCall` | `CxBulkLoadSession.current` | `CxSlowLaneSession.current` |
| `terminalBuffer` | `cxCallBuckets.completionBuffer` / terminal commands | `CxBulkLoadSession.completed` + terminal outbox | `lastOutcome` plus direct finalizer |
| `rail` | legacy flags/workspace mode | `stats.targetSize/refillThreshold` and `ringcx` | one-at-a-time defaults |
| `health` | monitor traces and workspace logs | runtime trace / watcher trace | session trace |

The migration should not start by deleting current code. It should first build these adapters:

```js
readLegacyAgentQueueState(agent)
readBulkAgentQueueState(session)
readSlowAgentQueueState(session)
projectAgentQueueStateForUi(state)
```

Then each worker can operate on the same object:

- account active-call watcher: updates only `current`
- terminal command/outbox: moves `current -> terminalBuffer`
- refill worker: appends accepted rows to `pending`
- terminal drain: drains `terminalBuffer` side effects outside the live loop

### Migration Sequence

1. **Read adapters only**
   - Build projection readers over `AgentState`, `CxBulkLoadSession`, and `CxSlowLaneSession`.
   - No writes.
   - Compare projected state to what each UI currently shows.

2. **Shadow queue object**
   - Write the projected object to `AgentState.cxCallBuckets` or a new rail-state collection in shadow mode.
   - Keep legacy/bulk/slow behavior untouched.
   - Use [cx-floor-queue-shadow-follow.js](C:/code/TagContactBridgeParalell/scripts/cx-floor-queue-shadow-follow.js) to validate consume/refill semantics.

3. **Universal account watcher**
   - Extend [cxAccountActiveCallWatcherService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxAccountActiveCallWatcherService.js) beyond bulk sessions.
   - It should fan out one `activeCalls/list` snapshot per account to all projected agent states.
   - It writes only current-call projection and watcher health.

4. **Universal terminal outbox**
   - Generalize [cxBulkLoadOutcomeAdapter.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadOutcomeAdapter.js) into a rail-neutral adapter.
   - Convert slow and legacy terminal buttons to insert outbox rows instead of direct cadence/Logics writes.
   - Keep existing direct writers callable until the outbox drain proves replay-safe.

5. **Refill worker**
   - Move `maybeRefill` out of bulk runtime into a rail-neutral queue worker.
   - Input is `AgentQueueState + rail policy`.
   - Output is accepted/published rows appended to `pending`.
   - It must not read RingCX current calls or write terminal outcomes.

6. **Shared UI projection**
   - Keep [CXWorkspaceRouter.tsx](C:/code/TagContactBridgeParalell/apps/web-client/src/workspaces/cx/CXWorkspaceRouter.tsx) as the rollback switch.
   - Add one shared center panel, button row, transition overlay, and queue list fed from `projectAgentQueueStateForUi`.
   - The visual UI should stay the same when switching rails; only pacing changes.

7. **Retire rail-private loops**
   - Remove browser mutation-style watch calls after account watcher is the source of current-call truth.
   - Remove simple-loop production path after its tests are absorbed.
   - Retire `AgentState.currentCall` as a write target only after legacy fallback is no longer needed.

### Cutover Rule

Each migration phase must be reversible by one flag and must pass these checks:

- no duplicate current call for an agent
- no phone-only identity match
- no terminal outcome without `queueItemId` plus UII or documented no-UII fallback
- no lead can be in two live rails at once
- no Logics or cadence write occurs in the active call watcher
- refill can be simulated read-only before it publishes
- UI can clear/transition without hiding the actual authoritative current call

## Where The Code Is Not Unified Yet

### Active-Call Truth Is Still Split

Bulk still has browser-driven watch:

- [CXWorkspaceBulkLoad.tsx](C:/code/TagContactBridgeParalell/apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx)

Bulk still has a per-session server watcher:

- [cxBulkLoadRuntimeService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadRuntimeService.js)

Slow-single has its own watch loop:

- [CXWorkspaceSlowSingle.tsx](C:/code/TagContactBridgeParalell/apps/web-client/src/workspaces/cx/slow-single/CXWorkspaceSlowSingle.tsx)

Legacy still reads `currentCall` from workspace/agent-state plumbing:

- [CXWorkspace.tsx](C:/code/TagContactBridgeParalell/apps/web-client/src/workspaces/cx/CXWorkspace.tsx)

Target:

- all modes read the account watcher projection
- browser polling becomes read-only
- no mode privately calls `activeCalls/list`

### Terminal Writes Are Still Mode-Specific

Bulk has the closest shape with outcome adapter/outbox:

- [cxBulkLoadOutcomeAdapter.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadOutcomeAdapter.js)
- [cxTerminalOutboxDrain.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxTerminalOutboxDrain.js)

Slow lane still directly finalizes:

- [cxSlowLaneService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxSlowLaneService.js)

Simple loop still directly finalizes:

- [cxSimpleCallLoopService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxSimpleCallLoopService.js)

Target:

- all terminal paths write the same outbox event
- one drain handles cadence/counts/Logics

### Queue Selection Is Closer But Not Universal

Bulk uses the reservation service.

Slow lane has a local wrapper over reservation.

Legacy still has older claim/serve paths inside cadence/workspace services.

Target:

- one reservation service
- one family target/bucket policy
- one claim/release contract
- rail policy controls only quantity/timing

### UI Still Has Separate Rail Brains

Bulk, slow-single, simple-loop, and legacy all carry their own command flow and state assumptions.

Target:

- one `CallRailWorkspace` shell
- one button row
- one transition overlay
- one current-call panel
- rail-specific adapter only supplies policy and command endpoints

### Phone And Logics Still Leak Into Live Identity

Some current-call and form plumbing still carries `currentCallPhone`, Logics lookup, or selected-contact fallback into the live call view.

Target:

- middle panel identity comes from queue item + RingCX externId/UII
- phone is display/supporting context only
- Logics data loads in side panels after the case identity is known

## Migration Plan

### Phase 0: Freeze And Guard

Before patching:

- keep legacy live behavior available
- do not remove flags while introducing shared services
- keep mode selection explicit
- keep the new account watcher dry-run/apply controllable

Acceptance:

- no live behavior changes without a flag flip
- one command can return the floor to legacy safe mode

### Phase 1: Account Watcher Shadow

Use the existing first draft.

Tasks:

- run [cx-account-active-call-watch-once.js](C:/code/TagContactBridgeParalell/scripts/cx-account-active-call-watch-once.js) in dry-run
- compare output against current live UI/session state
- verify one RingCX account call fans out correctly
- verify no cross-agent projection churn
- verify no phone matching

Acceptance:

- active UII/current lead matches what agents see
- no 429s
- no false current assignments
- no writes in dry-run

### Phase 2: Account Watcher Worker

Turn the one-off into a control-plane worker.

Worker behavior:

- tick at 1s while active rail sessions exist
- back off to 5-10s when idle
- group by account
- call RingCX once per account
- fan out to all active rail sessions
- write only changed projections
- back off on 429 without killing sessions

Acceptance:

- browser no longer needs mutation-style watch calls
- worker state is visible in health
- logs show account calls, active calls, projection changes, 429 backoff

### Phase 3: Universal Current Projection

Create a shared projection API consumed by UI.

Tasks:

- define one current-call DTO
- adapt bulk session to it
- adapt slow session to it
- adapt legacy state to it
- update UI to read projection, not rail internals

Acceptance:

- the middle panel renders the same regardless of rail
- changing rail does not change button layout or case display
- selected/form state no longer owns call identity

### Phase 4: Universal Terminal Outbox

Move all terminal writes to one outbox contract.

Tasks:

- keep bulk as the reference implementation
- adapt slow terminal path to write the same event
- adapt legacy/next-call-send terminal path to write the same event
- represent RingCX auto-advance as terminal observation, not watcher side effect

Acceptance:

- no rail calls `handleCxTerminalCallOutcome` directly from the live loop
- terminal events dedupe by `queueItemId + uii + outcome/source`
- DNC still reaches Logics through the drain
- metrics/cadence update after drain, not during UI transition

### Phase 5: Universal Queue/Reservation

Make every rail request work from the same lead pool/reservation service.

Tasks:

- preserve existing family bucket policy
- stop agent-specific surprise inserts during active rails
- route new greens into pool buffers
- let rails request `1`, `next`, or `target buffer`
- release rejected/publish-failed rows

Acceptance:

- no duplicate active case across rails
- no row remains claimed without a session owner
- DNC/contactability suppression is checked before reserve
- refill behavior is testable without RingCX

### Phase 6: Rail Policy Only

Collapse mode differences into policy.

Rail policies:

- `slow_single`: reserve/publish one, wait for proof
- `next_call_send`: terminal current, publish next, wait for proof before display
- `bulk_load`: maintain accepted buffer, display only RingCX active

Acceptance:

- same queue service
- same watcher
- same terminal outbox
- same drain
- same UI
- only pacing policy differs

### Phase 7: Delete Old Brains

Remove the duplicated paths after shadow evidence proves the shared path.

Delete or retire:

- per-session active-call pollers
- browser mutation watch loops
- direct terminal finalizers in slow/simple/legacy
- phone-based current-call identity
- rail-specific button implementations

Acceptance:

- no route directly decides call state
- no client mutation creates active-call truth
- no rail performs Logics writes inline during call transition

## Component-by-Component Diffs

Each component below should be implemented as its own tight diff. Do not mix unrelated components in one patch. The purpose is to make rollback and review boring.

### Component 1: Account Active-Call Watcher

Current:

- bulk has `watchCxBulkLoadSession`
- slow-single has a private watch command
- browser components trigger watch mutations
- RingCX active-call reads are still mode/session scoped

Target:

- one account-level watcher reads `activeCalls/list` once per RingCX account
- watcher fans out to all active sessions for that account
- watcher writes only changed current-call projection
- browser reads state only

Primary files:

- [cxAccountActiveCallWatcherService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxAccountActiveCallWatcherService.js)
- [cxBulkLoadActiveCallWatcher.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadActiveCallWatcher.js)
- [cxBulkLoadSessionRepository.js](C:/code/TagContactBridgeParalell/packages/shared-repositories/src/cxBulkLoadSessionRepository.js)
- [server.js](C:/code/TagContactBridgeParalell/apps/control-plane/src/server.js)
- [cx-account-active-call-watch-once.js](C:/code/TagContactBridgeParalell/scripts/cx-account-active-call-watch-once.js)

Implementation diff:

1. Keep the one-off dry-run/apply script.
2. Add a control-plane worker behind `CX_ACCOUNT_ACTIVE_WATCHER_ENABLED=false` by default.
3. Worker lists active sessions from each rail.
4. Worker groups sessions by `ringcx.accountId`.
5. Worker calls `client.listActiveCalls({ product: "ACCOUNT", productId: accountId })` once per account.
6. Worker projects each session from only its relevant `externId`s.
7. Worker writes only changed projections.
8. Worker logs compact timing, active-call count, changed session count, and 429 backoff.

Tests:

- one RingCX call per account
- no cross-agent projection churn
- no phone-only matching
- no write when no relevant call changed
- retryable 429/backoff does not kill sessions

Rollback:

- set `CX_ACCOUNT_ACTIVE_WATCHER_ENABLED=false`
- leave old per-rail watch routes intact until cutover is proven

### Component 2: Universal Session Projection

Current:

- bulk session, slow session, simple-loop session, and legacy current-call shape differ
- UI knows too much about rail internals
- middle panel can still be influenced by current-call phone/logics paths

Target:

- one normalized projection shape for every rail
- UI consumes the projection, not raw rail internals
- projection identity is queue item + externId + UII, not phone

Primary files:

- new `packages/shared-services/src/cxCallRailProjectionService.js`
- [CxBulkLoadSession.js](C:/code/TagContactBridgeParalell/packages/shared-models/src/CxBulkLoadSession.js)
- [CxSlowLaneSession.js](C:/code/TagContactBridgeParalell/packages/shared-models/src/CxSlowLaneSession.js)
- [AgentState.js](C:/code/TagContactBridgeParalell/packages/shared-models/src/AgentState.js)
- [CXWorkspaceBulkLoad.tsx](C:/code/TagContactBridgeParalell/apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx)
- [CXWorkspace.tsx](C:/code/TagContactBridgeParalell/apps/web-client/src/workspaces/cx/CXWorkspace.tsx)

Implementation diff:

1. Add pure `projectCallRailState(sessionOrAgentState)` helper.
2. Add adapter functions:
   - `projectBulkLoadRailState`
   - `projectSlowSingleRailState`
   - `projectLegacyRailState`
3. Include only non-PII active-call trace in projection.
4. Update read routes to return projection alongside existing raw session.
5. Update UI to prefer projection when present.
6. Remove phone fallback from middle-panel identity after projection is proven.

Tests:

- bulk/slow/legacy raw states project to the same DTO
- missing UII yields waiting/blocked, not guessed identity
- phone-only state does not produce active identity
- UI can render projection without rail-specific fields

Rollback:

- keep raw session response available
- UI can fall back to old rail fields until projection flag is enabled

### Component 3: Universal Terminal Outbox

Current:

- bulk writes through outcome adapter/outbox
- slow and simple-loop call `handleCxTerminalCallOutcome` directly
- auto-advance observations are not yet a first-class terminal observation stream

Target:

- every button and every RingCX auto-release writes the same terminal outbox event
- one drain updates cadence, metrics, Logics, and DNC
- live transition path does no Logics/cadence work

Primary files:

- [cxBulkLoadOutcomeAdapter.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadOutcomeAdapter.js)
- [cxTerminalOutboxDrain.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxTerminalOutboxDrain.js)
- [cxTerminalOutboxRepository.js](C:/code/TagContactBridgeParalell/packages/shared-repositories/src/cxTerminalOutboxRepository.js)
- [cxSlowLaneService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxSlowLaneService.js)
- [cxSimpleCallLoopService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxSimpleCallLoopService.js)
- [cxCadenceService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxCadenceService.js)

Implementation diff:

1. Rename/generalize bulk outcome adapter to `cxTerminalOutboxAdapter`.
2. Make adapter rail-agnostic.
3. Convert slow terminal path to write outbox event.
4. Convert simple-loop terminal path to write outbox event.
5. Convert bulk auto-advance/release observation to write a terminal observation row, not cadence directly.
6. Drain maps terminal event to `handleCxTerminalCallOutcome`.
7. DNC/Logics writes happen only in the drain.

Tests:

- duplicate terminal button clicks dedupe
- button terminal and auto observation for same UII dedupe correctly
- DNC terminal produces drain payload for Logics suppression
- no live-loop function calls `handleCxTerminalCallOutcome` directly after conversion

Rollback:

- pause drain if needed
- old direct terminal finalizers remain callable until each rail conversion is complete

### Component 4: Universal Lead Pool And Reservation

Current:

- bulk uses reservation service
- slow has a local reservation wrapper
- legacy still has older claim/serve flow in cadence/workspace code
- intake may still be able to feed rows into agent-visible queues outside the rail buffer policy

Target:

- all rails reserve from the same family buckets
- new leads enter the pool, not an active agent rail
- rail policy controls quantity/timing only

Primary files:

- [cxQueueReservationService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxQueueReservationService.js)
- [cxReserveModeService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxReserveModeService.js)
- [cxDialQueueRepository.js](C:/code/TagContactBridgeParalell/packages/shared-repositories/src/cxDialQueueRepository.js)
- [cxBulkLoadRuntimeService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadRuntimeService.js)
- [cxSlowLaneService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxSlowLaneService.js)
- [cxCadenceService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxCadenceService.js)
- intake/lead serving paths that add fresh leads

Implementation diff:

1. Define `reserveForRail({ rail, agent, domain, policy })`.
2. `bulk_load` requests target buffer/refill size.
3. `slow_single` requests one.
4. `next_call_send` requests one next lead.
5. Route all publish failures through release.
6. Route intake into pool buckets, not direct running-session insertion.
7. Add guard that no rail can reserve a case already active in another rail.

Tests:

- one case cannot be active in two rails
- publish reject releases reservation
- DNC/contactability suppression blocks reserve
- new green goes into pool and waits for next reserve cycle
- family ordering is stable and deterministic

Rollback:

- keep old claim path behind legacy flag until reserve service proves stable for slow and next-call-send

### Component 5: Rail Handoff Policies

Current:

- mode behavior is scattered through services and UI conditionals
- simple-loop/bulk-mirror/slow have overlapping responsibilities
- some rail behavior is encoded by booleans instead of policy

Target:

- one `cxRailPolicyService` defines mode behavior
- rail policy decides buffer size, refill threshold, publish priority, and publish timing
- services consume policy instead of branching everywhere

Primary files:

- new `packages/shared-services/src/cxRailPolicyService.js`
- [cxDialRuntimeModeService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxDialRuntimeModeService.js)
- [cxBulkLoadRuntime.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadRuntime.js)
- [cxSlowLaneService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxSlowLaneService.js)
- [cxSimpleCallLoopService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxSimpleCallLoopService.js)

Implementation diff:

1. Add policy resolver by agent/domain/flag.
2. Replace mode booleans with `railPolicy`.
3. Make each rail service receive policy explicitly.
4. Keep default policy safe/slow.
5. Log policy selected at session start.

Tests:

- agent resolves to expected rail policy
- unknown/missing flag resolves to safe default
- appointment policy uses immediate priority while normal queues use normal priority
- policy does not change terminal/outbox behavior

Rollback:

- one env flag returns all agents to legacy/safe policy

### Component 6: Shared UI Shell

Current:

- bulk, slow-single, simple-loop, and legacy have separate UI brains
- buttons are wired per mode
- transition overlay is duplicated
- center panel identity is still partly form/selected/currentCall driven

Target:

- one `CallRailWorkspace` shell
- one button row
- one transition overlay
- one current-call panel
- rail-specific adapter only supplies commands and state projection

Primary files:

- [CXWorkspace.tsx](C:/code/TagContactBridgeParalell/apps/web-client/src/workspaces/cx/CXWorkspace.tsx)
- [CXWorkspaceBulkLoad.tsx](C:/code/TagContactBridgeParalell/apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx)
- [CXWorkspaceSlowSingle.tsx](C:/code/TagContactBridgeParalell/apps/web-client/src/workspaces/cx/slow-single/CXWorkspaceSlowSingle.tsx)
- new `apps/web-client/src/workspaces/cx/CallRailWorkspace.tsx`
- API query hooks under [apps/web-client/src/lib/api/queries](C:/code/TagContactBridgeParalell/apps/web-client/src/lib/api/queries)

Implementation diff:

1. Extract `CallRailCurrentPanel`.
2. Extract `CallRailButtons`.
3. Extract `CallRailTransitionOverlay`.
4. Extract `useCallRailController`.
5. Bulk/slow/legacy adapters implement the same controller interface.
6. Remove mode-specific button layout after parity.

Tests:

- each rail renders same visible controls for same projection
- disabled/releasing state blocks duplicate clicks
- button sends one terminal command
- no form submit causes accidental queue advance
- current panel never hydrates identity from phone alone

Rollback:

- keep old workspace files routable until shared shell passes smoke tests

### Component 7: Logics And Side Effects

Current:

- Logics data is useful but still too near live identity and terminal paths
- DNC/updates can be mixed with button behavior depending on rail

Target:

- Logics is side-panel context and drain-side update target
- no Logics read/write is required for live call transition
- DNC propagates from terminal outbox drain

Primary files:

- [CXWorkspace.tsx](C:/code/TagContactBridgeParalell/apps/web-client/src/workspaces/cx/CXWorkspace.tsx)
- [CXWorkspaceBulkLoad.tsx](C:/code/TagContactBridgeParalell/apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx)
- [cxCadenceService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxCadenceService.js)
- Logics command routes under control-plane

Implementation diff:

1. Side panels load Logics by known `caseId`.
2. Middle panel does not use Logics lookup to choose active lead.
3. Terminal drain performs DNC/status updates.
4. Failure to update Logics retries in drain and never blocks next call.

Tests:

- missing Logics case does not block active call display
- DNC terminal eventually writes suppression
- Logics 429/failure does not block UI next-call state
- side panel handles absent data gracefully

Rollback:

- keep manual Logics actions available in UI even if drain is paused

## Grounded Functional Test Matrix

This section turns the migration plan into component-by-component tests. Each test should prove one element in isolation before we combine the full call flow.

### Element 1: List Building, Persistence, And Refresh

Proposed function:

- reserve from the shared pool
- publish to RingCX one accepted lead at a time
- persist the accepted buffer locally
- keep the middle panel independent from queue ordering
- refresh only when rail policy says the buffer is low
- release failed/rejected reservations instead of leaving claimed rows behind

Current executable coverage:

- [cxBulkLoadRuntimeService.test.js](C:/code/TagContactBridgeParalell/tests/cx-bulk-load/cxBulkLoadRuntimeService.test.js) `start fills the buffer to target via one publish and goes ready`
- [cxBulkLoadRuntimeService.test.js](C:/code/TagContactBridgeParalell/tests/cx-bulk-load/cxBulkLoadRuntimeService.test.js) `start sources the buffer from the reservation service, scoped to agent + domain + session`
- [cxBulkLoadRuntimeService.test.js](C:/code/TagContactBridgeParalell/tests/cx-bulk-load/cxBulkLoadRuntimeService.test.js) `fillBuffer reserves up to the deficit and publishes each reserved row one-at-a-time in reserve order, phone carried through`
- [cxBulkLoadRuntimeService.test.js](C:/code/TagContactBridgeParalell/tests/cx-bulk-load/cxBulkLoadRuntimeService.test.js) `bulk refill at the threshold tops the buffer back to 35 in residual family order`
- [cxBulkLoadRuntimeService.test.js](C:/code/TagContactBridgeParalell/tests/cx-bulk-load/cxBulkLoadRuntimeService.test.js) `a publish reject drops the candidate from the buffer and releases its reservation`
- [cxQueueReservationService.test.js](C:/code/TagContactBridgeParalell/tests/cx-bulk-load/cxQueueReservationService.test.js) family-order and reservation ownership tests

Behavior these tests lock:

- `bulk_load` target is 35.
- Refill threshold is 5.
- A 5-green live buffer refills with residual targets: 10 green, 10 blue, 5 yellow, 5 red.
- RingCX publish is one row per accepted response, in reservation order.
- The client-safe queue projection strips full phone numbers.
- Rejected publishes release claims immediately.
- Terminal disposition refills after the accepted terminal path, not from the watcher.

Remaining gaps to test before floor confidence:

- Starting a session while the agent is not off-hook must not publish yet, and a separate prep/start command must publish when off-hook is later true. Do not hide this inside the active-call watcher.
- The refill worker must prove it can load the next batch without direct user action once live slots reach the threshold.
- Mongo insert-once dedupe for terminal outbox is still integration-deferred.
- Queue rows need a real-DB proof that reservation/session ownership survives process restart.
- UI must keep the visible queue stable during release/refill instead of draining the whole left panel.

Manual/local test order:

1. Drain the test campaign and local session.
2. Seed a known pool: 15 green, 10 blue, 5 yellow, 5 red.
3. Start bulk session and confirm local `acceptedBuffer` equals RingCX accepted count.
4. Let RingCX dial, then verify only the active UII controls the middle panel.
5. Press each terminal button once and verify the current goes to terminal outbox, not direct Logics/cadence writes.
6. When the buffer reaches 5, verify 30 more leads are published one at a time and appended to the persisted buffer.
7. Confirm the queue display does not reorder based on phone/Logics enrichment.

### Element 2: Polling Truly Universal Across Agents

Proposed function:

- one account-level active-call read per RingCX account
- fan out the snapshot to every active local rail session under that account
- match only by owned `externId` / queue identity / UII
- write only changed current-call projection
- never count, refill, DNC, or call Logics from the watcher
- tolerate one account failure without poisoning other accounts

Current executable coverage:

- [cxAccountActiveCallWatcherService.test.js](C:/code/TagContactBridgeParalell/tests/cx-bulk-load/cxAccountActiveCallWatcherService.test.js) `groupBulkSessionsByAccount groups sessions by RingCX account and reports missing account ids`
- [cxAccountActiveCallWatcherService.test.js](C:/code/TagContactBridgeParalell/tests/cx-bulk-load/cxAccountActiveCallWatcherService.test.js) `buildCxAccountActiveCallWatchPlan calls RingCX once per account and fans out to sessions`
- [cxAccountActiveCallWatcherService.test.js](C:/code/TagContactBridgeParalell/tests/cx-bulk-load/cxAccountActiveCallWatcherService.test.js) `account watcher updates multiple agents from one account snapshot without cross-agent churn`
- [cxAccountActiveCallWatcherService.test.js](C:/code/TagContactBridgeParalell/tests/cx-bulk-load/cxAccountActiveCallWatcherService.test.js) `account watcher isolates an account read failure and keeps other accounts useful`
- [cxBulkLoadActiveCallWatcher.test.js](C:/code/TagContactBridgeParalell/tests/cx-bulk-load/cxBulkLoadActiveCallWatcher.test.js) no phone-only matching / ambiguity tests

Behavior these tests lock:

- Sean and Brad can both update from one RingCX account snapshot.
- An unrelated active call in the same account snapshot does not leak into either session.
- If account A returns 429/500, account B can still produce a useful projection.
- The watcher can move current-call state without terminal writes.

Remaining gaps to test before the watcher becomes authoritative:

- Control-plane worker scheduling at 1s while sessions are active.
- Backoff behavior after real RingCX 429s without pausing/killing sessions.
- Repository adapters for slow/legacy sessions so the same watcher is not bulk-only.
- A read-only projection route consumed by the browser instead of browser mutation-style watch calls.
- Health logs that show `accountsRead`, `activeCallCount`, `changedSessions`, `errors`, and `tickMs`.

Manual/local test order:

1. Run the watcher one-off in dry-run with two active bulk sessions under the same account.
2. Verify exactly one RingCX account read.
3. Verify each agent's current call matches only their accepted buffer candidate.
4. Inject or observe a 429 and confirm it records an account error without cancelling the session.
5. Flip apply mode locally and verify only changed sessions are written.
6. Keep browser refresh read-only; no UI action should call `activeCalls/list`.

Proof-of-concept floor follower:

- [cx-floor-active-call-shadow-follow.js](C:/code/TagContactBridgeParalell/scripts/cx-floor-active-call-shadow-follow.js)

Purpose:

- follow up to five real agents while they work in the current floor mode
- read Mongo state for each agent/session
- read RingCX active calls once per account per tick
- output an in-memory/event-log array of UII swaps
- prove whether account-level polling can track current calls without touching live behavior

Example commands:

```powershell
node scripts/cx-floor-active-call-shadow-follow.js --once --json --limit=5
node scripts/cx-floor-active-call-shadow-follow.js --durationSec=600 --intervalMs=1000 --limit=5
node scripts/cx-floor-active-call-shadow-follow.js --agents=cbolt@taxadvocategroup.com,bhansen@taxadvocategroup.com,slucas@taxadvocategroup.com --durationSec=600 --intervalMs=1000
```

Event shape:

```js
{
  type: "uii-swap",
  at,
  agent: { email, name, extensionId, cxAgentId },
  from: { uii, externId, queueItemId, caseId, name },
  to: { uii, externId, queueItemId, caseId, name },
  match: { status, reason, confidence },
  mongo: { agentState, bulkSession, slowSession }
}
```

Important boundaries:

- read-only only; no session projection writes
- no terminal/outbox/cadence writes
- no Logics lookup
- no phone-only current-call matching
- ambiguous matches are logged as ambiguous instead of guessed

Evidence we want:

- UII swaps occur within one tick of RingCX advancing.
- The same account snapshot can produce correct swaps for multiple agents.
- Active calls unrelated to an agent's queue/session do not attach to that agent.
- Current-call swaps line up with the agent's real visible CX flow.
- 429s are observable in the ledger/rate-limit state without cancelling any session.

If this proof is clean, the next implementation step is a control-plane worker that writes only the current-call projection. The browser should then read projection state, not run its own active-call mutation loop.

Proof-of-concept queue shadow:

- [cx-floor-queue-shadow-follow.js](C:/code/TagContactBridgeParalell/scripts/cx-floor-queue-shadow-follow.js)

Purpose:

- run next to the current live/legacy queue without changing it
- copy each agent's current app queue into an in-memory shadow list
- remove the current/completed call from the shadow list when Mongo reports it as current or completed
- simulate a refill when the shadow list reaches the low-water mark
- log where the real queue, current call, completion buffer, and simulated refill disagree

Example commands:

```powershell
node scripts/cx-floor-queue-shadow-follow.js --once --json
node scripts/cx-floor-queue-shadow-follow.js --durationSec=600 --intervalMs=1000 --threshold=5 --refillSize=30
node scripts/cx-floor-queue-shadow-follow.js --agents=cbolt@taxadvocategroup.com,bhansen@taxadvocategroup.com,slucas@taxadvocategroup.com --durationSec=600 --intervalMs=1000 --threshold=5 --refillSize=30
```

Event types:

```js
{
  type:
    | "shadow-initialized"
    | "actual-queue-changed"
    | "shadow-consumed-current"
    | "shadow-consumed-completion"
    | "actual-low-water"
    | "shadow-refill-simulated"
    | "shadow-refill-empty"
    | "current-not-in-shadow-queue"
    | "completion-not-in-shadow-queue",
  agent,
  actualQueueCount,
  shadowQueueCount,
  threshold,
  refillSize
}
```

Important boundaries:

- read-only only; no queue claims, no RingCX publishes, no dispositions
- no RingCX calls; this script reads Mongo only so it does not add API pressure during the active-call poll test
- no cadence writes, terminal writes, Logics writes, or DNC writes
- a simulated refill only reports which ready records would be pulled next
- the shadow queue should never be used as truth until it agrees with the app queue and current-call projection under real floor movement

Evidence we want:

- Current/completed calls disappear from the shadow queue exactly once.
- The real app queue does not unexpectedly empty or repopulate with unrelated leads.
- When the shadow count reaches five, a refill simulation finds a correctly scoped next batch.
- A missing refill is logged as `shadow-refill-empty`, not silently ignored.
- `current-not-in-shadow-queue` and `completion-not-in-shadow-queue` events are rare and explainable.
- Actual queue churn is visible as `actual-queue-changed`, giving us a place to inspect whether another process is still injecting or removing leads outside the rail.

Integrated AgentQueueState shadow:

- [cx-floor-agent-queue-state-shadow-follow.js](C:/code/TagContactBridgeParalell/scripts/cx-floor-agent-queue-state-shadow-follow.js)

Purpose:

- connect the active-call watcher and queue shadow into one in-memory `AgentQueueState`
- read RingCX active calls once per account per tick
- read Mongo queue/session/current/completion sources for the same agents
- reduce both sources into the same object: `pending`, `current`, `terminalBuffer`, `refill`, `health`
- simulate refill from that object when `pending.length <= threshold`
- prove the future worker boundaries before any writes exist

Example commands:

```powershell
node scripts/cx-floor-agent-queue-state-shadow-follow.js --once --json --agents=cbolt@taxadvocategroup.com,bhansen@taxadvocategroup.com,slucas@taxadvocategroup.com
node scripts/cx-floor-agent-queue-state-shadow-follow.js --durationSec=3600 --intervalMs=1000 --threshold=5 --refillSize=30 --targetBuffer=35 --releaseMisses=2
```

Unified state shape used by the silent test:

```js
{
  agent,
  rail: { mode: "shadow_unified", targetBuffer, refillThreshold, refillSize },
  pending: [],
  current: null,
  terminalBuffer: [],
  refill: { inFlight: false, count, lastAttemptAt, lastResult },
  health: { lastWatcherAt, lastRingcxError, lastProjectionMismatch }
}
```

Important boundaries:

- read-only only; no claims, publishes, dispositions, cadence writes, Logics writes, or terminal-outbox writes
- RingCX active-call data can set/refresh `current` only when it matches a known candidate by `externId` or UII
- agent-identity-only active calls are logged as `ringcx-owned-active-unmatched`, not treated as authoritative current leads
- existing historical terminal buffers are seeded on startup, not emitted as fresh terminal events
- refill is simulated from the same object and never sent to RingCX

Evidence we want:

- `current-set-from-ringcx` follows real RingCX movement without phone fallback.
- `current-refreshed-from-ringcx` is common during stable calls and should not churn queue state.
- `terminal-buffered` should occur only for new release/completion movement after startup.
- `refill-simulated` should happen when `pending` reaches the low-water mark and should pull the expected next ready rows.
- `ringcx-owned-active-unmatched` identifies places where RingCX sees a call but our queue object cannot tie it to a candidate.
- The same object should explain list movement, current-call movement, and refill decisions without separate shadow scripts disagreeing.

### Element 3: Rail Selector Goal

The eventual top-login selector should choose a rail policy, not a different app.

```js
{
  rail: "slow_single" | "next_call_send" | "bulk_load",
  targetBuffer,
  refillThreshold,
  publishPriority,
  publishTiming,
}
```

Universal pieces that must not change by selector:

- lead pool/reservation
- RingCX publisher
- account active-call watcher
- current-call projection
- terminal outbox
- terminal drain
- button semantics
- middle-panel identity rules

Only the RingCX handoff timing changes:

- `slow_single`: reserve/publish one lead and wait for proof.
- `next_call_send`: terminal current, publish next, wait for watcher proof before display.
- `bulk_load`: maintain accepted buffer, let watcher display whichever accepted lead RingCX is currently dialing.

### Test Discipline For Every Next Diff

Each implementation diff should name which element it touches and add or update the matching tests in the same patch.

Required proof shape:

- Arrange: seed local session/pool explicitly.
- Act: call one service command or one watcher tick.
- Assert: session state, RingCX call count, reservation writes, terminal writes, and UI-safe projection.

Do not accept a diff that:

- makes the active-call watcher refill a queue
- lets phone/Logics lookup decide current identity
- writes cadence/Logics directly from a live button path
- adds another rail-specific copy of terminal button behavior
- changes queue assignment and active-call projection in the same patch

## Testing Plan

### Unit Tests

- account watcher groups sessions by account
- one RingCX read per account
- no cross-agent projection writes
- no phone-only matching
- released active calls produce observation only
- terminal outbox dedupes repeated button/auto events
- reservation service releases rejected rows

### Local Integration

- Mickey test account with one active rail
- Sean test account with one active rail
- two agents active under same RingCX account
- verify one account call updates both sessions
- verify active UII is correct after RingCX auto-advance

### Live Shadow

- dry-run account watcher during floor calls
- compare watcher projection to current UI state
- log timing and 429s
- no writes until confidence is high

### Live Apply

- apply watcher projection only
- browser remains read-only
- no cadence/Logics side effects from watcher
- rollback by disabling worker

## Rollback Plan

Every phase must be reversible:

- account watcher worker flag off
- browser watch route still available until cutover is complete
- terminal outbox drain can pause without losing rows
- rail mode flag can return agents to legacy safe mode
- no schema migration should be required to disable the shared watcher

## Final Shape

The final system is not "three dialers." It is one dialer with three pacing policies.

```text
shared pool + reservation
shared RingCX publisher
shared account active-call watcher
shared current-call projection
shared terminal outbox
shared drain
shared UI shell

slow_single    = one-at-a-time pacing
next_call_send = one-next-call pacing
bulk_load      = buffered pacing
```

That is the version with the fewest fixable surfaces.
