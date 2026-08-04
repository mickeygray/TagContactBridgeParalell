# The daily entry — clean implementation plan

Date: 2026-08-04
Status: PLAN. Patch is held; nothing here is deployed.
Supersedes the piecemeal approach taken earlier today (see "What changes" below).

---

## The shape

Mickey, 2026-08-04: *"group like services so that they save to sections of the
same collection entry at once — spend sync does spend, logics activity does
statuses and financial, call log does calls, then create an entry for the day."*

```
   19:50, ONE PASS
   ├─ spend sync       ──→  spend section
   ├─ logics activity  ──→  status + financial section
   ├─ call index       ──→  calls section        (+ the links collection)
   │
   ├─ CREATE THE DAY'S ENTRY  ← one write, all sections
   └─ send the email          ← from the same gather
```

Each service **returns** its section. It does not write. One writer assembles
the day and stores it once.

## Why assemble-then-write, not attach-as-you-go

This is the correction to what was built earlier today, and it is worth stating
plainly because the piecemeal version looked fine and was not.

`attachDailyCallFacts` and `attachDailyActivityFacts` both **require the day's
entry to already exist** — they `findOne({dateKey})` and return `missing-day` if
it does not. But the entry is created by the report path, which runs at the END
of the pass. So a section written before the report would silently return
`missing-day` and be lost. It would look like it worked: no error, no throw, a
tidy status string.

Assembling first removes the ordering hazard entirely rather than documenting it.
There is no window in which a section can be written to a day that does not
exist.

## The entry

`DailyReportFact`, one document per `dateKey` (unique index).

| Section | Written by | Contents |
| --- | --- | --- |
| `facts.spend` | spend sync | total, LD + lead count, mail + pieces, BCD + call count |
| `facts.activity` | logics activity | rows scanned, notice uploads, suspended flips, **DNC and post-dates from the canonical feed** |
| `facts.financial` | logics activity | the money side of the day |
| `facts.calls` | call index | counts by provider and significance, longest, total talk |
| `facts.bySource` | report gather | per-source attribution |
| `facts.byAgent` | report gather | per-officer |
| `facts.statusMovement` | report gather | status transitions |

`coverage` stays what it is: the rollup sections plus the call projection. A
section arriving does not change a day's trustworthiness.

---

## Work, in order

### 1. Turn the three services into section producers

Each already computes its numbers. None should write.

- **spend sync** — already rides along as `report.spend`. Extract the section
  builder so it is callable without composing a report.
- **logics activity** — `processed` is the accurate day (rows scanned, uploads,
  suspended, DNC, post-date). Return it as a section instead of calling
  `attachDailyActivityFacts`.
- **call index** — `summary.callFacts` is already the right shape. Return it
  instead of calling `attachDailyCallFacts`.

**Delete both attach functions once nothing calls them.** They only exist to
patch a day that already exists, which is the pattern being removed.

### 2. One writer assembles the day

`writeDailySnapshot` grows from "build from the report" to "build from the report
**plus** the sections handed to it". Still one write, still keyed on
`range.from`, still only for a delivered email.

An absent section is `null`, not `{}`. A service that did not run and a service
that found nothing are different days, and the reader must be able to tell.

### 3. RingCentral links

Nothing new to build. The pieces exist:

- Provider resolution works — `recordingArchive.provider`, verified against 1,962
  RC rows over 90 days.
- The forwarder exists, is configured, and enforces its own HMAC.
- The nginx bypass is written (`d3c528c`), not applied.

What remains is two operator steps, in this order:

1. Apply the nginx change so a signed link reaches the forwarder.
2. Confirm one RC link plays. **Until it does, the mint-on-read path is
   unproven** — every RC recording still has a Drive copy, so nothing has ever
   exercised it.

Only then does retiring the Drive dump become safe. Mickey: RC recordings are
*"a perk, not a feature"* — this stays behind the financial work.

### 4. Arm the pass

One flag at a time, each with an observed night, each retiring its old timer in
the **same** change:

| Flag | Retires |
| --- | --- |
| `NIGHTLY_SPEND_SYNC_ENABLED` | the 19:45 spendSync timer |
| `CALL_RECORDING_INDEX_ENABLED` | the 23:00 EOD archive |
| `NIGHTLY_ACTIVITY_REVIEW_ENABLED` | the 20:00 review runtime — **only if the notice email is still wanted** |

---

## Already done and holding

- One gather feeds the email and the snapshot (`60e1fc4`).
- Costs by source stored (`93d8ffb`).
- The links collection is real and idempotent — 1,586 rows, re-runs do not
  duplicate (`ba1a7b9`).
- A failing chore no longer costs the night (`96c1d8e`).
- Activity's day is recorded rather than spent on an email (`48b78fe`) — to be
  reshaped into a section producer by step 1.

## Standing rules this plan obeys

- **Unknown is null, never zero.** A count that could not be computed is not a
  quiet day.
- **Persist events, not state.** A finished day's counts are events; balances and
  current statuses are pulled live.
- **The email is a refinement; the entry has everything.** Two bars — the email's
  ten minutes for "worth hearing", the index's five for "notable".
- **One gather.** The activities run once and everything downstream reads that.
- **Anything that could dial someone who asked us to stop is complete or
  untouched.** No partial state there, ever.
