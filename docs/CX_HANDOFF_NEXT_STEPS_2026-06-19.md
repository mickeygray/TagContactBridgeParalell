# CX Handoff Replacement Plan - 2026-06-19

This is the single plan.

The goal is to replace the current CX handoff mechanics, not add another patch layer around them. The replacement should promote the compact canonical state we already have, use the existing active-call matcher, and give the UI one boring lifecycle to render.

Most important correction from review:

```text
Do not gate terminal buttons on UII.
Gate terminal buttons on owned active telephony state.
Use UII for clean routing, finalization, logs, and post-call work.
```

UII capture can lag. That is a real RingCX observation delay, not a failure by itself. The app must not strand an agent on a live call with no terminal buttons while it waits for UII.

## Current Posture

Live is currently conservative:

- disposition buttons work from ownership/permission, not direct UII availability;
- strict RingCX active-call confirmation protects against optimistic lead drift;
- `agentstates.cxCall` already exists as a compact canonical shadow;
- existing shadow-gate logging already compares canonical state against legacy state;
- handoff is still split across too many partial sources of truth.

Current problem class:

```text
terminal click / disposition response / nextDial response / auto-serve / queue restore / currentCall polling
all try to influence the same center card and button state.
```

That creates flicker, missing buttons, slow handoff, and occasional lead-state disagreement.

## Parallel Simple Loop Test Lane

This is the proposed clean-room test lane for local Mickey-only validation before more patches are added to the live flow.

Reason:

```text
The existing handoff loop has too much history braided into it:
strict confirmation, optimistic nextDial, queue claiming, UI staging,
canonical shadow, RingCX capture, EX-era guards, auto-serve, and cleanup
all influence the same visual call card.
```

The next experiment should not try to make old deterministic plumbing imitate the final design. It should build a small parallel loop that uses the desired final shape from the start.

### Test-Lane Rule

```text
The UI never decides truth.
RingCX owned active-call evidence decides currentCall.
The UI asks for transitions and renders the single object.
```

### Test Object

Use one per-agent session object:

```ts
type CxSimpleLoopSession = {
  sessionId: string;
  agentEmail: string;
  agentExtensionId: string;
  cxAgentId: string | null;
  status: "idle" | "running" | "paused" | "failed" | "killed";

  localQueue: CxSimpleQueuedLead[];

  current: null | {
    queueItemId: string;
    caseId: string | number | null;
    phoneLast4: string | null;
    phoneHash?: string | null;
    campaignId: string | null;
    dialGroupId: string | null;
    externId: string;
    uii: string | null;
    phase: "publishing" | "confirming" | "active" | "releasing" | "failed";
    outcome: null | string;
    timestamps: {
      publishStartedAt?: string;
      publishAcceptedAt?: string;
      captureStartedAt?: string;
      activeConfirmedAt?: string;
      releaseRequestedAt?: string;
      dispositionAcceptedAt?: string;
      failedAt?: string;
    };
  };

  completed: Array<{
    queueItemId: string;
    caseId: string | number | null;
    externId: string;
    uii: string | null;
    outcome: string;
    dispositionAcceptedAt: string | null;
    gradeQueuedAt?: string | null;
  }>;

  lastError: null | {
    code: string;
    message: string;
    at: string;
    queueItemId?: string | null;
  };
};
```

### Local Test Flow

```text
1. Build a local queue for one test agent.
2. Start a simple loop session.
3. Publish exactly one lead to RingCX.
4. Do not render that lead as active until active-call evidence confirms it.
5. If RingCX active-call evidence appears:
     set current.phase = active
     attach UII when available
     render the active lead and terminal buttons
6. On terminal button click:
     disable buttons
     clear the middle card into releasing/loading
     send disposition for the current call
     move current into completed
     begin publishing the next queued lead
7. Repeat until queue is empty or killed.
```

The important difference from the old path:

```text
publish accepted != active call
disposition accepted != next active call
queue row selected != current call
```

### Routes For The Test Lane

Keep this separate from the existing CX workspace routes while testing:

```text
POST /api/cx-simple/session/start
GET  /api/cx-simple/session
POST /api/cx-simple/current/disposition
POST /api/cx-simple/current/skip
POST /api/cx-simple/session/kill
```

The route layer should be thin. The service owns the state transition.

### Service Boundary

Add a new service rather than editing the old loop first:

```text
packages/shared-services/src/cxSimpleCallLoopService.js
```

Responsibilities:

- create one session for one agent;
- load the local test queue;
- publish one lead at a time;
- capture/observe RingCX active-call evidence;
- own the `current` object;
- record completed outcomes;
- expose a compact debug snapshot;
- provide a hard kill path that cancels pending RingCX leads and clears local session state.

Non-responsibilities:

- no normal production queue assignment rewrite;
- no EX polling;
- no old auto-serve restore;
- no UI-selected lead as source of truth;
- no parallel matcher with different rules.

### Capture Failure Handling

For this test lane, failure should be explicit and boring:

```text
publish accepted
  -> capture scoped by externId / agent / account
  -> if no active call appears inside the test window:
       mark current.phase = failed
       cancel the published RingCX lead when possible
       pause the session after N consecutive misses
       do not advance endlessly through the queue
```

Default breaker for the test:

```text
3 active-call-not-found misses in 5 minutes
  -> session.status = paused
  -> surface "RingCX accepted leads but no active call appeared for this agent"
```

This prevents the Brad-style failure lane from burning 30+ leads while still preserving exact evidence.

### Diagnostics Required

Every publish/capture miss should log the three scoped reads separately:

```text
cx.simple.capture.external_id
cx.simple.capture.agent
cx.simple.capture.account
```

Required fields:

```json
{
  "sessionId": "abc",
  "agentExtensionId": "63914587004",
  "cxAgentId": "21812",
  "queueItemId": "mongo-id",
  "caseId": 129299,
  "campaignId": "2457",
  "dialGroupId": "1067",
  "externId": "parallel:WYNN:129299:...",
  "scope": "EXTERNAL_ID | AGENT | ACCOUNT",
  "callCount": 0,
  "sampleKeys": [],
  "matched": false,
  "reason": "active-call-not-found"
}
```

Also read back the RingCX lead by `externId` after publish when practical:

```text
cx.simple.ringcx_lead_state
```

The goal is to distinguish:

```text
RingCX accepted but never dialed
vs
RingCX dialed but activeCalls/list does not expose the externalId
vs
RingCX exposes the call late
vs
our matcher is looking in the wrong scope
```

### Test UI

Build the smallest possible test panel:

```text
session status
local queue count and first few candidates
current phase / case / phone last4 / UII
last publish result
last capture result
completed count
last error

buttons:
start
disposition/no-answer test
skip/fail current
kill session
```

The production CX workspace should not be reshaped around this until the local lane proves the lifecycle.

### Success Criteria

The test lane is useful if it can answer these questions with logs:

1. Does RingCX create active calls for the exact lead we published?
2. Does active-call evidence arrive before or after the current strict timeout?
3. Does `externalId` appear on active calls consistently?
4. Does agent-scoped active call lookup show calls that account/external lookup misses?
5. Can the UI stay empty/loading between calls without flicker?
6. Can terminal outcomes always move the call into `completed` exactly once?
7. Can a bad agent lane pause instead of draining a queue through repeated failed publishes?

### How This Relates To The Existing Bucket Plan

The existing bucket-shadow plan remains the live migration path.

The simple loop is a proof harness:

```text
If the simple loop works:
  use its object shape and state transitions to simplify the live bucket mediator.

If the simple loop fails:
  the failure should isolate RingCX publish/capture behavior without legacy UI noise.
```

Do not merge the simple loop by copying all of its routes into production. Merge the proven concepts:

- one current object;
- active-call evidence creates current;
- terminal click drains current;
- completed buffer records outcome;
- failed capture pauses the agent lane;
- UI renders release/loading while waiting.

### Final Build Shape For The First Coding Pass

This is the version to build first.

Do not extend the existing workspace handoff path for this pass. Do not make `cxDialQueueMediatorService` bigger yet. Build a separate proof harness that can be thrown away or folded back in cleanly.

Important local-test intent:

```text
This runs beside the current queue system, but local can route one allowed
agent through this loop instead of the current queue UI/handoff loop.
```

For the first real test, that means:

```text
agent = mgray only
environment = local only
current queue remains available as fallback
simple loop can take over the visible CX call lane for Mickey
normal production agents remain on the existing queue flow
```

This is the clean "unplug the current queue for me only" switch. It lets us test a simpler object and RingCX handoff path on a real workstation without risking the floor.

#### 1. Storage

Use a new Mongo collection for the test lane:

```text
cxsimpleloopsessions
```

Reason:

```text
agentstates.cxCall and agentstates.cxCallBuckets are already live-shadow fields.
The simple loop must not pollute or fight them while we are proving the shape.
```

Suggested minimal model:

```text
packages/shared-models/src/CxSimpleLoopSession.js
```

Indexes:

```js
{ sessionId: 1 } unique
{ agentExtensionId: 1, status: 1, updatedAt: -1 }
{ createdAt: 1 } // optional TTL later, not required for first test
```

Keep it Mixed-heavy for the first pass. This is a test harness, not a permanent schema commitment.

#### 2. Service

Add:

```text
packages/shared-services/src/cxSimpleCallLoopService.js
```

The service owns the full state transition. The route layer should call service functions only.

Required public functions:

```js
startCxSimpleLoopSession(input, options)
getCxSimpleLoopSession(input, options)
advanceCxSimpleLoopSession(input, options)
submitCxSimpleLoopDisposition(input, options)
skipCxSimpleLoopCurrent(input, options)
killCxSimpleLoopSession(input, options)
```

The core reducer should be pure and unit-testable:

```js
reduceCxSimpleLoopSession(previousSession, event, now)
```

Side effects belong outside the reducer:

- Mongo writes;
- RingCX lead publish;
- RingCX active-call capture;
- RingCX disposition/cancel/hangup;
- logging.

#### 3. Capture Helper

Do not duplicate active-call matching logic in the simple loop.

Extract or expose a shared helper from the existing RingCX capture path:

```text
packages/shared-services/src/ringcxActiveCallCaptureService.js
```

Suggested exports:

```js
waitForRingcxCampaignCall(client, criteria, options)
captureRingcxActiveCallForPublishedLead(input, options)
diagnoseRingcxActiveCallCaptureMiss(input, options)
```

The helper should preserve the current scoped reads:

```text
externalId first
agent scoped read when cxAgentId exists
account scoped read
```

The simple loop may call this helper directly. The existing `ringcxDialExecutionService` can later call the same helper, but that refactor is optional in the first pass if it risks changing live behavior.

#### 4. Queue Input

For the first local test, do not build a new queue generator.

Use existing queue rows as input:

```text
CxDialQueue rows assigned/visible to the test agent
```

The start route accepts:

```json
{
  "agentEmail": "mgray@taxadvocategroup.com",
  "limit": 5,
  "campaignIdOverride": null,
  "dialGroupIdOverride": null,
  "apply": true
}
```

The service snapshots the queue into `session.localQueue` once at start. After that, the session owns its own list. Do not keep re-reading/sorting the production queue during the test loop.

Each queued item gets a stable `loopOrder`:

```js
localQueue: [
  { loopOrder: 0, queueItemId, caseId, phoneLast4, phoneHash, campaignId, dialGroupId, externId, status: "pending" }
]
```

This is important because the local bulk-publish test showed RingCX/UI ordering can be ambiguous without an explicit order field.

#### 4a. Local Replacement Harness Switch

Add a local-only switch that lets the CX workspace read/render from the simple-loop session for one allowed agent:

```text
CX_SIMPLE_LOOP_REPLACE_WORKSPACE_FOR_ALLOWED_AGENT=false
```

When enabled and the logged-in agent is allowed:

