# Automated services — what actually runs

Date: 2026-08-04
Status: AUDIT. Nothing deleted, nothing disarmed.
Purpose: work through these ONE AT A TIME before any deletion.

---

## 0. The correction this audit forced

**The nightly stack IS RUNNING.** I said repeatedly that `ParallelControlPlane`
was Manual+Stopped and that nothing scheduled had run since 2026-07-30. That is
false, and it was load-bearing in several of my recommendations.

Evidence — writes landing in the 19:45–19:50 window on 2026-08-03:

```
spendSync   -> SpendEntry        8/3 7:45 PM
hygiene     -> DailyLoopRun      8/3 7:50 PM   (nightlyHygieneCompletedAt)
nightPass   -> PaymentTruth      8/3 7:50 PM
```

And live traffic today:

```
leadDelivery -> LeadDeliveryItem  8/4 9:29 AM   11,499 docs
pb callback  -> LeadDeliveryEvent 8/4 9:29 AM   28,135 docs
dials        -> DailyDial         8/4 9:29 AM   17,596 docs
```

Anything reasoned from "the control plane is down" needs re-checking. In
particular `spendSyncService` / `SpendEntry` are LIVE and must not be deleted.

---

## 1. The services

13 runtimes are constructed in `apps/control-plane/src/server.js`.

| Service | Configured | Fires | Evidence it runs |
| --- | --- | --- | --- |
| `spendSync` | **on** | 19:45 | SpendEntry 8/3 7:45 PM ✅ |
| `nightlyClose` | **on** | 21:30 | (not probed) |
| `recordingArchive` EOD | **on** | 23:00 | CallLog 8/3 5:36 PM ✅ |
| `lexisDailyDrop` | **on** | 02:00 | (not probed) |
| `logicsActivityReview` | **on** | 20:00 | (not probed) |
| `nightlyHygiene` | env-gated | 19:50 | DailyLoopRun 8/3 7:50 PM ✅ |
| `reportSchedule` | env-gated | 20:00 | ReportDefinition 8/4 8:10 AM ✅ |
| `leadDelivery` | env-gated | continuous | LeadDeliveryItem 8/4 9:29 AM ✅ |
| `phoneBurnerLeadDelivery` | env-gated | callback | LeadDeliveryEvent 8/4 9:29 AM ✅ |
| `nightlyCallGrade` | **off** | 18:00 | — |
| `lexisNightly` | **off** | 02:00 | — |
| `phoneburnerRotation` | **off** | 07:00 | — |
| `blogger` | **off** | 08:00 | — |
| `demoRingout` | **off** | — | — |

### Hygiene tasks (inside `nightlyHygiene`, each separately armed)

```
night-persist            PaymentTruth 8/3 7:50 PM   ✅ running
mail-invoice             MailInvoice — 1 doc, from a MANUAL run only
mail-spend-derive        MailSpendDay — 3 docs, MANUAL only
call-links               CALL_LINK_CAPTURE_ENABLED absent
call-recovery-discovery  dry-run
queue-rollup             DailyQueueRollup 7/31, 3 docs — GATED OFF
logics-source            dry-run
```

---

## 2. Decide first — this one is actively breaking a report

**`queue-rollup` / DailyQueueRollup.** Writer hard-gated, store holds 3 days
(newest 7/31), and the READER in `reportComposerService` `fail()`s on any range
over `QUEUE_DAY_LOOP_MAX` (7 days). So **every monthly report goes out
`[DEGRADED]` today**, and monthly per-agent numbers are not computable at all.

Two ways out, and it is a genuine choice:
- **re-arm the capture** — per-agent history accumulates from today, monthly
  becomes possible in ~4 weeks;
- **drop the reader** — monthly reports stop failing immediately, and per-agent
  is accepted as a ≤7-day question forever.

Doing neither leaves a red band on every long report.

---

## 3. Ready to delete (verified, one item)

