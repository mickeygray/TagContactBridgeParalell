# CX Legacy Hangover Delete Ledger - 2026-07-07

Purpose: capture the old CX/bulk-load machinery that should move to attic or be deleted after proof. This is a delete map, not a delete patch. Do not remove these in one sweep; retire one slice, pin the replacement, run the named gate, then commit.

## Rules Before Deleting

- Keep Mickey's rule: no service restart from Codex. If a cut needs `ParallelControlPlane` or `ParallelRingCentralCx` restarted, Mickey does it.
- Respect the attic model in `docs/CX_BULK_LOAD_REWRITE_WORK_ORDERS_2026-07-02.md`: old code moves out of active files only after negative pins or proof.
- Do not delete shared RingEX, Logics, or queue primitives just because bulk no longer wants them. Delete only the bulk/CX coupling or the legacy fallback named here.
- `get-leads` is the survivor hatch. Do not remove it with the manual-dial remnants.

## Current Proof Snapshot

- WO-1/2/3 are already moved to attic: `attic/green-first-touch-supply.attic.md`, `attic/adoption-path.attic.md`, `attic/manual-dial-lane.attic.md`.
- Wrap drill tag `20260707003153` proved: terminal rows drained, DNC status accepted, correction row inserted, correction drained, queue row stamped `dnc`.
- Same drill also proved the live hook is not yet cut over: `CX_CALL_WRAP_QUEUE_ENABLED` was off, so the legacy drain summary path won the thread key and wrap-card interview writes deduped.

## Progress (Fable, 2026-07-07 ~01:30 — working the suggested order, gate 309/309)

- ✅ **Order 1 / Item 2 DONE:** `markAdoptedCandidateServing` removed from the alpha-watch
  MEANINGFUL regex (comment points at attic/adoption-path.attic.md). Stale-docs sweep ran:
  every remaining `/start-next`-as-active mention lives in DATED historical docs (the 06-25
  audit guide, the 07-01 finish plan) — archaeology, not live claims; left untouched by the
  attic model's own logic.
- ✅ **Order 2 / Item 10 now-half DONE:** the runtime-SERVICE DISPTRACE copy (factory + 15
  `_step` statements through submitCxBulkLoadDisposition) and the flow-trace console mirror
  + `CX_BULK_LOAD_FLOW_TRACE`/`_AGENT` knobs are OUT (attic/wo30-disptrace-flowtrace.attic.md
  with revive instructions). WO-30 DONE-WHEN checks pass: 0 DISPTRACE hits in the service
  file, 0 flow-trace hits in packages/apps; the RUNTIME's DISPTRACE survives untouched per
  the dividing line. traceBulkFlow still emits the full cx.alpha.bulk.* channel.
- ⏳ **Items 4/5/6 are ONE ceremony from their triggers:** flag `CX_CALL_WRAP_QUEUE_ENABLED=true`
  + Mickey restarts + `node scripts/cx-wrap-drill.js --arm` → the "cards minted by the LIVE
  drain hook" PASS is the shared trigger. Drill tag 20260707003153 already proved everything
  downstream of the hook (DNC status, correction drained, dnc stamped).
- ⏸ Items 1 (tripwire), 3 (EX ownership / WO-28), 7 (banner plumbing / WO-16), 8 (WO-22),
  9 (floor acceptance) — triggers not met; untouched per the ledger's own rules.

## Progress (Codex, 2026-07-07 least-risk cut pass)

- DONE: `/cx/prep` now shows the same navbar CX controls as `/cx`; this was the pre-test
  visibility fix, not a behavior rewrite.
- DONE: removed the old page-level break strip from `CXWorkspaceBulkLoad.tsx`. The live
  `BreakResumePrompt`, timed-break resume path, and navbar availability controls remain.
- DONE: removed the disabled simple-loop client harness from the bulk workspace and removed
  the now-orphaned simple-loop client API hooks. The shared service/model tests remain for
  archaeology until the service bundle is deliberately deleted.
- DONE: removed the orphan slow-single client API hooks and tombstoned `/api/cx/slow-single`
  with `410 cx-slow-single-retired`.
- DONE: tombstoned `/api/cx/simple-loop` with `410 cx-simple-loop-retired` after updating
  the stale Mickey test script instruction that still referenced `?cxSimpleLoop=1`.
- Outcome note: `docs/CX_DELETE_RUN_FLEET_OUTCOMES_2026-07-07.md`.
- Validation run:
  - `node --test tests/cx-bulk-load/cxDeleteRunFleet.test.js`
  - `npm.cmd run typecheck --workspace=web-client`
  - `node --test tests/cx-bulk-load/cxBulkLoadRuntimeService.test.js tests/queue/cxWorkspacePresenceHeal.test.js tests/queue/cxManualUnavailableRelease.test.js`
  - `node --test tests/cx-bulk-load/cxServerWireAudit.test.js tests/cx-simple-loop/cxSimpleCallLoopService.test.js`
  - route syntax checks for both tombstone route files
- Stop point: legacy queue auto-serve, auto-review, wrap cutover, EX ownership, and
  appointment-wrap cuts are still direct-path or trigger-gated. Do not batch them into this
  cleanup pass.

## Second-Pass Gotchas (Codex, 2026-07-07 Navbar/Break Sweep)

These are not all delete-now items. They are places where old code can still mislead testing, hide a new UI change, or leave a callable side door after the visible CX rail has moved to bulk.

### A. `/cx/prep` Mounts Bulk Workspace But Hides Navbar CX Controls

Current refs:
- `apps/web-client/src/app/routes.tsx:193` mounts `CXShell` at `/cx`.
- `apps/web-client/src/app/routes.tsx:206` through `219` mounts the same `CXWorkspace` under `/cx/prep`.
- `apps/web-client/src/app/CXShell.tsx:30` only shows `CxConnectButton` and `CxAvailabilityToggle` on exact `/cx` or `/cx/`.

