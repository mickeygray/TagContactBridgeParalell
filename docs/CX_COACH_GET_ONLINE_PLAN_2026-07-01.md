# CX Coach — Get-Online Plan (2026-07-01)

Goal: the **rewritten coach prompting live on ONE agent, observed, this afternoon** — then iterate to the
full two-station. Grounded in what's actually built + what's on the live box.

## Where we are (grounded)

| piece | state | where |
|---|---|---|
| `coachSoloLoop.js` (single-call loop, cockpit+dialog, growth-gated) | **built, wired, 9 tests green, default-off** | LOCAL only |
| `coachSoloTransport.js` (Sonnet on `LIVE_COACH_SOLO_ANTHROPIC_API_KEY`) | **built, dormant when key unset** | LOCAL only |
| `coachTwoStationPrompts.js` (the REWRITE: B + A builders) | **built, 5 golden tests green** | LOCAL only |
| bus wiring `LIVE_COACH_COACH_MODE=batch\|solo`, `startSoloCoach` | **built** | LOCAL only |
| front-end (`cockpit`/`dialog`/`rollingSummary` render) + normalizers | **already exist** — no work | live + local |
| two-station Phases 2–5 (B runner, A runner, orchestrator, review) | **NOT built** (~a day) | — |
| any coach rewrite on the box | **NOT deployed** — box runs a diverged prod branch | — |

**Key reality:** the coach lives in `ai-bus` (:7000), separate from the control-plane/cx dialer. A coach
deploy + :7000 restart is **floor-safe** (allowed mid-floor; cannot affect dialing).

## Where we want to get — today (limited)

The **new strategist prompt** running on the **existing solo loop** (single-call), Sonnet, on **one agent**,
**observed** before it goes live-to-agent. This ships the rewrite today using all the tested plumbing; the
full B@3min/A@10s split is the next iteration (Phases 2–5 in `CX_COACH_TWO_STATION_LOOP_DESIGN`).

## TODO — TODAY (limited online)

- [ ] **1. Confirm the box's coach code state.** git-status / mtime of `apps/ai-bus/src/*` + `packages/shared-services/src/coach*` on the box — know exactly what we're deploying onto (the box is diverged; don't clobber a hotfix). *(read-only)*
- [ ] **2. Wire the new strategist prompt into the solo loop.** Make `coachSoloLoop` build its request via `coachTwoStationPrompts.buildStrategistRequest` (session transcript + reference) instead of `buildBatchGuidanceRequest`; parse the `cockpit` half via `parseBatchGuidance` (shape matches) — ignore the `rollingSummary` half for v0. Add/adjust a test. *(no-spend, local, default-off)*
- [ ] **3. Dedicated Sonnet key.** Provision `LIVE_COACH_SOLO_ANTHROPIC_API_KEY` (own metered key so cost is measurable + rate-isolated). Confirm `LIVE_COACH_SOLO_MODEL=claude-sonnet-5`.
- [ ] **4. Deploy coach files to the box (ai-bus only).** Targeted copy per `UBUNTU_LIVE_BOX_GUIDE` safe-patch rhythm: back up the box's current files, copy `coachSoloLoop.js`, `coachSoloTransport.js`, `coachTwoStationPrompts.js`, + the bus/server wiring; `node --check`; restart **`parallel-ai-bus` only** (floor-safe). Do NOT touch control-plane/cx.
- [ ] **5. Enable for ONE agent, default-off for everyone.** `LIVE_COACH_RUNTIME_MODE_BATCH_ENABLED=true` + `LIVE_COACH_COACH_MODE=solo` + agent-override so ONLY the pilot agent resolves to batch/hybrid mode (the `LIVE_COACH_RUNTIME_MODE_AGENT_OVERRIDES` pattern, like the dial runtime). Everyone else stays deterministic (no coach).
- [ ] **6. OBSERVE before live-to-agent.** Watch the pilot agent's `coach.cockpit` + `dialog` stream on the admin dashboard + journal on a couple of real calls — verify quality, cost ($/call on the key), zero errors/`sse_proxy.failed` storms. Kill switch = unset the key or flip `LIVE_COACH_COACH_MODE=batch` (instant off, it's gated).
- [ ] **7. Go live-to-agent (one agent).** Brief the agent, let the panel show it, watch the journal for the session. Measure a few calls' worth of $/quality.

## TODO — NEXT (full two-station, not today)

- [ ] **8. Phase 2 — B station runner** (3-min, reads full transcript+reference → cockpit + rollingSummary) + test.
- [ ] **9. Phase 3 — A station runner** (10-s lean, reads cockpit.says/dialog.guidance/summary+last turn → dialog + summaryText, via the canonical dispatch normalizer) + test.
- [ ] **10. Phase 4 — orchestrator + `LIVE_COACH_COACH_MODE=two-station`** (B@3min + A@10s, sequenced, cold-start silent) + e2e harness.
- [ ] **11. Phase 5 — adversarial review** (B-overwrite/A-increment race, cold-start, normalizer routing).
- [ ] **12. Phase 6 — measure $/day, drop A→Haiku, widen the pilot.**

## Safety / deploy notes

- Coach deploy = **ai-bus (:7000) only** — never restart control-plane/cx during floor hours (the dialer;
  see the reboot-congestion incident). Coach code cannot affect dialing.
- Everything is **default-off + one-agent-gated**; kill switch is instant (unset key / flip mode).
- The box is **diverged/dirty** — targeted file copies with backups, never a broad `git pull`/`reset`.
- v0 ships the **single-call new prompt**, NOT the B/A split. It proves the rewrite + cost + the live
  pipeline on one agent; the two-station is the next build, not a same-day dependency.