```text
hide/disable legacy servedQueue as active truth
hide/disable legacy nextDial active staging
render simpleLoop.current as the center card
render simpleLoop.localQueue as the visible queue snapshot
send terminal buttons to simple-loop routes
keep a kill/fallback control visible in the debug panel
```

Do not globally disable the old queue services. The replacement switch is a read/render/action fork for the allowed local agent only.

Fallback rule:

```text
if simple loop is killed or disabled:
  reload workspace
  return that agent to the normal local CX queue flow
```

#### 4b. Bulk Publish / Queue Mirror Test Mode

The simple loop should support two publish modes:

```text
mode=single
  publish one lead, wait for active-call evidence, then repeat after terminal outcome

mode=bulk-mirror
  publish the session queue/window into RingCX up front
  let RingCX create the next active call
  simple loop watches activeCalls/list and promotes only observed active calls
```

Default first build can be `single`, but the shape must not block `bulk-mirror`; the whole point of the next test is to see if bulk posting plus a simple state object feels cleaner.

Bulk-mirror constraints:

- local/Mickey only;
- maximum queue/window comes from `CX_SIMPLE_LOOP_MAX_QUEUE`;
- every candidate gets `sessionId` and `loopOrder`;
- before bulk publish, provide a drain/cancel helper for stale RingCX test leads in the target campaign;
- after publish, do not assume RingCX visible order from local sort;
- record RingCX `leadId` / accepted payload on each candidate when available;
- current call is still created only from active-call evidence, not from bulk publish acceptance.

Bulk-mirror state additions:

```js
localQueue: [
  {
    loopOrder: 0,
    ringcxLeadId: null,
    ringcxPublishedAt: null,
    ringcxPublishStatus: "pending" | "accepted" | "failed" | "cancelled",
    status: "pending" | "mirrored" | "active" | "completed" | "failed" | "cancelled"
  }
]
```

Bulk-mirror success criteria:

```text
RingCX dials the same people we expect.
The UI stays blank/releasing until active-call evidence appears.
The active call maps back to exactly one localQueue candidate.
Terminal outcome moves that candidate to completed exactly once.
No disappeared/reappeared queue item becomes the active card by client guesswork.
```

#### 5. Publish/Capture/Advance Contract

The only function that starts the next call is:

```js
advanceCxSimpleLoopSession(...)
```

It does exactly one candidate at a time.

Sequence:

```text
advance
  -> select first localQueue item with status=pending
  -> set current.phase=publishing
  -> publish that one lead to RingCX
  -> if publish rejected:
       current.phase=failed
       candidate.status=failed
       session.status=paused if repeated
  -> if publish accepted:
       current.phase=confirming
       run active-call capture
  -> if capture finds owned active call:
       current.phase=active
       current.uii = captured UII if present
       candidate.status=active
  -> if capture misses:
       current.phase=failed
       candidate.status=failed
       cancel published RingCX lead when possible
       increment captureMiss streak
       pause after threshold
```

Hard rule:

```text
advance must not recursively drain the whole queue.
One call to advance may publish at most one lead.
```

This makes the test safe and makes each failure readable.

In `bulk-mirror` mode, `advance` changes meaning:

```text
advance/watch
  -> do not publish another lead if the queue/window is already mirrored
  -> poll/read activeCalls/list for this agent/session candidates
  -> match observed active call to localQueue by UII/externalId/phone+agent+campaign only through shared matcher
  -> promote matched candidate to current
  -> leave all other candidates in mirrored/pending
```

Hard rule for both modes:

```text
published/mirrored candidate != current call
only observed owned active-call evidence == current call
```

#### 6. Terminal/Disposition Contract

`submitCxSimpleLoopDisposition` is the only function that resolves the current call.

Sequence:

```text
terminal button
  -> set current.phase=releasing
  -> write UI-readable release state immediately
  -> submit RingCX disposition if UII exists
  -> if UII is missing, record pending finalization and do not pretend disposition succeeded
  -> move current into completed with outcome exactly once
  -> clear current
  -> call advance once, unless autoAdvance=false
```

For first test:

```text
autoAdvance=true by default
```

But it must still be one next publish only.

In `bulk-mirror` mode:

```text
terminal button
  -> drain current into completed
  -> submit RingCX disposition when possible
  -> clear current / show release state
  -> resume watch for the next RingCX active call
  -> do not call old nextDial
```

This is the test that most closely matches the desired final model:

```text
RingCX owns queued dialing inventory.
Parallel owns current-call truth, UI state, outcomes, metrics, and cleanup.
```

#### 7. Bad Lane Breaker

Required from day one.

```text
3 capture misses in 5 minutes for the session
  -> session.status=paused
  -> no further publish attempts
```

Surface this clearly in the test UI/debug response:

```text
RingCX accepted leads but no active call appeared for this agent.
Check agent login, availability, phone route, and campaign/dial group.
```

This is the direct protection against the Brad-style failure loop observed on live.

#### 8. Routes

Wire through control-plane routes, but keep them isolated and flag-gated.

Suggested commands:

```text
POST /api/cx/simple-loop/start
POST /api/cx/simple-loop/advance
POST /api/cx/simple-loop/disposition
POST /api/cx/simple-loop/skip
POST /api/cx/simple-loop/kill
```

Suggested read:

```text
GET /api/cx/simple-loop/session?agentEmail=...
```

Flags:

```text
CX_SIMPLE_LOOP_ENABLED=false
CX_SIMPLE_LOOP_ALLOWED_EMAILS=mgray@taxadvocategroup.com
CX_SIMPLE_LOOP_MAX_QUEUE=5
CX_SIMPLE_LOOP_REPLACE_WORKSPACE_FOR_ALLOWED_AGENT=false
CX_SIMPLE_LOOP_MODE=single
```

The route must reject non-allowed agents even on local unless explicitly configured.

#### 9. Test UI

Do not modify the main production CX center card yet.

For local testing, add either:

```text
/cx/simple-loop
```

or a clearly labeled debug panel behind:

```text
?cxSimpleLoop=1
```

The panel renders only the simple-loop session object:

- queue snapshot;
- current phase;
- UII present/missing;
- last publish result;
- last capture diagnostics;
- completed buffer;
- paused/breaker reason.

Do not let this panel read legacy `servedQueue`, selected queue row, or `agentstates.currentCall` as truth.

When `CX_SIMPLE_LOOP_REPLACE_WORKSPACE_FOR_ALLOWED_AGENT=true`, the regular CX middle lane for the allowed agent should be driven by the same simple-loop session object. The debug panel can sit beside it, but the agent-facing state must be the object, not legacy queue state.

#### 10. Logging

Required event names:

```text
cx.simple.session_started
cx.simple.advance_started
cx.simple.publish_started
cx.simple.publish_accepted
cx.simple.publish_rejected
cx.simple.capture_scope
cx.simple.capture_found
cx.simple.capture_missed
cx.simple.breaker_paused
cx.simple.release_started
cx.simple.disposition_submitted
cx.simple.completed_buffered
cx.simple.killed
```

Each log must include:

```text
sessionId
agentExtensionId
agentEmail
cxAgentId
queueItemId
caseId
campaignId
dialGroupId
externId
currentPhase
loopOrder
```

Do not log raw full phone numbers.

#### 11. Unit Tests For This Pass

Add:

```text
tests/cx-simple-loop/cxSimpleCallLoopService.test.js
```

Required tests:

- start snapshots queue with stable `loopOrder`;
- `advance` publishes at most one pending candidate;
- replacement mode does not stage legacy servedQueue as active truth;
- publish accepted alone moves to `confirming`, not active;
- capture found moves to `active`;
- capture miss marks current/candidate failed and does not continue to next candidate automatically after breaker threshold;
- three misses in five minutes pauses session;
- terminal disposition moves current to completed exactly once;
- terminal disposition clears current before auto-advance;
- auto-advance after terminal publishes only one next lead;
- bulk-mirror publish marks candidates mirrored/accepted but does not create current;
- bulk-mirror active observation promotes exactly one matched candidate;
- bulk-mirror terminal disposition clears current and resumes watching without calling old nextDial;
- kill clears current and marks pending candidates cancelled/killed.

Mock RingCX publish/capture/disposition. No network calls in unit tests.

#### 12. What Codex Should Not Build Yet

Do not:

- mirror the full queue into RingCX;
- replace the production CX workspace handoff;
- make `cxCallBuckets` authoritative;
- relax strict mode globally;
- add weak phone matching;
- let the simple loop retry indefinitely;
- let route handlers directly mutate session shape.

The first proof is deliberately narrow:

```text
one agent
one session
one queue snapshot
one current call
one publish at a time
one completed buffer
clear pause on repeated capture miss
```

## 2026-06-19 Shadow Loop Readout

Read source:

- live/local `agentstates.cxCall`;
- live/local `agentstates.cxCallBuckets`;
- local bulk handoff test that published a short Mickey-owned queue into RingCX;
- observed UI/RingCX ordering disagreement during that test.

What worked:

- bucket priming is happening, and active agents had populated `newCalls`;
- active promotion works when the existing matcher finds a strong identity, especially UII or high-confidence `externId` scan;
- no-UII publishing shells are getting expiry timestamps, which is the right short-lived shape;
- `completionBuffer` exists and can preserve outcomes once a terminal writer actually reaches the mediator;
- the shadow loop is useful as evidence because it exposes disagreements between legacy state, compact `cxCall`, and the bucket object.

What is not ready to drive behavior:

- `agentstates.cxCallBuckets.currentCall` can outlive legacy idle/released state. Sean and Mickey both showed stale bucket `currentCall` values after the legacy/current state had already moved on.
- `agentstates.cxCall.phase` can remain `dispositioning` with a UII and no expiry. The no-UII shell cleanup does not solve UII-bearing stale dispositioning.
- `newCalls` is currently a candidate cache sorted by most recent `seenAt`, not an ordered RingCX handoff queue. It should not drive UI order or RingCX publish order without a separate handoff snapshot.
- `completionBuffer` only fills when terminal code calls `observeCxBucketTerminalOutcome`. Manual clear, queue cancellation, legacy release, or local recovery can bypass that and leave `currentCall` looking active.
- a local bulk publish showed that the queue order the UI implies and the order RingCX receives can diverge. That needs explicit `handoffBatchId` and `handoffOrder`, not another inferred sort.

Current stale shape to target:

```text
agentstates.cxCallBuckets.currentCall
  says active/confirming with old UII

agentstates.cxCall
  may say dispositioning with same old UII

legacy currentCall/activityState
  already says idle/released or has moved on
```

That shape should be treated as a failed terminal bridge, not as a normal active-call state.

Speculative places to look next:

1. `packages/shared-services/src/cxWorkspaceService.js`
   - Audit every terminal button, clear, cancel, release, queue-reset, and local recovery path.
   - Anything that ends or discards the visible call should call the bucket terminal bridge or an explicit bucket orphan/clear helper.
2. `packages/shared-services/src/ringcxAgentMonitorService.js`
   - Add a reconciliation pass after active calls are observed.
   - If the bucket `currentCall` UII is no longer in owned active calls and legacy state is idle/released, emit a stale-current transition and clear or buffer it.
3. `packages/shared-services/src/cxDialQueueMediatorService.js`
   - Centralize the stale-current reducer instead of letting each caller hand-edit bucket state.
   - Add a UII-bearing dispositioning TTL or orphan rule, separate from no-UII shell expiry.
4. `apps/control-plane/src/routes/readCx.js`
   - Expose a compact disagreement view: legacy phase, `cxCall` phase, bucket current phase, UII, queue item, age, and suspected stale reason.
5. Future queue mirror / publish path
   - Do not reuse `newCalls` sort as handoff order.
   - Create a handoff snapshot with stable `handoffBatchId`, `handoffOrder`, and the exact payload accepted by RingCX.

Would gutting older plumbing help?

Yes, but only after the replacement owns the same safety boundaries. The old plumbing is not just bulky; it is structurally mismatched to the desired shape. Multiple systems are still allowed to declare what the center card is: selected queue row, served queue row, nextDial response, legacy `currentCall`, compact `cxCall`, bucket `currentCall`, and client restore logic. That is why small timing changes create large UI effects.