Why gotcha:
- The navbar break buttons can be correctly built and bundled, but still invisible if the agent lands on `/cx/prep`.
- This looks like a failed frontend patch even though the route shell is hiding the controls.

Safe next step:
- If `/cx/prep` is still a real agent workspace entry, include it in `showCxControls`.
- Do not broaden this to every `/cx/*` route unless inbox/calls/coach/manual should also show dialing controls.

### B. Old Page-Level Break Strip Is Hidden, Not Removed

Current refs:
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:5418` wraps the old sticky break strip in `{false ? (...) : null}`.
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:5425` through `5465` still contains the old `Resume`, `5 min`, and `15 min` page-level controls.
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:5377` through `5398` still computes values mostly for that hidden strip.

Why gotcha:
- It does not render, but stale strings and stale availability plumbing remain in the biggest file in the app.
- Future grep/debug can point at the dead strip and make it look like the live break UI still lives inside the workspace body.

Safe next step:
- After the navbar break controls pass one local visual/live-state test, remove only the dead strip and any variables used exclusively by it.
- Keep `BreakResumePrompt`, timed-break resume logic, and the underlying set-status/resume behavior until the navbar path fully owns the same behavior.

### C. Simple-Loop Harness Is UI-Dead But Still In The Bulk File

Current refs:
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:236` defines `SimpleLoopTestPanel`.
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:3503` hard-sets `simpleLoopPanelEnabled = false`.
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:3508` through `3513` still creates simple-loop query/mutation hooks.
- `apps/web-client/src/lib/api/queries/cx.ts:150` through `198` still exports simple-loop client hooks.
- `apps/control-plane/src/server.js:1743` still mounts `/api/cx/simple-loop`.
- `packages/shared-services/src/cxSimpleCallLoopService.js:105` defaults `CX_SIMPLE_LOOP_ENABLED` false, so the service is normally disabled but still present.

Why gotcha:
- The visible query-param harness is dead now, but the code remains in the active workspace and the backend route remains mounted.
- A stale script or env flip can still hit the old rail and create confusing test evidence.

Safe next step:
- Remove the panel and client hooks from `CXWorkspaceBulkLoad.tsx` first.
- Leave or tombstone the backend route separately after checking scripts/tests that intentionally use `CX_SIMPLE_LOOP_ENABLED`.

### D. Slow-Single UI Is Gone, Backend Route Still Mounted

Current refs:
- `apps/web-client/src/workspaces/cx/slow-single/CXWorkspaceSlowSingle.tsx` is deleted in the current WIP.
- `apps/web-client/src/workspaces/cx/CXWorkspaceRouter.tsx` unconditionally returns `CXWorkspaceBulkLoad`.
- `apps/web-client/src/lib/api/queries/cxSlowSingle.ts` still defines slow-single hooks.
- `apps/control-plane/src/server.js:1744` still mounts `/api/cx/slow-single`.
- `packages/shared-services/src/cxSlowLaneService.js` still contains the slow-single state machine.

Why gotcha:
- No visible route should reach slow-single, but the server route is still callable.
- Unlike simple-loop, this route is not obviously protected by a single default-off env flag in the route layer.

Safe next step:
- If slow-single is truly retired, convert `/api/cx/slow-single/*` to an explicit 410/tombstone or move the route behind a deliberately named env gate before deleting the service.
- Do not delete the shared RingCX lead-publishing primitive with it; bulk still uses that class of publisher.

### E. Legacy Queue Plumbing Is Constant-Off But Still Interleaved

Current refs:
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:3497` sets `legacyQueueEnabled = false`.
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:3498` still calls `useCxCallQueue(domain, legacyQueueEnabled)`.
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:3499` through `3502` keeps `refetchLegacyQueue` as a no-op wrapper.
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:4757` still branches on the disabled legacy queue.

Why gotcha:
- This is currently inert, but it keeps the old queue vocabulary in the live bulk file.
- It can waste debugging time when a tester is trying to prove the bulk session and RingCX pool, not the old local queue.

Safe next step:
- Remove after simple-loop panel removal, because both are part of the same "old workspace rails inside the bulk file" cleanup.

### F. Control-Plane App Serves Built Web Bundle, Not Vite Source

Current refs:
- `apps/control-plane/src/server.js:519` uses `apps/web-client/build`.
- `apps/control-plane/src/server.js:530` serves that build with `express.static`.
- `apps/control-plane/src/server.js:1798` attaches the static web build after API routes.
- `apps/web-client/.gitignore:2` ignores `build`.

Why gotcha:
- `3001` can show current source while `5001`/ngrok/control-plane still shows the previous built bundle.
- This was the reason a navbar source change could exist but not appear in the app until `npm run build --workspace=web-client` regenerated `apps/web-client/build`.

Safe next step:
- Treat any frontend UI patch as two checks: source/typecheck, then web-client build if the app is being viewed through control-plane/ngrok/static.

### G. EX Lead-Serving Gates Still Exist Under Availability/Load-Balancer

Current refs:
- `packages/shared-services/src/agentAvailabilityService.js:36` defines `isExLeadServingGateEnabled`.
- `packages/shared-services/src/agentAvailabilityService.js:613` can derive `ex-busy`.
- `packages/shared-services/src/agentAvailabilityService.js:655` can mark fresh-lead gating as `ex-call`.
- `packages/shared-services/src/cxLoadBalancerService.js:314` can block eligibility on an active EX call when the EX gate is enabled.

