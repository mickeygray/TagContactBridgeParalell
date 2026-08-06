# Patch work order — Jira bridge, TAG yellows, three-pass standardization

Date: 2026-08-06
Status: OPEN. Sections run in dependency order, not theme order.

```
⟳ BUILD STATUS — read this first after any compaction or re-entry
────────────────────────────────────────────────────────────────────
2026-08-06 (10): E11 - RUNBOOK WRITTEN, NOTHING ARMED, and it
cannot be: the code has never shipped, so there has been no dark cycle
to observe, and three hard blockers survive. Arming is also a live
action on a host this box does not govern. See
.ai/context/EVENING_PASS_ARMING_RUNBOOK_2026-08-06.md for the order
(payment-reconcile is the only stage ready), what to watch, the stop
conditions, and what "resolved" means for each blocker.
Next action: E12 (the side-by-side - the point of the patch).

2026-08-06 (9): E10 IS DONE - cx recording worker DELETED, service
KEPT for the admin route and backfill scripts. 754 pass.
CORRECTION TO (7) AND (8): I wrote that cx.call.placed had NEVER
been emitted. It has - 33,105 times, newest 2026-07-08. My probe read
a missing FIELD (happenedAt is unset on all of them) as a missing
RECORD. D10 was also the wrong gate: cx.call.placed is not this
service's input. The delete verdict stands on the right evidence -
CallLog platform:"cx" newest row is 2026-07-16 and the worker's
trailing window holds 0.
The Phase A entry was NOT dead: POST /api/hygiene/hourly-sweep/run
defaults scheduledPhase TRUE and the flag fell to its `= true`
default, so an admin ran the RingCX pull today. Third surviving
trigger this patch has found.
SEPARATE LIVE OUTAGE, found while proving the deletion safe: the EOD
recording archive has archived NOTHING since 2026-08-03T14:13Z. It is
armed and DEADLOCKED - its idle gate waits on 27 permanently-stale
processing rows, polls 12h, then throws. See the E10 entry.
Next action: E11 (arm one at a time) or E12/E13.

2026-08-06 (8): E8 IS DONE - call-log-hygiene-evening landed dark
before call-recording-index, with a DST-safe pacificMsSinceToday. 17
tests, 754 pass. The window turned out to BE the step: PhoneBurner
rows are created ~5.4h after callStartTime, so the 65-minute default
could never see the only live feed (0 rows in 65 min vs 947 in 24h).
Three of four inputs are dead; CallLog platform ex stopped
2026-08-03T14:04Z, the same hour attribution-reconcile last ran -
consistent with Phase A stopping on the live host, not two provider
faults. Five arming blockers in the E8 entry; the critical one is that
MD2 MUST NOT SHIP until replay is safe (an overlapping window can
rewrite a resolved CallLog row to pending-retry with a null source).
Next action: E10 (cxRecordingHourly).

2026-08-06 (7): E7 IS DONE — the reconciliation trio landed dark
between activity-review and call-recording-index (NOT before
night-persist; the produce/consume edge the order assumed does not
exist). 24 tests, 737 pass. Five scope corrections and three ARMING
BLOCKERS are recorded in the E7 entry — read them before setting any
of the three flags.
TWO FINDINGS BIGGER THAN THE STEP ITSELF:
  * THE RC TELEPHONY-SESSION FEED IS DEAD since 2026-06-30. The
    ringcentral-cx app is alive and still writing family:cx rows, but
    its telephony-session writer stopped 37 days ago; the reconciler
    returned scanned=0 on every run until it too stopped 2026-08-03.
    Someone must decide: fix the writer, or retire the service.
  * cx.call.placed looked never-emitted — WRONG, see (9). It has
    33,105 records; my probe misread an unset field.
Next action: E8 (call log hygiene, evening half).

2026-08-06 (6): E9 IS DONE — NCOA folded into the nightly mailbox
visit; both old hourly triggers deleted. 7 new tests, 727 pass.
Next action: E7 (reconciliation trio into the evening, dark).
Two corrections from doing E9, both recorded in the E9 entry: there
were TWO old NCOA triggers (server.js AND hourlySweeperService:1248,
the second ungated inside the dark scheduledPhase block), and the
mailbox task's arming had to widen to EITHER flag or the fold would
have silently disarmed NCOA on any host running the invoice reader
dark.

2026-08-06 (5): SAVE-THEN-SEND landed (842b581) — reportDefinition
takes an onComposed hook, the runtime writes the day's record from the
same gather the mail is built from, then stamps emailAcceptedAt only
if the provider took it. B3 + E2 landed with it (c36f15f).

2026-08-06 (4): B2 IS DONE — commit 6ef75d7, hygiene suite 28/28.
"Land dark, observe one cycle, arm" now actually produces evidence, so
E3/E7-E10 and every new pass task can follow it. Next action: B3
(queue-rollup, needs decision D2 first — every monthly report is
[DEGRADED] until then). One correction from doing B2: I claimed the
dark branch's bare-Error cursor throw was a live bug; it was not.
Probed it — the abort already happened, one indirection later, via the
retry path's own failing durable write. Changed to cursorLost() for
directness, not as a fix.

2026-08-06 (3): B1 IS DONE — commit 9730cfa, 9 tests, awaiting the
first post-deploy cycle for VERIFY-LIVE. Next action: B2 (the plan()
fix in nightlyHygieneRuntime). One correction from doing B1:
summarizeHourlySweepResult never read the four floor keys, so the
planned step-3 summarize edit was a no-op and was skipped.

2026-08-06 (2): EXECUTION DETAIL ADDED. Every near-term step now
carries PATCH / TEST / VERIFY blocks with file:line anchors verified
against code (not docs) on this date. Branch: jira/hourly-migration,
six commits, NOT pushed. Next action: §2 B1.

NOTHING in this order has started except §1 "Already in the tree"
(committed on this branch). Do not re-derive the audit — it is
recorded here with evidence.

THE TWO FACTS THAT REORDER EVERYTHING:
1. Live runs cx-round-2. cleaned-metrics (which this branch extends)
   is 69 commits ahead, a STRICT ANCESTOR relationship, and 60 of
   those commits exist only on this box. Nothing here ever shipped.
2. server.js:690 hardcodes `const runScheduledPhase = false`, killing
   the hourly sweeper's whole Phase A — including four floor services
   never meant to stop: dncRecheck, fillerPoolRefresh,
   agedRollingRefresh, callrailStatSync. (NCOA survives: the server
   runs it OUTSIDE Phase A via its own guarded slot at ~:826.)
   Deploying without §2 B1 stops DNC rechecking. Fix first.
────────────────────────────────────────────────────────────────────
```

## The target, in Mickey's words (2026-08-06)

> "the goal is turn off hourly and do three processes
> 1) set up the morning and run lead cadence for the day
> 2) recalibrate at noon and run a second cadence blast
> 3) close up and release financial info
> ... close up will be the heaviest process eventually cause it will do all the
> call log stuff, all the financial stuff etc as the worker that builds the data
> structure that feeds the email. but it can also do things like post ncoa ...
> so the idea is the app becomes a lot lighter and a lot more focused."

Refinements settled in conversation:

- **Cadence splits by CHANNEL, not 50/50.** "all the texts and emails at 8 and
  all the rvms at noon kinda thing." Due items already carry `channel`
  (counterCadenceService.js:230-243) — this is a filter, not a count-and-halve.
