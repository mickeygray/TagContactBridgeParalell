# App Stability Cleanup Roadmap (Simplified Execution Edition)

Purpose: make the app easier to keep alive and debug with minimal behavior change, by replacing fragile or duplicated patterns with smaller, explicit, reusable code paths. The cleanup goal is subtractive: remove unnecessary work, break serial load chains, and move nonessential work away from the user's critical path.

## Simplification thesis

The app has accumulated additive fixes: guards, retries, pollers, hydration effects, repair loops, and self-healing checks. Some are necessary, but they can also create flicker, slow first login, and slow admin/metrics loads when they run serially or run on every screen boot.

Before adding another guard, ask:

> Can this work be removed, precomputed, parallelized, cached, or moved off the interactive path?

Primary symptoms this cleanup should target:

- CX flicker, where multiple effects or backend records compete to advance or restore the current lead.
- Slow agent login, where OAuth readiness, CX prep, queue generation, and workspace hydration happen while the agent waits.
- Slow metrics/admin load, where reconciliation, history, or heavy reads block the first useful screen.

The intended direction is not "more safety code everywhere." It is fewer moving parts, clearer ownership, and less serial work.

## Guiding principles

- Keep behavior stable unless a change directly fixes a known bug class.
- Prefer the smallest possible PR that removes risk and is easy to reason about.
- Group changes by risk level, not by file size.
- Standardize once, then reuse; avoid inventing one-off implementations.
- Avoid broad route reshuffles during operational work.
- Use this document as the single source of truth for scope.
- Prefer deleting or relocating work over adding compensating guards.
- Prefer parallel reads over serial hydration when data dependencies do not require sequencing.
- Prefer morning prep, nightly close, and cached snapshots over live recomputation during login or first render.
- Keep the interactive path narrow: login, current lead, current call, and current coach state should not wait on unrelated metrics, history, or repair work.

## Scope in this workspace

- `apps/control-plane`
- `apps/inbound-gateway`
- `apps/outbound-gateway`
- `apps/ringcentral-cx`
- `apps/ai-bus` (if present in your environment)
- `apps/web-client`
- `packages/shared-*`

## Global success criteria (applies to every phase)

- Login, queue handoff, no-answer, voicemail, and coach/session flows stay stable.
- No silent worker/thread failures.
- Shutdown behavior is deterministic and inspectable.
- Logs show identity chain (`caseId`, `sessionId/queue key`, agent, action, outcome).
- Each PR can be safely rolled back.

## How to read this section

Each item is written as: **file → simplification you’d make** while preserving functional behavior.

## Phase -1 - Critical path audit

This phase is read-only until the dependency graph is clear. It exists to find subtractive fixes before we write another additive patch.

Target flows:

- Agent login and CX auth readiness.
- CX workspace first render.
- Current lead hydration.
- Queue generation and refill.
- Metrics workspace first render.
- Live coach session lookup.
- Admin call/recording panels.

Audit questions:

- What must finish before the user can see a useful screen?
- What can be fired in parallel?
- What can wait until a panel opens?
- What can be precomputed before agents log in?
- What can be read from a snapshot first, then refreshed in the background?
- Which "self-heal" or repair paths only need to run after a failure?
- Which client effects are restoring stale state after a newer call/lead is already active?

Expected outputs:

- A small dependency graph for agent login and CX workspace boot.
- A list of serial calls that can become parallel.
- A list of work to move to morning prep.
- A list of metrics/admin data that should be snapshot-first.
- A list of guards, pollers, and effects that can be deleted after the simpler path exists.

Definition of done:

- The first useful CX screen renders with only required identity, queue, and current-call state.
- Metrics pages read a fast snapshot first and refresh deeper data after render.
- No unrelated repair, reconciliation, or historical load blocks login or the main workspace.

## Phase 0 — Critical Safety (P0)

1. [apps/control-plane/src/server.js](C:/Users/micke/Documents/Codex/2026-06-16/can-you-audit-and-tighten-the/work/tagcontactbridgeparallel/apps/control-plane/src/server.js) — normalize webhook protection by replacing repeated inline checks with a single `requireSignedWebhook` helper and apply it consistently to `DROP_WEBHOOK`, `webhook/ex`, and `webhook/ringcentral/*` routes.

2. [apps/control-plane/src/server.js](C:/Users/micke/Documents/Codex/2026-06-16/can-you-audit-and-tighten-the/work/tagcontactbridgeparallel/apps/control-plane/src/server.js) — extract a small `safeEndpoint` wrapper for token/webhook routes that handles rate-limit + signature check + standardized failure envelope.

3. [apps/control-plane/src/server.js](C:/Users/micke/Documents/Codex/2026-06-16/can-you-audit-and-tighten-the/work/tagcontactbridgeparallel/apps/control-plane/src/server.js) — make `/api/internal/rc/access-token` explicitly short-lived + throttled by source identity, then keep existing return contract intact.

## Phase 1 — Worker / lifecycle hardening (P1)

