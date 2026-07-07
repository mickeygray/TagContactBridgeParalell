# First Touch — step-by-step implementation plan (written 2026-07-07 ~01:00)

Companion to `docs/CX_QUEUE_BUILD_AND_FIRST_TOUCH_DESIGN_2026-07-07.md` (the why). This is
the HOW: ordered steps, each with pins, DONE-WHEN benchmarks, and STOP-IF tripwires, in the
sprint's work-order style. Ledger discipline applies: declare the expected test delta before
every gate run (`node --test tests/cx-bulk-load/*.test.js`); a surprise delta = STOP.

## THE MODEL (Mickey's ruling, 2026-07-07: the temporary flag)
*"a temporary flag that gets released on consuming a cxft id so it doesn't bleed but is one
loop."*

- **Flag at mint:** every NEW lead's queue row is stamped `metadata.firstTouchPending: true`
  (+ `firstTouchMintedAt`). No window arithmetic — the 5pm–7:45am "overnight set" is simply
  "whatever is still flagged at build time." **This deletes the Friday→Monday problem:** an
  unconsumed flag survives any gap by having no date in it.
- **Flagged = OUTSIDE the family system.** Flagged rows are excluded from normal bulk
  reservation (they are pre-green). They enter the color families only after consumption,
  where their age classifies them naturally.
- **All first touches travel the cxft lane.** Morning batch AND live drip both publish to
  the per-agent RingCX first-touch queues (externs `cxft-<agentToken>-<queueItemId>`),
  which outrank the bulk campaign — so mornings are automatically "all new first," and when
  the first-touch queue drains, the bulk campaign takes over = "queues fill normally."
- **Release on consumption, exactly once:** when a `cxft-*` call TERMINATES (any outcome —
  a ring-out IS a touch), the drain clears the flag via CAS (`firstTouchPending: true →
  false`, + `firstTouchConsumedAt`, + the touch UII). The drain is the single Mongo writer
  (the layering law), so the release lives in the drain's business write. One loop, no bleed.

Feature gate: `CX_FIRST_TOUCH_ENABLED` (default **false**) — flag-off must be byte-for-byte
today's behavior at every step below.

---
## F0 — The flag: stamp, read, release (pure + repository)
**Build:**
1. `packages/shared-services/src/cxFirstTouchService.js` (new):
   - pure `isFirstTouchPending(row)` — true iff `metadata.firstTouchPending === true`.
   - pure `buildFirstTouchStamp(now)` → `{ "metadata.firstTouchPending": true,
     "metadata.firstTouchMintedAt": now }`.
   - pure `buildCxftExternId(agentToken, queueItemId)` + `parseCxftExternId(externId)`
     (mirror the cxbl extern conventions in cxBulkLoadLeadSourceService).
2. `cxDialQueueRepository.releaseFirstTouchFlag(queueItemId, { uii, at })` — ONE CAS:
   match `{ _id, "metadata.firstTouchPending": true }`, set pending:false + consumedAt +
   firstTouchUii. Returns null when already consumed (idempotent).
3. Stamp call site: wherever the intake (4001) creates the queue row for a NEW lead —
   append `buildFirstTouchStamp()` to the row creation, gated on the env flag.
**Pins (+4 declared):** stamp shape; parse/build extern round-trip; release CAS releases
once (fake repo double-call → second returns null); isFirstTouchPending edge cases.
**DONE-WHEN:** gate green at declared count; a hand-minted row in Mongo shows the stamp;
flag-off mints show NO stamp.
**STOP-IF:** the stamp call site touches any code path shared with the reservation CAS
(it must be creation-time only).

