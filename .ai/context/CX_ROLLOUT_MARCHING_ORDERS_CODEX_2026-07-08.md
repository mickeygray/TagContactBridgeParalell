# MARCHING ORDERS — BULK-WORKSPACE ROLLOUT (for Codex, 2026-07-08)

Mission: run the user-by-user bulk-workspace rollout to done. Mickey owns every `.env`
edit, restart, commit, and `--arm`; you own code, tools, dry-runs, and evidence. Fable
owns a separate track (the coach stack + a duplicate-app test environment) — division
of labor below keeps you out of each other's diffs.

## READ FIRST (the ground truth, in order)

1. `docs/CX_FLOOR_ROLLOUT_USER_BY_USER_2026-07-08.md` (rev 2) — the wave plan and the
   interference model. The one-line summary you must internalize: **one shared Atlas
   Mongo; the floor's dialing is the legacy CX cadence rail over the SAME CxDialQueue;
   isolation = the `pilot` queueFamily (no floor query enumerates it) + per-agent
   route-stamp lock (rcxAccountId/rcxCampaignId/rcxDialGroupId must exactly match the
   reserving session's route).**
2. `docs/CX_ROAD_TO_FLOOR_CHECKLIST_2026-07-08.md` — phases + the Phase 4b deploy gate.
3. The tools: `scripts/cx-pilot-queue.js` (build/refresh/status/cleanup/undo/drip-*),
   `scripts/cx-floor-watch.js`, `scripts/cx-floor-pilot-report.js`.
4. The isolation code: `CX_BULK_RESERVE_PILOT_FAMILY` in cxReserveModeService.js,
   the `pilot` enum entry in CxDialQueue.js, the normalizer passthrough in
   cxLeadServing.js, pins in tests/cx-bulk-load/cxReserveModeService.test.js.

## STANDING RULES (non-negotiable, all pre-existing house law)

- **Dry-run default on every mutating tool; only Mickey arms.** Your job is to make the
  dry-run output so clear that arming is a glance.
- **No service restarts, no `.env` edits, no commits** — hand Mickey the exact lines.
- **The four floor families are radioactive** (fresh-day1 / fresh-day2to10 /
  fresh-day16to30 / aged): never write rows into them except via the release mechanics
  specified in Work Order 1. The cadence worker claims `ready` floor-family rows within
  ~5 minutes, from BOTH boxes.
- **One-active-row-per-case law**: never create a second active CxDialQueue row for a
  case (the `findActiveQueueItem(domain, caseId)` fallback cross-wires terminals).
- Phones print last-4 everywhere. Live Ubuntu box is read-only. Lane flags stay OFF.
- **Do not touch Fable's track**: `coachTwoStation*`, `coachTurnAccumulator`,
  `coachSoloLoop`, `liveCoachBusService`, `apps/ai-bus/**`, `scripts/coach-eval/**`,
  `apps/web-client/src/lib/liveCoach/**`. If a work order seems to require it, stop and
  flag instead.
- Gate after every change: `node --test tests/cx-bulk-load/*.test.js` (379 green now)
  — plus cadence/queue/dial-runtime suites when you touch shared services/repos, and
  web tsc + `npm run build` for any client change.

---

## WORK ORDER 1 — THE 8:30 NO-SHOW RELEASE (iron out BEFORE FRIDAY — not urgent today)

Mickey's spec, two passes (2026-07-08 morning, second pass supersedes the first on
mechanics): the check stands — *"at 8:30 theres a check (time updated by Mickey 07-08; originally 8am). this person has x leads. and if
they havent started dialing their leads get released"* — but the release carries **NO
priority weight**: *"these leads dont need weight because they will all be fresh and
should really be divvied out like the other ones."* And the load-bearing step is NOT the
Mongo shuffle: *"the big thing is cleaning out their ring central so if they start
dialing later its not a count conflict for those leads."* He also rejected re-feeding
released leads one-at-a-time through the serving queue (the extern/id mismatch), and
pointed at the target shape: *"really we could just silently add them to the bottom of
every agents active fresh queue."*

**Order of operations inside `noshow-release` (dry-run default, Mickey arms):**

1. **RINGCX CLEANOUT FIRST — this is the whole point.** For every undialed row staged to
   the no-show agent that carries publish stamps (`metadata.rcxVisibilityCampaignId` +
   `metadata.rcxVisibilityExternId`), cancel the RingCX copy — the per-row primitive
   already exists: `cancelPublishedQueueItemInRingcx` (ringcxLeadServingService.js),
   extern-scoped, cannot touch leads we didn't publish. Verify with a read-back where
   the API allows. A lead must never exist ACTIVE in the no-show agent's campaign after
   release — that's the "count conflict" when they show up late and go available.
   Rows never published (no stamps) skip this step — nothing to clean.
