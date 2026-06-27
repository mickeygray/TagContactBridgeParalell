# CX Dial Rail — Function-by-Function Build Breakdown (2026-06-23)

> Companion to `CX_DIAL_RAIL_FINALIZATION_PLAN_2026-06-23.md`. The plan's **Canonical Spec §0–§6** + **Implementation Guide M1–M8** are the authoritative contract; this doc maps them to the exact functions/files/line-refs an implementer touches, in dependency order. Build straight through in milestone order. **Non-negotiable: M2 (reaper exclusion) ships strictly before M4 (rail rewire); no live toggle until the full M8 offline suite is green.**

## CX Dial Rail — Function-by-Function Build Breakdown

This document is the single implementer reference for building the **Source Pool & Reservation service** straight through. The authoritative contract is the **Canonical Spec §0–§6** plus the **Implementation Guide M1–M8**; this breakdown does not restate those documents — it maps them onto the exact functions, files, and line refs an engineer touches, in dependency order. Every function below is given as **Now** (current behavior, line ref as read today), **Target** (KEEP / MODIFY / NEW / DELETE / REPLACE), **Change** (the precise edit), and **Serves** (the spec section / failure-mode / milestone it satisfies). The reservation model is: a shared `cxQueueReservationService` (one instance, shared by all rails + the M5 publish-time interlock) reserves `ready→claimed` rows atomically per family via the net-new repo helper `reserveReadyRows`, applies a **claim-time cross-pool guard (`assertNotActiveInUcq`)**, the reaper is made blind to session-held and appointment-pinned rows, a guarded-CAS heartbeat (`renewClaim`) keeps the lease alive, and every terminal path nulls the reservation provenance trio so no row is ever pinned without a live owner. **The non-negotiable deploy gate: M2 (reaper exclusion) ships strictly BEFORE M4 (rail rewire). M1 (`reserveReadyRows`) may merge isolated but MUST NOT be consumed live until M2 lands. No live toggle until the full M8 offline suite is green.**

---

### Build-order crosswalk (M1 → M8)

> **DEPLOY RULE (restated, non-negotiable): M2 must be deployed strictly before M4.** `reserveReadyRows` (M1) may merge in isolation but must not be consumed live by any rail until the reaper-exclusion edit (M2) is in production — otherwise a freshly reserved row is reapable mid-lease (FM-1/FM-1b buffer-steal / cross-session double-reserve). **Live toggle is additionally gated on the full M8 offline suite passing green.**

| Milestone | Creates / Edits | Files |
|---|---|---|
| **M1** — atomic bulk-claim helper | NEW `reserveReadyRows` (single `updateMany` per family, `modifiedCount`=truth, one same-tick re-plan retry, dotted reservation-provenance `$set`, appointment-excluded `$match`); REUSE `TOUCH_BALANCED_QUEUE_SORT` + `buildClaimPatch` | `cxDialQueueRepository.js` |
| **M2** — reaper exclusion + heartbeat + serving-stamp | EDIT `buildExpiredClaimRequeueQuery` (append 2 `$or` clauses: reservationSessionId + appointmentId); `requeueExpiredClaims` inherits; NEW `renewClaim` (guarded-CAS heartbeat); serving-stamp via existing `transitionQueueItemState(['claimed']→serving)` at the verified assigner pattern `cxCadenceService.js:3511`, reading `item?.metadata?.reservationSessionId` OFF the row, `match:{reservationSessionId}+returnNew:true`, null-return race-bail mirroring `:3535` (no new repo fn) | `cxDialQueueRepository.js`, dialer caller in `cxCadenceService.js` / `cxBulkLoadRuntime.js` |
| **M3** — provenance-null + crash reconciler | EDIT `buildClearedDialRuntimeMetadata` (+3 null keys → transitively nulls complete/reschedule/cancel/assigner); EDIT `listQueueItems` (NEW `metadataReservationSessionIdNotIn` branch); NEW `cxReservationReconcilerService.reconcileDanglingReservations` (calls `completeCxQueueItem` force path) | `cxCadenceService.js`, `cxDialQueueRepository.js`, **NEW** `cxReservationReconcilerService.js` |
| **M4** — three-rail rewire (gated behind M2) | THREAD `reservationService` into bulk wiring + slow lane; REPLACE list/snapshot fill sources with `reserveFromFamilyOrder`; REPLACE `fillBuffer`/`watchCxBulkLoadSession`; slow-lane `selectNextQueueItem` reserve + dialability post-filter; DELETE `bulk-mirror` 4th path; durable write-ahead outbox replacing in-process Set | `cxBulkLoadRuntime.js`, `cxBulkLoadRuntimeService.js`, `cxBulkLoadActiveCallWatcher.js`, `cxBulkLoadStateMachine.js`, `cxSlowLaneService.js`, `cxSimpleCallLoopService.js` |
| **M5** — cross-pool publish interlock **(BOTH ends + mirror disable)** | NEW `findActiveClaimForCase` (different active claimed/serving sibling by caseId, `_id`-excluded), consumed by `ringcxLeadServingService.publishQueueItemToRingcx` (PUBLISH-time refusal); **EDIT `cxQueueReservationService.reserveFromFamilyOrder` to add `assertNotActiveInUcq(rows)` CLAIM-time guard via `queueItemRepository.existsForLead`**; **EDIT `cxMorningQueueBuilderService.js` (mirror default OFF + pacing-gate)** | `cxDialQueueRepository.js`, `ringcxLeadServingService.js`, `cxQueueReservationService.js`, `cxMorningQueueBuilderService.js` |
| **M6** — ingestion family-enum validation + atomic appointment paused-create | EDIT `queueCxDialRequest` (canonicalize `payload.queueFamily` via `normalizeQueueFamily`, re-derive via `resolveQueueFamilyForPayload`/`deriveQueueFamilyFromAgeDays` when unassigned/invalid); EDIT `cxAppointmentService.ensureAppointmentQueueItem` (ready-guard `→paused` transition between create and the existing paused transition) | `cxCadenceService.js` (`queueCxDialRequest`), `cxAppointmentService.js`; REUSE `normalizeQueueFamily`/`resolveQueueFamilyForPayload` |
| **M7** — reserve-mode family targets | NEW `cxReserveModeService.buildFamilyTargets({ policy, totalDeficit, env=process.env })` (consumes `getQueueFamilyTargetOpen` + `env.RC_CX_RESERVE_MODE` + `RC_CX_AGED_MIN_RESERVE_PER_CYCLE` via inlined `readEnvNonNegInt`; targetOpen = DEPTH not throughput; green-first mode = `fresh-day1: totalDeficit`) | **NEW** `cxReserveModeService.js` |
| **M8** — offline test suite + checklist walk | CREATE the ~13 named offline test files mirroring the 54-test bulk_load layout; walk the §6 air-tightness checklist box-by-box mapping each box to its milestone; typecheck clean; **no live toggle until all green with M2-before-M4 enforced** | `__tests__/` (net-new test files) |
| **M8b** — provenance/route-lock/logging/intake hardening | `metadata.reservationRail` rail-provenance stamp + rail-mismatch FAIL-CLOSED enforcement; **reserve-time RingCX route lock (`rcxAccountId`/`rcxCampaignId`/`rcxDialGroupId`/`routeCampaignKey`) + publish-time route-match check releasing `'route-changed-before-publish'`**; **4001 intake stays pool-additive (no assignment, no publish) + reserve-time local DNC/Logics/terminal-outbox suppression by `queueItemId` AND `(domain,caseId)`, fail-closed on unknown/stale**; strip `[DISPTRACE]` PII logging to audit-friendly non-PII | `cxBulkLoadRuntime.js`, `cxBulkLoadRuntimeService.js`, `cxQueueReservationService.js`, `ringcxLeadServingService.js`, `inboundIntakeService.js` |

---

### New files to create

| File | Provides | Milestone |
|---|---|---|
| `packages/shared-services/src/cxQueueReservationService.js` | `createCxQueueReservationService({cxDialQueueRepository, queueItemRepository, resolveQueueDialability})` → `reserveFromFamilyOrder`, `releaseReserved`, `renewReserved`. The ONE shared instance all rails + the M5 interlock inject. Wraps `reserveReadyRows`/`renewClaim`/`transitionQueueItemState`. `reserveFromFamilyOrder` runs the M5 claim-time `assertNotActiveInUcq` guard via injected `queueItemRepository.existsForLead`, and (M8b) stamps the RingCX route-lock fields + applies local DNC/Logics/terminal-outbox suppression BEFORE claim. | M1/M4/M5/M8b |
| `packages/shared-services/src/cxReservationReconcilerService.js` | `reconcileDanglingReservations` — finds `claimed` rows whose owning session is not live (via `listQueueItems` `metadataReservationSessionIdNotIn`), adopts via reservationSessionId-guarded CAS, and force-completes terminal-evidence rows through `completeCxQueueItem`. | M3 |
| `packages/shared-services/src/cxReserveModeService.js` | `buildFamilyTargets({ policy, totalDeficit, env=process.env })` — builds `mix`-mode per-family targets from `getQueueFamilyTargetOpen(policy, fam)` + `env.RC_CX_RESERVE_MODE` + `RC_CX_AGED_MIN_RESERVE_PER_CYCLE` (read via inlined `readEnvNonNegInt`); green-first mode assigns `fresh-day1: totalDeficit`. targetOpen = DEPTH. | M7 |

### Files to modify (function list)

| File | Functions edited |
|---|---|
| `packages/shared-repositories/src/cxDialQueueRepository.js` | `buildExpiredClaimRequeueQuery` (append 2 `$or`), `renewClaim` (NEW), `reserveReadyRows` (NEW), `findActiveClaimForCase` (NEW), `listQueueItems` (NEW `metadataReservationSessionIdNotIn` branch) |
| `packages/shared-repositories/src/queueItemRepository.js` | none (consumed read-only: `existsForLead` (`:391`) + `activeLeadFilter` (`:28`) injected into the reservation service for the M5 claim-time guard) |
| `packages/shared-models/src/CxDialQueue.js` | none (all reservation lifecycle maps onto existing enum + Mixed `metadata`; NO schema migration) |
| `packages/shared-services/src/cxCadenceService.js` | `buildClearedDialRuntimeMetadata` (+3 null keys — the M3 code footprint here); `queueCxDialRequest` (M6 family-enum canonicalize/re-derive); `classifyCxTerminalOutcome` (Drain-milestone broadening, not M3) |
| `packages/shared-services/src/cxAppointmentService.js` | `ensureAppointmentQueueItem` (M6 atomic paused-create ready-guard) |
| `packages/shared-services/src/cxBulkLoadRuntime.js` | `getService`, `listReadyQueueItems`, `markCandidatePublished`, `markCandidateServing`, `terminalExecutor` (logging), `makeInProcessMarkOnce` (REPLACE), `startCxBulkLoadSession` (pass-through) |
| `packages/shared-services/src/cxBulkLoadRuntimeService.js` | `fillBuffer`, `watchCxBulkLoadSession`, `submitCxBulkLoadDisposition`, `skipCxBulkLoadCurrent`, `startCxBulkLoadSession`, `killCxBulkLoadSession`, `maybeRefill`, `persistableState`, `createCxBulkLoadRuntimeService` deps |
| `packages/shared-services/src/cxBulkLoadActiveCallWatcher.js` | `deriveCurrentTransition` (drop synthetic outcome), `deriveReleasedCandidates` (NEW pure fn) |
| `packages/shared-services/src/cxBulkLoadStateMachine.js` | `reduceCxBulkLoadState` (trim synthetic `auto_advanced`; add `buffer.released` case) |
| `packages/shared-services/src/cxSlowLaneService.js` | `selectNextQueueItem` (reserve + dialability post-filter), module-scope reservationService wiring |
| `packages/shared-services/src/cxSimpleCallLoopService.js` | `scoreBulkActiveCandidate` (delete phone +45 tier), `advanceCxSimpleLoopSession` (delete `bulk-mirror` branch), `resolveSimpleLoopMode`; DELETE `captureBulkCurrent`/`loadSimpleLoopQueue`/`replenishBulkQueue`/`shouldReplenishBulkQueue`/`getBulkQueueTargetSize` with the `bulk-mirror` collapse |
| `packages/shared-services/src/ringcxLeadServingService.js` | `publishQueueItemToRingcx` (consume `findActiveClaimForCase`, refuse publish on different active sibling; M8b route-match check) |
| `packages/shared-services/src/cxMorningQueueBuilderService.js` | mirror default flip + pacing-gate (M5 FM-2b): `normalizeBoolean(env.CX_MORNING_QUEUE_BUILDER_MIRROR, …)` default `true→false` (`:528`); gate `if (options.mirror)` (`:433/:434`) behind `!pacingEnabled` read directly off `process.env.PACING_QUEUE_ENABLED` |
| `packages/shared-services/src/inboundIntakeService.js` | M8b: 4001 intake stays pool-additive (creates pool-owned `ready`/`queued`, no `assignment`, no RingCX publish) |