The replacement should not be "delete the old code and hope." It should be:

```text
one object owns the lifecycle
old fields become projections
old callers become observation writers
UI renders one projection
terminal outcomes always drain the same current call
```

The high-value deletion target is the independent handoff plumbing around auto-serve, nextDial-as-current-truth, local selected-lead restoration, and direct `agentstates.currentCall` mutation. Keep RingCX active-call observation, disposition submit, DNC/cadence protections, and strict one-off confirmation. Remove only the pieces that compete to stage or restore the visible call.

## Next Live Read Plan

Purpose:

```text
decide whether the new bucket shape is failing at active-call matching,
terminal cleanup, or ordered handoff projection.
```

Do not use the next read to decide whether the UI should switch yet. Use it to classify the failure mode.

For each active dialing agent, capture one compact row:

```text
agent
legacy activityState / activePlatform
legacy currentCall UII / queueItemId / caseId
cxCall phase / UII / queueItemId / age / expiresAt
bucket currentCall phase / UII / queueItemId / caseId / matchedBy / confidence / age
bucket newCalls count
bucket completionBuffer count and newest outcome
latest queue_handoff timing event
latest cx.bucket.* event
latest cx-call-lifecycle.transition event
```

Sort each agent into exactly one read bucket:

1. Healthy handoff.
   - active RingCX call becomes bucket `currentCall`;
   - terminal click moves it to `completionBuffer`;
   - `currentCall` clears;
   - next active observation creates the next call.
2. Stale terminal bridge.
   - legacy is idle/released or has moved on;
   - bucket `currentCall` still says active/confirming;
   - compact `cxCall` may be stuck in `dispositioning`;
   - this points at terminal writers missing the bucket bridge.
3. Missing active match.
   - RingCX has an owned active call;
   - bucket has candidates in `newCalls`;
   - no bucket `currentCall` appears, or it logs match miss/ambiguity;
   - this points at active-call matcher/scorer input.
4. Handoff order mismatch.
   - same leads exist in local queue and RingCX;
   - first RingCX lead does not match the UI's expected next lead;
   - this points at missing explicit `handoffBatchId` / `handoffOrder`.
5. Queue/client projection noise.
   - backend bucket and compact `cxCall` are correct;
   - UI still flickers, restores, or shows the wrong selected card;
   - this points at legacy client restore/selection code, not RingCX.

Most likely speculative place to look from the first read:

```text
terminal bridge and stale-current reconciliation, not active matching.
```

Reason:

- active matching already succeeded for multiple agents with UII/high-confidence matches;
- stale examples had specific old UIIs and matched candidates, which means they made it into `currentCall`;
- the failure shape appeared after the call should have been terminal or idle;
- therefore the missing edge is likely "this call ended, drain exactly this bucket current call" rather than "we cannot find the call."

Concrete next inspection targets:

- `cxWorkspaceService` paths that submit disposition, clear served state, cancel local queue rows, or recover from client handoff errors;
- `ringcxAgentMonitorService` paths that observe an owned active call disappearing from `activeCalls/list`;
- `cxDialQueueMediatorService` paths that should expose one canonical helper for `clearCurrentCallAsTerminal`, `clearCurrentCallAsOrphan`, and `promoteCandidateToCurrent`;
- the debug read route should make stale-current age obvious enough that one glance says "terminal bridge missed."

Recommended next live-read decision:

```text
If more than one agent lands in stale terminal bridge:
  build the terminal/orphan clear helper first.

If more than one agent lands in missing active match:
  instrument matcher inputs before touching UI.

If order mismatch repeats:
  add handoffBatchId/handoffOrder before any queue mirror test.

If backend is clean but UI flickers:
  strip client restore/selection paths behind the release/loading state.
```

## Final Architecture

Use one per-agent lifecycle model:

```text
newCalls[]          planned or known queue candidates, no UII required
currentCall         one owned active RingCX call; may be confirming until UII is captured
completionBuffer[]  completed calls with terminal outcome and post-call work
```

Final source-of-truth rule:

```text
Only RingCX active-call observation or equivalent owned telephony presence can create currentCall.
```

UII upgrades a call from `confirming` to fully identified `active`. It must not be required for the agent to press a terminal button.

These must not create an active `currentCall` by themselves:

- queue upload/lead-loader acceptance;
- disposition response;
- nextDial response;
- selected lead/form state;
- auto-serve timer;
- client-side queue click;
- queue metadata alone.

## Core Invariants

- Queue acceptance means a candidate exists. It does not mean a call exists.
- Owned active telephony creates `currentCall` in `confirming` when UII is not known yet.
- Captured UII upgrades `currentCall` to `active`.
- Terminal buttons require owned active telephony state plus permission, not UII.
- Terminal click immediately clears the visible middle panel or moves it into a release/loading state.
- Terminal click moves the call into `completionBuffer`, even if UII finalization is still pending.
- UII is required for clean post-call routing/finalization when available, not for allowing disposition.
- `currentCall` may lag in `confirming`. It cannot fork, be inferred from non-call responses, or be created from queue metadata alone.
- Existing `agentstates.cxCall` is the compatibility projection to promote, not a parallel object to reinvent.
- Existing `agentstates.currentCall`, `activityState`, and `activePlatform` become temporary compatibility projections.

## Existing Pieces To Reuse

Do not build a second matcher or second canonical-call object.

Reuse and wrap:

- `agentstates.cxCall` as the compact canonical projection;
- existing `CX_CANONICAL_CALL_*` flags and shadow-gate logging;
- existing no-UII TTL/shell cleanup semantics;
- active-call matching/scoring already present in the RingCX services;
- active-call capture metadata, especially `metadata.lastDialExecutionUii`.

The genuinely new pieces are:

- `newCalls[]`, a candidate bucket derived from existing queue rows and dial requests;
- `completionBuffer[]`, a post-call work buffer for outcomes, metrics, coach summaries, and finalization;
- a mediator that owns the bucket lifecycle and projects into `agentstates.cxCall`;
- a re-scoped UI button gate that keys on owned active telephony instead of UII.

## Data Model

Initial storage can be `agentstates.cxCallBuckets`. If the completion buffer needs durable retries or grows too large, move completion work to a dedicated collection.

```ts
type CxCallCandidate = {
  queueItemId: string;
  externalId: string | null;
  domain: string | null;
  caseId: string | number | null;
  phoneLast4: string | null;
  phoneHash?: string | null;
  normalizedPhone?: string | null; // memory-only matching; do not log raw phone
  displayName?: string | null;
  campaignId?: string | null;
  dialGroupId?: string | null;
  agentExtensionId: string;
  actionKey?: string | null;
  source: "workspace-queue" | "served-queue" | "dial-request" | "ringcx-mirror";
  seenAt: string;
};

type CxCurrentCall = CxCallCandidate & {
  phase: "confirming" | "active";
  telephonyActive: true;
  uii: string | null;
  activeObservedAt: string;
  matchedBy: "uii" | "externId-scan" | "phone-agent-campaign" | "telephony-presence";
  confidence: "high" | "medium" | "low";
  outcome: null;
};

type CxCompletedCall = CxCallCandidate & {
  phase: "completed";
  uii: string | null;
  uiiFinalizationStatus: "pending" | "captured" | "not-needed" | "failed";
  outcome: string;
  buttonClickedAt: string;
  dispositionAcceptedAt?: string | null;
  postCallStatus: "pending" | "done" | "failed";
  handoffId: string;
};

type CxCallBuckets = {
  agentExtensionId: string;
  newCalls: CxCallCandidate[];
  currentCall: CxCurrentCall | null;
  completionBuffer: CxCompletedCall[];
  stats: {
    activeMatches: number;
    misses: number;
    ambiguous: number;
    weakMatchesRejected: number;
    legacyAgreements: number;
    legacyDisagreements: number;
  };
  updatedAt: string;
};
```

## Matching Rule

The matcher order must follow what the system can actually observe.

Use the existing scorer/matcher patterns from:

- `packages/shared-services/src/ringcxDialExecutionService.js`;
- `packages/shared-services/src/ringcxAgentMonitorService.js`.

Do not reimplement a separate matcher that can drift.

Promotion order:

1. UII-to-UII match.
   - Prefer captured UII stored at dial time, especially `metadata.lastDialExecutionUii`.
   - This is the reliable anchor.
2. `externId` if RingCX echoes it.
   - Accept only through the existing recursive scan/scorer path.
   - Treat this as high confidence only when unambiguous.
3. phone + agent + campaign/dial group.
   - This is weak and must remain gated.
   - It must never promote on ties.
   - It must never promote from phone alone.
   - Keep `RINGCX_ACTIVE_CALL_ALLOW_WEAK_MATCH=false` unless intentionally testing.
4. otherwise log miss or ambiguity and do not promote.

Do not list `queueItemId` or `ringcxLeadId` as direct active-call keys unless code proves RingCX exposes them on active-call payloads. Today they are candidate metadata, not active-call identifiers.

## Phase 1: Bucket Shadow On Live

Purpose: run the replacement lifecycle silently beside the current flow.

No UI behavior change.

No full queue upload.

No change to which lead RingCX dials.

### Step 1: Prime `newCalls`

Sources already available:

- workspace queue rows;
- serving/claimed queue rows;
- existing one-lead publish/dial path.

Action:

```text
queue row seen -> upsert cxCallBuckets.newCalls
```

Log:

```text
cx.bucket.queue_primed
```

### Step 2: Observe Active Calls

Sources already available:

- `ringcxAgentMonitorService` account `activeCalls/list`;
- `ringcxDialExecutionService` active-call capture after publish;
- existing canonical `cxCall` transition writes.

Action:

```text
active RingCX call or owned telephony-active state observed
  -> feed existing match result/scorer into mediator
  -> set bucket currentCall as confirming if UII is absent
  -> set bucket currentCall as active if UII is captured
  -> compare bucket against agentstates.cxCall and legacy currentCall
```

Logs:

```text
cx.bucket.active_match
cx.bucket.active_confirming
cx.bucket.active_match_miss
cx.bucket.active_match_ambiguous
cx.bucket.shadow_compare
```

### Step 3: Observe Terminal Outcomes

Source:

- existing disposition endpoint / terminal button payload.

Action:

```text
terminal outcome observed
  -> append/update cxCallBuckets.completionBuffer
  -> preserve current live behavior
```

If UII is absent at click time:

```text
completionBuffer.uiiFinalizationStatus = "pending"
```

Logs:

```text
cx.bucket.terminal_observed
cx.bucket.completion_buffered
cx.bucket.uii_finalization_pending
```

### Phase 1 Files

Add:

`packages/shared-services/src/cxDialQueueMediatorService.js`

Responsibilities:

- hold/update bounded per-agent bucket state;
- normalize candidate identity;
- consume existing active-call match results;
- record terminal outcomes;
- emit bucket logs;
- expose debug snapshots;
- no RingCX API calls.

Extend:

`packages/shared-services/src/cxCallLifecycleService.js`

Only small helpers if needed:

- `projectCxCallFromBuckets(...)`;
- `describeCxBucketGate(...)`;
- `buildCxBucketTransitionLogPayload(...)`;
- shared no-UII expiry helper reuse.

Wire:

`packages/shared-services/src/cxWorkspaceService.js`

- prime `newCalls` from queue/workspace rows;
- observe terminal outcomes;
- add bucket comparison fields to existing `cx.lifecycle.shadow_gate`;
- no behavior change.

`packages/shared-services/src/ringcxAgentMonitorService.js`

- feed existing `activeCalls/list` results and existing match decisions into mediator;
- compare bucket prediction to existing mark-active logic;
- no legacy behavior change.

`packages/shared-services/src/ringcxDialExecutionService.js`

- feed publish/capture results and captured UII metadata into mediator;
- no publish/capture behavior change.

