WO-1 - Green-first-touch BULK path only          STATUS: DONE

LEDGER: 296 -> 272 pass + 24 skipped (expected: skip 24 dedicated green-first-touch tests)
TYPECHECK: n/a (no web-client files touched)

EVIDENCE:
- Baseline before WO-1: `node --test tests/cx-bulk-load/*.test.js` -> 296 pass, 0 fail.
- Expected delta declared by WO-1: skip `cxGreenFirstTouchSupplyService.test.js` (7 tests), `cxGreenFirstTouchQueueMaterializerService.test.js` (10 tests), and `cxDialQueueRepositoryFirstTouch.test.js` (7 tests), total 24 skips.
- Gate after WO-1: `node --test tests/cx-bulk-load/*.test.js` -> 296 total, 272 pass, 24 skipped, 0 fail.
- Barrel/runtime sanity: `node -e "require('./packages/shared-services/src'); require('./packages/shared-services/src/cxBulkLoadRuntime'); require('./packages/shared-services/src/cxBulkLoadRuntimeService'); console.log('require-ok')"` -> require-ok.
- Whitespace gate: `git diff --check -- <WO-1 files>` -> clean.
- DONE grep raw command: `rg -n "cxGreenFirstTouch|CX_GREEN_FIRST_TOUCH|greenCoverageBatchId|firstTouchOnly|firstTouchAttempts|firstTouchMaxAttempts|applyFirstTouchClaimFilter|countReadyFirstTouchRows|normalizeFirstTouchSupplyPlan|firstTouchReleasePatch" packages apps scripts -g '!logs/**'` -> 71 raw hits, all inside WO-1 pending-delete comment blocks or commented disabled wiring.
- DONE grep executable check: same kill-set regex after stripping JS/TS comments from `packages apps scripts` -> 0 live/executable hits.
- Leave-alone grep: `rg -c "firstTouchEligible" packages apps` -> total 33 before, total 33 after; files unchanged.
- Local smoke after Mickey restarted `ParallelControlPlane`: session `cxbl-da4e2056-a6d8-4041-bf24-8796b01fbd57` advanced through two terminal outcomes (`voicemail`, `did_not_connect`), current cleared, phase returned to `ready`, buffer moved 10 -> 8, and both terminal outbox rows drained. RingCX active-call read showed 0 active `cxbl-*` calls afterward.

FILES:
- `packages/shared-services/src/cxGreenFirstTouchSupplyService.js`
- `packages/shared-services/src/cxGreenFirstTouchQueueMaterializerService.js`
- `packages/shared-services/src/index.js`
- `packages/shared-repositories/src/cxDialQueueRepository.js`
- `packages/shared-services/src/cxQueueReservationService.js`
- `packages/shared-services/src/cxBulkLoadRuntimeService.js`
- `packages/shared-services/src/cxBulkLoadRuntime.js`
- `tests/cx-bulk-load/cxGreenFirstTouchSupplyService.test.js`
- `tests/cx-bulk-load/cxGreenFirstTouchQueueMaterializerService.test.js`
- `tests/cx-bulk-load/cxDialQueueRepositoryFirstTouch.test.js`
- `tests/cx-bulk-load/cxQueueReservationService.test.js`
- `tests/cx-bulk-load/cxBulkLoadRuntimeService.test.js`
- `docs/rewrite-reports/WO-1.md`

STOPPED/NOTED:
- The live queue policy concept `firstTouchEligible` was intentionally untouched.
- Mickey's local-state idea is compatible with this cut: if a future test needs a yellow stack to behave like first-touch for assignment/projection, mutate that test pool in local/in-memory state only and do not write synthetic first-touch markers back to Mongo.
- No service restart was performed. Running NSSM processes will not pick up this code until Mickey restarts the relevant local service.
- Smoke note: several remaining claimed rows still carry old `terminalOutcome` metadata from prior history. They are not `ready` rows and did not block this polling smoke, but use a rebuilt clean batch before judging deeper terminal/refill behavior.

PENDING DELETE:
- `packages/shared-services/src/cxGreenFirstTouchSupplyService.js`: entire historical implementation retained as `WO-1 pending delete`; live export is inert.
- `packages/shared-services/src/cxGreenFirstTouchQueueMaterializerService.js`: entire historical implementation retained as `WO-1 pending delete`; live export is inert.
- `packages/shared-services/src/index.js`: green-first-touch barrel imports/exports commented as `WO-1 pending delete`.
- `packages/shared-repositories/src/cxDialQueueRepository.js`: first-touch claim filter/count implementation and export commented as `WO-1 pending delete`.
- `packages/shared-services/src/cxQueueReservationService.js`: first-touch release accounting and reserve-option forwarding commented as `WO-1 pending delete`.
- `packages/shared-services/src/cxBulkLoadRuntimeService.js`: first-touch plan normalization and reserve-option forwarding commented as `WO-1 pending delete`.
- `packages/shared-services/src/cxBulkLoadRuntime.js`: planner import/config injection commented as `WO-1 pending delete`.
- Dedicated green-first-touch test suites are `test.skip` with WO-1 markers pending permanent deletion or replacement.

LIVE HITS:
- Kill-set live/executable hits: 0 after stripping JS/TS comments.
- Raw kill-set grep hits: 71, all pending-delete/commented disabled code.
- `firstTouchEligible` live policy hits: 33, unchanged and intentional.
