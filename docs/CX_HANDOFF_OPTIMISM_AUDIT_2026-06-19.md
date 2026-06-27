# CX Handoff Optimism Audit - 2026-06-19

This is the archaeology note for the question: did we accidentally disable the optimistic / joint-send handoff that used to make CX feel fast, or was it pulled back while fixing drift?

## Scope

This audit is based on:

- Git history and code diffs from late May through `0.1.9`.
- Patch docs currently in the repo.
- The current Codex thread context around the June 17-18 live tests.

It is not a claim that every historical chat message from the last few weeks has been read. If a full chat export exists, it should be checked separately before treating this as the complete human-decision timeline.

## Short Answer

There are two separate concepts that got blended together:

1. Backend joint-send / `nextDial`: submit the disposition and send the next RingCX dial in the same request.
2. Client optimistic active staging: immediately render the next lead as the active call card before RingCX confirmation has fully landed.

The current live-safe target should be:

- Keep backend `nextDial` on.
- Keep strict confirmation on.
- Do not stage the next lead as active until a confirmed call identity or confirmed serving row exists.
- Render a pending handoff shell while waiting so the agent sees movement without getting live buttons for an unconfirmed lead.

That is not "no optimism." It is "optimistic transport, conservative active render."

## Evidence Timeline

### 2026-06-02: Optimism was already supposed to be narrowed

`docs/PATCH_QUEUE_2026-06-02.md` says:

> Keep the optimistic next-lead handoff in the queued/unconfirmed lane unless RingCX returns an actual UII/session id or explicit `confirmedCall`. Do not stage the next lead from `activeCallCapture.ok` alone.

That means the desired direction was not instant active staging from weak proof. It was already: queued/unconfirmed display is acceptable; active call render requires UII/session/confirmedCall.

### 2026-06-10: Both `0.1.2` commits had the fast joint-send shape

The two `0.1.2` commits are:

- `f5ff66b` - `0.1.2 coach uniformity patch`
- `5ec9e1f` - `0.1.2 cx vm / mini memory`

In both versions, the main `submitQueueDisposition` path did not have a `deferNextDial` option. It always tried to prepare the next lead:

```ts
const nextQueueLead = pickNextCallHandoffLead();
const nextDial = buildNextCallHandoffPayload(nextQueueLead);
```

Then, when the backend result said the next dial was accepted/confirmed, the client immediately staged the next lead:

```ts
if (nextDialAccepted) {
  if (nextQueueLead) {
    stageNextCallHandoffLead(nextQueueLead);
  }
  toast("Next call sent", {
    description: "RingCX confirmed the next queue lead.",
  });
}
```

This is the strongest repo evidence for the memory that the handoff used to feel fast. The faster shape was present in `0.1.2`: disposition plus next dial were bundled, and the UI moved forward on accepted/confirmed next-dial results.

### 2026-06-11: `0.1.4` still deferred next dial by default

In `990dc36` (`0.1.4 Individual VMS / Coach guide v1`), `CXWorkspace.tsx` introduced the defer gate and defaulted it to on:

```ts
const shouldDeferNextDial = options.deferNextDial ?? true;
const nextQueueLead = shouldDeferNextDial ? null : pickNextCallHandoffLead();
```

And VM explicitly called:

```ts
submitQueueDisposition("did-not-answer", "Voicemail", {
  deferNextDial: true,
  autoServeDelaySeconds: DISPOSITION_NEXT_LEAD_DELAY_SECONDS,
});
```

So `0.1.4` was not the globally-on backend joint-send version. It had the staging machinery, but default call disposition did not automatically attach the next dial.

The important correction is: `0.1.4` did not merely preserve an already-deferred model. It appears to be the point where the `0.1.2` default joint-send behavior was turned into an opt-in path.

### Chat evidence around `0.1.4`

The local Codex session log has compacted June 11 chat context. The cleanest reading is:

- Immediately before the `0.1.4` patch, the visible asks were mostly about coach uniformity, gRPC/coach health, voicemail routing, and moving the voicemail implementation from barge toward disposition-based behavior.
- The user explicitly noted the new direction: voicemail was now disposition-based and the barge approach was going away.
- I did not find a direct pre-`0.1.4` user complaint saying the normal answer/no-answer joint-send handoff was bad and should be turned off.
- After the patch, there is clear chat evidence of CX trouble:
  - larger flicker/desync/day restart/slow loading,
  - "12 seconds is way too long",
  - buttons for voicemail/no-answer flickering,
  - app trying to change between people,
  - VM drop timing causing brief desync,
  - errors about needing to disposition the previous thing.
- The post-patch diagnosis in chat pointed at two concrete problems:
  - RingCX disposition timeout on VM DROP dispositions was `300`, creating long `activity-dispositioning` deferrals.
  - Anti-jitter guards were blocking the backend next-dial restore for Sean, causing call ringing / blank screen.

So the chat supports: there really was handoff/flicker trouble in the area. It does not clearly support: "turn off backend nextDial globally" as the intended fix. The evidence looks more like the `0.1.4` defer gate was introduced while solving voicemail/disposition timing and jitter, and it swept the regular fast joint-send path into a more conservative default.

### Older client staging did exist

In the older path, once `nextDialAccepted` returned true, the client did:

```ts
stageNextCallHandoffLead(nextQueueLead);
toast("Next call sent", {
  description: "RingCX confirmed the next queue lead.",
});
```