Why gotcha:
- The default env appears off, and cx-runtime suppression exists, so this is not automatically a live bug.
- It is still the same old conceptual coupling: EX state can influence CX lead serving if the gate is enabled or called without cx-only suppression options.

Safe next step:
- Before deleting, confirm which production/local envs set `RC_CX_EX_BUSY_GATE_ENABLED`.
- For bulk, prefer an explicit cx-runtime mode option over relying on global defaults.

## Final Excision Pre-Test Cut Map (Codex, 2026-07-07)

Purpose: this is the exact cut list to review before the next local proof run. It traces both sides of each old lane. Do not apply all of this as one giant patch; cut one slice, run typecheck/tests/build, then test the app.

### 0. Visibility Fix, Not Excision: `/cx/prep` Hides New Navbar Controls

Trace:
- `apps/web-client/src/app/routes.tsx:193` mounts `CXShell` under `/cx`.
- `apps/web-client/src/app/routes.tsx:206` through `220` mounts the same `CXWorkspace` under `/cx/prep`.
- `apps/web-client/src/app/CXShell.tsx:30` sets `showCxControls` to exact `/cx` or `/cx/`.
- `apps/web-client/src/app/CXShell.tsx:70` through `76` renders `CxConnectButton` and `CxAvailabilityToggle` only if `showCxControls`.

Pre-test fix:
- Change `apps/web-client/src/app/CXShell.tsx:30` so `/cx/prep` also shows the controls, if `/cx/prep` remains a real agent entry route.
- Keep the fix narrow. Do not show dial/break controls on `/cx/inbox`, `/cx/call-library`, `/cx/coach`, or `/cx/manual` unless that is a deliberate product decision.

### 1. Client Simple-Loop Harness: First Client-Side Cut

Trace:
- UI slab: `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx`.
- Client hooks: `apps/web-client/src/lib/api/queries/cx.ts`.
- Server mount: `apps/control-plane/src/server.js`.
- Route adapter: `apps/control-plane/src/routes/cxSimpleLoop.js`.
- Shared service/model/tests/scripts: `packages/shared-services/src/cxSimpleCallLoopService.js`, `packages/shared-models/src/CxSimpleLoopSession.js`, `tests/cx-simple-loop/cxSimpleCallLoopService.test.js`, `scripts/mickey-test-queue.js`, `scripts/local-ordered-mickey-bulk-load.js`.

Client cut set:
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:61` through `66`: remove `useCxSimpleLoop*` imports.
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:71`: remove `CxSimpleLoopSession` type import.
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:194` through `234`: remove `describeSimpleLoopCurrent`, `SimpleLoopDisposition`, `describeSimpleLoopMatch`, `describeSimpleLoopLastCompleted`.
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:236` through `424`: remove `SimpleLoopTestPanel`.
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:3503` through `3575`: remove the hard-off simple-loop state, hooks, busy flag, mirror watcher, and polling effect.
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:4313` through `4409`: remove `currentSimpleLoopSessionId`, `runSimpleLoopAction`, `handleSimpleLoopStart`, `handleSimpleLoopStartAndDial`, `handleSimpleLoopAdvance`, `handleSimpleLoopDisposition`, `handleSimpleLoopSkip`, and `handleSimpleLoopKill`.
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:5478` through `5499`: remove the disabled panel render.
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:4786`, `4868`, and `5079`: remove the remaining `simpleLoopPanelEnabled` guards/dependency once the variable is gone.

Client API cleanup after the bulk file no longer imports these:
- `apps/web-client/src/lib/api/queries/cx.ts:97` through `140`: remove `CxSimpleLoopCandidate` and `CxSimpleLoopSession` if there are no other client imports.
- `apps/web-client/src/lib/api/queries/cx.ts:142` through `198`: remove `simpleLoopQueryKey`, `invalidateSimpleLoop`, `useCxSimpleLoopSession`, `buildCxSimpleLoopCommandHook`, and all five exported command hooks.

Server follow-up:
- `apps/control-plane/src/server.js:30`: remove `createCxSimpleLoopRouter` import.
- `apps/control-plane/src/server.js:1743`: remove or tombstone the `/api/cx/simple-loop` mount.
- `apps/control-plane/src/routes/cxSimpleLoop.js:1` through `67`: delete the route file only after no scripts/tests intentionally use it, or replace it with a 410 tombstone.
- `packages/shared-services/src/index.js:269` through `277` and `1138` through `1155`: remove simple-loop imports/exports after the route is gone.
- `packages/shared-services/src/cxSimpleCallLoopService.js`: delete after route exports are gone. Important functions currently exported at `1453` through `1462`.
- `packages/shared-models/src/CxSimpleLoopSession.js` and `packages/shared-models/src/index.js:19`, `71`, `129`: remove only after old `cxsimpleloopsessions` data no longer needs app-level tooling.

Validation:
- `rg -n "simpleLoopPanelEnabled|SimpleLoopTestPanel|useCxSimpleLoop|CxSimpleLoopSession|cxSimpleLoop|simple-loop" apps/web-client/src apps/control-plane/src packages/shared-services/src packages/shared-models/src scripts tests`
- Expected after full cut: no active source hits except historical docs or explicit tombstone tests.

### 2. Slow-Single Server Rail: Tombstone Before Delete

Trace:
- UI file is already gone: `apps/web-client/src/workspaces/cx/slow-single/CXWorkspaceSlowSingle.tsx` is deleted in this WIP.
- Router is one-lane: `apps/web-client/src/workspaces/cx/CXWorkspaceRouter.tsx` returns `CXWorkspaceBulkLoad`.
- Client hooks still exist: `apps/web-client/src/lib/api/queries/cxSlowSingle.ts`.
- Server mount still exists: `apps/control-plane/src/server.js:31` and `1744`.
- Route adapter: `apps/control-plane/src/routes/cxSlowSingle.js`.
- Shared service/repository/model: `packages/shared-services/src/cxSlowLaneService.js`, `packages/shared-services/src/cxSlowLaneStateMachine.js`, `packages/shared-repositories/src/cxSlowLaneSessionRepository.js`, `packages/shared-models/src/CxSlowLaneSession.js`.

