# CX Dial Rail Finalization Plan - 2026-06-23

## Purpose

Finalize the CX dialing rewrite around three testable rails without letting the live call loop become responsible for business writes, Logics calls, metrics repair, or slow Mongo work.

The core principle:

> RingCX owns the live call. The app observes the active UII, renders the matching lead, captures lightweight intent, and moves on when RingCX changes calls. Business meaning drains after the fact.

## How to read this document

This plan was written in layers. It builds to a single source of truth at the end. Read it in this order:

1. **AUTHORITATIVE — build from these:**
   - **Source Pool & Reservation — Canonical Spec (§0-§6)** and **Ordered Implementation Guide (M1-M8b)** at the end of the doc. These win on ANY conflict. All numbers, field names, signatures, families, ordering modes, and the deploy sequence (M2 strictly before M4) come from here.
   - **Companion build reference — `CX_DIAL_RAIL_BUILD_BREAKDOWN_2026-06-23.md`:** the function-by-function `Now → Target → Change → Serves` map for every file the build touches (build-order crosswalk + New/Modify/Untouched file lists). Build straight through it; it defers to the Canonical Spec + Guide on any conflict.
   - **Live Loop Rules** — authoritative for live-loop behavior (may-do/must-not-do + the prior-active-set release diff, `deriveReleasedCandidates`); referenced by §2 CR3 and §4.
   - **Terminal Outbox**, **Drain**, **Serve-Time Safety**, **Existing Mongo Writer Compatibility**, **Production Standard**, **What To Avoid** — authoritative for the outbox/drain/business-write layer (which the Canonical Spec deliberately does NOT cover). Where these touch reservation/completion, defer to §2-§4.

2. **HISTORICAL / RATIONALE — read for "why", do NOT implement from:** the earlier rail-shape and review passes — **Rail Fill Source Contract**, **Family Bucket Loader**, **Simplification Audit for Current Implementation**, **Review Hardening (2026-06-23)**, **Minimal-Viable (Thinest) Execution Cut**, **"Can we do this with less code?"**, **Green-First Queue Rewrite**, and **Implementation Order**. These predate the reservation service. They use pre-canonical names (`bulkLoadSessionId`, `reserveFromFamilyOrder({families,limit})`, `cxBulkLoadRuntime.js`), a `30`-target buffer, and strict green-first ordering — all superseded. Their value is the bug stories and the rationale that produced §0-§6.

**One-line authority rule:** if an early section and the Canonical Spec disagree on a number, name, family, or ordering, the Canonical Spec / Implementation Guide is correct.

**Canonical terms (quick reference) — these win everywhere:**

- **Pool:** ONE shared `CxDialQueue`, tiered by the `queueFamily` field. Never "source pools" (plural) or per-color collections.
- **Families/colors:** green=`fresh-day1` (≤1d), blue=`fresh-day2to10` (**actual 2–14d**), yellow=`fresh-day16to30` (**actual 15–29d**), red=`aged` (30–120d), dead (>120d). Classify by the **numeric band**, never the stale key label.
- **Bulk sizing:** TARGET (full inventory) = **35** (15/10/5/5). REFILL BATCH = **~30**, published when live slots drop to the THRESHOLD of **≤5**. `30` is never the target.
- **Ordering:** policy-driven `RC_CX_RESERVE_MODE`; **DEFAULT = mix** (15/10/5/5). `green-first` is the non-default mode (no aged floor) gated by `RC_CX_AGED_MIN_RESERVE_PER_CYCLE`.
- **Reservation fields:** `metadata.reservationSessionId` / `reservedAt` / `reservationExpiresAt` (+ `assignment.assignedAt`, `claimUntil`). Never `bulkLoad*`.
- **Reservation API:** `reserveFromFamilyOrder({domain, agentExtensionId, sessionId, familyTargets, totalLimit, claimMinutes, metadata})` + repo `reserveReadyRows(domain, familyTargets, options)`. Never the old `({families, limit})` signature.
- **Button:** captures **INTENT** (durable terminal-outbox row, write-ahead). A RingCX disposition is a downstream EFFECT for the connected voicemail-box-full case only. Buttons never hang up.
- **Terminal outbox row = durable TRIGGER, not completion.** A reserved/`claimed` (published-but-un-served) row completes via the FORCE path `completeCxQueueItem` (fromStates includes `claimed`, no held-for-disposition gate), NOT the gated `handleCxTerminalCallOutcome`.

## Final Rail Shape

### 1. Legacy Fast Rail

Use legacy as the fast `nextDial`/poller rail.

This rail already has:

- `nextDial` payload construction.
- transition/loading overlay.
- terminal workflow matching.
- existing agent-facing layout.

Target behavior:

1. Agent clicks a terminal button.
2. Client enters release/loading state and disables buttons.
3. App submits current disposition and sends nextDial.
4. UI does not optimistically show the next lead.
5. Poller observes the new active RingCX UII.
6. UI swaps to the lead that matches the observed UII.

Legacy should be the "fast but safe" test rail. It should not become the bulk architecture.

### 2. Slow Single Rail

Keep slow single as the boring safe fallback.

Target behavior:

1. Send one lead.
2. Wait for confirmation.
3. Agent handles the call.
4. Terminal action completes/release.
5. Send the next lead.

Do not spend extra work teaching slow single the full nextDial/poller handoff unless legacy fails as the fast rail. Slow single's value is being simple and recoverable.

### 3. Bulk Load Rail

Bulk is the new architecture.

Target behavior:

1. Preload a RingCX campaign queue.
2. RingCX advances calls.
3. 1-second poller observes active calls.
4. App matches by `externId` / `queueItemId`, never phone-only.
5. UI shows the active matched lead.
6. Button intent is captured lightly.
7. Released UII is written to a durable terminal outbox row — the durable **trigger**, not the completion (a reserved/`claimed` row completes via the force path `completeCxQueueItem`; see Canonical Spec §4).
8. A drain performs business writes later.

Bulk buffer sizing (canonical — see §2 "Rail load sizes"):

- **target buffer (full inventory): `35`** (15 green / 10 blue / 5 yellow / 5 red)
- **refill threshold: `5` live**
- **refill batch: `~30`** — published when live slots drop to ≤5, toward the 35 target

`30` is the refill batch size, **not** a second target. The earlier "target 30" framing is pre-canonical.

### Rail Fill Source Contract

> Already self-bannered as superseded. Note specifically: the reserve-step field names here (`bulkLoadSessionId`/`bulkLoadReservedAt`/`bulkLoadReservationExpiresAt`) are PRE-CANONICAL — use §2's `reservationSessionId`/`reservedAt`/`reservationExpiresAt`. Read for the Mickey agent-queue-as-storage bug story only.

> **Superseded by "Source Pool & Reservation — Canonical Spec"** (end of doc) — the single source of truth. Retained for rationale/history; the canonical spec wins on any conflict.

The 2026-06-23 local test proved the refill trigger fires correctly at the
threshold, but the source contract is still too passive. The current draft reads
`ready` rows that are already assigned to the agent. That works for a moment, but
the legacy queue balancer can trim/reassign those rows before bulk publishes
them, so a threshold refill can find only one row even though plenty of inventory
exists.

Concrete issue from the Mickey bulk test:

- I pre-staged refill candidates onto Mickey's agent queue.
- The rail crossed the threshold and correctly asked for more.
- By then, other queue maintenance had touched those assigned `ready` rows.
- The refill found one usable row instead of the intended batch.
- The visible result was misleading: the rail logic looked broken, but the real bug was the source contract. We were relying on an agent queue as temporary storage.

The fix is to stop assigning fresh inventory directly to agents as a live side effect. New greens, blues, yellows, and reds should enter source pools. A rail gets leads only when it explicitly reserves them for a session/load operation.

This contract should be shared by all three rails. The wrinkle is not how the pool is formed; the wrinkle is how many rows a rail reserves and publishes.

Rail-specific load sizes:

- Legacy fast rail: reserve the next candidate only when the handoff needs it.
- Slow single rail: reserve one candidate, publish one candidate, wait for confirmation.
- Bulk rail: reserve a batch, publish one at a time in order, and append accepted rows to the rail buffer.

Every rail must own a reserve step:

1. Compute the deficit: `targetBuffer - (acceptedBuffer.length + current?1:0)`.
2. Atomically reserve up to that deficit from eligible queue inventory.
3. Reservation means one write per row before publishing:
   - `state: "claimed"`
   - `assignment.extensionId = agentExtensionId`
   - `metadata.bulkLoadSessionId = sessionId`
   - `metadata.bulkLoadReservedAt = now`
   - `metadata.bulkLoadReservationExpiresAt = now + short TTL`
   - clear stale `lastRingcxPublished*` and runtime flags
4. Publish only reserved rows to RingCX.
5. If RingCX accepts a row, append it to `acceptedBuffer`.
6. If RingCX rejects or the publish call fails, release that row back to `ready`
   with a visible failure reason.

Do not pre-stage refill rows onto an agent and wait for the threshold. The old
assignment machinery is allowed to touch idle `ready` rows; rail-reserved rows
must be claimed to the session so they cannot be stolen while the publish
request is in flight.

The selection mix should be policy-driven, not hard-coded in the runtime. For a
floor agent, read the same family targets used by queue policy. For test runs,
allow a small explicit target such as 6 seed leads plus a deficit refill. The
runtime should not care which families were chosen; it only receives reserved
candidates with stable `queueItemId` and `externId`.

Implementation target:

- Build one shared pool service that produces ordered candidate buckets.
- Keep inbound/new greens in the green source bucket, not on a specific agent.
- Let each rail call the same reserve function with a requested count and policy.
- Only publish rows that were atomically reserved by that rail/session.
- If a publish fails, release that reservation back to the proper source bucket with a visible reason.

## Live Loop Rules

> Status: AUTHORITATIVE for live-loop behavior and the prior-active-set release diff (`deriveReleasedCandidates`). Referenced by Canonical Spec §2 CR3 and §4 — not a superseded narrative pass.

The live loop may do only these things:

- poll RingCX active calls
- match active calls to known candidates
- render current call
- capture button intent for current UII
- write a tiny durable outbox event when a UII releases
- clear/transition UI state

The live loop must not do these things:

- call Logics
- update cadence counters directly
- update answered/no-answer counters directly
- write call summaries
- perform expensive enrichment
- phone-match a lead into the middle panel
- block UI on metrics, Logics, summaries, or cleanup

> **Review (2026-06-23) — the #1 orphan fix.** The live loop must detect releases by
> diffing the *prior* active set against *this* tick's snapshot, NOT by checking only
> app-memory `current`. A lead RingCX dials+releases *between* two 1s polls is never
> promoted to `current`, so a single-snapshot diff never sees it: it gets no outbox
> row, stays in `acceptedBuffer`, and its queue item stays `claimed` → re-dialable,
> outcome lost. Persist `nextActiveExternIds` on the session each tick.

```js
// PURE. Anything active LAST tick and absent THIS tick released between polls —
// even if it was never promoted to `current`. Returns candidates to finalize.
function deriveReleasedCandidates({ prevActiveExternIds = [], activeCalls = [], pool = [] }) {
  const nowActive = new Set(activeCalls.map((c) => String(c.externId || "")).filter(Boolean));
  const byExternId = new Map(pool.map((c) => [String(c.externId || ""), c]));
  const released = [];
  for (const ext of prevActiveExternIds) {
    if (!ext || nowActive.has(ext)) continue;            // still live → not released
    const candidate = byExternId.get(ext);
    if (candidate) released.push(candidate);             // vanished between polls
  }
  return { released, nextActiveExternIds: Array.from(nowActive) };
}
// Each released candidate → append a durable outbox row (source: "poller_release"),
// keyed (queueItemId:uii), then remove from acceptedBuffer. Persist nextActiveExternIds.
```

## Terminal Outbox

Use a durable Mongo outbox, not in-memory-only state.

Reason:

- in-memory is fastest, but loses outcomes on restart
- direct business writes are durable, but can slow or break the call loop
- outbox gives durability while keeping the call loop crisp

### Event Shape

Minimal event:

```js
{
  key: `${queueItemId}:${uii}`,
  queueItemId,
  uii,
  domain,
  caseId,
  agentExtensionId,
  agentEmail,
  externId,
  activeAt,
  releasedAt,
  buttonIntent,   // "answered" | "voicemail" | "dnc" | null
  outcomeBucket,  // "answered" | "did_not_connect" | "dnc"
  source,         // "button" | "auto_advance" | "poller_release"
  status: "pending",
  attempts: 0,
  createdAt,
  updatedAt
}
```

### Outcome Mapping

For lead spacing and retry policy:

- voicemail -> `did_not_connect`
- no answer -> `did_not_connect`
- no button intent on released UII -> `did_not_connect`
- answered -> `answered`
- DNC -> `dnc`

Keep `buttonIntent: "voicemail"` for reporting, but cadence math can treat voicemail and no-answer the same.

### Indexes

Recommended indexes:

```js
{ key: 1 } unique
{ status: 1, outcomeBucket: 1, createdAt: 1 }
{ queueItemId: 1, status: 1 }
{ domain: 1, caseId: 1, status: 1 }
{ uii: 1 }
```

### Idempotent Write (replaces the in-process Set)

> **Review (2026-06-23).** Today `persistTerminalOutcome` marks an in-process `Set`
> (`makeInProcessMarkOnce`) *before* the business write and swallows the error
> (`cxBulkLoadRuntime.js:188`) — a thrown write is lost with no retry, and the dedupe
> dies on restart / doesn't span processes. Make the **unique-index insert the
> idempotency claim**, and write the row write-ahead (BEFORE `dispositionCall`) so a
> crash can't leave RingCX advanced with no recorded outcome. Delete the `Set`.

```js
async function appendTerminalOutbox(outboxRepo, row) {
  try {
    await outboxRepo.insertOne(row);             // unique index on { key: 1 } = the claim
    return { written: true, key: row.key };
  } catch (err) {
    if (err && err.code === 11000) return { written: false, key: row.key, reason: "duplicate" };
    throw err;                                    // fail closed: real errors surface, not swallowed
  }
}
```

## Drain

Use one universal drain for all agents.

Initial cadence:

- run once per minute
- process DNC first
- then answered
- then voicemail/no-answer

The drain owns:

- cadence updates
- queue item completion/reschedule
- answered counters
- no-answer counters
- Logics DNC / contact stop
- call log finalization
- metrics events
- retries and alerting

DNC must be high priority. It does not need to block the live UI, but it must retry loudly and prevent future serving quickly.

> **Review (2026-06-23) — confirmed with the floor owner.** The drain is **our business
> logic only** (Logics contact-stop, cadence, answered/no-answer counters, CallLog,
> metrics). It must **never** call RingCX `dispositionCall` — by drain time (up to ~60s
> later) the call has long since released and RingCX rejects a disposition on a gone call
> (returns `false`, proven live). RingCX is dispositioned/advanced **live** — automatically
> for ring-no-answer/intercept, or by the manual button for voicemail-box-full — and the
> drain only translates the recorded outcome into our systems.
>
> **DNC is the single most important business write here.** It must ship in v1 even if the
> universal cross-agent scheduler is deferred to a per-session deferred write: a dropped or
> delayed DNC is a compliance failure, not a metrics nit. Process DNC rows first, suppress
> serving on `failed` DNC rows, and alert loudly — never let a DNC fall into the silent
> non-connect path.

### Atomic Claim + Poison Policy

> **Review (2026-06-23).** The plan gives rows `status`/`attempts` but never says the
> drain **claims a row atomically** — without it two ticks/pods co-process one row and
> any `$inc` metric double-counts. Claim with `findOneAndUpdate(pending→processing)`,
> flip `pending→done` only on success, and dead-letter to `failed` (NOT `done`) at the
> attempts cap so a permanently-failing DNC keeps suppressing serving instead of being
> dropped or retried forever. (For the first single-agent toggle, `pending→done` +
> log-on-error + no auto-retry is acceptable — but state which.)

```js
async function claimNextOutboxRow(coll, { now, leaseMs = 60000, attemptsCap = 5 }) {
  return coll.findOneAndUpdate(
    { status: "pending", attempts: { $lt: attemptsCap } },
    { $set: { status: "processing", leasedAt: now, updatedAt: now }, $inc: { attempts: 1 } },
    { sort: { outcomeBucket: 1, createdAt: 1 }, returnDocument: "after" }, // dnc sorts first
  );
}
async function drainOnce({ coll, handlers, now, attemptsCap = 5, alert }) {
  for (;;) {
    const res = await claimNextOutboxRow(coll, { now: now(), attemptsCap });
    const row = res && res.value;
    if (!row) return;
    try {
      await handlers[row.outcomeBucket](row);                       // dnc | answered | did_not_connect
      await coll.updateOne({ _id: row._id }, { $set: { status: "done", updatedAt: now() } });
    } catch (err) {
      const failed = row.attempts >= attemptsCap;                   // dead-letter, still suppresses serving
      await coll.updateOne({ _id: row._id }, { $set: { status: failed ? "failed" : "pending", lastError: String(err && err.message), updatedAt: now() } });
      if (failed) alert(`outbox row ${row.key} dead-lettered: ${err && err.message}`);
    }
  }
}
```

## Serve-Time Safety

Serving should check the outbox as a redundancy gate.

When building/loading a queue:

1. collect candidate `queueItemId`s and `(domain, caseId)` pairs
2. query pending/processing/retry outbox rows in one indexed query
3. filter candidates in memory

This prevents a lead from being re-served during the minute before the drain finishes.

Once a released call has a durable outbox timestamp, it is safe to suppress from serving.

> **Review (2026-06-23).** This durable query is the *real* re-serve gate, independent
> of the once-a-minute drain — so DNC suppression doesn't wait up to 60s. Today the only
> gate is a `state:'ready'` read plus a `.catch(()=>null)` claim write whose return is
> discarded (`cxBulkLoadRuntimeService.js:148-155`); a lost claim re-opens the lead and
> a sibling case can't be suppressed. Suppress by `queueItemId` **and** `(domain,caseId)`,
> and keep `failed` rows in the filter. Also make publish an *atomic* claim
> (`ready→claimed` via `findOneAndUpdate`), only buffering candidates whose claim returned.

```js
async function filterServableCandidates(outboxColl, candidates) {
  const queueItemIds = candidates.map((c) => String(c.queueItemId || c.id || c._id));
  const caseKeys = candidates.map((c) => `${c.domain}:${c.caseId}`);
  const rows = await outboxColl.find(
    { status: { $in: ["pending", "processing", "retry", "failed"] },     // failed still suppresses
      $or: [
        { queueItemId: { $in: queueItemIds } },
        { $expr: { $in: [{ $concat: ["$domain", ":", { $toString: "$caseId" }] }, caseKeys] } },
      ] },
    { projection: { queueItemId: 1, domain: 1, caseId: 1 } },
  ).toArray();
  const blockedItems = new Set(rows.map((r) => String(r.queueItemId)));
  const blockedCases = new Set(rows.map((r) => `${r.domain}:${r.caseId}`));
  return candidates.filter((c) =>
    !blockedItems.has(String(c.queueItemId || c.id || c._id)) &&
    !blockedCases.has(`${c.domain}:${c.caseId}`));
}
```

## Existing Mongo Writer Compatibility

Do not invent a second counter system.

Existing placement writer:

- `handleCxCallPlaced()` in `packages/shared-services/src/cxCadenceService.js`
- increments `placedCalls`, `dailyPlacedCalls`, `monthlyPlacedCalls`, `hourlyPlacedCalls`
- writes `contacts_sent`
- stamps CallLog
- marks queue item serving/held

Existing terminal writer:

- `handleCxTerminalCallOutcome()` in `packages/shared-services/src/cxCadenceService.js`
- handles safe non-connect outcomes
- updates no-answer style counters
- reschedules/completes queue items
- clears CX call state

Important mismatch to fix before bulk is production-grade:

- bulk currently marks candidates serving, but should record placement through the same placement writer or an equivalent bulk-safe wrapper
- bulk auto-advance currently uses `cx-auto-advanced`; the drain should convert released-with-no-intent to `did_not_connect`
- answered and DNC need explicit drain handlers, not blind calls into the non-connect terminal writer

## Bulk Refill Acceptance Tests

Bulk refill must be hammered before live use.

Acceptance checklist:

- starts with 35 accepted/live slots (15/10/5/5 mix, per §2)
- drops to 6 live slots without refill
- drops to 5 live slots and triggers refill
- refills toward 35 (publishing the ~30-row refill batch when ≤5 live), not 20 and not 30-as-target
- accepted refill candidates append without clobbering `current`
- rejected publish rows do not poison the session
- agent not off-hook pauses refill instead of throwing
- partial supply, for example only 3 ready leads, leaves the rail healthy
- no duplicate queue items enter `acceptedBuffer`
- UI queue display does not collapse to only the most recently accepted lead
- poller still swaps current by RingCX active call evidence
- terminal outbox still receives released current even if refill is in progress

### Family Bucket Loader

> Already self-bannered as superseded. The day-band KEY names here (`fresh-day2to10`/`fresh-day16to30`) are stale vs real age bands — classify by §0 numeric thresholds (blue 2-14d, yellow 15-29d), never by the key label.

> **Superseded by "Source Pool & Reservation — Canonical Spec"** (end of doc) — the single source of truth. Retained for rationale/history; the canonical spec wins on any conflict.

All rails should pull from the same ordered family buckets rather than from
agent-local ready queues. Do not build separate family logic per rail. Build one
source-pool selector and let the rail request a count.

Recommended target mix for a full bulk pool:

- 15 green / fresh-day1
- 10 blue / fresh-day2to10
- 5 yellow / fresh-day16to30
- 5 red / aged

This is 35 live slots for full bulk. If the rail is already at 5 live slots, the
refill publishes 30 more. Slow single and legacy use the same bucket order, but
request only the next candidate needed by their loop.

The loader should preserve order inside each family bucket. New inbound green leads should be inserted into the green source bucket, not shoved directly into an active agent's loaded campaign. The next agent/session that refills from green gets the newest eligible greens in deterministic order.

Rules:

- Build each family bucket independently.
- Sort within each bucket by the family policy.
- Concatenate buckets in configured order: green, blue, yellow, red.
- Reserve and publish the requested count from the concatenated plan in that exact order.
- If yellow/red supply is short, publish what exists and leave the rail healthy.
- Never disturb the current call while refilling.
- Never live-insert a new green into an active agent queue. Insert it into the green source bucket; the next rail refill claims it if policy says it is next.

## Button Policy

Buttons capture **intent** — a durable terminal-outbox intent row, written write-ahead (see
"Ordering (orphan-safe)" below). They **never** call a hangup function. For the connected
voicemail-box-full case the app *then* sends a RingCX **disposition** on the ACTIVE call as a
downstream effect, and RingCX handles the advance. The disposition is the effect; the recorded
act is the intent. (We do not hang up; proven that `hangupCall` is a no-op on a ringing dial.)

### Who ends each call

- **Ring-no-answer / carrier intercept** → RingCX **auto-advances on its own**. The agent
  does nothing. The poller observes the released UII and, with no button intent, the drain
  buckets it `did_not_connect`. This is the entire reason the rail is built this way — the
  app does not chase these; nothing can be done about them and nothing needs to be.
- **Voicemail-box-full / mailbox-not-set-up** → RingCX may **not** auto-advance the same way
  (OPEN: verify against live RingCX). For these the **"No answer" button IS the manual
  voicemail-box-full disposition**: the call has connected to the mailbox (it is `ACTIVE`),
  the agent presses the button, the app sends a RingCX disposition on that active call, and
  RingCX advances. Dispositioning only works while the call is `ACTIVE`/connected (proven
  live) — which is exactly the full-mailbox state, so the manual button fires at the right
  moment.

### Ordering (orphan-safe)

A button press writes its durable outbox **intent row write-ahead — BEFORE the RingCX
disposition** — so the recorded intent (especially `dnc`) survives a crash or a lost RingCX
response. The `poller_release` path is the backstop: any release with no recorded intent
becomes `did_not_connect`. Never let a button's RingCX disposition fire before its intent is
durably recorded.

## What To Avoid

Avoid these regressions:

- phone-only matching into current call
- UI staging before poller UII confirmation
- direct Logics calls from button handlers
- direct cadence/counter writes from button handlers
- adding boolean flags instead of separating rail behavior
- clearing the visible queue when only the current lead should move
- writing new business counters outside the existing cadence/call writers
- making refill block the active-call UI longer than necessary

## Implementation Order

> Historical ordering — SUPERSEDED by the Ordered Implementation Guide (M1-M8b), which carries the NON-NEGOTIABLE deploy order (M2 before M4). Kept as a high-level summary only; build from M1-M8b.

1. Stabilize Legacy Fast Rail
   - keep nextDial on
   - keep UI in release/loading state
   - switch visible lead only when poller sees new UII
   - suppress noisy strict errors during handoff

