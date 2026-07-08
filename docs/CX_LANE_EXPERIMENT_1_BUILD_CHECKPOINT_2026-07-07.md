# CX Lane Experiment 1 Build Checkpoint - 2026-07-07

This is the Codex build checkpoint for `docs/CX_LANE_EXPERIMENT_1_INTERRUPT_2026-07-08.md`.

## Implemented / Tightened

- `/api/cx/bulk-load/lane-call` reads the in-memory lane-call registry for the logged-in agent.
- The account active-call watcher recognizes only UII-bearing `cxft-*` and `cxapt-*` active calls.
- `cxbl-*` remains the bulk session's job and does not trigger the lane modal.
- Lane extern parsing is structured through `parseLaneExternId`, not ad hoc string splitting.
- The client polls the lane-call route and renders a non-blocking top modal.
- First-touch lane modal uses the emerald treatment; appointment lane modal uses the sky treatment.
- The modal text explicitly says no lane wrap card is expected in this serving-only test.
- `scripts/cx-lane-drill.js` refuses the interrupt drill unless first-touch and appointment maps are Mickey-only.
- `scripts/cx-campaign-map.js` has the fixed first-touch/new-lead matcher.

## Verification

```powershell
node --test tests/cx-bulk-load/cxLaneDispatch.test.js
```

Result: 11 pass, 0 fail.

```powershell
node --test tests/cx-bulk-load/cxDeleteRunFleet.test.js tests/cx-bulk-load/cxLaneDispatch.test.js tests/cx-bulk-load/cxAccountActiveCallWatcherService.test.js tests/cx-bulk-load/cxBulkLoadRuntimeService.test.js tests/cx-bulk-load/cxCallWrapCardService.test.js tests/cx-bulk-load/cxServerWireAudit.test.js
```

Result: 97 pass, 0 fail.

```powershell
node --check packages/shared-services/src/cxLaneRegistry.js
node --check packages/shared-services/src/cxLaneCallRegistry.js
node --check packages/shared-services/src/cxAccountActiveCallWatcherService.js
node --check scripts/cx-lane-drill.js
node --check scripts/cx-campaign-map.js
node --check apps/control-plane/src/routes/cxBulkLoad.js
node --check apps/control-plane/src/server.js
npm.cmd run typecheck --workspace=web-client
npm.cmd run build --workspace=web-client
```

Result: all passed.

## Still Not Proven

- Real RingCX campaign delivery for the lane calls.
- Real modal timing in the browser against live UII snapshots.
- Live Mongo state cleanup after `scripts/cx-lane-drill.js --cleanup <tag>`.
- F2 consumption: lane terminal observation, wrap cards, and lane flag release are explicitly not built in this slice.
