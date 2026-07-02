# CX Stale-Serving Shell — Diagnostic Detector (Bruce) — Notes (2026-06-29)

First deliverable for [CX_STALE_SERVING_EDGE_CASE_BRUCE_2026-06-29.md](CX_STALE_SERVING_EDGE_CASE_BRUCE_2026-06-29.md):
a **diagnostic-only, default-off, read-only** detector for the stale-serving-shell class. Per the
operator's choice it OBSERVES only (no mutation yet) and, for each proven shell, reports the outcome
the cleaner *would* assert (a selected disposition if one is on the row, else `did_not_connect`).

## Root cause (verified against live code)

A bulk **serving** row = `state:"serving"` + `metadata.servingAt` + `wrapUpRequired:true` +
`lastDialExecutionUii` + `rcxAccountId` + `reservationSessionId`. Three facts combine into the loop:

1. **The claim reaper is structurally blind to serving rows.** `buildExpiredClaimRequeueQuery`
   targets only `state:"claimed"` and excludes any row with `metadata.servingAt` or
   `reservationSessionId` set (`cxDialQueueRepository.js`). A serving shell carries all three.
2. **The watcher's `current.released` never de-serves the queue row.** When RingCX drops the call,
   `cxAccountActiveCallWatcherService` clears the *session's* `state.current` and (if there's UII
   proof) writes one terminal **outbox** row — but it issues **no `CxDialQueue` CAS**. The only clean
   exit from `serving` is a terminal-outbox row that the control-plane drain replays into
   `handleCxTerminalCallOutcome → completeCxQueueItem`.
3. So if RingCX ends the call but **no terminal outbox row is written** (no real UII proof, or the
   session forgot/never wrote it), the shell persists. The **only** thing that frees it today is the
   legacy `requeueStaleServingQueueItems` (`RC_CX_STALE_SERVING_MINUTES`≈8 min) stacked on the
   5-min cadence tick → the ~8.5 min Bruce loop. It requeues to `ready` (no durable terminal fact)
   and gates only on agent-state heuristics (no RingCX dequeue proof, no replacement-UII check).

## What was built (default-off, ZERO mutation)

- **`packages/shared-services/src/cxStaleServingReconcilerService.js`** — a pure classifier
  (`classifyStaleServingRow` + `resolveServingIdentity` + `resolveSelectedDisposition` +
  `collectStoredUiis`/`collectStoredExternIds`) and a read-only sweep
  (`createCxStaleServingReconcilerService().runStaleServingDiagnosticOnce`). It scans serving rows,
  reads a fresh **per-account** RingCX snapshot, checks the terminal outbox (reusing the `#12`
  `buildTerminalEvidenceKeys` superset), classifies, **logs** each candidate + the action it *would*
  take, and returns a structured report. It imports no mutation primitive and calls none.
- **`scripts/cx-stale-serving-diagnostic.js`** — an on-demand runner (Mongo + RingCX, read-only) that
  prints the report. **Zero change to any live process** — operator/cron runnable.
- Barrel export; 21 tests; full `cx-bulk-load` suite **270 pass / 0 fail**.

## The predicate (the doc's guardrail), fail-closed

A row is a `stale-shell` candidate only when **all** hold:
- **previously-matched identity present** (any non-synthetic stored UII *or* externId);
- **gone proof** — NONE of the row's stored UIIs *or* externIds appear in a **confirmed-good**
  snapshot, matched **externId-first** exactly how the live watcher matches;
- **no terminal outbox row** (`buildTerminalEvidenceKeys → findByIdemKeys` empty);
- **no replacement call for the agent** (else it's `agent-advanced`, observe-only — see below);
- **agent not active** (when the activity guard is wired).

Everything short → a `skip` with an explicit reason. **Fail-closed everywhere:** a failed/empty
RingCX read (`snapshot-read-failed`), an evidence-check error (`evidence-check-failed`), a missing
account (`no-account-id`), or a live owning session (`owning-session-live`) → skip, **never** "assume
gone". `snapshotOk=true` is only reachable from a genuine `{activeCalls:[...]}` body (the RingCX
client throws on non-2xx and on malformed/empty-shaped responses).

