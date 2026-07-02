# CX Bulk Load Local Testing Handoff - 2026-07-01

This note captures the current local CX bulk-load testing state, the trouble spots found across the current July 1 thread and the "Definitely Not Codex" session, and the simple design direction Mickey wants preserved.

The short version: bulk-load dialing should be one rail, RingCX should prove the live call, the app should only project that proof, and terminal buttons should send one disposition path that ends the current call and advances. Anything else trying to own current call state, next lead staging, or call completion is suspect.

## Source Trail

- Current July 1 recovery/live-test conversation in this Codex thread.
- `C:\Users\micke\DEFINITELY NOT CODEX\sessions\2026\06\24\rollout-2026-06-24T16-19-18-019efbee-4bac-77d3-a46b-ac47486dc1f7.jsonl`
  - line 6: request to audit `docs/CX_BULK_LOAD_SIMPLIFICATION_REVIEW_GUIDE_2026-06-24.md`.
  - line 355: request to review `docs/CX_CURRENT_STATE_AUDITOR_GUIDE_2026-06-25.md` and call queue ownership.
  - lines 2752-2753: prior summary: keep `submitQueueDisposition` as one path only and let UI map typed results to toast/transition/refetch.
  - lines 3878-3888: user asked for remaining defect simplification concepts; prior assistant identified reserved-row finality and agent-scoped start lock.
  - lines 3907-3925: green first-touch simplification: pure gate planner, finite batch ownership, single debt source, atomic terminal/touch persistence.
- `.ai/context/PROJECT_HANDOFF.md`
- `.ai/context/CODEX_RECOVERY_NOTES.md`
- `docs/CX_0_2_ALPHA_TEST_OBSERVABILITY_RUBRIC_2026-06-29.md`
- `docs/CX_BULK_LOAD_SIMPLIFICATION_REVIEW_GUIDE_2026-06-24.md`
- `docs/CX_CURRENT_STATE_AUDITOR_GUIDE_2026-06-25.md`
- `docs/CX_2_0_GREEN_FIRST_TOUCH_SWEEP_IMPLEMENTATION.md`

## Non-Negotiable Operating Rules

- Do not restart `Parallel*` or NSSM services from Codex. If a service restart is needed, Mickey does it.
- Do not mix legacy dialing with bulk-load dialing for the local bulk test agent.
- Do not use phone-only matching for active calls.
- Do not patch around missing ownership metadata by adopting random RingCX calls into the session.
- Do not treat UI state alone as pass/fail evidence.
- Keep code changes small and tested before rebuilding the local queue.

## Desired Design

The intended design is deliberately boring:

1. A bulk session reserves a finite set of `CxDialQueue` rows.
2. The bulk-load rail publishes those rows to RingCX with the `cxbl` ID shape.
3. The account active-call watcher polls RingCX and proves which published row is actually active.
4. The UI displays the RingCX-proven current call.
5. A terminal button sends one disposition command.
6. The accepted disposition ends or releases the RingCX call, records the terminal outcome once, clears current state, and requests/refills the next lead.
7. The terminal outbox performs downstream cadence/writeback work outside the live call loop.

The source docs say the same thing in different words:

- `docs/CX_BULK_LOAD_SIMPLIFICATION_REVIEW_GUIDE_2026-06-24.md:9` says RingCX receives buffered leads, the account watcher reads active calls, the reducer projects current/accepted/completed, and buttons submit terminal intent.
- `docs/CX_CURRENT_STATE_AUDITOR_GUIDE_2026-06-25.md:11` says RingCX owns live call truth, the app displays RingCX-proven active, and buttons write terminal.
- `docs/CX_CURRENT_STATE_AUDITOR_GUIDE_2026-06-25.md:49` calls for one current-call projection and one terminal writer.
- `docs/CX_2_0_GREEN_FIRST_TOUCH_SWEEP_IMPLEMENTATION.md:1416` says LeadCadence is candidate source, `CxDialQueue` is dialable supply, reservation claiming controls finite work, and call proof/drain is the actual touch proof.

## Named Concepts

Use these names consistently while debugging:

- **Bulk-load rail**: The local replacement for legacy dialing for this test agent. It owns publishing and advancing the local test batch.
- **Legacy rail**: Older dial/queue/start commands. These must not be used while bulk-load mode owns the agent.
- **RingCX proof**: An active RingCX call whose extern ID or queue item ID matches a bulk candidate. This is the only valid live-current proof.
- **Candidate**: A session buffer item tied to a `CxDialQueue` row.
- **Reserved row**: A `CxDialQueue` row claimed for the current bulk session with `metadata.reservationSessionId`.
- **Serving row**: The row currently proven by RingCX and promoted to active/current.
- **Terminal outcome**: No answer, voicemail, DNC, callback, etc. It should be persisted once, with UII evidence when available.
- **Auto-review**: A review prompt for a RingCX-ended call that disappeared before manual disposition. It must not be opened for normal manual no-answer.
- **EX lifecycle watcher**: Legacy EX presence/current-call path. For local bulk testing it is a likely state-owner conflict and should remain disabled/observe-only/CX-owned.
- **First-touch debt**: Green-first-touch accounting. It should clear only on call proof/drain, not client-side tricks.

## Wiring Map

```text
LeadCadence / source pools
  -> CxDialQueue ready rows
  -> reservation session claims finite rows
  -> bulk-load publisher posts rows to RingCX using cxbl IDs
  -> RingCX account active-call watcher polls active calls
  -> externId / queueItemId match promotes one candidate to serving/current
  -> CX bulk UI projects that current call
  -> terminal button sends one disposition request
  -> RingCX disposition accepted
  -> app hangs up/releases current call and clears current
  -> terminal outcome adapter persists outcome once
  -> terminal outbox drains cadence/writeback outside the live loop
  -> refill/reservation brings in next rows when needed
```

Key code anchors:

- `packages/shared-services/src/cxQueueReservationService.js:6` describes reservation and guarded release of claimed rows.
- `packages/shared-repositories/src/cxDialQueueRepository.js:413` stamps `reservationSessionId`, `reservedAt`, `reservationRail`, and clears stale publish/attempt metadata during reservation.
- `scripts/local-ordered-mickey-bulk-load.js:47` builds the `cxbl` extern ID shape for local ordered loads.
- `scripts/local-ordered-mickey-bulk-load.js:169` stamps initial queue rows with `reservationSessionId` and `bulkLoadSessionId`.
- `scripts/local-ordered-mickey-bulk-load.js:273` pushes accepted rows into the session buffer and stamps the matching queue row as claimed for that session.
- `packages/shared-services/src/cxBulkLoadActiveCallWatcher.js:9` says active-call matching is extern-ID first and never phone-only.
- `packages/shared-services/src/cxAccountActiveCallWatcherService.js:693` promotes RingCX-proven current calls through `markCandidateServing`.
- `packages/shared-services/src/cxBulkLoadRuntime.js:933` now only promotes rows whose `reservationSessionId` matches the active bulk session.
- `packages/shared-services/src/cxBulkLoadRuntime.js:1136` sends RingCX disposition and records accepted disposition status.
- `packages/shared-services/src/cxBulkLoadRuntimeService.js:1016` handles accepted manual terminal disposition by clearing current and triggering the no-answer refill path when applicable.
- `packages/shared-services/src/cxBulkLoadOutcomeAdapter.js:3` documents the single terminal writer with idempotency keyed by queue item and UII.
- `packages/shared-services/src/cxTerminalOutboxDrain.js:3` keeps downstream terminal work outside the live call loop.
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:3845` keeps the legacy queue disabled in the bulk workspace.

## Where We Have Had Trouble

### 1. Too Many Things Owning Current Call State

The recurring failure mode has been "something else thinks it owns the current call." Symptoms from the July 1 thread:

- Poller matched the first call, then stopped matching after advance.
- RingCX showed one current lead while the app still showed a previous queue head.
- "CX still owns the call" logic blocked or delayed no-answer completion.
- UI catch-up/auto-review appeared briefly after manual actions.

Relevant anchors:

- `docs/CX_BULK_LOAD_SIMPLIFICATION_REVIEW_GUIDE_2026-06-24.md:84` warns that legacy appointment paths must not fire while bulk owns the call flow.
- `docs/CX_CURRENT_STATE_AUDITOR_GUIDE_2026-06-25.md:171` calls for one current-call owner.
- `packages/shared-services/src/cxBulkLoadActiveCallWatcher.js:177` handles released-current detection from RingCX poll state.
- `packages/shared-services/src/cxAccountActiveCallWatcherService.js:246` marks `reviewHoldReason: "ringcx-current-released"` when RingCX proves the current call disappeared.
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:4419` now gates auto-review so manual terminal actions do not become "auto-disposed, please decide" prompts.

