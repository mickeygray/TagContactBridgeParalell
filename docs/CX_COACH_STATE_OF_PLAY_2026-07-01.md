# Live Coach — State of Play (2026-07-01)

Where the live sales coach landed after this session: the design decisions, what's coded and
tested, what's validated, and what hasn't been built yet. Companion docs:
`CX_COACH_SCALE_TEST_2026-07-01.md` (eval results + cost), `CX_COACH_TWO_STATION_LOOP_DESIGN_2026-06-30.md`
(the original two-station design).

---

## TL;DR

The **two-station coach** design is settled and its *prompts* are coded + adversarially validated
(quality, compliance, cost, determinism, and the wake/sleep judgment). What is **not** built yet is
the **runtime** that runs those prompts in the two-station cadence, the **UI** that renders it, and
the **live wiring** for a pilot. The next real step is building the A/COACH station and a Sean-only
pilot — everything upstream of that is now measured rather than assumed.

Status legend: ✅ coded + tested · 🔬 validated by eval · ⬜ not built · 🎨 designed/mocked only

---

## Where we landed — the coach design

- **Two stations.** **B / STRATEGIST** (Sonnet, the big prompt) reads the whole call + reference and
  produces the cockpit (section, beats, the typed play menu, remember, summary). **A / COACH** (Haiku,
  a small prompt, no reference) picks the single best play from B's menu, adapts the words, and speaks
  — or stays quiet. B is the brain on a slow clock; A is the voice on a fast one.
- **Trigger = turns, not a clock.** A fires **every ~3 turns**; B regrounds **every ~5 min**. The
  3-turn count must be **substance-floored** (only real turns count — see Determinism). This replaces
  the current 10-second timer.
- **Models: Sonnet big / Haiku small.** The strategic read needs Sonnet (scale test was Sonnet). The
  small "apply the menu" job is Haiku's lane — ⅓ the cost *and* it parsed more reliably (35/35 vs
  33/35) because B already did the hard thinking.
- **Typed guidance, bounded write.** The chime is **one** typed thing — `say` (a line), `objection`
  (a way to think), or `opening` (a point of attack) — picked as the single clearest response. The
  model **selects + adapts**, it does not free-compose ("keep the move, rewrite the words").
- **HOLD / silence is first-class, with an asymmetric bias.** The coach may say nothing. The
  coachability gate is **high-precision**: wake only on a *clear* moment; when in doubt, sleep.
  Rationale (user): missing a moment = the agent handles it solo (cheap); a wrong/needless wake spends
  attention and trust, and a coach that fires on nothing gets tuned out.
- **Compliance floor (load-bearing).** Never promise an outcome / settlement / OIC / dollar amount /
  date — say what *we do*, not what the IRS gives or when. A stop / DNC is terminal (confirm +
  disengage, no reopen). This **outranks "advance."** Tuned to a "middle" guardrail level — heavier
  than the bare prompt, lighter than a rigid lockdown.
- **Two-gate determinism.** A cheap deterministic layer drops *only* literal noise (empty, bracketed
  IVR garble, dupes, pure filler) — it never judges meaning, so it can't eat a meaningful short turn.
  Haiku's coachability gate does the judgment, given a 2–3 turn window.
- **Two-layer product.** The coach is not the product — the **static middle** is: the house script +
  objection sheet + strategy sheet + sales psychology, rendered as a browsable **dictionary/manual**.
  The AI overlays and chimes only when certain; the static layer is the floor that makes the silence
  safe (a quiet coach over a live script = "keep going," not abandonment). The AI is a live index into
  a book the agent already has.

---

## What's coded + tested (this session)

- ✅ **`coachTwoStationPrompts.js`** — the B/A prompt builders, fully tuned:
  - Multi-read → resolve to BEST play (`rec:true`) + at most one other + a visible `reasoning` field
    (thinking off); terse caps; summary as a "check-this-but-write-a-paragraph" narrative string.
  - HOLD permission (empty `says` / empty `say`).
  - **Compliance floor** on A (no outcome/date promise, DNC terminal, HOLD) — tightened to the middle
    level.
  - **Coachability gate** on A as the explicit first move, with the when-in-doubt-sleep bias.
  - Tests: `tests/live-coach/coachTwoStationPrompts.test.js` (6/6).
- ✅ **`repairModelJson`** in `coachBatchRunner.js` — production parse fix: Sonnet occasionally emits a
  trailing comma; strict `JSON.parse` was silently dropping the whole reground to `{guidance:[]}`.
  Repairs trailing commas / prose wrappers; reused in the eval runner. Tests in
  `tests/live-coach/coachBatchRepair.test.js` (+7, green).
- ✅ **Eval harness** (`scripts/coach-eval/`): `run.js` (`--all --compact --dump`), `apiRunner.js`,
  `run-window.js` (A cost), `run-batch.js` (batch scaling), `run-reactor.js` (reactor cost),
  `run-a-quality.js` (A compliance probe), `run-a-coachable.js` + `run-a-coachable2.js` (coachability
  gate), `run-determinism.js` + `run-determinism2.js` (determinism). 7 annotated fixtures
  (`fixture-tax-call-01` + 6 workflow-authored: hostile-dnc, noise-heavy, hard-no, fast-yes,
  complex-tax, rambling), each with a per-checkpoint rubric + STT noise.
