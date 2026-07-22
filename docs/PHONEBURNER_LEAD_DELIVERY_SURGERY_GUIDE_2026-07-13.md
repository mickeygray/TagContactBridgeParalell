# PhoneBurner Lead Delivery Surgery Guide

Date: 2026-07-13  
Status: Phase 9 controlled-floor hardening; surgery is planned, not yet authorized for physical deletion  
Parent contract: `.ai/context/PHONEBURNER_PROVIDER_NEUTRAL_LEAD_DELIVERY_WORK_ORDER_2026-07-10.md`

> Historical planning note: for the current Pool-only, Call-End-driven runtime,
> use `docs/PHONEBURNER_SIMPLE_LOOP.md` and
> `docs/PHONEBURNER_SIMPLE_LOOP_REMOVAL_LEDGER.md`. This guide contains earlier
> assumptions about two-folder capacity and backend-owned provider deletion and
> must not override the newer contract.

## 1. Purpose

This is the cut list for turning the current recovery implementation into one
boring lead-delivery system. It names the concepts we will keep, the names we
will change, the duplicate machinery we will remove, and the proof required at
each incision.

This guide does not authorize deleting live-test WIP. Until the full-day gate
passes and Mickey explicitly approves deletion, obsolete paths are hard-gated,
their callers are migrated, and they remain on the pending-deletion list.

At the start of every surgery turn:

1. Re-read the parent work order and this guide.
2. State the active phase and surgery slice.
3. Inspect the dirty tree and runtime ownership before editing.
4. Change one ownership boundary at a time.
5. Run the named gate before moving to the next slice.
6. Report what is now pending deletion; do not silently keep compatibility
   machinery forever.

## 2. North-star flow

There is one path:

```text
LeadCadence + CaseProfile evidence
  -> classify one durable LeadDeliveryItem
  -> reserve it once
  -> compose one agent packet
  -> post through one provider-mutation lane
  -> capture one exact provider callback
  -> record one physical attempt and outcome
  -> delete that exact provider contact
  -> retain the durable backend timer when another attempt is allowed
  -> terminalize it or hold it for the next allowed cadence window
  -> refill from stable physical folder counts
  -> close the floor at 17:30 Pacific
```

The coordinator may read legacy evidence while that evidence is being migrated.
It may not delegate a decision to `CxDialQueue`, UCQ/`QueueItem`, `AgentSlice`,
RingCX active-call state, a callback pulse counter, a folder-maintenance script,
or another scheduler.

## 3. Non-negotiable invariants

- `leadDeliveryService.js` is the only business-decision owner during surgery.
- PhoneBurner's two working folders are capacity truth. A local count is only a
  repairable projection.
- Provider identity is exact: call + contact + external lead. Never match by
  phone, name, timing, URL agent, or floor weighting.
- A provider upload does not count as a contact attempt. A hard Call End does.
- One exact Call End represents one physical attempt. A provider contact may
  survive multiple allowed same-day attempts under PhoneBurner's two-hour
  cycle. Completion deletes it only when cadence says it is capped, terminal,
  blocked, or otherwise ineligible.
- Folder reconciliation is a curator/repair loop. It may remove contacts by
  exact identity but may never infer or increment an attempt.
- Callback capture is durable before acknowledgement and does no business work
  inline.
- DNC, bad lead, appointment, call-memory, and cadence effects happen after the
  local completion commit and are idempotent.
- Creation closes at 17:00 Pacific. The existing runtime performs the daily
  close at or after 17:30 Pacific; there is no cleanup service or second timer.
- Daily close pauses delivery first, drains in bounded chunks, never removes an
  `in_call` contact, tolerates 404, respects 429, and proves stable zero.
- Daily close owns every configured production folder pair, even when that
  agent is temporarily delivery-disabled. A disabled delivery flag is not a
  permission to leave provider work behind overnight.
- Daily close and Call Begin have one exact-attempt ordering fence: Call Begin
  winning first defers close; `delete_pending` winning first blocks a later
  Call Begin and lets close remove that contact.
- The next Pacific day's normal tick returns closed, undialed work to the shared
  pool even if yesterday's agent never logs in.
- Explicit post-close preposition is allowed only through the coordinator; it
  does not manufacture agent activity or undo the pause.
