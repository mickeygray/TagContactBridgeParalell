# PhoneBurner Post-CX Rebuild Plan — 2026-07-12

## Objective

Use the Monday July inventory bridge as a measured migration boundary, prove the
PhoneBurner operating loop, then replace CX voice ownership with the existing
provider-neutral lead-delivery runtime. Keep cadence, Logics effects,
appointments, call memory, and coaching inputs where they are useful; remove CX
as the owner of queue construction, delivery, call completion, and refill.

No physical CX deletion occurs during this plan until the replacement path has
passed the named gates and Mickey approves deletion.

## Migration checkpoint

- Checkpoint name: `phoneburner-july-bridge-2026-07-13`
- Historical source window: July 1, 2026 00:00 Pacific inclusive through
  July 13, 2026 07:30 Pacific exclusive.
- Post-checkpoint new-arrival window begins at July 13, 2026 07:30 Pacific
  inclusive.
- The boundary is a source receipt timestamp, not the physical last contact to
  finish posting.
- The fixed preload/packet key and provider-neutral item ledger prove which
  historical rows were assigned, accepted, pending, failed, or conflicted.
- A pre-checkpoint lead may reappear only through the cadence due-work path. It
  must never reappear as a new arrival.

## Parallel track A — remove CX voice ownership

1. Inventory every CX writer and read dependency.
2. Classify each dependency as:
   - disable now;
   - retain temporarily as migration evidence;
   - move behind a provider-neutral adapter;
   - pending deletion after proof.
3. Keep one owner for each task:
   - `leadDeliveryService` decides callability, pool, fairness, assignment,
     packet, completion state, and re-up timing;
   - `leadDeliveryRepository` stores and atomically changes state;
   - the PhoneBurner client transports contacts and reads provider evidence;
   - the callback route authenticates and captures provider events;
   - Logics/appointment adapters perform declared downstream effects.
4. Hard-gate legacy CX cadence, hot-lane, bulk-load, appointment queue,
   morning-builder, first-touch, and direct-feeder voice writers before any new
   PhoneBurner owner is action-capable.
5. Replace CX-specific appointment queue ownership with a provider-neutral
   appointment effect while retaining the canonical appointment record.
6. Retain old CX collections read-only only where they supply migration evidence
   needed to prevent DNC, answered, appointment, or daily-attempt mistakes.
7. After the controlled rollout proves the replacement, mark the gated files and
   symbols pending deletion and request Mickey's approval for physical removal.

### CX retirement map

- Disable now: the direct four-agent feeder task/script and legacy PhoneBurner
  rotation. The RingCX service startup gate also keeps cadence, fresh-hot,
  morning builders, pacing/UCQ, stale-dial maintenance, and agent-release
  workers dark whenever provider-neutral lead delivery owns voice.
- Contain next: direct reads of `CxAppointment`, `CxTerminalOutbox`, CX-only call
  logs, `counterCadence.*Cx*`, `cadenceState.channelDnc.cx`, and
  `payloadSnapshot.cxAppointment` behind one neutral source-evidence adapter.
- Replace next: the control-plane handlers that call CX-named Logics status,
  appointment, and wrap-card services. Keep the effects, but inject neutral
  DNC, appointment, and review ports.
- Retain temporarily: the appointment model/UI and terminal outbox until the
  final CX overlap window is reconciled and drained.
- Disable after drain: startup CX reservation reconciliation, terminal-outbox
  draining, lane timers, boring pollers, caller-ID/account watchers, and CX
  mutation routes. Recording/coaching reads are a separate product decision.
- Pending deletion after full-day proof and approval: `CxDialQueue`, UCQ/
  `QueueItem`, `AgentSlice`, bulk sessions, queue/reservation/serving services,
  and feeder scripts.

## Parallel track B — proof suite

### Checkpoint and replay

- Half-open source window includes the final pre-cutoff timestamp and excludes
  the exact cutoff.
