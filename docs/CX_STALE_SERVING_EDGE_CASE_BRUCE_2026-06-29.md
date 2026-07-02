# CX Stale Serving Edge Case - Bruce - 2026-06-29

Purpose: capture one live legacy edge case so the CX 2.0 queue/watcher work can reason about it without turning it into a broad live behavior patch.

## Short Read

This should not become a broad live/legacy behavior change by itself. It is the first observed instance of this exact shape, and legacy already recovered through stale-serving cleanup. It is still useful evidence for the new queue/watcher design because it shows why first-touch debt must depend on terminal proof, not just RingCX publish/capture.

## Observed Timeline

1. At `2026-06-29T18:03:37Z`, Bruce received case `130936` through queue item `6a3fe2e974fd3164e8338295`.
2. RingCX accepted/published the lead and the app captured UII `202606291403386100000154316253`.
3. RingCX later showed a `dequeueTime` on that UII at about `18:03:55Z`.
4. The app still had `agentstates.cxCall.phase = active` and the queue row held/serving, with no terminal outbox row and no disposition/hangup metadata.
5. At `18:12:05Z`, stale-serving cleanup released the row back to `ready` with `lastReleaseReason: stale-serving-timeout`.
6. Bruce then received a new lead normally at `18:12:56Z`.

## Interpretation

- This was not a failed publish/capture. The lead did reach RingCX and had a confirmed UII.
- It was a post-call cleanup miss: RingCX dequeued or auto-ended the call, but the app did not create a terminal/release fact at that moment.
- Do not infer outcome from this single case. It could be no-answer, customer hangup, intercept, or another RingCX auto result.
- Do not create a generic "missing current UII means terminal" rule. That can produce false no-answers during ordinary campaign pauses or read errors.

## What The Next Queue Pass Should Consider

1. Add a watcher-side diagnostic first:
   - `serving row has lastRingcxMonitorActiveCall.raw.dequeueTime`
   - no active RingCX call for that UII
   - no terminal outbox row for `queueItemId + uii`
   - row remains `serving` or agent `cxCall.phase` remains `active`
   - log elapsed age and recovery action.

2. For bulk/2.0 only, make the universal watcher able to produce a narrow terminal observation when proof is strong:
   - old UII was previously matched to a current queue row
   - RingCX now shows that same UII gone or dequeued
   - no button terminal intent exists
   - no newer UII has replaced it for the agent
   - the observation writes a durable `did_not_connect` or `auto_release_review` terminal/review row exactly once.

3. Keep the cleanup action separate from lead advancement:
   - release old app state from `active/serving`
   - write terminal/review proof if confidence is high enough
   - wait for RingCX proof of the next UII before rendering the next middle-section call.

4. If confidence is not high enough, do not terminalize. Shorten the stale-serving path only for the proven shape:
   - `dequeueTime present`
   - old UII no longer active
   - no terminal row
   - no active call for that agent.

## Guardrail

The lesson is not "auto-terminalize whenever the watcher sees no call." The lesson is:

```txt
previously matched UII
  + RingCX dequeue/gone proof
  + no terminal row
  + no replacement UII
  -> release stale app shell and optionally write a narrow terminal/review observation
```

This keeps the Bruce case from becoming a band-aid while still making the new queue system resistant to the exact stale-shell class we saw.
