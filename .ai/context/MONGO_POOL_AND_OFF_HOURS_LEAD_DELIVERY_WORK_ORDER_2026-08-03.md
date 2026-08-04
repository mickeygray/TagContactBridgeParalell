# Mongo Compute and Lead-Delivery Scheduling Work Order

Date: 2026-08-03

Status: PATCHES A/B DEPLOYED 2026-08-03 WITH IMMEDIATE GATES PASSED; NATURAL-BOUNDARY OBSERVATION OPEN; PATCH C LOCAL WIP HELD FOR PATCH G

Owner: Codex under Mickey's direction
Active lead-delivery phase: Phase 9 controlled-floor hardening

## 1. Objective

Make five coordinated operational repairs:

1. Bound and age out idle MongoDB driver connections used by the shared
   application runtime, beginning with the four long-lived Linux services.
2. Stop the provider-neutral lead-delivery runtime from rereading cadence and
   CaseProfile source data outside its Pacific delivery window while preserving
   exact callback processing and the scheduled floor close.
3. Stop the daytime source cursor from immediately starting another exhaustive
   active-cadence sweep after it reaches the end, while keeping new accepted
   leads and claim-time safety current.
4. Make the one-minute event recovery drain provider-scoped, index-aligned,
   bounded, and a true no-op for unchanged duplicate callbacks.
5. Consolidate the unrelated hourly/nightly workers so off-hours and weekend
   compute happens only in an explicitly named, persisted daily slot.

These repairs address different costs and must be proved independently:

- the pool repair reduces unnecessary Atlas connections and prevents one
  process from retaining a roughly 100-connection default pool;
- the tick repair removes weekday overnight source scans and repeated
  CaseProfile joins;
- the source repair removes repeated daytime full-population walks;
- the event repair prevents the lightweight after-hours path from becoming a
  new query-targeting offender;
- the scheduler repair removes duplicate and incorrectly timed bulk work that
  is outside the lead-delivery owner.

An adjacent Google Sheet retirement is authorized as a **separate git patch**
and may land immediately before these repairs. It is not a sixth repair in
this work order and must retain its own commit, tests, deployment evidence,
and rollback boundary. Patches A and B do not depend on it. Patch C must begin
by re-reading the scheduler call graph after that patch lands so it removes
only the owners that still exist and never recreates the retired Sheet path.

Neither repair disables Atlas continuous backup or changes the seven-day
point-in-time restore policy. Atlas `OplogFetcher` / `getMore` query-targeting
alerts are a separate managed-backup question for Atlas support.

## 2. Evidence Behind the Work

Read-only live inspection on 2026-08-03 found 174 established Atlas
connections owned entirely by the expected Linux application services:

| Service | Established connections |
| --- | ---: |
| control plane | 106 |
| inbound gateway | 27 |
| outbound gateway | 22 |
| AI bus | 19 |

The shared connector in
`packages/event-core/src/services/mongo.js` creates one Mongoose connection per
process, but it supplies only `dbName` and `serverSelectionTimeoutMS`.
Mongoose 8 therefore retains its large default pool. There is no evidence here
of an attacker or a loop repeatedly creating new Mongoose connection objects.

The control plane's observed 106 sockets are consistent with the driver's
default 100 application connections plus topology-monitoring sockets. Treat
that as strong evidence for an unbounded-default-pool explanation, not as proof
of a leak. `maxPoolSize` applies to a server pool and monitoring sockets remain
outside the application pool, so rollout documentation must not promise a
literal aggregate ceiling of `service count * maxPoolSize`.

Because this is the shared connector, the option change also applies whenever
RingCentral CX or a one-shot script uses this connector. The four long-lived
services are the measured rollout target, not the entire blast radius. Focused
tests must therefore prove the connector contract itself rather than assuming
only those four service entry points can consume it.

The frequent CaseProfile read was traced to this path:

```text
leadDeliveryRuntime minute tick
  -> cadence source readBatch(limit <= 250)
  -> leadDeliveryRepository.readSourceBatch()
  -> readCaseProfilesForSources()
  -> CaseProfile.find({ $or: [{ domain, caseId }, ...] })
```

`runTick()` currently has an early Pacific-weekend return but no equivalent
time-of-day boundary. On a weekday, source ingestion can therefore continue at
10:30 PM, 3:00 AM, and every other minute outside the delivery window.

The scheduled floor close is due at 17:30 Pacific. Its function has durable
per-agent completion markers, but it has no process-local same-date completed
fast path before configuration synchronization and close setup. After a close
finishes, later ticks can unnecessarily revisit close machinery.

## 3. Non-Goals

This work must not:

- change lead allocation, packet composition, fairness, daily attempt caps, or
  PhoneBurner folder policy;
- remove callback capture or discard a delayed exact Call End;
- turn EOD metrics into a second lead-delivery decision owner;
- add another scheduler, service, queue collection, or Mongo change stream;
- remove indexes, invoke broad `syncIndexes()`, or delete Mongo records;
- alter Atlas backup configuration;
- implement or bundle the Google Sheet phase-out into Patches A, B, or C;
- combine the separately discussed 20-minute-call conversion check or EOD
  payment/post-date repair into this infrastructure patch.

