# Coach Local Demo — plan to attach the new coach to the client (2026-06-25)

> Goal: a **local, script-driven** run where a sample call transcript drives the new coach — the
> navigator + reaction run as **agents on this Max account** (`claude -p`, no metered API) — and the
> resulting `CoachState` flows to the **real cockpit**. First time results flow end-to-end.
>
> It doubles as the safest possible first exercise of the agent substrate the AI-bus audit flagged as
> unverified: local, reads a fixed script, sequential (no 429 storm), default-off, on a stub session —
> the `claude -p` Max path gets proven HERE before it ever touches the live bus or the floor.
>
> Builds on: `COACH_FRONTEND_CONNECTION_PLAN_2026-06-24.md` (the `CoachState` contract + SSE
> transport), the phase-machine plan, and the cockpit mockup. Pure core already done + tested:
> `coachPhaseMachine.js` (16 ✓), `coachState.js` (12 ✓).

## The loop (one replayed transcript turn)

```text
transcript turn (from the script)
  -> signalExtractor(turn, capturedFacts)            // pure, deterministic  [BUILD NEXT]
  -> reduceCoachPhase(state, signals)                // pure, DONE
  -> [cadence ~1/min]  navigator agent (claude -p Sonnet)   builds guidance + proposes phase
  -> [reaction-worthy]  reaction agent (claude -p Haiku)    renders Read/Steer/Try
  -> assemble CoachState (phase, discovery, reaction, play, compliance)
  -> selectMode(state)                               // pure, DONE
  -> emit guideDelta                                 // coach.snapshot / guide.delta
  -> client renders the cockpit
```

The two agent calls are the only live pieces; everything around them is pure and already tested.

## Pieces to build (smallest-first, each verifiable before the next)

| # | Piece | Kind | Verify |
|---|---|---|---|
| 1 | **`coachSignalExtractor.js`** — `(turnText, capturedFacts) -> signals` (fee number, POA/2848, PII fields, close-summary; reuse the match-bank + DiscoveryItem registry) | pure | unit tests, offline |
| 2 | **`claudeAgentRunner.js`** — minimal `claude -p` wrapper: spawn the CLI, **strip `ANTHROPIC_API_KEY` + `ANTHROPIC_AUTH_TOKEN`** from the child env (forces Max), `--output-format json`, parse the envelope, return `{text\|json, model, usage}` | the one real-spawn piece | local run on the box w/ `claude` logged in |
| 3 | **`coachDemoAssembler.js`** — the local orchestrator: per turn, run #1 → phase machine → (gated) the agents via #2 → build `CoachState` → `selectMode` → `applyGuideDelta` | impure (calls #2) | injected fake runner → offline unit test; real runner → live |
| 4 | **`scripts/coach-demo-replay.js`** — load a sample script, replay turns (step or timed), feed the assembler, print each `CoachState` | harness | run it; read the console |
| 5 | **attach to client** — emit `coach.snapshot`/`guide.delta` over SSE; the cockpit subscribes | wiring | see it render |

## The fastest first result (slice A — prove the agent loop, no UI yet)

Build #1 + #2 + #3 + #4, run #4, and **print** each turn's `CoachState` to the console. This proves the
whole chain with **real Max-agent output** — the phase advances through the WYNN arc as the script
progresses, and the reaction agent renders real Read/Steer/Try — before any UI exists. If slice A
prints sensible coach output for the sample script, the hard part is done.

Sample script: the WYNN consultative call (`Downloads/_taxgroup_extract.txt`) reshaped into a
turn-by-turn transcript (agent/prospect lines), or a real recorded-call transcript if one's handy.

## Slice B — attach to the client (the actual ask)

Two transport options; pick by how much of the stack we want running:

- **B1 (full):** the local `ai-bus`/busService emits `coach.snapshot`/`guide.delta` on the existing
  `/sessions/:id/events` SSE for a stub session id; the real cockpit subscribes (the connection plan's
  transport, unchanged). Most faithful, more moving parts.
- **B2 (thin):** a tiny standalone local SSE server (mirror `localBusServer.js`) that the assembler
  pushes deltas to, and a minimal page (or the cockpit pointed at it) renders. Fewer dependencies,
  fastest to "see it move."

Recommend **B2 first** (prove the render loop with a stub server), then **B1** (wire the real
busService) once the cockpit renders correctly. The cockpit component (`LiveCoachCockpit`, from the
mockup) is the same in both — it only consumes `CoachState`.

## Rate / 429 discipline (we already tripped it once)

- Replay is **sequential**, one turn at a time — no concurrency storm.
- The **navigator runs on a cadence** (~1/min), not every turn; the **reaction agent** fires only on
  reaction-worthy turns. So a full call is ~a handful of agent calls, not one-per-utterance.
- Honor the spawn tax: `claude -p` cold start is ~5s — fine for a demo cadence; if we batch a whole
  script fast, add a small inter-call delay. (This is the governor's job later; for the demo, a fixed
  spacing is enough.)
- Slice A is the cheapest possible probe of the Max path — if it 429s under sequential single calls,
  that's a real signal about the account's headroom worth knowing before the bus depends on it.

## Build order

1. `coachSignalExtractor.js` + tests (pure — keeps the whole chain offline-verifiable up to the agents).
2. `claudeAgentRunner.js` (the `claude -p` Max wrapper) — the one piece that must be run on the box to
   verify (the rest is fakeable).
3. `coachDemoAssembler.js` + tests (inject a fake runner for the offline test; real runner for live).
4. `scripts/coach-demo-replay.js` → **slice A** (console). Run it, read real coach output.
5. **Slice B** (B2 thin SSE → cockpit render, then B1 real busService).

## Why this is safe + what it de-risks

- Local, fixed script, stub session, default-off, sequential — no live floor, no concurrency.
- Proves the **`claude -p` Max agent path** (the §9A keystone, currently unbuilt/unverified) in
  isolation before it's wired into the bus.
- Proves the **full coach chain** (extractor → phase machine → agents → CoachState → client) end to
  end, which no unit test can.
- Everything pure stays pure and tested; only the agent runner + the assembler's agent calls are new
  live surface, and they're contained to this harness.

## Open decisions (defaulted; revisit on the box)

- **Reaction model on the agent path** — `claude -p --model haiku` for the reaction (cheap, the probe
  showed Haiku renders faithfully); navigator `--model sonnet`. Confirm both support the run shape on
  the Max CLI.
- **Cadence in the demo** — fire the navigator every N turns (e.g. every 4) rather than a wall-clock
  timer, so a stepped replay is deterministic.
- **Script source** — synthetic from the WYNN script first (deterministic, repeatable); a real
  recorded transcript second (messier, truer).
