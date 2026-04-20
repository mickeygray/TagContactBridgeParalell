# Logics Status Scan Plan

This document captures the first control-plane implementation plan for the
daily Logics catch-all scan.

## Position

`5001` should own the heavy daily reconciliation loop.

It should not depend on live call traffic alone to discover prospect changes,
conversions, or inactive outcomes.

## Intended Core Loop

1. For each configured status id bucket, call `Case/GetCasesByStatus`
2. Compare returned case ids to `MasterProspectIndex`
3. If a case disappeared from a prospect bucket, call `Case/CaseInfo`
4. Decide whether the case is:
   - still a prospect in a different bucket
   - converted and should be upgraded into `CaseProfile`
   - bad/inactive and should be deactivated or archived
5. For changed or promoted cases only, call:
   - `Billing/CasePayment`
   - `Billing/CaseInvoice`
   - `Billing/CaseBillingsummary`
6. Materialize:
   - `MasterProspectIndex`
   - `PaymentLedger`
   - `CaseProfile` when conversion/client evidence exists

## Current Tenant Reality

Live Logics smoke checks on April 17, 2026 changed the near-term plan:

- `Case/CaseInfo` works on TAG and WYNN
- `Case/CaseStatusInfo` works on TAG and WYNN
- `Find/FindCaseByPhone` works on TAG and WYNN
- `CaseActivity/Activity` works on TAG and WYNN
- `Billing/CaseBillingSummary` works on TAG and WYNN
- `Case/GetCasesByStatus` currently returns route-level `404` on both tenants
- `Billing/CasePayment` currently returns `Resource not found!` on both tenants
- `Billing/CaseInvoice` currently returns `Resource not found!` on both tenants

That means the intended status-bucket sweep is still the right long-term model,
but the immediate `5001` implementation has to be capability-aware.

## Interim Reconciliation Strategy

Until `GetCasesByStatus` and the billing detail routes are confirmed on these
tenants, `5001` should do this:

1. Keep `MasterProspectIndex` fed from lead-contact, mailer uploads, manual CSV
   imports, call sourcing, and unmatched-but-resolved phone events
2. Run daily `CaseInfo` refresh on tracked prospects and recently touched cases
3. Use status drift from `CaseInfo` to:
   - keep prospects shallow
   - upgrade converted cases into `CaseProfile`
   - deactivate bad/inactive outcomes
4. Use `Billing/CaseBillingSummary` as the available aggregate financial signal
5. Defer invoice-based cleaner rules and payment-ledger materialization until
   those tenant routes are verified or replaced

## Why This Still Works

- `GetCasesByStatus` gives a lightweight control-plane scan
- `CaseInfo` confirms source/status drift before acting
- `PaymentLedger` stays normalized
- `CaseProfile` only grows for real converted/enriched cases
- `LeadCadence` remains the outreach workflow layer

## Current Direction

- real-time loops still matter for call/source/contact matching
- daily status scanning is the catch-all repair and upgrade path
- manual CSV imports remain a gap-fill tool, not the primary truth path
