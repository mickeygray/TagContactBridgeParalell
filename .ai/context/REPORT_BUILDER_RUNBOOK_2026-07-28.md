# REPORT BUILDER — SHIP RUNBOOK

Ship early, watch it, then let it run. Every switch below is OFF right now, and
the control plane on :5001 is still running **pre-patch code** — nothing in this
patch exists in production until it restarts.

Arm in the order given. Each stage is observable before the next one matters,
and each is a single env line plus a restart.

---

## Stage 0 — restart with everything OFF (day 0)

Restart the control plane. No flags. Nothing changes behaviour; the new
runtimes log that they are disabled and exit.

**Confirm on `/health`:**

```
nightlyHygiene.enabled   false
nightlyHygiene.at        19:50 PT
nightlyHygiene.tasks     night-persist(off) · call-urls(off) · logics-source(off)
reportSchedule.enabled   false
```

If those keys are absent, the restart did not pick up the patch.

---

## Stage 1 — run the night, write nothing (day 1)

```
NIGHTLY_HYGIENE_ENABLED=true
```

At 19:50 PT the pass runs and writes nothing: `night-persist` shows what it
WOULD persist, `call-urls` reports coverage, `logics-source` lists the cases it
WOULD move off ABC.

**Watch `nightlyHygiene.lastResult.tasks[].summary`:**

```
night-persist  2026-07-29: 2240 row(s) · 5 deal(s) · 2240 event(s) + 1123 payment truth(s) to persist
call-urls      2026-07-29: 0/1789 attempt(s) carry a recording URL (0%) — capture is not landing
logics-source  152 caller(s) on an active piece → 52 case(s) to move off the catch-all
```

Expected on night 1: **non-zero** persist counts, and a `logics-source` plan in
the tens. A zero persist count means the day target is wrong — check
`nightlyHygiene.targetDay` equals the day that just finished selling.

`call-urls` at 0% is expected **until** Codex's capture path is live. Once it
is, this should climb the same evening. If it stays 0 for a day with dials,
capture is not landing — that is the one number here worth chasing.

---

## Stage 2 — let it persist attribution (day 2)

```
NIGHT_PERSIST_ENABLED=true
```

This is the write that cannot be re-derived: `officerAtSale` / `sourceAtSale`
are who owned and sourced the case AT SALE, and a live re-pull returns today's
assignment instead. Everything else in the system re-derives; this does not.

**Verify the morning after:**

```bash
node -e 'require("dotenv").config();const{connectMongo}=require("./packages/event-core/src");const{getSharedConfig}=require("./packages/shared-config/src");const P=require("./packages/shared-models/src/PaymentTruth");(async()=>{await connectMongo(getSharedConfig());const d="2026-07-29";const D=await P.countDocuments({paymentDateKey:d,paymentType:"initial"});const O=await P.countDocuments({paymentDateKey:d,paymentType:"initial",officerAtSale:{$ne:null}});console.log(`${d}: ${O}/${D} deals carry an officer`);process.exit(0)})()'
```

`O` should equal `D`, or be short only by deals with no assignment activity at
all. It is safe to re-run the pass — the writes are idempotent upserts and the
stamp never writes null over an existing value.

---

## Stage 3 — send the reports (day 3)

```
REPORT_SCHEDULER_ENABLED=true
```

Then arm the definitions:

```bash
node scripts/report-schedule.js --enable "night board"
node scripts/report-schedule.js --list
node scripts/report-schedule.js --due
```

`midday work check` is already armed and **goes to seven people**. Preview
exactly what they will receive before the first 13:00 fires:

```bash
node scripts/report-schedule.js --run "midday work check"
```

That composes the real report and prints it. It sends nothing without `--send`.

---

## Stage 4 — write the mail piece back to Logics (last)

```
LOGICS_SOURCE_WRITER_ENABLED=true
```

Deliberately last: it is the only switch that writes to **live client records**
in someone else's system. Everything before it writes to our own Mongo or sends
an email.

**Dry-run it first, every time:**

```bash
node scripts/sanitize-logics-source.js --days 7
```

Only the three ACTIVE pieces are ever written (SourceID 73/74/75). Inactive
pieces stay on ABC by design, and a case already carrying a specific piece is
never re-pointed — generic → specific only, never the reverse.

---

## What to watch each night

| signal | where | healthy |
|---|---|---|
| pass ran | `nightlyHygiene.lastRunKey` | equals the day that just finished |
| attribution landed | the query in Stage 2 | officer count tracks deal count |
| capture landing | `call-urls` summary | climbing above 0% once capture ships |
| reports sent | `reportSchedule.lastResults[].delivered` | `true` |
| a definition broke | `--list` → `LAST ERROR` | absent |

---

## Rolling back

Every stage is one env line. Unset it and restart; nothing else to undo.

- Attribution already written **stays** written — it is additive and idempotent.
- The Logics source writer is the only stage with an external side effect. It
  writes a SourceID onto a case; reverting means setting those cases back, so
  keep the dry-run output from the night you arm it.
- The old night board is **untouched** and still registered. It has not been
  retired, so if the new path disappoints, `NIGHT_BOARD_ENABLED=true` restores
  exactly the previous behaviour.

---

## Known and deliberate

- **The old board still exists.** Retirement waits until the persist task has
  run armed for several nights and the Stage 2 query looks right.
- **Numbers will shift on cutover**, both corrections: deals count SALES not
  payment rows (a first invoice split into two installments was counted twice),
  and net now includes BCD spend, which the old board omitted.
- **Recurring payments are not source-folded** on month-range reports, so
  "(unsourced)" recurring totals are large. Deals are always folded. Fixing it
  costs ~1,400 extra Logics reads per monthly report.
- **`manderson` and `abanks`** receive the 1pm report but are not on the staff
  roster; an unrecognised name defaults to the sales board, so they will appear
  there if they have queue or deal activity.
- **The report designer UI is not built.** Everything is driven by
  `scripts/report-schedule.js` until it is.