- ✅ **Corpus dump + build brief** — `C:\Users\micke\coach-guidance-corpus.md` (verbatim guidance
  source + a brief to synthesize it into the static field manual).

### Pre-existing substrate (coded before this session)

- ✅ **`coachSoloLoop.js`** — the single-call collapse (big prompt every 10s, growth-gated,
  default-off). This is the *substrate* A/COACH would be built on, but it is **not** the two-station
  split.
- ✅ **`coachSoloTransport.js`** — Sonnet via a dedicated metered key.
- ✅ The full live pipeline (STT → `liveCoachBusService` → `liveCoachSanitizedPipeline` → composer),
  the 3-lane batch coach (`coachFloorLoop`: reactor/deep/summary), the shipped **cockpit UI**
  (`stream.ts` / `useCoachCockpit.ts` / `CoachCockpit.tsx`), the objection bank + guidance libraries,
  and the gRPC bridge.

---

## What's validated (eval proof points)

- 🔬 **B / strategist scale test: 27/28 PASS, 0 doctrine violations** across 7 fixtures (context /
  objections / filter perfect; STT garble fully filtered; DNC-terminal + tax-general compliance held).
- 🔬 **A / Haiku compliance:** unfloored it was a liability (sold past every DNC, over-promised dates —
  on *both* models, so it was the prompt, not Haiku). **With the floor: DNC 4/4 clean, date/outcome
  promises gone, OIC clean** — and still useful (schedules callbacks, advances the close). Verdict:
  Haiku passes muster *with* the floor.
- 🔬 **Coachability gate:** sleeps on filler/backchannel/small-talk, wakes on clear objections/
  questions — including pivotal short turns ("No.", "How much?") *when given a 2–3 turn window*
  (a lone turn is ambiguous and it correctly sleeps).
- 🔬 **Determinism:** the fire decision is a pure hash of the committed transcript (robust); partials
  can't inflate turns; thoughts are coalesced not fragmented. **The one gap: no substance floor** — an
  unfiltered turn count fires ~70% more, on backchannels/garble.
- 🔬 **Cost (measured, real API):** B $0.0173/reground · A-Haiku $0.00225/tick · batching all 7 agents
  in one call is only ~4% cheaper than 7 separate (cost is ~linear in agents).

---

## What has NOT been coded (the pending build list)

1. ⬜ **The A/COACH station + two-station runtime.** The loop that runs B every ~5 min and A every ~3
   turns with the cockpit as the handoff. `coachSoloLoop` is the substrate; the split, the cadences,
   and the A-side coachability loop are not built.
2. ⬜ **The 3-turn substance-floored trigger.** A pure accumulator: count a turn only if it clears the
   substance floor (≥2 real, non-backchannel words, not bracketed/IVR garble). Not the 10s timer.
3. ⬜ **Feed A a 2–3 turn window** (incl. the agent's line), not a single row. The pipeline already
   renders last-6 for the reactor tier — needs A wired to that window.
4. ⬜ **`$3,500` in A's context** — fixes the `$[X]` fee-placeholder bug (put the fee in the reference
   or cockpit).
5. 🎨 **The two-layer UI** — static script canvas + cockpit read-along highlighting + the typed chime
   card. Designed and mocked (`layered_live_coach_ui`), not built.
6. 🎨 **The static dictionary / field manual** (Vite component) — script → objections → strategies →
   psychology-in-source-voices, cross-linked, searchable, with scripts/examples/Q&A. Corpus dumped +
   briefed, not built.
7. ⬜ **Live wiring / Sean-only pilot** — direct API, Sonnet+Haiku, floored + coachability-gated
   prompts, per-agent opt-in, default-off, with **fires-vs-ticks logging** (to pin the real fire rate
   + the cold-start DNC-timing histogram — the last numbers still estimated).
8. ⬜ **B opportunities polish** — force the top lever into the crowned play, not `remember` (the only
   sub-2 dimension in the scale test; additive, must not weaken HOLD/filter/DNC).

---

## Economics (measured)

- **Config:** Sonnet big / Haiku small, small every 3 turns, big every 5 min, per-agent opt-in.
- **~$34–48 / agent / month** at realistic pace and ~4 fire-hours/day.
- **7-agent floor ~$230–320/mo** (batching is ~linear, ~4% discount, not flat). Sean-only pilot
  ~$34–48/mo. STT is sunk (already running).
- The small prompt is the cost driver (fires ~12–18× more than the big), so **Haiku on the small is
  the single biggest lever** — running it on Sonnet more than doubles the floor for no quality gain.

---

## Key files

- Prompts: `packages/shared-services/src/coachTwoStationPrompts.js`
- Parse fix: `packages/shared-services/src/coachBatchRunner.js` (`repairModelJson`)
- Substrate loop: `packages/shared-services/src/coachSoloLoop.js` + `apps/ai-bus/src/coachSoloTransport.js`
- Evals: `scripts/coach-eval/`
- Corpus dump: `C:\Users\micke\coach-guidance-corpus.md`
- Docs: `docs/CX_COACH_SCALE_TEST_2026-07-01.md`, `docs/CX_COACH_TWO_STATION_LOOP_DESIGN_2026-06-30.md`
