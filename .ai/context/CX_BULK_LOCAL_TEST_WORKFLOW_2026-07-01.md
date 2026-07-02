# CX Bulk Local Test Workflow - 2026-07-01

This note captures the recovered end-of-thread workflow for resuming CX 0.2 alpha live testing after the Codex Desktop crash/context loss. It is intentionally operational: use it to rebuild a clean Mickey local bulk test pool, verify the `cxbl` identity path, and identify what can still fight the RingCX active-call poller.

## Hard Guardrails

- Do not restart `Parallel*` or NSSM services from Codex. If a restart is needed, ask Mickey which service to restart and wait for confirmation.
- Do not reset, revert, clean, or broadly rewrite the live-test working tree.
- Do not use UI state alone as pass/fail evidence. Pair the browser with backend logs, session documents, queue rows, and RingCX active-call evidence.
- Keep local bulk testing separate from the live legacy rail. Legacy `parallel:*` active calls may exist, but they are not the ID family under test here.
- Build test supply in small slices. Prefer 10ish rows for the initial test, with a refill pool behind it.

## Recovered Tail Facts

The last working theory from the recovered conversation was not "bad UI polling" by itself. The bigger issue was multiple things trying to own call state at the same time.

Recovered observations:

- The local bulk rail must use `cxbl-*` extern IDs. The watcher matches active RingCX calls by `externId` first, then `queueItemId`; it must not promote by phone alone.
- The previous bad test mixed legacy/mirror tooling into a local bulk test. That produced or surfaced `parallel:*` IDs, which are valid for legacy but wrong for this bulk workflow.
- The desired morning workflow is: load roughly 10 yellow leads, let RingCX progress through them, and when live slots drop to about 5, refill from the same yellow pool without any agent button click.
- On-hook/off-hook should not decide whether the queue can be built or refilled. It only matters later for user-facing control, such as an eventual on/off-hook button or appointment wrap behavior.
- The poller diagnostic added near the end of the last session is `cx.alpha.watch.match_diagnostic`. That is the main backend breadcrumb for active-call matching.
- The likely top conflict is still the EX presence lifecycle path. It can write or clear `AgentState.currentCall`, `status`, and `activePlatform`, while the bulk rail is trying to project RingCX active calls into the session current.

## Correct Local Bulk Path

Use the app/control-plane bulk route as the path under test:

- Start/load session: `POST /api/cx/bulk-load/start`
- Read session: `GET /api/cx/bulk-load/session`
- Terminal buttons: `POST /api/cx/bulk-load/disposition`
- Appointment wrap: `POST /api/cx/bulk-load/appointment-wrap`
- Manual support routes exist, but the normal morning flow should not require extra button clicks.

Known Mickey WYNN local route from recovered prep:

- Domain: `WYNN`
- Account: `50810001`
- Campaign: `2306`
- Dial group: `963`
- Agent group: `2187`
- Dial priority: `NORMAL`

The route should be passed through the bulk start API or resolved by the app's agent route logic. Scripts may be used to prepare supply, but the actual test should prove the app route works.

## Queue Pool Recipe

For the clean 10ish-yellow test, the source rows must be in `CxDialQueue` and match the reservation query used by the bulk rail.

Required row shape:

- `domain: "WYNN"`
- `state: "ready"`
- `releaseAt <= now`
- `queueFamily: "fresh-day16to30"` for yellow
- `queueFamilyRank: 2`
- `queueTier: "later"`
- `phone`, `name`, and `caseId` populated
- `rcxAccountId: "50810001"`
- `rcxCampaignId: "2306"`
- `rcxDialGroupId: "963"`
- no appointment lock: `metadata.appointmentId` missing, null, or empty string
- no active sibling in the legacy UCQ/QueueItem pool for the same case

Recommended counts:

- Initial target: about 10 yellow rows.
- Refill threshold: about 5 live slots.
- Extra ready rows behind the first 10: enough to watch at least one refill cycle.

Important: do not preload RingCX with an old script that builds `parallel:*` extern IDs. The bulk runtime builds the publish ID at reservation/publish time as:

`cxbl-wynn-<session-token>-<queueItemId>`

That ID is what RingCX should echo back in account active calls and what the watcher should match.

## What The Bulk Runtime Does

The current bulk path is:

1. `/api/cx/bulk-load/start` resolves the agent and route.
2. `startCxBulkLoadSession` creates a fresh `cxbl-<uuid>` session.
3. `fillBuffer` computes family deficits, reserves rows through `reserveFromFamilyOrder`, and stamps ownership metadata.
4. Each reserved row is published to RingCX with a bulk extern ID from `buildBulkLoadExternId`.
5. Only after a guarded publish stamp succeeds does the candidate enter `acceptedBuffer`.
6. `maybeRefill` runs when `liveSlots <= refillThreshold`, reserves more rows, publishes them, and preserves the same `cxbl` ID convention.

The refill should be automatic. Agents should not need a "Start next" button in the normal progressive flow.

## How UII Attachment Should Work

The account active-call watcher is the intended owner of bulk current-call projection.

The watcher:

- reads RingCX account active calls through `listActiveCalls({ product: "ACCOUNT", productId: accountId })`;
- normalizes `externalId`, `externId`, or `outboundExternid` into `externId`;
- matches against the candidate pool by `externId`, then by `queueItemId`;
- attaches the RingCX `uii` to the matched candidate;
- promotes the matched candidate into `session.current`;
- keeps `prevActiveExternIds` and `trace.prevActiveCalls` so a call that appears and disappears between polls can still be terminalized if it had a real UII.

Expected match diagnostics:

- `matchStatus: "matched"` with `matchReason: "externId"` is the clean path.
- `matchStatus: "empty"` means no relevant active calls were visible.
- `matchStatus: "ambiguous"` with `live-calls-no-identity-match` means RingCX has active calls, but none match the current bulk candidate pool.
- `transitionKind: "switch"` should move the middle card to the newly active candidate and terminalize the old one only with terminal write proof.

## Things That Can Fight The Poller

Confirmed conflicts:

- EX presence webhook path: `processPresenceEnvelope` can write `currentCall`, `status`, and `activePlatform` from EX presence. It also calls the presence bridge and downstream call-session reconciliation.
- EX presence poller path: `reconcilePolledPresence` can write or clear the same fields unless the mode is `off` or the runtime is effectively `cx-only`.
- EX mismatch reconciliation: `stuck_oncall`, `stuck_ringing`, `stuck_disposition`, and `session_mismatch` can clear or replace the current call based on EX state.
- Startup/reinit presence seed: `seedPresenceForAgents` can refresh agent state from EX presence on process startup or RingCentral platform reinit unless disabled.
- Legacy publish/mirror routes: anything that uses the old queue card, `publishQueueItemToRingcx`, or `parallel:*` extern IDs is outside the local bulk identity contract.

Likely or situational conflicts:

- UI-side polling or local staging can make the middle panel look stale, but it should not be treated as root cause unless the backend session is correct.
- Review hold can intentionally pause promotion and log `matchStatus: "held-review"`.
- The cadence worker, reapers, load balancer, and UCQ cross-pool interlocks can move or reject rows before publish; check queue row state before calling it a poller bug.
- Terminal outbox/drain timing can make buttons appear broken if `session.current` is missing or has no UII.
- Old standalone testing scripts can create plausible-looking local rows that do not match the route, state, family, or ID shape that the app path needs.

## Evidence Checklist For The Next Test

Before Mickey starts:

- Confirm services are already in the expected state. Do not restart anything from Codex.
- Confirm there is no active bulk session for Mickey unless intentionally continuing one.
- Confirm the RingCX-side lead list for the Mickey test route is drained.
- Confirm app-side ready supply: about 10 `WYNN` yellow rows matching account `50810001`, campaign `2306`, and dial group `963`.
- Confirm no `parallel:*` IDs are in the new local bulk session buffer.

At start:

- Call the real bulk start route, target about 10, refill threshold about 5.
- Read `/api/cx/bulk-load/session` and confirm `runtime: "bulk_load"`, `status: "running"`, `acceptedBuffer` populated, and extern IDs start with `cxbl-wynn-`.
- Confirm RingCX active calls echo the same `cxbl-wynn-...` extern ID.

During calls:

- Watch `cx.alpha.watch.match_diagnostic`.
- Compare `activeCalls`, `relevantActiveCalls`, `candidatePool`, `matchedCandidate`, `transitionKind`, `current`, and `currentPromotion`.
- The middle card should follow the candidate whose extern ID matches the RingCX active call.
- At about 5 live slots, `maybeRefill` should refill from the yellow ready pool and continue using `cxbl-wynn-...`.

Stop conditions:

- A RingCX active call has a `cxbl-wynn-...` extern ID but the watcher reports no matching candidate.
- The session current has a different queue item or UII than the RingCX active call.
- EX logs show `ringcentral.ex.presence.processed`, `ringcentral.ex.poll.reconciled`, `ringcentral.ex.poll.status_updated`, or `session_mismatch` near the moment current-call state flips unexpectedly.
- The app buffer contains `parallel:*` or old local script extern IDs.

## EX Watcher Disable Discussion Prep

The user's next intended move is to disable the EX presence lifecycle before testing. Going slow means first disabling behavior, proving silence, then considering deletion later.

Current code facts:

- `RC_CX_EX_PRESENCE_POLL_MODE=off` disables the polling body; the poller still starts but ticks return `presence-poller-disabled`.
- `RC_CX_RUNTIME_MODE=cx-only` also makes `exPresencePollMode()` return `off` and `exCxPollWriteMode()` return `cx-owned`.
- `RC_CX_EX_POLL_CX_WRITE_MODE=cx-owned` preserves CX-owned state if the poller runs, but it is still less clean than turning the poller off.
- `RC_PRESENCE_STARTUP_SEED_ENABLED=false` prevents startup/reinit presence seeding.
- The webhook route still calls `processPresenceEnvelope`; turning the poller off does not necessarily silence live EX webhook events if a subscription is delivering them.

Small safe disable plan to discuss next:

1. Set runtime/env for the RingCentral CX service so local bulk is `cx-only`, EX poll mode is `off`, and startup seed is disabled.
2. Add, if needed, a narrow env-gated no-op around the EX presence webhook processing path so presence webhooks can be acknowledged without writing agent call state during the test.
3. Ask Mickey to restart the relevant NSSM service after the env/code decision. Codex must not restart it.
4. Verify startup logs show the poller mode as off or disabled, and verify no EX presence processed/reconciled/status-updated logs appear during the test window.

## Next Safe Coding Slices

Do these only after this workflow is accepted:

- Add a small, explicit EX presence webhook disable flag if the current env flags only disable polling and seed.
- Add or adjust a read-only prep/check script that reports Mickey WYNN ready yellow supply, active bulk session, and forbidden legacy IDs without writing.
- If no app route exists for building a small test supply, add a deliberately scoped route or script for creating route-matched `ready` yellow rows. Keep it separate from RingCX publish.
- Add a lightweight verification command that prints bulk session buffer/current IDs and watcher match diagnostics without dumping PII.