4. [packages/shared-runtime/src/serviceRuntime.js](C:/Users/micke/Documents/Codex/2026-06-16/can-you-audit-and-tighten-the/work/tagcontactbridgeparallel/packages/shared-runtime/src/serviceRuntime.js) — add one simple worker primitive: `createIntervalWorker({name, fn, intervalMs, options}) -> {start, stop, drain}` with default in-flight guard, start/stop logs, and lastError tracking.

5. [apps/outbound-gateway/src/server.js](C:/Users/micke/Documents/Codex/2026-06-16/can-you-audit-and-tighten-the/work/tagcontactbridgeparallel/apps/outbound-gateway/src/server.js) — migrate one low-risk existing interval worker to `createIntervalWorker`.

6. [apps/control-plane/src/server.js](C:/Users/micke/Documents/Codex/2026-06-16/can-you-audit-and-tighten-the/work/tagcontactbridgeparallel/apps/control-plane/src/server.js) — migrate one cleanup/stale-session worker with the same helper and keep startup/shutdown order unchanged.

7. [apps/ringcentral-cx/src/server.js](C:/Users/micke/Documents/Codex/2026-06-16/can-you-audit-and-tighten-the/work/tagcontactbridgeparallel/apps/ringcentral-cx/src/server.js) — migrate stale session/queue janitor loop(s) to the shared worker helper.

8. [apps/inbound-gateway/src/server.js](C:/Users/micke/Documents/Codex/2026-06-16/can-you-audit-and-tighten-the/work/tagcontactbridgeparallel/apps/inbound-gateway/src/server.js) — apply the same helper so lifecycle semantics match across services.

## Phase 2 — Data correctness (P1)

9. [packages/shared-services/src/clientCaseDiscoveryService.js](C:/Users/micke/Documents/Codex/2026-06-16/can-you-audit-and-tighten-the/work/tagcontactbridgeparallel/packages/shared-services/src/clientCaseDiscoveryService.js) — replace pre-check/create branching with a single atomic upsert path (`$setOnInsert` + matching filter), eliminating TOCTOU-like attribution drift.

10. [packages/shared-repositories/src/paymentLedgerRepository.js](C:/Users/micke/Documents/Codex/2026-06-16/can-you-audit-and-tighten-the/work/tagcontactbridgeparallel/packages/shared-repositories/src/paymentLedgerRepository.js) — make the upsert filter include tenant/domain so one tenant’s ledger can’t overwrite another tenant’s payment row.

11. [packages/shared-repositories/src/caseProfileRepository.js](C:/Users/micke/Documents/Codex/2026-06-16/can-you-audit-and-tighten-the/work/tagcontactbridgeparallel/packages/shared-repositories/src/caseProfileRepository.js) — add one tiny payment dedupe helper that always produces a stable payment key; use it before any `totalPaid` mutation path.

12. [packages/shared-repositories/src/caseProfileRepository.js](C:/Users/micke/Documents/Codex/2026-06-16/can-you-audit-and-tighten-the/work/tagcontactbridgeparallel/packages/shared-repositories/src/caseProfileRepository.js) — collapse `firstPaymentDate` / `lastPaymentDate` updates into one guarded atomic update object (no split updates).

13. [packages/shared-services/src/paymentReconcileService.js](C:/Users/micke/Documents/Codex/2026-06-16/can-you-audit-and-tighten-the/work/tagcontactbridgeparallel/packages/shared-services/src/paymentReconcileService.js) — extract `reconcilePaymentTransaction(...)` and ensure ledger + counter updates share one controlled success/failure path.

## Phase 3 — Runtime robustness (P2)

14. [packages/shared-services/src/caseProfilePaymentSyncService.js](C:/Users/micke/Documents/Codex/2026-06-16/can-you-audit-and-tighten-the/work/tagcontactbridgeparallel/packages/shared-services/src/caseProfilePaymentSyncService.js) — replace silent lock-release swallowing with explicit warning + retry marker so stale lock risks are visible.

15. [packages/shared-services/src/socialResponderService.js](C:/Users/micke/Documents/Codex/2026-06-16/can-you-audit-and-tighten-the/work/tagcontactbridgeparallel/packages/shared-services/src/socialResponderService.js) — wrap interval body in one `safeTick` guard so one exception does not terminate periodic cleanup.

16. [packages/shared-services/src/dialService.js](C:/Users/micke/Documents/Codex/2026-06-16/can-you-audit-and-tighten-the/work/tagcontactbridgeparallel/packages/shared-services/src/dialService.js) — keep sweep cap behavior but emit a structured event when stale-session cap is reached.

17. [packages/shared-services/src/cxWorkspaceService.js](C:/Users/micke/Documents/Codex/2026-06-16/can-you-audit-and-tighten-the/work/tagcontactbridgeparallel/packages/shared-services/src/cxWorkspaceService.js) — make post-call cleanup paths explicit and awaited, with structured outcome logging instead of fire-and-forget warn-only calls.

18. [packages/shared-services/src/cxWorkspaceService.js](C:/Users/micke/Documents/Codex/2026-06-16/can-you-audit-and-tighten-the/work/tagcontactbridgeparallel/packages/shared-services/src/cxWorkspaceService.js) — convert queue refill fallback from warning-only side effects into a helper that returns `{ok, reason}` and logs through the worker/observability contract.

