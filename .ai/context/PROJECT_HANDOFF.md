# Project Handoff

Date: 2026-06-30

## What Happened

Codex Desktop crashed or lost context during CX 0.2 alpha live testing. The prior project conversation was not recoverable from the inspected Codex state, so the durable context was rebuilt from repository docs, git state, runtime logs, and the Codex SQLite log database.

The user explicitly asked not to edit app code yet. This handoff records the recovered state and the safe next steps before coding resumes.

## What Was Recovered

- The repo is on branch `release/0.2.0-alpha`.
- The branch was ahead of origin by these commits at recovery time:
  - `269b71c docs(cx): add final 0.2.0 scrub verification`
  - `f5a9217 chore(alpha): add test observability harness`
  - `3f7421d feat(cx): harden alpha bulk call flow`
- The working tree was dirty with code, docs, tests, and log artifacts. Treat those changes as intentional WIP until proven otherwise.
- A saved test log, `tmp-alpha-audit-tests.out.log`, showed `187 pass / 0 fail`.
- The expected old Codex thread/session context was not found in the inspected Codex stores.

Recovered project intent from the docs:

- RingCX owns live call truth. The app should project RingCX-proven active call state, not infer truth from UI alone.
- Alpha pass/fail needs evidence from logs, health endpoints, Mongo, RingCX, or alpha audit artifacts.
- Stop-test issues include wrong agent, wrong lead, wrong UII, wrong case, client leakage, wrong campaign, or wrong refill.
- Bulk mode should have one current-call owner, one terminal outbox writer, one refill owner, and no phone-only matching.
- Terminal outcomes must be durable and idempotent. UII evidence comes before outcome evidence.
- Stale-serving recovery is observe-first and fail-closed. The Bruce edge case is not a broad "no active call means no-answer" rule.
- Coach/gRPC behavior and CX call mechanics are judged separately. Coach can be intentionally off during CX validation.

Recovered WIP themes from the dirty tree:

- Bulk alpha runtime mode disables legacy cadence and queue paths.
- Bulk UI disables legacy queue/simple-loop surfaces.
- First-touch supply and queue reservation paths track max attempts.
- Active-call watchers hold current state through pending RingCX switch periods.
- Stale-serving reconciler reads dequeue timing from bulk active-call stamps.
- Workspace service blocks legacy dial requests in bulk mode.
- Cadence service guards against double-counting terminal UII evidence.

## Runtime State At Recovery

All inspected `Parallel*` NSSM services were stopped:

- `ParallelControlPlane`
- `ParallelInboundGateway`
- `ParallelMongo`
- `ParallelNginx`
- `ParallelNgrok`
- `ParallelOutboundGateway`
- `ParallelRestartHelper`
- `ParallelRingCentralCx`

No target app ports were listening during the check. The web client log showed proxy failures to `127.0.0.1:5001`, consistent with the control plane being down while the web client had been trying to proxy requests.

Known NSSM service destinations:

- Mongo data: `C:\code\TagContactBridgeParalell\runtime\mongodb-data`
- NSSM logs: `C:\tools\logs`
- RingCentral CX app: `apps\ringcentral-cx\src\server.js`
- Control plane app: `apps\control-plane\src\server.js`
- Inbound gateway app: `apps\inbound-gateway\src\server.js`
- Outbound gateway app: `apps\outbound-gateway\src\server.js`

## What Context Is Still Missing

- The original Codex project thread and detailed pre-crash conversation.
- Any live human observations made immediately before the crash.
- The exact RingCX and Mongo state at the moment of the crash.
- Whether the user wants the NSSM stack restarted immediately or wants more inspection first.
- Which dirty files are intended for the next commit versus temporary live-test artifacts.

## Where Logs And Sessions Live

Codex recovery paths:

- Expected Codex home: `C:\code\agents\codex-home`
- Expected logs folder: `C:\code\agents\codex-home\log`
- Expected sessions folder: `C:\code\agents\codex-home\sessions`
- Expected archived sessions folder: `C:\code\agents\codex-home\archived_sessions`
- Actual inspected log database fallback: `C:\code\agents\codex-home\logs_2.sqlite`

Active Codex home inspected separately:

- `C:\Users\micke\.codex`
- It contained only new/current recovery-era sessions and an unrelated smoke test, not the lost project thread.

Project/runtime log locations:

- `C:\tools\logs`
- `C:\code\TagContactBridgeParalell\logs`
- `C:\code\TagContactBridgeParalell\runtime`
- `C:\code\TagContactBridgeParalell\runtime\alpha-log-sections`
- `C:\code\TagContactBridgeParalell\runtime\live-coach-grpc-bridge`

## What To Read Before Continuing

Start here:

- `AGENTS.md`
- `.ai/context/CODEX_RECOVERY_NOTES.md`
- `docs/CX_0_2_ALPHA_TEST_OBSERVABILITY_RUBRIC_2026-06-29.md`
- `docs/CX_0_2_ALPHA_LOG_FLEET_RUNBOOK_2026-06-30.md`

Then read the current alpha implementation context:

- `docs/CX_0_2_0_PRE_ALPHA_REVIEW_PUNCHLIST_2026-06-29.md`
- `docs/CX_0_2_0_DEFECT_FIXES_NOTES_2026-06-29.md`
- `docs/CX_0_2_0_ALPHA_SCALE_TEST_LOGGING_STRATEGY_2026-06-29.md`
- `docs/CX_STALE_SERVING_DIAGNOSTIC_NOTES_2026-06-29.md`
- `docs/CX_STALE_SERVING_EDGE_CASE_BRUCE_2026-06-29.md`
- `docs/CX_COACH_SINGLE_MODEL_COLLAPSE_NOTES_2026-06-30.md`
- `docs/CX_CURRENT_STATE_AUDITOR_GUIDE_2026-06-25.md`
- `docs/CX_CANONICAL_CALL_STATE_ARCHITECTURE.md`

## Next Safe Coding Steps

1. Inspect the working tree by topic before editing. Do not reset or revert user/agent WIP.
2. If a `Parallel*`/NSSM service restart is needed, ask Mickey to perform it. Do not attempt service restarts from Codex.
3. If launching, validate Mongo, control plane, RingCentral CX, web client, health endpoints, and ports before live actions.
4. Run the alpha rubric preflight and capture alpha log sections before making behavioral claims.
5. If coding resumes, patch one narrow area at a time: active-call ownership, terminal idempotency, first-touch attempts, stale-serving diagnostics, bulk UI legacy disablement, or runtime gating.
6. Re-run targeted tests and save evidence after each slice.
7. Keep raw logs, secrets, and temporary recovery artifacts out of commits unless the user explicitly asks to preserve them.
