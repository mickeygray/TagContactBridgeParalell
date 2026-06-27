# CX worktree pare-back grouping - 2026-06-25

Purpose: identify what in the current head belongs to the CX final product, what should be parked, and what needs manual reachability review before any patch. This is not a deletion list by itself. It is the map to avoid shipping test scaffolding, AI WIP, logs, or half-wired experiments with the CX rail work.

## Snapshot

Current working tree shape:

- 39 modified tracked files.
- 3,137 tracked insertions and 499 tracked deletions.
- Large untracked surface across CX rails, AI/coach/blogger work, tests, scripts, docs, and local logs.
- The riskiest files are not necessarily the largest files. The riskiest files are route, index, registry, and client-query files because they can make WIP reachable.

## 0.2.0 Product Boundary

The 0.2.0 patch is not just a dialer cleanup. CX, Logics, Mongo, and AI are one connected product surface: the app has to serve the right lead, show the right call, collect the right outcome, generate useful coaching/summary intelligence, and persist the useful business record back into the systems that agents and managers actually use.

0.2.0 should ship code that supports one of these final surfaces:

- Legacy CX rail staying alive as fallback.
- Slow single rail as the deterministic one-at-a-time fallback.
- Bulk rail as the new pilot path.
- Universal current-call projection from RingCX active calls.
- Queue reservation, refill, terminal outbox, and reconciliation safety.
- Appointment/task/logics handoff where it is required by the CX workflow.
- LeadCadence/case-profile/communications persistence that makes call outcomes visible later.
- Sparse Logics activity creation for meaningful call notes, appointments, DNC, and final outcomes.
- AI call-summary, coach, interview, and response surfaces wired into the page and terminal drain.
- Mongo-backed durable state for queues, sessions, terminal outcomes, summaries, and UI recovery.
- Tests that prove those specific surfaces.

Everything else should be parked, archived, ignored, or split into a different branch/commit. The thing to cut is noise: raw logs, one-off local scripts, probe harnesses, temporary fixtures, duplicate docs, and tests that only prove abandoned experiments.

## Keep, But Tighten

These are likely part of the final 0.2.0 runtime, but need careful review because they are broad or shared.

- `apps/control-plane/src/server.js`
  - Startup reconciliation and worker wiring belong here, but every new route/worker registration should be checked against the final mode flags.
- `apps/control-plane/src/routes/commandsCx.js`
- `apps/control-plane/src/routes/readCx.js`
  - Keep only commands/read endpoints used by legacy, slow, bulk, appointment, and current-call projection.
  - Remove or flag any old simple-loop, preview SDK, or test-only endpoints.
- `apps/ringcentral-cx/src/server.js`
  - Keep active-call polling and RingCX command support that final rails use.
  - Verify no exploratory preview/manual-dial command is exposed as a normal path.
- `packages/shared-config/src/index.js`
  - Keep final feature flags and mode config only.
  - Remove abandoned test flags after they are replaced by one mode selector.
- `packages/shared-integrations/src/ringcxVoiceClient.js`
  - Keep stable RingCX client methods used by final rails.
  - Audit any SDK/preview/get-leads experiment before shipping.
- `packages/shared-models/src/AgentState.js`
- `packages/shared-models/src/CallLog.js`
- `packages/shared-repositories/src/callLogRepository.js`
- `packages/shared-repositories/src/cxDialQueueRepository.js`
- `packages/shared-services/src/cxCadenceService.js`
- `packages/shared-services/src/cxWorkspaceService.js`
- `packages/shared-services/src/hourlySweeperService.js`
- `packages/shared-services/src/idleReaperService.js`
- `packages/shared-services/src/ringcxAgentMonitorService.js`
- `packages/shared-services/src/ringcxDialExecutionService.js`
- `packages/shared-services/src/ringcxLeadServingService.js`
  - These are shared legacy/CX surfaces. Keep only changes that are required for safety, compatibility, or final rails.

## Final 0.2.0 Rail Candidates

These untracked files appear to be the actual rail rewrite. They should be reviewed as a coherent patch set with the Logics, Mongo, and wired AI surfaces they depend on. Do not mix them with local-only probes, abandoned SDK attempts, or raw test artifacts.

Backend routes:

- `apps/control-plane/src/routes/cxBulkLoad.js`
- `apps/control-plane/src/routes/cxSlowSingle.js`
- `apps/control-plane/src/routes/cxSimpleLoop.js`

Frontend rail surfaces:

- `apps/web-client/src/lib/api/queries/cxBulkLoad.ts`
- `apps/web-client/src/lib/api/queries/cxSlowSingle.ts`
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx`
- `apps/web-client/src/workspaces/cx/CXWorkspaceRouter.tsx`
- `apps/web-client/src/workspaces/cx/slow-single/CXWorkspaceSlowSingle.tsx`
- `apps/web-client/src/workspaces/cx/AppointmentList.tsx`

Models and repositories:

- `packages/shared-models/src/CxBulkLoadSession.js`
- `packages/shared-models/src/CxSlowLaneSession.js`
- `packages/shared-models/src/CxTerminalOutbox.js`
- `packages/shared-repositories/src/cxBulkLoadSessionRepository.js`
- `packages/shared-repositories/src/cxSlowLaneSessionRepository.js`
- `packages/shared-repositories/src/cxTerminalOutboxRepository.js`

Bulk/slow/current-call services:

- `packages/shared-services/src/cxAccountActiveCallWatcherService.js`
- `packages/shared-services/src/cxBulkLoadActiveCallWatcher.js`
- `packages/shared-services/src/cxBulkLoadLeadSourceService.js`
- `packages/shared-services/src/cxBulkLoadMutationEligibility.js`
- `packages/shared-services/src/cxBulkLoadOutcomeAdapter.js`
- `packages/shared-services/src/cxBulkLoadRingcxPublisher.js`
- `packages/shared-services/src/cxBulkLoadRuntime.js`
- `packages/shared-services/src/cxBulkLoadRuntimeService.js`
- `packages/shared-services/src/cxBulkLoadStateMachine.js`
- `packages/shared-services/src/cxDialRuntimeModeService.js`
- `packages/shared-services/src/cxMorningQueueBuilderService.js`
- `packages/shared-services/src/cxQueueReservationService.js`
- `packages/shared-services/src/cxReservationReconcilerService.js`
- `packages/shared-services/src/cxReserveModeService.js`
- `packages/shared-services/src/cxSlowLaneService.js`
- `packages/shared-services/src/cxSlowLaneStateMachine.js`
- `packages/shared-services/src/cxTerminalOutboxDrain.js`
- `packages/shared-services/src/cxTerminalRectificationService.js`
- `packages/shared-services/src/ringcxActiveCallCaptureService.js`

Tests to keep with this patch:

- `tests/cx-bulk-load/*`
- `tests/cx-dial-runtime/*`
- `tests/cx-handoff/*`
- `tests/cx-simple-loop/*`
- `tests/queue/cxTerminalOutcome.test.js`
- `tests/queue/dispositionMap.test.js`

## Keep In 0.2.0, But Commit As A Separate Slice

These belong to the end-of-call/logics/appointment layer. They are part of 0.2.0, but should be committed as a separate slice from queue mechanics so we can review, test, or roll back the queue rail without losing the business-record layer.

- `packages/shared-services/src/cxAppointmentService.js`
- `packages/shared-services/src/cxCallActivityBackfillService.js`
- `docs/CX_BULK_HANDOFF_LOGICS_WORKBENCH_PLAN_2026-06-25.md`
- `docs/CX_END_OF_CALL_DRAIN_AI_HANDOFF_2026-06-25.md`
- `docs/CX_BULK_WRAP_OUTCOME_PLAN_2026-06-25.md`

This slice should answer:

- Does appointment creation move the agent into the right RingCX state and back?
- Does DNC write to the correct system without blocking the live call loop?
- Does call summary/writeback happen from the terminal drain rather than the hot polling loop?
- Does LeadCadence communication history get enough sparse detail to make later review useful?
- Does Logics receive only sparse, useful activity records rather than noisy live-loop chatter?

## Keep In 0.2.0 If Wired To The Page Or Drain

AI is part of this release when it is connected to the rewritten page, live coach/interview surfaces, call summaries, terminal drain, or the unified AI bus that feeds those surfaces. Do not park AI work just because it is AI. Park it only if it is standalone experimentation, duplicate scaffold, or unrelated background prototype.

AI bus and provider work that may belong after reachability review:

- `packages/shared-integrations/src/anthropicClient.js`
- `packages/shared-services/src/aiBusRegistry.js`
- `packages/shared-services/src/aiProviders.js`
- `packages/shared-services/src/aiSandbox/schemas.js`
- `packages/shared-services/src/aiTaskRegistry.js`
- `packages/shared-services/src/aiTaskRunner.js`
- `tests/ai-bus/sandboxHarness.js`

Coach rewrite work that may belong after page/drain integration review:

- `packages/shared-services/src/coach*.js`
- `packages/shared-services/src/liveCoachTranscriptTranslator.js`
- `packages/shared-services/src/liveCoachSanitizedPipeline.js`
- `tests/live-coach/*`
- `tests/livecoach-translator/*`
- `docs/COACH_*`
- `docs/SAMPLE_CALL_TRANSCRIPT.md`

## Park Outside This Patch

These are the likely noise buckets. They can be preserved, but they should not ride along with the 0.2.0 runtime unless promoted to maintained tooling or product tests.

Blogger/agent experiments:

- `scripts/blogger-claude-writer.js`
- `scripts/blogger-current-event.js`
- `scripts/bloggerContentUtils.js`
- `scripts/claudeAgentRunner.js`
- `scripts/codex-agent/*`
- `tests/blogger/*`

Potentially duplicate or planning-only docs:

- old/duplicative `docs/AI_*`
- old/duplicative `docs/COACH_*`
- `docs/UNIFIED_AGENT_BRAIN_PLAN_2026-06-24.md`
- `docs/SAMPLE_CALL_TRANSCRIPT.md`

Other likely non-CX experiment:

- `packages/shared-services/src/taxGroupScript.js`

## Local Test And Probe Scripts

Some of these are useful, but they are not production runtime. Decide deliberately whether each becomes a maintained script, a dev-only script, or a discarded one-off.

Likely dev-only:

- `scripts/cx-account-active-call-watch-once.js`
- `scripts/cx-bulk-agent-test-prep.js`
- `scripts/cx-dispo-probe.js`
- `scripts/cx-drain-and-mirror-agent-queues.js`
- `scripts/cx-floor-active-call-shadow-follow.js`
- `scripts/cx-floor-agent-queue-state-shadow-follow.js`
- `scripts/cx-floor-queue-shadow-follow.js`
- `scripts/cx-publish-agent-queue-to-ringcx.js`
- `scripts/local-ordered-mickey-bulk-load.js`
- `scripts/mickey-test-queue.js`

Recommendation:

- Keep only scripts that are required for operations or reproducible tests.
- Move retained dev scripts under a clearly named dev/ops area or document them.
- Do not include Mickey/Sean one-off scripts in a production patch unless they are explicitly test fixtures with no live credentials and no accidental live targeting.

## Delete Or Ignore Local Runtime Artifacts

These are not product code.

- `logs/*`
- local `runtime/*` bundles/logs if present

Recommendation:

- Do not commit logs.
- Add or confirm `.gitignore` coverage for `logs/`, local dev logs, and runtime bundles.
- If a log contains evidence worth preserving, summarize it in a doc and delete the raw file.

## Manual Reachability Review

These files can make WIP reachable even when the WIP itself looks isolated. They need line-by-line review before patching.

- `apps/web-client/src/app/routes.tsx`
- `apps/web-client/src/lib/api/queries/cx.ts`
- `packages/shared-integrations/src/index.js`
- `packages/shared-models/src/index.js`
- `packages/shared-repositories/src/index.js`
- `packages/shared-services/src/index.js`
- `apps/control-plane/src/routes/readCx.js`
- `apps/control-plane/src/routes/commandsCx.js`
- `apps/control-plane/src/server.js`

Review questions:

- Does this export/register only final 0.2.0 surfaces?
- Does this expose old simple-loop or preview SDK tests?
- Does this make abandoned AI/coach/blogger experiments reachable from the 0.2.0 patch?
- Does this correctly expose AI/coach surfaces that are intentionally wired into the rewritten page?
- Does this change legacy behavior when the selected mode is legacy?
- Is every new route gated by auth and the intended runtime mode?

## Candidate Staging Plan

1. Classify AI/coach/blogger changes by wiring:
   - keep if used by the 0.2.0 page, coach, drain, summary, or AI bus,
   - park if it is a standalone experiment, duplicate doc, one-off script, or abandoned test.
2. Delete or ignore raw logs/runtime artifacts.
3. Keep a 0.2.0 working tree containing:
   - rail routes/components/hooks,
   - queue/session/outbox models and repositories,
   - current-call watcher,
   - reservation/reconciliation services,
   - terminal drain/rectification,
   - appointment/logics/communications writeback,
   - AI bus/coach/summary surfaces used by the rewritten page,
   - Mongo persistence for durable queue/call/outcome/summary state,
   - required legacy hardening,
   - CX, Logics, Mongo, and AI tests that prove the final surface.
4. Make route/export/index files the last thing staged, after confirming no experiment is reachable.
5. Commit in separated slices:
   - CX rail backbone and repositories,
   - bulk/slow UI and API hooks,
   - active-call watcher and terminal outbox,
   - legacy safety/hardening,
   - appointment/logics workbench integration.
   - AI bus/coach/call-summary integration.
6. Run tests before any live patch:
   - `node --test tests/cx-bulk-load/*.test.js`
   - `node --test tests/cx-dial-runtime/*.test.js tests/cx-handoff/*.test.js tests/cx-simple-loop/*.test.js`
   - `node --test tests/queue/cxTerminalOutcome.test.js tests/queue/dispositionMap.test.js`
   - add the AI/coach tests selected for the 0.2.0 page once the final keep list is chosen.

## Branch And Handoff Strategy

Because tasks are about to swap between people, create a clean handoff branch before more work lands on top of this head.

The branch payload is the integrated mode we are trying to make runnable tonight after the last local tests wrap. It should contain the current best 0.2.0 candidate, even if imperfect, as long as the code is intentionally part of that candidate and can be tested or rolled back as one coherent unit.

Put this on the branch:

- the mode selector and runtime wiring for the mode we are actively testing tonight;
- legacy fallback required to keep the app usable if the new mode fails;
- CX queue/current-call/terminal/outbox plumbing used by that mode;
- Logics, Mongo, appointment, communications, and drain pieces required by that mode;
- wired AI/coach/summary pieces required by the rewritten page;
- tests and docs that explain or verify the above.

Do not put this on the branch:

- raw logs or runtime bundles;
- one-off Mickey/Sean/manual probe scripts unless promoted to formal fixtures;
- abandoned preview SDK/get-leads attempts;
- duplicate design docs that no longer describe the chosen path;
- standalone AI/blogger/account-agent experiments not called by the 0.2.0 page or drain.

Recommended branch shape:

- `wip/0.2.0-integrated-page`
  - Contains CX, Logics, Mongo, AI bus, coach/summary surfaces, appointment, terminal drain, communications, and product tests.
- `wip/ai-background-experiments`
  - Contains blogger, account-agent experiments, standalone model/provider probes, and anything not wired to the 0.2.0 page.
- `archive/local-cx-test-scripts-2026-06-25` or equivalent stash
  - Holds Mickey/Sean probes and one-off local test runners if we want them preserved but not staged.

Recommended handoff order:

1. Make a safety branch from the messy head before deleting anything.
2. Keep AI/coach files that the 0.2.0 page actually calls.
3. Remove raw logs from the visible working tree.
4. Park standalone AI/blogger/probe/test noise to its own branch or stash.
5. Keep 0.2.0 CX+Logics+Mongo+AI code together.
6. Commit 0.2.0 in reviewable slices, not one giant "everything changed" commit.
7. Leave a short branch note naming which files are intentionally WIP and which are ready for audit.

The key rule: do not split Logics or wired AI away from CX for 0.2.0. Split by runtime concern and reviewability, not by product ownership.

## What To Pare Back First

Fastest safe cleanup order:

1. Remove raw logs from the worktree view.
2. Park AI/coach/blogger files only when they are not wired to the 0.2.0 page, drain, coach, summary, or AI bus.
3. Park one-off Mickey/Sean/probe scripts unless they are converted into formal fixtures.
4. Collapse duplicate CX/AI/coach docs into current implementation guides and audit guides.
5. Review `index.js`, route registration, and frontend routing for accidental WIP exposure.
6. Only then start deleting or simplifying runtime code.

Do not revert or delete broad CX, Logics, Mongo, or AI runtime files until they are mapped to a final 0.2.0 responsibility. Some of the mess is scaffolding, but some of it is the new backbone.