**Confidence + actionable** (so the future act-mode can't over-reach):
- An **idle** shape proven only by an **empty** account snapshot (a campaign-pause / lull risk) →
  `confidence:"low-empty-snapshot"`, `actionable:false`. A non-empty snapshot or a `dequeueTime`
  corroboration → `high` / actionable.
- The **agent-advanced** shape (a different call is live for the agent now) is surfaced but
  `actionable:false` — an act path must not terminalize the old row while the agent is on a new one.

## Adversarial review → fixes (run `w2dn7ql7z`, 17 agents)

The review confirmed the module is **genuinely read-only and fail-closed**, and caught real
correctness defects that are now fixed:

- **BLOCKER (fixed):** the detector resolved the RingCX account from `metadata.lastDialExecutionAccountId`
  — a **legacy non-bulk** field the bulk serving stamps never write — so it would have skipped 100%
  of real bulk rows as `snapshot-read-failed` (a false all-clear), masked by a bad test fixture. Now
  resolves the canonical chain **`rcxAccountId` (top-level column) → `metadata.rcxAccountId` → …**,
  with a distinct `no-account-id` skip and an injected `resolveAccountId` (session-join) fallback.
- **HIGH/MEDIUM (fixed):** `still-active` keyed on a single resolved UII against a snapshot UII set
  built only from `raw.uii` — narrower than the codebase's extractors and the externId-first live
  matcher, so a still-live call surfacing under a `callId`/externId would be misread as gone. Now
  matches the **full stored UII family + externId** against both the snapshot UII set **and** an
  externId set.
- **MEDIUM (fixed):** an empty snapshot read as "every UII gone" during a pause → now
  `low-empty-snapshot` / non-actionable (with `dequeueTime` corroboration restoring high).
- **MEDIUM (fixed):** the runner can't wire the live agent-active guard (`evaluateServingQueueActivity`
  is not exported) → the report now states `agentActivityGuard:"disabled"` and the count is labeled
  an **upper bound**; the optional seam remains for act-mode.
- **LOW (fixed):** `agent-advanced` is now explicitly `actionable:false` / `observe-only`.

## How to run

```
node scripts/cx-stale-serving-diagnostic.js                 # 6-min cutoff, 500 rows, human report
node scripts/cx-stale-serving-diagnostic.js --stale-minutes=4 --json
```
Reads `MONGO_URI` (+ `PARALLEL_DB_NAME`) and the RingCX voice-client env. Read-only; safe to run
against production. Structured logs: `cx_stale_serving_diagnostic.{candidate,summary,...}`.

## Path to act-mode (NOT built — explicit preconditions)

When the diagnostic confirms the shape's frequency and you want to enable auto-clean, the same pure
classifier backs it — but only after: (1) **wire the agent-active guard**
(`evaluateServingQueueActivity` + agent-state) so a mid-wrap agent is never terminalized; (2) require
a **second confirming read** (or `dequeueTime` corroboration) before acting on an idle shape — never
a single snapshot; (3) act **only** on `actionable===true` (`idle-stale-shell`, high confidence) —
never `agent-advanced` without a separate gate; (4) keep cleanup **separate from advancement**
(release the shell + write the narrow outcome once via the single-writer outbox; wait for RingCX
proof of the next UII before rendering the next call). The action itself: write the proposed outcome
once (selected disposition if found, else `did_not_connect`) via `makeOutcomeIdemKey`/`insertOnce`,
then a `serving`-capable guarded CAS (`completeCxQueueItem` or a `serving`→`ready` transition matched
on `reservationSessionId`) — the legacy `requeueStaleServingQueueItems` is the existing belt for
everything the proven-shape cleaner declines.

---

## Handoff — for the second reviewer (Codex)

**State:** diagnostic-only, default-off, zero mutation. Built + self-reviewed by a 17-agent
adversarial pass (run `w2dn7ql7z`) that confirmed read-only + fail-closed and caught one **blocker**
(wrong account field) + five correctness gaps, all now fixed. 21 tests; `cx-bulk-load` suite **270
pass / 0 fail**. Nothing committed. The pure classifier is fully unit-tested; the Mongo/RingCX seam
is integration-deferred per the rail's policy (no local Mongo here).

**Files to review:**
- `packages/shared-services/src/cxStaleServingReconcilerService.js` (the detector + sweep)
- `scripts/cx-stale-serving-diagnostic.js` (the read-only runner)
- `tests/cx-bulk-load/cxStaleServingReconciler.test.js`

**Please confirm (the items a second set of eyes / live data adds the most value on):**
1. **Field grounding against live data.** I switched the account read to top-level `rcxAccountId`
   after the review found `lastDialExecutionAccountId` is legacy-only. Confirm a real stuck **bulk**
   serving row actually carries `rcxAccountId` (or `metadata.rcxAccountId`), and that
   `metadata.lastRingcxActiveCall.agentId` equals the `agentId` the active-call snapshot reports for
   the same agent (replacement-UII detection depends on that alignment). This is the load-bearing
   assumption and is best verified against prod data, which I can't reach from here.
2. **Run it against prod (read-only).** `node scripts/cx-stale-serving-diagnostic.js --json`. The
   real signal is the skip-reason distribution: a healthy result should NOT be dominated by
   `no-account-id` or `snapshot-read-failed` (those would mean account resolution is still off). Watch
   `byShape` / `byConfidence` and `actionableCandidateCount` vs `candidateCount`.
3. **The selected-disposition probe.** For Q2 ("match the selected disposition, else did_not_connect")
   I read `lastHangupRequestDisposition` → `lastDisposition` → `disposition`. Bruce's case had none, so
   confirm which field (if any) actually holds an agent's selected-but-uncommitted disposition on a
   stuck bulk serving row — or whether that always resolves to `did_not_connect` in practice.