Cut/tombstone set:
- Delete `apps/web-client/src/lib/api/queries/cxSlowSingle.ts:1` through `93` after confirming no client imports remain.
- `apps/control-plane/src/server.js:31`: remove `createCxSlowSingleRouter` import.
- `apps/control-plane/src/server.js:1744`: remove or tombstone `/api/cx/slow-single`.
- `apps/control-plane/src/routes/cxSlowSingle.js:1` through `59`: delete after mount is removed, or leave as explicit 410 if stale callers are likely.
- `packages/shared-services/src/index.js:282` through `289` and `1143` through `1155`: remove slow-single imports/exports.
- `packages/shared-services/src/cxSlowLaneService.js`: exported functions to remove are `confirmCxSlowSingleCurrent`, `getCxSlowSingleSession`, `killCxSlowSingleSession`, `normalizeSlowSingleOutcome`, `startCxSlowSingleCall`, and `submitCxSlowSingleOutcome` at `1014` through `1020`.
- `packages/shared-services/src/cxSlowLaneStateMachine.js`, `packages/shared-repositories/src/cxSlowLaneSessionRepository.js`, and `packages/shared-models/src/CxSlowLaneSession.js`: delete only after the route/service export cut passes and no admin cleanup tooling needs old slow-lane sessions.

Validation:
- `rg -n "cxSlowSingle|CxSlowSingle|slow-single|cxSlowLane|CxSlowLaneSession|CX_SLOW" apps packages scripts tests`
- Expected after full cut: no active source hits except historical docs or tombstones.

### 3. Legacy Queue Auto-Serve Inside Bulk Workspace: Largest Client Cut

Trace of the old path:
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:3498` calls `useCxCallQueue(domain, false)`.
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:4756` through `4759` builds `rawQueueItems` from `callQueue.data` or `data.callQueue`.
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:4965` through `5023` builds old `queueItems`.
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:4620` through `4705` has `handleSelectFromQueue`, which can call `useCxDialAny`/`useCxSimulateCallAny`.
- `apps/web-client/src/lib/api/queries/cx.ts:739` through `775` defines `useCxDialAny` and `useCxSimulateCallAny`.
- `apps/control-plane/src/routes/commandsCx.js:292` through `307` maps `/api/commands/cx/:domain/dial` to `requestCxDial`.
- `apps/control-plane/src/routes/commandsCx.js:458` through `475` also uses `requestCxDial` for appointment call-now. That route is not bulk dead code; do not delete it globally.

Bulk-workspace cut set:
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:43`: remove `useCxCallQueue` import.
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:50`, `51`, `67`: remove `useCxDialAny`, `useCxDisposition`, `useCxSimulateCallAny` if no non-legacy references remain after this cut.
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:426` through `453`: remove `contactFromQueue` and `buildQueueDialRequest` if no later queue path remains.
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:582` through `598`: remove `AUTO_SERVE_*` and `AUTO_SERVE_BLOCKED_AGENT_STATES` if no old auto-serve effects remain.
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:815` through `833`: remove `buildQueueItemKey` and `getQueueItemSuppressionKeys` after old queue suppression is gone.
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:3251` through `3260`: remove old served-queue identity/contact state if bulk display state has replaced every use.
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:3262` through `3266` and `3270`, `3275`, `3277`: remove auto-serve timers/refs and old terminal workflow ref if their effects are gone.
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:3332` through `3356`: remove `clearServedQueueSelection` or collapse it into a bulk-only panel clear if still needed.
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:3415` through `3469`: remove `cancelAutoServe`, `scheduleAutoServe`, and `suppressCurrentQueueLead`.
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:3497` through `3502`: remove `legacyQueueEnabled`, `callQueue`, and `refetchLegacyQueue`.
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:3584` through `3586` and `3594` through `3596`: remove callQueue timing fields/deps.
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:4568` through `4705`: remove `restoreServedQueueLead`, `stageQueueLeadInWorkspace`, and `handleSelectFromQueue`.
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:4756` through `4781`: remove `rawQueueItems`, `isQueueItemLocallySuppressed`, and `activeServingQueueItem`.
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:4785` through `4876`: remove the old active-serving restore effect.
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:4878` through `4963`: remove the old terminal-workflow auto-advance effect.
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:4965` through `5023`: remove old `queueItems`.
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:5025` through `5058`: remove legacy stale-served-queue recovery.
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:5060` through `5160`: remove old auto-serve scheduling/gating.