The conversion/payment cleanup should receive its own work order after these
compute boundaries are proven.

## 4. Fix One: Bounded Mongo Pools

### 4.1 Configuration contract

Add the following normalized values to shared configuration:

```text
MONGO_MAX_POOL_SIZE       default 20, allowed 5..100
MONGO_MIN_POOL_SIZE       default 0, allowed 0..MONGO_MAX_POOL_SIZE
MONGO_MAX_IDLE_TIME_MS    default 300000, allowed 60000..1800000
MONGO_MAX_CONNECTING      default 2, allowed 1..10
MONGO_WAIT_QUEUE_TIMEOUT_MS default 10000, allowed 1000..60000
```

Rules:

- Invalid, fractional, contradictory, or out-of-range values fail startup
  validation; they must not silently become unbounded.
- `minPoolSize` remains zero so idle services do not hold warm application
  sockets merely to satisfy a floor.
- `maxIdleTimeMS` closes unused sockets after the bounded idle period.
- The idle default remains safely above the one-minute runtime tick. A
  60-second idle timeout beside a 60-second query can create avoidable
  close/reopen churn.
- `maxConnecting` prevents a reconnect storm from opening many sockets at
  once.
- `waitQueueTimeoutMS` prevents a saturated smaller pool from turning into an
  indefinitely waiting request. Checkout timeout is a safe retryable service
  error and must be counted; it must not be swallowed or retried in a tight
  loop.
- `serverSelectionTimeoutMS: 5000` remains unchanged.
- The first rollout uses one global policy for all shared-connector consumers.
  Do not add service-specific environment knobs until evidence shows that one
  service needs a distinct limit.

The initial maximum of 20 is intentionally conservative: it moves the control
plane away from the 100-connection default without forcing it directly to a
single-digit pool. The exact aggregate depends on topology, active servers,
monitoring sockets, and actual checkout concurrency. If pool wait or timeout
evidence appears, adjust from measured concurrency rather than restoring an
unbounded default.

### 4.2 Code locations

Expected implementation files:

```text
packages/shared-config/src/index.js
packages/event-core/src/services/mongo.js
tests/config/mongoPoolConfig.test.js                 (new)
tests/event-core/mongoConnectionOptions.test.js       (new)
```

Implementation shape:

1. Shared config parses and validates the five policy values.
2. `connectMongo(config)` passes the normalized values to the existing single
   `mongoose.connect()` call.
3. Keep `connectionPromise` as the sole per-process connection owner.
4. Export a small pure pool-option resolver if needed for testing; do not add a
   second connection wrapper.
5. Safe health may expose only the numeric pool policy and connection state.
   It must not expose the URI, hostname, credentials, or topology members.
   Safe counters may include checkout timeout count and current configured
   bounds.

### 4.3 Proof gates

Focused tests must prove:

- defaults resolve to `20 / 0 / 300000 / 2 / 10000`;
- explicit valid overrides reach `mongoose.connect()` unchanged;
- invalid maximum, minimum greater than maximum, and invalid
  idle/connecting/wait-queue values fail closed;
- two concurrent `connectMongo()` callers still share one connection promise;
- `disconnectMongo()` resets the singleton for a later clean connection;
- `skipMongo` remains unchanged;
- health/config serialization contains no URI or credentials.

Run the focused tests plus existing authentication/service-runtime config tests
before considering deployment.

### 4.4 Live rollout and rollback

Restart one service at a time after the tested files are installed:

1. inbound gateway; verify local health and inbound acceptance;
2. outbound gateway; verify health and worker idle state;
3. AI bus; verify local health;
4. control plane last; verify health, callback intake, and lead-delivery safe
   state.

After each restart:

- confirm the unit is active;
- confirm its local health endpoint returns 200;
- wait at least one idle timeout and compare count-only connection ownership;
- check for server-selection, checkout-timeout, or wait-queue errors using a
  bounded masked journal window;
- do not perform a PhoneBurner write merely to test the pool.

Expected aggregate steady-state evidence is materially below the observed 174
connections, with no loss of health or event processing.

Rollback is configuration-first: restore the prior effective pool ceiling and
restart only the affected unit. Do not roll back by starting a second process
or pointing a service at a different database.

## 5. Fix Two: Off-Hours Lead-Delivery Tick Boundary

### 5.1 Governing rule

The delivery window remains 07:50 through 16:59:59 Pacific on business days.

Outside that window, the minute tick may do only work necessary to preserve
already-proven call facts and close the current floor:

- drain durable exact provider events;
- finish or retry the current date's scheduled 17:30 floor close;
- on a weekday, recover a prior-business-day close that durable markers prove
  incomplete, or prove was due for an already-in-scope agent but never marked,
  through one bounded, once-per-date audit;
- report safe runtime status.

It may not run:

- cadence source ingestion;
- `readSourceBatch()` or its CaseProfile join;
- physical Pool watchdog refill;
- watchdog supply refresh;
- day-start building before 07:50;
- productivity rebalance;
- fresh dispatch or provider contact creation;
- prior-day tombstone release before the morning operating tick.

### 5.2 Explicit tick modes

Add one pure mode resolver inside the lead-delivery decision owner. Suggested
result vocabulary:

```text
disabled
weekend_event_drain
preopen_event_drain
delivery_open
postwindow_event_drain
close_due
close_complete_event_drain
```

The exact labels may vary, but the behavior must be explicit and testable.

Mode behavior:

| Pacific state | Allowed work |
| --- | --- |
| weekend | exact event drain only; no scan, refill, posting, or close discovery |
| weekday before 07:50 | exact event drain; prior-business-close recovery only when the once-per-date durable audit proves it is required |
| 07:50 through 16:59:59 | existing full controlled-floor tick |
| 17:00 through 17:29:59 | exact event drain only; wait for close boundary |
| at/after 17:30, close incomplete | exact event drain plus bounded floor close |
| at/after 17:30, close completed | exact event drain only |

Callback HTTP capture remains independent and available at all times. Draining
an exact delayed Call End may persist its attempt/outcome, but downstream
refill/provider creation must continue to fail closed against the delivery
window.

The event consumer needs an explicit capacity-work gate. Today,
`processLeasedEvent()` can call `refreshAgentCapacity()` from
`onProviderCleanup`, use the legacy `local.needsRefill` lane, and call
`wakeImmediateFresh()` after it makes the Call End durable. In an off-hours
mode, all three capacity paths must be skipped while the exact attempt,
outcome, DNC/Bad Lead action, appointment state, and call-memory projection are
still completed idempotently. The next `delivery_open` watchdog repairs the
physical Pool deficit. Do not leave the event failed merely because its
off-hours capacity work was deliberately deferred.

### 5.3 `runTick()` ordering

Refactor `runTick()` without adding a second timer:

1. Return immediately when the runtime is disabled.
2. Resolve the Pacific tick mode once from the injected clock and existing
   delivery-window evaluator. Do not introduce a second contact-window policy.
3. In `delivery_open`, preserve the existing proven sequence: prior-close
   reconciliation, morning tombstone release, physical Pool watchdog, exact
   event drain, bounded day start, ingestion, productivity, and close status.
   Its event drain uses `allowProviderCapacityWork: true`.
4. In event-only modes, drain exact durable events with
   `waitForRefillCompletion: false` and
   `allowProviderCapacityWork: false`, then return.
5. In `close_due`, drain exact events with capacity work disabled, then call
   only the existing bounded floor-close owner. This lets a delayed Call End
   remove an `in_call` blocker before the close retry.
6. On the first weekday tick for a Pacific date, perform one bounded durable
   close audit. Use the previous Pacific **business** date, skipping Saturday
   and Sunday. Resume when a durable marker is incomplete, or when an agent
   already in scope at that close lacks the required completion marker. Never
   infer a missing Sunday close on Monday. Cache a conclusive audit result only
   in process memory; after restart, re-prove it from durable markers. A
   completed prior close returns to event-only mode without provider reads on
   later ticks, while an incomplete close retains the existing bounded
   retry/`Retry-After` contract until complete.
7. Move prior-day working-folder tombstone release to the first
   `delivery_open` tick. It calls `source.readOne()` and therefore must never
   run at 03:00 merely because the Pacific date changed. Re-read exact source
   eligibility immediately before any released item can be posted.
8. In every other off-hours mode, return without calling source, watchdog,
   productivity, capacity refresh, fresh dispatch, or provider-create paths.
9. Record `lastTickAt`, increment the safe tick counter, and expose the mode
   even when no source work ran.

Do not move allocation or eligibility decisions out of
`packages/shared-services/src/leadDeliveryService.js`.

### 5.4 Same-date close fast path

Before `runEndOfDayFolderDrain()` synchronizes agents or acquires Pool
operations, add a process-local fast path:

```text
if runtime date key == requested date key
and runtime close status == completed
then return already-completed without database/provider work
```

Restart safety must remain durable:

- After a process restart, in-memory close state is empty.
- The first due tick must still read the persisted per-agent close markers and
  finish or prove the close.
- Only after that proof may later same-process ticks use the fast path.
- A partial, failed, or contradictory close must never use the completed fast
  path.

### 5.5 Code locations

Expected implementation files:

```text
.ai/context/PHONEBURNER_PROVIDER_NEUTRAL_LEAD_DELIVERY_WORK_ORDER_2026-07-10.md
packages/shared-services/src/leadDeliveryService.js
tests/lead-delivery/leadDeliveryRuntime.test.js
tests/lead-delivery/leadDeliveryService.test.js        (only if the pure mode resolver is exported)
```

Record this compute boundary in the canonical Phase 9 work order before code.
No route, model, repository, scheduler, or service-unit file should be needed.

### 5.6 Proof gates

Extend the existing runtime harness with bounded counters for source reads,
agent synchronization, watchdog calls, productivity calls, provider creates,
and event drains.

