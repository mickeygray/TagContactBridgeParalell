WO-3 - Manual start-next side door          STATUS: DONE

LEDGER: 297 total / 273 pass / 24 skipped -> 295 total / 271 pass / 24 skipped
(expected: comment-disable two dedicated manual-lane tests)
TYPECHECK: `npm.cmd run typecheck --workspace=web-client` -> clean

EVIDENCE:
- Implementation mode changed by Mickey instruction: do not gut/delete yet; comment-disable with
  `WO-3 pending delete` markers and write the replacement disabled state.
- Caller sweep found no script callers. Active source callers were the route/hook/export lane only;
  historical docs still mention the old lane as history/work-order context.
- Focused gate: `node --test tests/cx-bulk-load/cxAccountActiveCallWatcherService.test.js tests/cx-bulk-load/cxBulkLoadRuntimeService.test.js`
  -> 60 pass, 0 fail.
- Full gate: `node --test tests/cx-bulk-load/*.test.js` -> 295 total, 271 pass, 24 skipped, 0 fail.
- Typecheck: `npm.cmd run typecheck --workspace=web-client` -> clean.
- Require sanity: `node -e "require('./packages/shared-services/src'); require('./packages/shared-services/src/cxAccountActiveCallWatcherService'); require('./packages/shared-services/src/cxBulkLoadRuntime'); require('./packages/shared-services/src/cxBulkLoadRuntimeService'); console.log('require-ok')"`
  -> require-ok.
- Whitespace gate: `git diff --check -- <WO-3 files>` -> clean.
- Source kill-set sweep excluding logs/build/dist/node_modules:
  `startCxBulkLoadNextManualCall|manualStartPending|findManualStartedActiveCall|manualDialer|resolveBulkManualDialContext|manualStart|start-next`
  -> 76 raw `rg` hits, 0 live/executable hits after stripping line comments.
- A non-source built asset under `apps/web-client/build` still contains the old compiled UI text/state.
  It is excluded from source evidence and was not modified or deleted.

FILES:
- `apps/control-plane/src/routes/cxBulkLoad.js`
- `apps/web-client/src/lib/api/queries/cxBulkLoad.ts`
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx`
- `packages/shared-services/src/cxAccountActiveCallWatcherService.js`
- `packages/shared-services/src/cxBulkLoadRuntime.js`
- `packages/shared-services/src/cxBulkLoadRuntimeService.js`
- `packages/shared-services/src/index.js`
- `tests/cx-bulk-load/cxAccountActiveCallWatcherService.test.js`
- `tests/cx-bulk-load/cxBulkLoadRuntimeService.test.js`
- `docs/CX_CURRENT_STATE_AUDITOR_GUIDE_2026-06-25.md`
- `docs/CX_BULK_WORKSPACE_POLISH_COMPONENT_PLAN_2026-06-26.md`
- `docs/rewrite-reports/WO-3.md`

WHAT CHANGED:
- The bulk `/start-next` route is no longer registered.
- The web-client no longer exports `useCxBulkLoadStartNext`.
- The old manual-start response/current fields are commented out of the bulk API type.
- The UI no longer disables terminal buttons because a manual-started current is waiting for UII.
- The account watcher no longer augments active calls with phone-only manual-start matches.
- The runtime no longer wires a `manualDialer` adapter or public manual-start wrapper.
- The runtime service no longer exposes the manual-start mutator that staged `current` without RingCX proof.
- The two dedicated positive tests for the banned manual lane are commented out, dropping two pass tests.
- Current docs that listed `start-next` as an active bulk surface now list `get-leads` only.

PENDING DELETE:
- All old manual-lane code is retained in `WO-3 pending delete` comments for one test cycle.
- Once the comment-disabled lane survives the next live/local loop, the pending-delete blocks can be
  physically removed in a later gutting pass.

STOPPED/NOTED:
- No service restart was performed. Running NSSM services will not pick this up until Mickey restarts.
- No live smoke was run for WO-3 yet. The next meaningful test needs a clean CX-side queue and fresh
  bulk batch, because prior reports already showed the local pool was contaminated.
- Historical planning/audit docs still mention `start-next` as something to remove; those were left
  untouched because they are context, not active route documentation.

LIVE HITS:
- Kill-set live/executable hits in source: 0 after stripping JS/TS line comments.
- Raw source hits: 76 by `rg`, all `WO-3 pending delete` comments.
