# CX Boring Webhook Runtime

Date: 2026-07-10

## Decision

RingCX owns the agent call flow, queue, hang-up, and disposition. Boring is a read model plus
business-integration bridge. It does not advance calls and does not offer normal call-outcome
buttons.

## Runtime Contract

1. RingCX POSTs a signed event to `/api/cx/ringcx-web-service-canary`.
2. The route writes the safe capture, updates durable call memory, and enqueues any business
   action using Mongo only.
3. The route returns HTTP 200 even if normalization/processing fails after the raw capture.
   Logics, appointment, and cadence latency can never hold a RingCX agent session open.
4. A separate worker drains durable actions with retry/backoff.
5. Boring's existing one-second session poll reads `cx_boring_call_memory`; it never owns the
   RingCX queue or creates an app-side lead count.
6. A small account active-call poll updates display memory when an ACTIVE webhook is late. A
   confirmed disappearance clears display memory only; it never infers or writes an outcome.

## Outcome Mapping

- DNC, Bad Lead, Bad Number, Wrong Number -> one `logics_dnc` action.
- Appointment with date/time -> existing `createCxAppointment` service.
- Appointment without date/time -> one appointment-only Boring wrap card.
- No Answer, Busy, Congestion, Intercept, Voicemail -> cadence timestamp/action.
- Answered and Client -> call memory only; no invented case-land action.

Every durable action is keyed by RingCX UII plus action type. Duplicate webhooks are harmless.
A completed UII cannot reopen from a delayed ACTIVE webhook.

## Gates (all default off)

```text
CX_BORING_WEBHOOK_ENABLED=true
CX_BORING_WEBHOOK_ACTIONS_ENABLED=true
CX_BORING_WEBHOOK_CAMPAIGN_IDS=2306
CX_CALL_WRAP_QUEUE_ENABLED=true
CX_CALLER_ID_ROTATION_ENABLED=true
CX_CALLER_ID_ROTATION_ARM=false
CX_BORING_CALLER_ID_DIAL_GROUP_IDS=1011,1067,1068
```

- `CX_BORING_WEBHOOK_ENABLED` enables call-memory projection and durable action enqueue.
- `CX_BORING_WEBHOOK_ACTIONS_ENABLED` permits the separate worker to call Logics/appointments
  and stamp cadence. Keep it false for capture-only proof.
- `CX_BORING_WEBHOOK_CAMPAIGN_IDS` is the exact signed-webhook allowlist. Start with Parallel Test.
- `CX_CALL_WRAP_QUEUE_ENABLED` is needed only for the appointment-time fallback.
- `CX_CALLER_ID_ROTATION_ENABLED` starts Boring's registered-pool worker. It cannot run unless
  `CX_BORING_WEBHOOK_ENABLED` is also true.
- `CX_CALLER_ID_ROTATION_ARM` permits campaign writes. Leave it false for the first dry-run.
- `CX_BORING_CALLER_ID_DIAL_GROUP_IDS` selects the agents Boring supplies from the registered
  master pool. The default is Sean, Brad, and Chris; Phil and Bruce are intentionally excluded.

The caller-ID worker uses `config/cx-caller-id-rotation-pools.json` as the sole registered-pool
source, holds one Mongo run lock per interval, updates every active campaign in an owned dial
group together, and reads each campaign back after a write. The manual shifter reads the same
pool file.

## Old Paths Hard-Gated by the New Runtime

When `CX_BORING_WEBHOOK_ENABLED=true`:

- `/api/cx/bulk-load/session` projects webhook call memory.
- `/api/cx/bulk-load/disposition` returns `410 ringcx-dispositions-only`.
- start/sync/get-leads/pause/resume/kill are read/no-op projections; direct RingCX feeder owns supply.
- the old account active-call watcher is disabled.
- old first-touch/appointment/Sean dispatch timers do not execute; the direct feeder owns loading.
- the web client hides Answer, No Answer, Bad Number, and Voicemail buttons.
- an appointment-only card displays only the date/time/timezone form.

## Pending Deletion After Proof

No code was physically deleted during the weed-whack pass. After Parallel Test and floor proof,
the following become deletion candidates:

- Boring `finishCall`, `recordCompleted`, and `recordReleased` terminal decision paths.
- Boring session adoption, local claim, cancel, reset, refill, and queue-count machinery.
- app-side disposition endpoint and outcome-button handlers.
- bulk active-call watcher ownership for the Boring mode.
- legacy lane dispatch timers superseded by the direct feeder.
- legacy `config/rcx-caller-id-pools.json`, superseded by the registered master pool.

Keep call memory, Logics workspace integration, appointment services, call notes, coaching, and
operational health surfaces.