### Files to leave untouched

- `CxDialQueue.js` — entire schema: `state` enum, `queueFamily` enum, `queueFamilyRank`, `claimUntil`, `assignment` subdoc, `metadata` (Mixed — new keys absorbed, NO migration), `uq_cxdialqueue_active_action` index, all base scalars, all secondary indexes, `callPlan`, placement counters.
- `cxDialQueueRepository.js` bodies that inherit edits or aren't touched: `normalizeDomain`, `isDuplicateKeyError`, `activeQueueFilter`, `normalizeQueueFamilies`, `normalizeRouteCampaigns`, `resolveQueueFamilies`, `buildReadyClaimQuery`, `applyCreatedAtRange`, `findActiveQueueItem`, `upsertQueueItem`, `releaseDueQueueItems`, `requeueExpiredClaims` (body — inherits the query edit), `claimRandomReadyQueueItem`, `claimNextReadyQueueItem`, `markQueueItemCompleted`, `cancelActiveQueueItems`, `updateQueueItem`, `transitionQueueItemState` (body), `findQueueItemById`, `findClaimedQueueItemByRequestKey`, `countQueueItems`, `buildClaimPatch` (body), `TOUCH_BALANCED_QUEUE_SORT`.
- `queueItemRepository.js`: `existsForLead` (`:391`) + `activeLeadFilter` (`:28`) are CONSUMED unchanged (injected into the reservation service); the file itself is not edited.
- `cxCadenceService.js`: `completeCxQueueItem` (reused as-is as the force path), `rescheduleCxQueueItem` / `cancelCxQueueItem` (gain lease-null transitively), `handleCxCallPlaced` (rail-side wiring only), `handleCxTerminalCallOutcome` (kept for legacy served path), `resolveQueueFamilyForPayload` (REUSED unchanged as the M6 re-derive fallback — the edited function is `queueCxDialRequest`, NOT this).
- `cxQueuePolicyService.js`: `resolveAccountQueuePolicy`, `deriveQueueFamilyFromAgeDays`, `deriveQueueFamilyFromLeadTouchState`, `deriveQueueFamilyFromLeadCreatedAt`, `getQueueFamilyTargetOpen`, `getQueueFamilySortRank`, `getQueueFamilyPolicy`, `getPolicyBucketForQueueFamily`, `isQueueFamilyAllowedForAccountPolicy`, `resolveQueueLifecycleHold`, `buildCallAttemptPatch`, `normalizeQueueFamily` (`:436`, REUSED unchanged by M6 to canonicalize caller-supplied families).
- `cxQueueFairnessService.js`: `getCxQueueServeRank`, `buildCxHourlyAttemptPatch`, `getCxHourlyCapForQueueFamily`, `getCxHourlyPacingStatus`, `isFreshFirstContactQueueItem`, `computeAgingBoost`.
- `cxBulkLoadActiveCallWatcher.js`: `matchActiveCallToCandidates` (already strict externId→queueItemId, no phone fallback), `loadActiveCallsSnapshot`, `normalizeActiveCall`, `extractActiveCallList`, `candidateExternId`, `candidateQueueItemId`, `MATCH_ORDER`, `str`.
- `cxBulkLoadStateMachine.js`: `clonePlain`, `arrayOf`, `queueItemKey`, `upsertByQueueItemId`, `removeByQueueItemId`, `pushCompletedOnce`, `CX_BULK_LOAD_PHASES`.
- `cxBulkLoadRuntimeService.js`: `liveSlots`, `bufferDeficit`, `candidatePool`, `sanitizeCandidateForClient`, `sanitizeSession`, `serializeError`, `targetBufferFor`, `refillThresholdFor` (logic).
- `cxBulkLoadRuntime.js`: `bulkOutcomeDisposition`, `resolveAgentContext`, `assertBulkRuntime`, `findOwnedBulkLoadSession`, `bulkSessionBelongsToAgent`, `isBulkLoginOffhook`, `makeHttpError`, `resolveSessionId`, `offhookGate.isAgentOffhook`, normalize\*.
- `cxSlowLaneService.js`: `publishCurrent`, `executeTerminalDispositionWithRetry`, `startCxSlowSingleCall` (explicit-`queueItemId` branch + confirm/terminal orchestration).
- `cxSimpleCallLoopService.js`: `advanceSingleSession` (retained as the sole mode), `submitCxSimpleLoopDisposition`.
- `cxMorningQueueBuilderService.js`: every other path beyond the two edits named above (the builder's pool-additive materialize stays).

---

## Subsystem 1 — Repository + Model layer (`cxDialQueueRepository.js`, `CxDialQueue.js`)

All line refs are against the files as read today. Authority = Canonical Spec §0–§6 + Implementation Guide M1/M2/M3/M5. **Deploy gate: M1 (`reserveReadyRows`) may merge isolated, but MUST NOT be consumed live until M2 (reaper exclusion) ships — M2 strictly before M4.**

### File: `packages/shared-repositories/src/cxDialQueueRepository.js`

**`TOUCH_BALANCED_QUEUE_SORT`** (`:6`, frozen object: queueFamilyRank, dailyPlacedCalls, progressiveStageIndex, lastPlacedAt, priorityScore, releaseAt, createdAt)
- **Now:** The canonical pool sort. Used by `releaseDueQueueItems` (`:180`), `claimNextReadyQueueItem` (`:287`), `listQueueItems` default (`:430`).
- **Target:** KEEP — verbatim.
- **Change:** none. NEW `reserveReadyRows` REUSES it for both the candidate `find().sort()` (M1 `:1211`) and the post-claim re-read (`:1245`). Spec mandates reserve order = persisted `queueFamilyRank` only.
- **Serves:** §1 I1 (new greens at green head by `{queueFamilyRank:1,…,createdAt:1}`), §2 order-fill backfill in rank order, FM-6 (DB-authoritative ordering; aging boost display-only).

**`buildClaimPatch(now, claimMinutes)`** (`:114`, returns `{state:'claimed', lastClaimedAt, claimUntil}`; floors claimMinutes at 1)
- **Now:** Single-claim patch for `claimNextReadyQueueItem`/`claimRandomReadyQueueItem`. `claimUntil = now + max(claimMinutes,1)·60s`. The G3a 1-min floor lives here (`:118`).
- **Target:** KEEP unchanged.
- **Change:** none to the function. NEW `reserveReadyRows` spreads it into its bulk `$set` (M1 `:1221`) so the bulk path never diverges from the single-claim path, then layers `assignment.*` + reservation provenance as dotted keys on top. G3a guardrail (§3): the reservation service MUST pass an explicit `claimMinutes ≥ renewalInterval·2` and never rely on this default-5.
- **Serves:** §2 reservation lease fields; §3 G3a; M1 Wires/Why (single/bulk parity).

**`buildExpiredClaimRequeueQuery(now)`** (`:122`) — **THE REAPER-EXCLUSION EDIT (M2)**
- **Now:** Builds the global reaper match for `requeueExpiredClaims`: `state:'claimed'`, `claimUntil:{$ne:null,$lte:now}`, plus a 4-clause `$and` ($or guards on `metadata.servingAt` empty, `lastDialExecutionUii` empty, `lastQueueAttemptHeldForDisposition`≠true, `lastDialIntentStatus` empty/failed). **GLOBAL — no domain, no agentExtensionId, no reservationSessionId filter.**
- **Target:** MODIFY — extend (do NOT replace; the four existing `$and` clauses stay).
- **Change:** APPEND two more `$or` clauses INTO the existing `$and` (M2 `:1332`): (1) §3.1 hard ownership exclusion — `{$or:[{'metadata.reservationSessionId':{$exists:false}},{...:null},{...:''}]}` so ANY session-held row is invisible to the reaper regardless of lease age; (2) FM-5 appointment exclusion — `{$or:[{'metadata.appointmentId':{$exists:false}},{...:null},{...:''}]}`. Keep `claimUntil:{$ne:null,$lte:now}` (null claimUntil is never reaped).
- **Serves:** §3.1 (removes heartbeat-vs-reaper TOCTOU), FM-1 (buffer-steal same session), FM-1b (cross-session double-reserve), FM-5 (un-pinned appointment), FM-7 (assignment silently wiped). §6 checklist line: reaper invisible to any reservationSessionId row + appointment* rows.

**`requeueExpiredClaims(now, limit)`** (`:201`, the reaper: find by query, per-doc `findOneAndUpdate` → `state:'ready'`, `claimUntil:null`, unconditionally wipes `assignment` subdoc `:221`, stamps lastReleased* metadata)
- **Now:** Frees expired claims. The unconditional `assignment` wipe (`:221`) is FM-7; the global query (`:202`) is the FM-1/FM-1b vector.
- **Target:** KEEP body unchanged — it inherits the fix automatically because it calls `buildExpiredClaimRequeueQuery(now)` (`:202`). M2 Files note: "requeueExpiredClaims inherits the change automatically."
- **Change:** none directly. Behaviorally it now skips every `reservationSessionId`/`appointmentId`-bearing row. The per-doc re-guard `{_id, ...query}` (`:216`) carries the new exclusions too, so an unguarded re-match can't slip through.
- **Serves:** §3.1, FM-1/1b/5/7. M2.

**`renewClaim(ids, claimMinutes, sessionId)`** — **NEW (M2)**
- **Now:** does not exist.
- **Target:** NEW.
- **Change:** Add after the reaper block. ONE `findOneAndUpdate` per id guarded by `{_id:id, state:'claimed', 'metadata.reservationSessionId':sessionId}`, `$set:{claimUntil:until, 'metadata.reservationExpiresAt':until}`, `{new:true}`; collect renewed ids, return them (M2 `:1363`). Serving/other-owner ⇒ silent no-op. Export it.
- **Serves:** §3.2 (guarded-CAS heartbeat; liveness signal, not the safety mechanism — the no-op once row goes `serving` or another owner holds it), §3.3 (caller stops renewing on terminal evidence), §6 checklist (renew every tick, interval < claimMinutes).

**`reserveReadyRows(domain, familyTargets, options)`** — **NEW (M1, the headline net-new helper)**
- **Now:** does not exist (verified absent).
- **Target:** NEW.
- **Change:** Add after `claimNextReadyQueueItem` (`:272`); export in `module.exports` (`:481`). Per-family loop over `normalizeQueueFamilies(Object.keys(familyTargets))`. Per family: `familyMatch = {state:'ready', queueFamily, 'metadata.appointmentId':{$in:[null,'']}, ...(domain?{domain:normalizeDomain(domain)}:{})}`. Bulk-claim with ONE same-tick re-plan retry (`attempt < 2 && need > 0`): `find(familyMatch).sort(TOUCH_BALANCED_QUEUE_SORT).limit(need).select({_id:1}).lean()` → collect ids → ONE `updateMany({_id:{$in:ids}, state:'ready'}, {$set:{...buildClaimPatch(now,claimMinutes), 'assignment.extensionId':extensionId, 'assignment.assignedAt':now, 'assignment.queueFamilySnapshot':family, 'metadata.reservationSessionId':sessionId, 'metadata.reservedAt':now, 'metadata.reservationExpiresAt':now+ttl, 'metadata.lastRingcxPublishedAt':null, 'metadata.lastRingcxPublishedExternId':null}})`. `need -= res.modifiedCount`; break if `modifiedCount===0`. Re-read the rows this session now owns (`state:'claimed', reservationSessionId:sessionId, reservedAt:now`) sorted by `TOUCH_BALANCED_QUEUE_SORT`. `missing[family]=need` only after the retry. Requires `sessionId` (throw if absent); explicit `claimMinutes` floored at 1 (M1 `:1189`). All provenance set as DOTTED `$set` keys (never nested objects — avoids upsert clobber).
- **Serves:** §2 reservation contract + the 5-step bulk-claim spec; FM-10 (single `updateMany` modifiedCount = truth, distinguishes claimed-elsewhere from short supply); §3 G-appt structural exclusion of appointment rows; CR2 (atomic ready→claimed before publish). §6 checklist: single atomic bulk claim per family + one same-tick re-plan retry.

**`findActiveClaimForCase(domain, caseId, excludeId)`** — **NEW (M5, publish-time interlock half)**
- **Now:** does not exist.
- **Target:** NEW.
- **Change:** Add a `findOne({domain:normalizeDomain(domain), caseId:Number(caseId), state:{$in:['claimed','serving']}})` with `if (excludeId) query._id = {$ne:excludeId}` (M5 `:1620`). Explicitly NOT a reuse of `findActiveQueueItem` (`:142`) — that self-matches over ANY active state via `activeQueueFilter` with no `_id` exclusion and would let the publishing row mask its own sibling. Catches a concurrent claim under any actionKey (not actionKey-scoped).
- **Serves:** §0 / CR4 / FM-2 publish-time half of the DB-level cross-pool interlock; consumed by `ringcxLeadServingService.publishQueueItemToRingcx` to refuse publish when a DIFFERENT active CxDialQueue claim/serving sibling exists. (The CLAIM-time half lives in `cxQueueReservationService.assertNotActiveInUcq` via `queueItemRepository.existsForLead` — Subsystem 4.)

**`upsertQueueItem(domain, caseId, update, options)`** (`:146`, raw upsert; actionKey-scoped filter; `findOneAndUpdate(..., {new,upsert,setDefaultsOnInsert})`; duplicate-key fallback to `findActiveQueueItem`)
- **Now:** The raw writer. Called directly only by cxWorkspaceService refill materializers (day2-15/day16-30/aged) and indirectly via `cxCadenceService.queueCxDialRequest`. Already pool-owned (never sets `assignment`).
- **Target:** KEEP — no repo-layer signature/body change.
- **Change:** none in this file. (§1 I1/I2 family-enum-validation and stable-actionKey conformance are enforced at the CALLER layer — `cxCadenceService.queueCxDialRequest`/`cxAppointmentService` in M6 — not here. The repo upsert stays the raw mechanism.) Note the `$set:{...update}` dotted-vs-nested gotcha is why `reserveReadyRows` uses dotted keys. **M6 explicitly does NOT swap appointment/ingestion paths to bare `upsertQueueItem` — they stay on `queueCxDialRequest` to preserve STOP/DNC eligibility gating.**
- **Serves:** §1 sanctioned-writer #2 (raw funnel), I2 actionKey unique-index mechanism (`uq_cxdialqueue_active_action`). Unchanged.

**`claimNextReadyQueueItem(domain, claimMinutes, options)`** (`:272`, sorted `findOneAndUpdate` with `buildClaimPatch`; delegates to `claimRandomReadyQueueItem` when `options.randomize`)
- **Now:** Legacy/slow single-row claim path (limit:1 semantics). Uses `buildReadyClaimQuery` + `TOUCH_BALANCED_QUEUE_SORT`.
- **Target:** KEEP unchanged (M1 explicitly: "Keeps existing claimNextReadyQueueItem and listQueueItems unchanged").
- **Change:** none. It is one of the "claimed elsewhere" actors that `reserveReadyRows`'s `modifiedCount < n` retry is designed to tolerate (legacy fast's limit:1 racing the bulk claim).
- **Serves:** §2 (legacy fast / slow single still use the single-claim path; rails request through the reservation service but this remains the underlying single-row primitive). Unchanged.

