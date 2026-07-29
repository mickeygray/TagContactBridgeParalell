# BUILD-UP WORK ORDER — post-gutting, feature by feature
Date: 2026-07-27 · Author: analysis+execution session · Executor: any session
Parent: `METRICS_COACH_PATCH_WORK_ORDER_2026-07-27.md` (v2 — rules of
engagement §0, doctrine §0.1, thesis §0.5, front-end scope §0.6 all still
binding). Design: `CUSTOM_REPORT_GENERATOR_DESIGN_2026-07-27.md` (approved,
all questions closed). Retirement store:
`C:\code\TagContactBridge-retired\2026-07-27-metrics-patch\` + manifest.

**This document replaces the parent's §3 build list.** Where they disagree,
this one wins — it was written after the gutting, against the actual tree.

---

## ⟳ STATE AT THE START OF BUILD-UP

The metrics realm was gutted 2026-07-27: ~7,800 lines removed, 14 whole
files retired, `nightlyCloseService.js` 3,955 → 1,047 lines. Nothing is
committed; nothing is deployed. **The control-plane restart is the cutover**
— running services still hold pre-gut code in memory.

Battery at start: **161 metrics/config · 76 lead-delivery · 11 hiring ·
web-client typecheck clean.** Any feature below must leave these green
(counts may only rise, or fall with a stated reason).

### What exists and works
| Capability | Where |
|---|---|
| Sheet import (SUCCESS + failed), duplicate-safe | `logicsPaymentsCsvImportService.js` |
| Gate, receipts, domain fingerprint | `paymentsSheetGateService.js` + `PaymentsSheetImport.js` |
| Profile truth-up per upload | `paymentsSheetReconcileService.js` |
| Deal math, sale-month attribution, vintage split | `simpleDealMathService.js` |
| The one read (range-native) | `simpleMarketingReadService.js` |
| Nightly email + WYNN slice | `simpleNightlyEmailService.js` + `templates/nightly/simple-close.hbs` |
| Activities → status counts | `activityStatusChangeRollupService.js` |
| Phone fold incl. spouse | `casePhoneFoldService.js` (wired into `leadQueueStatusRefreshService` only) |
| ST/FD branch, DISABLED | `leadSourceBranchService.js` |
| Logics thumbnail writer | `logicsSourceWriterService.js` |
| Month-end reconcile | `scripts/month-end-reconcile.js` |

### Known-incomplete, by design
- `casePhoneFoldService` populates `normalizedPhones`; **nothing reads it yet** (F2).
- `{domain, normalizedPhones}` index is **declared, not built** — lands on restart via syncIndexes.
- Report generator: **design only, zero code** (F3).
- 7 metrics dashboard panels are **already orphaned** (no importer) — see F0.4.

---

## FEATURE 0 — Make the restart safe and verifiable
Nothing below is provable until the control plane restarts. Do this first.

**0.1 `.env` — add/edit on BOTH local and Linux.** None of these keys exist
today except `LOGICS_ACTIVITY_REVIEW_HOUR` (pinned to 7).
```
LOGICS_PAYMENTS_CSV_IMPORT_ENABLED=true    # upload route 404s without it
LEAD_DELIVERY_STATUS_MAX_AGE_HOURS=24      # arms the freshness gate (~25 leads held = 0.3%)
LOGICS_ACTIVITY_REVIEW_HOUR=20             # EOD move; currently 7
SIMPLE_NIGHTLY_EMAIL_ENABLED=true          # the new email IS the email now
NIGHTLY_CLOSE_SEND_EMAIL=false             # legacy path is gone; leaving true only sends ops mail
SIMPLE_NIGHTLY_WYNN_RECIPIENTS=<list>      # optional; unset = WYNN slice skipped
```
Leave `LEAD_SOURCE_BRANCH_ENABLED` absent/false until Logics sources 57/76 exist.
Guard already in code: `sameDay` derives from the run hour (≥12 → today), so a
forgotten HOUR=7 keeps yesterday-semantics rather than a broken window.

**0.2 Build `scripts/post-restart-smoke.js`** — NEW, read-only, no writes.
Asserts, in order, printing PASS/FAIL per line:
1. `require("../packages/shared-services/src")` loads.
2. `CaseProfile` collection has an index on `{domain, normalizedPhones}`
   (proves syncIndexes ran).
3. `evaluatePaymentsSheetGate({dateKey: today})` returns a shape with
   `holdMoney` and `holdSafetyWork === false`.
4. `buildSimpleMarketingSummary({domain:"ALL", from:today, to:today})`
   returns `totals.cashCollected` and `totals.cashBreakdown`.
5. `listFailedPayments({from, to})` and `listLongCalls({dateKey})` return arrays.
6. `listLongCalls` result contains **no** row with `platform === "ex"`.
7. Activity day JSON exists at
   `runtime/logics-activity-review/logics-activity-review-ALL-<today>.json`
   with `processed.statusChangeCounts` (WARN not FAIL if the 20:00 run
   hasn't happened yet).
Exit non-zero on any FAIL.
VERIFY: run it before the restart (expect index + activity FAILs), and after
(expect all PASS).

**0.3 Restart** — Mickey only, UAC. Order: control plane → watch first
hourly sweep log → 20:00 activity review → upload both sheets → gate
`ready=true` → 21:00 close. Then run 0.2 again.

**0.4 Retire the 7 orphaned dashboard panels.** VERIFIED 2026-07-27: nothing
imports them; `MetricsWorkspace.tsx` imports only `AttributionReviewPanel`
and `PaymentsCsvImportCard`. Copy to the retirement store, then delete:
`CallrailPanel.tsx` `DailyPulsePanel.tsx` `DailySummaryPanel.tsx`
`FixedCostsPanel.tsx` `MailCostsPanel.tsx` `RedlinesPanel.tsx`
`SourcesPanel.tsx`. Then check whether their query hooks in
`apps/web-client/src/lib/api/queries/metrics.ts` (`useMetricsPulse`,
`useMailCosts`, `useRedlines`, `useCallrail`, `useDailySummary`,
`useMetricSources`) still have callers; retire the orphans and, if a hook's
only consumer was a deleted panel, retire its `readMetrics.js` route too.
VERIFY: web-client typecheck clean; `readMetrics.js` still loads.

---

## FEATURE 1 — Close the daily loop (sheet-triggered, two-stage send)
The pieces exist; nothing orchestrates them. Today only the clock fires.

**1.1 Sheet-triggered activities pull.**
FILE: `apps/control-plane/src/routes/metrics.js`, inside the
`POST /payments-csv/:domain` handler, AFTER `recordPaymentsSheetImport`.
LOGIC: if `readPaymentsSheetStatus({dateKey}).ready === true` AND today's
activity review has not run → fire
`runLogicsActivityReviewBatch({ dateKey: today })` **async (do not await the
response on it)** with a run-once guard.
GUARD: a tiny collection `ControlPlaneDailyLoopRun` keyed `{dateKey}` with
`activitiesFiredAt`, or runtime state on the router — collection preferred so
a process restart cannot double-fire.
RULE: a failure here must NOT fail the upload (wrap in try/catch, report in
the response as `activitiesTriggered: {fired, reason}`).
VERIFY: new test asserting (a) not fired when gate not ready, (b) fired once
when it flips ready, (c) not re-fired on a third upload.

**1.2 Non-sourceable alert email (to Mickey only).**
NEW FILE: `packages/shared-services/src/unsourcedAlertService.js`.
EXPORTS: `listUnsourcedDeals({from, to})`, `sendUnsourcedAlert({dateKey, recipients, logger})`.
CONTENT: window deals whose resolved source is missing — reuse
`resolveDealSource(...).missing === true` from `simpleDealMathService`, plus
`sourceConflicts` from the reconcile pass. Include caseId, client, domain,
amount, date, and what each side said.
MUST run AFTER Feature 2's rescue once that exists (see 2.4).
RECIPIENTS: `UNSOURCED_ALERT_RECIPIENTS`, default `mgray@taxadvocategroup.com`.

**1.3 Two-stage send.**
FILE: `apps/control-plane/src/services/nightlyCloseRuntime.js`, at the
`emailMode.mode === "simple"` block (~line 318).
LOGIC: if unsourced count > 0 AND not past the deadline → send the ALERT,
record `awaitingRectification: true`, DO NOT send the summary yet.
Summary sends when either (a) the faceplate "send now" action fires, or
(b) `SIMPLE_NIGHTLY_SEND_DEADLINE` (default `22:00`) passes — in which case
the summary goes with an "N unsourced" line in the narrative.
RULE: **a night is never silently skipped.** If neither path fires by
midnight, log an error-level event.
NEW ROUTE: `POST /api/metrics/nightly/send-now` (admin) → sends the held summary.
FACEPLATE: a button on the reconciliation card showing "N unsourced — resolve
or send now".
VERIFY: tests for held / deadline-released / manual-released; assert the
narrative carries the unsourced count when released with unsourced > 0.

---

## FEATURE 2 — Attribution rescue (finish the spouse work)
Point (Mickey): *"you can get spouse numbers because sometimes the
attribution is behind spouse numbers."* Proven on case 415022: spouse cell
lives only in Logics, Logics' own FindCaseByPhone 404s on it, and an
unattributed outbound to it already sits in our call logs.

**2.1 Widen the fold's coverage.** `casePhoneFoldService.buildCaseProfilePhonePatch`
is wired only into `leadQueueStatusRefreshService`. Add it wherever a
`getCaseInfo` payload is already in hand. **Do NOT** add a getCaseInfo call
just to fold. **Do NOT** touch `cx*` files (§0.2 freeze) without asking.

**2.2 Backfill script** `scripts/backfill-case-phones.js` — NEW, dry-run
default, `--apply`, `--domain`, `--limit`. For cases with empty
`normalizedPhones`: getCaseInfo → fold → upsert. Report before/after counts.
Paced (the queue refresh already shows a safe concurrency of ~5).

**2.3 Rescue resolver.** NEW: `packages/shared-services/src/attributionRescueService.js`.
`rescueUnsourcedDeal({domain, caseId})`:
1. getCaseInfo → `foldCasePhones` → all six numbers.
2. Query `controlplanecalllogs` for INBOUND calls on any of those numbers.
3. If a match has a tracker/piece, that IS the source. Prefer the earliest
   inbound (the response call), and record which phone matched — spouse
   matches must be visible, not silent.
4. Return `{sourceName, matchedPhone, matchedVia: "primary"|"spouse", callId}`
   or null. **Never guess** — no match means no source.

**2.4 Wire rescue BEFORE the alert.** `unsourcedAlertService` (1.2) runs the
rescue first; only what survives reaches Mickey.

**2.5 Write-back.** A rescued source flows through
`logicsSourceWriterService.writeLogicsCaseSource` so Logics gets the
thumbnail too — not just our profile. Extend `LOGICS_SOURCE_REGISTRY` as
sources gain Logics ids.

VERIFY: unit tests with the 415022/394513 fixtures (already in
`tests/metrics/casePhoneFold.test.js`); a live dry-run reporting how many of
the current unsourced deals get rescued, and the spouse-vs-primary split.
BASELINE: 223 unmatched inbound numbers in a week; 90 both-generic legacy
cases are the stress cohort (ruling 6.3).

---

## FEATURE 3 — Custom report generator
Design is approved and closed: `CUSTOM_REPORT_GENERATOR_DESIGN_2026-07-27.md`.
Build in its §11 order. Non-negotiables from the design:
- CSVs are **ROI-style, SUCCESS-only**; failures/restatements/caveats live in
  the email BODY only.
- Primary slice is **LD vs everything** (`slice`), domain is secondary.
- Recipients are a **checklist roster**, not typed addresses.
- Ship two standing definitions: **"Financials"** (full picture) and
  **"LD sheet"** (same granularity, LD slice).
- Profit reads `cost not configured` until Logics CPLs exist. Never guess.
- Calls can never be split by company — those cells read `n/a (shared tenant)`.

**3.1** Extend the rollup with **deals-by-officer** (the one new aggregation).
FILE: `simpleMarketingReadService.buildSimpleNightlyPaymentRollup` — it
already emits `cashByOfficer`; add deal counts per officer from the same
groups. NOTE: officer only exists on sheet-touched rows, so this index is
thin until the daily import has history — that is expected, not a bug.
**3.2** NEW `packages/shared-services/src/reportBuilderService.js` — pure:
`buildReportTable({summary, index, slice})` → `{columns, rows}`. One function
per index; no DB access; fully unit-testable against fixtures.
**3.3** NEW `packages/shared-services/src/csvSerializerService.js` — UTF-8,
CRLF, header row, plain numbers (no `$`), dates `YYYY-MM-DD`. Test the Excel
quirks: embedded commas, quotes, leading zeros, negative amounts.
**3.4** NEW `packages/shared-services/src/reportEmailService.js` — narrative
(reuse `buildNightlyNarrative` scoped to the window) + inline HTML table +
CSV attachments via `mailerService.sendMail`. Verify the mailer's attachment
support before relying on it.
**3.5** NEW model `ControlPlaneReportDefinition` + `knownRecipients` roster.
**3.6** Routes (admin): `POST /api/reports/preview`, `POST /api/reports/generate`,
`GET|POST /api/reports/definitions`, `DELETE /api/reports/definitions/:id`.
**3.7** Faceplate card: index + window + slice + recipient checkboxes +
detail toggle + note; buttons Preview / Generate & email / Save.
**3.8** LIVE PROOF before any real recipient list: generate "July by source"
and "July by officer", Mickey eyeballs both.

---

## FEATURE 4 — Weekly rhythm
**4.1 Saturday loop** — same email over Mon..Sat. `buildSimpleMarketingSummary`
is already range-native; activities = sum of the week's day JSONs. Subject
`Weekly Close <from>..<to>`. Add weekday 6 under a weekly-mode flag in
`nightlyCloseRuntime` — do NOT duplicate the runtime.
**4.2 Weekly DNC purge** — Saturday, after the weekly email. Hard-delete
DNC-retired rows older than 7 days (the lag IS the undo window).
**JOIN SPEC (the trap, written out):** `metadata.retiredReason ===
"logics-dnc-status"` and `metadata.retiredAt < now-7d` live on
**leaddeliveryitems** where `caseId` is a **STRING**; cadence rows only carry
`active:false`. Select retired items → delete them → delete matching
`LeadCadence` **via the MODEL** with BOTH caseId forms
(`$or: [{caseId: Number(id)}, {caseId: String(id)}]`). A collection-name-string
write silently no-ops — proven 2026-07-24.
Dry-run default; Mickey approves the first live run; report counts in the
weekly email.

---

## FEATURE 5 — Recordings surface (front-end #2)
One faceplate card over the EXISTING `listLongCalls`. Date picker, agent
filter, listen links; linkless rows show `recordingStatus`. No player —
links open Drive.
**HARD RULE:** the PB/CallRail allow-list (`LONG_CALL_RECORDING_PLATFORMS`)
is the only source. EX recordings must never surface — ruling 6.1, "ex is
dangerous". Do not convert it to a deny-list; do not add a platform without
Mickey's ruling.
Content-blocked until PB archive completes (all PB rows currently read
"recording pending") — build the card anyway; it degrades honestly.

---

## FEATURE 6 — Hourly slimming
**6.1 Payment sweep scope-shrink.** `paymentReconcileService.js` (~line 552)
+ `caseProfileRepository.js` (~line 842, `findCaseProfilesDueForPaymentReconcile`).
Replace the all-profiles wheel (97k+, 250/domain/hr) with the union of:
(a) live `leaddeliveryitems` cases — states eligible / follow_up_wait /
review / provider_accepted / delivery_failed, **caseId is a STRING there,
coerce**; (b) existing `findRecentCaseProfilesForPaymentReconcile`;
(c) cases with a SUCCESS ledger row in the last 14 days.
New repo fn `findActiveLoopCaseIdsForPaymentReconcile(domain, limit)`. Keep
the 250 cap. Escape hatch `PAYMENT_RECONCILE_FULL_WHEEL=true`.
VERIFY: `tests/metrics/paymentReconcileScope.test.js`; log the live universe
size (expect ~10k → ~1–2k/hr).
**6.2 PhoneBurner calls hourly.** Census first:
`scripts/reconcile-phoneburner-daily-dial-calllog.js`,
`dailyDialCallLogAuditService`, `dailyDialCallLogProjectionService`,
`reconcilePhoneBurnerCallsForNightly`. Then schedule the pull hourly inside
the `callLogHygiene` lane; "sorting" = classify into the LD/Aged call buckets
the board already uses. Also chase the PB recording archive so Feature 5's
links fill.
**6.3 Legacy remnants** — reassess only after F6.1/6.2:
`metricsBackfillService` (1,182L; only `syncHourlyMetricsForDomain` survives,
used by call-log hygiene), `legacyContactActivityService` (426L; callLogService
+ hygiene), `marketingMoneyService` (40L; 4 live callers). All three are
genuinely live — surgery, not deletion, and only with a reason.

---

## STANDING RULES FOR EVERY FEATURE
1. Run the battery BEFORE and AFTER. Counts rise, or fall with a stated reason.
2. Retire, never delete — copy to
   `C:\code\TagContactBridge-retired\<date>-<patch>\` and add a manifest row first.
3. Back up any file before bulk surgery. A brace-matching cut broke
   `nightlyCloseService` once; line-based cutting against this codebase's
   column-0 closing-brace convention is the method that works.
4. A name appearing only in COMMENTS reads as "referenced" by naive scans —
   verify before concluding something is live.
5. Money-touching changes need the regression-proof pattern (§0.3 of the parent).
6. No live-data writes without Mickey's explicit go. Scripts default dry-run.
7. CX/RingCX frozen. `.orig` files untouched. Never restart services.
8. Ask one simple question at a time; never decide a business rule.

## OPEN ITEMS FOR MICKEY
- **F0.4**: confirm the 7 orphaned panels can be retired (they are already
  unimported — this is cleanup, not a feature change).
- **F3**: CPL feed — a faceplate config you maintain, or does Logics expose
  per-source cost via API?
- **F6.3**: whether the three legacy remnants are worth surgery at all, or
  simply left alone as working plumbing.
