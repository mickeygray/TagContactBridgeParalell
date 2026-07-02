WO-wrap-state — TRUNK RULING implementation (call end ≠ outcome)          STATUS: DONE
Executor: Claude Fable (direct, 2026-07-02 evening, after the answered-call eject)

LEDGER: 273 total / 273 pass / 0 skipped -> 277 total / 277 pass / 0 fail
(expected: 4 old-behavior tests re-expressed under trunk semantics + 5 new trunk pins,
net +4; actual matched)
TYPECHECK: clean (no .ts files touched this order)

WHAT CHANGED (one file of production code):
- packages/shared-services/src/cxAccountActiveCallWatcherService.js — the connected-release
  response only. Detection unchanged. A released current WITH a UII now transitions to
  current.wrap = { at, reason } instead of writing did_not_connect + clearing: same current,
  buttons stay live (UI keys on current existing; sanitizer passes wrap through — ZERO UI
  changes needed), the agent's disposition IS the record via the unchanged normal path.
  Never-connected releases: identical old behavior. Wrap timeout (options.wrapTimeoutMs,
  default 180000ms): expiry runs the old terminal path with source "wrap-timeout".
  Reappearing call clears the wrap flag (resume). wrapChanged added to the changed detection.
- Supersede rule: a genuine next-call arrival ends the wrap via the EXISTING switch path
  (completePrevious, source "active-call-switch") — no hold gap; q2 promotes immediately.

TESTS:
- Re-expressed (intent preserved): "releases current when RingCX drops it" -> wrap pin;
  "releases UII-bearing current after cache lost" -> covered by wrap pins; service-level
  "writes terminal observations for released UIIs" + the LOCKED #6 version-miss test -> seeded
  with an EXPIRED wrap so the identical terminal/version-miss machinery runs (source
  "wrap-timeout"); auto-advance + rejected-disposition tests -> supersede expectations
  (source "active-call-switch", next call promotes, no hold gap); refill-serialization test ->
  never-connected current (its subject is serialization, not release semantics).
- New trunk pins: connected release wraps (no outcome, current held) · wrapped current holds
  steady next tick (no duplicate processing) · wrap timeout writes did_not_connect
  source:"wrap-timeout" · reappearing call clears wrap · never-connected still releases
  immediately · THE TRUNK PIN: disposition on a wrapped current -> dispositionOk, exactly ONE
  record carrying the HUMAN's outcome, cleared only after it landed, stable across the next tick.

NOTES:
- RingCX side: disposition-after-call-end is the normal dispositioning-hold flow; the
  already-ended hangup tolerance (isAlreadyEndedHangupError) covers the probe. The early
  auto-write never bought advancement.
- reviewHold is no longer set for connected releases (the wrap replaces it); never-connected
  and timeout paths still set it, so the correction lane (WO-31, demoted to safety net)
  retains its trigger.
