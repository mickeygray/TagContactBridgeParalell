# CX Final Push Implementation Guide - 2026-07-08

This guide is for the final push implementation. Keep it boring. The goal is not architecture cleanup. The goal is phones ringing, outcomes draining, and no hidden machine judgment.

## Mission

Make the CX trunk behave like this:

1. 4001 intakes a fresh lead.
2. The app queues it as first contact.
3. 4001 forwards an audit signal to 6101.
4. 6101 generic first-touch dispatcher publishes it to RingCX using the configured agent order.
5. RingCX dials.
6. Poller matches by identity.
7. Terminal outcome drains.
8. Retry window or DNC/client status determines whether it returns.

No Sean drip. No quality guessing. No broad cleanup sweep. No local-only helper that becomes another owner.

## Non-Negotiables

- Mickey owns service restarts and `.env` changes.
- Do not restart `Parallel*` / NSSM services from Codex.
- Do not print secrets.
- Do not change app code and env in the same unproven sweep.
- Do not delete working legacy paths during this final push.
- Do not touch Fable's coach/two-station files unless Mickey explicitly moves that scope back here.
- Do not "unify" all phone normalizers during this push.

## Intended Ownership

There must be one dialing owner.

If 6101 is the owner:

- 6101 runs bulk runtime, lane dispatchers, poller/watchers, terminal drain, and wrap queue.
- 4001 only intakes and forwards first-contact audit signals.
- Local/dev boxes must not also write CX lifecycle state unless this is a deliberate local test.

If ownership changes, update this guide before patching.

## Patch Order

### 1. Freeze The Current Truth

Before code changes:

- `git status --short`
- list exact files intended for the patch
- note which box owns dialing
- note whether this is local-only, live-only, or both
- run the focused gate if time permits:

```powershell
node --test tests/cx-bulk-load/*.test.js tests/cx-handoff/cxDialQueueMediatorService.test.js
```

### 2. Verify The 4001 Forward

Find and preserve the current seam:

- Source: `packages/shared-services/src/inboundIntakeService.js`
- Config reader: `CX_FIRST_CONTACT_FORWARD_*`
- Receiver route on the dialing owner: `apps/ringcentral-cx/src/server.js`
- Endpoint: `/api/inbound/cx-first-contact-forward`

Required behavior:

- Forward is best-effort and logged.
- Forward failure must not block intake.
- Forward must not create duplicate queue rows.
- Receiver log must include enough masked identity to trace the case/queue item.

If more implementation is needed here, add logging first, then behavior. The first bug to avoid is silent no-dispatch.

### 3. Verify Generic First-Touch Lane

Use `packages/shared-services/src/cxFirstTouchDispatchService.js`.

Required behavior:

- Reads rows with `metadata.firstTouchPending=true`.
- Uses `CX_FIRST_TOUCH_QUEUE_MAP`, not Sean-only env.
- Round-robins through the configured map.
- Publishes `IMMEDIATE` during drip mode.
- In assign mode, only assigns rows for later morning build and does not publish.
- Releases claim on RingCX reject so the next tick can retry.

Do not use `cxSeanFirstTouchDripService` for final rollout. That service is a pilot artifact and should remain flag-off unless Mickey explicitly tests it.

### 4. Verify Appointments

Use the existing appointment lane dispatcher.

Required behavior:

- `CX_APPT_LANE_ENABLED=true`
- `CX_APPT_QUEUE_MAP` includes all intended agents.
- Due appointment publishes to the owning agent campaign.
- Appointment lane terminal outcome resolves the appointment and queue row.

No appointment should become generic bulk material unless that is a deliberate fallback.

### 5. Make Retry Timing Explicit

Fresh retry default is currently 90 minutes. That is acceptable.

For rollout clarity, prefer explicit env on the owner:

```text
RC_CX_GREEN_RETRY_DELAY_MINUTES=90
```

or:

```text
RC_CX_FRESH_RETRY_DELAY_MINUTES=90
```

Do not implement new timing logic unless the existing delay is not being enforced.

### 6. Audit The Eligibility Gate Before Changing It

The current gate blocks DNC/client/non-active-prospect style states. That matches Mickey's clarification if the categories are real:

- DNC / opt-out / stop-contact
- inactive cadence
- non-prospect Logics status
- paid/converted/client
- blocked lifecycle stage

Do not remove these blindly.

The only final-push change allowed here is to prevent destructive behavior on uncertainty:

- transient Logics/RingCX read failure -> retry/hold
- confirmed non-active prospect -> block

### 7. Keep Healing, Remove Judgment

Allowed:

- stale claim release
- terminal outbox retry
- poller recovery with hard evidence
- cycling past a jammed row
- waiting for retry window

Not allowed:

- cancel because a read failed
- clear current call because a snapshot was unavailable
- skip because lead "looks wrong"
- release dialed rows as no-show inventory
- route around the generic first-touch lane

