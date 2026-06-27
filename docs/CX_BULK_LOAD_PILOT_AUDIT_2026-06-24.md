# CX Bulk-Load Rail — Pre-Pilot Audit (2026-06-24)

> Read-only, xhigh-effort audit of the CX "bulk load" dial rail ahead of a **Sean-only floor
> pilot**, against the code author's audit targets. Method: 9 finder angles (7 author areas + 2
> cross-cutting) → **every finding adversarially verified against the actual code** by a separate
> reader → gap sweep. **45 findings, all 45 confirmed** (6 critical, 10 high, 18 medium, 9 low,
> 2 cleanup). No edits made. Source run: `tasks/wmjz0ucch.output`.

## Top-line verdict

**The design is largely sound; the panel is not pilot-ready.** The things the author was most worried
about mostly check out — but **all 6 criticals share one root cause**, and it fires even with a single
agent. **Do not start the Sean pilot until the session-write path is serialized.**

What's genuinely safe (verified): account watcher does **one read per tick, not per agent**; matching
is **strict safe-identity only** (externId / queueItem / UII — no phone/name fuzzy match, no
wrong-lead enrichment); the busy skip is **per-session, never a global floor lock**; the busy flag
**always clears** (no permanent busy-lock); **DNC reaches the drain→Logics path**; true 429/400/timeout
**fails soft**; pilot isolation is clean (**Sean-only enable, hot flip-back to legacy without a
rebuild, idle watcher = true no-op**); the browser is **read-only** on `/session`.

---

## Root cause (all 6 criticals)

Three things write the **same session document** concurrently — the agent command
(disposition/skip/kill), the per-session `/watch` poll (~1s), and the background account watcher
(~1s) — with no serialization:

1. **Blind full-document `$set`, no version guard** — `cxBulkLoadSessionRepository.js:108-112`
   (`findOneAndUpdate({sessionId}, {$set: patch})`, no `version`/`updatedAt` match) → last-write-wins.
2. **`withSessionMutation` is a presence `Set`, not a lock** — `cxBulkLoadRuntimeService.js:245-254`
   does `busySessionIds.add(key)` with no `.has()` rejection, so concurrent same-kind mutations both
   proceed.
3. **The `/watch` + refill path never enters the busy set** — `:519-520` only *reads* it; only
   disposition/skip/kill register busy. And the account watcher **snapshots the busy set before its
   awaits** (`:864`, `Array.from(busySessionIds)`), so a disposition starting mid-tick isn't skipped.

Net: a `/watch` or account-watcher tick that began just before Sean clicks Disposition finishes its
~1s RingCX read and **`$set`-clobbers the disposition** — resurrecting the dispositioned lead at the
top of the panel, or two ticks both refill and double-claim pool rows. This is the engine behind both
pilot-killers: "lead stranded at top" *and* "call doesn't count."

---

## Critical findings (6 — all confirmed)

| # | File:line | Defect | Failure |
|---|---|---|---|
| C1 | cxAccountActiveCallWatcherService.js:301-406 | Stale busy-snapshot + blind `$set` clobbers an in-flight disposition | Dispositioned lead resurrected at top; refilled buffer overwritten |
| C2 | cxBulkLoadRuntimeService.js:519-698 | `/watch` never registers busy → concurrent ticks both `maybeRefill` + persist | Last-write-wins clobbers promoted current + fresh leads (orphaned rows) |
| C3 | cxBulkLoadRuntimeService.js:245-783 | `withSessionMutation` is a flag, not a lock | Double-clicked disposition double-fires terminal write + refill (double-count, double-claim) |
| C4 | cxBulkLoadRuntimeService.js:519-698 | Watch tick persists stale whole-doc over a completed disposition | Terminal counted, but session view corrupted; agent stuck on a dead lead |
| C5 | cxBulkLoadRuntimeService.js:864 | Background account-watcher per-session `$set` from stale snapshot | Same clobber as C1, no front-end involved (runs across every session) |
| C6 | cxBulkLoadRuntimeService.js:607-698 | Two un-serialized watchers persist **divergent** `prevActiveCalls` | Loses externId/uii needed to later release → feeds stuck-current + lost-count |

## High findings (10 — all confirmed; top 9 shown)