2. **Mongo release, NO WEIGHT:** unassign (clear `assignment.*`, `claimUntil`,
   reservation metadata), `state: "ready"`, normal `priorityScore`/rank — released
   fresh leads re-enter distribution exactly like any other fresh lead. Stamp
   `metadata.noShowRelease {fromAgent, at}` for audit only.
3. **Redistribution — present, don't hardcode.** Mickey: "theres a few options here."
   Build steps 1-2 as the tool now; make step 3 a `--distribute <mode>` with the modes
   below stubbed behind explicit flags, and leave the default at `pool` until he picks:
   - `pool` (default): released rows sit unassigned in the pool; every agent's normal
     refill/threshold machinery divvies them organically — zero new distribution code.
   - `bottom`: divide round-robin across agents with activity today and BATCH-append to
     each receiver (a NORMAL-priority `publishBatchToRingcx` lands at the BOTTOM of the
     campaign list natively — "silently add them to the bottom" is literally what
     NORMAL priority does). Mint fresh externs for the receiver at publish; never reuse
     the cancelled extern (that is the id-mismatch he flagged).
   - ONE-AT-A-TIME RE-FEED THROUGH THE SERVING QUEUE: rejected by Mickey. Do not build.
4. **Ledger law unchanged:** never touch a row with `placedCalls > 0`; never write into
   the four floor families outside these mechanics; one-active-row-per-case holds.

**No-show definition (v1, unchanged):** zero `CxBulkLoadSession` for the agent since
06:00 local AND zero of their staged rows with `placedCalls > 0` today.

**Timing note:** with the CURRENT bulk rail (one-at-a-time publish during a running
session) an agent who never starts a session has NOTHING in RingCX — step 1 no-ops and
this is Mongo-only. The cleanout matters the moment the overnight loader pre-builds
dial lists into RingCX (the 6pm→8am plan). Build the tool to handle both worlds by
keying step 1 purely on the presence of publish stamps.

**Logging:** `cx.alpha.noshow.checked` / `cx.alpha.noshow.rcx_cancelled` (per row:
campaignId, externId, result) / `cx.alpha.noshow.released` {fromAgent, count, mode}.
Masked phones. Tests: `tests/cx-bulk-load/cxNoShowRelease.test.js` — no-show query
builders; cancel-before-release ordering; never selects `placedCalls > 0`; released
rows carry NO elevated rank/score; dry-run writes nothing. Full cx gate green after.

## WORK ORDER 2 — WAVE EXECUTION SUPPORT (operate + evidence, one agent per clean day)

Waves: Bruce (ballen@) → Phil (polson@) → Brad (bhansen@) → Chris (cbolt@), per the
rollout doc. For each wave, you run the machine parts:

1. Preflight (name-only checks): both lane flags false, `CX_BULK_RESERVE_PILOT_FAMILY=pilot`
   present, wrap flags true, the agent's `RINGCX_AGENT_ROUTE_*` entries exist.
2. `node scripts/cx-pilot-queue.js build --agent <email> --count 300` — dry-run, eyeball
   the picks, hand to Mickey to arm.
3. During the block: `node scripts/cx-floor-watch.js` running; watch for the STOP-IFs in
   the rollout doc; **~8:30**: run Work Order 1's `noshow-release` dry-run for the
   wave agent and report the verdict (Mickey arms if it's a real no-show).
4. Debrief: `node scripts/cx-floor-pilot-report.js --agent <email> --archive` +
   `cx-pilot-queue.js status`; then `cleanup --arm` (Mickey) for unserved rows.
5. Append the wave verdict to the WAVE LOG at the bottom of the rollout doc: date,
   agent, counters, verdict lines, anomalies, Sean-style five questions if collected.

## WORK ORDER 3 — CHECKLIST STRAGGLERS (verify-then-do; skip what's already done)

From `docs/CX_ROAD_TO_FLOOR_CHECKLIST_2026-07-08.md` Phase 2 — check the current tree
first, several may already be closed:
- Item 5: sync-indexes allowlist carries CxCallWrapCard (believed done — verify
  `scripts/sync-indexes.js`).
- Item 6: wrap picker timezone-explicit (appointmentDate/Time/Timezone from the card
  instead of a bare datetime-local). Client change → needs Mickey's rebuild; keep the
  diff minimal and run web tsc + build.
- Item 7: resolve route effect statuses + client surfacing (believed done — the
  persistent red toast exists; verify and mark).

## WORK ORDER 4 — DEPLOY-DAY PARITY PREP (produce, don't execute)

Assemble the Ubuntu push-day checklist as a doc section (no live-box writes, ever):
the Phase 4b flag gate (`CX_CALL_WRAP_QUEUE_ENABLED=true` + classifier INTO the live
`.env` BEFORE the deploy restart — without them a deployed floor has ZERO DNC path),
plus: the pilot-family/reserve-mode code and the no-show tool ride the push inert
(their env switches stay absent on live), lane flags absent, drip flags absent.

## WORK ORDER 5 — THE "MAIL CALL" HOLD BUTTON (this week; Sean runs on a verbal stopgap today)

Context (Mickey, 2026-07-08): inbound leads ride EX on purpose — a true
fastest-hand-wins ring that a CX inbound queue can't replicate (standing theory; do not
try to disprove it in this order). Agents will keep taking EX "mail calls" mid-day.
Today's stopgap: Sean closes the CX workspace when he takes one. The build: **a button
next to Break — "Mail call" — that puts the agent in a distinct, UNTIMED hold.**

