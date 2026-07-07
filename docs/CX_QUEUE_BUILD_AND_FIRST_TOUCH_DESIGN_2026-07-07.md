# CX Queue Building + New-Lead First Touch — design capture (Mickey, 2026-07-07 ~00:30)

**The ruling, in the owner's words:** *"anything added from 5pm–7:45am pst gets divided
amongst the agents as the first things we call in the morning is all new. then once those
all get touched the queues fill normally, with balanced greens blues yellows and reds. …
as a new lead is minted on 4001 it sends it as a call to a round robin style serve to the
first touch queues with priority immediate (the set up for those is in cx: 'CX Brad First
Touch' etc). … it's really about the contents of the list at specific times, respecting the
touch count and the timeout between calls, and cycling real calls."*

**Status: DESIGN CAPTURED, build pending.** Nothing wired.

## What already exists (recon 2026-07-07 — build ON these, don't reinvent)
- **The color tiers ARE the queue families:** green=`fresh-day1`, blue=`fresh-day2to10`,
  yellow=`fresh-day16to30`, red=`aged`. "Balanced" = the existing `mix` reserve mode
  (`buildFamilyTargets`, cxReserveModeService — per-family targetOpen ~15/10/5/5 with the
  `RC_CX_AGED_MIN_RESERVE_PER_CYCLE` red-throughput floor FM-4b).
- **First-touch policy gates exist:** `queuePolicy.fresh.firstTouchEligible`
  (cxQueuePolicyService:338, enforced in cxLoadBalancerService:279 — "queue-policy-blocked-
  first-touch"). Hourly caps exist on the policy (`hourlyCap`).
- **IMMEDIATE dial priority exists** on the dial-request path (`ringcxDialPriority:
  "IMMEDIATE"`, cxWorkspaceService buildQueueDialRequest — used by next-call handoff).
- **Per-agent first-touch queues exist IN RINGCX** ("CX Brad First Touch", …) — configured,
  waiting for a dispatcher.
- **The constraint machinery from this sprint:** touch counting (terminal attempt proof,
  per-UII idempotent), timeout-between-calls (cadence `nextDelayMinutes` + the 2-hour
  served-quarantine from the wrap design), pool hygiene (ghost guard + resync + the
  self-verifying build check promised in the floor experiment).
- **An ordered-load session mode exists** (run-4's `cxbl-ordered-*` sessions with
  `stats.orderedAcceptedCount` — the loader can already load a SPECIFIC ordered list).

## Lane 1 — THE MORNING BUILD (overnight-first, then balanced)
- **The overnight set:** leads created 17:00 → 07:45 America/Los_Angeles. Tag at mint time
  (`metadata.overnightBatch: <morning-date>`) — membership is decided by CREATION time, not
  by when the build runs.
- **07:45 build:** divide the overnight set among the day's agents round-robin (balanced by
  count; assignment stamped on the rows), and each agent's queue loads OVERNIGHT-FIRST via
  the ordered-load mode. These are all first touches — priority position, all new, morning
  energy on fresh leads.
- **Exhaustion → normal fill:** once an agent's overnight slice is all TOUCHED (first
  attempt recorded — the touch counters say so), refill reverts to the standard `mix`
  family targets (balanced green/blue/yellow/red). Mechanically: a reserve-mode wrapper —
  `overnight-first` drains the tagged set before delegating to `buildFamilyTargets(mix)`;
  the refill machinery (gate 8) already refills toward targets from live composition.
- Leftover overnight leads an absent agent never touched: rebalance to present agents at a
  mid-morning sweep (owner call — see open questions).