- NOT restarted, NOT committed (Mickey's lane). The next live run after a restart is the
  trunk's field test: answered call ends -> lead stays -> click -> that outcome is the record.

LIVE HITS: n/a (behavior change, no deletions).

---
ADDENDUM 2 — CONNECTED LATCH (congestion fix, same day, after Codex's no-default-timeout patch)

FIELD EVIDENCE (via the new scripts/cx-bulk-session-inspect.js — WO-9, now built):
- All promotion-time active-call stamps read callState "OUTDIAL" — a UII is assigned at DIAL
  time, so UII presence NEVER meant "answered". The congestion call (case 123558) showed the
  full signature: uii assigned + OUTDIAL-only + vanished + zero serving stamp; RingCX advanced
  with no disposition.
- Codex's no-timeout patch (correct for answered calls) made the wrong-signal worse: an
  OUTDIAL flash could wrap FOREVER.

FIX (cxAccountActiveCallWatcherService.js):
- CONNECTED LATCH: connectedAt stamped ONCE when the current's uii is observed in a
  connected-family state (ACTIVE/CONNECTED/ONHOLD/HOLD/TRANSFER) — per-tick half (before
  release derivation) + promotion half (matched call already connected at promotion).
- Wrap eligibility = connectedAt (was: uii presence). Never-connected vanishes — ring-outs AND
  carrier congestion — take the immediate machine outcome; the loop advances instantly.
- An existing wrap is honored regardless (Codex's opt-in timeout semantics preserved).

LEDGER: 278/278/0 (fixtures for answered-call tests now carry callState "ACTIVE" — honest
data; the congestion case is the never-connected path, already pinned).

FOLLOW-UP (small, optional): label congestion distinctly — after a never-connected release,
a fire-and-forget leadSearch on the lead could read RingCX's own pass result and relabel the
outcome "congestion" instead of generic did_not_connect (reporting nicety, not loop integrity).
RESTART NEEDED: ParallelControlPlane only (the watcher's home).

---
ADDENDUM 3 — CONGESTION LABEL, wired live (Mickey: "put the speculative fix directly in")
- Engage Voice docs confirmed: leadSearch accepts `systemDispositions` filters and CONGESTION
  is a first-class system disposition; leads carry externId in responses.
- On a never-connected release the watcher does ONE bounded (2s race) fail-soft
  `searchLeads({campaignId, systemDispositions:["CONGESTION"]})`, matches OUR lead by externId,
  and stamps `systemDisposition: "CONGESTION"` onto the terminal record. The outcome ENUM stays
  did_not_connect — cadence/drain routing untouched; this is a reporting label. Any error,
  timeout, or non-match keeps the plain record (pinned).
- Adapter threads the field; it persists inside the outbox row's `payload` (Mixed);
  cx-bulk-session-inspect now prints `sys=CONGESTION` on the outbox tail.
- LEDGER: 280/280/0 (two new pins: label attaches on match; failing search keeps the plain
  record). Restart: ParallelControlPlane.

---
ADDENDUM 4 — THE AUTO-ADVANCE TAXONOMY (Mickey's ruling, 2026-07-02): every RingCX
auto-advance is exactly one of two lanes. (1) SYSTEM-DISPOSED NEVER-CONNECT — RingCX advanced
because it already disposed the pass (CONGESTION/BUSY/INTERCEPT/NOANSWER/MACHINE/ABANDON):
push ITS verdict to our terminal record (their vocabulary, read not invented). (2) ANSWERED,
NO DISPOSITION FROM US — prospect hung up on a connected call: the wrap holds for the human's
click, which IS the record. The connectedAt latch is the lane selector. Generalized label
landed: family-filtered probe + per-lead field read (plausible names) + one-time row-shape
trace (cx.bulk.leadsearch.row_shape) + CONGESTION-only fallback; BUSY pin proves verbatim
stamping. 281/281.
OPEN (business call, NOT built): mapping their system dispositions into OUR outcome enum
(e.g. MACHINE -> voicemail) would change cadence routing — Mickey decides if/when.

---
ADDENDUM 5 — THE HANG-UP-ON-US CASE (the one modal, ratified): when the PROSPECT hangs up on
an answered call and RingCX advances, the new call owns the screen/buttons — so the superseded
answered lead is the ONE moment a modal exists: the answered-undisposed card (agent picks the
real outcome; click routes through the WO-17/31 correction lane; the new call is never
blocked). Signal = lastOutcome.connectedAt + no manual outcome. GAP FOUND BY PIN + FIXED: the
supersede path (reducer current.matched/completePrevious) never set lastOutcome — the modal
would have had nothing to read; the reducer now stamps the completed previous into lastOutcome.
Pin: "a hung-up-on ANSWERED call superseded by the next call stays correctable". 282/282.
Full human-interaction surface, final: (1) live call → buttons; (2) answered call ends, no
next call → wrap, same buttons, no popup; (3) answered call ends, next call already live →
the ONE modal for the previous lead; (4) never-connected → nothing asked, RingCX's verdict
recorded w/ system-disposition label. UI halves of (3) land with WO-16 (projector modal) +
WO-31 (correction lane).