- **Call log hygiene splits across midday and evening.** "call log hygiene
  could be the thing thats split between 1 and 7." The service takes `sinceMs`
  (hourlyCallLogHygieneService.js:917) and upserts on sessionId (:1057), so two
  overlapping lookbacks dedupe themselves.
- **First-touch stays real-time.** Only the follow-up cadence batches.
- **NCOA goes nightly.** "no application on your business for 2-3 days max."
- **Metrics email goal:** ONE duplicate nightly definition rendered from the
  stored DailyReportFact day beside the live-composed one until they agree.
  "making the mongo record creation process consistent while keeping the
  processes independent."
- **1pm may carry a partial-day stats email** per Matt — content unknown (D3).

## Standing invariants (do not violate while working this order)

1. **Two-step handover is ONE change.** Fold-in and old-trigger retirement in
   the same commit, always.
2. **Nothing arms itself.** Land dark behind a default-off flag, observe one
   cycle via plan() output, arm as a separate change.
3. **The night services and PhoneBurner keep churning.** Everything else may
   be wonky mid-construction (Mickey 2026-08-04); those two may not.
4. **Unknown ≠ zero.** A source that could not be read reports UNKNOWN.
5. **Writers never stamp placeholders into slots they don't own** (settled in
   code: flattenFactUpdate, dailyReportFactService.js).

---

## §0. HOW TO PATCH AND TEST IN THIS REPO (applies to every step)

**Editing:**
- `node --check <file>` after every edit, before anything else.
- Smallest diff that fixes the step. No adjacent refactors, no reformatting.
  Every line that isn't the step can break something for no reason.
- Comments are claims, not facts — B1 exists because a comment said the floor
  services were "independent of lite mode" while the code gated them off.
- LF/CRLF warnings from git on this box are noise. `.orig` files: never
  commit, never delete.

**Testing:**
- Run suites INDIVIDUALLY: `node --test tests/metrics/<file>.test.js`.
  NEVER the whole runner. NEVER `tests/lead-delivery/leadDeliveryRuntime.test.js`
  (hangs the runner — standing rule).
- The hygiene suite's pattern is the house pattern: build with
  `createNightlyHygieneRuntime({})`, inspect `getState()`, use its
  `taskByKey()` helper; run-loop behaviour is driven with
  `{ config: { enabled: true, hour: 0 } }` (tests/metrics/
  nightlyHygieneRuntime.test.js:56, :191). Extend that file in that style.
- Every behavioural claim in a PATCH block below must gain a test that FAILS
  on the old code. Write the test, watch it fail, apply the patch, watch it
  pass. A test that never failed proves nothing.

**Runtime verification:**
- Scripts: run from repo root, `DNS_SERVERS=8.8.8.8` set, dotenv resolves
  from the root. Probe scripts live in scripts/analysis/.
- This box runs live ops: NEVER start/restart services, never run dev servers
  for this. In-process verification = probe scripts + getState() + Mongo
  reads. Mongo is the SHARED Atlas cluster: name every write before making it.
- The hourly/nightly workers are NOT running from this working copy (live is
  cx-round-2). Steps marked **VERIFY-LIVE** cannot be proven on this box —
  they are proven by the first cycle after deploy, from the named log lines.
  Say so in the commit message rather than claiming verification.

