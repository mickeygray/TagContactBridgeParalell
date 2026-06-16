# Call Totals Reconciliation Plan

Last updated: 2026-06-16

## Why This Exists

The current metrics UI is useful for spend, leads, payments, and mailer response calls, but it does not honestly show how much the CX floor is working newly generated leads. The existing `DailyCallStat` table is a cross-tenant call-response rollup keyed by `date + piece`; it is not a clean ledger for outbound CX dialing effort.

That creates two separate truths that should not be blended:

- **Mailer response calls:** inbound/response-oriented call totals from `controlplanedailycallstats`.
- **CX lead work:** outbound CX attempts against specific generated leads from `controlplanecalllogs` joined to `controlplaneleadcadences`.

The first safe step is to persist a reconciliation layer that keeps those truths separate while still making the month-to-date work visible.

## What Was Added

Script:

```powershell
node scripts\reconcile-monthly-call-totals.js --from 2026-06-01 --to 2026-06-16 --apply
```

The script writes:

- A JSON dump under `runtime/metrics-reconcile/`.
- A Mongo document in `controlplanemetriccallreconciliations`.
- A combined report covering CX lead work, mailer response calls, and source-attributed deals/payments.

It does **not** mutate:

- `DailyCallStat`
- `MetricsSnapshot`
- `LeadCadence`
- `CaseProfile`
- `PaymentLedger`
- dashboard/read-service code

## Current Persisted June Report

Collection:

```text
controlplanemetriccallreconciliations
```

Document key:

```json
{
  "kind": "monthly-call-honesty",
  "range.fromKey": "2026-06-01",
  "range.toKey": "2026-06-16"
}
```

Persisted `_id` from the first write:

```text
6a3187e4d5da59727fba176f
```

Headline counts from the first applied run:

| Metric | Count |
| --- | ---: |
| Raw CX outbound rows | 23,466 |
| Unique CX session rows | 23,466 |
| Soft-deduped CX attempts | 16,783 |
| Attempts against active June-generated leads | 10,442 |
| Attempts against older/inactive/unmatched leads | 6,341 |
| Active June-generated leads | 3,371 |
| Active June-generated leads dialed | 3,250 |
| CX attempts over 2 minutes | 75 |
| CX attempts over 5 minutes | 23 |

Source breakdown:

| Source | Active Leads | Dialed Leads | CX Attempts | Over 2m | Over 5m |
| --- | ---: | ---: | ---: | ---: | ---: |
| LD CUSTOM | 1,422 | 1,363 | 4,396 | 33 | 10 |
| LD CUSTOM 2 | 1,286 | 1,228 | 3,847 | 39 | 11 |
| LD GENERAL | 659 | 659 | 2,199 | 3 | 2 |
| Local UI Smoke | 4 | 0 | 0 | 0 | 0 |

Mailer response calls remain separate:

| Metric | Count |
| --- | ---: |
| Mailer response calls | 747 |
| Mailer calls over 2 minutes | 402 |
| Mailer calls over 5 minutes | 311 |
| Mailer unique callers | 327 |

Top mailer rows:

| Piece | Calls | Over 2m | Over 5m |
| --- | ---: | ---: | ---: |
| Affordability Federal Snap | 186 | 130 | 107 |
| Urgent Third Pink State | 105 | 76 | 64 |
| Urgent Third State | 91 | 66 | 55 |
| Urgent Third PC State | 71 | 24 | 8 |
| Unknown | 57 | 21 | 20 |
| Urgent Third Federal | 41 | 7 | 2 |
| Citation State PC | 38 | 17 | 13 |
| Must Respond Federal | 38 | 13 | 8 |

Deal/payment reconciliation:

| Metric | Count |
| --- | ---: |
| Successful payment rows | 181 |
| Initial deal count | 32 |
| Initial amount | $37,226.47 |
| Total collected | $331,747.66 |
| Deal source-review rows | 94 |

Top deal rows by source:

| Source | Deals | Initials | Total Collected |
| --- | ---: | ---: | ---: |
| Urgent Third State | 11 | $14,661.30 | $26,141.07 |
| Affordability Federal Snap | 5 | $11,039.50 | $12,352.00 |
| Urgent Third Pink State | 5 | $6,162.67 | $10,133.76 |
| LD CUSTOM | 4 | $1,975.00 | $1,975.00 |
| LD CUSTOM 2 | 1 | $1,293.00 | $1,293.00 |
| Urgent Third Pink Federal | 2 | $1,000.00 | $2,439.50 |
| Affordability Pink State Snap | 1 | $500.00 | $1,519.75 |
| LD GENERAL | 2 | $325.00 | $325.00 |
| LD Posting | 1 | $270.00 | $1,020.00 |

