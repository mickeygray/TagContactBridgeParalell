# CX Handoff Version Audit - 2026-06-19

Scope: only the CX disposition/next-call handoff path. This ignores coach, voicemail content, AI bus, metrics, and unrelated UI changes unless they directly affect queue state, nextDial, active call confirmation, or agent state clearing.

## Commit Map

| Label | Commit | Date | Meaning for this audit |
| --- | --- | --- | --- |
| 0.1.1 | `2225726` | 2026-06-09 17:19 PT | Fast joint disposition + nextDial path existed. |
| 0.1.2 | `5ec9e1f` | 2026-06-10 18:08 PT | Same handoff model as 0.1.1, plus VM/watchdog work. |
| 0.1.3 | not found | n/a | No literal 0.1.3 commit in this branch history. Treat as the interim window before 0.1.4 unless another artifact is found. |
| 0.1.4 | `990dc36` | 2026-06-11 16:59 PT | Individual VM / coach guide commit; this is where disposition default changed to defer nextDial. |
| 0.1.5 | `39c02f3` | 2026-06-17 15:43 PT | EX phase-out/login simplification test; added stricter active-call guard concepts. |
| 0.1.6 | `00f581b` | 2026-06-17 16:08 PT | CX current call guard. |
| 0.1.7 | `ce5da75` | 2026-06-17 16:47 PT | Claimed-call hold guard. |
| timing | `93d2716` | 2026-06-17 17:23 PT | CX handoff timing logs. |
| 0.1.9 | `0f5a862` | 2026-06-18 17:26 PT | CX handoff stabilization; nextDial default re-enabled, but without direct UI staging. |
| live now | working diff over `0f5a862` | 2026-06-19 | Temporary rollback: all three buttons defer nextDial again. |

## What Was In Place

### 0.1.1 (`2225726`)

Relevant file: `apps/web-client/src/workspaces/cx/CXWorkspace.tsx`

Disposition flow:

- `submitQueueDisposition()` always called `pickNextCallHandoffLead()`.
- It always built `nextDial` when a next queue lead and phone were available.
- It sent that `nextDial` inside the disposition mutation payload.
- Before the server response, if there was an immediate handoff candidate, it called `optimisticallyEjectDispositionLead({ skipAutoServe: true })`.
- On a confirmed response, it called `stageNextCallHandoffLead(nextQueueLead)`.
- `releaseQueueAfterSuccess()` used `preserveCurrentLead: nextDialAccepted`, then the explicit stage call replaced the center card with the next lead.
- There was no `deferNextDial` option.

Plain English:

`0.1.1` was fast because disposition and next dial were joined. It also had real optimism: remove current lead immediately, then stage the next lead when backend said the next call was accepted/confirmed.

Risk:

- If backend acceptance/confirmation was too loose, the UI could get ahead of RingCX.
- But if RingCX gave a clean `nextDialAccepted`, this was the smooth version.

### 0.1.2 (`5ec9e1f`)

Relevant file: `apps/web-client/src/workspaces/cx/CXWorkspace.tsx`

Disposition flow stayed materially the same as `0.1.1`:

- Still no `deferNextDial`.
- Still always selected a next queue lead.
- Still sent `nextDial` with disposition.
- Still optimistically ejected the current lead before the response when a next handoff existed.
- Still directly staged the next lead after `nextDialAccepted`.

What changed around the path:

- Voicemail added watchdog/settling behavior.
- VM drop flow still eventually called `submitQueueDisposition("did-not-answer", "Voicemail", ...)`, which meant VM also inherited the same nextDial handoff behavior.

Plain English:

`0.1.2` appears to preserve the smooth handoff model. It did not turn off nextDial. It mainly hardened VM/button settling around that model.

### 0.1.3

No literal `0.1.3` commit exists in the current branch history.

Working assumption:

- If people refer to "1.3", they likely mean the working period between `0.1.2` and `0.1.4`.
- The actionable comparison is therefore `5ec9e1f..990dc36`.

### 0.1.4 (`990dc36`)

