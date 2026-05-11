# Nightly Logics Money Sweep Spec

## Goal

Catch money that appears in Logics without a same-day call, webhook, or lead
event. This is intentionally a nighttime pass, not hourly work.

Important boundary: this sweep discovers candidate Logics cases by status, but
it should only create a `CaseProfile` when that case has a payment inside the
nightly payment window. Status alone is not enough evidence to materialize a
profile.

The hourly loop should stay focused on fresh calls, recordings, scoring,
spend-sheet updates, contact events, and payment checks for recently touched
cases. The nightly loop can afford the broad Logics scan.

## Trigger

Run inside the nightly close final pass, after the normal hourly-style sweep
and before the three nightly emails are rendered.

Inputs:

- `domains`: default `TAG,WYNN`
- `dateKey`: LA calendar day being closed
- `paymentWindow`: `[dateKey 00:00:00 America/Los_Angeles, next day)`
- `monthWindow`: current LA calendar month, for first-payment/month-to-date
  comparisons already used by the financial email

## Status Scope

The primary discovery path is `Case/GetCasesByStatus`.

Default status families:

- active client statuses
- Tier 1 statuses
- optionally Tier 2-5 and post-date statuses if financial reporting wants all
  first payments, not only the first tier

Initial concrete defaults should come from `STATUS_SCAN_SETS` and
`statusMap.js`:

- Use configured `conversionStatusIds`
- Filter/label by `resolveStatus(domain, statusId)`
- Keep categories `client`, `tier1`, `tier2`, `tier3`, `tier4`, `tier5`,
  and `postdate`
- Allow env overrides:
  - `NIGHTLY_LOGICS_MONEY_STATUS_IDS_TAG`
  - `NIGHTLY_LOGICS_MONEY_STATUS_IDS_WYNN`

## Capability Gate

Earlier smoke notes showed `Case/GetCasesByStatus` returning route-level `404`
on both tenants. Before doing real work, run a small canary:

1. Pick one known active/tier status per domain
2. Call `getCasesByStatus(statusId, { orderByCreatedDate: true })`
3. If it returns case ids, enable full status sweep for that domain
4. If it returns `404`, mark the domain as `status-sweep-unavailable`

Unavailable status sweep is not a fatal nightly failure. It should:

- add a bug/ops item to the nightly ops email
- fall back to the tracked-case set:
  - `CaseProfile` due for payment reconcile
  - cases touched in `CallLog`
  - cases created/served through `LeadCadence`
  - cases accepted in same-day `MasterProspectIndex`

## Main Loop

For each enabled domain:

1. Resolve status ids
2. For each status id, fetch case ids through `GetCasesByStatus`
3. Deduplicate case ids across statuses
4. For each case id:
   - fetch `CaseInfo`
   - run `reconcilePaymentsForCase({ domain, caseId, lane: "nightly" })`
   - query `PaymentLedger` for payments whose `paidAt` is inside
     `paymentWindow`
   - if no same-day payment exists, do not create a `CaseProfile`
   - if same-day payment exists:
     - create or update `CaseProfile`
     - attach the same-day payment ledger rows
     - run attribution repair
5. Rebuild daily/monthly financial summaries after the sweep

## Attribution Repair

When a same-day payment is found, create/update the `CaseProfile` and assign
source with this precedence:

1. Existing `CaseProfile.sourceCanonicalId`
2. `MasterProspectIndex` by `domain + caseId`
3. `LeadCadence` by `domain + caseId`
4. Resolved `CallLog` history for the case, preferring the earliest source
   before first payment
5. Resolved `CallLog` by normalized phone when the case id was absent on the
   call row
6. Logics `CaseInfo` source fields, such as `SourceID` or `SourceName`
7. Canonical alias/source-map lookup
8. If still unresolved, write a review item and keep the payment in the
   financial email under `Unknown`

The repair must never overwrite a manually locked attribution.

## Writes

The sweep is idempotent.

Expected writes:

- `PaymentLedger`: upsert by Logics payment id
- `CaseProfile`: create if missing only when the case has a same-day payment;
  update payment counters and status snapshot for those paid cases
- `DailySummary`/financial materializations: rebuild after sweep
- `ReviewQueueItem`: only for unresolved attribution, API capability gaps, or
  repeated per-case failures
- optional `NightlyLogicsMoneySweepRun`: durable run summary with status ids,
  counts, failed case ids, and capability flags

## Run Controls

Suggested config:

- `NIGHTLY_LOGICS_MONEY_SWEEP_ENABLED=true`
- `NIGHTLY_LOGICS_MONEY_SWEEP_DRY_RUN=false`
- `NIGHTLY_LOGICS_MONEY_SWEEP_MAX_CASES_PER_DOMAIN=20000`
- `NIGHTLY_LOGICS_MONEY_SWEEP_MAX_CASES_PER_STATUS=5000`
- `NIGHTLY_LOGICS_MONEY_SWEEP_CONCURRENCY=3`
- `NIGHTLY_LOGICS_MONEY_SWEEP_STATUS_IDS_TAG=`
- `NIGHTLY_LOGICS_MONEY_SWEEP_STATUS_IDS_WYNN=`

The implementation should checkpoint by `domain + statusId + caseId` so a long
run can resume instead of starting over.

## Nightly Email Impact

Financial email should include:

- status-sweep enabled/unavailable by domain
- cases discovered by Logics status sweep
- cases reconciled
- same-day payments found
- payments newly added to ledger
- first payments in the current month
- attribution repaired
- attribution unresolved
- failed payments found today

Ops email should include:

- status endpoint 404/capability failure
- per-status failure counts
- per-case retry/dead-letter counts
- unresolved attribution queue count

## Acceptance Cases

1. A payment is run today on an active WYNN case with no call today.
   Nightly sweep finds it through status scan, writes/updates `PaymentLedger`,
   creates/updates `CaseProfile`, resolves source, and includes it in the
   combined financial email.

2. A Tier 1 TAG case receives a first payment today but its source is missing
   from `CaseProfile`.
   Nightly sweep backfills source from `MasterProspectIndex`, `LeadCadence`, or
   prior `CallLog`, then includes it in month-to-date first-payment reporting.

3. A case appears in an active/Tier 1 status but has no payment today.
   Nightly sweep reconciles it as a candidate, but does not create a
   `CaseProfile`.

4. `GetCasesByStatus` returns 404 for a domain.
   Nightly close completes, sends only the three normal emails, and the ops
   email clearly says the full Logics status sweep was unavailable for that
   domain.
