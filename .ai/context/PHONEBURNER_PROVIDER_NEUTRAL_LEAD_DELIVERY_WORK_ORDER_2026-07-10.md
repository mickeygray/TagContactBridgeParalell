# Provider-Neutral Lead Delivery / PhoneBurner Work Order

Date: 2026-07-10  
Owner: Codex, under Mickey's live-floor direction  
Status: PERSISTENT IMPLEMENTATION GOAL ACTIVE; PHASE 9 CONTROLLED-FLOOR HARDENING ACTIVE  
Applies to: the replacement daytime lead-building, allocation, buffering, PhoneBurner delivery, and call-completion loop

## 0. Mandatory Re-Read Rule

Before every turn that touches this rewrite:

1. Read this file end to end.
2. Read `AGENTS.md` and inspect `git status --short`.
3. State in commentary: `Re-read PhoneBurner lead-delivery work order; active phase: N`.
4. Confirm that no folder ID is being guessed and no secret will be printed.
5. Work only inside the active numbered phase.
6. Run the phase's named proof gate before advancing.
7. At handoff, report:
   - phase completed;
   - files changed;
   - tests/evidence;
   - assumptions made;
   - next phase;
   - anything still intentionally blank.

If a future request conflicts with this document, Mickey's newest explicit instruction wins. Amend this document first so the durable contract and the live instruction do not diverge.

## 0.1 Continuous Execution Rule

This work runs as a persistent goal. Proof gates are mandatory quality boundaries, not places to wait for another user prompt.

After a phase gate passes:

1. Record the evidence in commentary and the final handoff.
2. Update the active phase.
3. Continue directly into the next phase.
4. Keep iterating across automatic goal turns until the definition of done is satisfied.

Pause only when:

- Mickey must create or supply PhoneBurner folders, LeadStreams, member IDs, or another external credential/configuration value;
- an action would be destructive or would alter live production behavior beyond the authorized rollout phase;
- a material business decision is absent from this work order and cannot be safely inferred;
- a repeated external blocker satisfies the goal-blocked threshold.

Do not pause merely because a phase ended, the work is large, or a progress report would be convenient. While waiting for external folder IDs, continue every safe phase or test that does not require them.

## 1. Governing Objective

Build a fresh, provider-neutral lead-delivery system whose first delivery adapter is PhoneBurner.

The system has one repetitive job:

```text
decide who is callable
  -> place callable work into four shared pools
  -> reserve work fairly for active agents
  -> build a shallow packet for an agent
  -> deliver that packet into the agent's PhoneBurner distribution folder
  -> accept PhoneBurner call events
  -> record what happened once
  -> make the lead terminal or due again
```

The system is not a port of the RingCX runtime. It may borrow proven pure rules and small transport helpers, but it starts with provider-neutral names, provider-neutral state, and one new decision owner.

## 2. Non-Negotiable Architecture Laws

### 2.0 PhoneBurner cycles; the backend curates (2026-07-14 ruling)

This ruling supersedes the earlier delete-every-completion/recreate-when-due
lifecycle for ordinary nonterminal same-day attempts.

- PhoneBurner owns mechanical recycling inside its configured two-hour cycle.
- The provider-neutral service builds the first working list and injects newly
  arrived leads.
- Every exact Call End/offload durably increments the cadence attempt count and
  advances the last-contact timestamp before any removal decision.
- While a lead remains callable and below its age-based daily cap, keep the
  same exact PhoneBurner contact available for native recycling.
- Remove the exact provider contact immediately when it reaches its daily cap,
  becomes terminal or blocked, or otherwise fails eligibility.
- Current caps remain three attempts per day for days 0-1, two per day for days
  2-16, one per day for days 17-31, and one attempt followed by the red-tier
  hold from day 32 onward.
- A periodic folder curator reads structured provider identities, joins them to
  canonical cadence evidence, and removes stale/ineligible contacts missed by
  the immediate Call End path. It is a repair loop, not a second counter.
- An unresolved or contradictory Call End fails closed for further recycling
  until reconciled. A folder poll may never invent an attempt.
- Folder placement and recycling never count as attempts. Only an exact,
  persisted Call End does.

### 2.0.1 Fresh delivery is an immediate lane (2026-07-15 ruling)

Fresh delivery does not wait for bulk packet construction, low-water refill,
or provider-pool capacity.

- When an eligible `new_today` item is ingested, the lead-delivery service
  immediately offers that one item to the next active agent selected by the
  durable fresh fair-pick cursor.
- Active means exact provider evidence within the configured activity window;
  an enabled account or shift flag alone is not activity.
- Existing provider-pool depth, `estimatedOutstanding`, packet deficit, and
  ordinary refill state never exclude an otherwise active agent from fresh
  ownership.
- The provider post contains one fresh item only. Bulk packet allowances and
  fallback pools cannot fill or delay this operation.
- The fresh fair-pick cursor advances only after PhoneBurner accepts the
  contact. A rejected, failed, or ambiguous post does not spend that agent's
  fair turn.
- When no agent is active, the item remains eligible and unassigned. The next
  periodic tick and the next exact Call End both retry immediate fresh
  delivery.
- The fifteen-minute receipt deadline is an alert/retry boundary, not a reason
  to wait. Once PhoneBurner accepts the contact, the backend observes that
  provider identity and does not create a duplicate replacement.
- Ordinary Call End processing still performs its two independent duties:
  record the completed attempt, and refill the caller's Pool only when the
  physical Pool is below low water. It may also wake this immediate fresh lane,
  but it does not own fresh selection or timing.


### 2.0.2 Physical Pool watchdog and Call End recording evidence (2026-07-28 ruling)

The simple daytime loop must recover when an agent's PhoneBurner Pool becomes
empty without producing another Call End.

- The existing runtime tick performs a bounded watchdog pass; no second
  scheduler, service, counter, or queue is introduced.
- The physical PhoneBurner Pool folder is the only capacity truth. Consumer
  inventory and `estimatedOutstanding` never suppress a watchdog refill.
- Call End and watchdog use the same decision helper and the same durable
  per-agent Pool-operation lock. The physical count is read inside that lock,
  so concurrent triggers cannot create two packets.
- At or below the low-water boundary, two agreeing physical Pool reads are
  required before a packet is posted. Failed or contradictory reads fail
  closed.
- The watchdog considers only configured, enabled agents whose shift is
  enabled and not operator-paused, and it runs only while the delivery window,
  actions, refill, and provider-authoritative inventory are enabled.
- A watchdog refill never counts an attempt. Exact, persisted Call End remains
  the only attempt counter.
- A validated HTTPS PhoneBurner recording link present on Call End is retained
  as narrow recording evidence. It is carried through the exact event,
  `DailyDial` attempt, and downstream `CallLog` projection without retaining
  the raw callback or logging the URL.
### 2.1 One canonical lead-delivery store

Create a new provider-neutral collection/model for this runtime. Do not use:

- `CxDialQueue`;
- `CxBulkLoadSession`;
- `QueueItem` / UCQ;
- `AgentSlice` as a runtime dependency;
- RingCX campaign, UII, extern ID, dial group, active-call, or off-hook state as canonical delivery state.

Old collections remain untouched during rollout. They can be read for migration diagnostics only when explicitly required. They must never simultaneously own the same live PhoneBurner work.

### 2.2 One decision owner

`packages/shared-services/src/leadDeliveryService.js` is the only file allowed to decide:

- pool membership;
- agent eligibility for a reservation;
- fresh-lead fairness;
- reservation expiry/reassignment;
- packet composition;
- refill timing;
- which lead is delivered next;
- whether a completed attempt becomes terminal or follow-up due.

Supporting files may store, fetch, normalize, or transport. They may not make business decisions.

### 2.3 Thin support files

The minimum supporting files are permitted because persistence and transport should not be embedded in business logic:

```text
packages/shared-models/src/LeadDeliveryItem.js
packages/shared-models/src/LeadDeliveryAgent.js
packages/shared-models/src/LeadDeliveryEvent.js
packages/shared-repositories/src/leadDeliveryRepository.js
packages/shared-integrations/src/phoneBurnerClient.js
apps/control-plane/src/routes/phoneBurnerLeadDelivery.js
config/lead-delivery-agents.json
```

These files must remain deliberately boring:

- models define shapes and indexes only;
- repository performs atomic database operations only;
- PhoneBurner client performs authenticated HTTP and normalizes responses only;
- route authenticates, captures, calls the service, and responds quickly only;
- config contains agent policy and blank folder identifiers only.

No helper tree. No second orchestrator. No provider-specific business rules outside the main service.

### 2.4 Before provider acceptance, we choose; after acceptance, we observe

Before a PhoneBurner contact POST succeeds, the lead-delivery service owns selection and reservation.

After PhoneBurner accepts the contact:

- do not reorder an active dial session;
- do not infer that deletion changes the active session;
- do not silently replace or duplicate the accepted contact;
- wait for PhoneBurner events or reconciliation evidence;
- use hard identity (`phoneBurnerContactId`, our unique `externalLeadId`, and PhoneBurner `callId`), never phone-only matching.

### 2.5 One outcome per call

Every PhoneBurner call event is idempotent by provider call ID plus event type. A completed call can write one normalized outcome. Duplicate callbacks are successful no-ops.

### 2.6 No live-flow dependency on Logics latency

The callback route must durably capture the event and return promptly. Logics DNC, appointment, call notes, cadence mutation, and other business effects run after durable capture through a retryable drain.

### 2.7 No guessed presence

The public PhoneBurner REST API does not currently provide a documented live-login/presence endpoint. Do not invent one.

Agent activity is derived from evidence:

