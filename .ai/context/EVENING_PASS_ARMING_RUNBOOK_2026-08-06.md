# Evening pass — arming runbook

Date: 2026-08-06. Covers the four tasks added by E7–E9 of
`PATCH_WORK_ORDER_2026-08-06.md`. E10 was a deletion and has nothing to arm.

```
⟳ STATUS
────────────────────────────────────────────────────────────────────
NOTHING HERE HAS BEEN ARMED, and nothing can be yet — see §0.
All four flags are UNSET. Each one below is a separate decision that
belongs to Mickey, on the live host, not to a commit on this branch.
────────────────────────────────────────────────────────────────────
```

---

## §0. Why E11 cannot run today

E11 says *"arm E7–E10 one at a time, each after its own observed dark cycle."*
Both halves of that are currently unmet.

1. **There has been no dark cycle, because the code has never shipped.**
   `jira/hourly-migration` extends `cleaned-metrics`, which has never been
   deployed. The tasks exist only here. There is no observed pass to read.
2. **Three hard blockers survive** from the E7/E8 reviews (§3 below). Two of
   them corrupt data or stall the night when armed, and neither is fixable
   from the task — both need a change inside the underlying service.

There is also a standing unknown that gates everything: **which host actually
runs `nightlyHygieneRuntime` is unverified.** This box's `.env` demonstrably
does not govern the live stack — NCOA ran in production on a day this box had
`NCOA_MAILBOX_ENABLED=false`. Setting a flag here proves nothing about the live
pass.

So the deliverable for E11 is this runbook, not a flag flip.

---

## §1. Prerequisites, in order

Each must be true before ANY flag below is set.

- **P1. The branch is deployed** to whatever host runs the control plane, and
  the deploy landed **between nights, not mid-pass.** The nightly cursor
  (`nightlyHygieneNextTaskIndex`) is a positional array index, and E7/E8 both
  inserted tasks into the middle of that array. A pass half-finished under the
  old array resumes at the wrong chore under the new one.
- **P2. `NIGHTLY_HYGIENE_ENABLED=true` on that host**, and one full pass has
  been observed. Every task's `plan()` runs whether or not the task is armed,
  so a dark pass produces the evidence the rest of this runbook reads.
- **P3. The dark pass completed within its lease.** `HYGIENE_CLAIM_LEASE_MS` is
  45 minutes for the WHOLE pass, now shared by 15 tasks. If the dark pass is
  already close to that, arming anything makes it worse — arming adds `apply()`
  on top of the `plan()` you just timed.

**Read the dark pass like this.** The runtime's `getState()` carries
`lastResults`, one row per task with `summary` (from `describe`) and `planned`.
The four rows to find:

| task key | a healthy dark row looks like |
|---|---|
| `session-reconcile` | `THE SESSION FEED IS DEAD — nothing written since 2026-07-16` |
| `payment-reconcile` | `up to 500 case(s) per domain across TAG, WYNN, AMITY` |
| `payment-fields-sync` | `up to 500 case(s) per domain … 26h lookback, 30d stale check` |
| `call-log-hygiene-evening` | `~8h since 19:00Z: N call(s) [TAG …in/…out · WYNN …]` |

**The one dark row that carries real information** is
`call-log-hygiene-evening`. Its count is a live measurement, and a **non-zero**
count is the proof that the widened window sees PhoneBurner where the old
65-minute window saw nothing. If that row reads `0 call(s)`, stop — the premise
of E8 did not hold on the live host and arming it will do nothing.

Anything reading `COULD NOT COUNT` is a blocker in itself: that is a task that
could not see its own input, and it must not be armed until it can.

---

## §2. The order, and why

Arm ONE per night. Never two. The point of one-at-a-time is that when the pass
gets slower or a number moves, you know which flag did it.

### Stage 1 — `NIGHTLY_PAYMENT_RECONCILE_ENABLED=true`

**Why first.** It is the only one of the four with real value, a bounded cost,
and no unresolved blocker. Its retry handler got a claimer in the same commit
that created it, so failures land in the durable queue and drain within the
hour instead of sitting `pending` forever.

**What it does when armed.** Up to 500 cases per domain, serial Logics pulls,
writing PaymentLedger rows Logics has that we do not. ~1,500 round-trips.

**Watch:**
- Pass duration. If the whole pass approaches 45 minutes, lower
  `NIGHTLY_PAYMENT_RECONCILE_MAX_CASES` — do not raise it.
- `applied.capSaturated`. A domain that fills its cap means the wheel is
  bounded, and it takes `profiles / 500` nights to complete one rotation. TAG
  has ~93,000 profiles, so expect saturation and decide whether that rate is
  acceptable rather than being surprised by it.
- `applied.written` (new ledger rows) and `applied.flaggedFailures`.

**Stop if:** the pass exceeds its lease, or `failed` is non-zero on more than
one domain for two nights running.

**Rollback:** unset the flag. Nothing it writes needs undoing — ledger upserts
are keyed on `casePaymentId` and are idempotent.