Survivors:
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:3678` through `3680` is the bulk `remainingQueue`.
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:940` defines `BulkBufferList`.
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:5522` through `5538` renders the real RingCX bulk buffer from `bulkRemainingQueue`.
- `apps/control-plane/src/routes/commandsCx.js:292` through `307` should stay for non-bulk/manual/admin command surfaces unless a separate floor-wide decision removes them.

Validation:
- `rg -n "legacyQueueEnabled|rawQueueItems|activeServingQueueItem|handleSelectFromQueue|scheduleAutoServe|AUTO_SERVE|legacy-stale-served-queue|legacy-terminal-workflow|useCxCallQueue" apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx`
- Expected after cut: zero hits in `CXWorkspaceBulkLoad.tsx`.

### 4. Old Page-Level Break Strip: Remove After Navbar Button Smoke

Trace:
- New navbar controls live in `apps/web-client/src/components/cx/CxAvailabilityToggle.tsx`.
- Old page strip is in `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx`.

Cut set:
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:5377` through `5394`: remove `cxRouting`, `cxDesiredAvailability`, `cxPauseType`, break allowance, and break remaining calculations if they are only feeding the hidden strip.
- Keep the pending expression at `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:5395` through `5398`, because `BreakResumePrompt` still uses it at `5407`.
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:5417` through `5471`: remove the `{false ? (...) : null}` hidden top bar entirely.
- Keep `handleCxAvailabilityChange` at `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:4411` through `4498` until `handleResumeWorkFromBreak` and `BreakResumePrompt` no longer need the same set-status/resume path.

Also update:
- `apps/web-client/src/components/cx/CxAvailabilityToggle.tsx:14` through `36` has stale comments saying it posts to `/api/agents/:extensionId/available|unavailable`; the live code uses `/api/commands/cx/WYNN/set-status`.

Validation:
- `rg -n "TOP BAR: sticky routing controls|Resume RingCX dialing|cxDesiredAvailability|cxPauseType|shortBreaksRemaining|mealBreaksRemaining" apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx`

### 5. Retired Auto-Review Banner And `/review-outcome`

Trace:
- Client state/UI: `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx`.
- Client API hook: `apps/web-client/src/lib/api/queries/cxBulkLoad.ts`.
- Server route: `apps/control-plane/src/routes/cxBulkLoad.js`.
- Runtime endpoint: `packages/shared-services/src/cxBulkLoadRuntime.js`.
- Shared correction builder: `packages/shared-services/src/cxBulkLoadOutcomeAdapter.js`.
- Wrap cards also use a correction builder path, so do not delete the builder just because the old auto-review endpoint goes away.

Client cut set:
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:86`: remove `useCxBulkLoadReviewOutcome` import.
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:126` through `131`: remove the `BulkAutoReview` type.
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:3634`: remove `bulkReviewOutcome`.
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:3638` through `3655`: remove `bulkAutoReview`, remaining countdown state, `bulkReviewHoldUntil`, `bulkReviewHoldReason`, `bulkReviewHoldActive`, and `bulkReviewCandidate`.
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:3656` through `3663`: simplify `bulkDisplayCandidate` so it no longer includes `bulkReviewCandidate`.
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:3683`: remove `lastBulkAutoReviewKeyRef`.
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:4026` through `4031`: remove auto-review reset work but keep bulk latch reset.
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:4046` through `4081`: remove the "AUTO-REVIEW BANNER RETIRED" hold-closed effect and countdown effect.
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:4500` through `4535`: remove `handleBulkAutoReviewDnc`.
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:5730` through `5775`: remove the banner JSX.

Client/server API cut set:
- `apps/web-client/src/lib/api/queries/cxBulkLoad.ts:51` through `61`: remove `CxBulkLoadReviewOutcomeResult` after no client uses it.
- `apps/web-client/src/lib/api/queries/cxBulkLoad.ts:196` through `207`: remove `useCxBulkLoadReviewOutcome`.
- `apps/control-plane/src/routes/cxBulkLoad.js:13`: remove `submitCxBulkLoadReviewOutcome` import.
- `apps/control-plane/src/routes/cxBulkLoad.js:154` through `156`: remove or tombstone `/review-outcome`.
- `packages/shared-services/src/cxBulkLoadRuntime.js:1729` through `1774`: remove `submitCxBulkLoadReviewOutcome` after route is gone.
- `packages/shared-services/src/cxBulkLoadRuntime.js:1840`: remove it from module exports.
- `packages/shared-services/src/index.js:299` and `1104`: remove import/export.

Survivor:
- Keep `packages/shared-services/src/cxBulkLoadOutcomeAdapter.js:93` `buildReviewCorrectionRow` while wrap-card DNC/correction code still depends on it. Tests show wrap-card usage in `tests/cx-bulk-load/cxCallWrapCardService.test.js:80`.

Validation:
- `rg -n "BulkAutoReview|bulkAutoReview|useCxBulkLoadReviewOutcome|review-outcome|submitCxBulkLoadReviewOutcome|agent-auto-review" apps packages tests`
- Expected after endpoint/UI cut: hits may remain only in `cxBulkLoadOutcomeAdapter`, wrap-card tests, or historical docs until the correction builder is renamed.

### 6. Dead `/appointment-wrap` Freeze Route: Server/API Cut Only

Status 2026-07-07:
- Cut complete in this pass. The retired client hook/type, HTTP route, runtime command, shared exports, and stale appointment-wrap test wording were removed.
- Proof recorded in `docs/CX_DELETE_RUN_FLEET_OUTCOMES_2026-07-07.md` under "Pass 2: Appointment-Wrap Command Cut".
- Validation complete: retired-path search returned zero active hits, route/runtime syntax passed, delete-run fleet passed 3/0, focused bulk/wrap suite passed 70/0, and web typecheck/build passed.

Current state:
- The old live-call appointment-freeze hook is not imported by `CXWorkspaceBulkLoad.tsx` anymore.
- The visible appointment action at `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:6180` is the wrap-card survivor: `wrapResolve.mutateAsync({ action: "appointment", appointmentAt })`.
- `SharedAppointmentList` at `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:6250` through `6257` is the existing appointment list/call-now surface, not the old appointment-wrap creator.

Cut set removed:
- `apps/web-client/src/lib/api/queries/cxBulkLoad.ts`: `CxBulkLoadAppointmentWrapResult` and `useCxBulkLoadAppointmentWrap`.
- `apps/control-plane/src/routes/cxBulkLoad.js`: `/appointment-wrap` route and import.
- `packages/shared-services/src/cxBulkLoadRuntime.js`: `submitCxBulkLoadAppointmentWrap` implementation/export.
- `packages/shared-services/src/index.js`: `submitCxBulkLoadAppointmentWrap` barrel import/export.
- `tests/cx-bulk-load/cxBulkLoadRuntimeService.test.js`: stale appointment-wrap-specific wording around the busy-session watcher test.

Survivors:
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:6180` wrap-card appointment resolution.
- `apps/control-plane/src/routes/cxBulkLoad.js:111` through `138` wrap-card resolve route.
- `packages/shared-services/src/cxAppointmentService.js` and `createCxAppointment`; wrap-card appointment resolution still needs the real appointment writer.
- `apps/control-plane/src/routes/commandsCx.js:458` through `475` appointment call-now path, unless separately removed from appointment operations.

