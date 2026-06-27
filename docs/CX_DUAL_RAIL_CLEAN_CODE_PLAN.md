# CX Fresh Dial Rails Clean Code Plan

Purpose: replace the patched legacy CX dialing behavior with two clean, fresh rails. The goal is not to keep sanding the current `CXWorkspace` / `nextDial` / simple-loop stack. The goal is a floor-safe runtime switch between two intentionally written modes:

```text
slow_single -> fresh one-lead-at-a-time mode, stability first
bulk_load   -> fresh RingCX-owned buffer mode, throughput first
```

The old legacy flow remains only as an emergency rollback during the migration. It is not the target fallback. The new fallback is `slow_single`, written from scratch with the lessons learned from the legacy pain.

The rails must be independently runnable and independently disabled. Shared code is allowed only where it is truly domain-neutral: auth, RingCX client primitives, lead eligibility reads, phone normalization, active-call reads, and final metric/cadence writes.

## Document Map (read this first)

This plan grew across several sessions and holds more detail — and a few overlapping file lists — than any single pass needs. Read in this order; treat these as the source of truth when sections disagree.

**The model (what we are actually building):** two physically separate stacks, each a complete collection of functions tied to its own but visually identical client version. The new (`bulk_load`) stack runs alongside the current (`slow_single` / `legacy_emergency`) stack with **nothing shared but boring primitives**, so the new version can be **tested silently in parallel** (Mickey-local first) while the floor runs the old one untouched. Isolation is the whole point — see `## Clean Code Rules For The Split`.

**How you select a stack:**

- Primary (v1, silent test): the **client build flag** `VITE_CX_WORKSPACE_MODE=legacy_emergency|slow_single|bulk_load` (`## Workspace File Shape`). A build is wired to exactly one stack; switching = client rebuild + refresh, never live server surgery. This is what makes the silent parallel test possible.
- Later phase (live-floor canary): the **server resolver** `CX_DIAL_RUNTIME_*` (`## Runtime Selector`) routes individual agents to a rail within one shared deployment. Build this only once the bulk stack has earned live floor time; it is not the v1 switch. The two are complementary layers (build flag = which stack a build serves; server resolver = per-agent override on a shared deployment), not competing rollback mechanisms.

**Canonical names (resolve the drift between sections):**

- Client workspaces — `## Workspace File Shape` wins: `CXWorkspaceRouter`, then `legacy/CXWorkspaceLegacy`, `slow-single/CXWorkspaceSlowSingle`, `bulk-load/CXWorkspaceBulkLoad`, `shared/*` (presentational only). The `CxDialRuntimeRouter` / `Cx*Workspace` names once used in `### 11` are superseded.
- Backend services keep rail-first names: slow = `cxSlowLane*`, bulk = `cxBulkLoad*`. "simple loop" / `cxSimpleCallLoopService` / `CxSimpleLoopSession` = the **old live prototype being replaced**, referenced only as the thing the fresh rails supersede, never a name for new code.
- Resolver (`cxDialRuntimeModeService`): `resolveCxDialRuntimeMode`, `isCxBulkLoadRuntime`, `buildCxDialRuntimeMetadata`.
- Bulk session repo (`cxBulkLoadSessionRepository`): `createSession`, `getSessionBySessionId`, `getSessionByAgent`, `updateSession`, `deleteSession`.

**Which spec to implement from:**

- Slow lane: `## Slow Lane Fallback Clean Implementation` (files `cxSlowLane*`).
- Bulk rail: the contracts in `### Function-level seam by file` + the build order in `## Execution Checklist` (files `cxBulkLoad*`). `### Final File Set` and `## File Series` are longer narratives of the same set; **where a file or function name disagrees, the Execution Checklist wins.**
- One-button dial: `## One-Button Disposition→Dial (PREVIEW)`.
- Background / reasoning only (NOT a build spec): `## Authoritative Implementation Plan`, `## Judgment: Rewrite vs Pull Forward`, `## Current Commingling To Remove`.

## Clean Code Rules For The Split

This rebuild is a subtraction project. The winning implementation is the smallest one that lets agents dial, see the active call, submit the correct outcome, and move on.

Hard rules:

- One mode, one controller. Do not make one workspace file branch through both lifecycles.
- Same UI shape is fine; shared lifecycle state is not.
- Functions do one job and return one shape.
- No helper should both mutate our queue and call RingCX.
- No helper should both call RingCX and update the visible React form.
- No mode should import another mode's service, state machine, or React controller.
- Shared services are allowed only for boring primitives.
- All state transitions must be traceable by one session id / agent id / queue item id / UII.
- Every button press should have one backend command and one result object.
- Never hide a second write inside a "convenience" helper.

Allowed shared primitives:

```text
auth/context resolution
domain normalization
phone normalization
RingCX client request wrappers
lead eligibility read snapshots
active-call read snapshots
metrics/cadence outcome adapter
logging/trace helpers
```

Forbidden shared mutable plumbing:

```text
servedQueue React state
nextDial handoff
cxSimpleLoop prototype state
bulk session state inside slow_single
slow lane pending state inside bulk_load
legacy EX poll ownership
optimistic stage/restore effects
button handlers that branch by mode
```

## Clean Code Principles (how to achieve it)

The rules above say *what* the split forbids. This says *how* to build each component so the rules hold by construction — keyed to the actual files. Every example is an anti-fusion seam: the place where an implementer will naturally collapse two jobs into one.

**Layer per rail; never layer a function.** Three tiers, one direction. *Pure core* (`cxBulkLoadStateMachine`, `matchActiveCallToCandidates`, `deriveCurrentTransition`, externId builders) is total in its inputs — no Mongo, RingCX, clock, or React — and tests with plain objects, zero mocks. *Adapters* (session repo, RingCX publisher, active-call watcher, outcome adapter) each wrap exactly one external system and return plain data. *Orchestrator* (runtime service) is the only sequencer. The watcher tick proves it: `loadActiveCallsSnapshot` (effect) → `matchActiveCallToCandidates` + `deriveCurrentTransition` (pure pair) → orchestrator applies — not one `watchTick()` that fetches, matches, and mutates current.

**One job, one return shape; if you need "and," split.** `ensureBuffer` is three jobs as written — the name needs an "and" ("compute deficit *and* snapshot/publish *and* persist"). Lift the math out of the I/O path so `ensureBuffer` only sequences deficit → snapshot → publish → `repo.update`. Same tell in `watch` ("reconcile … *and* … complete previous"): the completion is a hidden second write — route it through the outcome adapter, never inside `watch`'s body.

**Fewest moves: derive, don't store; the call's own result IS the probe.** The one-button flow is the minimal `dispose → confirm → dial` because the dial's resolved value *is* the availability probe — there is no separate go-available poll. Mirror that: a candidate's published-vs-active *display* state derives from the session arrays, not a flag re-stamped on each card. (The one deliberate exception is `current` — a first-class persisted object carrying `phase`/`activeEvidence` that the state machine writes; that one is stored on purpose.) No recursive advance loop; advance is one pure pop fired by the orchestrator on `accepted`.

**One writer per fact, enforced by a key not by prose.** Terminal outcomes are written only by the outcome adapter's `persistTerminalOutcome`, idempotent on `(sessionId, candidateId, eventType)` — so a double-click and the auto-advance close both funnel to one writer and "once" is true by the key, not a `closed` guard on the session. That `(sessionId, candidateId, eventType)` key is canonical for the terminal write; the state machine's `(candidateId, queueItemId)` is the per-candidate guard one layer up, so the two never double-write. Kill is *not* on this path: `cancelBatchForSession` clears current and cancels published-but-undialed candidates without emitting any terminal disposition — never fabricate an outcome for a lead that never connected.

**Typed results, not boolean soup.** The watcher returns `{ kind: 'observed' | 'ambiguous' | 'empty' }` — one kind per the state-machine event it feeds — so "publish accepted does not mean active" is a type, not a convention. Classify errors *at the adapter seam* (`classifyDispose`/`classifyPlace` → `{kind:'accepted'|'soft_false'|'reject'|'live'}`); the orchestrator switches on `.kind` and never re-derives outcome from `resp !== false` at each call site.

**One-way deps; the import graph is the proof.** Pure core imports nothing; adapters import client + core types; orchestrator imports adapters + core; no mode imports the other's service/state/controller. The shared terminal button is *presentational only* — takes `onSubmit` + a typed render-state — so identical-looking step lists stay two orchestrators.

**The test is the atomicity proof.** If a piece needs RingCX, Mongo, *and* a clock mocked, it is mixing layers — split until each tests with plain inputs. The pure pair (matcher + transition) needing no mock is the bar; hold every adapter to the read/reuse/forbid deny-list (`Must not call: claimNextReadyQueueItem, requestCxDial`) that makes "read-only" checkable.

## Codex Notes: Keeping The Build Small

The implementation should be organized around user-visible verbs, not around existing services. A good file answers one plain sentence:

```text
select candidates
publish candidate
watch active call
submit outcome
advance state
render state
```

If a function name needs "and", "then", "also", or "maybe", it is too large.

### The Fewest-Moves Backend Shape

For each rail, write small use-case functions. They may call adapters, but they should not become adapters themselves.

Slow single:

```text
startSlowSingleCall(agent)
  -> select one candidate
  -> publish one candidate
  -> persist pending/current state

watchSlowSingleCurrent(agent)
  -> read RingCX active calls
  -> match one candidate
  -> promote pending to current

submitSlowSingleOutcome(agent, outcome)
  -> write terminal outcome once
  -> dispose/end RingCX current
  -> clear current
```

Bulk load:

```text
prepareBulkBuffer(agent)
  -> select deficit
  -> publish one-by-one
  -> append accepted candidates

watchBulkCurrent(agent)
  -> read RingCX active calls
  -> match active to accepted buffer
  -> promote exactly one current

submitBulkOutcome(agent, outcome)
  -> write terminal outcome once
  -> dispose/end RingCX current
  -> remove consumed candidate
```

No use-case function should directly know React state, toast copy, route paths, or raw RingCX request URLs.

### One Command Per Button

The client should treat each terminal button as a single command:

```text
POST /cx/bulk-load/outcome
POST /cx/slow-single/outcome
```

The command result should be typed by phase:

```text
{
  ok: true,
  phase: "releasing" | "dialing_next" | "waiting_active_call" | "current" | "failed",
  current: null | CurrentCall,
  nextAction: null | "watch_active_call" | "retry_release",
  trace: { sessionId, agentExtensionId, queueItemId, uii }
}
```

Do not return a giant legacy workspace object. Do not return every queue row. Do not make the client infer whether to clear the middle panel from six booleans.

### State Is A Small Object

Each rail should persist a small session/current state object, not an expanding mirror of the old workspace.

Minimum fields:

```text
sessionId
mode
agentExtensionId
agentEmail
phase
current
buffer
lastOutcome
lastError
updatedAt
```

Current call:

```text
candidateId
queueItemId
externId
domain
caseId
name
phoneLast4
uii
phase
activeEvidenceAt
```

Everything else is derived or fetched on demand. The UI does not need the whole queue document to show the middle panel.

### Make Adapters Boring

RingCX adapter functions should be thin and literal:

```text
loadOneLeadToRingcx(candidate, priority)
loadManyLeadsToRingcxSequentially(candidates, priority)
readActiveCalls(agentOrAccountScope)
disposeRingcxCall(uii, disposition)
```

They return normalized data. They do not pick the next lead, update Mongo, advance a session, or decide UI copy.

Repository functions should be equally dull:

```text
getSession(sessionId)
saveSession(session)
appendAcceptedCandidates(sessionId, candidates)
setCurrent(sessionId, current)
clearCurrent(sessionId, reason)
recordOutcomeOnce(key, outcome)
```

If a repository function calls RingCX, it is wrong. If a RingCX adapter writes Mongo, it is wrong.

### Review Checklist For Every PR

Before merging any section, answer these in code review:

- Can I explain every function in one sentence?
- Does any function both call RingCX and write Mongo?
- Does any function both mutate backend state and update React state?
- Does the client mount exactly one mode controller?
- Does a terminal button send exactly one command?
- Is every terminal write idempotent?
- Is active call matching externId/queue identity first?
- Is phone-only matching absent or explicitly weak/diagnostic?
- Can the mode be disabled without cleaning data by hand?
- Can logs trace the path by session id, agent id, queue item id, and UII?

If any answer is no, split the code before adding more behavior.

### Red Flags To Stop On

These are signs the rewrite is turning back into the old system:

- a function has more than one external side effect,
- route handlers contain business logic,
- React effects decide call lifecycle,
- a shared helper imports a mode service,
- a mode service imports `CXWorkspace`,
- a "temporary" flag changes call lifecycle,
- a response shape uses `ok` without a specific `phase`,
- a stale lead is visible while a release is in progress,
- a terminal button can be clicked twice and create two outcomes.

## Workspace File Shape

The agent-facing app can look the same in both modes, but it should mount different clean implementations.

```text
apps/web-client/src/workspaces/cx/CXWorkspaceRouter.tsx
  -> reads build/runtime flag
  -> mounts exactly one implementation

apps/web-client/src/workspaces/cx/legacy/CXWorkspaceLegacy.tsx
  -> emergency old workspace only

apps/web-client/src/workspaces/cx/slow-single/CXWorkspaceSlowSingle.tsx
  -> clean one-at-a-time fallback

apps/web-client/src/workspaces/cx/bulk-load/CXWorkspaceBulkLoad.tsx
  -> clean RingCX-buffer mode

apps/web-client/src/workspaces/cx/shared/*
  -> visual-only shared panels/components
```

The shared folder should contain presentational components only. If a shared component needs to know how a call advances, it is no longer shared.

Runtime/build flag example:

```text
VITE_CX_WORKSPACE_MODE=legacy_emergency
VITE_CX_WORKSPACE_MODE=slow_single
VITE_CX_WORKSPACE_MODE=bulk_load
```

The rollback target is a client rebuild and hard refresh, not another live server surgery.

## Clean Client Implementation Note

The client split should preserve the UX that agents recognize while removing the lifecycle spaghetti underneath it. Treat the current live client as evidence, not as the implementation to copy.

Before rewriting `slow_single`, read the live-proven behavior and extract only the facts:

- what successfully starts a lead,
- what blocks accidental lead switching,
- what button/result states agents depend on,
- what refresh/poll signals actually restore a current call,
- what parts exist only because older patches fought each other.

Then rewrite the slow mode as fresh code.

Do not port these patterns forward:

- stacked `useEffect` restore/suppress loops,
- mode flags inside one button handler,
- stale localStorage execution-mode overrides,
- optimistic staging before backend acceptance,
- toast-only loading states,
- fallback behavior hidden inside broad helpers.

