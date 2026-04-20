# Sourcing And Status Redesign Notes

This document captures the current sourcing/statusing weak spots found in the
original `TagContactBridge` repo and proposes a tighter `5001` control-plane
design for case attribution, payment updates, and status refresh.

## Original Materials Reviewed

- `ringBridge/services/logicsLookupService.js`
- `ringBridge/services/attributionService.js`
- `ringBridge/services/hourlySyncService.js`
- `ringBridge/services/callRailDealDiscovery.js`
- `ringBridge/services/callRailStatsService.js`
- `ringBridge/services/sourceCanonicalService.js`
- `ringBridge/models/CaseProfile.js`
- `ringBridge/models/DailyPaymentSummary.js`
- `config/sourceMap.js`
- `config/statusMap.js`
- `ringBridge/routes/apiRoutes.js`

## What Is Good Already

- `CaseProfile` is the right idea: one durable ledger per Logics case.
- `SourceCanonical` is the right idea: one place to unify aliases, source IDs,
  tracking numbers, mailer numbers, and RingCentral extensions.
- `DailyPaymentSummary` is the right idea: a deduped payment ledger that the
  ROI/metrics layer can aggregate quickly.
- `hourlySyncService` already does real gap filling and payment refresh work.
- Match rates are already pretty strong, which means this is a boundary and
  consistency problem more than a “bad data” problem.

## Main Weak Spots

### 1. Attribution is resolved in multiple places with different rules

Current attribution logic is spread across:

- `logicsLookupService`
- `attributionService`
- `callRailDealDiscovery`
- manual dashboard routes
- `hourlySyncService`

That means the same case can enter through:

- live RC enrichment
- CallRail deal discovery
- hourly payment sweep
- manual case-profile creation

and get a slightly different source result depending on which path touched it
first.

### 2. Manual fixes do not fully write the same downstream artifacts

The manual route at `/admin/caseprofiles/manual` updates `CaseProfile`, but it
does not write the same `DailyPaymentSummary` rows that the ROI and daily
summary surfaces use.

That likely explains the behavior where:

- a manual deal looks present in one view
- but does not count in the ROI/daily payment views
- and mail/manual source buckets can still look wrong

### 3. `hourlySyncService` is doing too many jobs at once

It currently mixes:

- status refresh for active prospects
- gap-filling missing `CaseProfile` rows
- payment sweep / ledger materialization
- attribution repair
- spend pre-sync side effects

That makes the refresh path harder to reason about and harder to replay safely.

### 4. Current coverage depends too much on “touched today”

`hourlySyncService` backfills cases seen in today’s `ContactActivity`, then
loops non-prospect `CaseProfile` records for payment updates.

That works for active traffic, but it leaves a coverage risk for:

- older cases with partial identity but no durable profile row
- cases discovered manually
- cases whose source/status drifted after their original call window

### 5. Source truth is split between multiple materials

There are currently several source truth layers:

- Logics `SourceID`
- `config/sourceMap.js`
- `SourceCanonical`
- `LeadCadence.source`
- CallRail tracking metadata
- mailer mappings
- manual dashboard source strings

They are all useful, but they need one precedence order and one persisted match
record.

## Likely Cause Of The ROI / Manual Count Hole

The strongest likely bug from the original code review is:

1. manual route creates or updates `CaseProfile`
2. manual route fetches payments and updates profile financial fields
3. manual route does not materialize `DailyPaymentSummary`
4. ROI and daily summary routes aggregate from `DailyPaymentSummary`
5. result: manual deal exists, but range summaries miss it

That is a consistency issue, not just a UI issue.

## Recommended 5001 Design

### A. Build a tiny durable case index for full coverage

Yes, I think a thin control-plane index for all Logics cases is a good idea.

Not the full case payload for 500,000 cases at first. Start with:

- `domain`
- `caseId`
- normalized phones
- current `statusId`
- current `sourceId`
- last checked timestamps
- last changed timestamps
- optional create date