## Lane 2 — THE LIVE DRIP (new lead minted during the day)
```
lead minted (intake, port 4001)
  → round-robin pick the next agent (among today's active first-touch agents)
  → publish ONE lead to that agent's RingCX first-touch queue ("CX <Agent> First Touch")
    with dialPriority IMMEDIATE
  → RingCX dials it as the agent's next call
  → M2 alert in the UI: "brand-new lead from the first-touch queue" (the one allowed
    new-lead modal — the agent must KNOW this isn't their bulk list)
```
- **Watcher integration (the real build):** a first-touch call arrives with a NON-cxbl
  extern, so the bulk watcher's relevantCalls filter would drop it today. The first-touch
  lane needs its own extern convention (`cxft-<agent>-<leadId>`), and the watcher must
  recognize it as an EXPECTED interrupt: present it (M2), let the current bulk call finish
  per normal rules, and record its outcome through the same terminal outbox (source
  `first-touch`). One outbox, one drain, one wrap-card path — the new lane reuses the
  entire exit machinery including the 2h quarantine and the wrap card (a first-touch
  answered call is EXACTLY the card's target).
- **Round-robin state:** a small durable pointer (who got the last drip), skipping agents
  who are off/unavailable (presence via the availability router). Fairness across the day,
  not per-hour.

## The constraint contract (the "really about" list, one owner each)
| Constraint | Owner | Mechanism |
|---|---|---|
| List contents at specific times | the morning build + reserve-mode wrapper | overnight-first until drained → mix targets; window 17:00–07:45 PT by mint time |
| Touch count | the terminal attempt proof (exists) | per-UII idempotent counters; policy `hourlyCap`/family caps decide eligibility; overnight slice "done" = every row touched once |
| Timeout between calls | cadence + quarantine (exist) | `nextDelayMinutes` per family plan; the 2-hour served-quarantine floors ALL re-surfacing; first-touch drip leads inherit both after their first touch |
| Cycling real calls | pool hygiene (exists) + build verification | ghost guard + resync keep the pool honest; the loader's self-verifying build check (reserved == published == loaded, PASS/FAIL printed) runs at every morning build |

## Reads → writes (per component)
| Component | consumes | produces |
|---|---|---|
| Intake tagger (4001) | new lead creation events | `metadata.overnightBatch` stamp OR a live-drip dispatch |
| Morning builder (07:45 cron) | overnight-tagged rows + agent roster | per-agent ordered loads (overnight slice first) + build-verification PASS/FAIL |
| Reserve-mode wrapper | agent's untouched-overnight count | overnight-first targets → delegates to mix when drained |
| Drip dispatcher | round-robin pointer + presence | one IMMEDIATE publish to one agent's first-touch RingCX queue + M2 signal |
| Watcher (extended) | cxft-* externs | first-touch call presentation + terminal rows (source first-touch) |
| Exit path (unchanged) | terminal rows | drain → wrap cards → resolutions — identical for both lanes |

## Build order (proposed)
1. **Intake tagging + the 07:45 morning builder** (server-side, cron via the scheduler;
   ordered loads already exist) — delivers the morning experience with zero UI work.
2. **Reserve-mode wrapper** (`overnight-first`) — small, pure, pinnable like buildFamilyTargets.
3. **Drip dispatcher** (round-robin + IMMEDIATE publish to the existing RingCX first-touch
   queues) — server-side; calls arrive on agents' phones even before the UI knows.
4. **Watcher cxft-* recognition + M2 alert** (the UI half — after WO-16's projector, per the
   standing sequencing).
5. Mid-morning leftover rebalance + reporting (counts of overnight touched/untouched per
   agent — feeds the metrics panel).

## Open questions for the owner
- Round-robin scope: ALL rostered agents or only currently-available ones? (Drafted:
  available-only for the drip; all rostered for the morning division.)
- Leftover overnight leads when an agent is out: rebalance at a fixed time (10:00?) or
  leave for their return?
- Does the live drip fire while the target agent is MID-CALL (IMMEDIATE queues behind the
  current call) or skip to the next agent in the ring? (Drafted: queue behind — it's their
  lead; RingCX IMMEDIATE handles the ordering.)
- Weekend/holiday windows: does Friday 5pm → Monday 7:45am all count as one overnight set?
- Touch definition for "once those all get touched": any dial attempt, or connect-or-better?
  (Drafted: any attempt — a ring-out IS a touch for ordering purposes.)