- Restart and replay may repeat reads and CAS attempts, never calls or outcomes.
- Immutable provider-attempt history owns exact callback attribution, business
  date, and the derived completed metric. Receipt time cannot create activity.
- A daily-close tombstone is valid only for its exact attempt number; old
  metadata cannot hide or release a newer provider contact.
- Historical terminal outcomes stop queued newer work. An already active call
  finishes physically, is counted with its actual outcome, and then the older
  terminal lifecycle is enforced without duplicating the terminal effect.
- Legacy voice writers remain dark while the provider-neutral owner is enabled.

## 4. Canonical vocabulary

### 4.1 Names that stay

- `LeadDeliveryItem`: one durable lead plus its current delivery state and
  immutable provider-attempt history.
- `LeadDeliveryAgent`: one agent's delivery policy, activity evidence, pause,
  fairness, and repairable provider-count projection.
- `LeadDeliveryEvent`: durable provider callback inbox.
- `shared pool`: all currently eligible work before reservation.
- `reservation`: short-lived fair ownership of fresh work.
- `packet`: the exact set selected to restore an agent to target.
- `deliveryAgentId`, `packetId`, `providerContactId`,
  `providerExternalLeadId`, `providerCallId`, `providerAttemptSequence`, and
  `providerAttemptHistory`.
- `new_today`, `overnight`, `older_available`, and `follow_up_due`.

### 4.2 Names to change

Persisted-field renames use expand -> dual-read/write -> backfill -> compare ->
contract. They are never a broad search-and-replace.

| Current name | Canonical name | Reason |
| --- | --- | --- |
| `sourcePool` | `currentPool` | Pool membership changes with time and outcome. |
| `activeAttempt` | `deliveryActive` | The flag covers eligible/waiting work, not a live phone call. |
| `estimatedOutstanding` | `projectedWorkingCount` | It is a repairable projection, not capacity truth. |
| `distributionFolderId` | `providerPoolFolderId` | Says which provider-side role the folder serves. |
| `receivingFolderId` | `providerConsumerFolderId` | Separates provider consumption from backend pooling. |
| `providerBufferTarget` | `poolTarget` | Shorter and tied to the working set. |
| `refillAtOrBelow` | `poolLowWater` | Names the trigger rather than an implementation. |
| `workingFolderDrain` | `dailyClose` | The business operation is closing the floor, not generic draining. |
| provider `post` lane | provider `mutation` lane | Creates and identity-safe deletes share one owner. |
| `operatorPaused` + `shiftEnabled` | `deliveryPaused` + `activeUntil` | One veto plus expiring activity evidence; remove the redundant boolean. |

Do not rename Mongo collections in the same change as code symbols. Model and
collection migration is a later, separately proven operation.

## 5. Final component boundaries

The goal is fewer owners, not more helper files.

### Decision coordinator

`packages/shared-services/src/leadDeliveryService.js`

Owns eligibility, pool classification, ordering, fairness, reservations, packet
composition, provider-attempt transitions, callback application, capacity and
refill decisions, and daily close. Internal extraction is allowed only into
three cohesive modules after dead code is removed:

1. `leadDeliveryPolicy.js`: pure decisions and transitions.
2. `leadDeliverySource.js`: neutral `LeadCadence`/`CaseProfile` adapter.
3. `leadDeliveryCoordinator.js`: leases, provider mutation, callbacks, refill,
   reconciliation, and daily close.

Do not create one file per rule or one wrapper per function.

### Store

`packages/shared-repositories/src/leadDeliveryRepository.js`

Owns narrow reads, inserts, and versioned compare-and-set only. It does not
classify pools, choose agents, compute packets, or invoke providers.

### Provider adapter

`packages/shared-integrations/src/phoneBurnerClient.js`

Owns normalized PhoneBurner HTTP, authentication, pagination, retry metadata,
and response normalization only. It does not know cadence, fairness, packet
allowances, or agents beyond provider identifiers supplied by the coordinator.

### Callback edge

`apps/control-plane/src/routes/phoneBurnerLeadDelivery.js`

Normalizes, durably captures, acknowledges, and schedules injected callback
processing. It does not count calls, choose agents, refill, or call Logics.

### Composition and effects

