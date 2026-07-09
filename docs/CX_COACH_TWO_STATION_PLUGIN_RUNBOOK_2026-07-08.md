# THE COACH IS NO LONGER ETHEREAL — TWO-STATION RUNTIME + THURSDAY PLUG-IN RUNBOOK
## (Fable, overnight build 2026-07-08; tomorrow = dialing pilot, Thursday = plug this in, Friday = test with coach on)

## WHAT GOT BUILT TONIGHT (all default-off, all gated, all tested)

| Piece | File | Proof |
|---|---|---|
| Substance-floored turn trigger | `packages/shared-services/src/coachTurnAccumulator.js` | 7/7 pins incl. BYTE-PARITY with the validated determinism eval |
| **The two-station runtime** (B ~5min + immediate first ground; A every 3 substantive turns; HOLD first-class; fail-soft cooldowns; fires-vs-ticks + token counters) | `packages/shared-services/src/coachTwoStationLoop.js` | 10/10 pins |
| B/A direct-API transports (Sonnet/Haiku, shared metered key, `stop_reason` truncation = failure, Retry-After-aware backoff) | `apps/ai-bus/src/coachTwoStationTransports.js` | 5/5 pins (the solo transport had zero) |
| Bus wiring: `startTwoStationCoach()` + `LIVE_COACH_COACH_MODE=two_station` + 5-min cost-meter log | `liveCoachBusService.js` + `apps/ai-bus/src/server.js` | ai-bus suite 103/103 |
| Audit fix A5: `callStrategy` write-only hole (steering now reaches serialize/projection) | `liveCoachBusService.js` | — |
| Audit fix D1+D2: SSE server-close freeze + retry-budget exhaustion (cockpit reconnects forever) | `apps/web-client/src/lib/liveCoach/stream.ts` | tsc + build green |
| Fee placeholder fix: `$___` → `$3,500` rides the reference (`LIVE_COACH_FEE_AMOUNT` to change) | `startTwoStationCoach` | eval: zero placeholders in 7 calls |
| B opportunity polish: a surfaced LEVER must ride the crowned play, not `remember` | `coachTwoStationPrompts.js` | 6/6 prompt pins still hold |
| uiiReconcile known-fail: root cause was the ENGAGED dev kill switch, not code; test now isolates it | `tests/live-coach/uiiReconcile.test.js` | 6/6 (was 2/6) |
| **Runtime-level eval** — 7 fixtures through the REAL loop + REAL API | `scripts/coach-eval/run-two-station.js` | **ALL DOCTRINE CHECKS PASS** |

### The eval verdict (the Friday-confidence artifact — real Sonnet + Haiku calls)

```
hard-no:     A fired 1x in 25 substantive turns, held 7   <- it knows a genuine no
hostile-dnc: 3 fires; DNC terminal honored; ZERO says after; no reopen
fast-yes:    5 supportive fires driving the close
all 7:       0 outcome promises, 0 fee placeholders, fire rate sane everywhere
cost:        ~$0.06/call avg -> ~$40-65/agent/mo at real pace (the $34-48 estimate,
             measured; the upper band = real-pace cache WRITES since B's 5-min reground
             sits at the cache TTL boundary. Sonnet INTRO pricing ends 2026-08-31:
             +50% on the B leg after -> ~$60-90. The live 5-min meter is the truth.)
```

Live-coach suite: **351/351** (was 342 w/ 4 known-fails). ai-bus: **103/103**. CX gate untouched: 379/379.

### The adversarial pass (32-agent review over the night's diff, then fixes, then re-gate)

10 confirmed findings, ALL FIXED same night + pinned (5 new regression tests): a failed
B reground consumed its own trigger (quiet-tail calls never regrounded again); A fires
landing during a cooldown were destroyed instead of deferred; prose-mode A output
miscounted as HOLDs (skewing the exact meter the pilot reads); billed tokens from failed
calls escaped the meter; **`ensureSession` wiped `metadata.callStrategy` every ~10s**
(a pre-existing hole that also defeated the A5 fix — now carried across the rebuild);
shutdown never stopped the two-station loop; the LEVER prompt line could collide with
HOLD on a genuine no (now explicitly HOLD-outranked); A's rolling summary head-clamped
into a permanent freeze on the call's opening (now tail-kept + displaced by each B
reground); stop() now quiesces mid-tick. 18 other findings refuted with evidence.
Doctrine eval re-run post-fix: hard-no and hostile-dnc both fully clean.