That gives us a lightweight reconciliation backbone without needing every
detail on every row.

Benefits:

- we stop depending on “today touched it” as the only discovery path
- we can batch-check status/source deltas by case ID
- we can attach new activity/calls/payments to old cases more reliably
- manual corrections can lock against a stable indexed case record

### B. Split the control-plane flow into four explicit stages

1. `case-index`
- durable minimal record for every known Logics case
- owns caseId/domain/phone/sourceId/statusId checkpoints

2. `case-match`
- answers “which case does this phone/call/payment belong to?”
- can use phone, CallRail, RC ext, tracking number, canonical aliases

3. `case-attribution`
- answers “which source/channel should this case be credited to?”
- applies one precedence order and writes a persisted attribution decision

4. `case-financial-ledger`
- materializes payment rows and status snapshots
- feeds ROI, daily summary, and metrics APIs

### C. Persist the attribution decision, not just the result

Every case should carry:

- resolved source name
- resolved source channel
- `matchedBy`
- confidence tier
- locked/manual flag
- review-needed flag
- last attribution run
- supporting evidence IDs

That way the system knows not just the answer, but why it decided that answer.

### D. Use one precedence order everywhere

Recommended precedence:

1. manual lock
2. Logics `SourceID` mapped through canonical source tables
3. canonical tracking number / mailer / RC extension match
4. LeadCadence intake source
5. latest known activity source fallback
6. unresolved

The key is that every path uses the same order.

### E. Treat manual actions as first-class pipeline writes

Manual fixes should not be “special side effects.”

They should call the same shared control-plane workflow that automation uses,
with an extra flag:

- `origin = manual`
- `lockSource = true/false`
- `lockCaseMatch = true/false`

That workflow should always write:

- `CaseProfile`
- case attribution decision
- payment ledger rows if payments exist
- event/audit records

### F. Separate status refresh from payment refresh

These should become separate worker workflows:

- `refresh-case-statuses`
- `refresh-case-payments`
- `refresh-case-attribution`
- `gap-fill-case-profiles`

They can still be triggered together, but they should not be one giant job.

### G. Batch-check by status where possible

Your instinct is good here.

If Logics can give us workable status filters or if we can cheaply maintain a
local case index by `statusId`, then `5001` can:

- fetch candidate case IDs by current status bucket
- run Mongo `$in` comparisons against known rows
- prioritize refreshes where status/source/payment drift is most likely

That is much cheaper than repeatedly rediscovering cases from edge traffic.

## Concrete Improvements I Would Make

### Improvement 1

Create a `CaseIndex` collection in the new control plane with the thin shape
above and backfill it from Logics over time.

### Improvement 2

Create one shared `resolveCaseAttribution()` workflow that is used by:

- live Ring enrichment
- CallRail deal discovery
- hourly payment/status refresh
- manual dashboard fixes

### Improvement 3

Create one shared `materializeCasePayments()` workflow that always writes both:

- `CaseProfile` financial rollups
- payment ledger rows

This should fix the manual-appears-here-but-not-there class of bug.

### Improvement 4

Add explicit `needsReview` reasons instead of only a boolean:

- `missing-source-id`
- `canonical-conflict`
- `manual-source-without-ledger`
- `multiple-logics-matches`
- `payment-without-profile`
- `profile-source-vs-ledger-source-mismatch`

### Improvement 5

Track match evidence on every resolved case:

- `sourceId`
- tracking number
- RingCentral ext
- caller phone
- matched activity ID
- payment row IDs

That makes audit and manual repair much easier.

## My Current Recommendation

I would not throw away the current approach. The wheel is mostly good.

I would tighten it by:

- introducing a durable thin `CaseIndex`
- centralizing attribution into one workflow
- centralizing payment materialization into one workflow
- making manual writes go through the same path as automation
- moving all of this into `5001` as explicit control-plane services

That gives you better coverage on old cases, better match consistency, and a
much lower chance that the ROI/dashboard layer disagrees with the manual/admin
layer.