- recent PhoneBurner call/contact event;
- observed contact movement from distribution to receiving folder;
- explicit operator shift enable/disable if later required;
- expiration of `activeUntil` when no evidence arrives.

An account existing is not evidence that the agent is actively consuming leads.

## 3. Vocabulary

Use these provider-neutral terms in new code:

| Term | Meaning |
|---|---|
| `work item` | One lead that may be delivered for one current contact attempt |
| `shared pool` | Eligible, unassigned work grouped by why it is callable |
| `reservation` | Time-limited exclusive claim that a work item belongs at the top of one agent's backend buffer |
| `backend buffer` | Work reserved/claimed for an agent but not necessarily posted to PhoneBurner yet |
| `provider pool` | The agent's shallow PhoneBurner LeadStream distribution folder |
| `consumer` | The agent's active PhoneBurner Blind Pull dial session |
| `packet` | The small set of contacts added to restore an agent's provider pool to target |
| `refill request` | A request created when completed calls reduce outstanding provider work to the low-water mark |
| `fresh weight` | Hour-scoped fair priority for receiving newly arrived leads |
| `lease` | The maximum time a fresh reservation is protected before speed-to-lead overrides fairness |

Do not call these objects CX sessions, RingCX buffers, UCQ slices, campaigns, or UI queues.

## 4. The Four Shared Pools

Every currently callable work item belongs to exactly one pool at a time.

### 4.1 `new_today`

Definition:

- lead was received during the current Pacific business day;
- lead is not already terminal or blocked;
- lead is not currently in a timed follow-up attempt;
- lead has not exceeded the three-contact daily maximum.

Ordering: newest received first.

Purpose: speed-to-lead. This is the scarce pool governed by agent fairness weights and reservation leases.

### 4.2 `overnight`

Definition:

- lead was selected by the overnight builder snapshot for the current business day;
- lead is not in `new_today`;
- lead is not currently `follow_up_due`;
- lead remains callable when rechecked at claim time.

Ordering: preserve the overnight builder's intentional order unless a later explicit policy changes it.

Purpose: reliable beginning-of-day inventory, with larger allowances for the designated top agents.

### 4.3 `older_available`

Definition:

- callable lead not received today;
- not part of today's overnight snapshot;
- not currently due through the follow-up timer;
- not terminal, blocked, reserved, delivered, or over contact limits.

Ordering: explicit and deterministic. Initially use oldest eligible/least recently contacted, not Mongo natural order.

Purpose: keep agents productive after higher-value inventory is exhausted.

Controlled-floor ruling (2026-07-14): `older_available` is a hard fallback.
Do not select or post aged work while any active `overnight` first-contact item
still has zero persisted attempts and no persisted last-contact timestamp. The
barrier includes overnight work already reserved, packetized, provider
accepted, or in call; assigning it to PhoneBurner is not consumption. A hard
Call End persisted through the canonical cadence path consumes that first
contact and releases the barrier only when no such overnight item remains.
`LeadCadence` dual-writes the literal provider-neutral facts
`totalAttemptCount` and `lastContactAt` on every exact counted attempt. Source
reads take the maximum/newest evidence across those fields and the CX-era
compatibility fields so migration can never lower a count or move the last
contact backward.

### 4.4 `follow_up_due`

Definition:

- any nonterminal lead whose `nextContactAt <= now`;
- agnostic of original lead type, source pool, or age;
- still passes contactability and daily-attempt checks.

Ordering: most overdue first, then oldest last-contact timestamp.

Purpose: second and third daily contacts after the configured timeout.

### 4.5 Pool exclusivity precedence

When conditions overlap, choose exactly one pool in this order:

```text
follow_up_due
new_today
overnight
older_available
```

The precedence only prevents duplication. Packet allowances determine how much of each pool an agent receives.

## 5. Eligibility Rules

Before a work item can enter a pool or be claimed, verify:

1. Stable domain and case identity exist.
2. A callable normalized US phone exists.
3. Logics/current contact status does not prove DNC, bad lead, client, completed appointment, closed/non-prospect, or another explicit stop state.
4. The lead has not already been terminally contacted today.
5. Daily attempted contacts are below three.
6. If this is a retry, `nextContactAt <= now`.
7. No active reservation or provider delivery exists for the same lead/attempt.
8. The lead is inside permitted contact hours for its state/timezone.
9. Any unknown or failed high-risk eligibility read fails closed for delivery and records a retryable reason; it does not silently cancel the lead.

Borrow pure eligibility and timing rules from existing services only after copying them behind provider-neutral names and tests. Do not import a 5,000-line CX service into the new runtime.

## 6. Agent Configuration

Create `config/lead-delivery-agents.json` only in the configuration phase. All folder IDs start as empty strings.

Required template:

```json
{
  "defaults": {
    "providerBufferTarget": 5,
    "refillAtOrBelow": 1,
    "freshReservationRange": 3,
    "freshReservationMinutes": 15,
    "activeEvidenceMinutes": 10,
    "maxPendingFreshReservations": 1
  },
  "agents": {
    "agent_key": {
      "enabled": false,
      "displayName": "",
      "provider": "phoneburner",
      "phoneBurnerMemberId": "",
      "phoneBurnerUsername": "",
      "applicationAccountEmail": "",
      "distributionFolderId": "",
      "receivingFolderId": "",
      "leadStreamId": "",
      "subscribedPools": [],
      "packetAllowances": {
        "new_today": 0,
        "overnight": 0,
        "older_available": 0,
        "follow_up_due": 0
      }
    }
  }
}
```

Rules:

- No agent becomes enabled while required folder IDs are blank.
- Never copy historical Mickey test folder IDs into production-agent entries.
- Secrets and OAuth tokens stay in environment/token storage, never this JSON.
- Folder IDs are supplied by Mickey after he creates one distribution and one receiving folder per agent.
- `phoneBurnerMemberId`, `phoneBurnerUsername`, and `leadStreamId` are optional verification metadata, not delivery prerequisites. PhoneBurner's documented contact-create route does not require an owner field, and the configured distribution folder is the LeadStream routing key.
- `applicationAccountEmail` is the explicit Parallel user-account mapping for downstream appointment ownership. It is not inferred from display name and is not a PhoneBurner credential.
- A shared authenticated PhoneBurner owner is valid. Do not require or invent a unique owner identity per agent when the distribution folders live in one network/admin account.
- An agent can have an allowance of zero or omit a pool entirely.
- Packet allowances describe composition preferences, not separate PhoneBurner folders.

## 7. PhoneBurner Setup Required From Mickey

Do not request this until the configuration phase is ready and the exact checklist can be handed to Mickey.

For each enabled agent Mickey will create/configure:

1. One unique distribution folder.
2. One unique receiving folder.
3. One Blind Pull LeadStream using that distribution and receiving folder.
4. One dialer preset with the required dialing/live-answer dispositions.
5. The agent as a Blind recipient, not Preview.
6. Post-call/call-event webhook callbacks pointed at the new authenticated route.
7. Native recycling configured for the controlled two-hour cycle. The backend
   remains authoritative for attempt counts, eligibility, terminal outcomes,
   age-based daily caps, and removal.

Mickey then supplies, per agent:

```text
distributionFolderId =
receivingFolderId =
optional leadStreamId/admin label =
optional phoneBurnerMemberId or owner identity =
```

The folder pair is the runtime requirement. Optional admin labels may remain blank when the PhoneBurner application already proves the mapping.

### 7.1 Weekend pre-positioning ruling (2026-07-10)

The weekend/Monday preload is part of this runtime, not a temporary PhoneBurner feeder:

1. Ingest every eligible cadence row into the provider-neutral store.
2. Use persisted least-served fairness; do not use a stateless `index % agentCount` round robin.
3. Pre-position only enough accepted contacts to restore each explicitly enabled agent to `providerBufferTarget` (initially five).
4. Keep all excess inventory in the backend shared pools so Monday's newest leads are not buried under a large PhoneBurner folder.
5. Posting a contact does not count an attempt. Only an identity-backed provider call completion counts.
6. Bruce Allen is the first live canary. All other agents remain posting-dark until Bruce proves acceptance, callback identity, decrement, and refill.
7. The existing cadence collection remains the source and may continue its non-voice scheduling work. Old PhoneBurner writers must remain off; CX inventory that no agent consumes is not canonical state for this runtime.

Implementation clarification:

- Weekend pre-positioning is an explicit operator invocation of the existing `seedAgent` runtime API with `{ preposition: true }`; it is not a timer, round robin, or second feeder.
- It restores only the identity-backed deficit up to `providerBufferTarget` and is idempotently a no-op at target.
- It does not set `shiftEnabled`, extend `activeUntil`, or otherwise claim that the agent is consuming leads.
- It uses the same claim-time source re-read as every other provider POST. Current status, daily-attempt, follow-up timer, identity, and phone checks remain fail-closed.
- Only the exact `{ preposition: true }` intent may skip the current-clock contact-window verdict because folder placement is not an attempted call. Ordinary seed, unknown intents, and every automatic refill retain the strict contact-window check.
- Pre-positioning does not authorize automatic refill. Automatic refill still requires the refill flag plus unexpired provider/operator activity evidence.

### 7.2 Monday July inventory bridge ruling (2026-07-12)

Mickey explicitly authorized one temporary exception to the shallow-buffer rule so
the five PhoneBurner agents have a complete first-pass inventory on Monday,
July 13, before the live refill loop is enabled:

1. At 07:30 America/Los_Angeles, take one fixed snapshot of leads received from
   2026-07-01 00:00 Pacific through the run snapshot, capped at 5,000 contacts.
2. Include only leads that are still currently callable after the same
   fail-closed cadence, CaseProfile, DNC, appointment, payment/client,
   daily-attempt, and two-hour follow-up checks used by the provider-neutral
   runtime. Re-read that evidence immediately before every provider claim.