Current strategy: RingCX watcher owns current-call proof. UI projects it. Manual terminal buttons do not create auto-review.

### 2. Legacy Rail And ID Shape Leakage

The local bulk test broke when tooling or a route used legacy assumptions. Mickey called this out directly: live and local are different, local testing is bulk as a system to replace legacy, and `cxbl` is the shape that must be read on both ends.

Bad signs:

- RingCX has a dialed call, but the queue row has no bulk ID.
- The app reports: "Bulk load mode owns dialing for this agent; use the bulk-load rail instead of the legacy dial command."
- A reload creates 20 leads when 10 were expected, or CX side and app side pools do not match.

Relevant anchors:

- `docs/CX_BULK_LOAD_SIMPLIFICATION_REVIEW_GUIDE_2026-06-24.md:16` flags browser-path functions that read RingCX and mutate session state as suspicious.
- `docs/CX_BULK_LOAD_SIMPLIFICATION_REVIEW_GUIDE_2026-06-24.md:92` says no `legacy`, `simpleLoop`, or `nextDial` path should run inside bulk mode.
- `scripts/local-ordered-mickey-bulk-load.js:51` builds the bulk extern ID from the `cxbl` prefix, queue item ID, and sequence.
- `packages/shared-services/src/cxBulkLoadActiveCallWatcher.js:80` indexes active calls by extern ID and queue item ID.
- `packages/shared-services/src/cxBulkLoadRuntime.js:899` asserts publish stamping before marking a candidate loaded.

Current strategy: rebuild fresh local pools through the bulk-load path only, with `cxbl` IDs, then verify app-side queue and CX-side queue agree before clicking through calls.

### 3. Missing Reservation Metadata

One important July 1 failure: RingCX had an active call with a valid `cxbl` extern ID, but the corresponding app row/session candidate had lost `metadata.reservationSessionId`. A previous fallback tried to adopt that call anyway. That made the system less honest and made later mismatches harder to diagnose.

Relevant anchors:

- `packages/shared-repositories/src/cxDialQueueRepository.js:413` should stamp reservation metadata when rows are claimed.
- `packages/shared-repositories/src/cxDialQueueRepository.js:521` renews claims only when state is `claimed` and `reservationSessionId` matches.
- `packages/shared-services/src/cxBulkLoadRuntime.js:933` now refuses to mark a candidate serving unless the row belongs to the active reservation session.
- `packages/shared-services/src/cxAccountActiveCallWatcherService.js:757` logs `cx.alpha.watch.serving_stamp.missed` when serving promotion misses.

Current strategy: missing reservation metadata is a loader/session data bug, not a runtime adoption opportunity.

### 4. No-Answer Disposition Became Over-Guarded

No-answer used to be the simplest and most reliable button. It later regressed: RingCX accepted-looking UI events appeared, but the call did not terminate or advance. The most suspicious branch was the "RingCX still owns the call" / release-unconfirmed guard, because it treated accepted disposition as not enough if the active call still appeared in a short follow-up poll.

Relevant anchors after simplification:

- `packages/shared-services/src/cxBulkLoadRuntime.js:132` logs disposition probes and post-disposition hangup probes.
- `packages/shared-services/src/cxBulkLoadRuntime.js:1136` sends the disposition, then attempts the post-disposition hangup probe, then returns `dispositionStatus: "accepted"` on 200-class acceptance.
- `packages/shared-services/src/cxBulkLoadRuntimeService.js:701` only asks for the next lead after `did_not_connect`.
- `packages/shared-services/src/cxBulkLoadRuntimeService.js:1016` clears current after accepted manual terminal disposition.
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:5764` marks a manual terminal action before submit so UI effects do not treat it as auto-release.

Current strategy: if RingCX accepts the disposition, the live loop advances. Do not add a short-window "still active" veto unless there is hard evidence it is required.

### 5. Auto-Review Was Triggering For Manual Actions

Mickey saw "auto-disposed, please decide" after a manual no-answer-like event. That is the wrong UX and a bad state signal. Auto-review should be for RingCX-ended/disappeared calls where the app needs a human correction, not for a normal manual terminal button.

Relevant anchors:

- `packages/shared-services/src/cxAccountActiveCallWatcherService.js:246` uses `reviewHoldReason: "ringcx-current-released"` for RingCX-disappeared current calls.
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:4005` reads `bulkReviewHoldReason`.
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:4419` now requires `ringcx-current-released` and no manual terminal ref before opening auto-review.
- `packages/shared-services/src/cxBulkLoadOutcomeAdapter.js:87` keeps review DNC correction separate from the normal terminal outcome idempotency key.

Current strategy: manual terminal is terminal. Auto-review is only for RingCX release without a manual terminal.

### 6. EX Presence Lifecycle Can Still Fight CX

The project has been phasing out EX as a call-state owner. Mickey's local-test read is that EX presence lifecycle serves no useful purpose for bulk because users dial through CX. The concept is flawed for this flow: EX can mark an agent/current call based on presence, while CX is the actual call surface.

Relevant anchors:

- `packages/shared-services/src/ringcentralExService.js:57` has the EX-to-CX decoupling rollout flag.
- `packages/shared-services/src/ringcentralExService.js:98` has EX presence poll mode, including disabled/observe-only behavior.
- `packages/shared-services/src/ringcentralExService.js:280` shows the older EX `currentCall` shape.
- `packages/shared-services/src/ringcentralExService.js:404` persists EX-derived agent state.
- `packages/shared-services/src/ringcentralExService.js:432` reacts to EX presence changes.

Current strategy: for local bulk testing, disable or fully observe-only this lifecycle before call-loop testing. Long term, EX should not own CX current-call state.

### 7. UI Polish Changes Reopened Core Flow Risk

There was one strong checkpoint in this thread: the flow was "fast, kept accurate, hung up immediately on click." The next work was supposed to be UI polish: stop the middle section from jumping, detach the post-auto-advance terminal action, use a modal for DNC-only correction, and visually wipe current fields between calls.

After those UI changes, no-answer regressed. That suggests some UI state wiring was still too close to the core live-call loop.

Relevant anchors:

- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:4419` is where auto-review display can affect perceived call flow.
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:5785` is where manual terminal success now shows "Next lead requested" without browser-side staging.
- `docs/CX_CURRENT_STATE_AUDITOR_GUIDE_2026-06-25.md:248` says UI should be a projector, not an owner.

Current strategy: restore and protect the simple call loop first. Then add UI polish in isolated pieces that cannot mutate current call ownership.

### 8. Eligibility And DNC/Logics Gating

Live testing also surfaced bad rows making it to dialable state, including a DNC/logics-status concern. That is adjacent to the local bulk loop but important: bad leads should not merely be caught at serve time; they should be blocked before they enter dialable supply.

Relevant anchors:

- `docs/CX_2_0_GREEN_FIRST_TOUCH_SWEEP_IMPLEMENTATION.md:1416` says `CxDialQueue` is the dialable supply and blockers must be enforced before rows become usable supply.
- `docs/CX_2_0_GREEN_FIRST_TOUCH_SWEEP_IMPLEMENTATION.md:1626` says touch debt clears only on proof, not on client-side state.
- `docs/CX_CURRENT_STATE_AUDITOR_GUIDE_2026-06-25.md:273` lists DNC/auto-release and disappeared-call cases as key audit questions.

Current strategy: keep contact eligibility checks close to materialization/reservation, then verify live pool counts and sample blocked evidence read-only before restart-heavy changes.

## What Has Been Effective

- Using `cxbl` IDs end-to-end.
- Rebuilding a clean app-side queue after CX-side queue is drained.
- Treating `reservationSessionId` as mandatory proof that a row belongs to the active bulk session.
- Removing phone-only matching from active-call detection.
- Treating RingCX active-call polling as the current-call source of truth.
- Keeping terminal persistence in `cxBulkLoadOutcomeAdapter` and downstream writeback in `cxTerminalOutboxDrain`.
- Removing the "accepted but still active" style guard from the hot no-answer path.
- Adding targeted logs around RingCX disposition acceptance and post-disposition hangup probes.
- Testing no-answer and voicemail separately to compare RingCX behavior.
- Asking Mickey to restart services only when necessary and after code is ready.

## What Still Is Not Working Reliably

- The local no-answer path has repeatedly regressed after unrelated-looking UI changes.
- The active-call poller can stop matching after the first call when queue/session/CX IDs drift.
- Some reload attempts have created mismatched app-side vs CX-side queue contents.
- Auto-review/catch-up UI still needs to be visually and logically detached from manual terminal actions.
- The middle current-lead UI can flicker or feel jumpy between "current lead", "no one", and "next lead".
- EX lifecycle code still exists and can conceptually fight CX unless disabled/observe-only/CX-owned for this test.
- Live eligibility/materializer gating needs continued verification so DNC/inactive/bad-logics rows cannot enter dialable supply.

## Current Code Posture After July 1 Simplification

The latest local simplification intentionally removed the release-verifier branch that could block advancement after accepted disposition:

- `packages/shared-services/src/cxBulkLoadRuntime.js:933` has strict reserved-row serving promotion.
- `packages/shared-services/src/cxBulkLoadRuntime.js:1136` returns accepted disposition status after RingCX accepts the disposition and the post-disposition hangup probe is attempted.
- `packages/shared-services/src/cxBulkLoadRuntimeService.js:1016` clears current after accepted terminal disposition without creating a review hold.
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:4419` prevents manual terminal actions from opening auto-review.

