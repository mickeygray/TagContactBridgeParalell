# CX Floor Experiment 1 — Trunk Acceptance (handoff design, written 2026-07-06)

**Purpose:** prove the bulk-dial trunk is stable under real human use before wider floor
rollout. The trunk ruling, verbatim: *poller matches → doesn't corrupt call state → you can
enter the outcome → the outcome you enter is stable.*

**Hypothesis:** every call shape in the matrix below lands exactly where the table says,
with zero questions the agent didn't need, and the end-of-run ledger reconciles perfectly.

**Roles:** one AGENT (makes calls, follows the scenario script, notes anything that *felt*
wrong) + one OBSERVER (runs the evidence windows, fills the results table). Mickey can play
both for a solo run. Time budget: ~60–75 minutes including one 5-minute walk-away.

**Covers matrix rows:** F2/F3/F4 (never-connects + labels), F5/F6 (VM shapes), F7 (normal
answer), F8 (wrap hold — UNTESTED, the centerpiece), F9-adjacent (auto-answered default),
F13 (double-click), plus the rescue-answer branch (R1-B — UNTESTED).

---
## 0) PREFLIGHT — owner does this once, in order, skip nothing

1. **Commit the working tree.** (If not already done — the tree carries everything.)
2. **Rebuild the web client:** `cd apps/web-client && npm run build`.
   ⚠ THE LESSON OF 2026-07-06: the client is a BUILT bundle served by the control plane —
   browser refresh does NOT ship client fixes. Verify after rebuild: the browser console's
   bundle filename hash CHANGED from the previous session.
   ⚠ THE LESSON OF 2026-07-07 (the workspace fork): `/cx` routes to the BULK workspace
   only when `VITE_CX_WORKSPACE_MODE=bulk_load` was in the environment AT BUILD TIME
   (`apps/web-client/.env.local` carries it in this repo — a Vite env var is baked into
   the bundle, not read at runtime). Any OTHER checkout/box building without that flag
   serves the LEGACY workspace on /cx — the old queue/dial/dispo pipeline, no bulk UI.
   Verify on the surface itself before testing: the bulk workspace shows the bulk session
   controls (queue preview / bulk start); the legacy one shows the coach cockpit instead.
   If the floor tests from a machine that isn't this repo's build, check its flag FIRST.
3. **Restart `ParallelControlPlane`.** Verify clean boot: err-log tail empty post-rotate.
4. Env name-checks (values not needed, just presence): `CX_ALPHA_TRACE_ENABLED` set;
   `CX_BULK_RESYNC_ENABLED` absent or true.
5. Kill any stale bulk session. Build a fresh queue, **10 leads, unique names**
   (`FLOOR1-01`…`FLOOR1-10`), numbers you control: at least 1 dead/wrong number, 1 voicemail
   box, the rest answerable test phones.
6. Open the three evidence windows:
   - stdout: `Get-Content C:\tools\logs\parallel-parallelcontrolplane.out.log -Wait -Tail 5`
   - browser DevTools console (filter: `[cx]` and `[disp]`)
   - inspect on demand: `node scripts/cx-bulk-session-inspect.js`
7. Save the baseline inspect output. Confirm: all reserved rows `claimed sess=ok`, BUFFER =
   lead count, CURRENT (none), no RESYNC line.

---
## 1) SCENARIO SCRIPT — run in order; one row at a time; fill the table as you go