**Contract:**
1. **Reuse the break plumbing exactly** for the hold itself: locate the existing break
   flow (the cert guide Gate 7 names its anchors: AgentState `activityState` +
   `cxRouting`, app-unavailable + RingCX paused/on-hook, the resume instruction). The
   mail-call hold must do EVERYTHING break does on entry — session paused, RingCX
   unavailable so campaign dials cannot ring the agent mid-EX-call — with a NEW status
   value (e.g. `mail-call`) distinct from `break` everywhere status is read (AgentState,
   the workspace chip, the pilot report).
2. **No timer — a perma-break.** Break's expiry/blocked-UI machinery does NOT apply;
   the hold ends only when the agent clicks resume ("I'm back"). VERIFY the stale-session
   sweeps / janitors won't kill or wrap-timeout a session sitting in this state through
   a long call (find every idle-based reaper that could fire; either exempt the state or
   document the recovery as instant-resume). A mail-call hold that silently dies after
   20 minutes is worse than no button.
3. **Honor system, but AUDITABLE for free:** no enforcement UI. Instead, stamp the hold
   segments (start/end/status) and teach `cx-floor-pilot-report.js` to annotate each
   mail-call segment with the agent's EX activity in that window (`CallLog` with
   platform `ex` for that agent — the field exists; ROI already keys on it). A mail-call
   hold with zero EX calls in it shows up as a WATCH line in the report — visibility,
   not blocking. That is the "unabusable" Mickey wants, deferred honestly.
4. Client: button beside Break in the bulk workspace (label "Mail call", distinct
   color/icon), status pill while held, one-click resume. Web tsc + build; Mickey
   refreshes. Server: mirror the break route shape; flag-gate if the break flow is
   flag-gated, otherwise ship dark via UI presence only.
5. Tests: status-transition pins (enter/exit, distinct from break, no expiry), reaper
   exemption pin, report annotation pin. Full cx gate green.

## WORK ORDER 6 - STALE OWNERSHIP FAMILY (no-show release + stale browser session)

Mickey connected two bugs as the same family: stale ownership artifacts outliving the
thing that owned them. The inventory-side version is WO1: a no-show agent leaves RingCX
copies and Mongo claims behind. The client-side version is Chris's stale browser tab: the
server moved to a newer running session, but the tab stayed bound to an older killed
session and kept showing a dead lead/buttons.

**Shared rule:** prove current ownership before serving, displaying, or completing work.
If ownership is stale, clean up or rebind. Do not invent outcomes or silently decide a
lead is bad.

**Inventory side (WO1 final pass):**
- RingCX cleanout first, using only our publish stamps and extern-scoped cancels.
- Mongo release second, with no priority/weight boost.
- Distribution is explicit: `pool` or `bottom`.
- Never touch rows with `placedCalls > 0`.
- Before coding the final pass, verify whether released rows need route re-stamping for
  another agent's route-lock or whether `pool` clears route ownership until reservation.

**Client side (new stale-tab guard):**
- Treat `/api/cx/bulk-load/session` as the canonical running session.
- If the client-held session id differs from the server's running session id, clear stale
  middle-card/button state and rebind to the server session.
- A disposition request targeting a killed/replaced session should fail closed with a
  structured stale-session response, not apply an outcome.
- Add masked logs: `cx.alpha.client_session.stale_binding` and
  `cx.alpha.client_session.rebound`.
- Add a test: old session killed, new session running with buffer, client poll sees the
  new id, old lead clears, buttons only attach to the new session.

Details live in `.ai/context/CX_STALE_OWNERSHIP_FAMILY_2026-07-08.md`.

## REPORTING

Append after every order to `.ai/context/CX_ROLLOUT_CODEX_LOG_2026-07-08.md`: what ran,
dry-run output snippets (masked), gate counts, and OPEN QUESTIONS FOR MICKEY as a list
he can answer in one pass. If anything contradicts these orders or the ground-truth
docs, stop that order and log the contradiction instead of improvising.
