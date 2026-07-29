# Metrics Reboot Handoff

Date: 2026-07-24  
Scope: local Windows worktree only  
PhoneBurner work-order phase: 9 — controlled-floor hardening

## Stop State

- No Linux/live patch was made.
- No Windows service was restarted.
- No payment treatment, source correction, or review alert was written to Mongo.
- The July exception scanner was run read-only only.
- The dirty worktree contains unrelated WIP; do not reset, revert, clean, or delete `.orig` files.

## July Facts Proven Read-Only

The apparent `34 deals` are 34 positive successful initial-payment rows, not 34 independent net deals:

- 34 positive initial rows
- 2 negative initial rows
- 32 positive-net case groups
- 1 fully offset case group
- 1 negative-net case group
- 31 case-based net deals

The simple July summary currently preserves every signed payment dollar:

- net deals: 31
- net initials: $29,884.84
- total collected: $312,333.00
- successful payment rows: 260 across TAG, WYNN, and AMITY

The read-only exception scan across all configured domains found four cases:

1. `394513`
   - Two positive initial rows.
   - User ruling: one deal, keep the full $1,000, source `Affordability Federal`.
   - Spouse-number collision is why this must remain a visible operator review.
2. `409586`
   - One positive and one negative initial, fully offset.
   - User ruling: chargeback pair; no CallRail/source match is required; net deal and money are zero.
3. `220274`
   - Missing current source.
   - User ruling: report as `Aged` because the originating piece is retired.
4. `365360`
   - Standalone negative initial of -$3,200 and missing source.
   - Still requires an operator-selected reporting source.

Read-only scanner aggregate:

```text
scannedPayments: 260
exceptionCases: 4
missing_source: 3
negative_initial_payment: 1
multiple_positive_initials: 1
offsetting_initial_chargeback: 1
```

## Completed Local Implementation

- `simpleDealMathService.js`
  - groups successful payments by `domain + caseId`;
  - counts a case as +1, 0, or -1 from net initials;
  - preserves every signed transaction dollar;
  - flags multiple positive initials;
  - treats blank, `ABC`, and `Unknown` sources as missing.
- `simpleMarketingReadService.js`
  - the board and simple nightly email now share one payment rollup;
  - joins `PaymentLedger` to `CaseProfile`;
  - exposes per-source deals, net initials, and total collected.
- `PaymentLedger` and `paymentLedgerRepository`
  - persist an operator-owned `metricsTreatment`;
  - reconciliation cannot overwrite it;
  - the synthetic-to-real promotion path was changed from delete-before-upsert to guarded in-place promotion when exactly one CSV-authoritative successful twin exists.
- `paymentMetricsReviewService.js`
  - discovers the four payment exception shapes;
  - supports `count-one-deal`, `chargeback-pair`, `chargeback-reversal`, and `source-override`;
  - scanner is dry-run first and uses stable review keys;
  - scan payload now carries its date window;
  - resolve re-reads the complete successful case set inside that window and rejects stale identities;
  - treatment must match the exception reason;
  - reopening clears stale resolution data.
- Metrics routes/UI
  - distinct admin-only `resolve-payment` endpoint;
  - payment exception details and treatment form;
  - payment exceptions cannot be ignored in the UI;
  - metrics table includes Deals, Initial $, and Collected with corrected column order.
- Manual and nightly review scans now use all configured domains (`WYNN`, `TAG`, `AMITY`) so they match the `ALL` board.

## Validation At Stop

- Syntax gate over the touched backend/test files: passed.
- Focused metrics tests after interruption: 26/26 passed.
- Full metrics suite before the last interrupted safety pass: 83/83 passed.
- Web-client typecheck after the UI safety changes: passed.
- Focused diff checks: passed, with only normal LF/CRLF warnings.

## Do Not Apply Alerts Yet

Two safety items were identified while wrapping and are not complete enough to permit `--apply`:

1. `logicsPaymentsCsvImportService.js` can still collapse identical CSV rows.
   - It independently `findOne`s by case/amount/date for every CSV row.
   - Two identical $500 rows can both claim the same existing ledger row.
   - Synthetic IDs for identical txn-id-less rows can also collide.
   - Required fix: prefer exact transaction ID; maintain a consumed-candidate set per import; include a deterministic duplicate ordinal in txn-id-less synthetic identity; add a two-identical-row regression test.
2. Payment review fail-closed guards were interrupted before completion.
   - Generic attribution `resolve` and `ignore` must reject `payload.kind === "payment-exception"`.
   - `findCanonicalResolution` must prefer one exact `internalName`/`canonicalKey` match before alias matches. This is required because `Affordability Federal` currently also appears as an alias of `Affordability Federal Snap`.
   - Payment source propagation must write/check `CaseProfile` first, then mirror `MasterProspect`; a failed/missing CaseProfile must not allow the review to be marked resolved.
   - Add focused tests for all three.

Minor test cleanup: in `paymentLedgerMetricsTreatment.test.js`, restore the mocked `PaymentLedger.find` inside the `finally` block, not after it.

## Exact Resume Order

1. Re-read `AGENTS.md`, the project handoff/recovery notes, and the PhoneBurner work order; Phase 9 remains active.
2. Finish the duplicate-safe CSV importer and its regression tests.
3. Finish the three payment-review fail-closed guards above and their tests.
4. Run:

```text
node --test tests/metrics/*.test.js
npm.cmd run typecheck   (from apps/web-client)
git diff --check -- <metrics files only>
```

5. Re-run the read-only scanner:

```text
node scripts/scan-payment-metrics-reviews.js --from 2026-07-01 --to 2026-07-24 --dry-run
```

6. Only after those gates pass, create the four local review alerts:

```text
node scripts/scan-payment-metrics-reviews.js --from 2026-07-01 --to 2026-07-24 --apply
```

7. Do not auto-apply the user rulings. Let the operator form persist them:
   - `394513`: Count as one deal + `Affordability Federal`
   - `409586`: Chargeback pair
   - `220274`: Report as Aged
   - `365360`: Chargeback / reversal + operator-selected source
8. Rebuild/read July through the simple summary and prove source buckets plus unchanged signed totals.
9. Mickey owns any local `Parallel*` restart after review.