Optional:

`apps/control-plane/src/routes/readCx.js`

- expose bucket shadow only behind debug/admin flag.

### Phase 1 Flags

Keep existing canonical flags:

```text
CX_CANONICAL_CALL_WRITE_ENABLED=true
CX_CANONICAL_CALL_READ_ENABLED=true
CX_CANONICAL_CALL_STRICT_GATE=false
CX_CANONICAL_CALL_VERBOSE_LOGS=true
```

Add:

```text
CX_BUCKET_SHADOW_ENABLED=true
CX_BUCKET_SHADOW_RENDER_ENABLED=false
CX_BUCKET_SHADOW_DEBUG_READ_ENABLED=false
CX_BUCKET_SHADOW_PROJECT_CXCALL=false
```

### Phase 1 Success Criteria

Before moving on:

- `newCalls` is populated for every active dialing agent;
- every active RingCX call either matches one candidate or logs a clear miss;
- confirming calls are visible in logs instead of treated as failed calls;
- bucket active match agrees with legacy current call most of the time;
- bucket active match agrees with compact `cxCall` when `cxCall` has UII;
- terminal button presses are observed with outcome even if UII is still pending;
- no ambiguous phone fallback during ordinary outbound calls;
- no new user-visible behavior changes.

## Phase 2: Bucket Projects Compact `cxCall`

Enable:

```text
CX_BUCKET_SHADOW_PROJECT_CXCALL=true
```

Behavior:

- the bucket mediator becomes the planned owner/projector for CX-path `agentstates.cxCall`;
- high-confidence bucket `currentCall` projects into `agentstates.cxCall`;
- confirming no-UII state projects with TTL/expiry;
- existing UI still renders as today;
- existing `cx-call-lifecycle.transition` logs continue;
- disagreements become important.

Important ownership rule:

```text
Do not let cxCadenceService, ringcxAgentMonitorService, clear paths, and bucket projection all fight over cxCall.
```

During Phase 2, old writers may still feed observations, but projection ownership must be explicit. The end state is one owner for `cxCall` writes on the CX path.

Purpose:

```text
prove bucket can replace the current compact canonical shadow before it drives the UI
```

Success criteria:

- projected `cxCall` does not fight existing writers;
- no-UII shell cleanup still works;
- `cx.lifecycle.shadow_gate` remains understandable;
- no increase in stuck dispositioning or false blocks.

## Phase 3: UI Reads Bucket `currentCall`

Behavior:

- center panel renders from bucket/current `cxCall` projection;
- terminal buttons key on owned active telephony plus permission, not UII;
- legacy `currentCall` becomes compatibility projection;
- middle panel clears or enters release/loading immediately on terminal click;
- UII finalization continues in the background if needed.

Button rule:

```ts
const canUseTerminalButtons =
  Boolean(cxBuckets.currentCall?.telephonyActive) &&
  cxBuckets.currentCall.outcome == null &&
  hasDispositionPermission &&
  !releaseInFlight;
```

Confirming interstitial:

```text
If currentCall.phase === "confirming":
  show "Confirming call identity..."
  keep terminal controls available if telephony ownership is solid
  mark post-call UII finalization as pending if the agent dispositions before UII arrives
```

Terminal click flow:

```text
agent clicks terminal button
  -> currentCall moves to completionBuffer
  -> UI clears middle panel / shows release animation
  -> submit RingCX disposition or hangup for the completed call
  -> if UII exists, attach it immediately
  -> if UII is missing, keep uiiFinalizationStatus=pending
  -> post-call workers process metrics/coach/summary when identity is sufficient
  -> next active RingCX observation creates the next currentCall
```

Important:

```text
Disposition response does not render next call.
Queue row does not render next call.
UII capture does not control whether the agent can disposition a live call.
Owned active telephony controls terminal availability.
```

Success criteria:

- terminal buttons stay available on owned active calls even while UII is confirming;
- no center-card flicker between old/new leads;
- old call never reappears after terminal click;
- completion buffer records every terminal outcome;
- agents understand blank/loading state between calls;
- missing UII becomes a logged finalization issue, not a live-call button outage.

## Phase 4: Rolling RingCX Queue Mirror

Purpose: reduce one-off `nextDial` choreography without jumping straight to full queue mirroring.

Behavior:

- mirror only the next 1-2 future calls into RingCX;
- feed mirror from existing queue-generation and assignment rules;
- preserve DNC/cadence terminal rules;
- RingCX starts owning near-term dialing inventory;
- bucket observer still decides `currentCall`;
- `requestCxNextDialHandoff(...)` remains fallback behind a kill-switch.

Success criteria:

- RingCX does not dial absent/unready agents unexpectedly;
- mirrored leads are consumed/cleaned predictably;
- DNC and cadence rules are not bypassed;
- active calls still match bucket candidates deterministically.

## Phase 5: Full Queue Mirror

Behavior:

- queue load mirrors the whole agent queue, or a large managed window, into RingCX;
- Parallel stops relying on normal per-disposition `nextDial`;
- RingCX owns dialing inventory;
- Parallel owns bucket state, UI projection, outcomes, metrics, coach summary, and cleanup;
- hard kill-switch remains available.

Final loop:

```text
queue build
  -> newCalls[]
  -> mirror to RingCX

RingCX activeCalls/list
  -> match active call to newCalls[] using existing scorer
  -> currentCall confirming or active
  -> UI center panel/buttons

terminal button
  -> currentCall moves to completionBuffer
  -> UI clears center/loading
  -> RingCX disposition/hangup
  -> metrics/coach/summary workers

RingCX activeCalls/list
  -> next active observation
  -> next currentCall
```

## Deletion Plan

Delete only after replacement owns the relevant behavior.

### Delete After Phase 3

- direct active staging after `nextDialAccepted`;
- client logic that treats nextDial response as active-current truth;
- terminal button gates based on selected case/form/served queue alone.

### Delete After Phase 4

- `requestCxNextDialHandoff(...)` as the normal terminal-button path;
- auto-serve timers as the primary handoff engine;
- duplicate current-card restoration paths.

Delete `skipAgentStateClearAfterRelay` only after both are true:

```text
bucket owns clear/release
nextDial no longer drives the normal current-call path
```

That flag protects against the background relay stomping the next call's clear, so removing it too early can revive the same handoff race.

Keep manual recovery/fallback commands.

### Delete After Phase 5

- direct writes to `agentstates.currentCall` outside projection helper;
- local `servedQueue*` as an independent source of truth;
- queue metadata as active-call source of truth;
- one-off normal nextDial handoff choreography.

## Keep

Do not remove:

- RingCX `activeCalls/list` polling or equivalent event feed;
- RingCX disposition/hangup submit;
- queue generation and assignment rules;
- DNC and cadence terminal protections;
- daily/cadence counters until replacement metrics are proven;
- no-UII TTL cleanup;
- strict confirmation for one-off/non-mirrored dialing.

Strict confirmation remains appropriate when a single one-off dial request is the only thing tying UI state to RingCX state. It should not become a disposition-button gate in the mirrored/current-call UI path.

## Logs

Every bucket log should include enough data to compare bucket vs compact `cxCall` vs legacy:

```json
{
  "agentExtensionId": "12345",
  "bucketPhase": "confirming",
  "bucketQueueItemId": "abc",
  "bucketUii": null,
  "telephonyActive": true,
  "uiiFinalizationStatus": "pending",
  "cxCallPhase": "publishing",
  "cxCallQueueItemId": "abc",
  "cxCallUii": null,
  "legacyQueueItemId": "abc",
  "legacyUii": null,
  "agreement": true,
  "matchedBy": "telephony-presence",
  "confidence": "medium",
  "weakMatchEnabled": false,
  "reason": "active-call-observed"
}
```

Required event names:

- `cx.bucket.queue_primed`
- `cx.bucket.active_match`
- `cx.bucket.active_confirming`
- `cx.bucket.active_match_miss`
- `cx.bucket.active_match_ambiguous`
- `cx.bucket.shadow_compare`
- `cx.bucket.terminal_observed`
- `cx.bucket.completion_buffered`
- `cx.bucket.uii_finalization_pending`
- `cx.bucket.projected_cxCall`

## Unit Testing Plan

Use the repo's existing style:

```text
node:test + node:assert/strict
pure helpers first
no Mongo/RingCX network calls in unit tests
small fixtures that model real RingCX payload shapes
```

Suggested folder:

```text
scripts/queue-tests/
```

Run targeted tests as sections land:

```powershell
node --test scripts/queue-tests/*.test.js
node --test tests/cx-call-state-guard/*.test.js tests/queue/cxTerminalOutcome.test.js
```

### Test Fixtures

Create shared fixtures only if repetition starts hurting readability:

```text
scripts/queue-tests/fixtures.js
```

Fixture families:

- `candidateQueueItem(...)`
- `activeCallWithUii(...)`
- `activeCallWithExternId(...)`
- `activeCallPhoneOnly(...)`
- `legacyAgentState(...)`
- `canonicalCxCall(...)`
- `terminalButtonPayload(...)`

Keep fixtures deliberately small. The important thing is identity, phase, UII, queue item, agent, campaign, and phone; not full production payload copies.

### Phase 1 Tests: Bucket Shadow

File:

```text
scripts/queue-tests/cxDialQueueMediatorService.test.js
```

Required coverage:

- `primeNewCalls` upserts candidates by stable queue identity without duplicating rows.
- priming a later copy of the same candidate updates display metadata but does not create a second candidate.
- active call with captured UII promotes the matching candidate to `currentCall.phase === "active"`.
- active telephony without UII promotes to `currentCall.phase === "confirming"` instead of failing.
- terminal outcome moves or mirrors the call into `completionBuffer` even when UII is null.
- terminal outcome with null UII sets `uiiFinalizationStatus === "pending"`.
- terminal outcome with known UII sets `uiiFinalizationStatus === "captured"`.
- current call is cleared/drained after terminal outcome, but candidate history needed for finalization is preserved.

Hard negative tests:

- queue acceptance alone never creates `currentCall`.
- disposition response alone never creates the next `currentCall`.
- selected case/form state alone never creates `currentCall`.
- ambiguous phone fallback logs ambiguity and does not promote.
- phone-only fallback does not promote when weak matching is disabled.
- two candidates with the same phone for the same agent do not promote by phone.

Log-shape tests:

- `cx.bucket.active_match` includes agent, phase, matchedBy, confidence, bucket queue id, bucket UII, and reason.
- no log payload includes raw full phone when only hash/last4 is required.

### Phase 1 Matcher Reuse Tests

File:

```text
scripts/queue-tests/cxActiveCallMatching.test.js
```

Purpose:

```text
prove the mediator consumes the existing scorer/matcher result instead of inventing a competing matcher
```

Required coverage:

- UII match outranks externId and phone.
- captured `metadata.lastDialExecutionUii` matches active call UII.
- externId scan match is accepted only when unambiguous.
- phone + agent + campaign match is accepted only behind the weak-match flag.
- weak phone fallback rejects ties.
- weak phone fallback rejects phone-alone evidence.
- matcher miss returns a structured miss reason that can be logged.

This test should mock the existing matcher output if direct import is too tangled. The important contract is that bucket code receives and honors the scorer decision; it should not duplicate scoring rules.

### Phase 2 Tests: `cxCall` Projection

File:

```text
scripts/queue-tests/cxBucketProjection.test.js
```

Required coverage:

- bucket `confirming` projects to compact `cxCall` with no-UII expiry.
- bucket `active` projects to compact `cxCall` with UII and no unnecessary expiry.
- projected `cxCall` preserves queue item, case id, phone-normalized value, phase, transition id, writer, and lastObservedAt.
- projection is inert when `CX_BUCKET_SHADOW_PROJECT_CXCALL=false`.
- projection does not run when `CX_CANONICAL_CALL_WRITE_ENABLED=false`.
- projected no-UII shells expire through existing `isExpiredNoUiiCxCallShell`.
- `buildCxCallTransitionLogPayload` style fields are present for old/new phase churn.

