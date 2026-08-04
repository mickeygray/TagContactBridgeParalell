# Night cleanup — line-by-line build guide

Date: 2026-08-04
Scope: **the overnight only.** Mickey: *"if we accomplish one thing over here
it's cleaning up the stuff that happens overnight first."*
Method: 10-agent audit, every thinning claim handed to a verifier told to refute
it. Line numbers are from the working tree at commit `7843c36`.

---

## WHAT "DONE" MEANS FOR THIS PASS

Mickey, 2026-08-04: *"it's important to touch everything here — we don't have to
complete the implementation in one pass, but sorta moving things around so it's
one thing on and we are in a place to do the next part is more the goal."*

So the acceptance test is **not** "every feature works." It is:

1. **One thing is on at night.** One process owns the evening. No second timer
   doing overlapping work on its own clock.
2. **Everything has been touched and has a home.** Every night job is either a
   task in the registry, explicitly parked with a written reason, or retired.
   Nothing is left un-inventoried.
3. **The next pass can finish it.** A piece may land DARK or PARTIAL, as long as
   it is in the right place and its remaining work is written down.

**Breadth beats depth here.** A dark task in the right place is a better outcome
than a finished feature in the wrong one — the point of this pass is position,
not completeness.

**The one exception, and it is absolute:** anything governing whether we may
dial a person is *complete or untouched*. There is no acceptable dark or partial
state for the DNC queue refresh (see §3 below). Everything else may land unfinished.

---

## THE SHAPE

```
   ONE PROCESS at 19:50
   ├─ links → cost → activities        (the data layer, built once)
   └─ the report composes ONCE, then BRANCHES:
      ├─ save the snapshot   ← first
      └─ send the email      ← second, same report object
```

The branch already exists. `reportDefinitionService` composes once and hands
that same report to `captureDeliveredDailyFact` — it just runs *after*
`sendMail`. **Moving that call ahead of the send is the whole change.** There is
no snapshot task, and there must not be one: a task receives no report, so its
only possible body is a second gather.

---

## STOP — FOUR THINGS THAT BITE BEFORE ANY EDIT

### 1. The pass is NOT failure-isolated. The comment says it is.

`nightlyHygieneRuntime.js:987` reads *"One chore failing must never cost the
others their night."* The code does the opposite on the live path: with a
`durableClaim`, a task error releases the claim and **returns** (`:990-1004`),
so every later task is skipped.

It resumes at the SAME failing task on the next poll (`:936`,
`startTaskIndex = durableClaim.nextTaskIndex`), and the poll is 5 minutes
(`:41`). From 19:50 that is **at most two retries before the 20:00 email.**

Consequence for this job: every task folded in sits *behind* seven fallible
tasks, three of which make network calls — including `mail-invoice`, documented
at `:400` as "the task most able to stall." **Fix the isolation before folding
anything else in, or order the fallible network tasks last.** Doing neither
means one flaky mailbox read at 19:51 costs the night's costing AND activities.

### 2. The resume cursor is POSITIONAL and durable — reordering TASKS can skip a task.

`claimNightlyHygiene` reads `nightlyHygieneNextTaskIndex` (`:75`) and the loop
starts there (`:937`). If a deploy lands after a partial pass stored, say,
`nextTaskIndex: 1`, the *new* array has a different task at index 1 and the task
that should have run next is **silently skipped for that day**.

If the skipped one is `night-persist`, that day's `officerAtSale` /
`sourceAtSale` are **unreconstructible** — Logics returns who owns the case
today, not who closed it in July.

**RULE: never deploy a TASKS array change inside the pass window, or clear
`nightlyHygieneNextTaskIndex` in the same deploy.**

### 3. Retiring nightlyClose can silently start over-dialing.

This is the one breakage the "wonky is fine" rule does not cover.

`nightlyCloseService.js:348` runs `refreshQueuedLeadStatuses` **opt-OUT**
(`options.leadQueueStatusRefreshEnabled !== false`). That re-reads per-case
Logics status and calls `retireDncLead`
(`leadQueueStatusRefreshService.js:180-214`), which sets the state terminal and
`LeadCadence.active = false`.

