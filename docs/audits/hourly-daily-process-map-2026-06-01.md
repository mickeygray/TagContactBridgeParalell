# Hourly & Daily Autonomous Processes — Map + Correction Notes

**Date:** 2026-06-01 PT
**Author:** Claude (Opus)
**Purpose:** Document what the two autonomous "heavy-lifter" tracks — the **hourly sweep** and the **nightly/daily schedulers** — actually do today, and where they're congested, redundant, or fuzzy about ownership. This is the "pick them apart and say what each does, well or not" pass. **No AI/feature work here** — that's a separate track; these processes only ever hand it *data*, never call into it.

> **Methodology / confidence:** Items marked **[verified]** I read directly. Items marked **[mapped]** come from a structural sweep of the code (file:line cited) that I didn't open line-by-line — trust the shape, spot-check the exact line before acting. Correction opinions are tagged **→ OPINION**.

---

## The thesis: what each track is *for*

The cleanest way to judge these is to name each one's job and then ask whether everything it does belongs there.

- **Hourly = "stay current."** Incremental hygiene during business hours: ingest new calls, repair attribution, reconcile recent payments, refresh today's metric rollups, enforce cadence, drain a retry queue. Cheap, frequent, idempotent, bounded windows.
- **Nightly = "close the books."** Once-a-day authoritative pass: final reconcile, prune resolved events, and produce the financial / lead / ops emails + CSVs. Allowed to be dense and slow because it runs once and nothing waits on it.

My read: **the boundary is mostly coherent**, and the user's instinct that "nightly being dense is fine" is right — density isn't the problem. The problems are (1) the hourly Phase A is a 16-step sequential monolith with one slow step that can starve the rest, and (2) three responsibilities live in *both* tracks without an explicit "who's the source of truth" rule. Details below.

---

## TRACK A — The Hourly Sweep

Two workers boot in control-plane, each `setInterval(60s)`, each guarded only by an in-process boolean (`workerState.running`) — fine for the single-instance steady state.

### Worker 1: main hourly sweep — two phases in one tick

**[verified]** [apps/control-plane/src/server.js:461](C:\code\tagcontactbridgeparalell\apps\control-plane\src\server.js). The tick fires every 60s and does two different things:

- **Phase A — scheduled hygiene.** Runs **once per UTC hour** (hour-key guard, [server.js:472](C:\code\tagcontactbridgeparalell\apps\control-plane\src\server.js)) **and only inside PT business hours** (`isOperatingNow`, [server.js:489-510](C:\code\tagcontactbridgeparalell\apps\control-plane\src\server.js)). So it's ~14 fires/day, not 24 — this bounds the overlap-with-nightly worry a lot.
- **Phase B — retry drain.** Runs **every 60s**, claims up to a batch cap of queued `HourlyJobEvent` retry jobs, dispatches each with a 45s timeout.

The first tick is deferred via `setImmediate` so a slow Logics call doesn't block boot ([server.js:638-644](C:\code\tagcontactbridgeparalell\apps\control-plane\src\server.js)).

**Phase A job inventory** (sequential, in order) — **[mapped]** from [hourlySweeperService.js / hourlyJobHandlers.js]:

| # | Job | Reads | Writes | External | Notes |
|---|-----|-------|--------|----------|-------|
| 1 | sessionReconcile | WorkflowRecord, Event (last-hour window) | Event, WorkflowRecord, ReviewQueue | RingCentral call-log | attribution repair |
| 2 | paymentReconcile | PaymentLedger, CaseProfile | PaymentLedger, CaseProfile, ReviewQueue | **Logics, per case, round-robin up to ~250/domain** | the heavy one |
| 3 | paymentFieldsSync | CaseProfile, PaymentLedger | CaseProfile, WorkflowRecord | none | **uses `acquireRunLock`** |
| 4 | callLogHygiene | CallLog (windowed), LegacyContactActivity | CallLog, CallLedger, CaseProfile | RingCentral sweep, inline transcription/archive | 3 sub-passes |
| 5 | cxCallActivityBackfill | CallLog | CallLog | — | 65-min window |
| 6 | metricsRefresh | CallLog (per-day) | **CallStat, MetricsSnapshot** | none | builds the rollups |
| 7 | cxRecordingHourly | CallLog (windowed) | HourlyJobEvent, CallLog | RingCX metadata + WAV download + Drive | also a separate worker — see flag |
| 8 | leadCadenceEnforcement | LeadCadence | LeadCadence | none | ~250/domain |
| 9 | staleCadenceSweep | LeadCadence | LeadCadence | none | |
| 10 | staleNcoaSweep | NcoaBatch(Row) | NcoaBatch | none | |
| 11 | ncoaMailbox | mailbox | NcoaBatch, LeadCadence | SFTP/IMAP | one file/day |
| 12 | dncRecheck | LeadCadence | LeadCadence | RealValidation DNC | 150ms inter-call sleep |
| 13 | calllogBridge | CallLog | CaseProfile | Logics getCaseInfo | repairs missed promotions |
| 14 | fillerPoolRefresh | LeadCadence | LeadCadence, Mpi | Logics bulk, RealValidation | 1st-of-month only |
| 15 | agedRollingRefresh | LeadCadence | LeadCadence | Logics, SendGrid | daily 6am boundary |
| 16 | resolutionEmails | HourlyJobEvent | HourlyJobEvent | SendGrid | up to ~100 emails |

### What Phase A / B do **well**

- **Phase B is the model citizen.** Claim-based, batched, idempotent, per-job timeout, retry/dead-letter decision. This is exactly how heavy work should be structured. **→ OPINION: the heavy Phase A handlers should look more like Phase B than like Phase A.**
- **The business-hours gate** on Phase A is a genuinely good instinct — it stops overnight churn on the expensive Logics/RC surfaces.
- **`metricsRefresh` produces durable rollups** (`CallStat`, `MetricsSnapshot`) **[verified]** [hourlyMetricsRefreshService.js:55](C:\code\tagcontactbridgeparalell\packages\shared-services\src\hourlyMetricsRefreshService.js) → `metricsBackfillService`. That's the right shape: aggregate once, store, let readers read.

### Where it's congested — **→ OPINION**

1. **One slow step starves the other fifteen.** Phase A is a sequential `await` chain inside a single boolean-guarded tick. `paymentReconcile` (step 2) can fire **up to ~250 sequential Logics calls per domain** ([mapped] paymentReconcileService.js). At 100-500ms each across two tenants that's plausibly minutes — and `metricsRefresh`, `leadCadenceEnforcement`, `resolutionEmails` all sit *behind* it in the same chain. The 45s per-handler timeout doesn't bound the *phase*. **Fix direction:** give the independent handlers their own claim + cadence (the Phase B pattern), or at minimum group the Mongo-only handlers (3, 9, 10) to run concurrently with the API-bound ones (2, 12, 13). The ordering shouldn't be load-bearing.

2. **`cxRecordingHourly` downloads inline.** [mapped] It loops candidate `CallLog` rows (up to ~500/domain) and can download a WAV + upload to Drive *inside the tick* ([cxRecordingHourlyService.js] processCallRecordingArchive call), **while also** emitting `HourlyJobEvent` archive jobs that Phase B would drain. That's two paths to the same work. **Fix direction:** pick the queue path — enqueue archive jobs, let Phase B (or the dedicated recording worker) drain them — and keep the tick bounded to the cheap metadata fetch + enqueue.

3. **Index coverage on the windowed scans.** The hygiene scans filter `CallLog` on `{domain, direction, callStartTime, durationSec}` and `{domain, telephonySessionId, recordingArchive.status, callStartTime}` ([mapped] hourlyCallLogHygieneService.js:708, 852). Confirm compound indexes exist for these (esp. `recordingArchive.status`); otherwise each hourly pays a collection scan per domain. **(Verify against actual `CallLog` indexes before claiming a miss.)**

