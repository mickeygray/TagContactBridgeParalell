# Patch work order — Jira bridge, TAG yellows, three-pass standardization

Date: 2026-08-06
Status: OPEN. Sections run in dependency order, not theme order.

```
⟳ BUILD STATUS — read this first after any compaction or re-entry
────────────────────────────────────────────────────────────────────
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

**E7. Reconciliation trio into the pass, DARK *(large)***
Three new tasks in this order BEFORE night-persist: session-reconcile,
payment-reconcile, payment-fields-sync (ordering contract:
caseProfilePaymentSyncService.js:494+ — fields sync AFTER ledger reconcile).
Each wraps the same service call Phase A makes today (hourlySweeperService
:1037-1060), each behind its own default-off flag
(`NIGHTLY_SESSION_RECONCILE_ENABLED` etc.), each with count().
Widen `maxCasesPerDomain` for payment-reconcile — 250/domain was sized for
14 passes/night; nightly needs the 10,000 cap nightlyCloseService used
(:267). Phase A copies stay until X1 deletes Phase A whole — they are dead
code on this branch already (runScheduledPhase=false), so no double-run risk
BEFORE deploy; the X1 commit is where they physically go.
**TEST:** registry order test (three keys before night-persist); per-task:
injected service fake, plan/count/apply contract; payment-fields-sync task
asserts it is ordered after payment-reconcile *(the :494 contract as a
failable check)*.

**E8. Call log hygiene, EVENING half *(medium)*** — new task, DARK:
`sinceMs` = ms since 12:00 PT today (compute from persistTargetDay's zone
helpers; DEFAULT_SINCE_MS at hourlyCallLogHygieneService.js:917 stays
untouched for other callers). Include nativeSweep. The MIDDAY half is MD2;
the hourly trigger (Phase A `callLogHygiene`) is deleted by X1. Overlap with
MD2's window is deliberate — upsertCallLog dedupes on sessionId (:1057).
**TEST:** task passes its sinceMs through (injected service spy); window
helper unit-tested against a fixed clock (12:00 PT boundary, DST-safe via
the Intl pattern already in the sweeper :1123-1128).

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

**E10. cxRecordingHourly** — gate on D10 (`cx.call.placed` still emitted?).
If dead: delete worker + task in one commit. If alive: fold as a dark
evening task, delete `startCxRecordingWorker` in the same commit.

**E11. Arm E7-E10 one at a time**, each after its own observed dark cycle.
Never the group.

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
