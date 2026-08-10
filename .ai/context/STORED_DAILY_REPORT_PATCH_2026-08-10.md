# Stored Daily Report Patch — 2026-08-10

## Outcome

This patch makes the canonical nightly report gather once, stores the same
in-memory day before email delivery, and lets record-sourced definitions render
one or many stored days without re-querying Logics, CallRail, or RingCentral.

The email path remains fail-open with respect to the snapshot: a failed snapshot
is reported and alerted, but it cannot prevent the already-built email from
being sent. A missing or incomplete stored range fails visibly rather than
rendering a confident zero.

## Exact patch scope

Runtime/config/model:

- `packages/shared-config/src/dailyReportContract.js`
- `packages/shared-models/src/DailyReportFact.js`
- `packages/shared-services/src/dailyEntryService.js`
- `packages/shared-services/src/dailyRecordRenderService.js`
- `packages/shared-services/src/dailyReportContract.js`
- `packages/shared-services/src/dailyReportFactService.js`
- `packages/shared-services/src/dailySectionBuilders.js`
- `packages/shared-services/src/dailySnapshotService.js`
- `packages/shared-services/src/reportBlocksService.js`
- `packages/shared-services/src/reportDefinitionService.js`

Tests:

- `tests/metrics/dailyEntry.test.js`
- `tests/metrics/dailyRecordRender.test.js`
- `tests/metrics/dailyReportContract.test.js`
- `tests/metrics/dailyReportFactService.test.js`
- `tests/metrics/entryRange.test.js`

No other dirty worktree file belongs to this patch.

## Hardened behavior

- One canonical vocabulary drives report blocks, stored keys, model fields, and
  range builders.
- Capture format is version 2; older rows are identified and surfaced.
- One-day rendering uses complete detail. Multi-day rendering reads additive
  facts plus only the bounded call-review detail needed by the email.
- Range queries use the indexed `dateKey` interval instead of a large `$in`.
- Ranges are capped at 3,660 days and impossible calendar dates are rejected.
- Missing, degraded, incomplete, and legacy days are surfaced separately.
- Ratios are recomputed from summed parts; non-finite numeric input is ignored.
- Calls are counted across every compatible day while review rows are bounded to
  the five longest linked calls per agent.
- Missing agent-attribution evidence can never merge to a green reconciliation.
- Aggregate call facts and activity facts remain independently owned and cannot
  be erased by a report-only gather.
- Snapshot reruns preserve closed mail spend and mail-piece count while allowing
  event-backed LD/BCD values to refresh; facts and detail remain identical.
- Snapshot persistence happens before send from the same gather. Provider
  acceptance is stamped afterward. Snapshot failure cannot block the email.

## Verification completed locally

- `node --check` passed for every patch JavaScript file.
- Focused stored-report contract/entry/fact/renderer tests passed.
- Full `tests/metrics/*.test.js` gate passed before final packaging.
- A read-only Friday 2026-08-07 real-data dry run completed with all five report
  sections captured, zero missing sections, no degradation, complete report
  coverage, and no Mongo write.

Re-run immediately before deployment:

```powershell
$tests = Get-ChildItem tests\metrics -Filter *.test.js | ForEach-Object FullName
node --test $tests
node scripts/daily-snapshot-dry-run.js 2026-08-07
```

The second command is read-only because its writer is injected; it gathers live
data but does not persist the snapshot.

## Deployment gate

1. Confirm the target checkout is healthy and record the current control-plane
   health result.
2. Confirm `REPORT_SCHEDULER_ENABLED` is true without printing other environment
   values.
3. Determine the single timer owner:
   - if nightly hygiene is enabled, nightly hygiene owns report delivery and the
     standalone report timer remains surrendered;
   - otherwise the standalone report scheduler owns it.
4. Confirm the canonical report definition is enabled, has recipients, is
   unfiltered/all-domain, and remains live-sourced for the nightly email. Do not
   flip an email definition to `renderSource=record` as part of this code patch.
5. Create a timestamped backup of only the ten runtime/config/model files above.
6. Install only this patch's files and verify their exact hashes.
7. Run `node --check` on changed JavaScript and the five focused test files.
8. Run the full metrics gate.
9. Restart only `parallel-control-plane`.
10. Verify systemd active, control-plane health 200, report runtime enabled, and
    exactly one report-delivery owner.

No Mongo migration is required. `DailyReportFact.dateKey` already has the unique
index used by the upsert and range reader; capture version 2 is additive and old
documents remain readable with an explicit legacy advisory.

## Rollback

Rollback is file-scoped:

1. Restore the ten runtime/config/model files from the timestamped backup.
2. Restart only `parallel-control-plane`.
3. Verify active plus health 200 and the same single scheduler owner.

The patch does not alter environment flags, report definitions, recipients, or
existing Mongo documents during deployment, so rollback requires no data repair.
Any version-2 documents written before rollback remain harmless to the prior
schema because their additional fields are additive.
