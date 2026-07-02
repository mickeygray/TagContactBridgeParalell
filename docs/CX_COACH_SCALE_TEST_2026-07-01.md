# Live Coach — STRATEGIST Prompt Scale Test (2026-07-01)

Scale-test of the two-station coach's **STRATEGIST** prompt (`coachTwoStationPrompts.buildStrategistRequest`)
across 7 annotated tax-resolution call fixtures, graded by an independent LLM-judge workflow.

## Result: PILOT-SAFE — 27 PASS / 1 PARTIAL / 0 FAIL / 0 doctrine violations

Two independent runs, each 28 checkpoints (7 fixtures × 4). Safety/compliance dimensions
(context, objections, filter, doctrine) scored a perfect **28/28 both runs**. The only sub-2
dimension is `opportunities` (~3/28 = 1), and it is a play-quality nit, not a safety issue.

## Harness

- `scripts/coach-eval/run.js` — loads each `fixture-*.js`, builds the strategist request on the
  transcript-so-far at every checkpoint, runs real Sonnet 5 via the Anthropic API
  (`apiRunner.js`, key from repo `.env`), thinking OFF, `cache_control` on the ~24k reference.
  Flags: `--all` (every fixture), `--compact` (scorecard), `--dump=<path>` (full per-checkpoint JSON).
- Cost: ~$0.02/checkpoint, ~$0.54 per full 28-checkpoint sweep.
- Fixtures: `fixture-tax-call-01` (baseline) + 6 workflow-authored — `hostile-dnc`, `noise-heavy`,
  `hard-no`, `fast-yes`, `complex-tax`, `rambling`. Each is 24–30 turns with intentional STT garble
  (`see pee five oh four`→CP504, `el tee eleven`→LT11, `leen`→lien, `garnishmint`, `[static]`,
  IVR `press one to accept`, Spanish bleed) and a per-checkpoint rubric
  `{context, objections, opportunities, filter}`.