3. Deal the snapshot across Bruce, Phil, Sean, Brad, and Chris by persisted
   least-served count with deterministic ties. A restart resumes from durable
   assignments; it does not restart an in-memory modulo round robin.
4. Prefer the newest eligible receipt first so every agent receives useful
   Monday inventory immediately while the paced backlog continues loading.
5. Persist the assignment and stable external identity before posting, then use
   the existing provider-wide lane: one logical create at a time, at least six
   seconds between starts, with the existing ambiguity reconciliation and 429
   cooldown behavior.
6. Posting still does not count as a contact attempt. Only a hard provider call
   completion may advance attempts.
7. This is an explicit, one-shot operator bridge. It does not enable the normal
   runtime, change checked-in agent enablement, manufacture shift activity, or
   authorize automatic refill. It must default to dry-run and require an
   explicit apply acknowledgement.
8. The full PhoneBurner folders are intentional for this first pass only. After
   the agents consume them once, reconcile those provider identities before
   enabling the shallow re-up loop or another voice writer.
9. The old CX direct feeder and legacy PhoneBurner rotation may not concurrently
   own this Monday population. The one-shot must fail closed if a conflicting
   PhoneBurner writer is armed, and the old CX scheduled feeder must be disabled
   before agents begin the migrated PhoneBurner work.

This ruling supersedes section 7.1 only for the named July 13 one-shot. The
current controlled-floor architecture uses target-20 buffers with guarded
refill at five or below.

### 7.3 Monday migration checkpoint ruling (2026-07-12)

The July bridge must leave one durable, PII-free boundary from which the normal
provider-neutral flow can later start:

1. The migration checkpoint is the source window boundary, not the last
   provider contact to finish posting. The bridge window is
   `[2026-07-01 00:00 Pacific, 2026-07-13 07:30 Pacific)`.
2. `receivedBefore` is exclusive. A lead whose canonical receipt timestamp is
   exactly 07:30 Pacific belongs to the post-checkpoint flow. The future
   new-arrival reader begins with `receivedAt >= checkpoint.receivedBefore`.
3. The checkpoint must persist the fixed preload key, source bounds, status,
   PII-free aggregate counts, and completion evidence. It must not store a
   phone number, display name, raw lead, raw provider payload, or secret.
4. Every bridge assignment remains independently reconstructable from the
   provider-neutral item ledger and its fixed packet/preload key. Provider
   acceptance, pending work, conflicts, and failures must reconcile before the
   checkpoint can be marked complete.
5. Older pre-checkpoint leads do not re-enter as new arrivals. They may become
   callable again only through the canonical cadence timer and daily-attempt
   rules, which is a separate due-work path.
6. The post-checkpoint flow stays dark until the Monday first-pass inventory
   proves provider acceptance, callback identity, outcome handling,
   appointment/DNC effects, and safe reconciliation. Enabling that flow is a
   separate Mickey-approved rollout action.
7. Rebuild tests must prove the exact boundary has no gap or overlap, including
   equal-timestamp ties, retry/restart with the same preload key, a partial
   provider run, and an older lead becoming due through cadence without being
   mistaken for a new arrival.

This checkpoint is the handoff between the temporary full-folder bridge and the
normal shallow-buffer runtime. It does not itself enable posting or refill.

Implementation evidence (2026-07-12):

- `LeadDeliveryCheckpoint` uses the checkpoint key as Mongo `_id`, so Monday's
  insert-once contract does not depend on a newly deployed secondary index.
- Apply persists `scheduled -> running -> partial|failed|completed` under
  versioned CAS. A completed checkpoint cannot be regressed by a stale retry.
- Counts and SHA-256 audit sets are rebuilt from the complete packet ledger,
  never from per-process progress. Completion requires admitted and accepted
  sets to match with zero unresolved, failed, conflicted, or capped work.
- The CLI reports only PII-free checkpoint status, cutoff, and counts and will
  not return success without a completed durable checkpoint.
- The exact Monday preview scanned 2,582 July rows, found 2,230 eligible, and
  allocated a dry balance of 446 per agent. Checkpoint document count remained
  zero before and after the preview, proving the preview stayed write-free.
- The complete provider-neutral lead-delivery suite passed 221/221 after the
  checkpoint lifecycle and RingCX single-owner startup gate were added. No live
  provider write or service restart occurred during this proof.

## 8. Persistent Data Shapes

### 8.1 `LeadDeliveryItem`

One document per lead/current attempt. Required fields:

```text
domain
caseId
leadCadenceId
normalizedPhone
displayName
sourcePool
receivedAt
overnightBatchKey
overnightOrder
nextContactAt
dailyAttemptDateKey
dailyAttemptCount
totalAttemptCount
lastContactAt
lastOutcome
state
activeAttempt
reservedAgentId
speedOverrideAgentId
reservedAt
reservationExpiresAt
freshDeadlineAt
packetId
deliveryAgentId
provider
providerContactId
providerExternalLeadId
providerAcceptedAt
providerCompletedAt
providerCallId
lastCountedProviderCallId
attemptedAt
terminalAt
version
metadata
createdAt
updatedAt
```

Allowed states:

```text
eligible
reserved
packetized
provider_accepted
in_call
follow_up_wait
terminal
blocked
delivery_failed
review
```

Required uniqueness/indexes:

- one active attempt for `(domain, caseId)`;
- unique non-null `providerExternalLeadId`;
- unique non-null `providerContactId` where provider scope requires it;
- indexes for `(state, sourcePool, nextContactAt)`;
- indexes for `(reservedAgentId, state)`;
- indexes for `(provider, providerCallId)`;
- version/CAS support for every state transition.

### 8.2 `LeadDeliveryAgent`

Required fields:

```text
agentId
displayName
enabled
shiftEnabled
activeUntil
lastProviderEvidenceAt
providerAcceptedCount
providerCompletedCount
estimatedOutstanding
openRefillRequest
refillRequestId
lastRefillRequestedAt
lastPacketAt
fairnessHourKey
fairnessTieBreaker
freshReservedThisHour
lastFreshReservedAt
pendingFreshCount
version
updatedAt
```

`estimatedOutstanding` is a fast projection, not sole truth. It must be reconstructable from active delivery items and repairable by reconciliation.

### 8.3 `LeadDeliveryEvent`

Required fields:

```text
provider
providerEventId
dedupeKey
providerCallId
providerContactId
providerExternalLeadId
eventType
receivedAt
normalizedOutcome
payloadDigest
status
attempts
nextAttemptAt
processedAt
lastError
```

Store only the safe normalized/captured payload required for replay. Do not log or expose raw tokens or unnecessary PII.

Unique key: `(provider, providerEventId)` when supplied; otherwise deterministic digest of stable provider call/event identity.

## 9. Agent Activity Model

An agent is eligible for new reservations only when:

```text
enabled == true
shiftEnabled == true
activeUntil > now
required folder configuration is complete
agent subscribes to the requested pool
agent has a positive allowance for `new_today`
estimatedOutstanding <= freshReservationRange for fresh work
pendingFreshCount < maxPendingFreshReservations
```

Evidence extends `activeUntil`:

- `contact_displayed`;
- `call_begin`;
- `call_done`;
- verified movement of one of our contact IDs from distribution to receiving;
- an explicit operator start-shift signal, if implemented later.

Do not extend activity merely because a folder contains contacts.

## 10. Hourly Fresh Fairness

### 10.1 Goal

No fixed Chris -> Sean -> Brad rotation. Give the newest lead to the eligible agent who has been served least during the current hour, while respecting an existing fair claim if that agent is close to needing more work.

### 10.2 Hour reset

At the first fairness operation in each Pacific hour:

1. Set `fairnessHourKey` to the new hour.
2. Reset `freshReservedThisHour` to zero.
3. Generate a deterministic shuffled tie-breaker from `(hourKey, agentId)` so restarts do not reshuffle the hour.
4. Preserve existing unexpired lead reservations; do not orphan them at the boundary.

No separate top-of-hour worker is required for correctness; lazy reset under atomic update is preferred.

### 10.3 Winner order

Rank eligible agents by:

1. lowest `freshReservedThisHour`;
2. oldest/null `lastFreshReservedAt`;
3. deterministic hourly tie-breaker;
4. stable agent ID as final deterministic tie.

When an agent receives a fresh reservation:

- increment `freshReservedThisHour` atomically;
- set `lastFreshReservedAt`;
- increment `pendingFreshCount`;
- thereby move that agent to the bottom of the current fairness order.

### 10.4 Example

```text
Chris has 1 provider lead remaining.
Sean has 2 provider leads remaining.
Brad has 3 provider leads remaining.
Brad owns the best current fresh weight.
```

If a new lead arrives, reserve it for Brad because 3 is within the configured reservation range. If Chris asks for a packet first, Chris receives other eligible pools; Brad's fresh reservation remains at the top of Brad's backend buffer.

## 11. Fifteen-Minute Fresh Reservation Lease

Fresh speed deadline is always anchored to lead receipt plus exactly 15 minutes, not renewed on each reassignment. A shorter configurable reservation lease may expire before that deadline, but a longer lease may never extend it:

```text
freshDeadlineAt = receivedAt + 15 minutes (absolute, non-configurable)
reservationExpiresAt = min(reservedAt + configured lease, freshDeadlineAt)
```

Behavior:

1. While `now < freshDeadlineAt`, respect the fair reservation.
2. When the reserved agent requests/refills, deliver that lead first.
3. If the reservation expires before delivery, release it atomically.
4. At/after `freshDeadlineAt`, speed outranks the prior weight.
5. Give it to the next eligible agent who has an open refill request/capacity.
6. Do not grant a new 15-minute window after reassignment.
7. Record every reservation/release reason for audit.

