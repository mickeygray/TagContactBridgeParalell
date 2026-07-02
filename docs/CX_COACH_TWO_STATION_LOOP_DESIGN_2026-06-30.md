# Two-Station Coach Loop — Design (2026-06-30, design-only)

Sibling to `CX_COACH_SINGLE_MODEL_COLLAPSE_NOTES_2026-06-30.md`. **Build gate:** measure the single-call
Sonnet-API $/day first (see the coach-model-economics decision); this is a paper design until then.

## The idea

Split the coach into **two mutually-grounding stations** instead of one prompt doing everything. Each
does ONE job and hands the other a freshly-curated context, so neither needs heavy static scaffolding —
**the grounding IS the other station's output.**

- **LONG / STRATEGIST (B)** — reads the materials + ground truth, decides strategy. Slow clock (~3 min).
- **SHORT / COACH (A)** — applies B's curated grounding to the live moment, talks to the agent. Fast clock (~10 s).

B never talks to the agent. A always does.

```
            full reference + raw transcript                 summary + list + focus + position
   ┌──────────────────────────────────────┐        ┌──────────────────────────────────────────┐
   │  B — STRATEGIST   (every ~3 min)      │ ─────► │  A — COACH   (every ~10 s, growth-gated)   │ ──► live say to agent
   │  reground: where are we, what matters │  hands │  apply focus (or another list item on      │
   │  overwrites the shared summary        │  state │  new context); fold last turn into summary │
   └──────────────────────────────────────┘        └──────────────────────────────────────────┘
                ▲  reads the raw transcript (ground truth) every pass; corrects A's drift
```

## Reads → Writes (the running ledger)

Every component pinned as **consume ↔ produce** against the REAL field names — the running reminder
that keeps the build grounded (and would have caught the almost-reinvented shapes). Each station
section below restates its own in/out.

| component | READS | WRITES |
|---|---|---|
| STT (continuous) | call audio (both legs) | `session.memory.transcripts` (raw transcript) |
| **B — STRATEGIST** (~3 min) | full raw transcript + full reference (+ prior `rollingSummary` as a prior) | `cockpit{currentSection, beats, says (one `rec:true`), remember, priorFlags, summary}` (overwrite) · `rollingSummary{summaryText, factsCaptured, openQuestions, objections, taxIssues, nextBestFocus}` (overwrite) |
| **A — COACH** (~10 s) | `cockpit.says` + the `rec:true` say + `cockpit.currentSection` + prior `dialog.guidance` + `rollingSummary.summaryText` + last turn | `dialog{say, guidance}` · `rollingSummary.summaryText` (incremental fold) |
| Normalizer (per object) | raw model JSON (possibly wacky) | canonical `cockpit` / `dialog` / `rollingSummary` — or empty, never malformed |
| Client (`useCoachCockpit`) | `coach.cockpit` / `dialog` / `coach.summary` off `session.latest` | rendered cockpit panel |

## Cadence

- **0–3 min:** STT accumulates; **no coaching, no model fires** — save the spend. *(cold-start = silent; chosen 2026-06-30)*
- **At 3 min:** B's first pass — reads the full 3-min transcript + full reference → orients; A's 10 s cadence begins.
- **Every ~3 min:** B re-fires → **overwrites** the grounding.
- **Every ~10 s (growth-gated):** A fires → live say + incremental summary update.

Asymmetric on purpose: A tracks the *conversation* (fast clock); B tracks *strategy/position* (slow
clock) — roughly 18 A : 1 B. Optional backstop: A may set `needsReground` to pull B early on a hard
off-script pivot; the 3-min heartbeat is the floor, not the only trigger.

## Shared state = the EXISTING front-end objects — do NOT reinvent

The shipped system already maps coach state to objects the web client renders off `session.latest`
(types: `apps/web-client/src/lib/liveCoach/stream.ts`; consumed by `useCoachCockpit.ts` /
`CoachCockpit.tsx`). The two-station outputs MUST be these objects. The conceptual names we used are
just these existing fields:

| conceptual (design) | EXISTING front-end field | object |
|---|---|---|
| `position` | `cockpit.currentSection` | `LiveCoachCockpitState` |
| `skeleton` | `cockpit.beats[] {beatId,point,status}` | `LiveCoachCockpitState` |
| `list` | `cockpit.says[] {type,tag,rec,text}` | `LiveCoachCockpitState` |
| `focus` | the `says[]` item with `rec:true` | `LiveCoachCockpitState` |
| `triggers` | `cockpit.remember[] {text,kind}` | `LiveCoachCockpitState` |
| prior fumbles | `cockpit.priorFlags[] {section,issue}` | `LiveCoachCockpitState` |
| section summary | `cockpit.summary` | `LiveCoachCockpitState` |
| whole-call summary + facts | `rollingSummary {summaryText, factsCaptured, openQuestions, objections, taxIssues, nextBestFocus}` | `LiveCoachRollingSummary` |
| A's live line | `dialog.say` | `LiveCoachDialog` |
| A's carried `guidance` | `dialog.guidance` | `LiveCoachDialog` |

So there is **no new shared object.** B writes the `cockpit` (+ `rollingSummary`); A reads
`cockpit.says`/`rec` as its list/focus, reads back `dialog.guidance` as its prior guidance, then writes
`dialog {say, guidance}`. **The cockpit IS the B→A handoff and the front-end render at once, and A's
self-carried guidance already persists in `dialog.guidance`.** Zero net-new state, zero front-end work.
Emit surface already exists: `applyDeepSteering`→`coach.cockpit`, `applyRollingSummary`→`coach.summary`,
`emitBatchGuidance`→`dialog` (the built `coachSoloLoop` already drives cockpit + dialog).

### Summary lifecycle — incremental A + authoritative B

- **A (every 10 s):** `newSummary = existingSummary + last turn(s)`. Cheap incremental keep-alive — the
  summary is never stale.
- **B (every 3 min):** **OVERWRITES** `summary` from the **full raw transcript** (ground truth) — corrects
  whatever paraphrase drift A's incremental folds accumulated over the window. Also overwrites
  `list` / `focus` / `position`.

This is fast-incremental-state + periodic-authoritative-reconciliation: A keeps it live and cheap; B
resets drift to zero every 3 min, so drift is bounded to a single 3-min window.

## Shape normalizer — already exists, REUSE (don't write a new one)

