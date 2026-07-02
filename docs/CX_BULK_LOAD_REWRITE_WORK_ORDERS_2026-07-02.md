# CX Bulk-Load Rewrite — Work Orders (2026-07-02)

Step-by-step execution guide for the weed-whack + rebuild. The decisions in here are FINAL —
they were made after a full 8-area complexity scan, a correctness audit, and verification
(greps, live-box env checks). The executing model's job is to execute, not to relitigate.
If a step can't be executed as written, STOP and report — do not improvise a different design.

Companion docs (context, not instructions): `docs/FINISH_SPRINT_QUEUE_TO_COACH_2026-07-02.md`
(the sprint + full weed-whack appendix), `docs/CX_BULK_LOAD_FINISH_PLAN_2026-07-01.md`
(correctness findings referenced as B-numbers).

**Review round 1 (2026-07-02) incorporated.** A second-opinion pass flagged seven orders as
close-to-live-behavior; all seven got proof steps or sequencing guards (WO-3, WO-5, WO-12,
WO-15, WO-22, WO-27, WO-30 below). No decision reversed. The pattern for executors: where an
order now says "evidence first" or "parity fixture," that proof is part of DONE WHEN — a cut
without its proof is an unfinished order.

**THE ATTIC MODEL (Mickey, 2026-07-02 — supersedes both "pending-delete comment blocks" and
"physical deletion"): nothing is deleted; retired code MOVES OUT of active files into the
attic.** `attic/<feature-name>.attic.md` at the repo root — markdown with fenced code blocks,
so it can never be imported, compiled, tested, or linted, and rollback/reuse is "open one
file," not git archaeology. Active files carry ZERO corpse comments. Every attic file starts
with this header:

```
# ATTIC — <feature name>
Retired by: WO-<n> (<date>) — <the design decision that closed this path, one sentence>
Applied to: <what flow/feature this code served when it was alive>
Lived at: <file:line ranges at the WO-0 baseline commit>
Replaced by: <the surviving path>
Revive: <what to re-wire, and WHICH negative-pin tests (by name) must be consciously removed>
```

Consequences for every order: the report's PENDING DELETE line becomes **ATTIC** (feature file +
what moved); DONE-WHEN greps become TRUE ZERO in `packages apps scripts tests` (no more
live-vs-commented hair-splitting — attic/ is excluded by path); rule 2a2's negative pins are
REQUIRED before the move (the tripwire outlives the body).

Attic riders now due (executor work, one commit each):
- **WO-1 attic rider:** the WO-1 pending-delete blocks → `attic/green-first-touch-supply.attic.md`
  (this one's revive note matters — the first-touch interrupt concept may genuinely return).
- **WO-2 attic rider:** adoption blocks → `attic/adoption-path.attic.md`. Pins already armed.
- **WO-3 attic rider:** manual-dial blocks + the two disabled dedicated tests →
  `attic/manual-dial-lane.attic.md`, AFTER adding the negative pins: `/start-next` answers
  `410 {code:"manual-dial-disabled", use:"get-leads"}` (the 3-line stub is the only active-tree
  remnant), `startCxBulkLoadNextManualCall` asserted not-exported, watcher asserted to never
  phone-attach. One clean live loop on the WO-3 build remains the trigger (next fresh-batch
  session).
All future whack orders land straight in attic form — no intermediate comment-block stage.

**Mickey override (2026-07-02): no physical deletes during this pass.** Older language below
that says "delete," "wood-chipper," "remove," or "cut" now means: disable, comment out, or
hard-gate the old path; write the simpler replacement path where the order calls for one; run
the named tests and gate; record the disabled code as pending deletion in the WO report; then
advance. Git history is still the archive, but permanent deletion waits until Mickey approves
it after proof. Grep-based DONE WHEN checks now mean **0 live/executable hits**. Commented-out
or hard-gated pending-delete blocks may remain only when they are clearly marked with the WO
number and listed in the report.

## THE SPLIT — who does what (explicit, no gray areas)

### THEY DO — the executors (Codex / delegated models): 28 of 30 orders
Everything not listed under I-DO below. By phase:
- **Phase A (pool):** WO-1, 2, 3, 4 (chippers) · WO-5 (w/ parity fixture) · WO-6, 7 · WO-8, 9
  (scripts). Nothing here waits on me — **start WO-1 immediately.**
- **Phase B (proof):** WO-10, 11, 12, 13.
- **Phase C (button/UI):** WO-14, 15 first · then WO-17, 18, 20, 21 · WO-19's server half
  anytime, its client cleanup only AFTER my WO-16 lands.
- **Phase D (record):** WO-22, 24, 25. (WO-24 must not reshape idemKey — that second pass is
  mine.) NOTE: WO-31 (released-call correction lane) is textually filed after WO-25 but RUNS in
  Phase C alongside WO-17 — the M1 wrap-up modal needs its lane live for the Unit-3 session.
- **Phase E (room):** WO-26, 27, 28 (WO-27 last, after the Unit-3/4 human bars).
- **Phase F:** WO-29, 30 (now-half).
- **Coach side:** the SSE reconnect fix (stream.ts — spec'd as D1/D2 in
  `docs/AI_BUS_AUDIT_2026-07-01.md`: reconnect on graceful close, reset the retry budget,
  no-retry on 4xx) and the Unit-7 manual content nits a rep's red pen produces (schema in
  `apps/web-client/src/workspaces/field-manual/content/types.ts`).

### I DO — Claude Fable (big guns, deliberately few — the token budget is the constraint)
1. **WO-16** — the projector rewrite: `bulkLoadProjection.ts` + the slim UI state layer.
   Sequenced: after their WO-14/15, alongside WO-19's server half.
2. **WO-23** — the cadence crossing: characterization test over `handleCxTerminalCallOutcome`,
   then the `applyCxTerminalOutcome` extraction. Sequenced: inside Phase D.
3. **The idemKey 4→2 flatten** — second pass, only after WO-22/24 are green.
4. **BG-8 decision** — the watcher tail re-architecture stays DEFERRED; I re-decide it from
   pilot logs, nobody builds it speculatively.
5. **The coach A-station, whole** (Unit 8): the three bus substrate fixes (shared metered
   transport w/ stop_reason+backoff, commit-only growth signature, callStrategy serialization)
   + turn accumulator + substance floor + the gated prompt wiring + fires-vs-ticks and
   one-tap-useful instrumentation — and the Unit-9 layered-UI core (read-along + chime card on
   the cockpit contract).
6. **Three diff reviews** — end of A+B, end of C+D, end of E+F. I review DIFFS, not the
   codebase; executors keep per-WO diffs clean so this stays cheap.

### MICKEY DOES — the human lane (nobody else may)
Service restarts and all commits · run WO-8's sweep against Atlas and the `sync-indexes` flip ·
eyeball WO-22's rectifier dry-run output before the delete (and later the dryRun-off flip) ·
kill running sessions before WO-27 deploys · every Load & Run session and its feels-right bar
(Units 1–6), the rep red-pen session (Unit 7), the live dev call (Unit 8), and recruiting Sean
for the Unit-9 pilot week · the WO-3 "escape hatch" trade is his to veto until WO-3 executes.

**Handoff protocol:** one report file per order at `docs/rewrite-reports/WO-<n>.md`, in THIS
format (uniform reports are what keep the big-guns reviews cheap):

