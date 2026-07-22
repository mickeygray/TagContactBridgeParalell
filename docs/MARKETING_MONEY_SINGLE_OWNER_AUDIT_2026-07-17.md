# Marketing Money Single-Owner Audit ? 2026-07-17

## Ruling

`packages/shared-services/src/marketingMoneyService.js` is the only normal-runtime write boundary for marketing money.

- `SpendEntry` is the cost fact ledger.
- `PaymentLedger` is the revenue fact ledger.
- `MetricsSnapshot`, `CaseProfile`, emails, source panels, and close records are projections. They do not own money.
- Sheet and Logics clients are discovery adapters. They may fetch and normalize facts, but they do not decide financial precedence.

## What was overlapping

1. LD spend was incremented at intake and later recomputed with an exact nightly `SET`.
2. Sheet spend was upserted, but rows removed from the sheet were never removed from totals.
3. Spend sync could be triggered by its timer, the hourly sweep, manual routes, and nightly close. The in-process guard prevented simultaneous calls, but it did not define row lifecycle.
4. Payment event intake and Logics reconciliation could both overwrite the same ledger row. Event intake treated a missing status as `SUCCESS`.
5. Daily and lifetime snapshots summed every payment status, so pending, failed, or reversed transactions could appear as revenue.
6. Legacy backfills write the ledgers directly. They remain migration tools, not runtime owners.

## Implemented ownership contract

### Spend

Every source row receives a stable `entryKey`. A successful complete sheet read is reconciled as one source image:

- present row: upsert and `active=true`;
- row missing from the new image: `active=false`, with `retiredAt`;
- empty parsed image: fail closed rather than retiring the entire source;
- metrics and spend readers include only rows where `active != false`, preserving unstamped legacy rows until reconciliation.

The LD intake incrementer is legacy-only and disabled by default. Exact LD spend is written by the reconciliation materializer.

### Revenue

Logics reconciliation is authoritative and stamps `authoritativeSource=logics-reconcile`. An observed payment event may insert a provisional row, but on an existing row it updates only `lastObservedAt`. Missing event status remains `null`; it is never promoted to success.

Revenue projections include only `transactionStatus=SUCCESS`.

### Read-side money policy

- Metrics source and daily-summary views read spend only from active `SpendEntry` rows.
- Payment dollars, initials, and lifetime paid totals come from successful `PaymentLedger` rows.
- CaseProfile may still supply case/deal counts and attribution context, but its copied payment amounts cannot contribute dollars.
- Legacy spend/metrics fallbacks are hard-gated off.
- Historical manual overlays may preserve non-money lead/count history; their spend contribution is forced to zero.

## Runtime writer map

| Input | Runtime entry | Money owner operation | Authority |
|---|---|---|---|
| Spend sheet | `spendSyncService.syncSheet` | `reconcileSpendSheet` | complete source image |
| LD daily counts | `ldSpendService.materializeLdSpendForDate` | `recordComputedSpend` | exact computed fact |
| Logics payments | `paymentReconcileService` | `reconcilePayment` | authoritative |
| Payment event | `controlPlaneEventService` | `observePayment` | provisional only |
| Legacy import | `metricsBackfillService` / scripts | direct ledger migration | operator-only |

## Projection chain

`discovery adapter -> marketingMoneyService -> SpendEntry / PaymentLedger -> MetricsSnapshot -> panels/emails/closes`

No panel, email, close, or CaseProfile field is allowed to become an alternate financial ledger.

## Deliberately not deleted yet

Per the live WIP deletion guardrail, these are retained but no longer authoritative:

- `incrementSpendEntry` and the realtime LD tick path (hard-gated off by default);
- `upsertPaymentLedger` compatibility alias (routes to authoritative reconciliation);
- direct bulk writes inside explicit legacy backfill tooling;
- multiple calls that trigger the same spend-sync runtime. These are redundant triggers, not separate fact owners, and can be pruned after one close cycle proves reconciliation telemetry;
- disabled CaseProfile/legacy/manual money fallback code, retained for proof-gated deletion.

## Next proof before physical deletion

1. Run one complete spend sync and record active/upserted/retired counts per sheet.
2. Compare ledger totals with the source sheets and successful Logics payments for the same closed day.
3. Rebuild that day's snapshot twice; totals must remain byte-for-byte identical.
4. Confirm no provisional event overwrote a reconciled payment and no inactive spend row appears in panels or close emails.
5. Audit existing duplicate spend identities. After reconciliation clears legacy duplicates, add a unique partial index on `entryKey`.
6. Then remove the legacy LD incrementer and redundant scheduler triggers with Mickey's approval.

## Case discovery and source ownership

Accurate money is downstream of complete case discovery and stable source attribution.
The prior vendor report started with LeadCadence only, then removed untracked source
rows before creating the attachment. A case discovered through Logics status scanning,
MasterProspectIndex, or a later CaseProfile promotion could therefore be absent from a
clean-looking email. An unknown LeadCadence source could also disappear before it ever
reached attribution review.

`marketingCaseDiscoveryService.buildMarketingCaseDiscovery` now owns the daily case
census. For a domain and business date it unions these durable observations by case ID:

- LeadCadence `createdAt` (intake observation);
- MasterProspectIndex `firstSeenAt` (Logics/status observation);
- CaseProfile `caseCreatedDate` (authoritative Logics creation date).

It then hydrates all three records, resolves canonical source evidence once, and emits
explicit coverage: discovered, attributed, unattributed, conflicts, observations by
store, missing LeadCadence, and query truncation. Unknown/conflicting cases are sent to
the existing attribution review instead of being silently discarded.

CaseProfile/SourceCanonical is the durable source attribution authority. Email builders,
payment rollups, and call rollups consume that attribution; they do not independently
invent source labels.

## Live vendor email owner

The scheduled owner is:

`runGroupedNightlyClose -> buildGroupedNightlyPayload -> sendLeadDataCloseEmail`

The standalone `runVendorNightlyEmail` remains a manual/preview compatibility path. It
does not own the scheduled close.

The live lead-data email now uses one discovery result for both the daily summary and
lead detail. It exposes new-case coverage in the body, includes source/provenance fields
in the lead reconciliation CSV, and receives WYNN-only month-to-date source rows from