Regression coverage against existing tests:

```powershell
node --test tests/cx-call-state-guard/cxCallLifecycleService.test.js
```

Do not move to Phase 3 if projection breaks existing canonical gate tests.

### Phase 3 Tests: UI Gate And Release State

Keep most of this as pure functions extracted from `CXWorkspace.tsx`; avoid brittle DOM tests at first.

Suggested helper file:

```text
apps/web-client/src/workspaces/cx/cxCallViewModel.ts
```

Suggested test file:

```text
scripts/queue-tests/cxCallViewModel.test.js
```

Required coverage:

- terminal buttons are enabled when `telephonyActive === true`, permission is present, and release is not in flight, even if UII is null.
- terminal buttons are disabled when telephony is not active.
- terminal buttons are disabled while release is in flight.
- `confirming` state renders/returns a "confirming identity" message without hiding terminal buttons.
- terminal click returns a release/loading view model and clears old lead display.
- old call does not reappear after terminal click unless active telephony observation explicitly recreates it.
- disposition response does not render next call.
- queue row does not render next call.

Hard regression test:

```text
confirming currentCall + no UII + live-call ownership => terminal buttons remain available
```

That is the June-bug guardrail.

### Phase 4 Tests: Rolling Mirror

File:

```text
scripts/queue-tests/cxRingcxQueueMirror.test.js
```

Required coverage:

- mirror chooses only the next configured window size, such as 1 or 2 candidates.
- mirror never includes DNC-terminal candidates.
- mirror respects assignment/agent eligibility.
- mirror respects cadence terminal/suppression rules.
- mirror is inert behind `CX_RINGCX_QUEUE_MIRROR_ENABLED=false`.
- failed mirror response leaves the local bucket candidate intact and logs a retryable failure.
- accepted mirror response does not create `currentCall`.
- active-call observation is still required to create `currentCall`.

### Phase 5 Tests: Full Queue Mirror

Only write these once Phase 4 is stable.

Required coverage:

- queue build produces a bounded RingCX mirror payload and matching `newCalls[]`.
- full mirror kill-switch prevents any outbound RingCX mutation.
- consumed mirror candidates are removed or marked consumed without deleting historical completion data.
- completionBuffer still records outcome when RingCX owns the dialing inventory.
- DNC and cadence protections are preserved under full mirror mode.

### Cross-Phase Regression Scenarios

These should exist before Phase 3 or any live UI read flip:

1. No UII at call start.
   - active telephony observed;
   - bucket goes `confirming`;
   - buttons remain available;
   - terminal click buffers completion with pending UII.
2. UII arrives after terminal click.
   - completionBuffer updates from pending to captured;
   - old call does not return to the center panel.
3. Next lead accepted before active call observed.
   - candidate is in `newCalls`;
   - UI remains release/loading;
   - no currentCall until active observation.
4. Ambiguous phone match.
   - logs ambiguity;
   - does not promote;
   - no terminal button state is created from ambiguity alone.
5. Agent has stale no-UII shell.
   - expiry logic clears/allows past shell;
   - new confirming state can be written cleanly.

### Test Gate By Section

Phase 1 is not done until:

```text
cxDialQueueMediatorService tests pass
matcher-reuse tests pass
existing cxCallLifecycleService tests pass
existing cxTerminalOutcome tests pass
```

Phase 2 is not done until:

```text
projection tests pass
cx-call-state-guard tests pass
shadow comparison logs have the required fields
```

Phase 3 is not done until:

```text
view-model tests pass
June-bug guardrail test passes
manual local UI test shows confirming state with terminal buttons available
```

Phase 4 is not done until:

```text
rolling mirror tests pass
DNC/cadence suppression tests pass
accepted mirror response still does not create currentCall
```

Phase 5 is not done until:

```text
full mirror tests pass
kill-switch tests pass
completionBuffer still captures outcomes under mirrored inventory
```

### What Not To Unit Test

Do not unit-test live RingCX latency.

Do not unit-test real Mongo indexes here.

Do not unit-test the full Vite DOM unless a specific view-model test cannot capture the bug.

For those, use integration/smoke tests after the unit contract is stable.

## Rollback

Phase 1 rollback is just flags:

```text
CX_BUCKET_SHADOW_ENABLED=false
CX_BUCKET_SHADOW_RENDER_ENABLED=false
CX_BUCKET_SHADOW_PROJECT_CXCALL=false
```

Existing `cxCall` and legacy state continue operating as they do now.

If Phase 2 projection causes trouble:

```text
CX_BUCKET_SHADOW_PROJECT_CXCALL=false
```

If Phase 3 UI rendering causes trouble:

```text
CX_BUCKET_SHADOW_RENDER_ENABLED=false
```

If mirroring causes trouble:

```text
CX_RINGCX_QUEUE_MIRROR_ENABLED=false
```

## 2026-06-19 Implementation Alignment Note

The file has been read in this latest form (sections include `Current Posture`, `Phase 1`, `Phase 2`, `Phase 3`, `Deletion Plan`) before naming the minimal implementation pass.

Current suggested pass name without code edits:

- `cx-bucket-shadow-phase-1`

Implementation file set for this pass:

- [packages/shared-services/src/cxDialQueueMediatorService.js](/C:/code/TagContactBridgeParalell/packages/shared-services/src/cxDialQueueMediatorService.js)
- [packages/shared-services/src/cxWorkspaceService.js](/C:/code/TagContactBridgeParalell/packages/shared-services/src/cxWorkspaceService.js)
- [packages/shared-services/src/ringcxAgentMonitorService.js](/C:/code/TagContactBridgeParalell/packages/shared-services/src/ringcxAgentMonitorService.js)
- [apps/control-plane/src/routes/commandsCx.js](/C:/code/TagContactBridgeParalell/apps/control-plane/src/routes/commandsCx.js)
- [apps/control-plane/src/routes/readCx.js](/C:/code/TagContactBridgeParalell/apps/control-plane/src/routes/readCx.js)
- [apps/web-client/src/workspaces/cx/CXWorkspace.tsx](/C:/code/TagContactBridgeParalell/apps/web-client/src/workspaces/cx/CXWorkspace.tsx)
- [apps/web-client/src/lib/api/queries/cx.ts](/C:/code/TagContactBridgeParalell/apps/web-client/src/lib/api/queries/cx.ts)

### Concrete Today Pass: Stale Current-Call Fix

This is the minimal implementation pass to eliminate stale bucket `currentCall` drift and keep the same object ownership model.

1. `packages/shared-services/src/cxDialQueueMediatorService.js`
   - add stale-current helpers and reconciler:
     - `isBucketCurrentCallStale(...)`
     - `reconcileCxBucketCurrentCalls(...)`
     - increment `staleCurrentClears` in stats
   - add env toggles:
     - `CX_BUCKET_STALE_RECONCILE_ENABLED`
     - `CX_BUCKET_STALE_CURRENT_MS`
     - `CX_BUCKET_STALE_MISMATCH_MS`
     - `CX_BUCKET_CONFIRMING_STALE_MS`

2. `packages/shared-services/src/ringcxAgentMonitorService.js`
   - call `reconcileCxBucketCurrentCalls(...)` every monitor pass after active-call processing
   - return reconciliation totals:
     - `staleBucketCurrent`
     - `staleBucketCurrentAgents`

3. `packages/shared-services/src/cxCadenceService.js`
   - route terminal/release current-call clears through `observeCxBucketTerminalOutcome(...)`
   - include stale-serving timeout clear in terminal bridge

4. `packages/shared-services/src/ringcxDialExecutionService.js`
   - route auto-disposition clear via `observeCxBucketTerminalOutcome(...)` with outcome `ringcx-auto-disposition`

5. `packages/shared-services/src/idleReaperService.js`
   - route orphan clear success via `observeCxBucketTerminalOutcome(...)` with outcome `idle-reaper-orphan-clear`

6. `packages/shared-services/src/cxWorkspaceService.js` (hardening pass only if needed)
   - route any remaining terminal clear that currently does `currentCall: {}` into mediator terminal bridge.

7. Unit test folder (as requested): `scripts/queue-tests`
   - `scripts/queue-tests/cxBucketStaleCurrent.test.js`
   - `scripts/queue-tests/cxBucketTerminalBridge.test.js`
   - assertions:
     - stale `currentCall` cleared and completion outcome buffered
     - candidate history retained for finalization
     - no-UII confirming stale clear buffers outcome as pending
     - monitor reconciler clears stale only
     - terminal outcomes are never dropped

## Concrete Today Pass: Local Parallel Runtime (Login-Only)

This pass is the fresh-start proof lane to run local calls for one agent (`mgray`) using existing login.
No legacy CX flow changes. No new production queue behavior. No route sharing with the existing workspace handoff except a gated opt-in.

### Scope constraints (hard)

1. This is local-only and one-agent-only until proven.
2. One queue snapshot per session, no re-reading queue mid-session.
3. One active `current` only, one publish/disposition cycle in progress at a time.
4. Active call evidence is always required before a lead becomes current.
5. `sessionId` is the only source for test-loop state.

### Add this exact file set

1. [packages/shared-services/src/cxSimpleCallLoopService.js](/C:/code/TagContactBridgeParalell/packages/shared-services/src/cxSimpleCallLoopService.js)
   - create reducer-first implementation:
     - `reduceCxSimpleLoopSession(previousSession, event, now)`
     - `startCxSimpleLoopSession(input, options)`
     - `getCxSimpleLoopSession(input, options)`
     - `advanceCxSimpleLoopSession(input, options)`
     - `submitCxSimpleLoopDisposition(input, options)`
     - `skipCxSimpleLoopCurrent(input, options)`
     - `killCxSimpleLoopSession(input, options)`
   - export session stats counters:
     - `publishAttempts`, `captureAttempts`, `captureMisses`, `terminalOutcomes`, `autoAdvanceCount`, `breakerPauses`
   - own these transitions:
     - `pending -> publishing -> confirming -> active`
     - `confirming -> active`
     - `confirming/active -> releasing -> completed`
     - `pending/capturing/publish -> failed -> paused (breaker only)`

2. [packages/shared-services/src/CxSimpleLoopSession.js](/C:/code/TagContactBridgeParalell/packages/shared-services/src/CxSimpleLoopSession.js)
   - if adding collection-backed sessions, keep this model tiny and mixed-first.
   - required fields:
     - `sessionId`, `agentEmail`, `agentExtensionId`, `status`, `localQueue`, `cursorIndex`, `current`, `completed`, `lastError`, `stats`, `createdAt`, `updatedAt`.
   - required indexes:
     - `{ sessionId: 1 }` unique
     - `{ agentExtensionId: 1, status: 1, updatedAt: -1 }`

3. [apps/control-plane/src/routes/cxSimpleLoop.js](/C:/code/TagContactBridgeParalell/apps/control-plane/src/routes/cxSimpleLoop.js)
   - thin route wrapper only; no business logic.
   - `POST /api/cx-simple/session/start`
   - `GET /api/cx-simple/session`
   - `POST /api/cx-simple/session/advance`
   - `POST /api/cx-simple/current/disposition`
   - `POST /api/cx-simple/current/skip`
   - `POST /api/cx-simple/session/kill`
   - each handler calls the matching function from `cxSimpleCallLoopService`.
   - hard-fail if agent is not in the allowlist config.

4. [apps/control-plane/src/server.js](/C:/code/TagContactBridgeParalell/apps/control-plane/src/server.js)
   - mount the new router behind a local gate.
   - no merge into existing workspace routes.

5. [apps/web-client/src/lib/api/queries/cxSimpleLoop.ts](/C:/code/TagContactBridgeParalell/apps/web-client/src/lib/api/queries/cxSimpleLoop.ts)
   - simple query + mutation hooks for the six routes above.
   - no UI state duplication beyond query cache.

