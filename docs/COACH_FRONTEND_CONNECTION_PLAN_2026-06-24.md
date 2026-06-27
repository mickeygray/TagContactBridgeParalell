# Coach → Front-End Connection Plan (2026-06-24)

> How the **new structured coach** (orchestrator + phase state machine + the guidance OO model) wires
> to the **cockpit UI**. Companion to: `UNIFIED_AGENT_BRAIN_PLAN_2026-06-24.md` (orchestrator, the
> `control` field), `AI_LIVE_COACH_TRANSCRIPT_SEMANTIC_AUDIT_2026-06-23.md` (the guideDelta idea), the
> phase-machine plan, the coach-guidance OO model, and the cockpit mockup. Status: design.

## The core flip

Today the browser is the *author* of phase/discovery/reaction: `LiveCoachPanel.tsx` folds typed SSE
events into `{dialog, context, transcript, stage}`, then **computes** phase (line ~1287), the
discovery checklist (~1249), and reactions (~1337) from heuristics, and parses the navigator string
with `parseNavigatorSay`. That client-side authorship is the "idea, not a fact" smell — the browser
can disagree with the coach, drift, and flicker.

**The flip:** the server owns one authoritative `CoachState`; the client **renders it, computes
nothing.** `parseNavigatorSay` and the client phase/discovery/reaction logic get deleted once parity
holds.

---

## 1. The wire contract — `CoachState`

One authoritative object the server owns and the client renders. Every field is server-decided —
including `mode` (which signal is loudest), so the client never decides what to show, only how.

```text
CoachState {
  session:    { id, callId, agent, status, startedAt }
  phase:      { current, order, advanceGoal, since }            // from reduceCoachPhase (server)
  discovery:  { items:[{ id, label, captured, value }], missing:[id] }   // DiscoveryItem registry
  reaction:   { id, read, steer, try, at, ttlMs } | null        // the live nudge; null when quiet/WAIT
  play:       { id, label, rungs:[{ id, label, state }], currentRung } | null
  compliance: { flags:[{ severity, message }] }                 // the gate output
  mode:       "quiet" | "reaction" | "play" | "steer_back" | "compliance" | "post_call"
  grade:      { ... } | null                                    // post-call only
  rev:        <monotonic int>                                   // ordering + dedup
}
```

`mode` is the **loudest-signal selector**, decided server-side by the orchestrator's `control` output
(propose-not-dispose: the model proposes, the engine + gates decide). This is what makes the cockpit
*stateful* without the client guessing — `compliance` pre-empts `reaction`, `reaction` pre-empts
`play`, a stalled discovery flips to `steer_back`, call-end → `post_call`.

`reaction.ttlMs` encodes the **~10–30s relevance half-life**: when a reaction goes stale the panel
fades it to `quiet` on its own (no lingering nudge), no server message needed.

### `guideDelta` — the incremental update

A partial `CoachState` + `rev`. `applyGuideDelta(state, delta)` merges by `rev` (newer wins, stale
ignored). This is the rename/realization of the audit doc's `applyGuideDelta`. A phase change, a new
reaction, a play advance, a compliance flag, or a mode change is one delta — small and ordered.

---

## 2. Transport — reuse the existing SSE, additively

The channel already exists: `streamLiveCoachEvents(`/sessions/:id/events`, { onEvent })` (the
`@/lib/liveCoach/stream` client) over the busService SSE. **Do not build a new transport.** Add two
event types alongside the existing granular ones (`compose.*`, `context.*`, `transcript.*`, `session.*`):

- `coach.snapshot` — the full `CoachState`, sent **on connect and on reconnect** (the authoritative
  baseline; this is the bind-lock re-sync that prevents losing state on an SSE blip).
- `guide.delta` — a partial `CoachState` + `rev` (every subsequent change).

The existing granular events **stay** — but only for the **transcript ribbon** and diagnostics. The
structured coach state comes from `snapshot + deltas`, not from re-deriving it client-side. This keeps
the migration additive: the old panel ignores the two new events; the new cockpit ignores the granular
ones it no longer needs.

---

## 3. Client state model — apply, don't compute

```text
on "coach.snapshot"  -> setCoachState(snapshot)                 // authoritative reset
on "guide.delta"     -> setCoachState(applyGuideDelta(prev, d)) // rev-ordered merge
on transcript.*      -> foldTranscriptRibbon(...)               // display only, unchanged
render <Cockpit state={coachState} />                           // pure render of state.mode
```

- `applyGuideDelta` is a **pure reducer** (mirrors the proven `cxBulkLoadStateMachine` /
  `reduceCoachPhase` pattern) — fully unit-testable offline with fixture deltas.
- **Delete**, once parity holds: `parseNavigatorSay`, the client phase computation, the client
  discovery-checklist derivation, the client reaction assembly. They move server-side into the
  orchestrator + the phase machine + the DiscoveryItem registry.
- History (reaction/guidepost lists) is **append-keyed by `reaction.id` / phase `since`** — append,
  never replace (the existing flicker fix, preserved).

---

## 4. Render mapping — `CoachState.mode` → cockpit

