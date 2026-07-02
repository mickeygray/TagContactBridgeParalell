# Sprint 2 — Stability & Funky Call Outcomes (game plan, written 2026-07-02 night)

The next sprint: take the outcome engine written tonight and prove it against every weird call
shape a dialer floor actually produces, then soak it for stability. Companions:
`docs/FINISH_SPRINT_QUEUE_TO_COACH_2026-07-02.md` (sprint 1, still governs the WO queue),
`docs/CX_BULK_LOAD_REWRITE_WORK_ORDERS_2026-07-02.md` (work orders + THE SPLIT),
`docs/CX_BULK_LOAD_CODE_BLOCKS_2026-07-02.md` (paste-ready blocks incl. BLOCK I),
`docs/rewrite-reports/WO-wrap-state.md` (tonight's full change log, addenda 1–5).

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

**Retest protocol (the un-contaminated run):** restart ParallelControlPlane FIRST; fresh
queue; confirm CX_ALPHA_TRACE_ENABLED is set (name only); browser console open — `[disp]
PRESS` at CXWorkspaceBulkLoad.tsx:5737 is the client-side proof-of-click (its absence = button
disabled/unmounted, its presence + no server log = D2/D4 territory); inspect script now prints
`lane=CONNECTED@…/never-connected` on CURRENT. Then re-run: answered→hangup (expect wrap,
buttons stay), next call (expect supersede→answered), never-connect (expect sys= label).

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