`apps/control-plane/src/server.js` should end as configuration and composition.
Move the body of `createControlPlaneLeadDeliveryActionHandlers` into one thin
`apps/control-plane/src/services/leadDeliveryActions.js` adapter containing the
four effect ports:

- `recordVoiceAttempt`
- `setLogicsDnc`
- `createAppointment`
- `createAppointmentTimeTask`

Those ports execute a decision; they do not make one.

## 6. Public API after surgery

| Current symbol | Final symbol | Surgery |
| --- | --- | --- |
| `seedAgent` and `launchAgent` | `startAgent` | One active-start operation. |
| `seedAgent(..., { preposition: true })` | `prepositionAgent` | Explicit staging without activity evidence. |
| `cancelAgent` | `pauseAgentDelivery` | Pause is not cancellation or deletion. |
| `fillAgent` | private `fillAgentToTarget` | Never exposed as a second operator path. |
| `previewAgent` | `previewAgentFill` | Makes the preview scope explicit. |
| `readAgentProviderOutstanding` | `readStableWorkingCount` | Requires stable physical evidence. |
| `refreshAgentCapacity` | `refreshAgentWorkingSet` | Count, repair, and refill under one owner. |
| `reconcileAgent` | `reconcileAgentWorkingSet` | Exact identity reconciliation. |
| `runEndOfDayFolderDrain` | `runDailyClose` | Canonical floor-close operation. |
| `drainCapturedEvent` | `processCapturedEvent` | One exact inbox event. |
| `drainEvents` | `processPendingEvents` | Durable inbox worker. |
| `completeDownstream` | `applyCompletionEffects` | Local completion already happened. |
| route `createPhoneBurnerLeadDeliveryRuntime` | `createPhoneBurnerCallbackRouter` | It is an HTTP edge, not the runtime. |

Delete after callers are migrated and the slice gate passes:

- `appendAgentPacket`
- `appendWeightedAgentPacket`
- `launchBackgroundRefill`
- `providerInventoryAuthoritative` and the local-estimate refill branch
- `recirculateCompletedProviderContact`
- the route-local preview/fallback drain
- callback pulse meters and route-owner inference

Temporary compatibility methods and routes must log aggregate use and have a
named removal gate. A compatibility alias may delegate; it may not retain an
alternate implementation.

## 7. Ordered surgery

### Slice 0 — freeze the proven lifecycle

The July 14 floor ruling is backend-owned redialing. The live contract is:

```text
Call End -> count once -> evaluate terminal/cap/eligibility
         -> delete the exact PhoneBurner contact
         -> when allowed, retain a durable follow-up timer
         -> repost a fresh contact only when that timer is due
```

Then prove daily close, oversized-folder chunking, restart catch-up, next-day
release, post-close preposition, and delayed exact callbacks.

Gate:

- exact completion is idempotent;
- retryable contacts release their old provider identity after exact deletion;
- terminal, capped, blocked, and review contacts are deleted; provider 404 succeeds;
- deletion never counts an attempt;
- 429 leaves durable retry evidence;
- a backend redial receives a new contact and attempt identity;
- a later-day/backend-timer attempt gets a new contact and external identity;
- old identity cannot delete or mutate a newer attempt;
- queued newer work is cancelled only for an exact lead-level terminal outcome;
- an in-call newer attempt is never deleted and cannot reopen the lead afterward;
- delayed callbacks preserve the original Pacific business day and do not
  manufacture agent activity;
- restart between item completion and agent projection reconstructs the metric;
- stale close metadata cannot hide a newer attempt;
- both close/Call Begin boundary interleavings preserve the winner;
- the 17:30 close finishes or reports a precise partial reason.

### Slice 1 — hard-gate alternate writers

Keep `findArmedLegacyVoiceWriters` as a startup interlock. Confirm every entry in
`LEGACY_VOICE_WRITER_SETTINGS` is dark.

Hard-gate these scripts so they refuse provider mutation while lead delivery is
the owner:

- `scripts/phoneburner-emergency-topup.js`
- `scripts/phoneburner-align-ledger-to-folders.js`
- `scripts/phoneburner-redistribute-undialed-fresh.js`
- `scripts/phoneburner-drain-working-folders.js`
- `scripts/phoneburner-reset-delivery-ledger.js`

Gate: startup fails with any competing voice writer; SMS, email, and RVM still
work; no scheduled task or script can mutate the same population.

