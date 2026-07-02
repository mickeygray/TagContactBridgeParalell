# CX 2.0 bulk_load — Pre-Alpha Adversarial Review Punch-List (2026-06-29)

Adversarial multi-agent review of the **uncommitted** working-tree changes (11 defect fixes + alpha-trace logging + stale-serving diagnostic + green-first-touch). 21 agents, 7 finder dimensions → 12 candidates → **7 survived** verification (5 refuted), 0 new in the completeness sweep.

## Clean (the reassuring part)

- **Logging-safety: CLEAN.** The new `cxAlphaTraceService` + every `logCxAlpha`/`traceBulkFlow`/`traceDisposition` call site verified **pure-observational** — no uncaught throw into a caller, no state mutation, no control-flow gating, no return-value change, PII-redacted, gated default-off. The "nothing working depends on the log firing" constraint holds.
- **Concurrency / state-machine: CLEAN.** No double-reserve / stuck-busy / refill-ordering defects survived.
- **Completeness sweep: CLEAN.** Fresh-eyes pass found nothing new.
- **Refuted false-alarm worth noting:** a finder raised a *high* "partial-unique index collides with the field-level `index:true` on agentEmail — the #2 backstop won't build." **3 verifiers REFUTED it** (different key patterns / index code mislocated). The #2 partial-unique index is fine.

## The 7 that survived — honest triage

Severities below are the **verifier-corrected** values (the synthesis lead elevated B1/B2 to "blocker" on blast-radius grounds; my read on default-on vs default-off is noted per item).

### ⚠ Fix before testing — the only genuine default-ON bug

**B1 — Terminal attempt counter double-increments (idempotency token written but never read).** *(PLAUSIBLE, medium; default-ON)*
`packages/shared-services/src/cxCadenceService.js:276` (`buildTerminalAttemptProofPatch`)
`buildCallAttemptPatch` applies an absolute `+1` to `placedCalls`/`dailyPlacedCalls`/`monthlyPlacedCalls`. `handleCxTerminalCallOutcome` re-derives it on every invocation and is **not idempotent**, so: (a) an outbox **replay** after a partial-apply/markFailed re-applies `+1`; (b) the new **#4 `review-dnc` lane** drains a second terminal event for the *same physical dial* (`dispatchCadenceEvent` hardcodes `sourceService:"cx-bulk-load"`) → another `+1`. The author left the suppression marker `metadata.lastTerminalAttemptCountedUii` (written at `cxCadenceService.js:2873`) **but nothing reads it.** Inflated counts feed dialing caps + cadence progression → a lead is throttled/advanced on a single real attempt.
**Fix:** in `buildTerminalAttemptProofPatch`, read `queueItem.metadata.lastTerminalAttemptCountedUii`; return `countable:false` when it equals the current terminal UII. Add the already-counted case to `tests/queue/cxTerminalOutcome.test.js` (it currently exercises only source/uii).

**✅ Fixed (Claude, 2026-06-30):** `buildTerminalAttemptProofPatch` now reads `queueItem.metadata.lastTerminalAttemptCountedUii` and returns `{countable:false, alreadyCounted:true, queuePatch:{}}` when it matches the current terminal UII. The marker is written atomically with the `+1` in the same `completeCxQueueItem`/`rescheduleCxQueueItem` `extraUpdate` (lines 2908-2934), so an outbox replay or the review-dnc lane re-draining the same physical dial is suppressed; a genuinely different UII still counts. New test "bulk terminal attempt proof is idempotent…" added to `tests/queue/cxTerminalOutcome.test.js`. 260 tests green.

### ⓷ Fix before widening (safe for a 1-agent pilot) — only bite if green-first-touch is ON

**B2 — Green first-touch re-dials the same fresh lead every refill tick (no attempt cap).** *(CONFIRMED, medium; default-OFF)*
`packages/shared-repositories/src/cxDialQueueRepository.js:78` (`applyFirstTouchClaimFilter`) + `cxQueueReservationService.js:127` (`releaseReserved`)
Bulk never writes `placedCalls`; a non-terminal dial (no-answer/publish-fail/contact-block) releases the row to `state:ready` with `placedCalls:0` and `greenCoverageBatchId` intact → it re-satisfies the first-touch filter verbatim and re-dials, hammering the *most sensitive never-contacted* leads all morning. This is the documented "bulk can't express never-dialed-only / debt never clears" gap.
**Fix:** on release, `$inc` a `firstTouchAttempts` (or `placedCalls`) and add a max-attempts/cutoff bound so a released green isn't immediately re-eligible. **Codex's lane** (green-first-touch) — coordinate.

**Codex pass applied:** first-touch reservation now carries `firstTouchMaxAttempts` through planner → runtime → reservation repo, defaulting to 1 via `CX_GREEN_FIRST_TOUCH_MAX_ATTEMPTS`. `releaseReserved` stamps `metadata.firstTouchAttempts` and `metadata.firstTouchLastAttemptAt` for first-touch rows before returning them to `ready` after failed publish/route/contact releases, while `session-killed` cleanup returns untouched rows without burning an attempt. First-touch claim/count queries exclude rows whose attempts have reached the cap.

**W1 — Open-coverage plan drops all normal-family targets → un-dialable greens starve the agent.** *(PLAUSIBLE, low; default-OFF)*
`packages/shared-services/src/cxGreenFirstTouchSupplyService.js:196` (`buildMorningCoverageSupplyPlan`)
When `remaining>0` the plan returns `familyTargets:{fresh-day1:take}` only and never exits coverage mode until `countReadyFirstTouchRows===0`; the runtime ignores the plan's `cutoffAt`/`coverageOpen`. With B2, a batch of dead-phone greens fills the buffer exclusively with the same failing leads → the agent dials nothing. Fixing B2's attempt-cap drains this lock too.
**Fix:** honor `cutoffAt` in the runtime and/or fall back to `normalFamilyTargets` once first-touch attempts are exhausted.

