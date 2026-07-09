# TONIGHT'S PUSH — the reconciliation plan (2026-07-08, floor close → Ubuntu owns)

Decision (Mickey): the push happens TONIGHT, not Friday. This doc reconciles today's
open issues into one deploy sequence. After tonight: **Ubuntu is the owner** (all CX
workers + the agents' front), the local box goes worker-quiet (dev + ops tools + the
coach rig only). That single change is the headstone for today's dual-writer incident
class (Brad's button flicker, Chris's dead tab, the morning freezes' second half).

## 0) RECONCILE THE LIVE TREE FIRST (or lose it)

The live box is on `patch/2026-06-10-coach-uniformity` @ 0f5a862 (0.1.9) with a LARGE
uncommitted working set (`git status` shows M: apps/ai-bus/src/* incl. aiTaskRoutes +
liveCoachModelPolicy + localBusServer, .claude/launch.json, .gitignore, AGENT_HANDOFF,
more). A blind checkout destroys them.

1. Capture: on the box, `git diff > /tmp/live-uncommitted-$(date +%s).diff` and copy it
   home (keep forever).
2. Triage against OUR tree — the known June hotfixes are already back-ported (the
   dashboard-or-internal auth middleware in ai-bus server.js, stream.ts, liveCoachProxy,
   readCx — per the hotfix memory). Anything in the diff NOT recognizably ours gets a
   ruling: port into the local tree BEFORE the commit, or consciously discard.
3. Then `git stash` (belt) before the checkout — recoverable either way.

## 1) COMMIT THE LOCAL TREE (Mickey's hand)

Everything since the last commit rides tonight: the sys-dispo law + wrap queue, the
fork collapse, lanes (flag-dark), cadence hygiene, the pilot-family isolation + tools,
the Sean drip (flag-dark), the case-panel UI restructure, the two-station coach
(flag-dark) + stream.ts fixes + bridge allowlist, the caller-id shifter/rotate, the
no-show orders + docs. Note: the 30 tracked-log deletions are STILL STAGED from
yesterday's hygiene pass — tonight's commit scoops them by design.

Gate inventory at last full run: cx 379/379 · live-coach 355/355 · ai-bus 103/103 ·
cadence/queue/dial-runtime/call-state-guard 260/260 · web tsc + build clean.

## 2) ENV PARITY — the ownership blocks (the actual dual-writer fix)

Same version ≠ single writer. Ownership is configuration, explicit on BOTH sides:

**UBUNTU .env gains (the owner; needs sudo to edit — the ubuntu user can't read it):**
```
CX_CALL_WRAP_QUEUE_ENABLED=true          # Phase 4b: without these a deployed floor has
CX_SYSDISPO_CLASSIFIER_ENABLED=true      # ZERO DNC path (wrap card IS the DNC channel)
CX_ALPHA_TRACE_ENABLED=true
CX_ALPHA_TRACE_AGENT=                    # blank = trace all (the mgray-only trap)
CX_DIAL_RUNTIME_BULK_LOAD_ENABLED=true   # the bulk rail is the floor now
```
Verify present (name-only): the full RINGCX_AGENT_ROUTE_* roster, RingCX/RC creds,
Mongo URI. Verify ABSENT: lane flags, CX_SEAN_FIRST_TOUCH_*, CX_BULK_RESERVE_PILOT_FAMILY,
LIVE_COACH_COACH_MODE/two-station keys (coach stays a local-rig affair until its pilot).

**LOCAL .env gains (goes quiet — EXPLICIT offs; the fallback traps make silence a lie):**
```
RC_CX_CADENCE_WORKER_ENABLED=false
RINGCX_AGENT_MONITOR_ENABLED=false
CX_MORNING_QUEUE_BUILDER_ENABLED=false   # EXPLICIT — unset falls back to BULK_LOAD_ENABLED=true
CX_DIAL_RUNTIME_BULK_LOAD_ENABLED=false  # local bulk routes off; re-enable deliberately for dev
CX_SEAN_FIRST_TOUCH_TEST_ENABLED=false   # the drip moves to a ruling post-push
```
Plus the control-plane watcher/drain/dispatcher flags off (verify exact names in
server.js at execution: the account active-call watcher, terminal outbox drain, lane
dispatcher master). Local keeps: nginx/ngrok fronts (office tools), the ops scripts
(caller-id rotate, pilot tools — they are API clients, box-agnostic), the coach 3002
rig (overlay processes, unaffected by worker silence).

## 3) THE SEQUENCE (after floor close)

1. Step 0 (live-tree capture + triage) → step 1 (commit + push to remote).
2. Local box: apply the LOCAL env block → `Start-Service ParallelRestartHelper` — the
   local stack comes back worker-quiet. (Do this BEFORE Ubuntu's restart so there is
   never a two-owner window.)
3. Ubuntu (the guide's deploy pattern, `sudo -H -u parallel`): fetch + checkout
   `release/0.2.0-alpha` → install deps if lockfile changed → `npm run build` (web) →
   apply the UBUNTU env block → `node scripts/sync-indexes.js` (CxCallWrapCard unique
   idemKey rides it) → restart the parallel-* units.
4. Agents tomorrow: everyone on the UBUNTU front URL. The local front stays up for
   office tools but serves no dialing.

## 3b) TONIGHT'S BUG FIXES (Fable, ride the commit — client-only, tsc+build green)

- **Feed-staleness tripwire** (the "Chris's dead tab" class): the 1s session poll keeps
  rendering its last good snapshot when fetches silently fail — now amber
  "reconnecting" at 10s stale, red "this screen is a snapshot" + Refresh button +
  outcome buttons gated at 30s. Visibility-aware (a backgrounded tab returning never
  false-alarms — staleness measures from tab-visible, and focus refetch wins the race).
- **Offhook-stuck guidance** (the "polson wedged 40min" class): a session in
  `waiting_offhook` >60s now tells the agent exactly which side to kick (RingCX
  Available/off-hook toggle, or stop+restart the session) instead of a silent screen.
- Brad's button flicker: deliberately NOT masked client-side — it is the dual-writer
  wound and tonight's ownership blocks are its fix. Zombie running sessions (harmless,
  self-clear on next start): follow-up note only.

## 4) POST-PUSH VERIFICATION (the 15-minute proof)

- Health 200s on every Ubuntu unit; boot logs clean; bundle hash fresh on its front.
- ONE test dial end-to-end on Ubuntu: dial → terminal → drain ≤1 tick → wrap card
  mints → resolve writes through (the cert Gate 4/6 shape, on the new owner).
- **Single-writer proof**: `cx-call-lifecycle.transition` / watcher ticks appear in
  UBUNTU's journal ONLY; the local NSSM logs stay silent on CX writes. This is the
  line that says today can't recur.
- Sysdispo classifier live: one machine-answer test shows `sys=` labeling on Ubuntu.
- The 8:30 no-show check, mail-call button, connect-rate canary, worker LEASE GUARD:
  unchanged follow-ups (Codex WOs) — the lease guard graduates from "nice" to "next"
  since ownership is now config-only.

## 5) ROLLBACK

Ubuntu: `git checkout patch/2026-06-10-coach-uniformity && git stash pop` + restart
units + revert its env block (the captured diff makes this lossless). Local: remove
the quiet block + restart helper — the box re-arms as today. Two moves, ~10 minutes,
no data migration in either direction (shared Mongo means the data plane never moved).

## OPEN RULINGS FOLDED IN (say yes/no during the window)

1. Cert Gates 2/7: today's de-facto multi-agent day arguably closed them — file the
   signoff or run the formal 10-lead drill on Ubuntu tomorrow morning?
2. The pilot family / drip: retire for now (the floor IS bulk) or re-home to Ubuntu
   for continued fresh-touch testing?
3. Caller-id pools: fill tonight while the box work happens (the rotation script runs
   from anywhere) — the burned ANIs want resting regardless of which box owns dialing.