Important cleanup confirmation:

- `LD CUSTOM` includes WYNN `115669` Michael Nott / James Sharp / `$1,200`.
- `LD CUSTOM 2` includes WYNN `124777`.
- TAG mailer manual source fixes are reflected in the deal source rows.
- `Unknown` and `ABC` remain present only as recurring collections in this range, not initial deals.

## Issues Addressed

### 1. LD Call Totals Were Understated In The Existing Metrics View

The dashboard-facing source metrics were showing very small LD call counts, such as `LD CUSTOM 83` and `LD CUSTOM 2 0`, because the current metrics path is reading call rollups from `DailyCallStat`. That table is not the right source for outbound CX attempts.

The reconciliation now reads `controlplanecalllogs` directly for `platform: "cx"` and `direction: "outbound"`, then joins those calls back to active `LeadCadence` rows created in the reporting window.

### 2. Raw CX Rows And Operational Attempts Are Different

RingCX/control-plane call logs can contain more rows than the operational count we want for "how many times did we work this lead." The report stores both:

- `rawRows` / `uniqueSessionRows`
- `softDedupedAttempts`

The source metrics use the softer attempt count, deduped by platform, direction, domain, case, phone, and call-start second. This may slightly undercount rapid duplicate dials in the same second, but it avoids materially overstating work when duplicate call records are present.

### 3. LeadCadence `createdAt` Includes Imported/Inactive Noise

A huge `ABC` bucket appeared when counting all LeadCadence rows created in June. Inspection showed those rows were inactive TAG rows by state, likely imported or migrated operational rows, not active June lead flow.

The reconciliation therefore counts only:

```js
active: { $ne: false }
```

This keeps the active June-generated lead totals from being swallowed by stale inactive cadence rows.

### 4. Mailer `Unknown` / `ABC` Buckets Are Only Partly Fixable

The June `Unknown` and `ABC` mailer call-stat rows were inspected using their embedded `raw.telephonySessionId` / `raw.caseId` breadcrumbs. Only a few rows could be safely re-bucketed from current source data. Most remain genuinely unresolved or pending in the existing call-stat source.

Recommendation: do not bulk rewrite those rows yet. Treat them as source-cleanup targets.

### 5. Deal Cleanup Needed To Be Captured Beside Call Work

Manual deal attribution fixes are easy to lose if they only live in one-off notes. The reconciliation now includes successful `PaymentLedger` rows for the same reporting range:

- `initial` payments count as deals and initial dollars.
- all successful payments count toward total collected.
- source is selected from `PaymentLedger.sourceCanonicalId` first, then `CaseProfile.sourceCanonicalId` / `sourceName`.
- initial deal rows are retained with case ids, case payment ids, source path, and review flags.

This gives us a single place to verify whether source cleanup has affected revenue attribution before it is pushed into dashboard semantics.

### 6. Status-First Deal Rescue Is A Separate Cleanup Path

The safest way to find missed new clients is not always calls first. Some cases become visible first because Logics status or payment state changed before our local `CaseProfile` / metrics attribution caught up.

The status-first rescue path is:

1. Pull the newest Logics cases from early deal/client statuses, currently TAG `210` and `206`, using Logics' default modified-date order.
2. Inspect each case's payments directly from Logics.
3. If the case has successful payments and no local `CaseProfile`, create the missing profile with `$setOnInsert`-style safety.
4. Reconcile the case into `PaymentLedger` using the normal payment reconciler, not a parallel payment writer.
5. Use local evidence only for attribution:
   - existing `LeadCadence` / source fields
   - CX call logs
   - webhook/intake events
   - mailer/call response breadcrumbs
6. Leave ambiguous attribution in the review output instead of forcing it into a source bucket.

This is implemented as a one-off rescue lane in:

```powershell
node scripts\status-payment-metrics-rescue.js --domain TAG --statuses TAG:210,206
```

Write mode is intentionally split:

```powershell
node scripts\status-payment-metrics-rescue.js --write --domain TAG --statuses TAG:210,206
node scripts\status-payment-metrics-rescue.js --write --apply-attribution --domain TAG --statuses TAG:210,206
```

