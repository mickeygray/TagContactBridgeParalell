WO-2 - Adoption path          STATUS: DONE

LEDGER: 296 total / 272 pass / 24 skipped -> 297 total / 273 pass / 24 skipped (expected: +1 shared negative pin)
TYPECHECK: n/a (no web-client files touched)

EVIDENCE:
- Expected delta declared before the full gate: add one shared negative pin in `cxAccountActiveCallWatcherService.test.js`; keep the 24 WO-1 skips.
- Focused gate after mechanical cleanup: `node --test tests/cx-bulk-load/cxAccountActiveCallWatcherService.test.js tests/cx-bulk-load/cxBulkLoadRuntimeService.test.js` -> 62 pass, 0 fail.
- Full gate: `node --test tests/cx-bulk-load/*.test.js` -> 297 total, 273 pass, 24 skipped, 0 fail.
- New shared negative pin: `WO-2 injected external candidates are ignored by the account watcher` proves an injected resolver is not called, no external-only candidate is promoted, no serving stamp is attempted, and no session write happens.
- Require sanity: `node -e "require('./packages/shared-services/src/cxAccountActiveCallWatcherService'); require('./packages/shared-services/src/cxBulkLoadRuntime'); require('./packages/shared-services/src/cxBulkLoadRuntimeService'); console.log('require-ok')"` -> require-ok.
- Whitespace gate: `git diff --check -- <WO-2 files>` -> clean.
- DONE grep raw package/app command: `rg -n "markAdoptedCandidateServing|resolveExternalCandidates|ringcx-active-external-id" packages apps -g '!logs/**'` -> 10 raw hits, all WO-2 pending-delete comments.
- DONE grep executable check: same kill-set regex after stripping JS/TS comments from `packages apps` -> 0 live/executable hits.
- Whole-context raw sweep: `rg -n "markAdoptedCandidateServing|resolveExternalCandidates|ringcx-active-external-id" packages apps scripts tests docs -g '!logs/**'` -> 30 raw hits, including historical docs/script mentions and the new test pin.
- Local smoke after Mickey restarted `ParallelControlPlane`: CX advanced away from the bulk list and presented active call `parallel:WYNN:131242:6a424b7774fd3164e89339ed` (Jennie Davis), not a `cxbl-*` row. The app did not adopt it as current, which is the intended WO-2 behavior. Peggy Miller and Michelle Wilson remained bulk-session rows with no UII/current stamp, confirming the missed Michelle match was not an adoption failure; CX was serving non-bulk inventory.

FILES:
- `packages/shared-services/src/cxAccountActiveCallWatcherService.js`
- `packages/shared-services/src/cxBulkLoadRuntime.js`
- `packages/shared-services/src/cxBulkLoadRuntimeService.js`
- `packages/shared-services/src/cxStaleServingReconcilerService.js`
- `tests/cx-bulk-load/cxAccountActiveCallWatcherService.test.js`
- `docs/rewrite-reports/WO-2.md`

STOPPED/NOTED:
- Initial focused run failed because two log payload fields still referenced the removed `adopted` local and the new test read `result.plan.summary` instead of the top-level `result.summary`. Both were corrected before the focused/full gates passed.
- `cxStaleServingReconcilerService.js` was touched only to reword a historical comment naming the removed runtime method; no logic changed there.
- Docs and scripts still contain historical adoption-analysis mentions; they are not runtime live hits and are listed under LIVE HITS rather than edited in this order.
- No service restart was performed. Running NSSM processes will not pick up this code until Mickey restarts the relevant local service.
- Smoke note: the old yellow test session is contaminated for deeper loop testing. Several rows carry stale `terminalOutcome`/`long-call-hold-timeout` metadata, and RingCX fell through to a non-bulk `parallel:*` lead. Drain CX and rebuild a fresh batch before judging terminal/refill behavior.

PENDING DELETE:
- `packages/shared-services/src/cxBulkLoadRuntime.js`: `markAdoptedCandidateServing` retained in a WO-2 pending-delete comment block; runtime no longer exposes it.
- `packages/shared-services/src/cxBulkLoadRuntime.js`: hard-coded `resolveExternalCandidates: null` wiring commented as WO-2 pending delete.
- `packages/shared-services/src/cxBulkLoadRuntimeService.js`: `resolveExternalCandidates` dependency and watcher pass-through commented as WO-2 pending delete.
- `packages/shared-services/src/cxAccountActiveCallWatcherService.js`: external candidate pool/resolver/reproject plumbing and adopted-serving branch commented as WO-2 pending delete.

LIVE HITS:
- Kill-set live/executable hits in `packages apps`: 0 after stripping JS/TS comments.
- Raw package/app hits: 10, all WO-2 pending-delete comments.
- Raw whole-context hits: 30, including historical docs/script/test references; no executable runtime dependency remains.
