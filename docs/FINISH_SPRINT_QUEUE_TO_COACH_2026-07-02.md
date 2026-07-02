# Finish Sprint — Queue to Coach (starts 2026-07-02)

The spec, in the owner's words: **"simpler. less if-this-then-this. atomic functions do one
thing. one owner. it's really just picking up the phone and hanging it up over and over again
and writing down what happened in the background."**

So the goal is **weed whack and build** — not patch. A full complexity read of the whole
bulk-load area (8 scans, every attack line-anchored) says the boring loop honestly needs
**~3,000 server lines + ~650 UI lines**. What exists is ~14,000 server + 7,100 UI. The
difference is five kinds of weed: dark features behind never-set flags, second implementations
of solved problems, forensics rigs from closed investigations, injection ceremony with one real
implementation, and display varnish. The full attack list is the appendix at the bottom;
each unit below carries its targets.

Every unit now has FOUR legs, in this order:

- **Whack** — cut this unit's weeds first, so fixes land on clean ground.
- **Build** — the correctness fixes (from `docs/CX_BULK_LOAD_FINISH_PLAN_2026-07-01.md`).
- **Pin** — the tests that make the unit impossible to silently regress.
- **Load & Run** — a human session with the real tool and a feels-right bar. Node tests prove
  the code works; this proves it's useful. A unit isn't done until a human says so.

**Standing rules:** Mickey restarts services. No control-plane + cx bounces together during
floor hours. Full suite green after every whack AND every fix — the 296 tests are the machete's
safety net (most weeds aren't pinned by any test, so most cuts are green by construction; where
a cut touches a pinned invariant, the appendix says so). One unit per day target; a wobbly unit
rolls forward.

**Unit 0 (first thing):** commit the baseline — the July-1 simplification, the field manual,
the docs. Then every whack is a reviewable diff against a fixed floor.

---

## Phase 1 — The Queue (Units 1–6)

### Unit 1 — The Pool

One supply owner: reservation. A session builds through the production path and a human can see
the pool at a glance.

**Whack** (~1,100 lines)
- **BG-3**: green-first-touch, end to end — materializer (387 lines, ZERO callers: the only
  writer of the rows the planner counts, so the feature is inert even flag-on), planner (330,
  incl. a hand-rolled timezone lib), repo filter, release patch, runtime normalization.
  Live-box `.env` verified clean (2026-07-01) — cleared to cut. ~890 prod + ~700 test lines.
- Unwired lease heartbeat `renewReserved`/`renewClaim` (the code's own comment admits no
  caller; reaper ownership-exclusion is the real mechanism). `findQueueItemsByRingcxExternIds`
  (zero refs). Collapse `releaseReserved`+`cancelReserved` → one `endReservation`. Flatten
  `cxReserveModeService` to the 4-line mix map (knobs set nowhere, live box verified). Collapse
  the nested family loops into one `reserveReadyRows` call. Shared filter builder for
  `listQueueItems`/`countQueueItems`. Move the claim-time UCQ interlock to the publish gate
  (one check, one place). **Flag, don't touch:** the legacy claim engine dies at floor cutover.