The first command can create or repair missing profile/payment records. The second command is intentionally separate because attribution is easier to get subtly wrong than payment presence. This keeps "we found a real paid case" separate from "we know exactly which source should receive credit."

This lane should be used to explain gaps like:

- Logics shows more initials than our metrics layer.
- A paid case has no local `CaseProfile`.
- A case has `PaymentLedger` rows but missing or generic source attribution.
- TAG mailer initials appear in Logics but remain hidden under `Unknown` / `ABC` / blank source locally.

It should not be used to rewrite dashboard counters directly. Its job is to generate repaired local facts and a reviewable evidence report that the reconciliation layer can read.

## Proposed Careful Implementation

### Phase 1: Nightly Reconciliation Job

Run the one-off script after nightly patch/cleanup:

```powershell
node scripts\reconcile-monthly-call-totals.js --from 2026-06-01 --to 2026-06-16 --apply
```

For future months, use the first day of month through the current PT date.

Output should be emailed or included in the EOD metrics cleanup note:

- raw CX rows
- soft-deduped CX attempts
- attempts against active generated leads
- source rows
- mailer response totals
- generic mailer buckets
- deal/payment totals
- deal source review rows
- generic deal buckets

### Phase 2: Read-Side Metrics Overlay

Once we trust the reconciliation for a few days, add a read-only overlay to the metrics UI:

- `CX Attempts`
- `CX >2m`
- `CX >5m`
- `Generated Leads Dialed`
- `Generated Lead Coverage %`
- `Initial Deals`
- `Initial Dollars`
- `Total Collected`
- `Deal Source Review Count`

These should come from `controlplanemetriccallreconciliations`, not from `DailyCallStat`.

Keep the existing mailer response call columns sourced from `DailyCallStat`.

The deal overlay should read from the reconciliation until the canonical metrics rewrite is ready. That keeps patched/rescued deal attribution visible without creating a second competing payment pipeline.

### Phase 3: Source Hygiene

Clean source attribution before trying to make this canonical:

- Resolve remaining `Unknown` and `ABC` source rows where possible.
- Normalize `LD CUSTOM`, `LD CUSTOM 2`, `LD GENERAL`, and `LD Posting` source labels.
- Keep inactive imported cadence rows from being treated as new generated leads.

### Phase 4: Proper Call Metrics Ledger

The bigger rewrite should introduce a purpose-built call metrics ledger or materialized rollup with explicit dimensions:

- `date`
- `domain`
- `platform`
- `direction`
- `sourceCanonicalId`
- `sourceName`
- `caseId`
- `leadCreatedAt`
- `callStartedAt`
- `durationSec`
- `dedupeKey`
- `countsAsLeadWork`
- `countsAsMailerResponse`
- `countsAsInitialDeal`
- `countsAsRecurringPayment`
- `paymentType`
- `casePaymentId`
- `paymentAmount`

Then the dashboard can aggregate from that ledger instead of mixing `DailyCallStat` and direct `CallLog` queries.

## Permanent Anti-Drift Architecture

Goal: stop **mid-month metrics drift** — the numbers you saw for June 5 must not silently change by June 16 — while still letting late truth (a case that paid, an attribution cleanup) be reflected honestly. Status-first reverse attribution is the anchor; "close the books" is the mechanism.

### Why metrics drift today (root cause, traced to code)

Every current metrics store is **upsert-by-key recompute**, so a re-run overwrites the past:

- `DailyCallStat` — upsert by `(date, piece)`.
- `MetricsSnapshot` — `index({ domain, bucketType, bucketKey }, { unique: true })`; recompute overwrites the bucket.
- `controlplanemetriccallreconciliations` — upsert by `(kind, range.fromKey, range.toKey)`; the monthly doc is recomputed nightly against **today's** state.

Four things change after a day has elapsed and therefore restate it: (a) **attribution** cleanup (source moves buckets), (b) **status** changes (a case enters/leaves the deal set), (c) the **active-lead denominator** (`LeadCadence.active` flips, changing coverage %), (d) **late-arriving payments** (a June payment reconciles in July). Because storage is recompute-overwrite, all four silently rewrite closed days.

### The principle: close the books, restate with journal entries

Separate two truths that today are blended:

- **As-reported (frozen):** what the number *was* when the period closed. Immutable forever.
- **As-corrected (latest):** best current truth, including late facts.