## F1 — Reservation exclusion (flagged rows are invisible to bulk)
**Build:** add `"metadata.firstTouchPending": { $ne: true }` to the bulk reservation's
source query (reserveFromFamilyOrder's row selection in cxDialQueueRepository) — gated:
the filter applies only when `CX_FIRST_TOUCH_ENABLED`.
**Pins (+2):** flagged row never reserved (fake query assertion / integration-shape test
mirroring the existing reservation pins); flag-off = query unchanged (byte-equality pin on
the built query object).
**DONE-WHEN:** gate green; with the flag on locally, a flagged row sits unreserved through
a queue build while unflagged rows reserve normally.
**STOP-IF:** any change to the CAS from-states or reservation metadata — this step is ONE
query filter, nothing else. (Reservation is refactor-fragile — locked invariants apply.)

## F2 — Consumption in the drain (release on cxft terminal)
**Build:** in the drain's business write path (the terminal handler or the drain hook —
implementor's choice, but it must ride the drain, not the watcher): when a drained terminal
row's externId parses as `cxft-*` (or payload.source === "first-touch"), call
`releaseFirstTouchFlag(queueItemId, { uii, at })`. Fail-soft; log
`cx.alpha.drain.first_touch.released` with `{ queueItemId, uii, alreadyConsumed }`.
**Pins (+3):** cxft terminal releases the flag; bulk (cxbl) terminal does NOT touch it;
double-drain/replay releases once (CAS pin).
**DONE-WHEN:** gate green; the wrap-drill pattern proves it live later (F5).
**STOP-IF:** any temptation to release the flag from the watcher — the drain is the single
writer, full stop.

## F3 — The drip dispatcher (live mints, round-robin, IMMEDIATE)
**Build:** `packages/shared-services/src/cxFirstTouchDispatchService.js` (new, injected
deps, pure-testable core):
1. Durable round-robin pointer (one small doc: `{ _id: "cxft-round-robin", lastAgent }`).
2. `dispatchNewLead(queueItemId)`: roster = configured first-touch agents
   (`CX_FIRST_TOUCH_AGENTS` env list v1; availability-filtered via the presence router,
   available-only per the drafted ruling); pick next after `lastAgent` (skip unavailable);
   publish ONE lead to that agent's RingCX first-touch queue with the `cxft` extern and
   `dialPriority: "IMMEDIATE"` (reuse the existing publisher/dial-request machinery — the
   IMMEDIATE path exists in buildQueueDialRequest); advance the pointer (CAS).
3. Hook: the intake (4001) calls dispatch after stamping, ONLY inside dialing hours
   (outside hours = stamp-and-accumulate; the morning build sweeps them).
4. No agent available → no dispatch, flag simply persists (the loop is self-healing).
**Pins (+4):** round-robin order + skip-unavailable (pure picker); pointer CAS (no
double-advance on race); after-hours = no dispatch; publish payload carries the cxft
extern + IMMEDIATE.
**DONE-WHEN:** gate green; drill (F5) proves distribution order live.
**STOP-IF:** the dispatcher writes ANY Mongo state beyond the pointer + publish stamps —
exterior publish + pointer only (layering law).

## F4 — The morning builder (07:45 America/Los_Angeles, cron)
**Build:** a scheduled job in the control plane (same pattern as the cx_appointments tick):
1. At 07:45 PT (env `CX_FIRST_TOUCH_BUILD_AT`, default "07:45"): scan ALL
   `firstTouchPending` rows (no date filter — the flag model). Sort oldest-minted first.
2. Divide round-robin across the ROSTER (all rostered agents for the division, per the
   drafted ruling — absent agents' slices rebalance at the mid-morning sweep, see 4).
3. Publish each agent's slice IN ORDER to their first-touch queue (cxft externs, normal
   priority — the queue itself outranks the campaign; IMMEDIATE is reserved for the drip).
4. Mid-morning sweep (env `CX_FIRST_TOUCH_REBALANCE_AT`, default "10:00"): rows still
   flagged AND published to an agent who has zero presence today → re-publish round-robin
   to present agents (release the old RingCX copy first — the ghost-guard canceller exists).
5. **Self-verifying build (the verification-never-gets-done law):** the job's last act
   prints/logs PASS/FAIL: `flagged == published == ringcxAccepted` per agent + total, and
   `cx.alpha.first_touch.build` carries the counts. FAIL = loud log + no partial silent
   success.
**Pins (+3):** division math (pure: N leads × M agents, oldest-first, remainder fairness);
build-verification verdict shape; rebalance selection (pure).
**DONE-WHEN:** gate green; a local run with 5 synthetic flagged leads + 2 agents produces
3/2 split, publishes, and prints PASS.
**STOP-IF:** the builder reserves rows through the bulk reservation path — first-touch
publishing must NOT consume family targets (flagged rows are outside the family system).

## F5 — The drill + benchmarks (before any human tests)
**Build:** `scripts/cx-first-touch-drill.js` (self-grading, the house pattern):
1. Mint 4 synthetic flagged leads (drill-tagged, unique names).
2. Run the builder function directly (not waiting for 07:45) → assert division/publish/
   verdict PASS.
3. Simulate consumption: inject cxft terminal outbox rows for 2 of them → live drain
   releases those flags (assert consumedAt + pending:false + released-once on replay).
4. Assert the 2 unconsumed stay flagged (the Friday property: no date math, they'd ride
   the next build untouched).
5. Assert a flagged row is invisible to a reservation cycle while an unflagged control
   row reserves.
6. Print the verdict table + cleanup command.
**Floor benchmarks (the acceptance bar, measured by the drill + first live morning):**
- Build time: < 60s for a full overnight set.
- Drip latency: mint → RingCX accepted < 10s (log-timestamped).
- **Zero bleed:** consumed flags == cxft terminals, exactly; zero rows flagged-and-consumed;
  zero rows that lost the flag without a cxft terminal (the ledger query is part of the
  drill).
- Morning experience (human bar, Mickey's words): *"the first calls of the day are all new
  leads, and when they run out the mix takes over without me doing anything."*

## F6 — UI half (M2 alert + cxft presentation) — AFTER WO-16, per standing sequencing
The watcher learns `cxft-*` externs as EXPECTED interrupts (extern recognition + M2 "brand
new lead" alert + disposition wiring through the same terminal path). Until then the server
lanes run headless: calls arrive via RingCX's own queue priority, outcomes flow through the
watcher's observational machinery, flags release in the drain, answered cxft calls make
wrap cards like any other conversation. The UI half changes what the agent SEES, not what
the system records — deliberately last.

---
## THE SPLIT
- **Executors:** F0, F1 (with the STOP-IF respected to the letter), F3, F4, F5 — patterns
  all exist in-tree (pure service + repository CAS + scheduled tick + drill script).
- **Fable:** F2 (drain surgery — single-writer territory), the F1 review (reservation is
  refactor-fragile), F6 (watcher surgery), and the diff review on every step per the
  sprint's standing rule.
- **Mickey:** env roster + RingCX first-touch queue IDs config, the flag flip, restarts,
  and the first live morning.

## Open rulings folded in (from the design doc, now decided by the flag model)
- Weekend window: SOLVED — flags have no dates.
- Touch definition: any cxft terminal (a ring-out consumes — it was a touch).
- Still open: drip queues-behind vs skips a mid-call agent (drafted: queue behind);
  mid-morning rebalance time (drafted 10:00).
