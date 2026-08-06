# Patch work order — Jira bridge, TAG yellows, three-pass standardization

Date: 2026-08-06
Status: OPEN. Sections run in dependency order, not theme order.

```
⟳ BUILD STATUS — read this first after any compaction or re-entry
────────────────────────────────────────────────────────────────────
NOTHING in this order has started except the items in §1 "Already in
the tree", which are DONE but UNCOMMITTED. Step 0 (commit) is the
next action. Do not re-derive the audit findings — they are recorded
here with file:line evidence and were verified against code, not docs.

THE TWO FACTS THAT REORDER EVERYTHING:
1. Live runs cx-round-2. cleaned-metrics is 69 commits ahead, a
   STRICT ANCESTOR relationship (no merge needed), and 60 of those
   commits exist only on this box. Nothing here has ever shipped.
2. cleaned-metrics hardcodes `const runScheduledPhase = false`
   (apps/control-plane/src/server.js:690), which kills the hourly
   sweeper's whole Phase A — INCLUDING four floor services that were
   never meant to stop: dncRecheck, fillerPoolRefresh,
   agedRollingRefresh, callrailStatSync. Deploying this branch as-is
   stops DNC rechecking. See §3 B1. Fix before anything ships.
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
  all the rvms at noon kinda thing." This replaces the count-and-halve
  mechanism the audit sized as a large build — the selector's due items already
  carry `channel` (counterCadenceService.js:230-243), so this is a filter.
- **Call log hygiene splits across midday and evening.** "call log hygiene
  could be the thing thats split between 1 and 7." The service takes `sinceMs`
  and upserts on sessionId (hourlyCallLogHygieneService.js:917, :1057), so two
  overlapping lookbacks are safe and dedupe themselves.
- **First-touch stays real-time** as leads arrive. Only the follow-up cadence
  batches.
- **NCOA goes nightly.** Asked directly about the delay: "its a mail list that
  has no application on your business for 2-3 days max so its fine."
- **Metrics email goal:** migrate ONE of the duplicate nightly definitions to
  render from the stored DailyReportFact day, run it beside the live-composed
  one, compare until they agree. "making the mongo record creation process
  consistent while keeping the processes independent."
- **1pm may carry a partial-day stats email** ("certain stats baked into a 1pm
  email per Matt") — content unknown, see decisions D3.

## Standing invariants (do not violate while working this order)

1. **Two-step handover is ONE change.** Folding a job into a pass and retiring
   its old trigger happen in the same commit. This repo has paid for the split
   version repeatedly — most recently the four duplicate ReportDefinitions
   firing two emails a night (the pair without "roll up with calls" was never
   disabled when its replacement armed).
2. **Nothing arms itself.** Every new pass and task lands dark behind a
   default-off flag, is observed for one cycle via plan() output, then armed as
   a separate change.
3. **The night services and PhoneBurner keep churning.** Construction anywhere
   else is fine (Mickey 2026-08-04); those two are not.
4. **Unknown ≠ zero.** A source that could not be read reports UNKNOWN, never
   an empty result. This is the codebase's most repeated failure mode.
5. **Writers never stamp placeholders into slots they don't own** — settled in
   code 2026-08-06 (flattenFactUpdate, dailyReportFactService.js). Keep it true
   for every new section.

---

## §1. Already in the tree — DONE, UNCOMMITTED (step 0 commits all of it)

**Metrics record-creation fixes (2026-08-06, tested, 69 tests green):**
- `persistDailyReportFact` writes dotted `facts.<key>` paths instead of
  replacing the whole facts subdocument (dailyReportFactService.js,
  flattenFactUpdate). Two writers can now share a day.
- The `{status:"pending"}` calls placeholder is no longer written over another
  writer's real counts — the email path leaves `facts.calls` alone unless it
  actually holds callFacts.
- `gatherersFromContext` drives the section registry's `build(ctx)` — all
  SEVEN sections gather (was a hand-copy of five that silently dropped calls
  and activity). Report-only path honestly yields null for calls/activity.

**Jira→Logics bridge (complete, dark):**
- 414 Logics tasks migrated (migration-ledger.json), verified by read-back.
- Webhook listener at /api/jira (routes/jiraWebhook.js), service
  (jiraTaskBridgeService.js), ledger model (JiraTaskLink), 25 tests. Dark
  behind JIRA_TASK_BRIDGE_ENABLED; refuses unsigned traffic.
- Verified user map packages/shared-data/src/jiraLogicsUserMap.js — 16/18 ids
  harvest-confirmed; Jacqueline's WYNN(43)/AMITY(165) unexercised.
- Template issue ASSIGNMENT-2049: `[Database] | [CaseID] | [Name]` /
  `[Logics Subject]` `---` `[Logics Note Body]`.

**NCOA handler (built, tested 9/9, NOT wired):**
- ncoaMailboxHandler.js — NCOA as a second handler on the shared mailbox loop;
  processAttachment accepts a pre-downloaded buffer; the ingest loop passes the
  Gmail client so handlers can mark-read/archive after a clean pass only.

**Step 0 — commit the above in logical chunks** (metrics fixes / jira bridge /
ncoa handler / analysis scripts), push the branch. 60 commits on this box have
never reached origin and the deploy tooling pulls from GitHub — nothing below
can ship until this happens.

---

## §2. Hard blockers — before any pass work

**B1. Floor services are dead code on this branch.** dncRecheck,
fillerPoolRefresh, agedRollingRefresh AND callrailStatSync (the CallRail
response-call feeder) all live inside `if (scheduledPhase)` at
hourlySweeperService.js:1035-1232, and server.js:690 hardcodes it false.
Hoist the four into an always-run section beside Phase B, preserving each
`.catch()` wrapper. Do NOT re-enable runScheduledPhase — that would resurrect
the reconciliation jobs this migration retires. Their internal gates (monthly
boundary, PT-hour checks, CALLRAIL_STAT_SYNC_ENABLED) prevent over-running.
*Later, step M3 moves them into the morning pass and removes this hoist — in
one change.*

**B2. The evening pass cannot be observed dark.** nightlyHygieneRuntime.js
:1125-1140 skips plan() entirely for unarmed tasks, while its own contract
(:369) says "plan() — read-only; always safe, always run". Fix: always run
plan(), record plannedCount, gate only apply() on armed. Without this,
invariant 2 is theatre — a dark task produces zero evidence and every arming
decision is blind. Watch HYGIENE_CLAIM_LEASE_MS (45 min) still covers eleven
plan() calls; mail-invoice plan() opens a mailbox and call-recovery-discovery
consumes a full gather.

**B3. queue-rollup is disarmed in code but its reader still hard-fails.**
LEGACY_QUEUE_ROLLUP_WRITES_ENABLED=false (nightlyHygieneRuntime.js:45) is
ANDed into writesArmed(), so the env flag is inert — while
reportComposerService.js:771 readQueueRange still fail()s on ranges > 7 days.
**Every monthly report goes out [DEGRADED] today.** Decision D2 picks the fix;
either way it lands before the evening pass is restructured.

**B4. Decide the deploy strategy** (D1) before building on this branch:
ship the 69, or cherry-pick B1's fix onto cx-round-2 while pass work continues
here. Note cc3807d (oldest commit in the divergence) already deleted the
metrics workspace read route and all seven panels — shipping means shipping
that too (D9).

---

## §3. Workstream A — the three passes

### A-EVENING (exists as nightlyHygieneRuntime, 19:50; the email fires 20:00)

- **E1.** B2's plan() fix. *(small)*
- **E2.** Fix activity-review's return-shape read — apply() reads
  `r?.written || r?.reviewed` but the service returns
  processed.parsedRows/outputRows/aiReview.reviewedCases; a successful review
  reports 0. (nightlyHygieneRuntime.js:934-944) *(small)*
- **E3.** Export dailyEntryService from the shared-services barrel; register
  `daily-entry` as a hygiene task, DARK behind DAILY_ENTRY_ENABLED. Needs its
  own count() (a task without one never applies — the spend-sync lesson).
  Registry order: after call-recording-index and activity-review, so
  gatherersFromContext receives callFacts and activitySection. *(medium)*
- **E4.** Observe one full dark cycle. Every task shows a real plannedCount or
  an honest skip reason in getState(). *(observe)*
- **E5.** Two-step handover, spend-sync: NIGHTLY_SPEND_SYNC_ENABLED=true AND
  remove `spendSyncRuntime.start()` (server.js:3118) in one change. *(small)*
- **E6.** Two-step handover, activity-review: arm AND remove
  `logicsActivityReviewRuntime.start()` (server.js:3113) in one change.
  Decision D6 first: does anyone read its 20:00 notice email? *(small)*
- **E7.** Move sessionReconcile → paymentReconcile → paymentFieldsSync into
  the pass as dark tasks, order preserved (the ordering contract lives at
  caseProfilePaymentSyncService.js:494+). Widen paymentReconcile's
  250-cases-per-domain cap — it was sized for hourly. *(large)*
- **E8.** Call log hygiene, EVENING HALF: register dark with
  sinceMs ≈ 8h (12:00→19:50) plus nativeSweep. The midday pass (M-D2) takes
  20:00-prev→13:00. Overlap is deliberate; upsertCallLog dedupes on sessionId.
  Retire the hourly trigger in the same change as whichever half arms LAST.
  *(medium)*
- **E9.** NCOA into the evening: add `createNcoaHandler()` to the handlers
  array in readMailInvoiceMailbox AND delete resolveHourlyNcoaSlot from the
  hourly worker — one change. Handler is built and tested. *(small)*
- **E10.** cxRecordingHourly + standalone cxRecordingWorker: fold or delete
  per D10 (does the RingCX dialer still emit cx.call.placed?). Either way the
  double-owner goes. *(medium)*
- **E11.** Arm E7-E10 one at a time, each after its own observed dark cycle.
  Never the group. *(process)*
- **E12.** THE SIDE-BY-SIDE. Build the read path that renders the nightly
  email from the stored DailyReportFact day (readEntryRange detail view feeds
  the existing template). Point ONE of the duplicate definitions (`financial`,
  blocks=rollup — the stray pair fires at 20:00 daily already) at the rendered
  path. Two emails arrive nightly: live-composed vs record-rendered. When they
  agree for a week, disable the stray pair entirely (they are duplicates
  today — see the 4-definitions finding). *(large; the point of the patch)*
- **E13.** Decision D7: who owns coverage.complete once the worker writes real
  call counts. Recommended: compute on read; neither writer stamps it.

**Timing note:** 19:50→20:00 gives ten minutes. Once E7/E8 land the pass gets
heavy; if a cycle ever overruns, move the pass start earlier (19:30) rather
than the email later. Track actual durations from cycle one.

### A-MORNING (net-new runtime, DARK behind MORNING_PASS_ENABLED)

- **M1.** Build the runtime on nightlyHygieneRuntime's shape: durable per-day
  claim (own DailyLoopRun key), business-day guard, ordered registry,
  per-task writesArmed(), plan()/apply(), bounded retry. *(large)*
- **M2.** Clock: Mickey wants ~08:00. fillerPoolRefresh's internal gate wants
  day-01 05:00 PT and aged wants 06:00 PT (fillerPoolRefreshService.js:861-872)
  — those gates become redundant once the pass itself provides the once-daily
  claim, so LOOSEN the hour gates to "any qualifying day" rather than moving
  the pass to 5am. *(small, but it is a behaviour change — note in D5)*
- **M3.** Two-step handover, floor services: register dncRecheck,
  fillerPoolRefresh, agedRollingRefresh, callrailStatSync as morning tasks AND
  remove the B1 hoist — one change. *(medium)*
- **M4.** Cadence, morning channels: add a `channels` option to
  selectCounterCadenceDueItems (filter on the existing per-item `channel`
  field; CHAINS = sms/email/rvm). Morning task calls channels:["sms","email"].
  Same change: outbound-gateway's 5s worker passes includeDaily:false so it
  keeps ONLY real-time first-touch and age-relative sends. *(small-medium)*
- **M5.** Re-home the age-relative SMS-2: counterCadenceService.js:259-272
  fires prospect-follow-up-text-2 two hours after receipt, evaluated BEFORE
  the daily gate — it needs the frequent worker. It STAYS on the
  outbound-gateway real-time path (that worker survives; only daily batching
  leaves it). Verify M4's includeDaily:false preserves it. *(small, but test)*
- **M6.** Caller-ID rotation currently rotates every 2h in business hours —
  ANI-reputation decision, not scheduling (D8). *(decision)*

### A-MIDDAY (net-new runtime, DARK behind MIDDAY_PASS_ENABLED, ~12:00-13:00)

- **MD1.** Same scaffold as M1, own claim key. *(medium — reuse)*
- **MD2.** Call log hygiene, MIDDAY HALF: sinceMs covering 20:00-prev→13:00
  (pairs with E8). *(small once E8 exists)*
- **MD3.** Cadence, midday: channels:["rvm"]. forceDaily semantics let a
  second batch run same-day (lastDailyBatchKey); confirm the RVM per-day caps
  hold under a single noon burst. *(small)*
- **MD4.** The 1pm stats email — BLOCKED on D3 (Matt's stat list). Until then,
  ship the default: a read-only health check running the evening gatherers
  with apply:false, alerting if any source cannot answer. Early warning
  without a partial-day record or a merge seam. *(medium)*
- **MD5.** Arm morning first, then midday (midday's cadence correctness
  assumes morning consumed its slots), each after a dark cycle. *(process)*

### A-CROSS

- **X1.** Retire the hourly sweeper: delete startHourlySweepWorker and Phase A
  entirely; start a small 60s timer that ONLY drains the retry queue with the
  BUSINESS_HOURS_LITE handler set. One change. **Assumption to confirm (D4):**
  failed-text/RVM retries keep a short clock; only batch work moves to passes.
  The RC subscription watchdog keeps its own timer in ringcentral-cx —
  untouched. *(large; LAST, after 13+22-equivalents all armed)*
- **X2.** Weekend (D11): one guard currently covers cadence AND floor
  services; live runs floor services 7 days. Make it explicit per-pass.
- **X3.** Deletions — confirmed dead: startCxTerminalOutboxWorker (server.js
  :1614-1743), the `if (false)` legacy spend block (:836-860, AFTER E5),
  metricsRefresh tombstone (hourlySweeper :1107-1109), cxTerminalRectification,
  runHourlyLeadCadenceEnforcement, index.js.orig (do not commit, do not keep).
  Confirm-first: Sean first-touch pilot (:3001), cxCallActivityBackfill (D10),
  scheduled-actions cadence engine + staleCadenceSweep (D12).

---

## §4. Workstream B — Jira bridge (short; mostly arming)

- **J1.** Committed in step 0.
- **J2.** Mickey rules on the 22 `run ths`-status tickets whose note says
  FILE POA (queue-name vs action). Releases most of the 61 held conflicts.
- **J3.** Confirm Jacqueline's WYNN 43 / AMITY 165 in the back office;
  flip `verified` in jiraLogicsUserMap.js. Releases 28 held tasks + unblocks
  the bridge for her WYNN/AMITY tickets.
- **J4.** Arm: set JIRA_WEBHOOK_SECRET + JIRA_TASK_BRIDGE_ENABLED=true, point
  a Jira webhook (issue created/updated) at /api/jira/webhook, add the field
  descriptions to the ASSIGNMENT create screen (team-managed: Project settings
  → Issue types → Task; UI-only). Watch /api/jira/links for a week dark first
  — the route records decisions without writing while the flag is off.
- **J5.** Cleanup: delete ASSIGNMENT-2048 (probe); decide whether 2049 joins
  the AUGUST sprint or stays backlog.

## §5. Workstream C — TAG yellows → PhoneBurner

Unchanged from REVISION_WORK_ORDER §3, restated for one-list completeness:

- **Y1.** Diagnose why 4,579/4,586 pool rows sit in dnc-lookup-pending-retry —
  the retry has never run. Everything else waits on this.
- **Y2.** Run the scrub through the pool (RealPhoneValidation spend: get the
  go-ahead on volume first).
- **Y3.** Admission/composite source on the callRecoveryAdmissionService
  pattern → tier 4 of the existing ranker (leadDeliveryService.js:1500).
- **Y4.** Dry-run per-agent/per-day admission counts before any write; cap
  day one low.
- **Y5.** Gate on B1: DNC recheck must be demonstrably running before old
  records dial.

---

## §6. Decisions owed by Mickey

| # | Decision | Default if silent |
|---|---|---|
| D1 | Ship the 69 commits, or cherry-pick B1 to cx-round-2 first? | Cherry-pick B1; keep building here |
| D2 | queue-rollup: re-arm capture or delete the reader's fail()? | Delete the fail path; DailyReportFact becomes queue truth |
| D3 | What stats go in Matt's 1pm email? | Health-check only until answered |
| D4 | Retry drain keeps a 60s clock after hourly dies? | Yes (X1 assumes it) |
| D5 | Morning pass clock, given loosened internal gates | 08:00 PT |
| D6 | Does anyone read the activity-review 20:00 notice email? | Drop it when E6 arms |
| D7 | coverage.complete owner | Compute on read |
| D8 | Caller-ID rotation: fold to 2x/day or keep 2h timer? | Keep its own timer (ANI reputation) |
| D9 | Metrics workspace (route+panels already deleted on branch) — anyone using it? | Ship the deletion |
| D10 | Is cx.call.placed still emitted (decides cxCallActivityBackfill)? | Needs the Mongo query |
| D11 | Weekend: floor services yes / cadence no? | Yes/no exactly that |
| D12 | Any LeadCadence rows with pending schedule.actions (decides the legacy engine)? | Needs the Mongo query |

## §7. Sequence at a glance

```
0  commit + push ──► B1 floor fix ──► B2 plan() fix ──► B3/D2 queue-rollup
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