The cockpit (see the mockup) is a function of `mode`. The render is a `switch`, not a pile of cards
all fighting for attention:

| `mode` | Hero | Ambient |
|---|---|---|
| `quiet` | nothing — calm | phase rail + discovery status only |
| `reaction` | the `read/steer/try` card | phase/play/discovery shrink |
| `play` | the play tracker + the current-rung `try` | discovery collapses |
| `steer_back` | the guidance ("get income + ability-to-pay first" + next question) | no `try` line |
| `compliance` | a hard red interrupt at the top | pre-empts everything |
| `post_call` | the grader scorecard | call view fades |

The phase rail, play tracker, discovery chips, and compliance strip are each a **dumb component bound
to one slice of `CoachState`** — they re-render only when their slice's `rev` advances.

---

## 5. Stability rules (carry the hard-won flicker fixes forward)

- **rev-ordered merge** — `applyGuideDelta` ignores a delta with `rev <= current` (fixes out-of-order
  SSE delivery, the dual-poller class of bug).
- **snapshot-on-reconnect** — the bind-lock: on SSE reconnect the server re-sends `coach.snapshot`, so
  a dropped stream never strands stale state.
- **quiet-start** — the server holds `mode:quiet` for the opening turns (the existing
  `LIVE_COACH_VISIBLE_AFTER_TURNS` behavior), so the panel is calm at call open.
- **reaction TTL fade** — the panel fades a reaction to `quiet` after `ttlMs` with no new reaction;
  no stale nudge lingers.
- **scoped overlays** — any "loading next" / transition overlay is keyed to the one session and clears
  on the next snapshot/delta or a TTL backstop (the audit's stuck-overlay lesson, applied here).
- **append history** — reactions and phase transitions append (keyed by id/since), never clobber.

---

## 6. Migration — additive, flagged, parity-gated

The proven discipline from the bulk pilot + the AI-bus audit: **wrap, don't rip; flag per-agent;
don't remove the proven path until the new one has parity.**

1. **Server emits both.** The orchestrator computes `CoachState` and busService emits
   `coach.snapshot`/`guide.delta` **alongside** today's granular events. Zero change to the current
   panel (it ignores the new events).
2. **New cockpit behind a flag.** `LiveCoachCockpit` renders from `CoachState`; gated per-agent
   (`LIVE_COACH_COCKPIT_AGENTS=sean@...`), exactly the Sean-only pilot shape.
3. **Parity.** Run both side by side; confirm the cockpit's phase/reaction/discovery match (or beat)
   the old panel's, with the same latency. Watch for: stale-reaction lingering, phase lag, missed
   compliance flags.
4. **Cut over + delete.** Flip agents over; only then delete `parseNavigatorSay` + the client
   phase/discovery/reaction computation. The browser becomes a pure renderer.

---

## 7. Seams (the real files)

| Concern | Today | Change |
|---|---|---|
| SSE client | `@/lib/liveCoach/stream` `streamLiveCoachEvents` | add `coach.snapshot`/`guide.delta` cases |
| Event fold | `LiveCoachPanel.tsx` `handleEvent` (~152+) | route the two new events into `applyGuideDelta` |
| Client compute (to delete) | `parseNavigatorSay` (~579), phase (~1287), discovery (~1249), reactions (~1337) | move server-side; delete after parity |
| Server emit | busService (`appendStreamStatus`, the `/sessions/:id/events` route) | emit `CoachState` snapshot + deltas |
| State assembly | (none — scattered) | the orchestrator assembles `CoachState` from phase machine + navigator + gate + DiscoveryItem registry |

## 8. Build order

1. **`CoachState` + `guideDelta` contract** — one shared schema both server and client import (the
   single source of truth for the wire shape).
2. **`applyGuideDelta` reducer + tests** — pure, offline, fixture-driven (the testable core; like
   `reduceCoachPhase`).
3. **Server assembly + emit** — the orchestrator builds `CoachState`; busService sends
   snapshot/deltas over the existing SSE (additive).
4. **Client wiring** — the two new event cases → `applyGuideDelta` → `CoachState`.
5. **`LiveCoachCockpit`** — render from `CoachState.mode` (the mockup), behind the per-agent flag.
6. **Parity + cut-over + delete the client heuristics.**

Steps 1–2 are pure functions with no live dependency — verifiable the day they're written, and they
nail down the contract everything else hangs on. Step 3 depends on the phase machine
(`reduceCoachPhase`) and the orchestrator landing first, so the natural sequence is: **phase machine →
CoachState contract → server assembly → client render.**

---

## Open decisions (defaulted here; revisit when back)

- **`try` affordance** — defaulted to glance-only (no copy/read-aloud button) per the mockup; a phone
  agent reads, doesn't click. Revisit if agents ask.
- **Dock vs docked rail** — defaulted to keeping the floating dock (minimizable) but emitting
  `coach.snapshot` on every (re)mount so the bind-churn that caused past flicker can't strand state.
  A fixed workspace rail is the safer long-term home; deferred.
- **Transcript ribbon source** — kept on the existing granular `transcript.*` events (display only),
  not folded into `CoachState`, to keep `CoachState` small and the deltas cheap.