Use one explicit client state machine per mode. For terminal handoff, the shared visual shape can be:

```text
current
  -> releasing
  -> dialing_next
  -> waiting_active_call
  -> current
```

The middle panel should be allowed to go blank/grey during that transition. That is better than showing stale contact data while RingCX catches up.

Transition copy:

```text
releasing            "Submitting disposition..."
dialing_next         "Starting next call..."
waiting_active_call  "Waiting for RingCX..."
```

Only the final `current` state restores the live form and terminal buttons. This is the clean UI answer to the flicker problem: agents see motion, but stale data is never actionable.

## First Pass Build Checklists

These are the two first-pass task lists. Each checklist must stand on its own. Do not complete an item in one rail by importing mutable lifecycle code from the other rail.

### Checklist A: `slow_single`

### Slow Single: Error-Bounded Simplification Notes (single-load confirm)

Target: one lead in progress, confirm-driven transitions, minimal code, no legacy coupling.

- [ ] `apps/control-plane/src/routes/cxSlowSingle.js`: keep handlers thin. Each route performs auth + runtime gate + one service call + session snapshot response.
- [ ] `apps/control-plane/src/routes/commandsCx.js`: do not add slow-single business logic. Add only wiring that chooses handler by route, no lifecycle flags set here.
- [ ] `apps/control-plane/src/routes/readCx.js`: remove any slow-single current inference from `servedQueue`/nextDial when runtime is slow_single.
- [ ] `packages/shared-services/src/cxSlowLaneStateMachine.js`: keep pure transition helpers only. States: `idle`, `pending_publish`, `pending_confirm`, `active`, `releasing`, `completed`, `failed`.
- [ ] `packages/shared-services/src/cxSlowLaneService.js`: orchestrator does exactly 4 commands: `start`, `watchCurrent`, `submitOutcome`, `killSession`.
- [ ] `packages/shared-services/src/cxSlowLaneService.js`: `watchCurrent` only promotes when active evidence matches pending/current candidate; otherwise returns `waiting`.
- [ ] `packages/shared-services/src/cxSlowLaneService.js`: on successful publish set `phase='pending_confirm'` and store pending candidate; never set `current` from publish result.
- [ ] `packages/shared-services/src/cxSlowLaneService.js`: add `confirmMissedLimit` (small constant, e.g., 5-8). On repeated non-matches, set `phase='failed'` and clear pending, then force caller to retry via explicit restart.
- [ ] `packages/shared-services/src/cxSlowLaneService.js`: terminal buttons always call `submitOutcome` once; outcome adapter is idempotent on `(sessionId,candidateId,eventType)`.
- [ ] `packages/shared-services/src/cxSlowLaneService.js`: after terminal outcome, clear `current` and return `phase='releasing'` so UI can transition to watch-driven wait.
- [ ] `packages/shared-services/src/ringcxActiveCallCaptureService.js`: add `matchActiveCallToCandidate` helper for one-at-a-time matching; no phone-only fallback branch.
- [ ] `packages/shared-services/src/ringcxActiveCallCaptureService.js`: return explicit proof shape (`observed|ambiguous|none`) instead of boolean truthiness.
- [ ] `packages/shared-models/src/CxSlowLaneSession.js`: reduce persisted session payload to session metadata + one `current` + one queue of next candidates; remove dead fields from old loop.
- [ ] `packages/shared-repositories/src/cxSlowLaneSessionRepository.js`: isolate updates to narrow patch functions (`setCurrent`, `clearCurrent`, `setPending`, `recordOutcomeOnce`).
- [ ] `apps/web-client/src/workspaces/cx/slow-single/CXWorkspaceSlowSingle.tsx`: one-step phase machine only (`waiting_active_call`, `releasing`, `current`) and explicit clear on terminal action.
- [ ] `apps/web-client/src/workspaces/cx/slow-single/CXWorkspaceSlowSingle.tsx`: do not read `selectedLead`, `servedQueue`, or `agentstates.cxCall` to derive current.
- [ ] `apps/web-client/src/lib/api/queries/cxSlowSingle.ts`: single route hooks only; no derived queue transforms in query layer.
- [ ] `tests/cx-simple-loop/cxSimpleCallLoopService.test.js`: repurpose as reference for expectations only; split slow-single covered tests into `tests/cx-slow-lane/` with one spec per seam (state machine, watcher, idempotent outcome).
- [ ] `packages/shared-services/src/index.js` and `packages/shared-models/src/index.js`: export only intentionally used slow_single symbols, remove old aliases still consumed by routes.

Goal: clean, stable one-lead-at-a-time fallback. This is the floor-safety rail.

### Bulk Load: first pass (simplest, bounded guard)

Constraint: **keep only what is required for this pass** — start/watch/outcome, evidence-only current, and bounded error handling.

- [ ] `packages/shared-models/src/CxBulkLoadSession.js`: keep schema to fields actually used by pass one.
  - `runtime`, `status`, `agent`, `ringcx`, `candidates`, `current`, `buffer`, `stats`, `events`.
  - Remove derived/stateful fields that only drive legacy-style UI logic.
- [ ] `packages/shared-repositories/src/cxBulkLoadSessionRepository.js`: add only narrow atomic patch operations.
  - `createSession`, `getSessionBySessionId`, `getSessionByAgent`, `updateSession`, `deleteSession`.
  - No calls to RingCX / queue write helpers here.
- [ ] `packages/shared-services/src/cxBulkLoadLeadSourceService.js`: read snapshot once and publish from that list.
  - Keep candidate identity stable (`externId`, `queueItemId`) and deterministic ordering only for repeatability.
  - No “best candidate” sorting after session start; we only need list fullness.
- [ ] `packages/shared-services/src/cxBulkLoadRingcxPublisher.js`: only 2 public behaviors in first pass.
  - `publishBatchToRingcx(session,candidates)` sends the whole publish set.
  - `cancelBatchForSession(session)` drains/cancels remaining published-but-unconsumed candidates.
- [ ] `packages/shared-services/src/cxBulkLoadActiveCallWatcher.js`: `matchActiveCallToCandidates` is the single truth source for current.
  - Match only by strict identity evidence (`externId`, then `queueItemId`); no phone-first.
  - Return explicit result kinds: `matched`, `ambiguous`, `none`.
- [ ] `packages/shared-services/src/cxBulkLoadRuntimeService.js`: orchestrator sequence stays minimal.
  - `startCxBulkLoadSession`: create session → publish batch (bulk) → persist snapshot.
  - `watchCxBulkLoadSession`: one evidence read, one deterministic transition.
  - `submitCxBulkLoadDisposition` / `skipCxBulkLoadSession`: idempotent completion of exactly one current.
  - `killCxBulkLoadSession`: clear current + cancel batch + set terminal session state.
- [ ] `packages/shared-services/src/cxBulkLoadActiveCallWatcher.js` + `cxBulkLoadRuntimeService.js`: add bounded hardening.
  - Count consecutive unmatched watches (`consecutiveMisses`) with small cap (e.g., 8).
  - On cap breach, move to `failed` with explicit message and require manual recovery.
- [ ] `apps/control-plane/src/routes/cxBulkLoad.js`: route handlers stay thin.
  - Only auth/running-mode gate + service call + snapshot return.
  - No matching/outcome policy in route layer.
- [ ] `apps/control-plane/src/server.js`: mount only one bulk surface; keep `cxSimple` off in bulk mode.
- [ ] `apps/web-client/src/workspaces/cx/CXWorkspace.tsx`: when runtime resolves to `bulk_load`, render `CXWorkspaceBulkLoad` only.
- [ ] `apps/web-client/src/workspaces/cx/bulk-load/CXWorkspaceBulkLoad.tsx`: show only:
  - `session.current`, `buffer` status, loading/release state.
  - hide stale assumptions: no queue list order, no guessed next lead.
- [ ] `apps/web-client/src/workspaces/cx/bulk-load/CXWorkspaceBulkLoad.tsx`: on terminal click, clear UI immediately and move to watch phase, not assume new current.
- [ ] `apps/web-client/src/lib/api/queries/cxBulkLoad.ts`: one hook per route only, no transform layer.
  - `useCxBulkLoadStart`, `useCxBulkLoadSession`, `useCxBulkLoadWatch`, `useCxBulkLoadDisposition`, `useCxBulkLoadSkip`, `useCxBulkLoadKill`.
- [ ] `apps/control-plane/src/routes/readCx.js` + `apps/control-plane/src/routes/commandsCx.js`: do not consume legacy `servedQueue` / `selectedLead` / `nextDial` as current truth in bulk runtime path.
- [ ] `tests/cx-bulk-load/*`: keep tests atomic and small.
  - state machine + witness kind handling + one current transition per watch + one terminal write per action.

Pass-one acceptance for bulk:

- [ ] New leads are loaded in bulk and list is replenished only by count threshold.
- [ ] Current advances only from active-call evidence.
- [ ] Polling misses are bounded and fail closed.
- [ ] One button action = one completion.

- [ ] Read live `legacy_emergency` behavior and write down only the facts to preserve.
  - What starts a call reliably?
  - What prevents lead switching?
  - What terminal button responses are trusted?
  - What poll/refresh signals restore a real current call?
- [ ] Create `cxSlowLaneStateMachine.js`.
  - Pure states: `idle`, `selecting`, `publishing`, `pending_confirmation`, `active`, `releasing`, `released`, `failed`.
  - No Mongo, no RingCX, no clock.
- [ ] Create slow-lane session persistence.
  - Store one small session/current object.
  - No old `servedQueue`, no `nextDial`, no `cxSimpleLoop`.
- [ ] Create slow-lane lead selector.
  - Select exactly one eligible candidate.
  - Return plain candidate data only.
  - Do not publish inside the selector.
- [ ] Create slow-lane RingCX publish adapter.
  - Publish one lead to RingCX.
  - Default normal queue leads to `NORMAL`.
  - Return `accepted`, `pending`, or `rejected`.
  - Do not write Mongo inside the adapter.
- [ ] Create slow-lane active-call watcher.
  - Read RingCX active calls.
  - Match the pending candidate to active evidence.
  - Promote only one current call.
  - Never cancel only because UII is late.
- [ ] Create slow-lane outcome adapter.
  - Terminal writes are idempotent.
  - RingCX disposition/end-call is awaited for terminal buttons.
  - Orphan cleanup runs after accepted terminal response.
- [ ] Create slow-lane runtime service.
  - `startSlowSingleCall`
  - `getSlowSingleSession`
  - `watchSlowSingleCurrent`
  - `submitSlowSingleOutcome`
  - `killSlowSingleSession`
- [ ] Create slow-lane routes.
  - Routes only validate/auth and call runtime service.
  - No business logic in route handlers.
- [ ] Create slow-lane React hooks.
  - One hook per route.
  - No legacy workspace object returned.
- [ ] Create `CXWorkspaceSlowSingle.tsx`.
  - Same visual workspace shape.
  - Dedicated state machine: `current -> releasing -> dialing_next -> waiting_active_call -> current`.
  - Terminal buttons send one command and disappear/disable immediately.
- [ ] Wire `CXWorkspaceRouter.tsx`.
  - `VITE_CX_WORKSPACE_MODE=slow_single` mounts only the slow lane.
  - No legacy effects mount in this mode.
- [ ] Add tests.
  - State machine pure tests.
  - Publish adapter normalized result tests.
  - Active match tests.
  - Idempotent terminal outcome tests.
  - Client smoke test: terminal button disables and waits for confirmed current.

Done when:

- [ ] One lead can be selected, published, shown active, dispositioned, and cleared.
- [ ] No next lead renders until active evidence exists.
- [ ] Accepted-but-no-UII is a waiting state, not a scary error.
- [ ] A client rebuild can switch back to `legacy_emergency`.

### Checklist B: `bulk_load`

Goal: RingCX-owned buffer with one source of truth: RingCX-active evidence.

Pass scope (first completion): start/watcher/outcome only.

- [ ] `packages/shared-models/src/CxBulkLoadSession.js`: keep only one minimal session schema:
  - session metadata, runtime status, `current`, `candidates`, `refill`, `stats`, `events`.
  - states are `pending | published | active | completed | cancelled | failed`.
- [ ] `packages/shared-repositories/src/cxBulkLoadSessionRepository.js`: patch APIs only (`create/get/update/delete`).
  - no queue writes, no RingCX calls.
- [ ] `packages/shared-services/src/cxBulkLoadLeadSourceService.js`: pure snapshot of eligible rows.
  - deterministic order
  - identity fields (`queueItemId`, `externId`) only
  - filter already-known candidates
  - no state mutation.
- [ ] `packages/shared-services/src/cxBulkLoadRingcxPublisher.js`:
  - `publishBatchToRingcx` for bulk writes.
  - `cancelBatchForSession` for kill.
  - no per-call publish loop in steady state.
- [ ] `packages/shared-services/src/cxBulkLoadActiveCallWatcher.js`:
  - `loadActiveCallsSnapshot`
  - `matchActiveCallToCandidates`
  - explicit outcomes: `matched`, `ambiguous`, `none`.
  - match keys: `externId` then `queueItemId`.
- [ ] `packages/shared-services/src/cxBulkLoadStateMachine.js`:
  - pure transitions for `pending -> published -> active -> releasing -> completed`.
  - separate event for `waiting_active_call`.
- [ ] `packages/shared-services/src/cxBulkLoadRuntimeService.js`:
  - `startCxBulkLoadSession` (snapshot + first publish + persist)
  - `watchCxBulkLoadSession` (single evidence pass + single transition)
  - `submitCxBulkLoadDisposition` and `killCxBulkLoadSession` (single completion path)
  - bounded miss guard with explicit failure state.
- [ ] `apps/control-plane/src/routes/cxBulkLoad.js` and `apps/control-plane/src/server.js`: thin command surface only, one mount path.
- [ ] `apps/web-client/src/lib/api/queries/cxBulkLoad.ts` + `apps/web-client/src/workspaces/cx/bulk-load/CXWorkspaceBulkLoad.tsx`:
  - session-only source of current
  - buffer is count only
  - terminal click immediately enters release state, then awaits watch confirmation.
- [ ] Tests (`tests/cx-bulk-load/*`):
  - watcher witness shape
  - one publish batch per refill
  - one auto-advance completion
  - one idempotent completion on button click.

Pass-one done:

- [ ] `bulk_load` starts and publishes a full buffer.
- [ ] active call promotion is evidence-based only.
- [ ] list fullness is maintained by threshold refill, not by queue-order assumptions.
- [ ] each button click writes one terminal outcome once.
- [ ] miss counter is bounded, then fails closed.

## Button And Load-In Contract