2. Add Terminal Outbox
   - schema/model
   - unique key
   - append-only live-loop write
   - serve-time safety filter

3. Add Universal Drain
   - DNC first
   - answered handler
   - did-not-connect handler
   - retry metadata
   - simple logs

4. Fix Bulk Placement/Release Accounting
   - record call placed through existing placement semantics
   - released-with-no-intent becomes `did_not_connect`
   - stored button intent overrides default

5. Hammer Bulk Refill
   - 30 target / 5 threshold
   - partial refill
   - rejection handling
   - no current clobber

6. Live Toggle Readiness
   - legacy fast
   - slow single
   - bulk load
   - one env/runtime switch per agent or cohort
   - clean rollback path

## Production Standard

> Status: AUTHORITATIVE — six production invariants. Consistent with Canonical Spec §3/§4 and Live Loop Rules.

The production standard is not "the app guessed right."

The standard is:

1. RingCX active call evidence decides what is current.
2. The UI never shows a lead as current without active-call evidence.
3. Released calls are durably timestamped before they can be served again.
4. Business writes happen outside the live loop.
5. DNC is drained quickly and retried loudly.
6. Refill keeps agents supplied without disturbing current-call rendering.

## Simplification Audit for Current Implementation

> Historical review pass — predates the reservation service; uses pre-canonical 'outbox' framing. Kept for rationale; the Canonical Spec (§0-§6) + Implementation Guide (M1-M8b) win on any conflict.

Current code is close but still mixed in a few places that reintroduce stale behavior and old assumptions. Keep behavior unchanged, but simplify to atomic jobs with explicit boundaries.

### Highest-risk simplifications (do now)

1. Replace legacy-shaped loop state in the simple loop service
   - File: `packages/shared-services/src/cxSimpleCallLoopService.js`
   - Risk: `startCxSimpleLoopSession` and related helpers still carry old queue/selection assumptions.
   - Change: keep one replacement session object for the replacement mode; do not branch session shape.

2. Remove weak match fallback from the simple loop hot path
   - File: `packages/shared-services/src/cxSimpleCallLoopService.js`
   - Risk: any non-strict match opens stale-current possibilities.
   - Change: active-call evidence only; no phone fallback.

3. Collapse synthetic auto-advance outcomes into terminal intent
   - File: `packages/shared-services/src/cxBulkLoadStateMachine.js`
   - Risk: invented labels (`cx-auto-advanced`) blur business semantics.
   - Change: transition should be explicit terminal events with no-answer equivalence in one place.

4. Split watcher orchestration into single-purpose functions
   - File: `packages/shared-services/src/cxBulkLoadRuntimeService.js`
   - Risk: `watchCxBulkLoadSession` currently polls + matches + refills + transitions in one unit.
   - Change: separate helpers for:
     - resolve active match
     - refill if needed
     - apply state transition

5. Make slow lane confirm path single-loop, no UI-driven re-drive
   - File: `packages/shared-services/src/cxSlowLaneService.js`
   - Risk: UI side logic currently does extra confirm/rewind assumptions.
   - Change: watcher decides fallback, loop keeps one terminal handoff.

### File-by-file cleanup list (minimal deltas)

1. `packages/shared-services/src/cxSimpleCallLoopService.js`
   - keep only: seed, poll, evidence match, disposition capture, drain/refill.
   - drop: mixed legacy/simple/bulk branching in the same file scope.

2. `packages/shared-services/src/cxBulkLoadRuntimeService.js`
   - keep handlers only: start/watch/submitDisposition/skip/kill.
   - move business checks to one transition helper and one outbox helper.

3. `packages/shared-services/src/cxBulkLoadStateMachine.js`
   - define one explicit transition graph:
     - running→current
     - current→terminal
     - terminal/failed handled by drain only.

4. `packages/shared-services/src/cxBulkLoadActiveCallWatcher.js`
   - strict matcher order:
     - externId match
     - queueItemId match
     - no match
   - no weak fallback.

5. `packages/shared-services/src/cxSlowLaneService.js`
   - single background decision function:
     - if active evidence exists, hold
     - else timeout/terminal
     - else continue waiting.

6. `packages/shared-services/src/cxSimpleLoopSession.js`
   - keep session shape minimal and loop-focused.
   - no legacy queue fields required for replacement mode.

7. UI route bindings
   - `apps/web-client/src/workspaces/cx/CXWorkspace.tsx`
   - `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx`
   - `apps/web-client/src/workspaces/cx/slow-single/CXWorkspaceSlowSingle.tsx`
   - `apps/web-client/src/lib/api/queries/cx.ts`
   - `apps/web-client/src/lib/api/queries/cxBulkLoad.ts`
   - keep routing thin; no new route/shape decisions outside service responses.

### Non-breaking simplification rules to preserve

1. Do not patch live production flow logic into legacy fast rail.
2. Do not let handlers mutate legacy queue shape as canonical state in replacement mode.
3. Do not use phone-only matching in any replacement path.
4. Keep queue clear semantics: never clear current because a lead is confirmed/replaced in background.
5. Any bulk refill should append into buffer and never disturb current.

### Suggested review checkpoints

1. For each target file, confirm every function has one job and one return shape.
2. Confirm active call is always the only source of current rendering.
3. Confirm every terminal writes exactly one outbox row and clears current.
4. Confirm every buffer change is monotonic (append/remove).
5. Confirm no function in loop services calls cadence counters or Logics directly.

## Review Hardening (2026-06-23)

> Historical review pass — this adversarial review MOTIVATED the Canonical Spec. Its 'primitives do not exist yet' / '30% done' verdict is point-in-time; those primitives are now specified as build targets in M1-M3. Read for rationale, not current status.

Code-grounded adversarial review verdict. The plan's principle is right; the safety
primitives it leans on **do not exist in code yet** — what ships today is an in-process
`Set` plus a synchronous, error-swallowing cadence write. So orphaning under speed is
real on two fronts.

**Drain concept: SOUND. Build: ~30% done, hard 70% hand-waved.** The single-writer seam
already exists (`cxBulkLoadOutcomeAdapter.persistTerminalOutcome` + `makeOutcomeIdemKey`)
— frame step 2 as "make the existing write durable + deferred," not "build a new outbox."

**Two real orphan gaps (must close before first live toggle):**
1. **Mid-tick orphan** — `watchCxBulkLoadSession` takes one snapshot/tick and completes
   only app-memory `current`. A lead dialed+released between two polls is never observed
   → no row, stays in `acceptedBuffer`, queue item still `claimed` → re-dialable, outcome
   lost. Fix: gap-tolerant release detection (prior-active set minus current snapshot).
2. **Restart/crash orphan** — no durable write-ahead. Order today is `dispositionCall`
   (RingCX ends call + advances) → `persistTerminalOutcome` → `persist`; a crash in that
   window strands `current` as phantom-ACTIVE and a later match relabels the real
   disposition `cx-auto-advanced` (a **DNC silently becomes auto-advance**). Fix: write a
   unique-keyed row BEFORE `dispositionCall` + a startup reconciler that replays it.

**Compliance landmine (must-fix):** answered & DNC dispositions are **silently dropped
today** — `classifyCxTerminalOutcome` only marks voicemail/no-answer safe; dnc/answered
fall through to `lastTerminalOutcomeIgnoredReason='not-safe-non-connect'` and return
`advanced:false`. No Logics contact-stop, no answered counter, no completion. Build the
explicit answered + DNC drain handlers the plan calls for; treat unknown outcomes as
fail-loud, never write-ignored-and-return-ok.

**Also before live:** record placement through the existing `handleCxCallPlaced` on the
bulk path (idempotent per `queueItemId:uii`) — today `placedCalls`/`contacts_sent` are
uncounted for bulk while terminal counters advance (metrics under-count exactly when bulk
goes live).

**Keep it simple — defer / cut (not needed for the first single-agent toggle):**
- **Universal cross-agent drain** → ship a per-session deferred write first (enqueue one
  durable row, best-effort process it); add the standalone cron/priority drain later.
- **Per-rail family bucket logic** → do not implement this three times. The source-pool
  selector is shared; each rail only passes the requested count and publish mode.
  Reconcile the **30-target/5-threshold vs 35-slot mix** by treating 35 as the full
  desired bulk inventory and 30 as the refill amount when 5 live slots remain.
- **`cxSimpleCallLoopService` `bulk-mirror`** is a 4th bulk path with a **banned
  phone-weighted matcher** (`scoreBulkActiveCandidate`, phone=+45) — collapse/delete it so
  no phone-only fallback is live during the toggle.

**Idempotency note:** keep the existing key on `queueItemId` (what the state machine
completes on); adding `uii` into the identity would *weaken* the complete-once contract.

## Minimal-Viable (Thinest) Execution Cut

> Historical review pass — thin-primitive sketch; uses outbox/intent vocabulary and a fixed target=30 buffer, both superseded by §2 (target 35 / refill 30 / threshold 5). Kept for rationale; build from M1-M8b.

Use this as the immediate implementation goal: remove every code path that is not required to
move one lead from RingCX active evidence to one durable terminal row.

### Non-negotiable contract

1. RingCX active-call evidence is the only source of `current`.
2. Every released **active UII** — whether or not it was ever promoted to `current` — must
   create one durable terminal row, even with no button intent. (A lead RingCX dials+releases
   between two polls is never `current`; the prior-active-set diff is what catches it. Do not
   narrow this to `current` or the mid-tick orphan returns.)
3. Every code path that mutates business state must run outside the live tick loop.
4. No synthetic business outcomes in the live loop.

### Thin function set (maximal reduction)

#### Shared loop primitives

Create/keep only these helper functions in each rail:

- `snapshotActiveCalls()` → pull current RingCX active calls.
- `deriveReleaseCandidates({ prevActive, nextActive, pool })` → returns released candidates.
- `matchCurrent(pool, active)` → one strict match (externId then queueItemId).
- `applyDispositionIntent(session, current, intent)` → write outbox intent only.
- `transitionCurrent(session, nextCurrent, now)` → clear old current, set new current.
- `ensureBuffer(session, threshold=5, target=30, offHook)` → refill when needed.

All other orchestration logic should compose these functions, not replace them.

#### Bulk path only (today toggle)

`watchCxBulkLoadSession()` should reduce to:

1. `prevActive = session.activeExternIds`
2. `active = snapshotActiveCalls()`
3. `released = deriveReleaseCandidates({ prevActive, nextActive: active, pool: session.acceptedBuffer })`
4. `for each released -> appendTerminalOutbox(row)`
5. `current = matchCurrent(session.acceptedBuffer, active)`
6. `transitionCurrent(session, current, now)`
7. `ensureBuffer(session, 5, 30, session.agentOffHook)`
8. persist `session.activeExternIds = active map`

#### Legacy fast + slow single

Keep as thin wrappers over the same primitives:

- Legacy: button click starts `release` + `nextDial`; only render on active evidence.
- Slow single: submit one lead, wait for `active` evidence, terminal button -> outbox intent + clear current.

### File-level simplification scope

1. [packages/shared-services/src/cxBulkLoadRuntimeService.js](/C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadRuntimeService.js)
   - `watchCxBulkLoadSession` should only orchestrate the thin function set above.

2. [packages/shared-services/src/cxBulkLoadActiveCallWatcher.js](/C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadActiveCallWatcher.js)
   - keep strict matching only; remove any fallback branches.

3. [packages/shared-services/src/cxSimpleCallLoopService.js](/C:/code/TagContactBridgeParalell/packages/shared-services/src/cxSimpleCallLoopService.js)
   - remove dual-path branching and any non-minimal loop logic.

4. [packages/shared-services/src/cxSlowLaneService.js](/C:/code/TagContactBridgeParalell/packages/shared-services/src/cxSlowLaneService.js)
   - keep exactly one confirm/poll decision path.

5. [packages/shared-services/src/cxBulkLoadStateMachine.js](/C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadStateMachine.js)
   - keep one transition function: `fromActive` and `toTerminal`.

6. UI surfaces:
   - [apps/web-client/src/workspaces/cx/CXWorkspace.tsx](/C:/code/TagContactBridgeParalell/apps/web-client/src/workspaces/cx/CXWorkspace.tsx)
   - [apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx](/C:/code/TagContactBridgeParalell/apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx)
   - [apps/web-client/src/workspaces/cx/slow-single/CXWorkspaceSlowSingle.tsx](/C:/code/TagContactBridgeParalell/apps/web-client/src/workspaces/cx/slow-single/CXWorkspaceSlowSingle.tsx)
   - render based on `current` from service only; do not re-derive from queue or response assumptions.

### Things to cut now (do not keep these in the first toggle)

- Any per-route logic that edits live state shape.
- Any phone/fuzzy fallback matching.
- Any route-specific branching to preserve legacy queue fields inside replacement services.
- Route-local or rail-local family bucket merge logic; use the shared source-pool selector.
- Cross-agent drain scheduling.
- Extra retry/visibility states in the loop (keep pending/retry/failed only for outbox).

## "Can we do this with less code?" — Claude review outcome

> Historical review pass — de-duplication/orchestration notes only; no reservation or source-pool authority. Superseded by the Canonical Spec + Implementation Guide for any contract detail.

Yes. The current direction is strong, but there is unnecessary duplication across three loop files.  
The goal is to remove non-essential abstractions, not rewrite behavior.

### Reduction principle

- Keep exactly one active-call tick path in each file.
- Keep one strict matcher per rail.
- Keep one terminal event sink per loop.
- Keep one replenishment strategy and reuse it.

### What to collapse first

1. `watchCxBulkLoadSession`
- from orchestration+business+retry logic
- to composed calls of:
  - snapshot active
  - diff release
  - append outbox for releases
  - strict match current
  - update current
  - refill when threshold hits
  - persist active ids

2. `cxSimpleCallLoopService`
- remove `single`/`bulk-mirror` branching in replacement mode
- reuse same loop primitives as bulk:
  - snapshot active
  - strict match
  - transition current
  - append intent outbox

3. `cxSlowLaneService`
- keep one decision loop:
  - active evidence exists -> wait
  - timeout without answer -> terminal
  - terminal -> clear current and stop driving next-state by route.

4. `cxBulkLoadStateMachine`
- trim to: active -> terminal transition, no synthetic `auto_advance` outcome creation inside the live loop.

5. `cxBulkLoadActiveCallWatcher`
- make it only the matcher:
  - `externId` match
  - then `queueItemId` match
  - no fallback branches.

### Suggested "thin file" target layout

1. `packages/shared-services/src/cxBulkLoadRuntimeService.js`
- Orchestrator functions: `start`, `watch`, `submitDisposition`, `skip`, `kill`.
- Internally: only the 6-step tick.

2. `packages/shared-services/src/cxSlowLaneService.js`
- Orchestrator functions: `start`, `watch`, `submitDisposition`, `skip`, `kill`.
- Single confirm timeout path.

3. `packages/shared-services/src/cxSimpleCallLoopService.js`
- Orchestrator functions: `start`, `watch`, `submitDisposition`, `skip`, `kill`.
- No duplicate rail-mode shape conversion.

4. `packages/shared-services/src/cxBulkLoadStateMachine.js` and
`packages/shared-services/src/cxBulkLoadActiveCallWatcher.js`
- Keep pure transition/match utilities only.

### Concrete simplification checkpoints

- Replace one loop to exactly one `tick()` function per service.
- Remove one-off helper names not used by `tick()`.
- No function in loop services should call:
  - cadence writes
  - Logics APIs
  - queue mutation logic that assumes legacy `selectedLead` shape.
- Keep one canonical evidence source and one outbox call site.

## Green-First Queue Rewrite (All 3 Rails) — Simplest Migration Map

> Historical / SUPERSEDED — earliest reservation sketch. Its strict green-first ordering and pre-canonical signatures (`reserveFromFamilyOrder({families,limit})`, `cxBulkLoadRuntime.js`) are NOT current. Canonical: ordering is policy-driven, mix-DEFAULT; green-first is a non-default `RC_CX_RESERVE_MODE` behind `RC_CX_AGED_MIN_RESERVE_PER_CYCLE`. Defer to §2 / M1 / M7.

> **Superseded by "Source Pool & Reservation — Canonical Spec"** (end of doc) — the single source of truth. Retained for rationale/history; the canonical spec wins on any conflict.

What broke the current loops: queue membership is still being built from legacy visible/assigned `ready` queries instead of session-owned reservations. That lets stale pool rows be touched by queue balancing and makes fresh leads race behind non-fresh rows.

### Cross-Rail Invariant

1. No rail should use assignment visibility as a queue builder source.
2. All rails claim leads atomically from `ready` before publish.
3. Queue order is policy-driven and shared by all rails.
4. Current is set only from RingCX active-call evidence.

### Shared Primitive to Introduce

Add one shared reservation layer:

1. Add [packages/shared-services/src/cxQueueReservationService.js](/C:/code/TagContactBridgeParalell/packages/shared-services/src/cxQueueReservationService.js).
2. The service exposes `reserveFromFamilyOrder({ domain, families, limit, claimMinutes, metadata })` and returns `{ reserved, missing }`.
3. Add `releaseReserved(rows, reason)` for publish failure cleanup.
4. Reserved rows are returned in exact family order and are already `claimed`.
5. The service writes provenance metadata only and does not implement business-state decisions.

### Repository helper needed

1. Add helper `reserveReadyRows(domain, candidateIds?, options)` in [packages/shared-repositories/src/cxDialQueueRepository.js](/C:/code/TagContactBridgeParalell/packages/shared-repositories/src/cxDialQueueRepository.js).
2. Keep existing `claimNextReadyQueueItem` and `listQueueItems` unchanged.
3. Use atomic `transitionQueueItemState` from `ready -> claimed` for stale-race safety.

### Rail-by-Rail Simplest Wire

#### 1) Bulk rail

1. Replace the current read-only list path in [packages/shared-services/src/cxBulkLoadRuntime.js](/C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadRuntime.js) with the shared reserver.
2. Keep [packages/shared-services/src/cxBulkLoadLeadSourceService.js](/C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadLeadSourceService.js) as normalization only.
3. In [packages/shared-services/src/cxBulkLoadRuntimeService.js](/C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadRuntimeService.js), `fillBuffer` should compute deficit, reserve rows, publish only reserved rows, release on reject, and append accepted rows directly to `acceptedBuffer`.

#### 2) Simple loop rail

1. Replace start/replenish logic in [packages/shared-services/src/cxSimpleCallLoopService.js](/C:/code/TagContactBridgeParalell/packages/shared-services/src/cxSimpleCallLoopService.js) to use shared reserved rows instead of `loadSimpleLoopQueue`.
2. Remove `replenishBulkQueue`/`loadSimpleLoopQueue` dual-mode flow and `bulk-mirror` branching from `advanceCxSimpleLoopSession`.
3. Remove phone-score fallback path (`findBulkCandidateForActiveCall` + `scoreBulkActiveCandidate`) from active matching.
4. Update [packages/shared-models/src/CxSimpleLoopSession.js](/C:/code/TagContactBridgeParalell/packages/shared-models/src/CxSimpleLoopSession.js) to drop `mode` if no longer used.

#### 3) Slow single rail

1. Replace [packages/shared-services/src/cxSlowLaneService.js](/C:/code/TagContactBridgeParalell/packages/shared-services/src/cxSlowLaneService.js): `selectNextQueueItem` should call shared reserve with `limit: 1`.
2. Keep publish/confirm/terminal orchestration unchanged.
3. Remove pre-publish branching that reselects assignment paths for the next row.

### Route and API layer expectations

1. [apps/control-plane/src/routes/cxBulkLoad.js](/C:/code/TagContactBridgeParalell/apps/control-plane/src/routes/cxBulkLoad.js), [apps/control-plane/src/routes/cxSimpleLoop.js](/C:/code/TagContactBridgeParalell/apps/control-plane/src/routes/cxSimpleLoop.js), [apps/control-plane/src/routes/cxSlowSingle.js](/C:/code/TagContactBridgeParalell/apps/control-plane/src/routes/cxSlowSingle.js) stay thin and unchanged.
2. Queue-building logic remains in services only.

### Green-first order target

1. Use this order for each reserve wave:
1. Fill `fresh-day1` first up to deficit.
2. Use `fresh-day2to10` only when needed.
3. Use `fresh-day16to30` only when needed.
4. Use `aged` only when needed.
5. Do not sort by agent-specific visibility; keep green-family policy head intact.

### Cut-to-live acceptance order

1. Add shared reserver service + repository helper.
2. Wire bulk to it and verify one refill cycle moves reserved rows and handles reject release.
3. Wire slow single one-row reserve path.
4. Strip simple from `bulk-mirror` branch and keep strict-match only.
5. Remove legacy visible-queue read path dependencies once all three rails pass.

### Practical simplification checks

1. `loadSimpleLoopQueue`/`replenishBulkQueue` no longer call list/read assignment views.
2. `cxSimpleCallLoopService` no longer has `mode === "bulk-mirror"` decision branches.
3. `cxSlowLaneService.selectNextQueueItem` delegates to shared reservation for next lead.
4. `[packages/shared-services/src/cxBulkLoadRuntime.js](/C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadRuntime.js)` no longer depends on `agentExtensionId` for queue selection.


---

## Source Pool & Reservation — Canonical Spec

> **Status:** canonical. This section is the single source of truth for the CX lead **source pool** and **reservation** service. It supersedes and consolidates three earlier, overlapping drafts (listed under *Supersedes*). Where this section and any earlier prose disagree, this section wins.

### 0. Scope & the one-pool decision

All three rails (legacy fast, slow single, bulk load) draw live-dialable leads from **exactly one shared pool: `CxDialQueue`** (mongo model `ControlPlaneCxDialQueue`, `packages/shared-models/src/CxDialQueue.js:116`). Tiering is by the `queueFamily` field, **not** by separate collections:

| Color  | `queueFamily`     | Age band (numeric, authoritative) | `queueFamilyRank` |
|--------|-------------------|-----------------------------------|-------------------|
| green  | `fresh-day1`      | ageDays ≤ 1                       | 0 |
| blue   | `fresh-day2to10`  | 2 ≤ ageDays ≤ 14                  | 1 |
| yellow | `fresh-day16to30` | 15 ≤ ageDays ≤ 29                 | 2 |
| red    | `aged`            | 30 ≤ ageDays ≤ 120               | 3 |
| (none) | `dead`            | ageDays > 120                    | 4 |

The family **keys are stale vs business meaning** — `fresh-day2to10` covers business-age 2–14 and `fresh-day16to30` covers 15–29 (`cxQueuePolicyService.js:1530` `deriveQueueFamilyFromAgeDays`). Always classify and document by the **numeric thresholds**, never by the key name. `queueFamilyRank` is a persisted indexed field (`CxDialQueue.js:30`) stamped at materialize time from `getQueueFamilySortRank()`.

**The parallel `QueueItem`/UCQ pool is OUT OF SCOPE and must not be a rail source.** `universalQueueService`, `freshLeadAssignmentService`, and `queueItemRepository` operate on a *separate* `QueueItem` collection (states `in_pool`/`fresh_assigned`/`pending_assignment`/`in_slice`). No rail in this spec may read or reserve from it. The only sanctioned bridge, `ringcxLeadServingService.publishQueueItemToRingcx` (`ringcxLeadServingService.js:808`), which copies a `CxDialQueue` row into the UCQ behind `isPacingQueueEnabled`, is a **double-dial hazard** (the two pools share no `_id`, only a string-built `caseId`/`leadId`).

**The config-flag OFF state is not sufficient on its own — a DB-level cross-pool interlock is required (see CR4/FM-2).** A per-agent mis-set of `isPacingQueueEnabled` would otherwise let the same `caseId` be live in `CxDialQueue` (reserved/claimed) AND `QueueItem` (in_pool/in_slice) simultaneously, with nothing at the DB layer preventing the double-dial. Therefore: at reserve/claim time the reservation service MUST assert (cheap indexed existence check on the shared `caseId`/`leadId` string) that the case is **not currently active in `QueueItem`**, and refuse the claim if it is; symmetrically, `publishQueueItemToRingcx` MUST be gated on the **absence** of an active `CxDialQueue` claim for the same `caseId`. The flag-OFF invariant is belt; this interlock is suspenders.

### 1. Ingestion contract (every source → pool-owned, family-classified)

**Invariant I1 — pool-owned at create, with a validated family.** Every ingestion writer creates rows with `state ∈ {queued, ready}`, a resolved `queueFamily`, a valid `releaseAt`, and **NO `assignment.extensionId`** (no agent pin), except the appointment exception below. Agent pinning is a strictly *later* step (§3 reservation, or the balanced-load assigner at `cxCadenceService.js:3511` which writes `assignment` via `transitionQueueItemState(... ['claimed'] ...)`). New greens enter at the **head of the green family** by the natural sort `{queueFamilyRank:1, …, createdAt:1}` (`TOUCH_BALANCED_QUEUE_SORT`, `cxDialQueueRepository.js:6`) — i.e. inserted into the green source bucket, never shoved onto a specific agent's loaded campaign.