| # | Agent does | Expected screen | Expected record (inspect OUTBOX / stdout) | PASS bar |
|---|---|---|---|---|
| E1 | Answer, talk ≥15s, YOU hang up, click **No answer**? No — click **Answered** | lead holds while talking; name NEVER blanks; after click, "Last call" view keeps the name | outcome `answered`, source=disposition, exactly ONE row | the click is the record |
| E2 🎯 **WRAP (untested)** | Answer, talk ≥15s, have the PROSPECT hang up first. DO NOT click for 30–60s. Watch the middle. THEN click **Voicemail**(or any) | lead HOLDS with live buttons the whole wait (inspect mid-wait: `wrap={...}` on CURRENT); no auto-advance, no popup | NO row until your click; then exactly your outcome, once | *"it waited for me, then my click was the truth"* |
| E3 | Dial the dead/wrong number, touch nothing | status-line advance ~1s, NO prompt, name of NEXT lead appears cleanly | `did_not_connect` + `sys=` label (INTERCEPT or carrier verdict) | machine's verdict recorded, no interruption |
| E4 | Let a call ring out, touch nothing | same as E3 | `did_not_connect` (+`sys=NOANSWER` if RingCX says) | same |
| E5 | VM box: listen ≥10s, click **Voicemail** | wrap-style hold until click; after click, advance | outcome `voicemail`; stdout shows `probe.post_hangup.skipped … voicemail-transfer-owns-call-end`; **the drop PLAYS on the box** | VM rail end-to-end |
| E6 | On any call, MASH a disposition button 3–4 times fast | no error, one transition | exactly ONE outbox row (idemKey dedup) | double-click safe |
| E7 🎯 **RESCUE (untested)** | Owner: `node scripts/cx-resync-drill.js` dry → `--arm`. Agent: go available and **ANSWER the ghost** | middle FILLS on the connect tick (not during ring) with the drilled lead + live buttons; disposition normally | stdout `serving_stamp.rescued`; row `rescuedFromState=cancelled`; your click's outcome; NO resync line | *"a good call landed in MY app with MY buttons"* |
| E8 | Mid-call on a healthy answer, OBSERVER runs inspect | `lane=CONNECTED@<time>` while the agent is talking | (observation only) | the connected latch fires live |
| E9 | Natural-pace mini-soak: run the remaining leads back-to-back like a real shift | no wedges, no blank names, no popups, next lead always arrives | every call = one row; labels match ears | *"it behaves like a tool, not a test"* |

Optional E10 (walk-away, needs the 5-min break): finish a call into wrap (like E2) and walk
away 5 minutes. Expected: the wrap HOLDS at 5 minutes — your click when back is the record.
POLICY UPDATE (2026-07-06 auto-opt-out ruling): a wrap abandoned past **30 minutes** now
self-resolves via the answered guard (source `wrap-timeout`) — the janitor, not a bug.
`CX_BULK_WRAP_TIMEOUT_MS=0` restores hold-forever if ever needed.