## 12. Provider Buffer and Packet Rules

### 12.1 Default sizing

Current controlled-floor defaults, configurable per agent:

```text
providerBufferTarget = 20
refillAtOrBelow = 5
freshReservationRange = 20
```

Keep the PhoneBurner side intentionally shallow because contacts added during an active LeadStream session append to the active list rather than jumping ahead.

### 12.2 Count by identities, not arithmetic alone

The immediate estimate is:

```text
accepted provider contacts
- idempotently completed provider calls
= estimated outstanding
```

But every accepted contact must remain individually represented. A naked mutable counter is insufficient.

### 12.3 Refill trigger

On an idempotent `call_done`:

1. Mark the matching delivery item completed/in follow-up/terminal.
2. Recompute or atomically decrement the agent projection.
3. If outstanding is at or below low-water, create one guarded refill request.
4. If a refill is already in flight, do not create another.
5. Refill only the deficit:

```text
needed = providerBufferTarget - currentOutstanding - acceptedInFlight
```

### 12.4 End-call offload and universal dialed ledger ruling (2026-07-13)

The backend owns call history and retry eligibility; PhoneBurner owns only immediate consumability and presentation:

1. `contact_displayed` is activity evidence, not a dial attempt.
2. `call_begin` proves the active physical call identity, but does not count a completed attempt.
3. One exact, idempotent `call_done` with provider call identity is the universal "has been dialed" record. It writes the attempt, outcome, daily count, completion time, and next eligible time before refill or downstream Logics/appointment work.
4. Blind Pull normally moves the contact from distribution to receiving when dialing starts. The receiving folder is therefore a parking location, not the retry clock and not the universal call ledger.
5. After local completion is durable, keep a nonterminal contact in PhoneBurner
   only when another same-day attempt is permitted. Delete the exact contact at
   its daily cap or on terminal/blocked/ineligible evidence. Provider `404` is
   an idempotent already-absent success.
6. PhoneBurner's configured two-hour cycle owns the mechanical same-day retry.
   The backend count and timestamp remain authoritative and may curatively
   remove the contact at any time.
7. Next-day and red-tier holds remain backend-owned. When those longer windows
   become due, all claim-time eligibility checks run again before creating a
   new PhoneBurner contact.
8. DNC, bad lead, appointment, client, answered, and unresolved review outcomes remain out of every distribution folder. Unknown/weak outcomes stay in review and cannot redial until stronger disposition evidence resolves them.
9. Agent outstanding capacity is read from two stable physical working-folder counts. The local count is a repairable projection only. `call_done` may open one guarded refill after local completion and exact provider cleanup are durable; downstream business actions cannot erase or recount the call.
10. A failed create, ambiguity reconciliation, or exact delete remains durable and retryable. It must never invent a second logical attempt.

The local item and immutable provider-attempt history are the universal ledger.
PhoneBurner working folders are consumable working sets, not history, cadence,
or outcome storage. The backend curates them from exact persisted evidence.

The complete PhoneBurner trigger, disposition-button, preset, authentication, and canary map is maintained in `docs/PHONEBURNER_WEBHOOK_ACTION_MATRIX_2026-07-13.md` and is part of this work order.

MVP cut line (2026-07-13): every exact PhoneBurner Call End owns attempt completion, capacity decrement, timer/terminal state, and guarded refill. Only DNC/Bad Lead invokes an application-side business action. A PhoneBurner appointment is a terminal/stat outcome only; the backend has no PhoneBurner appointment-execution subsystem.

### 12.4 Packet composition

Build the packet inside `leadDeliveryService.js`:

1. Unexpired fresh reservations for that agent, newest first.
2. Remaining slots dealt from subscribed pools according to that agent's allowances. The same explicit `packetPoolOrder` controls both the allowance and fallback passes; subscription array order never changes dialing order.
3. If one subscribed pool is short, fall through deterministically to other subscribed pools.
4. Recheck eligibility at atomic claim time.
5. Claim exactly the number needed; do not pre-claim the next packet.
6. Post contacts one at a time and wait for PhoneBurner acceptance.
7. Mark `provider_accepted` only after an accepted response returns a provider contact ID.
8. On rejection, release or mark retryable according to explicit failure classification.

### 12.5 Scheduled floor close (superseding ruling, 2026-07-13)

Mickey's latest floor instruction supersedes the earlier natural-drain-only rule:

1. Provider contact creation remains closed at 17:00 America/Los_Angeles.
2. On the first existing lead-delivery runtime tick at or after 17:30 Pacific, the same runtime owner closes every configured production folder pair for the day and drains both working folders. Delivery enablement does not exempt a configured agent from floor close.
3. Do not create a second scheduler, shell child process, or independent cleanup service. Restart after 17:30 must catch up through the normal runtime tick.
4. Enumerate and delete by exact PhoneBurner contact identity only. Never match or delete by phone, name, timing, or folder count alone.
5. Serialize the close behind the existing provider-mutation lane so a queued contact create cannot land behind the drain.
6. Treat provider `404` as already absent. Respect `429`/`Retry-After`, leave the day incomplete, and retry from durable identity on a later tick.
7. Preserve enough provider-attempt identity after deletion for a delayed exact Call End to resolve and count once. Folder deletion never counts a call attempt and never invents an outcome.
8. Release undialed packet/provider assignments back to the canonical backend pool only through versioned compare-and-set. A concurrent Call End or newer attempt wins.
9. Mark an agent closed only after both working folders have two agreeing zero-count reads and the local outstanding projection is repaired to zero.
10. Callback capture and event drain remain alive during and after the floor close. Closing delivery must not stop outcome, DNC, appointment, or call-memory processing.
11. The daily close applies to every production agent present in `config/lead-delivery-agents.json` with a valid distribution/consumer folder pair, including a temporarily delivery-disabled agent. Unconfigured folders and folders outside that production mapping are not touched.
12. Weekend pre-positioning must run after the final scheduled close for that calendar day; otherwise the 17:30 close intentionally removes it.
13. A large folder is drained in bounded, rate-safe chunks. A per-run limit must make progress; it may never reject the entire folder merely because the folder is larger than one chunk.
14. Closed, undialed provider assignments remain identity-bearing tombstones through the end of that Pacific date. The first normal tick on the next Pacific date releases every such item back to the shared pool, whether or not yesterday's agent returns.
15. If the exact prior-day Call End arrives after release or after a newer attempt is posted, count and action the historical attempt from immutable attempt history. Ordinary retry/review outcomes do not delete, refill from, or overwrite the newer attempt's provider identity or lifecycle. A lead-level terminal outcome (`dnc`, `bad_lead`, `appointment`, or `client`) is the explicit exception: cancel an exact queued newer contact without counting it; if the newer contact is already `in_call`, let that physical call finish and then enforce the historical terminal lifecycle without firing the historical business action twice.
16. Historical business date comes from exact call-begin evidence when present. Without call-begin, a provider acceptance on an earlier Pacific date than daily removal is pre-positioning evidence, not a dial; anchor the attempt to the removal/close date. Webhook receipt time never manufactures a new business day or agent-presence lease.
17. A close tombstone applies only to its exact `providerAttemptSequence`. A stale tombstone may not hide, release, or suppress a newer accepted attempt. Completion metrics are reconstructed from unique immutable item-attempt completions so restart between item and agent writes cannot lose or double-count the metric.
18. The exact-attempt `delete_pending` compare-and-set is the close/Call Begin ordering fence. If Call Begin wins first, close must defer and leave the provider contact intact. If close intent wins first, a later Call Begin cannot transition the item to `in_call`; close owns and removes that contact.

### 12.5.1 Bounded morning launch ruling (2026-07-15)

Mickey's latest floor instruction makes morning availability a hard operating
constraint:

1. From 07:50 Pacific, every configured active agent must receive a usable
   shallow packet within ten minutes, including after a late Windows restart.
2. Morning launch may refresh one bounded newest-first page of active,
   nonterminal LeadCadence rows before posting so overnight arrivals are
   represented.
3. Morning launch must not await a full LeadCadence scan or rewrite every
   durable delivery item. The provider-neutral store is already the claim and
   identity ledger.
4. Fill low physical Pools immediately from already-eligible durable items.
   Re-read only the selected row at claim time before provider POST.
5. Continue the exhaustive source reconciliation in bounded background ticks.
   Meticulous repair, DailyDial projection, and folder cleanup may run at the
   end-of-day boundary; they may not gate the next morning's packets.
6. The previous full-scan-before-post implementation remains disabled during
   the no-delete proof window and is pending physical deletion after floor
   evidence and Mickey approval.

### 12.6 Provider-wide contact-post lane

The five shallow agent buffers share one PhoneBurner contact-create lane. Agent
fairness decides *which* durable work item is next; it does not create five
independent API writers.

Initial canary policy:

```text
providerPostConcurrency = 1
providerPostMinimumIntervalMs = 6000
maximum logical contact starts = 10/minute
expected floor consumption = 3-5/minute
```

Ten per minute is an operating limit with two-times expected sustained
headroom, not a claim about PhoneBurner's undocumented maximum. At that rate a
worst ordinary synchronized refill (five agents moving from one contact to five)
is flattened into roughly two minutes instead of a 20-request burst. A bounded
transport replay can create two physical POSTs inside one logical turn, keeping
the worst retry envelope near 20 physical POSTs/minute. Adjust the limit
only from measured queue delay, provider responses, and PhoneBurner guidance; do
not discover the ceiling by flooding the live account.

Rules:

1. Every logical `createContact` attempt, including recovery/reconciliation,
   enters the same FIFO lane.