---

## THURSDAY PLUG-IN (every step your hands, in order; total ~20 min)

**0. Commit first** (tonight's tree is uncommitted, as always — yours).

**1. `.env` (repo root) — the coach block:**

```
LIVE_COACH_RUNTIME_MODE_BATCH_ENABLED=true
LIVE_COACH_RUNTIME_MODE_DEFAULT=deterministic
LIVE_COACH_RUNTIME_MODE_AGENT_OVERRIDES=slucas@taxadvocategroup.com:batch
LIVE_COACH_COACH_MODE=two_station
LIVE_COACH_SOLO_ANTHROPIC_API_KEY=<mint a fresh metered key in console — spend isolation>
VITE_LIVE_COACH_PANEL_ENABLED=true
```

(Optional knobs, defaults are the design: `LIVE_COACH_TWO_STATION_B_INTERVAL_MS=300000`,
`LIVE_COACH_TWO_STATION_A_TURNS=3`, `LIVE_COACH_FEE_AMOUNT=$3,500`.)
Sean-only comes from the OVERRIDES line — everyone else's `deterministic` default means
the loop literally never sees their sessions.

**2. Disengage the kill switch:** delete `runtime/live-coach.killed`.
   (It is engaged right now. It is also your INSTANT rollback — see below.)

**3. Rebuild the client** (`cd apps/web-client && npm run build`) — the panel flag is
   build-time. Hard refresh Sean's browser after.

**4. Start the coach stack** (two terminals, same as the June tests — there is no NSSM
   service for these on this box, which is a feature for a pilot):

```
npm run ai:bus                                        # terminal 1 — port 7000
node scripts/ringcx-grpc-live-coach-bridge.js         # terminal 2 — the audio bridge
```

**5. Preflight (5 min):** ai-bus boot log shows `live_coach.floor_coach.config` with
   `twoStation: true, started: true`; make one test call as an overridden agent and watch
   terminal 1 for `coach_two_station.b.reground` on your first real sentences, then
   `coach_two_station.a.fired` / `a.hold`; cockpit paints in the workspace panel.

**6. Watch during the day:** the `live_coach.two_station.meter` line every 5 min is the
   whole story — `bRegrounds/aFires/aHolds/aDupes/turnsCommitted/turnsDropped` + token
   spend per station. The doctrine expectation from the eval: holds ≥ fires on normal
   calls; a chatty coach here = investigate, don't tune live.

**ROLLBACK (instant, no restart):** `type nul > runtime\live-coach.killed` — the bridge
stops opening coach sessions on the spot. Softer: remove Sean from the OVERRIDES line +
restart ai-bus only. The dialing pilot is UNTOUCHED by any of this — different process.

## FRIDAY = the coach-on test day

Same dialing pilot shape as Wednesday, plus: Sean gets the panel; you watch fires-vs-
holds live; debrief adds "did the chime earn its interruptions?" The meter lines give
the real per-day $ number to hold against the $34-48/mo estimate.

## DELIBERATELY NOT IN THIS PILOT (all additive later)

- The unwired client state spine (coachState/phaseMachine/…, ~160 tests) — different
  render contract, zero pilot dependency (recon-verified).
- The bus-task closeout grader swap (audit E1) — recon wrote the exact ~40-line adapter
  plan (late-bound `liveCoach.callGrader`, `AI_TASK_LIVECOACH_CALLGRADER_ENABLED`),
  Thursday+ scope.
- The typed chime card + layered script canvas UI — design/mock only; A's says render
  through the EXISTING dialog card today.
- Remaining bus-audit debt that a direct-API pilot never touches (B1 model-policy
  surface, D3 proxy drain leak, F1-F5 streamlines).
