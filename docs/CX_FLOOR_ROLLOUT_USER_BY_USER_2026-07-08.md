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
| `scripts/cx-pilot-queue.js refresh --max 5 [--arm]` | **the new-stuff tee**: MOVE up to N brand-new, still-unassigned `fresh-day1` intake rows into the pilot family (move, never copy — one-active-row law; the rest of intake flows to the floor untouched; reversible via `undo`) | dry-run default |
| `scripts/cx-pilot-queue.js status / cleanup / undo` | count by state / cancel unserved batch rows / restore teed rows | cleanup+undo need `--arm`; never touch a row that already dialed |
| `scripts/cx-floor-watch.js` | **the logs-that-watch-everything station**: every agent's session journeys (DIAL→ANSWER→TERMINAL→DRAIN→CARD→RESOLVE + stall warnings) + live tail of the NSSM service logs (red-flags: unknown sysdispo token, [cx][wipe], drain failures, publish rejects) — everything mirrored to `logs/floor-rollout/watch-<stamp>.log` | only its own sink file |
| `scripts/cx-floor-pilot-report.js --agent slucas@... --archive` | end-of-block scoreboard with fail-closed verdicts + date-windowed log extract archived to `logs/floor-rollout/slucas-<date>/` | only its archive dir |

Safety net behind all of it: fillBuffer re-checks Logics contact eligibility live
(enforceStop) per case at serve time, and Sean's pilot terminals write the SAME
LeadCadence touch state the floor reads — so the floor sees his attempts (budget
consumed, scheduled cx actions suppressed): suppression, never double-dialing.

## WAVE 1 — SEAN (tomorrow)

### 1) Preflight (Mickey's hand, before 8am — never a mid-floor restart)

`.env` (this box):

```
CX_FIRST_TOUCH_ENABLED=false          # TRAP 2: still true from the interrupt test
CX_APPT_LANE_ENABLED=false            # TRAP 2: same
CX_ALPHA_TRACE_AGENT=                 # TRAP 1: currently mgray-only -> Sean would trace ZERO lines
CX_BULK_RESERVE_PILOT_FAMILY=pilot    # the isolation switch (this box only)
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
close-up.) Mid-morning, tee him a taste of new stuff:

```
node scripts/cx-pilot-queue.js refresh --max 5 --arm   # newest unassigned intake -> his queue
```

His running session picks the teed rows up on the next buffer refill — fresh lead, new
workspace, floor never saw them.

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