"In case the model gets wacky" is already handled at THREE boundaries, one per client object, each
between the model return and the client emit. Each guarantees the canonical shape — clamps enums,
coerces field aliases, drops mis-routed/empty rows, bounds lengths, recovers a single object returned
instead of an array, strips ``` fences. **Worst case is an EMPTY object, never a malformed one or a
crash** (a non-JSON blob coerces to `{guidance:[]}`).

| client object | normalizer | file |
|---|---|---|
| `cockpit` / reactor say | `parseBatchGuidance` → `repairGuidanceRow` (+ repairSays/Beats/Remember/PriorFlags, coerceResponse, stripFences, clampSection, ensureOneRec) | `coachBatchRunner.js` |
| `rollingSummary` | `normalizeRollingSummaryPayload` / `normalizeRollingSummaryMemory` / `normalizeStringArray` | `liveCoachRollingSummaryService.js` |
| `dialog` | `buildLiveCoachGuidanceDispatchPlan` → `normalizeGuidanceItem` (reads `try\|say\|line` → say, **`steer\|guidance\|nextStep` → guidance**), rejects mis-routed/empty | `liveCoachBatchGuidanceDispatchService.js` |

For the two-station: B's cockpit rides the repair layer (B *is* the deep prompt); B's rollingSummary rides
the rolling normalizers; **A's `dialog {say, guidance}` rides `buildLiveCoachGuidanceDispatchPlan`, which
ALREADY maps a `guidance` field → `dialog.guidance`.** Build note: route A through that canonical dispatch
plan — NOT `coachSoloLoop`'s hand-built `buildLiveDispatches` — so A inherits the full repair + rejection
for free.

## Station contracts

### B — STRATEGIST (long, ~3 min)
- **in:** full raw transcript (ground truth) + full reference *(+ prior summary as a continuity prior —
  truth wins because the transcript is present, so it self-corrects instead of compounding)*.
- **out → the EXISTING objects (overwrites them):**
  - `cockpit` (`LiveCoachCockpitState`) via **`applyDeepSteering`** (`coach.cockpit`) — `currentSection`
    (position), `beats` (forward skeleton, by `beatId`), `says` (the list — objections/tactics, exactly ONE
    `rec:true` = the focus), `remember` (triggers), `priorFlags`, `summary`. **This is the SAME shape
    today's DEEP pull produces** — B *is* the deep prompt, re-cadenced.
  - `rollingSummary` (`LiveCoachRollingSummary`) via **`applyRollingSummary`** (`coach.summary`) —
    `summaryText` + `factsCaptured`/`openQuestions`/`objections`/`taxIssues`/`nextBestFocus`. B reads the
    transcript, so it owns the summary: **B replaces BOTH the old deep lane AND the Codex summary lane.**
- In one line: *"Whole script + the call so far → reground the cockpit + refresh the rolling summary."*

### A — COACH (short, ~10 s) — self-priming, emits `dialog` + increments the summary
- **in (all from existing state):** `cockpit.says` + the `rec:true` say (B's list/focus) + `cockpit.currentSection`
  + **its prior `dialog.guidance`** (self-carried) + the current `rollingSummary.summaryText` + the new turn(s).
- **out → existing objects:**
  - `dialog` (`LiveCoachDialog`) via `emitBatchGuidance`: `say` (the line) + `guidance` (the now-active play,
    carried forward — the front-end already renders it and A reads it back next tick).
  - `rollingSummary.summaryText` via `applyRollingSummary` (`coach.summary`): the **incremental** fold
    `prior summaryText + last turn`. (B overwrites the full `rollingSummary` every 3 min — the two-maintainer
    lifecycle, now landing on the existing field.)
- **job:** keep applying the prior `dialog.guidance` (adapt its line to the latest turn) UNLESS the turn is
  broadly a different situation → switch to the matching `cockpit.says` item (that becomes the new
  `guidance`); fold the turn into `summaryText`; emit the line.
- **self-priming with ZERO new state:** prior guidance lives in `dialog.guidance`, the list in `cockpit.says`,
  the running summary in `rollingSummary.summaryText`. On the first tick after a B reground,
  `guidance := rec:true say`. A holds a **sticky current play**, switching only on a detected broad shift —
  stable, low-churn, reactive. B re-anchors all of it every 3 min.
- **decision rule:** A never invents strategy (B curated `cockpit.says`); `needsReground` fires only when
  the call breaks to something the list can't cover.

## Why a 3-min B is safe

The `list`/`skeleton` are **forward-looking** — they carry the current *and upcoming* moves and the
*anticipated* triggers. So normal call progression (advancing a section, an expected objection firing) is
already in A's hands; B only re-grounds to refresh the summary, re-select the next slice, and catch
genuine off-script drift. The only thing 3 min can't cover is a hard, unexpected pivot → the optional
`needsReground` early-trigger.

## Drift handling

Two guards: (1) B always re-anchors to the **raw transcript** every 3 min (resets A's incremental drift);
(2) `summary`/`list` carry **immutable anchors verbatim** (balance, notice codes, names, the literal
objection), and A's live say fact-checks against the last raw turn — paraphrase never mutates a number.

## Cost + model assignment

- **B:** full reference + transcript, but RARE (~3–10 calls per call). The expensive read happens seldom.
- **A:** lean (summary + list + last turn), FREQUENT (every 10 s) but tiny per call.
- **Assignment:** B = **Sonnet** (curates from the full materials). A = **Haiku-able** (it only *applies*
  B's pre-selected list). Start both Sonnet, prove the loop, then drop A to Haiku once the `list` reliably
  carries the grounding.

This is the project's **"retrieval over stuffing"** thrust finally realized: B *is* the retriever
(LLM-selects the relevant shallow copy every 3 min); A applies it. The static reference never rides in A's
hot path.

## Relationship to the built solo loop

`coachSoloLoop` (built 2026-06-30, see the collapse notes) is the closest existing thing to "A with no B"
— it carries the full prompt every 10 s. The two-station design = move the materials into a new **B
station (3 min)** and leave A lean. **Build path:** keep `coachSoloLoop` as A's substrate; add the B
station + the shared-state handoff (`summary`/`list`/`focus`/`position`); lean A's prompt down to
`summary + list + last turn`. The existing `deep → session.callStrategy → reactor` wiring is the
one-directional seed of exactly this (B→A) — this closes nothing back to B (B reads truth itself) except
the optional `needsReground` flag.

## Build plan — finishing the concept

Fable-mode staging: each phase ships ONE verifiable artifact, lands **default-off**, and touches NOTHING
in the live batch/solo paths (additive, new mode). **Phases 1–5 are no-spend** (authoring + code + tests +
review, all default-off) — buildable now, independent of the gate. **Phase 6 is the go-live gate.** The
work is forking `coachSoloLoop` (which already builds the DEEP request, applies cockpit steering, emits
dialog, growth-gates) and splitting its one call into two cadences.

**Phase 1 — Two prompt builders.** *(no-spend)*
- READS → WRITES:
  - B builder: reads full reference + transcript → request whose parsed output is `cockpit`
    (currentSection/beats/says-with-one-`rec`/remember/priorFlags/summary) **+** `rollingSummary`
    (summaryText + factsCaptured/objections/taxIssues/nextBestFocus). Extend `buildBatchGuidanceRequest`
    (DEEP) to also emit the rolling-summary block — ONE B call produces both.
  - A builder: reads `cockpit.says`+`rec` + currentSection + prior `dialog.guidance` + `summaryText` +
    last turn → lean request whose parsed output is `dialog{say,guidance}` + `summaryText`. New lean builder.
- ARTIFACT: both builders + golden tests — fixed inputs → the request carries the expected blocks, and the
  parsed output passes the EXISTING normalizers (repair layer / dispatch plan / rolling normalizers) into
  the exact client shapes.

**Phase 2 — B station (strategist).** *(no-spend, default-off)*
- READS → WRITES: reads `session.memory.transcripts` (full) + reference → writes `session.latest.cockpit`
  (`applyDeepSteering`/`coach.cockpit`) **+** `session.latest.rollingSummary` (`applyRollingSummary`/
  `coach.summary`). One Sonnet call (reuse `createSoloTransport`, full reference cached). Fires on a 3-min
  heartbeat + `needsReground` early-trigger; overwrites.
- ARTIFACT: offline test — fake B model → `applyDeepSteering` got the cockpit, `applyRollingSummary` got
  the rollingSummary; 3-min cadence + heartbeat fire. **B's first pass IS the 3-min warm-up orient — it
  subsumes the open phase-audit item** (priorFlags + pending beats = "did you do phase 1").

**Phase 3 — A station (coach).** *(no-spend, default-off)*
- READS → WRITES: reads `session.latest.cockpit.says`(+`rec`) + currentSection + `session.latest.dialog.guidance`
  (self-carried) + `rollingSummary.summaryText` + last turn → writes `session.latest.dialog{say,guidance}`
  via **`buildLiveCoachGuidanceDispatchPlan` → `emitBatchGuidance`** (the canonical normalizer, NOT the
  hand-built `buildLiveDispatches`) **+** `rollingSummary.summaryText` (incremental fold via
  `applyRollingSummary`). 10-s growth-gated; sticky guidance, switch only on a broad shift in `cockpit.says`.
- ARTIFACT: offline test — fake A model → dialog emitted with say+guidance; sticky guidance holds + switches
  on shift; summaryText increments; routes through the dispatch normalizer (mis-routed/empty rejected).

**Phase 4 — Orchestrator + wiring.** *(no-spend, default-off)*
- READS → WRITES: a `coachTwoStationLoop` runs B@3min + A@10s over one session (two intervals, in-flight
  guards, B-overwrite vs A-increment **sequenced so they don't race `session.latest`**). Cold start: A gated
  on "cockpit exists" → silent until B's first 3-min pass. Bus `startTwoStationCoach` behind
  `LIVE_COACH_COACH_MODE=two-station` (default-off); server builds + injects the B and A transports.
- ARTIFACT: end-to-end synthetic harness — fake transcript → silent 0–3 min, B writes cockpit+summary at
  3 min, A emits dialog every 10 s off B's cockpit, self-priming guidance sticks + switches. Plus
  `node --check` + the live-coach suite stays green (batch/solo unregressed).

**Phase 5 — Adversarial review + drift check.** *(no-spend)*
- Fan out finders over the two-station code (loop correctness, the B-overwrite/A-increment race on
  `session.latest`, cold-start gating, the normalizer routing), verify, fix — same shape as the solo-loop review.

**Phase 6 — Measurement gate → go-live.**
- Run BOTH stations on the dedicated Sonnet API key a few days; measure $/day (B's 3-min full-reference calls
  + A's 10-s lean calls) vs the solo loop's every-10-s full prompt. Then: (a) confirm cost is acceptable;
  (b) drop A to Haiku once `cockpit.says` reliably grounds it; (c) pilot on ONE agent via the agent-override
  pattern (like the dial runtime), watching the journal.
```