2. Acquire the lane before the per-item provider-post lease, then reload and CAS
   the item. Queued work must not burn its item lease while waiting.
3. The lane uses a durable cross-process mutex with a bounded crash lease plus a
   process-local FIFO. Heartbeat the mutex during long reconciliation/provider
   work, then hold it until the request finishes and the minimum start interval
   has elapsed. Lost renewal opens a fail-closed provider circuit.
4. A second action-capable process may not bypass the same durable lane key.
5. A `429` is retryable backpressure, never terminal lead failure. Preserve the
   exact external ID, clear the item post lease, abort the rest of that packet,
   apply `Retry-After` when present, and otherwise use a bounded cooldown before
   retry. Extend the durable lane lock through the cooldown and intentionally let
   it expire; do not hold the callback/refill caller or delete the cooldown lock.
6. Provider ambiguity still reconciles the exact external identity before any
   retry. Pacing never weakens idempotency. Every tick automatically recovers
   existing `packetized` work (including `prepared`, stale `posting`, and
   `reconcile_required`) without claiming a refill deficit. This recover-only
   path remains active when refill is off and for explicit pre-positioned work
   that intentionally has no shift activity evidence.
7. Event/refill processing is decoupled from physical posting after the complete
   available deficit is durably packetized. A full packet releases the refill
   owner before entering the provider lane; a partial packet retains one durable
   refill owner through its limited provider work. Callback event completion does
   not wait on provider latency. Same-agent hangups coalesce and request one exact
   recompute after the active refill, while the five-minute crash leases remain a
   recovery bound rather than the expected provider-work duration.
8. Safe health state exposes the configured interval, queue depth, in-flight
   count, last/next start timestamps, accepted count, rate-limit count, background
   refill count, and fail-closed circuit state. It exposes no contact payload,
   phone, name, folder ID, or provider token.
9. PhoneBurner's published monthly import allowances do not say whether REST
   contact creation consumes them. Treat that as an explicit rollout question;
   deleting/recycling contacts is not assumed to restore allowance.

## 13. New-Lead Arrival Without a Hangup

When a brand-new lead arrives:

1. Validate and insert it into `new_today`.
2. Calculate the fair winner immediately.
3. Reserve it immediately if an eligible agent is within fresh-reservation range.
4. Do not wait for a hangup to establish ownership/weight.
5. Deliver immediately only if that agent has an open deficit/refill request.
6. Otherwise keep it first in that agent's backend buffer for the next request.
7. At the 15-minute deadline, offer it to the next eligible requesting agent.

This separates fair ownership from physical PhoneBurner delivery.

## 14. PhoneBurner Adapter Contract

`phoneBurnerClient.js` may borrow and clean the historical implementation's proven OAuth and REST calls. It exposes only normalized transport operations:

```text
createContact(input)
getContact(contactId)
listFolderContacts(folderId, options)
getFolderCount(folderId)
moveContact(contactId, folderId)
deleteContact(contactId)
listDialSessions(options)
getDialSession(dialSessionId)
refreshAccessToken()
```

Rules:

- no allocation logic;
- no pool selection;
- no retry timer decisions beyond bounded transport retry;
- no logging raw phone numbers, tokens, or payloads;
- refresh tokens securely and atomically;
- return a small normalized result with status, contact ID, and safe error classification;
- support injected fake transport for tests;
- never default to a folder ID.

Contact POST must include:

- stable unique provider external lead ID;
- correct owner/member identity if required;
- exact agent distribution folder ID;
- normalized contact fields;
- duplicate behavior chosen explicitly, never implicit update-by-phone.

## 15. PhoneBurner Callback Contract

The callback route must:

1. Authenticate using the configured webhook secret/signature.
2. Capture safe event identity durably.
3. Return success promptly after durable capture.
4. Never perform Logics or appointment network calls inline.
5. Normalize supported events:
   - contact displayed;
   - call begin;
   - call done/post-call status;
   - disposition.
6. Resolve by provider call/contact/external IDs.
7. Refuse phone-only ownership.
8. Treat duplicate delivery as a successful no-op.
9. Put unknown/malformed dispositions into `review`; never invent `no_answer` merely because a call disappeared.

## 16. Outcome and Cadence Rules

Initial normalized outcomes:

| PhoneBurner outcome | Normalized result | Lead-delivery action |
|---|---|---|
| No Answer | `no_answer` | increment attempt; due again in two hours if under daily max |
| Voicemail | `voicemail` | increment attempt; due again in two hours if under daily max |
| Busy | `busy` | increment attempt; due again in two hours if under daily max |
| Congestion / Intercept | explicit normalized no-connect subtype | increment attempt; due again per policy |
| DNC | `dnc` | terminal; enqueue Logics DNC action |
| Bad Lead / Bad Number / Wrong Number | `bad_lead` | terminal; enqueue the same Logics DNC path unless Mickey changes policy |
| Appointment | `appointment` | terminal for dialing and retained for reporting; no backend scheduling action |
| Client | `client` | terminal |
| Answered | `answered` | record concrete outcome; do not invent follow-up without disposition policy |
| Unknown | `review` | no automatic terminal/cadence decision |

The daily attempt limit is three. Retry delay initially is two hours. Both must be single policy values, not repeated constants.

## 17. Existing Code That May Be Borrowed

Borrow behavior only with focused tests and provider-neutral names:

- contactability, business-hours, timezone, daily-count, and cooldown calculations from `cxQueuePolicyService.js`;
- atomic claim/release/CAS patterns from `cxDialQueueRepository.js` and `cxQueueReservationService.js`;
- due-action reading from `universalQueueService.js`;
- per-agent shallow packet concepts from `agentSliceService.js`;
- reservation expiry concepts from `freshLeadAssignmentService.js`;
- idempotent durable outbox/drain patterns from `cxTerminalOutboxRepository.js` and `cxTerminalOutboxDrain.js`;
- PhoneBurner OAuth/contact/folder operations from historical `services/phoneBurnerService.js`.

Rules for borrowing:

1. Copy the smallest coherent function, not an entire service.
2. Rename CX/RingCX-specific vocabulary.
3. Remove environment reads from pure logic; pass policy as input.
4. Add tests that state the new business rule.
5. Do not import `cxCadenceService.js` into the new decision owner.
6. Existing downstream appointment/Logics functions may be called through injected handlers after durable events.

## 18. Code That Must Not Be Reused as Runtime Machinery

- `CxDialQueue` model/repository as the new store;
- `QueueItem`/UCQ and `AgentSlice` collections;
- `cxBulkLoadRuntimeService`;
- `cxBulkLoadRingcxPublisher`;
- RingCX active-call watchers;
- RingCX off-hook/presence/self-heal services;
- CX direct four-agent feeder;
- RingCX system-disposition polling;
- caller-ID suspect watchdog;
- browser/UI call-outcome buttons;
- historical PhoneBurner morning folder cascade policy;
- in-process-only round-robin state.

## 19. Concurrency and Idempotency Requirements

Every state-changing operation must be safe with multiple workers:

- work item claims use state+version compare-and-set;
- agent refill uses one lock/in-flight marker per agent;
- immediate-fresh claim uses item CAS; only provider acceptance advances the
  durable fair-pick cursor, and a failed cursor commit is visible and stops the
  worker before another assignment;
- callback events are insert-once;
- provider acceptance is keyed by our external lead ID;
- call completion is keyed by provider call ID;
- reservation expiry matches the reservation owner/version it is expiring;
- a failed provider POST cannot leave a phantom outstanding count;
- a successful provider POST followed by local timeout is reconciled by external lead ID before retrying;
- no phone-only dedupe or ownership.

## 20. Reconciliation

Reconciliation is repair, not a competing owner.

Per active agent, periodically:

1. List the configured distribution folder.
2. Optionally list the receiving folder if API visibility is reliable.
3. Match only our external lead IDs/provider contact IDs.
4. Compare with locally `provider_accepted`/`in_call` items.
5. Repair estimated outstanding count.
6. Mark unexplained differences for review.
7. Never infer a call outcome from absence alone.
8. Never refill above target merely because a read failed.

## 21. Observability Without PII

Structured events:

```text
lead_delivery.pool_upserted
lead_delivery.fresh_reserved
lead_delivery.fresh_posted
lead_delivery.reservation_expired
lead_delivery.refill_requested
lead_delivery.packet_built
lead_delivery.provider_accepted
lead_delivery.provider_rejected
lead_delivery.call_event_captured
lead_delivery.call_completed
lead_delivery.follow_up_scheduled
lead_delivery.terminal_recorded
lead_delivery.reconciled
lead_delivery.reconcile_failed
```

Allowed identifiers in routine logs:

- agent key;
- domain;
- masked/hashed case identity;
- work-item ID;
- provider contact/call ID when not PII;
- pool;
- counts;
- reason codes.

Never print full phones, tokens, raw provider payloads, or lead PII.

## 22. Feature Activation and Coexistence

The new runtime starts dark:

```text
LEAD_DELIVERY_ENABLED=false
LEAD_DELIVERY_PROVIDER=phoneburner
LEAD_DELIVERY_CALLBACK_CAPTURE_ENABLED=false
LEAD_DELIVERY_ACTIONS_ENABLED=false
LEAD_DELIVERY_REFILL_ENABLED=false
```

Activation sequence:

1. Models/indexes and pure tests only.
2. Read-only pool preview.
3. Callback capture only.
4. Mickey-only PhoneBurner delivery folder.
5. One-agent shallow packet with synthetic/test contacts.
6. One-agent real-lead canary.
7. Multi-agent shadow allocation without posting.
8. Multi-agent controlled posting.
9. Retire old direct CX/PhoneBurner feeders only after evidence and Mickey approval.

