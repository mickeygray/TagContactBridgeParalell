# PhoneBurner simple loop

This is the intended operating contract for the current simplified path.

The current symbol-by-symbol cut list is in
`docs/PHONEBURNER_SIMPLE_LOOP_REMOVAL_LEDGER.md`.

## Live loop

1. PhoneBurner sends a Call End callback.
2. The callback is persisted and the exact attempt is written to `DailyDial`.
3. The agent's **Pool** folder count is read. The Consumer folder is not used for refill decisions.
4. If Pool is 5 or more, stop.
5. If Pool is below 5, post one packet, up to 20 leads.
6. A per-agent single-flight guard prevents overlapping packets.

The low-water read is deliberately narrow: it reads the Pool folder twice and
requires the two counts to agree before posting. It does not read or count the
Consumer folder.

## Automated day lifecycle

All times are Pacific.

1. Before **7:50 AM**, the minute tick may ingest eligible LeadCadence rows and
   build the durable queue, but provider posting is closed.
2. On the first tick at or after **7:50 AM**, the runtime first resumes any
   interrupted prior-day close, releases prior-day delivery identities, and
   drains persisted Call End results.
3. Morning launch has a **10-minute service objective**. The runtime refreshes
   one bounded newest-first page of active, nonterminal LeadCadence rows, then
   immediately activates each configured agent and seeds a physical Pool below
   5 with one simple packet of up to 20 from the durable queue.
4. A durable per-agent `simpleDayStart` marker prevents a restart or later tick
   from seeding that agent twice. An incomplete or empty-queue start remains
   retryable on the next tick.
5. During the day, the minute tick continues the exhaustive eligibility
   reconciliation in bounded pages and drains persisted results. That deeper
   cleanup never gates morning packets. Only an exact Call End whose Pool is
   below 5 performs a steady-state refill.
6. At **5:00 PM**, the delivery window closes. Every provider-create operation
   rechecks the window, so a packet already in progress also stops adding.
7. At **5:30 PM**, the existing durable daily close drains the configured
   working folders, then projects the day's exact `DailyDial` attempts back to
   `LeadCadence`. Its progress is crash-resumable and the next morning finishes
   any unpersisted prior-day rows before starting fresh work.

The expensive correctness work belongs to bounded background maintenance and
the end-of-day repair boundary. A restart after 7:50 must never make agents wait
for a full active-cadence sweep before receiving work.

There is no second refill scheduler. The minute tick owns queue/result
maintenance and the once-per-day start/close transitions; Call End owns normal
Pool refills.

## Production authority boundary

Production deliberately exposes no alternate writer:

- Admin `seed` and `launch` return `410` and cannot pre-position contacts.
- Legacy fill, refill, weighted-packet, preload, and background-refill methods
  default to `legacy-operator-disabled`.
- Direct `postTopOfQueue` access defaults to `direct-post-disabled`; only the
  internal day-start and exact Call End owners can call the real operator.
- Legacy callback pulse and URL-selected refill owners require an additional
  compatibility switch that production never supplies.
- Old mutation scripts remain on disk for the no-delete proof window, but the
  preload runtime defaults to the disabled legacy surface and no script is
  scheduled by the application.

The remaining admin operations are read-only preview/status, explicit pause,
reconciliation, and a manual invocation of the same guarded minute tick.

## Packet order

The ordinary packet reads already-eligible canonical queue rows in this order:

```text
overnight -> follow_up_due -> older_available
```

`new_today` is not bulk packet inventory. A low-water request, day-start seed,
pre-position, or legacy direct packet request cannot claim it.

Before claiming a new row, the operator finishes any durable provider post left
unfinished by a timeout or rate limit. If that prior post is still ambiguous,
the operator stops. It never guesses that the post failed and never fills around
uncertain work.

## Error behavior

- A failed or changing Pool count posts nothing.
- A closed delivery window claims nothing.
- Concurrent Call Ends for one agent share one in-process top-up operation.
- Claims use the durable item version, so a row can only be won once.
- An accepted partial packet remains accepted; a later Call End recounts the
  physical Pool before deciding whether more work is needed.
- Rate-limited or ambiguous provider posts remain durable and are retried before
  new queue rows.
- A failed Pool read or retryable provider failure leaves the Call End event
  retryable. The existing event drain wakes it again; no second refill scheduler
  is involved.
- A definite provider rejection is recorded as a delivery failure and the
  packet may continue with another eligible row.
- `follow_up_due` rows are filtered by `nextContactAt <= now` in the repository,
  before the posting operator can see them.