**`transitionQueueItemState(id, fromStates, update, options)`** (`:341`, `findOneAndUpdate({_id, state:{$in:fromStates}, ...options.match}, {$set:update}, {new:options.returnNew})`; returns null on guard miss, no throw)
- **Now:** The generic guarded CAS. `options.match` keys are merged into the query (`:353`). Returns null when nothing matched (`:358`).
- **Target:** KEEP unchanged — but it becomes a load-bearing CAS primitive for four new flows.
- **Change:** none to the function. NEW consumers: (1) `cxQueueReservationService.releaseReserved` calls it `(['claimed'], {state:'ready', assignment:{…nulls}, reservation provenance nulled, lastReleaseReason}, {match:{'metadata.reservationSessionId':row.metadata.reservationSessionId}})` — the match makes it a real reservationSessionId-guarded CAS; (2) the dialer `claimed→serving` write `(['claimed'], {state:'serving','metadata.servingAt':now,'metadata.lastDialExecutionUii':uii}, {match:{reservationSessionId}, returnNew:true})` at the verified assigner pattern `cxCadenceService.js:3511` — caller reads `reservationSessionId = item?.metadata?.reservationSessionId` OFF the row and MUST check the null return and bail on a race, mirroring `:3535` queue-assignment-race handling (M2 `:1390`); (3) the crash reconciler adopts dangling rows via a reservationSessionId-guarded CAS (M3 `:1456`); (4) the M6 appointment ready-guard `(['ready'], {state:'paused'})`.
- **Serves:** §3.5 (single atomic serving-stamp), §4 release coordination + reconciler CAS (FM-11), §3.2/§4 reservationSessionId guards, M6 appointment atomicity. The verified `{new: options.returnNew}` / `match`-merge behavior is exactly what M1/M2/M3/M6 rely on.

**`releaseDueQueueItems(now, limit)`** (`:174`, find `state:'queued', releaseAt:{$lte:now}` sorted by `TOUCH_BALANCED_QUEUE_SORT`, per-doc CAS → `state:'ready', claimUntil:null`)
- **Now:** Promotes time-released `queued` rows to `ready`.
- **Target:** KEEP unchanged.
- **Change:** none. Reaffirmed as the ONLY promoter of rescheduled rows: §4 "Published → rescheduled lands in `queued` NOT `ready`… re-promoted to `ready` only by `releaseDueQueueItems`" — a rescheduled row is not directly reservable until this runs. Its `state:'ready'` output is what `reserveReadyRows`'s `$match` then sees.
- **Serves:** §4 reschedule lifecycle (FM-8c interplay — works only because complete/reschedule now null the reservation provenance, see CxCadence edit), §6 checklist (rescheduled rows re-promoted by releaseDueQueueItems, not directly reservable).

**`listQueueItems(filters)`** (`:384`, builds query from domain/caseId/state/states/excludeIds/queueFamily/queueFamilies/assignedExtensionId/assignedOnly/metadataActionKey/createdAt/visibleExtensionId; sorts; `.lean()`)
- **Now:** General lister. Verified (`:384`–`:443`) it does NOT honor any reservationSessionId filter. Its `visibleExtensionId`/assigned-`ready` mode is the legacy "agent queue as temporary storage" reader the rails must stop using as a queue-builder source (CR1).
- **Target:** MODIFY — add one filter branch (M3).
- **Change:** Add a `metadataReservationSessionIdNotIn` branch (M3 `:1424`): when the array is non-empty, set `query['metadata.reservationSessionId'] = {$nin: filters.metadataReservationSessionIdNotIn, $ne: null}` (a reconcile target must actually carry a stale sessionId). Without it the reconciler's filter is silently dropped and it would scan EVERY claimed row. No other branch changes.
- **Serves:** §4 crash reconciler (finds dangling claimed rows whose owning session is NOT currently live), FM-11. CR1 separately requires rails to STOP using `visibleExtensionId` as a queue source — that's a caller-side change (M4), the lister itself keeps the capability.

**`markCandidateServing` / `markCandidatePublished`**
- **Now:** NEITHER EXISTS in this repository file (verified full module.exports `:481`–`:495`). No `markCandidateServing`/`markCandidatePublished` symbol present at the repo layer. (NOTE: the bulk **wiring** file `cxBulkLoadRuntime.js` DOES define `queueStateAdapter.markCandidatePublished`/`markCandidateServing` closures over `transitionQueueItemState` — those are rail-side adapters, covered in Subsystem 3, not repo functions.)
- **Target:** N/A at the repo layer. The serving-stamp the spec calls for (§3.5) is NOT a new named repo function — it is the dialer calling the existing `transitionQueueItemState(['claimed'], {state:'serving','metadata.servingAt':now,…})` in cxCadenceService / the bulk adapter (M2). "Publish" stamping (`lastRingcxPublished*`) is cleared inside `reserveReadyRows` and set by the RingCX serving service / rail adapter, not by a repo helper.
- **Change:** none — do not create these as repo functions. The closest existing repo write is `markQueueItemCompleted` (`:294`, sets `state:'completed', claimUntil:null, completedAt`), which stays as-is.
- **Serves:** §3.5 single serving-stamp is satisfied via `transitionQueueItemState`, not a new repo helper.

### File: `packages/shared-models/src/CxDialQueue.js` (mongoose model `ControlPlaneCxDialQueue`)

**`state` enum** (`:18`–`:23`, `['queued','ready','claimed','serving','completed','cancelled','paused']`, default 'queued', indexed)
- **Now:** All seven lifecycle states already present. `claimed` (reservation lease) and `serving` (dialer stamp) both exist.
- **Target:** KEEP — no enum change needed. The entire reservation lifecycle (ready→claimed→serving→completed, claimed→ready release, claimed→queued reschedule, →paused appointment) maps onto the existing enum.
- **Change:** none.
- **Serves:** §2/§3/§4 full lifecycle. Confirms no schema-level state migration is required.

**`uq_cxdialqueue_active_action` partial unique index** (`:73`–`:80`, unique on `{domain, caseId, 'metadata.actionKey'}`, partialFilterExpression `state ∈ {queued,ready,claimed,serving,paused}`, named)
- **Now:** Enforces one active row per (domain, caseId, actionKey). `claimed`/`serving` are inside the active partial set.
- **Target:** KEEP unchanged.
- **Change:** none — but it is load-bearing for §4: a reserved row leaking in `state:'claimed'` forever (the FM-8b held-for-disposition orphan, now that the reaper excludes session-held rows) would block this index. The fix is force-completing `claimed` rows via `completeCxQueueItem` (caller layer, M3) so terminal state ∉ active set → the unique slot frees. M3 verify asserts the slot frees after force-complete.
- **Serves:** §1 I2 (stable actionKey dedupe), §4 (force-complete frees the slot), FM-3, FM-8b. Index itself untouched; the surrounding completion behavior is what changes.

**`queueFamily`** (`:24`–`:29`, enum `['fresh-day1','fresh-day2to10','fresh-day16to30','aged','dead','unassigned']`, default 'fresh-day1', indexed)
- **Now:** Five §0 families plus a legacy `unassigned`. Keys are stale vs business age bands (blue=2–14d, yellow=15–29d) per §0.
- **Target:** KEEP enum (schema unchanged). Classify by numeric band via `deriveQueueFamilyFromAgeDays`, never by key label; a row whose family is off the five reservable buckets is orphaned (un-reservable). `unassigned` is NOT addressed by any `familyTargets` bucket — flagged as a latent orphan family, but no schema edit is mandated by the repo/model layer (enum validation/re-derive is enforced at the ingestion CALLER `queueCxDialRequest`, M6).
- **Change:** none to the schema. `reserveReadyRows` keys `familyTargets` strictly off `normalizeQueueFamilies(...)`; ingestion-side enum validation (M6 — `queueCxDialRequest` canonicalizing via `normalizeQueueFamily` + re-derive) keeps off-enum rows out.
- **Serves:** §0 family table, §1 I1 family validation (caller), FM-3b (unaddressed-family orphan). Schema enum retained as-is.

**`queueFamilyRank`** (`:30`, Number default 0, indexed)
- **Now:** Persisted indexed rank stamped at materialize from `getQueueFamilySortRank()`. First sort key in `TOUCH_BALANCED_QUEUE_SORT`.
- **Target:** KEEP unchanged.
- **Change:** none. Reservation orders by THIS persisted field only (FM-6 DB-authoritative). FM-6b risk (stale rank after a band crossing) is mitigated by a caller-side re-materialize/re-classify SLA, not a schema change.
- **Serves:** §2 order-fill, FM-6, FM-6b. Schema field unchanged.

**`claimUntil`** (`:42`, Date default null, indexed)
- **Now:** Lease expiry; set by `buildClaimPatch`, nulled on release/complete/requeue. The reaper matches `claimUntil:{$ne:null,$lte:now}`.
- **Target:** KEEP unchanged.
- **Change:** none to schema. NEW write sites: `reserveReadyRows` stamps it via `buildClaimPatch`; `renewClaim` re-stamps it each tick (M2). Renewal interval must be < claimMinutes (G3a).
- **Serves:** §3 lease/heartbeat. Field unchanged.

**`assignment` subdoc** (`:60`–`:65`, `{extensionId(indexed), agentName, assignedAt, queueFamilySnapshot}`)
- **Now:** Agent pin. Written by the balanced-load assigner (`cxCadenceService.js:3511`) and wiped wholesale by the reaper (`:221`, FM-7). At ingestion it is NEVER set (pool-owned, I1).
- **Target:** KEEP schema unchanged — all three subfields are exactly what reservation needs.
- **Change:** none to schema. NEW write semantics: `reserveReadyRows` stamps `assignment.extensionId/assignedAt/queueFamilySnapshot` as dotted `$set` keys at claim time (provenance pin AFTER claim); `releaseReserved` nulls the whole subdoc on claimed→ready. The reaper no longer wipes session-held assignments because §3.1 makes those rows invisible to it (FM-7 closed at the query layer, not the subdoc layer).
- **Serves:** §2 provenance pin, §3.1/FM-7, §4 release. Schema unchanged.