Required focused tests:

1. **03:00 weekday:** one tick drains a pending exact event but performs zero
   source reads, CaseProfile-equivalent reads, watchdog work, productivity, or
   provider creates.
   If an explicitly incomplete prior-business-day close exists, the bounded
   close-recovery path may perform its exact repository/provider close reads,
   but it still performs zero cadence/CaseProfile reads.
2. **07:49 weekday:** no source read or provider create.
3. **07:50 weekday:** existing bounded morning launch runs once and retains its
   current proof.
4. **16:59 weekday:** exact event processing remains active under the normal
   open-window behavior.
5. **17:00 weekday:** no ingestion/refill/productivity/provider create.
6. **17:29 weekday:** close remains not due and source reads remain zero.
7. **17:30 weekday:** close runs and preserves the existing bounded deletion,
   two-zero-read, DailyDial persistence, and CallLog projection proofs.
8. **22:30 after completed close:** exact event drain remains active; source
   reads and close setup are zero.
9. **restart at 22:30 with an incomplete close:** persisted markers are read
   and the close resumes exactly once.
10. **03:00 after completed close:** no source ingestion and no repeated close.
11. **Saturday/Sunday:** no source/watchdog/refill/productivity/provider work;
    a delayed exact event can still be durably processed without posting.
12. **Pacific DST boundaries:** mode selection follows
    `America/Los_Angeles`, not server local time or UTC calendar dates.
13. **delayed terminal Call End:** it remains idempotent and cannot reopen or
    refill an off-hours contact.
14. **full regression:** existing morning launch, Call End, refill lock,
    productivity, and floor-close slices remain green.
15. **off-hours Call End:** the exact attempt and downstream non-capacity
    actions complete once, while folder counts, `refreshAgentCapacity()`,
    legacy refill, and immediate-fresh wake remain at zero; the 07:50 watchdog
    repairs the deficit.
16. **next-date tombstones:** they remain untouched at 03:00, are rechecked and
    released on the first `delivery_open` tick, and cannot post without a fresh
    source-eligibility read.
17. **Monday recovery:** Friday is the prior business close; no Sunday close is
    discovered, created, or retried.

The off-hours test must fail if `source.readBatch()` is called. Counting only
provider posts is insufficient because the defect is database churn before the
post guard.

### 5.7 Safe observability

Add only count/status fields to lead-delivery health:

```text
tickMode
offHoursTicks
sourceReadsSkippedOffHours
lastTickAt
lastErrorCode
```

Do not include case IDs, provider IDs, folder IDs, phone numbers, or source
rows.

### 5.8 Live rollout and rollback

This fix affects only `parallel-control-plane`.

After targeted deployment and the authorized control-plane restart:

- verify local health 200;
- verify the lead-delivery runtime is enabled and reports the expected mode;
- during an open window, prove the bounded morning/daytime path still ticks;
- after the window, prove source and CaseProfile query counters stop advancing
  while callback events remain processable;
- verify the 17:30 close either completes or safely resumes;
- observe Atlas query statistics through at least one overnight boundary.

Rollback is the prior `runTick()` implementation plus one control-plane
restart. No data rollback is required because this patch changes scheduling,
not document shape.

## 6. Fix Three: Bounded Daytime Source Reconciliation

### 6.1 Current defect

The current source reader is bounded per query but not bounded per business
day:

- `ingestOnce()` sets `sourceCursor` back to `null` as soon as a complete scan
  reaches the end;
- the next daytime tick therefore starts again from the newest active cadence
  row;
- while a continuation cursor exists, `readBatch()` also reads a separate hot
  head page, causing two cadence reads and two CaseProfile/appointment joins on
  one tick;
- the cadence query filters `{ domain, active }`, sorts by
  `{ createdAt: -1, _id: -1 }`, and has no declared compound index matching
  that exact filter and pagination order.

The off-hours boundary removes nighttime repetitions but leaves this daytime
full-population loop intact.

### 6.2 Two explicit source lanes

Keep one decision owner and separate the source work by purpose:

1. **New-arrival lane**
   - Accepted full leads continue through their existing durable intake and
     call-queue enrollment path.
   - Maintain a durable `(createdAt, _id)` high-water mark for crash repair.
   - The polling fallback reads only rows strictly newer than that mark; it
     never rereads an unconditional hot head.
   - Persist the high-water mark only after every row before it was safely
     admitted, refreshed, blocked, or durably classified for retry.
   - Equal timestamps use `_id` as the deterministic no-gap/no-overlap tie.
2. **Daily repair lane**
   - Run at most one exhaustive active-source reconciliation per Pacific
     business date.
   - Begin only after morning launch has supplied usable packets; repair may
     never gate the 07:50 availability deadline.
   - Continue in bounded pages during `delivery_open`, then persist completion
     and remain stopped until the next Pacific business date.
   - Store only a PII-free checkpoint key, cursor, status, counts, and
     timestamps in the existing provider-neutral checkpoint machinery. Do not
     add a new collection or scheduler.
   - A restart resumes an incomplete checkpoint and recognizes a completed
     checkpoint; it does not restart the whole population.

