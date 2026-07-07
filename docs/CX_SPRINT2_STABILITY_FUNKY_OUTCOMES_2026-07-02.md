# Sprint 2 — Stability & Funky Call Outcomes (game plan, written 2026-07-02 night)

The next sprint: take the outcome engine written tonight and prove it against every weird call
shape a dialer floor actually produces, then soak it for stability. Companions:
`docs/FINISH_SPRINT_QUEUE_TO_COACH_2026-07-02.md` (sprint 1, still governs the WO queue),
`docs/CX_BULK_LOAD_REWRITE_WORK_ORDERS_2026-07-02.md` (work orders + THE SPLIT),
`docs/CX_BULK_LOAD_CODE_BLOCKS_2026-07-02.md` (paste-ready blocks incl. BLOCK I),
`docs/rewrite-reports/WO-wrap-state.md` (tonight's full change log, addenda 1–5).

## ⚡ MARCHING ORDERS — NEXT TEST SESSION (written 2026-07-06 night, gate 297/297)

One sitting, ~45 min + one coffee break. Everything below rides ONE commit + ONE restart.
Execute top to bottom; each step has its own PASS bar; fill the results table at the bottom
of §S3 as you go. ✅ HOLD LIFTED: the rescue-lane adversarial review landed 2 blockers + 3
real findings — ALL FIXED + PINNED (see §GHOST CALL POLICY verdict record); final gate
**299/299**. The orders below stand as written.

**STEP 0 — PREFLIGHT (non-negotiable, in order):**
1. COMMIT THE TREE. It carries: outcome engine, ghost guard, resync spine, rescue/hangup
   lane, VM-hangup fix (live-verified), route logging, banner retirement, inspect upgrades,
   drill script — 297 green tests of uncommitted value.
2. Restart `ParallelControlPlane`. Confirm clean boot: err-log tail empty after the rotate.
3. Name-only env checks: `CX_ALPHA_TRACE_ENABLED` set; `CX_BULK_RESYNC_ENABLED` absent or true.
4. Kill any stale bulk session (kill path is proven). Fresh mini queue, 6 leads, UNIQUE
   names (`T0706-01`…`T0706-06`).
5. Open three evidence windows: stdout tail (`Get-Content C:\tools\logs\parallel-parallelcontrolplane.out.log -Wait -Tail 5`),
   browser console (`[disp] PRESS` is proof-of-click), and a terminal for
   `node scripts/cx-bulk-session-inspect.js`. Save the baseline inspect.

**STEP 1 — TRUNK LATCH VERIFY (the last big unknown: is RingCX's answered state in our set?):**
- Call #1: answer it yourself, stay on ≥15s. MID-CALL inspect must show `lane=CONNECTED@<time>`.
  Hang up from the prospect side → lead HOLDS in wrap, buttons live → click an outcome →
  that click is the one record in the outbox. FAIL if lane stays `never-connected` while
  you're talking → capture inspect + the active-call callState from stdout; the fix is
  widening CONNECTED_STATES (one line) — stop and report.
- Call #2: let it ring out, don't touch anything → `did_not_connect` + `sys=` label in the
  outbox tail, next dial ~1s, NO prompt (banner is dead).
- BAR: *"the latch fires when a human answers, and only then."*

**STEP 2 — R1 BRANCH A, ghost that rings out (full protocol in §S3/R1):**
`node scripts/cx-resync-drill.js` dry → `--arm` → go available → DON'T answer.
Expect: misses-without-prune while ringing → call vanishes → `resync.pruned
reason=idle-drift-sweep` ≤60s → `rcxCancel=YES` on the row → NO outcome row for the drilled
id → session keeps rolling. BAR: *"refused, swept, source killed, nothing invented."*

**STEP 3 — R1 BRANCH B, ghost you ANSWER (the rescue):**
Re-run the drill on another lead → go available → ANSWER the ghost.
Expect: middle slot fills ON THE CONNECT TICK ONLY (`serving_stamp.rescued` in stdout, never
during ring), buttons live, disposition normally; row shows `rescuedFromState=cancelled`; NO
resync line; your click is the record. BAR: *"a good call is never burned — it lands in MY
app with MY buttons."*

**STEP 4 — R2 WALK-AWAY (the coffee break; full protocol in §S3/R2):**
Take one normal call, disposition it, then IDLE 13 minutes.
Expect at ~12 min: rows `ready releasedBy=long-call-hold-reaper` with `rcxCancel=YES@fresh`
(the ghost guard beating the dialer) → ≤60s later `resync.pruned reason=idle-drift-sweep`,
BUFFER (0), RESYNC line. YOUR PHONE MUST NEVER RING. Cleanup: kill + note the kill log.
BAR: *"walking away costs the batch, loudly — never the truth."*

**STEP 5 — OPTIONAL, F3 label calibration:** one lead with a known-dead number → expect
`did_not_connect sys=INTERCEPT` (or the carrier's verdict), status-line advance, guard silent.

**STOP-IF TRIPWIRES (any of these = stop, capture inspect + stdout, report):**
- An outcome row appears for a drilled queueItemId (LAW violation — record invented).
- The phone rings during Step 4 (ghost guard failed live).
- A lead leaves the middle without your click or a machine verdict (TRUNK bug — outranks
  everything else in this doc).
- Wrap doesn't hold after a real answered call ends (Step 1 regression).
- Buttons stay dead >15s after a disposition resolves (known D1 overlay — don't stop, but
  note the timestamp; it feeds WO-16/17).

**END-OF-RUN LEDGER:** calls placed == outbox rows, exactly; zero rows for drilled ids;
every `sys=` label matches what your ears heard. File PASS/FAIL per step in the §S3 results
table; every mismatch becomes a pin before the next round.

## What landed tonight (ALL UNCOMMITTED — the ledger for cold pickup)

The outcome engine, in `cxAccountActiveCallWatcherService.js` + `cxBulkLoadActiveCallWatcher.js`
+ `cxBulkLoadStateMachine.js`, gate at **284/284**:

1. **WRAP STATE** — a connected call that ends doesn't auto-write; the lead holds with live
   buttons; the agent's click IS the record. No default timeout (Codex; `wrapTimeoutMs` is
   test/ops opt-in). Reappearing call un-wraps (poll-flap self-heal).
2. **CONNECTED LATCH** — `connectedAt` stamped when the current's uii is seen in
   ACTIVE/CONNECTED/ONHOLD/HOLD/TRANSFER (per-tick + at-promotion halves). UII presence ≠
   answered (UIIs exist at dial time — the congestion lesson).
3. **REAL-PICKUP GUARD** — `answered` additionally requires connected duration ≥
   `CX_BULK_ANSWERED_MIN_CONNECTED_MS` (default 10s; 0 disables). Screener/VM-kick SIP-answers
   downgrade to did_not_connect. Guard only touches MACHINE defaults — a human click is never
   second-guessed.
4. **ANSWERED DEFAULT** — auto-closed/superseded calls that pass the guard record `answered`,
   done and dusted, zero interruptions; the pure watcher's `deriveCurrentTransition` +
   release/timeout paths carry it; supersede stamps `lastOutcome` (reducer fix).
5. **SYSTEM-DISPOSITION LABEL** — never-connects get RingCX's own verdict
   (CONGESTION/BUSY/INTERCEPT/NOANSWER/MACHINE/ABANDON) via a bounded fail-soft leadSearch
   (family probe → per-lead field → CONGESTION fallback; one-time `cx.bulk.leadsearch.row_shape`
   trace documents the real response shape on first live hit). Label only — outcome enum
   untouched.
6. **THE AUTO-ADVANCE TAXONOMY** (the ruling that closes the category): every auto-advance is
   (a) machine-disposed never-connect → machine's verdict recorded, or (b) answered-undisposed →
   wrap or `answered`+worklist. The connectedAt latch is the lane selector.
7. **NO OUTCOME MODALS.** Inventory = M2 (new lead) + M3 (appointment wrap) only. Follow-up on
   answered calls = WO-32 worklist ("Answered today — follow up": [Set appointment][DNC][✕],
   ✕ = view-only dismiss). Code = BLOCK I in the code-blocks guide, paste-ready.
8. Also in-tree from earlier tonight: the attic (WO-1/2/3 moved out, 3 provenance files),
   the WO-3 negative pins + 410 tripwire, `scripts/cx-bulk-session-inspect.js` (the microscope,
   now prints `sys=` labels).

**Env knobs introduced:** `CX_BULK_ANSWERED_MIN_CONNECTED_MS` (10000), `CX_BULK_WRAP_TIMEOUT_MS`
(opt-in, unset = hold forever), `CX_COACH_BRIDGE_ENABLED` (spec'd in blocks, not wired).

## Sprint 2 structure — same law as sprint 1: Build → Pin → Load & Run with a human bar

### Unit S0 — Preflight (every session, non-negotiable)
Commit the working tree (STILL UNCOMMITTED — first act). Restart `ParallelControlPlane` (the
watcher's home). Drain CX-side queue, rebuild fresh via the loader. Run
`node scripts/cx-bulk-session-inspect.js` and save the output as the round's baseline.
**Evidence discipline for the whole sprint:** every funky run gets an inspect snapshot BEFORE
and AFTER + the outbox tail; every actual-vs-expected mismatch becomes a pin in the suite
before the next round.

### Unit S1 — The Funky Outcome Matrix (the centerpiece)

Run each row live; verify the record via inspect (`OUTBOX TAIL` outcome + source + sys) and the
screen via eyeballs. Mark PASS/FAIL in a results table appended to this doc.

| # | Call shape | How to manufacture | Expected record | Expected screen |
|---|---|---|---|---|
| F1 | Carrier congestion | burst-dial / known-bad route (it found us twice today) | did_not_connect · source active-call-release · sys=CONGESTION | status line only; next dial ~1s; NO prompt |
| F2 | Busy | call your own busy line | did_not_connect · sys=BUSY | same |
| F3 | Disconnected number | dial a dead number | did_not_connect · sys=INTERCEPT | same |
| F4 | Rings out | let it ring | did_not_connect (sys=NOANSWER if RingCX says) | same |
| F5 | Screener / VM-kick (<10s SIP-connect) | call a Google Voice number, don't engage | did_not_connect (real-pickup guard) | same; NEVER on the worklist |
| F6 | VM greeting, agent listens >10s, clicks Voicemail | any VM box | voicemail (HUMAN record) | wrap held until click |
| F7 | Real answer, agent dispositions normally | test call | the human's outcome, once | normal loop |
| F8 | Real answer, prospect hangs up, NO next call queued | hang up on the agent, empty buffer tail | NOTHING until click (wrap holds indefinitely) | lead + buttons stay; click later works |
| F9 | Real answer, prospect hangs up, RingCX advances | hang up mid-list | answered (auto) · lands on worklist | next call takes screen; NO modal |
| F10 | Ultra-short real answer (<10s, "wrong number" click) | quick-answer + agent clicks fast | the human's click (guard never touches manual) | normal |
| F11 | Ultra-short real answer, NO click, auto-advanced | quick answer + hang up fast | did_not_connect (guard downgrade — KNOWN behavior, verify it feels right) | status line |
| F12 | Poll flap mid-conversation | brief network cut / block the poll route | NO record; wrap set then cleared; call continues | agent notices nothing |
| F13 | Double-click a button | mash it | ONE record (idemKey dedup) | no error |
| F14 | Click racing an advance | click as the screen changes | stale-click no-op server-side (WO-17 when pasted; pre-paste: verify no wrong-call write) | no toast |
| F15 | Worklist DNC (after BLOCK I pastes) | DNC from the bar | review-correction row; original `answered` row untouched | row disappears |
| F16 | UII re-key at answer (suspected, unconfirmed) | watch inspect during answers | unknown — CAPTURE IT: if current's uii changes mid-call, record the tick | — |

**Bar (Mickey):** *"Every row lands where the table says, the sys labels match what actually
happened on the phone, and nothing asked me a question I didn't need."*

### Unit S2 — Stability soak
One 30+ call session at natural pace. Afterward, the ledger audit via inspect + Mongo:
**calls placed == outcome rows, exactly, no dupes, no orphans**; zero sessions wedged; wrap
lifecycle counts sane (every wrap ended by click, supersede, or session end — count wraps that
outlived 10 minutes: should be 0 unless the agent walked away); sys-label distribution eyeballed
against the day's feel (congestion clusters = carrier trouble, not lead trouble).
**Bar:** *"The counts reconcile to the call, and I didn't touch the inspect script to fix
anything — only to look."*

### Unit S3 — Recovery drills (break it on purpose)

---
#### R1 — Trigger A drill: the incident replay (explicit protocol)

*Proves: a row cancelled out from under a live session (Monday's exact shape) self-cures —
one refused ghost dial, one prune, no invented outcome, session keeps rolling.*

**Preconditions (do in order, skip nothing):**
- P1. Tree committed; `ParallelControlPlane` restarted AFTER the commit (ghost guard, resync,
  VM skip, route logging all ride this bounce).
- P2. `CX_ALPHA_TRACE_ENABLED` set (name-only check) — the drill's evidence is trace lines.
- P3. Fresh mini queue, 5–6 leads, UNIQUE names (`RESYNC-A-01`…). Start the session.
- P4. Baseline: `node scripts/cx-bulk-session-inspect.js` → SAVE the output. Must show:
  all reserved rows `state=claimed sess=ok rcxCancel=no`, BUFFER = lead count, no RESYNC line.
- P5. Second terminal tailing stdout: `Get-Content C:\tools\logs\parallel-parallelcontrolplane.out.log -Wait -Tail 5`.

**Steps → expected at each:**
| # | Do | Expect | PASS if |
|---|---|---|---|
| 1 | Take call #1 normally, disposition it | normal loop; outbox row drains | baseline sanity — loop works pre-drill |
| 2 | `node scripts/cx-resync-drill.js` (dry) | prints TARGET = next buffer row, `row.state=claimed owned=yes`, refuses nothing | dry run names the lead you expect |
| 3 | Same + `--arm` | `ARMED: <id> cancelled out-of-band` | script confirms CAS took |
| 4 | Inspect again | target row `state=cancelled`; session BUFFER **still lists it** (drift is real); RESYNC line **absent** | drift manufactured, not yet healed |
| 5a | **Branch RING-OUT:** go available, let the ghost dial, DON'T answer | stdout: `match_diagnostic` (matched) + `serving_stamp.missed` per tick WHILE RINGING — **no prune yet** (the rescue window); call rings out and vanishes; within ≤60s the sweep fires `resync.pruned reason=idle-drift-sweep … why=row-cancelled` with `ringcxCancels cancelled:true` | miss ≠ prune while ringing; the sweep cleans up after the vanish |
| 5b | **Branch ANSWER (run the drill twice to do both):** answer the ghost | on the connect tick: `serving_stamp.rescued` (NOT missed→pruned); **the lead APPEARS IN THE MIDDLE with live buttons**; disposition it normally (voicemail → click Voicemail); row shows `rescuedFromState=cancelled` | the rescue: connected ghost + innocent death = synced, agent works it in OUR app |
| 6 | Inspect after (branch 5a) | `RESYNC: <time> reason=idle-drift-sweep removed=<id>(row-cancelled)`; BUFFER −1, target gone; **OUTBOX has NO row for the drilled id**; drilled row shows `rcxCancel=YES@<fresh>`; session `status=running`. (Branch 5b instead: your disposition's outcome row in the outbox, rescue stamps on the row, NO resync line) | forecast healed or call salvaged — never both, never neither |
| 7 | Let the next lead dial; work it normally | normal adoption, disposition, advance | the session never wedged |

**Deliberate non-goal:** the ghost call itself gets NO record (you manufactured an outlawed
state; its evidence is the trace pair in stdout). That's D6 territory, by design for now.

**Failure meanings:** no miss at step 5 → ghost didn't dial (check the row's extern is still
in RingCX) or watcher isn't ticking. Misses repeat past ~60s with no prune → resync not live
(env kill switch? pre-restart process?). Prune with wrong `why` → audit logic bug, STOP.
**Any outcome row for the drilled id → LAW violation, stop everything and call Fable.**

---
#### R2 — Trigger B + ghost-guard drill: the walk-away (explicit protocol)

*Proves: the lease-expiry reaper now unloads RingCX (Monday it lied "no copy"), and the idle
sweep prunes the dead buffer — no ghost ever dials, nothing freezes silently.*

**Preconditions:** P1/P2 as R1. Fresh mini queue (`RESYNC-B-01`…), start session, take ONE
call, disposition it. Baseline inspect saved.

**Steps → expected:**
| # | Do | Expect | PASS if |
|---|---|---|---|
| 1 | IDLE. Stay logged in, take nothing. Set a 13-minute timer | nothing for ~11 min (lease = reservedAt+10min, reaper ≈ +90s more) | patience |
| 2 | At ~12 min: inspect | reserved rows `state=ready releasedBy=long-call-hold-reaper` AND **`rcxCancel=YES@<fresh time>`** on every published row | THE GHOST GUARD: RC-unload actually ran (Monday: `rcxCancel=no` + "no-published-ringcx-copy") |
| 3 | Within ≤60s of step 2 (next sweep) | stdout `cx.alpha.watch.resync.pruned reason=idle-drift-sweep` all remaining ids `why=row-state-unadoptable`; `ringcxCancels` shows `skipped … no-live-ringcx-copy` for every row (the ghost guard already unloaded them at reap time — the dedupe proving both layers agree); inspect: BUFFER (0) + RESYNC line | quiet drift swept; defense-in-depth layers don't double-fire |
| 4 | Whole drill: your phone | NEVER rings | no ghost exists to dial — the guard beat the dialer |
| 5 | Cleanup: kill the session, rebuild fresh for whatever's next | kill log clean (`reservedReleased`, no orphans) | standard recovery still holds |

**Failure meanings:** step 2 `rcxCancel=no` → ghost guard not live (restart taken? code
present?) — do NOT proceed to step 3, the leads are still loaded in RingCX. Step 3 no prune →
resync off/env. **Step 4 phone rings → guard failed live, capture inspect + stdout instantly,
that's a blocker.**

---
#### R3 — Mickey's wrong-number run (matrix row F3, NOT a guard test)
Put a known-bad number on one lead. Expected: normal never-connect — `did_not_connect` +
`sys=INTERCEPT` (or carrier's verdict) in the outbox tail, status-line advance ~1s, NO prompt,
row healthy throughout, resync silent. This calibrates the LABELS; the guard never wakes.
File the result in the F-matrix, not here.

**Results table (fill as you run):**
| Run | Step | Observed | PASS/FAIL |
|---|---|---|---|
| R1 | | | |
| R2 | | | |
| R3 | | | |
Restart control-plane MID-CALL (wrap must survive the restart — it's on the session doc);
restart mid-wrap then click (the click must still be the record); kill a session holding a
wrapped current (reservations released, RC leads cancelled, no orphan outcome); rebuild over a
contaminated pool (the eternal enemy — verify the loader + inspect agree before dialing).
**Bar:** *"I tried to lose a record and couldn't."*

### Unit S4 — Paste round + re-run
Executor pastes BLOCK I (worklist) + continues the WO queue (WO-4/6 next — the cadence guard
protects every future session build). Re-run F9/F15 against the real bar. Then sprint 1's
Unit-1/2 human bars formally (they're nearly earned already by tonight's field work).
**Bar:** the sprint-1 bars, plus *"the worklist is where answered calls go to get finished."*

## Known-open ledger (so nothing hides behind compression)
- Tree UNCOMMITTED (S0 first act). Watcher lives in CONTROL-PLANE (restarts must hit it).
- Wrap has NO default timeout → walk-away wraps persist until session end (S2 counts them;
  decide a policy only if the soak shows real strays).
- ~~Legacy auto-review can still pop on never-connects until WO-16 lands~~ RETIRED EARLY
  (2026-07-02 night 2): the banner popped "auto-advanced — DNC?" over a manual No-answer click
  on a screener-bot call; Mickey ruled "factored out". The open-effect is now a null-asserter
  (CXWorkspaceBulkLoad.tsx ~4406, tsc clean); state/JSX/display-cascade plumbing still excises
  with WO-16. INTERIM GAP (accepted): no DNC path for auto-advanced calls until the WO-32
  worklist pastes — never-connects don't want one per design; answered calls wait for BLOCK I.
- `⚠ verify` items in the code-blocks guide: web-client test runner, coach bridge route names,
  lastOutcome display fields (BLOCK A's `connected` field is now `connectedAt` — update at
  paste time), auth-user shape on the BLOCK I endpoint.
- F16 (UII re-key) is a data hunt, not a known bug.
- Sprint-1 WO queue continues in parallel: WO-4, 6 (then 5/7/8), Phase B, then WO-16 (mine)
  after 14/15. WO-31/32 run in Phase C. BIG-GUNS reserved list unchanged.
- Coach side untouched tonight; Units 7–9 (manual read, A-station, Sean pilot) follow the
  bulk-rail bars. Aug-31 Sonnet pricing cliff still wants the pilot before September.

## Night-2 field samples + the three-way code trace (2026-07-02 late)

**Both live samples ran on a STALE process** (ParallelControlPlane was never restarted after
the connectedAt-latch / label-lookup patches — Mickey's own catch). So neither sample can
convict or acquit tonight's watcher code. The deep trace (client button path, server
disposition guards, watcher promotion-while-wrapped) read the DISK code and its findings
stand regardless:

**CORRECTION to the "wrap is invisible" claim:** the client keys the middle slot purely on
`current.uii` presence (CXWorkspaceBulkLoad.tsx:3998 `bulkConfirmedCurrent`), and a wrap-held
current KEEPS its uii — so a wrapped lead renders normally with live buttons. F8's promised
screen ("lead + buttons stay") is accidentally already met, no BLOCK paste required, as long
as (a) nothing strips uii and (b) no blocking overlay is stuck. The client is still wrap-BLIND
(zero references; no "wrap-up" pill), but blind ≠ hidden.

**Defect queue from the trace (all confirmed by code read, most-severe first):**
- **D1 — sticky blocking overlay, no watchdog (client).** `submitQueueDisposition` shows
  blocking transitions with NO auto-clear at :5765 ("Finishing current lead", cleared only by
  mutation settle) and :5786 ("Loading next lead", cleared ONLY if the refetched session has
  `current.uii`, :5793-5797). If the server hangs, or the next current never arrives, the
  overlay persists forever: all disposition buttons disabled + card body pointer-events-none
  = "clicks stopped working". Fix wants WO-17's identity routing first (unfreezing buttons
  mid-flight is unsafe while the POST is identity-less). Fold into WO-16/17.
- **D2 — session-mutation serializer tail has NO timeout (server).**
  cxBulkLoadRuntimeService.js:337-363: every mutation on a session queues behind the prior
  promise with no timeout and no enqueue log. One hung RingCX HTTP call inside any prior
  mutation wedges every later request on that session silently — zero logs, no HTTP response,
  frozen UI. Prime suspect for a zero-evidence click. Design-gated fix (timeout + trace line).
- **D3 — identity-less disposition POST** ({sessionId, disposition} only; applied to whatever
  current exists at execution; input.queueItemId silently discarded). Already Tier-1 / WO-17.
- **D4 — silent HTTP rejections — FIXED IN-TREE tonight:** routes/cxBulkLoad.js
  sendBulkCommand now logs `[cx.bulk.http] rejected` (path/status/code/sessionId/disposition/
  user) on every guard throw, and `[cx.bulk.http] null-result` on the silent
  no-active-session→HTTP-200-null path (cxBulkLoadRuntime.js:1273). Gate 280/280.
- **D5 — review hold blocks adoption; reason goes stale.** An active reviewHoldUntil
  early-returns the tick BEFORE match/promotion (watcherService:315-368) — a new call cannot
  be adopted during the (default 3s) progressive pause; fine at 3s, check
  CX_BULK_LOAD_PROGRESSIVE_PAUSE_MS isn't set long locally. On expiry NOTHING clears
  reviewHoldUntil/reviewHoldReason — the stale reason persists until the next reducer event
  (client auto-review banner conditions read it). Cosmetic-to-minor; note for WO-16.
- **Cheap alpha-trace gotcha:** every cx.alpha.* line is env-gated
  (CX_ALPHA_TRACE_ENABLED, plus CX_ALPHA_TRACE_AGENT substring filter) — "zero disposition
  logs" is only meaningful evidence when tracing is confirmed ON (name-only env check).

**Good news the trace certified:** supersede-while-wrapped is unblocked by design (wrap never
gates matching; `current.matched` completes the wrapped current answered-guard-checked and
promotes the new call, reducer clears hold fields); the watcher correctly filtered a stray
`parallel:*` call in the same sample; the auto-review surface is an inline banner, NOT a
backdrop modal — it cannot eat clicks.

**Night-2 run 3 (post-restart, more stable):** screener-bot call ("record your name" auto-
answerer) manually dispositioned No answer → the legacy auto-review banner still popped →
retired (see known-open ledger). OPEN QUESTION for F5: how does RingCX status a screener
pickup? The `sys=` label + the one-time `cx.bulk.leadsearch.row_shape` trace from this run
hold the answer — pull the inspect outbox tail for that call. RISK TO WATCH: a screener that
holds the line > CX_BULK_ANSWERED_MIN_CONNECTED_MS (10s) auto-records `answered` and will land
on the worklist; if field data shows screeners routinely exceed 10s, the fix is a higher
threshold or letting a MACHINE-family sys label veto the answered default — decide on data,
not tonight.

**2026-07-06 — VM DROP foot-on-the-hose (F6's server half), FIXED IN-TREE:** NSSM stdout
logs (C:\tools\logs\ — stdout IS live evidence, third surface alongside Mongo traces +
inspect) proved the VM press reached the server: VM DROP accepted by RingCX, then our
post-disposition hangup accepted ~1s later, no voicemail ever landed. Root cause (Mickey's
call, Codex-confirmed, code-verified): VM DROP is xfer:2 — RingCX ends the call BY
TRANSFERRING the leg to the drop system; `runPostDispositionHangupProbe` had no voicemail
exception and killed the transfer. Fix: voicemail outcome now skips the probe
(reason `voicemail-transfer-owns-call-end`, logged through the same probe channel;
cxBulkLoadRuntime.js:141 block). The probe still runs for everything else — Auto Dispo
(xfer:0) records but doesn't drop, which is why it exists. Pins: 2 new in
tests/cx-bulk-load/cxBulkLoadRuntime.test.js (voicemail never calls hangupCall /
did_not_connect still does). Gate 282/282 (280 + 2 declared). VERIFY LIVE (needs restart):
rebuild a mini queue, press VM once on a real VM box, confirm the drop actually plays and
the stdout trail shows probe.post_hangup.skipped with the voicemail reason. Side note from
the same sample: the sys-label lookup on the following auto-release found no matching row
before the 2s timeout — fail-soft worked, but watch whether label misses cluster (F1-F4
evidence). Duplicate "Mickey Answer Test" labels in the local batch make the flow FEEL
haunted — queue IDs/UIIs are distinct; consider unique names in the next test batch.

**2026-07-06 — GHOST-LEAD INCIDENT ("poller didn't connect to Mickey Answer Test 03"),
DIAGNOSED FROM LOGS+MONGO, NOT A CODE REGRESSION:** timeline: row 6a355aab (case 114149)
reserved 15:22:14 + published to RingCX campaign 2306 at 15:22:22 by Mickey's live session
cxbl-8d1f…; at 15:47:30 an out-of-band `codex-live-contamination-cleanup` CANCELLED the app
row (reason "remove-local-mickey-test-row-from-chris-live-queue") **without unloading the
published RingCX copy and ignoring the live reservation**; RingCX dialed the ghost at
15:50:25; control-plane restarted 15:50:37 (incidental); the new process **matched the call
16 consecutive ticks** (matchStatus=matched, promotion switch) but every apply skipped on
`cx.alpha.watch.serving_stamp.missed` — the serving CAS only accepts claimed/serving rows and
this one was cancelled. Call ended: **answered by a human, ZERO record anywhere** (apply-skip
discards the whole projection). Session frozen at v=13/phase=ready since 15:28. Sweep
confirmed this was the ONLY ghost from that cleanup. Boot was clean — the day's in-tree
changes (VM-hangup skip, route logging, banner neuter) are exonerated; VM fix still unverified.

Laws + defects this buys:
- **LAW: nobody cancels a published queue row out-of-band.** Any cleanup must go through the
  session kill (releases reservations + cancels RC leads) or be reservation-aware AND
  RingCX-unload-aware. An app-side cancel that leaves the RC copy loaded = a ghost lead that
  dials a real phone with no record — on a live queue that's a compliance hole, not a bug.
- **D6 — ghost-call recording hole (trunk-adjacent, WO-16/23 candidate):** when the serving
  CAS misses but the matched call is real (and possibly CONNECTED), the watcher discards
  everything. Minimum fix: persist a terminal observation (source=serving-miss-orphan) so an
  answered human call can never vanish; adoption can still be refused.
- **D7 — reservation TTL vs slow test sessions:** reservation expired 15:32 (10-min lease,
  reservedAt 15:22; the renew heartbeat was never wired — atticked as dead code, correctly).
  Slow human-paced test sessions outlive the lease; production pace likely doesn't. Watch S2
  soak for serving-miss clusters on slow sessions before designing anything.
- **Coordination fact:** local test rows publish into campaign 2306, which Codex treats as
  Chris's LIVE queue — the collision was two owners mutating one pool. Separate the test
  campaign or announce test sessions; either way, out-of-band cleanups follow the LAW above.
Recovery for the wedged session: kill it (proven path — reservedReleased + RC cancel +
currentTerminalized), rebuild a fresh mini queue, and note the ghost's RC-side lead in 2306
already consumed its dial.

**SAME DAY, THE SYSTEMIC HALF (Mickey: "isolate the issue if it exists outside of one-offs")
— IT DID. D8, THE GHOST FACTORY, FIXED IN-TREE:** Mongo showed the other 5 rows of the batch
in state `ready` with live published externs: at 15:33:45 (90s after the 10-min reservation
lease expired) the **long-call-hold reaper** released the whole remaining batch app-side, and
its RingCX-unload guard skipped with "no-published-ringcx-copy" on every row. Root cause =
reads→writes contract drift: `cancelRingcxPublishedCopyForQueueItem`
(cxCadenceService.js:~1819) read only the LEGACY `rcxVisibility*` publish fields; the bulk
publisher writes `lastRingcxPublished*`. So ANY release of a bulk-published row (reaper,
logout, manual-unavailable) freed the row app-side and left the lead loaded in RingCX =
ghost. Path map: session kill = correct (bulk-aware `cancelBatchForSession`); reaper = was
the factory; out-of-band = the Codex one-off. FIX: new pure `resolveRingcxPublishedCopies`
(exported for pins) recognizes both contracts — legacy status=published+extern+campaign, and
bulk extern+campaign+publishedAt newer than the last `rcxVisibilityCancelledAt` (so cancels
dedupe and republish revives); the guard now cancels EVERY live copy, passing the bulk
extern/campaign as overrides to `cancelPublishedQueueItemInRingcx` (which already accepted
them). Live floor unaffected until bulk rows exist there (legacy rows behave identically).
Pins: 4 in tests/cx-bulk-load/cxCadenceGhostGuard.test.js (incident shape / legacy unchanged
/ no-evidence skip / cancel-then-republish). **Gate 286/286** (282 + 4 declared).
DESIGN ITEM (not coded — refactor-fragile reservation territory): the lease still expires
under a living session (10 min, no renewal — the atticked `renewReserved`/`renewClaim`
heartbeat was BUILT for this and never wired; revival candidate per the attic's provenance,
OR teach the reaper to skip rows whose reservationRail=bulk_load while the owning session is
status=running). Decide after S2 soak data. OPS SEQUENCE for the retest: (1) KILL the frozen
session FIRST — its cancelBatchForSession unloads the 5 ghosts still sitting in campaign
2306; (2) restart ParallelControlPlane (picks up VM-hangup fix + route logging + ghost
guard); (3) fresh mini queue with UNIQUE lead names; (4) the two-call latch verify + one VM
press.

**2026-07-06 — RESYNC SPINE (Mickey's "enforce resyncing" ask, built + adversarially
verified):** VOICEMAIL LIVE-VERIFIED the same day (drop plays; dispo/hangup saga CLOSED);
Mickey declared the call loop "pretty tight" and named the next three priorities:
(1) consistent queue building, (2) new-call second-queue flow (M2), (3) edit outcomes
after the fact (completed list + modified wrap-ups → WO-31 generalized correction +
WO-32 worklist). Sequencing deferred to Fable: commit → restart → compressed latch verify →
S2 soak; build track = WO-16 → WO-31/32 → M2; executors WO-6 next; + a self-verifying
queue-build check to fold into the queue units.

THE SPINE: `buffer.invalidated` reducer event (prunes acceptedBuffer, stamps
session.resync{at,reason,removed[]}, records NO outcome); pure `deriveBufferInvalidations`
mirrors the serving-CAS precondition exactly (claimed/serving + this session's reservation;
reasons row-missing/row-cancelled/row-state-unadoptable/reservation-foreign); Trigger A =
serving-stamp miss (the drift alarm — the incident's 16 silent misses now self-cure on the
first one); Trigger B = idle-drift sweep (no current + buffered candidates, ≥60s apart —
catches the post-reaper frozen shape that never ghost-dials); queueStateAdapter gains
loadCandidateRows; schema gains the `resync` path (strict mode would have silently dropped
the stamp — caught pre-verify); sanitizeSession exposes `resync` (no PII); inspect prints a
RESYNC line. Version-guarded writes, same per-session serializer, kill switch
CX_BULK_RESYNC_ENABLED=false, default ON.

**GHOST CALL POLICY — FINAL 3-BRANCH MATRIX (Mickey's ruling, 2026-07-06 late, gate
296/296).** Born from his live experience: a ghost hit VOICEMAIL — a CONNECTED call, so
RingCX never ring-out-advanced and he sat welded to a greeting with no buttons. The policy:
| Ghost shape | What happens | Why it's safe |
|---|---|---|
| RINGING | NOTHING — miss recorded, prune DEFERRED (Mickey's catch: every ghost rings first; pruning mid-ring closes the rescue window before the callee answers). Never connects → call vanishes, idle sweep prunes + RC-cancels ≤60s later | hangup is a proven no-op on ringing; RingCX ring-out advances it; the sweep's CANCEL_LEADS stops repeats |
| CONNECTED + rescue gate PASSES | **SYNCED**: `rescueCandidateServing` re-claims the row (from ready/cancelled), the lead becomes current, buttons live — human → work it, voicemail → click Voicemail (VM DROP works). `serving_stamp.rescued` trace; row stamped rescuedAt/FromState/Reason | the human is the human-vs-VM classifier; the click is the record; the app stays the only surface |
| CONNECTED + rescue REFUSED | **AUTO-HANGUP** (`ghost_call.hangup` trace) then prune + RC-cancel | a DNC'd human answered = ending the call IS compliance; a VM costs nothing; the agent is freed without ever touching CX |
Rescue gate (deriveRescueDecision, pure + pinned): row must exist, cancelledReason must NOT
match DNC/contact-blocked, reservation must not belong to another session, state must be
ready/cancelled (claimed/serving = the normal stamp's race, retried next tick), AND the
loader's own contact-eligibility check re-passes fresh (fail-closed: no verdict = no rescue).
Foreign rows are additionally never RC-cancelled by the pruner (their copy is theirs).
Everything gated by the same CX_BULK_RESYNC_ENABLED switch.
**R1 PROTOCOL CHANGE:** the drill's cancel reason is benign, so the drilled ghost is
RESCUE-ELIGIBLE — R1 now tests both branches: LET IT RING → prune path as written (steps
5-6); ANSWER IT → the lead should APPEAR IN THE MIDDLE with live buttons (rescued), you
disposition normally, row shows `rescuedFromState=cancelled`, no resync line. Run it both
ways. To manufacture branch 3 (refused→hangup), re-run the drill against a lead whose case
is contact-blocked, or trust the pins.

**RESCUE-LANE ADVERSARIAL VERDICT (2-lens refutation pass, 2026-07-06 late — 2 blockers +
3 real findings, ALL FIXED same night, gate 299/299):**
- **B1 (flicker clobber):** a one-tick snapshot flicker of a LIVE connected current + a
  connected ghost → the switch would force-complete the live call "answered" MID-conversation
  and install the ghost as current, permanently. FIX: SWITCH GUARD — a promotion carrying
  `completePrevious` is never rescued (promotion now carries the flag); the flicker tick
  reverts to the pre-rescue harmless miss. Self-sequencing: once the agent resolves their
  current, the ghost promotes with no previous and rescues cleanly. PINNED.
- **B2 (foreclosed retry):** the same-tick prune deleted the candidate the promised
  next-tick retry needed (the audit calls every rescuable row "unadoptable"). FIX: Trigger A
  prunes ONLY on a DEFINITIVE refusal; transient refusals retry with the candidate intact;
  Trigger B sweeps abandoned ones after the call leaves the snapshot. PINNED.
- **F1 (false-definitive under CX_BULK_LOAD_REQUIRE_FRESH_LOGICS_STATUS):** a Logics outage
  arrived as a well-formed ok:false → definitive → hangup on a live eligible human + a
  case-wide enforceStop cancel. FIX: the rescue's eligibility check is now READ-ONLY
  (enforceStop:false, fresh-status never required) and infrastructure-flavored block reasons
  are non-definitive.
- **F2 (TOCTOU):** a compliance stop landing inside the eligibility await could be silently
  overridden by the rescue CAS. FIX: the CAS re-asserts the decided-upon document via
  `updatedAt` match — any concurrent write makes it miss and re-read.
- **F3 (dead gate):** deriveRescueDecision read `cancelledReason` but the compliance stop
  writes `cancelReason` — the DNC fast-gate never fired for the system's own primary DNC
  writer. FIX: both keys read. Also: reservation-foreign demoted to NON-definitive (a
  foreign owner holds a future dial intent; the live call may be a good conversation —
  never hang it up for that).
- Refuted by the skeptics (stays good): no nonsense match constructible (extern-only,
  session-fingerprinted, pre-filtered); no row steal (from-state CAS closes it); no
  session-write clobber (version guards); no unbounded retry storm; no double-hangup.

**RESYNC LAW (Mickey's non-invasiveness ruling, 2026-07-06):** the buffer is a FORECAST —
heal it freely (no call happened, pruning invents nothing). The current is a FACT — the
resync reads around it but NEVER touches it; the middle slot is governed by the human click
+ wrap law, and every historical middle-slot bug came from something "helpfully" mutating
it. The client is a 1s MIRROR of the session doc — no independent state, self-heals by
construction (its one real wedge, the blocking overlay, is client-local: D1/WO-16/17).
Walk-away wrap strays are COUNTED in the S2 soak, decided as policy, never auto-healed.
If the soak surfaces a real current-drift case, the sanctioned extension is a TRACE-ONLY
current check in the same audit — evidence, no action, and only after one real occurrence.

ADVERSARIAL VERIFY (2 lenses, both tried to refute): 1 BLOCKER found+fixed — per-id error
swallow in loadCandidateRows made a Mongo blip look like a deleted row (would prune healthy
leads as row-missing during a replica election; now any read error rejects the whole batch →
trigger does nothing; pinned). 1 real-minor fixed — Trigger A now respects the 60s rate
limit (a stubborn un-curable miss no longer re-reads the buffer every 1s tick). 2 nits
fixed — sanitize passthrough (above) + clock hygiene (scoped runs / busy ticks no longer
purge other sessions' rate-limit stamps). REFUTED by the skeptics (good news): the
prune→refill→re-reserve path is clean (only reaped `ready` rows can re-enter, via a fresh
reservation+publish). Pins: 6 in tests/cx-bulk-load/cxBulkLoadResync.test.js incl. the
read-failure pin. **Gate 292/292.** Needs the restart to go live (same bounce as the ghost
guard + VM fix).

**Retest protocol (the un-contaminated run):** restart ParallelControlPlane FIRST; fresh
queue; confirm CX_ALPHA_TRACE_ENABLED is set (name only); browser console open — `[disp]
PRESS` at CXWorkspaceBulkLoad.tsx:5737 is the client-side proof-of-click (its absence = button
disabled/unmounted, its presence + no server log = D2/D4 territory); inspect script now prints
`lane=CONNECTED@…/never-connected` on CURRENT. Then re-run: answered→hangup (expect wrap,
buttons stay), next call (expect supersede→answered), never-connect (expect sys= label).

## RUN 4 RESULTS (2026-07-06 ~11:18-11:22 — the ghost lane's first live PASS + one UI find)

**GHOST PREVENTION LIVE-VERIFIED, END TO END:** drilled lead (Mickey Gray 01) was pruned by
the resync at 11:18:21 (row-cancelled) and its RingCX copy pulled with CANCEL_LEADS
`leadUpdateCount:1, dialerRefreshed:true` — **before it ever dialed**. No outbox row. RingCX's
own receipt confirms the lead was in dialable inventory (a not-found cancel returns count 0).
Leads 02/03 ran the boring loop: current → manual did_not_connect → drain replayed → call
notes → RC copies cancelled. This closes R1/R2's prevention branch with field evidence.

**Microscope gap (FIXED):** inspect said `rcxCancel=no` for 01 — it only read the release
path's `lastRingcxReleaseCancel` stamp; the resync's cancel stamps `rcxVisibilityCancelledAt`
via the canceller. Inspect now reads BOTH success shapes.

**THE NAME-VANISH BUG (FIXED, client):** "anytime the call picked up for 2 or 3 the name
disappeared from the middle" — root cause was NOT the pickup and NOT F16: the legacy
stale-served-queue recovery (`STALE_SERVED_QUEUE_RESET_MS = 20s`, CXWorkspaceBulkLoad.tsx
~5509) had NO bulk guard. In bulk mode the legacy queue is empty, so 20s after a lead landed
it always "recovered" — wiping the case panel (form → formHeading → the name) right around
when a ~15s ring got answered. Quick ring-outs advanced before the timer, which is why only
answered calls showed it. Buttons survived because they key off the server current (the
"happy accident"). FIX: `if (bulkRunning) return;` — the same guard its sibling legacy
effects already wear. tsc clean. Takes effect on the next client build/reload.

**FLICKER PARTLY REPAIRED, STILL OBSERVED (Mickey, post-fix run) → THE FIELD MICROPHONE:**
static analysis missed the wiper twice, so the client now confesses: every case-panel wipe
logs `[cx][wipe] {source}` (sources: bulk-session-ended / legacy-terminal-workflow /
legacy-stale-served-queue / next-call-handoff-fallback / next-call-rescheduled /
fresh-call-scramble-reset) and every panel populate logs `[cx][identity] populate {key,name}`.
VERDICT (same day): **STALE BUNDLE.** The pre-rebuild console showed hashed bundle
`CXWorkspaceRouter-CADvIyIz.js` unchanged across refreshes and zero microphone lines — the
web client is a BUILT bundle served by the control plane (server.js ~525 express.static), so
**client fixes need `npm run build` in apps/web-client, not a browser refresh**. None of the
day's client fixes had ever run ("partly repaired" = timing noise). POST-REBUILD
(`-BYRWoGn_.js`), first answered-call test: `[cx][identity] populate` fires with the name on
land AND on the post-dispo review handoff (same name, key flips current:→review:), and ZERO
`[cx][wipe]` lines — the name STAYED. n=1; the microphone stays armed — if the vanish ever
recurs, the console names the source. BONUS from the same logs: the `resync` annotation rides
the client projection as designed (an idle-drift-sweep prune visible in the disposition
response), and dispositions resolve ~2s with `terminal.ok=true`.

## DRAIN HARDENING LANDED (2026-07-06 night — Mickey's "stable for oddities + auto opt-out" directive, gate 304/304)
From the drain characterization's findings, all in-tree (restart to go live):
1. **Minimal resolution + backoff (SIMPLIFIED per Mickey same night — "we don't need to try
   24 times on something that's never going to work"):** failed rows back off quadratically
   (15s → 30-min cap); after **3** failed full replays the drain stops trying the effect
   chain, stamps the BARE MINIMUM back onto the lead (`recordMinimalTerminalResolution`: the
   outcome string + at/uii/sys-label + `lastTerminalResolution: "minimal-drain"` on the queue
   row — "the string tied back to the account"), and drains the row (`resolution: "minimal"`,
   `cx.alpha.drain.row.minimal_resolved` + warn). MALFORMED rows (no payload / no queue-item
   identity — "no button press") drain immediately with zero retries and zero writes
   (`resolution: "malformed"`). **Nothing ever parks; no dead-letter queue for a human to
   forget.** Kills poison-retry-forever, batch starvation, and bounds all replay drift at 3.
2. **markDrained is a CAS** (pending/failed only) + `drained_cas_miss` trace = concurrent-drain evidence.
3. **`oldestPendingAgeMs`** in every tick result — the stuck-ness dashboard number.
4. **LeadCadence counter replay-guard:** per-UII CAS on the counter write — the prior+1
   double-increment on partial-apply replays is dead.
5. **Sys-label store landed** (the WO-23 one-liners): `metadata.lastTerminalSystemDisposition`
   on every handler exit path + `ringcx.systemDisposition` on CallLog.
6. **WRAP JANITOR (policy change):** default wrap timeout is now **30 minutes** — an
   abandoned wrap self-resolves via the answered guard (source `wrap-timeout`), superseding
   hold-forever. `CX_BULK_WRAP_TIMEOUT_MS=0` restores the old behavior. The old hold-forever
   trunk pin is rewritten as held-at-14-min / swept-at-34-min.
Known remainder (documented, deliberate): bulk DNC's Logics half still doesn't exist — that
lands with the wrap queue (design doc), DNC cutover LAST.

## SCALE RISKS — the ghost/resync/rescue lane beyond isolated tests (Mickey's ask, 2026-07-06)

Per-event the lane is correct; at floor scale correct actions in bulk become POLICY, and
policy needs caps, corroboration, and a human tripwire. Ranked:

1. **Tick-time contamination (top risk).** The watcher tick is the floor's heartbeat; the
   lane adds variable-latency work to it (row reads, eligibility checks, RC cancels,
   hangups). A stranded connected ghost retries its rescue EVERY TICK incl. an eligibility
   call — ten of those during a Mongo/Logics brownout slow the tick, and a slow tick
   mis-times the latch → real answered calls mis-classify. HARDEN: per-candidate rescue
   backoff (~5s, not per-tick); treat tick duration as a metric with an alarm.
2. **Storm amplification.** A systemic drift producer (bad TTL, bad deploy, rogue cleanup)
   makes the WHOLE floor "provably dead" → mass prune + hundreds of sequential CANCEL_LEADS
   → RingCX throttling, tick stalls, the floor's loaded work destroyed in minutes — loudly
   but automatically. HARDEN: per-tick prune/cancel caps per session + a CIRCUIT BREAKER
   (>X% of floor rows dead in a window = systemic event → freeze the healer, page a human).
3. **Hangup trusts historical metadata.** The definitive gate keys partly on cancelledReason
   strings written by OTHERS; a lazy future script stamping blocked-flavored reasons on
   innocent rows = systematic hangups on live humans "for compliance". HARDEN (highest-value
   single change): the hangup requires the FRESH eligibility verdict to corroborate — a
   string match alone is refuse-without-hangup.
4. **The healer hides the disease.** Chronic drift used to scream (wedges); now it hums —
   pruned leads look like "the queue ran dry", a slow dial-volume leak behind a health mask.
   HARDEN: aggregate the prune counts somewhere a human looks (metrics panel / daily line)
   with a go-find-the-wounder threshold.
5. **Noted, smaller:** rescue re-claims outside the family-order reservation machinery
   (off-books path — note in the invariant docs); system hangups flip agents available →
   machine-gun cadence under mass drift (per-session hangup rate cap, e.g. 3-in-5-min then
   stop+alarm); the whole lane assumes the SINGLETON watcher (in-memory clocks duplicate
   across pods — revisit before any multi-process control plane).

Shortlist if/when hardening is ordered: #3 corroborated hangups → #1 rescue backoff →
#2 caps+breaker → #4 prune surfacing. None are big; all are the difference between a tool
and a lawnmower running unattended.

## Post-review patch (same night, after the read-only second-opinion pass)
The reviewer confirmed the label chain but found the drain bridge dropping it. Fixed in-tree:
1. **Drain bridge forwards `systemDisposition`** (apps/control-plane/src/server.js
   recordCadenceEvent bridge) — the payload carried it; the bridge now hands it to
   `handleCxTerminalCallOutcome`. NOTE: the handler does not yet STORE it (queue-row
   metadata / CallLog evidence) — that one-line add belongs to WO-23's
   characterization-test-first work on the handler; the field now arrives at its doorstep.
2. **Lookup gates on OUTCOME, not source** — any `did_not_connect` (including superseded
   short-connects wearing "active-call-switch") gets the label probe; `answered` rows never
   need one (connectedAt + duration already decided).
Gate: 284/284. The reviewer's design endorsement stands: the watcher owns the lookup (freshest
context); the drain only ever forwards; a drain-side lookup is at most a future
backfill/rectifier concern.
