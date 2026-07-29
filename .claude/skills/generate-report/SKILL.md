---
name: generate-report
description: Build, run, email or schedule a report, or answer an ad-hoc data question, across Logics + CallRail + the dialer + spend. Use whenever the user asks for numbers, a report, a board, "how did X do", "how many of Y", or wants something sent on a clock.
---

# Generate a report / answer a question

Two jobs. **Packaged reports** — run an existing block, email it, put it on a clock.
**Unfamiliar questions** — "how many soft pulls converted", "how often do we call an LD
lead". The second is where the mistakes live, so most of this file is about that.

## The one rule

> Compose **declared functions** over **declared substrates** and **factors**.
> Never invent a calculation.

Every ratio comes from `reportOpsService.FUNCTIONS`. A ratio that isn't there gets
**added to the registry**, not typed into a script. Two implementations of "ROI" is how
one mail piece printed 4204% with total confidence.

---

# Part 1 — Packaged reports

| Want | Use |
|---|---|
| A named report, a board, something emailed | `scripts/build-report.js` |
| An odd cut — this agent, this extension, this source | `scripts/ask.js` |
| It on a clock | `scripts/report-schedule.js` |
| The nightly sequence | `scripts/run-night.js` |

Show the catalogue before guessing:

```bash
node scripts/build-report.js --blocks
```

- `--pick` takes presets and block ids interchangeably.
  - Presets: `board` `daily` `worklog` `financials` `marketing` `people` `health`
    `pipeline` `roi-by-source` `officer-performance` `profit-loss` `vendor-ld` `long-calls`
  - Blocks: `money` `spend` `net` `source` `officer` `cohort` `status` `recordings`
    `postdates` `declines` `effort` `lag` `streams` `worked` `pl` `casework` `longcalls`
- Range: `--today` `--yesterday` `--week` `--month` or `--from X --to Y`
- Out: console, `--csv`, `--html`, `--json`, `--email`
- `--where source=LD` · `--where officer="Bruce Hansen"` · `--where domain=TAG`
- `--cached` for instant repeats while iterating; drop it for the real run

`ask.js` is the substrate × factor × function matrix:

```bash
node scripts/ask.js --by source --measure deals,newCash,cash --fn roas,roi --month
node scripts/ask.js --what
```

Scheduling — `--enable` is what arms it; without it the definition is saved but inert.

```bash
node scripts/report-schedule.js --save "monday-marketing" --pick marketing --range week --at 07:00 --dow 1 --enable
```

---

# Part 2 — Answering an unfamiliar question

## Step 0. Which system would even know?

**Four systems record what happens. They do not write to each other.** This is the single
most expensive assumption in the codebase — reading one and treating it as the world.

| System | Join key | What ONLY exists here |
|---|---|---|
| **Logics** activity | `CaseID` | statuses, documents, soft pulls, source, assignment, SMS, tasks |
| **CallRail** | phone → case | inbound marketing calls, piece attribution, duration, first-time flag |
| **DailyDial** | `caseId` | **every outbound dial**, attempt counts, queue pool, outcome |
| **Spend** ledger | source name | cost, pieces mailed, leads bought |

Measured proof this matters: *"how often do we work an LD lead"* answered from Logics
alone gives **3.9%**. Joined to `DailyDial` it is **67.6%** — the dialer is the entire LD
contact operation and leaves **no trace** in Logics. Only 110 of 2,885 dialed cases
appear in both.

Before answering anything, name the systems involved. If a number looks shockingly low,
the first hypothesis is a missing system, not a broken business.

## Step 1. Get the material

```bash
node scripts/activity-vocab.js --from 2026-07-01 --to 2026-07-28
```

Writes to `runtime/vocab/`. The workhorse is **`activity-rows.tsv`** — every row on one
line, columns `domain, caseId, type, created, createdBy, subject`. The activity log is
**prose**, so grep is the honest first instrument.

```bash
grep -icE "soft ?pull|transunion" runtime/vocab/activity-rows.tsv
awk -F'\t' '$2=="429441"' runtime/vocab/activity-rows.tsv | sort -t$'\t' -k4
```

Full term dictionary: [`reference/activity-report-terms.md`](reference/activity-report-terms.md).

## Step 2. Check the parser actually sees it

```bash
node scripts/classify-coverage.js --probe "soft ?pull"
```

Reports how many matching rows fell through to `note` and how many produced no payload.
**A miss here is invisible** — the row parses, lands in the catch-all, and your count is
quietly smaller. This tool found two live bugs: 31 of 187 soft pulls unrecognised, and 20
of 548 status changes missed *that were all DNC and Disconnected Number*.