### Stage 2 — `NIGHTLY_CALL_LOG_HYGIENE_ENABLED=true`

**Blocked until §3-B is resolved.** This is the highest-value flag — it is what
makes the only live call feed visible at all, and it restarts the native sweep
that has written nothing since 2026-08-03 — but it is also the one most likely
to blow the lease, and blowing the lease abandons every remaining task for the
night.

**Watch:** pass duration above all. Then `applied.nativeInserted` (the `ex` feed
coming back), `applied.truncatedDomains` (rows the 500-row preview clamp never
reached), and `applied.scored` / `applied.archived`.

**Stop if:** the pass duration jumps by more than ~10 minutes, or
`truncatedDomains` is non-empty every night — that means the half-day window is
too wide for the preview lane and the split needs a third pass, not a bigger cap.

### Stage 3 — `NIGHTLY_SESSION_RECONCILE_ENABLED=true`

**Do not arm while the feed is dead.** It would be harmless (the task plans 0
and never applies) and equally pointless. Arm it only if two things become true:
the telephony-session writer in `ringcentral-cx` is fixed AND §3-C is resolved.
Arming it with a live feed and an unreachable 429 back-off risks opening a
process-wide RC circuit that fails every later task in the pass.

### Stage 4 — `NIGHTLY_PAYMENT_FIELDS_SYNC_ENABLED=true`

**Hard blocked. See §3-A.** Do not set this flag until the service stops writing
`paymentReconcile.lastCheckedAt`. Arming it corrupts the ordering that Stage 1
depends on, and the damage is cumulative and silent.

---

## §3. The blockers, and what "resolved" means

### A. fields-sync stamps a checkpoint it did not earn *(critical)*

`caseProfilePaymentSyncService` writes `paymentReconcile.lastCheckedAt` on every
case it touches — **including the no-drift path, which makes no Logics call at
all**. `paymentReconcileService` selects candidates on that same field,
oldest-first. So an armed fields-sync stamps "Logics has been asked" onto
hundreds of cases Logics was never asked about, and pushes them to the back of a
~93,000-deep wheel.

Widening `staleCheckMs` to 30 days shrinks the blast radius but does not close
it: the `lastCheckedAt: null` clause still matches every never-stamped profile,
so the first armed nights are degenerate regardless.

**Resolved when:** fields-sync writes its own checkpoint field instead of
reconcile's, *and* the candidate query has an ordered cursor so the slice
advances instead of re-reading the same head-500 ids.

### B. Nothing bounds a task's wall clock *(high)*

No timeout wraps `task.plan()` or `task.apply()`, and the 45-minute lease is
only consulted at claim time. When a pass overruns, `advanceNightlyHygiene`
stops matching, `cursorLost()` throws, and **every remaining task is abandoned
for the night**. An ordinary failure is worse in a different way: the task
re-runs from the top up to `MAX_TASK_ATTEMPTS`, i.e. three full bursts.

**Resolved when:** either a per-task timeout exists, or Stage 1 has run enough
nights to show the pass has ≥15 minutes of headroom.

### C. The RC 429 back-off branch is unreachable *(medium — only if the feed revives)*

`fetchCallRecordWithRetry` is called with `maxRetries: 1`, which makes
`attempt < maxRetries` false on the only attempt, so the "sleep 60s and retry"
branch can never run. The first 429 throws AND opens a process-wide circuit in
the shared RC client.

**Resolved when:** the reconcile call passes `maxRetries >= 2` with real pacing.

### D. Two live admin routes bypass all of this *(medium)*

`POST /api/hygiene/hourly-sweep/run` defaults `scheduledPhase` **true**, and
`POST /api/hygiene/hourly-call-log/run` calls the hygiene service directly. Both
are auth'd + admin-gated, but neither honours the nightly flags. Anyone hitting
them runs the work regardless of what this runbook says.

### E. The preview lane's output is discarded *(high, cost only)*

`operationsBySession` is read in exactly one place — inside the legacy-mirror
loop, which is empty because that feed died in May and is off by env anyway. Both
preview calls still pay full external cost. This wastes money rather than
breaking anything, which is why it does not block Stage 2 outright, but it should
be settled before the cost recurs nightly.

---

## §4. Not part of this runbook, but blocking the same outcome

**The EOD recording archive is armed and deadlocked.** It has archived nothing
since 2026-08-03T14:13Z. Its idle gate waits for three `processing` counters to
reach zero; 27 rows have been stuck since July and May, so every run polls 12
hours and then throws. Clearing those rows (or making the gate ignore rows older
than N hours) is independent of every flag above.

**The 2026-08-03 cluster.** Attribution-reconcile last ran 14:00Z, CallLog
`platform:"ex"` last wrote 14:04Z, the EOD archive last uploaded 14:13Z — while
the PhoneBurner projection is still running. Consistent with one process
stopping that afternoon. Recorded as an observation, **not** a diagnosis: the
standing rule is never to call something down without checking newest writes per
model, and that per-model check is what produced this list rather than a
conclusion drawn from it.