**Build** — loader→API route (kills the 8-char extern drift); cadence-dedupe guard (B2);
release-of-published pairing (B3); dup-sweep → `sync-indexes` (ops caveat #2); build
`scripts/cx-bulk-session-inspect.js` — the sprint's microscope.

**Pin** — cadence-guard test; release-pairing tests; sweep asserts zero dups.

**Load & Run (Mickey, ~45 min)** — drain CX queue → build a 10-lead session through the API
route → inspect: every row stamped, extern shapes match, app order = CX order → kill → inspect
clean + check the RingCX portal (do published leads actually stop dialing? write down what RC
does — it shapes B3) → rebuild until boring.

**Bar:** *"Build, inspect, kill in under two minutes; the counts always match; I trust the
inspect script over the UI."*

### Unit 2 — The Proof

One current-call owner: the watcher. RingCX proves; nothing guesses.

**Whack** (~400 lines)
- **BG-11**: the adoption/external-candidates path, end to end — `markAdoptedCandidateServing`,
  the watcher branch, the pass-through. Production hard-codes it null with a comment banning
  adoption; zero tests reference it. The purest weed in the codebase — all 8 scans agree.
- One review-hold duration owner (three copies + a knob nobody passes). Drop the second
  terminal-proof re-check and the `beforePersist` eligibility re-derivation (keep the module —
  it's the ONE shared stale/busy definition). Flatten `extractActiveCallList` 5 envelope shapes
  → the 2 RingCX returns. Merge the two active-call normalizers.
- **BG-8 is OPT-IN, not a whack**: collapsing the watcher's version-miss apparatus into
  project-inside-the-tail touches the locked #6/#10 defect fixes. Only as a deliberate
  re-architecture with those scenarios re-expressed as tests first — or skip it entirely.

**Build** — release debounce, 2 ticks (B5 — REWRITE the test at
`cxAccountActiveCallWatcherService.test.js:125` that pins the wrong 1-tick behavior);
stamp-miss escalation counter + alert (B4); assert sessionId truthy in the CAS helpers.

**Pin** — real CAS shapes (reservationSessionId match options actually exercised);
`serving_stamp.missed` EMITS (zero test hits today); version-miss variants.

**Load & Run (Mickey, ~45 min)** — 5 calls side-by-side with the RingCX portal; sabotage one
poll (a live call must survive the bad tick); manufacture a stamp-miss and watch the alert name
the frozen row.

**Bar:** *"The current call on screen is always RingCX's live call, it never flickers, and when
matching breaks the system tells me instead of freezing."*

### Unit 3 — The Button

One disposition path. The UI becomes what it was always supposed to be: a projector and four
buttons. This unit whacks the most because the button fixes should land in a small file.

**Whack FIRST, then build** (~6,300 lines out of the workspace file)
- **BG-1**: un-fork the legacy panel mirror — ~3,300 lines of Tasks/Activities/Invoices/
  Payments/CommLog/Logics panels that are byte-near-identical to `CXWorkspace.tsx` move to a
  shared module (wanted features in the wrong file — moved, not deleted; only 386 of ~3,430
  lines differ).
- **BG-2**: the three literal-false rails — legacy queue-serving machinery behind
  `legacyQueueEnabled = false` (~1,100), the simple-loop test panel (~420), the lead-lookup/
  scramble ladder (~460). All three kill switches are hardcoded literals with zero writers.
- **BG-6**: the UI's second ownership of the current call — the 9-atom mirror effect, the
  display ladder + latch + 250ms ticker, the parallel toast/timer machine, write-only atoms.
  The 1s session poll already carries everything; the projector is the fixed three-slot screen:
  current in color, lastOutcome greyed between calls, one status line, no banner. Two behaviors
  MOVE, don't die: manual-vs-auto review suppression goes server-side; the `setDomain` flip is
  kept/derived.
- **BG-7**: the manual-dial side door, end to end — `/start-next` (zero callers), the staging
  of `current` WITHOUT RingCX proof, `manualStartPending`, and with the lane gone the last
  phone-only matcher (`findManualStartedActiveCall`) is dead-by-construction. This settles the
  finish plan's B8 as REMOVE.
- Small game: `watchCxBulkLoadSession` compat endpoint (no route, no caller); dead knobs;
  `handleAppointmentSubmit` six-toast ladder → one; collapse the twin client mutation factories;
  the third copy of the env-route resolver.

**Build** — disposition POST carries `queueItemId`+`uii`, server rejects mismatch (B7); the 20s
watchdog dies WITH the legacy rail in BG-2 (it was legacy machinery — verify nothing re-arms);
fetch timeout (B10); transition auto-clear (B14); auto-review gate hardening (B16 — now mostly
server-side per BG-6); skip ends the RC call or is rejected (B12); progressive-pause self-heal
(B9 — and KEEP the pause/supersede machinery: deleting it resurrects "loads but doesn't dial").

**Pin** — the real terminal executor tests (a re-added veto must fail the suite); backend
reviewHold-clear; `bulkLoadProjection.ts` extracted + table-tested (first web-client test —
after BG-6 the projection is small enough to BE a module).

**Load & Run (Mickey, ~1.5 hr)** — ten no-answers with logs open; voicemail comparison;
adversarial clicking (double-click, click-during-release, skip mid-ring, >20s soak); one
pulled plug mid-disposition must recover to a retryable state.

**Bar:** *"Fast, accurate, hung up immediately on click — and I couldn't break it on purpose."*

### Unit 4 — The Record

One record owner: the outcome adapter writes once; the outbox drains in the background; ONE
janitor cleans up calls that ended with nothing written down.

**Whack** (~1,200 lines)
- **BG-4**: one janitor — delete the diagnostic-only stale-serving reconciler (496 + script +
  313 test lines; zero production wiring, and hand-run scripts never get run), promote the
  rectifier as the single permanent janitor. FIRST transplant its one good idea (externId-first
  still-active match) into the rectifier, THEN cut. Exclude bulk rows from the legacy requeue
  at cutover.
- **BG-10**: the cadence crossing — extract `applyCxTerminalOutcome` (the write half of
  `handleCxTerminalCallOutcome`), drain calls it directly; delete the three bulk-only carve-outs
  that exist only because bulk tunnels through legacy gates; gate the EX-era agent-state kick
  OFF for bulk rows. **Characterization test FIRST — nothing pins the handler end-to-end.**
  The write half stays ONE shared implementation (a private bulk writer would be a second owner
  of cadence bookkeeping — worse).
- `normalizeBulkTerminalOutcome` — VERIFIED zero callers (grep 2026-07-01: only its own
  definition). Delete. Plus: `previewCxTerminalRectification` (zero callers), rectifier knob
  algebra, evidence taxonomy → insert|skip + reason, the always-'terminal' param, twin drain
  hook blocks → one helper. The idemKey 4→2 flatten is SECOND-PASS ONLY (it reshapes the #12
  fix — reconciler tests green first, mirror updated in lockstep).

**Build** — drain attempts cap + `dead` status (B20); `terminal_record_deferred` alert (ops
caveat #8); kill-path deferred marker (B23); rectifier dry-run → review with Mickey → on (B21,
now doubled in importance: it's THE janitor); idle-session reaper (B24).

**Pin** — drain retry/starvation; the BG-10 characterization test; the
`handleCxTerminalCallOutcome` idempotency probe.

**Load & Run (Mickey, ~1 hr)** — follow 10 mixed outcomes downstream (exactly once each);
poison an outbox row → dead-letters after the cap, alert fires; kill mid-call → outcome still
lands.

**Bar:** *"I'd show these counts to a manager, and if recording breaks I find out the same
hour."*

### Unit 5 — The Room

The state shape says what the loop says: buffer, current, completed, stats. The wiring is plain
construction. Then make it pleasant.

**Whack** (~700 lines)
- **BG-9**: DI ceremony in the runtime — require `reduce`/`watcher`/`leadSource`/`publisher`
  directly (every seam has exactly one production implementation); delete the two
  required-but-never-read deps; keep only `buildExternId`/`buildExternSessionToken` of the lead
  source (~40 of its lines); delete the watcher interface probes (a probe-miss silently disables
  release detection — worse than dead). `getService()` shrinks from 517 lines toward plain
  construction. The runtime/runtimeService WALL stays — the wall is right, the tenants were
  the problem.
- State shape: delete 4 reducer events nothing emits + the unreachable statuses they gate; the
  zero-caller `events` append-log; the second worse kill (`killActiveBulkLoadSessionsForAgent`
  — leaks RC buffers); flatten the 10-value `phase` no code branches on → 4 derived values;
  collapse terminal.accepted/current.released/buffer.released → one `call.completed{source}`;
  per-item phase AND status → status; `lastOutcome` → `completed.at(-1)`; write-only stats;
  persisted fields 15 → ~8. One typed watcher-owned `prevActiveCalls` (the release-diff anchor
  SURVIVES — it's an organ); the reducer loses the `trace` grab-bag.

**Build** — EX: explicit mode-gated no-op (not a comment), gate inside
`processPresenceEnvelope`, modes surfaced in `/session` + the bulk header; confirm-and-remove
`/ringbridge/agent-state`. Polish, render-only (trivial after BG-6): displayForm wipe, grey
fixed-height empty state — and the ONE-SCREEN design law (Mickey 2026-07-02): a fixed
three-slot layout (lead slot always filled — live in color, last lead greyed between calls;
the SAME button row always, which after an auto-release keeps working against the greyed lead
and the server routes the click to the correction lane; one plain-words status line as the only
text that ever changes). No correction card, no banners, no toasts in normal flow. Supersedes
both the DNC-only-modal direction and the card concept; server half = WO-31, routing = WO-17,
render = the WO-16 projector.

**Pin** — EX gate tests in the pilot suite; reducer table tests over the shrunken event set;
projection tests extended.

**Load & Run (Mickey + one agent, ~2 hr)** — a 20–30 call session at natural pace, judged as a
workplace by someone who didn't build it; header shows EX modes; zero `ex.*` lines in the logs.

**Bar (the agent's words):** *"I'd work a full shift on this without wanting the old screen
back."*

### Unit 6 — Acceptance

**Build** — `scripts/cx-loop-acceptance.js`: the stop-gates as machine checks that exit nonzero.
**Whack (timed):** DISPTRACE runtime-service copy + flow-trace now; the transport-boundary
probes and alpha-trace stay through the pilot (the pilot wants probe logs open), then die —
**BG-5**, ~560 lines, scheduled for right after.

**Load & Run** — the live sequence end-to-end in one sitting: drained queue → fresh session →
no-answer first → voicemail comparison → >20s soak → acceptance script green.

**Exit:** bulk rail pilot-ready, and roughly **9,000 lines lighter** than it started the week.

---

## Phase 2 — The Coach (Units 7–9)

*(unchanged in scope — the coach side already landed on its simple shape: the manual is the
product, the AI wakes only on a clear moment)*

### Unit 7 — The Manual as a Tool
Human read: 60-second lookup drills, mid-call lookup simulation, a rep's red pen over one full
part, compliance spine reads as guidance. Fix what a rep flags.
**Bar:** *"A new rep would read this between calls; a veteran would still look things up."*

### Unit 8 — The A-Station
Substrate fixes first (shared metered transport w/ stop_reason + backoff; commit-only growth
signature — same code the substance floor lands in; callStrategy serialization). Then: 3-turn
accumulator + substance floor, 2–3 turn window incl. the agent's line, floored + gated Haiku
prompt, `$3,500` in context, fires-vs-ticks + one-tap "useful?" logging built in.
Fixture replay through the REAL runtime, then a live dev call before any agent sees it.
**Bar:** *"It spoke maybe twice in ten minutes, both times I'd have wanted it to, and the rest
of the time I forgot it was there."*

### Unit 9 — The Layered UI + the Sean Pilot
Static script canvas + read-along + one typed chime card + interview form; decide
persist-vs-fade / rail-vs-float / drill-follow on the real screen. SSE reconnect fix rides
along. Sean opts in for one real week; the one-tap data calibrates the gate; the invoice
answers the Aug-31 pricing question (decide before September).
**Bar (Sean):** *"Leave it on."*

---

## Sprint map

| Unit | Day | Theme | Whack | Human bar |
|---|---|---|---|---|
| 0 | first thing | Commit baseline | — | fixed floor under the sprint |
| 1 | Day 1 | The pool | green-first-touch + supply knobs (~1.1k) | trust the inspect script |
| 2 | Day 2 | The proof | adoption path + watcher dedup (~400) | never guesses, never freezes silently |
| 3 | Day 3 | The button | mirror un-fork + false rails + UI-as-owner + side door (~6.3k) | unbreakable on purpose |
| 4 | Day 4 | The record | one janitor + cadence crossing (~1.2k) | manager-grade counts |
| 5 | Day 5 | The room | DI ceremony + state shape (~700) | "I'd work a shift on this" |
| 6 | Day 6 | Acceptance | trace rigs (timed, post-pilot) | machine-gated pilot-ready |
| 7 | Day 7 | The manual | — | reps would read it |
| 8 | Day 8–9 | The A-station | (bus fixes are the whack) | quiet, right, forgettable |
| 9 | Week 2 | UI + Sean pilot | — | "leave it on" |

---

## Appendix — The Weed-Whack List (2026-07-01 scan, 8 areas, merged + verified)

**The honest core:** ~3,000 server + ~650 UI lines against ~14,000 + 7,100 existing. Per area:
runtime pair ~1,250 (vs 3,089) · state trio ~270 (vs 588) · watchers ~400 (vs 1,121) · supply
~250 (vs 2,014) · terminal family ~320 (vs ~1,490) · UI ~650 (+~3,300 legacy panels that MOVE
to a shared module, not die).

**Big game (payoff order):** BG-1 un-fork the legacy mirror (~3,300 moved, U3) · BG-2 three
literal-false UI rails (~1,980, U3) · BG-3 green-first-touch end-to-end (~890+700 tests, U1,
live-env verified clean) · BG-4 one janitor (~960, U4, transplant the externId match first) ·
BG-5 trace rigs (~560, U6, AFTER the pilot) · BG-6 UI's second ownership of current (~720, U3,
two behaviors move server-side) · BG-7 manual-dial side door (~260, U3, settles B8=remove) ·
BG-8 watcher version-miss collapse (~210, U2, **OPT-IN — touches locked #6/#10 fixes**) ·
BG-9 DI ceremony (~200 + getService shrink, U5) · BG-10 cadence crossing (~120, U4,
characterization test first) · BG-11 adoption path (~133, U2, purest weed — all scans agree).

**Do-not-cut (organs that look like weeds):** the reaper ownership-exclusion; `reserveReadyRows`
atomic claim + FM-10 retry; the 16-field claim stamp reset; `TOUCH_BALANCED_QUEUE_SORT`;
`reservationRail` provenance; reservationSessionId CAS on every release; the outbox
insertOnce + fallback double-fault chain (the byzantine look IS the #8 fix);
`buildTerminalEvidenceKeys` (#12); rectifier fail-closed skips; review-dnc as a separate row
(#4); `cxBulkLoadMutationEligibility` (the one shared stale/busy definition); drain fail-soft
hook isolation; `withSessionOperation` serializer + `markSessionBusy` (the double-reserve fix —
the "only a Set" finding was stale); E11000 recovery + the partial-unique index; kill's
two-source sweep; fillBuffer's fail-closed ladder + DNC gate; the prevActive diff (calls dial
AND release inside one 1s gap); the no-phone-matching rule (the 06-17 incident guard);
progressive-pause supersede map (deleting it resurrects "loads but doesn't dial"); the 1s UI
poll (the projector transport — don't upgrade to push); uii-gated disposition buttons.

**Conflicts, resolved:** `normalizeBulkTerminalOutcome` → VERIFIED zero callers, delete
(2026-07-01 grep). Dark knobs → VERIFIED unset on the live box, cut. Manual-dial matcher →
dies with the lane (decide the lane once: remove). DISPTRACE → transport-scope probes live
through the pilot, the rest dies now/after. BG-8 → opt-in re-architecture only. idemKey
flatten → second pass. Cross-pool interlock move → consolidate into fillBuffer's ladder at
publish-time (human blesses the milliseconds-wider window vs the vestigial UCQ pool). `trace`
strip → the watcher keeps one typed `prevActiveCalls`; the reducer loses the grab-bag.