It also used:

```ts
preserveCurrentLead: nextDialAccepted
```

That helped the UI feel fast, but it is exactly the family of behavior that can produce missing buttons, queue reappears, or wrong-card timing if the backend's "accepted" signal is ahead of the actual active call identity.

### 2026-06-15: Tracey -> Veronica diagnosis pointed at premature clears and weak staging

`docs/cx-handoff-tracey-veronica.PLAN.md` diagnosed:

- a missing-UII clear path that could clear an active CX call,
- EX presence as an amplifier rather than primary cause,
- client auto-stage accepting whatever polled serving item appeared after an optimistic eject.

It recommended:

- track the disposed lead and backend next-dial handoff token,
- only auto-stage when the served item is the confirmed handoff target,
- otherwise show "finishing previous call."

That aligns with pending shell / confirmed promotion, not blind active staging.

### 2026-06-17: Strict confirmation became the anti-drift line

`ringcxDialExecutionService.js` now treats strict confirmation as the thing that blocks UI drift:

```ts
RINGCX_CAMPAIGN_REQUIRE_ACTIVE_CALL_CONFIRMATION=true
```

forces:

```ts
captureAsync = false
```

under that mode. This is intentionally slower, but it prevents the endpoint from returning success before UII confirmation when strict mode is enabled.

That means the current "slow but stable" posture is not accidental. It is the safety rail that replaced async optimistic confirmation after the flicker/desync reports.

### 2026-06-18: `0.1.9` keeps backend joint-send on but pulls back active staging

Current `0.1.9` has:

```ts
const shouldDeferNextDial = options.deferNextDial ?? false;
```

So backend `nextDial` is on by default now.

But after `nextDialAccepted`, it does not immediately call `stageNextCallHandoffLead(nextQueueLead)` in the main disposition path. Instead it:

- releases the current lead,
- holds auto-serve for backend next dial,
- shows a waiting transition,
- waits for confirmed restore / serving state.

This is the thing we intentionally landed after observing:

- next lead disappeared from queue,
- reappeared in queue,
- then dialed,
- but disposition buttons were missing.

## What Was Turned Off

Not turned off:

- backend `nextDial` / joint-send is on in `0.1.9`;
- strict confirmation is on;
- async capture is off under strict mode;
- canonical strict gate remains off.

Pulled back:

- immediate active rendering of `nextQueueLead` from the disposition response in the main path.

So the thing that changed is not "nextDial got disabled." It is "nextDial stayed on, but active-card optimism was removed until confirmation."

## The Likely Historical Confusion

The app may have felt fast when either:

- backend next dial was explicitly enabled for a specific path, or
- the client staged the next lead immediately after `nextDialAccepted`, or
- auto-serve/polling restored the next lead quickly enough that it felt like one smooth handoff.

But repo evidence says `0.1.4` did not globally default to backend joint-send. So if the floor experienced a working fast mode around then, it was probably path-specific, flag-specific, or coming from quick auto-serve rather than the exact current global default.

## Patch Law For This Area

Do not silently disable a flag or behavior that was enabled in-session or already running live.

For CX handoff patches, every PR / patch note should state explicitly:

- Is backend `nextDial` enabled?
- Is client active staging enabled?
- Is strict confirmation enabled?
- Is async capture enabled?
- Is canonical strict gate enabled?
- What exact UI state is shown between disposition submit and confirmed next call?

If any of those change, the patch must include the reason, expected symptom improvement, rollback flag, and what log proves it.

## Recommended Next Implementation

Do not go back to raw active optimism. Implement the pending shell version.

### Desired Loop

1. Submit disposition for current lead with `nextDial`.
2. Immediately clear/lock current form and show a pending handoff shell.
3. Keep the next lead removed from the visible queue while pending.
4. Wait for confirmed next call identity:
   - UII,
   - confirmedCall,
   - confirmed serving row,
   - or canonical call state once strict gate is ready.
5. Promote pending shell to active lead and enable buttons.
6. If confirmation fails, restore queue / show retry without staging active controls.

### Minimum State Object

```ts
type CxPendingHandoff = {
  phase: "pending-handoff";
  handoffId: string;
  previousQueueItemId: string;
  nextQueueItemId: string;
  agentExtensionId: string;
  startedAt: string;
  status: "submitted" | "accepted" | "confirming" | "confirmed" | "failed";
  confirmedUii?: string;
  failureReason?: string;
};
```

The UI should render from this shell instead of juggling:

- selected lead,
- form values,
- served queue key,
- active serving queue item,
- current call,
- auto-serve timers,
- queue hydration.

## What To Measure Tomorrow

Use existing timing logs:

- `queue_handoff.submit`
- `queue_handoff.response`
- `queue_handoff.uii_observed`
- `queue_handoff.restore_serving`

Add one server-side `handoffId` to connect those events. Then measure:

- submit -> response,
- response -> UII observed,
- UII observed -> active UI render,
- terminal button -> next call visible,
- number of cases where pending shell failed or restored.

## Opinion

The correct next step is not a rollback to a vague older optimistic mode. It is a shaped optimistic mode:

- backend joint-send stays on,
- visible queue removes the selected next lead immediately,
- active card waits for proof,
- buttons remain disabled until proof,
- errors become pending-state text rather than disruptive alerts.

That is the closest version to the thing that felt fast while preserving the safety lesson from the recent flicker/desync bugs.