Every provider claim still calls the existing exact `source.readOne()` safety
recheck. A stale repair checkpoint can delay backend cleanup, but it can never
authorize a stale provider POST.

### 6.3 Query and index contract

Before changing indexes, perform read-only production proof:

1. `listIndexes()` on the relevant collections without printing collection
   contents;
2. count-only `explain("executionStats")` for the exact source and join shapes;
3. record winning stage, blocking-sort presence, keys examined, documents
   examined, rows returned, and input identity count only.

Required additive index for the active cadence pagination shape:

```text
{ domain: 1, active: 1, createdAt: -1, _id: -1 }
```

The declared CaseProfile unique index `{ domain: 1, caseId: 1 }` must be proven
to exist live. Schema declaration is not deployment proof because production
auto-indexing is not assumed.

Replace up to 250 individual CaseProfile `$or` point branches with one branch
per domain:

```text
{
  $or: [
    { domain: DOMAIN_A, caseId: { $in: [/* exact ids for A */] } },
    { domain: DOMAIN_B, caseId: { $in: [/* exact ids for B */] } }
  ]
}
```

Preserve domain/case pairing; never query `caseId` across tenants without the
domain branch. Apply the same grouping to active-appointment joins when their
identity shape matches.

Index rollout is additive and explicit. Do not call broad `syncIndexes()`:
that tool can drop live indexes not declared by the current model. Retain old
indexes through the proof window and list them as pending deletion only after
Atlas usage evidence and Mickey approval.

### 6.4 Expected files

```text
packages/shared-models/src/LeadCadence.js
packages/shared-repositories/src/leadDeliveryRepository.js
packages/shared-services/src/leadDeliveryService.js
tests/lead-delivery/leadDeliveryRepository.test.js
tests/lead-delivery/leadDeliveryRuntime.test.js
one narrow additive index command/script, if live index creation is required
```

### 6.5 Proof gates

Tests and count-only evidence must prove:

- a completed daily repair does not restart on the next minute tick;
- a restart resumes an incomplete repair and does not replay a completed one;
- a new lead received after repair completion is admitted through the
  high-water lane without waiting for tomorrow;
- equal-timestamp arrivals have no gap or duplicate;
- claim-time status/payment/DNC evidence can still block a previously admitted
  item;
- Saturday/Sunday run neither source lane automatically;
- the active-source query has no `COLLSCAN` and no unbounded blocking sort;
- the CaseProfile join uses the live `{ domain, caseId }` index and examines a
  bounded number of keys relative to input identities, including zero-result
  cases;
- one normal continuation tick performs one source page and one grouped join,
  not a continuation plus unconditional hot-head reread.

## 7. Fix Four: Indexed Event Recovery Drain

### 7.1 Governing distinction

Callback capture is the primary event trigger. The one-minute backlog query is
only crash/retry recovery.

- A newly inserted callback may schedule processing of that exact event ID.
- An unchanged duplicate callback is a successful no-op and must not launch a
  full backlog drain.
- If stronger evidence upgrades an existing event, schedule only that exact
  event.
- When `actionsEnabled !== true`, the automatic recovery tick returns before
  querying the backlog. Capture remains durable; an operator diagnostic may
  preview explicitly, but the minute timer may not reread work it refuses to
  process.
- Recovery queries are scoped to the runtime's exact provider.

This is separate from the off-hours capacity gate in section 5: exact event
effects can run after hours, but folder counts, refill, and fresh dispatch stay
disabled until `delivery_open`.

### 7.2 Recovery query shape

Replace the mixed three-branch `$or` plus global sort with three independently
bounded provider-scoped heads:

1. pending events ordered by `receivedAt, _id`;
2. failed events due by `nextAttemptAt`, then `receivedAt, _id`;
3. processing events with expired leases ordered by
   `processingLeaseExpiresAt`, then `receivedAt, _id`.

Merge only the returned heads in memory, order by oldest claimable event, and
process at most the existing global drain limit. Do not open an unbounded
cursor or fetch the full branch populations.

Required additive partial indexes:

```text
{ provider: 1, receivedAt: 1, _id: 1 }
  partial status == "pending"

{ provider: 1, nextAttemptAt: 1, receivedAt: 1, _id: 1 }
  partial status == "failed"

{ provider: 1, processingLeaseExpiresAt: 1, receivedAt: 1, _id: 1 }
  partial status == "processing"
```

Keep event identity/CAS and lease acquisition unchanged. An index or query
optimization may never weaken exactly-once processing.

### 7.3 Expected files

```text
packages/shared-models/src/LeadDeliveryEvent.js
packages/shared-repositories/src/leadDeliveryRepository.js
packages/shared-services/src/leadDeliveryService.js
apps/control-plane/src/routes/phoneBurnerLeadDelivery.js
tests/lead-delivery/leadDeliveryRepository.test.js
tests/lead-delivery/leadDeliveryRuntime.test.js
tests/lead-delivery/phoneBurnerLeadDeliveryRoute.test.js
one narrow additive index command/script, if live index creation is required
```