Retire the 21:30 close without arming an equivalent and that stops entirely: a
case that went DNC today **stays dialable**. Silent, and on the wrong side of
the line.

**RULE: the DNC queue refresh must be running in the new pass BEFORE the old one
is retired — verified by observation, not by flag.**

### 4. The 45-minute lease will not hold nightlyClose's work.

`HYGIENE_CLAIM_LEASE_MS` is 45 minutes (`:46`). `nightlyCloseService:881-884`
documents resolution-bank-close as "can run ~25 minutes", and
lead-cadence-case-refresh walks up to 20,000 leads × 3 domains with a per-case
Logics GET. Past the lease another poll re-claims the day, and every
`advance`/`finish` filters on `nightlyHygieneClaimedAt === claimedAt`
(`:85`, `:98`) — so the original pass throws "durable cursor was lost" (`:961`)
and the night ends mid-list. **Raise the lease first, or leave the close alone.**

---

## THE BUILD, IN ORDER

Each step is independently verifiable. Do not batch across the marked gates.

### STEP 1 — Make the chain survive a failing task *(do this first)*

**Why first:** everything after this folds more work into a chain that currently
aborts. Fixing isolation is what makes the rest safe.

- `nightlyHygieneRuntime.js:990-1004` — on a task error, record the failure and
  `continue` to the next task instead of releasing and returning. Advance the
  cursor past the failed task so a retry does not re-run it forever; keep the
  failure in `results` so the pass reports it.
- Keep releasing on a **claim** error — that is a different failure and must
  still abort.

**Verify:** a test that arms three tasks, makes the middle one throw, and
asserts the third still ran and the pass reports `incomplete: true` with the
middle task's error present.

### STEP 2 — Inject the collaborators *(no behavior change)*

- `server.js` — move `createSpendSyncRuntime` (`:2264-2267`) **above**
  `createNightlyHygieneRuntime` (`:2260`), but **keep it above
  `nightlyCloseRuntime` (`:2268`)** — the comment at `:2271-2273` makes that
  dependency explicit. `createLogicsActivityReviewRuntime` is already at `:2246`
  and does not move.
- Pass `config: { ...(config.nightlyHygiene || {}), spendSyncRuntime,
  activityReviewRuntime: logicsActivityReviewRuntime }`.
- **Do NOT arm either flag in this step.**

**Verify:** `node --check apps/control-plane/src/server.js`; every use appears
after its create; `nightlyHygiene.getState()` still reachable at `:2366`.
Note there is **no** `registerCleanup` for nightlyHygiene — `:3199` is
`spendSyncRuntime.stop()`, not this runtime.

### ── GATE: deploy steps 1–2 and watch one clean night before continuing ──

### STEP 3 — Costing handover *(both halves, ONE change)*

- `.env`: add `NIGHTLY_SPEND_SYNC_ENABLED=true` **and** set `SPEND_SYNC_ENABLED=false`
  (`:345`) in the same edit. The second disarms only the CLOCK
  (`spendSyncService.js:541-544` returns before `setInterval`); `syncAll()`,
  `getState()` and the three admin routes at `routes/metrics.js:169-204` keep
  working.
- Split them across deploys and the sheet syncs twice a night. It does not
  double money — `reconcileSpendEntries` is upsert-by-key — but it doubles the
  Logics/Sheets load for nothing.

**Ordering note that is NOT a bug:** after this, `mail-invoice`/`mail-spend-derive`
(index 1–2) run *before* the sheet sync (index 7), inverting today's order.
`reportComposerService:481-484` resolves it by set-partition (invoice wins its
day), so the composed number should be identical — **but nothing tests that
inversion.** Add a test, or compare one night's totals against the prior night.

**Verify:** `SpendEntry` newest write lands in the 19:50 window, not 19:45; the
20:00 email's spend total matches the prior night's shape.

### STEP 4 — CORRECTED: activity review does NOT feed the snapshot

**Verified 2026-08-04, after this step was written on an untested assumption.**