`packages/shared-services/src/metricsPulseService.js` — 337 lines, zero
callers, zero routes, no history. Also `index.js:137`, `index.js:1309`, and the
types block in `apps/web-client/src/lib/api/types.ts`.

## 4. DO NOT DELETE — verified load-bearing despite looking dead

- **`spendSyncService`** — live, see §0.
- **`nightReportService`** — `readLdDials` feeds both enabled 20:00 definitions;
  a module-scope `require` in `nightPassService` means removing it breaks
  `night-persist` at load; it holds the only corrupt-spend-date detector.
- **`nightPassService`** — sole writer of `officerAtSale` / `sourceAtSale`.
- **The four "orphans" in `nightRecordingsService`** — a test asserts on their
  source text and the only two `CallLog.find(` sites live inside them.
- **`frontendReadService`** — feeds the CX floor search.
- **`readCallLinks()`** — dead today, but it is the backend for the call-link
  front end and already implements missing-day coverage.

---

## 5. Working order

Take them one at a time, each verified before the next:

1. `queue-rollup` — decide (§2). Only item degrading a live email.
2. `metricsPulseService` — delete (§3).
3. Fact-reader degenerate ranges — `complete: true` for `{}` and reversed
   ranges; the aggregation layer reads through this.
4. Vendor board — `listen` column and the CSV that restores hidden columns.
   Vendor-facing; do before any vendor address is added.
5. Duplicate ReportDefinitions — `financial` and `vendor` duplicate the "roll up
   with calls" pair, both `rollup` at 20:00, so two near-identical emails go
   out. Archive in Mongo, not code. **Never rename "financial roll up with
   calls"** — `dailyReportFactService` pins to it by name and both stored facts
   carry it.

---

## 6. THE PLAN — 2026-08-04 (supersedes §5 ordering)

Everything below reviewed with Mickey this morning. 609 tests green.

### Landed since the patch started (uncommitted except where noted)

- LD cost day 20:00→20:00 + script DNS fixes — **committed 665029a**
- WYNN BCD campaign 31 registered → first WYNN BCD deal attributes ($166.67)
- Vendor board channel isolation — BCD money no longer credited to the LD vendor
- `offhourscalls` block — 33 first-time off-hours callers Aug 1–3, built, NOT
  yet in any preset/definition (awaiting officer addresses)
- PB recording references now go through the promotion gate;
  `PHONEBURNER_RECORDING_ALLOWED_HOSTS=www.phoneburner.com` in .env
- Re-enabled: DNC recheck, aged-pool advancement, filler-pool refresh (= the
  "old TAG yellows → PhoneBurner" sampler), BLOGGER_ENABLED — all were killed
  by hard-coded `scheduledPhaseLite = true` at server.js:703
- False "control plane stopped / sheet retired" claims corrected in code,
  docs, and memory

### Architecture settled with Mickey

- **Two 7:50 passes + the emails.** Evening service = ONE shot: drain PB,
  capture call links (with agent + source + caseId), gather material ONCE,
  **save the snapshot FIRST, then build/send the email from the same
  material**. Folds in nightlyClose's OPERATIONAL half (payment sweep, cadence
  refresh, PB reconcile); its email half is already silenced. A send error is
  not the death of the data.
- **CallLog becomes a recording INDEX** — one row per call WITH a recording:
  metadata (platform/date/agent/source/caseId/duration/phone) + locator. Media
  stays with the vendor. DailyDial untouched. MarketingCallLink folds in.
  Facts: CallRail links self-serve (HTTP 200 audio), PhoneBurner links work,
  RingCentral 401s — but the forwarder ALREADY EXISTS (`/rc-play/:id`,
  HMAC-signed, configured, 3 viewers) and `mintRecordingPlaybackUrl` already
  routes per provider. Missing: report path never calls the minter; no
  searchable index; 252 CallRail rows mislabeled `platform:"ex"`; EX exclusion
  must live in the endpoint (502 ex rows). RC TTL default 1h — too short for
  an overnight email.