Validation:
- `rg -n "appointment-wrap|useCxBulkLoadAppointmentWrap|CxBulkLoadAppointmentWrapResult|submitCxBulkLoadAppointmentWrap" apps packages tests`
- Expected after full cut: zero active source hits.

### 7. Live Dialer DNC Button: Decision Gate, Not Blind Cut

Current refs:
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:5625` through `5638` renders live-call `DNC`.
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:5633` sends `submitQueueDisposition("dnc", "DNC")`.
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:6208` through `6219` renders wrap-card `DNC`, which is the intended survivor lane.

Decision:
- If the next proof run is specifically "all post-call status-changing actions happen through wrap cards," remove the live DNC button before the run.
- If the next proof run still needs live DNC as an emergency operator action, leave it but record that it is not the final design.

Server note:
- Do not remove backend `dnc` disposition handling until every client/script caller has moved to wrap-card DNC.

Validation:
- `rg -n "submitQueueDisposition\\(\"dnc\"|>DNC<|action: \"dnc\"" apps/web-client/src packages tests`

### 8. Exact String Check: Already Gone From Active Source

Checked active source for:
- `Start Queue`
- `start queue`
- `Ring CX bulk buffer`
- `bulk buffer`
- `Stop last call text`
- `last call text`

Result:
- No active `apps`, `packages`, `scripts`, or `tests` hits for those exact strings in this scan.
- The current left rail label is `RingCX` at `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:5510`, and the real list is `BulkBufferList` at `5538`.

## Delete Candidates

### 1. WO-3 Manual-Dial Tripwire Stub

Current refs:
- `apps/control-plane/src/routes/cxBulkLoad.js:163` keeps `/start-next` as a `410 manual-dial-disabled` tripwire.
- `attic/manual-dial-lane.attic.md` holds the retired implementation.

Why legacy:
- The actual side door is gone; this is only a muscle-memory guard.
- The surviving recovery path is `/api/cx/bulk-load/get-leads`.

Delete trigger:
- After the acceptance script and one clean local session prove no caller still probes `/start-next`.
- Keep or replace with a generic route tombstone only if operators/scripts still hit it.

Do not delete with:
- `/get-leads`, `startCxBulkLoadGetLeads`, or the loader path that rebuilds sessions through the API.

### 2. Alpha Watch Regex For Already-Retired Adoption Path

Current refs:
- `scripts/alpha-watch.js:25` watches active-call terms.
- `scripts/alpha-watch.js:26` still includes `markAdoptedCandidateServing`.
- `docs/rewrite-reports/WO-attic-riders.md:57` already flags this as inert.

Why legacy:
- The adoption path is attic-only now; the regex cannot observe a live event that should still exist.

Delete trigger:
- WO-30 trace cleanup or any alpha-watch refresh.

Do not delete with:
- The rest of `alpha-watch`; it is still useful while local alpha testing is noisy.

### 3. EX Presence Lifecycle Owning CX Call State

Current refs:
- `packages/shared-services/src/ringcentralExService.js:98` defaults EX presence polling to `write` when not in cx-only runtime.
- `packages/shared-services/src/ringcentralExService.js:467` processes webhook presence envelopes.
- `packages/shared-services/src/ringcentralExService.js:491` through `522` can set `currentCall`, `activePlatform`, and `status` from EX telephony.
- `packages/shared-services/src/ringcentralExService.js:1260` reconciles polled presence.
- `packages/shared-services/src/ringcentralExService.js:1355` through `1408` still computes CX-vs-EX ownership inside the EX poll path.
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:6247` through `6266` still shows EX call-state chips in the bulk workspace.

Why legacy:
- Bulk CX call state should be owned by RingCX active-call polling and UII/extern evidence, not EX presence. This was the suspected "something is fighting CX for control" class.
- WO-28 already names this: make EX explicit, gate `processPresenceEnvelope`, surface mode state, then remove the old implicit ownership behavior.

Replacement:
- CX-owned active-call watcher, terminal outbox, drain, and explicit runtime-mode display.

Delete trigger:
- WO-28 passes: bulk-alpha means EX poll off/no-write, `processPresenceEnvelope` returns a cx-only skip for bulk state, and the bulk header displays modes without letting EX decide current.

Do not delete with:
- RingEX auth, SMS, inbound EX call handling, non-bulk RingBridge UI, or availability reads that are still needed outside bulk.

### 4. Legacy Drain-Side Auto Summary / Case-Land Writer

Current refs:
- `apps/control-plane/src/server.js:949` defines `enqueueCxCallWrapFromTerminal`.
- `apps/control-plane/src/server.js:964` calls `writeCxCallWrapSummary`.
- `apps/control-plane/src/server.js:1000` writes a Logics activity directly from the drain-side summary path.
- `apps/control-plane/src/server.js:1056` says wrap queue enabled means cards replace the legacy auto-summary.
- `apps/control-plane/src/server.js:1136` through `1142` chooses `wrapCards.createFromDrain` when enabled, otherwise falls back to `enqueueCxCallWrapFromTerminal`.