4. **The empty-snapshot stance.** A single account snapshot that comes back empty marks the idle shape
   `low-confidence`/non-actionable rather than skipping it. Is that the right call for the diagnostic,
   or should an empty account snapshot skip entirely? (For act-mode the 2nd-confirming-read is required
   regardless.)

**Open decisions for whoever builds act-mode** (deliberately not built): the four preconditions in
"Path to act-mode" above — wire the agent-active guard (`evaluateServingQueueActivity` is currently
not exported), require a second confirming read, act only on `actionable` idle shells, keep cleanup
separate from advancement. The classifier already emits `actionable`/`confidence` so the act layer can
gate on them without re-deriving the predicate.

---

## Codex Review - Suggested Action Path

Short version: keep this diagnostic-only for one more pass, but make the diagnostic harder to fool
before trusting its counts. The shape is real and the guardrails are right; the remaining risk is a
false quiet report, not an over-active cleaner.

### Review Findings

1. **Live-owned rows should be observed, not skipped.**
   - Current runner passes active bulk session ids into the diagnostic.
   - The service then skips rows whose `metadata.reservationSessionId` is still live.
   - That is safe for mutation, but too quiet for diagnosis: a bulk stale-serving shell can still
     belong to a running session.
   - Suggested change: classify these as `live-owned-observe-only`, `actionable:false`, with their own
     bucket. Do not mutate them, but make them visible.

2. **Scan oldest serving shells first.**
   - The diagnostic calls `listQueueItems({ states:["serving"], limit })`.
   - That uses the generic queue sort, so a low limit can miss the oldest/most important serving rows.
   - Suggested change: add or use an explicit sort like `{ "metadata.servingAt": 1, _id: 1 }` for this
     diagnostic scan.

3. **Share the active-call normalizer with the live watcher.**
   - The script currently uses the same watcher loader, which is good.
   - The service itself indexes only `uii`, `externId`, and `agentId` from whatever calls it receives.
   - Suggested change: import/reuse `normalizeActiveCall` from `cxBulkLoadActiveCallWatcher.js` inside
     the diagnostic's account index. That prevents future callers from accidentally passing raw RingCX
     aliases and producing false "gone" results.

4. **Read dequeue corroboration from both possible serving stamps.**
   - The current diagnostic reads `metadata.lastRingcxMonitorActiveCall.raw.dequeueTime`.
   - Bulk serving stamps `metadata.lastRingcxActiveCall`.
   - Dequeue is not load-bearing, but it raises confidence, so read both places if present.

### Proposed Action Path

#### Step 1 - Tighten diagnostic, still read-only

Patch `packages/shared-services/src/cxStaleServingReconcilerService.js` only unless a repository sort
helper is needed:

- Replace the hard live-session skip with an observe-only classification path.
- Use watcher-normalized active calls in `buildAccountIndex(...)`.
- Include `metadata.lastRingcxActiveCall.raw.dequeueTime` as a fallback corroboration source.
- Add report counters for:
  - `live-owned-observe-only`
  - `oldestServingAt`
  - `newestServingAt`
  - `accountlessServingRows`

Patch repository/script only if needed:

- Either pass explicit sort through `listQueueItems(...)`, or add a narrow helper such as
  `listStaleServingQueueItems({ limit, sort })`.
- Keep the script read-only and keep the output explicit that active-session findings are
  non-actionable evidence.

#### Step 2 - Run read-only on live and judge the shape

Run:

```powershell
node scripts/cx-stale-serving-diagnostic.js --json
```

Healthy evidence looks like:

- low `no-account-id`
- low `snapshot-read-failed`
- clear distinction between:
  - idle stale shells
  - live-owned observe-only shells
  - agent-advanced observe-only shells
  - already-terminalized rows

Do not build act-mode if the report is dominated by account-resolution or snapshot-read failures.

#### Step 3 - Only then build act-mode, narrow and separated

Act-mode should be a separate function, not a flag that mutates inside the diagnostic path.

Minimum action predicate:

```txt
serving row is old enough
+ real prior UII or externId exists
+ two successful RingCX reads agree it is gone
+ no replacement active call for that agent
+ no terminal outbox row exists
+ agent activity guard says not active / not wrapping / not mid-appointment
```

Action should do exactly two things, in order:

1. Insert one terminal outbox row using the same idempotency path as bulk terminal outcomes.
   - selected disposition if safely found,
   - otherwise `did_not_connect`.
2. Clear the serving shell with a guarded queue-row CAS matched on:
   - queue item id,
   - `state:"serving"`,
   - `metadata.reservationSessionId`,
   - current stored UII/externId when available.

Do not advance the UI from this action. The normal watcher should still be responsible for displaying
the next current call only after RingCX proves the next UII/externId.

### Suggested Decision

Make the next patch a diagnostic-hardening patch, not a cleaner. Once the hardened diagnostic has run
against live for at least one real dialing window, use its counts to decide whether this deserves an
auto-cleaner or remains a manual/rare recovery script.