If coverage is short, **widen the pattern in `activityEventService.js` and add the real
strings to `tests/metrics/activityClassifierCoverage.test.js`** — don't work around it in
a script.

## Step 3. Name the population and the window

Say out loud, before computing:

- **What is the denominator's population?** 33,018 cases were touched in July but 31,412
  are nothing but a lead arriving — only ~1,600 have real casework. Pick the wrong one
  and you're off by 20×.
- **Is either side of the join clipped by the window?** If both events must fall inside
  the range, you are selecting for speed and will get a confidently wrong answer.

## Step 4. Fold aliases before grouping

Route source through `ops.resolveSourceRow` (money) and `ops.foldSourceKey` (spend and
calls). Run raw, one mail piece splits across every spelling it has ever had.

Observed splits: `1SOFTPULL`/`iSoftpull`/`iSoft Pull`/`SOFT PULL`/`SOFTPULL-`/`Credit
Score` · `LD CUSTOM 3`/`LD Custom 3` · `Jacqueline Santos`/`Jacqueline  Santos` ·
`[RESO ONLY]-RESO ONLY RESO ONLY` with one, two or three repeats.

## Step 5. Run it, then run the trap checklist

Every one of these produced a wrong number in this codebase:

1. **Missing system.** Would another system know? (§0)
2. **`Type` is unreliable.** 80 of 184 soft pulls are typed `General`. Filter on subject.
3. **`CreatedBy = "Mickey Gray"` is the API service account** — 36,961 of 45,582 rows.
   Exclude it before measuring human work.
4. **Deals are sales, not payment rows.** A first invoice paid in two installments is one
   deal. `ops.measure` counts distinct cases.
5. **A window is not a world.** Absence of an event in range ≠ absence of the event.
   "190 texted without consent" was consent granted before the window opened.
6. **Cohort mismatch.** Lead→sale in one month divides this month's sales by this month's
   leads — different populations. Use payment-side `sourceAtSale` instead.
7. **Score `0` is not a score.** It's no-hit/frozen. Averaging them in moved the mean 42 points.
8. **Ratios need spend.** ROAS/ROI are `null` at zero spend — `—`, never `Infinity`, never `0%`.
9. **Aged carries no ratio.** Money from a case older than a month, or a dead source,
   counts as revenue but has no return and is excluded from channel totals.
10. **Calls can never be split by company.** CallRail is one TAG tenant.
11. **Confident empty.** A source that failed to gather renders an empty table that reads
    as zero. If a section is empty, prove it's true rather than reporting 0.

## Step 6. Report what didn't match

When a join leaves rows unmatched, **say so with the number**. "693 calls, 210 matched to
a case, 483 unmatched" is an answer. Silently dropping the 483 is not.

---

## Worked patterns

Shapes that generalise — reach for the closest one.

| Question shape | Pattern |
|---|---|
| "What kind of source is X?" | Group ingestion by day. Lumpy with idle days = batch file load. Even daily = purchased feed. |
| "How many times do we contact Y?" | `DailyDial.attempts[].totalAttemptCount` is a **lifetime** counter — immune to the window trap. |
| "What's the conversion rate on mail?" | Not lead→deal. **Response→deal**: first-time callers per piece vs deals with that `sourceAtSale`. |
| "Is this piece any good?" | Cost per response hides it. Compare **conversion** and **average call length** — quality varies 30× by piece. |
| "How fast do we respond?" | min(non-service-account row) − ingestion, median by source. |
| "Did A cause B?" | Both events on one case, ordered, with a lookback wider than the effect you're measuring. |

---

## Safety

- **Read-only by default.** `ask.js`, `activity-vocab.js` and `classify-coverage.js` never
  write. `build-report.js` only sends with `--email`. Schedules only fire with `--enable`.
- **Emailing is outward-facing** — confirm the recipient list before sending to anyone but the user.
- **Never restart :5001 or :3001.** This box runs live ops. Never start nssm services unasked.
- **Mongo is the shared Atlas cluster.** Name any write before making it: collection, row
  count, reversible or not.
- Reports contain client PII. Keep them local unless the user asks otherwise.

## If it isn't buildable

Say so, and say what's missing. The registry, the blocks and the systems are all
enumerable — if a question needs a substrate nobody gathers or a function nobody declared,
that is a real answer and a small piece of work, not a reason to improvise a number.