Why legacy:
- Mickey's wrap ruling says the dialer's outcome writes CX state only. Case-land writes belong to wrap-card resolution.
- The real wrap drill showed the problem in miniature: with the flag off, the legacy writer consumed the thread key first; later card resolution deduped as `duplicate-thread-key`.

Replacement:
- `CxCallWrapCard` created by the live drain hook, then `wrapCards.resolve` writes interview/DNC/appointment at resolution time.

Delete trigger:
- Set `CX_CALL_WRAP_QUEUE_ENABLED=true`, Mickey restarts `ParallelControlPlane`, rerun `node scripts/cx-wrap-drill.js --arm`, and get PASS for "cards minted by the LIVE drain hook" plus non-deduped interview behavior.

Do not delete with:
- `writeCxCallWrapSummary` itself; it is still the shared write primitive used by wrap-card resolution and live coach closeout.

### 5. Post-Call Appointment Freeze Path

Current refs:
- `apps/control-plane/src/routes/cxBulkLoad.js:144` through `151` exposes `/appointment-wrap`.
- `packages/shared-services/src/cxBulkLoadRuntime.js:1507` starts `submitCxBulkLoadAppointmentWrap`.
- `packages/shared-services/src/cxBulkLoadRuntime.js:1525` through `1530` holds the session busy while Logics appointment work commits.
- `apps/web-client/src/lib/api/queries/cxBulkLoad.ts:179` defines `useCxBulkLoadAppointmentWrap`.
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:4004` wires `bulkAppointmentWrap`.
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:5862` through `5885` sends the modal through the bulk appointment-wrap route.
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:6773` through `6783` already renders appointment as a wrap-card action.

Why legacy:
- The freeze model was a workaround for doing Logics work while the live call loop waited.
- The wrap design moves post-call appointment work to the async card lane. The dial loop should not hold its breath for Logics.

Replacement:
- Wrap-card appointment action with a date/time picker, writing through the wrap resolution pipeline.
- Keep a deliberately separate live-call appointment UX only if the prospect is still on the phone.

Delete trigger:
- Wrap-card appointment tested end-to-end: card created by live drain, appointment resolved, Logics appointment created, app-side hold/correction row drained.

Do not delete with:
- `createCxAppointment`, appointment workspace views, or any live-call M3 surface until WO-16/17 defines the final live-call appointment route.

### 6. Live Dialer DNC Button / Terminal DNC As Case-Land Intent

Current refs:
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:6527` through `6540` renders the live bulk DNC button.
- `packages/shared-services/src/cxBulkLoadRuntime.js:508` through `518` maps `dnc` as a RingCX disposition.
- `packages/shared-services/src/cxCadenceService.js:2775` treats `dnc` as a contact outcome in terminal handling.
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:6761` through `6771` also renders DNC on wrap cards.

Why legacy:
- At wrap cutover, the live dialer should only advance/record the call result. DNC becomes an async wrap-card decision because it affects future dialing and external systems.

Replacement:
- Live call row: Answer / No answer / Voicemail / Skip as appropriate.
- Wrap card: DNC / Appointment / X.

Delete trigger:
- WO-17/31/32 or wrap-card equivalent proves DNC correction/status path from a card, including queue/cadence app effects and Logics status.

Do not delete with:
- The wrap-card DNC button. That is the survivor.

### 7. Auto-Review Banner And Review-Hold State

Current refs:
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:137` defines `BulkAutoReview`.
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:4006` through `4023` still owns auto-review state.
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:4419` through `4429` force-closes the retired banner.
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:4958` through `4993` still contains DNC correction handling for that banner.
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:6646` through `6689` still renders the banner if state opens.
- `packages/shared-services/src/cxAccountActiveCallWatcherService.js:291` stamps `reviewHoldUntil` / `reviewHoldReason`.
- `packages/shared-services/src/cxBulkLoadRuntimeService.js:940` clears review hold on manual terminal and `991` stamps it for skip.

Why legacy:
- The banner was retired after it popped the wrong question over a manual no-answer/screener case.
- The design now says answered follow-up belongs in a worklist/wrap card, not a transient banner inside the live call panel.

Replacement:
- WO-16 projector + WO-32 answered-calls worklist / wrap cards.

Delete trigger:
- WO-16/17 lands identity-carrying clicks and the worklist/card lane handles answered follow-up.

Do not delete with:
- Server-side `reviewHoldReason === "ringcx-current-released"` until WO-19 moves the suppression decision server-side and pins it.

### 8. Stale-Serving Diagnostic Module

Current refs:
- `packages/shared-services/src/cxStaleServingReconcilerService.js:3` declares diagnostic-only behavior.
- `packages/shared-services/src/cxStaleServingReconcilerService.js:101` resolves serving identity for the old diagnostic.
- `packages/shared-services/src/cxStaleServingReconcilerService.js:174` classifies stale serving rows.
- `packages/shared-services/src/cxStaleServingReconcilerService.js:333` runs the read-only sweep.
- `scripts/cx-stale-serving-diagnostic.js:38` consumes it.
- `tests/cx-bulk-load/cxStaleServingReconciler.test.js:8` pins it.
- `docs/CX_BULK_LOAD_REWRITE_WORK_ORDERS_2026-07-02.md:562` through `580` already assigns this to WO-22.

Why legacy:
- It is a diagnostic scaffold for the stale-serving problem, not the final janitor.
- WO-22 says to port the useful externId-first still-active guard into terminal rectification, then remove this diagnostic bundle.

Replacement:
- One terminal rectifier/janitor path with the still-active guard and dry-run proof.

Delete trigger:
- WO-22 proof: rectifier tests green, dry run reviewed, and grep for `cxStaleServingReconciler|classifyStaleServingRow|resolveServingIdentity|runStaleServingDiagnosticOnce|cx-stale-serving-diagnostic` has zero live hits.