`logicsActivityReviewService.js` is 1,791 lines with **zero persistence** — no
`updateOne`, `bulkWrite`, `insertMany`, `save`, or model access anywhere. Its
terminal act is `sendMail` at `:1539`, subject *"<range>: X notices, Y
suspended"*. The only thing `logicsActivityReviewRuntime` writes is a
`recordServiceAlert` on failure (`:384`), and neither the report nor the snapshot
reads ServiceAlert.

**So it is a SECOND EMAIL, not a data-layer build step.** The premise under which
it was folded into the 19:50 pass — "the review must land before the snapshot
that reads it" — is false. Nothing reads it.

Consequences:

1. **Its position in the pass is meaningless.** It can run anywhere. Ordering it
   before `call-recording-index` or the snapshot buys nothing.
2. **It should be judged as an email, under Mickey's own rule:** *"if it's not in
   service of the nightly emails as they exist, it probably shouldn't exist, or
   get reformatted as a piece of that."* Either it is a report somebody reads —
   in which case it stands on its own and does not belong in a data-layer pass —
   or it is not, and it goes.
3. **The double-run risk still stands** and is now worse, because a double run
   means two identical notice emails, not just wasted work. It shares
   `LOGICS_ACTIVITY_REVIEW_ENABLED` with the standalone 20:00 runtime, which
   shared-config defaults to TRUE. The task already has its own
   `NIGHTLY_ACTIVITY_REVIEW_ENABLED` (default off) for exactly this reason.

**Decision needed before this step runs at all: does anyone read the notice
email?** If yes, leave the 20:00 runtime alone and drop the folded task. If no,
retire both. Do not proceed with a "handover" between two things that were never
part of the data layer.

The handover mechanics below are retained only in case the answer is "keep it and
move it".

### STEP 4 (mechanics, if it is kept) — both halves, ONE change

- Task 9 already reads its own `NIGHTLY_ACTIVITY_REVIEW_ENABLED` (fixed in
  `7843c36`). Arm it, and in the SAME change make `server.js:2977` skip starting
  the standalone runtime.
- **The folded task must take `claimActivitiesRun({ dateKey })` itself.**
  Otherwise the sheet-upload trigger (`dailyLoopService.js:247` via
  `routes/metrics.js:135`) can still fire a second full review the same day —
  three domains × a 50k-row ActivityReport, a second AI pass, a second write of
  `logics_notice_alerts`.
- Do not pass an explicit dateKey that bypasses `isScheduledToday`
  (`logicsActivityReviewRuntime.js:126`) without also taking that claim — the
  block that skips is the same block that claims.

**Worth knowing:** the 20:00 review almost never runs at 20:00 today.
`decideScheduledActivitiesRun` returns `run: false` while the payments gate is
not ready (`dailyLoopService.js:203-220`), and that gate can only go ready
through a route 404'd by an absent flag — so it actually fires at the **23:00
deadline** (`:206-211`). Moving it to 19:50 gains about three hours, not ten
minutes.

**Verify:** exactly one `logics_notice_alerts` write for the day; the review's
completion timestamp lands in the 19:50 window.

### STEP 5 — DEFERRED TO THE NEXT PATCH

Mickey, 2026-08-04: *"create the emails and then do it again and create the
object ... then next patch move things together."* And: *"to be careful let's
just run it twice for now."*

So the reorder below is **not in this patch**. Today's order already satisfies
the safe version of it:

```
compose ONCE -> send the email -> captureDeliveredDailyFact stores the object
```

The email is untouched, and the object is stored after it from the same report.
What DID land this patch is the object's contents: `facts.spend` now carries all
costs by source (`93d8ffb`), read off `report.spend` rather than a rendered
section, so nothing about the email changed.

What the hoist below buys, and why it can wait: it stops a send failure from
costing the day's data. That is a real gap, but it reorders the live email path,
which is the one thing that must not move while the nightly email is the
priority.

**When it is picked up, the four edits are:**

Four coordinated edits, ONE change:

1. `DailyReportFact.js:25` — `emailAcceptedAt` becomes
   `{ type: Date, default: null }` (drop `required`). A pre-send snapshot has no
   accepted mail, and lying in a provenance field is worse than a null.
2. `dailyReportFactService.js:108,136` — tolerate null:
   `emailAcceptedAt ? new Date(emailAcceptedAt) : null`.
