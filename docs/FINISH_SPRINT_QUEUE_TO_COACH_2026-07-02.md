# Finish Sprint — Queue to Coach (starts 2026-07-02)

Unit-by-unit sprint to finish the two halves: the bulk-load rail (queue first) forward to the
live coach (buttoned up last). Every unit has the same three legs:

- **Build** — the code fixes scoped to this unit (from `docs/CX_BULK_LOAD_FINISH_PLAN_2026-07-01.md`
  and the coach landing in `docs/CX_COACH_STATE_OF_PLAY_2026-07-01.md`).
- **Pin** — the tests that make the unit's behavior impossible to silently regress.
- **Load & Run** — a hands-on human session with the real tool. Node tests prove the code works;
  this leg proves it's *useful*. Each has a script (what to do) and a **feels-right bar** (what
  a human must be able to say afterward). A unit isn't done until a human says the bar is met.

**Standing rules for the whole sprint:** Mickey restarts services — never from an agent. No
control-plane + cx bounces together during floor hours (7000 restarts + web rebuilds are fine).
Each unit ends with the full relevant suite green before the human session, so live time is spent
judging the tool, not debugging the code. One unit per working day is the target pace; a unit
that isn't at its bar rolls forward — don't start the next one on top of a wobbly one.

**Unit 0 (tonight / first thing):** commit the baseline. The working tree carries the July-1
bulk simplification (+~500 lines), the field manual, and the audit docs — all uncommitted on
`release/0.2.0-alpha`. Commit it as the sprint baseline so every unit diffs against something.
(Mickey's call, as always, but the sprint really wants a fixed floor under it.)

---

## Phase 1 — The Queue (Units 1–6)

### Unit 1 — The Pool (supply, reservation, honest session builds)

The foundation: a session builds through the production path, every row carries its reservation
proof, and a human can *see* the pool at a glance.

**Build**
- Loader → API route: `local-ordered-mickey-bulk-load.js` seeds rows as `ready` with test
  metadata only, then drives `POST /api/cx/bulk-load/start` — local sessions now run the real
  reservation + publish path with the real full-queueItemId extern shape (kills B6).
- Cadence-dedupe guard: the legacy dedupe patch can no longer strip a reserved/claimed row's
  metadata from a stale read (`cxCadenceService.js:2118` — B2, the reservationSessionId killer).
- Release-of-published pairing: preserve the extern stamp + `releasedWhilePublished` marker, RC
  cancel where the client is available (B3).
- Dup-running-session sweep → `sync-indexes` → prove `uniq_running_session_per_agent` built
  (ops caveat #2, self-verifying script).
- **Build the microscope now:** `scripts/cx-bulk-session-inspect.js` — session + acceptedBuffer +
  reserved rows + published externs, PII-masked, `--json`. Every later unit uses it.

**Pin** — cadence-guard test; release-pairing tests; sweep script asserts zero dups before sync.

**Load & Run (Mickey, ~45 min)**
1. Drain the CX-side queue. Build a 10-lead session through the API route.
2. `cx-bulk-session-inspect` → all 10 rows: `reservationSessionId` stamped, extern shape matches
   RingCX-side, app-order = CX-order.
3. Kill the session. Inspect again: rows released clean, extern history preserved. Check the
   RingCX portal: are the published leads actually cancelled or does RC keep dialing them?
   (This answers the open B3-shape question — write down what RC does.)
4. Rebuild. Do it twice more until it's boring.

**Feels-right bar:** *"I can build, inspect, and kill a session in under two minutes, the counts
always match, and I trust what the inspect script tells me more than the UI."*

### Unit 2 — The Proof (watcher, serving, matching)

RingCX proves the call; the app never guesses.

**Build**
- Debounce release proof: 2 consecutive miss ticks before terminalizing a live current (B5 —
  rewrite the test at `cxAccountActiveCallWatcherService.test.js:125` that pins the 1-tick
  behavior).
- Stamp-miss escalation: per-queueItemId counter, alert after N consecutive ticks, surfaced in
  the session trace (B4 — the silent freeze becomes loud).
- Delete `markAdoptedCandidateServing` + the watcher adoption branch (B15). Assert
  `session.sessionId` truthy in the CAS helpers.

**Pin** — real CAS shapes against a recorded `transitionQueueItemState` (the reservationSessionId
match options actually exercised); assert `cx.alpha.watch.serving_stamp.missed` EMITS (zero test
hits today); watcher version-miss variants.

**Load & Run (Mickey, ~45 min)**
1. Session up, RingCX dialing. Watch the middle panel promote **only** on proof — compare against
   the RingCX portal side by side for 5 calls.
2. Sabotage a poll (briefly cut the network / block the route): the live call must NOT vanish on
   the one bad tick; the debounce should visibly hold it.
3. Manufacture a stamp-miss (stale row from Unit 1's kill/rebuild): confirm the alert fires and
   the inspect script names the frozen row — no more silent "poller stopped matching."

**Feels-right bar:** *"The current call on screen is always the call RingCX says is live, it
never flickers, and when matching breaks the system tells me instead of freezing."*

### Unit 3 — The Button (the disposition loop — the heart)

One click = one command = accepted = advance. This is the unit the whole project is about.

**Build**
- Disposition POST carries `queueItemId`+`uii`; server rejects on mismatch with its current (B7).
- Gate the 20s "Queue recovered" watchdog on `bulkRunning` + `bulkDisposition.isPending` (B1 —
  the mid-call wipe).
- Staging-effect guard to `bulkDisplayIsCurrent` (B13 — no ended-call re-staging).
- Timeout on the RingCX voice fetch / race the hangup probe (B10). Auto-clear on the "Finishing
  current lead" transition (B14). Harden the auto-review gate ordering (B16).
- `skip` on a live proven call ends/cancels the RC call or is rejected (B12).
- Progressive-pause restore self-heal + alert (B9 — "loads but doesn't dial" dies here).

**Pin** — the big three: **real terminal executor** tests (accepted → advance even when the probe
hangs/errors; a stale follow-up poll neither vetoes nor re-promotes — today a re-added veto
passes the suite); backend reviewHold-clear on accepted manual terminal; extract the auto-review
predicate + display latch into `bulkLoadProjection.ts` and table-test it (first web-client test).

**Load & Run (Mickey, ~1.5 hr — the no-answer session)**
1. Ten calls, **no-answer every one**, disposition + probe logs open. Watch: click → hangup →
   clear → next, every time, no auto-review, no toasts.
2. Voicemail next, same logging — the known-good comparison.
3. Adversarial clicking: double-click the button; click during a release; click skip mid-ring;
   let a call run >20s mid-conversation (the watchdog soak — no "Queue recovered" wipe).
4. Pull the plug once mid-disposition: UI must recover to a retryable state, never a dead
   button row.

**Feels-right bar:** the July-1 checkpoint feeling, restored and sturdier — *"fast, accurate,
hung up immediately on click — and I couldn't break it on purpose."*

### Unit 4 — The Record (terminal, outbox, once-only)

Every call leaves exactly one mark, and a lost mark is loud.

**Build**
- Drain attempts cap + `dead` status excluded from pending, surfaced in health (B20 — no
  head-of-line starvation).
- `terminal_record_deferred` unconditional log + counter + alert (ops caveat #8 closed).
- Kill-path deferred marker instead of `.catch(() => null)` (B23).
- Terminal rectifier: run enabled+dryRun, review output with Mickey, flip dryRun off (B21).
- Idle-session reaper: auto-kill running sessions idle > N minutes (B24).

**Pin** — drain retry/starvation semantics; markDrained-throw replay; **trace
`handleCxTerminalCallOutcome` idempotency** (the untraced load-bearing guarantee — code read +
one integration probe with a deliberate replay).

**Load & Run (Mickey, ~1 hr)**
1. Run 10 mixed-outcome calls, then follow every one downstream: outbox row → drained →
   CallLog/cadence/Logics. Exactly once each. (Extend the inspect script to show the outbox
   tail if that's easier than Mongo spelunking.)
2. Poison one outbox row on purpose → watch it dead-letter after the cap instead of starving
   the batch; alert fires.
3. Kill a session mid-call → the in-flight outcome still lands (deferred marker path).

**Feels-right bar:** *"I would show these counts to a manager. Nothing double-counted, nothing
missing, and if recording ever breaks I find out the same hour, not at month-end."*

### Unit 5 — The Room (EX silence, UI polish, a real shift's feel)

Now — and only now — make it pleasant. The loop is locked; polish can't hurt it.

**Build**
- EX: explicit mode-gated no-op (not a comment), gate inside `processPresenceEnvelope`, surface
  `{cxRuntimeMode, exPresencePollMode, exWebhookState}` in `/session` + render in the bulk header.
  Confirm-and-remove `/ringbridge/agent-state` if nothing posts to it.
- Polish, render-only: wipe-between-calls as `displayForm` (state untouched); grey fixed-height
  empty/banner slot (kills the layout shove); detached DNC-only correction card (DNC + X = keep);
  the middle-section jump dies with these + the Unit-3 staging guard.
- Dead-code sweep (monitor/* handled separately in the bus tranche; here: the rail's
  `normalizeTerminalResult` identity, stale copy, misleading "RingCX still has the call" copy).

**Pin** — EX gate tests in the pilot suite (bulk-alpha ⇒ poll off + zero repo writes); projection
module tests extended over the polish states.

**Load & Run (Mickey + one agent if possible, ~2 hr)**
1. A 20–30 call session at natural pace — the first session judged purely as a WORKPLACE, with
   someone who didn't build it clicking the buttons.
2. Watch the seams the polish touched: between-calls blank is calm grey (not popups), the DNC
   correction never overlays live buttons, nothing jumps.
3. Header shows EX modes; log window shows zero `ex.presence|ex.poll|ex.webhook` lines.

**Feels-right bar (the agent answers, not us):** *"I'd work a full shift on this without wanting
the old screen back."*

### Unit 6 — Bulk Acceptance (the gate)

**Build** — `scripts/cx-loop-acceptance.js`: the rubric's stop-gates as machine checks that exit
nonzero (first-item extern match, accepted-advance timing, zero auto-review-on-manual, zero
deferred-terminal, EX silence, reconciler `released:0`).

**Load & Run** — the handoff's live sequence end-to-end, one sitting: drained queue → fresh
session → no-answer first → voicemail comparison → >20s soak → acceptance script green.

**Exit:** bulk rail declared pilot-ready. The multi-agent/floor-cutover conversation gets
scheduled from here — it is NOT part of this sprint.

---

## Phase 2 — The Coach (Units 7–9)

### Unit 7 — The Manual as a Tool (human read of the static middle)

The manual is the product; it's built (111 entries at `/cx/manual`); nobody has *used* it yet.

**Build** — nits only, driven by the session below. Candidates already flagged: the v2 tax
entries (self-employment / audit / innocent-spouse), a "Reference" deep-link from the coach
panel into manual entries.

**Load & Run (Mickey + one rep, ~1 hr)**
1. Between-calls simulation: 60 seconds on the clock — find the play for "I need to talk to my
   wife." Did search get you there? Was the entry readable in the gap?
2. Mid-call simulation: manual open on the side, someone reads objections off the trainer
   taxonomy aloud, the rep looks up the counter live.
3. Study read: the rep reads one full part (objections) and marks every entry that's wrong,
   floor-inaccurate, or preachy. The floor voice is the product — fix what a rep flags, not
   what we think.
4. Check the compliance spine reads as guidance, not legal boilerplate.

**Feels-right bar:** *"A new rep would actually read this between calls, and a veteran would
still look things up in it."*

### Unit 8 — The A-Station (the chime engine, built on a fixed substrate)

The runtime that runs the validated prompts on the landed cadence — plus the three bus-audit
fixes that sit exactly where it gets built.

**Build**
- Pre-pilot substrate fixes (from `docs/AI_BUS_AUDIT_2026-07-01.md`): shared metered-Anthropic
  transport with `stop_reason` detection + backoff (kills the truncation retry loop, A1/A2/A4);
  commit-only growth signature (A3 — and it's the same code the substance floor lands in);
  `callStrategy` serialization fix (A5); `emitBatchGuidance` return + hold-timer clears.
- The A-station: 3-substantive-turn accumulator with the deterministic substance floor; A fed a
  2–3 turn window including the agent's line; the floored + coachability-gated Haiku prompt
  (already validated) wired live; `$3,500` in A's context; B every 5 min on the solo substrate.
- **Fires-vs-ticks logging + the one-tap "was that useful?"** — the pilot's measurement
  instrument is part of the build, not an afterthought.

**Pin** — trigger determinism goldens over the 7 fixtures (substance floor: the noise fixture
must fire ~0 extra); transport stop_reason + backoff tests; the existing 296-suite + coach tests
stay green.

**Load & Run (Mickey, ~1.5 hr — before any agent sees it)**
1. Fixture replay through the REAL runtime (not the eval harness): watch fires-vs-ticks — the
   hostile-DNC fixture must go terminal-silent, the noise fixture must sleep through.
2. A live dev call: Mickey plays both sides on a real mic. Judge the chimes as a rep would:
   did it wake on the clear moment? Was the one thing it said the right *type* (say / objection /
   opening)? Did silence feel like "keep going"?
3. Tune nothing by feel yet — log what you'd tune and let the pilot data decide.

**Feels-right bar:** *"In ten minutes of live talk it spoke maybe twice, both times I'd have
wanted it to, and the rest of the time I forgot it was there."*

### Unit 9 — The Layered UI + the Sean Pilot (buttoning it up)

**Build**
- The two-layer UI: static script canvas (the manual's method part IS the content) + B's
  read-along highlighting (section lit, beats ticking) + the single typed chime card + the
  interview form. Decide the three open questions in the dev session, on the real screen:
  chime persist-vs-fade, rail-vs-float, drill-follows-vs-tracks.
- SSE client reconnect contract (bus audit D1/D2 — reconnect on graceful close, reset the retry
  budget) so a bus restart can't freeze the panel mid-shift.
- Per-agent opt-in, default-off, Sean only.

**Load & Run (Sean, one real week)**
1. Sean opts in. Coach runs his real calls. Every chime logs the one-tap "useful?".
2. Mid-week check: fires/hour, useful-rate, cost/day actuals vs the $34–48/mo model, cold-start
   DNC-timing histogram (the last unmeasured numbers).
3. End of week, the three verdicts: Sean ("did it help or annoy?"), the log (wake precision),
   the invoice (real cost). Tune the gate threshold from the "useful?" data — this is the
   calibration fixtures can't do.

**Feels-right bar (Sean's words, not ours):** *"Leave it on."*

**Exit / sprint done:** manual live and read; loop boring and machine-gated; coach quiet, legal,
useful, and priced. Decisions that come AFTER the sprint, armed with its data: floor-wide bulk
cutover; coach rollout past Sean; the Aug-31 Sonnet intro-pricing step (+~50%) — decide with a
week of real cost data in hand, before September.

---

## Sprint map (one line each)

| Unit | Day | Theme | Human session | Bar |
|---|---|---|---|---|
| 0 | tonight | Commit the baseline | — | fixed floor under the sprint |
| 1 | Day 1 | The pool | build/kill/inspect sessions | trust the inspect script |
| 2 | Day 2 | The proof | side-by-side vs RingCX portal + sabotage | never guesses, never freezes silently |
| 3 | Day 3 | The button | the no-answer session + adversarial clicking | fast, accurate, unbreakable on purpose |
| 4 | Day 4 | The record | follow 10 outcomes downstream + poison one | manager-grade counts, loud failures |
| 5 | Day 5 | The room | 20–30 call shift-feel session w/ an agent | "I'd work a shift on this" |
| 6 | Day 6 | Acceptance | the live gate run, machine-checked | bulk = pilot-ready |
| 7 | Day 7 | The manual | timed lookups + a rep's red pen | reps would actually read it |
| 8 | Day 8–9 | The A-station | fixture replay + live dev call | quiet, right, forgettable |
| 9 | Week 2 | UI + Sean pilot | one real week, one-tap feedback | "leave it on" |