Never allow the new service and an old feeder to deliver the same lead population simultaneously.

## 23. Implementation Phases and Proof Gates

### Phase 0 — durable contract

Work:

- write this document;
- add `AGENTS.md` re-read pointer;
- make no runtime code changes.

Gate:

- document exists;
- folder IDs blank;
- git diff contains instructions only.

### Phase 1 — pure decision core

Work:

- create `leadDeliveryService.js` with pure/injected decisions first;
- implement pool classification, packet deficit, packet recipe, fairness rank, lease deadline, and outcome transition as pure functions;
- no Mongo, HTTP, routes, timers, or server wiring.

Tests:

- mutual-exclusive pool classification;
- today newest-first;
- follow-up most-overdue-first;
- allowance fallback;
- Brad/Chris/Sean fairness example;
- hourly lazy reset and deterministic tie-break;
- 15-minute deadline does not renew;
- target five/low-water one deficit math;
- max-three daily attempts;
- unknown outcome becomes review.

Gate: all pure tests pass; main service is the only decision owner.

### Phase 2 — provider-neutral persistence

Work:

- add three models and one repository;
- add unique indexes and CAS operations;
- no PhoneBurner writes.

Tests:

- one active attempt per lead;
- atomic reservation race has one winner;
- refill lock has one winner;
- duplicate event insert is a no-op;
- reservation expiry cannot release a newer reservation;
- counts reconstruct from item state.

Gate: repository tests pass against test doubles and, where available, Mongo integration.

### Phase 3 — PhoneBurner transport adapter

Work:

- implement normalized client by borrowing historical REST/OAuth code;
- all folder IDs remain blank in config;
- fake-transport tests only unless Mickey explicitly authorizes Mickey-folder calls.

Tests:

- contact payload contains stable external ID and exact folder;
- no default folder;
- accepted response requires contact ID;
- 401 refresh/retry is bounded;
- ambiguous timeout reconciles before retry;
- logs mask sensitive data.

Gate: adapter tests pass; no production agent contacts posted.

### Phase 4 — callback capture

Phase 4 capture rulings (2026-07-10):

- Use distinct authenticated callback paths for `contact-displayed`, `call-begin`, `call-done`, and `disposition`; do not infer the source hook from an overlapping body shape.
- Canonicalize the disposition hook to `eventType: call_done`. Preserve `sourceHook: disposition` only as safe metadata so general call-done and disposition hooks cannot create two outcomes for one provider call.
- While actions are disabled, a well-formed event with hard occurrence and lead identity stays `pending` and replayable. The disabled asynchronous drain may preview exact-ID resolution, but it must not claim, complete, or mutate the event or work item.
- Unsupported events, unknown dispositions, and callbacks missing hard occurrence/lead identity are durably retained as `review`. A payload digest may dedupe only a review event; it can never make that event processable.
- The documented contact-displayed example does not prove a per-occurrence call/event identity. Without one, capture it for review and do not treat it as presence or delivery evidence.
- MVP override (2026-07-13, Mickey): callback intake is temporarily unauthenticated because reliable custom-header delivery was not established. Do not use query, body, or URL secrets. Capture remains exact-`true`, bounded, durable, deduplicated, and action processing still requires exact stored provider identity. Restore a provider-compatible authentication boundary after live flow proof.
- `LEAD_DELIVERY_CALLBACK_CAPTURE_ENABLED` is exact-`true` and defaults off. Merely having the shared webhook secret configured must never activate this route after a restart.
- The code-level Phase 4 gate uses a local signed HTTP canary to prove durable capture, duplicate handling, prompt acknowledgement, and replay. A real PhoneBurner-originated header canary is an explicit Phase 5/6 prerequisite, not something tests may assume.

Work:

- add the source-specific callback route, temporarily unauthenticated for the 2026-07-13 MVP;
- durable insert-once;
- asynchronous drain;
- actions remain disabled.

Tests:

- bad secret rejected;
- duplicate event accepted once;
- route returns quickly despite disabled/failed downstream action;
- identity resolves without phone matching;
- unknown disposition enters review.

Gate: signed canary event captured and replayable.

Phase 4 evidence (2026-07-10):

- focused authenticated callback-route tests: 10/10 passed;
- complete provider-neutral lead-delivery suite: 98/98 passed;
- syntax and diff checks passed;
- local signed HTTP canary proved durable-before-ACK capture, call-done/disposition dedupe, review-only malformed capture, PII exclusion, pending replay, and disabled actions;
- adversarial re-review passed after capture was changed to exact-true/default-off and duplicate/failed replay was aligned;
- no live PhoneBurner request was made and actual PhoneBurner custom-header delivery remains explicitly unproven.

### Phase 5 — configuration handoff

Work:

- generate agent config with every folder ID blank and every agent disabled;
- hand Mickey the exact PhoneBurner setup checklist;
- Mickey creates folders/LeadStreams and returns IDs;
- insert IDs without printing secrets;
- validate read-only folder access.

Gate: each enabled agent has verified unique distribution/receiving folder and Blind recipient configuration.

Phase 5 evidence (2026-07-10):

- `config/lead-delivery-agents.json` contains five disabled agents and only Mickey-supplied folder pairs; Mickey's `Pool ID` maps to `distributionFolderId` and `Consumer ID` maps to `receivingFolderId`;
- all five dark entries share the approved starting packet policy: all four pools, `new_today: 2`, and one from each remaining pool, with target five/low-water one;
- official PhoneBurner contact-create documentation and the historical working integration prove owner fields are optional; the validator and adapter no longer invent five separate owners or require duplicate LeadStream IDs;
- Mickey reported the Blind Pull LeadStreams, dispositions, and appointment-with-date action configured in PhoneBurner and designated Bruce Allen as the first active canary;
- a refresh-disabled, PII-safe live read proved all ten supplied distribution/receiving folders reachable through the configured OAuth owner; every folder returned HTTP 200 and count zero;
- the live empty-folder shape (`page_size: 0`) is normalized explicitly and covered by a regression test;
- focused configuration/transport/read-only-validation tests passed;
- complete provider-neutral lead-delivery suite: 108/108 passed;
- `docs/PHONEBURNER_LEAD_DELIVERY_CONFIGURATION_HANDOFF_2026-07-10.md` contains the external setup and return checklist;
- independent configuration/handoff re-review passed after unknown-field rejection and the executable header-canary sequence were made explicit;
- Monday-readiness audit found that only `LEAD_DELIVERY_CALLBACK_CAPTURE_ENABLED` is currently server-wired; the enabled/actions/refill switches must remain off until the Phase 6 runtime owns pool ingestion, posting, outcome actions, refill, and reconciliation;
- Phase 5 gate passed. The first real PhoneBurner callback/header proof remains the first action-dark condition of Phase 6; no outcome or refill action may run before it passes.

### Phase 6 — Bruce canary

Work:

- build and wire the persistent runtime owner with all posting/actions/refill dark by default;
- enable Bruce Allen only after a posting-dark preview;
- target five, low-water one;
- seed small controlled contacts;
- prove the first real callback reaches the authenticated capture route before enabling event actions;
- verify active LeadStream consumes live additions;
- verify call event decrements and triggers exact deficit refill.

Gate:

- no restart needed for live additions;
- accepted IDs reconcile;
- no duplicate calls;
- newest reserved work is bounded by shallow buffer;
- drain stops cleanly when refills disabled.

Phase 6 code evidence (2026-07-10; live canary still pending):

- the persistent control-plane runtime owns cadence ingestion, fair fresh reservations, shallow PhoneBurner posting, exact-ID callback drain, outcome state, guarded refill, and reconciliation behind four exact-off switches;
- all known legacy CX and PhoneBurner voice writers are conflict-checked, and queued/HTTP legacy PhoneBurner round/manual work is suppressed when the new owner is enabled; SMS, email, and RVM cadence remain active;
- cadence migration preserves the maximum proven daily attempt count, the latest voice touch, and the two-hour follow-up timer; scheduled appointments, DNC, payment/client, closed, and conflicting authoritative status evidence fail closed;
- explicit weekend pre-positioning can fill only the configured shallow deficit and participate in persisted fresh fairness without manufacturing ongoing agent activity; automatic refill still requires current provider evidence and the legal contact window;
- PhoneBurner appointments use a provider-neutral appointment mode and never read, create, or transition `CxDialQueue`; refill is driven from durable local completion before downstream Logics/appointment retry;
- the public callback prefix bypasses nginx user-session auth only for the bounded PhoneBurner callback paths; the temporary MVP app intake does not require a secret and exact stored provider identity remains mandatory before action;
- all declared exactly-once indexes are already present in the shared Mongo database; one redundant non-unique provider-external-ID index remains intentionally untouched;
- complete provider-neutral lead-delivery suite: 173/173 passed; targeted cross-system regression suite: 43/43 passed; syntax and diff checks passed;
- read-only Mongo evidence currently shows zero captured PhoneBurner callbacks, so live header arrival remains unproven and posting/actions/refill remain off;
- known non-blocking Phase 6 limitation: the cadence adapter has no authoritative current-day overnight snapshot/batch key. It does not guess one; those callable rows fall deterministically into `older_available`, so packet supply works but the `overnight` label/allowance remains unused until a real snapshot input exists.
- 2026-07-10 pacing ruling: all five agents share one contact-post lane at an initial six-second minimum start interval (10 logical creates/minute, concurrency one). This is a conservative operating limit with two-times the estimated floor demand and room for the adapter's bounded second physical attempt, not a discovered PhoneBurner ceiling. The implemented lane packetizes before provider leases, renews its durable mutex, extends it across `Retry-After`, aborts a packet on the first `429`, decouples callback completion from provider latency, coalesces same-agent refill pressure with an exact rerun, and exposes PII-free backpressure/circuit health. Live Bruce proof remains pending.
- post-pacing proof: complete provider-neutral lead-delivery suite 191/191; targeted CX/server regression slice 79/79; syntax and diff checks passed. The load proof is synthetic and made no PhoneBurner write. Remaining live gates are the real callback/header canary and the one-agent Bruce post/refill canary.
- 2026-07-13 bridge reconciliation: Bruce was out of office, so an explicit dry-run-first operator command moved the 445 contacts still visible in his PhoneBurner folders to Brad, Phil, Sean, and Chris by exact provider contact ID. Every provider success was followed by a versioned owner-ledger change; the one contact already absent before the operation remained untouched. Final provider proof was Bruce `0/0` and active-agent visible totals `557/556/556/556`; the ledger recorded exactly 445 PII-free redistribution markers.
- The live move exposed two read-shape facts now covered by regressions: PhoneBurner may report the actual row count as `page_size` on a final partial page, and exact-contact reads place the folder identifier under a nested category object. The complete provider-neutral suite passed 227/227 after those normalizations. No runtime agent documents, callback actions, refill actions, writer switch, or service restart were manufactured for this bridge operation.
- 2026-07-13 floor-control ruling: the background runtime cadence defaults to one hour (`LEAD_DELIVERY_TICK_INTERVAL_MS`, with a one-minute hard floor). A late arrival enters through the authenticated per-agent `launch` control, which opens a 75-minute evidence lease and performs the same shallow explicit seed. The authenticated `cancel` control durably pauses the agent and blocks new packets/refills; delayed provider callbacks may still record real call evidence but cannot undo that operator pause. These are backend contracts for a later floor-shape UI. All checked-in agents and all write/refill flags remain off pending the live canary gates.