Model facts **bitemporally**: `effectiveDateKey` (when it happened) and `recordedAt` (when we learned it). Once a period closes, its as-reported figure is frozen; corrections are **append-only adjustment facts**, never edits — exactly like accounting journal entries against a closed month.

### The status-first anchor (decouple "is it a deal?" from "whose source?")

§6 already split these; the architecture makes it permanent:

- **Deal truth = case STATUS + successful PAYMENT** (reverse attribution). Stable, freezable: "June had 32 initials" should not move.
- **Source attribution = a separate, versioned dimension.** It can be restated by an adjustment fact **without changing the deal count**. This kills attribution drift specifically — the cleanup that moves a deal from `Unknown` to `Urgent Third State` is a restatement of one dimension, not a rewrite of the total.

### Target state: an append-only fact ledger + a frozen close layer

Two new owned collections (write nothing else):

- **`MetricFact` (append-only).** One immutable row per metric-affecting fact, dimensions per the Phase-4 list PLUS `factId`, `effectiveDateKey`, `recordedAt`, `supersedesFactId` (corrections), `attributionVersion`, `dedupeKey`. Corrections = new facts (reversal + rebook), never updates. Deal facts key on `casePaymentId`; call facts on the soft-dedupe key.
- **`MetricClose` (frozen snapshot).** Per `(domain, periodKey, grain)` — the as-reported aggregate **at close time** plus the `recordedAt` watermark and the **frozen active-lead denominator**. Immutable once written.

Dashboard read: **closed periods → `MetricClose`** (frozen, drift-free); **live period → aggregate `MetricFact` as-of now**; a toggle for as-reported vs as-corrected.

### Roadmap — multiple stabs, each a refinement not a rewrite

1. **Stab 1 — Freeze (immediate drift stop, lowest risk).** Nightly, snapshot the *existing* reconciliation doc into an immutable per-day + per-month `MetricClose` keyed by `(domain, periodKey, grain, closedAt)`. No new math — just freeze what the reconciliation already computes. The dashboard shows the frozen close for everything ≤ yesterday; today stays live. **This alone stops drift for all closed days.**
2. **Stab 2 — Status-anchored deal facts.** Productionize the `status-payment-metrics-rescue` lane to emit immutable deal `MetricFact`s (by `casePaymentId`) via `createCaseProfileIfMissing` / `reconcilePaymentsForCase`, with attribution as a **separate versioned fact** so it restates independently. Deal count freezes; source restates.
3. **Stab 3 — Full fact ledger.** Make the reconciliation *computation* a fact **emitter** (call-attempts + recurring payments) instead of a doc recompute. Dashboard aggregates from `MetricFact`; `MetricClose` becomes a cached as-of snapshot.
4. **Stab 4 — Backfill to January.** Replay the status-first + call computation month-by-month back to Jan, writing facts with `recordedAt = backfill timestamp` and freezing each closed month's `MetricClose`. Idempotent (keyed by `factId` / `casePaymentId` + `dedupeKey`). Once a month freezes, it never drifts again.

### DAINTY safeguards

- Read-only except the two new owned collections; never mutate `CallLog` / `LeadCadence` / `PaymentLedger` / `CaseProfile` / `DailyCallStat` / `MetricsSnapshot`.
- Freeze is append-only; corrections are new facts; nightly is env-gated and best-effort (can never break the close).
- The dashboard overlay is additive — mailer `DailyCallStat` columns stay byte-identical.

### Hard parts (open, decide before building deep)

- **Coverage % denominator:** "active generated leads" drifts as cadences exhaust. Decision needed: freeze the active set **at close** (coverage% becomes as-reported), which is the only drift-free option but means a closed day's coverage won't move even if a lead later reactivates.
- **As-reported vs as-corrected UX:** the panel must show which it is. Recommended default: as-reported (frozen) for closed months, with a restatement badge when adjustment facts exist.
- **Month-boundary late payments:** a June payment reconciled in July is `effective=June, recorded=July` — as-corrected June reflects it, frozen June does not; it shows as a July adjustment. Correct, but needs an explicit, written rule.
- **Backfilled months carry provisional attribution** until Phase-3 source hygiene runs — mark them so.

## Safety Notes

- The current script is safe to rerun; it upserts by `kind + range`.
- Runtime JSON dumps are regenerated each run.
- No existing metrics or lead records are changed.
- The report intentionally separates outbound CX lead work from mailer response calls.
