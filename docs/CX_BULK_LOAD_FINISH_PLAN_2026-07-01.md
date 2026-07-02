# CX Bulk Load — How We Finish This Damn Thing (2026-07-01)

The finish plan for the bulk-load rail: what "done" means, what's actually left, and the order
that gets there without another regression cycle. Synthesized from
`.ai/context/CX_BULK_LOAD_LOCAL_TESTING_HANDOFF_2026-07-01.md` (the spec — the boring design)
plus a full 8-area map of the working-tree alpha code, cross-checked and spot-verified.
Companions: `docs/CX_0_2_ALPHA_TEST_OBSERVABILITY_RUBRIC_2026-06-29.md`,
`docs/CX_BULK_LOAD_SIMPLIFICATION_REVIEW_GUIDE_2026-06-24.md`.

---

## What DONE means

The boring loop, locked by machine:

> dial → RingCX proves → button → accepted → clear → next

1. **One rail.** No legacy, no EX, no manual-dial side door can write current-call state while
   bulk owns the agent.
2. **RingCX proof only.** A call is current because its `cxbl` externId/queueItemId matched a
   reserved row — never phone-only, never adopted.
3. **One disposition path.** The button sends one command pinned to the call the agent saw;
   accepted = advance. No veto branches.
4. **Once-only terminal.** Every outcome persists exactly once, and a failure to persist is
   *loud*, never silent.
5. **The UI projects.** Nothing client-side stages, clears, recovers, or re-stages a call.
6. **Machine-checked.** Every one of the above is pinned by a test or a self-verifying check
   that fails closed — not by a rubric someone runs by hand.

When all six hold and the live acceptance run (Tranche 7) passes, this thing is finished.

---

## Where we actually are

- Working tree = `release/0.2.0-alpha` + the July-1 simplification (uncommitted: runtime +325
  lines, runtimeService +230, watchers, UI). **Full suite 296/296 green** + web typecheck clean
  (verified today).
- The handoff's claimed posture is REAL (verified in code): strict reserved-row serving
  promotion (`cxBulkLoadRuntime.js:933`), one disposition path with **no release-verifier veto**
  (`:1136`), publish stamping fail-closed (`:899`), manual-terminal ref before submit
  (`CXWorkspaceBulkLoad.tsx:5764`), auto-review 4-condition gate (`:4419`), legacy queue
  compile-time dark (`:3848`).
- **Already fixed — do not redo** (all test-locked): the June-25 ReferenceError; reconciler
  adopted-row metadata merge; `releaseReserved` CAS hole; reserveMode green-first blockers;
  outcome idemKey UII-loss + eventType-collision; **watcher/refill now INSIDE the command tail**
  (`withSessionApply` — the old double-reserve blocker is closed); stateMachine `session.started`
  reset; drain scan-reject crash. The `uniq_running_session_per_agent` index is declared and
  allow-listed — only the dup-sweep before sync is missing.

So: the core loop is *currently correct in code*. What remains is (1) removing the half-dozen
things that keep un-correcting it, (2) pinning it so it can't silently regress, and (3) proving
it live once, with machine gates.

---

## Why it keeps breaking (the remaining offenders)

Spot-verified today unless noted. Full inventory with all 25 items lives in the map run; these
are the ones that matter.

**Tier 1 — produces the exact symptoms from the July-1 thread:**