Targeted verification already passed after this simplification:

```text
node --test tests\cx-bulk-load\cxBulkLoadRuntime.test.js tests\cx-bulk-load\cxBulkLoadRuntimeService.test.js tests\cx-bulk-load\cxAccountActiveCallWatcherService.test.js tests\cx-bulk-load\cxBulkLoadStateMachine.test.js
npm.cmd run typecheck --workspace=web-client
```

## Next Safe Coding Steps

1. Let Mickey restart only the needed local service if required for the latest code to take effect.
2. Rebuild a fresh local bulk session only after CX-side queue is drained.
3. Confirm the first visible queue item in the app matches the first CX-side item by `cxbl` extern ID or queue item ID.
4. Test no-answer first, with the disposition/post-disposition logs open.
5. Test voicemail next, using the same logging, so no-answer can be compared to a known-good terminal path.
6. If no-answer fails, inspect whether RingCX returned acceptance and whether the post-disposition hangup probe ran.
7. If poller matching fails, inspect `cx.alpha.watch.serving_stamp.missed` and the candidate row metadata before touching UI code.
8. If the queue drifts, inspect `reservationSessionId`, `bulkLoadSessionId`, `lastRingcxPublishedExternId`, and accepted buffer entries before reloading more leads.
9. Only after the simple loop is stable again, isolate UI polish:
   - wipe current fields between calls,
   - grey the empty state instead of blue/green popups,
   - move post-auto-release correction into a detached modal,
   - keep DNC as the only corrective button and X as "keep existing status."

## Suggested Remaining Work

- Add a test that a `cxbl` RingCX active call without matching `reservationSessionId` logs a serving-stamp miss and does not become current.
- Add a test that manual no-answer cannot open auto-review.
- Add a test that accepted RingCX disposition advances even if an immediate follow-up active-call poll is stale.
- Add a small diagnostic endpoint or script that prints the current bulk session, accepted buffer, reserved rows, and RingCX published extern IDs with PII masked.
- Convert the local ordered loader workflow into the same API route shape the app will eventually use, so testing stops depending on one-off script behavior.
- Make EX lifecycle mode explicit in the local test startup display so it is obvious whether EX is disabled, observe-only, or able to write state.
- Keep live materializer eligibility checks read-only unless Mickey asks for a restart/deploy.

## Fast Failure Triage

If the next local run breaks, triage in this order:

1. Did the button send one disposition request?
2. Did RingCX return accepted/200?
3. Did the post-disposition hangup probe run?
4. Did app current clear?
5. Did the watcher prove the next active call using `cxbl` extern ID or queue item ID?
6. Did `markCandidateServing` reject because `reservationSessionId` was missing or wrong?
7. Did UI show auto-review even though the action was manual?
8. Did any legacy or EX path write current call state?

If the answer is "reservation metadata missing" or "legacy route used," rebuild the session correctly. Do not add a fallback that hides the bad state.