Load-in is normal and waits for a yes. The UI can show a waiting/release state immediately, but it cannot show the next lead as current until the selected rail receives the affirmative signal it requires.

### Slow Single

```text
load one selected lead
  -> publish one lead to RingCX
  -> wait for RingCX accepted / pending confirmation
  -> show waiting state until active-call evidence arrives
  -> render current only after active evidence
```

Terminal button:

```text
agent clicks terminal button
  -> disable all terminal buttons
  -> clear/grey middle form behind release overlay
  -> send one backend command for current outcome
  -> backend applies outcome/disposition
  -> backend waits for RingCX disposition/end-call response
  -> backend returns accepted/retry/fail
  -> only then select/publish next lead
```

> **Clean-code:** Split into two commands the orchestrator sequences, not one handler. `submitOutcome` does only the idempotent terminal write via the outcome adapter, keyed `(sessionId, candidateId, eventType)`, and returns typed `accepted|retry|fail`; `advanceToNext` is a separate state-machine transition fired ONLY on `accepted`. "Then publish next" is never a tail appended inside the same function.

### Bulk Load

```text
load/refill buffer
  -> publish accepted candidates to RingCX
  -> do not render buffer order as truth
  -> poll/watch RingCX active calls
  -> match active call to one candidate
  -> render only that matched current call
```

Terminal button:

```text
agent clicks terminal button
  -> disable all terminal buttons
  -> push current into terminal processing
  -> send one backend command for current outcome
  -> backend writes outcome exactly once
  -> backend waits for RingCX disposition/end-call response when applicable
  -> current clears
  -> UI waits for next RingCX active-call match
```

Important distinction:

- `publish` means RingCX accepted a lead into the campaign queue.
- `active` means RingCX shows a live/current call.
- `terminal` means the call outcome is accepted and the current is finished.

Those are three separate concepts. Do not collapse them into one boolean named `ok`.

## Two Fresh Modes

### 1. `slow_single`

Fresh slow lane. One lead at a time. No optimistic next-lead handoff. No fixed "miss means cancel" timeout.

```text
select one eligible lead
  -> publish one lead to RingCX
  -> if RingCX rejects: release and show error
  -> if RingCX accepts: show waiting/pending
  -> active-call watcher promotes to active when RingCX evidence arrives
  -> terminal button submits disposition/outcome
  -> release UI and backend state
  -> then select the next lead
```

Design priorities:

- correctness over speed,
- no agent-facing scary errors for normal RingCX lag,
- no next lead visible until current lead is released,
- no cancellation just because UII is late,
- no bulk queue or RingCX order assumptions,
- clear "working" UI while waiting.

### 2. `bulk_load`

Fresh throughput lane. RingCX owns the dial buffer. Our UI shows only the active call RingCX reports, not our guessed queue order.

```text
snapshot eligible candidates
  -> publish/refill a RingCX buffer
  -> watch active calls once per second with account-level cache
  -> match active call to candidate by strong identity
  -> render only the matched active candidate
  -> terminal button writes outcome once
  -> refill when buffer reaches threshold
```

Design priorities:

- never render candidate order as truth,
- match by `externId` / queue identity / UII, not phone-only,
- auto-advance means RingCX changed active calls; prior current gets closed once,
- refill is background work,
- the UI is a current-call panel, not a queue-order panel.

### Shared Components Allowed

Both fresh modes may share:

- runtime resolver,
- RingCX client primitives,
- lead eligibility snapshot readers,
- active-call reader/cache,
- phone/domain normalization,
- outcome/cadence/metrics adapter,
- logging helpers.

Both fresh modes must not share:

- legacy `servedQueue` state,
- legacy `nextDial` handoff,
- legacy EX poll ownership,
- `cxSimpleLoop` prototype state,
- optimistic UI staging code,
- old button submit handlers.

### Runtime Names

Use these names going forward:

```text
slow_single
bulk_load
legacy_emergency
```

`legacy_emergency` is only for rollback while the fresh modes are being built. It should not receive new feature work.

## Build Order

1. Build shared runtime resolver.
   - Inputs: agent/user/domain/env.
   - Outputs: `slow_single`, `bulk_load`, or `legacy_emergency`.
   - No RingCX calls and no Mongo writes.

2. Build `slow_single` first.
   - This becomes the safe fallback.
   - It uses one-lead-at-a-time publish.
   - It has no hard call-confirmation timeout that cancels accepted leads.
   - It gives agents clear waiting/releasing UI states.

3. Build `bulk_load` second.
   - It uses batch/refill publishing.
   - It ignores guessed queue order.
   - It renders only RingCX active-call evidence.
   - It can be canaried per agent.

4. Keep `legacy_emergency` available only until both fresh modes have survived real floor testing.
   - No new features.
   - No new patchwork.
   - Only critical "keep old stuff afloat" fixes.

## Slow Lane Fallback Clean Implementation

The fallback lane cannot remain "the old code path plus whatever flags happen to be live." It needs to be a clean, named implementation whose only job is to keep the floor stable when the bulk rail is not ready.

### Slow Lane Contract

```text
slow_single
  -> one lead selected by our app
  -> one publish request to RingCX
  -> wait for accepted / pending / active evidence
  -> show either waiting state or the confirmed current call
  -> terminal button submits outcome
  -> clear the UI while release happens
  -> then select the next lead
```

This lane is intentionally not fast. Its correctness promise is stronger than its speed promise:

- no next lead is rendered as current until RingCX evidence exists,
- no pending accepted lead is cancelled just because UII was not found inside a short window,
- no broad queue mirroring,
- no RingCX order assumptions,
- no legacy EX presence ownership,
- no UI button state derived from stale previous-call data.

### Lessons To Bake In

1. RingCX accepted-but-no-UII is a pending state, not a hard failure.
   - We learned the 8s/12s capture miss can be too aggressive.
   - The fallback should return `pending_confirmation` / `queued_unconfirmed` and keep the UI in a waiting release/loading state.
   - It should not cancel the published lead unless the agent/session is explicitly killed or RingCX returns a true rejection.

2. Terminal buttons should be visually final immediately, but data-final only after the backend accepts the terminal event.
   - Button click moves the UI into a release overlay.
   - Buttons disappear or disable immediately.
   - The prior form is cleared/greyed so agents do not keep working the previous lead.
   - Metrics/cadence finalization still happens from the backend outcome path.

3. Slow Lane should not use bulk/bulk load state.
   - It may reuse read-only lead eligibility and RingCX client helpers.
   - It must not read or mutate `CxBulkLoadSession`.
   - It must not depend on `cxSimpleLoop` behavior.

4. Capture/polling needs an indefinite-safe shape.
   - Do not block one HTTP request forever.
   - Do not silently abandon the lead.
   - Use a short foreground check for instant wins, then persist `pending_confirmation` and let a watcher reconcile active evidence.
   - A pending shell must expire or be explicitly released so it cannot become another zombie.

5. Errors should distinguish "accepted and waiting" from "rejected."
   - Accepted/waiting is a neutral UI state.
   - Rejected/publish failed is an actionable error.
   - Pending confirmation should log loudly enough for us, but should not throw scary agent-facing errors during normal RingCX lag.

### Slow Lane File Set

Write this as new code. Read the legacy flow only for API details and outcome compatibility, not as the structure to preserve:

```text
packages/shared-services/src/cxSlowLaneFallbackService.js
packages/shared-services/src/cxSlowLaneStateMachine.js
packages/shared-services/src/cxSlowLaneCaptureWatcher.js
packages/shared-services/src/cxSlowLaneOutcomeAdapter.js
apps/control-plane/src/routes/cxSlowLane.js
apps/web-client/src/lib/api/queries/cxSlowLane.ts
apps/web-client/src/workspaces/cx/CXWorkspaceSlowSingle.tsx
```

Registration-only edits:

```text
packages/shared-services/src/index.js
apps/control-plane/src/server.js
apps/web-client/src/workspaces/cx/CXWorkspaceRouter.tsx
```

The existing `CXWorkspace.tsx` can remain as the emergency legacy shell during extraction, but the final fallback must not mount the old optimistic `servedQueue` / `nextDial` juggling effects.

### Slow Lane State Machine

Keep this pure and unit-tested:

```text
idle
  -> selecting
  -> publishing
  -> pending_confirmation
  -> active
  -> releasing
  -> released
  -> idle
```

Failure states:

```text
publish_failed
capture_expired_pending
release_failed_retryable
session_killed
```

Events:

```text
lead.selected
publish.accepted
publish.rejected
confirmation.pending
active_call.confirmed
terminal.clicked
terminal.accepted
terminal.failed_retryable
pending.expired
session.killed
```

Hard rules:

- `publish.accepted` never means `active` by itself.
- `confirmation.pending` keeps the selected lead visible only as waiting, not actionable.
- `active_call.confirmed` requires UII or a strong RingCX identity match.
- `terminal.clicked` disables controls but does not double-write metrics.
- `terminal.accepted` clears current and allows the next select.
- `pending.expired` must not strand a queue row in claimed/serving forever.

### Slow Lane Runtime Flow

```text
start / next
  -> pick exactly one eligible queue row
  -> publish it to RingCX
  -> short foreground active-call capture
     -> if found: current = active
     -> if accepted but not found: current = pending_confirmation
     -> if rejected: release row and show actionable error

watch pending
  -> poll active-call evidence for this agent/lead
  -> on match: current = active
  -> on stale pending timeout: mark retryable/stale and release safely

terminal click
  -> UI enters releasing overlay immediately
  -> submit RingCX disposition/hangup/outcome
  -> on backend accepted: terminal outcome adapter writes once
  -> clear current
  -> next select may begin
```

### Slow Lane UI Contract

The UI should make slowness legible instead of letting agents think the app is broken:

- while selecting/publishing: "Loading next call..."
- while pending confirmation: "RingCX accepted the lead. Waiting for call confirmation..."
- while releasing: "Finishing call..."
- buttons disabled for all non-active states,
- no stale lead fields remain editable during release/pending,
- no red error toast for pending confirmation,
- visible retry/refresh only for true publish/release failures.

### Slow Lane Tests

Add these before using the fallback as the safety rail for a bigger bulk-load test:

```text
tests/cx-slow-lane/cxSlowLaneStateMachine.test.js
tests/cx-slow-lane/cxSlowLaneFallbackService.test.js
tests/cx-slow-lane/cxSlowLaneCaptureWatcher.test.js
tests/cx-slow-lane/cxSlowLaneOutcomeAdapter.test.js
```

Minimum assertions:

- accepted-but-no-UII becomes `pending_confirmation`, not failed/cancelled,
- active evidence promotes pending to active,
- terminal click disables current controls and writes exactly one outcome,
- pending expiry releases/retries without stranding the queue row,
- disabling the bulk load rail routes agents to Slow Lane cleanly,
- no Slow Lane test imports `cxBulkLoad*` or `cxSimpleLoop*`.

### Rollback Use

If the bulk rail regresses, runtime should switch agents to:

```text
CX_DIAL_RUNTIME_DEFAULT=slow_single
```

If `slow_single` itself is broken during migration, use:

```text
CX_DIAL_RUNTIME_DEFAULT=legacy_emergency
```

Then restart `parallel-ringcentral-cx` and refresh clients if the UI runtime router changed.

The fallback should not require data cleanup from bulk sessions. It should pick one clean eligible row and proceed.

## Authoritative Implementation Plan

This section is the current plan. Later sections preserve reasoning and task detail, but this is the version to implement.

### Audit Verdict On The Simplest Draft

The simplest draft is directionally right: one runtime selector, one bulk session object, one watcher, one outcome adapter, and a clean UI fork.

Keep it, with these corrections:

1. Do not use `publishQueueItemToRingcx` in the bulk rail.
   - It is useful reference code, but it stamps legacy queue metadata and includes legacy presence/policy gates.
   - The bulk rail should create its own RingCX lead-loader adapter using the same client and the same payload knowledge.

2. Do not write call placed on publish.
   - Publish means RingCX accepted a lead into a campaign.
   - A countable call starts only when the watcher sees bulk active-call evidence.

3. Do not let route handlers mutate session shape.
   - Routes authenticate, resolve runtime, call service, return sanitized snapshot.
   - Only the runtime service applies state-machine events.

4. Do not mount legacy `CXWorkspace` effects in either fresh mode.
   - UI guards inside old effects are temporary, not a clean split.
   - Runtime routing should return early to `CXWorkspaceSlowSingle` or `CXWorkspaceBulkLoad` before legacy auto-serve/servedQueue effects mount.

5. Bulk upload is allowed, but RingCX order is not truth.
   - The RingCX client already supports `uploadLeads` as one-or-many.
   - The bulk UI never renders candidate order as dial order.
   - The watcher decides current from active-call evidence.

6. Phone-only matching is diagnostic only.
   - It can explain a possible relationship in logs.
   - It cannot promote or switch current.
   - Clean-code: keep this a pure predicate returning a typed `strong-identity | phone-only-diagnostic`, living in core with no import of the session repo. Only strong-identity may yield `active_call.confirmed`; the diagnostic branch returns a log string with no code path to `setCurrent`. Let the import graph prove it can never promote current.

7. Auto-advance is an internal transition reason, not the business outcome.
   - If RingCX changes from one bulk active call to another and no button was pressed, the prior current should complete once as `did_not_connect` with reason `ringcx-active-call-changed`.
   - Keep `cx-auto-advanced` as an event/reason for debugging, not as the cadence outcome.

### Final File Set

Build these files for the shared runtime and bulk rail. Slow lane files are listed above and should be built beside these, not inside legacy `CXWorkspace`:

```text
packages/shared-services/src/cxDialRuntimeModeService.js
packages/shared-models/src/CxBulkLoadSession.js
packages/shared-repositories/src/cxBulkLoadSessionRepository.js
packages/shared-services/src/cxBulkLoadStateMachine.js
packages/shared-services/src/cxBulkLoadLeadSourceService.js
packages/shared-services/src/cxBulkLoadRingcxPublisher.js
packages/shared-services/src/cxBulkLoadActiveCallWatcher.js
packages/shared-services/src/cxBulkLoadOutcomeAdapter.js
packages/shared-services/src/cxBulkLoadRuntimeService.js
apps/control-plane/src/routes/cxBulkLoad.js
apps/web-client/src/lib/api/queries/cxBulkLoad.ts
apps/web-client/src/workspaces/cx/CXWorkspaceRouter.tsx
apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx
```

Modify these existing files only for registration/forking:

```text
packages/shared-models/src/index.js
packages/shared-repositories/src/index.js
packages/shared-services/src/index.js
apps/control-plane/src/server.js
apps/web-client/src/workspaces/cx/CXWorkspace.tsx
```