### 7.4 Proof gates

Prove all of the following:

- actions disabled means zero automatic backlog queries;
- an unchanged duplicate acknowledges successfully and performs zero drain
  queries;
- strengthened evidence schedules only the exact event;
- PhoneBurner recovery cannot lease another provider's event;
- empty, one-pending, one-due-failed, and one-expired-lease explains use the
  intended indexes with no `COLLSCAN` or unbounded blocking sort;
- a future failed retry and an unexpired processing lease are not returned;
- merging three bounded heads preserves oldest-ready order and the global
  limit;
- duplicate/lease/CAS tests still prove one effect per exact event;
- a normal batch of 50 does not get blamed for unrelated Atlas
  `OplogFetcher`/backup `getMore` evidence.

Index promotion follows the same additive, no-drop rule as section 6.

## 8. Fix Five: Off-Hours Scheduler Consolidation

### 8.1 Current overlap

The lead-delivery tick is not the only nighttime reader:

- the hourly sweep runs its heavier phase outside business hours; its
  `business-hours-lite` mode currently makes daytime lighter, not nighttime;
- that heavy phase includes CaseProfile/payment reconciliation,
  CallLog-to-CaseProfile repair, CX backfills, stale LeadCadence action
  discovery, spend synchronization, and recording work;
- stale scheduled-action discovery has no proven matching index and can scan a
  large cadence population while returning zero;
- spend synchronization and recording work each have another scheduled owner;
- nightly close invokes another high-cap hourly sweep;
- nightly-hygiene completion is process-memory-only and planning can perform
  reads even when the corresponding write switch is off;
- Logics activity review currently defaults to all seven weekdays;
- a separate EOD recording/backfill task must not remain a second weekend or
  duplicate owner.

These are plausible contributors to 22:30/03:00 spikes and must not be hidden
inside the lead-delivery fix.

### 8.1.1 Separate Google Sheet retirement boundary

The legacy Google Sheet runtime path is being phased out in a separate git
patch. That patch owns its own caller inventory, replacement-source contract,
tests, and rollout. It must not include Mongo pool changes, lead-delivery tick
changes, event-drain changes, or the broader scheduler consolidation described
here.

The separate patch must:

1. identify every scheduled, startup, route, report, and direct service caller
   of the Sheet-backed path before changing it;
2. establish the replacement authority for each retained business result
   before hard-gating its Sheet caller;
3. ensure configuration defaults and restart behavior cannot silently turn
   the retired path back on;
4. retain no second scheduled owner for work now supplied by the replacement;
5. follow the repository no-delete rule: hard-gate or disable the old path and
   leave physical deletion pending proof and Mickey approval unless that
   separate patch receives explicit deletion approval;
6. produce a post-patch call-graph snapshot that Patch C treats as its input.

Patch C must not restore a Google Sheet read merely to preserve the old
hourly-sweep shape. If a financial, reporting, or hygiene result still needs a
source after retirement, its replacement belongs to the separate Sheet patch,
not to scheduler consolidation.

### 8.2 Scheduler contract

1. **Weekend:** enforce the canonical Phase 9 weekend boundary. Automated
   workers may perform only accepted-lead first contact/enrollment and exact
   durable callback/outbox processing. No discovery sweep, report, hygiene,
   recording backfill, spend sync, Logics review, nightly close, RVM poll, or
   PhoneBurner work runs.
2. **Ordinary off-hours hourly tick:** drain only already-durable retry/outbox
   work whose exact owner requires prompt completion. Do not discover broad
   populations.
3. **Named daily work:** each bulk job has one owner, one explicit Pacific
   weekday slot, and one durable claim keyed by `(job, Pacific date)`.
4. **Restart:** a completed durable claim remains completed. An incomplete
   claim resumes its bounded cursor. A restart does not rerun every planning
   query or generate a catch-up burst.
5. **Disabled task:** skip its `plan()`/discovery reads as well as its writes.
   Preview happens only through an explicit operator request.

Specific ownership changes:

- remove spend sync from the generic hourly sweep; retain only its dedicated
  scheduled owner;
- choose one scheduled recording/backfill owner and disable the duplicates;
- make Logics activity review Monday-Friday only;
- make nightly close call only its required projection/close operations, not a
  second full hourly sweep;
- run stale scheduled-action cleanup once in a named daily slot, or redesign
  its query and add a matching index after count-only explain proof;
- persist nightly-hygiene claims before expensive planning and do not plan
  disabled tasks;
- leave the report scheduler unchanged unless its existing persisted run-key
  and weekend tests fail;
- retire or weekday-gate any Windows EOD task that duplicates the chosen Linux
  owner. Windows service/task mutation remains Mickey-owned.

Do not create a new scheduler framework. Narrow the existing owners and reuse
existing checkpoint/claim persistence.

### 8.3 Expected files

Final files depend on the verified call graph, but the known implementation
surface is:

```text
apps/control-plane/src/server.js
apps/control-plane/src/services/nightlyHygieneRuntime.js
apps/control-plane/src/services/logicsActivityReviewRuntime.js
apps/control-plane/src/services/nightlyCloseRuntime.js
apps/control-plane/src/services/eodRecordingArchiveRuntime.js
packages/shared-services/src/hourlySweeperService.js
packages/shared-models/src/LeadCadence.js                 (only if an additive stale-action index is proved)
the nearest focused control-plane scheduler/runtime tests
```

### 8.4 Proof matrix

Using an injected Pacific clock and bounded fake repositories, prove:

- weekday 03:00 and 22:30 ordinary hourly ticks perform no CaseProfile,
  LeadCadence, payment, spend, recording-discovery, CX-backfill, or reporting
  scans;
- Saturday and Sunday start none of the prohibited automated workers;
- each named weekday job runs exactly once in its slot;
- restart after a completed slot performs zero planning reads;
- restart during an incomplete job resumes its bounded cursor once;
- spend sync has one owner and recording/backfill has one owner;
- nightly close does not invoke a full hourly sweep;
- disabled hygiene work performs zero `plan()` calls;
- stale-action cleanup has count-only explain proof before its index is added;
- Monday resumes normally without replaying missed weekend work;
- safe health reports only job key, status, timestamps, counts, and reason
  codes; never customer rows or credentials.
- the post-retirement scheduler graph has no enabled Google Sheet caller and
  Patch C does not import, invoke, or re-enable one.

### 8.5 Rollout boundary

Deploy scheduler consolidation separately from the pool/lead-delivery patch so
its effect is measurable and rollback is narrow. Restart only
`parallel-control-plane` after its focused tests pass. Observe at least one
weekday overnight boundary and one weekend boundary before declaring the
compute policy proven.

Atlas continuous-backup `OplogFetcher`/`getMore` remains a separate managed
service actor. Application success is measured by application query shapes,
job counters, and explains; it does not promise that every Atlas backup alert
will disappear.

## 9. Implementation Sequence

Implement and roll out in separately measurable patches:

### Separate Patch G: retire the Google Sheet runtime path

This is the independent patch Mickey authorized for immediate work. It is not
part of Patch A, B, or C and must be committed and rolled back separately.

1. Inventory the exact Sheet-backed entry points and their scheduler/startup
   callers without reading or printing credentials or customer rows.
2. State the replacement authority for every retained output before disabling
   the corresponding Sheet path.
3. Add failing tests proving the retired path cannot run from a scheduler,
   restart, default configuration, or an obsolete direct caller.
4. Hard-gate the legacy implementation under the repository no-delete rule;
   do not mix in Mongo pool, lead-delivery, event-drain, or scheduler cleanup.
5. Run the focused replacement and caller tests, then commit and deploy this
   patch as its own unit.
6. Capture the resulting call graph and enabled-owner list. Patch C starts
   from this post-retirement evidence rather than from the pre-patch graph.

Patch G is not a prerequisite for proving Patch A or Patch B unless its actual
diff overlaps one of their files. It is a prerequisite for finalizing Patch C,
because scheduler consolidation must operate on the code that remains after
the Sheet owner is retired.

### Patch A: evidence and bounded pools

1. Record the new Phase 9 compute boundary in the canonical PhoneBurner work
   order before runtime code.
2. Capture count-only baselines for application-owned connections, query
   shapes, and scheduler runs.
3. Perform read-only `listIndexes()` and count-only explains for source,
   CaseProfile join, event drain, and stale-action query shapes.
4. Add failing pool-policy/connector tests, including idle and wait-queue
   settings.
5. Implement shared pool configuration and connector options.
6. Run focused pool/config/runtime tests.
7. Deploy and restart one long-lived Linux application service at a time in the
   section 4 order; control plane remains last.
8. Observe health, connection counts, checkout timeouts, and server-selection
   errors before advancing.

### Patch B: lead-delivery compute boundary

1. Add failing off-hours tests beginning with 03:00, 22:30, weekend, delayed
   Call End, and Monday/Friday close recovery.
2. Add failing daily-repair/high-water tests, including restart and
   equal-timestamp boundaries.
3. Add failing provider-scoped event-recovery tests, including actions-off and
   unchanged-duplicate zero-query assertions.
4. Add the proven cadence/event indexes through a narrow additive migration;
   verify them with count-only explains. Do not run broad index synchronization.
5. Implement the pure tick-mode resolver, capacity-work gate, same-date close
   fast path, first-open tombstone release, daily repair checkpoint, new-arrival
   high-water lane, grouped CaseProfile join, and three-head event recovery.
6. Run focused repository/runtime/route tests and the broader lead-delivery and
   control-plane wiring regressions.
7. Inspect the diff for any second scheduler, decision owner, secret, folder
   identifier, destructive index action, or unrelated cleanup.
8. Deploy only the proved control-plane files and perform one authorized
   `parallel-control-plane` restart.
9. Observe at least one open-window cycle, 17:30 close, weekday overnight, and
   weekend boundary before declaring Patch B proven.