### 8. Add Logging Before Any Risky Behavior Change

If anything is unclear, add logs before changing behavior.

Minimum logs for final push:

- 4001 sent forward: `first-contact.cx-forward.sent`
- 4001 failed forward: `first-contact.cx-forward.failed`
- 4001 skipped forward: `first-contact.cx-forward.skipped`
- 6101 received forward: `ringcentral.cx_first_contact_forward.received`
- first-touch dispatch tick: `control-plane.cx_first_touch.dispatch.tick`
- first-touch dispatched/rejected: `cx.alpha.firsttouch.dispatched` / `cx.alpha.firsttouch.dispatch.failed`
- appointment dispatch tick: `control-plane.cx_appt_lane.dispatch.tick`
- poller matched identity
- terminal outbox created/drained
- stale session rebind or stale button rejection

Logs should include case id, queue item id, lane, agent email, campaign id, and masked phone when available. No raw full phone numbers.

## Config Checklist For Mickey

Hand Mickey exact names only; he edits.

Owner box on:

```text
CX_DIAL_RUNTIME_BULK_LOAD_ENABLED=true
CX_FIRST_TOUCH_ENABLED=true
CX_FIRST_TOUCH_QUEUE_MAP=<set>
CX_APPT_LANE_ENABLED=true
CX_APPT_QUEUE_MAP=<set>
CX_CALL_WRAP_QUEUE_ENABLED=true
CX_SYSDISPO_CLASSIFIER_ENABLED=true
CX_TERMINAL_OUTBOX_DRAIN_ENABLED=true
CX_ACCOUNT_ACTIVE_CALL_WATCHER_ENABLED=true
RC_CX_GREEN_RETRY_DELAY_MINUTES=90
```

Source/intake box on:

```text
CX_FIRST_CONTACT_FORWARD_ENABLED=true
CX_FIRST_CONTACT_FORWARD_URL=<owner>/api/inbound/cx-first-contact-forward
CX_FIRST_CONTACT_FORWARD_SECRET=<set if receiver requires it>
```

Explicitly off unless testing:

```text
CX_SEAN_FIRST_TOUCH_TEST_ENABLED=false
CX_FIRST_TOUCH_WINDOW_MODE=
CX_BULK_RESERVE_PILOT_FAMILY=
```

Morning builder, if this owner builds queues:

```text
CX_MORNING_QUEUE_BUILDER_ENABLED=true
CX_MORNING_QUEUE_BUILDER_ALLOW_BROAD_DISCOVERY=false
CX_MORNING_QUEUE_BUILDER_RESPECT_PRESENCE=false
```

## Test Plan

Run in this order.

### Smoke 1 - Fresh First-Touch

1. Create or wait for one fresh callable intake.
2. Confirm 4001 forward sent.
3. Confirm 6101 forward received.
4. Confirm queue row has `metadata.firstTouchPending=true`.
5. Confirm first-touch dispatcher publishes to RingCX.
6. Confirm phone rings.
7. Disposition no-answer or voicemail.
8. Confirm terminal drains and row waits/retries according to 90-minute rule.

### Smoke 2 - Appointment

1. Create a due test appointment for a mapped agent.
2. Confirm appointment dispatcher publishes.
3. Confirm appointment modal/lane appears.
4. Disposition.
5. Confirm appointment and queue row resolve.

### Smoke 3 - Bulk

1. Build a normal bulk queue for one mapped agent.
2. Confirm RingCX accepted leads.
3. Work 3-5 calls.
4. Confirm poller match, disposition, terminal drain, and advance.

### Smoke 4 - Bad Number

1. Trigger Bad Number on a known safe test row.
2. Confirm DNC/cadence/logics side effects and alert path.
3. Confirm no retry as dialable.

### Smoke 5 - Jam Healing

1. Simulate or observe a stuck/stale row.
2. Confirm the machine releases/retries only with evidence.
3. Confirm active calls are not cleared from an unknown snapshot.

## Deployment Stop Points

Stop and ask Mickey before proceeding if:

- lane flags are on but queue maps are empty
- Sean drip is on
- 4001 forward is disabled while fresh lead routing depends on it
- 6101 receives forwards but dispatcher never sees rows
- RingCX accepts leads but poller does not match extern/UII
- fresh rows are cancelled instead of waiting retry
- more than one box is writing CX lifecycle state
- any proposed fix touches broad normalizers, caller ID, or unrelated coach code

## Final Acceptance

The patch is acceptable when:

- Fresh leads from 4001 are visible on 6101 and dial through RingCX.
- Appointments dial through their lane.
- Bulk queue still advances.
- DNC/client/non-active-prospect rows do not dial.
- Retry wait is enforced.
- All skips are logged with concrete reasons.
- No silent side drip or pilot-only path is responsible for production fresh leads.
