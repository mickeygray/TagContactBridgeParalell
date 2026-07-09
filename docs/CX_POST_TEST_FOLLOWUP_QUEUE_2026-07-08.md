# CX FOLLOW-UP QUEUE — post-test tightening + review (living doc, started 2026-07-08)

The parking lot for queue-rail work that is REAL but not blocking the current test
window. Items get pulled from here after each test cycle (tighten → review → next).
Rule of the doc: every item names its trigger (when it becomes due) and its owner.
Checked = done + gated. New items append under the right section with a date.

## 1 — THE TOP ITEM: 8AM NO-SHOW RELEASE (due BEFORE FRIDAY)

- [ ] **Build `cx-pilot-queue.js noshow-release`** per the corrected mechanics
      (2026-07-08 second pass): check at 8am → an agent with staged leads and zero
      dialing forfeits them → **RingCX cleanout FIRST** (cancel their campaign's
      undialed copies via the `rcxVisibility*` stamps — the count-conflict killer for a
      late login) → Mongo release with **NO priority weight** (fresh leads divvy like
      any other) → distribution `--distribute pool|bottom` (pool = organic refill pulls;
      bottom = round-robin NORMAL-priority batch append, which lands at the bottom of
      each receiver's list natively). One-at-a-time re-feed: REJECTED, do not build.
      Owner: Codex (`.ai/context/CX_ROLLOUT_MARCHING_ORDERS_CODEX_2026-07-08.md` WO1).
      Trigger: before Friday's push; Sean being present makes it moot for this week's
      waves. Open choice for Mickey: pool vs bottom default (lean bottom for the
      same-day 8am case).
- [ ] **v2 (post-rollout): the ~8:35 PT auto-worker** — same check, flag-gated, beside
      the morning builder; `--to` becomes round-robin across agents with a session
      today. First-touch assignment stamps join the release set when lanes launch.
- [ ] **The "Mail call" hold button** (due this week; Sean runs on close-the-workspace
      verbally today): a Break-sibling with a distinct `mail-call` status — same entry
      mechanics as break (session paused + RingCX unavailable, so campaign dials can't
      ring mid-EX-call), but UNTIMED (perma-break, resume-only exit; the idle reapers
      must not kill it). Honor system now, auditable free: the pilot report annotates
      mail-call segments with the agent's EX CallLog activity — a hold with zero EX
      calls reads as a WATCH line. Owner: Codex (marching orders WO5). Standing theory
      it serves: EX inbound = true fastest-hand-wins; CX can't replicate that as an
      inbound queue (open to disproof, later).

## 2 — POST-TEST TIGHTENING (pull after each wave/test cycle)

- [ ] **Drip end-of-day RingCX cleanup automation** — `drip-cleanup` currently releases
      Mongo rows and PRINTS the campaign/extern pairs for manual console clearing;
      wire `cancelPublishedQueueItemInRingcx` so the RingCX copies cancel in the same
      armed pass. Trigger: after the first drip test day proves the flow.
- [ ] **No-session drip recognition** — the fresh-touch drip lands on Sean like a
      normal live call; the NEW workspace only paints lane/bulk calls it owns. Decide
      whether a drip call mid-bulk-session deserves recognition (banner/pill) or stays
      deliberately invisible. Trigger: Sean's first drip-live block feedback.
- [ ] **Loader windows (the 5pm buffer → 6pm round-robin loader → 8am ready)** — the
      clock (F2-C) and post-8am assigned-first reserve (F2-D) exist; the 6pm
      consume-the-buffer loader that pre-builds RingCX dial lists is the missing piece
      (and the thing that makes the no-show cleanout load-bearing). Trigger: after the
      waves prove the serving surface; pairs with the lane launch.
- [ ] **Per-agent dial-group priority rollout** — enableAbsolutePriority=true +
      campaignPriority (Appointment 10 / First Touch 5 / regular 1) on groups 1011,
      1012, 1014, 1067, 1068 (group 963 already done). One API pass, settings pattern
      in sprint memory. Trigger: lane launch, NOT the bulk waves.
- [ ] **Pilot-family exit plan** — when the rollout ends, decide: keep `pilot` as the
      permanent staging family for agent batches, or tombstone it (enum + normalizer +
      reserve-mode hook + tool). Trigger: full-floor acceptance.

- [ ] **CX inbound click-to-claim — two 10-minute probes decide it** (researched
      2026-07-08; full recon in sprint memory). Native RingCX CANNOT do it (push-ACD
      only: serial offers by rank/skill/longest-idle with acceptTime requeue — no
      blast, no claim API; Mickey's EX theory CONFIRMED). But the app-mediated rail is
      composable from existing, mostly production-proven parts, two shapes:
      (a) RingCX-side: mail DID → agentless holding gate → app polls activeCalls/list
      (queued calls visible by uii) → floor-wide claim card (wrap-card CAS pattern
      verbatim) → first click → `requeueCall(uii, gateId=claimer's personal gate)` →
      pause via the existing setAgentState. PROBE: does requeueCall accept a
      still-queued call (docs only show agent-connected examples)?
      (b) EX-side: mail queue → holding softphone anchor (vm-answerer pattern, loop
      hold audio) → claim card → blind-transfer the HOLDING party to the claimer's ext
      (the nailed-leg transfer cost lands on the anchor, not an agent). PROBE: does a
      bulk agent's station take a plain RC inbound cleanly while AUX-paused?
      Honest cost either way: claim→connect is ~2-10s, vs EX's answer-IS-the-claim
      instant pickup. The rail's real win arrives when the whole floor is mid-dial on
      bulk (deskphone racing stops working). Trigger: the duplicate-instance test
      window; write the probes cx-dispo-probe style first.
      **(c) THE HYBRID (Mickey 07-08, likely the winner short/mid-term): the number
      stays (or lands on) an EX simultaneous-ring queue — the answer stays the atomic
      claim, zero new telephony — and the APP reacts to the winner. HARD CONSTRAINTS
      (Mickey: "we've seen what happens having an ex poller, it can wrestle people —
      sharper focused than just check everyone"; these are law, not preference):
      · PUSH ONLY, NEVER POLL — the old wrestling was the level-triggered ~30s poller
        reconciling everyone; reconcilePolledPresence stays dead.
      · ONE SUBSCRIPTION, QUEUE-SCOPED — subscribe to the MAIL QUEUE's own leg
        (ext 500 / its DID), not to any agent's presence; the answered party carries
        the winner's extensionId (payload shape = one probe on the duplicate instance).
        There is NO per-agent watch surface at all.
      · EDGE-TRIGGERED, ZERO RECONCILIATION — two edges only: connected(sessionId,
        extensionId) → fire the WO5 mail-call hold for that one agent; ended(sessionId)
        → resume. CAS-idempotent on telephonySessionId; replays no-op; nothing ever
        re-checks or corrects state on a timer.
      · ZERO STATE OWNERSHIP — the consumer writes NO currentCall/activePlatform/
        status; its only action is calling the same route the mail-call button calls
        (a finger pressing the button, not a second brain). Coupling #2 (sanctioned),
        never the cut coupling #3.
      · FAILURE = ABSENCE, NOT HARM — webhook dies → auto-pause stops, agents fall
        back to pressing the WO5 button. The button is the PERMANENT fallback layer,
        not a stopgap.
      · isLikelyCxBridgeExCall suppression mandatory (CX bridge legs must never
        self-pause); ring NEVER pauses (a queue ring must not empty the dial pool).
      If the number must ENTER CX first (campaign-owned DID), an IVR transfer node can
      hand the call to the EX queue DID — extra hop + split attribution; only do it if
      CX must own the number. Sequencing: WO5 manual button ships first, proves the
      hold semantics with humans; the queue-scoped trigger then makes it automatic
      without adding a single new writer to agent state.**
- [ ] **The ex-busy auto-pause is already built, dark** — `RC_CX_EX_BUSY_GATE_ENABLED`
      flips CX desiredAvailability=unavailable on a CONNECTED EX call (ring deliberately
      doesn't pause). BUT it feeds on EX presence events that are currently ack-only
      ("cx-bulk-alpha-test-disable-ex-presence-side-effects") with zero RC push
      subscriptions active — enabling it is a re-wire decision entangled with the
      EX↔CX decoupling doctrine, not a flag flip. Trigger: after WO5's manual button
      proves the workflow; this is its automatic successor.

- [ ] **Connect-rate canary** (born of the 07-08 carrier-block afternoon: freezes + RC
      "Suspect" lockouts, diagnosed as carrier ANI-blocking upstream of CX after an
      hour of app-side suspicion): the drain/watcher already sees every dial's
      outcome — add a rolling 15-min connect-rate line to cx-floor-watch (and a red
      flag when it falls off a cliff), so the NEXT block announces itself in minutes.
      Pair with per-ANI daily dial caps (the burn pattern = volume + short-duration
      no-answers per number). Tool that exists now: scripts/rcx-shift-caller-ids.js
      (list = the burn map; shift = per-campaign callerId swap, dry-run default).
      Remediation lane per incident: Free Caller Registry + RC attestation ticket.

## 3 — REVIEW / RULINGS (Mickey's, one line each after the call)

- [ ] **Logics transient-vs-confirmed** (cert blocker #4): a Logics OUTAGE during an
      eligibility check currently cancels inventory exactly like a confirmed DNC.
      Recommended: transient failures block the single dial, never cancel rows.
- [ ] **Revert case 101617 WYNN Logics status** (still DNC from Morgan's wrap test)
      + the formal `cx-wrap-drill --arm` run for ledger #4's record.
- [ ] **Wrap picker timezone-explicit** (cert blocker #6) — Codex WO3; verify-then-do.
- [ ] **sync-indexes allowlist carries CxCallWrapCard** — Codex WO3; believed done,
      verify.

## 4 — DEFERRED BY DESIGN (do not pull early)

- **Ledger #4 cut** (legacy drain-side auto-summary fallback): stays as the flag-off
  parachute through the first floor week.
- **Cut-map §3** (legacy queue auto-serve client slab): post-floor.
- **WO-28 / EX presence ownership**: post-floor, per its own trigger.
- **Ubuntu deploy Phase 4b flag gate**: wrap + classifier flags into the live `.env`
  BEFORE the deploy restart — without them a deployed floor has ZERO DNC path. Rides
  push day, owner Mickey, checklist assembled by Codex WO4.
- **Coach-track items live in their own docs** (two-station runbook + bus audit): E1
  grader bus swap, state-spine wiring, typed chime card, daily spend ceiling on the
  two-station loop, Aug-31 Sonnet pricing re-check. Not queue work; listed so they
  aren't orphaned.