Relevant file: `apps/web-client/src/workspaces/cx/CXWorkspace.tsx`

This is the clean break in client behavior.

Changed:

- Added `deferNextDial?: boolean`.
- Set `const shouldDeferNextDial = options.deferNextDial ?? true`.
- `nextQueueLead = shouldDeferNextDial ? null : pickNextCallHandoffLead()`.
- VM explicitly called `submitQueueDisposition(..., { deferNextDial: true, ... })`.
- Answer/No Answer inherited the default, so they also stopped sending nextDial unless explicitly overridden.

Important nuance:

- `0.1.4` still did `shouldOptimisticallyEject = hasImmediateNextHandoff || shouldDeferNextDial`.
- Since `shouldDeferNextDial` defaulted true, it could still eject/clear the current lead quickly, even though it was no longer sending the next dial in the disposition payload.

Plain English:

`0.1.4` did not just slow handoff. It changed the architecture from "submit disposition with nextDial" to "submit disposition, clear locally, then let auto-serve find the next lead." That is probably the point where the older smooth progressive-dial feel was lost.

Risk:

- Because current lead clearing and next lead dialing became separate flows, the UI had more chances to show empty/transition/loading states.
- It may have hidden some race conditions by no longer sending nextDial, but at the cost of speed.

### 0.1.5 to 0.1.7 (`39c02f3`, `00f581b`, `ce5da75`)

Relevant files:

- `packages/shared-services/src/ringcxDialExecutionService.js`
- `packages/shared-services/src/cxWorkspaceService.js`
- `packages/shared-services/src/cxCadenceService.js`
- `packages/shared-services/src/ringcxAgentMonitorService.js`
- `apps/web-client/src/workspaces/cx/CXWorkspace.tsx`

Major changes:

- Introduced/expanded strict active call confirmation mechanics.
- Added `RINGCX_CAMPAIGN_REQUIRE_ACTIVE_CALL_CONFIRMATION`.
- Added `unconfirmed-active-call` style failure/reclaim states.
- Added guard behavior so clear/disposition paths do not advance if the agent still appears to be on an active CX call.
- Added current-call/claimed-call hold guards to prevent Tracey -> Veronica class leaks.
- Began canonical/shadow call state plumbing.

Important backend nuance:

- At `39c02f3`, `captureAsync` still came from `RINGCX_CAMPAIGN_CALL_CAPTURE_ASYNC` independently.
- Strict confirmation existed, but strict did not yet force `captureAsync = false`.
- That means a dangerous configuration was possible: `nextDial` enabled plus async capture enabled plus confirmation required. In that shape, the UI/server could disagree about whether a new call was really confirmed.

Plain English:

These commits were mostly safety work. They address real bugs, but they do not restore the old `0.1.2` progressive handoff. They add gates around active-call truth.

### `93d2716` - Timing Logs

Relevant file: `apps/web-client/src/workspaces/cx/CXWorkspace.tsx`

Added:

- `nextDialHandoffTimingRef`.
- `queue_handoff.submit`.
- `queue_handoff.response`.
- `queue_handoff.uii_observed`.
- `queue_handoff.restore_serving`.

Plain English:

This commit is observability, not the core behavior. Keep this. It is how we measure whether any future handoff is actually faster or just prettier.

### 0.1.9 (`0f5a862`)

Relevant files:

- `apps/web-client/src/workspaces/cx/CXWorkspace.tsx`
- `packages/shared-services/src/ringcxDialExecutionService.js`

Client behavior:

- Changed `const shouldDeferNextDial = options.deferNextDial ?? false`.
- This re-enabled nextDial by default.
- It removed the old direct `stageNextCallHandoffLead(nextQueueLead)` behavior in the normal disposition path.
- On accepted/queued nextDial, it holds auto-serve and shows a waiting transition instead of immediately staging the next lead.
- It sets `preserveCurrentLead: false`, so it clears the current card rather than preserving/staging the next one directly.

Backend behavior:

- `RINGCX_CAMPAIGN_REQUIRE_ACTIVE_CALL_CONFIRMATION=true` now forces `captureAsync = false`.
- Capture defaults became faster/more explicit: `8000ms` total, `250ms` interval.
- Added timing fields like `captureFirstPollMs`, `captureUiiFoundMs`, `publishMs`, `metadataWriteMs`, `responseReturnMs`.

Plain English:

`0.1.9` is not a return to `0.1.2`. It is a third shape:

1. send nextDial,
2. require backend confirmation,
3. do not directly stage the next lead,
4. wait for confirmed serving/current call state to bring it back.

This is safer than `0.1.2`, but slower and more dependent on the restore path being perfect.

### Live Now - Temporary Rollback Over `0f5a862`

Relevant file: `apps/web-client/src/workspaces/cx/CXWorkspace.tsx`

Live/client-only change:

- Added `DEFER_DISPOSITION_NEXT_DIAL = true`.
- `submitQueueDisposition()` defaults to `options.deferNextDial ?? DEFER_DISPOSITION_NEXT_DIAL`.
- Answer explicitly passes `deferNextDial: true`.
- No Answer explicitly passes `deferNextDial: true`.
- Voicemail explicitly passes `deferNextDial: true`.

Plain English:

Live now has `0.1.9` backend safety plus `0.1.4`-style "do not send nextDial" at the client. It is the conservative/manual wait state.

## Main Finding

The version that felt smooth was probably not just "nextDial on." It was this combined behavior from `0.1.1`/`0.1.2`:

1. disposition payload included `nextDial`;
2. current lead was locally ejected immediately;
3. backend accepted/confirmed next call;
4. client directly staged the known next queue item.

`0.1.4` removed step 1 by default.

`0.1.9` restored step 1 but did not restore step 4. It waited for serving/current-call restore instead.

Today's rollback removes step 1 again.

## Working Hypothesis

The headaches likely came from losing the original joint handoff and then trying to rebuild it indirectly:

- `0.1.4`: no nextDial, separate auto-serve loop, more loading/waiting.
- later: strict confirmation and guards added real safety, but not the old immediate "I know the next lead; stage it after confirm" behavior.
- `0.1.9`: sends nextDial again, but the UI does not use the known next lead as the stage target. It waits for backend/current-call state to rediscover it.

The likely next architecture is not full rollback to raw `0.1.2`. It is:

1. keep strict confirmation on;
2. keep async capture off when strict is on;
3. send `nextDial` with disposition;
4. hold a transition overlay while waiting;
5. when backend returns a confirmed UII for that exact next queue item, stage the same next lead object the client already selected;
6. never stage if backend returns queued/unconfirmed/no UII.

That gives the old speed shape with the newer safety boundary.

## Questions To Resolve In The Next Audit Pass

1. Did production ever run `0.1.1`/`0.1.2` with `RINGCX_CAMPAIGN_CALL_CAPTURE_ASYNC=true` and no strict confirmation?
2. Was `0.1.4` deliberately intended to kill nextDial, or was it a conservative artifact of the VM/drop cleanup?
3. In `0.1.9`, when `nextDialAccepted` is true, does the returned payload contain enough exact identity to stage the preselected queue item safely without waiting for the broader restore loop?
4. Can the queue item that "disappears and reappears" be held in a local pending slot, hidden from queue, then promoted only on exact UII confirmation?
5. Should appointment submit keep its separate immediate `dialAny` + `stageNextCallHandoffLead` logic, or should it be normalized to the same confirmed handoff helper later?

## Files To Keep Watching

- `apps/web-client/src/workspaces/cx/CXWorkspace.tsx`
- `packages/shared-services/src/cxWorkspaceService.js`
- `packages/shared-services/src/ringcxDialExecutionService.js`
- `packages/shared-services/src/cxCadenceService.js`
- `packages/shared-services/src/ringcxAgentMonitorService.js`
- `packages/shared-services/src/cxCallLifecycleService.js`
- `packages/shared-services/src/cxCallStateGuard.js`