**`metadata` (Mixed, default {})** (`:66`) — carries the reservation provenance trio + route-lock + suppression fields
- **Now:** Free-form Mixed. Already holds `actionKey`, `servingAt`, `lastDialExecutionUii`, `lastDial*`, `lastReleased*`, etc. Does NOT yet carry reservation provenance.
- **Target:** KEEP Mixed (no schema field additions needed — Mixed absorbs the new keys).
- **Change:** none to schema. NEW keys written into metadata by the new code: `reservationSessionId`, `reservedAt`, `reservationExpiresAt` (set by `reserveReadyRows`/`renewClaim`; nulled by `releaseReserved` and by `buildClearedDialRuntimeMetadata` on complete/reschedule — caller layer M3); plus `appointmentId` (read by the new reaper $or and the reserve $match), `servingAt` (single-write stamp, §3.5), `lastRingcxPublishedAt/ExternId` (cleared on reserve), `reservationRail` (M8b rail-provenance), and the M8b route-lock quartet `rcxAccountId`/`rcxCampaignId`/`rcxDialGroupId`/`routeCampaignKey` (stamped at reserve, verified at publish). Because metadata is Mixed, no migration — but the new repo queries (`buildExpiredClaimRequeueQuery`, `reserveReadyRows`, `listQueueItems` filter, `findActiveClaimForCase`) all key off these dotted paths.
- **Serves:** §2/§3/§4 entire reservation provenance lifecycle, FM-5 (appointmentId), FM-8c (provenance nulling), M8b (reservationRail + route-lock). No schema edit required; the Mixed type is sufficient.

---

## Subsystem 2 — CX Dial Rail Cadence / Policy / Completion layer (`cxCadenceService.js`, `cxQueuePolicyService.js`, `cxQueueFairnessService.js`)

Scope: the reservation/force-completion contract (Canonical Spec §2/§4; M3, M6, M7) as it lands on the cadence + policy + fairness modules. M1 (`reserveReadyRows`/`cxQueueReservationService`) and M2 (reaper exclusion/renewal/serving-stamp) live in `cxDialQueueRepository.js` + new service files and are NOT in these three files — but several functions here are the FORCE-COMPLETE, PROVENANCE-NULL, and FAMILY-ENUM seams the spec wires into. Line refs are current as read.

### File: `packages/shared-services/src/cxCadenceService.js`

**`buildClearedDialRuntimeMetadata({ now, reason })`** (`:3684`, returns a ~90-key flat dotted-`$set` object) — **THE central M3 edit.**
- **Now:** Returns a flat map nulling every `metadata.lastDial*`, `lastHangup*`, `rcxVisibility*`, `assignmentPack*` (`:3774-3779`), `lastQueueAttemptHeldForDisposition`/`wrapUpRequired` (`:3768-3769`), and stamps `dialRuntimeClearedAt/Reason` (`:3781-3782`). It does NOT touch `reservationSessionId`, `reservedAt`, or `reservationExpiresAt` — those three keys do not exist anywhere in this file (verified by grep: zero matches). It is spread into `completeCxQueueItem` (`:4368`), `rescheduleCxQueueItem` (`:4120`), `cancelCxQueueItem` (`:4417`), AND the balanced-load assigner claim stamp (`:3526`).
- **Target:** MODIFY. Add exactly three dotted keys to the returned object: `'metadata.reservationSessionId': null`, `'metadata.reservedAt': null`, `'metadata.reservationExpiresAt': null` (plan `:1418-1420`).
- **Change:** Insert the three null keys into the returned literal (near the `assignmentPack*` block at `:3774`). No other edit. Because this object is spread by complete + reschedule + cancel + assigner, all four paths get lease-nulling for free.
- **Serves:** M3 (`:1408`); §6 checklist `:1158` ("complete AND reschedule null reservationSessionId/reservedAt/reservationExpiresAt"); FM-8c (`:1137` — a rescheduled `queued` row must not retain a lease or the M2 reaper-exclusion pins a row no session owns). NOTE the assigner-path consequence (`:1478`, OPEN item `:1993`): the assigner at `:3526` will now ALSO null the lease on every `new-assignment` claim with no dotted re-set after the spread — safe ONLY under the invariant that rails never run the balanced-load assigner against a row they reserved via `reserveReadyRows`. Document that mutual-exclusion; if it ever breaks, the assigner must re-set `reservationSessionId` as a dotted key AFTER the spread (later keys win).