- Equal-timestamp ties are deterministic and neither lost nor duplicated.
- The same fixed key resumes after crash, timeout, ambiguous POST, or 429.
- A different key cannot claim an item owned by the bridge.
- Partial runs remain partial; zero accepted work cannot report success.
- Final aggregate counts reconcile to the provider-neutral item ledger.

### New arrivals and cadence re-up

- New-arrival ingestion starts at the checkpoint inclusive.
- A pre-checkpoint row is not ingested again as new.
- A pre-checkpoint row due after two hours re-enters only through follow-up.
- Daily attempts are capped at three by Pacific call-start date.
- Posting does not count an attempt; an identity-backed call completion does.
- DNC, bad lead, appointment, client/payment, closed, and conflicting status
  evidence fail closed.

### Agent allocation and folders

- Newest new work wins without burying older callable work forever.
- Persisted least-served fairness survives restart and concurrent requests.
- Offline or unsubscribed agents cannot win.
- Fresh-lead protection expires after the approved window and then yields to
  speed.
- Shallow target, low-water trigger, exact deficit, and provider-wide pacing are
  independent rules.
- Five concurrent refill requests still create one serialized provider lane.

### Callback and downstream effects

- Contact, call, and disposition identities reconcile without phone matching.
- Duplicate hooks count one physical attempt.
- General call-done may be strengthened by a later disposition without recount.
- DNC/bad-lead produces the one approved Logics effect exactly once.
- Appointment with date produces the canonical appointment exactly once.
- Unknown or insufficient provider evidence remains reviewable and never
  invents a terminal result.
- A failed downstream effect retries without recounting completion or refilling
  twice.

## Rollout gates

### Gate 1 — Monday historical bridge

- All competing writers remain dark.
- Fresh live preview is balanced and clean.
- All configured folders validate.
- Every accepted contact is represented by one provider-neutral item.
- Pending, failed, conflicted, and backpressure counts are explicit.

### Gate 2 — first-pass reconciliation

- Reconcile the contacts agents consumed from the full folders.
- Prove provider callbacks carry the required authentication and stable IDs.
- Prove DNC and appointment effects on controlled examples.
- Do not enable refill merely because the folders drained.

### Gate 3 — post-checkpoint shadow

- Read new arrivals from the checkpoint without posting.
- Read due follow-ups from cadence independently.
- Compare expected pool, eligibility, fairness, and packet composition against
  real arrivals and completions.
- Require zero gaps, duplicates, fourth daily attempts, or offline winners.

### Gate 4 — controlled live flow

- Enable one agent first with target five and low-water one.
- Prove callback decrement and exact-deficit refill.
- Add agents one at a time.
- Roll back by turning the new writer/refill switches off; never delete state as
  rollback.

### Gate 5 — CX retirement

- Keep the CX read-only migration evidence until one stable full-day comparison
  passes.
- Produce the pending-deletion manifest.
- Physically delete CX voice machinery only after Mickey approves it.

## Current authority boundary

The Monday bridge is authorized. The post-checkpoint action-capable flow is not
yet authorized. Tests, shadow reads, hard gates, and provider-neutral refactors
may proceed; enabling posting, callbacks with actions, or automatic refill waits
for the Monday proof and Mickey's explicit approval.

## Monday execution evidence — 2026-07-13

- The one-shot automation was interpreted in UTC and began at 00:30 Pacific,
  earlier than the intended 07:30 Pacific wall-clock time.
- Its first fresh scan admitted and PhoneBurner accepted 2,230 contacts: 446 per
  agent, with zero pending, failed, conflicted, backpressured, or capped work.
- Folder validation passed before and after. Normal flow, callback actions, and
  refill remained off.
- A new read-only comparison after 07:30 found 2,246 eligible at the same formal
  cutoff. Therefore 16 eligible contacts were not part of the sealed 2,230
  batch. No catch-up write was made.
- The 16-contact difference is the first held catch-up set. It must remain
  separate while agents work the sealed batch, then be reconciled into the
  post-canary continuation/backfill flow without changing or duplicating the
  completed 2,230-contact checkpoint.