3. `reportDefinitionService.js` — hoist the existing
   `captureDeliveredDailyFact({ def, report, range, emailAcceptedAt: null, writer })`
   call from `:256` to immediately after the claim at `:214` and **before**
   `sendMail` at `:233`. **Keep its own try/catch verbatim** — `:259-269` is what
   stops a fact failure releasing the claim and resending four emails on the
   next poll. Then after `result.delivered = true` (`:248`), stamp acceptance
   with a single swallowed `updateOne({dateKey}, {$set:{emailAcceptedAt: new Date()}})`.
4. Keep the field name `result.dailyFactCapture` — `reportScheduleRuntime.js:81-94`
   alerts on it by name.

Net: still ONE `composeReport`, snapshot first, email second, **zero new gathers.**

**Verify:** rewrite `dailyReportFactService.test.js:208-217` to assert capture
index < send index while keeping the `!between.includes("composeReport(")` half;
update the order array in `nightlyReportDelivery.test.js:154` to
`["fact-write","mail-accepted"]` while keeping `:155-158` (delivered stays true,
claim NOT released) **unchanged** — those two are the anti-duplicate-email
guarantee.

### STEP 6 — Retire the duplicate emails *(Mongo, not code)*

Four definitions are enabled at 20:00; the plain pair duplicates the other two.

- Archive plain `vendor` and `financial`. **`--archive` in
  `scripts/report-schedule.js:157` patches only `archivedAt` and leaves
  `schedule.enabled` true** — and a later `--save` resets `archivedAt` to null
  (`:124`), re-arming it invisibly. **Set `schedule.enabled = false` in the same
  operation, or archive via the route** (`routes/reports.js:200` does both).
- **NEVER rename "financial roll up with calls"** — `dailyReportFactService.js:9`
  pins to it. If it is renamed or archived, capture returns
  `{status:"skipped"}` and `reportScheduleRuntime.js:81` alerts only on
  `"failed"` — **the fact collection silently stops growing.**
- After this, the bare string `vendor` resolves to an archived row. Every
  vendor-facing step must spell **"vendor roll up with calls"**.

### STEP 7 — Fold link capture in, retire the 23:00 timer

Per §7a of the work order: keep the finding, drop the fetching. `call-links`
(task 4) already stores CallRail links with no download — it is DARK because
`CALL_LINK_CAPTURE_ENABLED` is absent, and an unarmed task is skipped without
even planning (`:949-963`), so it does not dry-run either.

**Carry forward or the report's listen links go blank:**
`recordingArchive.driveWebViewLink` is read by `nightReportService.js:300,309`
and `trainingCallReviewSourceService.js:342`. Re-point both in the same change.

**The EX exclusion is currently enforced BY not downloading** — `stampCallLog`
returns early unless an upload exists (`archive-eod-recordings.js:295-298`).
Once nothing downloads, that rule has **no representation at all**. It must move
onto the index writer and the read endpoint before capture is armed.

---

## THINNING — safe, verified, do last

- `server.js:810-844` — the `if (false) {` dead hourly spend-sync block.
  Unreachable by construction. Leave `HOURLY_SPEND_SYNC_ENABLED` and its config
  key alone: `server.js:348` still reads it into the sweep summary.
- `spendEntryRepository.js:248-264` `incrementSpendEntry` + its export at `:270`
  — zero callers; the materializer it served is retired
  (`nightlyCloseService.js:256`). Do this **separately** from the handover so a
  bisect can tell a spend regression from a cleanup.
- `.env:819` `EOD_RECORDING_ARCHIVE_ENABLED=false` — referenced by no code
  anywhere. The live switch is `RECORDING_ARCHIVE_EOD_ENABLED` (`:721`).

## Composer bugs found in passing — real, but NOT part of this cleanup

Fix these deliberately, in their own change, not folded into the consolidation:

- **BCD double-count.** `reportComposerService:555` adds every
  `channel === 'mailer'` row into `mail`, and BCD is added AGAIN at `:605/:612`
  from `DailyCallStat` × rate. *Caveat: the auditor could not prove statically
  that a BCD-named spend row exists — it is a live-data question. Confirm before
  fixing.* Note `isBcdPiece` at `:738` is block-scoped and NOT in scope at
  `:555`, and it is written for CallRail piece names, not spend source names.