| # | Offender | Where |
|---|---|---|
| B1 | 20s "Queue recovered" watchdog is not gated by `bulkRunning` and checks the LEGACY `disposition.isPending` — mid-bulk-call it clears the served selection + wipes the case panel. ✔verified | `CXWorkspaceBulkLoad.tsx:5536-5563` |
| B2 | Legacy cadence dedupe wholesale-replaces `metadata` on an active row from a stale read, no reserved-row guard — the in-code way a claimed row loses `reservationSessionId`. ✔verified | `cxCadenceService.js:2118-2137` |
| B3 | Releasing a PUBLISHED row orphans it: RingCX keeps the lead, next `reserveReadyRows` wipes the extern stamp, reconciler releases without RC cancel pairing | `cxQueueReservationService.js:147-198`, `cxDialQueueRepository.js:457-471` |
| B4 | Persistent serving-stamp miss = silent per-tick freeze (whole session patch discarded, log-only) — the "poller stopped matching" presentation | `cxAccountActiveCallWatcherService.js:748-772` |
| B5 | Single-tick release trust: ONE empty/partial poll clears a live current + records `did_not_connect`. ⚠ an existing test LOCKS the aggressive behavior — the fix rewrites it. ✔verified | `cxBulkLoadActiveCallWatcher.js:179-191`, test `:125` |
| B6 | Local loader bypasses the reservation rail entirely (direct `$set`, hand-rolled lifecycle, 8-char extern vs production full-queueItemId shape) — local tests a shape production never runs | `scripts/local-ordered-mickey-bulk-load.js:50-53,142-194` |
| B7 | Disposition POST carries no call identity (`{sessionId, disposition}`) — a click racing a release can terminal the WRONG call. ✔verified at the hook layer | `CXWorkspaceBulkLoad.tsx:5774`, `cxBulkLoad.ts:147-163` |

**Tier 2 — latent but real:** the manual-dial side door (`/start-next` stages current WITHOUT
RingCX proof + the only phone-only matcher left + an un-clearable `current-call-awaiting-uii`
wedge — `cxBulkLoadRuntime.js:1202-1233`, `cxBulkLoadRuntimeService.js:1075-1174`); progressive-pause
restore failure strands the agent paused = "loads but doesn't dial" (`cxBulkLoadRuntime.js:392-399`);
no timeout on the RingCX voice fetch (`ringcxVoiceClient.js:447`); refill side-effects land before
the version-guarded persist (cross-process only); `skip` orphans a live RC call
(`cxBulkLoadRuntimeService.js:1051-1073`); the ended-call re-staging effect
(`CXWorkspaceBulkLoad.tsx:4479-4518`); a lockable "Finishing current lead" transition
(`:4480-4487`); the banned adoption path still in tree as dead code (`markAdoptedCandidateServing`).

