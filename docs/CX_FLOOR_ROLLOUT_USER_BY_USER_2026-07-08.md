# CX FLOOR ROLLOUT — USER BY USER (Fable, 2026-07-08; rev 2 after the interference recon)

Expansion of `CX_ROAD_TO_FLOOR_CHECKLIST_2026-07-08.md` Phase 5. **Everything runs on
THIS Windows box** — the Ubuntu push is its own event (possibly Friday) and nothing here
depends on it. One agent at a time gets the new bulk workspace for observed blocks while
the floor keeps dialing exactly as today. Wave 1 = **Sean, tomorrow morning**.

## THE GROUND TRUTH (recon-verified, citations in sprint memory)

- **There is ONE data plane.** This box and the Ubuntu box point at the SAME Atlas
  Mongo (`tagcontactbridge_parallel`). The floor's dialing IS the CX cadence rail over
  the same `CxDialQueue` the bulk rail serves from — last 14 days: 10,419 floor calls
  (platform `cx`), the cadence assigner claims `ready` rows in the four floor families
  (fresh-day1 / fresh-day2to10 / fresh-day16to30 / aged) every ~5 minutes, from BOTH
  boxes. "Don't interfere with the floor" therefore means: **stay out of those four
  families and never create a second active row for a case.**
- **Sean already dials all day on the legacy CX rail** (1,677 calls/14d) into his OWN
  RingCX campaign: dial group 1011 "sean", campaign 2344. Nobody else routes to 2344.
  His live click-dials publish IMMEDIATE; bulk publishes NORMAL — his live work always
  outranks pilot leads even inside his own campaign.
- **Access exists**: the office reaches this box's web client via the nginx/ngrok front;
  Sean's account is seeded (email + OTP).
- **The pilot isolation family** (built 2026-07-08, gate 371/371): `queueFamily:"pilot"`
  — recognized by the schema/normalizer/reservation path, enumerated by ZERO floor
  queries on either box. A bulk session reserves it ONLY when this box's `.env` sets
  `CX_BULK_RESERVE_PILOT_FAMILY=pilot` (exclusive: such a session reserves nothing
  else). Rows are route-stamped to Sean's 50810001/2344/1011, so the reservation
  route-lock also keeps every OTHER bulk session out (a session on a different campaign
  reserves zero pilot rows — fail-closed). These changes ride Friday's push but stay
  inert on Ubuntu (env absent there).