### Phase 7 — one real agent

Work:

- one agent, one business-day slice;
- compare backend work items, PhoneBurner contacts, calls, outcomes, and Logics/cadence effects.

Gate: every accepted contact has one explainable terminal/follow-up state; no lead exceeds three daily attempts.

### Phase 8 — multi-agent fairness shadow

Work:

- calculate allocations for active agents without posting;
- prove hourly weights, leases, subscriptions, and allowances against real arrival/refill timing.

Gate: no offline agent wins; no fresh lead is trapped beyond 15 minutes; distribution is explainable.

### Phase 9 — controlled floor rollout

Work:

- enable posting one agent at a time;
- keep rollback as disabling the new refill writer, not deleting data;
- observe folder counts, callbacks, reconciliation, and outcomes.

Gate: stable full-day evidence and Mickey approval before old-path deletion.

Phase 9 daily-close hardening evidence (2026-07-13):

- the existing runtime tick owns the 17:30 Pacific close; no second scheduler or service was added;
- every configured production folder pair is closed even when its agent is temporarily delivery-disabled; agents are paused before the provider lane, both working folders drain by exact contact ID in bounded rate-safe chunks, and two stable zero reads close each agent;
- 404, 429/Retry-After, crash-after-delete recovery, missed-close restart catch-up, `in_call` deferral, same-evening/post-midnight/post-release historical Call Ends, Sunday preposition-to-Monday dating, next-day floor-wide release, and explicit post-close preposition have focused coverage;
- exact terminal outcomes cancel queued newer contacts or defer safely through an already-active call; old callbacks cannot refresh agent presence, stale close markers cannot hide newer attempts, and the completed metric reconstructs from immutable attempt history after a process loss;
- weak Call Ends can be strengthened while pending, processing, failed, or completed without recounting; durable effect context owns crash replay;
- close health retains only aggregate/per-agent status and counts; provider identity and lead data remain absent;
- complete provider-neutral lead-delivery suite: 287/287 passed; targeted Boring/CX regression slice: 139/139 passed; syntax checks passed; no live provider mutation was made by this proof;
- live activation still requires the authorized Windows control-plane restart and controlled-floor observation. Physical deletion remains gated on the stable full-day proof and Mickey approval.

Phase 9 productivity-rebalance ruling (2026-07-15):

- Ordinary Call End ownership does not change: read the exact agent's physical
  Pool and, below low water, post one normal packet. Productivity rebalance is
  a separate quarter-hour curation pass and may never become a second ordinary
  refill scheduler.
- The pass waits one complete 15-minute window after process start. It derives
  activity only from exact persisted PhoneBurner Call Ends in the preceding
  15 minutes. An agent with a current exact `in_call` item is never culled.
- If no other enabled agent has a recent exact Call End, the pass does nothing.
- A non-consuming agent loses the contacts physically present in that agent's
  distribution Pool except for exactly six contacts aged 17 days or more. If
  fewer than six are already present, the service first posts enough eligible
  yellow/red queue rows to complete the six-contact cushion; only then may it
  move the blue/newer work. Age 17-31 is the yellow cushion and age 32+ is the
  red cushion. The Consumer folder is not edited because PhoneBurner may already
  have cached that work.
- A cull runs only when all Pool contacts resolve by exact provider contact ID
  and the six yellow/red cushion is already present or can be completed first.
  Unknown identities or an incomplete aged top-up fail closed and move nothing.
- Every culled contact is moved by exact PhoneBurner contact ID directly from
  the non-consuming agent's Pool into an active agent's Pool, round-robin across
  the enabled agents that proved a Call End in the same 15-minute window. This
  preserves the provider identity and PhoneBurner recycle timing, consumes no
  upload, and does not leave the contact waiting in Mongo.
- The move is intent-marked before the provider call and ownership is updated
  by CAS after provider success. If the ownership CAS loses, the provider move
  is rolled back to the source Pool; an uncertain move fails closed for further
  curation. Current calls, daily caps, exact identities, and the existing Call
  End counter remain authoritative.
- The culled agent is not immediately refilled. Its six aged contacts are the
  continuity cushion; later real consumption reaches low water and the existing
  Call End path earns the next normal packet.
- The provider lane and one in-process rebalance owner serialize cull moves,
  redistribution, and ordinary refills. Restart/replay re-reads physical
  identities and therefore cannot release a contact solely from stale memory.

Phase 9 productivity-rebalance implementation evidence (2026-07-15):

- production wiring enables the pass inside the existing lead-delivery runtime;
  no second service, timer process, route, or provider writer was added;
- the restart warm-up, exact recent-Call-End activity read, six yellow/red
  cushion, Pool-only identity resolution, exact contact move, round-robin active
  destinations, move rollback, and post-cull normal posting have focused tests;
- focused runtime tests passed 3/3; the refill/day-start/productivity regression
  slice passed 9/9; repository suites passed 34/34; repository recent-activity
  proof passed; control-plane wiring passed 3/3; syntax and diff checks passed;
- the broad runtime/service test invocation reached its existing 124-second
  timeout without emitting an assertion failure, so it is not represented as a
  full-suite pass;
- no live PhoneBurner mutation or Windows service restart was performed. Mickey
  still owns the `ParallelControlPlane` restart that loads this implementation.

Phase 9 aged-cushion correction evidence (2026-07-15):

- live read-only proof showed Bruce's Pool had one red and forty blue/newer
  exact records; the original retain-only guard correctly explained why the
  first pass moved zero but did not implement the intended swap;
- the decision owner now posts only the missing eligible age-17+ cushion rows,
  proves all six were accepted, and only then moves the original blue/newer
  Pool contacts to active agents;
- a partial/unavailable cushion fails closed before any redistribution;
- focused productivity tests passed 4/4, including provider-operation ordering
  that proves all cushion creates precede every contact move; no live mutation
  or Windows service restart was performed by Codex.

Phase 9 universal fair-pick ruling (2026-07-15):

- one singleton per work type stores only the fixed `agentOrder` and durable
  `lastPickedAgentId` business values; `nextFairPick` receives temporary
  exclusions from the caller;
- it advances exactly one position at a time, skips excluded agents without
  resetting or reweighting the ring, wraps deterministically, and returns null
  when every agent is excluded;
- ordinary fresh assignment and undialed-list redistribution converge on this
  primitive using separate `fresh` and `redistribution` cursors. The expired
  fresh speed deadline lets the active requester take an ordinary reservation
  without consuming a fair turn; it no longer creates a separate speed-override
  posting identity;
- the pure helper, exclusion/wrap behavior, Mongo cursor model, and CAS retry
  have focused test proof;
- the live fresh reservation and productivity-move callers now use those
  cursors. The checked-in floor activity lease is 15 minutes; day start grants
  only that initial proof window while posting the first packet, and exact
  completed Call Ends renew the same 15-minute window. The old hourly fresh rank
  is no longer a live fresh-selection owner. Immediately before composition,
  the simple packet operator refreshes reservations and accepts at most one
  `new_today` row only when its unexpired `reservedAgentId` matches that agent.
  A packet therefore cannot steal unreserved or differently owned fresh work.
  Focused productivity, fresh,
  lifecycle, model, repository, configuration, and syntax gates pass. No live
  provider mutation or Windows restart was performed by this proof.

Phase 9 immediate-fresh replacement evidence (2026-07-15):

- This ruling supersedes the reservation/packet portion of the universal
  fair-pick evidence above. `new_today` is no longer a bulk packet pool and no
  live caller invokes the former reservation, speed-override, pending-count, or
  hourly least-served machinery.
- Source ingestion dispatches newest eligible fresh rows immediately to the
  next exact-recently-active agent in the fixed `fresh` ring. Pool depth,
  estimated outstanding, packet timing, and refill state are not inputs.
- The item is claimed by versioned CAS and posted through the existing paced
  provider lane. The durable cursor and accepted-fresh metric advance only
  after provider acceptance. A malformed activity row fails closed for that
  agent without blocking another valid active agent.