Do not modify legacy queue behavior in the first implementation pass except for the top-level runtime fork. Fresh modes should live beside legacy until they replace it.

### State Ownership

The bulk rail owns this object:

```text
CxBulkLoadSession
```

The emergency legacy rail currently owns:

```text
CxDialQueue state
servedQueue*
legacy currentCall staging
legacy nextDial handoff
```

The bulk rail may read `CxDialQueue` to create a snapshot, but it must not claim, serve, release, or complete legacy queue rows during publish/watch. Shared finalization happens only through the outcome adapter after a hard event:

- bulk active call observed
- terminal button pressed
- RingCX active call changed away from current
- session killed/cancelled

### Runtime Flow

```text
resolve runtime
  -> if slow_single: mount CXWorkspaceSlowSingle
  -> if bulk_load: mount CXWorkspaceBulkLoad

slow_single start
  -> read one eligible queue row
  -> publish one lead
  -> if accepted but unconfirmed: show pending confirmation
  -> active-call watcher promotes to active
  -> terminal button releases and clears
  -> next lead only after release

bulk_load start
  -> read eligible queue rows
  -> copy candidates into CxBulkLoadSession
  -> publish/refill RingCX buffer

bulk_load watch, once per second
  -> get shared account active-call snapshot
  -> match active call to bulk candidates
  -> if no match: leave current alone
  -> if same current: refresh evidence
  -> if new current: complete previous as did_not_connect/ringcx-active-call-changed, set new current active

bulk_load terminal button
  -> current phase = releasing
  -> send RingCX disposition/hangup if possible
  -> outcome adapter writes terminal once
  -> clear current
  -> ensure buffer
```

### Permanent 7am Queue Builder

The bulk rail needs RingCX to own the visible call buffer before agents log in. That is now a permanent `ringcentral-cx` worker, not a Codex reminder or laptop script:

```text
7am Pacific, weekdays
  -> resolve active CX-routing agents
  -> cancel traceable RingCX-published rows from the prior queue
  -> top up the local queue using existing queue policy rules
  -> mirror the first 30 rows into RingCX one at a time
  -> every publish uses dialPriority=NORMAL
  -> each row waits for RingCX acceptance before the next row is sent
```

Code:

- `packages/shared-services/src/cxMorningQueueBuilderService.js`
- `apps/ringcentral-cx/src/server.js`
- manual/operator sibling: `scripts/cx-drain-and-mirror-agent-queues.js`

Primary envs:

```text
CX_DIAL_RUNTIME_BULK_LOAD_ENABLED=true
CX_MORNING_QUEUE_BUILDER_ENABLED=true        # optional explicit override; false disables
CX_MORNING_QUEUE_BUILDER_HOUR=7
CX_MORNING_QUEUE_BUILDER_MINUTE=0
CX_MORNING_QUEUE_BUILDER_LIMIT=30
CX_MORNING_QUEUE_BUILDER_DOMAIN=WYNN         # optional; empty means use each agent domain
CX_MORNING_QUEUE_BUILDER_DRAIN=true
CX_MORNING_QUEUE_BUILDER_BUILD=true
CX_MORNING_QUEUE_BUILDER_MIRROR=true
CX_MORNING_QUEUE_BUILDER_FORCE_PUBLISH=true
```

Health surfaces:

- `/health` detailed payload includes `morningQueueBuilder`.
- `/api/ringcentral/runtime` includes `morningQueueBuilder.lastResult`.

Success means the morning result shows the expected agent count, `published + reused` near `agents * limit`, and no large `deferred` or `errored` totals. It is acceptable for drain candidates to be zero on a clean morning.

### Implementation Order

1. Add runtime resolver and tests.
2. Add `CxBulkLoadSession` model/repository and tests.
3. Add pure state machine and tests.
4. Add lead source snapshot service as read-only and tests.
5. Add RingCX publisher adapter using direct `loadLeads` payloads and tests.
6. Add active-call watcher with account-level cache/in-flight guard and tests.
7. Add outcome adapter with idempotency and tests.
8. Add runtime service orchestration and tests.
9. Add slow lane routes/workspace behind runtime gate.
10. Add bulk routes/workspace behind runtime gate.
11. Add client API hooks.
12. Run local Mickey/Sean trial in each fresh mode.

### First Shippable Test Scope

The first functional test should be Mickey/local only:

```text
CX_DIAL_RUNTIME_BULK_LOAD_ENABLED=true
CX_DIAL_RUNTIME_AGENT_OVERRIDES=mgray@taxadvocategroup.com:bulk_load
CX_DIAL_RUNTIME_DEFAULT=slow_single
```

Success means:

- non-canary users still resolve to `slow_single` or `legacy_emergency`, depending on the test flag
- Mickey resolves to `bulk_load`
- start snapshots candidates without claiming legacy rows
- RingCX receives candidate batch
- watcher displays only RingCX current
- terminal button completes current once
- active-call change completes prior current once
- disabling `CX_DIAL_RUNTIME_BULK_LOAD_ENABLED` restores `slow_single` without data cleanup

### Explicit Non-Goals For First Pass

- No admin dashboard.
- No metrics repair.
- No preview/progressive campaign migration.
- No old workspace refactor beyond top-level runtime fork.
- No removal of existing simple-loop prototype files until bulk rail works.

## Judgment: Rewrite vs Pull Forward

Rewrite the dialing rails. Do not rewrite neutral primitives.

The clean target is fresh code for `slow_single` and `bulk_load`. Pull forward only the boring shared primitives that are not part of the unstable handoff behavior.

Reuse the following carefully:

- RingCX voice client methods.
- Lead eligibility and queue policy readers.
- Existing cadence/counter finalizers, but only behind a narrow outcome adapter.
- Existing call-log and metrics writers, but only after a hard fact exists.
- Existing phone/domain normalization helpers where available.

Do not reuse the following inside the new rail:

- Legacy `CXWorkspace` local state as source of truth.
- Legacy auto-serve effects.
- Legacy next-dial handoff.
- Legacy `requestCxDial` route.
- Legacy `servedQueue*` state.
- Legacy restore/wrap-up effects.
- Any weak phone-only active-call promotion.

The existing simple-loop files are useful prototype material, but the clean version should be moved into named dual-rail files and stripped of legacy assumptions.

## Current Commingling To Remove

These are the places where rollback is not clean today:

1. The simple loop still loads directly from `cxDialQueueRepository.listQueueItems`.
   - This is acceptable only as a read-only source snapshot.
   - Once copied into the new session, the new rail owns the session copy.

2. The simple loop publishes through `publishQueueItemToRingcx`.
   - The helper is useful, but it stamps legacy queue metadata.
   - Wrap it so the new rail can choose what shared metadata is allowed.

3. The simple loop writes outcomes through `handleCxCallPlaced` and `handleCxTerminalCallOutcome`.
   - These are useful finalization primitives.
   - They must sit behind a new adapter so outcomes are idempotent and never fire from ambiguous state.

4. The client renders simple loop inside `CXWorkspace.tsx`.
   - This is not clean enough.
   - New mode should render a separate workspace component.

5. UI guards such as `if (simpleLoopPanelEnabled) return` are not architecture.
   - They are temporary safety belts.
   - A clean rail should avoid mounting the old effects entirely.

## Runtime Selector

> Scope: this server resolver is the **later-phase live-floor canary** — route individual agents to a rail within one shared deployment. The **primary v1 switch is the `VITE_CX_WORKSPACE_MODE` client build flag** (`## Workspace File Shape`, `## Document Map`). Build this resolver once the bulk stack has earned live floor time, not before.

Add one runtime resolver. Avoid interacting flag soup.

Suggested config:

```text
CX_DIAL_RUNTIME_DEFAULT=slow_single
CX_DIAL_RUNTIME_AGENT_OVERRIDES=mgray@taxadvocategroup.com:bulk_load,slucas@taxadvocategroup.com:bulk_load
CX_DIAL_RUNTIME_BULK_LOAD_ENABLED=false
```

Resolved values:

```text
slow_single
bulk_load
```

Rules:

- If global enable is false, `bulk_load` cannot resolve.
- Per-agent override beats default.
- Admins can view both, but only the resolved rail mutates.
- Client receives the resolved runtime from a read endpoint and mounts only that rail.

## File Series

### 1. Runtime Resolver

Add:

```text
packages/shared-services/src/cxDialRuntimeModeService.js
tests/cx-dial-runtime/cxDialRuntimeModeService.test.js
```

Responsibilities:

- Parse env safely.
- Resolve runtime by user email, extension, role, and optional domain.
- Return `{ runtime, reason, enabled, fallbackRuntime }`.
- Never mutate state.

Exports:

```js
resolveCxDialRuntimeMode({ user, account, domain })
isCxBulkLoadRuntime(resolution)
```

### 2. New Session Model

Keep or replace current prototype model:

```text
packages/shared-models/src/CxBulkLoadSession.js
packages/shared-repositories/src/cxBulkLoadSessionRepository.js
tests/cx-bulk-load/cxBulkLoadSessionRepository.test.js
```

Do not keep calling the final version "simple loop." That name describes the test harness, not the production behavior.

Shape:

```js
{
  sessionId,
  runtime: "bulk_load",
  status: "running" | "paused" | "completed" | "killed" | "failed",

  agent: {
    email,
    extensionId,
    cxAgentId,
    name
  },

  ringcx: {
    accountId,
    dialGroupId,
    campaignId,
    modeHint,
    dialPriority
  },

  source: {
    snapshotAt,
    snapshotReason,
    policyVersion,
    maxQueue,
    refillThreshold
  },

  candidates: [
    {
      candidateId,
      queueItemId,
      domain,
      caseId,
      name,
      phoneHash,
      phoneLast4,
      rawPhoneEncryptedOrOmitted,
      externId,
      campaignId,
      dialGroupId,
      state: "pending" | "publishing" | "published" | "active" | "completed" | "cancelled" | "failed",
      publishedAt,
      activatedAt,
      completedAt,
      uii,
      outcome
    }
  ],

  current: {
    candidateId,
    queueItemId,
    caseId,
    phase: "none" | "confirming" | "active" | "releasing",
    uii,
    activeEvidence,
    startedAt,
    updatedAt
  },

  refill: {
    threshold,
    targetSize,
    inFlight,
    lastRequestedAt,
    lastCompletedAt,
    lastError
  },

  completed: [],
  stats: {},
  events: [],
  lastError
}
```

Important: the session copy is the new rail source of truth. The legacy queue row is only a source record and finalization target.

### 3. State Machine

Add:

```text
packages/shared-services/src/cxBulkLoadStateMachine.js
tests/cx-bulk-load/cxBulkLoadStateMachine.test.js
```

This file should be pure. No Mongo. No RingCX. No timers.

Events:

```text
session.started
candidates.snapshotted
candidate.publish_requested
candidate.publish_accepted
candidate.publish_failed
active_call.observed
active_call.ambiguous
active_call.empty
current.release_requested
current.release_accepted
current.release_failed
current.auto_advanced
candidate.completed
refill.requested
refill.completed
session.paused
session.killed
```

Hard rules:

- Publish accepted does not mean active.
- Active requires strong RingCX evidence.
- UII is preferred, but active evidence can temporarily be non-UII only if it is explicit and non-ambiguous.
- Terminal completion is idempotent by `candidateId` and `queueItemId`.
- Current is cleared only by release/completion/kill, never by random empty poll.
- Auto-advance means RingCX changed active call; it does not mean the app invented a disposition.

### 4. Lead Source Snapshot

Add:

```text
packages/shared-services/src/cxBulkLoadLeadSourceService.js
tests/cx-bulk-load/cxBulkLoadLeadSourceService.test.js
```

Responsibilities:

- Read eligible queue rows from legacy queue policy.
- Normalize them into candidates.
- Exclude candidates already present in the session.
- Respect daily/cadence/DNC rules by reusing existing policy readers.
- Do not mutate old queue rows.

May reuse:

- `cxDialQueueRepository.listQueueItems`
- queue policy helpers
- route/campaign resolution helpers if extracted

Must not call:

- `claimNextReadyQueueItem`
- `transitionQueueItemState`
- `requestCxDial`
- old auto-serve code

### 5. RingCX Publisher Adapter

Add:

```text
packages/shared-services/src/cxBulkLoadRingcxPublisher.js
tests/cx-bulk-load/cxBulkLoadRingcxPublisher.test.js
```

Responsibilities:

- Load candidates into RingCX.
- Return exact accepted/rejected result.
- Capture RingCX identifiers returned by load.
- Cancel/drain candidates for a killed session.
- Hide provider quirks from the state machine.

Preferred approach:

- Extract pure lead-payload building from `ringcxLeadServingService`.
- Reuse the RingCX client.
- Avoid stamping broad legacy queue metadata during publish.

Allowed shared write:

- Optional metadata stamp on the original queue row:

```js
metadata.cxBulkLoad = {
  sessionId,
  candidateId,
  publishedAt,
  externId,
  campaignId,
  dialGroupId
}
```

This stamp must not change legacy state or assignment.

### 6. Active Call Watcher

Add:

```text
packages/shared-services/src/cxBulkLoadActiveCallWatcher.js
tests/cx-bulk-load/cxBulkLoadActiveCallWatcher.test.js
```

Responsibilities:

- Poll RingCX active calls for the account or agent scope.
- Match active calls to session candidates.
- Emit state-machine events.
- Cache account-level active-call snapshots briefly to avoid 7 agents x 1 second turning into waste.

Matching order:

1. `externId`
2. RingCX custom field / loaded lead identifier
3. `queueItemId` if RingCX preserves it
4. campaign + agent + unique candidate identity
5. phone only as diagnostic, never promotion

Outputs:

```js
{
  matched: true,
  ambiguous: false,
  candidateId,
  queueItemId,
  uii,
  evidence: {
    reasons: ["externId"],
    confidence: "strong",
    rawKeys
  }
}
```

### 7. Outcome Adapter

Add:

```text
packages/shared-services/src/cxBulkLoadOutcomeAdapter.js
tests/cx-bulk-load/cxBulkLoadOutcomeAdapter.test.js
```

Responsibilities:

- Convert new rail events into existing business facts.
- Write call placed only once.
- Write terminal outcome only once.
- Update cadence/counters only at terminal or hard active fact.

May reuse:

- `handleCxCallPlaced`
- `handleCxTerminalCallOutcome`
- call-log writers

But call them through idempotency guards:

```text
sessionId + candidateId + eventType
```

### 8. Runtime Service

Add:

```text
packages/shared-services/src/cxBulkLoadRuntimeService.js
tests/cx-bulk-load/cxBulkLoadRuntimeService.test.js
```

Responsibilities:

- Own the orchestration.
- Call lead source, publisher, watcher, and outcome adapter.
- Apply state-machine events.
- Persist sessions.
- Log transitions.

Routes should call this service and nothing else.

Public methods:

```js
startCxBulkLoadSession(input, context)
getCxBulkLoadSession(input, context)
publishCxBulkLoadBatch(input, context)
watchCxBulkLoadSession(input, context)
submitCxBulkLoadDisposition(input, context)
skipCxBulkLoadCurrent(input, context)
killCxBulkLoadSession(input, context)
```

### 9. Routes

Add:

```text
apps/control-plane/src/routes/cxBulkLoad.js
```

Mount under:

```text
/api/cx-bulk-load/session
```

Routes:

```text
POST /start
GET /
POST /publish
POST /watch
POST /disposition
POST /skip
POST /kill
```

Do not mount these under existing `/api/commands/cx/:domain` legacy routes.

The route layer:

- Authenticates.
- Resolves runtime.
- Rejects if runtime is not `bulk_load`.
- Calls runtime service.
- Returns sanitized session.

The route layer must not decide call state.

### 10. Client API

Add:

```text
apps/web-client/src/lib/api/queries/cxBulkLoad.ts
```

Hooks:

```ts
useCxDialRuntimeMode()
useCxBulkLoadSession()
useCxBulkLoadStart()
useCxBulkLoadPublish()
useCxBulkLoadWatch()
useCxBulkLoadDisposition()
useCxBulkLoadSkip()
useCxBulkLoadKill()
```

Do not invalidate legacy call queue queries from these hooks except for optional admin diagnostics. The bulk session is its own query key.

### 11. Client Workspace Split

See `## Workspace File Shape` for the canonical file/folder layout and the `VITE_CX_WORKSPACE_MODE` build flag; this section only adds the bulk rail's sub-components and the delegation detail. (Names here were updated from the superseded `CxDialRuntimeRouter` / `Cx*Workspace` scheme — see `## Document Map`.)

Add, under the canonical structure:

```text
apps/web-client/src/workspaces/cx/CXWorkspaceRouter.tsx
apps/web-client/src/workspaces/cx/slow-single/CXWorkspaceSlowSingle.tsx
apps/web-client/src/workspaces/cx/bulk-load/CXWorkspaceBulkLoad.tsx
apps/web-client/src/workspaces/cx/bulk-load/CXWorkspaceBulkLoadCurrentCall.tsx
apps/web-client/src/workspaces/cx/bulk-load/CXWorkspaceBulkLoadControls.tsx
apps/web-client/src/workspaces/cx/bulk-load/CXWorkspaceBulkLoadDiagnostics.tsx
```

Modify:

```text
apps/web-client/src/workspaces/cx/CXWorkspace.tsx
```

Only enough to delegate to the router:

```tsx
return (
  <CXWorkspaceRouter
    slow={<CXWorkspaceSlowSingle />}
    bulk={<CXWorkspaceBulkLoad />}
    emergency={<CXWorkspaceLegacy />}
  />
)
```

If extracting `CXWorkspaceLegacy` is too large for the first PR, do this intermediate move:

- Keep `CXWorkspace` as emergency legacy.
- Add a top-level mode check before mounting legacy effects.
- If `slow_single`, return `CXWorkspaceSlowSingle` early.
- If `bulk_load`, return `CXWorkspaceBulkLoad` early.

This is acceptable because old effects never mount.

### 12. Admin Diagnostics

Add later, not in first behavior patch:

```text
apps/web-client/src/workspaces/admin/CxDialRuntimeDiagnostics.tsx
apps/control-plane/src/routes/adminCxDialRuntime.js
```

Admin should see:

- agent runtime
- active session
- current candidate
- RingCX active evidence
- refill state
- last 20 events
- last error

## UI Behavior For Bulk Rail

The agent-facing UI should not render a queue order as truth.

Show:

- current RingCX call matched to candidate
- current contact details
- buttons: Answered, Voicemail, Skip/Kill session for test only
- loading/release animation between calls
- small buffer count: `RingCX queue loaded: 24, refill at 5`

Do not show:

- old queue ordering as dial order
- no-answer button if RingCX is auto-advancing no-answer
- legacy auto-serve countdown
- legacy queue restore warnings

## One-Button Disposition→Dial (PREVIEW)

The bulk rail's terminal disposition button can, in one click, save the current call's outcome and dial the next lead. RingCX has NO native primitive for this — there is no combined dispose-then-dial, auto-advance, or requeue-to-next endpoint. RC dev docs are explicit: "No combined dispose-then-dial or auto-advance functionality exists in this API." So the one button is an APP-orchestrated 2-call sequence, and the gap between the two calls IS the readiness signal we observe — never a thing we cancel against.

This subsection extends `## UI Behavior For Bulk Rail`: the disposition->next-dial is a UI interaction plus an outcome-adapter + watcher contract, owned by the bulk rail components only. Keep legacy out of it — the only cross-module reuse permitted below is the neutral observe-with-timeout primitive and the pure state-guard helpers; everything that reads active calls or matches candidates for the bulk rail lives in the new bulk-rail watcher.

Gated behind a new flag, following the runtime convention:

```text
CX_DIAL_RUNTIME_ONE_BUTTON_DISPOSITION_ENABLED=false   # global kill-switch; must be true for the one-button handler to arm
```

When false, the terminal button keeps the plain "submit disposition, agent dispositions next call by hand" behavior. When true, the same button runs the orchestrated sequence below. Per-agent override still beats default; this gate is an additional AND.

### The Two Endpoints (and why the gap exists)

Both already have wrappers in `C:/code/tagcontactbridgeparalell/packages/shared-integrations/src/ringcxVoiceClient.js`. Do NOT add `createManualAgentCall` — the wrapper is `placeManualCall`.