**Family validation (closes the unbounded-family hole).** `queueFamily` at create MUST be one of the five enumerated families. Any caller-supplied `queueFamily` (including `cxAppointmentService.js:262`'s `input.queueFamily || 'fresh-day2to10'` passthrough, which today applies only a default fallback and performs **no enum validation**) MUST be validated against the enum and, if absent or invalid, **re-derived from `ageDays` via `deriveQueueFamilyFromAgeDays`**. No row may enter the pool with a family that no `familyTargets` bucket in `reserveFromFamilyOrder` addresses (such a row would be pool-owned but permanently un-reservable / orphaned).

**Invariant I2 — stable actionKey.** Every writer MUST supply a stable `metadata.actionKey`; the partial unique index `uq_cxdialqueue_active_action` keys active rows on `{domain, caseId, metadata.actionKey}` over active states `{queued, ready, claimed, serving, paused}` (`CxDialQueue.js:73`). A missing/unstable key silently dedupes a genuinely new dial request onto an existing row, or fails the upsert. Precedence on collision: **appointment hold > fresh ingestion** (the appointment-hold short-circuit at `cxCadenceService.js:1990` is authoritative).

**Sanctioned writers (only two real funnels into `CxDialQueue`):**

1. **`cxCadenceService.queueCxDialRequest`** (`cxCadenceService.js:1935`) — the single funnel for event/first-contact/hot-intent/postdate/appointment ingestion. Classifies via `resolveQueueFamilyForPayload` (`:2107`), sets `state` from release timing (`:2141`), writes via `cxDialQueueRepository.upsertQueueItem` (`:2131`). **Never sets `assignment`.** Also the `DIAL_REQUESTED` event handler (`:2985`).
2. **`cxDialQueueRepository.upsertQueueItem`** (`cxDialQueueRepository.js:146`) — raw writer, called directly **only** by the `cxWorkspaceService` refill materializers: `materializeDay2to15` (`:3008`, `fresh-day2to10`, priority 100), `materializeDay16To30` (`:3113`, `fresh-day16to30`, priority 90), `materializeAgedQueueItems` (`:3223` from `LeadCadence`, `:3303` from `MasterProspectIndex` filler pool, `aged`, priority 85). All write `state:'ready'`, `releaseAt: now`, no `assignment`.

**Per-source conformance (named from grounding):**

| Source | Path | Today | Required change |
|--------|------|-------|-----------------|
| Intake first-contact | `inboundIntakeService.js:2272` | actionKey `first-cx:${caseId}`, family→`fresh-day1`, pool-owned | **conforms** — no change |
| SMS hot-intent | `hotIntentRouterService.js:176` | `fresh-day1`, priority 500, pool-owned | **conforms** |
| Post-date-hold release | `cxWorkspaceService.js:8843` | `fresh-day2to10`, pool-owned | **conforms** |
| Day2-15 / Day16-30 / Aged refill | `cxWorkspaceService.js:3008/3113/3223/3303` | `ready`, no assignment | **conforms**; `options.agentExtensionId` is touch-policy gating only (`:3003`), never a pin — keep it that way |
| Filler pool | `fillerPoolRefreshService.js:33/486` | writes `MasterProspectIndex.pool.tag` only | **conforms** but indirect: enters pool only via `materializeAgedQueueItems` when `pool.tag` matches current month (env `RC_CX_FILLER_POOL_TAG`). **Required:** define filler→pool materialization SLA + tag lifecycle so a month boundary cannot silently starve red (§6 FM-4). |
| Orchestrators (`hourlySweeperService`, `ncoaUploadService`) | — | no direct pool writer; reach pool via `LeadCadence`→first-contact/refill | **conforms** — keep them out of the direct writer set |
| **`cxMorningQueueBuilderService`** | `cxMorningQueueBuilderService.js` (`buildCxQueueForAgent:336`, `mirrorQueueRows:342–396`, `publishQueueItemToRingcx:367`) | **NON-CONFORMING reader/mirror.** Build phase reads queue membership from assignment-visibility lists (`listQueueItems` by `visibleExtensionId`, `cxWorkspaceService.js:2343`). Mirror phase calls `publishQueueItemToRingcx` directly with `statesToMirror=['claimed','serving','ready']` — the FM-2/CR4 UCQ double-dial bridge. | **OUT OF SCOPE + must be disabled for any agent on these rails** (§0/CR4/§6). It pre-seeds RingCX before login on the same agents the bulk/slow rails then drive; mirroring `ready` rows into the UCQ while the bulk rail reserves those same `ready` rows = same lead live in both pools, double-dialed. **Required:** disable this service (or force its mirror phase past the bridge with `isPacingQueueEnabled=false`) for every rail-driven agent; remove its visibility-list read from the live path. |
| **Appointment** | `cxAppointmentService.ensureAppointmentQueueItem:266` | goes through `queueCxDialRequest` (which drops the pin) BUT also passes `metadata.assignedExtensionId` (`:274`) and, in a **second write**, transitions the row to `state:'paused'` with its own `assignment{}` block (`:310/328`, and again `:693/733`) | **EXCEPTION — pre-pinned by design; create→pause must be made atomic (§3 G-appt).** This is the one ingestion path carrying an agent identity. Do **not** "centralize" appointment ingestion onto bare `queueCxDialRequest` — that un-pins appointment leads. |

Non-conformance to fix: the appointment two-step (create-as-ready-then-pause) and `cxMorningQueueBuilderService` (visibility-list read + UCQ mirror). The remaining defect the rails introduced is on the *read* side — building queue membership from legacy visible/assigned `ready` queries (the "agent queue as temporary storage" bug). §3 replaces that.

### 2. Reservation contract — `cxQueueReservationService`

Introduce **one shared reservation service** at `packages/shared-services/src/cxQueueReservationService.js` (net-new; confirmed absent today). All three rails reserve through it. No rail builds queue membership from `listQueueItems` + assignment visibility ever again.

**API:**

```js
// Returns rows already atomically claimed, in family order.
reserveFromFamilyOrder({
  domain,
  agentExtensionId,        // stamped into assignment AFTER claim (provenance pin)
  sessionId,               // FRESH UUID per process start; never reused (§4)
  familyTargets,           // POLICY-DRIVEN: { 'fresh-day1': n, 'fresh-day2to10': n, ... }
  totalLimit,              // overall deficit cap
  claimMinutes,            // TTL; see §3
  metadata,                // provenance only
}) -> { reserved: Row[], missing: { [family]: shortfall } }

releaseReserved(rows, reason) -> void   // publish-failure cleanup: claimed -> ready
renewClaim(ids, claimMinutes) -> void   // heartbeat; single guarded CAS per row (§3)
```

**Repository helper (net-new) — `reserveReadyRows(domain, familyTargets, options)` in `cxDialQueueRepository.js`. Implemented as a SINGLE atomic bulk claim per family, NOT a list-then-CAS-loop (closes the read-plan-staleness shortfall):**

Per family, run one pipeline-backed bulk claim:
1. `$match` `{ state:'ready', queueFamily:<family>, 'metadata.appointmentId':{$in:[null,'']} }` (appointment rows are structurally excluded — see G-appt).
2. `$sort` `TOUCH_BALANCED_QUEUE_SORT`.
3. `$limit n`, collect `_id`s.
4. **One** `updateMany({ _id:{$in:[...]}, state:'ready' }, { $set: claimPatch+lease+assignment })` — `updateMany` is atomic per-document; `modifiedCount` is the **true reserved count** in one round trip.
5. Re-read the actually-modified set (the rows whose `reservationSessionId` now equals this session).

`modifiedCount < n` means rows were claimed elsewhere between `$match` and `updateMany` (legacy fast's `limit:1`, the balanced-load assigner at `cxCadenceService.js:3511`, or another session). In that case **re-plan and retry the residual deficit ONCE within the same tick** before reporting `missing`. This distinguishes "claimed elsewhere" (transient — retry) from "truly short supply" (report in `missing`). The deficit formula must never attribute an elsewhere-claim to short supply.

- Keeps existing `claimNextReadyQueueItem` (`:272`) and `listQueueItems` unchanged.
- Reservation lease fields stamped on claim: `state:'claimed'`, `assignment.extensionId = agentExtensionId`, `assignment.assignedAt = now`, `claimUntil = now + claimMinutes·60s`, `metadata.reservationSessionId = sessionId`, `metadata.reservedAt = now`, `metadata.reservationExpiresAt = now + ttl`; clear stale `lastRingcxPublished*`/runtime flags.

**Ordering is POLICY-DRIVEN with per-family targets — this resolves the green-first-vs-mix contradiction.** The service consumes the *existing* per-family `targetOpen` machinery (`resolveAccountQueuePolicy` `cxQueuePolicyService.js:312`, `getQueueFamilyTargetOpen` `:414`, env `RC_CX_FRESH_TARGET_OPEN`/`RC_CX_DAY2TO15_TARGET_OPEN`/`RC_CX_DAY16TO30_TARGET_OPEN`/`RC_CX_AGED_TARGET_OPEN`, resolved at `cxWorkspaceService.js:3698`). Mode via `RC_CX_RESERVE_MODE`:

- **`mix` (DEFAULT; whether it becomes the SOLE sanctioned live mode is an OPEN decision — see the Implementation Guide "Open items"):** `familyTargets` = the per-family `targetOpen` deficit, e.g. **15 green / 10 blue / 5 yellow / 5 red** (35 full bulk inventory). Each family contributes its own deficit; `aged.fillRemainder=true` lets red absorb leftover total deficit (`cxWorkspaceService.js:3712`). Prevents aged starvation under chronic-short-green.
- **`green-first`:** `familyTargets['fresh-day1'] = totalDeficit`, all other families 0; backfill spills into blue→yellow→red only when green is short. **WARNING — no aged floor.** Under intermittent green trickle, each cycle fills green first and the spill rarely reaches red, so aged leads age toward `dead` (>120d, dropped from pool per §0) without ever being served. Do not run `green-first` live without the aged-floor guarantee below.

**Aged-floor / minimum-served guarantee (independent of open-set depth).** `targetOpen` is open-set **depth**, NOT dial **throughput** — holding red at depth 5 does not mean red gets dialed. Add `RC_CX_AGED_MIN_RESERVE_PER_CYCLE`: each reserve cycle reserves **≥N red** even when green is available, paired with the existing per-family hourly/daily minimums so aged is actually dialed, not merely held at depth. This applies in both modes (it is the only aged-throughput guarantee in `green-first`).

**Order-fill backfill (both modes):** build each family bucket via the bulk-claim above, in `queueFamilyRank` order (green, blue, yellow, red). If a family is short, take what the bulk claim modified and continue to the next family — never block, never throw; return the shortfall in `missing` only after the single same-tick re-plan retry. Short yellow/red leaves the rail healthy.

**Rail load sizes (same service, different request):**
- **Bulk:** reserve a batch (deficit toward target 35 / refill 30 when ≤5 live), publish one at a time in order, append accepted rows to `acceptedBuffer`.
- **Legacy fast:** reserve the next single candidate only when the handoff needs it (`totalLimit: 1`).
- **Slow single:** reserve one, publish one, wait for confirmation (`totalLimit: 1`, replacing `cxSlowLaneService.selectNextQueueItem`).

**Deficit formula (all rails):** `deficit = target − (acceptedBuffer.length + (current ? 1 : 0))`. Buffer membership reflects only rows whose lease the session still holds (rows are dropped from the buffer atomically before any `releaseReserved`, §3/§4).

### 3. Claim-TTL race guard (the buffer-steal bug — must close before any live toggle)

**The race (confirmed in grounding):** a reserved row carries a fixed `claimUntil = now + max(claimMinutes,1)·60s` (`buildClaimPatch:114`, default 5 min, **never renewed** — no heartbeat exists). While the row dwells in `acceptedBuffer`/`current` un-dialed, the reaper `requeueExpiredClaims` (`:201`) matches it once `claimUntil ≤ now` **and** it still "looks un-dialed" per `buildExpiredClaimRequeueQuery` (`:122`): `metadata.servingAt` empty, `lastDialExecutionUii` empty, `lastQueueAttemptHeldForDisposition` ≠ true, `lastDialIntentStatus` empty/failed. **The reaper query is GLOBAL — no `domain`, no `agentExtensionId`, no `reservationSessionId` filter.** It flips `state→ready`, nulls `claimUntil`, and **unconditionally wipes the entire `assignment` subdoc** (`:221`) — with no callback to the buffer holder. The freed row is re-claimable → **same lead double-reserved and double-dialed**.

A lease-freshness comparison (`reservationExpiresAt > now`) is **not** a sufficient fix: it is best-effort and lost the moment renewal lapses for one tick (GC pause, skipped watch tick, deploy restart) — a stale `reservationExpiresAt` makes the global reaper free a row a second session then re-claims (cross-session same-row double-reserve). The renewal-write-vs-reaper-write interleaving is itself an unguarded TOCTOU.

**Required mechanism (implement ALL):**

1. **Hard reaper exclusion by ownership, not by lease freshness (primary fix).** Extend `buildExpiredClaimRequeueQuery` so ANY row carrying a `metadata.reservationSessionId` is **invisible to the global reaper**, regardless of lease age: add `{$or:[{'metadata.reservationSessionId':{$in:[null,'']}},{'metadata.reservationSessionId':{$exists:false}}]}`. The only actor allowed to free a reserved row is (a) the owning session, via `releaseReserved`, or (b) the crash reconciler that has proven the session dead (§4). This removes the heartbeat-vs-global-reaper TOCTOU entirely; the heartbeat below becomes a liveness signal, not the safety mechanism.

2. **Renewal heartbeat as a single guarded CAS per row.** `renewClaim(ids, claimMinutes)` re-stamps `claimUntil` (and `reservationExpiresAt`) each tick for rows still in `acceptedBuffer`/`current`, with a **single `findOneAndUpdate` per row guarded by `{ state:'claimed', 'metadata.reservationSessionId': session.id }`** — it re-confirms the row still carries this session at write time (never blind-updates by `_id`). The renewal interval MUST be `< claimMinutes`. If the dialer has moved the row to `serving`, or another owner now holds it, the guard makes renewal a silent no-op. **Renewal MUST stop the instant a terminal outcome is observed for the row** (see fix 4).

3. **Terminal-aware reaper override (closes the orphan in §4).** The reaper exclusion in fix 1 must NOT pin an orphan that already has terminal evidence. A `claimed` row that carries a released-UII / terminal-outbox record but is un-completed must remain **force-completable** (§4): stop renewing its lease, and let the reconciliation path complete it. Equivalently: lease keep-alive applies only while NO terminal outcome has been observed.

4. **G-appt — appointment create→pause atomicity (closes the create→pause steal).** `cxAppointmentService` MUST make the appointment row appointment-pinned in a single atomic step — either create it **directly in `state:'paused'` with `assignment` set in the same upsert**, or claim `transitionQueueItemState(['queued','ready'], { state:'paused', assignment })` **before the row is ever reservable** — instead of today's create-as-ready (`:253`) then pause (`:310`). Defense-in-depth: reserve's family `$match` already excludes `{'metadata.appointmentId':{$in:[null,'']}}` and only claims `state:'ready'` (paused is structurally excluded). This makes "appointment is pre-pinned" an invariant no reserve CAS can violate during the create→pause window. The `assignment.extensionId`-set + `metadata.appointment*`-present skip predicate (FM-5) remains as a read-side guard for any future `paused→ready` release path (§4).

5. **Dialer serving-stamp as a SINGLE atomic write.** The `claimed→serving` transition MUST set `state:'serving'` AND `metadata.servingAt` in the **same `$set`** (`transitionQueueItemState(['claimed'], { state:'serving', 'metadata.servingAt': now, ... })`). `servingAt` is never set on a non-serving row. This eliminates the "serving-but-unstamped" latent window and makes renewal/dial ordering immaterial (renewal's `state:'claimed'` guard provably no-ops once the row is serving).

**Guardrail G3a:** `buildClaimPatch` collapses `claimMinutes` to 5 (1-min floor) on `0/NaN/undefined` (`:118`). The reservation service MUST pass an explicit `claimMinutes` ≥ (renewal interval × 2); never rely on the default.

### 4. Cross-rail invariant + release coordination

**Invariants (enforced by all three rails):**
- **CR1.** No rail uses assignment visibility (`listQueueItems` by `visibleExtensionId`/assigned `ready`) as a *queue builder source*. Membership comes only from `reserveFromFamilyOrder`. (This is why `cxMorningQueueBuilderService` is out of scope and disabled, §1.)
- **CR2.** All rails claim atomically `ready → claimed` before publish, via the single bulk `updateMany({_id:{$in},state:'ready'})` (§2); only rows whose claim modified-count includes them are buffered/published.
- **CR3.** Queue order is policy-driven and shared (§2); `current` is set only from RingCX active-call evidence (per the Live Loop Rules section).
- **CR4.** The UCQ bridge (`publishQueueItemToRingcx`, `isPacingQueueEnabled`) is OFF for any agent driven by these rails AND backed by the §0 DB-level cross-pool interlock (claim-time assertion that the `caseId` is not active in `QueueItem`, and publish-time assertion that no active `CxDialQueue` claim exists). `cxMorningQueueBuilderService`'s mirror phase is included in this prohibition.

**Session identity.** `sessionId` is a fresh UUID generated per process start and **never reused**, so "is the owning session gone?" is decidable without ambiguity (used by the crash reconciler and by every guarded write's `reservationSessionId` match).

**Reservation ↔ terminal-outbox reconciliation (the `claimed` lifecycle must close — two distinct terminal exits):**

- **Published → completed (force path; closes the held-for-disposition orphan).** When a reserved row is published and later released, the live loop writes its durable terminal outbox row. A reserved row is `state:'claimed'` with `metadata.servingAt` empty, so it is **un-held**: routing its completion through `handleCxTerminalCallOutcome` returns `advanced:false reason:"not-held-for-disposition"` (`cxCadenceService.js:2535–2546`) and completes nothing — and with the reaper now excluding session-held rows (§3.1) plus renewal keeping the lease alive, the row would leak `claimed` forever, blocking the `uq_cxdialqueue_active_action` index. **Therefore: terminal reconciliation for a row still in `state:'claimed'` (reserved-published, never marked serving) MUST complete via the force path — call `completeCxQueueItem` directly (`cxCadenceService.js:4118`, which accepts `claimed` in its `fromStates` and has NO held-for-disposition gate), OR pass an explicit `force:true`/`fromReservedClaim:true` into `handleCxTerminalCallOutcome` that, when authoritative terminal evidence (released UII) exists, skips the `:2535` early-return.** The held-for-disposition gate applies only to `serving` rows. A completed lead clears its own reservation (terminal state ∉ active set → unique index frees, reaper can't touch it).

- **Published → rescheduled (lands in `queued`, NOT `ready`).** The terminal reschedule path `rescheduleCxQueueItem` (`cxCadenceService.js:3852`) transitions to `state:'queued'` with a future `releaseAt` and cleared `assignment` — re-promoted to `ready` only by `releaseDueQueueItems` (`cxDialQueueRepository.js:174`, `queued→ready`). It is **not directly reservable until promoted.** `buildClearedDialRuntimeMetadata` (`cxCadenceService.js:3447`) clears `lastDial*` runtime fields but does **NOT** null the net-new reservation provenance, so **both `rescheduleCxQueueItem` AND `completeCxQueueItem` MUST additionally null `metadata.reservationSessionId` / `metadata.reservedAt` / `metadata.reservationExpiresAt`** (add them to `buildClearedDialRuntimeMetadata`). Otherwise a requeued `queued` row carries a stale lease that re-enables the reaper exclusion on a row no session owns.

- **Reserved-but-never-published → release back to source family.** If publish fails/rejects, or the session ends with rows still buffered un-dialed, the rail calls `releaseReserved(rows, reason)` → `transitionQueueItemState(['claimed'], { state:'ready', claimUntil:null, assignment:{extensionId:null,…}, 'metadata.reservationSessionId':null, …, metadata.lastReleaseReason })`. The row returns to its **original `queueFamily`** (family is never mutated on release), re-entering pool order at its natural `createdAt`/rank position. **`releaseReserved` MUST remove the row from `acceptedBuffer`/`current` BEFORE issuing the `claimed→ready` write**, so no later renewal tick from the same session can re-stamp a row it has released (closes the renew-vs-release TOCTOU).

- **Mid-tick orphan reconciliation:** a lead RingCX dials+releases between two polls is caught by the prior-active-set diff (`deriveReleasedCandidates`) → terminal outbox row → completed via the force path → reservation cleared. The diff is the backstop, not optional.

- **Crash reconciliation (strict startup ordering; idempotent):**
  1. **FREEZE the global/session reaper** until the crash reconciler has run.
  2. The reconciler claims each dangling `metadata.reservationSessionId` row via `transitionQueueItemState(['claimed'], {...})` **guarded by `reservationSessionId`**, so a freshly-restarted live session re-adopting its buffer (a CAS loser) cannot be clobbered. For each adopted row: if a terminal outbox row / released-UII evidence exists, **force-complete via `completeCxQueueItem`** (NOT the gated `handleCxTerminalCallOutcome` — same orphan trap as above); else `releaseReserved` it back to `ready`.
  3. Only after reconciliation completes does the reaper resume. Because session UUIDs are never reused, "owning session is gone" is unambiguous, and the reaper-vs-reconciler race over a dangling row cannot silently re-pool a published-but-uncompleted dial (the reaper is frozen until step 2 finishes).

### 5. Failure modes

| ID | Failure | Trigger | Mitigation in this spec |
|----|---------|---------|-------------------------|
| FM-1 | Buffer-steal double-dial (same session) | reaper requeues a buffered claimed row | §3.1 hard ownership exclusion (reaper invisible to any `reservationSessionId` row) + §3.2 guarded renewal |
| FM-1b | Cross-session same-row double-reserve | lease lapses one tick; global reaper frees; 2nd session re-claims | §3.1 ownership exclusion (not lease-freshness); only owner/reconciler frees |
| FM-2 | Double-dial across pools | `publishQueueItemToRingcx` (incl. morning-builder mirror) copies row into UCQ | §0 DB-level cross-pool interlock at claim+publish time, over and above CR4 flag-OFF |
| FM-2b | Morning builder seeds both pools | `cxMorningQueueBuilderService` mirrors `ready` rows + builds from visibility lists | §1 out-of-scope + disabled for rail agents; §6 checklist |
| FM-3 | actionKey collision/dedupe | source omits/unstable `actionKey`; appointment-hold short-circuit (`cxCadenceService.js:1990`) | §1 I2 mandatory stable key; precedence appointment hold > fresh ingestion |
| FM-3b | Unaddressed `queueFamily` orphan | caller supplies off-enum family (e.g. appointment `input.queueFamily` passthrough, `:262`) | §1 I1 enum validation + re-derive via `deriveQueueFamilyFromAgeDays` |
| FM-4 | Aged starvation (supply) | `MasterProspectIndex.pool.tag` ≠ current month at boundary | §1 filler SLA + tag lifecycle; `mix` default keeps red target funded |
| FM-4b | Aged starvation (throughput) | `green-first` trickle never spills to red; or `targetOpen` holds red at depth without dials | §2 `RC_CX_AGED_MIN_RESERVE_PER_CYCLE` + per-family hourly/daily mins; `targetOpen` is depth not throughput |
| FM-5 | Un-pinned appointment | create→pause two-step window; or reaper wipes assignment on a `ready` appointment row | §3 G-appt atomic create-as-paused + reserve `$match` excludes `metadata.appointmentId`; reaper exclusion extended to `metadata.appointment*` |
| FM-6 | DB-claim vs workspace-display order divergence | persisted `queueFamilyRank` + no aging boost vs in-memory `getCxQueueServeRank` boost (`cxQueueFairnessService.js:191`) | reservation orders by persisted rank only (DB-authoritative); aging boost is display-only |
| FM-6b | Stale persisted rank drifts the mix | row crosses a band boundary (e.g. day-2 green→blue) but keeps stale `queueFamilyRank` until re-materialized → counted against wrong family target | §6 re-materialize/re-classify SLA: re-stamp `queueFamily`/`queueFamilyRank` from `deriveQueueFamilyFromAgeDays` for any active row whose business-age crossed a band, with a max-staleness bound (nightly + on band-crossing) |
| FM-7 | Assignment silently wiped under buffer holder | unconditional `assignment` null on requeue (`:221`) | §3.1 ownership exclusion prevents reaper from touching session-held rows |
| FM-8 | Reserved-never-published leak | session ends with buffered un-dialed rows | §4 `releaseReserved` (buffer-drop before write) + frozen-reaper startup reconciler |
| FM-8b | Held-for-disposition orphan | reserved-published row dialed+released before `serving`; gated handler completes nothing while reaper excluded + lease renewed | §4 force-complete via `completeCxQueueItem` (no held gate) for `claimed` rows; §3.3 stop renewing once terminal evidence seen |
| FM-8c | Rescheduled row carries stale lease | reschedule→`queued` keeps `reservationSessionId` → re-enables reaper exclusion with no live owner | §4 null reservation provenance in `buildClearedDialRuntimeMetadata` |
| FM-9 | Family override mis-config | per-family daily-max double-gated by `RC_CX_ALLOW_FAMILY_DAILY_MAX_OVERRIDES` (`cxQueuePolicyService.js:245`) | reserve uses `targetOpen` (supply), not daily caps; caps don't reserve slots — documented separately |
| FM-10 | Read-plan staleness mis-attributed as short supply | list-then-CAS loses a row to another rail; loser reports `missing` though supply exists | §2 single `updateMany` bulk claim (modifiedCount = truth) + one same-tick re-plan retry before reporting `missing` |
| FM-11 | Crash reconciler clobbers re-adopting session | reconciler `releaseReserved`s a row a restarted live session still holds | §4 reconciler write guarded by `reservationSessionId`; fresh-UUID sessions; reaper frozen until reconciliation done |

### 6. Air-tightness checklist (must all pass before first live toggle)

- [ ] One pool only: every rail's live inventory comes from `CxDialQueue` via `reserveFromFamilyOrder`; zero reads of UCQ/`QueueItem` or assignment-visibility lists in any rail, **including `cxMorningQueueBuilderService` (disabled for rail agents)**.
- [ ] DB-level cross-pool interlock active: claim refuses if `caseId` is active in `QueueItem`; `publishQueueItemToRingcx` refuses if an active `CxDialQueue` claim exists for the `caseId`.
- [ ] Every ingestion writer is pool-owned (no `assignment` at create) except the appointment exception, which is **created atomically as `paused`+assigned** (no create→pause window).
- [ ] Every ingestion writer supplies a stable `metadata.actionKey`.
- [ ] Every pool row's `queueFamily` is one of the 5 enumerated families and is reservable by some `familyTargets` bucket (caller-supplied families validated/re-derived).
- [ ] New greens land at green-family head by `{queueFamilyRank:1, createdAt:1}`; no source live-inserts a green onto an agent's loaded campaign.
- [ ] Reservation is a single atomic bulk claim (`updateMany({_id:{$in},state:'ready'})`) per family; `modifiedCount` is the reserved count; residual deficit gets ONE same-tick re-plan retry before any `missing` is reported.
- [ ] `claimMinutes` is passed explicitly (never default-5); `claimUntil`/`reservationExpiresAt` renewed every tick (interval < `claimMinutes`) via a single CAS guarded by `{state:'claimed', reservationSessionId}`; renewal STOPS once terminal evidence is observed.
- [ ] Reaper (`requeueExpiredClaims`) is **invisible to any row carrying `reservationSessionId`** (hard exclusion, not lease-freshness); only the owning session or the (frozen-until-done) crash reconciler frees a reserved row. Exclusion also covers `metadata.appointment*` rows.
- [ ] Dialer sets `state:'serving'` AND `metadata.servingAt` in the SAME write; `servingAt` never set on a non-serving row.
- [ ] `familyTargets` resolved from policy (`getQueueFamilyTargetOpen` + env), `RC_CX_RESERVE_MODE` honored; order-fill backfill in rank order; shortfall returned in `missing` (never throws on short supply).
- [ ] Aged-throughput floor enforced (`RC_CX_AGED_MIN_RESERVE_PER_CYCLE` + per-family mins); `targetOpen` understood as depth not throughput; `green-first` not run live without this floor.
- [ ] Publish failure → `releaseReserved` drops the row from buffer BEFORE the `claimed→ready` write, returns it to its original family with a visible reason and nulled reservation provenance; family never mutated.
- [ ] Every released active UII (including mid-tick, never-`current`) yields one terminal outbox row → **force-complete via `completeCxQueueItem` for `claimed` rows** (held-for-disposition gate bypassed) → reservation cleared.
- [ ] Terminal completion AND reschedule both null `metadata.reservationSessionId`/`reservedAt`/`reservationExpiresAt`; rescheduled rows land in `queued`+`releaseAt` and are re-promoted by `releaseDueQueueItems` (not directly reservable).
- [ ] Startup: reaper frozen until crash reconciler runs; reconciler adopts dangling `reservationSessionId` rows via a `reservationSessionId`-guarded CAS, force-completes (if terminal evidence) or `releaseReserved`s; session IDs are fresh UUIDs, never reused.
- [ ] UCQ bridge `publishQueueItemToRingcx` (incl. morning-builder mirror) is disabled for every agent on these rails.
- [ ] Reserve order uses persisted `queueFamilyRank` only; aging boost is display-only; a re-materialize/re-classify SLA bounds `queueFamilyRank` drift across band boundaries.


---

## Source Pool & Reservation — Ordered Implementation Guide (FINAL)

> Builds the canonical spec (§0–§6 of `docs/CX_DIAL_RAIL_FINALIZATION_PLAN_2026-06-23.md`). Milestones are dependency-ordered: M1 lays the net-new claim primitives, M2–M3 close the lifecycle races, M4 rewires the rails (and threads the service into them), M5 adds the cross-pool interlock, M6–M7 conform ingestion + policy, M8 tests + maps to the §6 checklist. Every snippet is grounded in verified real signatures cited inline. **All new behavior is fail-closed and default-off** until the §6 checklist (M8) passes.
>
> **NON-NEGOTIABLE DEPLOY ORDER:** `reserveReadyRows` (M1) may be merged and unit-tested in isolation, but it MUST NOT be consumed by any live rail (M4 toggle) until M2's reaper ownership-exclusion ships. A reserved row whose lease lapses before M2 lands would be reaped back to `ready` by the existing `requeueExpiredClaims` while its session still believes it owns it — the exact FM-1 race the plan exists to close. Keep **M2 strictly before M4** in deploy order.

---

### M1 — `reserveReadyRows` repo helper + `cxQueueReservationService` (atomic bulk claim per family)

**(a) Goal** — Net-new single-atomic-bulk-claim-per-family primitive (`modifiedCount` = truth, one same-tick re-plan retry) and the one shared reservation service all three rails consume. Closes §2 read-plan-staleness (FM-10).

**(b) Files**
- EDIT `packages/shared-repositories/src/cxDialQueueRepository.js` — add `reserveReadyRows` after `claimNextReadyQueueItem` (`:272`); export it in `module.exports` (`:481`). Reuse `TOUCH_BALANCED_QUEUE_SORT` (`:6`), `buildClaimPatch` (`:114`), `normalizeDomain` (`:16`), `normalizeQueueFamilies` (`:35`).
- CREATE `packages/shared-services/src/cxQueueReservationService.js`.
- EDIT `packages/shared-services/src/index.js` — export `createCxQueueReservationService` (follow the `require("./...")` idiom around `:70`).

**(c) Snippets**

```js
// cxDialQueueRepository.js — after claimNextReadyQueueItem (:272).
// updateMany CANNOT sort, so we find+sort+limit candidate _ids, then bulk-claim
// with a re-asserted {state:'ready'} guard (closes the select→update TOCTOU).
async function reserveReadyRows(domain, familyTargets = {}, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const claimMinutes = Math.max(Number(options.claimMinutes) || 5, 1); // G3a: caller passes explicit
  const sessionId = String(options.sessionId || "").trim();
  if (!sessionId) throw new Error("reserveReadyRows requires a sessionId");
  const extensionId = options.agentExtensionId ? String(options.agentExtensionId) : null;
  const reservedRows = [];
  const missing = {};
  // family order = rank order (green,blue,yellow,red); normalize keys through the SAME normalizer.
  for (const family of normalizeQueueFamilies(Object.keys(familyTargets))) {
    const n = Math.max(Number(familyTargets[family]) || 0, 0);
    if (n <= 0) continue;
    const familyMatch = {
      state: "ready",
      queueFamily: family,
      "metadata.appointmentId": { $in: [null, ""] }, // G-appt: appointment rows structurally excluded
      ...(domain ? { domain: normalizeDomain(domain) } : {}),
    };
    // --- one bulk claim, plus ONE same-tick re-plan retry on residual deficit ---
    let need = n;
    for (let attempt = 0; attempt < 2 && need > 0; attempt += 1) {
      const candidates = await CxDialQueue.find(familyMatch)
        .sort({ ...TOUCH_BALANCED_QUEUE_SORT })
        .limit(need)
        .select({ _id: 1 })
        .lean();
      if (candidates.length === 0) break;
      const ids = candidates.map((c) => c._id);
      const res = await CxDialQueue.updateMany(
        { _id: { $in: ids }, state: "ready" }, // re-assert ready: rows claimed between read+write won't match
        {
          $set: {
            ...buildClaimPatch(now, claimMinutes), // state:'claimed', lastClaimedAt, claimUntil
            "assignment.extensionId": extensionId,
            "assignment.assignedAt": now,
            "assignment.queueFamilySnapshot": family,
            "metadata.reservationSessionId": sessionId,
            "metadata.reservedAt": now,
            "metadata.reservationExpiresAt": new Date(now.getTime() + claimMinutes * 60 * 1000),
            "metadata.lastRingcxPublishedAt": null,
            "metadata.lastRingcxPublishedExternId": null,
          },
        },
      );
      // modifiedCount is the TRUE reserved count this round (FM-10).
      need -= res.modifiedCount || 0;
      if (res.modifiedCount === 0) break; // nothing left to win this tick
    }
    // Re-read exactly the rows this session now owns in this family.
    if (need < n) {
      const claimed = await CxDialQueue.find({
        ...(domain ? { domain: normalizeDomain(domain) } : {}),
        queueFamily: family,
        state: "claimed",
        "metadata.reservationSessionId": sessionId,
        "metadata.reservedAt": now,
      }).sort({ ...TOUCH_BALANCED_QUEUE_SORT });
      reservedRows.push(...claimed.map((d) => d.toObject()));
    }
    if (need > 0) missing[family] = need; // genuine short supply, NOT elsewhere-claim
  }
  return { reserved: reservedRows, missing };
}
```

```js
// cxQueueReservationService.js — net-new. Pure-core orchestration; I/O injected.
"use strict";
const { randomUUID } = require("crypto");

function createCxQueueReservationService({
  cxDialQueueRepository,   // reserveReadyRows, transitionQueueItemState, findActiveClaimForCase (M5)
  queueItemRepository,     // existsForLead — cross-pool interlock (M5)
  resolveQueueDialability, // injected from cxQueuePolicyService — slow-lane dialability post-filter (M4)
  logger = console,
} = {}) {
  if (!cxDialQueueRepository?.reserveReadyRows) {
    throw new Error("cxQueueReservationService requires cxDialQueueRepository.reserveReadyRows");
  }

  async function reserveFromFamilyOrder({
    domain, agentExtensionId, sessionId, familyTargets,
    totalLimit = null, claimMinutes, metadata = {},
  }) {
    if (!sessionId) throw new Error("reserveFromFamilyOrder requires a sessionId");
    // cap per-family targets at the overall deficit so we never over-reserve.
    let remaining = Number.isFinite(totalLimit) ? Math.max(Number(totalLimit), 0) : Infinity;
    const capped = {};
    for (const fam of Object.keys(familyTargets || {})) {
      if (remaining <= 0) break;
      const take = Math.min(Math.max(Number(familyTargets[fam]) || 0, 0), remaining);
      if (take > 0) { capped[fam] = take; remaining -= take; }
    }
    const { reserved: rawReserved, missing } = await cxDialQueueRepository.reserveReadyRows(domain, capped, {
      sessionId, agentExtensionId, claimMinutes, now: new Date(), metadata,
    });
    // M5 claim-time interlock runs here (see assertNotActiveInUcq, added in M5).
    return { reserved: rawReserved, missing };
  }

  // claimed -> ready, buffer-drop happens in the RAIL before this call (§4 TOCTOU).
  async function releaseReserved(rows = [], reason = "reserved-released") {
    for (const row of rows) {
      await cxDialQueueRepository.transitionQueueItemState(
        row._id,
        ["claimed"],
        {
          state: "ready", claimUntil: null,
          assignment: { extensionId: null, agentName: null, assignedAt: null, queueFamilySnapshot: null },
          "metadata.reservationSessionId": null,
          "metadata.reservedAt": null,
          "metadata.reservationExpiresAt": null,
          "metadata.lastReleasedAt": new Date(),
          "metadata.lastReleaseReason": reason,
        },
        { match: { "metadata.reservationSessionId": row?.metadata?.reservationSessionId } },
      ).catch((err) => logger.warn?.("releaseReserved miss", { id: String(row._id), err: err?.message }));
    }
  }

  return { reserveFromFamilyOrder, releaseReserved, newSessionId: () => randomUUID() };
}
module.exports = { createCxQueueReservationService };
```

**(d) Wires/Why** — Implements §2 reservation contract + the §2 bulk-claim spec (5 steps). `updateMany({_id:{$in},state:'ready'})` is atomic per-doc so `modifiedCount` is the reserved count in one round trip; the single same-tick re-plan retry distinguishes "claimed elsewhere" (FM-10, transient) from true short supply (returned in `missing`). Mirrors `buildClaimPatch` exactly so the bulk path never diverges from the single-claim path — and like that path it sets `state/claimUntil` only via the shared patch, adding `assignment.*`/reservation provenance as dotted `$set` keys (never a nested object, per the upsert clobber gotcha). `transitionQueueItemState` is a verified `findOneAndUpdate(query, {$set:update}, {new: options.returnNew})` (`:341`); the `match` object is merged into the query (`:353`), so the `releaseReserved` reservationSessionId guard is a real CAS.

**(e) Verify** — Unit: seed N+2 `ready` rows in one family, request N; assert `reserved.length===N`, all carry the `sessionId`, `state==='claimed'`, no `missing` key. Concurrency: two `reserveReadyRows` calls over the same family race for the last row → exactly one wins it (the other's `modifiedCount` drops), no double-claim. Short supply: request 5 with 2 available → `missing[family]===3`, never throws.

---

### M2 — Reaper ownership exclusion + guarded renewal + single serving-stamp

**(a) Goal** — Make the global reaper invisible to any session-held row (primary FM-1/FM-1b/FM-7 fix), add a CAS-guarded `renewClaim` heartbeat, and force the dialer's `claimed→serving` stamp into one write (§3.1/§3.2/§3.5).

**(b) Files**
- EDIT `packages/shared-repositories/src/cxDialQueueRepository.js` — extend `buildExpiredClaimRequeueQuery` (`:122`); add `renewClaim`; export both. `requeueExpiredClaims` (`:201`) inherits the change automatically (it calls `buildExpiredClaimRequeueQuery`).
- EDIT `packages/shared-services/src/cxQueueReservationService.js` — add `renewClaim` wrapper (delegates to the repo helper).
- EDIT the dialer's `claimed→serving` writer — read the reservation sessionId off the row itself (`item.metadata.reservationSessionId`), mirror the assigner shape at `cxCadenceService.js:3511`, and treat a `null` return as a race.

**(c) Snippets**

```js
// cxDialQueueRepository.js :122 — ADD the ownership + appointment $or guards INTO the existing $and
// (do NOT replace it — the servingAt / lastDialExecutionUii / disposition-hold / dial-intent guards stay).
function buildExpiredClaimRequeueQuery(now) {
  return {
    state: "claimed",
    claimUntil: { $ne: null, $lte: now }, // null claimUntil is NEVER reaped — keep
    $and: [
      { $or: [{ "metadata.servingAt": { $exists: false } }, { "metadata.servingAt": null }] },
      { $or: [{ "metadata.lastDialExecutionUii": { $exists: false } }, { "metadata.lastDialExecutionUii": null }, { "metadata.lastDialExecutionUii": "" }] },
      { $or: [{ "metadata.lastQueueAttemptHeldForDisposition": { $ne: true } }, { "metadata.lastQueueAttemptHeldForDisposition": { $exists: false } }] },
      { $or: [
        { "metadata.lastDialIntentStatus": { $exists: false } }, { "metadata.lastDialIntentStatus": null }, { "metadata.lastDialIntentStatus": "" },
        { "metadata.lastDialIntentStatus": { $in: ["relay-failed", "error", "cancelled", "unconfirmed-active-call"] } },
      ] },
      // §3.1 HARD ownership exclusion — a session-held row is invisible to the global reaper.
      { $or: [
        { "metadata.reservationSessionId": { $exists: false } },
        { "metadata.reservationSessionId": null },
        { "metadata.reservationSessionId": "" },
      ] },
      // FM-5 — appointment rows are never reaper-freed (defense-in-depth alongside the $match exclude).
      { $or: [
        { "metadata.appointmentId": { $exists: false } },
        { "metadata.appointmentId": null },
        { "metadata.appointmentId": "" },
      ] },
    ],
  };
}

// renewClaim — ONE guarded CAS per row. Re-confirms {state:'claimed', reservationSessionId} at write time.
async function renewClaim(ids = [], claimMinutes = 5, sessionId = null) {
  const now = new Date();
  const minutes = Math.max(Number(claimMinutes) || 5, 1);
  const until = new Date(now.getTime() + minutes * 60 * 1000);
  const out = [];
  for (const id of ids) {
    const updated = await CxDialQueue.findOneAndUpdate(
      { _id: id, state: "claimed", "metadata.reservationSessionId": sessionId }, // serving/other-owner ⇒ no-op
      { $set: { claimUntil: until, "metadata.reservationExpiresAt": until } },
      { new: true },
    );
    if (updated) out.push(updated._id);
  }
  return out; // renewed ids; caller drops the rest from its heartbeat set
}
```

```js
// Dialer claimed→serving — SINGLE atomic write (§3.5). servingAt set in the SAME $set as state.
// Read the owning sessionId off the ROW (do NOT depend on a separate sessionId var at this site).
const reservationSessionId = item?.metadata?.reservationSessionId;
const served = await cxDialQueueRepository.transitionQueueItemState(
  item._id,
  ["claimed"],
  { state: "serving", "metadata.servingAt": now, "metadata.lastDialExecutionUii": uii },
  { match: { "metadata.reservationSessionId": reservationSessionId }, returnNew: true },
);
if (!served) {
  // guard miss = the row was reaped/re-claimed/already serving; treat as a race, do NOT proceed to dial.
  // mirror the 'queue-assignment-race' handling at cxCadenceService.js:3535.
  return { ok: true, served: false, skipped: true, reason: "serving-stamp-race", queueItemId: item._id };
}
```

**(d) Wires/Why** — §3.1 removes the heartbeat-vs-reaper TOCTOU entirely (FM-1, FM-1b, FM-7); the reaper now only frees rows with no `reservationSessionId`. §3.2 renewal is a liveness signal, not the safety mechanism — its `{state:'claimed', reservationSessionId}` guard makes it a no-op once the row goes `serving` or another owner holds it. §3.5 single serving-stamp eliminates the serving-but-unstamped latent window. `transitionQueueItemState` returns `null` on a guard miss (no throw, verified `:358`), so the serving site MUST check the return and bail on a race — otherwise the stamp silently no-ops and the dialer proceeds to dial an un-owned row. Renewal interval MUST be `< claimMinutes` (G3a: pass `claimMinutes ≥ renewalInterval·2`).

**(e) Verify** — Seed a `claimed` row with `reservationSessionId` set + `claimUntil` in the past → `requeueExpiredClaims(now)` returns `[]` (excluded). Null the `reservationSessionId` → same call now requeues it. `renewClaim([id], 10, 'sess-A')` with the row owned by `sess-B` → returns `[]`, row untouched. Flip row to `serving`, renew → no-op. Serving-stamp with a mismatched `reservationSessionId` → `served===null`, returns `skipped:true reason:'serving-stamp-race'`, never dials.

> **Impl note (first pass, 2026-06-23 — fable-code).** Built: reaper ownership-exclusion (appended the `reservationSessionId` + `appointmentId` `$or` clauses to `buildExpiredClaimRequeueQuery`'s existing `$and` — purely additive; `$exists:false`-tolerant so current non-reserved rows are reaped exactly as before, verified by logic + the 75-test bulk-load/dial-runtime regression staying green), net-new `renewClaim` (guarded CAS) + repo export, and `renewReserved` on the service (groups ids by `reservationSessionId` so a foreign-session row can't be renewed under the wrong owner; 4 new offline tests). **Serving-stamp (§3.5) deliberately DEFERRED to M4.** The only `claimed→serving` writers today are the *shared live* cadence writers (`cxCadenceService.js:1680/1713/2479`) used by the whole CX system; no reserved row flows through them until M4 wires reserved-row dialing. Editing them now is collateral risk for zero current benefit — the guarded single-write pattern will be applied at M4's bulk reserved-row serving transition, where it actually matters. **Unverified (integration-deferred, no local Mongo):** the reaper-exclusion's live behavior and `renewClaim`'s CAS — flagged for the M8 Mongo harness. The service-level `renewReserved` orchestration is fully offline-tested.

---

### M3 — Force-complete `claimed` rows + null reservation provenance + frozen-reaper reconciler

**(a) Goal** — Close the reserved-published lifecycle: force-complete `claimed` rows past the held-for-disposition gate, null reservation provenance on complete AND reschedule, add the `listQueueItems` filter the reconciler needs, and add a crash reconciler that runs before the reaper resumes (§4; FM-8, FM-8b, FM-8c, FM-11).

**(b) Files**
- EDIT `packages/shared-services/src/cxCadenceService.js` — add the 3 reservation keys to `buildClearedDialRuntimeMetadata` (`:3684`, the ~90-key flat `$set` spread used by `completeCxQueueItem`/`rescheduleCxQueueItem` AND the balanced-load assigner at `:3526`). Reconciliation reuses `completeCxQueueItem` (`:4352`) as-is — its `fromStates` already includes `'claimed'` and it has no held-for-disposition gate. **See Wires/Why for the assigner-path consequence (FM-8c interplay).**
- EDIT `packages/shared-repositories/src/cxDialQueueRepository.js` — add a `metadataReservationSessionIdNotIn` branch to `listQueueItems` (`:384`). It does NOT exist today (verified `:384`–`:443`: only domain/caseId/state/states/excludeIds/queueFamily/assignedExtensionId/visibleExtensionId/createdAt are honored), so the reconciler's filter is silently dropped without this edit and it would scan EVERY claimed row.
- CREATE `packages/shared-services/src/cxReservationReconcilerService.js` (startup, before reaper resume).

**(c) Snippets**

```js
// cxCadenceService.js — inside buildClearedDialRuntimeMetadata (:3684), add to the returned flat $set.
// These ride along on completeCxQueueItem AND rescheduleCxQueueItem (FM-8c: a requeued 'queued'
// row must NOT keep a lease, or the M2 reaper exclusion pins a row no session owns).
'metadata.reservationSessionId': null,
'metadata.reservedAt': null,
'metadata.reservationExpiresAt': null,
```

```js
// cxDialQueueRepository.js — listQueueItems (:384). Add alongside the existing filter branches.
if (Array.isArray(filters.metadataReservationSessionIdNotIn)
    && filters.metadataReservationSessionIdNotIn.length > 0) {
  query["metadata.reservationSessionId"] = {
    $nin: filters.metadataReservationSessionIdNotIn,
    $ne: null, // a reconcile target must actually carry a (stale) sessionId
  };
}
```

```js
// cxReservationReconcilerService.js — net-new. STRICT ordering: reaper stays frozen until done (§4).
"use strict";
function createCxReservationReconcilerService({
  cxDialQueueRepository,        // listQueueItems (now w/ metadataReservationSessionIdNotIn), transitionQueueItemState
  cxCadenceService,             // completeCxQueueItem (force path, no held gate)
  cxQueueReservationService,    // releaseReserved
  terminalEvidence,             // injected: async (row) => Boolean (released-UII / outbox row exists)
  logger = console,
} = {}) {
  // call ONCE at startup BEFORE starting the reaper loop; idempotent.
  async function reconcileDanglingReservations({ activeSessionIds = [] } = {}) {
    const dangling = await cxDialQueueRepository.listQueueItems({
      states: ["claimed"],
      // only rows whose owning session is NOT a currently-live session (filter added in this milestone)
      metadataReservationSessionIdNotIn: activeSessionIds,
      limit: "all",
    });
    for (const row of dangling) {
      const sessionId = row?.metadata?.reservationSessionId;
      if (!sessionId) continue;
      // adopt via reservationSessionId-guarded CAS so a re-adopting live session (CAS loser) is never clobbered (FM-11).
      const adopted = await cxDialQueueRepository.transitionQueueItemState(
        row._id, ["claimed"],
        { "metadata.reservationReconciledAt": new Date() },
        { match: { "metadata.reservationSessionId": sessionId }, returnNew: true },
      );
      if (!adopted) continue; // a live session re-adopted it first — leave it
      if (await terminalEvidence(row)) {
        // reserved-published, never serving ⇒ force-complete (NOT handleCxTerminalCallOutcome — held gate). FM-8b.
        await cxCadenceService.completeCxQueueItem({
          queueItemId: row._id, queueOutcome: "reservation-reconciled-terminal",
          actorEmail: "system:reservation-reconciler",
        });
      } else {
        await cxQueueReservationService.releaseReserved([row], "reservation-reconciler:session-gone");
      }
    }
  }
  return { reconcileDanglingReservations };
}
module.exports = { createCxReservationReconcilerService };
```

**(d) Wires/Why** — §4 "Published → completed (force path)": a reserved row is `claimed` with empty `servingAt`, so `handleCxTerminalCallOutcome` returns `advanced:false reason:"not-held-for-disposition"` (held gate at `:2709`) — it would leak `claimed` forever now that the reaper excludes it. `completeCxQueueItem` (`:4352`) accepts `claimed` in `fromStates` and force-completes; completion drops the row from the active set so the `uq_cxdialqueue_active_action` partial index frees. The `buildClearedDialRuntimeMetadata` edit (FM-8c) ensures both complete and reschedule null the lease (reschedule lands in `queued`, promoted only by `releaseDueQueueItems`). **Assigner interplay (verified `:3526`):** `buildClearedDialRuntimeMetadata` is also spread into the balanced-load assigner's claim stamp (`fromStates:['claimed']`, reason `'new-assignment'`), so every new assignment will now also null `reservationSessionId/reservedAt/reservationExpiresAt` in the SAME `$set` — and there is no later dotted key re-setting them at that site, so the assigner path intentionally clears any reservation lease at assignment time. This is safe because `reserveReadyRows` (M1) is the ONLY writer of `reservationSessionId` and the rails never run the balanced-load assigner against a row they have reserved; document this mutual-exclusion invariant. If that ever changes, the assigner must re-set `reservationSessionId` as a dotted key AFTER the spread (later keys win in a single object literal). The reconciler's `reservationSessionId`-guarded CAS prevents clobbering a restarted session (FM-11); fresh-UUID sessions make "owning session gone" unambiguous.

**(e) Verify** — Seed a `claimed` row (servingAt empty) + a fake terminal-outbox row → `completeCxQueueItem({queueItemId})` returns `mutated:true, state:'completed'`; confirm the unique-index slot frees (insert a new active row same `domain/caseId/actionKey` succeeds). Reschedule a `claimed` row → assert `metadata.reservationSessionId===null` post-write. Assigner: claim a row via the balanced-load path → assert `reservationSessionId===null` post-assignment. listQueueItems: seed two `claimed` rows (one with sessionId in `activeSessionIds`, one not) → `metadataReservationSessionIdNotIn:[live]` returns only the stale row. Reconciler: dangling row with a live `activeSessionIds` entry → untouched; without → force-completed or released.

> **Impl note (first pass, 2026-06-23 — fable-code).** Built: 3 reservation-null keys added to `buildClearedDialRuntimeMetadata` (rides on its 5 call sites — complete/reschedule/cancel/assigner — a no-op on current rows since none carry a lease yet; the assigner↔reserve mutual-exclusion invariant is noted in-comment); `listQueueItems` `metadataReservationSessionIdNotIn` branch (additive, placed just before the cursor build); net-new `cxReservationReconcilerService` (fully injectable, 7 offline tests) using `completeCxQueueItem`'s **force path** — verified against the real code that its `fromStates` includes `'claimed'` and that `{queueItemId, queueOutcome, actorEmail}` are real option names (not guessed). Verified non-disruptive: **11/11 cadence/terminal tests + 82/82 bulk/dial regression green.** **DEFERRED:** the startup boot-wiring (freeze-reaper-before-reconcile + actually calling `reconcileDanglingReservations` at boot) — a server-boot-sequence change only relevant once reserved rows can dangle (M4+); left for the deploy-wiring step. **Unverified (integration, no local Mongo):** the `listQueueItems` filter's live behavior and the reconciler's real interaction with `completeCxQueueItem`'s `buildQueueItemMutationMatch` guard — flagged for the M8 harness.

---

### M4 — Rail wiring: thread the service, bulk `fillBuffer`, slow single (with dialability post-filter), strip simple-loop bulk-mirror

**(a) Goal** — Route all three rails through `reserveFromFamilyOrder`: bulk reserves a batch + publishes one-at-a-time (release-on-reject, buffer-drop-before-release), slow reserves `totalLimit:1` AND re-applies dialability filtering it used to get from `claimNextCxQueueItem`, and the simple-loop phone-fallback matcher is removed (§2 rail sizes; CR1/CR2). **First sub-step: thread the reservation service into each rail — none of them has it in scope today.**

**(b) Files**
- EDIT `packages/shared-services/src/cxBulkLoadRuntimeService.js` — `createCxBulkLoadRuntimeService` deps: add `reservationService` (current deps are `leadSource`/`publisher`/`queueStateAdapter`). Update every call site that constructs the bulk runtime to pass the shared `createCxQueueReservationService(...)` instance. Then rewrite `fillBuffer` (`:120`).
- EDIT `packages/shared-services/src/cxSlowLaneService.js` — this file is NOT a factory; `selectNextQueueItem` (`:605`) is a module-level function. Either (i) convert the slow lane to a factory that closes over an injected `reservationService`, or (ii) `require("./cxQueueReservationService")` + the shared repos at module scope and construct a module singleton. Use the SAME instance M5's interlock uses. Then route the non-explicit-`queueItemId` branch through `reserveFromFamilyOrder` (`totalLimit:1`) + dialability post-filter.
- EDIT `packages/shared-services/src/cxSimpleCallLoopService.js` — remove the phone `+45` tier in `scoreBulkActiveCandidate` (`:178`); rewire the `bulk-mirror` branch row sourcing in `advanceCxSimpleLoopSession` (`:1346`).

**(c) Snippets**

```js
// cxBulkLoadRuntimeService.js — fillBuffer (:120). deficit unchanged; SOURCE becomes a claim.
// NOTE: reduce(...) takes a THIRD timestamp arg now() (verified :156/:164); pass it on every call.
// Reject path reuses the EXISTING reducer event "buffer.publish_failed" with shape
// { candidate: { queueItemId }, reason } (verified cxBulkLoadStateMachine.js:159) — there is NO
// "buffer.publish_rejected" case, so do NOT invent one.
const { reserved } = await reservationService.reserveFromFamilyOrder({
  domain: state.domain,
  agentExtensionId: state.agentExtensionId,
  sessionId: state.sessionId,                 // fresh UUID per process start (§4)
  familyTargets: state.familyTargets,         // policy-driven (M7)
  totalLimit: deficit,
  claimMinutes: state.claimMinutes,           // explicit, ≥ renewalInterval·2 (G3a)
  metadata: { rail: "bulk_load" },
});
if (!reserved.length) return state;
let next = state;
// publish ONE AT A TIME in family order; reserved rows are already claimed.
for (const row of reserved) {
  const externId = `cxbl-${String(state.domain).toUpperCase()}-${row._id}`.toLowerCase();
  const pub = await publisher.publishBatchToRingcx(client, {
    campaignId: state.ringcx && state.ringcx.campaignId,
    candidates: [{ queueItemId: row._id, domain: state.domain, caseId: row.caseId, externId }],
    dialPriority: state.ringcx && state.ringcx.dialPriority,
  });
  if (pub.accepted.length) {
    if (typeof queueStateAdapter.markCandidatePublished === "function") {
      await queueStateAdapter.markCandidatePublished({
        session: state, candidate: pub.accepted[0].candidate,
        externId: pub.accepted[0].externId, campaignId: state.ringcx && state.ringcx.campaignId,
      }).catch(() => null);
    }
    next = reduce(next, {
      type: "buffer.publish_accepted",
      candidate: pub.accepted[0].candidate,
      externId: pub.accepted[0].externId,
      campaignId: state.ringcx && state.ringcx.campaignId,
    }, now());
  } else {
    // buffer-drop (publish_failed removes/accounts the candidate) BEFORE releaseReserved so no
    // renewal tick re-stamps a released row (§4 TOCTOU).
    const reason = pub.rejected[0]?.reason || "unknown";
    next = reduce(next, { type: "buffer.publish_failed", candidate: { queueItemId: row._id }, reason }, now());
    await reservationService.releaseReserved([row], `bulk-publish-rejected:${reason}`);
  }
}
return next;
```

```js
// cxSlowLaneService.js — selectNextQueueItem (:605), non-explicit branch.
// makeHttpError signature is (message, status=400, code=null) (verified :79) — there is NO slot for
// a details object, so attach `missing` after construction.
const { reserved, missing } = await reservationService.reserveFromFamilyOrder({
  domain: input.domain, agentExtensionId: agent.agentExtensionId,
  sessionId: agent.sessionId, familyTargets: input.familyTargets, totalLimit: 1,
  claimMinutes: input.claimMinutes || 10, metadata: { rail: "slow" },
});
// DIALABILITY POST-FILTER: claimNextCxQueueItem used to run resolveQueueDialability in its retry
// loop and complete/requeue policy-held rows inline. reserveReadyRows only filters state:'ready' +
// appointment exclusion, so re-apply the same check and RELEASE any non-dialable row (fail closed).
let picked = null;
for (const row of reserved) {
  const dialability = resolveQueueDialability(row); // injected from cxQueuePolicyService
  if (dialability?.dialable) { picked = row; break; }
  await reservationService.releaseReserved([row], `slow-non-dialable:${dialability?.reason || "policy-hold"}`);
}
if (!picked) {
  const err = makeHttpError("No CX queue item available (no-ready-queue-item)", 409, "no-ready-queue-item");
  err.details = { missing };
  throw err;
}
return asPlain(picked);
```

```js
// cxSimpleCallLoopService.js — scoreBulkActiveCandidate (:178). DELETE the phone tier:
//   if (phone && activeCallContainsText(call, phone)) score += 45;   // <-- remove
// findBulkCandidateForActiveCall (:192) keeps its >= 45 floor; with the +45 gone the only
// passing scores are externId(100)/queueItemId(60), and the tie-break (two externId ⇒ null) still holds.
```

**(d) Wires/Why** — §2 rail load sizes + CR1 (no rail builds membership from `listReadyQueueItems`/visibility) + CR2 (atomic `ready→claimed` before publish). **Threading the service is a hard prerequisite** — verified that none of the three rails has `reservationService` in scope today (slow lane is module-functions with a direct `claimNextCxQueueItem` import; bulk closes over `leadSource`/`publisher`/`queueStateAdapter` only), so M4 must add the dep + update construction call sites before any snippet here resolves. Bulk's `snapshotCandidates` is read-only by construction, so claim semantics MUST come from the injected reservation service — you cannot get them by editing the lead source. Publish-one-at-a-time + buffer-drop-before-`releaseReserved` closes FM-8 and the renew-vs-release TOCTOU — and it uses the REAL reducer event `buffer.publish_failed` (verified the only handled reject case at `cxBulkLoadStateMachine.js:159`; an invented `publish_rejected` would be a silent no-op leaving the row in the buffer). Slow's `claimNextCxQueueItem` did dialability filtering in its retry loop; `reserveReadyRows`' `state:'ready'` + appointment `$match` is NOT equivalent (some `ready` rows are non-dialable at claim time — that is precisely why `resolveQueueDialability` exists), so the slow lane MUST post-filter and release non-dialable reserved rows or it regresses to serving leads it used to hold. Removing the phone `+45` tier tightens the bulk active-call matcher to externId/queueItemId only.

**(e) Verify** — Bulk: with deficit 5 and 5 reserved, a publisher stub rejecting row 3 → reducer drops row 3 from the buffer via `buffer.publish_failed`, row 3 is back to `state:'ready'` with `reservationSessionId===null`, next tick re-reserves it. Slow: stub `reserved:[]` → throws a 409 with `error.code==='no-ready-queue-item'` and `error.details.missing` populated. Slow non-dialable: stub one reserved row whose `resolveQueueDialability` is `{dialable:false}` → row released back to `ready`, throws 409. Simple-loop: a RingCX active call matching only by phone no longer scores ≥45 → `findBulkCandidateForActiveCall` returns null.

> **Impl note (first pass, 2026-06-23 — fable-code). M4a (BULK rail) DONE + green; slow/simple/watch REMAIN.** Rewrote `fillBuffer` to reservation-sourced + **publish-one-at-a-time** + release-on-reject; threaded `reservationService` into `createCxBulkLoadRuntimeService` (now a required dep) + the construction (`createCxQueueReservationService({cxDialQueueRepository})`). **`familyTargets`/`claimMinutes` are computed ONCE at start** (from the agent account policy via `buildFamilyTargets`) and carried in the free-form, already-persisted `stats` — **no `cxBulkLoadStateMachine`/model change** (a deliberately minimal seam vs the doc's `state.familyTargets`). `cxBulkLoadRuntimeService.test.js` rewritten to the reservation model (13/13; 101/101 full regression). **BUG CAUGHT in the doc snippet:** its candidate `{queueItemId, domain, caseId, externId}` omits `phone`/`name`, but `cxBulkLoadRingcxPublisher.js:40/53` **drops any phone-less candidate** — a reserved row would never dial. Added `phone`+`name` (the reserved row carries them). Also added a per-row try/catch so a publish *throw* releases the claim + continues (the bare snippet doesn't). **REMAINING in M4:** slow lane (`cxSlowLaneService.selectNextQueueItem` — Codex's), the simple-loop phone-tier removal, and the watch rewrite (serving-stamp deferred from M2 + gap-tolerant `deriveReleasedCandidates`).

---

### M5 — Cross-pool interlock + disable morning-builder mirror

**(a) Goal** — DB-level interlock so a `caseId` can't be live in both `CxDialQueue` and `QueueItem` (§0/CR4/FM-2): claim-time assert not active in `QueueItem`; publish-time assert no DIFFERENT active `CxDialQueue` claim/serving row. Disable the morning-builder mirror for rail agents (FM-2b).

**(b) Files**
- EDIT `packages/shared-services/src/cxQueueReservationService.js` — add the claim-time `existsForLead` guard inside `reserveFromFamilyOrder` (drop interlocked rows after the bulk claim, release them).
- EDIT `packages/shared-repositories/src/cxDialQueueRepository.js` — add `findActiveClaimForCase(domain, caseId, excludeId)` helper (a `findOne` for a DIFFERENT claimed/serving sibling). Do NOT reuse `findActiveQueueItem` (`:142`) for this: it `findOne`s over ANY active state via `activeQueueFilter` with no `_id` exclusion and no ordering, so when the row being published is itself active it may return itself and the `_id !== item._id` guard skips the real collision.
- EDIT `packages/shared-services/src/ringcxLeadServingService.js` — `publishQueueItemToRingcx` (`:808`): insert the active-sibling assertion AFTER `queueItem` is resolved (`:813`, the `.toObject()` form) and BEFORE the `isPacingQueueEnabled()` branch (`:816`) so it applies in both UCQ and legacy modes.
- EDIT `packages/shared-services/src/cxMorningQueueBuilderService.js` — flip `CX_MORNING_QUEUE_BUILDER_MIRROR` default off (`:528`) and gate `options.mirror` (`:433`) behind `!isPacingQueueEnabled()` for rail agents. `isPacingQueueEnabled` is module-PRIVATE in `ringcxLeadServingService.js` (`:798`) and NOT exported (verified exports `:1170` = only `cancelPublishedQueueItemInRingcx`, `publishQueueItemToRingcx`); read `process.env.PACING_QUEUE_ENABLED` directly here (mirror the one-liner at `:798`) rather than importing it.

**(c) Snippets**

```js
// cxQueueReservationService.js — claim-time interlock. queueItemRepository.existsForLead(leadId)
// is the cheap indexed existence check (queueItemRepository.js:391, activeLeadFilter at :28). leadId is
// the string bridge key (the two pools share no _id). Release any interlocked row immediately.
async function assertNotActiveInUcq(rows) {
  const keep = [];
  for (const row of rows) {
    const leadId = String(row.caseId); // shared caseId/leadId string per §0
    const active = await queueItemRepository.existsForLead(leadId).catch(() => null);
    if (active) {
      await releaseReserved([row], "cross-pool-interlock:active-in-queueitem"); // fail closed
    } else {
      keep.push(row);
    }
  }
  return keep;
}
// ...inside reserveFromFamilyOrder, replace `return { reserved: rawReserved, missing }` with:
const reserved = await assertNotActiveInUcq(rawReserved);
return { reserved, missing };
```

```js
// cxDialQueueRepository.js — net-new helper. Finds a DIFFERENT active claimed/serving sibling for
// this caseId (NOT actionKey-scoped, so it catches a concurrent claim under any actionKey).
async function findActiveClaimForCase(domain, caseId, excludeId = null) {
  const query = {
    domain: normalizeDomain(domain),
    caseId: Number(caseId),
    state: { $in: ["claimed", "serving"] },
  };
  if (excludeId) query._id = { $ne: excludeId };
  return CxDialQueue.findOne(query);
}
```

```js
// ringcxLeadServingService.js — publishQueueItemToRingcx, AFTER queueItem resolution (:813),
// BEFORE the isPacingQueueEnabled branch (:816). Symmetric interlock: refuse publish if a DIFFERENT
// active CxDialQueue claim/serving row exists for this caseId.
const activeSibling = await cxDialQueueRepository
  .findActiveClaimForCase(queueItem.domain, queueItem.caseId, queueItem._id)
  .catch(() => null);
if (activeSibling) {
  return {
    ok: false, published: false, skipped: true,
    reason: "cross-pool-interlock:active-cxdialqueue-claim", queueItemId: queueItem._id,
  };
}
```

```js
// cxMorningQueueBuilderService.js — :528 normalizeBoolean default true -> false; gate the mirror.
// Read pacing flag from env directly (isPacingQueueEnabled is not exported from ringcxLeadServingService).
const pacingEnabled = ["1", "true", "yes", "on"]
  .includes(String(process.env.PACING_QUEUE_ENABLED || "").trim().toLowerCase());
const mirrorEnabled = normalizeBoolean(env.CX_MORNING_QUEUE_BUILDER_MIRROR, false) && !pacingEnabled;
// ...:433
if (options.mirror && mirrorEnabled) { result.mirror = await mirrorQueueRows(agent, options); }
```

**(d) Wires/Why** — §0 belt-and-suspenders: the flag-OFF invariant (CR4) is belt; this DB interlock is suspenders against a per-agent pacing mis-set. Claim-time uses `existsForLead` (`queueItemRepository.js:391`, `activeLeadFilter` at `:28`) — indexed, cheap, fail-closed (drop+release on existence). Publish-time uses the NEW `findActiveClaimForCase` (a `_id:{$ne}` + `state∈{claimed,serving}` `findOne`) rather than `findActiveQueueItem` — verified that `findActiveQueueItem` (`:142`) is a self-matching single-doc lookup over any active state and would let the publishing row mask its own sibling. It sits AFTER `queueItem` resolution (`:813`) and BEFORE the `isPacingQueueEnabled()` branch (`:816`) so it runs in both the UCQ-enqueue and legacy-RingCX-push branches (FM-2). Disabling the morning-builder mirror removes the worst pre-push collision (FM-2b).

**(e) Verify** — Seed a `QueueItem` active for `leadId='12345'`, reserve a `CxDialQueue` row `caseId:12345` → reserved row is released, `reserved` excludes it. Publish a row whose sibling row (same `caseId`, different `_id`) is `claimed` → `findActiveClaimForCase` returns the sibling → `skipped:true reason:'cross-pool-interlock:active-cxdialqueue-claim'`; publishing the only active row (no sibling) → not skipped. With `CX_MORNING_QUEUE_BUILDER_MIRROR` unset OR `PACING_QUEUE_ENABLED=true` → `result.mirror` undefined.

> **Impl note (first pass, 2026-06-23 — fable-code). M5 DONE.** Built: net-new `findActiveClaimForCase` (repo, `_id:{$ne}` + `state∈{claimed,serving}` `findOne`, exported); `assertNotActiveInUcq` claim-time guard in `reserveFromFamilyOrder` (drop+release on `queueItemRepository.existsForLead`); the publish-time active-sibling assertion in `publishQueueItemToRingcx` (after resolution, before the pacing branch — guards both UCQ + legacy paths); morning-builder mirror **default flipped true→false + force-off when `PACING_QUEUE_ENABLED`** (self-contained on the config line; `options.mirror` reads it). 2 new offline interlock tests (15/15 service; 113/113 regression). **ACTIVATION CAVEAT:** the **PUBLISH-time** interlock is LIVE now (uses `cxDialQueueRepository.findActiveClaimForCase` directly). The **CLAIM-time** `assertNotActiveInUcq` is currently **dormant** — it no-ops unless a `queueItemRepository` (with `existsForLead`) is injected into the reservation construction, and the bulk/slow constructions inject only `cxDialQueueRepository` today. Threading `queueItemRepository` in is the one-line activation step (left for M8b/deploy wiring; the flag-OFF belt + the live publish-time guard cover the gap until then). Mongo behavior of `findActiveClaimForCase`/`existsForLead` integration-deferred (M8).

---

### M6 — Ingestion conformance: family enum validation + atomic appointment paused-create

**(a) Goal** — Validate/re-derive `queueFamily` against the enum at the `queueCxDialRequest` ingestion path (FM-3b) and ensure the appointment row is never observably `ready` before it is pinned `paused` (G-appt / FM-5) — WITHOUT bypassing `queueCxDialRequest`'s STOP/DNC eligibility gating.

**(b) Files**
- EDIT `packages/shared-services/src/cxCadenceService.js` — in `queueCxDialRequest` (`:1935`) family resolution path, canonicalize any caller `queueFamily` through `normalizeQueueFamily` and re-derive via `resolveQueueFamilyForPayload`/`deriveQueueFamilyFromAgeDays` when `unassigned`/invalid. Helpers exist and are exported from `cxQueuePolicyService.js`: `normalizeQueueFamily` (`:436`), `deriveQueueFamilyFromAgeDays` (`:1530`); plus the in-file `resolveQueueFamilyForPayload` (`:444`). This single ingestion-path fix covers the appointment route too, because appointments create via `queueCxDialRequest` (verified `cxAppointmentService.js:266`).
- EDIT `packages/shared-services/src/cxAppointmentService.js` — `ensureAppointmentQueueItem`: KEEP the existing two-step create — `queueCxDialRequest` (`:266`, which runs `resolveCaseContactEligibility` STOP/DNC gating) followed by the `transitionQueueItemState(['queued','ready','claimed','serving','paused'], {state:'paused', ...})` (`:319`). The race window is between those two writes. Close it cheaply by passing a pre-pinned hold so the row is created already non-reservable: pass `queueTier:"later"` + a future `releaseAt` (already done, `:277`) AND a `metadata.dialabilityHoldReason:"appointment"` (already done, `:285`). Confirm `queueCxDialRequest` honors a non-null future `releaseAt` by creating the row in `queued`/`paused` (NOT `ready`) — if it can land in `ready`, add an explicit `state:"paused"` to the create payload's metadata-driven path so the create→transition gap is never a `ready` window. Do NOT swap to a bare `upsertQueueItem`: that bypasses eligibility gating (a behavior change beyond "atomic paused-create").

**(c) Snippets**

```js
// cxCadenceService.js — queueCxDialRequest family resolution. Always canonicalize/re-derive.
// normalizeQueueFamily + deriveQueueFamilyFromAgeDays are exported from cxQueuePolicyService
// (verified module.exports :1548). resolveQueueFamilyForPayload is in-file (:444).
const family = (() => {
  const fam = normalizeQueueFamily(payload.queueFamily || payload.metadata?.queueFamily);
  if (fam && fam !== "unassigned") return fam;            // stale-but-valid is trusted
  return resolveQueueFamilyForPayload(payload);           // re-derives via deriveQueueFamilyFromAgeDays
})();
```

```js
// cxAppointmentService.js — KEEP queueCxDialRequest (:266) for creation (eligibility gating preserved),
// then KEEP the transition→paused (:319). The ONLY hardening here is guaranteeing the create cannot
// surface a 'ready' row before the pause. queueCxDialRequest already gets a future releaseAt (legalDialAt)
// + dialabilityHoldReason 'appointment'; assert the created row's state is NOT 'ready':
const created = effectiveQueueItem; // from queueResult.queueItem
if (created && created.state === "ready") {
  // belt-and-suspenders: an appointment row must never be reservable pre-pause.
  await cxDialQueueRepository.transitionQueueItemState(
    created._id, ["ready"], { state: "paused" },
  );
}
// ...then the existing transitionQueueItemState(...['queued','ready','claimed','serving','paused'], {state:'paused', assignment, ...})
// at :319 finalizes the pin + assignment. Family is already enum-validated upstream in queueCxDialRequest (above).
```

**(d) Wires/Why** — §1 I1 enum validation (no row enters with a family no `familyTargets` bucket addresses → orphan). FM-3b is closed at the `queueCxDialRequest` ingestion path, which is the single funnel both direct ingestion and the appointment route (`cxAppointmentService.js:266`) pass through — so the appointment's old `input.queueFamily || 'fresh-day2to10'` passthrough (`:275`) is now re-validated centrally, and we do NOT need `normalizeQueueFamily`/`deriveQueueFamilyFromAgeDays` imported into `cxAppointmentService` (it imports only `resolveQueueDialTimeWindow`, verified `:16`) nor a non-existent `ageDays` var. G-appt: the appointment create keeps its eligibility gate and is pinned `paused` with the `ready`-guard above plus the existing `:319` transition; `reserveReadyRows`' `metadata.appointmentId` `$match` exclusion + M2 reaper appointment-exclusion are defense-in-depth so the create→pause window can never be reserved. Upsert gotcha still applies anywhere a metadata patch is needed: use dotted keys to avoid clobbering nested `metadata`.

**(e) Verify** — Ingest with `queueFamily:'banana'` → stored family is the age-derived enum value, never `'banana'`. Appointment ingest → the created row is never observably `state:'ready'` (assert it is `queued`/`paused` immediately after `queueCxDialRequest`, then `paused`+assigned after the transition); a concurrent `reserveReadyRows` over its family never claims it. Appointment ingest for a STOP/DNC case → still rejected by `queueCxDialRequest` eligibility (proving the gate was NOT bypassed).

> **Impl note (first pass, 2026-06-23 — fable-code).**
>
> **M6.1 (family enum validation) — verified already satisfied, ZERO code change.** Traced the full ingestion funnel and proved the orphan invariant is already closed, so the doc's `const family = (() => {...})()` snippet would be a *redundant re-implementation* of `resolveQueueFamilyForPayload`'s own first branch (a fable-code anti-pattern: new surface, no benefit). The proof chain:
> - `queueCxDialRequest` is the single funnel. New-row path (`cxCadenceService.js:2107`) routes the family through `resolveQueueFamilyForPayload({...payload, callPlan})`; existing-row path re-derives via `buildQueueProgressionState` (`:2028`). The appointment route (`cxAppointmentService.js:266`) passes *through* `queueCxDialRequest` (real-bucket default `'fresh-day2to10'`). The only other `upsertQueueItem` writers are the 4 materializer/backfill sites in `cxWorkspaceService.js` (`:3008/:3113/:3223/:3303`) which write **hardcoded literal real buckets** with matching `getQueueFamilySortRank`, and the smoke path (`:4248`) which routes through `normalizeCxQueueFamily` with a `fresh-day1` default. No raw/user-supplied `queueFamily` write exists.
> - The value actually *stored* is `progression.queueFamily = deriveQueueFamily(...)` (`cxLoadBalancerService.js:406`). It collapses `'unassigned'` to `fallbackFromPlan` (whose ternary ladder always lands in a real bucket) and every override branch returns an enum member — so it **can never emit `'unassigned'` or a garbage value**. `normalizeQueueFamily('banana')` → `'unassigned'` (`cxLeadServing.js:126`) → age-derivation → worst case `'fresh-day1'`. `'dead'` is the only non-targeted outcome and is intentional (never `ready`, structurally excluded from `reserveReadyRows`).
> - **Locked with a pure regression test** (`tests/cx-bulk-load/cxIngestionFamilyConformance.test.js`, 6 tests) asserting `deriveQueueFamily` never returns `'unassigned'`/garbage for any garbage/sentinel/age-band input, preserves real buckets, and keeps `'dead'`. If a future refactor reopens the orphan hole, this fails.
>
> **M6.2 (atomic appointment paused-create) — guard ADDED** in `ensureAppointmentQueueItem` (`cxAppointmentService.js`). Captured `const isNewlyCreated = !effectiveQueueItem` before the create, and after the `queueItemId` validation inserted a CAS-guarded `transitionQueueItemState(queueItemId, ['ready'], {state:'paused'})` scoped to newly-created rows (no-op when the row was created `queued` for a future `legalDialAt`, the common case, or already `paused`). It runs *before* the assignment-conflict check so a freshly-created row is pinned non-reservable as early as possible, and `:319`'s pin (fromStates includes `'paused'`) still finalizes it.
> - **Why it's hardening, not the sole defense, and not a bandaid:** the *dominant* protection already exists — `reserveReadyRows` structurally excludes appointment rows (`cxDialQueueRepository.js:348` `metadata.appointmentId: {$in:[null,""]}`), so bulk/slow rails never touch them, and the `dialabilityHoldUntil` gate blocks any premature dial via the legacy rail. But the legacy ready-claim path (`buildReadyClaimQuery`, `:58`) does **not** exclude `appointmentId` (correctly — a *fired* appointment row stays `ready`+`appointmentId` at `:768` and is dialed by exactly that rail, pinned to its booking agent at `APPOINTMENT_PRIORITY`). So the create→pause window is the one spot the legacy rail could transiently claim a not-yet-pinned appointment row; this guard closes the post-return tail of that window and makes the row self-protecting against any future ready-consumer. A blanket `appointmentId` exclusion on `buildReadyClaimQuery` was rejected — it would permanently break appointment dialing.
> - **Test deferral:** `ensureAppointmentQueueItem` is a non-exported, module-level-repo-coupled Mongo path (no DI seam, no local `mongodb-memory-server`), so the guard is **integration-test-deferred to M8**, consistent with M2 reaper-exclusion / `reserveReadyRows`. The M8 `appointmentAtomicPause` test asserts: created row never observably `ready` (legalDialAt≤now case), concurrent `reserveReadyRows` never claims it, STOP/DNC still rejected.
>
> Regression after M6: `tests/cx-bulk-load/*.test.js` 90/90, `tests/queue/*.test.js` 141/141.

---

### M7 — Policy-driven `familyTargets` + `RC_CX_RESERVE_MODE` + aged floor

**(a) Goal** — Build `familyTargets` from the existing `targetOpen` machinery, honor `RC_CX_RESERVE_MODE` (default `mix` 15/10/5/5), and enforce `RC_CX_AGED_MIN_RESERVE_PER_CYCLE` so aged is dialed not merely held (§2; FM-4b).

**(b) Files**
- CREATE `packages/shared-services/src/cxReserveModeService.js` that reads policy via `getQueueFamilyTargetOpen` (exported from `cxQueuePolicyService.js`, verified `:1563`) + the `RC_CX_*_TARGET_OPEN` env (resolved at `cxWorkspaceService.js:3698`, wrapper `resolveQueueFamilyTargetOpen :2507`) and emits the `familyTargets` map. **Env-number reader:** inline a tiny local reader — `getNonNegativeEnvNumber` is module-local to `cxWorkspaceService.js` (NOT exported, and importing it would add a heavy circular dep), and `readEnvNumber`/`readEnvBoolean` (`cxQueuePolicyService.js:168`/`:178`) are NOT in that module's `module.exports` (verified exports `:1548`–`:1597`). `RC_CX_RESERVE_MODE` is NET-NEW (no existing reader).

**(c) Snippet**

```js
// cxReserveModeService.js — build familyTargets from policy + mode. targetOpen is DEPTH, not throughput.
"use strict";
const { getQueueFamilyTargetOpen } = require("./cxQueuePolicyService");

// Local non-negative env-int reader (mirrors readEnvNumber's body; that fn is not exported).
function readEnvNonNegInt(name, fallback) {
  if (!Object.prototype.hasOwnProperty.call(process.env, name)) return fallback;
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : fallback;
}

function buildFamilyTargets({ policy, totalDeficit, env = process.env }) {
  const mode = String(env.RC_CX_RESERVE_MODE || "mix").trim().toLowerCase();
  const open = (fam) => getQueueFamilyTargetOpen(policy, fam); // :414, account-aware, 0 when disabled/ineligible
  let targets;
  if (mode === "green-first") {
    targets = { "fresh-day1": totalDeficit, "fresh-day2to10": 0, "fresh-day16to30": 0, "aged": 0 };
  } else { // mix (default)
    targets = {
      "fresh-day1": open("fresh-day1"),           // ~15
      "fresh-day2to10": open("fresh-day2to10"),   // ~10
      "fresh-day16to30": open("fresh-day16to30"), // ~5
      "aged": open("aged"),                       // ~5; aged.fillRemainder absorbs leftover deficit
    };
  }
  // Aged-throughput floor (FM-4b) — applies in BOTH modes; the only aged guarantee in green-first.
  const agedFloor = readEnvNonNegInt("RC_CX_AGED_MIN_RESERVE_PER_CYCLE", 0);
  targets.aged = Math.max(Number(targets.aged) || 0, agedFloor);
  return targets;
}
module.exports = { buildFamilyTargets };
```

**(d) Wires/Why** — §2 "Ordering is POLICY-DRIVEN": consumes the existing `targetOpen` machinery rather than inventing depth values. `mix` is the default (15/10/5/5, red funded so it can't starve, FM-4). `green-first` carries the documented no-aged-floor warning — `RC_CX_AGED_MIN_RESERVE_PER_CYCLE` is the only aged-throughput guarantee there (`targetOpen` is depth; holding red at depth 5 ≠ dialing red). Uses the exported `getQueueFamilyTargetOpen` policy-aware getter (returns 0 when disabled or fresh-ineligible). The env reader is inlined because neither `getNonNegativeEnvNumber` nor `readEnvNumber` is importable — do NOT add a require against `cxWorkspaceService` for this.

**(e) Verify** — Unset env, `mix` mode, policy with fresh/day2to10/day16to30/aged targets 15/10/5/5 → `familyTargets` equals those. `RC_CX_RESERVE_MODE=green-first` → all-green except `aged === RC_CX_AGED_MIN_RESERVE_PER_CYCLE`. Set `RC_CX_AGED_MIN_RESERVE_PER_CYCLE=3` with policy aged 0 → `targets.aged===3`.

> **Impl note (first pass, 2026-06-23 — fable-code).** Built net-new `cxReserveModeService.buildFamilyTargets({policy, totalDeficit, env})` faithful to the snippet — `mix` (default) reads `getQueueFamilyTargetOpen(policy, family)` per family; `green-first` sends the whole deficit to `fresh-day1`; the `RC_CX_AGED_MIN_RESERVE_PER_CYCLE` floor applies in both. **`env` is a parameter (default `process.env`)** so tests inject an env object — no `process.env` mutation (non-destructive). `readEnvNonNegInt` inlined per the doc (the existing readers aren't importable without a circular dep). 7 offline tests; the mix-mode test **empirically confirms the family→bucket mapping** (`fresh-day2to10`→`day2to15`, `fresh-day16to30`→`day16to30`). Exported `buildFamilyTargets` from `index.js` for M4. Pure function, no Mongo — fully verified offline.

---

### M8 — Tests + §6 air-tightness checklist mapping

**(a) Goal** — Offline tests for every new seam, mapped to the §6 boxes each milestone ticks.

**(b) Files** — CREATE under the existing test root (mirror the bulk_load rail's 54-test layout): `reserveReadyRows.test.js`, `cxQueueReservationService.test.js`, `reaperOwnershipExclusion.test.js`, `renewClaim.test.js`, `servingStampRace.test.js`, `reservationReconciler.test.js`, `listQueueItemsReservationFilter.test.js`, `crossPoolInterlock.test.js`, `findActiveClaimForCase.test.js`, `appointmentAtomicPause.test.js`, `slowLaneDialabilityPostFilter.test.js`, `bulkPublishFailedRelease.test.js`, `familyTargets.test.js`. Inject all I/O (no live Mongo where avoidable; use in-memory or stubbed repositories).

**(c) §6 checklist → milestone map**

```text
M1  ⇒ "single atomic bulk claim per family; modifiedCount = reserved count; ONE same-tick re-plan retry"
M1  ⇒ "one pool only; membership via reserveFromFamilyOrder" (with M4)
M2  ⇒ "reaper invisible to any reservationSessionId row (hard exclusion); appointment* excluded"
M2  ⇒ "claimMinutes explicit; renewed every tick via CAS guarded by {state:'claimed',reservationSessionId}; stops on terminal evidence"
M2  ⇒ "dialer sets state:'serving' AND metadata.servingAt in the SAME write; null return = race, no dial"
M3  ⇒ "released active UII ⇒ force-complete via completeCxQueueItem (held gate bypassed) for claimed rows"
M3  ⇒ "complete AND reschedule AND assigner null reservationSessionId/reservedAt/reservationExpiresAt"
M3  ⇒ "listQueueItems honors metadataReservationSessionIdNotIn; startup reaper frozen until reconciler runs; CAS-guarded; fresh UUIDs"
M4  ⇒ "reservationService threaded into all 3 rails; rails claim ready→claimed before publish"
M4  ⇒ "bulk reject ⇒ buffer.publish_failed drops candidate BEFORE releaseReserved; reduce passes now() ts"
M4  ⇒ "slow lane re-applies resolveQueueDialability + releases non-dialable; 409 via makeHttpError(msg,409,code)+err.details"
M4  ⇒ "no rail uses assignment-visibility lists as a queue builder"
M5  ⇒ "DB-level cross-pool interlock at claim (existsForLead) AND publish (findActiveClaimForCase, _id!=self) time"
M5  ⇒ "morning-builder mirror disabled for rail agents (default-off + PACING_QUEUE_ENABLED gate)"
M6  ⇒ "queueCxDialRequest enum-validates/re-derives queueFamily; appointment route inherits it (no bypass)"
M6  ⇒ "appointment never observably 'ready' pre-pause; eligibility gating preserved (queueCxDialRequest kept)"
M7  ⇒ "familyTargets resolved from policy + RC_CX_RESERVE_MODE; aged floor enforced; targetOpen=depth; env reader inlined"
```

**(d) Wires/Why** — Each test asserts the spec invariant, not the implementation: bulk-claim concurrency (FM-10), reaper exclusion (FM-1/1b/7), serving-stamp-race-bails (FM-7), force-complete frees the unique-index slot (FM-8b), reschedule/assigner null the lease (FM-8c), reconciler filter actually narrows the scan (FM-11), interlock fails closed at both ends (FM-2), sibling-aware publish interlock (FM-2 self-match), atomic paused-create with gating intact (FM-5), slow-lane dialability parity, bulk reject uses the real reducer event, policy mix (FM-4b). Keep everything default-off and offline-verified before any live toggle, per the bulk_load rail precedent.

**(e) Verify** — Full suite green + `typecheck` clean; then walk the §6 checklist box-by-box against the test names. **No live toggle until all boxes pass, and M2 MUST be deployed before M4 is toggled (non-negotiable order).**

> **Impl note (first pass, 2026-06-23 — fable-code).**
>
> **Test strategy honored the project's existing discipline.** The whole suite tests
> service-layer orchestration with INJECTED fake repos and treats the repo↔Mongo
> boundary as separately/live-verified — there is no `mongodb-memory-server` anywhere and
> no test in the tree connects to Mongo, and `cxDialQueueRepository` hard-requires
> `CxDialQueue` with no DI seam. So I did NOT add a Mongo dep (it would be the first
> Mongo-touching test in the repo, a heavy binary download, and would force a
> model-injection refactor of a core repo Codex is concurrently editing — the opposite of
> minimal). Repo-level Mongo-EXECUTION semantics stay integration-deferred, exactly as
> every prior milestone (M1/M2/M3/M5) deferred them. What IS offline-testable (pure
> functions, injected-fake services, pure query builders) is covered now.
>
> **Offline tests added/confirmed this pass** (all under `tests/cx-bulk-load/`,
> `node --test "tests/cx-bulk-load/*.test.js"` → **101/101**; `tests/queue/*.test.js` →
> **141/141**):
> - `cxQueueReservationService.test.js` (15) — reserve cap/family-order, release CAS, renew grouping, M5 claim-time interlock, fresh UUIDs.
> - `cxReservationReconcilerService.test.js` (7) — adopt→force-complete-on-evidence / else release.
> - `cxReserveModeService.test.js` (7) — `familyTargets` mix/green-first + aged floor + env reader.
> - `cxBulkLoadRuntimeService.test.js` (13) — reserve→publish-one-at-a-time, reject→`buffer.publish_failed`→releaseReserved.
> - `cxIngestionFamilyConformance.test.js` (6, NEW M6) — orphan-safety: `deriveQueueFamily` never emits `unassigned`/garbage.
> - `reaperOwnershipExclusion.test.js` (11, NEW M8) — **behavioral** M2-gate proof: a tiny Mongo-query matcher (throws on any unmodeled operator → loud fail, never silent pass) evaluates `buildExpiredClaimRequeueQuery(now)` against crafted docs; reserved / appointment / serving / mid-dial / held / unexpired / non-claimed rows are all invisible, a clean expired row and an errored-intent row are reaped. Exported the pure builder (additive) to enable it.
> - `cxClearedReservationLease.test.js` (4, NEW M8) — M3 FM-8c: `buildClearedDialRuntimeMetadata` nulls the reservation trio (+ `lastDialExecutionUii`) for every reason, with all-dotted keys (no nested-metadata clobber). Exported the pure helper (additive) to enable it.
>
> Totals: `tests/cx-bulk-load/*.test.js` → **105/105**; `tests/queue/*.test.js` → **141/141**.
>
> **§6 checklist → status map** (✅ offline-proven · 🔵 service-level offline, rail/Mongo integration-deferred · ⏳ integration-deferred, repo↔Mongo, no local harness):
>
> | §6 box (from (c)) | Status | Evidence / deferral reason |
> |---|---|---|
> | M1 atomic bulk claim; `modifiedCount`=count; one re-plan retry | ⏳ | `reserveReadyRows` `updateMany`/`modifiedCount`/retry is real-Mongo; service cap/order proven in `cxQueueReservationService` |
> | M1 one pool; membership via `reserveFromFamilyOrder` (w/ M4) | 🔵 | bulk runtime reserves-then-publishes offline; live rail membership integration |
> | **M2 reaper invisible to any `reservationSessionId` row; appointment excluded** | ✅ | `reaperOwnershipExclusion.test.js` (behavioral) |
> | M2 `claimMinutes` explicit; renewed via CAS `{state:'claimed',reservationSessionId}`; stops on terminal | 🔵 | `renewReserved` grouping/return-set proven offline; repo `renewClaim` CAS integration |
> | M2 dialer sets `state:'serving'`+`metadata.servingAt` same write; null=race | ⏳ | serving-stamp write is the deferred M4 watch rewrite + repo CAS |
> | M3 released-active ⇒ force-complete via `completeCxQueueItem` (held bypass) | ✅ | `cxReservationReconcilerService.test.js` |
> | **M3 complete/reschedule/assigner null the reservation trio** | ✅ | `cxClearedReservationLease.test.js` (the shared `buildClearedDialRuntimeMetadata` trio); `releaseReserved` trio-null also proven in `cxQueueReservationService`. Live call-site wiring stays integration |
> | M3 `listQueueItems` honors `metadataReservationSessionIdNotIn`; reaper frozen until reconciler; CAS; fresh UUIDs | 🔵 | `newSessionId` fresh-UUID proven offline; `$nin` filter + startup-freeze are repo-Mongo |
> | M4 reservationService threaded into all 3 rails; claim before publish | 🔵 | bulk offline; slow/legacy + live publish integration |
> | M4 bulk reject ⇒ `buffer.publish_failed` BEFORE releaseReserved; reduce passes `now()` | ✅ | `cxBulkLoadRuntimeService.test.js` reject-release test |
> | M4 slow lane re-applies `resolveQueueDialability`+releases; 409 via `makeHttpError`+`err.details` | ⏳ | `cxSlowLaneService` uses a module-singleton reservation (not injectable); reserve/release/409 needs Mongo |
> | M4 no rail uses assignment-visibility lists as a queue builder | ⏳ | code-review + integration (morning-builder mirror disabled, M5) |
> | M5 DB interlock at claim (`existsForLead`) AND publish (`findActiveClaimForCase`, `_id!=self`) | 🔵 | claim-time proven offline (`cxQueueReservationService`); publish-time `findActiveClaimForCase` is repo-Mongo (and dormant until `queueItemRepository` wired — M8b) |
> | M5 morning-builder mirror disabled for rail agents (default-off + `PACING_QUEUE_ENABLED` gate) | ⏳ | code edit; integration/code-review |
> | **M6 `queueCxDialRequest` enum-validates/re-derives; appointment inherits (no bypass)** | ✅ | `cxIngestionFamilyConformance.test.js` (orphan-safety proven; already-satisfied, zero change) |
> | M6 appointment never observably `ready` pre-pause; eligibility preserved | 🔵 | guard added (`ensureAppointmentQueueItem`); `appointmentAtomicPause` is the Mongo-path integration test |
> | **M7 `familyTargets` from policy + `RC_CX_RESERVE_MODE`; aged floor; `targetOpen`=depth; env reader inlined** | ✅ | `cxReserveModeService.test.js` (7) |
>
> **Honest gate read:** the three safety-critical, refactor-fragile invariants — the **M2
> reaper exclusion** (the non-negotiable deploy gate), **M3 reservation-lease-null** (FM-8c),
> and **M6 orphan-safety** — are now behaviorally locked offline, so Codex's tightening pass
> can't silently regress them.
> Everything marked ⏳/🔵 is genuine repo↔Mongo or live-rail behavior that this codebase
> has always verified at integration time; M8's remaining work is to run those named
> integration tests against a real DB before the live toggle (still gated: **M2 before M4**).

### M8b — Security, 4001 Intake, Logics Suppression, and No Agent Bleed

This addendum is the production-safety layer for the queue rebuild. The core
reservation plan is sound; the remaining risk is letting correct queue mechanics
accidentally reintroduce old side effects: source rows live-inserted onto agents,
rows bleeding between tenants/agents, or Logics/DNC/contactability state being
ignored and then re-added later by a refill.

#### Security invariants

1. **Domain is part of every identity boundary.**
   - `domain` must be present on every source-pool query, reservation, publish,
     terminal outbox row, and drain write.
   - Never match only by `caseId`; `TAG:101617` and `WYNN:101617` are different
     leads. The Mickey/Brian test proved this is not theoretical.
   - Any helper that accepts `caseId` must also accept `domain` or refuse to run.

2. **Agent ownership is a reservation proof, not a filter hint.**
   - A rail may render/publish only rows whose `assignment.extensionId`,
     `metadata.reservationSessionId`, and rail/session id all match the active
     session.
   - `visibleExtensionId`, `lastTouchedExtensionId`, old assignment visibility,
     or UI queue membership are never sufficient proof.
   - Cross-agent handoff is allowed only by explicit release back to the pool,
     then a new reservation by the next agent/session.

3. **Rail mode is part of provenance.**
   - Reservation metadata should include `metadata.reservationRail =
     legacy_fast|slow_single|bulk_load`.
   - Publish metadata should echo the same rail.
   - If a row reserved by `bulk_load` is later acted on by slow/legacy code, that
     is a hard error and must release/fail closed, not "helpfully" continue.

4. **RingCX campaign/account mapping is locked at reserve time.**
   - Reservation should stamp the resolved `rcxAccountId`, `rcxCampaignId`,
     `rcxDialGroupId`, and `routeCampaignKey` used for publish.
   - Publish must verify those fields still match the agent's configured route.
   - If the agent/domain/campaign mapping changed between reserve and publish,
     release the row with `route-changed-before-publish`; do not publish it to
     the stale campaign.

5. **Logs are audit-friendly but not PII-rich.**
   - Logs should include domain, caseId, queueItemId, family, agentExtensionId,
     sessionId, rail, and reason.
   - Logs should not include full phone, SSN, raw payload bodies, or auth tokens.
   - Use `phoneLast4` or salted phone hash where helpful.

#### 4001 inbound / new-lead contract

4001 should feed the source pool, not the active agent queues.

Current inbound shape:

- `apps/inbound-gateway/src/server.js` accepts vendor/form/LD endpoints.
- `packages/shared-services/src/inboundIntakeService.js` writes prospect/cadence
  and calls `queueCxDialRequest` for first CX contact.
- That path already looks like the correct funnel when it creates a
  pool-owned row with no assignment.

Required behavior:

1. New lead arrives on `4001`.
2. Intake normalizes domain/source/phone and performs existing validation.
3. Logics create/sync happens as it does today when required.
4. The CX dial request writes or updates a `CxDialQueue` row in `queued` or
   `ready`, with stable `metadata.actionKey`, valid `queueFamily`, and no
   `assignment.extensionId`.
5. No agent session is mutated.
6. No RingCX campaign publish is triggered by intake.
7. The next rail refill/reserve claims the row if policy says it is next.

This preserves the "new greens are first-class" behavior without shoving a new
green into the currently active agent's loaded campaign. For bulk, it means a
new green waits in the green source bucket until the next refill; for slow and
legacy it can be the next single reserved candidate.

Do not add a shortcut where 4001 calls a rail, appends to `acceptedBuffer`, or
publishes directly to RingCX. That is the exact bleed path this rewrite is meant
to remove.

#### Logics / contactability suppression

The live rail should not call Logics, but the source pool must still respect
Logics and local contactability before a row is reserved or re-added.

Use a two-layer gate:

1. **Local indexed gate at reserve time.**
   - Check local `LeadCadence`, `CaseProfile`, and queue metadata snapshots.
   - Suppress rows with local DNC/channel DNC, inactive/deal/client stop states,
     appointment hold, postdate hold, RESO-only/management-only flags, or a
     terminal-outbox row still pending/processing for the same
     `(domain, caseId)` or `queueItemId`.
   - This gate is cheap and runs before publish.

2. **Background Logics reconciliation.**
   - Hourly/nightly workers refresh case status/payment/contactability snapshots
     from Logics into local records.
   - If Logics now says the case is non-dialable, update local state and cancel
     or release any un-published reservation for that case.
   - If the row is already active/current, do not yank the call mid-flight; mark
     it `must_not_requeue` and let the terminal outbox/drain prevent re-entry.

Fail-closed rule:

- If the local contactability snapshot is missing/stale for a high-risk reason
  (DNC unknown, Logics status unknown after repeated failures, route mismatch),
  do not reserve the row into a live rail. Mark it held with a visible reason and
  let the background reconciler repair it.

DNC rule:

- DNC is not just a "do not dial now" filter. It must also prevent future pool
  re-entry until explicitly cleared by the correct business process.
- A pending/failed DNC outbox row must suppress serving just like a completed DNC
  row. Failed DNC is "blocked until fixed," not "safe to retry dialing."

#### No re-add after terminal outcome

Every source-pool build/reserve must query the terminal outbox and local cadence
state before returning candidates.

Suppress by both:

- `queueItemId`
- `(domain, caseId)`

Reason: a terminal outcome may complete one queue row while a sibling actionKey
row for the same case is still technically active. For DNC/answered/deal/client
state, case-level suppression matters more than queue-row-level suppression.

Recommended reserve filter order:

1. Gather candidate ids in family order.
2. Query terminal outbox by queueItemId and `(domain, caseId)` in one indexed
   read.
3. Query local contactability/status snapshots in one indexed read.
4. Drop blocked candidates before claim.
5. Atomically claim only the survivors.

Do not claim first and then discover the row is DNC/deal/inactive unless the
claim is immediately released with a clear reason. The cleaner implementation is
pre-filter, then claim.

#### 4001 / pool interaction with "stuff coming in"

New intake should be additive to source buckets only:

- A new green inserts into `fresh-day1` with deterministic sort priority.
- It does not disturb `current`.
- It does not mutate an existing `acceptedBuffer`.
- It does not cancel a RingCX-loaded row.
- It can be included in the next refill if it sorts into the requested family
  window.

If fresh intake comes in while a bulk refill is already publishing:

- the active refill finishes with its reserved set;
- the new intake remains `ready`;
- the next refill sees it.

Avoid trying to "top insert" mid-publish. That is how order, ownership, and UI
buffer shape become impossible to reason about.

#### Split/current-system compatibility

The existing queue logic has useful parts that should be preserved:

- cadence spacing / 3-a-day / no-contact rules
- Logics and local contactability checks
- appointment hold behavior
- source/route campaign attribution
- DNC/channel DNC suppression
- agent policy/family target configuration

What must change is where those rules are applied:

- rules build eligible pool rows;
- rails reserve rows;
- rails publish rows;
- drains write business outcomes;
- no rail directly rebuilds, enriches, or mutates source truth.

If a legacy helper both "selects eligible row" and "mutates agent queue," split
it. Keep the eligibility/filter part, discard the agent-local assignment side
effect for replacement rails.

#### Extra tests to add

- `domainIsolation.test`: same `caseId` in TAG and WYNN; reserve/publish only
  the requested domain.
- `agentBleed.test`: agent A reservation cannot be published/rendered by agent B
  and releases instead of crossing over.
- `intakeDoesNotPublish.test`: 4001-style first-contact enqueue creates
  pool-owned `ready/queued` row only; no RingCX publish and no assignment.
- `newGreenDuringBulkPublish.test`: new green arrives while bulk refill is
  publishing; it is not appended to the active buffer until a later reserve.
- `logicsSuppression.test`: local case status/DNC snapshot blocks reserve.
- `pendingDncSuppressesServing.test`: pending/failed DNC outbox row blocks
  serving by both queueItemId and `(domain,caseId)`.
- `routeChangedBeforePublish.test`: reservation route snapshot mismatches current
  agent route; row is released, not published.
- `staleContactabilityFailsClosed.test`: repeated Logics/contactability failure
  marks the row held instead of silently serving it.

### Open items to confirm before building

1. M3 assigner-path coupling: confirm the rails NEVER run the balanced-load assigner (cxCadenceService.js:3511) against a row they have reserved via reserveReadyRows. The buildClearedDialRuntimeMetadata edit nulls reservationSessionId on every new-assignment claim; this is only safe if reserve-path and assigner-path are mutually exclusive per row. If they are not, the assigner must re-set reservationSessionId as a dotted key AFTER the spread. Verify against the live assignment caller graph.
2. M6 appointment create state: I asserted-and-guarded against a 'ready' create, but did not fully trace whether queueCxDialRequest can ever land an appointment row directly in 'ready' given releaseAt=legalDialAt(future)+dialabilityHoldReason='appointment'. Confirm queueCxDialRequest's create-state logic (around :1935+) so the belt-and-suspenders ready->paused transition is either confirmed necessary or removable.
3. M4 slow-lane factory conversion: cxSlowLaneService.js is module-functions, not a factory. Decide between (i) converting to a factory vs (ii) a module-singleton require of cxQueueReservationService, and ensure the SAME reservationService instance is shared with M5's interlock. List every selectNextQueueItem caller to update if the signature changes.
4. M4 bulk construction call sites: enumerate every place createCxBulkLoadRuntimeService is constructed so the new reservationService dep is threaded everywhere (missing one leaves an undefined-symbol crash at fillBuffer).
5. RC_CX_RESERVE_MODE family-key naming: the policy buckets in code are fresh-day1 / fresh-day2to10 / fresh-day16to30 / aged. Confirm there is no fresh-day11to15 (or similar) bucket the spec's 'day2to15' shorthand implies, so buildFamilyTargets keys match getQueueFamilyTargetOpen's expected family names exactly.
6. terminalEvidence injection for the reconciler is left abstract (released-UII / outbox-row existence). Define its concrete data source (CallLog released UII vs an outbox collection) before M3 ships, since it gates force-complete vs release.

> **Impl note (first pass, 2026-06-23 — fable-code).**
>
> M8b is the production-safety LAYER and the doc itself frames most of it as "confirm
> before building." Per fable-code I built only the clean, unambiguous, additive
> foundations this pass and did NOT speculatively build the large live-integration
> features (they need design confirmation + a real DB and would be confident guesses into
> live integrations). What landed vs. what is design-gated:
>
> **Built this pass (clean/additive/fail-safe):**
> - **§3 rail provenance (reserve side):** `reserveReadyRows` now stamps
>   `metadata.reservationRail` from `options.metadata.rail` (dotted, null when absent). This
>   fixed a real silent-drop bug — the rails passed `metadata:{rail:...}` but the `$set`
>   never persisted it. Aligned the slow rail's value to the spec enum (`slow`→`slow_single`;
>   bulk already `bulk_load`). No reader exists yet, so it is inert new provenance — the
>   publish-echo + cross-rail hard-error (§3 b/c) build on it later. Forwarding locked offline
>   (`cxQueueReservationService.test.js`); the actual stamp is repo↔Mongo (integration).
> - **§5 PII-safe logs:** closed two full-phone leaks in the `[DISPTRACE]` scaffolding —
>   `ringcxDialExecutionService.js` ENTER trace now uses the in-file `maskPhoneForLog`
>   (`***1234`); the bulk `current` trace drops `phone` entirely (caseId/domain/uii are the
>   spec-allowed correlators). (`row.phone` in the publish *candidate* at
>   `cxBulkLoadRuntimeService.js:155` is dial payload, not a log — left intact.)
>
> **Open items — resolved or scoped:**
> 1. *Assigner-path coupling:* the balanced-load assigner (`cxCadenceService.js:~3511`) uses
>    `transitionQueueItemState(_id, ['claimed'], …)` and spreads `buildClearedDialRuntimeMetadata`
>    — so it shares the `claimed` state with reserved rows; mutual exclusion is **operational**
>    (legacy assigner disabled for rail agents under §0 "one pool"), not per-row by state. The
>    trio-null is safe under that invariant: legacy agents have no reservation (rails off →
>    no-op), rail agents don't run the legacy assigner. **Did NOT** add the speculative
>    "re-set reservationSessionId after the spread" — that touches the legacy assignment path
>    and needs the full caller-graph trace the item asks for, before the live toggle.
> 2. *Appointment create state:* **RESOLVED in M6.** `queueCxDialRequest` lands the appointment
>    row `queued` for a future `legalDialAt` (common case) and `ready` only when the legal window
>    is already open; the belt-and-suspenders `ready→paused` guard is confirmed necessary for the
>    immediate case and a no-op otherwise. Primary defense is `reserveReadyRows`' appointmentId
>    exclusion + the `dialabilityHoldUntil` gate.
> 3. *Slow-lane factory:* slow lane uses a module-singleton `reservationService`. The
>    "same instance as M5" concern only bites the **claim-time** interlock (`assertNotActiveInUcq`),
>    which is **dormant** until `queueItemRepository` is injected (below). The M5 **publish-time**
>    interlock lives in `ringcxLeadServingService.publishQueueItemToRingcx` (instance-independent),
>    so it already guards all three rails. Converting slow lane to a factory is deferred with the
>    interlock activation.
> 4. *Bulk construction sites:* **RESOLVED** — a single site (`cxBulkLoadRuntime.js:247`), already
>    threaded with `reservationService`. No undefined-symbol risk.
> 5. *Family-key naming:* **RESOLVED in M6/M7** — buckets are exactly `fresh-day1 / fresh-day2to10 /
>    fresh-day16to30 / aged` (+ `dead`); `day2to15`/`day2to10` are aliases (`cxLeadServing.js`);
>    there is no `fresh-day11to15`, so `buildFamilyTargets` keys match `getQueueFamilyTargetOpen`.
> 6. *terminalEvidence source:* the reconciler takes `terminalEvidence` as an injected predicate
>    (the seam exists); choosing CallLog-released-UII vs an outbox collection is a deploy-time
>    wiring decision, unchanged this pass.
>
> **Design-gated — deliberately NOT built this pass** (live-integration; needs confirmation +
> real DB; tracked as the M8b named tests): the Logics two-layer reserve-time gate + background
> reconciliation worker; the terminal-outbox pre-filter (suppress by `queueItemId` AND
> `(domain,caseId)` before claim); route-lock verify-at-publish (`route-changed-before-publish`);
> the 4001 intake "additive to source pool, never publishes/assigns" conformance audit; and
> **activation of the M5 claim-time interlock** by injecting `queueItemRepository` into the three
> reservation constructions. These are the right next build once their design questions above are
> closed and a DB harness exists — still gated **M2 before M4**, all default-off.

---

### M9 — Simplest path for code you are running now (today-only, review-only in md)

Use this as a strict simplification layer on top of the current implementation: no new architecture, no route-owned state writes, no hidden logic in command/read routes. Every file below is sliced to one job with no duplicated control branches.

### 1) Route layer stays purely adapter-level

1. [apps/control-plane/src/routes/cxSimpleLoop.js](C:/code/TagContactBridgeParalell/apps/control-plane/src/routes/cxSimpleLoop.js): keep exactly this shape (`extract + user + logger + one command call`); this file already does not own state and should not be made more clever.
2. [apps/control-plane/src/routes/cxBulkLoad.js](C:/code/TagContactBridgeParalell/apps/control-plane/src/routes/cxBulkLoad.js): keep exactly this shape (`source(req)` + command + sanitizer); no queue reconstruction or timer behavior belongs here.
3. [apps/control-plane/src/routes/cxSlowSingle.js](C:/code/TagContactBridgeParalell/apps/control-plane/src/routes/cxSlowSingle.js): keep exactly this shape; no extra branch or special-case handling beyond auth and delegation.
4. `commandsCx.js` and `readCx.js` are not part of the loop loop; leave them as-is for now so production and legacy flows stay isolated and compareable.

### 2) Shared session-model trim for non-essential fields

1. [packages/shared-models/src/CxSimpleLoopSession.js](C:/code/TagContactBridgeParalell/packages/shared-models/src/CxSimpleLoopSession.js): if `bulk-mirror` is no longer a live fallback, drop `mode` and `queue`-shape coupling from replacement-mode thinking; keep schema fields needed by legacy only.
2. [packages/shared-models/src/CxBulkLoadSession.js](C:/code/TagContactBridgeParalell/packages/shared-models/src/CxBulkLoadSession.js): keep the acceptedBuffer/current/completed split; add only stable loop-control fields if required by `deriveReleasedCandidates` (e.g., previous active IDs) and do not add UI-only metadata.

### 3) `cxSimpleCallLoopService.js` simplification pass

1. [packages/shared-services/src/cxSimpleCallLoopService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxSimpleCallLoopService.js): remove split-brain behavior by treating the service as legacy single-rail only unless explicitly running replacement mode; no `bulk-mirror`/`mode` branch in the live loop.
2. `findBulkCandidateForActiveCall`, `scoreBulkActiveCandidate`, and `normalizePhone`-tied matching should be reduced to strict match evidence only when this service is ever used in any replacement role (no +45 phone fallback, no tie-break ambiguity).
3. `listBulkActiveCallsForSession` caching in this file is legacy-specific; keep only where it shortens legacy polling, but do not reuse it as shared live evidence for replacement loops.
4. Keep reducer events as state-only transitions; remove side logic from reducers and keep all I/O in orchestrator steps.
5. In `advanceCxSimpleLoopSession`, single-path means (`session.mode === "single"` only), no mirror-publish branch from buffer, and no resume from legacy queue ordering in this path.

### 4) Bulk-load runtime simplification

1. [packages/shared-services/src/cxBulkLoadRuntimeService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadRuntimeService.js): remove `_step` debug tracing, keep only one observable trace in one place (returning terminal/disposition and state transitions).
2. split the runtime into four tiny operations in order: capture one active-call snapshot, compute transition once, publish/reduce only when needed, persist terminal outcome and clear current in one linear move.
3. `fillBuffer` should do only one job: request deficit leads, publish batch to CX, drop rejected rows through reducer, then return the updated state; no extra list transforms.
4. `watchCxBulkLoadSession` should do only one round-trip cycle per tick (snapshot -> transition -> optional refill) and return immediately when no state change.
5. `submitCxBulkLoadDisposition` should remain terminal-only: record one durable outcome and then call refill, no additional business writes or ordering decisions.

### 5) Slow-lane simplification (single call at a time)

1. [packages/shared-services/src/cxSlowLaneService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxSlowLaneService.js): keep every call path to one-at-a-time semantics (select, publish, confirm, submit, complete).
2. move all “what to do on disposition” decisions to the reducer path; terminal handler just executes request → records result → completes current.
3. preserve dialability guard as a post-claim filter right after `selectNextQueueItem`; non-dialable rows are released immediately and return `409` (`cx-slow-single-no-ready-queue-item` style path already expressed in current semantics).
4. `startCxSlowSingleCall` and `submitCxSlowSingleOutcome` should not become implicit queue builders; they should only move a preselected call through deterministic states.
5. treat RingCX and terminal flow as independent: do not add hangup fallbacks or extra RingCX branching inside state transitions.

### 6) Service exports/injection consistency

1. [packages/shared-services/src/index.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/index.js): expose changed function names only if callers use them; avoid exporting temporary refactor helpers.
2. [apps/control-plane/src/server.js](C:/code/TagContactBridgeParalell/apps/control-plane/src/server.js): no route-level rewrite logic, only wire renamed handlers with unchanged request contracts.
3. If `createCxBulkLoadRuntimeService` instances are updated, thread the same dependency object into all constructors used at startup so no `undefined` dependency crash appears in one rail only.
4. keep exports for legacy/simple/slow unchanged until the migration handoff is explicit; this is simplification, not a breaking rewrite.

### 7) What this does *not* change

1. live call outcomes, counters, and business reporting still stay in the durable outbox drain; no loop function should call metrics, no loop function should call cadence counters, and no loop function should call Logics directly.
2. active call evidence remains RingCX-only; matching uses that evidence first (externId + queueItemId), with no phone fallback in replacement mode.
3. queue builders are shared and policy-driven, but no route/controller decides which family to pull from.

### 8) Practical checklist before each file commit

1. remove one branch/path, keep one purpose.
2. remove one helper that mutates session and one helper that only forwards errors.
3. keep exactly one test-visible reducer event per transition.
4. if a function name includes both “watch” and “reconcile,” split it in markdown review and ship it as two calls in next pass.
5. if the function needs to be retried, make retry explicit at the caller, not via nested conditionals.

### 9) Next review-increment

1. Start with [packages/shared-services/src/cxSimpleCallLoopService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxSimpleCallLoopService.js) + [packages/shared-models/src/CxSimpleLoopSession.js](C:/code/TagContactBridgeParalell/packages/shared-models/src/CxSimpleLoopSession.js) because they currently carry the broadest mode coupling.
2. Then do [packages/shared-services/src/cxBulkLoadRuntimeService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadRuntimeService.js) by deleting `_step` and collapsing `fillBuffer -> watch -> submit` into one atomic function per event.
3. Then do [packages/shared-services/src/cxSlowLaneService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxSlowLaneService.js) to confirm single-lead linear state movement.
4. Close each tranche with route pass-through verification in the three route files only (no logic moved into route handlers).

## M10 — Final simplification + hardening pass before write/edit session

This is the **thinnest executable plan** for the full implementation set in this codebase, with today-only safety. No new architecture is introduced here; only extraction/cleanup to atomic, single-purpose behavior. Keep behavior stable enough for comparison against current branch.

### Scope lock

1. Legacy fast rail remains untouched as a reference behavior.
2. Slow single is the recovery rail and must stay strictly one active call at a time.
3. Bulk is the replacement harness only; it owns buffer/accept/discharge for that rail only.
4. RingCX and outbox are the only live-loop truths for current/advance behavior.
5. Every change must preserve `C++ = no new route/state coupling` and `D+S = durable terminal outcome only`.

### A. Route-layer simplification map (adapter only)

1. [apps/control-plane/src/routes/cxSimpleLoop.js](C:/code/TagContactBridgeParalell/apps/control-plane/src/routes/cxSimpleLoop.js): keep adapter shape, ensure only `source -> sanitize -> command` and no session shape edits.
2. [apps/control-plane/src/routes/cxBulkLoad.js](C:/code/TagContactBridgeParalell/apps/control-plane/src/routes/cxBulkLoad.js): keep adapter shape, do not derive queue/fill decisions from request payload.
3. [apps/control-plane/src/routes/cxSlowSingle.js](C:/code/TagContactBridgeParalell/apps/control-plane/src/routes/cxSlowSingle.js): keep adapter shape, remove any attempt to infer queue mode from route-level state.
4. [apps/control-plane/src/server.js](C:/code/TagContactBridgeParalell/apps/control-plane/src/server.js): move route mounting drift checks into startup logs only; no middleware with loop state logic.
5. [apps/control-plane/src/routes/commandsCx.js](C:/code/TagContactBridgeParalell/apps/control-plane/src/routes/commandsCx.js): remove any helper path that mutates active loop state directly when calling new rails.
6. [apps/control-plane/src/routes/readCx.js](C:/code/TagContactBridgeParalell/apps/control-plane/src/routes/readCx.js): no longer call into queue shape mutators; preserve read-only role.

### B. Shared model simplification map

1. [packages/shared-models/src/CxSimpleLoopSession.js](C:/code/TagContactBridgeParalell/packages/shared-models/src/CxSimpleLoopSession.js): remove legacy replacement mode assumptions from schema consumers, keep only fields used by each mode branch.
2. [packages/shared-models/src/CxBulkLoadSession.js](C:/code/TagContactBridgeParalell/packages/shared-models/src/CxBulkLoadSession.js): keep `acceptedBuffer`, `current`, `completed`; add `prevActiveExternIds` only if used by release diff.
3. [packages/shared-models/src/index.js](C:/code/TagContactBridgeParalell/packages/shared-models/src/index.js): export only stable models; no export churn needed for transient helper names.

### C. Legacy/slow/bulk service atomicization

#### C1) cxSimpleCallLoopService (legacy fast rail)
1. [packages/shared-services/src/cxSimpleCallLoopService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxSimpleCallLoopService.js): reduce `advanceCxSimpleLoopSession` to one live-loop path by isolating legacy and replacement behavior at the callsite, not inside the reducer.
2. [packages/shared-services/src/cxSimpleCallLoopService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxSimpleCallLoopService.js): delete `bulk-mirror` branching in this service unless a dedicated flag path is explicitly exercised by test-only code.
3. [packages/shared-services/src/ringcxActiveCallCaptureService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/ringcxActiveCallCaptureService.js): keep one canonical matcher (`externId` then `queueItemId`), no phone normalization fallback in active-loop matching.
4. [packages/shared-services/src/cxSimpleCallLoopService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxSimpleCallLoopService.js): remove scoring helpers that combine stale fields; active match should stay deterministic and narrow.
5. [packages/shared-services/src/cxSimpleCallLoopService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxSimpleCallLoopService.js): move all side effects out of reducer blocks and into top-level commands so reducers are pure state transitions.

#### C2) cxSlowLaneService (single-call conservative rail)
1. [packages/shared-services/src/cxSlowLaneService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxSlowLaneService.js): enforce one-at-a-time path through `select -> publish -> confirm -> submit -> complete`.
2. [packages/shared-services/src/cxSlowLaneService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxSlowLaneService.js): make `submitCxSlowSingleOutcome` terminal-only and avoid extra RingCX branch decisions on top of state.
3. [packages/shared-services/src/cxSlowLaneService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxSlowLaneService.js): if active call cannot be resolved from RingCX evidence, clear only `current` and leave buffer semantics unchanged.
4. [packages/shared-services/src/cxSlowLaneStateMachine.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxSlowLaneStateMachine.js): keep state transitions minimal; one event -> one transition.
5. [packages/shared-services/src/cxSlowLaneService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxSlowLaneService.js): treat "no answer" as normal release with intent capture and buffer advance, no extra call-disposition branches.

#### C3) cxBulkLoad runtime (new clean rail path)
1. [packages/shared-services/src/cxBulkLoadRuntimeService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadRuntimeService.js): keep watch loop as pure cycle:
   cycle = poll RingCX active list -> diff prior-active IDs -> one reducer transition -> optional `fillBuffer` when live count <= threshold.
2. [packages/shared-services/src/cxBulkLoadRuntimeService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadRuntimeService.js): remove `_step` logs and any transient debug branch flags; if logs are required, log only terminal event + state transition.
3. [packages/shared-services/src/cxBulkLoadRuntimeService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadRuntimeService.js): rename `fillBuffer` to "request + publish + absorb only accepted" and return a single next-state object.
4. [packages/shared-services/src/cxBulkLoadRuntimeService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadRuntimeService.js): ensure `submitCxBulkLoadDisposition` does only "append terminal outbox row + advance/disposition clear path".
5. [packages/shared-services/src/cxBulkLoadActiveCallWatcher.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadActiveCallWatcher.js): keep capture evidence narrow and timer-driven; no queue enrichment and no fallback on phone fields.
6. [packages/shared-services/src/cxBulkLoadOutcomeAdapter.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadOutcomeAdapter.js): keep button intent only (`answered`/`voicemail`/`dnc`), no direct Logics or queue completion calls.

### D. Reservation/publish hardening points (thin)

1. [packages/shared-services/src/cxBulkLoadRuntime.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadRuntime.js): pass dependency object consistently to all constructors and never inline service creation in route handlers.
2. [packages/shared-services/src/cxQueueReservationService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxQueueReservationService.js): if this file is used, enforce one write: atomic `ready -> claimed` with reservation metadata; no pre-stage in-memory row queue.
3. [packages/shared-services/src/cxBulkLoadLeadSourceService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadLeadSourceService.js): filter by outbox suppression and local contactability before claim, release quickly and transparently if blocked.
4. [packages/shared-services/src/cxBulkLoadRuntimeService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadRuntimeService.js): publish only rows that return from claim; do not publish failed-claim placeholders.
5. [packages/shared-services/src/cxBulkLoadRingcxPublisher.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadRingcxPublisher.js): keep publish contract minimal: one row input -> accepted/rejected output.

### E. UI contract cleanup

1. [apps/web-client/src/lib/api/queries/cx.ts](C:/code/TagContactBridgeParalell/apps/web-client/src/lib/api/queries/cx.ts): keep read/write query keys stable; avoid mapping queue fields into loop state on the client.
2. [apps/web-client/src/lib/api/queries/cxBulkLoad.ts](C:/code/TagContactBridgeParalell/apps/web-client/src/lib/api/queries/cxBulkLoad.ts): keep payload shape as `{sessionId, buttonLabel, disposition...}` only.
3. [apps/web-client/src/lib/api/queries/cxSlowSingle.ts](C:/code/TagContactBridgeParalell/apps/web-client/src/lib/api/queries/cxSlowSingle.ts): keep API boundaries aligned to one call action per request.
4. Remove optimistic current-call rendering assumptions; client must follow backend-provided `current` from live poll evidence only.

### F. Error-boundary hardening (minimal)

1. For every `try/catch`, fail closed with explicit `status: "failed"` and a clear `reason`, instead of swallowing and continuing.
2. Never call in-memory dedupe for terminal outcomes in live paths; unique outbox row insert is the dedupe gate.
3. On publish partial failures, remove that row from in-memory buffer and append it to completed with a non-success outcome so it cannot stick.
4. On reclaimable publish failures, release reservation once and only once per lead per tick to avoid stampede churn.
5. On RingCX poller exceptions, keep prior session and only advance `updatedAt` with the error context; avoid resetting session into fallback mode automatically.
6. Any function that can be called concurrently must use atomic repo methods (`findOneAndUpdate`) and deterministic sort, not array-first heuristics.

### G. Concrete simplification sequence (file order)

1. [packages/shared-services/src/cxSimpleCallLoopService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxSimpleCallLoopService.js) + [packages/shared-models/src/CxSimpleLoopSession.js](C:/code/TagContactBridgeParalell/packages/shared-models/src/CxSimpleLoopSession.js) to remove mode bleed.
2. [packages/shared-services/src/cxBulkLoadRuntimeService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadRuntimeService.js) with the four operation split in section C3.
3. [packages/shared-services/src/cxSlowLaneService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxSlowLaneService.js) with C2 checks.
4. [packages/shared-services/src/ringcxActiveCallCaptureService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/ringcxActiveCallCaptureService.js) to enforce stable matching signal only.
5. [apps/control-plane/src/routes/cxSimpleLoop.js](C:/code/TagContactBridgeParalell/apps/control-plane/src/routes/cxSimpleLoop.js), [apps/control-plane/src/routes/cxBulkLoad.js](C:/code/TagContactBridgeParalell/apps/control-plane/src/routes/cxBulkLoad.js), [apps/control-plane/src/routes/cxSlowSingle.js](C:/code/TagContactBridgeParalell/apps/control-plane/src/routes/cxSlowSingle.js) for adapter pass-through.
6. [apps/control-plane/src/server.js](C:/code/TagContactBridgeParalell/apps/control-plane/src/server.js) mount checks only, no state conversion in routes.

### H. Do not do list (for this step)

1. Do not mix route-layer filtering, matching, and state transitions.
2. Do not alter queue assignment side effects in service constructors.
3. Do not rely on queue display order for correctness.
4. Do not let slow mode branch on bulk behaviors and vice versa.
5. Do not suppress UI transitions based on counters, outcomes, Logics, or cadence writes.
6. Do not add new collection schemas, fields, or migration logic before this simplification pass is stable.

### I. Minimal acceptance checks after each file

1. No route file contains direct writes to session fields.
2. No service reducer contains external I/O calls.
3. One reducer event maps to one deterministic transition.
4. Every publish path uses one claim then one publish one row call and handles rejected status explicitly.
5. Every terminal event is append-only outbox first, then clear/advance state.
6. On stale active evidence between polls, released candidates are removed from buffer by diff, not by UI `current` presence.

### J. Write-session readiness gate (the minimum safe starting point)

Use this checklist before touching code. If any item fails, pause and fix the blocker before editing:

1. Confirm target branch and workspace lock.
2. Freeze scope to `M10` + `M9` deltas only; no cross-cutting feature work.
3. Confirm route pass-through behavior for [apps/control-plane/src/routes/cxSimpleLoop.js](C:/code/TagContactBridgeParalell/apps/control-plane/src/routes/cxSimpleLoop.js), [apps/control-plane/src/routes/cxBulkLoad.js](C:/code/TagContactBridgeParalell/apps/control-plane/src/routes/cxBulkLoad.js), and [apps/control-plane/src/routes/cxSlowSingle.js](C:/code/TagContactBridgeParalell/apps/control-plane/src/routes/cxSlowSingle.js).
4. Confirm no test-runner, schema migration, or outbox collection changes are required for this pass.
5. Confirm write budget is for simplification only: no behavior expansion, no fallback feature flags.

### K. Write order (single-source-of-truth sequence)

Perform exactly in this order and verify each checkpoint before the next file:

1. Session shapes: [packages/shared-models/src/CxSimpleLoopSession.js](C:/code/TagContactBridgeParalell/packages/shared-models/src/CxSimpleLoopSession.js), [packages/shared-models/src/CxBulkLoadSession.js](C:/code/TagContactBridgeParalell/packages/shared-models/src/CxBulkLoadSession.js), [packages/shared-models/src/index.js](C:/code/TagContactBridgeParalell/packages/shared-models/src/index.js).
2. Legacy/simple service split: [packages/shared-services/src/cxSimpleCallLoopService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxSimpleCallLoopService.js), [packages/shared-services/src/ringcxActiveCallCaptureService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/ringcxActiveCallCaptureService.js).
3. Bulk core: [packages/shared-services/src/cxBulkLoadRuntimeService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadRuntimeService.js), [packages/shared-services/src/cxBulkLoadActiveCallWatcher.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadActiveCallWatcher.js), [packages/shared-services/src/cxBulkLoadOutcomeAdapter.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadOutcomeAdapter.js), [packages/shared-services/src/cxQueueReservationService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxQueueReservationService.js), [packages/shared-services/src/cxBulkLoadRuntime.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadRuntime.js).
4. Slow rail simplification: [packages/shared-services/src/cxSlowLaneStateMachine.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxSlowLaneStateMachine.js), [packages/shared-services/src/cxSlowLaneService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxSlowLaneService.js), [packages/shared-services/src/cxBulkLoadRingcxPublisher.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadRingcxPublisher.js), [packages/shared-services/src/cxBulkLoadLeadSourceService.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/cxBulkLoadLeadSourceService.js).
5. Export + wiring pass: [packages/shared-services/src/index.js](C:/code/TagContactBridgeParalell/packages/shared-services/src/index.js), [apps/control-plane/src/server.js](C:/code/TagContactBridgeParalell/apps/control-plane/src/server.js).
6. UI query boundaries: [apps/web-client/src/lib/api/queries/cx.ts](C:/code/TagContactBridgeParalell/apps/web-client/src/lib/api/queries/cx.ts), [apps/web-client/src/lib/api/queries/cxBulkLoad.ts](C:/code/TagContactBridgeParalell/apps/web-client/src/lib/api/queries/cxBulkLoad.ts), [apps/web-client/src/lib/api/queries/cxSlowSingle.ts](C:/code/TagContactBridgeParalell/apps/web-client/src/lib/api/queries/cxSlowSingle.ts).
7. Route validation pass: [apps/control-plane/src/routes/cxSimpleLoop.js](C:/code/TagContactBridgeParalell/apps/control-plane/src/routes/cxSimpleLoop.js), [apps/control-plane/src/routes/cxBulkLoad.js](C:/code/TagContactBridgeParalell/apps/control-plane/src/routes/cxBulkLoad.js), [apps/control-plane/src/routes/cxSlowSingle.js](C:/code/TagContactBridgeParalell/apps/control-plane/src/routes/cxSlowSingle.js).

### L. Write-session checkpoints (hard stop if any fail)

1. A touched file has exactly one new responsibility and no mixed concerns.
2. Route handlers never mutate loop/session state.
3. `deriveReleasedCandidates` (or equivalent prior-active diff) is used in the poller path for stale-release capture.
4. Active matching is RingCX-first evidence (externId and queueItemId) with no permissive phone-only fallback.
5. `submitCxBulkLoadDisposition` and `submitCxSlowSingleOutcome` remain terminal-only.
6. No new helper is introduced without a single return shape and one-call ownership.
7. If any file shows coupling to both bulk and legacy modes, defer that file and simplify in a follow-up pass.

### M. Roll-forward safety if a file gets blocked

1. Stop after the current file.
2. Revert only that file's edits in a single local pass.
3. Keep old path active and route untouched.
4. Move on to next file in the checklist where coupling is isolated.

## M11. Post-patch hardening review before the next CX rail test

This is the Codex review pass after the first large CX rail patch landed locally. The read covered the finalization plan, the build-breakdown companion doc, the new bulk/slow/simple loop services, the reservation repository, the active-call watcher, the outcome adapter, and the route/UI wiring that selects the rails.

Verification run:

```powershell
node --test tests/cx-bulk-load/*.test.js tests/cx-dial-runtime/*.test.js tests/cx-simple-loop/*.test.js
```

Result: 126 passing tests. This is a good baseline, but it does not yet prove the bulk rail is production-safe. Several tests now encode transitional behavior that should be replaced before live toggle, especially synthetic auto-advance outcomes and in-memory outcome dedupe.

### Bug and solution in plain terms

The core bug is a state handoff problem between our app, RingCX, and Mongo. RingCX can advance to the next lead faster than our UI/request loop can safely confirm and write the terminal outcome for the prior lead. In progressive/bulk behavior, no-answer style calls may disappear from the active call list without the agent pressing one of our buttons and without our app seeing a clean "this call is done" moment. That creates three visible failures:

1. The middle panel can show the wrong lead, stale lead, or no lead while RingCX is already dialing the next person.
2. A lead can be called but not counted, because no durable terminal event was written for the released UII.
3. Queue rows can become ghost claimed/serving rows if publish, active-call capture, terminal write, or cleanup disagree about ownership.

The older fixes pulled in opposite directions. Optimistic next-dial behavior made the floor feel fast, but it could stage a lead before RingCX evidence was stable. Strict confirmation stopped the worst UI drift, but it made handoff slower and exposed "waiting" errors. Bulk loading changes the shape again: RingCX owns the active call order, so our app should stop trying to infer order from the displayed queue and instead render only the current call RingCX proves is active.

The clean solution is:

1. Reserve leads atomically from the shared `CxDialQueue` into one rail-owned session.
2. Publish accepted leads to RingCX with route/agent ownership locked.
3. Poll RingCX active calls and match only by `externId` / `queueItemId`.
4. Track the previous active identity set so calls that appear and disappear between polls still produce a terminal event.
5. Capture button intent when the agent clicks, but do not rely on the button as the only way a call becomes terminal.
6. On UII release, append one durable terminal outbox event keyed by `queueItemId + uii`.
7. Let a drain process perform the slower Mongo cadence/Logics/counter writes outside the live call loop.
8. Keep the UI in a simple transition state until RingCX proves the next current call.

In other words: RingCX tells us what call is live, our reducer records the state transition, the outbox guarantees counting later, and the UI never tries to win a race by guessing.

### What is in good shape

1. The rail split is directionally correct: legacy, slow single, and bulk load have separate routes/services/UI entry points instead of one file trying to be every mode at once.
2. The control-plane route files are thin pass-through adapters. Keep them that way.
3. `cxSlowLaneService` is already close to the conservative rail shape: select, publish, confirm, submit, complete.
4. `cxBulkLoadActiveCallWatcher` matches on RingCX evidence (`externId`, then `queueItemId`) and does not use phone-only matching. That is the right identity boundary.
5. The repository-level reservation primitives are strong in concept: `ready -> claimed`, `reservationSessionId`, `reservedAt`, `reservationExpiresAt`, and CAS renew/release operations.
6. The reaper exclusion for reservation-backed rows and appointment rows exists in `cxDialQueueRepository`; this protects the new rails from the old cleanup path.

### Must-fix gates before bulk can be trusted live

1. **Implement prior-active-set release diff in the bulk watcher.**
   The plan says the bulk poller must detect calls that appear and release between 1-second polls. The current bulk watcher only handles a current-to-next switch. Add a real `deriveReleasedCandidates({ prevActiveExternIds, activeCalls, pool })` path and persist `prevActiveExternIds` in the bulk session. This is the difference between "we saw the call as current" and "RingCX advanced too fast but we still count it."

2. **Make terminal recording outbox-first and durable.**
   `cxBulkLoadOutcomeAdapter` currently uses an in-memory `markOnce` shape in the runtime wiring, then calls `handleCxTerminalCallOutcome` directly. That is not the production contract. The live loop should append a durable terminal outbox row keyed by `queueItemId + uii`, clear/advance UI state, and let the drain perform cadence/Logics writes. If the process dies after intent capture, the event must still drain later.

3. **Fix terminal idempotency key shape.**
   The finalization plan says `key: ${queueItemId}:${uii}`. The current adapter uses `sessionId:queueItemId:eventType`. That can suppress a legitimate second call to the same queue item inside one session, and it does not line up with UII as the call identity. Use `queueItemId:uii` when UII exists, with a narrow fallback only for no-UII terminal events.

4. **Bulk runtime must not swallow state-write failures.**
   `markCandidatePublished`, `markCandidateServing`, and terminal outcome writes are currently caught in places where the session can continue as if the write succeeded. For the production rail, a failed serving stamp or terminal outbox insert must fail closed or at least hold the UI in a retryable state. Do not promote a lead to current if the Mongo ownership/write proof failed.

5. **Reservation ownership guards need to be enforced in the bulk state adapter.**
   Bulk publish/serving writes currently allow broad state transitions and stamp `metadata.bulkLoadSessionId`. Production writes must be guarded by `state: "claimed"` and `metadata.reservationSessionId === sessionId`. The old `bulkLoadSessionId` may remain as debug metadata, but it cannot be the ownership lock.

6. **Bulk must inject and enforce the active UCQ interlock.**
   `cxQueueReservationService` can check `queueItemRepository.existsForLead`, but the current bulk runtime constructs it with only `cxDialQueueRepository`, making that interlock dormant. Either wire `queueItemRepository` everywhere this service is used by a live rail, or make the service fail closed when the interlock dependency is missing outside tests.

7. **Bulk publisher needs the same route-lock protection as the legacy publisher.**
   The bulk path bypasses `ringcxLeadServingService.publishQueueItemToRingcx`, where route matching and active sibling checks already exist. Add an equivalent route-lock check before `cxBulkLoadRingcxPublisher` sends a row, or adapt the existing publisher so both rails share the same safety gate. A row reserved for one campaign/agent must not be publishable to another route.

8. **Align target buffer and refill math with the canonical 35 shape.**
   The canonical bulk target is 35 with a 15/10/5/5 mix. Current defaults are 30 in bulk runtime/service, and refill uses the original family targets against the refill deficit. With a deficit of 30, that can reserve 15 green, 10 blue, 5 yellow, 0 red. Refill should calculate family deficits from the current live buffer composition, not reuse the session-start targets blindly.

9. **Remove synthetic terminal outcomes from the bulk state machine.**
   `cx-auto-advanced` and `auto_advanced` are useful debugging labels, but they should not become cadence outcomes. If no button intent exists when a UII disappears, write the terminal event as `did_not_connect` with `source: "active-call-release"` and keep the debug reason separate.

10. **Kill/reset must release reservations, not just cancel RingCX rows.**
   `killCxBulkLoadSession` needs a deterministic cleanup path: cancel unserved RingCX rows where possible, release all reserved-but-not-current rows, terminalize or quarantine the current row, and record what could not be cleaned. A reset that leaves claimed reservation rows behind will create tomorrow's ghosts.

11. **Finish deleting or isolating the old `bulk-mirror` simple-loop path.**
   `cxSimpleCallLoopService` and the legacy CX workspace still expose `bulk-mirror` branches. If this is not the new bulk rail, it should be removed from production UI paths or proven test-only. Otherwise there are two different "bulk" implementations with similar names and different guarantees.

### Simplification notes for the next edit session

1. Remove unused dependencies from `cxBulkLoadRuntimeService` and `cxBulkLoadRuntime` after the reservation path is authoritative. `leadSource` and `listReadyQueueItems` are old-reader artifacts if the rail only reserves from `CxDialQueue`.
2. Replace `[DISPTRACE]` console logs with one structured transition log behind a verbose flag, or remove them before live. Unit tests are already noisy because these logs are unconditional.
3. Keep one operation per helper:
   `reserveRows`, `publishReservedRow`, `observeActiveCalls`, `captureIntent`, `appendTerminalOutbox`, `drainTerminalOutbox`, `releaseReservation`.
4. Do not let reducers perform I/O. Reducers should only accept events and return state.
5. Keep Logics enrichment out of the live loop. Side panels may load Logics data; middle current-call identity must come from RingCX evidence and the reserved queue row.
6. Use the same terminal event object across all rails:

```js
{
  queueItemId,
  uii,
  agentExtensionId,
  buttonIntent,      // answered | voicemail | dnc | null
  outcomeBucket,     // answered | voicemail | dnc | did_not_connect
  source,            // button | active-call-release | manual-reset
  observedAt,
  rail,
  sessionId
}
```

7. The slow rail and bulk rail can share pure helpers only. They should not share orchestration services. Sharing the terminal event shape is good; sharing a "do everything" state service is how the old loop became hard to reason about.

### Tests to add before the next live trial

1. Active diff catches a call that appeared in `prevActiveExternIds`, is absent on the next poll, and was never promoted to UI `current`.
2. Active switch with no button intent writes one durable terminal event as `did_not_connect`, not `cx-auto-advanced`.
3. Terminal outbox idempotency allows two different UIIs for the same queue item and blocks only exact duplicate `queueItemId + uii`.
4. Terminal outbox insert failure does not clear `current` or remove the candidate from the buffer.
5. Bulk runtime constructor test proves `queueItemRepository` is wired into `createCxQueueReservationService` for live rails.
6. `markCandidatePublished` and `markCandidateServing` no-op when `reservationSessionId` does not match the active session.
7. Route-lock mismatch releases/quarantines the reserved row and never calls RingCX publish.
8. Refill at `liveSlots <= 5` requests the correct 30-row refill while preserving the 15/10/5/5 family target over the resulting buffer.
9. Refill cannot starve aged/red rows when red target is available.
10. `killCxBulkLoadSession` releases all reserved buffer rows and reports any RingCX cancel failures.
11. `cxSimpleCallLoopService` cannot create a `bulk-mirror` session from production UI routes after the real bulk rail is selected.
12. Slow lane terminal submit preserves strict confirmation and returns a retryable state when RingCX terminal disposition is not yet accepted.
13. `classifyCxTerminalOutcome` accepts only the intended trusted manual outcomes for `cx-bulk-load` and keeps "no voicemail box" out of the voicemail fast lane.

### Recommended order from here

1. Lock in the durable terminal outbox shape first. Do not tune UI or refill until the release/counting write path is dependable.
2. Add prior-active-set release diff and tests next. This is the core of making bulk safe when RingCX auto-advances faster than the UI.
3. Harden reservation ownership and route-lock checks before any live bulk traffic.
4. Fix refill target math and default target size.
5. Remove old `bulk-mirror` exposure from production UI and simple-loop code.
6. Only then run the next local test: 6 initial leads, cross threshold, refill 30, verify UI current follows RingCX active calls and terminal outbox receives one event per released UII.

### Production-readiness definition for this rail

Bulk is ready for a real floor pilot only when these are all true:

1. Every visible current call has a RingCX evidence match by externId or queueItemId.
2. Every released UII creates exactly one durable terminal event.
3. No terminal event depends on a Logics call, cadence counter update, or summary write in the live loop.
4. All reserved rows are either published, released, completed, or quarantined with a reason.
5. Refill keeps the queue full without changing agent ownership or route assignment.
6. Turning the rail off leaves no claimed reservation rows behind.
7. Legacy/slow mode can still run without reading bulk session state.

---

## M11 — Resolution (2026-06-23, fable-code; all 11 gates fixed + tested)

Each gate was verified against the REAL code before fixing (verify-don't-trust caught several
Codex misattributions, noted inline). Offline regression after the pass: `tests/cx-bulk-load`
**125/125**, plus queue 141 / cadence 6 / cx-simple-loop 12 / cx-dial-runtime 8 /
cx-call-state-guard 58 / cx-morning-prep 24 / cx-handoff 13 — **387 green, 0 fail**.

| # | Gate | Fix | Test |
|---|------|-----|------|
| 1 | Release-diff watcher | New pure `deriveReleasedCandidates` + `prevActiveExternIds` model field + `buffer.released` reducer event; watch diffs prior poll's active set and counts (`did_not_connect`/`active-call-release`) + drops any buffer lead RingCX dialed+released between polls; no-op tick now persists when the diff is dirty | watcher pure (3) + wired (1) |
| 2 | Durable terminal outbox | NEW `CxTerminalOutbox` model (unique `idemKey`) + `cxTerminalOutboxRepository` (insert-once/list/markDrained/markFailed) + pure `cxTerminalOutboxDrain`; runtime `recordCadenceEvent` now persists the outbox row BEFORE the cadence write (insert-once null ⇒ no double-dispatch) and the drain replays pending rows off the live loop | drain pure (4); Mongo insert-once/crash-recovery **integration-deferred** (no local Mongo) |
| 3 | Idempotency key | `makeOutcomeIdemKey` → `queueItemId:uii` (no-UII fallback); threaded `candidate.uii` | adapter (2) |
| 4 | Swallowed state-writes | Runtime gates `publish_accepted`/`current.matched` on a TRUTHY stamp result (serving stamp reordered BEFORE state mutate); a miss releases/skips and retries — never a ghost `current`. (Codex was wrong that the terminal write is swallowed; only publish/serving stamps were.) | service (2) |
| 5 | Ownership guards | Stamp CASes (in `cxBulkLoadRuntime.js`, NOT the state machine) narrowed to `[claimed]`/`[claimed,serving]` + `{match:{reservationSessionId}}`; `bulkLoadSessionId` is debug-only | service (2, shared with 4) |
| 6 | Interlock dormant | Injected `queueItemRepository` into both rails' reservation construction → M5 claim-time `existsForLead` interlock LIVE | covered by existing reservation interlock tests |
| 7 | Bulk route-lock | Per-row campaign check (`row.rcxCampaignId` vs session) ⇒ release `route-changed-before-publish`; cross-pool sibling guard (`findActiveSibling`→`findActiveClaimForCase`) ⇒ release before publish | service (2) |
| 8 | Target 35 + refill math | Default `30`→`35`; new pure `familyRefillTargets` reserves residual per-family deficits from the LIVE buffer (green-full refills red, no aged starvation); `queueFamily` rides the candidate | service (3) |
| 9 | Synthetic outcomes | Two literals fixed: watcher `cx-auto-advanced`→`did_not_connect` (+`previousReason` debug), state-machine default `auto_advanced`→`did_not_connect`, runtime `source`→`active-call-release` | watcher + service (updated 2) |
| 10 | Kill leaks reservations | `killCxBulkLoadSession` releases every buffered reserved row (reconstructs the `{_id,reservationSessionId}` shape) + terminalizes the in-flight `current` (`manual-reset`) — closes the FM-8 reaper-excluded ghost leak | service (2) |
| 11 | bulk-mirror UI | Flipped the flag-gated simple-loop panel default `bulk-mirror`→`single` + removed the selectable option (both CXWorkspace + CXWorkspaceBulkLoad); web-client typecheck clean. Service-side branch removal is the documented follow-up | typecheck |

**Still integration-deferred (no local Mongo, consistent with the whole rail):** gate 2's outbox
Mongo insert-once dedup + crash-recovery drain (the pure drain logic IS tested); the repo-level
CAS/match execution for gates 5/7/10 (the service orchestration is tested with fakes). These run
against a real DB before the live toggle, still gated **M2-before-M4**, all default-off.

**Follow-ups (named, not blocking):** drop the now-dead `bulk-mirror` branch + helpers from
`cxSimpleCallLoopService`; schedule the `cxTerminalOutboxDrain` on a worker tick; narrow the
`"single" | "bulk-mirror"` UI union once the service branch is gone.