### Patch C: scheduler consolidation

1. Re-inventory the post-Patch-G call graph and record the remaining enabled
   owners; do not assume the pre-retirement Sheet caller still exists.
2. Add the section 8 failing clock/restart/one-owner tests.
3. Narrow hourly, nightly-close, hygiene, spend, recording, and Logics-review
   owners without adding another timer framework.
4. Add only a proved stale-action index, if its retained query requires one.
5. Run the focused scheduler suites plus report, metrics, recording, and
   control-plane wiring regressions.
6. Deploy separately and restart only `parallel-control-plane`.
7. Observe one weekday overnight and one weekend. Compare application-owned
   operation counts to the baseline; report Atlas backup activity separately.

Do not combine rollback boundaries merely to save a deployment. Each patch
must be independently reversible and independently measurable.

## 10. Definition of Done

The work is complete only when:

- all four long-lived Linux services and tested shared-connector consumers use
  the bounded pool policy;
- aggregate application connections fall materially below the 174 baseline;
- no service health regression or Mongo wait/selection error appears;
- pool checkout timeouts remain zero or within an explicitly accepted measured
  retry budget;
- weekday overnight ticks perform zero cadence source batches and zero
  CaseProfile joins;
- exact callback capture and event drain remain available after hours;
- an off-hours Call End cannot count folders, refill, or wake fresh dispatch;
- the scheduled floor close still completes and restart catch-up remains
  idempotent;
- a completed close is not reprocessed every subsequent minute;
- a completed daily source repair does not restart each minute or after a
  process restart;
- new accepted leads still enter promptly through exact intake/high-water
  processing, with no timestamp gap or duplicate;
- the active-source and CaseProfile query plans use their intended indexes with
  no collection scan or unbounded sort;
- event recovery is provider-scoped, index-aligned, and unchanged duplicates
  perform zero backlog queries;
- the generic hourly worker is discovery-dark overnight;
- spend sync, recording/backfill, stale-action cleanup, Logics review, nightly
  hygiene, and nightly close each have one scheduled owner and one durable
  daily claim;
- disabled tasks perform no planning scans;
- weekend compute boundaries remain intact;
- the Google Sheet retirement remains a separately testable and reversible git
  patch, and the final scheduler graph neither invokes nor re-enables the
  retired path;
- no PhoneBurner contact, lead allocation, cadence count, or customer record is
  changed merely to prove the infrastructure patch;
- Atlas backup/query-targeting behavior is reported separately rather than
  incorrectly attributed to this application fix.

## 11. Intentionally Deferred Work

The following product behavior was discussed but is deliberately outside this
infrastructure work order:

- real-time Logics activity review after an identity-backed call lasting at
  least 20 minutes;
- immediate removal when that review proves conversion;
- EOD repair for missed initial payments;
- `suppressedUntil` handling for future post-dated payments and a recheck on
  the post date.

Those rules should be implemented as evidence inputs to
`leadDeliveryService`, not as decisions owned by metrics. They require their
own data contract, idempotency rules, and tests.

## 12. Local Implementation Evidence (2026-08-03)

- Patch A uses one bounded shared Mongoose connection owner with validated
  pool, idle, connecting, and wait-queue limits. Its focused configuration and
  connector tests pass.
- Patch B now uses the existing `LeadDeliveryCheckpoint` collection for both
  the prior cutover contract and the new PII-free daily source-repair cursor.
  The rejected `LeadDeliverySourceState` experiment is inert, is excluded from
  every deploy package, and remains pending physical deletion under the
  repository no-delete rule.
- An interrupted daily repair resumes its exact cursor before entering the
  new-arrival polling lane. Completed and completed-empty repairs remain
  complete across ticks and process restarts.
- The additive migration contains four indexes only: one cadence pagination
  index and three provider-event recovery indexes. A separate read-only
  preflight performs count-only `listIndexes()` and execution-plan proof for
  cadence, CaseProfile, appointment, and all three event heads without
  printing customer identities.
- Off-hours runtime proof covers 03:00, 07:49, 17:00, 17:29, the 17:30 close,
  22:30 same-process close completion, weekend event drain, delayed Call End,
  and actions-disabled zero-query behavior.
- Patch C is deliberately excluded from the Patch A and Patch B deployment
  packages. Its local weekday and nightly-hygiene cursor repairs do not waive
  the Patch G prerequisite or the remaining named-job durable-claim proof.
- Live Patch A reduced the four measured services from 175 established sockets
  to 36 after their idle gates while all four remained active/HTTP 200 and the
  bounded journal scan remained clean.
- Live Patch B passed 117/117 focused tests plus 10/10 named runtime tests,
  promoted exactly four additive indexes, and produced clean count-only plans
  for cadence, exact-pair joins, and all three event-recovery heads.
- The first live daily repair advanced through 6,250 fully accounted rows and
  25 durable versions without resetting or emitting an error. Completion,
  17:30 close, overnight, and weekend evidence remain required before the
  operational observation gate is closed.