Do not delete with:
- `requeueStaleServingQueueItems` in `cxCadenceService`; the work order explicitly leaves that legacy rail freer until full floor cutover.

### 9. Legacy Stale-Serving Freer In Cadence

Current refs:
- `packages/shared-services/src/cxCadenceService.js:1732` defines `requeueStaleServingQueueItems`.
- `packages/shared-services/src/cxCadenceService.js:1733` reads `RC_CX_STALE_SERVING_MINUTES`.
- `packages/shared-services/src/cxCadenceService.js:3211` gates it with `RC_CX_RELEASE_STALE_SERVING_ENABLED`.
- `docs/CX_BULK_LOAD_REWRITE_WORK_ORDERS_2026-07-02.md:579` through `581` says it survives WO-22.

Why legacy:
- It is the old serving-row freer. It remains a safety belt while the floor cutover is incomplete.

Replacement:
- Terminal rectification plus bulk session kill/reaper paths that cancel RingCX and drain terminal facts.

Delete trigger:
- After floor cutover and acceptance prove the rectifier/session cleanup replaces all stale-serving frees.

Do not delete with:
- WO-22. That order deletes the diagnostic bundle, not this last legacy safety belt.

### 10. DISPTRACE / Flow-Trace Scaffolding

Current refs:
- `packages/shared-services/src/cxBulkLoadRuntimeService.js:62` emits `[DISPTRACE]`.
- `packages/shared-services/src/cxBulkLoadRuntimeService.js:97` reads `CX_BULK_LOAD_FLOW_TRACE_AGENT`.
- `packages/shared-services/src/cxBulkLoadRuntime.js:78` emits `[DISPTRACE]`.
- `packages/shared-services/src/ringcxDialExecutionService.js:707` through `727` emits hangup DISPTRACE.
- `packages/shared-services/src/ringcxDialExecutionService.js:2944` through `2948` emits hangup request DISPTRACE.
- `scripts/cx-bulk-agent-test-prep.js:385` sets `CX_BULK_LOAD_FLOW_TRACE_AGENT`.
- `docs/CX_BULK_LOAD_REWRITE_WORK_ORDERS_2026-07-02.md:793` through `808` defines WO-30.

Why legacy:
- Some of this was emergency instrumentation for "no answer did not end the call."
- It should not live forever as unstructured console noise.

Replacement:
- Structured `cx.alpha.*` transport/disposition events until acceptance, then only the small logs that are still operationally useful.

Delete trigger:
- WO-30 now-half: remove runtime-service DISPTRACE copy and flow-trace knob.
- After acceptance: remove the remaining runtime DISPTRACE/probe loops that no longer answer an active question.

Do not delete with:
- The runtime transport boundary trace before the no-answer/voicemail loop is stable; the work order explicitly keeps it until acceptance.

## Things That Look Old But Are Not Delete Targets Yet

- `firstTouchEligible` policy fields: these are live account/queue policy, not the retired bulk green-first-touch supply feature.
- `writeCxCallWrapSummary`: shared primitive; remove legacy automatic call sites, not the function.
- `requestCxLeadStatusUpdate`: shared Logics status command; wrap-card DNC uses it too.
- RingEX auth/SMS/inbound features: only the CX call-state ownership coupling is on this ledger.
- `activePlatform`, `currentCall`, and `exTelephonyStatus` on `AgentState`: compatibility projections until the canonical `cxCall` migration has a real consumer map.
- `get-leads`: survivor recovery hatch.

## Suggested Delete Order

1. Small cleanup: alpha-watch adoption regex and any stale docs that claim `/start-next` is active.
2. WO-30 now-half: runtime-service DISPTRACE copy and flow-trace knob.
3. WO-16/17/19/31/32: delete auto-review banner, identity-less correction UI, live DNC as terminal case-land intent, and stale client-side review hold logic.
4. WO-28: make EX presence lifecycle explicitly off/no-write for bulk CX state, then remove bulk EX chips and implicit EX ownership branches.
5. Wrap cutover: enable `CX_CALL_WRAP_QUEUE_ENABLED`, prove live cards mint, then delete the legacy drain-side auto summary fallback.
6. Wrap appointment cutover: remove post-call appointment freeze path once card appointment is proven.
7. WO-22: port the stale-serving guard into terminal rectification, then delete the diagnostic stale-serving bundle.
8. After floor acceptance: remove remaining stale-serving legacy freer and leftover DISPTRACE/probe scaffolding.

## Additions (Fable, 2026-07-08 hardening pass)

- **DONE: ledger #6 executed** — the live-dialer DNC button is cut (trigger met 07-07 by
  the wrap-card DNC proof: interview + correction drained + Logics status confirmed by
  external read). The live row records call results only; backend dnc handling survives
  (wrap cards write through it). Comment tombstone at the old render site.
- **NEW CANDIDATE: the internal cx-queue claim routes** —
  `/api/ringcentral/cx-queue/claim-next|process-batch|build-agents` on the ringcentral-cx
  app (requireInternalAccess) drive `claimNextCxQueueItem`, the legacy distribution rail.
  Verified 2026-07-08: NOT in the bulk loop (bulk reserves via cxQueueReservationService);
  hardened with the same H5 exclusions. Delete trigger: one floor week of logs showing
  zero calls to these routes → 410 tombstones, then the claim fn per its own map.
- **KNOWN-FAILING SUITE (not a delete item): tests/live-coach/uiiReconcile.test.js**
  (4/6 red, pre-existing — the coach is parked/unwired; pins drifted from some earlier
  change). Reconcile when the coach pilot wires in; do not "fix" pins against unknown
  intended behavior before then.
