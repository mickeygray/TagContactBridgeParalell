# CX 0.2.0 — Defect Fix Notes (2026-06-29)

Implementation record for the 11 open defects in
[CX_0_2_0_REMAINING_DEFECTS_REVIEW_2026-06-26.md](CX_0_2_0_REMAINING_DEFECTS_REVIEW_2026-06-26.md).
Each fix: verified against current code → minimal change → test → `node --test tests/cx-bulk-load/*.test.js`
green. One note per defect below, for review.

Two already landed before this pass (in the audit guide §20.10.1): **#3** off-hook gate (fail-closed on
`summary.ready===false`) and **#9** PII leak (`sanitizeActiveCallSummary`). This doc covers the remaining 11.

**Baseline before this pass:** `node --test tests/cx-bulk-load/*.test.js` → 210 pass / 0 fail.

> **Important context discovered on resuming.** The working tree was already dirty: Codex had
> started fixes ("got excited") *and* begun a separate feature (green-first-touch supply) in the
> same uncommitted diff. Before editing I diffed `HEAD` and reconciled each defect against the
> live code. Findings: **#1 was already implemented by Codex exactly per the dossier's preferred
> approach (verified + tested green); #3/#9 landed earlier; #12 was half-done.** The
> green-first-touch feature (`cxGreenFirstTouchSupplyService.js`, `applyFirstTouchClaimFilter`,
> RingCX `create/updateCampaignDisposition`, the two `rcx-first-touch-*` scripts) is **default-off
> and additive** — it is *not* one of the 11 defects, so I left it untouched, but per the dossier
> it must stay gated behind these fixes (Phase 0). I did not extend or remove it.

---

## Status

| # | Sev | Defect | Status |
|---|---|---|---|
| 1 | blocker | contact-blocked reserved row leak | ✅ done (Codex, verified by me) |
| 12 | major | reconciler evidence-key inversion | ✅ done (finished by me) |
| 5 | major | release-verification mis-ordered | ✅ done |
| 8 | major | outbox double-fault | ✅ done |
| 6 | major | lost release across __v-miss | ✅ done |
| 7 | major | departing terminal dropped on serving miss | ✅ done |
| 10 | major | orphan serving stamp before version guard | ✅ done |
| 4 | blocker | review-outcome vs drain DNC TOCTOU | ✅ done |
| 2 | blocker | racy per-agent start | ✅ done |
| 11 | major | appointment-wrap partial commit | ✅ done |
| 13 | minor | renewReserved dead code | ✅ done (comment-only) |

