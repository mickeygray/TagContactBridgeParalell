# CX Final Push Audit Guide - 2026-07-08

This guide is for the final pre-patch and post-patch audit. It supersedes older rollout notes anywhere they conflict with the current goal:

Phone keeps pushing. New leads come in, first-touch and appointment lanes fire, bulk keeps dialing, and the machine only blocks for true non-prospect reasons or a defined retry window.

## Product Law

An active prospect is dialable.

Not active prospect means:

- DNC / opt-out / stop-contact.
- Converted/client/paid.
- Cadence is inactive because the lead was truly retired.

Acceptable machine decisions:

- Heal a jam.
- Cycle to the next lead when a row or call is stuck.
- Retry later when a fresh lead was already touched inside the configured retry window.
- Hold briefly when RingCX or Logics cannot be read, without destroying the row.

Suspicious machine decisions:

- "This lead looks low quality."
- "This status is weird, so cancel it permanently."
- "The UI/poller did not see the call, so erase the current call."
- "A fresh lead should sit in a side drip instead of the main lane."
- "Only one pilot agent should get new fresh leads."

## Main Surfaces To Audit

1. 4001 intake first-contact forward.
2. 6101 first-touch dispatcher.
3. 6101 appointment dispatcher.
4. Bulk-load runtime and poller.
5. Terminal outbox drain and wrap queue.
6. Fresh retry timing.
7. Autonomous release/healing jobs.

## Required Flag Shape

Verify by name only. Do not print secrets.

On the 4001 intake owner:

- `CX_FIRST_CONTACT_FORWARD_ENABLED=true`
- `CX_FIRST_CONTACT_FORWARD_URL` points to the 6101 receiver route:
  `/api/inbound/cx-first-contact-forward`
- `CX_FIRST_CONTACT_FORWARD_SECRET` is present if the receiver requires the internal service secret.
- `CX_FIRST_CONTACT_FORWARD_TIMEOUT_MS` is reasonable. Current code clamps to 250-5000 ms.

On the dialing owner:

- `CX_DIAL_RUNTIME_BULK_LOAD_ENABLED=true`
- `CX_FIRST_TOUCH_ENABLED=true`
- `CX_FIRST_TOUCH_QUEUE_MAP` is set and contains the intended agent order.
- `CX_APPT_LANE_ENABLED=true`
- `CX_APPT_QUEUE_MAP` is set and contains the intended agent order.
- `CX_SEAN_FIRST_TOUCH_TEST_ENABLED=false` or absent.
- `CX_MORNING_QUEUE_BUILDER_ENABLED=true` only on the box that owns dialing.
- `CX_MORNING_QUEUE_BUILDER_ALLOW_BROAD_DISCOVERY=false`
- `CX_MORNING_QUEUE_BUILDER_RESPECT_PRESENCE=false` unless Mickey explicitly changes the rule.
- `RC_CX_GREEN_RETRY_DELAY_MINUTES=90` or `RC_CX_FRESH_RETRY_DELAY_MINUTES=90` if the default should be made explicit.

Clock note:

- If the natural 8-5 / 5-6 / after-hours clock is desired, leave `CX_FIRST_TOUCH_WINDOW_MODE` unset.
- If testing needs immediate live first-touch dispatch outside the window, set `CX_FIRST_TOUCH_WINDOW_MODE=drip` for the test and remove it after.

## First-Contact Forward Audit

The source path is in `packages/shared-services/src/inboundIntakeService.js`.

Expected 4001 behavior:

- A freshly intaked callable lead calls `queueCxDialRequest`.
- The payload has:
  - `requestedBy: "intake-first-contact"`
  - `actionKey: "first-cx:<caseId>"`
- If forward is enabled, 4001 posts a notification to 6101.
- Log on success: `first-contact.cx-forward.sent`
- Log on failure: `first-contact.cx-forward.failed`

Expected 6101 receiver behavior:

- Route on the dialing owner: `apps/ringcentral-cx/src/server.js`
- Endpoint: `/api/inbound/cx-first-contact-forward`
- Log on receive: `ringcentral.cx_first_contact_forward.received`
- Current receiver accepts and logs. It does not create a duplicate queue row.

Why this is okay:

- The shared Mongo row was already created by `queueCxDialRequest`.
- The forward is the audit signal that 4001 reached 6101.
- The 6101 dispatcher reads `CxDialQueue` and publishes stamped rows.

If the phone is quiet, check in this order:

1. Did 4001 log `first-contact.cx-forward.sent`?
2. Did 6101 log `ringcentral.cx_first_contact_forward.received`?
3. Does Mongo have a row for the case with `metadata.firstTouchPending=true`?
4. Did 6101 log a first-touch dispatcher tick?
5. Did RingCX accept or reject the batch?

