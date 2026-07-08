# CX LANE EXPERIMENT 1 — THE INTERRUPT TEST (2026-07-08)

**Purpose:** prove, in one sitting, that (1) a synthetic new lead dispatches through the
first-touch lane and (2) a synthetic appointment fires AT its moment through the
appointment lane — both cutting into a NORMAL bulk queue about a minute apart — and that
(3) the lane modal narrates each interruption correctly (uii-gated, right face), while
(4) the bulk session underneath stays untouched.

**Everything is already built and gated (353/353).** This doc is the run.

---

## ⚠ THE ONE SAFETY RULE — MICKEY-ONLY MAPS DURING THE TEST

With `CX_APPT_LANE_ENABLED=true`, the clock dispatcher dispatches **any real scheduled
appointment that comes due** — and real ones exist in Mongo this week. For the test,
both maps must contain **only mgray@**:

```
CX_FIRST_TOUCH_QUEUE_MAP={"mgray@taxadvocategroup.com":<test-new-id>}
CX_APPT_QUEUE_MAP={"mgray@taxadvocategroup.com":<test-appt-id>}
```

Unmapped agents = loud skip, never a dial. Real agents' appointments stay app-side only,
exactly as today. **After the test: flip BOTH lane flags back to false** until launch.
(The full 5-agent maps are saved in this doc's appendix for launch day.)

---

## 0) PREFLIGHT — in order, skip nothing

1. **Console:** create the two test campaigns under YOUR dial group (the one your agent
   login dials from): **"test new"** and **"test appt"**. Default settings; leads load
   IMMEDIATE priority from our side.
2. `node scripts/cx-campaign-map.js` → both flagged with ids. Note the ids.
3. `.env`: set the two maps MICKEY-ONLY (above) + `CX_FIRST_TOUCH_ENABLED=true` +
   `CX_APPT_LANE_ENABLED=true`.
4. Restart: `Start-Service ParallelRestartHelper` (admin terminal).
5. Browser: hard refresh the workspace; confirm the bundle hash changed in console
   (the lane modal shipped in this build).
6. Dry-run the drill:
   `node scripts/cx-lane-drill.js --interrupt --phone <your cell>`
   → expect **"Prereqs all green"** + the runbook. Any NOT READY line = fix it first.
7. Be logged into RingCX as your agent, available on your dial group (the test campaigns
   must be able to reach you).

## 1) THE RUN

1. **Baseline:** build a small NORMAL queue in the workspace (~5 test leads, numbers you
   control), start the bulk session, dial through 1-2 leads like an ordinary day.
2. **Mid-queue**, second terminal:
   `node scripts/cx-lane-drill.js --interrupt --phone <your cell> --arm`
3. **Beat 1 (~15-45s):** the drill prints `[first-touch] DISPATCHED -> campaign ...`.
   Your cell rings via the **test new** campaign.
4. **Beat 2 (~60s after beat 1):** `[appointment] DISPATCHED at skew Ns`.
   Your cell rings via **test appt** — this ring IS the 4:30-fires-at-4:30 proof.
5. Work the bulk queue between and after the interruptions. Let the drill finish; read
   its VERDICT block. Cleanup: `node scripts/cx-lane-drill.js --cleanup <tag>`.

## 2) WHAT TO LOOK FOR

**The drill self-grades (trust its VERDICT):**
- both lanes dispatched by the LIVE dispatchers (not the drill — it only injects)
- published to YOUR mapped campaigns, `cxft-`/`cxapt-` externs
- **appointment fire skew within −5s/+45s** — the early-fire fix, live

**The modal (your eyes — the new machinery):**
- fires **only while the call actually exists** (ringing/active = uii present) — never
  before the ring, never from the dispatch alone
- FIRST TOUCH = emerald face, "LANE DRILL First Touch <tag>", "came in ~1 min ago", last-4
- APPOINTMENT = sky face, "booked for <time>"
- **auto-dismisses within ~8s of hangup** — no clicks anywhere
- the bulk queue area stays functional behind it (non-blocking)

**The bulk session (the do-no-harm check):**
- no case-panel wipes, no flicker, no ghost machinery touching the lane calls
  (foreign externs are ignored by design), queue resumes normally after each interruption

**The logs (if curious):** `cx.alpha.firsttouch.dispatched`, `cx.alpha.appt.dispatched`,
`control-plane.cx_first_touch.dispatch.tick` in the control-plane out-log.

**EXPECTED GAPS — do not read as failures:**
- **No wrap cards for the two lane calls.** Consumption (F2) is not built: lane terminals
  are not observed yet, the firstTouchPending flag is not released, no card mints. That is
  the next build; this test proves the SERVING half.
- The drill's queue row + appointment stay in Mongo until `--cleanup`; the RingCX copies
  in the test campaigns stay until dialed or cleared in console.

## 3) STOP-IFS (capture + stop)

- The modal fires with **no call ringing** (uii-gate violation) — screenshot + timestamp.
- The bulk session corrupts in any way (wipe, flicker, stuck state).
- The appointment fires more than ~45s off its moment (the skew verdict will show it).
- Anything dials an agent other than you (map containment failure — flip flags off).

## 4) AFTER

1. `--cleanup <tag>`; flip **both lane flags to false**; restart (or leave until morning —
   flags-off ticks are no-op env reads).
2. Verdict + notes back to Fable → next builds get sequenced: **F2 consumption** (wrap
   cards + flag release for lane calls), the 5pm/6pm/8am loader windows, the
   first-touch-first morning reserve, the 5-lead threshold rebuild.

## APPENDIX — the launch-day maps (full roster, bound 2026-07-08)

```
CX_FIRST_TOUCH_QUEUE_MAP={"slucas@taxadvocategroup.com":2831,"ballen@taxadvocategroup.com":2828,"polson@taxadvocategroup.com":2830,"bhansen@taxadvocategroup.com":2827,"cbolt@taxadvocategroup.com":2829}
CX_APPT_QUEUE_MAP={"slucas@taxadvocategroup.com":2902,"ballen@taxadvocategroup.com":2899,"polson@taxadvocategroup.com":2901,"bhansen@taxadvocategroup.com":2898,"cbolt@taxadvocategroup.com":2900}
```
(Anthony + James have no lane campaigns yet — console acts before they join the lanes.)

## THE DIAL-ORDER SAUCE (found + applied 2026-07-08)

Why IMMEDIATE wasn't jumping: RingCX priority is a DIAL-GROUP switch, and it was off.
Three knobs, all now understood:

1. **`enableAbsolutePriority` (dial group)** — THE switch: "dial higher priority
   campaigns before any others as long as they have active leads." Was FALSE on every
   group — campaign priorities were decorative. Now TRUE on group 963.
2. **`campaignPriority` (campaign)** — only matters with #1 on. Now: test appt 10 >
   test new 5 > bulk 1. An appointment lead beats a first-touch beats the bulk list.
3. **`dialLoadedOrder` (campaign)** — the test campaigns were CLONED carrying bulk's
   ordered mode (3 = load order), which pins FIFO regardless of insert priority. Lanes
   are now 0 (the real per-agent lane campaigns already were).

`enableListPriority` stays false (within-campaign IMMEDIATE weighting — unnecessary for
single-lead lane campaigns under absolute priority; fewer variables).

**FLOOR ROLLOUT NOTE:** every agent dial group (1011 sean, 1012 bruce, 1014 phil,
1067 Brad, 1068 Chris) needs the same flip before lane launch: enableAbsolutePriority
true + Appointment=10 / First Touch=5 / regular=1. One API pass when the lanes go live
(the settings script pattern is in the sprint memory).

## RESULT — PASSED (Mickey, 2026-07-08 evening)

"That worked. They came in in order on the bulk list, and the hot came in in the middle,
and the appointment came before the last one."

Proven live, end to end: mint → stamp → dispatcher claim/publish → ABSOLUTE-PRIORITY JUMP
(appt > first-touch > bulk, mid-list) → bulk order preserved around the interruptions →
center-screen takeover + lane disposition. The serving half of both lanes is DONE.

Remaining for the lanes (the consumption half + ops): F2 (flag release + wrap cards for
lane calls), the 5pm/6pm/8am loader windows, first-touch-first morning reserve + 5-lead
threshold rebuild, no-session drip recognition, per-agent dial-group priority rollout.
Per the safety rule: lane flags back OFF + cleanup when testing wraps.