(#3 off-hook gate, #9 PII strip — landed earlier, tested green, unchanged this pass.)

**All 11 open defects are now addressed. Final gate: `node --test tests/cx-bulk-load/*.test.js` →
236 pass / 0 fail (baseline 210; +26 new tests this pass).**

**Two items carry an integration-deferred / ops caveat (called out so they aren't missed):**
- **#2 layer 2** — the one-running-session-per-agent partial-unique index needs a one-time
  duplicate-running-session sweep, then `node scripts/sync-indexes.js CxBulkLoadSession`. Layer 1
  (agent-keyed lock) protects the common single-process race meanwhile.
- **#8** — a *total* outbox+fallback outage still can't durably record that one call's cadence/DNC
  work (no row to replay); the fix guarantees the floor isn't stuck + the failure is observable
  (`lastError` + trace). Worth wiring an alert on `disposition.terminal_record_deferred`.

---

## #1 — Contact-blocked reserved row leak  ✅ (Codex authored; I verified)

**State on resume:** already fixed in the working tree, exactly per the dossier's *preferred*
approach (NOT the unsafe `releaseReserved:true`). I verified the code + tests rather than re-doing it.

- `cxQueueReservationService.cancelReserved(rows, reason)` — guarded CAS `["claimed","ready"] →
  "cancelled"`, matched on `metadata.reservationSessionId`, clears the reservation id and stamps
  `cancelledByReservation/cancelledReason`. A blocked DNC lead becomes terminal, never returns to `ready`.
- `cxBulkLoadRuntimeService.dropReservedCandidate` now takes `cancelReserved`; the enforced-block
  branch (`fillBuffer`) passes `cancelReserved: enforced===true` / `releaseReserved: enforced!==true`.
- Tests: `cxQueueReservationService.test.js` locks the cancel CAS shape;
  `cxBulkLoadRuntimeService.test.js:241` now asserts `reservation.cancelled === ["q1"]` **and**
  `reservation.released === []` (cancel is a distinct sink from release — the locked
  "not re-released to ready" invariant still holds). Verified green.

**Verdict:** complete and floor-safe. No change needed from me.

---

## #12 — Reconciler evidence-key inversion  ✅ (finished by me)

**State on resume:** Codex had rewritten `cxBulkTerminalEvidenceKeys` (server.js) to delegate to
`makeOutcomeIdemKey`, but it kept `if (!queueItemId) return []` — so a **no-queueItemId** terminal
outbox row (the `${sessionId}:uii:${uii}` shape) was still missed, and the inline helper could not
be unit-tested.

**What I did:**
1. Lifted the read-side key builder into `cxBulkLoadOutcomeAdapter.buildTerminalEvidenceKeys(row)`,
   co-located with the write-side `makeOutcomeIdemKey` (single source of truth for the idemKey
   contract). It reproduces **every** writer branch: `queueItemId:uii`, `sessionId:uii:uii`,
   `sessionId:queueItemId:terminal`, `sessionId:case:caseId:terminal`.
2. Dropped the `!queueItemId` early-return so no-qid rows match their `sessionId:uii:uii` key.
3. Guarded the no-UII key against the degenerate `sessionId::terminal` (only emitted when there is
   a queueItemId or a real caseId) so the lookup can never be broad enough to force-complete an
   unrelated lead.
4. Exported it through the barrel; `server.js` now imports `buildTerminalEvidenceKeys` and its
   `cxBulkTerminalEvidenceKeys` is a one-line delegate. `node --check server.js` passes.
5. Added 4 unit tests in `cxBulkLoadOutcomeAdapter.test.js` (no-UII terminal match, no-qid UII
   match, UII+fallback together, degenerate-key guard). Suite green (221 pass / 0 fail).

**Why this matters:** the reconciler force-completes (vs. re-dials) a dangling reserved row based on
terminal evidence; the missed no-UII shape was a release → re-dial of an already-dispositioned
(possibly DNC-stopped) lead. Now the lookup set is a provable superset of whatever the single writer
wrote. Blast radius: helper lives only in the control-plane reconciler; `findByIdemKeys` stays
exact-match (untouched), so the shared rectifier is unaffected.

---

## #5 — Release-verification masks transient errors as a stale still-active result  ✅

**File:** `cxBulkLoadRuntime.js` `confirmRingcxUiiReleased` (poll loop ~310-348).

**Problem:** the loop kept the last sighting (`lastActiveCall`) and the last error independently. If
an early poll sighted the call and later polls only *threw* (transient API errors), the post-loop
guard `if (lastError && !lastActiveCall)` was false (a sighting existed), so it fell through to
`active-call-still-active-after-disposition` carrying the **stale poll-1 snapshot** — a definitive
compliance-relevant claim built on an unverified, possibly-already-released call.

**Fix (minimal, preserves the locked test):** track the poll index of each observation
(`activeSeenAt` / `errorSeenAt`). Report still-active only when the **most recent** observation was
an actual sighting; if the latest observation was a transient error (`errorSeenAt > activeSeenAt`,
which also covers the throws-only case), return `active-call-release-verification-failed`
(inconclusive/recoverable). Cases: persistent-active no-throw → still-active (unchanged, locked test
green); early sighting then throws → verification-failed; error-first then sighting → still-active
(latest wins); later poll sees it gone → released.

**Note:** this changes the *reason/snapshot*, not the write gating — both failure reasons still
return `ok:false` and block the terminal write, exactly as before (verified in
`cxBulkLoadRuntimeService.js:697-717`). Whether an *inconclusive* verification should be allowed to
persist the terminal write (vs. block) is a separate, larger product decision the dossier flagged —
I deliberately did **not** bundle it here. A bounded final re-poll on transient error is a possible
future enhancement; not added (the loop already polls up to 3×).

**Tests:** 3 new in `cxBulkLoadRuntime.test.js` (early-sighting-then-errors → verification-failed;
error-then-sighting → still-active; error-then-gone → released). Existing still-active test
preserved. Green.

---

## Watcher family (#7, #10, #6) — `cxAccountActiveCallWatcherService.js`  ✅

These three live in `applyProjection` and were fixed together (Codex's "one watcher transaction
cleanup"). The shared new dependency is `loadLatestState`, wired from the runtime service to its
existing `loadState` (the same loader `beforePersist` already uses).

### #7 — departing terminal dropped on the incoming candidate's serving-CAS miss
On a switch tick the projection co-attaches (a) the departing call A's terminal observation and (b)
the incoming candidate B's promotion. If B's serving-ownership stamp missed, `applyProjection`
`return`ed **before** `persistTerminalObservations`, silently dropping A's `did_not_connect`.
**Fix:** call `await persistTerminalObservations(projection)` immediately before the serving-miss
`return`. A's release is independent of whether B can be adopted; `persistTerminalObservations`
self-guards each obs, and this branch returns before the line-~600 flush so there's no double-write.
The session patch (B's promotion) is still correctly not written. **Test:** a genuine A→B switch
(A UII-proofed but un-anchored so it isn't a current-release/hold) with `markCandidateServing → null`
asserts the serving-miss skip, no session write, and exactly one terminal write for A.

### #10 — serving stamp fires before any latest-aware staleness guard
The apply-time eligibility check passed no `latest`, so the stale-projection branch (gated on
`latest`) never fired; the serving CAS (a Mongo `serving`/`wrapUpRequired` stamp) ran before the
version-guarded session write. On a stale projection the stamp could orphan a queue row the session
never adopts. **Fix:** load `latest` and pass it to `describeBulkLoadMutationEligibility` **before**
the serving block, skipping (`stale-projection-apply`) when stale. The read is **gated on
`promotionRequired`** — we only pay the extra round-trip where a side-effect actually precedes the
write; pure release/version-guarded writes are already protected by the write's own guard.
**Tests:** stale `__v` → serving never fires + no write + `stale-projection-apply`; matched `__v` →
serving fires once + writes (guards against over-blocking).

### #6 — lost release across a __v-miss (no re-read/retry)
On a version-miss the recomputed release anchors were discarded with no retry, so a lead that went
active→released entirely inside the race gap was never counted. **Fix:** a bounded
(`maxAttempts: 2`) `retryReleaseProjectionOnVersionMiss` that re-reads the latest row via
`loadLatestState`, **re-projects against THIS tick's same active-call snapshot** (a non-enumerable
`reproject` closure bound on the projection in `buildCxAccountActiveCallWatchPlan`), recomputes the
version guard from the fresh row, and retries the guarded write. Safety rails: never blind-resends
the stale patch (that would clobber the concurrent writer the guard exists to stop); **bails on a
fresh required promotion** (`version-miss-needs-promotion`) since re-stamping serving is out of
scope; no-ops to legacy single-shot behavior when `loadLatestState`/`reproject` aren't present.
**Test:** first write version-misses, retry re-reads + re-projects the empty snapshot and still
writes `current:null` + records A's `did_not_connect`.

**Residual (flagged, not a regression):** a *switch* tick (release **and** promotion together) that
version-misses still skips rather than retrying — the retry is deliberately scoped to the pure
release path to avoid an unstamped-promotion write. This is rarer than the pure-release #6 case and
no worse than today's behavior. Noted for a possible future follow-up.

---

## #8 — Outbox-outage double-fault leaves the call uncounted at terminal.started  ✅

**Files:** `cxBulkLoadRuntime.js` (`recordCadenceEvent` fallback) + `cxBulkLoadRuntimeService.js`
(`submitCxBulkLoadDisposition` terminal write).

**Problem:** disposition does `terminal.started` (keeps `current`) → hang up the call → `await
persistTerminalOutcome` (**unguarded**) → `terminal.accepted` (counts + clears `current`). The
durable path's `.catch` ran `await dispatchCadenceEvent(event)` which itself can throw (it runs
shared DNC stop/sync cleanup). If BOTH the outbox insert and the fallback dispatch threw, the
rejection propagated out of `persistTerminalOutcome`, so `terminal.accepted` never ran: the call was
already hung up yet the session sat at `terminal.started` (phase RELEASING, `current` set,
uncounted) forever.

**Fix (two parts):**
- **Part 1** — the fallback `.catch` wraps its `dispatchCadenceEvent` in its own try/catch and
  returns `{ written:false, fallbackFailed:true, error }` instead of rejecting. `recordCadenceEvent`
  surfaces that as a structured status, never a throw.
- **Part 2** — the disposition's `persistTerminalOutcome` call is wrapped in try/catch. The call has
  **already hung up** (we're past the `terminal.ok===false` guard), so on a throw *or* a
  `fallbackFailed` result we capture `terminalRecordError` and **still** advance to
  `terminal.accepted` + persist, stamping `lastError: "terminal-record-deferred: …"` (after
  `maybeRefill`, so the reduce path there doesn't clear it) and returning
  `terminalRecordDeferred:true`. Explicitly **not** routed through `terminal.failed` (that path is
  for a call that did *not* hang up). `clearTerminalHold` is also made non-fatal.

**Idempotency:** the outbox idemKey keeps any later drain/reconciler re-record a no-op.

**Residual (flagged):** in a *total* durability outage (outbox down AND fallback down), the
cadence/DNC work for that one call is not durably recorded — there is no outbox row to replay. The
fix guarantees the floor is not stuck and the failure is observable (`lastError` +
`disposition.terminal_record_deferred` trace), which is the reported bug. A fully automated
re-record lane for the double-outage is the same shape as #4's rectification lane and is out of
scope here — flagged for alerting.

**Tests:** 2 new in `cxBulkLoadRuntimeService.test.js` (fallbackFailed result; thrown persist) —
both assert `dispositionOk:true`, `current===null`, `completedCount===1`, not RELEASING,
`terminalRecordDeferred:true`, `lastError` marker. (The harness `build()` gained an optional
`outcomeAdapter` override.) The two existing disposition-failure tests (terminalExecutor reject/throw
→ `current` retained) still pass — those are the genuine "call did not hang up" path, untouched.

---

## #13 — renewReserved dead code / misleading lease comment  ✅ (comment-only)

Per the dossier's option (b) and Codex's confirmation ("don't add a shared-service heartbeat"): no
behavior change. Corrected the false `DEFAULT_RESERVE_CLAIM_MINUTES` comment in
`cxBulkLoadRuntimeService.js` that claimed "the bulk watch tick [renews] before the lease lapses" —
it now states the truth: the lease is single-shot, never heartbeated, and reserved rows are
reaper-exempt by ownership. Added an `UNWIRED (#13)` banner to `renewReserved` in
`cxQueueReservationService.js` noting it has no production caller and that any future wiring must be
bulk-watch-tick-only, never on this shared instance (slow-lane uses it too). `renewReserved` +
`renewClaim` + their 4 isolation tests are left intact. No functional risk.

---

## #4 — Review-outcome vs drain DNC TOCTOU (rectification lane)  ✅

**Files:** `cxBulkLoadRuntime.js` (`submitCxBulkLoadReviewOutcome`), `cxBulkLoadOutcomeAdapter.js`
(new pure `buildReviewCorrectionRow`), `cxTerminalOutboxRepository.js` (new `findByIdentity`).

**Problem:** the review path called `updatePendingOutcomeByIdentity` — a bare `findOneAndUpdate` that
flipped `payload.outcome → 'dnc'` on the **in-flight pending terminal row**. The drain replays an
in-memory snapshot of that row with no CAS and `markDrained` unconditionally, so a drain tick that
read the row at `did_not_connect` could replay the stale outcome and mark it drained **after** the
agent's update landed — the DNC never reached Logics, yet the agent was told `ok:true,updated:true`.
A silent DNC-compliance miss.

**Fix (Codex's recommended single-actor design):** stop mutating the shared terminal row. Record the
DNC correction as its **own durable outbox row** (a rectification lane):
- new pure `buildReviewCorrectionRow` builds a row keyed `queueItemId:uii:review-dnc` (distinct from
  the terminal `queueItemId:uii`, so no collision and `insertOnce` dedups repeat reviews), copying
  the original terminal row's `payload` shape and flipping `outcome → 'dnc'`.
- `submitCxBulkLoadReviewOutcome` reads the original row via the new `findByIdentity` (any status —
  works **even after the original drained**) for full case context, then `insertOnce`s the
  correction row. Returns `{ ok:true, recorded, deduped, idemKey }`.
- **No drain change required.** The existing drain replays the new row's `payload` (`outcome:'dnc'`)
  straight into `handleCxTerminalCallOutcome`'s DNC branch → Logics, idempotently. The drain's
  no-CAS behavior is untouched (its tests stay green) because we no longer race the terminal row.

This gives the correction a **guaranteed lane** even after the auto-disposition row drained, and
removes the shared-row contention entirely — in keeping with the rail's insert-once durability model.
`updatePendingOutcomeByIdentity` is kept but marked deprecated for this path (no other caller).

**Why no race remains:** the terminal row and the correction row are different rows with different
idemKeys; the drain processes each independently and idempotently. The original `did_not_connect`
records the attempt; the `review-dnc` records the stop — both true, DNC compliance guaranteed.

**Tests:** 3 new pure unit tests for `buildReviewCorrectionRow` (distinct idemKey vs terminal;
copies caseId/domain + flips to dnc; minimal-payload fallback). The Mongo seam
(`findByIdentity`/`insertOnce` in `submitCxBulkLoadReviewOutcome`) is integration-deferred per the
rail's policy — the pure row-builder carries the correctness-critical logic and is fully tested.

---

## #2 — Racy per-agent start (two running sessions per agent)  ✅

**Files:** `cxBulkLoadRuntimeService.js` (`startCxBulkLoadSession`), `CxBulkLoadSession.js` (schema
index), `scripts/sync-indexes.js` (promotion path).

**Problem:** `startCxBulkLoadSession` minted `sessionId = input.sessionId || newSessionId()` and locked
`withSessionMutation(sessionId)`. Two concurrent `/start` requests for the same agent *without* an
explicit sessionId (the normal UI path) mint **different** ids → take different serializer entries →
run fully concurrently. The retire-then-create is non-atomic, the only unique index was `sessionId`,
and the agent fields were plain non-unique indexes — so both `create()`s succeeded and the agent
ended with **two running sessions**, each reserving + dialing independently (double-reserve /
double-dial).

**Fix (both layers, per Codex):**
- **Layer 1 (single-process):** serialize starts on a **stable agent key**
  (`bulk-start:${agentEmail||ext}`) via a new `withAgentMutation` (shares `sessionOperationTails`,
  `markBusy:false`). The body is `withAgentMutation(agentKey) → withSessionMutation(sessionId)` —
  the inner lock still marks the **new** session busy so the watcher skips it during preload; the
  keys differ so there's no self-deadlock. The second start now waits, sees the first's running
  session, and retires it through the kill path (extracted `retireActiveSessionsForAgent`).
- **Layer 2 (multi-process/pod — the in-memory Map can't cross processes):** a **partial-unique
  index** `{ agentEmail: 1 }` where `status:"running"` (keyed on the always-present `agentEmail`;
  `agentExtensionId` is nullable and would collide on null). The start path catches the resulting
  **E11000** — retires the conflict + retries once, else recovers the winner (returns the existing
  running session) rather than duplicating.

**Ops / safety (flagged):** the index is **NOT auto-built** in prod (`autoIndex` off — see
`sync-indexes.js`). It is registered in `sync-indexes.js`'s allowlist and built explicitly via
`node scripts/sync-indexes.js CxBulkLoadSession` — which **requires a one-time sweep of duplicate
running sessions per agent first** (a unique build fails on existing dups). Until the index is built,
Layer 1 alone protects the single-process case (the common UI race); Layer 2's E11000 handler is
inert-but-ready. This is the one item here with a manual ops prerequisite — called out so it isn't
missed.

**Tests:** 2 new in `cxBulkLoadRuntimeService.test.js` — concurrent no-sessionId starts → exactly
one running session + one retired; injected E11000 on create → retire-conflict + retry, no duplicate.
(Harness `build()` gained `repo`/`newSessionId` overrides.) The existing explicit-sessionId
"start replaces a prior active session" test still passes.

---

## #11 — Appointment-wrap partial commit (Logics committed outside the session lock)  ✅

**Files:** `cxBulkLoadRuntime.js` (`submitCxBulkLoadAppointmentWrap`), `cxBulkLoadRuntimeService.js`
(new `markSessionBusy`).

**Problem:** `submitCxBulkLoadAppointmentWrap` ran the entire Logics-mutating sequence
(`createCxAppointment` + workbench + assign + post-date) **outside** the per-session serializer and
never marked the session busy. Only the *final* `submitCxBulkLoadDisposition` enters the busy set. So
during the multi-second Logics commit a concurrent `runCxAccountActiveCallWatchOnce` tick (seeing the
call released) could `current.released` → clear `state.current`. When the wrap then dispositions,
`loadState` has no `current` → `missing-current-call` early return → nothing sent to RingCX, and the
wrap returned a bare `ok:false` **without resuming dialing — after the Logics appointment was already
committed.** A real partial commit.

**Fix:**
- New runtime-service `markSessionBusy(sessionId)` — holds the **busy counter only** (the watcher's
  skip signal) and returns an idempotent release. Critically it does **not** chain
  `sessionOperationTails`, so an inner `submitCxBulkLoadDisposition` (`withSessionMutation`) still runs
  against an empty tail — **no self-deadlock** (the exact hazard the dossier flagged for the naive
  nest-the-whole-wrap-in-withSessionMutation approach).
- The wrap holds the busy flag across its **whole** body via `try { … } finally { releaseBusy() }`,
  so the account watcher **skips** the session and cannot clear `current` during the Logics commit.
- The terminal-failure branch now distinguishes the partial-commit case: if the appointment committed
  but the terminal couldn't finalize, it sets `appointmentCommittedTerminalDeferred:true` and a clear
  `appointment-committed-terminal-deferred:<reason>` resume reason — so the caller can retry the
  terminal/resume instead of treating the appointment as lost (no more silent bare `ok:false`).

**Why this is the right altitude (vs. the full lock refactor):** holding the busy flag prevents the
race at its root (the watcher can't mutate a busy session) without the cross-file
extract-a-lock-free-disposition-core refactor that risks a self-deadlock in a live, untested route.

**Tests:** 1 new in `cxBulkLoadRuntimeService.test.js` exercising the **real** runtime service: with
the busy flag held, a watch tick whose RingCX snapshot shows the call released **skips** the session
(current preserved as `q1`), and the inner disposition still completes (`dispositionOk:true`,
`current:null`, counted) — proving both the watcher-skip protection and the no-deadlock property. The
wrap's Logics orchestration (`createCxAppointment` etc.) stays integration-deferred per the rail's
policy; the locking fix — the heart of #11 — is what's unit-verified.

---

## Summary — what changed, for the reviewer

**Source files touched (all under git, on `release/0.2.0-alpha`):**
- `apps/control-plane/src/server.js` — #12 (delegate evidence keys to shared builder)
- `packages/shared-services/src/cxBulkLoadOutcomeAdapter.js` — #12 `buildTerminalEvidenceKeys`,
  #4 `buildReviewCorrectionRow` (+ exports)
- `packages/shared-services/src/cxBulkLoadRuntime.js` — #5 release-verify ordering, #8 fallback
  hardening, #4 rectification lane, #11 busy-hold + structured result
- `packages/shared-services/src/cxBulkLoadRuntimeService.js` — #8 guarded terminal write,
  #10/#6 `loadLatestState` wiring, #13 comment, #2 agent-keyed start + E11000, #11 `markSessionBusy`
- `packages/shared-services/src/cxAccountActiveCallWatcherService.js` — #7/#6/#10 watcher family
- `packages/shared-services/src/cxQueueReservationService.js` — #13 UNWIRED banner
- `packages/shared-services/src/index.js` — barrel exports
- `packages/shared-repositories/src/cxTerminalOutboxRepository.js` — #4 `findByIdentity` (+ deprecation)
- `packages/shared-models/src/CxBulkLoadSession.js` — #2 partial-unique index
- `scripts/sync-indexes.js` — #2 index promotion allowlist
- Tests: `cxBulkLoadOutcomeAdapter` (#12/#4), `cxBulkLoadRuntime` (#5), `cxAccountActiveCallWatcherService`
  (#7/#10/#6), `cxBulkLoadRuntimeService` (#8/#2/#11)

**Discipline:** every fix is the smallest change that addresses the cause, verified against the live
code, with a failable test, and the suite stays green after each. Shared-service blast radius was
respected throughout (e.g. `cancelActiveQueueItems` default untouched for #1; `findByIdemKeys` left
exact-match for #12; the drain untouched for #4; no shared-service heartbeat for #13). The
green-first-touch feature in the working tree was left exactly as Codex had it (default-off, additive)
— per the dossier it stays gated behind these fixes.

**Not done / deferred (by design, flagged above):** #2's partial-unique index requires the ops
dup-sweep + `sync-indexes.js` run; #8's total-double-outage record-loss needs an alert, not more code;
#6's switch-tick-version-miss residual is scoped out of the retry; #5's "allow terminal write on
inconclusive" is a separate product decision. Mongo-execution seams (#4 insert/find, #2 index build)
are integration-deferred per the rail's standing policy; their correctness-critical logic was
extracted into pure, tested helpers.