CONTRACT — these wrappers do NOT return a plain boolean. `request()` (`ringcxVoiceClient.js:754-768`) returns the parsed JSON body (a truthy object) on a 2xx and THROWS (`asError`, including the 429 backoff path) on any non-2xx, timeout, or transport failure. So every call below is `await`ed, the resolved value is truthy-on-success, and the ONLY soft-fail that comes back as a value is a literal `false` (mirror the live caller's `ok: response !== false` at `ringcxDialExecutionService.js:1186-1192`). A slow / 5xx / 429 / timed-out RingCX response REJECTS — it must be caught, classified as "retry the observe," and must NOT be read as a clean "not ready." This matters because the 2026-06-17 failure condition was exactly slow/rate-limited RingCX lookups.

```text
A) await dispositionCall(uii_A, { disposition, callback, callBackDTS, notes, phone })
   POST /voice/api/v1/admin/accounts/{accountId}/activeCalls/{uii}/dispositionCall
   disposition/callback/callBackDTS/notes -> query string; phone (optional) -> JSON body { phone }
   NOTE: the four documented RC params are disposition/callback/callBackDTS/notes; `phone` is a
         wrapper-level convenience that maps to a JSON body { phone }, not part of the RC param set.
   RESOLVES truthy on success / RESOLVES literal false on soft-fail / REJECTS on slow|5xx|429|timeout.
   SIDE EFFECT: applying a disposition releases the agent from Pending Disposition (PD).
                The disposition IS the go-ready. There is NO separate "go available" call.

B) await placeManualCall({ username, agentEmail, destination, callerId, ringDuration=5 })
   POST /voice/api/v1/admin/accounts/{accountId}/activeCalls/createManualAgentCall
   ON-WIRE query params are exactly: username, destination, ringDuration, callerId.
   `agentEmail` is NOT sent — it is a LOCAL username-resolution fallback only
   (resolution order: username -> agentEmail -> config.agentEmail -> config.rcUserEmail).
   RingCX support wants the generated RingCX username here, not the plain office email, so
   PASS `username` explicitly; relying on the agentEmail fallback risks the email-as-username
   dial failure the wrapper warns about (ringcxVoiceClient.js:932-939).
   destination is a PHONE NUMBER, not a leadId; no JSON body.
   RESOLVES truthy = ACCEPTED (accepted != live) / RESOLVES false = rejected / REJECTS as above.
   REQUIRES: agent online AND in AVAILABLE state. Rings the agent first, then dials destination.
   CARRIES NO externId -> the resulting active call is matched by (agent + the dnis you placed).
```

The crux race: `dispositionCall` clears PD; `placeManualCall` needs AVAILABLE; there is a brief PD-cleared -> AVAILABLE transition between them. The one button must BRIDGE that gap, not assume it is instant. The disposition's resolved value does not report "now AVAILABLE" — that edge is observed separately.

### Match Strategy For B (deterministic dnis, genuinely new)

A manual call carries no `externId`, so the fuzzy whole-object substring scorers used elsewhere (`scoreActiveCallMatch`, `scoreBulkActiveCandidate`) do not apply to B. Because the app PLACED the call, the match is deterministic: `(agent + dnis)`. The `dnis`/`ani` fields ARE already extracted into `summarizeActiveCall`'s key list (`ringcxActiveCallCaptureService.js:105-106`) but are NEVER read as discrete match fields today — so this dnis-equality match is new and collides with nothing. Match B by normalized-10-digit equality on `dnis` against the phone we placed, scoped to this agent. This match logic is OWNED by the new bulk-rail watcher (see below), not borrowed from the legacy service.

### Single-Flighted Ordered State Machine

One handler, single-flighted behind ONE per-session in-flight latch on `CxBulkLoadSession`, strict order, idempotent on double-click. Lives in `cxBulkLoadStateMachine.js`; terminal write goes through `cxBulkLoadOutcomeAdapter.js`; the live confirmation is observed by `cxBulkLoadActiveCallWatcher.js`; session/latch state is owned by `CxBulkLoadSession.js` via `cxBulkLoadSessionRepository.js`. Exposed as a runtime method `submitCxBulkLoadDisposition` on `cxBulkLoadRuntimeService.js` (route `routes/cxBulkLoad.js`, hook `useCxBulkLoadDisposition`).

The entire sequence is wrapped in one try/finally: the latch is released in `finally` (unless a live confirmation has taken ownership of the session), NEVER at scattered manual `inFlight = false` sites — because any wrapper REJECT would otherwise unwind past those sites and strand the latch, turning the terminal button into a permanent no-op for that seat (a floor-down for that agent). The release is persisted through `cxBulkLoadSessionRepository`, and `CxBulkLoadSession` carries an absolute latch TTL / stale-latch reaper so a missed release (e.g. process crash mid-flight) self-heals rather than wedging the seat forever.

```text
0. OWNERSHIP    one-button owns the session: while CX_DIAL_RUNTIME_ONE_BUTTON_DISPOSITION_ENABLED
                is true for this CxBulkLoadSession, the legacy advanceSingleSession capture-miss
                cancel (step "REPLACES" below) is hard-disabled for this session, and the
                captureBulkCurrent auto-advance-terminal stamp is bypassed for the dispositioned
                lead. The two paths must never both drive a single session.

   try {
1. LATCH        if (session.inFlight) return            // double-click is a no-op
                session.inFlight = true ; button -> "Saving + dialing…"

2. DISPOSE A    resp = await dispositionCall(uii_A, { disposition, callback, callBackDTS, notes })
                ok = resp !== false                     // truthy resolve = success; literal false = soft-fail
                if (!ok) { surface error ; return }      // finally releases the latch
                  -> NEVER auto-advance on a failed dispose
                  -> NEVER write a fake/hardcoded outcome (kills the did_not_connect default)
                  -> a REJECT (slow/5xx/429/timeout) is caught below as "retry the observe", not a fake outcome

3. MARK A       cxBulkLoadOutcomeAdapter.markTerminal(A, { disposition, ... })   // authoritative outcome
                  -> idempotency key on queueItemId; this is the source of truth for A's outcome
                  -> BEST-EFFORT side write, OUTSIDE the latch-critical path: try/catch
                     leadAction('READY_LEADS' | 'MANUAL_LEADS', body) ONLY if the RC lead record
                     needs to stay honest (callback/reschedule). A throw here is logged and swallowed
                     — it must NEVER abort the advance or strand the latch (owned-queue advance in
                     step 4 is the source of truth). There is NO updateCampaignLead wrapper.

4. ADVANCE      pop A ; B = queue.head                  // advance the OWNED bulk queue, not RC's

5. READINESS    confirm-then-dial with bounded retry (the ONLY real race):
   GATE           for attempt in 1..N (~150ms backoff, cap ~2s):
                    // BEFORE each (re)place, observe — never blind re-place:
                    if (await watcher.find(agentUsername, B.phone)) break   // already live -> CONFIRM
                    try {
                      resp = await placeManualCall({ username: agentUsername, destination: B.phone,
                                                     callerId, ringDuration })
                      if (resp !== false) break          // ACCEPTED (not yet live) -> go CONFIRM
                      // literal false ~always = "agent not AVAILABLE yet" -> backoff, retry
                    } catch (err) {
                      // AMBIGUOUS (timeout/5xx/429): the dial MAY have landed.
                      // Do NOT immediately re-place. Poll the watcher for (agent + B.phone);
                      // only re-place on the next attempt if STILL absent. At most one
                      // accepted placeManualCall for (agent, B) may be outstanding.
                    }
                  if (!accepted && !live) { surface "couldn't start next call — retry" ;
                                            queue head UNCHANGED ; return }   // finally releases latch
                  -> the dial's OWN resolved value is the availability probe; no separate go-available call
                  -> confirm-then-dial prevents a duplicate ring/dial when a prior attempt landed
                     but its response was slow/lost

6. CONFIRM      cxBulkLoadActiveCallWatcher: expect (agentUsername + B.phone-as-dnis) in
                listActiveCalls(...) -> on match:
                  hand session ownership to the live call ; session.inFlight released ;
                  button -> normal ; B becomes "current"
                  -> truthy resolve in step 5 = ACCEPTED, not live; the active call appearing
                     is the REAL confirmation
   } finally { if (!confirmed) session.inFlight = false }   // single release site; persisted via repository
```

Why air-tight: strict order (A is fully disposed before B dials); the readiness gate is OBSERVATIONAL and confirm-then-dial (retrying a not-yet-ready dial never cancels a valid one, and a landed-but-slow dial is observed, never re-placed); the explicit terminal write plus the auto-advance-stamp bypass kills the hardcoded `did_not_connect` risk; the single `finally` release plus TTL reaper means no reject path can strand the latch; you CANNOT pre-dial B (predictive again) — you CAN pre-warm B's screen as "NEXT ON DECK".

Wrappers Codex still needs (from the missing list) — add to `ringcxVoiceClient.js` only if the flow names them, otherwise call the generic ones:

- per-lead "ready/dial-now" helper: none exists. The one-button MARK A step uses `leadAction('READY_LEADS' | 'MANUAL_LEADS', body)` only (`AGENT_RESERVATION` is a real enum value but is NOT the op the one-button flow uses — do not reach for it here). If a named single-lead "ready/dial-now" helper is wanted, that is the one genuinely-missing wrapper to add, and it wraps `leadAction` with `READY_LEADS` (or `MANUAL_LEADS`).
- single-lead fetch by id: none. Read state via `searchLeads(payload)` (bulk leadSearch) filtered to the id, or add a wrapper.
- field-edit / patch a lead (callerId/phone/custom): none. Only `leadAction` enum ops and `loadLeads` (insert) exist.

### Readiness Gate Is Observational — What It Replaces

The bounded-retry gate is the whole point. Retrying a not-yet-ready dial is SAFE; canceling a slow-confirming valid dial is THE 2026-06-17 bug (a confirmation gate canceled valid dials on slow RingCX lookup -> publish/cancel/retry loop -> lead flicker + stuck states).

This flow REPLACES the live destructive seam, and "REPLACES" means the old branch is GATED OFF for one-button-owned sessions, not merely that a new path runs alongside it:

```text
REPLACES:  advanceSingleSession() capture-miss cancel
           C:/code/tagcontactbridgeparalell/packages/shared-services/src/cxSimpleCallLoopService.js  (~lines 1207-1232)
           cancelCandidatePublish(current, "cx-simple-loop-capture-missed", logger)  (~line 1212)
           fired when captureRingcxActiveCallForPublishedLead returns !ok/!activeCallSummary
           inside the ~8s RINGCX_CAMPAIGN_CALL_CAPTURE_MS window — i.e. cancels a valid dial
           when the RingCX active-call lookup is merely slow.

REQUIRED:  guard cancelCandidatePublish at ~line 1212 behind "and NOT one-button-owned": when
           CX_DIAL_RUNTIME_ONE_BUTTON_DISPOSITION_ENABLED is true for the session, the
           advanceSingleSession capture-miss cancel is hard-disabled for that session so the
           legacy slow-lookup cancel cannot fire concurrently (no dual-poller on one session).
```

Likewise, the legacy auto-advance terminal stamp must be suppressed for one-button sessions: `recordSimpleLoopAutoAdvanceTerminal()` (`cxSimpleCallLoopService.js:327-339`, called from `captureBulkCurrent` at ~1290 and ~1322) writes `outcome:'did_not_connect' / disposition:'did_not_connect' / result:'NOANSWER'` UNCONDITIONALLY whenever `priorCurrent` differs from the new match. If the one-button flow advanced the owned queue and then leaned on `captureBulkCurrent` for confirmation, that stamp would race the real disposition and overwrite lead A with a fake `did_not_connect`. So when `CX_DIAL_RUNTIME_ONE_BUTTON_DISPOSITION_ENABLED` is true, the `captureBulkCurrent` auto-advance-terminal stamp is bypassed for any lead already marked terminal by `cxBulkLoadOutcomeAdapter.markTerminal` (idempotency on queueItemId) — and step 6 confirmation routes through the new watcher, not through `captureBulkCurrent`'s priorCurrent-diff branch. "Explicit disposition kills the risk" is NOT sufficient on its own — the reused function writes the fake outcome on a separate code path, so it must be gated off.

The one-button gate NEVER cancels. A miss inside the window means "retry the observe / keep the lead current," not "cancel and requeue." (Note: the dial-execution path's `RINGCX_CAMPAIGN_REQUIRE_ACTIVE_CALL_CONFIRMATION` branch was already hardened to leave the lead `serving`/pending-confirmation; the simple-loop capture-miss cancel is the remaining LIVE destructive seam.)

REUSES (the ONLY cross-module imports — neutral, exported, side-effect-free):

- `ringcxActiveCallCaptureService.js:waitForRingcxCampaignCall` — the observe-with-timeout primitive (exported; observational, not cancelling),
- `cxCallStateGuard.js:decideCxCurrentCallDialBlock` / `evaluateCxClear` / `callIdentity` — pure gate + identity helpers,
- `CXWorkspace.tsx:simpleLoopWatchInFlightRef` / `autoServeInFlightRef` — existing single-flight ref patterns to MIRROR (pattern, not import) for the per-session latch.

PORT, do not import (these are PRIVATE module internals — verified NOT in `cxSimpleCallLoopService.js`'s `module.exports`, so `require` returns undefined): the bulk active-call read + `(agent + dnis)` candidate match presently embodied by the unexported `captureBulkCurrent` / `listBulkActiveCallsForSession` / `findBulkCandidateForActiveCall`. Per the "keep legacy out of it" mandate, port this read+match logic into the new `cxBulkLoadActiveCallWatcher.js` (deterministic dnis-equality, scoped to the agent) rather than exporting the legacy internals. Reaching into the service this flow decommissions would re-commingle the two rails the plan separates.

### Failure Modes

| Condition | What the handler does | Latch | Queue head |
|---|---|---|---|
| Dispose A soft-fails (`dispositionCall` resolves `false`) | Surface error; do NOT advance; do NOT write a fake outcome | released in `finally` | unchanged (A stays current) |
| Dispose A REJECTS (slow/5xx/429/timeout) | Caught; classify as "retry the observe," not cancel and not fake outcome; surface "saving, confirming…"; do NOT advance | released in `finally` (or held for re-observe) | unchanged (A stays current) |
| Call A already ended before disposition (PD window closed / agent hung up) | Treat dispose-false as terminal-already; mark A terminal from owned outcome, advance; do NOT re-dispose | released after advance | popped, B not yet dialed -> step 5 |
| `leadAction` side write throws (step 3) | Logged and swallowed (best-effort, outside latch-critical path); advance proceeds; owned-queue advance is source of truth | released in `finally` | advances normally (A terminal already written) |
| Dial B not ready (`placeManualCall` resolves `false`, agent not AVAILABLE yet) | Confirm-then-dial bounded retry (~150ms backoff, cap ~2s); EXPECTED, not an error | held during retry | unchanged until a dial is accepted |
| Dial B REJECTS mid-retry (timeout/5xx — MAY have landed) | Do NOT blind re-place; poll watcher for (agent + B.phone); only re-place if still absent; at most one outstanding accept | held during retry | unchanged until accepted/confirmed |
| Dial B fails after all retries (still neither accepted nor live) | Surface "couldn't start next call — retry"; STOP; no cancel | released in `finally` | unchanged (B stays head; agent re-clicks) |
| Double-click / re-fire while in flight | No-op (latch returns immediately) | held | unchanged |
| Accepted (step 5) but no active call appears (step 6 watcher times out) | Do NOT cancel; keep B as current/awaiting-confirm; allow re-observe; surface "dial accepted, confirming…" | released on timeout, do not requeue | B is current (NOT requeued) |
| Wrapper rejects anywhere after latch set | Caught; `finally` releases the latch; stale-latch TTL reaper is the backstop if the process dies first | released in `finally` / by reaper | unchanged (recoverable by re-click) |

The invariant: the only states that advance the queue are (A disposed AND a dial accepted/confirmed) or (A already-terminal). Every failure leaves the queue recoverable by re-click, no reject path strands the latch, and nothing in this table cancels a dial or writes a fake outcome.

### Push vs Poll

Ship v1 with the poll: the readiness gate retry-probes by re-issuing `placeManualCall` and reading its resolved value (the dial's own value IS the availability probe), confirm-then-dial via the `listActiveCalls` dnis-match watcher.

Fast-follow upgrade (not required v1): wire the WFM agent-state webhook on the backend and gate step 5 on the PUSHED edge instead of probing.

```text
WFM agent-state webhook (HTTP push) carries:
  event_type    -> agent state, e.g. AVAILABLE
  pending_disp  -> [0] = call ended & disposition not yet completed
Gate step 5 on the pushed PD-cleared -> AVAILABLE edge; the dial fires once, on the edge,
instead of N retry probes. Backend-only change; the state machine's contract is unchanged.
```

### LIVE CHECK Before Building The Gate

Confirm on this account that PD -> AVAILABLE is sub-second — i.e. there is NO admin-configured wrap/wrap-up timer holding the agent in a non-AVAILABLE state after disposition. If a wrap timer exists, either the retry window in step 5 must cover it (raise the cap past the wrap duration) or this dial mode must skip wrap. Building the bounded-retry gate against an unknown wrap timer will look like "dial never gets ready" when it is really the agent being held. Verify this BEFORE tuning backoff/cap.

## Data Flow

```text
Lead policy read
  -> snapshot candidates into bulk session
  -> publish/refill candidates to RingCX
  -> poll active calls
  -> match active call to candidate
  -> render current candidate
  -> terminal button or RingCX auto-advance
  -> write final outcome adapter
  -> refill when buffer <= threshold
```

## Rollback Contract

> For the v1 silent-test phase, rollback is the client build flag: rebuild with `VITE_CX_WORKSPACE_MODE=slow_single` and refresh — no server touch. The server-flag rollback below applies only in the later phase, once agents are routed live via `## Runtime Selector`.

Rollback must be boring:

```text
CX_DIAL_RUNTIME_BULK_LOAD_ENABLED=false
CX_DIAL_RUNTIME_DEFAULT=slow_single
```

Then restart the CX service and refresh client.

Rollback must not require:

- cleaning `CxDialQueue` assignment state
- manually unsticking `servedQueue`
- clearing legacy current calls
- undoing cadence counters

This is why shared writes are restricted to hard facts only.

## First PR Scope

Build the skeleton without floor behavior:

1. Runtime resolver.
2. Bulk session model/repository.
3. Pure state machine.
4. Runtime routes behind disabled flag.
5. Client runtime router that resolves everyone to `slow_single` unless explicitly overridden.
6. Unit tests.

No RingCX publish in first PR unless tests are already green.

## Second PR Scope

Mickey/local-only functional rail:

1. Lead snapshot from existing queue.
2. Publish one candidate.
3. Watch active call.
4. Render bulk workspace.
5. Terminal disposition writes through outcome adapter.
6. Kill session cancels pending published candidates.

## Third PR Scope

Bulk/refill behavior:

1. Publish up to target size.
2. Watch active call every second with shared snapshot cache.
3. Refill at threshold.
4. Auto-advance previous current when RingCX changes active call.
5. Count non-connects through outcome adapter.

## Required Tests Before Any Floor Trial

State machine:

- publish accepted does not mark current active
- active call requires strong RingCX evidence
- ambiguous evidence does not clear current
- terminal completion idempotent by candidate
- RingCX auto-advance completes previous current once
- kill clears current and prevents future publish

Runtime:

- legacy runtime never calls bulk routes
- bulk runtime never calls legacy `requestCxDial`
- bulk start snapshots once
- bulk refill excludes already-published candidates
- outcome adapter writes once per candidate/event

Client:

- bulk runtime does not mount legacy auto-serve effects
- terminal button enters release/loading state
- session polling updates current candidate
- no old queue card can stage into the center panel in bulk mode

## Success Criteria

The first usable local test is successful when:

1. Agent logs in and resolves to `bulk_load`.
2. App snapshots eligible leads.
3. RingCX receives candidates.
4. App ignores list order and displays only the active RingCX call.
5. Buttons remain present and scoped to the current candidate.
6. Current clears into release/loading state after terminal action.
7. Next active call appears when watcher observes it.
8. `slow_single` can be restored by one flag flip.

## Clean-Code Construction Mandate (bulk upload first, no coupling)

This section is the strict build rule set for the next pass:

- no file in `slow_single` imports bulk runtime files;
- no file in bulk rail imports legacy runtime mutators;
- shared code usage is limited to neutral primitives (auth, RingCX client, canonical helpers, logging);
- every runtime function has one clear job.

### One-way dependencies

- `slow_single` -> `shared neutral primitives` + slow-single internals
- `bulk rail` -> `shared neutral primitives` + `bulk rail internals`
- `shared neutral primitives` -> never resolves runtime mode or queue ownership.

Enforced result:

- `slow_single` works by itself when the bulk flag is off.
- `bulk_load` cannot accidentally execute legacy queue mutation.

### Function-level seam by file

#### 1) `packages/shared-services/src/cxDialRuntimeModeService.js`

- `resolveRuntimeMode({user, account, domain}): CxRuntimeResolution`  
  *Job*: pure mode resolution, no I/O.
- `isCxBulkLoadRuntime(resolution): boolean`  
  *Job*: pure boolean check, no side effects.
- `buildRuntimeMetadata(resolution): RuntimeMetadata`  
  *Job*: pure projection for API.

#### 2) `packages/shared-models/src/CxBulkLoadSession.js` + `packages/shared-repositories/src/cxBulkLoadSessionRepository.js`

- `createBulkLoadSession(input): Promise<Session>`  
  *Job*: persist new session document only.
- `getBulkLoadSession({sessionId, agentId}): Promise<Session | null>`  
  *Job*: pure read by key.
- `updateBulkLoadSession(sessionId, patch): Promise<Session>`  
  *Job*: atomic persisted patch for one session.

No legacy queue row writes here.

#### 3) `packages/shared-services/src/cxBulkLoadLeadSourceService.js`

- `snapshotEligibleQueueRows({agent, maxItems, policyOpts}): Promise<CandidateDraft[]>`  
  *Job*: read-only policy-compliant candidate selection.
- `normalizeQueueRowsToCandidates(rows): Candidate[]`  
  *Job*: stable projection with `externId` and `loop identity`.
- `filterNotInSessionCandidates(candidates, session): Candidate[]`  
  *Job*: dedupe against existing bulk-session IDs.

#### 4) `packages/shared-services/src/cxBulkLoadRingcxPublisher.js`

- `publishBatchToRingCX(sessionId, candidates): Promise<PublishResult>`  
  *Job*: one RingCX bulk publish call.
- `cancelBatchForSession(sessionId, candidates): Promise<CancelResult>`  
  *Job*: one cleanup path for kill.
- `mapRingCXPublishResult(session, result): CandidateUpdate[]`  
  *Job*: map external IDs / acceptance into minimal session updates.

#### 5) `packages/shared-services/src/cxBulkLoadActiveCallWatcher.js`

- `snapshotActiveCallsForAccount(context): Promise<ActiveCall[]>`  
  *Job*: read active calls (account-scoped preferred).
- `matchBulkActiveCall(candidates, activeCalls): MatchResult`  
  *Job*: ordered matching `externId -> queueItemId -> stable candidate identity` (no phone-only promotion).
- `pickCurrentCandidate(current, match): CurrentTransition`  
  *Job*: produce one transition only: none/same/switch.

#### 6) `packages/shared-services/src/cxBulkLoadOutcomeAdapter.js`

- `markCallPlaced(session, candidateId): Promise<void>`  
  *Job*: idempotent call-placed write.
- `markTerminal(session, current, disposition): Promise<void>`  
  *Job*: idempotent terminal write only from concrete event.
- `toCadenceMetricEvent(outcome): CadenceEvent`  
  *Job*: narrow transform into existing finalizers.

#### 7) `packages/shared-services/src/cxBulkLoadRuntimeService.js`

- `startCxBulkLoadSession(cmd): Promise<Session>`  
  *Job*: create session + initial snapshot + `ensureBuffer(session)` call.
- `getCxBulkLoadSession(query): Promise<SessionSnapshot>`  
  *Job*: read-only view for UI.
- `ensureBuffer(session): Promise<BufferResult>`  
  *Job*: compute deficit, call snapshot/publish, persist accepted candidates.
- `watchCxBulkLoadSession(cmd): Promise<SessionTransition>`  
  *Job*: reconcile one active-call sample and apply switch/complete for previous current if active changed.
- `submitCxBulkLoadDisposition(cmd): Promise<Session>`  
  *Job*: complete current once, clear current, request one ensureBuffer.
- `skipCxBulkLoadCurrent(cmd): Promise<Session>`  
  *Job*: same as submit with explicit skipped outcome.
- `killCxBulkLoadSession(cmd): Promise<Session>`  
  *Job*: stop active work, clear current, cancel published candidates.

#### 8) Route layer (`apps/control-plane/src/routes/cxBulkLoad.js`)

- one function per route only: `start`, `get`, `watch`, `disposition`, `skip`, `kill`
- each route does: auth -> runtime gate -> input parse -> service call -> return snapshot.

#### 9) Client (`apps/web-client/src/lib/api/queries/cxBulkLoad.ts`)

- one hook per route only: `useCxBulkLoadStart`, `useCxBulkLoadSession`, `useCxBulkLoadWatch`, `useCxBulkLoadDisposition`, `useCxBulkLoadSkip`, `useCxBulkLoadKill`.
- hooks never touch legacy queue-state hooks.

#### 10) Workspace split

- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx` reads only bulk session snapshot.
- `apps/web-client/src/workspaces/cx/CXWorkspace.tsx` performs exact runtime fork.
- bulk workspace renders:
  - session state
  - active `current`
  - buffer count/threshold
  - release/loading state
  - disposition buttons.
- legacy queue state is for rendering only when runtime is legacy.

### Bulk upload implementation shape (Mickey-local first)

1. Start session.
2. Snapshot N eligible candidates and persist to session as `pending`.
3. `ensureBuffer` publishes bulk batch up to `targetBuffer` (no single-row publish loop in steady state).
4. Mark each accepted candidate as `published` with RingCX id.
5. Poll `watch` in cadence; do not infer order:
   - match by evidence; ignore unmatched non-evidence state.
6. If current is empty and one match exists: set that as current (`active`).
7. If new match differs from current: complete old current as `cx-auto-advanced`, set new current.
8. On button action: complete current exactly once and clear current.
9. Refill when `published + active` is at or below threshold.
10. Never treat no-match active polling as hard failure in bulk mode.

### Minimal anti-regression checklist

- no phone-only matching.
- no legacy auto-serve/nextDial as source of current.
- no shared mutable state between rails.
- no recursive advance loops.
- no publish -> auto-current coupling.
- every terminal transition emits exactly once per candidate.

If any function above grows beyond one coherent task, split it before adding new behavior.

## Execution Checklist (thinnest implementation order)

Use this as a coding pass order. Each item is one local PR chunk.

1) Add runtime gate and resolution
   1. Edit `packages/shared-services/src/cxDialRuntimeModeService.js`
      - Add/define:
        - `type RuntimeMode = "slow_single" | "bulk_load"`
        - `type CxRuntimeResolution = { runtime: RuntimeMode, reason: string, enabled: boolean, fallbackRuntime: RuntimeMode }`
        - `function resolveCxDialRuntimeMode(input: { userEmail?: string, extensionId?: string, domain?: string, role?: string }): CxRuntimeResolution`
        - `function isCxBulkLoadRuntime(resolution: CxRuntimeResolution): boolean`
        - `function buildCxDialRuntimeMetadata(resolution: CxRuntimeResolution): { runtime: RuntimeMode, enabled: boolean, reason: string }`
   2. Add `tests/cx-dial-runtime/cxDialRuntimeModeService.test.js` with fixtures for:
      - disabled global flag
      - explicit agent override
      - admin/other users fallback logic

2) Add bulk session model/repository (no legacy queue writes)
   1. Edit `packages/shared-models/src/CxBulkLoadSession.js`
      - Ensure schema includes only:
        - `sessionId`, `runtime`, `status`, `agent`, `ringcx`, `source`, `candidates`, `current`, `completed`, `refill`, `stats`, `events`, `lastError`
      - Candidate states: `"pending" | "publishing" | "published" | "active" | "completed" | "cancelled" | "failed"`
      - Current states: `"none" | "confirming" | "active" | "releasing"`
   2. Edit `packages/shared-repositories/src/cxBulkLoadSessionRepository.js`
      - Add:
        - `createSession(session)` 
        - `getSessionBySessionId(sessionId)`
        - `getSessionByAgent({ agentEmail, extensionId, status? })`
        - `updateSession(sessionId, patch)`
        - `deleteSession(sessionId)` (for explicit kill cleanup)
   3. Add `tests/cx-bulk-load/cxBulkLoadSessionRepository.test.js`
      - create/get/update/delete happy path + schema defaults.

3) Add pure lead source boundary (read-only policy)
   1. Edit `packages/shared-services/src/cxBulkLoadLeadSourceService.js`
      - Add:
        - `async function snapshotCandidatesFromQueue(input: { agentEmail, maxItems, campaignId?, dialGroupId?, includeOnlyReady: boolean }): Promise<CandidateDraft[]>`
        - `function normalizeQueueRows(rows): CandidateDraft[]`
        - `function excludeSessionCandidates(candidates, session): CandidateDraft[]`
        - `function buildExternId({ domain, caseId, queueItemId }): string`
   2. Add `tests/cx-bulk-load/cxBulkLoadLeadSourceService.test.js`
      - snapshot and normalize determinism
      - no legacy state mutation verification.

4) Add bulk RingCX publish adapter
   1. Edit `packages/shared-services/src/cxBulkLoadRingcxPublisher.js`
      - Add:
        - `async function publishBatchToRingcx(session, candidates): Promise<PublishBatchResult>`
        - `function buildRingcxLeadPayload(candidate, options): RingcxLeadPayload`
        - `async function cancelBatchForSession(session): Promise<CancelBatchResult>`
        - `function toCandidatePublishPatch(publishResult): CandidatePatch[]`
   2. Add `tests/cx-bulk-load/cxBulkLoadRingcxPublisher.test.js`
      - happy path accepted/rejected mapping
      - explicit cancel path used by kill.

5) Add active-call matcher (proof-only, no phone-first logic)
   1. Edit `packages/shared-services/src/cxBulkLoadActiveCallWatcher.js`
      - Add:
        - `async function loadActiveCallsSnapshot(context): Promise<ActiveCall[]>`
        - `function matchActiveCallToCandidates(activeCalls, candidates): { matchedCandidateId: string | null, matchEvidence?: MatchEvidence, ambiguous?: boolean }`
        - `function deriveCurrentTransition(current, match): CurrentTransition`
        - `const MATCH_ORDER = ["externId", "queueItemId", "candidateIdentity"]` (no phone)
   2. Add `tests/cx-bulk-load/cxBulkLoadActiveCallWatcher.test.js`
      - externId preferred
      - no phone-only promotion
      - ambiguous case returns no switch.

6) Add outcome adapter with idempotency keying
   1. Edit `packages/shared-services/src/cxBulkLoadOutcomeAdapter.js`
      - Add:
        - `async function ensureCallPlaced(session, candidateId): Promise<void>`
        - `async function persistTerminalOutcome(session, candidateId, outcome, source): Promise<void>`
        - `function buildCadenceEvent(session, candidate, outcome, source): CadenceEvent`
        - `function makeOutcomeIdemKey({ sessionId, candidateId, eventType }): string`
   2. Add `tests/cx-bulk-load/cxBulkLoadOutcomeAdapter.test.js`
      - ensure idempotent completion by `(sessionId, candidateId, eventType)`
      - no duplicated cadence writes.

7) Add bulk runtime service orchestration (single source of state transition)
   1. Edit `packages/shared-services/src/cxBulkLoadRuntimeService.js`
      - Add and export:
        - `async function startCxBulkLoadSession(input, context): Promise<SessionSnapshot>`
        - `async function getCxBulkLoadSession(query): Promise<SessionSnapshot | null>`
        - `async function ensureBuffer(sessionId, context): Promise<Session>`
        - `async function watchCxBulkLoadSession(input, context): Promise<SessionTransitionResult>`
        - `async function submitCxBulkLoadDisposition(input, context): Promise<SessionSnapshot>`
        - `async function skipCxBulkLoadCurrent(input, context): Promise<SessionSnapshot>`
        - `async function killCxBulkLoadSession(input, context): Promise<SessionSnapshot>`
      - Keep the implementation minimal:
        - start: snapshot once, persist, call `ensureBuffer` once.
        - watch: evidence-based current switch only.
        - no recursive loops.
        - in bulk mode, no breaker on empty active poll.
   2. Add `tests/cx-bulk-load/cxBulkLoadRuntimeService.test.js`
      - one publish per slot refill
      - current switch-on-active-change semantics
      - completion-on-disposition exactly once.

8) Add route surface (bulk rail isolated)
   1. Edit `apps/control-plane/src/routes/cxBulkLoad.js`
      - Export handlers only:
        - `startCxBulkLoadSessionRoute`
        - `getCxBulkLoadSessionRoute`
        - `publishCxBulkLoadSessionRoute` — drop unless genuinely distinct: don't ship it as an alias of `watch` (one behavior with two public names drifts); buffer-fill is an internal effect of `start`/`watch`, not a client verb. One name per fact.
        - `watchCxBulkLoadSessionRoute`
        - `dispositionCxBulkLoadSessionRoute`
        - `skipCxBulkLoadCurrentRoute`
        - `killCxBulkLoadSessionRoute`
      - Pattern in each handler: auth -> runtime gate -> service call -> session snapshot response.
   2. Edit `apps/control-plane/src/server.js`
      - Mount once under `/api/cx-bulk-load/session/*`
      - Guard mount with `CX_DIAL_RUNTIME_BULK_LOAD_ENABLED` + allowlist helper.

9) Add client query hooks
   1. Edit `apps/web-client/src/lib/api/queries/cxBulkLoad.ts`
      - Add hooks:
        - `useCxBulkLoadRuntimeMode()`
        - `useCxBulkLoadSession()`
        - `useCxBulkLoadStart()`
        - `useCxBulkLoadWatch()`
        - `useCxBulkLoadDisposition()`
        - `useCxBulkLoadSkip()`
        - `useCxBulkLoadKill()`
      - Keep legacy queue query keys untouched.
   2. Add `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx`
      - Consume only bulk-session snapshot and actions.
      - Render:
        - buffer summary
        - current candidate card
        - release/loading state
        - answered/voicemail actions.
   3. Edit `apps/web-client/src/workspaces/cx/CXWorkspace.tsx`
      - Add runtime fork:
        - if `runtime === "bulk_load"` render `CXWorkspaceBulkLoad`
        - else existing legacy flow.
        - never mount legacy auto-serve/nextDial effects in bulk mode.

10) Wire and verify local Mickey dry-run (readiness-only smoke)
   1. Ensure env in local:
      - `CX_DIAL_RUNTIME_BULK_LOAD_ENABLED=true`
      - `CX_DIAL_RUNTIME_AGENT_OVERRIDES=mgray@taxadvocategroup.com:bulk_load`
   2. Run flow manually:
      - start -> buffer publish -> watch sees active -> current card updates
      - auto-change active -> previous current auto-completed once
      - disposition -> current cleared and auto-continue once.

11) Add hard rollback + no coupling checks (last mile)
   1. Ensure `CX_DIAL_RUNTIME_BULK_LOAD_ENABLED=false` restores `slow_single`.
   2. Search check list:
      - no route in bulk rail writes legacy queue state
      - no legacy route is imported by bulk runtime service
      - no phone-only matcher in bulk active watch
      - no current writes from legacy `nextDial` or `servedQueue` snapshots.

## Task Board (implementation-ready backlog)

### To Do

- [ ] Define runtime resolver contract + env behavior.
- [ ] Add bulk session model/repository patch APIs.
- [ ] Add bulk lead source snapshot service.
- [ ] Add bulk RingCX publish/kill adapter.
- [ ] Add active-call matcher and transition derivation.
- [ ] Add outcome adapter idempotency.
- [ ] Add bulk runtime orchestrator service.
- [ ] Add bulk routes and mount + gate.
- [ ] Add bulk workspace and client hooks.
- [ ] Run Mickey local validation loop.

### Doing

- [ ] None.

### Done

- [x] Added clean-code separation section to the plan.
- [x] Added function-level seam definitions.
- [x] Added thinnest execution checklist.

### Backlog cards (copy/paste to Jira/Trello)

1. Runtime mode resolution
   - Area: runtime
   - Files:
     - `packages/shared-services/src/cxDialRuntimeModeService.js`
     - `tests/cx-dial-runtime/cxDialRuntimeModeService.test.js`
   - Functions:
     - `resolveCxDialRuntimeMode`
     - `isCxBulkLoadRuntime`
     - `buildCxDialRuntimeMetadata`
   - DoD:
     - deterministic outputs for disabled global flag, explicit overrides, fallback.
   - Test:
     - unit test for all env cases.
   - Risk:
     - precedence bug between default and override.

2. Bulk session persistence
   - Area: model/repository
   - Files:
     - `packages/shared-models/src/CxBulkLoadSession.js`
     - `packages/shared-repositories/src/cxBulkLoadSessionRepository.js`
     - `tests/cx-bulk-load/cxBulkLoadSessionRepository.test.js`
   - Functions:
     - `createSession`
     - `getSessionBySessionId`
     - `getSessionByAgent`
     - `updateSession`
     - `deleteSession`
   - DoD:
     - no legacy queue writes in this layer.
   - Test:
     - CRUD repo behavior.
   - Risk:
     - schema mismatch between model and persisted docs.

3. Lead snapshot service
   - Area: service
   - Files:
     - `packages/shared-services/src/cxBulkLoadLeadSourceService.js`
     - `tests/cx-bulk-load/cxBulkLoadLeadSourceService.test.js`
   - Functions:
     - `snapshotCandidatesFromQueue`
     - `normalizeQueueRows`
     - `excludeSessionCandidates`
     - `buildExternId`
   - DoD:
     - read-only snapshot, stable candidate identity.
   - Test:
     - same input returns same ordered snapshot.
   - Risk:
     - accidentally mutating legacy queue rows.

4. RingCX publish adapter
   - Area: service
   - Files:
     - `packages/shared-services/src/cxBulkLoadRingcxPublisher.js`
     - `tests/cx-bulk-load/cxBulkLoadRingcxPublisher.test.js`
   - Functions:
     - `publishBatchToRingcx`
     - `cancelBatchForSession`
     - `buildRingcxLeadPayload`
     - `toCandidatePublishPatch`
   - DoD:
     - bulk accepted/rejected mapping with `externId`.
   - Test:
     - publish accepted/rejected + cancel path.
   - Risk:
     - RingCX payload mismatch.

5. Active matcher
   - Area: service
   - Files:
     - `packages/shared-services/src/cxBulkLoadActiveCallWatcher.js`
     - `tests/cx-bulk-load/cxBulkLoadActiveCallWatcher.test.js`
   - Functions:
     - `loadActiveCallsSnapshot`
     - `matchActiveCallToCandidates`
     - `deriveCurrentTransition`
   - DoD:
     - externId-first; no phone-only promotion.
   - Test:
     - match/ambiguous/no-match.
   - Risk:
     - false switch from ambiguous evidence.

6. Outcome adapter
   - Area: service
   - Files:
     - `packages/shared-services/src/cxBulkLoadOutcomeAdapter.js`
     - `tests/cx-bulk-load/cxBulkLoadOutcomeAdapter.test.js`
   - Functions:
     - `ensureCallPlaced`
     - `persistTerminalOutcome`
     - `buildCadenceEvent`
     - `makeOutcomeIdemKey`
   - DoD:
     - terminal writes are idempotent.
   - Test:
     - duplicate disposition does not duplicate writes.
   - Risk:
     - cadence map regression.

7. Runtime orchestrator
   - Area: service
   - Files:
     - `packages/shared-services/src/cxBulkLoadRuntimeService.js`
     - `tests/cx-bulk-load/cxBulkLoadRuntimeService.test.js`
   - Functions:
     - `startCxBulkLoadSession`
     - `getCxBulkLoadSession`
     - `ensureBuffer`
     - `watchCxBulkLoadSession`
     - `submitCxBulkLoadDisposition`
     - `skipCxBulkLoadCurrent`
     - `killCxBulkLoadSession`
   - DoD:
     - active-only current, bulk no-failure on no-match poll.
   - Test:
     - one active switch and one completion per current.
   - Risk:
     - hidden legacy route call.

8. Route surface
   - Area: server/routes
   - Files:
     - `apps/control-plane/src/routes/cxBulkLoad.js`
     - `apps/control-plane/src/server.js`
   - Functions:
     - `startCxBulkLoadSessionRoute`
     - `getCxBulkLoadSessionRoute`
     - `watchCxBulkLoadSessionRoute`
     - `dispositionCxBulkLoadSessionRoute`
     - `skipCxBulkLoadCurrentRoute`
     - `killCxBulkLoadSessionRoute`
   - DoD:
     - no state logic in routes.
   - Test:
     - runtime gate blocks non-bulk flow.
   - Risk:
     - mount/path mismatch.

9. Client runtime split
   - Area: web-client
   - Files:
     - `apps/web-client/src/lib/api/queries/cxBulkLoad.ts`
     - `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx`
     - `apps/web-client/src/workspaces/cx/CXWorkspace.tsx`
   - Functions:
     - `useCxBulkLoadRuntimeMode`
     - `useCxBulkLoadSession`
     - `useCxBulkLoadStart`
     - `useCxBulkLoadWatch`
     - `useCxBulkLoadDisposition`
     - `useCxBulkLoadSkip`
     - `useCxBulkLoadKill`
   - DoD:
     - bulk mode reads only session current and buffer.
   - Test:
     - smoke: action routes are called in bulk mode.
   - Risk:
     - legacy auto-serve still mounted.

10. Final rollback + coupling audit
   - Area: quality
   - Files:
     - all touched files
   - DoD:
     - toggle `CX_DIAL_RUNTIME_BULK_LOAD_ENABLED=false` restores `slow_single`.
     - no cross-rail mutable imports.
   - Test:
     - manual rollback and diff checks.
   - Risk:
     - lingering legacy read of `servedQueue` in bulk workspace.

11. Slow Single today: same simplification discipline as bulk

- Command surface (keep exactly):
  - `startCxSlowSingleCall`
  - `confirmCxSlowSingleCurrent`
  - `submitCxSlowSingleOutcome`
  - `killCxSlowSingleSession`
  - `getCxSlowSingleSession`

Backend simplification pass (current files, no behavior expansion):

1) `packages/shared-services/src/cxSlowLaneService.js`
   - `startCxSlowSingleCall`
     - Select one queue item, publish it, return session in `pending_confirmation`.
     - Do not call `confirmCxSlowSingleCurrent` from inside `start`.
   - `confirmCxSlowSingleCurrent`
     - Only this function can set active current fields (`uii`, `activeCallSummary`, `matchReasons`).
     - On miss, emit one `active.pending` and stop.
   - `submitCxSlowSingleOutcome`
     - Require current + active-phase precondition (or clear stale-check path with explicit error).
     - Execute only one terminal transition (`terminal.started` -> `terminal.accepted|failed`) and clear current there.
     - No hidden “auto watch + auto advance” side effects in one call.
   - `killCxSlowSingleSession`
     - Cancel current publish if exists; set phase to released/ended.
   - Strip mixed responsibilities:
     - keep one helper for queue claim + publish, one for capture, one for terminal result, one for session transition.
   - Add bounded capture-miss guard:
     - `CONFIRM_MISS_LIMIT` (e.g., 5) + small TTL window.
     - when exhausted, transition to `failed` and ask for explicit retry/restart.

2) `packages/shared-services/src/cxSlowLaneStateMachine.js`
   - Keep event-driven states but remove extra branches used only for bulk behavior.
   - Ensure:
     - publish acceptance -> `pending_confirmation`
     - active confirm -> `active`
     - terminal write -> `releasing`
     - final disposition -> `released`
   - Prevent dual transitions from same tick by making `terminal.accepted` the sole completion marker.

3) `packages/shared-repositories/src/cxSlowLaneSessionRepository.js`
   - Keep current interface but add narrow write helpers:
     - `setCurrent(sessionId, current)`
     - `clearCurrent(sessionId)`
     - `setPhase(sessionId, phase, patch = {})`
   - Prefer narrow helpers in service instead of wide object mutation.

4) `packages/shared-models/src/CxSlowLaneSession.js`
   - Trim to fields used by this rail (session metadata + current + lastOutcome + lastError + events/timestamps).
   - Do not grow schema with fields borrowed from old rails.

5) `packages/shared-services/src/ringcxActiveCallCaptureService.js`
   - For slow mode matching, use strict identity-first matching (`externId`, `queueItemId`, exact `uii`) and keep phone as fallback only where already explicitly allowed.
   - Return explicit proof shape so watch can apply “one miss counter” cleanly.

6) `apps/web-client/src/workspaces/cx/slow-single/CXWorkspaceSlowSingle.tsx`
   - Keep only one poll transition loop:
     - when phase indicates pending confirmation and `current.uii` missing -> watch.
   - Button state = direct phase contract (`active` only).
   - Show `releasing` as transient and avoid client-side current inference.

7) `apps/web-client/src/lib/api/queries/cxSlowSingle.ts`
   - Keep 4 command hooks + session query.
   - Keep invalidation narrow; one query key per command family.

8) `apps/control-plane/src/routes/cxSlowSingle.js`
   - Keep route thin and auth-first; no orchestration logic.

Acceptance checks to run before merge:

- [ ] publish accepted does not auto-activate current.
- [ ] only `confirmCxSlowSingleCurrent` activates current.
- [ ] one active match -> one current transition.
- [ ] one button click -> one terminal write.
- [ ] no phone-only matching in slow mode.
- [ ] capture misses are bounded and explicit.

## Slow Single Code Audit Runbook

Start the audit with invariants, not style. The core question is:

> Can this flow get stuck, advance too early, double-write, or silently call the wrong thing?

### Files to review

- `packages/shared-services/src/cxSlowLaneService.js`
- `packages/shared-services/src/cxSlowLaneStateMachine.js`
- `packages/shared-repositories/src/cxSlowLaneSessionRepository.js`
- `packages/shared-services/src/ringcxActiveCallCaptureService.js`
- `apps/web-client/src/workspaces/cx/slow-single/CXWorkspaceSlowSingle.tsx`
- `apps/web-client/src/lib/api/queries/cxSlowSingle.ts`
- `apps/control-plane/src/routes/cxSlowSingle.js`
- `packages/shared-services/src/cxMorningQueueBuilderService.js`

### Required behavior

- `start` only selects and publishes one lead, then returns `pending_confirmation`.
- `watch` only confirms active RingCX evidence and promotes to `active`.
- `outcome` only disposes, releases, and records the current call.
- `kill` only clears the current session safely.
- No backend endpoint secretly does "finish current + select next + publish + confirm".
- The UI may chain calls, but every backend command remains single-purpose.
- Buttons only unlock when `current.uii` exists and session phase is `active`.
- Between calls, the UI shows loading or disabled state instead of stale lead/buttons.
- Confirmation misses are bounded and fail closed.
- Terminal calls are guarded by `expectedQueueItemId` and `expectedUii`.

### Smoke checks

Run:

```powershell
node --check packages/shared-services/src/cxSlowLaneService.js
node --check packages/shared-services/src/cxSlowLaneStateMachine.js
node --check apps/control-plane/src/routes/cxSlowSingle.js
npm.cmd run typecheck --workspace=web-client
```

Local functional smoke:

1. Login as a test agent in `slow_single`.
2. Press send/start.
3. Confirm UI shows waiting/pending and no disposition buttons.
4. Let `watch` detect UII.
5. Confirm buttons appear only after active UII.
6. Press `Answered`, `No Answer`, or `Voicemail`.
7. Confirm current clears, last outcome updates, and UI shows loading.
8. Confirm the next start is a separate API call.
9. Confirm no duplicate terminal writes.

### Failure cases to test

- RingCX publish accepted but no UII arrives.
- Miss limit reached.
- Stale button press with wrong `expectedQueueItemId`.
- Stale button press with wrong `expectedUii`.
- RingCX disposition fails once, then retries.
- No next lead available.
- Agent refreshes page mid-pending.
- Agent refreshes page mid-releasing.

### Audit red flags

- Any `advanceNext`, `sendNext`, or `autoNext` backend behavior.
- Any `outcome` endpoint calling select, publish, or confirm.
- Any UI button enabled without `current.uii`.
- Any broad session kill not scoped to agent/session.
- Any queue row moved without recording why.
- Any swallowed error around RingCX publish, cancel, active-call read, or terminal disposition.

### Morning builder audit

The 7am builder must:

- run only when enabled.
- process active CX-routing agents.
- drain only traceable RingCX rows.
- build local queue before mirroring.
- mirror one lead at a time.
- use `NORMAL` priority.
- wait for RingCX response per lead.
- report totals in health/runtime.

Success looks boring: no hidden magic, clear logs, one command per action, and every wait state visible to the agent.

### Completion Gate

- [ ] Current is driven only by RingCX active evidence in bulk mode.
- [ ] One button action completes exactly one current once.
- [ ] RingCX auto-advance completes prior current once and switches cleanly.
- [ ] No phone-only matching for bulk mode.
- [ ] Kill clears current and cancels buffer leads.
- [ ] Local override rollback returns to `slow_single` without data cleanup.

## No-Crossing-Lines Enforcement Checklist

Use this checklist before merge. If any item fails, split files/functions before proceeding.

### 1) Runtime boundary

- `cxDialRuntimeModeService` is pure decision only.
  - no session reads/writes
  - no RingCX calls
  - no queue mutations
- legacy route/service code does not import bulk-load mutators.
- bulk-load route/service code does not import legacy queue mutators.
- shared neutral code does not resolve runtime.

### 2) Function atomicity

- one exported function does one command and one state responsibility.
- each function has one obvious noun and one verb in name.
- no function both:
  - reads evidence,
  - publishes RingCX leads,
  - and commits terminal outcomes.
- no recursive calls across `start/watch/submit/kill`.
- if a function exceeds one conceptual job, split and keep behavior tests with each split.

### 3) Evidence-only current rule

- only active-call evidence can set `current`.
- publish acceptance must not set `current`.
- empty/missing active evidence does not advance/clear `current` in bulk-load mode.
- if active evidence switches from current A to B:
  - complete A exactly once,
  - promote B exactly once.
- no phone-only promotion path in matching.

### 4) Idempotency and completion safety

- each terminal path uses one idempotency key:
  - `sessionId + candidateId + eventType`.
- `submit` and `skip` may only complete one `current` candidate.
- auto-advance completion and user completion never both apply to same candidate in one tick.
- every completion writes exactly one outcome record.

### 5) Dependency audit commands

Run these targeted checks when wiring files:

- ensure runtime purity:
  - `rg "resolveCx.*Runtime|CX_DIAL_RUNTIME|isCxBulkLoadRuntime" packages/shared-services/src packages/web-client/src/workspaces/cx apps/control-plane/src`
- ensure no legacy queue mutation in bulk load runtime:
  - `rg "requestCxDial|transitionQueueItemState|claimNextReadyQueueItem|servedQueue|nextDial" packages/shared-services/src/cxBulkLoad* apps/control-plane/src/routes apps/web-client/src/workspaces/cx`
- ensure no bulk load mutators imported in legacy rail:
  - `rg "cxBulkLoad" apps/control-plane/src routes/* packages/shared-services/src legacy*`
- ensure route thinness:
  - `rg "await .*startCxBulkLoadSession|await .*watchCxBulkLoadSession|await .*dispositionCxBulkLoadSession|await .*skipCxBulkLoadCurrent|await .*killCxBulkLoadSession" apps/control-plane/src/routes/cxBulkLoad.js`

### 6) Render-boundary sanity

- when runtime is `bulk_load`, only bulk session snapshot drives middle card.
- do not read `selectedLead`, `agentstates.cxCall`, or `servedQueue` as `current`.
- stop legacy auto-serve timers/effects when bulk mode route is active.

### 7) Merge gate

- [ ] Runtime resolution remains deterministic and isolated.
- [ ] current updates are evidence-driven.
- [ ] one active match => one current transition.
- [ ] one button click => one completion.
- [ ] one kill => current cleared + session cancelled + pending leads drained.
- [ ] rollback flag restores `slow_single` without migration scripts.
