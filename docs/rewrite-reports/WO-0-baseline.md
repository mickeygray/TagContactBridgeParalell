WO-0 - baseline          STATUS: DONE WITH DIRTY BASELINE NOTED

LEDGER: n/a -> 296 passing cx-bulk-load tests (expected: establish baseline)
TYPECHECK: clean via `npm.cmd run typecheck --workspace=web-client`

EVIDENCE:
- `node --test tests/cx-bulk-load/*.test.js` -> 296 pass, 0 fail.
- `npm.cmd run typecheck --workspace=web-client` -> clean.
- Target line counts:
  - 1691 `packages/shared-services/src/cxBulkLoadRuntime.js`
  - 1235 `packages/shared-services/src/cxBulkLoadRuntimeService.js`
  - 211 `packages/shared-services/src/cxBulkLoadActiveCallWatcher.js`
  - 835 `packages/shared-services/src/cxAccountActiveCallWatcherService.js`
  - 235 `packages/shared-services/src/cxQueueReservationService.js`
  - 786 `packages/shared-repositories/src/cxDialQueueRepository.js`
  - 323 `packages/shared-services/src/cxBulkLoadStateMachine.js`
  - 6824 `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx`
- Working tree was not clean at baseline. Non-app-code docs/instruction changes were already present from the 2026-07-02 instruction update; local runtime logs were also dirty/untracked.

FILES:
- `docs/rewrite-reports/WO-0-baseline.md`

STOPPED/NOTED:
- WO-0 originally says to stop if the tree is dirty. Mickey explicitly directed work to start from the top after adding the no-delete override, so this report records the dirty baseline instead of pretending it was clean.
- App code was not changed during WO-0.

PENDING DELETE:
- none

LIVE HITS:
- n/a