### Flag to verify (possible double-run)

`cxRecordingHourly` appears **both** as a standalone worker (`startCxRecordingWorker`, [verified] [server.js:652](C:\code\tagcontactbridgeparalell\apps\control-plane\src\server.js), fires at :30) **and** as Phase A step 7. The mapping suggests the Phase A entry is for observability only, but I did not confirm it doesn't actually re-invoke the download. **→ Verify Phase A step 7 isn't a second real execution of the same hour's recording pull.** If it is, that's duplicate RingCX calls and Drive uploads.

---

## TRACK B — The Nightly / Daily Schedulers

Eight runtimes registered in control-plane ([mapped] [server.js:1204-1212](C:\code\tagcontactbridgeparalell\apps\control-plane\src\server.js)), each a `setInterval`-driven scheduler with a `state.running` boolean and a next-run-at computed against a PT clock.

| Job | Schedule (default) | Produces | External | Collections |
|-----|--------------------|----------|----------|-------------|
| **Nightly Close** | 21:30, Mon-Fri | Financial + Lead-data + Ops emails, CSVs; prunes resolved events | Logics, SendGrid, SpendSync (Sheets) | R: CallLog, CaseProfile, PaymentLedger, HourlyJobEvent · W: PaymentLedger, CaseProfile, **deletes HourlyJobEvent** |
| Lexis Nightly | 02:00, Mon-Fri | Regional email; SFTP ingest→import | SFTP, SendGrid | file-based |
| Lexis Daily Drop | 02:00, Mon-Fri | Drop email; SFTP send of cached files | SFTP, SendGrid | none |
| Logics Activity Review | 06:00, daily | CSV of notice-flagged cases + email | Logics, SendGrid | Logics reads |
| EOD Recording Archive | 21:30, Mon-Fri | Drive uploads; CallLog stamps; email | RingCentral, CallRail, Google Drive | R: CallLog, LegacyContactActivity · W: CallLog, CallLedger |
| PhoneBurner Rotation | 07:00, Mon-Fri | **gated OFF** (`PHONEBURNER_ROTATION_ENABLED`); spawns legacy script | child process | none |
| Demo Ringout | windowed, opt-in | test ringouts | RingCentral | none |
| Blogger | 08:00, Mon-Fri | spawns blog runner, SSH deploy | child process / SSH | none |

### What nightly does **well**

- **It's the event-log janitor.** Nightly close prunes resolved `HourlyJobEvent` docs ([mapped] nightlyCloseService.js:922). **→ OPINION: this is the natural home for the "30k stale events" cleanup we discussed — it already owns pruning; the lever is making it more aggressive about terminal-status events, with the metrics-bearing ones projected out first (see the separate events note).**
- **Aggregations are date-windowed, not full scans.** **[verified]** `buildCxCallSummary` / `buildScoreSummary` both `$match` on `callStartTime: {$gte:start,$lte:end}` for the PT day ([nightlyCloseService.js:729-809](C:\code\tagcontactbridgeparalell\packages\shared-services\src\nightlyCloseService.js)). The earlier "full-collection scan" worry was **wrong** — correcting it here so nobody optimizes a non-problem.
- **Failure isolation.** The CX/score aggregations are wrapped so an aggregation hiccup never derails email composition ([verified] `.catch(() => [])`, [nightlyCloseService.js:765](C:\code\tagcontactbridgeparalell\packages\shared-services\src\nightlyCloseService.js)).

### Where it's congested / fuzzy — **→ OPINION**

1. **Two jobs named "Lexis" at the same 02:00 slot.** "Lexis Nightly" (ingest) and "Lexis Daily Drop" (send) both default to 2am Mon-Fri. Probably intentional (pull then push) but the naming invites confusion and the shared slot invites SFTP contention. **Fix direction:** rename to intent (`lexis-ingest` / `lexis-deliver`) and stagger the minute, or chain them so deliver runs *after* ingest confirms.