```
WO-<n> — <title>          STATUS: DONE | STOPPED | PARTIAL
LEDGER: <before> → <after> (expected: <n>)   TYPECHECK: clean | n/a
EVIDENCE: <each DONE-WHEN check, one line each — grep cmd + hit count, test names added/
          deleted, line counts vs WO-0 baseline, fixture/evidence citations where required>
FILES: <every file touched>
STOPPED/NOTED: <anything tripped, anything adjacent spotted but NOT fixed (rule 6)>
ATTIC: <attic file(s) + what moved there; header complete per the attic template>
LIVE HITS: <grep command + hit count in packages/apps/scripts/tests (attic/ excluded) — must be 0 for the kill set>
```

I read reports continuously but only open diffs at the three checkpoints; anything STOPPED
lands in my queue, not theirs to solve. A report missing its EVIDENCE lines is an unfinished
order — same rule as a cut without its proof.

## WO-0 (before anything): capture the baseline

Run and RECORD in `docs/rewrite-reports/WO-0-baseline.md` (create the dir — all reports live
there):
1. `node --test tests/cx-bulk-load/*.test.js` → the pass count (was 296 on 2026-07-01; record
   what YOU see — that number is now **THE LEDGER** and every subsequent report updates it).
2. `npm run typecheck --workspace=web-client` → clean.
3. `wc -l` of the eight target files (runtime, runtimeService, both watchers, reservation
   service, dial-queue repo, state machine, CXWorkspaceBulkLoad.tsx) — the shrink benchmarks
   measure against THESE numbers, not the estimates in this doc.
4. Confirm Mickey has committed the working tree (Unit 0 in the sprint doc). If the tree is
   dirty, STOP — no order runs against an uncommitted baseline.

## Rules of engagement (every work order, no exceptions)

1. **One work order = one commit-sized diff.** Finish it, run THE GATE, report, stop. Mickey
   owns commits and service restarts — never restart `Parallel*`/NSSM services, never commit
   unasked.