| # | File:line | Defect | Failure |
|---|---|---|---|
| H1 | cxBulkLoadActiveCallWatcher.js:44-178 | An empty/malformed **HTTP 200** RingCX body → `extractActiveCallList()` returns `[]`, indistinguishable from "no calls"; no debounce | One transient bad-200 tick clears the **live** current + books a false `did_not_connect` |
| H2 | cxAccountActiveCallWatcherService.js:168-178 | Auto-advance `completePrevious` moves prev lead to `completed[]` but pushes **no `terminalObservation`** | Real dialed lead silently **uncounted** (no cadence/Logics) |
| H3 | cxBulkLoadRuntimeService.js:651-692 | Same `completePrevious` zero-terminal gap in the per-session path; the green test exercises the *other* branch | Uncounted call; only the 5-min hourly rectifier may recover it |
| H4 | cxBulkLoadRingcxPublisher.js:70-122 | "Accepted" inferred from absence-of-rejection; **ignores `leadsInserted`** | `{leadsInserted:0, rejectedRows:[]}` (REMOVE_FROM_LIST dup, suppression) shows as a refilled lead RingCX will never dial |
| H5 | CXWorkspaceBulkLoad.tsx:5457-5466 | Disposition transport error → overlay set `blocking:true` with no `autoClearMs` and no `clearQueueAdvanceTransition()` | Overlay stuck + **every disposition button disabled**; only escape is Stop (kills the session) |
| H6 | cxBulkLoadOutcomeAdapter.js:30-34 | Watcher release + agent disposition collapse to one `qid:uii` idemKey; `insertOnce` is first-write-wins | Watcher-observed release that beats the click records the call as `did_not_connect` **forever**; the real voicemail/answer is deduped away |
| H7 | cxBulkLoadActiveCallWatcher.js:161-179 | `deriveCurrentRelease` clears current only when `prevActiveCalls` has the externId **with a truthy uii** | After a soft-error tick (or a no-UII promotion) the finished lead is **stranded at top forever** |
| H8 | cxBulkLoadActiveCallWatcher.js:143-146 | A dial whose entire lifetime is between two ~1s polls is never seen active-with-uii | The call is **never counted** (no terminal, silently dropped from buffer) |
| H9 | cxBulkLoadRuntimeService.js:749-758 | Disposition with `terminalExecutor ok:false` (RingCX 400/transient) returns **before** `persistTerminalOutcome` | Call not counted **and** current not cleared → stuck lead |

## Notable mediums/lows (selected — all confirmed)

- **Set-appointment fires a legacy-rail IMMEDIATE dial mid-bulk** (`CXWorkspaceBulkLoad.tsx:5469-5538`,
  no `bulkRunning` guard) — the one non-terminal mutating command reachable from the bulk panel; races
  the bulk rail's own buffer. *(client isolation leak)*
- **Last-lead disposition leaves a stuck "Loading next lead" overlay** (`:5446-5454`) — clears only on
  a new numeric-caseId current, which never arrives when the buffer is empty.
- **`maybeRefill` has no in-flight latch** (`cxBulkLoadRuntimeService.js:415-437`) — two concurrent
  callers compute the same deficit and both `fillBuffer` → ~2× the target buffer loaded.
- **Refill post-publish release re-opens a double-dial** (`:369-399`) — a CAS-miss after a successful
  RingCX insert releases the Mongo row but not the RingCX lead; a second session can re-publish it.
- **No-UII idemKey collapse** (`cxBulkLoadOutcomeAdapter.js:30-35`) — skip + manual-reset-kill for the
  same queueItem share `${sessionId}:${qid}:terminal`; the second is silently dropped.
- **Outbox fail-open double-count** (`cxBulkLoadRuntime.js:245-261`) — `insertOnce` error is caught as
  `{idemKey}` (truthy), so under a Mongo blip two concurrent watchers both dispatch the cadence event.
- **busy set is per-process only** (`:232`) — the moment the control plane scales or restarts under
  load, cross-process double-disposition/double-refill is unguarded.
- **skip/kill have no inner try/catch** (`:787-848`) — a throw clears busy correctly but leaves the
  session mid-mutation (stuck lead on throw); same for disposition's bare `persist`/`maybeRefill`.
- **No per-session log visibility** (`server.js:1016-1032`) — a frozen session is **silent**; the rich
  per-session projection (matchStatus/currentUii/transitionKind) goes only to Mongo `trace`, never logs.
- **Single-sample release, no debounce** (`cxAccountActiveCallWatcherService.js:100-139`) — RingCX
  eventual-consistency blips trigger release on the first omitted tick.

---

## The author's questions, answered

