# Mini work order — merge the two gathers into one pipe

Date opened: 2026-08-04
Scope: **one change.** Nothing else belongs in this patch.
Precondition: `815435f` is deployed and one night has been observed.
Companion to: NIGHT_CLEANUP_BUILD_GUIDE_2026-08-04.md

---

## The goal, in one sentence

The email and the snapshot are built from **one** gather instead of two.

## Where it stands after `815435f`

```
reportScheduleRuntime
  ├─ runDefinition(def)        -> composeReport #1 -> renders + sends the email
  └─ writeDailySnapshot(def)   -> composeReport #2 -> builds + persists the fact
```

Two gathers against Logics, CallRail and RingCentral, minutes apart, for one
night. Taken knowingly for one patch (Mickey: *"to be careful let's just run it
twice for now"*) so the send path could stop carrying persistence.

## Why it is small

`runDefinition` **already returns its composed report** —
`reportDefinitionService.js:181`, the `report` key on `result`. Nothing needs to
be plumbed; the object is sitting there unused.

---

## The change

### 1. Accept a report instead of composing one

`dailySnapshotService.js` — `writeDailySnapshot` takes `report` as a parameter.
When supplied, skip the compose entirely; when absent, compose as it does today.

**Keep the fallback.** It is not dead weight: it is what makes a missed night or
a backfill runnable without a send, which was half the reason the writer was
extracted. Delete the compose and the writer becomes a side effect again.

The two-stage candidate gate collapses to one. The pre-gate exists only to avoid
paying for a gather we would then decline — with the report handed in, that cost
is already sunk, so run the real gate once against the actual report.

### 2. Hand the report over

`reportScheduleRuntime.js` — add `report: result.report` to the
`writeDailySnapshot({...})` call. One line.

### 3. Flip the two tests back

Both were rewritten in `815435f` and carry a comment saying they invert here.

- `dailyReportFactService.test.js` — "sending carries NO persistence concern"
  keeps its current assertions (the send path still must not write the fact).
  Add: the snapshot call must NOT compose when a report is supplied.
- `dailyReportFactService.test.js` — "the snapshot writer is ordered after the
  email…" gains an assertion that `report: result.report` is passed, alongside
  the existing `range: result.range`.
- `nightlyReportDelivery.test.js` — "the send path cannot be broken by the fact
  store" is unchanged. The structural guarantee it protects does not move.

---

## What must not break

| Guarantee | Why it matters | How it is held |
| --- | --- | --- |
| The email renders and sends identically | It is the one thing that must not move | Nothing in `runDefinition` changes; only what happens after it |
| `dateKey` comes from `result.range` | An independently derived day wrote TODAY where the email wrote YESTERDAY, and the unique-key `$set` silently overwrote the earlier document | Already the case; do not "simplify" it into a computed day |
| Snapshot only for a delivered email | A day whose mail never went out must not acquire a snapshot claiming it did | `if (result.delivered)` stays |
| An accepted email never becomes sendable again | A released claim re-sends four emails on the next five-minute poll | Structural — `runDefinition` does not write the fact, so it cannot release the day over a fact failure. **Do not move the writer back inside it.** |
| `result.dailyFactCapture` keeps its name | `reportScheduleRuntime.js:81-94` alerts on that exact field and the literal status `"failed"` | Assign the writer's return to it, as now |

---

## Verify

1. `node --test "tests/metrics/*.test.js"` — 615+ green.
2. **One gather, not two.** Run the scheduler against a stubbed composer and
   assert it was called exactly once for the canonical definition.
3. **The stored fact still carries costs by source** — `facts.spend` non-null
   with `total`, `ld`, `ldLeads`, `mail`, `mailPieces`, `bcd`, `bcdCalls`.
4. On the first real night: one `DailyReportFact` for the day, `revision` not
   climbing, `dateKey` equal to the email's range.

---

## Explicitly NOT in this patch

- Moving the snapshot **before** the send. That is a separate, later change and
  it reorders the live email path. It is what actually closes the
  send-fails-and-the-day-is-lost gap, and it waits until the nightly email is
  not the thing being protected.
- Arming `NIGHTLY_SPEND_SYNC_ENABLED` or `NIGHTLY_ACTIVITY_REVIEW_ENABLED`.
- Anything in the 19:50 registry.

## Rollback

Revert the one-line change in `reportScheduleRuntime.js`. The writer's compose
fallback means it keeps working with no other edit — which is the main reason
the fallback stays.