**Committing:** one step = one commit; a two-step handover is ONE commit.
Narrative message + `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
No pushing until Mickey says push.

---

## §1. Already in the tree — committed on jira/hourly-migration

- `4773a05` CR-5 recovery drift (28 files; also carries JiraTaskLink model +
  shared-models barrel, noted in message)
- `dd1b67d` daily-record fixes: dotted `facts.<key>` writes, pending-calls
  placeholder guard, registry-driven gatherersFromContext (all 7 sections)
- `239f444` Jira bridge: listener, ledger, verified user map, 25 tests
- `771336b` NCOA handler + guarded hourly NCOA slot + /api/jira mount
- `4239f05` this work order; `9bc264d` analysis evidence + 414-task ledger

---

## §2. Hard blockers — before any pass work

### B1. Restore the four floor services — ✅ DONE (9730cfa)

Landed as specified, with two deviations worth recording:
- Step 3 (summarize reads) was a NO-OP: `summarizeHourlySweepResult`
  never read the four keys. Verified by grepping its whole body before
  skipping it. Smaller diff than planned.
- Skip reasons for the three flag-gated entries changed from
  "business-hours-lite" to "floor-service-disabled" — the old string
  named a mode these no longer participate in and would have misled
  whoever next read a summary.
Nine tests in tests/metrics/hourlyFloor.test.js, including the exact
flag shape server.js sends and a both-directions no-double-call check.
VERIFY-LIVE still outstanding (see below).



**Cause (verified):** server.js:810-822 passes `dncRecheckEnabled: true`,
`fillerPoolRefreshEnabled: true`, `agedRollingRefreshEnabled: true` into
`runHourlySweep` — but all four floor entries are consumed inside
`if (scheduledPhase) {` (hourlySweeperService.js:1035, closes ~:1232), and
server.js:690 hardcodes `runScheduledPhase = false`. The flags are passed and
never read. The block comment "independent of lite mode" is true of LITE mode
and false of `scheduledPhase`.

**PATCH — packages/shared-services/src/hourlySweeperService.js:**
1. Extract a new exported async function near the bottom of the file:
   ```js
   async function runFloorServices({
     dncRecheckEnabled, fillerPoolRefreshEnabled, agedRollingRefreshEnabled,
     logger,
     impls = null,   // test injection; null = the real lazy requires below
   } = {}) { ... }
   ```
   Move these four entries into it VERBATIM, including each `.catch()`
   wrapper (one failure must not take the tick):
   - `callrailStatSync` — the whole env-gated IIFE at :1116-1132
     (`CALLRAIL_STAT_SYNC_ENABLED` gate stays inside it, unchanged)
   - `dncRecheck` — :1184-1188 (`dncRecheckEnabled ? runDncRecheckSweepIfEnabled() ...`)
   - `fillerPoolRefresh` — :1212-1216
   - `agedRollingRefresh` — :1223-1227
   Return `{ callrailStatSync, dncRecheck, fillerPoolRefresh, agedRollingRefresh }`.
   `impls` lets tests inject `{ runDncRecheckSweepIfEnabled, ... }`; default
   resolves the same module functions the entries use today.
2. In `runHourlySweep`, AFTER the `if (scheduledPhase) { ... }` close and
   BEFORE `summary.phaseB = await drainHourlyJobQueue(...)` (:1234), add:
   ```js
   // FLOOR SERVICES — always run, independent of the retired Phase A.
   // Each keeps its own internal gate (env flag, monthly/06:00-PT window,
   // pool freshness), so an every-tick call cannot over-run them. B1 of
   // PATCH_WORK_ORDER_2026-08-06: these died when scheduledPhase went
   // hardcoded-false, and DNC recheck must never be deploy-gated again.
   summary.floor = await runFloorServices({
     dncRecheckEnabled, fillerPoolRefreshEnabled, agedRollingRefreshEnabled, logger,
   });
   ```
   Leave the Phase A copies REMOVED (moved, not duplicated). `calllogBridge`,
   `resolutionEmails` and the reconciliation entries stay in Phase A — they
   are the things being deliberately retired into passes later.
3. `summarizeHourlySweepResult` (:104+) reads `result.phaseA?.<key>` for
   summaries. Grep it for the four moved keys and change each read to
   `result.floor?.<key> ?? result.phaseA?.<key>` (old stored results keep
   summarizing).
4. Export `runFloorServices` from the module and the shared-services barrel.
5. Do NOT touch server.js:690 and do NOT re-enable `runScheduledPhase`.

**TEST — new file tests/metrics/hourlyFloor.test.js:**
- `runFloorServices` with injected impls and all three flags true → all four
  impls called once; result carries all four keys. *(fails pre-patch: fn
  doesn't exist)*
- One injected impl rejects → its key carries `{ error }`, the other three
  still ran. *(the .catch isolation, as a failable check)*
- `dncRecheckEnabled: false` → dncRecheck is the skipped shape and its impl
  was NOT called; callrailStatSync with env unset → skipped shape.
- `runHourlySweep({ scheduledPhase: false, ...all flags false })` →
  `summary.phaseA === null` AND `summary.floor` exists with four keys.
  (All-flags-false keeps the test off the network; phaseB drains against the
  suite's existing fakes — mirror how tests/ncoaHourlyScheduling.test.js
  stubs the queue, or pass `handlerKeys: []`.)

**VERIFY-LIVE:** first tick after deploy logs the floor keys in the sweep
summary; `dnc.checkedAt` advancing on MasterProspectIndex within a week is
the ground-truth probe (scripts/analysis re-use: tag-filler-admission-audit).

**COMMIT:** "Floor services run on every tick, independent of the retired
Phase A" — note in the message that Phase A remains dark deliberately.

### B2. Restore the standing dry-run — ✅ DONE (6ef75d7)

Landed as specified. Notes for whoever reads a dark cycle next:
- Dark rows now carry `reason: "standing-dry-run"` (was
  "write-disabled-no-discovery"), their real `planned` count, and their
  describe() summary. No external consumer read the old string —
  grepped apps/ packages/ scripts/ tests/ before changing it.
- A dark task whose plan() THROWS is now a visible task failure rather
  than a silent skip. Intended: a task that cannot look should surface
  before it is armed. It also means a broken dark task now consumes the
  bounded-retry budget, which it did not before.
- Cost is live from the next cycle: eleven plan() calls nightly
  regardless of arming, of which mail-invoice opens a mailbox and
  call-recovery-discovery consumes a gather.
- Five tests, four of which failed on the old code.



**Cause (verified):** nightlyHygieneRuntime.js:1125-1140 — when
`!armed && !force` the loop pushes `{ skipped: true, reason:
"write-disabled-no-discovery", planned: 0 }`, advances the durable cursor and
`continue`s WITHOUT calling `task.plan()`. The contract at :366-372 promises
the opposite: "plan() — read-only; always safe, always run."

**PATCH — apps/control-plane/src/services/nightlyHygieneRuntime.js:**
Restructure the loop body at :1125-1150 so plan() precedes the arm check:
```js
const armed = apply === null ? task.writesArmed() : Boolean(apply);
const planned = await task.plan({ domains: state.domains, days: state.days, logger: log });
const plannedCount = typeof task.count === "function"
  ? Number(task.count(planned)) || 0
  : planned.reduce((acc, p) => acc + (p.plan?.length || 0), 0);
state.totals.planned += plannedCount;

if (!armed && !force) {
  results.push({
    task: task.key, label: task.label,
    dryRun: true, planned: plannedCount,
    summary: typeof task.describe === "function" ? task.describe(planned) : null,
    reason: "standing-dry-run",
    durationMs: Date.now() - taskStarted,
  });
  // cursor advance exactly as the current skip branch does
  ...advanceNightlyHygiene(...); continue;
}
```
Keep `if (armed && plannedCount)` as the apply gate, unchanged. A plan() that
throws flows into the existing bounded-retry catch — that is correct: a task
whose read side is broken should be visible, not silently skipped.

**TEST — extend tests/metrics/nightlyHygieneRuntime.test.js:**
- Find the existing assertion on reason `"write-disabled-no-discovery"` and
  REPLACE it: unarmed task run → its result row has `dryRun: true`,
  `planned` equal to the fake plan's count, reason `"standing-dry-run"`.
  *(fails pre-patch: planned is 0 and plan() uncalled)*
- Unarmed task: `plan` called exactly once, `apply` never called (spy fakes,
  same style as the :191 throw-isolation test).
- Armed task with plannedCount 0: apply still not called (regression guard
  for the count() trap).
- state.totals.planned includes unarmed tasks' counts.

**Cost note (accepted, it is the point):** mail-invoice plan() opens the
mailbox and call-recovery-discovery consumes a full gather, nightly, even
dark. Eleven plan() calls fit inside HYGIENE_CLAIM_LEASE_MS = 45 min (:46).

### B3. queue-rollup — execute decision D2 *(small either way)*

Verified state: `LEGACY_QUEUE_ROLLUP_WRITES_ENABLED = false` (:45) is ANDed
into writesArmed (:815-816) so `QUEUE_ROLLUP_ENABLED` is inert, while
reportComposerService.js fail()s any >7-day range without complete stored
coverage (:787 partial, :790 none). Every monthly report is [DEGRADED] now.

- **Variant (a) re-arm:** delete the const at :45; writesArmed becomes the
  env flag alone. TEST: `taskByKey(s,"queue-rollup").writesArmed` true with
  env set, false without.
- **Variant (b) — DEFAULT — demote the reader:** at :787 and :790 change
  `fail(` to `advise(` (amber advisory channel already exists; see
  nightly-report-failure-vs-advisory doctrine). Keep the notes verbatim.
  TEST: compose a >7-day range against a fake readQueueRange returning
  partial coverage → `report.failures` empty, advisories carry
  "queue counts INCOMPLETE". *(fails pre-patch: it lands in failures)*

---

## §3. Workstream A — the three passes

### A-EVENING (nightlyHygieneRuntime, 19:50; email at 20:00)

Registry today, in order (:429-:962): night-persist, mail-invoice,
mail-spend-derive, call-links, call-recovery-discovery,
call-recovery-eligibility-hygiene, queue-rollup, logics-source, spend-sync,
activity-review, call-recording-index.

**E1** = B2 above.

**E2. Fix the activity-review return read *(small)***
**Cause (verified):** apply() at :934-944 reads
`Number(r?.written || r?.reviewed || 0)` but `runActivityReview` returns the
raw service result whose real shape (logicsActivityReviewRuntime.js:295-306)
is `processed.parsedRows / processed.outputRows / processed.suspendedOutputRows
/ processed.aiReview.reviewedCases / processed.suspendedAiReview.reviewedCases`.
A successful review reports written: 0 forever.
**PATCH** — map the real keys:
```js
const p = r?.processed || {};
return {
  written: Number(p.outputRows || 0) + Number(p.suspendedOutputRows || 0),
  reviewed: Number(p.aiReview?.reviewedCases || 0) + Number(p.suspendedAiReview?.reviewedCases || 0),
  rows: Number(p.parsedRows || 0),
  skipped: 0,
  failed: r ? 0 : 1,
};
```
**TEST** (hygiene suite): inject a fake activityReviewRuntime returning
`{ processed: { parsedRows: 5, outputRows: 3, suspendedOutputRows: 1,
aiReview: { reviewedCases: 2 } } }` → applied.written === 4, rows === 5.
*(fails pre-patch: written === 0)*

**E3. Register the daily-entry worker, DARK *(medium)***
**PATCH:**
1. Barrel: export `dailyEntryService` from packages/shared-services/src/index.js
   (it is absent — verified; only jiraTaskBridgeService was added there).
2. New task appended AFTER call-recording-index (:962 block) — position 12 —
   key `"daily-entry"`, label `"Daily entry (one object, one post)"`,
   `writesArmed: () => String(process.env.DAILY_ENTRY_ENABLED || "false") === "true"`.
3. **Self-contained gather, by design** ("keeping the processes independent"):
   plan() composes its OWN one-day report exactly the way
   dailySnapshotService's compose fallback does (same runDefinition call,
   selection `def.blocks?.length ? def.blocks : ["daily"]`), collects
   `callFacts` from `gatherRecordingLinks({ dateKey, apply: false }).callFacts`
   (callRecordingIndexService.js:437), then
   `buildDailyEntry({ dateKey: persistTargetDay(), apply: false,
   gatherers: gatherersFromContext({ report, callFacts, activitySection: null }) })`.
   activitySection stays null until E6 lands, and that is HONEST — null
   renders as unread, not empty (invariant 4).
4. `count(planned)` = `planned[0].sectionsGathered.length` — **a task without
   count() never applies** (plannedCount 0; the spend-sync lesson, recorded
   at the activity-review task comment :925). apply() re-runs with
   `apply: true`, `overwrite: []`.
**TEST:**
- hygiene suite: `taskByKey(s, "daily-entry")` exists, is 12th, writesArmed
  false by default, HAS a count function *(the count-trap regression)*.
- dailyEntry.test.js already covers the worker (16 tests) — no new worker
  tests needed here.
**Cost note:** this duplicates the 20:00 email's gather during the
side-by-side period. Accepted deliberately; E12's parity report is what ends
it.

**E4. Observe one dark cycle** — read getState(): every task shows a real
plannedCount or an honest skip reason. This is the first night B2 makes that
possible. No commit; record findings in this file's status block.

**E5. Handover: spend-sync *(small, ONE commit)***
Arm `NIGHTLY_SPEND_SYNC_ENABLED=true` (env; operator does the live half) AND
delete `await spendSyncRuntime.start();` — server.js:3118. KEEP the
construction at :2380 (startHourlySweepWorker receives spendSyncRuntime,
:664 — the object is injected elsewhere; only its self-timer dies).
**TEST:** none runnable here beyond `node --check`. **VERIFY-LIVE:** next
night, spend-sync applied>0 in hygiene state AND the standalone runtime's
lastRun stops advancing.

**E6. Handover: activity-review *(small, ONE commit)*** — same pattern:
`NIGHTLY_ACTIVITY_REVIEW_ENABLED=true` AND delete server.js:3113. Keep
construction :2367 (the hygiene task receives it as
`activityReviewRuntime` — verified in apply()'s deps). Requires E2 landed and
D6 answered (the 20:00 notice email dies with the standalone runtime).

**E7. Reconciliation trio into the pass, DARK *(large)*** — **DONE**, 24 tests.
Landed as three tasks behind three independent default-off flags
(`NIGHTLY_SESSION_RECONCILE_ENABLED`, `NIGHTLY_PAYMENT_RECONCILE_ENABLED`,
`NIGHTLY_PAYMENT_FIELDS_SYNC_ENABLED`). Five things in the original scope were
wrong and are corrected below; three defects survive that this task cannot fix
and they are **hard arming blockers**.

**Corrections to the scope as written**

1. **NOT before night-persist.** The stated reason (payment-reconcile produces
   the rows night-persist stamps) does not hold: night-persist runs
   runNightPass → runMoneyLoop → `pullCaseBilling`, a LIVE Logics pull
   (paymentTruthService:265), so it never reads a PaymentLedger row this pass
   wrote. With no produce/consume edge, the trio sits between activity-review
   and call-recording-index — which keeps night-persist's irreplaceable write
   first, keeps the recording index on a corrected day, keeps the two long
   serial Logics loops out of the front of the pass, and shifts only ONE
   existing task index. *The cursor is positional: deploy between nights.*
2. **The ordering citation was wrong.** caseProfilePaymentSyncService:494 is
   just the function signature. The contract is in the file header at :9-11,
   and its stated downstream (metricsRefresh) is retired
   (hourlySweeperService:1190). The reason the order actually matters was never
   named: BOTH services stamp `paymentReconcile.lastCheckedAt` and reconcile
   SELECTS on it (caseProfileRepository:852). Now pinned by a test.
3. **Cap is 500/domain, NOT 10,000.** The 10,000 at nightlyCloseService:267 is
   dead code (`:259` short-circuits to "retired-from-nightly-close") and the
   loop is serial and unpaced at ~2 Logics GETs per case against a 45-minute
   claim lease. Measured: TAG 93,076 profiles, WYNN 20,229, and only 1.3% of
   TAG carries a ledger row so most cases take the 2-request 404 path. Each cap
   is also now its OWN env var — Phase A fed one `maxCasesPerDomain` to both
   services, so widening the reconciler silently widened the fields sync too.
4. **`staleCheckMs` goes UP to 30d, not down to 20h.** Shrinking it below the
   run interval makes the candidate query's stale clause match every profile in
   the domain (measured 93,076/93,076 TAG), and the service slices an UNSORTED
   union to the cap — the same head-500 ids forever. The nightly pass now
   targets CHANGE (ledger row or CaseProfile touched in 26h), not audit.
5. **The retry lane had no claimer.** payment-reconcile's service emits
   `handlerKey: "reconcileCasePayments"` on the `hourly` lane. That lane IS
   drained every 60s outside the dead gate — but through
   `BUSINESS_HOURS_LITE_HOURLY_HANDLER_KEYS`, which did not list that handler,
   so the jobs would sit `pending` forever and never dead-letter either
   (markHourlyJobFailed only dead-letters a CLAIMED attempt). Key added to the
   whitelist in the same commit, per the two-step-handover rule.

**⚠ ARMING BLOCKERS — do not set these flags until each is resolved**

- **payment-fields-sync (BLOCKER, critical).** The service stamps
  `paymentReconcile.lastCheckedAt` on every case it touches *including the
  no-drift path, which makes no Logics call at all* (:397/:438). Since
  payment-reconcile selects on that field oldest-first, a fields-sync pass
  stamps "Logics has been asked" onto cases Logics was never asked about and
  pushes them to the back of a 93k-deep wheel. The 30d staleCheck shrinks the
  blast radius but does not close it: the `lastCheckedAt: null` clause still
  matches every never-stamped profile, so the first armed nights are degenerate
  regardless. **Fix needs an ordered cursor in the service, and fields-sync must
  stop writing reconcile's checkpoint.** Arm payment-reconcile first and alone.
- **session-reconcile (BLOCKER, medium).** `fetchCallRecordWithRetry` is called
  with `maxRetries: 1`, which makes the 429 back-off branch unreachable
  (`attempt < maxRetries` is never true — ringcentralAttributionService:319).
  The first 429 therefore throws AND opens a **process-wide** circuit in the
  shared RC client, which would fail every later task in the same pass, not just
  this one. Give it a real back-off before arming.
- **session-reconcile has no input anyway (see below).**

**⚠ THE RC SESSION FEED IS DEAD — a finding bigger than E7**

Probed 2026-08-06 against the shared cluster:
- Newest `family:ringcentral` / `telephony-session` workflow record: **2026-06-30**.
  The whole `family:ringcentral` namespace stopped that day.
- `ringcentral.attribution.resolved` events since 2026-06-30: **0** (581 ever).
- The reconciler ran hourly × 3 domains until 2026-08-03 14:00Z and returned
  `scanned=0` on **every run for 37 days**.
- The writer is the **ringcentral-cx** app (ringcentralExService), which is
  **alive** — it wrote `family:cx` cadence-queue rows the same day. So this is a
  dead feed inside a live service, not a stopped service.
- No RC-sourced CallLog rows in 7 days (all 10,300 carry `source: null`).
- `cx.call.placed`: **CORRECTED (see E10)** — 33,105 records exist, newest
  2026-07-08. The probe that said "never" read an unset `happenedAt` field as a
  missing record. D10 was also the wrong gate for E10.

So session-reconcile has nothing to reconcile. It is built anyway, but its
`plan()` counts the FEED rather than calling the service, and `describe()` says
`THE SESSION FEED IS DEAD — nothing written since 2026-06-30` instead of
rendering 0. Wrapping it naively would have reported "attribution is clean"
every night forever. **Someone needs to decide whether that writer gets fixed or
the service gets retired.**

**Also fixed during review** (all found by adversarial pass, all now tested):
a `String(date).slice(0,10)` in the dead-feed banner that rendered "Tue Jun 30",
dropping the year off the one line whose job is to show staleness — and the test
that passed vacuously because it fed an ISO string where `plan()` emits a Date;
a partial-failure hole where ONE domain's failed feed count rendered as
"no unattributed sessions" or as a confident dead-feed verdict; `skipped`
conflating "asked, empty" with "never asked"; a lock-busy sweep of every domain
reporting as a clean zero; and no signal when payment-reconcile's cap bound the
night.

**TEST:** 24 in tests/metrics/nightlyReconciliationTrio.test.js, plus the
registry-order assertion in nightlyHygieneRuntime.test.js. 737 pass across the
metrics suite; the three server.js-loading suites pass. The claimer test was
verified failing with the whitelist entry removed.
**VERIFY-LIVE (open):** one dark cycle — confirm the three dry-run rows appear
with sane summaries and that session-reconcile prints the DEAD banner.

**E8. Call log hygiene, EVENING half *(medium)*** - **DONE**, 17 tests.
Task `call-log-hygiene-evening` behind `NIGHTLY_CALL_LOG_HYGIENE_ENABLED`,
placed before call-recording-index. New DST-safe helper `pacificMsSinceToday`.

**THE WINDOW IS THE SUBSTANCE, not a scheduling detail.** The service filters on
`callStartTime` with a 65-minute default, and the only feed still producing -
PhoneBurner, ~2,245 rows/day - is projected off a CLOSED DailyDial date, so its
rows are created an average of **5.4h** after the call started (min 0.7h, tail
32.9h). A 65-minute `callStartTime` window can therefore *never* see them.
Measured 2026-08-06: outbound preview finds **0 rows in 65 minutes, 947 in 24
hours**. Widening to a half-day is what makes the live feed visible at all.

**Three of the four inputs are dead** (probed 2026-08-06):

| input | newest | note |
|---|---|---|
| `rb_contactactivities` | 2026-05-04 | legacy ringBridge writer gone; also OFF by env, so the mirror to ledger-sync to promotion to case-refresh to metrics-date chain is a **structural no-op** |
| CallLog platform cx | 2026-07-17 | 20 days |
| CallLog platform ex | **2026-08-03T14:04Z** | self-inflicted - ex rows are written BY this service's own native sweep |
| CallLog platform phoneburner | today | the only live feed, 2,245/day |

That ex date is the **same hour** attribution-reconcile last ran (2026-08-03
14:00Z, see E7). Both are Phase A jobs, which is consistent with the live host
having stopped running Phase A entirely at that point - not with two independent
provider faults. Arming this task is what restarts the native sweep.

**Scope corrections**

1. **`DEFAULT_SINCE_MS` is at :45, not :917** (:918 is the use-site), and it is
   module-private with every real caller passing `sinceMs` explicitly - so
   "stays untouched for other callers" is true but nearly vacuous.
2. **The cited Intl pattern at hourlySweeperService:1123-1128 does not exist** -
   those lines are the payment-reconcile argument block. The right primitive was
   already in this file: `pacificHourMinute` (:250). `pacificMsSinceToday` is
   built on it.
3. **`plan()` must not call the service.** It has no dryRun of any kind, and its
   read path upserts CallLog, syncs the ledger, promotes case profiles, queues
   archives and bills Whisper and Claude. plan() runs nightly armed or not, so a
   dark task would write to five providers every night and an armed one would
   pay the whole burst twice. plan() counts the window instead.
4. **A wider window is NOT wider coverage.** callLogRepository:386 clamps the
   preview query to 500 rows **newest-first**, and that clamp is not raisable
   from the task. Measured WYNN outbound afternoons: 1,015 rows/day average,
   1,521 max - so ~515/day are never previewed, and because of the sort the
   dropped rows are the OLDEST, i.e. exactly the ones nearest the midday seam.
   The task now reports the remainder rather than letting it vanish.
5. **`now` is passed explicitly.** Left unset the service derives it inside its
   per-domain body, so domain N's window starts N domains' runtime later than
   domain 0's - and a wall-clock-anchored sinceMs has none of the 5 minutes of
   slack the 65-minute default carried against an hourly cadence.
6. **`totals.ledgerSynced` does not exist.** The service accumulates it per
   domain and never rolls it up, which is why Phase A's summarizer has always
   printed `ledgerSynced: 0`. The task sums it from the per-domain summaries.

**ARMING BLOCKERS**

- **MD2 MUST NOT SHIP UNTIL REPLAY IS SAFE (critical).** The order's premise
  that overlap is harmless because "upsertCallLog dedupes on sessionId" is
  wrong twice over: the dedupe key is compound `{domain, telephonySessionId}`,
  and that line only runs inside the legacy-mirror loop, which is empty. Real
  replay defects: (a) `emitMissingSourceAlert` passes a `dedupeKey` into
  `createReviewQueueItem`, but ReviewQueueItem has **no dedupeKey field and no
  unique index**, so mongoose strict mode silently drops it and every replay
  inserts another "Missing source attribution" row - which the deep-cut and
  frontend reads count; (b) `persistCallLog` `$set`s strategy/confidence/status
  every pass and the prior-CallLog lookup does not exclude the row's own record,
  so a call stamped `callrail` at midday returns as `prior-calllog` in the
  evening, and **a pass that fails to match rewrites a resolved row to
  `status: "pending-retry"` with a null sourceCanonicalId**. E8 alone has no
  overlap partner, so this is latent - MD2 is where it bites.
- **The preview lane's output is DISCARDED (high).** `operationsBySession` is
  read in exactly one place: inside the empty legacy-mirror loop. Both preview
  calls still pay full external cost - up to 500 rows x 3 candidate domains of
  serial CallRail GETs plus up to 3 serial Logics `findCaseByPhone` per
  unmatched row, and 100% of measured WYNN afternoon rows fall through. Decide
  whether to wire it to patch CallLog directly or stop calling it, before
  arming. `limitPerDomain` is deliberately left at 200: raising it buys cost,
  not coverage.
- **Wall clock vs the 45-minute lease (high).** Nothing wraps `task.plan()` or
  `task.apply()` in a timeout, and the lease is only consulted at claim time. A
  full pass at measured volumes is plausibly 10-50 min. Exceeding the lease
  makes `advanceNightlyHygiene` stop matching, throws `cursorLost()` and
  **abandons every remaining task for the night**; an ordinary failure re-runs
  the same task from the top up to `MAX_TASK_ATTEMPTS`, i.e. three full bursts.
- **CallRail ignores the window entirely (medium).** The lookup passes
  `dateRange: "this_month"`, so on the 1st its window is hours and on the 31st a
  month. A caller-supplied window is a lie for that sub-job.
- **X1 does not remove every trigger.** Two live admin routes call this service:
  `POST /api/hygiene/hourly-call-log/run`, and `POST /hygiene/hourly-sweep/run`
  whose `scheduledPhase` **defaults TRUE**. X1 removes the worker, not the
  routes - the same class of surviving second trigger E9 found.

**TEST:** 17 in tests/metrics/callLogHygieneEvening.test.js, incl. both DST
transitions. Both are at 02:00 local, so a NOON anchor never straddles one and
the helper is exact on both days - an earlier anchor would not be, and the tests
pin that so moving the anchor cannot silently break it. 754 pass.
**VERIFY-LIVE (open):** one dark cycle - the dry-run row should show a ~8h
window and a non-zero call count, which is itself the proof that the widened
window sees PhoneBurner where 65 minutes did not.

**E9. NCOA handover *(small, ONE commit)*** — **DONE**, 7 tests.
Shipped as scoped, plus three things the scope missed:

1. **There were TWO old triggers, not one.** server.js had its hour slot;
   `hourlySweeperService.js:1248` ALSO called `runNcoaMailboxIngestIfDue`,
   ungated, inside the `if (scheduledPhase)` block. Dark today (Phase A is
   off) but it would have become a second owner the moment anyone re-armed
   Phase A. Deleted, not gated.
2. **Arming had to widen or the fold would have disarmed NCOA.** The task
   armed on `MAIL_INVOICE_MAILBOX_ENABLED` alone; NCOA answered to
   `NCOA_MAILBOX_ENABLED`. On any host with the invoice reader dark, folding
   would have silently stopped NCOA. `writesArmed` now returns true for
   EITHER flag — arming decides whether the mailbox is opened; each handler
   is still included per its own flag (`buildMailboxHandlers`).
3. **`summarizeHourlySweepResult` kept an `ncoaMailbox` key** that would
   now be `null` on every tick forever — which reads as "ran, found nothing"
   rather than "not this job's any more". Key removed.

`buildMailboxHandlers({ncoaEnabled, targetDate})` was extracted and exported
so handler selection is testable without a Gmail client.
**TEST:** 5 in nightlyHygieneRuntime.test.js (all 5 verified failing on the
pre-fold code), 2 in hourlyFloor.test.js. 727 pass across metrics +
ncoaMailboxIngestService + the two server.js-loading suites.
**VERIFY-LIVE (open):** nightly mailbox_ingest log shows handler=ncoa
listed>0; hourly worker log stops showing ncoaMailbox.

**E10. cxRecordingHourly** - **DONE** (deleted). Worker + Phase A entry gone,
service KEPT.

**THE STATED GATE (D10) WAS THE WRONG QUESTION, AND MY ANSWER TO IT WAS WRONG.**
D10 asks "is `cx.call.placed` still emitted?" Two errors:

1. `cx.call.placed` is not this service's input at all. `runCxRecordingHourly`
   reads `CallLog {platform:"cx", callEndTime in [t-75m, t-15m], durationSec >=
   min, recordingArchive.status not terminal}`. `cx.call.placed` is
   cxCallActivityBackfill's input.
2. I recorded "never emitted" in two earlier status blocks. **It is emitted
   33,105 times.** My probe read `newest[0]?.happenedAt` and printed "(never)"
   when that came back undefined - and `happenedAt` is set on **zero** of those
   33,105 records, so I reported a missing FIELD as a missing RECORD. Newest by
   `createdAt` is 2026-07-08T22:58:45Z: dormant, not never. Exactly the
   unknown-vs-zero trap this order polices, committed by its own probe.

**The right evidence, and it still says DELETE.** CallLog `platform:"cx"`:
62,971 rows, newest `callStartTime` **2026-07-16T00:05:36Z**, newest
`createdAt` 2026-07-17. Rows in the worker's 60-minute trailing window right
now: **0**. Every tick since mid-July has taken the `no-eligible-calllog-rows`
early return without ever calling RingCX.

**What was deleted** (one commit): `startCxRecordingWorker` (~96 lines) and its
call site; the hardcoded `legacyHourlyRecordingOwnerEnabled = false` and its
else-branch; `cxRecordingState` and its health-payload line, close handler,
`waitForCxRecordingIdle`, and `registerCleanup`; the `runCxRecordingHourly`
import; the Phase A `cxRecordingHourly` entry and its `cxRecordingHourlyEnabled`
param and the server.js arg feeding it.

**What was KEPT, deliberately:** `cxRecordingHourlyService.js` entire.
`POST /api/metrics/cx-recording/run` and `GET /cx-recording/preview-window` are
the only way to re-pull a specific RingCX hour, and both backfill scripts call
the service. What went is the clock, not the capability. Also kept:
`RINGCX_RECORDING_HOURLY_MINUTE` (read directly by
scripts/backfill-cx-wem-recordings.js, not via the config key).

**THE PHASE A ENTRY WAS NOT DEAD CODE.** Third time this patch has found a
surviving trigger the plan did not know about.
`POST /api/hygiene/hourly-sweep/run` defaults `scheduledPhase` **TRUE** and
never passes `cxRecordingHourlyEnabled`, so the param fell to its `= true`
default - an admin hitting that route ran the RingCX pull today. Deleting the
entry and the param together is what closes it.

**The old reason string was false.** `retired-duplicate-owner` claimed the EOD
recording archive superseded this. It does not: that runtime's sources are
legacy contact-activity docs + RingCentral `getAccountCallLog` + CallRail. It
never queries `platform:"cx"` and never calls RingCX. It was a successor only in
the sense that the lane it replaced is empty. The commit records the honest
reason instead.

**FOUND WHILE PROVING THE DELETION SAFE - A LIVE OUTAGE, NOT PART OF E10**

The EOD recording archive - the *actual* scheduled owner for the lanes that
still have traffic (`ex`, CallRail) - **has archived nothing since
2026-08-03T14:13:02Z**. Run summaries in `ops/end-of-day-recordings/` stop at
dateKey 2026-07-29. Upload counts collapse: 90d 3,430 / 30d 946 / 7d 30 / 3d
**0**.

Named cause: `waitForRecordingPipelineIdle` (added 2026-08-03) requires
`transcriptionProcessing === 0 && archiveProcessing === 0 && jobProcessing ===
0` before archiving. Live counts are **11 / 7 / 9**, and all are permanently
stale - archive-processing newest `updatedAt` 2026-07-09, transcription-
processing newest 2026-05-05. With `RECORDING_PIPELINE_IDLE_WAIT_ENABLED=true`
and a 12h max wait, every run polls for 12 hours and then throws.
`runArchiveEodRecordings` is never reached. **It is armed and deadlocked.**

Two follow-ups, both independent of this step: clear the 27 stale `processing`
rows (or make the idle gate ignore rows older than N hours), and confirm which
host actually runs `eodRecordingArchiveRuntime`.

**THE 2026-08-03 CLUSTER.** Three independent things last ran within 13 minutes
of each other that afternoon: attribution-reconcile 14:00Z (E7), CallLog
`platform:"ex"` last write 14:04Z (E8), EOD archive last upload 14:13Z. A fourth
writer - the PhoneBurner projection - is still going (2026-08-06T04:32Z). That
pattern is consistent with one process stopping that afternoon while another
kept running. **Not diagnosed, and deliberately not asserted as a cause** - the
standing rule is never to call something down without checking newest writes per
model, and the per-model check is what produced this list, not a conclusion from
it.

**TEST:** the boundary test flipped from pinning the hard gate to pinning the
absence, matched against CODE not prose (the tombstone comment names the deleted
function on purpose). 754 metrics tests pass; the four server.js-loading suites
pass; the kept service, metrics route, server and sweeper all still load.

**E11. Arm E7-E10 one at a time** - **RUNBOOK WRITTEN, NOTHING ARMED.**
See `.ai/context/EVENING_PASS_ARMING_RUNBOOK_2026-08-06.md`.

E11 cannot execute today and the reason is structural, not a judgement call:

1. **There has been no dark cycle to observe, because the code has never
   shipped.** This branch extends cleaned-metrics, which has never been
   deployed. E11's own precondition is unmet.
2. **Three hard blockers survive** the E7/E8 reviews. Two of them corrupt data
   or stall the night when armed, and neither is fixable from the task - both
   need a change inside the underlying service.
3. **Arming is a live action on client money records and external API spend,
   on a host this box does not govern.** Setting a flag in this working copy
   proves nothing: NCOA ran in production on a day this box had
   `NCOA_MAILBOX_ENABLED=false`. Which host runs nightlyHygieneRuntime is still
   unverified.

All four new flags are UNSET here and stay that way. The runbook carries: the
prerequisites (deploy BETWEEN nights - the cursor is a positional index and
E7/E8 both inserted mid-array), how to read the dark pass per task, the arming
ORDER with the reasoning, what to watch and what should stop you, the rollback,
and each blocker with a concrete definition of "resolved".

Order, shortest form - **one per night, never two**:

| stage | flag | state |
|---|---|---|
| 1 | `NIGHTLY_PAYMENT_RECONCILE_ENABLED` | **ready** - bounded, no open blocker, retry handler has a claimer |
| 2 | `NIGHTLY_CALL_LOG_HYGIENE_ENABLED` | blocked on the wall-clock question (B) - highest value, most likely to blow the 45-min lease |
| 3 | `NIGHTLY_SESSION_RECONCILE_ENABLED` | pointless until the cx telephony-session writer is fixed; unsafe until the 429 back-off is reachable (C) |
| 4 | `NIGHTLY_PAYMENT_FIELDS_SYNC_ENABLED` | **hard blocked** (A) - it stamps reconcile's checkpoint on cases it never pulled |

The single most informative line in the first dark pass is
`call-log-hygiene-evening`'s summary. Its call count is a live measurement, and
a NON-ZERO count is the proof that the widened window sees PhoneBurner where 65
minutes saw nothing. If it reads `0 call(s)`, E8's premise did not hold on the
live host and Stage 2 should not proceed.

**E12. The side-by-side *(large — the point of the patch)***
1. New packages/shared-services/src/dailyRecordRenderService.js:
   `renderReportFromRecord({ dateKey })` reads the stored day
   (readEntryRange detail view + the record's own coverage) and returns an
   object SHAPED IDENTICALLY to what runDefinition's compose returns for the
   nightly email — same sections array, same block ids — so the existing
   email template renders it unchanged. A section null in the record renders
   as UNKNOWN (invariant 4), never as zero.
2. reportScheduleRuntime: when a definition carries `renderSource:"record"`,
   call the renderer instead of composing. One flag on ONE definition.
3. Point the stray `financial` definition (blocks=["rollup"], fires 20:00
   daily — currently a pure duplicate) at `renderSource:"record"` via a
   one-shot script scripts/analysis/point-definition-at-record.js (named
   Mongo write: ReportDefinition.updateOne on that name only).
4. scripts/analysis/compare-nightly-emails.js: diff the two sends' numbers
   per section per day; write a parity line into this file's status block.
5. After 7 agreeing days: disable BOTH stray definitions
   (`financial`, `vendor` — schedule.enabled=false, named write). The
   two-email duplication Mickey noticed ends here, deliberately.
**TEST:** renderer unit tests — a fixture day renders every section; a day
with facts.calls null renders UNKNOWN not 0; the renderer never touches the
network (assert no client construction). Schedule-runtime test: definition
with renderSource:"record" routes to the renderer (injected fake).

**E13** = decision D7 (coverage.complete owner; default compute-on-read).

**Timing:** 19:50→20:00 is ten minutes. When E7/E8 arm, track cycle duration
from getState; if a cycle overruns, move the pass to 19:30 — never the email
later.

### A-MORNING (net-new runtime, DARK behind MORNING_PASS_ENABLED)

**M1. Scaffold *(large)*** — new
apps/control-plane/src/services/morningPassRuntime.js cloned from
nightlyHygieneRuntime's structure: durable per-day claim on DailyLoopRun
(own loopKey "morning-pass"), isPacificBusinessDay guard (weekend behaviour
per D11), ordered task registry with writesArmed/plan/count/apply/describe,
bounded attempts (copy MAX_TASK_ATTEMPTS + per-day pruning), cursor
advance, getState(). Constructed + started in server.js beside
nightlyHygieneRuntime (:2394/:3117 pattern). B2's plan()-always-runs
semantics from day one.
**TEST:** clone the hygiene suite's skeleton for the new runtime: claim
idempotence (second run same day is a no-op), task isolation (throw doesn't
cost the night), unarmed = standing dry-run, guard released on every early
return (:63 test's pattern).

**M2. Clock *(small)*** — MORNING_PASS_HOUR default 8 (D5). LOOSEN the two
internal hour gates so the pass owns "once daily": fillerPoolRefreshService
:861-872 `day === "01" && hour === "05"` → keep the day-01 check, drop the
hour equality (the pass claim already gives once-per-day); same for the
aged 06:00-PT gate. These are behaviour changes — name them in the commit.
**TEST:** gate fns unit-tested: day-01 at hour 8 now qualifies; day-02
still refuses.

**M3. Handover: floor services *(medium, ONE commit)*** — register the four
as morning tasks (each wrapping the same fns runFloorServices uses, each
default-off) AND delete the B1 hoist from hourlySweeperService in the same
commit. TEST: morning registry has the four; hourlyFloor.test.js updated to
assert `summary.floor` is GONE *(the reverse of B1's test — proves the
handover, not a duplicate)*.

**M4. Cadence, morning channels *(small-medium, ONE commit)***
1. counterCadenceService: add `channels = null` to
   selectCounterCadenceDueItems (:528) and runCounterCadenceSweep; thread to
   the evaluators: skip any push whose `channel` is filtered —
   the age-relative push at :269 (channel "sms") and the daily push at :290.
   `channels: null` = today's behaviour exactly.
2. Morning task calls `runCounterCadenceSweep({ channels: ["sms","email"],
   includeAgeRelative: false, maxDispatches: <explicit>, sourceService:
   "morning-pass" })`.
3. SAME COMMIT: outbound-gateway/src/server.js:317-322 adds
   `includeDaily: false` to the 5s worker's call — it keeps ONLY real-time
   first-touch + age-relative. The manual route :585 is left untouched.
**TEST:** new tests/cadence/counterCadenceChannels.test.js — fixture leads
due on all three chains: channels ["sms","email"] excludes every rvm item;
channels null = unfiltered *(fails pre-patch: option unknown)*;
includeDaily:false still yields the age-relative sms-2 item (M5's guarantee);
per-day caps consulted identically under a channel filter.

**M5. Age-relative SMS-2 stays real-time *(test-only)* ** — verified:
:259-272 evaluates BEFORE the daily gate, so the gateway worker with
includeDaily:false keeps firing it. M4's test pins it; no further patch.

**M6** = decision D8 (caller-ID rotation).

### A-MIDDAY (net-new runtime, DARK behind MIDDAY_PASS_ENABLED, ~12:00)

**MD1.** Scaffold = M1's, own loopKey "midday-pass". *(medium)*
**MD2.** Call log hygiene MIDDAY half: sinceMs = ms since 20:00 PT
yesterday (pairs with E8; same helper, different anchor). *(small)*
**MD3.** Cadence: `runCounterCadenceSweep({ channels: ["rvm"],
forceDaily: true, includeAgeRelative: false })` — forceDaily permits the
second same-day batch past lastDailyBatchKey. TEST: second-batch-same-day
fixture sends rvm only, once. *(small)*
**MD4.** 1pm stats: BLOCKED on D3. Default build: task running the E3
gatherers with apply:false and alerting (advise channel) when any source
cannot answer — early warning, no partial-day record, no merge seam.
*(medium)*
**MD5.** Arm morning first, then midday, each after a dark cycle.

### A-CROSS

**X1. Retire the hourly sweeper *(large, LAST, ONE commit)*** — after E11 +
MD5 fully armed: delete startHourlySweepWorker (server.js:664+) and Phase A
inside runHourlySweep entirely; new ~40-line startRetryDrainWorker on a 60s
timer calling ONLY `drainHourlyJobQueue({ handlerKeys:
BUSINESS_HOURS_LITE_HOURLY_HANDLER_KEYS, batchCap: 10 })` (keys const
:341-353 survives). Assumption D4 (confirmed default): retries keep a short
clock. The RC subscription watchdog (ringcentral-cx) is untouched — it owns
its own timer; the drain's renewRingcentralSubscription handler is only its
retry fallback.
**TEST:** drain worker unit (injected queue fake, 60s tick, cap respected);
grep-test that no caller of runHourlySweep passes scheduledPhase anymore.

**X2** = D11 weekend, explicit per-pass. **X3** deletions (confirmed-dead
list unchanged from the audit; execute each as its own small commit after
its gate: startCxTerminalOutboxWorker; the `if (false)` spend block
:836-860 AFTER E5; metricsRefresh tombstone; cxTerminalRectification;
runHourlyLeadCadenceEnforcement; Sean pilot + cxCallActivityBackfill +
scheduled-actions engine after their D-questions).

---

## §4. Workstream B — Jira bridge (arming; code is done)

- **J1** committed (`239f444`).
- **J2** Mickey rules the 22 `run ths`/FILE POA tickets. Then re-run
  scripts/analysis/build-final.js + post-migration.js (ledger skips the 414).
- **J3** Confirm Jacqueline WYNN 43 / AMITY 165 in the back office → flip
  `verified` in jiraLogicsUserMap.js → releases 28 held tasks.
- **J4** Arm: JIRA_WEBHOOK_SECRET + JIRA_TASK_BRIDGE_ENABLED=true (env),
  Jira webhook (issue created/updated) → /api/jira/webhook, field
  descriptions onto the ASSIGNMENT create screen (UI-only, team-managed).
  Watch GET /api/jira/links for a week DARK first — the route records every
  decision without writing while the flag is off. That week IS the test.
- **J5** Delete ASSIGNMENT-2048 (probe); decide 2049's sprint.

## §5. Workstream C — TAG yellows (unchanged; gated on B1)

Y1 diagnose the stuck dnc-lookup-pending-retry (4,579 of 4,586) → Y2 scrub
(volume go-ahead first — RealPhoneValidation spend) → Y3 admission source on
the callRecovery pattern into tier 4 (leadDeliveryService.js:1500) → Y4
dry-run per-agent counts, cap day one → Y5 confirm DNC recheck running
(B1's VERIFY-LIVE) before any old record dials.

---

## §6. Decisions owed by Mickey

| # | Decision | Default if silent |
|---|---|---|
| D1 | Ship the 69 commits, or cherry-pick B1 onto cx-round-2 first? | Cherry-pick B1; keep building here |
| D2 | queue-rollup: re-arm capture or demote the reader's fail()? | Demote to advise; DailyReportFact is queue truth |
| D3 | Matt's 1pm stats — which numbers? | Health-check only until answered |
| D4 | Retry drain keeps a 60s clock after hourly dies? | Yes (X1 assumes it) |
| D5 | Morning pass clock (gates loosened per M2) | 08:00 PT |
| D6 | Anyone read the activity-review 20:00 notice email? | Drop it when E6 arms |
| D7 | coverage.complete owner | Compute on read |
| D8 | Caller-ID rotation: fold to 2x/day or keep 2h timer? | Keep its own timer (ANI reputation) |
| D9 | Metrics workspace (route+panels already deleted on branch) | Ship the deletion |
| D10 | Is cx.call.placed still emitted? (Mongo query) | Decides E10 delete-vs-fold |
| D11 | Weekend: floor services yes / cadence no? | Exactly that, explicit per pass |
| D12 | LeadCadence rows with pending schedule.actions? (Mongo query) | Decides the legacy engine + staleCadenceSweep |

## §7. Sequence at a glance

```
0  commit+push(held) ─► B1 floor fix ─► B2 plan() fix ─► B3/D2 queue-rollup
                                          │
        ┌─────────────────────────────────┤
        ▼                                 ▼
   E1-E4 evening dark            M1-M2 morning scaffold
        ▼                                 ▼
   E5-E11 handovers, arm 1-by-1  M3-M5 fold floor+cadence (dark)
        ▼                                 ▼
   E12 side-by-side email        MD1-MD4 midday (dark)
        ▼                                 ▼
   E13/D7 coverage               MD5 arm morning ► arm midday
        └────────────┬────────────────────┘
                     ▼
        X1 delete hourly Phase A, keep 60s retry drain
                     ▼
        X2-X3 weekend + deletions
   (J and Y workstreams run parallel to all of the above)
```