6. [apps/web-client/src/workspaces/cx/CxSimpleLoopPanel.tsx](/C:/code/TagContactBridgeParalell/apps/web-client/src/workspaces/cx/CxSimpleLoopPanel.tsx) (or route page)
   - display only this object:
     - `status`, `localQueue`, `current`, `completed`, `lastError`, `stats`
   - expose buttons:
     - Start, Disposition (map to current outcome), Skip, Kill.
   - never read legacy queue/calls as source of truth.

### Config flags for this pass

- `CX_SIMPLE_LOOP_ENABLED=false`
- `CX_SIMPLE_LOOP_ALLOWED_EMAILS=mgray@taxadvocategroup.com`
- `CX_SIMPLE_LOOP_MAX_QUEUE=5`
- `CX_SIMPLE_LOOP_CAPTURE_TIMEOUT_MS=45000`
- `CX_SIMPLE_LOOP_CAPTURE_MISS_LIMIT=3`
- `CX_SIMPLE_LOOP_CAPTURE_MISS_WINDOW_MS=300000`
- `CX_SIMPLE_LOOP_MODE=single`
- `CX_SIMPLE_LOOP_REPLACE_WORKSPACE_FOR_ALLOWED_AGENT=false`

### Exact runtime sequence

1. Start session -> snapshot queue once.
2. Session owns a stable `localQueue` with `loopOrder` for each candidate.
3. `advanceCxSimpleLoopSession` publishes exactly one pending candidate at a time.
4. Service waits for owned active-call evidence:
   - no evidence: `current.phase=failed`, candidate fails, capture miss increments, maybe pause.
   - evidence found: `current.phase=active`, `current.uii` optional.
5. Terminal click call:
   - immediately set `current.phase=releasing`
   - submit RingCX disposition when uii present or buffer outcome if uii missing
   - push into `completed` once
   - clear `current`
   - auto-advance one call by default.
6. Breaker:
   - when capture misses hit limit in window, set `status=paused`, no more publish attempts.

### Publish and capture contract (single mode)

- `advance` is the only function allowed to call RingCX publish.
- one `advance` call must publish one candidate.
- publish accepted alone sets `current.phase=confirming`, not active.
- publish reject sets candidate failed and pauses on configured breaker rule.

### Bulk publish test mode (future flag, no default)

- keep command signatures stable so `mode: "bulk-mirror"` can be added without rewrite.
- still do not use publish acceptance as current-truth.
- still keep one observed active call as the only `current`.

### Session health logs (required)

- add logs:
  - `cx.simple.start_requested`
  - `cx.simple.started`
  - `cx.simple.advance_started`
  - `cx.simple.publish_started`
  - `cx.simple.publish_accepted`
  - `cx.simple.publish_rejected`
  - `cx.simple.capture_scope`
  - `cx.simple.capture_found`
  - `cx.simple.capture_missed`
  - `cx.simple.disposition_buffered`
  - `cx.simple.release_started`
  - `cx.simple.completed_buffered`
  - `cx.simple.paused`
  - `cx.simple.killed`
- include fields: `sessionId`, `agentExtensionId`, `queueItemId`, `caseId`, `campaignId`, `dialGroupId`, `externId`, `currentPhase`, `outcome`, `loopOrder`, `matchScope`, `reason`.

### Minimal test work for today (in scripts)

Create under:

`scripts/queue tests/`

Files:

- `cxSimpleCallLoopService.test.js`
- `cxSimpleCallLoopService.reducer.test.js`

Required assertions:

- start snapshots once with stable loop order.
- advance publishes at most one candidate.
- `publishAccepted -> confirming` before active.
- active evidence promotes to active exactly once.
- no stale clear when uii still pending and telephony still owned.
- capture miss increments breaker and pauses after configured threshold.
- disposition buffers to completed exactly once.
- kill marks unstarted candidates cancelled and clears current.

## North Star

Final code should be boring:

```text
one candidate bucket
one owned current call
one completed-call buffer
one existing matcher/scorer path
one projection into cxCall
one release path that drains currentCall
```

Everything else is a compatibility shim waiting to be removed.

## Final Approval + Today's Local-Run Build (mgray only)

Use this section as the canonical local replacement plan for this session.

### Hard constraints (do not violate)

- Keep legacy CX flow intact for everyone else.
- Build as isolated local harness only: `cxsimpleloopsessions` (new collection).
- Replace logic only inside new files + new routes:
  - `packages/shared-services/src/cxSimpleCallLoopService.js`
  - `packages/shared-services/src/CxSimpleLoopSession.js`
  - `packages/shared-repositories/src/cxSimpleLoopSessionRepository.js`
  - `apps/control-plane/src/routes/cxSimpleLoop.js`
  - `apps/control-plane/src/server.js` mount only a new path
  - `apps/web-client/src/lib/api/queries/cxSimpleLoop.ts`
  - `apps/web-client/src/workspaces/cx/CxSimpleLoopPanel.tsx` (or a dedicated debug workspace page)
- Do not mutate or simplify existing production queue/plumbing.
- Do not let route handlers mutate session state shape; the service owns transitions.
- Do not use `servedQueue`, legacy `selected lead`, or legacy next-dial as source-of-truth.
- Do not use weak phone matching for capture or promotion.

### Exact flow to implement

1. Only if enabled by:
   - `CX_SIMPLE_LOOP_ENABLED=true`
   - `CX_SIMPLE_LOOP_ALLOWED_EMAILS` includes logged-in email (`mgray` for this phase)
   - then use simple-loop workspace for that agent when `CX_SIMPLE_LOOP_REPLACE_WORKSPACE_FOR_ALLOWED_AGENT=true`
2. `start` takes one queue snapshot once for the session; no repeated re-query for the core loop.
3. Only this path can publish:
   - `advance` publishes one candidate at most.
   - `publish accepted != current` (it only moves current to `confirming`).
4. Only owned RingCX active-call evidence can promote current:
   - match by explicit metadata route identity only (externId/metadata/case/channel markers; no weak phone fallback).
   - active evidence with no UII => `current.phase=confirming`.
   - active evidence with UII => `current.phase=active`, `current.uii=...`.
5. Terminal action behavior:
   - immediate `current.phase=releasing`
   - RingCX disposition only when possible
   - outcome always goes to `completed` exactly once
   - clear `current`
   - auto-advance one unit (unless explicitly false).
6. Breaker:
   - repeated capture misses in window pauses session (`status=paused`) and stops publishing.

### Routes and names to support

Use only this route shape:

- `POST /api/cx/simple-loop/session/start`
- `GET /api/cx/simple-loop/session`
- `POST /api/cx/simple-loop/session/advance`
- `POST /api/cx/simple-loop/session/disposition`
- `POST /api/cx/simple-loop/session/skip`
- `POST /api/cx/simple-loop/session/kill`

Request/body contracts stay minimal and can grow in future passes, but keep `agentEmail/agentExtensionId/allowedOnly/sessionId` checks strict.

### Config values for local gate

- `CX_SIMPLE_LOOP_ENABLED=false`
- `CX_SIMPLE_LOOP_ALLOWED_EMAILS=mgray@taxadvocategroup.com`
- `CX_SIMPLE_LOOP_REPLACE_WORKSPACE_FOR_ALLOWED_AGENT=false`
- `CX_SIMPLE_LOOP_MAX_QUEUE=5`
- `CX_SIMPLE_LOOP_CAPTURE_TIMEOUT_MS=45000`
- `CX_SIMPLE_LOOP_CAPTURE_MISS_LIMIT=3`
- `CX_SIMPLE_LOOP_CAPTURE_MISS_WINDOW_MS=300000`
- `CX_SIMPLE_LOOP_MODE=single`

### Required logging surface

- `cx.simple.start_requested`
- `cx.simple.started`
- `cx.simple.advance_started`
- `cx.simple.publish_started`
- `cx.simple.publish_accepted`
- `cx.simple.publish_rejected`
- `cx.simple.capture_scope`
- `cx.simple.capture_found`
- `cx.simple.capture_missed`
- `cx.simple.disposition_buffered`
- `cx.simple.release_started`
- `cx.simple.completed_buffered`
- `cx.simple.paused`
- `cx.simple.killed`

Payload should include:
`sessionId`, `agentExtensionId`, `queueItemId`, `caseId`, `campaignId`, `dialGroupId`, `externId`, `currentPhase`, `outcome`, `loopOrder`, `matchScope`, `reason`, `attemptNo`.

### Required unit tests (new folder is exact)

Create tests only in:

`C:\code\TagContactBridgeParalell\scripts\queue tests\`

Files to add:

- `cxSimpleCallLoopService.test.js`
- `cxSimpleCallLoopService.reducer.test.js`

Coverage requirements:

- start snapshots once with stable `loopOrder`.
- `advance` emits at most one publish attempt.
- publish acceptance never sets `current.active`.
- active evidence promotion only from owned evidence.
- UI release path preserves `completed` semantics.
- disposition can happen while `uii` is missing and still buffers as pending.
- stale/ambiguous evidence does not clear current.
- capture miss breaker pauses at configured threshold.
- kill clears live current and cancels/marks pending items.

### Keep these out of this phase

- no changes to legacy mediator/service flow
- no legacy current/currentCall mutation by route handlers
- no production next-dial wiring changes
- no weak phone matching

This pass is intentionally narrow. Its only success criterion is "simple-loop harness runs cleanly and predictably for local Mickey-only calls."

## Latest Implementation Draft (Today Build, no production mutations)

Keep all previous sections as historical design notes. This is the concrete, minimal build recipe for today.

### What we are building now

1. Mickey-only local loop drives RingCX using a snapshot queue and explicit active-call evidence.
2. Legacy queue plumbing remains unchanged for all non-local-flow users.
3. Routes are thin; service owns transitions.
4. No weak/phone-only matching.
5. No production fallback behavior changes.

### Concrete file changes to apply

1. Add `packages/shared-models/src/CxSimpleLoopSession.js` as mixed-first session model with `sessionId`, `agentEmail`, `agentExtensionId`, `cxAgentId`, `status`, `mode`, `localQueue`, `cursorIndex`, `current`, `completed`, `stats`, `missWindow`, `lastError`, `createdAt`, `updatedAt`.
2. Add `packages/shared-repositories/src/cxSimpleLoopSessionRepository.js` with CRUD plus queries by `sessionId` and `agentExtensionId/status`, using collection `cxsimpleloopsessions`.
3. Add `packages/shared-services/src/cxSimpleCallLoopService.js` with reducer-first API: `reduceCxSimpleLoopSession(previousSession, event, now)`, `startCxSimpleLoopSession(input, options)`, `getCxSimpleLoopSession(input, options)`, `advanceCxSimpleLoopSession(input, options)`, `submitCxSimpleLoopDisposition(input, options)`, `skipCxSimpleLoopCurrent(input, options)`, `killCxSimpleLoopSession(input, options)`.
4. Add `apps/control-plane/src/routes/cxSimpleLoop.js` as thin wrappers for allowlisted agents to call service methods and expose: `POST /api/cx/simple-loop/session/start`, `GET /api/cx/simple-loop/session`, `POST /api/cx/simple-loop/session/advance`, `POST /api/cx/simple-loop/session/disposition`, `POST /api/cx/simple-loop/session/skip`, `POST /api/cx/simple-loop/session/kill`.
5. Update `apps/control-plane/src/server.js` to mount the router only under local gate + allowlist.
6. Add `apps/web-client/src/lib/api/queries/cxSimpleLoop.ts` with query/mutation hooks for the same six routes and no duplicated local call state.
7. Add/update `apps/web-client/src/workspaces/cx/CxSimpleLoopPanel.tsx` to render only `status`, `current`, `localQueue`, `completed`, `stats`, and `lastError`, with terminal actions routed to simple-loop endpoints.

### New service semantics (hard rules)

1. `startCxSimpleLoopSession` snapshots queue once, stamps stable `loopOrder`, sets status to `running`.
2. `advanceCxSimpleLoopSession` selects one pending candidate by `loopOrder`, publishes one lead, then sets `current.phase = confirming` on publish acceptance.
3. Active evidence matching is explicit only: `externId` first, then `cxAgentId`, then account; phone-only matching is forbidden.
4. Capture timeout sets `current.phase = failed`, increments miss window, and may pause session via breaker.
5. `submitCxSimpleLoopDisposition` sets `current.phase = releasing`, writes one completed outcome by `queueItemId`, clears `current`, then auto-advances exactly one candidate by default.
6. `killCxSimpleLoopSession` clears live `current`, marks runnable candidates cancelled/failed, and blocks future publish calls.

### Required kill/drain behavior

1. Before bulk mirror publish, add helper `killOrDrainCandidateRingcxLeads(session)` to cancel stale test leads tied to session.
2. Do not skip candidate cancellation in pending/paused states.
3. Single mode does not require pre-publish drain for correctness but helper remains required for future bulk mode.

### Route and env gate

1. `CX_SIMPLE_LOOP_ENABLED=false`
2. `CX_SIMPLE_LOOP_ALLOWED_EMAILS=mgray@taxadvocategroup.com`
3. `CX_SIMPLE_LOOP_REPLACE_WORKSPACE_FOR_ALLOWED_AGENT=true` for local replacement validation only.
4. `CX_SIMPLE_LOOP_MAX_QUEUE=5`
5. `CX_SIMPLE_LOOP_CAPTURE_TIMEOUT_MS=45000`
6. `CX_SIMPLE_LOOP_CAPTURE_MISS_LIMIT=3`
7. `CX_SIMPLE_LOOP_CAPTURE_MISS_WINDOW_MS=300000`
8. `CX_SIMPLE_LOOP_MODE=single`

Session should only render in UI when both flags and allowlist pass.

### Event/trace contract (must log)

- `cx.simple.start_requested`
- `cx.simple.started`
- `cx.simple.advance_started`
- `cx.simple.publish_started`
- `cx.simple.publish_accepted`
- `cx.simple.publish_rejected`
- `cx.simple.capture_scope`
- `cx.simple.capture_found`
- `cx.simple.capture_missed`
- `cx.simple.disposition_buffered`
- `cx.simple.release_started`
- `cx.simple.completed_buffered`
- `cx.simple.paused`
- `cx.simple.killed`

Every log should include at minimum:
`sessionId, agentExtensionId, queueItemId, caseId, campaignId, dialGroupId, externId, currentPhase, outcome, loopOrder, matchScope, reason, attemptNo`.

### Unit tests (exact folder)

Create exactly this folder: `C:\code\TagContactBridgeParalell\scripts/queue tests/`.

Create exactly these files: `C:\code\TagContactBridgeParalell\scripts/queue tests/cxSimpleCallLoopService.test.js` and `C:\code\TagContactBridgeParalell\scripts/queue tests/cxSimpleCallLoopService.reducer.test.js`.

Use RingCX client mocks only.

Required assertions: `start` creates one snapshot with deterministic order; one `advance` performs at most one publish; `publish_accepted` moves only to confirming; active evidence transitions to active exactly once; `skip` and `disposition` move current into completed once and clear UI current; missing UII still buffers completed; miss counter breaker pauses within rolling window; stale/ambiguous evidence does not clear current; `kill` clears current and marks remaining candidates as not runnable.

### Safe rollback

- Set `CX_SIMPLE_LOOP_ENABLED=false`.
- Set `CX_SIMPLE_LOOP_REPLACE_WORKSPACE_FOR_ALLOWED_AGENT=false`.
- No runtime code path should touch legacy queue flow.

## Revised Version Goals After Bulk-Mirror Test

This section supersedes the earlier "single publish first" posture for the next version design. The local bulk-mirror test showed the important thing:

```text
RingCX accepted the leads, but RingCX did not necessarily dial them in the same order
the app rendered or the same order the app posted.
```

That is not a problem if the app stops treating its own queue order as call truth.

### Core Finding

The queue generator and cadence policy can remain the source of lead selection:

```text
3 attempts per day
spacing / cooldown rules
fresh / blue / aged policy
DNC and contact reset rules
agent pool policy
```

But once a batch is handed to RingCX, RingCX owns live dialing order.

Therefore:

```text
Parallel chooses who is eligible and sends a buffer.
RingCX chooses what is actively being dialed.
Parallel renders only the RingCX active call it can match by externalId/UII.
```

The agent does not need to see or care about the pre-dial queue order. They need a stable current call, working terminal buttons, and fast transition/loading state.

### New End-State Goal

Build a per-agent RingCX buffer, not a per-agent visible ordered queue.

```text
localWaiting      leads selected by existing cadence / pool rules
publishedToCx     leads accepted by RingCX but not currently active
current           one RingCX active call matched back by externId/UII
completed         terminal outcome captured and queued for metrics/grading/cleanup
expired           RingCX accepted it but it never surfaced within the allowed window
```

The UI should render:

```text
Current CX call
release/loading state between calls
small buffer status for debugging only
last outcome / error if needed
```

It should not render a pretend "next call" based on local queue order.

### Scale Target

For production floor agents:

```text
targetCxBuffer = 30
refillThreshold = 5
refillAmount = targetCxBuffer - activeBuffer
```

Where:

```text
activeBuffer = publishedToCx not completed/expired/cancelled + current
```

When `activeBuffer <= refillThreshold`, the backend pulls more eligible leads from the existing queue/cadence generator and bulk-loads enough leads to bring the buffer back to `targetCxBuffer`.

For local Mickey testing:

```text
targetCxBuffer = 5
refillThreshold = 1 or 2
```

Same model, smaller numbers.

### Preserve Existing Queue Policy

Do not rewrite lead eligibility as part of this version.

The existing queue generation policy remains authoritative for:

- how many times a lead can be called per day;
- cooldown/spacing between attempts;
- fresh, blue, aged, and route-campaign distribution;
- DNC/contact reset behavior;
- agent pool assignment rules;
- lead cadence / case profile linkage.

The new work changes the transport and lifecycle after a lead is eligible, not the business rules that make it eligible.

### Required RingCX Identity Contract

Every lead sent to RingCX must have a stable external id:

```text
externId = parallel:{domain}:{caseId}:{queueItemId}
```

The active-call observer must match RingCX current calls back to local state by:

1. exact UII when already known;
2. recursive `externId` / `externalId` scan in RingCX active-call payload;
3. agent-scoped active-call evidence with no ambiguity;
4. no phone-only promotion.

If RingCX does not expose `externId` on active calls reliably, the scale plan is blocked until we find a different stable identity field or route.

### Refill Rules

The refill loop is backend-owned and per-agent locked.

Rules:

- only one refill job per agent at a time;
- publish leads in bulk, not one API call per lead;
- stamp each queue item as `publishedToCx` only after RingCX acceptance;
- never create UI current from publish acceptance;
- refill only from existing eligible queue rows;
- stale/expired published leads are replaced, not treated as completed;
- terminal outcome moves current into completed exactly once.

Pseudo-shape:

```text
observe active call
  -> if externId/UII maps to publishedToCx:
       promote to current
       render current call

terminal button
  -> clear middle panel into release/loading
  -> submit outcome
  -> move current to completed
  -> continue observing RingCX for next active call

refill tick
  -> count publishedToCx + current
  -> if <= threshold:
       pull eligible leads from existing generator
       bulk load to RingCX up to target buffer
       stamp accepted leads
```

### What Should Be Removed Later

Once this model proves itself, these old ideas should stop owning the visible call:

- local queue row as current call;
- nextDial response as current call;
- client selected lead restore as current call;
- auto-serve timer as current call;
- UI queue order as RingCX order;
- optimistic form staging before active-call evidence.

These can remain as compatibility projections during rollout, but they should not decide the middle card or terminal button state.

### What To Log

Add compact logs that let us answer whether the buffer is healthy:

```text
cx.buffer.refill.started
cx.buffer.refill.accepted
cx.buffer.refill.failed
cx.buffer.active.matched
cx.buffer.active.missed
cx.buffer.current.promoted
cx.buffer.current.completed
cx.buffer.published.expired
```

Minimum fields:

```text
agentExtensionId
agentEmail
targetCxBuffer
refillThreshold
bufferBefore
publishedCount
bufferAfter
queueItemId
caseId
campaignId
dialGroupId
externId
uii
matchReason
elapsedMs
```

Do not log raw full phone numbers.

### Next Build Goal

Build the local/simple-loop version as the proof of the production shape:

```text
1. Start session by snapshotting eligible local queue rows.
2. Bulk publish a buffer to RingCX.
3. Do not care what order RingCX dials.
4. Watch active calls and promote only matched externId/UII to current.
5. Keep terminal buttons tied to current.
6. After terminal, clear UI and resume watch.
7. Refill when mirrored buffer falls below the local threshold.
```

Success is not "our queue order matches RingCX." Success is:

```text
every RingCX active call maps to the right case,
buttons stay available for that active call,
terminal outcome completes exactly one call,
and the agent never sees stale prior-call state.
```

### Local Harness Adjustment: Buffer Inventory, Not Queue Order

The next local simple-loop pass should model RingCX as the owner of live order:

- `session.queue` is a remaining CX buffer, not a promised dial order.
- A RingCX active-call match removes that candidate from the buffer and promotes it to `current`.
- A watch tick with no active match is neutral (`bulk.watch.empty`), not a capture failure.
- Refill is based on remaining buffer inventory. When the buffer falls to the threshold, pull cadence-safe eligible rows and top back up to the target.
- Refill dedupe must include remaining buffer, `current`, and completed calls so a crossed-off lead does not re-enter the buffer.

This keeps the UI honest: it shows the current RingCX call and a buffer count, not a local ordering claim.

## Findings From The Simple-Loop Field Test - 2026-06-19

The Sean/local simple-loop test changed the target shape a bit. The original hope was that we could bulk publish a small ordered queue, keep our UI queue in the same order, and then promote the top local row as RingCX dialed. That is not the right contract. RingCX may accept the same inventory but choose or expose the next active call in an order that does not match our visible queue. The important invariant is not order. The important invariant is that the active RingCX call can be matched back to exactly one local candidate.

### What We Learned

- RingCX can auto-advance a preview-dial lead without a manual agent terminal button. In Sean's recent call history, several skipped leads ended with `outboundDisposition: "NOANSWER"`, `agentDisposition: null`, `callState: "END-CALL"`, `dequeueTime: null`, and no meaningful agent session duration. The app should treat this as a real terminal outcome observed from RingCX, not as a missing local button click.
- The UI cannot rely on "agent pressed No Answer" to close every no-answer call in bulk-mirror mode. If RingCX moves from one active candidate to another, the prior current call must be completed locally as a system terminal event, then reconciled later against RingCX call history.
- The simple-loop voicemail test did not exercise the real production voicemail path. It went through the generic hangup/disposition helper, and RingCX rejected some attempts with `400 invalid.data`. The simple-loop VM action needs to call the same production VM/drop route or send the exact disposition shape RingCX expects.
- A local no-answer normalization bug was found: `did-not-answer` was not mapping to the real `did_not_connect` disposition key. That made the test button path diverge from the production disposition map.
- A RingCX disposition payload bug was found: explicit `callback: false` was being dropped by truthiness checks. RingCX may require the explicit false value, so disposition helpers must preserve it.
- High-frequency per-agent active-call polling is the wrong scaling shape. The simple-loop watcher currently uses the shared RingCX bearer for `activeCalls/list`, so assume all active-call watch traffic shares the same token budget unless a path explicitly proves per-agent bearer use.
- The safer polling model is one account-level active-call snapshot per backend process, shared across all agents, refreshed about once per second, with local filtering by `externId`, queue item, phone, campaign, and agent identity.

### Revised Contract

RingCX owns live dial order. Parallel owns candidate inventory, current-call projection, terminal accounting, metrics, cadence, and UI state.

The simple-loop replacement should work like this:

```text
local candidate buffer
  -> publish bounded window to RingCX
  -> mark published candidates as mirrored inventory