2. **THE GATE** after every order:
   `node --test tests/cx-bulk-load/*.test.js` compared against THE LEDGER — the count goes UP
   (new pins) or stays; it goes DOWN only when the order explicitly disables/rewrites named
   tests, and then your report states the expected delta BEFORE you run the gate ("disabling 2
   manual-dial tests → ledger 296→294") and the actual must match the expected. Any surprise
   delta in either direction = STOP. Plus, for any order touching `apps/web-client`,
   `npm run typecheck --workspace=web-client`.
2a. **GREPS TARGET SYMBOLS, NEVER CONCEPT WORDS** (rule earned by the WO-1 stop): a DONE-WHEN
   grep pattern is built from the order's kill-set symbol names, not from a domain word like
   `firstTouch` or `staleServing` — domain words collide with live features that share
   vocabulary. If your grep hits a file outside the order's named FILES + kill set, that hit
   is a LIVE feature until proven otherwise: leave it, list it under LIVE HITS, and STOP if
   the order's DONE WHEN can't be met without touching it.
2a2. **INVERT, DON'T SKIP, shared tests** (pattern set by WO-1, now the standard): when a
   SHARED test file asserts behavior of a feature you're disabling, do not skip or delete the
   test — invert it into a negative pin ("X is ignored", "option arrives undefined", "no longer
   stamps"), prefixed `WO-<n>`, leaving every adjacent general assertion untouched. The
   disabled state becomes test-locked: accidental re-wiring fails the suite. Skip-gating is
   only for DEDICATED test files of the disabled feature.
2b. **ROLLBACK RULE:** if a human session (the sprint doc's feels-right bars) fails after your
   orders landed, the default is REVERT the suspect order's commit — never fix-forward on the
   floor's time. Mickey reverts; you get the report back with what broke; the order re-runs
   corrected. This is why one WO = one commit.
3. **The DO-NOT-CUT list at the bottom is law.** If your order seems to require modifying
   anything on it, you have misread the order — STOP.
4. **No physical deletes in this pass.** Disable, comment out, or hard-gate old paths instead
   of deleting them. Mark every disabled block with the WO number and `pending delete`, write
   the replacement/simple path, run the gate, and report the pending-delete inventory. If a test
   is intentionally disabled/commented, treat that as a ledger delta exactly like a deleted
   test: state the expected count change before running the gate. Permanent deletion happens
   only after proof and Mickey approval.
5. **No new abstractions.** You are removing indirection, not relocating it. If you feel the
   urge to add a helper/factory/adapter, STOP — that instinct is what this rewrite is cleaning
   up. Plain functions, plain requires, one owner.
6. **Scope discipline.** Touch only the files your order names. If you find an adjacent bug,
   note it in your report; don't fix it.
7. Tier meanings — 🟢 MECHANICAL: any competent agent; the steps are exhaustive.
   🟡 CAREFUL: decisions are pre-made but you're touching live logic — follow the steps
   exactly and the DONE WHEN checks are your proof. 🔴 BIG GUNS: reserved — do not attempt;
   listed so you know what to leave alone.

---

## PHASE A — Pool & supply (run in order WO-1 → WO-9)

### WO-1 🟢 Green-first-touch BULK path only — RESCOPED after executor stop (2026-07-02)
**What the stop found (correct):** `firstTouch` is two unrelated concepts. The LIVE one —
`firstTouchEligible` — is account/queue POLICY (fresh-lead eligibility in
`cxQueuePolicyService.js`, `cxLoadBalancerService.js`, `UserAccount`/`AgentState` models,
`accounts.js`, user-admin UI). Verified 2026-07-02: the bulk green cluster never reads it —
zero bridge. The DEAD one is the bulk green-first-touch supply feature, and it keys on its OWN
symbols. This order touches ONLY the kill set below.

**KILL SET (disable/hard-gate, mark `WO-1 pending delete`):**
- Files: `cxGreenFirstTouchQueueMaterializerService.js`, `cxGreenFirstTouchSupplyService.js`
  (gate each export to an inert stub; body commented with the WO-1 marker) + their exports in
  `packages/shared-services/src/index.js`.
- `cxDialQueueRepository.js`: `applyFirstTouchClaimFilter` → identity (returns the filter
  unchanged), `countReadyFirstTouchRows` → gated stub; the `firstTouchOnly` /
  `firstTouchMaxAttempts` claim options they fed.
- `cxQueueReservationService.js`: `firstTouchReleasePatch` → returns `{}`;
  `isFirstTouchReservation`, `shouldCountFirstTouchRelease` gated with it; the
  `firstTouchOnly`/`firstTouchMaxAttempts` reserve options.
- `cxBulkLoadRuntimeService.js` + `cxBulkLoadRuntime.js`: `normalizeFirstTouchSupplyPlan` +
  call sites; `firstTouch` fields on session/plan shapes stop being written.
- Metadata markers that only this feature writes: `greenCoverageBatchId`,
  `metadata.firstTouchOnly`, `firstTouchAttempts`, `firstTouchLastAttemptAt`.
- Env: `CX_GREEN_FIRST_TOUCH_BULK_ENABLED` references.
- Tests: skip-gate (`test.skip` + WO-1 marker) `cxGreenFirstTouchSupplyService.test.js`,
  `cxGreenFirstTouchQueueMaterializerService.test.js`, `cxDialQueueRepositoryFirstTouch.test.js`
  — declare the expected ledger delta BEFORE running the gate.

**LEAVE-ALONE SET (live hits, intentional — list them under LIVE HITS in the report):**
`firstTouchEligible` everywhere it appears: `cxQueuePolicyService.js`,
`cxLoadBalancerService.js`, `packages/shared-data/src/accounts.js`,
`shared-models/UserAccount.js`, `shared-models/AgentState.js`, `userAccountRepository.js`,
`apps/web-client/src/lib/api/types.ts`, `workspaces/users/UserForm.tsx`, `UsersWorkspace.tsx`
(+ the built asset). Touch none of them.

**DONE WHEN:**
1. `grep -rn "cxGreenFirstTouch\|CX_GREEN_FIRST_TOUCH\|greenCoverageBatchId\|firstTouchOnly\|firstTouchAttempts\|firstTouchMaxAttempts\|applyFirstTouchClaimFilter\|countReadyFirstTouchRows\|normalizeFirstTouchSupplyPlan\|firstTouchReleasePatch" packages apps scripts`
   → 0 LIVE hits (pending-delete comment blocks excluded, each carrying the WO-1 marker).
2. `grep -rc "firstTouchEligible" packages apps` → count UNCHANGED from the same grep run
   before your diff (record both numbers in the report).
3. THE GATE passes at the declared ledger delta.
**STOP IF:** any kill-set symbol turns out to be read by a file in the leave-alone set — that
would be the bridge we verified doesn't exist; report it.

### WO-2 🟢 Wood-chipper: the adoption path
**Why:** production hard-codes `resolveExternalCandidates: null` with a comment banning
adoption; zero producers, zero tests. All 8 scans agree. Decision final.
**Steps:** delete `markAdoptedCandidateServing` (`cxBulkLoadRuntime.js:970-1012`), the
`adoption`/`adopted-serving` branch + `externalCandidates` plumbing in
`cxAccountActiveCallWatcherService.js`, the `resolveExternalCandidates` pass-through
(runtime + service signatures + the hard-coded null).
**DONE WHEN:** `grep -rn "markAdoptedCandidateServing\|resolveExternalCandidates\|ringcx-active-external-id" packages apps`
→ 0 hits; THE GATE passes.

### WO-3 🟢 Wood-chipper: the manual-dial side door
**Why:** `/start-next` has zero callers; it's the only command path that writes `state.current`
without RingCX publish proof, and it forces the last phone-only matcher. Finish-plan B8
resolved: REMOVE. Decision final.
**Review note:** the lane may have served as a recovery hatch during wobble testing. The
SURVIVING hatch is `/get-leads` (on the DO-NOT-CUT list as "the standalone /get-leads recovery
button") — a wedged queue is recovered by asking for the next lead through the proven path,
never by staging an unproven current. That trade is accepted.
**Steps:**
0. Caller sweep beyond imports: grep `start-next` and `startNext` across `scripts/`,
   `.ai/context/`, `docs/`, and any `*.http`/`*.rest`/curl snippets. Code callers must be zero;
   doc/script mentions get updated to `/get-leads` in the same diff. If a REAL code caller
   surfaces, STOP.
1. Route: gate `/start-next` in `apps/control-plane/src/routes/cxBulkLoad.js` to return
   `410 { ok:false, code:"manual-dial-disabled", use:"/api/cx/bulk-load/get-leads" }` — a
   plain 404 would leave anyone with muscle-memory curl guessing; the 410 names the surviving
   hatch. (Under the no-delete override this IS the "removal"; the handler body goes into the
   WO-3 pending-delete block.)
2. Client: remove `useCxBulkLoadStartNext` from `apps/web-client/src/lib/api/queries/cxBulkLoad.ts`
   (defined, never imported) and the `manualStartPending` guard in `CXWorkspaceBulkLoad.tsx`.
3. Service: remove `startCxBulkLoadNextManualCall` (`cxBulkLoadRuntimeService.js:1075-1174`)
   and the 3 `manualStart*` candidate flags/stats stamps.
4. Runtime: remove the `manualDialer` adapter + `resolveBulkManualDialContext`
   (`cxBulkLoadRuntime.js:1202-1233`); fix the file-header comment that claims "no manual dial
   here" (it will finally be true — keep the corrected sentence).
5. Watcher: remove `findManualStartedActiveCall` (`cxAccountActiveCallWatcherService.js:140-156,
   201-207`) — dead-by-construction once nothing sets `manualStartPending`.
6. Delete the two tests that exist only for this lane (they're in the runtime-service and
   watcher test files — remove those test() blocks, not the files).
**DONE WHEN:** `grep -rn "startCxBulkLoadNextManualCall\|manualStartPending\|findManualStartedActiveCall\|start-next" packages apps`
→ 0 hits; THE GATE passes (count drops by exactly the deleted tests).

### WO-4 🟢 Wood-chipper: dead-code bundle
Each item is verified-dead (grep run 2026-07-01). **Bullet-by-bullet, never one mystery cut:**
delete one bullet, run its grep (expect 0 outside the deletion), run THE GATE, then the next
bullet. The report lists per-bullet: what was cut, the grep evidence, the suite count. If any
single bullet fails its grep or the gate, skip THAT bullet with a note and continue — don't
block the bundle.
- `normalizeBulkTerminalOutcome` (`cxBulkLoadRuntime.js:458-463`) — zero callers, verified.
- `renewReserved` + `renewClaim` (`cxQueueReservationService.js:200-227`,
  `cxDialQueueRepository.js:520-539`) + their test blocks — the code's own comment admits no
  caller.
- `findQueueItemsByRingcxExternIds` (`cxDialQueueRepository.js:656-694`) — zero refs.
- `watchCxBulkLoadSession` compat export + anything referencing it — no route, no caller.
- `MATCH_ORDER` export + the `agentLifecycleAdapter` watcher arg the watcher never reads.
- `previewCxTerminalRectification` — zero callers, duplicates default dry-run.
- `killActiveBulkLoadSessionsForAgent` — the second, worse kill (leaks RC buffers).
- `appendBulkLoadSessionEvent` + the `events` append-log substrate — zero callers.
- Always-null `releaseStatus`/`releaseAttempts` fields; the always-`'terminal'` `eventType`
  param on the outcome adapter; `fallbackRuntime` + `buildCxDialRuntimeMetadata` in
  `cxDialRuntimeModeService.js` (self-referential; DO NOT touch the rest of that file).
- Dead client knobs: `waitForRestore` mode, `input.hangup` passthrough, unused
  `useCxBulkLoadStart` if grep confirms zero imports.
**DONE WHEN:** each grep 0; THE GATE passes.

### WO-5 🟡 Supply flatten (decisions pre-made)
1. Collapse `releaseReserved` + `cancelReserved` into one `endReservation(rows, { to, reason })`
   — same CAS (`reservationSessionId` match), same stamps; the two old exports become two-line
   wrappers ONLY if >3 call sites would churn, else update call sites and delete both names.
2. Flatten `cxReserveModeService.js` to the 4-line mix map (the `RC_CX_RESERVE_MODE` /
   aged-floor knobs are set nowhere — live box verified). Keep the exported function signature.
3. Collapse the nested family loops in the reservation service: pre-cap targets, call
   `reserveReadyRows` ONCE per refill.
4. Shared filter builder for `listQueueItems`/`countQueueItems`; normalize the four spellings
   of "no limit" to one.
5. Flatten the reaper `$or` triplets to `$in: [null, ""]` — the invariant test
   (`reaperOwnershipExclusion.test.js`) was BUILT to survive exactly this change; if it fails,
   your change altered selection, not spelling — STOP and revert.
6. Move the claim-time UCQ interlock (`assertNotActiveInUcq`) into the publish gate next to
   `findActiveSibling` — ONE check, publish-time; delete the third construction site's silent
   no-op. (Blessed: milliseconds-wider window vs the vestigial UCQ pool.) Add a publish-gate
   test: a case active in UCQ is rejected AT PUBLISH.
**PARITY FIXTURE (required — this order changes reservation mechanics, not just dead code):**
BEFORE steps 3/6, write a fixture test that seeds a mixed pool (all four families, varied
`queueFamilyRank`/`createdAt`) and records exactly which rows — and in what order — a refill
reserves under CURRENT code. Steps 3 and 6 must leave that fixture green unchanged: same rows,
same order. If the collapse changes the selection, your pre-cap math is wrong — STOP and
report, don't adjust the fixture.
**DONE WHEN:** parity fixture green before AND after; publish-gate test green; THE GATE passes;
`cxQueueReservationService.js` + `cxReserveModeService.js` combined shrink ≥80 lines.
**DO NOT:** touch `reserveReadyRows` internals, `TOUCH_BALANCED_QUEUE_SORT`, the 16-field claim
stamp reset, or the reaper's reservation exclusion SELECTION.

### WO-6 🟡 Cadence-dedupe guard (fix B2)
In `cxCadenceService.js:2118-2137`: the dedupe patch replaces `metadata` wholesale from a stale
read. Change to dotted-key updates (`"metadata.actionKey": ...` etc.) so unrelated keys —
above all `metadata.reservationSessionId` and the publish stamps — survive. Additionally, skip
the patch entirely when the existing row is `claimed`/`serving` with a `reservationSessionId`
(the bulk rail owns it). Also delete the four `needs*` diff booleans in that block — always
patch the dotted keys. KEEP the appointment-hold early-return and the release state guard.
**Pin it:** add a test — legacy re-enqueue on a reserved row must not strip its lease.
**DONE WHEN:** new test green; THE GATE passes.

### WO-7 🟡 Loader → API route
Rewrite `scripts/local-ordered-mickey-bulk-load.js`: it now ONLY (a) seeds `CxDialQueue` rows
as `ready` with test metadata, (b) calls `POST /api/cx/bulk-load/start` (route exists at
`apps/control-plane/src/routes/cxBulkLoad.js:49`) so reservation + publish run the production
path with the production full-queueItemId extern shape. Delete the script's direct-`$set`
claiming, hand-rolled session lifecycle, and the 8-char extern builder. Keep its CLI shape
(`--agent`, count) so Mickey's muscle memory works.
**DONE WHEN:** script runs against a local stack and the created session's rows all carry
`metadata.reservationSessionId` + full-shape externs (assert in-script, print a summary table);
`grep -n "slice(-8)" scripts/local-ordered-mickey-bulk-load.js` → 0.

### WO-8 🟢 Dup-sweep + index sync (ops caveat #2)
Write `scripts/cx-bulk-session-dup-sweep.js`: finds agents with >1 `running`
`CxBulkLoadSession`, kills all but the newest (via the EXISTING `killCxBulkLoadSession` path —
not raw deletes), prints before/after counts, exits nonzero if dups remain; then (guarded by
`--sync`) runs `node scripts/sync-indexes.js CxBulkLoadSession` and verifies
`uniq_running_session_per_agent` exists via `listIndexes`, exiting nonzero if not. Self-verifying
— no manual steps in the middle.
**DONE WHEN:** script exists, `node --check` clean, dry-run mode prints and exits 0 on a clean
DB. (Mickey runs it against Atlas.)

### WO-9 🟢 The microscope: `scripts/cx-bulk-session-inspect.js`
Read-only. Prints for an agent (`--agent email` | `--session id`): session id/status/phase,
acceptedBuffer (queueItemId, state, externId), the session's reserved `CxDialQueue` rows
(state, `reservationSessionId`, `lastRingcxPublishedExternId`), and last 10 terminal-outbox
rows (status, idemKey). Mask phones through the EXISTING sanitize helpers (grep
`sanitizeSession` / `maskPhoneForLog` — reuse, don't write new masking). `--json` flag for raw.
**DONE WHEN:** runs read-only against local Mongo; zero unmasked phone digits in default output.

---

## PHASE B — Proof (WO-10 → WO-13)

### WO-10 🟡 Release debounce (fix B5) — includes a sanctioned test rewrite
**Decision:** one empty/partial poll must NOT kill a live current. Two consecutive miss ticks
required.
**Steps:**
1. In `cxBulkLoadActiveCallWatcher.js` (`deriveCurrentRelease`, :179+ and the buffered-release
   twin): require the extern to be absent in TWO consecutive polls before emitting the release
   (carry a `missedOnce` marker on the candidate/current between ticks — it lives in the
   watcher's own prev-state, NOT on the session doc).
2. The test at `cxAccountActiveCallWatcherService.test.js:125` pins the OLD one-tick behavior.
   Rewrite it: first miss-tick → no release, marker set; second consecutive miss → release.
   Add the counter-case: miss then reappear → marker cleared, call still current.
**DONE WHEN:** both new tests green; THE GATE passes. The release still happens (two ticks ≈
2s) — do NOT debounce longer.
**DO NOT:** touch `deriveReleasedCandidates`' prevActive diff mechanics beyond the marker.

### WO-11 🟡 Stamp-miss escalation (fix B4) + emission test
1. In `cxAccountActiveCallWatcherService.js` (:748-772 region): count consecutive
   `serving_stamp.missed` per queueItemId (watcher-local map); at N=5 consecutive, emit ONE
   `logger.error("cx.bulk.serving_stamp.stuck", {queueItemId, ticks})` and write the reason
   into the session trace field the UI already reads. Reset the counter on success or candidate
   removal.
2. Test: assert `cx.alpha.watch.serving_stamp.missed` EMITS on a CAS miss (zero test hits
   today), and the stuck-escalation fires at N.
**DONE WHEN:** tests green; THE GATE passes.

### WO-12 🟢 Watcher small game
- One owner for review-hold duration: single env parse + one `buildReviewHoldUntil`; delete the
  other two copies + the `options.reviewHoldMs` knob (no caller passes it). Rename ONE side of
  the double-meaning `CX_BULK_LOAD_PROGRESSIVE_PAUSE_MS` (the review-hold use becomes
  `CX_BULK_LOAD_REVIEW_HOLD_MS`, default unchanged; keep reading the old name as fallback with
  a deprecation comment).
- Delete the second terminal-proof re-check in `persistTerminalObservations` (all three
  producers gate at the push site) and the `beforePersist` eligibility re-derivation call site
  (KEEP `cxBulkLoadMutationEligibility.js` itself — it is law).
- Flatten `extractActiveCallList` envelope shapes — **EVIDENCE FIRST**: before cutting,
  collect the actual shapes: grep recorded active-call payloads in `runtime/` ndjson + alpha
  traces (and/or add a one-day shape-counter log line and read it after a local session). If
  the evidence shows only 2 of the 5 shapes occur, flatten to those 2 and note the evidence in
  the diff; if the evidence is inconclusive or a third shape appears, KEEP all shapes and
  report — this bullet becomes a no-op. Keep the retryable-error throws either way.
- Merge `compactActiveCall`/`normalizeActiveCall` into the pure module's one normalizer.
**DONE WHEN:** THE GATE passes; greps for the deleted names → 0; the envelope flatten (if done)
cites its evidence in the report.

### WO-13 🟡 Real-CAS-shape tests (pin, no behavior change)
Add tests driving `markCandidatePublished`/`markCandidateServing` against a RECORDED
`transitionQueueItemState` (capture the exact filter object): assert fromStates
(`['claimed','serving']` / `['claimed']`) and the `{'metadata.reservationSessionId': sessionId}`
match option are present verbatim. This is the lock on the loop's central invariant — a
loosened match string must fail a test, not a floor.
**DONE WHEN:** tests green against current code (they describe what IS, and pin it).

---

## PHASE C — Button & UI (WO-14 → WO-21; WO-16 is BIG GUNS — skip it)

### WO-14 🟢 Un-fork the legacy panel mirror (BG-1 — MOVE, not delete)
Only 386 of ~3,430 lines differ between `CXWorkspaceBulkLoad.tsx:100-3526` and
`CXWorkspace.tsx:100-3530`; both mount exclusively via the mode router.
**Steps:**
1. Create `apps/web-client/src/workspaces/cx/panels/` and extract the shared case-side panels
   (Tasks, Activities, Invoices, Payments, CommLog, Logics, Appointment) as components taking
   the props they already take (`domain`, `caseId`, `phone`, plus the handful of callbacks —
   preserve exact prop shapes; where the 386 differing lines diverge, parameterize with a prop,
   defaulting to legacy behavior).
2. Point BOTH workspaces at the shared panels. Byte-identical rendering is the bar — this is a
   refactor with zero behavior change.
**DONE WHEN:** typecheck clean; both workspaces render (dev server spot-check); combined line
count of the two workspace files drops ≥3,000; no `panels/` component imports workspace state
(props only).
**STOP IF:** a panel turns out to read workspace-local state directly (not via props) — report
which, don't invent a context.

### WO-15 🟢 Wood-chipper: the three literal-false UI rails (BG-2)
All three kill switches are hardcoded literals with zero writers; the router already serves the
legacy rail via `CXWorkspace.tsx`. Decision final.
1. `legacyQueueEnabled = false` (`CXWorkspaceBulkLoad.tsx:3848`): delete the flag and every
   branch it gates — the legacy queue-serving rail, its suppression machinery, auto-serve
   subsystem, **the 20s "Queue recovered" stale-served watchdog (:5536-5563 — this delete IS
   finish-plan fix B1)**, queue-family taxonomy, the non-bulk appointment branch.
2. `simpleLoopPanelEnabled = false` (:3858): delete the panel + plumbing.
3. `leadLookupCaseId = null` / `leadLookupPhone = ""` (:4230-4231): delete the lookup/scramble
   ladder.
**DONE WHEN:** typecheck clean; `grep -n "legacyQueueEnabled\|simpleLoopPanelEnabled\|leadLookupCaseId" CXWorkspaceBulkLoad.tsx`
→ 0; the file shrinks ~1,900-2,000 lines; the bulk loop (start/dispose/get-leads) still
compiles against the session poll; **eslint react-hooks rules clean on the file** (this file is
hook-dense — a deleted branch that orphans a hook dependency or changes effect wiring must
surface here, not on the floor); **visual smoke test**: dev server up, load the bulk workspace,
confirm it renders and start/get-leads buttons appear (no session needed — render is the test).
**STOP IF:** any deleted symbol is imported elsewhere — report, don't stub. STOP IF a hook or
effect you're deleting is READ by surviving code (state consumed outside the dead rail) —
report the entanglement.

### WO-16 🔴 BIG GUNS — the projector rewrite (BG-6). DO NOT ATTEMPT.
The 9-atom mirror effect, display ladder + latch + 250ms ticker, and the parallel toast/timer
machine get replaced by one pure projection module (`bulkLoadProjection.ts`) + ~100 lines of
render wiring, with manual-vs-auto review suppression moving server-side. Reserved because it
rewrites the UI's state semantics. Executors: after WO-15, leave the remaining state layer
EXACTLY as is for the big guns.
**THE DESIGN LAW (Mickey, 2026-07-02 — supersedes the correction-card and banner concepts):**
less visual disturbance, fewer UI cases — this is an app for agents who should never have to
think about the app. ONE FIXED LAYOUT; nothing appears, disappears, or moves. Three slots:
1. **Lead slot** — always shows a lead at the same size: the live current in full color, or
   the LAST lead greyed between calls. Greyed IS the between-calls state. Never blank, never
   a "no one" state, never a card.
2. **Button row** — the SAME terminal buttons, always, same place. After an auto-release (the
   Joe case) the buttons keep working against the greyed lead; the click carries that lead's
   identity and the SERVER routes it to WO-31's correction lane. The agent has exactly one
   flow: click what happened, even if the call already dropped. No click = keep the recorded
   outcome; the next call replaces the grey lead. There is NO separate correction card/modal.
3. **Status line** — one fixed line, one plain sentence, the ONLY place words happen: "On call
   with Peggy" / "Call ended — you can still mark Joe" / "Dialing the next lead…" / "This call
   isn't from your list" (the Jennie case — consumes WO-31's unowned enrichment; no banner
   component). Plain words, what's true + what to do; never why, never system vocabulary.
No toasts in bulk-mode normal flow — toasts are for real errors only.
**THE MODAL LAYER (Mickey, 2026-07-02): the base screen stays calm; the few genuine
decision/context-switch moments are MODALS — a CLOSED inventory, one at a time, fired only at
call boundaries, each a row in the projection table test. No new modal without a design ruling.**
- **M1 Wrap-up** — fires ONLY when a CONNECTED call (had UII, ACTIVE state — not ringing)
  released without a manual terminal. Buttons: DNC · Voicemail · Schedule (retroactive
  callback/appointment, via WO-31's extended correction lane) · Keep. A never-connected drop
  fires NOTHING (status line only) — that anti-badger guard is load-bearing.
- **M2 New-lead alert** — fires when the call being served to THIS agent is not from the bulk
  list (first-touch interrupt / fresh lead / other queue): shows who + provenance ("brand-new
  lead — web form"), one acknowledge button. Consumes WO-31 3b's enrichment (which must carry
  a provenance label). The Jennie-style merely-observational case (call not served as workable)
  stays on the status line, no modal.
- **M3 Appointment wrap** — the existing flow, unchanged.
`bulkLoadProjection.ts` is a pure function: (session, accountSnapshot) →
{leadSlot, buttonsEnabledFor, statusLine, modal|null}; the table test enumerates every state
including all field cases and every modal firing rule (esp. M1's connected-only guard).

### WO-17 🟡 Disposition carries identity (fix B7)
Contract (final, amended 2026-07-02 for the one-flow design law): client sends
`{ sessionId, disposition, queueItemId, uii }` from the DISPLAYED lead (live or greyed).
Server (`runtimeService` disposition command) routes three ways:
1. Matches `state.current` → normal terminal disposition (today's path).
2. No current (or mismatch) but matches the session's `lastOutcome` identity → route to the
   WO-31 correction lane (this is how the same button row corrects the Joe case — the UI never
   knows the difference).
3. Matches neither → `{ ok:false, code:"stale-click" }`; the UI ignores it silently (log
   server-side; the display has already moved on — no toast, this is a sub-second race, not an
   agent error).
Tests: all three routes; mismatch never writes a normal terminal outcome; back-compat tick for
an identity-less client (old build mid-deploy) accepts as today with a deprecation log.
**DONE WHEN:** tests green; THE GATE passes.

### WO-18 🟢 Client small game
- AbortSignal timeout on the `ringcxVoiceClient` bare fetch (:447) — 8s default, env override;
  a timeout surfaces as the existing retryable error shape (fix B10).
- Auto-clear the "Finishing current lead" transition after 10s or on next session poll showing
  a new current (fix B14) — timer cleared on unmount.
- Collapse the two client mutation factories + twin side-effect types → one factory, one type.
- `handleAppointmentSubmit`: delete the dead non-bulk branch; six-toast ladder → one summary
  toast.
- Collapse the third env-route resolver copy (`cxBulkLoadRuntime.js:247-282`) into the
  `cxWorkspaceService` implementation.
**DONE WHEN:** typecheck + THE GATE.

### WO-19 🟡 Review suppression moves server-side (fix B16's real home)
Decision (final): the SERVER decides review-hold. Accepted MANUAL terminal disposition patch
carries `reviewHoldUntil: null, reviewHoldReason: null` explicitly; ONLY the watcher's
auto-drained release path sets `reviewHoldReason: "ringcx-current-released"`. Add both
assertions as tests (accepted-manual → nulls; released-without-manual → reason set). The UI
keeps only the server fact: `reviewHoldReason === "ringcx-current-released"`. WO-16's
projector decides how that fact appears in the fixed lead slot/status line/modal inventory;
executors do not add a correction card here. Delete the client-side manual-terminal ref
machinery ONLY if WO-16 has landed (it owns that cleanup); otherwise leave the client untouched.
**DONE WHEN:** two server tests green; THE GATE passes.

### WO-20 🟡 Pause self-heal + honest skip
- Progressive-pause restore (fix B9): on restore failure (`cxBulkLoadRuntime.js:392-399,
  1152-1167`) retry once after 2s; if still failed, set a `pauseRestoreFailed` marker the
  watcher tick checks — watcher forces available when `now > pausedAt + pauseMs + 15s` grace,
  logging `cx.bulk.pause_restore_recovered`. KEEP the supersede-token map untouched.
- Skip (fix B12): when `state.current.uii` is live-proven, `skipCxBulkLoadCurrent` first sends
  the same RingCX disposition/hangup path as no-answer (reuse the executor — no new path), and
  only then advances; if the executor rejects, the skip is rejected.
**DONE WHEN:** tests for both (restore-fail → recovered; skip-on-live → RC executor called);
THE GATE passes.

### WO-21 🟡 The real-terminal-executor test suite (the loop's padlock)
Build the disposition tests against the REAL executor (`cxBulkLoadRuntime.js:1112-1198`) with
only the HTTP transport faked (record requests, script responses):
1. RingCX 200-accept + hangup-probe OK → `dispositionStatus:"accepted"`, advance.
2. 200-accept + probe THROWS → still accepted (probe is best-effort).
3. 200-accept + probe hangs → accepted within the WO-18 timeout.
4. 200-accept + a follow-up watcher tick still showing the disposed UII (stale poll) → tick
   neither vetoes the advance nor re-promotes the disposed call.
5. RingCX 4xx/5xx → `ok:false`, NO outcome written, current retryable.
6. Transport throw → same as 5.
**Why it matters:** today every disposition test stubs the executor — a re-added "still active"
veto would pass the suite. This padlocks the July-1 regression point forever.
**DONE WHEN:** all six green; THE GATE passes.

---

## PHASE D — Record (WO-22 → WO-25; WO-23 is BIG GUNS — skip it)

### WO-22 🟡 One janitor (BG-4)
1. TRANSPLANT FIRST: port the stale-serving reconciler's externId-first still-active match
   (`cxStaleServingReconcilerService.js:233` region) into `cxTerminalRectificationService.js`
   as its still-active guard (a candidate row whose externId appears in a fresh active-call
   snapshot is SKIPPED, fail-closed).
2. Port the reconciler's classification tests that still apply to the rectifier's new guard
   (still-active → skip; gone + no outbox evidence → candidate).
3. **DRY-RUN PROOF before the chipper:** run the rectifier enabled+dryRun against local data
   containing at least one manufactured stale shell (serve a row, end the RC call with no
   outbox write). The dry-run output must classify it as a candidate and skip everything else.
   Save the output in the report. Mickey eyeballs it. ONLY THEN:
4. Wood-chipper: delete `cxStaleServingReconcilerService.js` (496),
   `scripts/cx-stale-serving-diagnostic.js` (151), `tests/cx-bulk-load/cxStaleServingReconciler.test.js`
   (313).
**DONE WHEN:** rectifier tests green incl. the ported guard; the dry-run proof is in the
report; `grep -rn "cxStaleServingReconciler\|classifyStaleServingRow\|resolveServingIdentity\|runStaleServingDiagnosticOnce\|cx-stale-serving-diagnostic" packages scripts tests`
→ 0 LIVE hits; THE GATE passes. **LEAVE ALONE (live, intentional):**
`requeueStaleServingQueueItems` + `RC_CX_STALE_SERVING_MINUTES` +
`RC_CX_RELEASE_STALE_SERVING_ENABLED` in `cxCadenceService.js` and its ringcentral-cx wiring —
that is the LEGACY rail's only serving-row freer and it survives until floor cutover; list it
under LIVE HITS. (Flipping `HOURLY_CX_TERMINAL_RECTIFICATION_ENABLED` + dry-run off stays
Mickey's call.)

### WO-23 🔴 BIG GUNS — the cadence crossing (BG-10). DO NOT ATTEMPT.
Characterization test over `handleCxTerminalCallOutcome`, then extraction of
`applyCxTerminalOutcome` + deletion of the three bulk-only carve-outs + gating the EX-era
agent-state kick off for bulk rows. Reserved: the handler is a branch farm with no end-to-end
pin; wrong cuts here corrupt cadence bookkeeping silently.

### WO-24 🟡 Drain + terminal hygiene
- Attempts cap on the outbox drain (fix B20): `attempts` increment per failed drain; at 5 →
  status `dead`, excluded from `listPendingForDrain` (`cxTerminalOutboxRepository.js:28-35`),
  surfaced as a count in the drain tick log + worker health.
- `terminal_record_deferred` (ops caveat #8): unconditional `logger.error` (not trace-gated) +
  counter on worker health (`cxBulkLoadRuntimeService.js:1029-1035`).
- Kill-path deferred marker (fix B23): replace `.catch(() => null)`
  (`cxBulkLoadRuntimeService.js:1231-1241`) with the SAME deferred-marker pattern the
  disposition path uses.
- Small game: evidence taxonomy strong/medium/weak/ignore → insert|skip + reason; collapse the
  drain's twin note/wrap hook blocks → one `runHook` helper (ordering preserved — the fail-soft
  isolation tests must stay green); rectifier `run(options, deps)` signature; delete the
  `maxAgeMs` algebra + `activeUiis` knob nobody sets.
**DONE WHEN:** new tests (cap → dead + excluded; deferred → logged unconditionally); THE GATE
passes.
**DO NOT:** touch `makeOutcomeIdemKey` shapes or `buildTerminalEvidenceKeys` — the idemKey
flatten is explicitly second-pass, not in this order.

### WO-25 🟡 Idle-session reaper
New small module or a block in the existing hourly sweeper: running `CxBulkLoadSession` with no
`updatedAt` movement for 45 min (env `CX_BULK_SESSION_IDLE_KILL_MIN`) → kill via the EXISTING
`killCxBulkLoadSession` (which releases reservations + cancels RC leads). Log per kill. Test
with injected clock.
**DONE WHEN:** test green; THE GATE passes.

### WO-31 🟡 The released-call correction lane — server half (added 2026-07-02, field evidence)
**Why (the Joe case, reproduced live):** RingCX released a proven current before the agent
could choose Voicemail; the watcher honestly recorded `did_not_connect`
(`source: active-call-release`), cleared current, the loop advanced — correct — but the agent
had NO way to correct the label afterward. The fix is NOT to loosen matching, adopt non-bulk
calls, or delay the release path (that re-adds the veto class we removed). It's a correction
lane. **Field evidence supersedes the earlier "DNC-only correction" direction.**
**DESIGN DECISIONS (final; amended 2026-07-02 for the modal layer):**
- Corrections are LABEL + COMPLIANCE + FORWARD-SCHEDULING, never cadence rewinds. The original
  outcome already drained; a correction updates the recorded outcome (DNC stays absorbing) but
  never re-times or re-steps the queue row retroactively. `schedule` CREATES a forward action —
  a callback/appointment for the released lead — routed through the EXISTING appointment/
  callback machinery (`submitCxBulkLoadAppointmentWrap` / callback queue timing) keyed to the
  `lastOutcome` identity, NOT a new scheduling path.
- Correctable outcomes: `voicemail` | `dnc` | `schedule{kind, at}`. (Keep/dismiss writes
  nothing.)
- Only the session's LAST auto-released call is correctable; a new release replaces it.
- Enrichment (step 3b) carries a PROVENANCE label per active call (bulk | first-touch | legacy |
  fresh) so the M2 new-lead modal can say what's coming in.
**Steps:**
1. Generalize the existing review-DNC correction in `cxBulkLoadOutcomeAdapter.js`
   (`buildReviewCorrectionRow`, the separate `review-dnc` idemKey lane) into a
   `review-correction` lane parameterized by outcome (`voicemail` | `dnc`) — SEPARATE outbox
   row, distinct idemKey per correction type, never mutating the original terminal row (the #4
   design is law).
2. Drain side (`cxTerminalOutboxDrain` → `handleCxTerminalCallOutcome` path): a
   `review-correction` row updates the recorded outcome label on the terminal record/CallLog
   surface + DNC absorbing effects; NO cadence re-step. Keep it inside the existing drain hook
   isolation (a correction failure must not fail other rows).
3. Server state: the disposition/watch payload already carries `lastOutcome` +
   `reviewHoldReason` — ensure the released-call's identity (queueItemId, uii, outcome, at)
   survives on the session (`lastOutcome`) so WO-16 can keep the fixed lead slot/button-row
   usable AFTER current is cleared and the next call is live.
3b. **Unowned-call visibility (added 2026-07-02 — "don't adopt" must not mean "don't show"):**
   enrich the `/session` READ response with the account watcher's last in-memory active-call
   snapshot for this agent, each call labeled `owned` (matches the session's current/buffer) or
   `unowned` (e.g. a legacy `parallel:*` call). READ-TIME COMPOSITION ONLY — never persisted to
   the session doc (no per-tick writes for display data; capture stays observational per the
   06-17 incident rule). No adoption affordance rides this field, on the server or in any
   client type. Test: an unowned active call appears in the response, produces zero session
   writes, and cannot be dispositioned (identity check from WO-17 rejects it).
4. Tests: correction row for voicemail lands with its own idemKey (no collision with the
   original `did_not_connect` row or a dnc correction); double-submit dedups; correction after
   a NEWER release is rejected (`stale-correction`); drain applies label-only.
**DONE WHEN:** tests green; THE GATE passes. There is NO correction card or banner — the UI half
is WO-16's fixed button-row + status-line + closed modal inventory (big guns); executors do NOT
build UI for this. Note WO-17's amended three-way routing is the entry point into this lane.
**DO NOT:** touch the release path's timing, the watcher's release detection, or
`makeOutcomeIdemKey`'s existing shapes (extend, don't reshape — the 4→2 flatten stays mine).

---

## PHASE E — Room (WO-26 → WO-28)

### WO-26 🟡 DI ceremony collapse (BG-9)
In `cxBulkLoadRuntime.js`: require `reduce`/the pure watcher/`buildExternId`+
`buildExternSessionToken`/the publisher directly (every seam has exactly one production
implementation — tests already inject real modules); delete the two REQUIRED-but-never-read
deps (`leadSource`, `listReadyQueueItems` — the harness itself confesses); delete 2/3 of
`cxBulkLoadLeadSourceService.js` keeping only the two extern builders (~40 lines); delete the
watcher DI seam + interface-probe feature detection (a probe-miss silently disables release
detection — worse than dead); delete the `agentLifecycleAdapter.pauseProgressiveDialing`
phantom seam, pass `clearTerminalHold` as one function.
**DONE WHEN:** `getService()` under 300 lines (from 517); THE GATE passes with test fakes
updated mechanically (same shapes, fewer layers).
**DO NOT:** merge runtime and runtimeService — the wall stays.

### WO-27 🟡 State-shape shrink
**SEQUENCING (hard rule from review):** this order runs LAST of the 🟡 set — only after the
Unit-3 and Unit-4 human bars are met (the loop is stable). It is the largest saved-data
compatibility surface in the plan.
**COMPATIBILITY RULE:** existing Mongo `CxBulkLoadSession` docs carry the old fields. Reads
must TOLERATE old shapes forever (the loader/`sanitizeSession` normalizes old `phase` values,
ignores `events`/`lastOutcome`/dead stats on load); writes stop producing them. Never a
migration script — tolerate-and-stop-writing. Deploy note for Mickey: kill running sessions
before this lands (the idle reaper from WO-25 makes that a one-liner), so no live session
straddles the shape change.
All pre-decided; the reducer's table tests are the net — extend them first where a case is
untested, then cut:
- Delete 4 reducer events nothing emits (`watch.started`, `current.cleared`,
  `session.completed`, `failed`) + the unreachable statuses/phases/`completedAt` they gate.
- `phase`: 10-value enum → 4 values DERIVED in `sanitizeSession` (idle/dialing/wrapping/done);
  repoint the ~13 label assertions.
- Delete `buffer.preload_started`/`refill_started` (state copied into itself) and
  `agent.waiting_offhook`/`offhook_ready` (result used inline).
- Collapse `terminal.accepted`/`current.released`/`buffer.released` → one
  `call.completed{source}` event (reducer + all three emitters + tests).
- Per-item `phase` AND `status` → keep `status`. Flat + nested-ringcx duplicate fields → one.
  `lastOutcome` → derive `completed.at(-1)` at projection. Delete write-only
  `stats.acceptedCount`/`failedPublishCount`.
- One typed watcher-owned `prevActiveCalls` field; the reducer loses the `trace` grab-bag
  (**the prevActive diff data itself SURVIVES — it is the release-detection anchor**).
- Persisted session fields 15 → ~8 (`sanitizeSession` derives the rest).
**DONE WHEN:** reducer test table covers every surviving event; THE GATE passes;
`cxBulkLoadStateMachine.js` ≤ 220 lines.
**STOP IF:** any "unreachable" event turns out to have an emitter your grep finds — report it.

### WO-28 🟡 EX made explicit
- Replace the commented-out webhook body in the EX path with an explicit mode-gated no-op
  (env/cx-only gate) — comment-disable silently reverts on merge.
- Add the lifecycle gate INSIDE `processPresenceEnvelope` (return `{skipped:"cx-only"}` with
  zero persists/reconcilers when off) — protects every entry point.
- Surface `{ cxRuntimeMode, exPresencePollMode, exWebhookState }` on the bulk `/session`
  response; render the triple in the bulk workspace header (small grey text).
- `/ringbridge/agent-state`: grep + report callers; if zero, delete the route (report first if
  any doubt).
- Update `.ai/context/CX_BULK_LOCAL_TEST_WORKFLOW_2026-07-01.md:169` (stale claim that the
  webhook still writes).
**DONE WHEN:** EX gate tests (bulk-alpha ⇒ poll off + zero repo writes) live in
tests/cx-bulk-load/; THE GATE passes; header shows the modes.

---

## PHASE F — Acceptance & timed cuts (WO-29 → WO-30)

### WO-29 🟡 `scripts/cx-loop-acceptance.js`
Machine gates, exit nonzero on any failure: (1) first buffer item's extern matches CX-side
(via the WO-9 inspect internals); (2) a scripted no-answer round-trip advances within 5s;
(3) accepted-manual left `reviewHoldReason` null; (4) `terminal_record_deferred` counter zero;
(5) zero `ex.presence|ex.poll|ex.webhook` log lines in the window; (6) reconciler startup
`released:0`. Reuse WO-9's readers.
**DONE WHEN:** runs green against a healthy local loop; each gate individually forceable to red.

### WO-30 🟢 Timed trace cuts
**The dividing line (review-sharpened):** anything that helps answer *"no-answer did not end
the call — why?"* lives until AFTER acceptance. That means the runtime's disposition + hangup-
probe DISPTRACE lines and the transport-boundary probes are UNTOUCHABLE in the now-half.
NOW (duplicates and noise only): delete the runtime-service DISPTRACE copy (~32 — it duplicates
the runtime's, which stays) and the flow-trace 6-events-per-refill +
`CX_BULK_LOAD_FLOW_TRACE_AGENT` knob (~80 — refill forensics, not disposition forensics).
AFTER ACCEPTANCE (Unit 6 green — do not jump the gun): runtime DISPTRACE + the 4 unref'd probe
timers (`cxBulkLoadRuntime.js:69-140,185-232,1078-1178` — KEEP the post-dispo `hangupCall`
behavior as ~12 plain lines), `cxAlphaTraceService` + its 19 call sites, `emitCxTiming` UI
scaffolding.
**DONE WHEN (now-half):** `grep -n "DISPTRACE" packages/shared-services/src/cxBulkLoadRuntimeService.js`
→ 0 LIVE hits (the runtime file's DISPTRACE SURVIVES — do not grep it to zero repo-wide);
`grep -rn "CX_BULK_LOAD_FLOW_TRACE_AGENT\|flow-trace" packages apps` → 0 LIVE hits; the runtime
DISPTRACE still logs a disposition round-trip end-to-end (run one scripted disposition and see
it); THE GATE passes.

---

## 🔴 BIG GUNS — reserved tasks (everyone else: hands off)

1. **WO-16 · The projector rewrite** — `bulkLoadProjection.ts` + the slim state layer replacing
   the mirror effect/display ladder/latch/ticker; lands AFTER WO-14/WO-15, WITH WO-19's
   server-side suppression. Produces the first web-client test file as its own pin.
2. **WO-23 · The cadence crossing** — characterization test over `handleCxTerminalCallOutcome`,
   then the `applyCxTerminalOutcome` extraction + bulk carve-out deletion + EX-kick gating.
3. **BG-8 · The watcher tail re-architecture** — DEFERRED, default is DON'T. Revisit only if
   the pilot shows version-miss churn in the logs.
4. **The idemKey 4→2 flatten** — second pass after WO-22/WO-24 are green; reshapes the #12 fix;
   writer + `buildTerminalEvidenceKeys` mirror move in lockstep.
5. **Unit 8 · The coach A-station** (whole thing: substrate fixes, turn accumulator + substance
   floor, window, pilot logging) — different half of the product, same rule: big guns only.
6. **Phase review** — big guns review the DIFFS (not the code) at three checkpoints: end of
   Phase A+B, end of Phase C+D, end of Phase E+F. Executors: keep per-WO diffs clean so the
   review is cheap.

## DO-NOT-CUT (law — from the full scan; if your order collides with this list, STOP)

Reaper reservation ownership-exclusion selection · `reserveReadyRows` find→updateMany→re-read +
FM-10 retry · the 16-field claim stamp reset · `TOUCH_BALANCED_QUEUE_SORT` ·
`metadata.reservationRail` · reservationSessionId CAS on every release/cancel · the outbox
insertOnce + fallback double-fault chain · `buildTerminalEvidenceKeys` co-located with the key
writer · rectifier fail-closed skip ladder · review-dnc as a SEPARATE outbox row ·
`cxBulkLoadMutationEligibility.js` · drain fail-soft hook isolation · `withSessionOperation`
serializer + `markSessionBusy` · E11000 retire→retry→recover + the partial-unique index ·
kill's two-source reserved sweep · fillBuffer's fail-closed ladder + DNC eligibility gate ·
the prevActive diff release detection · the no-phone-matching rule · progressive-pause
supersede map + `isAlreadyEndedHangupError` · `isBulkLoginOffhook` fail-closed +
`assertBulkRuntime` 403 gate · serving-CAS-before-session-write + departing-call terminal
flush · cx-synth UII filter · per-account single-snapshot fan-out · the review-hold CONCEPT ·
the 1s UI session poll · uii-gated disposition buttons · `pushCompletedOnce` + `clonePlain` +
expectedVersion CAS · the runtime/runtimeService wall itself.

## Execution order & checkpoints

| Order | WOs | Lane | Checkpoint |
|---|---|---|---|
| 1 | WO-1..4 (chippers) | THEY | greps 0, GATE green |
| 2 | WO-5..9 (pool) | THEY | MICKEY: Unit-1 session + Atlas sweep |
| 3 | WO-10..13 (proof) | THEY | MICKEY: Unit-2 session · **ME: diff review #1** |
| 4 | WO-14..15 (UI chippers) | THEY | typecheck + render smoke |
| 5 | **WO-16 = ME** + WO-17, 31, 18..21 = THEY | split | MICKEY: Unit-3 session (incl. Joe + Jennie reproductions) |
| 6 | WO-22, 24, 25 = THEY + **WO-23 = ME** | split | MICKEY: dry-run eyeball + Unit-4 session · **ME: review #2** |
| 7 | WO-26..28 (room) | THEY | MICKEY: kill sessions pre-WO-27, Unit-5 session |
| 8 | WO-29..30 (acceptance) | THEY | MICKEY: Unit-6 gate run · **ME: review #3** |
| 9 | idemKey 2nd pass + coach Unit 8/9 core | ME (+ THEY: SSE fix, manual nits) | MICKEY: dev call, Sean week |

Every human session and feels-right bar stays as written in
`docs/FINISH_SPRINT_QUEUE_TO_COACH_2026-07-02.md` — the work orders are the how; the sprint doc
is the why and the when.