- **CX → its own branch, not deletion.** 66 services + 8 models. Separate op.
- **spendSync / EOD recording archive / lexis / logicsActivityReview** — being
  replaced by the above; stop-writing later, readers and history stay.

### Today, in order

1. **Commit the tree** (fixes+features commit, then floor-enables commit).
2. **Vendor email repairs** — outward-facing, before any vendor address:
   drop `listen` from vendor boards, `attachCsv=false` on the vendor
   definition, decide `ldcalls`-on-vendor (anonymize seat or drop), suppress
   officer names.
3. **Recording index slice** (Mickey: "by far the smallest slice"):
   authenticated endpoint returning metadata + opaque ids; mint on request;
   EX fenced in the endpoint; repair the 252 mislabeled rows; nightly email
   links via the minter (RC rows link to the index or use a longer TTL — needs
   Mickey's pick).
4. **LD touch accounting** — one block answering "how are we doing at touching
   stuff" per pool/age, runnable morning/noon/evening.
5. **Evening service consolidation** — spec then build. Drain stays MANUAL
   until Mickey explicitly says nightly-automated.
6. **Deletes** — metricsPulseService only (verified). queue-rollup needs his
   call first (monthly reports go out [DEGRADED] today).

### Decisions Mickey owes

- queue-rollup: re-arm capture (monthly per-agent in ~4 wks) or drop reader?
- Duplicate ReportDefinitions: archive plain `financial` / `vendor`?
- RC links in email: index-page link vs long-TTL signed link?
- Nightly automated PB drain: yes or no?
- Where does the control plane HOST? (decides whether .env/server.js edits are
  live after a restart — the four re-enables depend on this)

---

## 7. THE REVISION PLAN — Mickey's ordering, 2026-08-04 (supersedes §6 order)

Goal: "making the app a coherent only useful surface." May extend past today.

1. **Blogger on** — ✔ `BLOGGER_ENABLED=true` (env). Fires 08:00 once the
   hosting process restarts with this repo's .env.
2. **Lead aging on** — ✔ `agedRollingRefreshEnabled: true` (committed eecc0bf).
   Same restart caveat.
3. **TAG yellows → PhoneBurner groundwork — HALF DONE, half MISSING.**
   ✔ The sampler runs: fillerPoolRefresh re-samples status=2 TAG cases
     (caseId>=50000, has phone) into MasterProspectIndex — 4,586 TAG rows.
   ✘ NOTHING DELIVERS THEM. LeadDeliveryItem is effectively WYNN-only:
     11,493 WYNN rows vs SIX Tag rows (2 from July). The delivery loop that
     fills PhoneBurner folders never ingests TAG MPI rows. The repo touches
     MPI only as a per-case findOne (enrichment), not as a source.
   The missing piece is an INTAKE: admit TAG MPI rows into the delivery pool
   the way callRecoveryCompositeSource admits recovery episodes. Real build.
4. **CX phase-out** — move 66 services + 8 models to their own branch.
5. **Service workers → 3x/day:**
   - MORNING: set up the floor (rotation-era chores, blogs at 08:00)
   - MIDDAY: honest LD accounting — is everything getting touched, does the
     pool need reorienting so new stuff gets a SECOND touch
   - EVENING (one shot): drain/reset, capture call links (agent+source+case),
     gather once, SNAPSHOT FIRST, then send. Folds nightlyClose's operational
     half.
6. **Vendor email tightening** (listen col, CSV, officer names, phones-not-ids).
7. **CallLog → recording-forward surface** (index + minter on the report path;
   EX fenced; 252 mislabeled rows repaired).
8. **Admin panel / app review** — deprecate and rebuild toward "coherent only
   useful surface."

Committed so far: 665029a, b33412a, eecc0bf.
