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
