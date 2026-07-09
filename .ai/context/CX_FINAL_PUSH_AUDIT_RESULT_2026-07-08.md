# CX Final Push Static Code Audit Result - 2026-07-08

Read-only static audit of the seven surfaces in `CX_FINAL_PUSH_AUDIT_GUIDE_2026-07-08.md`, imported from the attached Fable report and normalized into a durable repo note.

No live box was touched by this audit. This proves what the code is wired to do. The live half - flag values, Mongo rows, current logs, and RingCX accept/reject behavior - is still required before calling the push certified.

## Headline

Static code result: clean. No confirmed lead-destroying path was found.

All seven surfaces are clean statically. Autonomous release/heal paths have hard-evidence guards. The one finding that looked dangerous - the poller clearing the current call without a real active-call snapshot - was hand-checked and refuted.

Important catch: the code defaults every dial lane off. That is floor-safe, but it means "phone keeps pushing" depends on the live box having the explicit enable flags set.

## Per-Surface Verdicts

| # | Surface | Verdict | Key evidence |
|---|---------|---------|--------------|
| 1 | First-contact forward, 4001 to 6101 | Healthy | `queueCxDialRequest` writes the Mongo row first and is awaited in `packages/shared-services/src/inboundIntakeService.js:2412`. The forward happens after that, fire-and-forget, so a forward failure cannot lose the lead. The 6101 receiver is audit-only at `apps/ringcentral-cx/src/server.js:2427`, logging `ringcentral.cx_first_contact_forward.received`. |
| 2 | First-touch and appointment dispatch | Healthy | Both lanes are gated by explicit flags plus non-empty queue maps. They publish lane extern ids (`cxft-` / `cxapt-`, not `cxbl`) with immediate priority and CAS-style claims to avoid double dispatch. Appointment rows are fenced out of ordinary bulk selection. |
| 3 | Bulk trunk, poller, drain, wrap | Healthy, verified | Active-call matching is extern/UII-first and explicitly not phone-guessing in `packages/shared-services/src/cxBulkLoadActiveCallWatcher.js:12`. Dispositions drain through the terminal outbox. Wrap is only for answered material, with connected evidence and the pickup guard. |
| 4 | Fresh retry and autonomous release/heal | Healthy | Fresh retry reschedules instead of cancelling. Release/heal paths are evidence-gated: no release on missing snapshot alone, no release of rows with placed-call evidence, and no permanent cancel on transient RingCX/Logics read failure. |
| 5 | Flag defaults | Floor-safe | Bulk load, first-touch, appointment lane, first-contact forward, Sean-only drip, broad discovery, and presence gating all default safe/off. Retry defaults to 90 minutes. |

## Refuted Finding

The scary finding was around `deriveCurrentRelease` in `packages/shared-services/src/cxBulkLoadActiveCallWatcher.js:181`: if the active-call read failed and looked empty, it might clear the middle panel/current call without proof.

That does not happen in the current code.

`packages/shared-services/src/cxAccountActiveCallWatcherService.js:609` catches the RingCX read failure and emits a no-mutation projection with `changed: false`; it then continues before the projection path. `projectBulkSessionFromAccountSnapshot` is only reached below that at `packages/shared-services/src/cxAccountActiveCallWatcherService.js:632` after a clean read.

So `deriveCurrentRelease` is never fed "empty because RingCX failed." It only sees a successful read that actually returned zero active calls. That makes the release proof legitimate, not the 2026-06-17-style footgun.

## Open Items The Static Audit Cannot Close

- Stale browser session behavior: a button on a dead/replaced server session can return a null/no-op style result. Server-side this is not lead-destroying, but the client should re-probe session state instead of silently letting the agent think a disposition landed.
- Appointment terminal drain: dispatcher wiring looks healthy, but a live proof should confirm terminal outcome resolves the appointment and drains the queue row.
- Congestion as `did_not_connect`: acceptable if it reschedules into the 90-minute retry window and does not starve the seat. Needs live confirmation under load.
- Live flag shape: because code defaults lanes off, the flag check is load-bearing.
- One owner: exactly one box should own dialing/queue lifecycle writes. Two boxes writing CX state is a stop condition.

## Required Live Check Before Certification

Verify by name only. Do not print secrets.

On the 4001 intake owner:

- `CX_FIRST_CONTACT_FORWARD_ENABLED=true`
- `CX_FIRST_CONTACT_FORWARD_URL` points to `/api/inbound/cx-first-contact-forward`
- `CX_FIRST_CONTACT_FORWARD_SECRET` present if the receiver requires internal service auth
- `CX_FIRST_CONTACT_FORWARD_TIMEOUT_MS` reasonable, current code clamps to 250-5000 ms

On the dialing owner:

- `CX_DIAL_RUNTIME_BULK_LOAD_ENABLED=true`
- `CX_FIRST_TOUCH_ENABLED=true`
- `CX_FIRST_TOUCH_QUEUE_MAP` contains the intended agent order
- `CX_APPT_LANE_ENABLED=true`
- `CX_APPT_QUEUE_MAP` contains the intended agent order
- `CX_SEAN_FIRST_TOUCH_TEST_ENABLED=false` or absent
- `CX_MORNING_QUEUE_BUILDER_ENABLED=true` only on the box that owns dialing
- `CX_MORNING_QUEUE_BUILDER_ALLOW_BROAD_DISCOVERY=false`
- `CX_MORNING_QUEUE_BUILDER_RESPECT_PRESENCE=false`
- `RC_CX_GREEN_RETRY_DELAY_MINUTES=90` or `RC_CX_FRESH_RETRY_DELAY_MINUTES=90`

Minimum live proof:

- Fresh first-touch: 4001 intake to 6101 receive to RingCX accept.
- Appointment dispatch: due appointment publishes, reaches the correct lane, resolves/drains.
- Bulk no-answer and voicemail: disposition accepted, terminal row drains, next lead advances.
- Answered call: connected evidence creates wrap card only for answered material.
- Bad number: DNC/cadence path fires and alert/email path is observable.
- Fresh retry: retry waits about 90 minutes instead of disappearing or immediately recycling.

Static verdict: clean. Live go/no-go rests on the flag shape, one-owner check, and minimum proof above.