## Phase 4 — Observability and error shape

19. [packages/shared-observability/src/logger.js](C:/Users/micke/Documents/Codex/2026-06-16/can-you-audit-and-tighten-the/work/tagcontactbridgeparallel/packages/shared-observability/src/logger.js) — add a narrow structured log helper for repeated CX/coach/voicemail paths with fields for operation, latency, caseId, sessionId, and outcome.

20. [packages/shared-errors/src/index.js](C:/Users/micke/Documents/Codex/2026-06-16/can-you-audit-and-tighten-the/work/tagcontactbridgeparallel/packages/shared-errors/src/index.js) — codify a single lightweight error envelope helper (`ok:false`, `error`, optional `code`, `requestId`) and use it in edited high-risk routes.

21. [apps/ringcentral-cx/src/server.js](C:/Users/micke/Documents/Codex/2026-06-16/can-you-audit-and-tighten-the/work/tagcontactbridgeparallel/apps/ringcentral-cx/src/server.js) — rename/log event names in touched handlers to `cx.queue.*`, `cx.disposition.*`, `coach.session.*`, `vm.drop.*`, `metrics.close.*` without changing handler behavior.

22. [apps/control-plane/src/server.js](C:/Users/micke/Documents/Codex/2026-06-16/can-you-audit-and-tighten-the/work/tagcontactbridgeparallel/apps/control-plane/src/server.js) — standardize route error payload shape only for the routes touched in this phase.

## Phase 5 — Import + config simplification

23. [packages/shared-services/src/index.js](C:/Users/micke/Documents/Codex/2026-06-16/can-you-audit-and-tighten-the/work/tagcontactbridgeparallel/packages/shared-services/src/index.js) — keep pure exports only; move init/registration side effects to an explicit `init` module and call from service startup.

24. [packages/shared-config/src/index.js](C:/Users/micke/Documents/Codex/2026-06-16/can-you-audit-and-tighten-the/work/tagcontactbridgeparallel/packages/shared-config/src/index.js) — split compose-orchestrate responsibilities into smaller modules and avoid one file owning all env and app assembly.

25. [packages/shared-config/src/env.js](C:/Users/micke/Documents/Codex/2026-06-16/can-you-audit-and-tighten-the/work/tagcontactbridgeparallel/packages/shared-config/src/env.js) — add typed env accessors with explicit defaults to reduce repeated normalization logic.

26. [packages/shared-config/src/companyConfig.js](C:/Users/micke/Documents/Codex/2026-06-16/can-you-audit-and-tighten-the/work/tagcontactbridgeparallel/packages/shared-config/src/companyConfig.js) — isolate tenant/company resolution from runtime bootstrap.

## Phase 6 — Controlled bloat reduction

27. [packages/shared-services/src/cxWorkspaceService.js](C:/Users/micke/Documents/Codex/2026-06-16/can-you-audit-and-tighten-the/work/tagcontactbridgeparallel/packages/shared-services/src/cxWorkspaceService.js) — extract one bounded helper cluster (queue handoff/disposition cleanup), only after a regression test or assertion is added.

28. [packages/shared-services/src/cxCadenceService.js](C:/Users/micke/Documents/Codex/2026-06-16/can-you-audit-and-tighten-the/work/tagcontactbridgeparallel/packages/shared-services/src/cxCadenceService.js) — extract a single cadence predicate helper for repeated eligibility checks.

29. [apps/web-client/src/workspaces/cx/CXWorkspace.tsx](C:/Users/micke/Documents/Codex/2026-06-16/can-you-audit-and-tighten-the/work/tagcontactbridgeparallel/apps/web-client/src/workspaces/cx/CXWorkspace.tsx) — extract pure formatting/helper functions from render-only concerns when a bug fix is already touching that area.

30. [packages/shared-services/src/ringcxDialExecutionService.js](C:/Users/micke/Documents/Codex/2026-06-16/can-you-audit-and-tighten-the/work/tagcontactbridgeparallel/packages/shared-services/src/ringcxDialExecutionService.js) — extract one helper family only if it maps to an active bug class and keep runtime path unchanged.

31. [packages/shared-services/src/taxResolutionSalesTrainerService.js](C:/Users/micke/Documents/Codex/2026-06-16/can-you-audit-and-tighten-the/work/tagcontactbridgeparallel/packages/shared-services/src/taxResolutionSalesTrainerService.js) — similarly extract only one helper block with explicit tests before moving route-facing logic.

## Non-goals (still in force)

- No queue semantics redesign.
- No cadence algorithm rewrite.
- No broad UI redesign.
- No production feature additions during this cleanup branch.
- No import churn without a concrete lifecycle/startup or safety gain.

## Execution discipline

- Every PR should include one of the phases above, no more.
- One PR may include at most two of the same service files to keep rollback simple.
- Do not move to the next phase until the previous phase smoke checks pass.
- If a change is uncertain, defer it to the next phase rather than widening scope.