**Tier 3 — silently loses data:** outbox drain has no attempts cap (poisoned rows starve the
batch forever — `cxTerminalOutboxRepository.js:28-35`); double-fault loses the outcome permanently
with the rectifier default-off; `terminal_record_deferred` has NO alert (ops caveat #8); kill path
swallows persist failure (`.catch(() => null)`); abandoned sessions hold up to 35 reaper-invisible
rows; ops caveat #2's dup-sweep still unbuilt.

---

## The finish line — seven tranches, in order

Order matters: **loop first, pins second, eyes third, side doors fourth** — polish never before
the loop is locked, per the handoff's own lesson (trouble #7).

### Tranche 1 — Lock the loop (small, surgical, ~a day)

| Fix | Effort | Kills |
|---|---|---|
| Gate the 20s watchdog: `if (bulkRunning) return;` + include `bulkDisposition.isPending` | S | B1 |
| Guard the cadence dedupe patch: dotted metadata keys or reject reserved/claimed rows | S | B2 |
| Debounce release proof: 2 consecutive miss ticks before terminalizing (rewrite the test at `cxAccountActiveCallWatcherService.test.js:125` that pins the 1-tick behavior) | S | B5 |
| Send `queueItemId`+`uii` in the disposition POST; server rejects on mismatch with its current | M | B7 |
| Guard the staging effect to `bulkDisplayIsCurrent` (stops ended-call re-staging + the watchdog re-arm + the `setDomain` flip) | S | B13 |
| Auto-clear timeout on the "Finishing current lead" transition (no permanent dead buttons at buffer exhaustion) | S | B14 |
| AbortSignal timeout on the RingCX voice fetch / race the hangup probe | S | B10 |
| Delete `markAdoptedCandidateServing` + the watcher adoption branch (or throw `adoption-disabled`) | S | B15 |
| Pair release-of-published with RingCX truth: preserve the extern stamp + `releasedWhilePublished` marker, and cancel the RC lead where the client is available | M | B3 |

**Exit gate:** full suite green + the B5 test rewritten + a >20s local bulk call shows no
"Queue recovered" toast (quick manual soak; the machine version comes in Tranche 3).

### Tranche 2 — Pin it (the tests that make regression impossible)

The three handoff-requested tests first — none exist today:

1. **Real terminal executor** (not the stub every disposition test uses): accepted →
   `dispositionStatus:'accepted'` even when the probe errors/hangs; a follow-up tick with the
   stale disposed UII neither vetoes nor re-promotes. *This is the July-1 regression point —
   today a re-added veto passes the whole suite green.* (M)
2. **Real CAS shapes**: `markCandidateServing`/`markCandidatePublished` against a recorded
   `transitionQueueItemState` — assert the `reservationSessionId` match options and that
   `cx.alpha.watch.serving_stamp.missed` actually EMITS (zero test hits today). (S)
3. **Manual no-answer cannot open auto-review — both ends**: backend (accepted disposition patch
   carries `reviewHoldReason: null`; only ringcx-released produces `'ringcx-current-released'`)
   and UI (extract the auto-review predicate + display-latch chain into a pure
   `bulkLoadProjection.ts` module — web-client has ZERO test files, so extraction IS the
   enabler — then table-test: manual never opens / released-without-ref opens / stale >10s
   doesn't / error-path ref cleanup). (M)

Then the gap-fillers: cadence-dedupe guard test (locks the B2 fix); `reserveReadyRows` execution
tests via mongodb-memory-server (the most load-bearing write has zero executing tests); reducer
gaps (`buffer.released`, `terminal.failed`, `current.cleared`, publish_failed); watcher
version-miss variants; kill's non-buffer sweep. (S–L, parallelizable)

**Exit gate:** the suite fails if anyone re-adds a disposition veto, loosens a CAS match string,
or lets manual terminal open auto-review.

### Tranche 3 — Eyes (observability that fails closed)

- `terminal_record_deferred`: unconditional log + counter on worker health + alert when nonzero
  (closes ops caveat #8). (S)
- `serving_stamp.missed` escalation: per-queueItemId counter, alert after N consecutive ticks,
  surfaced into the session trace so a frozen session is *visible* (B4). (S)
- `scripts/cx-bulk-session-inspect.js`: one read-only command printing session + acceptedBuffer +
  reserved rows + published externs, PII-masked — replaces triage steps 5-8. (S)
- Convert the rubric's stop-test gates into `scripts/cx-loop-acceptance.js` that exits nonzero —
  the "did the loop work" verdict must be machine-checked, because manual verification never
  gets done. (M)

### Tranche 4 — Close the side doors (second owners die here)

- **Decide the manual-dial lane** (B8): recommend REMOVE (`/start-next`,
  `startCxBulkLoadNextManualCall`, `findManualStartedActiveCall` — the last phone-only matcher).
  If kept: agent-scope the phone attach, require ACTIVE state, bounded TTL on
  `manualStartPending`, fix the false "no manual dial here" header. (M)
- Progressive-pause restore self-heal: one retry + watcher-tick reconciliation past
  pauseMs+grace, else alert — "loads but doesn't dial" dies here (B9). (M)
- `skip` on a live proven call: end/cancel the RC call or reject the skip (B12). (S)
- **EX lifecycle** (f): explicit mode-gated no-op instead of the commented-out webhook body;
  lifecycle gate INSIDE `processPresenceEnvelope`; surface
  `{cxRuntimeMode, exPresencePollMode, exWebhookState}` in `/session` and render it in the bulk
  test header (the handoff's "make EX mode obvious" line); decide `/ringbridge/agent-state`
  after confirming no live poster. (S+S+S, per-agent suppression M later)
- Kill-path deferred marker instead of `.catch(() => null)` (B23). (S)

### Tranche 5 — Supply integrity + the ops caveats

- Dup-running-session sweep → verify zero → `sync-indexes` → prove `uniq_running_session_per_agent`
  built. Self-verifying script, not runbook steps (ops caveat #2 / B25). (S)
- Outbox drain attempts cap + `dead` status + health surface (kills head-of-line starvation, B20). (M)
- Terminal rectifier: run enabled+dryRun once, review, flip dryRun off (the only backstop for the
  double-fault loss path, B21). (S)
- Idle-session reaper: auto-kill running sessions idle > N min (frees the 35-row lockup, B24). (M)
- Refill version-miss compensation: release that pass's reservations or retry with fresh read
  (B11 — matters the day a second process exists). (M)
- **Loader → API route** (B6): seed rows `ready` with test metadata, then drive
  `POST /api/cx/bulk-load/start` so local tests run the production reservation + publish path
  with the real extern shape. Kills the whole "missing reservation metadata" incident class at
  the root. (M)

### Tranche 6 — UI polish (isolated, render-only — only now)

1. Wipe fields between calls as render-only `displayForm` (blank when
   `bulkRunning && !bulkDisplayIsCurrent`) — do NOT clear state; the staging effect fights state
   wipes. (S)
2. Grey neutral empty state + fixed-height banner slot (also stops the layout shove). (S)
3. Detached DNC-only correction modal (DNC + X = keep existing), guaranteed never to overlay the
   next call's buttons. (M)
4. Middle-section jump: covered by 1+2 + the Tranche-1 staging guard. (—)

### Tranche 7 — Prove it (pilot acceptance)

The live run, in the handoff's own order, now with machine gates:

1. Mickey restarts the needed local service; startup header shows EX poll off / cx-only.
2. Drain the CX-side queue → fresh session via the API route (not the old loader path).
3. First visible app queue item matches first CX-side item by `cxbl` extern / queueItemId
   (`cx-bulk-session-inspect.js` proves it).
4. **No-answer first**, disposition + probe logs open; voicemail second as the known-good
   comparison.
5. >20s call soak: no watchdog toast, no wipe, no auto-review on manual terminal.
6. `cx-loop-acceptance.js` green; reconciler startup shows `released:0`; zero
   `ex.presence|ex.poll|ex.webhook` lines in the window; `terminal_record_deferred` counter zero.
7. Then the cutover conversation (multi-agent, floor hours, legacy retirement) starts from a
   proven loop — not before.

---

## Only a human / live runtime can answer (the verify queue)

1. `handleCxTerminalCallOutcome` idempotency under drain replay — the once-only downstream
   guarantee rests on it; untraced. (code-read + one integration probe)
2. Does anything still POST `/ringbridge/agent-state`? (before removing/gating)
3. Does the UI expose Skip / manual start-next while current is live? (sizes B8/B12 UI-side)
4. RingCX-side behavior of orphaned published leads after release/kill — does RC keep dialing
   them? (shapes the B3 fix)
5. `updateBulkLoadSession` enforces `expectedUpdatedAt` when `__v` is absent — every stale-poll
   protection reduces to this one repo behavior.
6. Atlas: dup running-session count before the index sync; rectifier dry-run output before the
   flip.

---

## Scoreboard (what's locked vs hand-waved today)

**GREEN (test-locked):** stamp-miss never promotes · publish-stamp fail-closed · never
phone-only at the pure layer · one disposition path + idemKey dedup · rejected/thrown never
advances · kill releases buffer + one-session-per-agent · drain isolated/fail-soft ·
watcher+refill inside the session tail · trace layer redacts.

**RED (nothing pins it):** the real terminal executor (stubbed everywhere) · manual-no-answer ≠
auto-review (both ends) · real CAS match shapes + stamp-miss emission · single-tick release (the
test pins the WRONG behavior) · all UI loop invariants (zero web-client tests) ·
`reserveReadyRows` (zero executing tests) · drain retry/starvation semantics · EX slice in the
pilot suite · the acceptance rubric itself (all 11 phases manual).

Tranches 2–3 exist to turn that RED column green. That — plus the seven Tier-1 fixes — is the
whole distance between "works when we baby it" and *finished*.