- **Time-sharing, not swapping**: pilot rows live only in Mongo until Sean STARTS a
  bulk session — fillBuffer then reserves ~35 and publishes ONE AT A TIME; killing the
  session cancels its own unserved RingCX copies (extern-scoped — the rail cannot
  cancel leads it didn't publish). So Sean's day interleaves cleanly: pilot block =
  session running; the rest of the day = his live flow, untouched.

## THE TOOLS (all new, all default-safe)

| Tool | What | Writes? |
|------|------|---------|
| `scripts/cx-pilot-queue.js build --count 300 [--arm]` | mint the pilot batch from the safe pool: active WYNN leads, no cx dial in 30d, **no active queue row for the case** (2,353 busy cases auto-excluded in tonight's dry-run), not DNC/staged-out, phone+name present | dry-run default |
| **the Sean first-touch drip** (service worker, Mickey's patch shape — see the section below) | occasionally assigns ONE unassigned fresh intake mint to Sean and publishes it IMMEDIATE into his **First Touch campaign 2831** through the existing publish primitive — the fresh-touch experience test, full legacy semantics | flag-gated off + dry-run mode |
| `scripts/cx-pilot-queue.js refresh --max 5 [--arm]` | the bulk-workspace alternative tee: MOVE up to N unassigned `fresh-day1` intake rows into the pilot family so his BULK session serves them (move, never copy — one-active-row law; reversible via `undo`). Use the drip OR this per block, not both at once | dry-run default |
| `scripts/cx-pilot-queue.js status / cleanup / undo / drip-status / drip-cleanup` | count by state / cancel unserved batch rows / restore teed rows / account for + release undialed drip rows | cleanup+undo+drip-cleanup need `--arm`; never touch a row that already dialed |
| `scripts/cx-floor-watch.js` | **the logs-that-watch-everything station**: every agent's session journeys (DIAL→ANSWER→TERMINAL→DRAIN→CARD→RESOLVE + stall warnings) + live tail of the NSSM service logs (red-flags: unknown sysdispo token, [cx][wipe], drain failures, publish rejects) — everything mirrored to `logs/floor-rollout/watch-<stamp>.log` | only its own sink file |
| `scripts/cx-floor-pilot-report.js --agent slucas@... --archive` | end-of-block scoreboard with fail-closed verdicts + date-windowed log extract archived to `logs/floor-rollout/slucas-<date>/` | only its archive dir |

Safety net behind all of it: fillBuffer re-checks Logics contact eligibility live
(enforceStop) per case at serve time, and Sean's pilot terminals write the SAME
LeadCadence touch state the floor reads — so the floor sees his attempts (budget
consumed, scheduled cx actions suppressed): suppression, never double-dialing.

## THE SEAN FIRST-TOUCH DRIP (Mickey's patch shape, built 2026-07-08, 8/8 pins, gate 379/379)

Mickey's live read-only investigation set the shape: 4001 keeps minting fresh rows
exactly as it does today (`intake -> fireImmediateContact -> queueCxDialRequest`,
fresh-day1); a Sean-only flag occasionally selects one still-unassigned mint, assigns
it to Sean, and the existing RingCX publish loads it into his **First Touch campaign**.
No 4001 rewrite, no cxft lane machinery, no broad changes. Two adaptations from the
recon, both in Mickey's favor:

1. **It runs on THIS box, not live.** The shared Atlas Mongo means rows minted by
   live's 4001 are visible here instantly — the worker ticks inside this box's
   control-plane next to the lane dispatchers. Zero live patches, zero 4001 touches,
   zero live restarts. (Mickey's restart-cost analysis was for patching live; here the
   normal morning restart carries it.)
2. **It publishes via `publishBatchToRingcx` with the explicit campaign id** — the
   queue-item publisher resolves the per-agent env route FIRST (slucas → 2344, his
   bulk/live lane) and row stamps cannot override it; the batch publisher takes
   campaignId verbatim (same path the lane dispatchers used in the passed interrupt
   test). Extern stays the LEGACY convention (`parallel:WYNN:<caseId>:<rowId>`) so the
   call lands on Sean exactly like a floor fresh lead — cadence counters, follow-ups,
   his normal workspace handling, all unchanged.

Sean's known IDs (Mickey-verified): email slucas@taxadvocategroup.com · RC ext 445 ·
extension id 63756126004 · CX agent id 20845 · First Touch DG 1011 / campaign 2831 ·
bulk campaign 2344 (separate, untouched by the drip).

Flags (all read per tick; worker interval 60s inside the control-plane worker gate):

```
CX_SEAN_FIRST_TOUCH_TEST_ENABLED=true     # master (default false)
CX_SEAN_FIRST_TOUCH_DRY_RUN=true          # select+narrate, ZERO writes — run this first
CX_SEAN_FIRST_TOUCH_EXTENSION_ID=63756126004
CX_SEAN_FIRST_TOUCH_CAMPAIGN_ID=2831
CX_SEAN_FIRST_TOUCH_MAX_PER_TICK=1
CX_SEAN_FIRST_TOUCH_MIN_GAP_MINUTES=10    # "occasional", crash-safe (state in Mongo)
CX_SEAN_FIRST_TOUCH_WINDOW_MINUTES=30     # only genuinely NEW mints
```

Logs, exactly the requested set (all `cx.alpha.sean_ft.*`, phone/name masked, visible
live in `cx-floor-watch.js`): candidate seen · selected/skipped + reason (incl.
`claim-lost` when a floor claimer wins the race — their lead by design) · queue row id ·
assignment · publish result · extern id. Publish reject auto-releases the claim back to
the floor pool.

**Dry-run → live restart calculus:** flags load at boot, so flipping DRY_RUN off needs
a control-plane restart. Two clean paths — (a) morning restart WITH dry-run on, watch a
few narrated selections, then one brief control-plane-only restart mid-morning while
Sean has no bulk session running (the floor's dialing lives in ringcentral-cx + RingCX,
not here); or (b) go straight to live at the morning restart — blast radius is one
narrated lead per 10 minutes, max. Mickey's call on the day.

**End of test:** `node scripts/cx-pilot-queue.js drip-status` for the ledger;
`drip-cleanup --arm` releases undialed drip rows back to the floor pool (they are real
fresh leads) and prints the exact campaign/extern pairs to clear from 2831 in console.

## WAVE 1 — SEAN (tomorrow)

### 1) Preflight (Mickey's hand, before 8am — never a mid-floor restart)

`.env` (this box):

```
CX_FIRST_TOUCH_ENABLED=false          # TRAP 2: still true from the interrupt test
CX_APPT_LANE_ENABLED=false            # TRAP 2: same
CX_ALPHA_TRACE_AGENT=                 # TRAP 1: currently mgray-only -> Sean would trace ZERO lines
CX_BULK_RESERVE_PILOT_FAMILY=pilot    # the isolation switch (this box only)
CX_SEAN_FIRST_TOUCH_TEST_ENABLED=true # the fresh-touch drip (see its section)
CX_SEAN_FIRST_TOUCH_DRY_RUN=true      # narrate-only until you flip it (restart calculus in the drip section)
```

Note: while the pilot switch is set, EVERY bulk session on this box reserves only the
pilot family — your own bulk tests will see empty buffers (route-lock keeps you out of
Sean's rows). Unset it when you want to run your own bulk sessions.

Then: restart (`Start-Service ParallelRestartHelper`, admin), clean-boot check, hard
refresh, and build the batch:

```
node scripts/cx-pilot-queue.js build --count 300            # eyeball the picks
node scripts/cx-pilot-queue.js build --count 300 --arm      # write
node scripts/cx-pilot-queue.js status                       # ~300 ready
```

### 2) The brief (say to Sean, ~2 min)

- "Nothing about your normal day changes. For a couple of blocks today you'll also work
  a separate list from a new screen — same RingCX login, group 1011."
- "New screen: [the office workspace URL], log in with your work email + the code it
  sends. Hit start — it feeds you leads one at a time."
- "Three buttons: **Answer**, **No answer**, **Voicemail** — every lead leaves through
  one. No Skip, that's deliberate."
- "'Never call me again' = click **Answer**, then mark **DNC on the card** that pops up
  right after. Answered calls always make that card — appointment, DNC, or dismiss."
- "Break or done? Stop the session on screen first, then you're back to your normal
  flow. Anything stuck >15s, wave at Mickey — no refresh-mashing."

### 3) Block 0, ~8:00-8:30 — the controlled 10 (closes cert Gates 2 & 7)

Before the 300: a 10-lead controlled batch (numbers we control) through the same pilot
family (`build --count 10 --tag pilot-cert-<date>` against a hand-picked pool, or seed
via the existing drill scripts). Sean drives: answered / no-answer / voicemail / dead
number untouched / VM box / wrap-hold (prospect hangs up first, wait 30s, THEN click) /
one DNC card / one appointment card / one 5-min break+resume. Narrator running. File
Gates 2 & 7 into `CX_BULK_CERTIFICATION_SIGNOFF_2026-07-08.md` — cert fully signed.

### 4) Pilot blocks, rest of morning — the real 300, observed

Sean alternates on his own rhythm: pilot session blocks ↔ his normal live flow. Mickey's
station (ONE terminal now):

```
node scripts/cx-floor-watch.js
```

(Optional second terminal: `node scripts/cx-answer-progression.js` for the single-session
close-up.) The new stuff comes through **the first-touch drip** (its own section above):
dry-run narrations visible from the morning restart, flipped live on your call — one
fresh lead at a time ringing Sean through campaign 2831 exactly like a floor fresh
lead. Watch `cx.alpha.sean_ft.*` in the floor watch. (Alternative for a bulk-session
block: `node scripts/cx-pilot-queue.js refresh --max 5 --arm` moves fresh mints into
his pilot queue instead — one mechanism at a time, never both.)

Watch for: journeys completing end-to-end; `sys=` labels matching ears; cards minting
seconds after answered terminals; the persistent red toast on any failed card effect
(photograph it); Sean's *behavior* — what he reaches for that isn't there, whether the
wrap card interrupts his flow, whether the Communications/Logics panels get used.

**STOP-IFs** (stop the pilot, floor unaffected): a lead leaves the middle without a
click or machine verdict; an unexplained outcome row; his phone rings for a lead his
screen never showed; buttons dead >15s; any `[cx][wipe]`; ANY pilot lead appearing in
another agent's queue (containment breach — `status` + capture immediately).

**Rollback** = Sean stops the session and just... keeps doing his normal day. Then
`cleanup --arm` cancels the unserved batch, `undo --arm` returns teed rows, and the
pilot env line comes out at the next convenient restart.

### 5) Debrief, ~12:00

```
node scripts/cx-floor-pilot-report.js --agent slucas@taxadvocategroup.com --archive
node scripts/cx-pilot-queue.js status
```

Clean verdict block required: drain ledger zero-pending, answered==cards, cards all
resolved, zero unknown tokens, zero wipes, retry stash empty. Plus the five questions:
what surprised you / what was slower / what did you look for and not find / did any call
feel lost / would you keep it tomorrow. Accept → Sean keeps his pilot blocks and wave 2
schedules. Reject → rollback (above), findings become fixes.

## THE 8:30 NO-SHOW CHECK (Mickey's 07-08 rule, corrected same morning; iron out BEFORE FRIDAY)

An agent who got a morning batch and hasn't started dialing by ~8:30 forfeits it. The
mechanics, per Mickey's second pass: **no priority weight** (they're fresh leads —
divvied out like the other ones); **the load-bearing step is the RingCX cleanout**
(cancel their campaign's undialed copies so a late login can't double-dial/count-
conflict — extern-scoped, keyed on the rcxVisibility publish stamps); redistribution
is `pool` (organic refill) or `bottom` (round-robin NORMAL-priority batch append —
NORMAL lands at the bottom of the list natively). One-at-a-time re-feed: rejected.
Never touches a row that already dialed. Tool: `cx-pilot-queue.js noshow-release`
(dry-run default). Full mechanics + the open distribution choice:
`.ai/context/CX_ROLLOUT_MARCHING_ORDERS_CODEX_2026-07-08.md` Work Order 1.

## WAVES 2-5 (one agent per clean day)

Bruce (ballen@, 1012/2345) → Phil (polson@, 1014/2347) → Brad (bhansen@, 1067/2457) →
Chris (cbolt@, 1068/2458). Route entries already exist for all (and for the overflow:
jsharp@, awells@, acalloway@, manderson@). Waves 2+ = same shape minus the controlled
batch; each agent gets their own `build` batch (their email → their route stamps; the
same pilot family serves them all because reservation route-locks per session). After
two consecutive clean waves, two agents/day is allowed.

**Full floor** = every agent accepted + road-to-floor Phase 1 items done. THEN the
Ubuntu deploy conversation starts, at the Phase 4b flag gate (wrap flags into the live
`.env` BEFORE the deploy restart — without them a deployed floor has zero DNC path).

## UBUNTU PUSH-DAY CHECKLIST (produce only; no live-box writes from Codex)

This is a deploy-day checklist, not permission to touch the live box during rollout.
Mickey owns the live `.env`, deploy command, and restart timing.

**Required live `.env` gate before the deploy restart:**

```
CX_CALL_WRAP_QUEUE_ENABLED=true
CX_SYSDISPO_CLASSIFIER_ENABLED=true
```

Those two flags are not optional for a floor deploy: without wrap cards and the system
disposition classifier, answered-call DNC/appointment closeout and RingCX's own
ANSWER/BUSY/CONGESTION evidence do not have the production path this alpha is proving.

**Must stay absent/off on live unless a separate lane rollout explicitly says otherwise:**

```
CX_BULK_RESERVE_PILOT_FAMILY
CX_FIRST_TOUCH_ENABLED
CX_APPT_LANE_ENABLED
CX_SEAN_FIRST_TOUCH_TEST_ENABLED
CX_SEAN_FIRST_TOUCH_DRY_RUN
CX_SEAN_FIRST_TOUCH_EXTENSION_ID
CX_SEAN_FIRST_TOUCH_CAMPAIGN_ID
```

**Code that can ride the push inert:**

- `pilot` queue-family enum and reserve-mode support: inert without
  `CX_BULK_RESERVE_PILOT_FAMILY`.
- `cx-pilot-queue.js noshow-release`: manual tool only, dry-run default.
- Sean first-touch drip code: inert without `CX_SEAN_FIRST_TOUCH_TEST_ENABLED`.
- Lane dispatch/recognition code: inert while lane flags stay absent/off.

**Push-day readback after Mickey deploys/restarts:**

- Confirm live health endpoint and control-plane boot logs.
- Confirm no lane/drip worker logs appear on live.
- Confirm wrap-card route answers enabled.
- Confirm system-disposition classifier flag is active in startup/runtime logs.
- Confirm `sync-indexes` allowlist includes `CxCallWrapCard` before relying on card rows.
- Run read-only watch/report tooling only; no queue writes from Codex on Ubuntu.

## WHAT STAYS OFF / UNTOUCHED

- Lanes (first-touch + appointment dispatchers): OFF all waves — separate track.
- The coach panel: whatever its flag says; not coupled to this rollout.
- The Ubuntu box: untouched by the pilot; Friday's push carries the pilot-family code
  but the env switch stays absent there (inert by design).
- The four floor families, the cadence worker, the morning builder: never touched by
  any pilot tool (the build pool explicitly excludes every case with an active row).

## STANDING RULES (unchanged)

Mickey owns every .env edit, restart, and commit. No mid-floor control-plane bounces.
Pilot tools are dry-run by default and never cancel a row that already dialed. Phones
print last-4 everywhere. Tombstone before delete. `get-leads` survives.