- **`spendByDay[day].bcd` is initialised at `:537/:592` and never assigned**,
  while `material.spend.total` includes BCD — so anything summing `spendByDay`
  disagrees with the headline by exactly the BCD amount.
- **`readDailyReportFactRange` returns `complete: true` for degenerate ranges**
  (`{}` and reversed from/to) — `:206` swallows both the unparsable and reversed
  case. Reject before querying; keep the four coverage keys unchanged on the
  valid path (`dailyReportFactService.test.js:172-191` pins them).

---

### STEP 8 — Touch nightlyClose: sort its jobs, move what moves, park the rest

Under the "position, not completeness" rule this no longer blocks. nightlyClose
(21:30) holds roughly eight jobs. Sort every one into **move / park / drop**,
land them dark, and write down what is left:

| Job | Disposition |
| --- | --- |
| `refreshQueuedLeadStatuses` (DNC) | **ALL-OR-NOTHING.** Opt-OUT today (`nightlyCloseService.js:348`) and the caller of `retireDncLead` (`leadQueueStatusRefreshService.js:180-214`). Either it is running and observed in the new pass, or the 21:30 timer stays on. **Never dark, never partial.** |
| payment sweep | move — task, dark |
| `runNightlyLeadCadenceCaseRefresh` (`:136-226`) | move, dark — but it walks up to 20k leads × 3 domains with a per-case Logics GET. **Raise `HYGIENE_CLAIM_LEASE_MS` (`:46`, 45 min) before arming.** |
| `ensureClientCaseProfiles` | move — task, dark |
| `recoverCxCallLogsForDate` | **drop** — CX, per the CX-as-data shakedown |
| resolution-bank-close (`:881-884`) | move LAST, dark — documented "can run ~25 minutes" |
| PhoneBurner reconcile | move — task, dark. Touches invariant #2; observe before arming |
| `HourlyJobEvent` prune | **decide before Step 8 lands.** It is stranded behind an email that never sends (`:805`, `NIGHTLY_CLOSE_SEND_EMAIL=false`), so retiring the close silently removes it |

**The timer comes off only when the DNC row above is satisfied.** Everything else
can sit dark behind its own flag — that is what "in a place to do the next part"
means.

---

## Order of operations, one line each

```
1. fix failure isolation          (unblocks everything)
2. inject collaborators           (no behavior change)
   ── GATE: one clean night ──
3. costing handover               (.env, both halves)
4. activity review handover       (+ take the claim)
5. snapshot before send           (the goal)
6. archive the duplicate pair     (Mongo, enabled=false too)
7. link capture in, 23:00 out     (carry the readers + EX rule)
8. touch nightlyClose             (sort 8 jobs; DNC all-or-nothing)
9. thinning                       (dead code, separately)
```

**After this pass, the night is:** one process at 19:50 that ends with the send,
plus lexis at 02:00. Some of what it carries will be dark. That is the intended
end state for THIS pass — one thing on, everything homed, the next part
unblocked.

### What the next pass picks up (written down so it is not rediscovered)

- Arm the tasks that landed dark, one at a time, each with an observed night.
- The recording INDEX (serving side): add `provider` + `providerRef` to
  `MarketingCallLink`; keep `listenUrl` only for providers whose URLs are durable
  (CallRail serves `HTTP 200 audio/mpeg` unauthenticated); leave it **null** for
  RingCentral and mint at read time through the existing HMAC forwarder
  `/api/recordings/rc-play/:recordingId`, which already mints a fresh RC bearer
  per request. An RC URL with a token baked in is not a durable artifact and must
  never be cached as one — the model's "the URL never changes" premise
  (`MarketingCallLink.js:11`) holds for CallRail and fails for RC.
- Repair the 252 CallRail rows mislabeled `platform:"ex"`, and enforce the EX
  exclusion at the endpoint.
- The email renders FROM the snapshot rather than from sibling material.
- The composer bugs listed above, in their own change.

**Never in the same change as anything else:** a TASKS array reorder (positional
cursor), and retiring nightlyClose (DNC refresh).
