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

Required report execution closure (the live checkout does not yet contain the
save-before-send scheduler wiring or all of its runtime dependencies):

- `apps/control-plane/src/services/reportScheduleRuntime.js`
- `packages/shared-services/src/reportComposerService.js`
- `packages/shared-services/src/caseListFormatter.js`

Nighttime NCOA handoff (ships as source plus flags, never as a flag-only
change):

- `apps/control-plane/src/server.js`
- `apps/control-plane/src/services/nightlyHygieneRuntime.js`
- `packages/shared-services/src/hourlySweeperService.js`
- `packages/shared-services/src/mailboxIngestService.js`
- `packages/shared-services/src/ncoaMailboxHandler.js`
- `packages/shared-services/src/ncoaMailboxIngestService.js`
- `packages/shared-services/src/nightlyEmergencyCloseService.js`

Tests:

- `tests/metrics/dailyEntry.test.js`
- `tests/metrics/dailyRecordRender.test.js`
- `tests/metrics/dailyReportContract.test.js`
- `tests/metrics/dailyReportFactService.test.js`
- `tests/metrics/entryRange.test.js`
- `tests/metrics/hourlyFloor.test.js`
- `tests/metrics/nightlyHygieneRuntime.test.js`
- `tests/metrics/ncoaMailboxHandler.test.js`
- `tests/metrics/nightlyEmergencyClose.test.js`
- `tests/ncoaMailboxIngestService.test.js`

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
- NCOA opens the shared mailbox in the 19:50 nightly pipeline and no longer has
  an hourly owner. Its handler remains independently gated, cannot arm the
  invoice writer, and counts NCOA-only CSV work so apply cannot be skipped.
- NCOA discovery remains read-only before the apply gate; partial attachment
  failure leaves the message available for retry while per-attachment durable
  dedupe protects completed files.

## Verification completed locally

- `node --check` passed for every patch JavaScript file.
- Focused stored-report contract/entry/fact/renderer tests passed.
- Full `tests/metrics/*.test.js` gate passed before final packaging.
- The focused NCOA handoff/emergency-close gate passed 72/72, including removal of both hourly
  owners, independent flagging, NCOA-only apply, partial-message retry, and the
  read-only discovery gate.
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
2. Install the nighttime NCOA handoff before changing flags. The current live
   checkout still has both old hourly NCOA owners and lacks
   `ncoaMailboxHandler.js`; setting the new flags against that checkout is not a
   valid deployment.
3. Record presence/absence only, never values, for the three flags this patch
   owns. After the source and tests pass, set exactly:
   - `NIGHTLY_HYGIENE_ENABLED=true`
   - `NCOA_MAILBOX_ENABLED=true`
   - `REPORT_SCHEDULER_ENABLED=true`
   Leave `MAIL_INVOICE_MAILBOX_ENABLED` at its prior value. NCOA does not need
   or imply the invoice writer.
4. Verify the single timer owner: nightly hygiene owns report delivery and the
   standalone report timer is surrendered while `NIGHTLY_HYGIENE_ENABLED=true`.
5. Confirm the canonical report definition is enabled, has recipients, is
   unfiltered/all-domain, and remains live-sourced for the nightly email. Do not
   flip an email definition to `renderSource=record` as part of this code patch.
6. Create a timestamped backup of only the existing runtime/config/model files
   listed above, and record which listed files were absent so rollback removes
   only files introduced by this patch.
7. Install only this patch's files and verify their exact hashes.
8. Run `node --check` on every changed JavaScript file and run the ten focused
   test files.
9. Run the full metrics gate.
10. Restart only `parallel-control-plane`.
11. Verify systemd active, control-plane health 200, report runtime enabled,
    exactly one report-delivery owner, the nighttime mailbox task armed for
    NCOA, and no hourly NCOA owner.

No Mongo migration is required. `DailyReportFact.dateKey` already has the unique
index used by the upsert and range reader; capture version 2 is additive and old
documents remain readable with an explicit legacy advisory.

## Rollback

Rollback is file-and-flag scoped:

1. Restore every replaced runtime/config/model file from the timestamped
   backup and remove only patch files recorded as absent before installation.
2. Restore the prior presence/value of `NIGHTLY_HYGIENE_ENABLED`,
   `NCOA_MAILBOX_ENABLED`, and `REPORT_SCHEDULER_ENABLED` without changing any
   unrelated flag.
3. Restart only `parallel-control-plane`.
4. Verify active plus health 200 and the restored scheduler/NCOA owner state.

The patch does not alter report definitions, recipients, or existing Mongo
documents during deployment. Any version-2 documents written before rollback
remain harmless to the prior schema because their additional fields are
additive. NCOA writes retain their existing content-hash dedupe, so a rollback
after a successful nightly attachment does not require data repair.