| Area | Question | Verdict |
|---|---|---|
| Account watcher | One account read per tick, not per agent? | ✅ yes |
| | 429/400/timeout fail soft, no session killed? | ✅ yes (but a bad **200** does not — H1) |
| | Enough logs to diagnose a stale session live? | ⚠️ partial — frozen session is silent |
| Busy skip | Only the busy session skipped (no global lock)? | ✅ yes |
| | Can a session stay busy forever on throw? | ✅ no — `finally` always clears |
| | Finally cleanup correct on every path? | ⚠️ partial — flag clears, but skip/kill/disposition can leave the lead mid-mutation |
| Projection identity | Match only on safe identity (externId/queueItem/UII)? | ✅ yes |
| | Any enrichment path attaching the wrong lead? | ✅ no |
| | Departed current correctly cleared? | ⚠️ partial — H7 / no-UII stranding |
| Refill | Visual refill = RingCX actually accepted? | ⚠️ partial — H4 phantom-accept |
| | One-at-a-time, await each accepted? | ✅ yes |
| | Can refill run twice / during a concurrent write? | ❌ **no — unsafe** (C2/C3, `maybeRefill` latch) |
| Terminal/counting | Every real UII exactly one terminal? | ⚠️ partial — zero (H2/H3/H8) or wrong (H6/H1) |
| | Auto-advanced no-answers → `did_not_connect`? | ⚠️ partial — `completePrevious` writes no durable terminal |
| | DNC reaches drain→Logics, not only metrics? | ✅ yes |
| Client read-only | Browser only reads `/session`? | ✅ yes |
| | Buttons only terminal commands? | ⚠️ partial — Set-appointment fires a legacy-rail dial |
| | Overlay hides flicker without blocking others? | ⚠️ partial — blocks the agent's own panel on failure/last-lead (not other agents) |
| Pilot isolation | Bulk enable for Sean only? | ✅ yes |
| | Flip back to legacy without a rebuild? | ✅ yes |
| | Watcher no-op when zero bulk sessions? | ✅ yes |
| Concurrency | Read-modify-write races on session state? | ❌ **no — unsafe** (C1-C6) |
| | Any terminal/refill/advance not idempotent? | ⚠️ partial — H6, mediums |
| | State set without guaranteed clear on throw? | ✅ flag clears (but session state can be left stuck) |

## Verdict on the author's five asks

1. **Is the server watcher safe as the universal matching *direction*?** As a **reader/matcher, yes**
   (one read/tick, safe identity, fails soft on real errors). As a **writer, no** — it and `/watch`
   both blind-`$set` the doc. The fix *is* the author's instinct: make the account watcher the **sole
   writer** and turn `/watch` read-only.
2. **Safe for a Sean-only pilot?** **Isolation is safe**; **the concurrency is not.** One agent already
   has three concurrent writers (his click + `/watch` + account watcher), so Sean-only does not dodge
   the clobber. Not until the write path is serialized.
3. **What strands a lead at top?** The clobber races (C1-C6); `deriveCurrentRelease` unable to clear
   after a no-UII promotion or soft-error tick (H7); a disposition that 400s or throws (H5, H9); a
   last-lead overlay that never clears; a phantom-accepted lead (H4).
4. **What makes a call happen but not count?** `completePrevious` auto-advance (H2/H3); dial-and-die
   within one poll (H8); disposition transport failure before the terminal write (H9); the idemKey
   collision recording the wrong outcome (H6); the empty-200 false `did_not_connect` (H1).
5. **What to watch in the first two hours?** Logs are currently insufficient (a frozen session is
   silent — add a per-session heartbeat first). Watch: terminal-outbox dispatch count vs Sean's actual
   call count (gap = uncounted); `did_not_connect` rate (spike = false-release H1); outbox
   `duplicate`/fail-open reasons (H6 + double-count); the front-end `queueAdvanceBlocking` overlay
   (H5); RingCX 429/400 counts; and `session.trace.accountActiveCallWatcher` (matchStatus / currentUii
   / transitionKind per tick).

---

## The fix that unblocks the pilot

**One architectural change kills all 6 criticals + the refill-twice hazard: single-writer + a version
guard.**

1. **Make the account watcher the only writer of the session doc; make `/watch` read-only** (return
   state, never `persist`). This is the author's "universal matching direction," enforced.
2. **Add optimistic concurrency to `updateBulkLoadSession`** — match on `version`/`updatedAt`, bump on
   write, skip-or-retry on mismatch — as the backstop so no stale writer can ever clobber.
3. **Make `withSessionMutation` a real per-session async mutex** (a queue, not a presence Set) covering
   the writer path; cross-process safety needs a DB-level lock if the control plane ever scales.

Cheap pre-pilot partials worth folding into the same patch:
- **2-consecutive-miss debounce** before release (H1, single-sample medium).
- **Persist a terminal on `completePrevious`** in both watcher paths (H2/H3).
- **Clear the overlay on disposition error + last-lead** (H5 + stuck-loading medium).
- **Guard Set-appointment behind `!bulkRunning`** (legacy-rail leak).
- **Let a real disposition override a watcher's `did_not_connect`** rather than the idemKey silently
  dropping it (H6).
- **Add a per-session heartbeat log** before the pilot (matchStatus / bound uii / ticks-unchanged).

Build order: do the **single-writer + version guard** first (resolves C1-C6 + the refill race); then
the counting-correctness partials (H1/H2/H3/H6/H8); then the front-end overlay + isolation partials
(H5, Set-appointment); then the heartbeat log. Each is independently verifiable and default-safe.