- Once the exact Call End reaches the lead's age-based daily cap, the row stays
  in the daily ledger and `follow_up_wait`, but `nextContactAt` is cleared. A
  stale source timer cannot restore it, and both posting lanes recheck the cap
  before either a new claim or a pending provider retry.
- A Call End without a recognized terminal disposition stays recorded as
  `review` but enters `follow_up_wait` for two hours. A later DNC or appointment
  for the same provider attempt strengthens that row without incrementing it.

## What must remain

- LeadCadence remains the morning source for eligibility and lead age.
- The durable delivery item remains the claim/identity record.
- `DailyDial` is today's exact call ledger; it carries attempt timestamps,
  duration, outcome, daily count, cap, and next eligibility.
- PhoneBurner remains the physical Pool/Consumer owner.
- LeadDeliveryEvent remains the callback audit trail.
- Call End recording, DNC, appointment, and Logics actions remain downstream outcome work.
- The Pool count is the only refill trigger.
- The constants that define this loop are 5 for low water and 20 for packet
  size. They are not derived from the older refill planner.
- The delivery window is 7:50 AM through 5:00 PM Pacific, and daily close begins
  at 5:30 PM Pacific.

## What is intentionally not in the live posting loop

- Agent weighting.
- Periodic automatic refill.
- Repeated source rescans.
- Packet preview/retry policy.
- Consumer-folder counting.
- Refill leases and background refill scheduling.
- Consumer-folder availability.
- Estimated outstanding counts as permission to post.

Those older paths remain in the repository for compatibility and test coverage. They are commented out or bypassed in the live automatic tick; permanent deletion waits for floor proof.

## Eligibility immediately before this loop

- Day start gives every enabled agent one initial shallow packet and a
  15-minute opportunity to prove activity.
- After that startup window, `active` means one exact completed Call End in the
  immediately preceding 15 minutes. Login state, a day-long shift marker,
  delayed/review callbacks, and historical activity are not activity proof.
- Ordinary Pool depth, estimated outstanding, bulk packet timing, and refill
  state do not affect fresh eligibility.

## Immediate fresh lane

1. Each source-ingestion pass looks for eligible `new_today` rows, newest first.
2. It reads the durable `fresh` cursor and chooses the next currently active,
   configured, subscribed agent in the fixed ring.
3. It claims exactly one row with a versioned compare-and-set and posts it
   through the same paced provider mutation lane used by ordinary packets.
4. Only a provider acceptance advances the cursor. A rejection or ambiguous
   attempt leaves the accepted-turn cursor unchanged.
5. It repeats while eligible fresh rows and active agents exist. No active
   agent means the rows remain eligible for the next minute tick or Call End.
6. A real Call End durably records activity, signals the single fresh worker,
   and returns without waiting for the fresh backlog to post.

The receipt-plus-15-minute time is an overdue alert/retry boundary. It is not a
reservation period and does not make fresh wait for the next bulk packet.

## One fair-pick primitive

`nextFairPick` owns circular agent selection. One Mongo cursor per work type
stores exactly the fixed `agentOrder` and `lastPickedAgentId` business values.
The caller supplies only a temporary exclusion list. Selection starts after the
last pick and skips excluded agents without changing the ring. Immediate fresh
assignment peeks the `fresh` cursor, posts one contact, and CAS-writes the winner
only after PhoneBurner accepts it. Productivity movement uses the separate
`redistribution` cursor.

## Quarter-hour productivity swap

- Every 15 minutes, after one full warm-up window, exact Call Ends identify the
  agents currently consuming. A zero-Call-End agent with no active call keeps
  exactly six yellow/red contacts in Pool. If that agent owns fewer than six,
  the runtime posts the missing eligible aged contacts first. Only after all six
  are present does every other exact Pool contact move directly to consuming
  agents' Pools round-robin. Consumer is never edited.
- This is a contact move, not a delete/repost: provider identity, recycle timing,
  and upload usage for redistributed work stay unchanged. If identities are
  incomplete or the aged cushion cannot be completed, the pass moves nothing.

The swap is separate from and must not add branches to the physical
`Pool < 5 -> post up to 20` operation.

## Still separate work

- The former reservation, hourly least-served rank, pending-fresh counters, and
  `speedOverrideAgentId` path remain only as disabled reference during the
  no-delete proof window. Neither live fresh delivery nor the simple packet
  operator calls them.
- Add blue/yellow/red packet caps to ordinary packet composition once floor
  evidence requires them; the productivity swap's six-contact aged cushion does
  not change the normal packet recipe.