2. **The 12-hour idle-wait inside EOD archive.** [mapped] EOD archive can poll the recording pipeline for up to 12h before proceeding ([eodRecordingArchiveRuntime.js:135-141]). On a single box that's a runtime sitting in a wait loop most of the night. Works, but it's a fragile way to express "run after recordings settle." **Fix direction:** make it event-driven (archive when the hourly recording worker signals the day is drained) rather than a wall-clock poll.

3. **Sequential email/CSV composition.** [mapped] Nightly builds multiple CSVs and sends pools sequentially. Fine for a once-a-day job — **→ OPINION: leave it.** This is the "density is acceptable" case; don't spend effort parallelizing a job nothing waits on.

---

## The seams — three responsibilities that live in BOTH tracks

This is the real answer to "do we accomplish what we want concretely between the two." Mostly yes, but three things lack an explicit source-of-truth rule:

1. **Payment reconciliation.** Hourly Phase A step 2 (`reconcilePaymentsForDomain`, round-robin, incremental) **and** nightly close (final reconcile pass). **→ OPINION: this is fine *if* it's stated** — hourly = best-effort incremental during the day, nightly = authoritative close-of-day. Make nightly the reconciler-of-record explicitly (it already prunes the retry queue, so it's the natural authority) and document that hourly is allowed to be lossy. Right now the division is implicit.

2. **CallLog → metrics aggregation.** Hourly `metricsRefresh` builds `CallStat`/`MetricsSnapshot`; nightly re-aggregates raw `CallLog` for the email. **→ OPINION: partially redundant but defensible** — nightly slices on `platform:"cx"` and `callScore.lead_verdict` ([verified]) which the rollup may not carry. The clean fix is to decide *what dimensions `CallStat` should carry* so nightly can read the rollup for the overlapping parts and only re-query for the genuinely email-specific cuts. Don't blanket-dedup; close the dimension gap.

3. **Recording archive.** Hourly `cxRecordingHourly` (RingCX, intra-day) **and** nightly EOD archive (RingCentral + CallRail + CX, end-of-day) both pull recordings and stamp `CallLog.recordingArchive`. **→ OPINION: clarify the split by provider/timing** — e.g. hourly handles fresh CX pulls, nightly is the sweep-up for anything the hourly missed + the non-CX providers. Confirm they can't both grab the same row in the same evening (the `recordingArchive.status` terminal guard should prevent it — verify).

---

## Suggested correction priorities (notes, not a commitment)

1. **De-monolith Phase A** so one slow Logics reconcile can't starve metrics/cadence/emails. Highest leverage for "uncongested." Move independent handlers to the Phase B claim model or run the Mongo-only ones concurrently.
2. **Pick one recording-archive path in the hourly** (enqueue, don't download inline) so the tick stays bounded.
3. **Write down the three source-of-truth rules** above. Cheap, and it's the difference between "two processes that mostly agree" and "two processes that provably don't double-count."
4. **Verify the cxRecording double-run flag** and the `CallLog` index coverage — both are confirm-then-maybe-fix, not assumed.
5. **Lexis rename + stagger** and **EOD idle-wait → event signal** are lower-priority tidiness.

## Don't churn

- Nightly's sequential email/CSV build (density is acceptable here).
- The business-hours gate on Phase A (correct as-is).
- The Phase B retry-drain design (it's the reference pattern).
- The date-windowed nightly aggregations (already bounded).

## Open questions

1. Is the **cxRecording Phase A entry** a real second execution or just reporting? (Gates correction #4.)
2. For the **payment/metrics/recording seams**, do you already consider nightly the authority, or is that genuinely undecided?
3. Is the **EOD 12-hour idle-wait** load-bearing (waiting on a known-late RC media delay), or vestigial?