RingCX active-call snapshot
  -> match active call back to one mirrored candidate
  -> promote that candidate to current
  -> remove it from mirrored inventory

active call changes without local button
  -> complete previous current as cx-system-terminal-pending
  -> reconcile actual outcome from RingCX call history
  -> promote new matched active call

agent terminal button
  -> submit the specific disposition/drop action
  -> clear visible middle panel into transition state
  -> complete current locally
  -> resume active-call watch

buffer low-water mark
  -> generate more cadence-safe candidates
  -> dedupe against mirrored inventory, current, and completed
  -> publish enough to top RingCX back up
```

### UI Implications

- The middle panel should show only the RingCX-matched current call, not the assumed top of our local queue.
- During terminal handoff, the form should clear or grey out into a release/loading state. It should not flash the old lead back onto the screen while RingCX is advancing.
- The visible queue can become a buffer summary, not a promised dial order. Agents do not need to know the exact RingCX queue order if the current card is correct and responsive.
- Buttons should be available only when the app has a matched, owned current call. They should not disappear simply because the local queue order disagrees with RingCX.
- In bulk-mirror mode, the agent-facing terminal buttons should probably shrink to `Answered` and `Voicemail`. RingCX can own ordinary no-answer progression and report it through call history/active-call changes.

### Button Model Simplification

The simple-loop test suggests `No Answer` should stop being a primary agent action in the bulk-mirror workflow. If RingCX has a mirrored buffer and can auto-advance preview dials, then no-answer is best treated as a system-observed terminal outcome:

```text
RingCX dials lead
  -> prospect does not answer
  -> RingCX ends/advances call as NOANSWER
  -> Parallel detects active call changed or call history terminal
  -> Parallel completes prior current as no-answer/cx-auto-advanced
```

That means the visible agent controls can be narrower:

```text
Answered
  -> agent says the call connected and should be terminally classified as an answered interaction

Voicemail
  -> agent intentionally sends the voicemail/drop disposition path

No Answer
  -> hidden/debug/backstop only, not the normal workflow
```

This removes one source of button drift. The UI no longer needs to ask the agent to report something RingCX is already deciding. The app only needs to watch RingCX closely enough to clear the current card and reconcile the outcome when CX auto-advances.

### Cadence Accounting For Auto-Advance

Moving `No Answer` out of the agent button row does not mean no-answer stops counting. It means the backend has to count it from RingCX evidence.

The active-call watcher must treat a UII/current-call change as a possible terminal transition for the prior call:

```text
current = lead A / uii A
watch sees RingCX active call become lead B / uii B
  -> complete lead A as cx-auto-advanced/no-answer-pending
  -> write the same cadence tick a No Answer button would have written
  -> move lead A into completed/reconcile buffer
  -> promote lead B as current
```

The cadence tick has to be idempotent and keyed tightly enough that the watcher cannot double-count during polling jitter:

```text
agentExtensionId
queueItemId or caseId
uii
terminalSource: ringcx-auto-advance
terminalOutcome: pending/no-answer once reconciled
terminalObservedAt
```

This is what preserves the existing contact rules:

```text
max 3 call attempts per day
daily spacing and cooldowns
15 no-contact / DNC behavior
future monthly cadence rules
```

In other words: the UI can lose the `No Answer` button, but the backend cannot lose the no-answer event. The auto-transition path must feed the same counters, metrics, and cadence ledgers as a manual terminal action.

### Polling And Rate Safety

The next pass should avoid per-agent active-call polling. Poll once, cache once, match many.

Recommended starting point:

```text
activeCalls/list cadence: 1000ms per backend process
snapshot TTL: about 900ms
RingCX API product: ACCOUNT snapshot, then local filtering
429 behavior: respect Retry-After, back off globally, show sync-delayed state
```

This still needs one important production hardening step: if multiple Node processes can call `activeCalls/list`, the active-call snapshot should eventually move behind a singleton service or shared cache. A per-process cache is enough for local proof, but not the final scale answer.

### Concrete Next Test Goals

1. Bulk publish a bounded buffer for one test agent.
2. Do not render local queue order as authoritative.
3. Watch account active calls once per second and match the active call back to local candidates.
4. Auto-complete the prior current call when RingCX advances without a local terminal click.
5. Reconcile those auto-completed calls with RingCX call history so metrics/cadence get the real outcome.
6. Wire the three buttons through the same production disposition semantics, including explicit `callback: false` where required.
7. Refill the mirrored RingCX buffer when unmatched published inventory falls to the threshold.

Success for the next test is simple:

```text
the card on screen matches the call RingCX is actually dialing,
buttons remain stable for that call,
no-answer auto-skips do not strand the UI,
and completed calls land in a buffer that can be reconciled for metrics.
```

## Implementation Consolidation Notes - 2026-06-19

After the first narrow implementation pass, the strongest direction is to reuse the existing production cadence handlers rather than letting the simple-loop session become a second ledger.

### What Was Hardened

- The bulk active-call watcher now needs one shared account-level snapshot instead of one RingCX request per UI tick/agent. The implementation should guard both cache hits and in-flight requests so overlapping browser polls do not fan out into multiple `activeCalls/list` calls.
- When a mirrored candidate is matched to a RingCX active call, the simple loop should call the existing call-placed handler with:

```text
confirmedCall: true
ringcxPublished: true
countAsAttempt: true
holdUntilDisposition: true
```

This lets the normal production path write placed-at metadata, daily/monthly attempt counters, call-log scaffolding, and serving/held state.

- When RingCX advances from one matched current call to another, the simple loop should call the existing terminal outcome handler for the prior current call with a no-answer-style result:

```text
sourceService: cx-simple-loop
source: ringcx-active-call-changed
outcome/disposition: did_not_connect
result: NOANSWER
```

This is the key accounting bridge. The reducer can still move the prior call into its local completed buffer, but cadence should be updated by the same handler the rest of the app uses.

- The old cadence handler should honor an explicit confirmed `holdUntilDisposition` flag as a real hold reason. Without that, a bulk-published row that starts in `ready` can be counted but not held, and the terminal handler may later ignore the auto no-answer as `not-held-for-disposition`.

### Remaining Concerns

- This is still a harness/proof shape until the active-call snapshot is made singleton across every process that might call RingCX. A process-local cache protects one Node process, not the whole box.
- The auto-advance no-answer path depends on the prior current call having been successfully recorded as call-placed/held. If the first active match happened before that write, terminal reconciliation may be ignored by the defensive handler.
- Voicemail still needs to use the production VM/drop path. The generic simple-loop disposition route is not enough proof because RingCX rejected some generic attempts with `400 invalid.data`.
- `No Answer` can disappear from the primary UI only after the watcher is reliably writing those backend terminal ticks. Until then, keep it as a debug/backstop action.

## Day-1 Fix: file-by-file thinning plan (current loop hardening)

Goal: reduce the loop to: _publish bulk, watch active-call evidence, auto-advance current when active changes, and keep completion strictly one-at-a-time_. Keep all legacy behavior untouched.

### 1) `packages/shared-services/src/cxSimpleCallLoopService.js`

1. Introduce one local-only state machine for `tick`/`advance`:
   - keep `session.current`, `session.buffer`, `session.completed`, `session.stats`.
   - remove queue-order assumptions from the hot path; only candidate identity is `queueItemId`, `caseId`, `externId`.
2. Make `advanceCxSimpleLoopSession` minimal and non-recursive:
   - in `single` mode: publish one pending candidate only.
   - in `bulk-mirror` mode: top buffer up to target by publish window helper; then call only `watchActiveForCurrent`.
3. In the active-watch path:
   - call `captureRingcxActiveCallForPublishedLead` once per tick.
   - if no current and capture found -> set `current` only from capture.
   - if capture found and current exists but changed -> complete old current with `reason: cx-auto-advance`, set new current from capture.
   - if capture not found -> do not emit capture-miss breaker in bulk mode; in single mode keep existing miss breaker logic.
4. Add explicit stale handling:
   - if `session.current` has been stable too long with no evidence delta, close it with `stale` and keep UI clear.
5. Submit/skip handlers:
   - operate only on `current`.
   - move exactly one call to completed once; clear `current` after outcome write.
   - call `watch/advance` once on success.
6. Kill path:
   - ensure kill cancels all published/pending RingCX candidates for the session via existing cancel helper.
   - clear `current` and buffer cleanly.
7. Keep `reduceCxSimpleLoopSession` as the only state transition authority.

### 2) `packages/shared-services/src/ringcxActiveCallCaptureService.js`

1. Keep matching logic shared; do not add new local matcher in the loop.
2. Keep scoped read order stable:
   1) externalId exact
   2) agent-scoped
   3) account-scoped
3. Return minimal fields needed for auto-advance:
   - `queueItemId`, `caseId`, `externId`, `uii`, `agentIdentity`, `callState`, `disposition`, `changedAt`.
4. Add/keep a clear signal for “no active owned call” vs “scoped reads succeeded but unmatched”.

### 3) `packages/shared-models/src/CxSimpleLoopSession.js`

1. Keep structure minimal for today:
   - `session.current` single object
   - `session.buffer` array (mirrored/pending/active/completed markers)
   - `session.completed` array
   - `session.stats.captureMisses`, `session.stats.autoAdvances`
   - optional `session.staleSince`
2. Do not add fields for legacy queue behavior (`servedQueue`, `selectedLead`, `nextDial`).

### 4) `apps/control-plane/src/routes/commandsCx.js` and `apps/control-plane/src/routes/readCx.js`

1. Keep route surface thin:
   - add pass-through handlers for start/get/advance/disposition/skip/kill.
2. Do not compute call state in route layer.
3. In command path, only validate allowlist and call service.
4. In read path, return the session snapshot only; no derivation from old queue state.

5) `apps/control-plane/src/routes/cxSimpleLoop.js` (or existing simple-loop route file)

1. Ensure each route uses only one service call:
   - `/session/start`, `/session`, `/session/advance`, `/session/disposition`, `/session/skip`, `/session/kill`.
2. Add local-only kill/reload guard logs and keep legacy CX routes untouched.

### 5) `apps/web-client/src/workspaces/cx/CXWorkspace.tsx` and API query hooks

1. When simple-loop replacement flag is enabled for allowed agent:
   - render current from `cxSimpleLoopSession.current` only.
   - disable legacy active truth reads (`agentstates.cxCall`, selected lead, nextDial) for current card.
2. Poll `/api/cx/simple-loop/session` frequently enough to track active swaps.
3. Keep terminal buttons routed to simple-loop disposition/skip endpoints.
4. Keep old workspace controls untouched for non-allowed agents.

### 6) `packages/shared-services/src/index.js` and `packages/shared-models/src/index.js`

1. Ensure exports are explicit and flat for the new service/model only.
2. Do not re-export legacy services through the simple-loop surface.

### 7) `tests/cx-simple-loop` (or `scripts/queue tests/` when you consolidate)

1. Keep tests in one folder and only assert current behavior:
   - start snapshot is deterministic.
   - one advance publishes at most one candidate.
   - capture auto-advances on active call change.
   - auto-advance does not fire two completions in one tick.
   - submit/skip complete exactly one current only.
   - stale current clear does not regress current.
   - kill clears current and runs drain/cancel.

### 8) Rollout steps in one pass

1. Keep existing production queue untouched.
2. Deploy Mickey-only replacement harness + flag.
3. Validate:
   - no terminal click required for RingCX auto-advancing no-answer.
   - card updates only on active-call evidence.
   - queue display no longer determines current call.
4. Keep as long as long enough to capture:
   - stable active card matching RingCX
   - single-complete-per-call
   - no old-call stranding
5. Only then map minimal concepts back into legacy loop.

This section is the file-by-file recipe for a smallest-risk, smallest-code run of the current plan in local Mickey mode.