| E11 🎯 **APPOINTMENT WRAP (the pre-drain half-step — Mickey's add)** | On an answered call,
open the appointment modal (M3) and book a real test appointment; take your time filling it
(≥20s — the point is the slow window) | the lead HOLDS in the middle the whole time (the
session is deliberately marked busy during the Logics commit — the watcher must NOT clear or
advance it); modal completes; then normal advance | appointment created; outcome `answered`
recorded once; stdout shows the appointment-wrap trail; NO watcher interference mid-modal
(no `session.skipped reason=session-busy-apply` surprises beyond the designed hold) | *"the
paperwork window froze the flow gracefully and nothing fought me for the screen"* |

**D1 — DRAIN DRILL (fully synthetic, zero calls, self-grading — full how-to:
docs/CX_DRAIN_DRILL_HOWTO.md):**
`node scripts/cx-drain-drill.js` (dry run) then `--arm`. Injects three crafted outbox rows
and lets the LIVE drain worker eat them: a malformed row (drains instantly, "malformed"), a
poison row (rides the 3-retry backoff ladder ~4-6 min then resolves minimally — the slow part
is the point), and a good row (drains fully AND proves the sys-label store live on a
drill-tagged synthetic queue row). The script watches, prints every transition, and grades
itself PASS/FAIL — no eyes-on-Mongo needed. No RingCX interaction on any lane. Cleanup
command printed at the end. Run it any time the control plane is up on the current tree —
it needs no session, no queue, no phone.

E11 note: this tests TODAY'S freeze-model appointment path. The async call-wrap-queue
redesign (docs/CX_CALL_WRAP_QUEUE_DESIGN_2026-07-06.md) will eventually retire the
post-hangup freeze; this row proves the current behavior is safe for the floor meanwhile.

---
## 2) LOGGING — what exists and what each line proves

**Browser console (the client's testimony):**
- `[disp] PRESS {...}` — the click left the button (absence on a press = disabled/unmounted).
- `[disp] guard passed → firing …` / `RESOLVED after Xms` — request round-trip healthy (~2s normal).
- `[cx][identity] populate {key, name}` — the middle filled, with what name; `current:` →
  `review:` key flip on disposition is the designed handoff.
- `[cx][wipe] {source}` — **any occurrence during a running session is a finding.** The
  source tag names the guilty path verbatim. Silence = pass.

**Control-plane stdout (the server's testimony):**
- `cx.alpha.watch.serving_stamp.accepted` (`servingMethod: markCandidateServing` normal;
  `rescueCandidateServing` = E7's rescue) / `.missed` + `rescueRefusal` — adoption story.
- `cx.alpha.watch.resync.pruned {reason, removed, ringcxCancels}` — the healer acted; should
  appear ONLY around E7's drill, never during healthy flow.
- `cx.alpha.bulk.disposition.started/…` — the disposition trail; `[cx.bulk.http] rejected /
  null-result` — a click the server REFUSED (any occurrence = capture it, it's a finding).
- `cx.alpha.disposition.probe.post_hangup.skipped … voicemail-transfer-owns-call-end` — E5's proof.
- `cx.alpha.watch.ghost_call.hangup` — should NOT appear in this experiment (no blocked-lead
  drill is scripted); an occurrence = capture + report.

**Inspect (the database's testimony):** CURRENT `lane=` / `wrap=`, RESYNC line, RESERVED
rows `rcxCancel=`, OUTBOX tail outcomes + `sys=` + sources.

**Evidence capture per scenario:** nothing fancy — if a row PASSES, tick the table. If
anything surprises: screenshot the console, copy the last ~30 stdout lines, run inspect,
paste all three next to the row. Every mismatch becomes a pin before the next round.

---
## 3) DESIRED OUTCOME — what "trunk stable" formally means

The experiment PASSES when:
1. Every scenario row lands per its table entry (E2 and E7 are the money rows).
2. **End-of-run ledger:** calls placed == outbox rows, exactly; zero dupes; zero rows for
   the drilled lead beyond the agent's own E7 click; every `sys=` label matches what ears heard.
3. Zero `[cx][wipe]` lines during running sessions; zero popups other than the appointment
   modal if used; zero moments where a lead left the middle without a click or a machine verdict.
4. The agent's verdict, in their words, matches the bar: *"every call went where I expected
   and nothing asked me a question I didn't need."*

On PASS → the trunk is formally accepted; sprint moves to S2 soak (30+ calls) + the build
track's next deliveries. On any tripwire → stop, capture, report; the failing shape becomes
a pin + fix before re-run.

**STOP-IF tripwires (halt the experiment, capture all three evidence surfaces):**
- A lead leaves the middle without a click or machine verdict (TRUNK bug — outranks all).
- An outcome row appears that nobody clicked and no machine verdict explains.
- The phone rings for a lead the app doesn't show and doesn't rescue on connect.
- Buttons dead >15s after a click resolves (known D1 overlay — note timing, don't halt,
  UNLESS it doesn't self-clear on the next lead).
- Any `[cx][wipe]` line mid-session — note the source tag; halt only if the name actually
  vanished with it.

**Known-open, don't panic:** wrap has NO default timeout (walk-away holds are BY DESIGN —
count them, E10); the answered worklist (WO-32) isn't built yet, so answered-undisposed
calls just record `answered` and move on; outcome EDITING isn't built yet (that's the
build track's current work — see below).

---
## 4) Build track running in parallel (Fable, so the handoff doc says who's doing what)

While the floor runs this: **WO-17 disposition identity + WO-31 correction lane** (server
first) — every disposition POST gains `{queueItemId, uii}` identity with 3-way routing
(current-match → terminal; lastOutcome-match → correction row; neither → explicit
stale-click rejection instead of silence), and `review-outcome` generalizes beyond DNC so
any completed call can be re-outcomed (original row untouched, correction appended). This is
the enabler for outcome editing (Mickey priority #3) and the safe-unfreeze for the D1
overlay fix. WO-16 (projector rework) follows AFTER this experiment passes — it's
deliberately not landing mid-test. None of it disturbs the bundle the floor is testing.