## First-Touch Dispatch Audit

Dispatcher: `packages/shared-services/src/cxFirstTouchDispatchService.js`

Expected:

- `CX_FIRST_TOUCH_ENABLED=true`
- Queue map is non-empty.
- Pending rows have:
  - `metadata.firstTouchPending=true`
  - `metadata.firstTouchDispatch=null`
  - `metadata.firstTouchAssignment=null` for live drip
  - `state` is `queued` or `ready`
- Dispatcher publishes with `dialPriority: "IMMEDIATE"`.
- Extern id starts with the lane form, not a bulk `cxbl` id.

Healthy logs:

- `control-plane.cx_first_touch.dispatch.tick`
- `cx.alpha.firsttouch.dispatched`
- `cx.alpha.firsttouch.dispatch.failed` only with a clear RingCX reject/error.

Red flags:

- `empty-queue-map`
- `flag-off`
- `hold-window` during a time Mickey expects live dialing
- rows stuck with `firstTouchPending=true` and no dispatch attempt
- `CX_SEAN_FIRST_TOUCH_TEST_ENABLED=true`

## Appointment Dispatch Audit

Expected:

- `CX_APPT_LANE_ENABLED=true`
- `CX_APPT_QUEUE_MAP` is set.
- Due appointments publish to the owning agent's mapped campaign.
- Appointment calls show the appointment modal/card lane, not ordinary bulk UI only.

Healthy logs:

- `control-plane.cx_appt_lane.dispatch.tick`
- lane extern resolves as appointment material
- terminal outcome resolves the appointment and drains its queue row

Red flags:

- unmapped agent skips
- appointment due but no dispatch tick
- appointment publishes as bulk material

## Bulk Dial Trunk Audit

Expected:

- Agent has a running bulk session.
- RingCX campaign has accepted leads.
- Poller matches by strong identity, not phone guess.
- No-answer, voicemail, bad number, answered, congestion, and system dispositions all drain.

Healthy evidence:

- poller match with extern/UII
- disposition probe sent/accepted
- terminal outbox row created
- drain marks row drained
- wrap card only for answered material

Red flags:

- stale browser session id differs from server running session
- middle card shows old lead after server has moved on
- button action targets killed/replaced session
- poller clears current without known active-call snapshot

## Fresh Retry Timing Audit

Fresh retry default is currently 90 minutes.

Audit:

- Explicit env is preferred for rollout: `RC_CX_GREEN_RETRY_DELAY_MINUTES=90` or `RC_CX_FRESH_RETRY_DELAY_MINUTES=90`.
- Confirm a no-answer fresh row does not immediately recycle ahead of its retry window.
- Confirm the row is not cancelled. It should wait and return.

Red flags:

- fresh lead disappears permanently after a retry outcome
- retry is much shorter than 90 minutes without Mickey asking
- retry is much longer than expected and starves dialing

## Autonomous Release / Healing Audit

These are acceptable if they heal jams and keep dialing moving:

- expired claim release
- stale serving release with hard evidence
- manual unavailable release after a timed break/hold
- terminal outbox drain retry

These are suspicious:

- release based on missing snapshot alone
- release of a row with `placedCalls > 0` as if it were undialed
- permanent cancel on transient Logics/RingCX read failure
- no-show cleanup that leaves RingCX copies in the absent agent campaign

Check flags:

- `RC_CX_RELEASE_EXPIRED_ASSIGNMENTS_ENABLED`
- `RC_CX_RELEASE_STALE_SERVING_ENABLED`
- `RC_CX_MANUAL_UNAVAILABLE_RELEASE_ENABLED`

If enabled, the audit question is not "is it autonomous?" The question is "does it heal a jam with evidence, or does it cause the jam?"

## Stop Conditions

Stop the patch/test and escalate if:

- 4001 queues a fresh lead but neither forward nor first-touch dispatcher logs appear.
- 6101 first-touch dispatcher skips with `empty-queue-map` or `flag-off`.
- New leads land in Sean-only drip instead of the generic first-touch lane.
- RingCX accepts leads but poller does not match by extern/UII.
- A stale snapshot clears an active call.
- A transient Logics/RingCX error cancels a lead.
- A no-show/release flow touches dialed rows.
- Two boxes are both actively writing CX lifecycle state.

## Minimum Test Proof

Before declaring final push healthy, collect one example each:

1. New first-touch lead from 4001 to 6101 to RingCX.
2. Appointment lane dispatch and terminal drain.
3. Ordinary bulk call no-answer or voicemail.
4. Answered call creating wrap material.
5. Bad Number button marking DNC/cadence and alert path.
6. Fresh retry waits, not disappears.