**Codex pass applied:** the attempt cap makes exhausted first-touch rows disappear from the first-touch-only count/query, so coverage mode drains instead of repeatedly reserving the same dead row. Normal-family fallback remains the existing behavior once first-touch count reaches zero.

**W2 — Shared `upsertQueueItem` forks a new active row instead of reactivating a completed/cancelled row.** *(PLAUSIBLE, low; default-ON but legacy-path)*
`packages/shared-repositories/src/cxDialQueueRepository.js:245`
The new unflagged `state:$nin:[completed,cancelled]` filter (with `upsert:true`) means a legacy cadence/workspace re-queue of a drained (`completed`) case **inserts a second document** for the same `(domain,caseId,actionKey)` — no E11000 (the partial unique index excludes completed) — orphaning the old row, resetting placed/daily counters, splitting history. Collateral drift into 5 legacy callers of a shared fn; not one of the 11 fixes.
**Fix:** revert the `state` clause on the actionKey branch, or scope it strictly to the green-first-touch materializer path.

### ⓸ Watch only — diagnostic-only / known limitation, none block testing

**N1 — Stale-serving dequeue corroboration reads a field bulk shells never write.** *(CONFIRMED, low; diagnostic-only, fails safe)*
`cxStaleServingReconcilerService.js:124` reads `metadata.lastRingcxMonitorActiveCall.raw.dequeueTime` (legacy monitor only); bulk shells stamp `metadata.lastRingcxActiveCall` (`cxBulkLoadRuntime.js:845/879`). So `dequeueTime=null`/`dequeueTimeSeen=false` on every bulk shell — the "restore high confidence" channel is a silent no-op for exactly its target rows. Fails safe (no false stale).
**Fix:** also read `metadata.lastRingcxActiveCall.raw.dequeueTime` as fallback (per design notes).

**✅ Fixed (Claude, 2026-06-30):** `normalizeActiveCall` (cxBulkLoadActiveCallWatcher.js) now carries `dequeueTime` onto the serving stamp (additive, never used for matching), and `resolveServingIdentity` reads dequeueTime from BOTH `lastRingcxMonitorActiveCall.raw` (legacy) and the bulk `lastRingcxActiveCall` (flat, `.raw` fallback). Corroboration now works for the bulk shells it targets. New tests in the watcher + reconciler suites; one deepEqual fixture updated.

**N2 — Agent-advanced detection defeated when the snapshot omits `agentId` → inflated actionable-idle count.** *(PLAUSIBLE, low; diagnostic-only)*
`cxStaleServingReconcilerService.js:236` — `agentMap` is built only for calls with truthy `agentId`; a replacement call without `agentId` makes a live-on-fresh-call agent fall through to `idle-stale-shell actionable:true`. Over-counts the actionable bucket the operator reads.
**Fix:** corroborate replacement via uii/externId when `agentKey` is absent, or down-rank confidence instead of marking actionable.

**✅ Fixed (Claude, 2026-06-30):** the idle branch now down-ranks to `confidence:"low-agent-visibility"`, `actionable:false`, `observe-only` when `agentMap` is empty while the snapshot is non-empty (no active call carried an agentId → the agent-advanced check ran blind, so we can't rule out this agent being live on an unattributable call). The shared test fixture was made realistic (the other live call is attributed to a *different* agent), so genuine idle shells stay actionable. New test "agent-advanced BLIND…".

**N3 — Partial RingCX insert logged as `phantomSuspected` but never pruned.** *(PLAUSIBLE, low; known RingCX limitation)*
`cxBulkLoadRingcxPublisher.js:183` — when `0 < leadsInserted < accepted.length` with empty `rejectedRows`, un-inserted leads stay in `patch.accepted`, get stamped serving, never dial. RingCX doesn't say *which* externIds it silently dropped, so there's no clean prune.
**Fix:** ensure the stale-serving diagnostic / ~8-min legacy requeue covers it; alert when `phantomSuspected` fires.

**Codex pass:** left as watch-only. `phantomSuspected` already logs the unsafe partial-insert shape; without RingCX returning rejected externIds, code-side pruning would be an ungrounded guess. Treat every event as a diagnostic requiring stale-serving/requeue confirmation.

## Tomorrow's test focus

- **placedCalls integrity (B1):** watch the pilot agent's dialed bulk leads go exactly `0→1` per real dial. Any `→2` after a terminal-write retry or a DNC-review submission is B1 firing — diff against `metadata.lastTerminalAttemptCountedUii`.
- **Green re-dial loop (B2/W1) — only if the green flag is ON:** alert on any `(domain,caseId,actionKey)` reserved+published more than once in a refill window; watch for an agent whose buffer is 100% `fresh-day1` for consecutive ticks (coverage-lock). Stage the flag→OFF kill-switch.
- **Duplicate queue rows (W2):** spot-query `CxDialQueue` for >1 doc per `(domain,caseId,actionKey)`, especially cases that recently went `completed` then got re-touched by legacy cadence.
- **Stale-serving signal quality (N1/N2):** treat `dequeueTimeSeen` as expected-false and the `actionable`-idle count as an **upper bound** this round — don't act on it; verify the ~8-min legacy requeue still frees real shells.
- **Phantom inserts (N3):** watch for `phantomSuspected` trace events — each is a lead stamped serving that RingCX never took; confirm it gets freed and doesn't strand at the top of the queue.