- Judge: a 3-phase workflow — one blind judge per checkpoint grades the actual output vs its rubric
  + an explicit doctrine (DNC-terminal, tax-general/no-OIC, advance-only-on-a-genuine-no incl. HOLD,
  take-the-yes, filter-STT-garble, don't-fabricate, SSN-deferral-is-correct); every FAIL/violation is
  re-verified by a second adversarial audit; a synthesis produces the scorecard.

## What the test found and fixed

### 1. Production parse defect (`repairModelJson`)
The `noise-heavy` t22 checkpoint failed to parse. Root cause was **not** truncation
(`stop_reason: end_turn`, ~2070/4000 tokens) — Sonnet occasionally emits a **trailing comma**
before the closing brace (`"summary": "...", }`), which strict `JSON.parse` rejects. This traced to
the **production** path: `coachBatchRunner.coerceResponse` did `JSON.parse` and on failure silently
dropped the whole reground to `{guidance:[]}`.

Fix: `repairModelJson(text)` in `coachBatchRunner.js` — strict parse, then strip trailing commas
(`,(\s*[}\]])` — never touches commas inside string values), then isolate the outermost object/array
out of any prose wrapper; returns `null` only when genuinely not JSON. Wired into `coerceResponse`
(only the already-failing branch changes) and reused in the eval `apiRunner` so the harness parses
identically to production. +7 unit tests incl. the production-path end-to-end recovery. Clean re-run:
**0 parse failures.**

### 2. HOLD / silence ("sometimes no advice is okay")
The first run's only failures (2 FAIL + 1 PARTIAL, all in `fixture-hard-no`) were the same defect:
on a genuinely-handled, twice-declined prospect the strategist **wrote** the graceful exit but
benched it `rec:false` and crowned a reopen-probe (*"is the balance actually lower today…"*) to fill
the mandatory single-rec slot. The defect was the always-crown-a-play contract, not the model's read.

Fix: the STRATEGIST may now return an **empty `says` (a HOLD)** with the reason in `reasoning`, when a
line would be noise — the agent is executing well, a genuine calmly-declined no, or a compliant/DNC
close underway — and is explicitly forbidden from manufacturing a play or reopen-probe. The normalizer
already passes an empty `says` through as "no line" (`ensureOneRec([]) → []`), so zero plumbing change.

Re-run: **8/28 HOLDs, all judged PASS**; the three `hard-no` defects converted; no regressions. The
HOLDs cluster at one legitimate pattern — the agent just posed the alternative-choice close or the DNC
is underway, and the coach stays silent to let it land (previously these emitted hacky
`[Pause — let them answer]` pseudo-says).

## Remaining follow-ups

1. **`opportunities` polish (quality, not safety):** ~3/28 checkpoints identify the top lever
   (an active CP504/LT11 clock, an engaged spouse, a stated hardship) but park it in `remember`
   instead of the crowned `says`. Fix by forcing the single highest-value lever into the play —
   additive to lever-selection only; must NOT weaken the HOLD / filter / DNC / tax-general logic,
   which is at 28/28.
2. **DNC guardrail — design question:** on a DNC the coach now HOLDs (silent, safe) when the agent is
   already confirming removal. Decide whether to instead emit an affirmative "honor it, end now"
   guardrail line for a wavering agent.
3. **A/COACH station + B→A handoff cadence** still unbuilt (this test covers B/STRATEGIST only).
4. **No live wiring yet** — next per the plan: stress/guardrail tests → multi-conversation → wire.

## Per-fixture (final run)

| Fixture | Pass | Partial | Fail | Note |
|---|---|---|---|---|
| complex-tax | 4 | 0 | 0 | Held the tax-general guard at the "get it knocked down?" trap. |
| fast-yes | 4 | 0 | 0 | Take-the-yes on early buying signals; protected the close through garble. |
| hard-no | 4 | 0 | 0 | HOLD/backstop ×3; refused the reopen-probe. |
| hostile-dnc | 4 | 0 | 0 | DNC terminal HOLD; `press one` IVR never misread as consent. |
| noise-heavy | 4 | 0 | 0 | Heaviest STT load fully filtered. |
| rambling | 4 | 0 | 0 | Venting filtered out of case facts; corrected "just a bill". |
| tax-call-01 | 3 | 1 | 0 | Lone PARTIAL: generic discovery probe crowned, CP504 lever left in `remember`. |

## Cost model (measured 2026-07-01)

Two harnesses on the real Anthropic API (dedicated key, thinking off, reference cached):
`run.js` (B/STRATEGIST) and `run-window.js` (A/COACH — crystalize a B cockpit, tick A forward turn
by turn on Sonnet **and** Haiku).

**Measured unit costs:** B (big prompt) **$0.0173/reground**; A (small prompt) **$0.0072/tick on
Sonnet 5**, **$0.00225/tick on Haiku 4.5** (Haiku parsed 35/35 vs Sonnet 33/35 — more reliable on the
constrained "apply B's menu" task). B fires 1/3-min; A fires up to 6/min (every 10s, growth-gated).

**Per agent / month** (5h live-talk/day × 25 days = 7,500 talk-min; multiply by concurrent agents):

| Architecture | $/min talk | $/call-hr | $/agent-mo |
|---|---|---|---|
| Current built — big prompt every 10s | $0.07–0.10 | $4.15–6.23 | **$519–779** |
| Two-station, **A on Haiku** (recommended) | $0.015–0.019 | $0.89–1.16 | **$111–144** |
| Two-station, A on Sonnet | $0.035–0.049 | $2.07–2.94 | $259–367 |
| B-only (brain, no live layer) | $0.006 | $0.35 | $43 |

**Takeaways:** (1) A (small but ~18× more frequent than B) is the cost driver, not B. (2) The
two-station split is a **~4–5× cost cut** vs the current big-prompt-every-10s loop, at the same 10s
responsiveness — the economic case for building the A station. (3) Run **A on Haiku** — ⅓ the cost and
more reliable here. (4) Everything is talk-time-gated (holds/dials/dead-air = $0); raising the A
interval 10s→15s cuts A ticks ~6→4/min (the $144→$111 delta). All figures are API-rate on the
dedicated key = the real production cost, not an estimate.

### Batch scaling — "all N agents at once" (measured, `run-batch.js`, real `coachBatchRunner` DEEP path)

One batched call carries N conversations and returns N cockpits. Measured N=1/3/5/7:

| N | 1 batched call | per agent | output tokens |
|---|---|---|---|
| 1 | $0.0204 | $0.0204 | 1,364 |
| 3 | $0.0546 | $0.0182 | 4,732 |
| 5 | $0.0578 | $0.0116 | 4,654 |
| 7 | $0.1165 | $0.0166 | 10,094 (7 cockpits) |

Batched N=7 ($0.1165) is only **~4% cheaper** than 7 separate calls (7×$0.0173=$0.1211). The output
(one cockpit per agent) is irreducible and dominates; batching only dedups the shared reference
cache-read. **Conclusion: coach cost scales ~LINEARLY with concurrent active calls** — "all 7 at once"
is the right architecture (one round-trip, coherent cross-floor view) but ~linear, not flat.

### 7-agent floor / month (5h talk/day × 25d, ~4% batch discount, talk-time-gated)

| Architecture | $/agent-mo | **7-agent floor** |
|---|---|---|
| Current built — big prompt @10s | $498–747 | **$3,500–5,200** |
| Two-station, A on Haiku (recommended) | $106–139 | **$744–971** |
| Two-station, A on Sonnet | $249–353 | $1,742–2,468 |
| B-only brain (no live line) | $42 | $291 |

Finishing the two-station split + running A on Haiku takes a 7-agent floor from ~$3,500–5,200/mo
(current architecture) to **~$750–970/mo** — a ~$2,700–4,300/mo saving at the same responsiveness.