Rollback: disable refill, then pause delivery. Do not turn another writer on
against overlapping work.

### Slice 2 — collapse operator commands

Add canonical `start`, `preposition`, and `pause` methods. Migrate admin routes
and tests. Keep old `/seed`, `/launch`, and `/cancel` endpoints as delegating
aliases for one observed window, then remove them.

Gate:

- one method can activate an agent;
- one method can preposition without activity;
- pause prevents every automatic refill;
- no production caller references either append method.

### Slice 3 — reduce callback edge to capture

In `apps/control-plane/src/routes/phoneBurnerLeadDelivery.js`:

- rename the factory to `createPhoneBurnerCallbackRouter`;
- make generic `/call-done` canonical;
- retain `/call-done/:agentId` only as a temporary alias;
- delete `createPhoneBurnerLeadDeliveryDrain` fallback behavior;
- delete legacy pulse/route-owner flags, counters, and inference;
- inject only `processCapturedEvent`/`processPendingEvents`.

Gate: durable insert precedes 200; duplicate capture is a successful no-op; the
route performs no Logics, appointment, allocation, count, or refill work; exact
persisted identity owns attribution.

### Slice 4 — remove manual recirculation and dual refill

Remove `recirculateCompletedProviderContact`; the provider-neutral backend owns
redial eligibility. The coordinator records the exact attempt, deletes the
completed provider contact, and reposts a fresh provider contact only after the
durable timer is due and the cadence cap still allows another attempt.

Make physical provider counts unconditionally authoritative. Remove
`providerInventoryAuthoritative`, `launchBackgroundRefill`, and every branch
that can refill from `projectedWorkingCount` alone.

Gate: stable double-read controls low-water; unreliable reads fail closed;
projection repairs to physical truth; the delete/repost decision is durable
before the capacity owner decides to refill.

### Slice 5 — move the July bridge out of runtime

The one-shot preload/checkpoint machinery is migration code, not the permanent
delivery loop. After its checkpoint is terminal and reconciled, move any audit
reader to a migration-only module and remove runtime entry points including:

- `preloadWindow`
- `checkpointReadyForContinuation`
- `readWindowBatch`
- checkpoint creation/update helpers
- `LeadDeliveryCheckpoint` write paths
- `phoneburner:july-preload` package command

Then retire the July preload, today-four, Bruce redistribution, and ledger-reset
scripts. Keep checkpoint documents read-only through retention.

Gate: no partial/pending/failure/conflict remains; post-checkpoint ingestion has
neither gap nor overlap; permanent startup imports no migration writer.

### Slice 6 — neutralize persisted CX vocabulary

Add a provider-neutral `voice` namespace, dual-write, backfill, compare, switch
queries/indexes, and only then remove CX-shaped fields:

- `cadenceCounters.cx` -> `cadenceCounters.voice`
- `lastTouched.cx` -> `lastTouched.voice`
- `counterCadence.lastCxDialedAt` -> `lastVoiceAttemptAt`
- `lastCxDialedBy*` -> `lastVoiceAgent*`
- `lastCxQueueFamily` -> `lastVoicePool`
- `lastCxQueueItemId` -> `lastVoiceWorkItemId`
- `cxDailyDateKey` / `cxDailyCalls` -> `voiceDailyDateKey` /
  `voiceDailyAttempts`
- CX answered, no-answer, monthly, and DNC fields -> corresponding `voice*`
- `cadenceState.channelDnc.cx` -> `.voice`

Keep the already neutral `lastLeadDeliveryCountedCallId` and
`lastLeadDeliveryCountedAttemptKey` during the migration.

Gate: old-only, new-only, and dual documents produce the same eligibility and
timer; aggregates reconcile; no old-field writer remains.

### Slice 7 — slim control-plane composition

Extract the action adapters from `apps/control-plane/src/server.js`. Replace CX
names at the effect boundary, including a neutral façade over appointment and
lead-status updates. Keep allocation and outcome decisions in the coordinator.

Gate: server startup composes interfaces; it does not contain cadence mutations
or provider policy; effect tests prove idempotency.

### Slice 8 — retire legacy PhoneBurner ownership

Pending deletion after proof:

- `apps/control-plane/src/services/phoneburnerRotationRuntime.js`
- `packages/shared-services/src/outboundPhoneBurnerService.js`
- PhoneBurner round/manual branches in `outboundDispatchService.js`
- old outbound-gateway PhoneBurner endpoints
- historical rotation wrappers and remaining mutation scripts

Gate: no queued legacy event, caller, import, timer, route, or provider write;
one stable full day under the neutral owner.

### Slice 9 — retire CX delivery rails

Remove writers before stores.

Writer/service candidates:

- `cxBoringDialerService.js`
- `cxBoringDialerRuntime.js`
- `cxBoringWebhookService.js`
- `cxBoringWebhookRuntime.js`
- `cxBulkLoadRuntimeService.js`
- `cxBulkLoadRuntime.js`
- `cxBulkLoadRingcxPublisher.js`
- `cxBulkLoadStateMachine.js`
- `cxBulkLoadOutcomeAdapter.js`
- `cxFirstTouchDispatchService.js`
- `cxMorningQueueBuilderService.js`
- `cxSeanFirstTouchDripService.js`
- `cxAppointmentDispatchService.js`
- `cxAccountActiveCallWatcherService.js`
- `cxCallerIdRotationService.js`
- `apps/control-plane/src/routes/cxBulkLoad.js`
- CX direct feeder, suspect watchdog, and caller-ID mutation scripts
- CX bulk-load web query and workspace delivery controls

Store candidates only after consumer and retention proof:

- `CxBulkLoadSession`
- `CxDialQueue`
- `CxTerminalOutbox`
- CX Boring webhook store/repository
- UCQ `QueueItem`
- `AgentSlice`
- their allocation repositories and indexes

Remove barrel exports last. Do not delete the RingCX application wholesale:
recording, transcription, call memory, coaching, and read-only monitoring are
separate capabilities from queue ownership.

## 8. Explicit keep list

Keep and neutralize only where needed:

- `LeadCadence`
- `CaseProfile` and current eligibility evidence
- `LeadDeliveryItem`, `LeadDeliveryAgent`, `LeadDeliveryEvent`
- `leadDeliveryRepository`
- PhoneBurner client and durable credential store
- one provider mutation lane/run lock
- callback inbox and immutable attempt history
- Logics DNC integration
- terminal appointment outcome reporting (no PhoneBurner appointment execution)
- call history, call memory, coaching, recordings, transcripts, and review tools
- SMS, email, and RVM cadence
- legacy CX collections read-only until overlap and retention gates pass

## 9. Proof matrix for every slice

Every slice needs:

1. `rg` proof that no unintended caller remains.
2. Focused unit/route/repository tests for the changed boundary.
3. The full `tests/lead-delivery` suite.
4. Startup/wiring tests showing one new owner and zero armed legacy writers.
5. PII-free health evidence; no raw provider payload, phone, lead, token, or
   secret in logs.
6. Restart/replay proof for any changed durable state.
7. No provider mutation unless the live action is separately authorized.

Additional deletion gate:

- stable multi-agent full-day evidence;
- callbacks and outcomes reconcile exactly once;
- physical and projected folder counts agree;
- refill occurs at configured low-water and never above target;
- daily/age cadence never permits an extra attempt;
- fresh fairness and the 15-minute escape are explainable;
- daily close drains both working folders without losing delayed callbacks;
- Mickey explicitly approves the named deletion slice.

## 10. Rollback and retention

Rollback order:

1. Disable automatic refill.
2. Pause agent delivery.
3. Keep callback capture and event processing alive until accepted contacts are
   reconciled.
4. Do not arm CX or legacy PhoneBurner writers against overlapping work.
5. Never delete Mongo documents or provider contacts merely to roll back code.

Code deletion and database deletion are separate approvals. Retain old
collections read-only through the overlap window. Preserve an audit branch or
artifact, but never use rollback to create two voice owners.

## 11. Stop conditions

Stop the current surgery slice and report instead of improvising if:

- a provider identity is missing or contradictory;
- physical folder reads disagree or paginate inconsistently;
- a callback could apply to more than one attempt;
- a legacy writer is armed;
- a migration checkpoint is partial or changed;
- the change would require a broad data rewrite without dual-read proof;
- the change would physically delete code before Mickey's approval;
- a Windows `Parallel*` restart is required. Mickey owns that restart.