**`queueCxDialRequest(payload)`** (`:1935`, async) — **THE M6 family-enum-validation edit (the actual code edit, NOT `resolveQueueFamilyForPayload`).**
- **Now:** The sanctioned cadence writer that funnels ingestion/appointment rows into `upsertQueueItem` while applying STOP/DNC eligibility gating, actionKey derivation, and family resolution. The family resolution path can let a caller-supplied off-enum value (`unassigned`) or an invalid string pass through into a pool row no `familyTargets` bucket addresses (FM-3b latent orphan).
- **Target:** MODIFY.
- **Change:** In the family-resolution path: canonicalize `payload.queueFamily` via `cxQueuePolicyService.normalizeQueueFamily` (`:436`, REUSED unchanged); when the result is `unassigned`/invalid/absent, re-derive via `resolveQueueFamilyForPayload` → `deriveQueueFamilyFromAgeDays` so every persisted row lands on one of the 5 reservable families. Keep STOP/DNC eligibility gating intact — do NOT bypass `queueCxDialRequest` to a bare `upsertQueueItem`.
- **Serves:** §6 `:1148` (every pool row's family is one of 5 and reservable, caller-supplied validated/re-derived); M6 (`:1662`); FM-3b.

**`completeCxQueueItem(options)`** (`:4352`, async) — **the FORCE-COMPLETE path; reused AS-IS.**
- **Now:** `resolveQueueItemForMutation` → `transitionQueueItemState(_id, ["queued","ready","claimed","serving","paused"], {...})` to `state:"completed"`, clears assignment, spreads `buildClearedDialRuntimeMetadata`, stamps `queueOutcome`/`disposition`/reflected-Logics fields, decrements agent open-assignments. `fromStates` already includes `'claimed'` (`:4362`); there is NO held-for-disposition gate.
- **Target:** KEEP (signature + body unchanged). It already satisfies the §4 "Published → completed (force path)" requirement once `buildClearedDialRuntimeMetadata` is patched.
- **Change:** none to this function. It gains the lease-null behavior transitively via the `buildClearedDialRuntimeMetadata` edit. New callers: the M3 reconciler (`cxReservationReconcilerService`, net-new file) calls it with `queueOutcome:"reservation-reconciled-terminal"` for `claimed` rows that have terminal evidence (plan `:1464`); AND the bulk rail's watch-release / submitDisposition / skip paths (Subsystem 3) call it as the force path for `claimed` rows that the gated `handleCxTerminalCallOutcome` would refuse.
- **Serves:** §4 force path (`:33`, `:85`, `:1478`); §6 `:1157` (released active UII ⇒ force-complete via completeCxQueueItem for `claimed` rows, held gate bypassed); FM-8b (`:1136`).

**`handleCxTerminalCallOutcome(payload)`** (`:2651`, async) — the GATED terminal writer; deliberately NOT the bulk/reserved completion path.
- **Now:** Classifies via `classifyCxTerminalOutcome`, loads the queue item, then enforces a held-for-disposition gate at `:2709-2749`: `heldForDisposition = state==='serving' || metadata.lastQueueAttemptHeldForDisposition===true || metadata.wrapUpRequired===true`. A reserved/`claimed`-but-never-served row fails this gate and early-returns `{advanced:false, reason:"not-held-for-disposition"}` (`:2740-2748`) — completing nothing. Also early-returns `not-safe-non-connect` when `!classification.safeToAdvance` (`:2691-2707`, the answered/DNC gap, below). When held, it writes counters + completes/reschedules.
- **Target:** KEEP for the legacy/slow served-call path (its `serving`-gated cadence-counter logic is still correct there). It must NOT be the completion path for reserved-published bulk rows — the spec explicitly routes those to `completeCxQueueItem` instead.
- **Change:** none required for M3 itself (the bulk rail bypasses this function). Document the `:2709` held gate as the reason bulk cannot use it (plan `:1478`). The answered/DNC fall-through (`:2691`) is a separate fix owned by the Drain/outbox layer (Review Hardening `:701`), not this milestone — but see `classifyCxTerminalOutcome` below.
- **Serves:** §4 (negative space — why the force path exists); FM-8b motivation (`:1136`).

**`classifyCxTerminalOutcome(payload)`** (`:188`) — **the answered/DNC handler-gap source.**
- **Now:** Returns `{safeToAdvance, normalizedOutcome, matchedValue}`. `answered` and `dnc` are recognized ONLY when `sourceService==='cx-bulk-load'` (`trustedManualSource`, `:190`, `:196-221`). For every other source, voicemail/no-answer return `safeToAdvance:true` (`:227-266`) but answered/DNC are not matched and fall through to the terminal `{safeToAdvance:false, normalizedOutcome:null}` (`:269`). Downstream (`handleCxTerminalCallOutcome :2691`) that becomes `lastTerminalOutcomeIgnoredReason:'not-safe-non-connect'` → silently dropped (no Logics contact-stop, no answered counter). This is the compliance landmine in Review Hardening `:701-705`.
- **Target:** MODIFY (drain-layer milestone, not M3). The plan's authoritative fix lives in the Drain/Outbox layer: explicit `answered` + `dnc` drain handlers, and unknown outcomes treated fail-loud rather than write-ignored-and-return-ok (`:430`, `:701-705`, Drain `:313`/`:328`). Within this function the minimal change is to classify `answered`/`dnc` from any trusted terminal source (not just `cx-bulk-load`) OR to surface a distinct `unknown` bucket the drain can fail loudly on, rather than collapsing into `safeToAdvance:false`.
- **Change:** broaden answered/DNC recognition beyond `trustedManualSource`, or emit a non-`null` `normalizedOutcome` for unknown so callers don't silently ignore. Exact wiring is owned by the Drain milestone; flagged here as the classify-time root.
- **Serves:** Review Hardening compliance fix (`:701`); Outcome Mapping (`:247-256`); DNC-first drain priority (`:313`).

**`rescheduleCxQueueItem(options)`** (`:4089`, async) — second consumer of the provenance-null edit.
- **Now:** `transitionQueueItemState(_id, [open states], { state:"queued", releaseAt, claimUntil:null, assignment:buildClearedAssignment(), ...buildClearedDialRuntimeMetadata({...}), lastReleased* metadata })` (`:4110-4131`), optional background RingCX cancel, decrements open-assignments. Lands the row in `queued`+`releaseAt`. Today it does NOT null reservation lease keys (they don't exist).
- **Target:** KEEP signature/body; gains lease-nulling transitively from the `buildClearedDialRuntimeMetadata` edit.
- **Change:** none directly. After M3, a rescheduled row lands `queued` with `reservationSessionId:null` → not reaper-pinned, re-promoted only by `releaseDueQueueItems` (not directly reservable). This is precisely FM-8c (`:1137`, `:1416-1417`).
- **Serves:** §6 `:1158`; FM-8c.

**`handleCxCallPlaced(payload)`** (`:2203`, async) — **bulk placement accounting (pre-live placement parity).**
- **Now:** The existing single placement writer. Increments `placedCalls`/`dailyPlacedCalls`/`monthlyPlacedCalls`/`hourlyPlacedCalls` via `buildCallAttemptPatch` (`:2239`), writes the `contacts_sent` metric event (`:2588-2596`), upserts CallLog with `platform:'cx'` + ringcx stamp + source attribution (`:2360-2387`), and marks the queue item `serving`/held (`:2477`) vs completes (`:2509`) vs reschedules (`:2534`). Held-for-disposition decided at `:2464-2475` (`holdUntilDisposition` when `serving` || `confirmedClaimedCxCall` || explicit hold). Idempotency guard: `payload.alreadyHandled===true` early-returns (`:2204`). It keys placement off `queueItemId`.
- **Target:** KEEP as the canonical placement writer; the bulk rail must route through THIS (or a bulk-safe wrapper) instead of inventing counters (Existing Mongo Writer Compatibility `:406-430`; Review Hardening `:707`). Today bulk marks candidates `serving` but does NOT count placement through here, so `placedCalls`/`contacts_sent` under-count exactly when bulk goes live (`:710`, `:428`).
- **Change:** no edit to the function body required for M3; the wiring change is on the BULK rail side (call `handleCxCallPlaced` on publish, idempotent per `queueItemId:uii`). Confirm the `claimed`-state branch behaves for reserved-published rows: a reserved row is `claimed` (not `serving`), so `confirmedClaimedCxCall` (`:2461`) fires `holdUntilDisposition` and writes `state:"serving"` (`:2479`) — which is the bulk "placed" accounting. Verify that does not collide with the force-complete path (reserved row completes via `completeCxQueueItem`, not the held gate). Idempotency key stays on `queueItemId` (do NOT fold `uii` into the complete-once identity — Review Hardening `:723`).
- **Serves:** Existing Mongo Writer Compatibility (`:412-417`, `:428`); Review Hardening "Also before live" (`:707-710`).

**`resolveQueueFamilyForPayload(payload)`** (`:444`) — **the REUSED re-derive fallback for M6 (NOT the edited function).**
- **Now:** Resolves a queueFamily from explicit `queueFamily`/`metadata.queueFamily`/`family` (`:445-450`), else from `leadCreatedAt` via `deriveQueueFamilyFromLeadCreatedAt`, else `leadAgeDays` via `deriveQueueFamilyFromLeadTouchState` || `deriveQueueFamilyFromAgeDays` (`:471-483`), else queueTier/activeDay/source heuristics. Final fallback `fresh-day1`. Returns one of the 5 enumerated families (or `dead`).
- **Target:** KEEP — REUSED unchanged. The M6 enum-validation EDIT lives in `queueCxDialRequest` (`:1935`); this function is the re-derive helper that path calls when `normalizeQueueFamily` yields `unassigned`/invalid. Its `fresh-day1` fallback already prevents `unassigned` leaking into a reservable bucket.
- **Change:** none. (Earlier drafts incorrectly named this as the M6 edit site; the edit is in `queueCxDialRequest`, this is the reused fallback.)
- **Serves:** §6 `:1148`; M6 ingestion conformance (re-derive arm).

### File: `packages/shared-services/src/cxQueuePolicyService.js`

**`normalizeQueueFamily(value)`** (`:436`) — **the M6 canonicalizer (REUSED unchanged).**
- **Now:** Exported helper that maps an input value onto the canonical queueFamily enum (or `unassigned`/null for off-enum input).
- **Target:** KEEP — REUSED unchanged by M6. `queueCxDialRequest` calls it to canonicalize `payload.queueFamily` before deciding whether to re-derive.
- **Change:** none.
- **Serves:** §6 `:1148`; M6 canonicalize arm.

**`getQueueFamilyTargetOpen(policy, queueFamily)`** (`:414`) — **the policy depth source M7 consumes for `familyTargets`.**
- **Now:** Resolves the account policy (or treats an already-resolved policy as-is via `isResolvedQueuePolicy`), returns `0` when `!resolved.enabled` or when fresh and `!fresh.eligible` (`:418-420`), else the family bucket's `targetOpen` clamped ≥0 (`:421-422`). Account-aware, exported (`:1563`).
- **Target:** KEEP unchanged. M7's net-new `cxReserveModeService.buildFamilyTargets` imports it (`:1717`) and calls `getQueueFamilyTargetOpen(policy, fam)` per family to build the `mix`-mode targets (`:1734-1737`). targetOpen is DEPTH not throughput (plan `:1748`).
- **Change:** none. It is the canonical getter; do NOT inline depth values.
- **Serves:** §2 policy-driven ordering (`:1058-1060`); M7 (`:1717`, `:1728`); §6 `:1154`.

**`resolveAccountQueuePolicy(account)`** (`:312`) — policy resolver feeding the family targets.
- **Now:** Reads `account.cxQueuePolicy` (Mixed), returns a no-leads policy when disabled/no manual policy, else resolves per-family `targetOpen` (fresh/day2to15/day16to30/aged), `routeCampaigns`, `aged.fillRemainder` (`:386-392`), `totalOpen` default `RC_CX_TOTAL_OPEN_DEFAULT`=25 (`:333`).
- **Target:** KEEP unchanged. Upstream of `getQueueFamilyTargetOpen`; the policy object it returns is what M7 passes in.
- **Change:** none. `aged.fillRemainder` (`:388`) is the field §2 references for red absorbing leftover deficit (`:1060`).
- **Serves:** §2 (`:1058`); M7 input.

**`deriveQueueFamilyFromAgeDays(ageDays)`** (`:1530`) — the numeric-band family classifier; the §0 source of truth for bands.
- **Now:** `≤1→fresh-day1`, `≤14→fresh-day2to10`, `≤29→fresh-day16to30`, `≤120→aged`, else `dead`; non-finite → `fresh-day1` (`:1531-1537`). This is the ACTUAL band logic (blue 2-14d, yellow 15-29d) the spec insists on over the stale key labels (`:27`, `:453`).
- **Target:** KEEP unchanged. It is already the canonical numeric classifier the Canonical Spec endorses (classify by band, never the `fresh-day2to10`/`fresh-day16to30` key label). M6's `queueCxDialRequest` re-derive arm calls it.
- **Change:** none. Confirm (OPEN item `:1997`) there is no `fresh-day11to15` bucket — verified: the enum is exactly fresh-day1 / fresh-day2to10 / fresh-day16to30 / aged / dead (`QUEUE_FAMILY_SORT_RANKS :94-101`), so the spec's `day2to15` shorthand maps to the existing `fresh-day2to10` key and `buildFamilyTargets` keys will match.
- **Serves:** §0 family bands; M6 re-derive; M7 key-name conformance (`:1997`).

**queueFamily enum / `QUEUE_FAMILY_SORT_RANKS` / `QUEUE_FAMILY_POLICIES` / `getQueueFamilySortRank` / `getQueueFamilyPolicy`** (`:94`, `:103`, `:440`, `:445`)
- **Now:** Frozen enum of 5 families + `unassigned`; ranks green0/blue1/yellow2/aged3/dead4/unassigned5 (`:94-101`); per-family `claimMinutes`/`cooldownMinutes`/`dailyMax` policies (`:103-148`); `getQueueFamilyPolicy` overlays env cooldown/dailyMax.
- **Target:** KEEP. The enum is the 5-family set §6 `:1148` validates against; `getQueueFamilyPolicy().claimMinutes` is the per-family claim length the reservation lease and assigner use (assigner reads it at `cxCadenceService.js:3498`).
- **Change:** none. M1/M2 require `claimMinutes` be passed EXPLICITLY (never default-5, §6 `:1151`); these policies are the source the caller reads it from.
- **Serves:** §6 `:1148`/`:1151`; M2 renewal lease length.

### File: `packages/shared-services/src/cxQueueFairnessService.js`

**`getCxQueueServeRank(item, options)`** (`:191`) — the in-family/cross-family serve-order ranker.
- **Now:** Returns a numeric rank: SMS-hot −0.5, fresh-first-contact 0, green parity 0.5/1, blue 1, yellow 2, aged 3, dead 999, minus an aging boost (`:196-213`). Used to order candidates within the shared pool.
- **Target:** KEEP unchanged. The reservation layer reserves by FAMILY targets (M1 reserves per-family using `TOUCH_BALANCED_QUEUE_SORT` in the repo, `:1211`), and this serve-rank governs intra-pool ordering at serve time. No reservation contract depends on changing it.
- **Change:** none. Confirm the rail's reserve order (rank order green→blue→yellow→red, plan `:1197`) is consistent with this ranker's family ordering — it is (green<blue<yellow<aged).
- **Serves:** §2 ordering consistency; fairness (unchanged).

### Net summary of edits owned by THIS layer
- TWO concrete code edits: (1) add 3 null keys to `buildClearedDialRuntimeMetadata` (`:3684`) — the M3 footprint inside `cxCadenceService.js`, transitively giving `completeCxQueueItem`, `rescheduleCxQueueItem`, `cancelCxQueueItem`, and the balanced-load assigner their lease-nulling; (2) the M6 family canonicalize/re-derive inside `queueCxDialRequest` (`:1935`) via `normalizeQueueFamily` + `resolveQueueFamilyForPayload`/`deriveQueueFamilyFromAgeDays`.
- `completeCxQueueItem` is reused unchanged as the force-complete path (held gate bypassed because it never had one).
- `handleCxTerminalCallOutcome`'s `:2709` held gate and `classifyCxTerminalOutcome`'s `:190`/`:269` answered-DNC fall-through are the documented REASONS the bulk path bypasses the gated writer (force path + drain handlers); the answered/DNC fix itself is a Drain-layer milestone, not M3.
- `handleCxCallPlaced` is unchanged but must be the bulk placement writer (wiring lives on the rail side).
- `resolveQueueFamilyForPayload` + `normalizeQueueFamily` are REUSED unchanged by M6; `getQueueFamilyTargetOpen` + the policy resolvers + `deriveQueueFamilyFromAgeDays` are consumed unchanged by the net-new M7 `cxReserveModeService.buildFamilyTargets`.

---

## Subsystem 3 — Three Rails + Active-Call Watcher + Bulk State Machine (reservation rewire, M1–M8)

Scope note on file identity: there are TWO distinct bulk runtime files. **`cxBulkLoadRuntime.js`** (the spec's pre-canonical name; 17,586 bytes) is the **DI/wiring entry** the routes call (`getService` builds adapters + injects `listReadyQueueItems`). **`cxBulkLoadRuntimeService.js`** (16,977 bytes) is the **pure-injectable orchestrator** (`fillBuffer`/`watchCxBulkLoadSession`/`maybeRefill`/`submit…`). The list-path→`reserveFromFamilyOrder` change touches BOTH: the wiring file must inject the reservation service (M4 "thread the service"); the orchestrator's `fillBuffer` must consume it. **NON-NEGOTIABLE: M2 (reaper exclusion) deploys strictly before M4 (this rewire).**

### File: `packages/shared-services/src/cxBulkLoadRuntime.js` (wiring/entry — M4 "thread the service")

**`getService` (`:169`)**
- **Now:** Lazily constructs the singleton orchestrator via `createCxBulkLoadRuntimeService({...})`. Injects `leadSource`, `publisher`, `watcher`, `outcomeAdapter`, `terminalExecutor`, `queueStateAdapter`, `offhookGate`, `client`, `listReadyQueueItems`, `reduce`, `newSessionId`.
- **Target:** MODIFY.
- **Change:** Add a `reservationService` dep = a shared `createCxQueueReservationService({ cxDialQueueRepository, queueItemRepository, resolveQueueDialability })` instance (the SAME instance slow-lane/M5 interlock use; `queueItemRepository` is injected so the M5 claim-time `assertNotActiveInUcq` guard has `existsForLead`). Pass `familyTargets`/`claimMinutes` provenance through `startCxBulkLoadSession` (familyTargets built by M7 `buildFamilyTargets`). The injected `listReadyQueueItems` becomes vestigial for sourcing (still allowed for diagnostics) — it is no longer the buffer-fill source.
- **Serves:** §2 reservation contract; CR1 ("no rail builds membership from `listQueueItems`+assignment visibility"); M4 (b)/(d) "threading the service is a hard prerequisite — none of the rails has `reservationService` in scope today."

**`listReadyQueueItems` (injected closure, `:324`)**
- **Now:** `cxDialQueueRepository.listQueueItems({ states:['ready'], visibleExtensionId, includeUnassignedVisible, sort, limit })` — the assignment-visibility read that IS the "agent queue as temporary storage" bug (Mickey test): a read-only list of `ready` rows already touchable by the queue balancer between read and publish.
- **Target:** REPLACE (as the fill source).
- **Change:** Remove from the buffer-fill path. Source becomes `reservationService.reserveFromFamilyOrder({domain, agentExtensionId, sessionId, familyTargets, totalLimit:deficit, claimMinutes, metadata:{rail:'bulk_load'}})` which returns rows already atomically `ready→claimed` AND already cleared of UCQ-active siblings / DNC-suppressed rows (M5/M8b guards run inside reserve). Keep `listQueueItems` only for non-sourcing diagnostics, never as a queue builder.
- **Serves:** §2 single-atomic-bulk-claim; "Rail Fill Source Contract" (stop using the agent queue as storage); CR1/CR2; FM-10.

**`queueStateAdapter.markCandidatePublished` (`:192`)**
- **Now:** `transitionQueueItemState(queueItemId, ['ready','claimed','serving','paused'], { state:'claimed', 'metadata.bulkLoadSessionId':…, 'metadata.bulkLoadPublishedAt':…, lastRingcxPublished*… })`. Uses PRE-CANONICAL `bulkLoad*` metadata keys; re-claims a row already claimed by reserve.
- **Target:** MODIFY (KEEP shape, rename provenance).
- **Change:** Row is ALREADY `claimed` by `reserveReadyRows`, so this becomes a publish-stamp only (no `ready→claimed`). Replace `metadata.bulkLoad*` with canonical `metadata.reservationSessionId`/`reservedAt`/`reservationExpiresAt` (set by reserve) + publish provenance (`lastRingcxPublishedExternId`). Do NOT clear `claimUntil` to null (renewal owns the lease now, §3.2). Add `metadata.reservationRail='bulk_load'` (M8b §3). M8b: before stamping published, verify the row's route-lock quartet (`rcxAccountId`/`rcxCampaignId`/`rcxDialGroupId`/`routeCampaignKey`) still matches the publish target — release `'route-changed-before-publish'` on mismatch (publish-path enforcement lives in `ringcxLeadServingService`, Subsystem 4; the adapter passes the locked values through).
- **Serves:** §2 reservation fields ("Never `bulkLoad*`"); M8b rail-provenance + route-lock.

**`queueStateAdapter.markCandidateServing` (`:216`)**
- **Now:** `transitionQueueItemState(..., ['ready','claimed','serving','paused'], { state:'serving', 'metadata.servingAt':now, 'metadata.lastDialExecutionUii':uii, lastQueueAttemptHeldForDisposition:true, … })`.
- **Target:** MODIFY.
- **Change:** Narrow `fromStates` to `['claimed']` and set `state:'serving'` + `metadata.servingAt` in the SAME `$set` (it already does), reading `reservationSessionId = item?.metadata?.reservationSessionId` OFF the row and guarding with `{ match:{ 'metadata.reservationSessionId': sessionId } }` + `returnNew:true`; treat `null` return as a race (no-op, don't proceed) mirroring the assigner pattern at `cxCadenceService.js:3535`. This is the §3.5 single-atomic serving-stamp.
- **Serves:** §3.5 single serving-stamp; M2 (e) "null return = race."

**`terminalExecutor` closure (`:250`)**
- **Now:** Sends `client.dispositionCall(uii, {disposition})` mapped via `bulkOutcomeDisposition`. No hangup. Heavy `[DISPTRACE]` logging.
- **Target:** KEEP (behavior); MODIFY (logging).
- **Change:** Unchanged dial model (RingCX disposition advances the dialer). Per Button Policy: this is the connected voicemail-box-full EFFECT only; ring-no-answer auto-advances with no executor call. Strip `[DISPTRACE]` noise to audit-friendly non-PII logs (M8b §5: no full phone). No functional change to dispositioning.
- **Serves:** Button Policy ("Who ends each call"); M8b §5 logging.

**`bulkOutcomeDisposition` (`:53`)**
- **Now:** Maps `voicemail→VM DROP`, `dnc→DNC`, default→`Auto Dispo`.
- **Target:** KEEP. **Change:** none.
- **Serves:** Existing RingCX disposition contract.

**`makeInProcessMarkOnce` (`:115`) + its wiring into `createCxBulkLoadOutcomeAdapter({markOnce})` (`:173`)**
- **Now:** In-process `Set` dedupe passed as `markOnce` to the outcome adapter; the cadence write swallows errors (`…catch(()=>null)` at `:188`).
- **Target:** REPLACE.
- **Change:** Replace the in-process `Set` with the durable unique-keyed outbox insert as the idempotency claim (`appendTerminalOutbox`, unique `{key:1}`); stop swallowing the write error (fail closed). This is the "Idempotent Write (replaces the in-process Set)" review item. The `…catch(()=>null)` on `recordCadenceEvent` must go.
- **Serves:** Terminal Outbox "Idempotent Write"; Review Hardening orphan #2 (durable write-ahead).

**Route entries + thin wrappers — `startCxBulkLoadSession`/`watchCxBulkLoadSession`/`submitCxBulkLoadDisposition`/`skipCxBulkLoadCurrent`/`killCxBulkLoadSession`/`getCxBulkLoadSession` (`:358–429`) + `resolveAgentContext` (`:125`), `assertBulkRuntime` (`:156`), `resolveSessionId` (`:347`), `findOwnedBulkLoadSession` (`:98`), `bulkSessionBelongsToAgent` (`:87`), `isBulkLoginOffhook` (`:67`), `makeHttpError` (`:80`), normalize\* (`:37–48`)**
- **Now:** Thin auth/gate/delegation wrappers; default-off runtime gate.
- **Target:** KEEP (thin). **Change:** none beyond passing the new `familyTargets`/`claimMinutes` provenance down through `startCxBulkLoadSession`'s service call. Routes stay thin per "Route and API layer expectations."
- **Serves:** Final Rail Shape #3; "keep routing thin."

### File: `packages/shared-services/src/cxBulkLoadRuntimeService.js` (orchestrator)

**`fillBuffer` (`:120`)** — the central change.
- **Now:** offhook-gate → `bufferDeficit` → `leadSource.snapshotCandidates({listReadyQueueItems}, {maxItems:deficit})` (read-only list of assignment-visible `ready` rows) → `publisher.publishBatchToRingcx(client, {candidates:drafts})` as ONE batch → loop `pub.accepted`/`pub.rejected` into reducer events. No claim before publish; no release on reject; rejects only logged via `buffer.publish_failed` without freeing the row.
- **Target:** REPLACE the source + publish loop.
- **Change:** (1) Keep offhook gate + `bufferDeficit`. (2) Replace `leadSource.snapshotCandidates` with `reservationService.reserveFromFamilyOrder({domain, agentExtensionId, sessionId:state.sessionId, familyTargets:state.familyTargets, totalLimit:deficit, claimMinutes:state.claimMinutes, metadata:{rail:'bulk_load'}})` → `{reserved}` already `claimed` (and UCQ-clean / DNC-clean per the in-reserve M5/M8b guards). (3) `if(!reserved.length) return state`. (4) PUBLISH ONE AT A TIME in family order (loop over `reserved`, single-candidate `publishBatchToRingcx` per row). (5) On accept: `markCandidatePublished` + `reduce(…,'buffer.publish_accepted',…,now())`. (6) On reject: **buffer-drop FIRST** via `reduce(…,'buffer.publish_failed',{candidate:{queueItemId:row._id},reason},now())` (the EXISTING reducer reject event — do NOT invent `publish_rejected`), THEN `reservationService.releaseReserved([row], 'bulk-publish-rejected:'+reason)`. Order matters: drop-before-release closes the renew-vs-release TOCTOU.
- **Serves:** §2 "Rail load sizes — Bulk: reserve a batch, publish one at a time, append accepted"; §4 "releaseReserved MUST remove the row from buffer BEFORE the claimed→ready write"; FM-8/FM-10; M4 (c)/(d).

**`maybeRefill` (`:172`)**
- **Now:** `if status!=='running' return`; `if liveSlots > refillThreshold return`; emit `buffer.refill_started`; `fillBuffer`.
- **Target:** KEEP (logic); inherits `fillBuffer` rewrite.
- **Change:** Reconcile sizing: `DEFAULT_TARGET_BUFFER=30` (`:14`) → **35** (15/10/5/5); threshold stays 5; refill batch ~30 (the deficit toward 35). 30 is the refill amount, never the target. `targetBufferFor`/`refillThresholdFor` (`:111/:114`) read from `stats.targetSize`/`refillThreshold` — keep, default target → 35.
- **Serves:** §2 "TARGET=35, REFILL BATCH ~30, THRESHOLD ≤5"; "Bulk buffer sizing."

**`watchCxBulkLoadSession` (`:231`)** — gap-tolerant release.
- **Now:** Single snapshot per tick. `matchActiveCallToCandidates` → if matched, refresh/switch `current`; on switch, `completePrevious` via `outcomeAdapter.persistTerminalOutcome(... 'auto-advance')`; refill. **Bug:** completes ONLY the app-memory `current`; a lead RingCX dials+releases between two polls is never promoted to `current` → no outbox row → stays `claimed` → re-dialable, outcome lost (mid-tick orphan).
- **Target:** REPLACE the tick body with the thin 8-step set.
- **Change:** Insert the prior-active-set diff: (1) `prevActive = state.activeExternIds`. (2) `active = watcher.loadActiveCallsSnapshot`. (3) `{released, nextActiveExternIds} = watcher.deriveReleasedCandidates({prevActiveExternIds:prevActive, activeCalls:active, pool:candidatePool(state)})` (NEW watcher fn). (4) for each `released` → `appendTerminalOutbox` row (`source:'poller_release'`, no intent → `did_not_connect`) → remove from `acceptedBuffer` → **force-complete via `completeCxQueueItem`** (the row is `claimed`/un-`serving`, so the gated `handleCxTerminalCallOutcome` returns `advanced:false` — must bypass) → null reservation provenance. (5) `match = matchCurrent`. (6) `transitionCurrent`. (7) `ensureBuffer`/`maybeRefill`. (8) persist `state.activeExternIds = nextActiveExternIds`. Keep the offhook short-circuit + the no-op-write guard. Replace the synthetic `'cx-auto-advanced'`/`'auto-advance'` outcome with explicit terminal events.
- **Serves:** Live Loop Rules "#1 orphan fix" / `deriveReleasedCandidates`; §4 "Mid-tick orphan reconciliation" + "Published→completed force path"; Minimal-Viable "Bulk path only" 8-step; Production Standard #3.

**`submitCxBulkLoadDisposition` (`:307`)**
- **Now:** loadState → `terminal.started` → `terminalExecutor` (RingCX disposition) → `persistTerminalOutcome` → `terminal.accepted` → `maybeRefill` → persist. Outbox write happens AFTER the disposition (not write-ahead). Heavy `[DISPTRACE]`.
- **Target:** MODIFY (ordering + write-ahead).
- **Change:** Reorder to write-ahead: write the durable outbox INTENT row (button intent, esp. `dnc`) BEFORE `terminalExecutor`/`dispositionCall`, so a crash/lost RingCX response can't strand an advanced call with no recorded outcome. For a reserved/`claimed` row, completion goes through the force path (`completeCxQueueItem`), not the held-gated handler. Strip `[DISPTRACE]`.
- **Serves:** Button Policy "Ordering (orphan-safe)"; Review Hardening orphan #2; §4 force path.

**`skipCxBulkLoadCurrent` (`:371`)**
- **Now:** `persistTerminalOutcome(outcome:'skipped')` → `terminal.accepted` → refill.
- **Target:** KEEP; **Change:** route its terminal write through the same outbox + force-complete path as disposition (one outbox call site). No phone/no synthetic outcome.
- **Serves:** "Confirm every terminal writes exactly one outbox row and clears current."

**`startCxBulkLoadSession` (`:190`)**
- **Now:** kill prior → create session (`stats.targetSize=30`) → `session.started` → offhook → `buffer.preload_started` → `fillBuffer`.
- **Target:** MODIFY.
- **Change:** `targetSize` default → 35; generate `sessionId` as a fresh UUID (already `cxbl-${randomUUID()}` — confirm never reused); stamp `familyTargets` (from M7 `buildFamilyTargets({policy, totalDeficit, env})`) + `claimMinutes` (≥ renewalInterval·2, G3a) onto the session for `fillBuffer`. Preload now reserves.
- **Serves:** §4 "fresh UUID per process start, never reused"; §2 sizing/policy; G3a.

**`killCxBulkLoadSession` (`:388`)**
- **Now:** best-effort `cancelBatchForSession` over `acceptedBuffer` → `session.killed`.
- **Target:** MODIFY.
- **Change:** Before kill, `releaseReserved` all still-buffered un-dialed rows back to their source family (buffer-drop before the `claimed→ready` write) so reserved-never-published rows don't leak (`claimed` forever now that the reaper excludes session-held rows).
- **Serves:** §4 "Reserved-but-never-published → release"; FM-8.

**Pure helpers `liveSlots`/`bufferDeficit`/`candidatePool`/`persistableState`/`sanitizeCandidateForClient`/`sanitizeSession`/`serializeError` (`:19–86`)**
- **Now:** Buffer math + persistence projection; `persistableState` doesn't carry `activeExternIds`.
- **Target:** KEEP, with one add. **Change:** add `activeExternIds` to `persistableState` (`:39`) so the prior-active set survives across ticks (the diff is useless if not persisted). `candidatePool` (`:31`) already returns buffer+current — reuse it as `deriveReleasedCandidates`' `pool`. Deficit formula `target − (acceptedBuffer.length + current?1:0)` matches §2 — keep.
- **Serves:** Live Loop Rules "Persist `nextActiveExternIds` on the session each tick"; §2 deficit formula.

**`createCxBulkLoadRuntimeService` deps destructure (`:90`) + dep-presence loop (`:107`)**
- **Now:** Requires `repo,leadSource,publisher,watcher,outcomeAdapter,offhookGate,client,listReadyQueueItems,reduce`.
- **Target:** MODIFY.
- **Change:** Add `reservationService` to the destructure and the required-deps loop; `listReadyQueueItems`/`leadSource` demoted from required-source to optional/diagnostic.
- **Serves:** M4 "thread the service."

### File: `packages/shared-services/src/cxBulkLoadActiveCallWatcher.js`

**`matchActiveCallToCandidates` (`:58`)**
- **Now:** externId-first, then queueItemId; explicitly NO phone fallback; ambiguity guard on multiple distinct candidate matches.
- **Target:** KEEP. **Change:** none — already strict externId→queueItemId with no weak fallback.
- **Serves:** "What To Avoid" (no phone-only matching); Simplification Audit #4; Production Standard #1/#2.

**`deriveCurrentTransition` (`:97`)**
- **Now:** Returns `none`/`same`/`switch`; on switch-away sets `completePrevious:true, previousOutcome:'cx-auto-advanced'` — a SYNTHETIC invented label.
- **Target:** MODIFY.
- **Change:** Remove the synthetic `'cx-auto-advanced'`; emit an explicit terminal-release signal and let the released row be bucketed `did_not_connect` by the drain/outcome mapping (no-intent release → `did_not_connect`). Auto-advance must not invent a business outcome inside the live loop.
- **Serves:** Simplification Audit #3 ("Collapse synthetic auto-advance outcomes"); Minimal-Viable #4 ("no synthetic auto_advance"); Drain "released-with-no-intent → did_not_connect."

**`deriveReleasedCandidates` — NEW (does NOT exist today; spec body at plan §"Live Loop Rules")**
- **Now:** absent — confirmed not in the file (exports are only `MATCH_ORDER, normalizeActiveCall, matchActiveCallToCandidates, deriveCurrentTransition, loadActiveCallsSnapshot`).
- **Target:** NEW (pure).
- **Change:** Add `deriveReleasedCandidates({prevActiveExternIds=[], activeCalls=[], pool=[]})` → `{released, nextActiveExternIds}`: build `nowActive` set from `activeCalls.externId`, index `pool` by externId, return any prevActive externId absent from nowActive whose candidate is in pool (released between polls), plus `nextActiveExternIds=Array.from(nowActive)`. Pure, no I/O. Wire into `watchCxBulkLoadSession` step 3.
- **Serves:** Live Loop Rules "#1 orphan fix"; Minimal-Viable shared primitive `deriveReleaseCandidates`; §4 mid-tick reconciliation; FM-8b.

**`normalizeActiveCall` (`:33`), `extractActiveCallList` (`:44`), `candidateExternId` (`:22`), `candidateQueueItemId` (`:27`), `loadActiveCallsSnapshot` (`:124`), `MATCH_ORDER` (`:15`), `str` (`:17`)**
- **Now:** Normalization + thin RingCX read.
- **Target:** KEEP (reused by `deriveReleasedCandidates`). **Change:** none.
- **Serves:** Watcher purity invariant.

### File: `packages/shared-services/src/cxBulkLoadStateMachine.js`

**`reduceCxBulkLoadState` (`:62`)** — the pure reducer.
- **Now:** Handles `session.started`, `buffer.preload_started/refill_started/publish_accepted/publish_failed`, `agent.waiting_offhook/offhook_ready`, `current.matched` (with `completePrevious`/`previousOutcome` default `'auto_advanced'` at `:186`), `terminal.started/accepted/failed`, `current.cleared`, `session.completed/killed`, `failed`. `acceptedBuffer` mutated monotonically via `upsertByQueueItemId`/`removeByQueueItemId`.
- **Target:** MODIFY (trim synthetic outcome; add release accounting).
- **Change:** (1) `current.matched` (`:171`): drop the invented `'auto_advanced'`/`previousOutcome` default — completion of the departing current is now driven by an explicit terminal/release event from the watcher diff, not a string the reducer invents. (2) Add a `buffer.released`/release handling so a `deriveReleasedCandidates` hit removes the released row from `acceptedBuffer` (reuse `removeByQueueItemId`) and pushes a `completed` entry without a synthetic outcome. (3) `buffer.publish_failed` (`:159`) stays the reject event `fillBuffer` reuses (do NOT add `publish_rejected`). Keep transition graph minimal: running→current (`current.matched`), current→terminal (`terminal.accepted`), terminal/failed handled by drain.
- **Serves:** Simplification Audit #3; Minimal-Viable #4 ("active→terminal, no synthetic auto_advance"); "keep one transition function: `fromActive` and `toTerminal`."

**Helpers `clonePlain`/`arrayOf`/`queueItemKey`/`upsertByQueueItemId`/`removeByQueueItemId`/`pushCompletedOnce` (`:16–60`), `CX_BULK_LOAD_PHASES` (`:3`)**
- **Now:** Monotonic buffer + completed-set helpers, keyed on `queueItemId`.
- **Target:** KEEP. **Change:** none — `removeByQueueItemId`/`pushCompletedOnce` are exactly what the new release path needs. Idempotency key stays `queueItemId` (Review Hardening "do NOT add uii into identity — weakens complete-once").
- **Serves:** "Confirm every buffer change is monotonic"; Review Hardening idempotency note.

### File: `packages/shared-services/src/cxSlowLaneService.js`

**`selectNextQueueItem` (`:605`)**
- **Now:** If `input.queueItemId` → `findQueueItemById`. Else `claimNextCxQueueItem({domain, extensionId, candidateExtensionIds, claimMinutes, maxClaimAttempts, ignoreActivityState, skipOrderingBackfill,…})` (which runs dialability filtering + completes/requeues policy-held rows in its retry loop). Throws 409 on no-claim.
- **Target:** REPLACE the non-explicit branch.
- **Change:** Route the non-`queueItemId` branch through `reservationService.reserveFromFamilyOrder({domain, agentExtensionId, sessionId, familyTargets, totalLimit:1, claimMinutes:input.claimMinutes||10, metadata:{rail:'slow'}})` → `{reserved, missing}`. CRITICAL: `reserveReadyRows` only filters `state:'ready'` + appointment exclusion, NOT dialability — so re-apply `resolveQueueDialability(row)` as a POST-FILTER and `releaseReserved` any non-dialable reserved row (fail closed) to preserve the hold behavior `claimNextCxQueueItem` gave for free. If nothing dialable → `makeHttpError('No CX queue item available (no-ready-queue-item)',409,'no-ready-queue-item')` with `err.details={missing}`. Keep the explicit-`queueItemId` branch unchanged.
- **Serves:** §2 "Slow single: reserve one, publish one (`totalLimit:1`)"; M4 (c)/(d)/(e) "slow lane re-applies `resolveQueueDialability` + releases non-dialable"; CR1/CR2.

**`publishCurrent` (`:628`), `executeTerminalDispositionWithRetry` (`:647`), `startCxSlowSingleCall` (`:678`)**
- **Now:** publish/confirm/terminal orchestration; `startCxSlowSingleCall` enforces "release current before next lead."
- **Target:** KEEP.
- **Change:** none ("Keep publish/confirm/terminal orchestration unchanged" / "Remove pre-publish branching that reselects assignment paths for the next row" — but that branching lives in `selectNextQueueItem`, already covered). One confirm/poll decision path retained.
- **Serves:** Final Rail Shape #2 ("boring safe fallback"); Simplification Audit #5; "single confirm timeout path."

**Module-scope wiring note**
- **Now:** `cxSlowLaneService.js` is NOT a factory; `selectNextQueueItem` is a module-level function importing `claimNextCxQueueItem` directly.
- **Target:** MODIFY (wiring).
- **Change:** Either convert to a factory closing over an injected `reservationService`, or `require("./cxQueueReservationService")` + shared repos at module scope and build a module singleton — using the SAME instance M5's interlock uses.
- **Serves:** M4 (b) threading note.

### File: `packages/shared-services/src/cxSimpleCallLoopService.js`

**`scoreBulkActiveCandidate` (`:178`)**
- **Now:** Scores externId +100, queueItemId +60, **phone +45** (`:187`), caseId +5. The phone tier is the BANNED phone-weighted matcher.
- **Target:** MODIFY (strip phone tier).
- **Change:** DELETE `if (phone && activeCallContainsText(call, phone)) score += 45;`. With the +45 gone the only passing scores are externId(100)/queueItemId(60); the `>=45` floor and the tie-break null still hold.
- **Serves:** Review Hardening "banned phone-weighted matcher (`scoreBulkActiveCandidate`, phone=+45) — collapse/delete"; Simplification Audit #2 ("no phone fallback"); "What To Avoid"; M4 (c).

**`findBulkCandidateForActiveCall` (`:192`)**
- **Now:** Filters `score >= 45`, sorts desc, returns top unless tie with #2.
- **Target:** KEEP (floor unchanged).
- **Change:** none structurally — with phone +45 removed, only externId/queueItemId scores pass the `>=45` floor, so it becomes strict-identity by construction. (Whole `bulk-mirror` matcher path is slated for deletion below; if `bulk-mirror` is fully collapsed, this fn goes with it.)
- **Serves:** strict-match invariant.

**`advanceCxSimpleLoopSession` (`:1346`) — the `bulk-mirror` branch (`:1352`)**
- **Now:** `if (session.mode === 'bulk-mirror') { replenishBulkQueue; mirrorBulkQueue; captureBulkCurrent } else advanceSingleSession`. A 4th bulk path duplicating bulk-rail behavior with the phone-fallback matcher.
- **Target:** REPLACE/DELETE the `bulk-mirror` branch.
- **Change:** Remove the `mode==='bulk-mirror'` branch entirely (collapse to the single `advanceSingleSession` path) so no phone-only fallback is live during the toggle. Per Green-First map: drop `replenishBulkQueue`/`loadSimpleLoopQueue` dual-mode flow; if the simple rail stays, its sourcing also goes through shared reserved rows, not `loadSimpleLoopQueue`.
- **Serves:** Review Hardening "collapse/delete the 4th bulk path"; Simplification Audit #1; Green-First "Remove `bulk-mirror` branching"; M4 (b).

**`captureBulkCurrent` (`:1273`)**
- **Now:** Filters mirrored candidates, lists active calls, uses `findBulkCandidateForActiveCall` (phone-capable), records auto-advance terminal + call-placed, applies `bulk.capture.found`.
- **Target:** DELETE (with the `bulk-mirror` collapse) or MODIFY to strict-only.
- **Change:** If `bulk-mirror` is removed, this whole function is dead and deleted. If retained transitionally, its matcher is now strict-identity (phone +45 gone) and it must not phone-match into current.
- **Serves:** "Confirm active call is always the only source of current rendering"; no phone-only matching.

**`loadSimpleLoopQueue` (`:895`) + `replenishBulkQueue` (`:940`) + `shouldReplenishBulkQueue` (`:931`) + `getBulkQueueTargetSize` (`:925`)**
- **Now:** `loadSimpleLoopQueue` reads `listQueueItems({visibleExtensionId})` — the assignment-visibility queue-builder. `replenishBulkQueue` calls it to top up the mirror buffer.
- **Target:** REPLACE source (or DELETE with `bulk-mirror`).
- **Change:** Stop building membership from `listQueueItems`+`visibleExtensionId`; source from shared reserved rows. With `bulk-mirror` removed, `replenishBulkQueue`/`shouldReplenishBulkQueue`/`getBulkQueueTargetSize` are dead and deleted. Practical check: "`loadSimpleLoopQueue`/`replenishBulkQueue` no longer call list/read assignment views."
- **Serves:** CR1; Green-First "Replace start/replenish logic… use shared reserved rows"; "agent queue as temporary storage" bug.

**`resolveSimpleLoopMode` (`:61`, `mode==='bulk-mirror'?'bulk-mirror':'single'`) + `CxSimpleLoopSession.mode` field**
- **Now:** Branches session shape on `mode`.
- **Target:** MODIFY/REMOVE.
- **Change:** With `bulk-mirror` collapsed, simplify to the single replacement-mode shape; drop `mode` from `CxSimpleLoopSession.js` if unused (Green-First "Update CxSimpleLoopSession.js to drop `mode`"). "Do not branch session shape."
- **Serves:** Simplification Audit #1 ("keep one replacement session object; do not branch session shape").

**`advanceSingleSession` and the single-loop disposition/skip/kill entries (`submitCxSimpleLoopDisposition` `:1360`, etc.)**
- **Now:** The boring single-lead loop.
- **Target:** KEEP.
- **Change:** none beyond reusing the shared loop primitives (snapshot active → strict match → transition current → append intent outbox). No cadence/Logics calls in the loop.
- **Serves:** "Confirm no function in loop services calls cadence counters or Logics directly"; Minimal-Viable "Legacy fast + slow single thin wrappers."

---

## Subsystem 4 — Cross-pool interlock, ingestion conformance, intake/route hardening, and net-new service files (M5/M6/M7/M8b + the reservation service spine)

These are the net-new files and caller-side conformance work that bind the three subsystems above into a working reservation service. They depend on M1–M4 being in place. **M5 is a TWO-ENDED interlock plus a mirror disable; M6 is enum-validation PLUS atomic appointment paused-create; M8b includes route-lock + intake/suppression, not just provenance + logging.**

### NEW: `cxQueueReservationService.js` (the shared spine — M1/M4/M5/M8b)
- **Now:** does not exist.
- **Target:** NEW. `createCxQueueReservationService({ cxDialQueueRepository, queueItemRepository, resolveQueueDialability })` → exposes `reserveFromFamilyOrder({domain, agentExtensionId, sessionId, familyTargets, totalLimit, claimMinutes, metadata})`, `releaseReserved(rows, reason)`, `renewReserved(ids, claimMinutes, sessionId)`. **`queueItemRepository` is a REQUIRED dep specifically so `reserveFromFamilyOrder` can run the M5 claim-time guard via `queueItemRepository.existsForLead`.**
- **Change:**
  - `reserveFromFamilyOrder` calls `reserveReadyRows(domain, familyTargets, {sessionId, extensionId:agentExtensionId, claimMinutes, ttl, totalLimit})` → `rawReserved`. **M5 claim-time interlock (Guide M5 (b)):** run `const reserved = await assertNotActiveInUcq(rawReserved)` — `assertNotActiveInUcq(rows)` per row calls `queueItemRepository.existsForLead(String(row.caseId))` (queueItemRepository.js `:391`, `activeLeadFilter` `:28`) and, for any row already active in the QueueItem/UCQ pool, drops it from the result AND `releaseReserved`s it (fail closed). REPLACE the naive `return {reserved: rawReserved, missing}` with `return {reserved, missing}` after the guard. **M8b suppression (fail-closed):** before returning, apply a local indexed contactability/DNC + Logics-status + terminal-outbox suppression by BOTH `queueItemId` AND `(domain,caseId)` (pre-filter-then-claim where possible, post-claim release otherwise); on stale/unknown DNC status, fail CLOSED (drop + release). **M8b route-lock:** stamp `rcxAccountId`/`rcxCampaignId`/`rcxDialGroupId`/`routeCampaignKey` onto each reserved row's metadata at reserve time so publish can verify them. Returns `{reserved, missing}` in green→blue→yellow→red rank order, capped at `totalLimit`.
  - `releaseReserved` per-row calls `transitionQueueItemState(['claimed'], {state:'ready', assignment nulled, reservation provenance nulled, lastReleaseReason:reason}, {match:{'metadata.reservationSessionId':row.metadata.reservationSessionId}})`.
  - `renewReserved` delegates to `renewClaim`.
  - ONE singleton instance shared by bulk wiring (`getService`), slow lane, and the M5 publish interlock.
- **Serves:** §2 reservation contract; §0/CR4 (BOTH ends of the cross-pool interlock — claim-time here, publish-time in `ringcxLeadServingService`); §6 checklist ("claim refuses if caseId is active in QueueItem"); M1/M4 "thread the service"; M8b route-lock + suppression.

### NEW: `cxReservationReconcilerService.js` (crash reconciler — M3)
- **Now:** does not exist.
- **Target:** NEW. `reconcileDanglingReservations({liveSessionIds})`.
- **Change:** `listQueueItems({states:['claimed'], metadataReservationSessionIdNotIn:liveSessionIds})` (the M3 lister branch) → for each dangling row, adopt via reservationSessionId-guarded `transitionQueueItemState` CAS; for rows with terminal evidence, force-complete via `completeCxQueueItem({queueOutcome:'reservation-reconciled-terminal'})`; otherwise release back to `ready`. Frees the `uq_cxdialqueue_active_action` slot for held-forever FM-8b orphans.
- **Serves:** §4 crash reconciliation; FM-11; FM-8b.

### NEW: `cxReserveModeService.js` (family targets — M7)
- **Now:** does not exist.
- **Target:** NEW. **Signature: `buildFamilyTargets({ policy, totalDeficit, env = process.env })`** (no `account`/`mode` params — `mode` is read from `env.RC_CX_RESERVE_MODE` internally).
- **Change:** For `mix` mode: per the 5-family enum, call `getQueueFamilyTargetOpen(policy, fam)` (cxQueuePolicyService) to build per-family DEPTH targets (targetOpen is DEPTH not throughput), honoring `env.RC_CX_RESERVE_MODE` + `RC_CX_AGED_MIN_RESERVE_PER_CYCLE` read via an inlined `readEnvNonNegInt` env reader (`getNonNegativeEnvNumber`/`readEnvNumber` are NOT exported, so inline). For green-first mode: assign `{ 'fresh-day1': totalDeficit }`. Output is the `familyTargets` object stamped on the session at `startCxBulkLoadSession` and passed to `reserveFromFamilyOrder`.
- **Serves:** §2 policy-driven ordering; M7.

### `ringcxLeadServingService.publishQueueItemToRingcx` (cross-pool interlock consumer — M5 + M8b route-match)
- **Now:** publishes a claimed row to RingCX.
- **Target:** MODIFY.
- **Change:**
  - **M5 publish-time half:** Before publishing, call `findActiveClaimForCase(domain, caseId, excludeId=row._id)`; if a DIFFERENT active `claimed`/`serving` sibling exists, REFUSE publish (release this reservation) — the publish-time half of the CR4/FM-2 cross-pool interlock.
  - **M8b route-match:** verify the row's locked route quartet (`rcxAccountId`/`rcxCampaignId`/`rcxDialGroupId`/`routeCampaignKey`, stamped at reserve) still matches the current publish target; on mismatch, `releaseReserved` with reason `'route-changed-before-publish'` (covered by `routeChangedBeforePublish.test`).
- **Serves:** §0/CR4/FM-2; M5 publish-time end; M8b route-lock invariant #4.

### `cxMorningQueueBuilderService.js` (mirror disable — M5 / FM-2b)
- **Now:** `CX_MORNING_QUEUE_BUILDER_MIRROR` defaults ON via `normalizeBoolean(env.CX_MORNING_QUEUE_BUILDER_MIRROR, true)` (`:528`); the mirror runs whenever `if (options.mirror)` (`:433/:434`) regardless of pacing.
- **Target:** MODIFY (two edits).
- **Change:** (1) Flip the mirror default OFF: `normalizeBoolean(env.CX_MORNING_QUEUE_BUILDER_MIRROR, false)` at `:528`. (2) Gate the `if (options.mirror)` mirror call (`:433`) behind `!pacingEnabled`, reading `process.env.PACING_QUEUE_ENABLED` DIRECTLY (note `isPacingQueueEnabled` is module-private/unexported in `ringcxLeadServingService`, so the gate reads the env var locally rather than importing). This stops the morning builder from mirror-publishing for rail agents while pacing is on.
- **Serves:** §6 checklist box "morning-builder mirror disabled for rail agents"; FM-2b.

### Ingestion family-enum validation + atomic appointment paused-create (M6)
- **Now:** caller layer can stamp a non-enumerated family (`unassigned`) that no `familyTargets` bucket addresses → latent orphan (FM-3b); and the appointment create path (`cxAppointmentService.ensureAppointmentQueueItem`, create via `queueCxDialRequest` `:266`, transition→`paused` `:319`) has a window where a freshly created `ready` row is reservable BEFORE the paused transition lands (G-appt / FM-5 create→pause steal).
- **Target:** MODIFY at `cxCadenceService.queueCxDialRequest` (`:1935`) + `cxAppointmentService.ensureAppointmentQueueItem`.
- **Change:**
  - **(M6 enum validation, code edit in `queueCxDialRequest`):** canonicalize `payload.queueFamily` via `cxQueuePolicyService.normalizeQueueFamily` (`:436`), then re-derive via `resolveQueueFamilyForPayload`/`deriveQueueFamilyFromAgeDays` when the result is `unassigned`/invalid — so every persisted row lands on one of the 5 reservable families. The `fresh-day1` fallback in `resolveQueueFamilyForPayload` is the backstop. Keep STOP/DNC eligibility gating intact (do NOT swap appointment/ingestion to bare `upsertQueueItem`).
  - **(M6 appointment atomic paused-create, belt-and-suspenders):** in `ensureAppointmentQueueItem`, AFTER `queueCxDialRequest` (`:266`) and BEFORE the existing `:319` transition, if the created row is `state:'ready'`, run `transitionQueueItemState(['ready'], {state:'paused'})` so the appointment row is never reservable in the create→pause window. `reserveReadyRows` also structurally excludes `metadata.appointmentId` rows (M1 `$match`) — this guard closes the residual create-instant race.
- **Serves:** §6 `:1148`; M6 (both halves); FM-3b; G-appt/FM-5.

### 4001 intake + Logics/contactability suppression (M8b)
- **Now:** Not represented in earlier drafts.
- **Target:** MODIFY `inboundIntakeService.js` (4001 intake) + enforce suppression inside `cxQueueReservationService.reserveFromFamilyOrder`.
- **Change:**
  - **4001 intake stays pool-additive:** `inboundIntakeService.js` must feed the source pool ONLY — create pool-owned `ready`/`queued` rows with NO `assignment` and NO RingCX publish (covered by `intakeDoesNotPublish.test`). Intake never reserves or serves; it only grows the pool.
  - **Reserve-time suppression (in the reservation service, see above):** local indexed DNC/Logics-status/terminal-outbox suppression keyed by `queueItemId` AND `(domain,caseId)` BEFORE claim (pre-filter-then-claim), fail-closed on stale/unknown DNC (covered by `logicsSuppression.test` / `pendingDncSuppressesServing.test` / `staleContactabilityFailsClosed.test`).
- **Serves:** M8b intake + compliance suppression invariants.

---

## Subsystem 5 — M8 offline test suite + §6 checklist walk

M8 is a distinct, mandatory milestone: no live toggle until the full offline suite is green, typecheck is clean, and the §6 air-tightness checklist is walked box-by-box with M2-before-M4 enforced. The suite mirrors the existing 54-test bulk_load layout.

### CREATE (~13 named offline test files)
| Test file | Asserts |
|---|---|
| `reserveReadyRows.test` | per-family atomic `updateMany`, `modifiedCount`=truth, one same-tick re-plan retry, dotted provenance, appointment `$match` exclusion |
| `cxQueueReservationService.test` | `reserveFromFamilyOrder`/`releaseReserved`/`renewReserved`; green→blue→yellow→red order capped at `totalLimit` |
| `reaperOwnershipExclusion.test` | reaper invisible to any `reservationSessionId` row + `appointmentId` rows (M2 query edit) |
| `renewClaim.test` | guarded-CAS heartbeat; no-op on `serving`/other-owner |
| `servingStampRace.test` | `claimed→serving` single stamp; null-return race-bail at the `:3511` pattern |
| `reservationReconciler.test` | dangling-claim adoption + force-complete + `uq_cxdialqueue_active_action` slot frees |
| `listQueueItemsReservationFilter.test` | `metadataReservationSessionIdNotIn` branch (`$nin` + `$ne:null`) |
| `crossPoolInterlock.test` | claim-time `assertNotActiveInUcq` (via `existsForLead`) + publish-time `findActiveClaimForCase` refusal (BOTH ends) |
| `findActiveClaimForCase.test` | different-sibling detection with `_id` exclusion |
| `appointmentAtomicPause.test` | M6 ready-guard `→paused` closes the create→pause window |
| `slowLaneDialabilityPostFilter.test` | slow lane re-applies `resolveQueueDialability` + releases non-dialable |
| `bulkPublishFailedRelease.test` | buffer-drop-BEFORE-release on publish reject |
| `familyTargets.test` | `buildFamilyTargets({policy, totalDeficit, env})` mix + green-first |
| (M8b add-ons) `routeChangedBeforePublish.test`, `intakeDoesNotPublish.test`, `logicsSuppression.test`, `pendingDncSuppressesServing.test`, `staleContactabilityFailsClosed.test` | M8b route-lock + intake-additive + fail-closed suppression |

### §6 checklist → milestone crosswalk (walk box-by-box)
- Reaper invisible to reservationSessionId/appointment rows → **M2**
- Single atomic bulk claim per family + one re-plan retry → **M1**
- Renew every tick, interval < claimMinutes → **M2**
- Complete AND reschedule null reservation provenance trio → **M3**
- Rescheduled rows re-promoted by `releaseDueQueueItems`, not directly reservable → **M3/repo**
- Every pool row's family is one of 5 + reservable; caller-supplied validated/re-derived → **M6**
- Claim refuses if caseId active in QueueItem (claim-time) + publish refuses on active sibling (publish-time) → **M5 (both ends)**
- Morning-builder mirror disabled for rail agents → **M5/FM-2b**
- Reserve-time route lock + publish-time route-match → **M8b**
- 4001 intake pool-additive; reserve-time DNC/Logics suppression fail-closed → **M8b**
- Rail-mismatch fails closed (bulk_load row acted on by slow/legacy) → **M8b**

**Gate:** live toggle ONLY after full green + typecheck clean + M2 deployed strictly before M4.

---

### Ingestion sources not re-expanded above (conformance per Canonical Spec §1)

The cross-pool/ingestion inventory pass hit a transient API error mid-run; the M5/M6/M8b content above was reconstructed from the Implementation Guide and is complete, but two ingestion sources were not re-expanded function-by-function. Their authoritative conformance verdict (Canonical Spec §1):

- **`cxWorkspaceService.maybeRefillCxQueueForAgent`** (per-agent refill path). **Now:** assigns refill packs scoped by `options.agentExtensionId`. **Target:** KEEP as no-pin — `agentExtensionId` is touch-policy gating ONLY, never an `assignment` pin. **Change (M6 verify):** confirm it never writes `assignment.extensionId` at create; if it does, drop it. **Serves:** §1 I1 + CR1 (no agent-pinned ingestion; this is the exact path the Mickey agent-queue-as-storage bug came from).
- **`fillerPoolRefreshService`** (writes `MasterProspectIndex.pool.tag`). **Now:** tags filler cases; they enter the pool only via `materializeAgedQueueItems` when `pool.tag` matches the current month (`RC_CX_FILLER_POOL_TAG`). **Target:** KEEP, add SLA. **Change:** define a filler→pool materialization SLA + tag lifecycle so a month boundary cannot silently starve red. **Serves:** §1 + FM-4 (aged supply starvation).