- A scoped exact Call End persists activity and signals the single fresh
  worker without waiting for fresh provider latency. No active agent leaves the
  row eligible for the next minute tick or Call End; receipt plus 15 minutes is
  the overdue alert boundary, not a bulk reservation wait.
- Ordinary low-water, day-start, legacy seed, pre-position, and direct packet
  paths exclude `new_today`. Focused fresh/runtime proof passed 16/16 and the
  service/repository/configuration/callback/server-wiring regression gate passed
  103/103. Syntax checks passed. No live provider mutation or Windows restart
  was performed by this proof.

Phase 9 daily-cap posting hardening evidence (2026-07-15):

- A retryable or review Call End that reaches its age-based daily cap remains
  in `follow_up_wait` for audit and metrics but carries no `nextContactAt`.
  The next Pacific-day source refresh re-evaluates it from canonical age and
  attempt evidence; a capped row does not manufacture its own release timer.
- Source refresh takes the maximum proven same-day count and cannot restore a
  stale same-day cadence timer after that maximum reaches the cap.
- Both ordinary and immediate-fresh posting paths recheck the same pure
  age-based daily-cap verdict immediately before claiming or retrying provider
  work. A capped row is held with no due time and no provider POST.
- Focused outcome/cap proof passed 3/3; focused runtime cap and resurrection
  proof passed 4/4; fresh plus cap runtime regression passed 21/21; the
  service/repository/configuration/callback/server-wiring gate passed 104/104.
  Syntax checks passed. No live provider mutation or Windows restart was made
  by this proof.

## 24. Tests Required Before Any Live Write

At minimum:

```text
pool classification
pool ordering
packet allowance composition
fairness hourly reset
immediate fresh winner and newest-first ordering
fresh waits without exact recent provider evidence
provider rejection does not advance the fresh cursor
ordinary packet cannot claim fresh work
atomic claim race
atomic refill lock
provider acceptance/rejection
ambiguous POST reconciliation
five-agent provider-post serialization and minimum start spacing
queued item has no provider-post lease before its lane turn
429 retry/cooldown without terminal failure
paced 20-contact burst cannot outlive event/refill ownership
event idempotency
call-done decrement
refill deficit
two-hour follow-up
three-attempt daily maximum
DNC/bad lead terminal action
appointment action
unknown disposition review
reconciliation repair
drain without refill
```

## 25. Definition of Done

The rewrite is done only when:

1. Agents start one Blind Pull LeadStream and do not switch folders during ordinary work.
2. The provider pool remains intentionally shallow.
3. New leads are fairly reserved immediately and delivered on the winner's next capacity request.
4. No fair reservation holds a new lead past its 15-minute receipt deadline.
5. Follow-ups become due from one timer source after two hours.
6. No lead receives more than three attempts per Pacific business day.
7. Agent subscriptions/allowances determine packet composition.
8. Every PhoneBurner acceptance and call completion is identity-backed and idempotent.
9. DNC, bad lead, appointment, client, answered, voicemail, and no-connect outcomes are explainable.
10. Logics/appointment latency never blocks the PhoneBurner session.
11. Restart/replay does not duplicate reservations, contacts, calls, or outcomes.
12. The new runtime has no dependency on `CxDialQueue`, UCQ, RingCX active-call state, or app-side dial buttons.
13. Old delivery writers are dark for the migrated population.
14. Mickey approves deletion only after a proven full-day rollout.

## 26. Current Configuration Inputs

```text
Global curator folders:
  Call backs = 66253042
  Expired Daily Contacts = 66209775

Agent list and enabled status:
  Bruce Allen — designated first canary; code/config remains dark until the live-write gate
  Phil Olson, Sean Lucas, Brad Hansen, Chris Bolt — posting-dark until Bruce passes

Optional PhoneBurner member/owner IDs:
  intentionally blank; not required by the contact-create route

Per-agent distribution folder IDs:
  Bruce Allen = 66252220
  Phil Olson = 66252218
  Sean Lucas = 66252216
  Brad Hansen = 66252214
  Chris Bolt = 66252212

Per-agent receiving folder IDs:
  Bruce Allen = 66252221
  Phil Olson = 66252219
  Sean Lucas = 66252217
  Brad Hansen = 66252215
  Chris Bolt = 66252213

Optional LeadStream IDs/admin labels:
  intentionally blank; PhoneBurner application setup plus distribution folder is authoritative

Per-agent pool subscriptions:
  equal weekend/Monday starting policy pending checked-in configuration

Per-agent packet allowances:
  configured pool allowances with new_today preference inside a target-20 packet

Final providerBufferTarget/refillAtOrBelow:
  controlled-floor setting: 20/5
```

## 27. First Implementation Turn Checklist

When Mickey authorizes coding, the first implementation turn must do only Phase 1:

1. Re-read this work order.
2. Announce `active phase: 1 — pure decision core`.
3. Inspect the dirty tree; do not touch unrelated WIP.
4. Create the single main decision file and its focused test file.
5. Implement no HTTP, Mongo, route, timer, server registration, or environment flag.
6. Borrow only small pure calculations after restating them in provider-neutral vocabulary.
7. Run the Phase 1 tests.
8. Report the Phase 1 proof, update the active phase, and automatically continue into persistence.

The proof gate is deliberate. It proves the rules before the machinery without turning the gate into a user-input dependency.

Phase 9 PB-to-metrics ownership hardening evidence (2026-07-17):

- DailyDial remains the sole daytime PhoneBurner attempt ledger. Delayed exact
  callbacks append their attempt but cannot regress the latest-call snapshot,
  reopen a terminal/capped row, or weaken a stronger outcome.
- Explicit `leadReceivedAt` and `lastOffloadAt` fields remove the former
  retry-timestamp ambiguity; `receivedAt` is retained only for compatibility
  through the no-delete proof window.
- The 17:30 close and scheduled nightly close call the same deterministic
  DailyDial-to-CallLog projector. The nightly invocation is a retry trigger
  before source enrichment, not a second decision or fact owner.
- Vendor call reporting now reads CallLog only. The CallLedger-first legacy
  implementation is disabled and pending proof-gated deletion.
- Projection failure/partial status is exposed to the vendor email; preview
  closes stay write-free.
- Focused ledger/projection/wiring proof passed 15/15 and the complete metrics
  suite passed 40/40. The broad lead-delivery glob hit its known 184-second
  timeout without an emitted assertion failure and is not represented as a
  full-suite pass. No provider mutation or Windows service restart occurred.

## Phase 9 PhoneBurner appointment-execution removal ruling (2026-07-17)

PhoneBurner appointment execution is permanently absent from this runtime because
the provider contract does not expose a dependable appointment instant.

- A PhoneBurner `Appointment` disposition remains one terminal call outcome.
- The exact attempt is written to `DailyDial`, projected to `CallLog`, and
  counted once in metrics.
- The callback route does not parse or persist appointment date, time, or
  timezone fields. Legacy appointment-time labels normalize to `appointment`.
- There is no appointment feature flag, handler, schedule repository, daily
  appointment model, wake timer, Pool swap, Logics task, wrap-card work item,
  or appointment close path in PhoneBurner lead delivery.
- The standalone implementation files, tests, and implementation guides were
  physically removed with Mickey's explicit approval. Existing application/CX
  appointment features outside PhoneBurner lead delivery remain separate.
- No Mongo collection was destructively dropped; any historical documents are
  inert data with no model or runtime reader.

Post-removal proof: 93/93 focused route, wiring, service, repository,
ledger, and projection tests passed; 3/3 appointment terminal-lifecycle runtime
cases passed; and 40/40 metrics tests passed. The complete runtime test file
hit its known lingering-handle timeout and is not represented as a full-file
pass. No PhoneBurner mutation or Windows service restart was performed.
## Phase 9 productivity/refill deadlock hardening evidence (2026-07-17)

- Root cause was a circular wait: ordinary refill held an agent Pool operation
  while waiting for the global productivity rebalance, and that rebalance then
  queued behind the same agent Pool operation.
- Ordinary refill no longer waits for the global productivity promise.
  Productivity remains enabled and both paths continue to serialize through
  the existing per-agent Pool operation owner.
- A focused regression forbids the global productivity dependency inside the
  simple `postTopOfQueueOnce` path.
- Local syntax and control-plane wiring proof passed 4/4; focused productivity,
  simple-loop, Pool-lock, cap, Call End, and deterministic circular-wait runtime
  proof passed 13/13.
- The same two-file repair passed syntax and the 13/13 focused runtime proof on
  Linux. One controlled `parallel-control-plane` restart completed after
  systemd cleared the pre-existing deadlocked process. Post-restart health was
  HTTP 200 with productivity enabled/warming and no provider post in flight.
- Post-restart replay completed the previously stuck Brad and Chris Call Ends;
  all five durable Pool operation leases were clear, ticks advanced normally,
  and productivity remained enabled without an in-flight stall.
# Phase 9 weekend compute boundary (2026-08-02)

This ruling supersedes any earlier weekend pre-positioning language.

- Saturday and Sunday are determined in `America/Los_Angeles`.
- Weekend automation may accept a newly submitted lead, deliver only its
  initial text/email, and durably enroll it for the next call queue.
- Weekend automation must not run PhoneBurner scans/refills, provider posting,
  productivity rebalancing, cadence sweeps, RVM disposition polling, scheduled
  blasts, hourly reconciliation, reports, nightly close, Lexis drops, or
  hygiene/recovery discovery.
- A manual operator-forced action remains possible when explicitly requested;
  scheduled runtimes may not infer that permission.
- Monday resumes from durable state without replay bursts or duplicate first
  contact.
