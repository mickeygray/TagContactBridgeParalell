# METRICS + COACH PATCH — EXECUTION WORK ORDER (v2)
Date: 2026-07-27 · v2 = post-verification rewrite (every file/line reference
re-checked against the working tree this date)
Author: analysis session (Fable) · Executor: Opus session
Branch: `cx-round-2`, local Windows worktree, ~95 files uncommitted.
Companion docs: `CUSTOM_REPORT_GENERATOR_DESIGN_2026-07-27.md` (approved
design), `METRICS_REBOOT_HANDOFF_2026-07-24.md` (historical — superseded
where they conflict). Auto-memory: `metrics-simplification-doctrine.md`,
`deal-count-and-chargeback-doctrine.md`, `payments-csv-importer-fix.md`,
`lead-mgmt-audit-findings.md`, `dnc-bleed-root-cause.md`.

---

## ⟳ READ THIS FIRST — POST-COMPACTION / NEW-SESSION RE-ENTRY

If you are an AI session that just compacted, resumed, or started fresh:
this paragraph is your orientation. Read it, then act — do not re-derive.

**What is happening:** Mickey (mgray@) is shipping the METRICS + COACH
patch on branch `cx-round-2`. The money system was rebuilt so that
"metrics reported is tied to the payment sheet": he uploads TAG + WYNN
payment CSVs ~18:00 daily, a gate holds all money publishing until both
land, activities are pulled from Logics for status counts, and a
snapshot email (narrative + tiles + CSV-clean numbers) goes out nightly —
weekly on Saturdays. Everything is BUILT and TESTED but UNCOMMITTED on
the local Windows box (which runs LIVE ops — never restart services;
Mickey does, via UAC). The push to Linux happens as ONE commit when
Mickey says the patch is done.

**Your working model:** Fable sessions = meticulous analysis + maintaining
THIS guide. Opus sessions = execute FROM this guide ("save some fable
money"). Either way: this document is the contract. Update it when
rulings or code change; never contradict §0 doctrine; never decide §6-class
business questions yourself — ask Mickey one simple question at a time.

**Immediate state (2026-07-27):** ~95 files uncommitted (inventory §1);
battery 173+76+11 green; control-plane restart PENDING (Mickey/UAC);
July month-end apply STAGED not applied (§3.4); the last days of July are
the live TEST WINDOW for everything (§3.12 is the acceptance gate);
August 1 is the clean-cost cutover (ST/FD + CPL, Wave C).

**Your first moves after reading this:**
  1. Skim §0 (rules), §1.5 (live actions already performed — never repeat),
     §6 (rulings ledger — all settled, quotes are Mickey's).
  2. `git status --porcelain | head -50` to confirm the tree still matches §1.
  3. Run the §5 battery before AND after anything you change.
  4. Then continue whatever §2/§3 item Mickey points you at — or if he
     hasn't, report readiness and ask which item to take.

**Hard do-nots, condensed:** no service restarts · no live-data applies
without an explicit go · CX/RingCX untouchable · `.orig` files untouchable ·
no `leadDeliveryRuntime.test.js` in sweeps · EX recordings never surface ·
money doctrine in §0.1 is settled law · numbers in this doc drift — verify
shape, not digits.

Companion truth: `CUSTOM_REPORT_GENERATOR_DESIGN_2026-07-27.md` (approved
design, all questions closed) · auto-memory files listed in the header.

---

## 0. RULES OF ENGAGEMENT (violating any of these is a failed execution)

### 0.1 Doctrine — never contradict
- Deals count SALES; a chargeback never reduces a deal count
  (`simpleDealMathService.js` → `initialDealCount = positiveInitialCount > 0 ? 1 : 0`).
- ALL initial-typed money attributes to the case's FIRST positive initial —
  installments AND chargebacks (`attributePaymentsToSaleWindow`). Recurring
  stays in the month collected.
- Payment Type (Initial/Recurring) is the split. The sheet's `Tag` column is
  human entry — stored in `raw.csv.tag`, NEVER drives logic.
- Sheet Payment Status is binary: anything non-SUCCESS is a failed payment,
  PENDING included; only a blank status is skipped.
- Cash headlines money; sale-attributed totals shown, never headlined.
  `cashCollected` ties to the LEDGER (→ Logics only after the daily sheet
  import). Never claim it "ties to the bank".
- Metrics reported = the payment sheet. The hourly API payment sweep is a
  tripwire (same-day converted detection + failure reviews); its dollars
  never headline.
- FORWARD-ONLY: never rename existing `ABC` sources, never rewrite
  historical attribution, never encode the re-contact capture rule into
  historical data. Pre-August history reports as-is.
- The payments-sheet gate holds MONEY only. `holdSafetyWork` is hardcoded
  `false` in `paymentsSheetGateService.evaluatePaymentsSheetGate` —
  DNC/lead-status work is NEVER gated by a missing sheet.
- Suppressions fail closed: split tender suppresses only on proof of exactly
  one distinct day; the domain fingerprint rejects clear mis-picks and passes
  only unknown/ambiguous files.
- EX recordings NEVER surface (ruling §6.1): allow-list
  `LONG_CALL_RECORDING_PLATFORMS = ["phoneburner","callrail"]` in
  `simpleMarketingReadService.js`. Never convert to a deny-list.
- CSVs are ROI-style — SUCCESS-only. The full picture (failures,
  restatements, caveats) belongs to email BODIES only (design doc §4).

### 0.2 Operational constraints
- CX/RingCX is UNTOUCHABLE this patch (Mickey: "we will keep cx for now …
  no need to jerk on those wires") — no removals/refactors/cleanup in
  `cx*`/`ringcx*` services, routes, or workspaces.
- This box runs LIVE ops (:5001/:3001, 8 Manual-start nssm services).
  Never restart or start services; Mickey does (UAC).
- No live-data applies without Mickey's explicit go. Every script defaults
  dry-run; keep it that way.
- `.orig` files: do not delete, do not commit.
- **RETIRE, NEVER DELETE** (Mickey, 2026-07-27: "we should retire code and
  not delete it" / "move it out of the deployed repo but keep it on my
  computer"). Removed files are copied to
  `C:\code\TagContactBridge-retired\<date>-<patch>\` (a SIBLING of the
  repo — never inside it, never deployed) with an entry in that folder's
  `RETIRED-MANIFEST.md` saying what it was and why it went. Only then
  remove from the working tree.
- Never run `tests/lead-delivery/leadDeliveryRuntime.test.js` in a sweep
  (pre-existing hangs); use the §5 battery exactly.
- Numeric claims in this doc (test counts, apply counts, line numbers)
  drift with a live repo — re-verify before relying on an exact number;
  compare SHAPE, not digits.

### 0.3 Money-touching edits require the regression-proof pattern
Reconstruct the pre-change behavior in a scratchpad copy and show the new
tests FAIL against it before trusting them. Precedent:
`tests/metrics/logicsPaymentsCsvImport.test.js` (4 of 6 failed vs the
pre-fix importer; 2 controls passed both).

---

## 0.5 ARCHITECTURE THESIS (Mickey, verbatim — steers every priority call)

> "The app is a storage container of the data from those two sheets and a
> logics writer for the thumbnail and a way to generate summary emails over
> any time frame."

  a) STORE the two daily sheets — payments CSV + activities. Ingestion
     quality is the product.
  b) WRITE the thumbnail to Logics — source names (ST/FD), corrections.
     EXISTS: `logicsSourceWriterService.js` (`writeLogicsCaseSource`,
     `LOGICS_SOURCE_REGISTRY`: TAG "Urgent Third State"→73, pink
     tracker→74; CLI `scripts/write-logics-case-source.js`; mirrors
     CaseProfile). Extend, never duplicate. Lead COSTS are hand-entered in
     Logics by Mickey (~3s each) — we never post dollar amounts.
  c) GENERATE summary emails over ANY timeframe.
     `buildSimpleMarketingSummary({from,to})` is range-native; the email
     layer must stay range-native too.
  d) THE METRICS PAGE IS NOT A PRODUCT ("they don't want to look at that
     page so I shouldn't make them"). No dashboard investment — emails +
     CSVs + the faceplate.

## 0.6 FRONT-END SCOPE — exactly five surfaces, nothing else gets UI work

  1. COACH + TRAINER — `apps/web-client/src/workspaces/trainer/
     SalesTrainerWorkspace.tsx` (patch co-headliner; §3.13).
  2. CALL RECORDINGS — listening surface, PB/CallRail only (§3.14).
  3. RECONCILIATION FACEPLATE — `apps/web-client/src/workspaces/metrics/`:
     `PaymentsCsvImportCard.tsx` (upload + gate), `AttributionReviewPanel.tsx`
     (reviews/exceptions), plus non-sourceable resolution (§3.7).
  4. CUSTOM REPORT GENERATOR — per approved design doc; index + slice
     (LD vs everything) + timeframe → email with ROI-style CSV attachments.
  5. CX WORKSPACE — frozen as-is (0.2).

Cost + profit reach other people through #4 (email is the format "they
will deal with"). Profit computable only once Logics CPLs exist — until
then the cell reads `cost not configured`, never a guess.

---

## 1. STATE — DONE, ON DISK, UNCOMMITTED. DO NOT REDO.

Battery at v2 time: **173 metrics/config + 76 lead-delivery (safe batch) +
11 hiring = 260 green; web-client typecheck clean.**

### 1.1 New services (all in `packages/shared-services/src/`)
| File | What it is |
|---|---|
| `simpleDealMathService.js` | deal math: gross deals, sale-month attribution, split tender, reversal helpers |
| `simpleMarketingReadService.js` | THE read: board/summary, cashBreakdown (vintage), cashByOfficer, byDomain, dealsBySourceByDomain, `listLongCalls` (allow-list), SOURCE_ALIASES |
| `simpleNightlyEmailService.js` | narrative (3 sentences), complete-snapshot email data, WYNN-only slice builder, dual send, `readActivityStatusCounts` |
| `logicsPaymentsCsvImportService.js` | sheet importer: duplicate-safe, txn-id-first, status-salted failed-payment ingestion, all 21 columns → `raw.csv` |
| `paymentsSheetGateService.js` | gate + receipts + `verifyPaymentsCsvDomain` fingerprint + `describePaymentsCsv` |
| `paymentsSheetReconcileService.js` | per-upload profile truth-up: creates/fills, never overwrites real sources, rollups via `caseProfilePaymentSync.processCandidateCase` |
| `activityStatusChangeRollupService.js` | Activities → status-change counts by catalog, final-status-of-day |
| `leadSourceBranchService.js` | ST/FD branch (DISABLED), env-extendable matrix, `isBranchedDataLeadSource` |
| `leadQueueStatusRefreshService.js` | queue-wide Logics status refresh + DNC retirement (nightly) |
| `logicsSourceWriterService.js` | the Logics thumbnail writer (see 0.5b) |
| `callrailDailyStatSyncService.js`, `dailyDial*Service.js` | call feeders (pre-existing this branch, ride along) |
| `paymentMetricsReviewService.js` | payment exception scanner (windows identically to the board) |

### 1.2 New models / templates / scripts / tests
- `packages/shared-models/src/PaymentsSheetImport.js` (receipts; unique
  {domain, dateKey}) — exported from models `index.js`.
- `packages/shared-templates/src/templates/nightly/simple-close.hbs` —
  narrative block, tiles, deals-by-source, status-change table, officers,
  long calls, restatements, by-company.
- Scripts: `month-end-reconcile.js` (dry-run default), `write-logics-case-source.js`,
  `scan-payment-metrics-reviews.js`, `sync-callrail-daily-stats.js`,
  PB call-log audit/reconcile/repair trio, hiring + cx-chris investigation
  tools (ride-along).
- Tests (tests/metrics/ + tests/config/): 20+ new/updated suites — see §5.

### 1.3 Key modifications
| File | Change |
|---|---|
| `apps/control-plane/src/routes/metrics.js` | upload route: fingerprint 409, reconcile pass, receipt, gate in response; legacy-mirror/backfill routes REMOVED |
| `apps/control-plane/src/server.js` | per-domain DNC policy via `dncStatusIdsForDomain` (statusMap) |
| `apps/control-plane/src/services/logicsActivityReviewRuntime.js` | `sameDay` dateKey (hour-aware), hour default 20 |
| `packages/shared-config/src/index.js` | activity review hour 20 + `sameDay` (defaults from run hour ≥12 — protects the pinned `.env` HOUR=7) |
| `packages/shared-config/src/statusMap.js` | `dncStatusIdsForDomain()` (TAG=[39,173], WYNN=[173], AMITY=[]) |
| `packages/shared-repositories/src/paymentLedgerRepository.js` | csv-authority guard; twin absorption follows incoming `transactionStatus` |
| `packages/shared-services/src/nightlyCloseService.js` | payments-sheet gate at top of `runGroupedNightlyClose` (money holds, safety never); `leadQueueStatusRefresh` wired |
| `packages/shared-services/src/inboundIntakeService.js` | `extractLeadLien` + ST/FD branch call (inert while flag off); LD ×$3 realtime tick REMOVED |
| `packages/shared-services/src/leadDeliveryService.js` | `DEFAULT_DNC_STATUS_IDS=[173]` floor, freshness gate (env-armed; no-profile leads held once armed) |
| `packages/shared-services/src/fillerPoolRefreshService.js` | stranded-checkpoint fix (null/missing `nextAt` past first checkpoint, guarded by `count < 3`) |
| `packages/shared-services/src/logicsActivityReviewService.js` | `statusChangeCounts` in processed + email lines (single + batch) |
| `packages/shared-integrations/src/anthropicClient.js` | `modelRejectsSamplingParams` `/claude-[a-z]+-5(?!\d)/` — do NOT "simplify" |
| `packages/shared-services/src/metricsBackfillService.js` | `backfillLegacyMetricsRange` excised |
| trainer files (`SalesTrainerWorkspace.tsx`, `salesTrainer.ts`, `taxResolutionSalesTrainerService.js`, `routes/salesTrainer.js`) | coach send flow + UI (Codex + session work) |

### 1.4 RETIRED (already done — do not resurrect; originals in the retirement store
`C:\code\TagContactBridge-retired6-07-27-metrics-patch\` + manifest)
`legacyLeadCadenceService.js` (zero callers; only reader of the trap
`leadcadences` collection), `legacyMetricsMirrorService.js`,
`legacyAttributionSyncService.js`, `scripts/backfill-legacy-metrics.js`,
4 admin routes (`/legacy-mirror/status|sync`, `/legacy-attribution/sync`,
`/backfill/:domain`), `backfillLegacyMetricsRange`.
Retired 2026-07-27 (Opus, this session): `legacyClientService.js` (95L, zero
refs) and `legacyMetricsService.js` (707L) — the latter's only consumer
gated it behind `legacyMetricsFallbackEnabled()`, which was **hardcoded
`return false`**, so all 7 fallback branches in `frontendReadService` were
provably dead; those branches and the gate came out too (2210 → 2174 lines).
Battery + web-client typecheck green after.

### 1.5 Live-data actions already performed (do not repeat)
- 2026-07-24 DNC cleanup: 9,080 statuses refreshed, 479 DNC retired, 114
  checkpoint-scrubbed (37 national-registry drops), 0 stranded after.
- Initials-only CSV applies: TAG/WYNN 2026-07-24 files → 1 insert
  (Fombah Sirleaf $950, synthetic cpid −99278794).
- NOT YET APPLIED: the full-export month reconcile (§3.4/§3.12).

---

## 2. PHASE OUT — three waves, each step gated

### Wave A — now
- A1 `ldSpendService.js`: intake tick already removed; FILE STAYS until B4
  (nightly legacy emails still read its estimators). Action: none.
- A2 `scripts/phoneburner-july-preload.js`: KEEP through the July test
  window (ruling 6.2); deletion decided at EOJ sign-off (§3.12.4).

### Wave B — blocked on the EMAIL CUTOVER FLIP
Flip (Mickey, one evening): `.env` → `SIMPLE_NIGHTLY_EMAIL_ENABLED=true`,
`NIGHTLY_CLOSE_SEND_EMAIL=false`, optionally `SIMPLE_NIGHTLY_WYNN_RECIPIENTS`.
`resolveNightlyEmailMode` fails safe on both-on (mode off + conflict flag).
After ONE clean simple-email night, in order (each step: delete →
`node --check` → §5 battery → next):

| Step | Remove | Keep / caution |
|---|---|---|
| B1 | `runMetricsRefresh` in `hourlySweeperService.js` (fn @~605, call @~1131) + `hourlyMetricsRefreshService.js` + env `HOURLY_METRICS_REFRESH_ENABLED` | — |
| B2 | `metricsBackfillService.js` `syncHourlyMetricsForDomain` + snapshot-rebuild half | KEEP pieces `hourlyCallLogHygieneService` uses (grep first — hygiene stays) |
| B3 | `vendorNightlyEmailService.js`, `vendorDailySummaryService.js`, `marketingCaseDiscoveryService.js`, their `nightlyCloseService` call sites (`buildVendorReport`, vendor blocks of `runGroupedNightlyClose` / `sendFinancialCloseEmail`), routes `/vendor-summary/:domain`, `/vendor-nightly/*` | "Payments that didn't process today" MUST survive — re-point at ledger non-SUCCESS rows (sheet-fed) or fold into the simple email FIRST |
| B4 | `ldSpendService.js`, `nightlyCloseService.ldFamilyEstimatedCost` + `buildLdCostSummary`, `scripts/backfill-ld-spend.js`, `scripts/audit-june-metric-reconcile.js`, tests `ldSpendService.test.js` + `ldLeadSpendTick.test.js` | verify no other callers first |
| B5 | `marketingMoneyService.js` email-facing rollups | census `grep -rn "marketingMoney" --include=*.js apps packages` — keep what `controlPlaneEventService` uses |
| B6 | `MetricsSnapshot` model + `rebuildMetricSnapshots` if B2 orphaned them | grep readers; simple board never reads snapshots |

Exit: `grep -ri "vendorNightly|vendorDailySummary|hourlyMetricsRefresh|ldSpend"`
→ comments only; battery green; one more clean night.

### Wave C — after Mickey creates Logics sources 57/76
- C1 `.env` `LEAD_SOURCE_BRANCH_ENABLED=true` — wiring already live.
- C2 Smoke: first branched post lands in Logics as `ABC ST`/`ABC FD`;
  board buckets it LD.
- C3 Registry consolidation: `LOGICS_SOURCE_REGISTRY` (source writer) and
  `LEAD_SOURCE_BRANCH_MATRIX` (branch service) are two hand-maintained maps
  that must agree (73/74 today; 57/76 join). Fine at 4 entries; consolidate
  into one module if it grows past ~10.

---

## 3. BUILD — SUPERSEDED

**The gutting happened 2026-07-27 (~7,800 lines out) and this §3 list was
written before it. The current build plan is
`BUILD_UP_WORK_ORDER_2026-07-27.md` — Features 0-6, written against the
post-gut tree. Where the two disagree, the build-up order wins.**

§0 (rules of engagement), §0.5 (thesis), §0.6 (front-end scope), §5
(battery) and §6 (rulings ledger) in THIS document remain binding.

Historical §3 list follows for provenance only:

### 3. BUILD — WHY / WHERE / WHAT / VERIFY per item

### 3.1 Payment sweep scope-shrink
WHY: `reconcilePaymentsForDomain` round-robins ALL 97k+ CaseProfiles
(stale-after 1h, cap 250/domain/hr) for facts the sheet now owns.
WHERE: `paymentReconcileService.js:552`, `caseProfileRepository.js:842`
(`findCaseProfilesDueForPaymentReconcile`).
WHAT: universe → union of (a) live `leaddeliveryitems` cases (states
eligible/follow_up_wait/review/provider_accepted/delivery_failed —
caseId is a STRING there, coerce), (b) existing
`findRecentCaseProfilesForPaymentReconcile`, (c) cases with a SUCCESS
ledger row in the last 14 days. New repo fn
`findActiveLoopCaseIdsForPaymentReconcile(domain, limit)`. Keep the 250
cap. Escape hatch `PAYMENT_RECONCILE_FULL_WHEEL=true` restores today.
VERIFY: `tests/metrics/paymentReconcileScope.test.js` (query shape);
live dry count logged (expect ~10k→~1–2k/hr); battery green.

### 3.2 EX legs — DONE (ruling §6.1). Allow-list only. No action.

### 3.3 Cost-at-post mirror — OPTIONAL, default OFF
Only if Mickey supplies values: `branchMatrix` entries may carry
`costPerLead`; branched post writes a SpendEntry (channel lead-data).
Logics carries cost; ours would only mirror. No dollars written today.

### 3.4 Month-end apply runbook (execution)
```
node scripts/month-end-reconcile.js --domain TAG  --file <export.csv>          # dry
node scripts/month-end-reconcile.js --domain TAG  --file <export.csv> --apply  # Mickey's go
```
Reference dry (2026-07-24 TAG file): 49 inserts / 226 stamps / 29 profiles
/ 44 source fills / fingerprint TAG@1.0 — counts DRIFT daily (hourly sweep
writes); always re-dry immediately before apply, compare shape not digits.
WYNN needs its own export. AMITY has no export path — stays unreconciled,
never faked.

### 3.5 Spouse-phone recall → ATTRIBUTION RESCUE (recipe proven)
POINT (Mickey): "you can get spouse numbers because sometimes the
attribution is behind spouse numbers." Household mail → spouse calls the
tracker → case created under the primary → deal reads unsourced.
PROOF (live, 2026-07-27): case 415022 — Barbara's cell exists ONLY in
Logics case fields (`SpouseCellPhone`); `FindCaseByPhone` on it → 404
(primary → instant hit); our `normalizedPhones` is EMPTY (even the
primary!) and UNINDEXED; an unattributed outbound to her number already
sits in calllogs (case=null). Case 394513 (Nevel) same shape.
BUILD:
  a) DONE 2026-07-27 (Opus): `CaseProfile.js` index
     `{ domain: 1, normalizedPhones: 1 }` + new `spouse.workPhone` field
     (Logics returns SpouseWorkPhone; we had no slot). **The index is
     declared, NOT yet built on Atlas — it lands via syncIndexes on the
     next control-plane restart (§4.3).**
  b) PARTIALLY DONE 2026-07-27 (Opus): new pure module
     `casePhoneFoldService.js` (`foldCasePhones`,
     `buildCaseProfilePhonePatch`, `normalizePhone`) — folds all six
     phones, primary-first, deduped; spouse stays NULL when Logics reports
     none so a fold can never blank another writer's data; patch omits
     keys it has nothing to say about. WIRED into
     `leadQueueStatusRefreshService.js` (nightly queue = zero extra API).
     Cover: `tests/metrics/casePhoneFold.test.js` (8, real Logics
     fixtures). STILL TO WIRE: `paymentsSheetReconcileService.js` (sheet
     cases — note it does NOT currently call getCaseInfo, so this needs a
     lookup or a different hook) and the `cxWorkspaceService` case-parse
     (0.2 freeze: add the fold only, no refactor).
  c) ATTRIBUTION RESCUE, runs BEFORE the §3.7 alert: unsourced deal →
     getCaseInfo → six phones → match inbound calls (calllogs first,
     CallRail per-call API if needed) → matched call's tracker IS the
     source.
  d) WRITE-BACK through `logicsSourceWriterService.writeLogicsCaseSource`
     (registry, §2.C3) — Logics gets the thumbnail, not just our profile.
VERIFY: unit tests for the fold (six-phone union, string coercion);
baseline 223 unmatched inbound numbers/week — re-run rescue scan after
backfill, report recovered count.
STRESS TEST (ruling 6.3): the 90 both-generic legacy cases are the rescue
cohort — deep-dig each (six phones → activities → calllogs → CallRail
per-call API; push the API lookups to their limits), report
found/unfindable split; label whatever survives AFTER the dig, not before.
Part of the July test window.

### 3.6 Sheet-triggered EOD loop
FLOW: Mickey uploads BOTH sheets ~18:00 → gate ready → THEN activities
pull + close. Clock = fallback (20:00 review + 21:00 close stay).
WHERE: upload route (`routes/metrics.js` payments-csv handler), after
`recordPaymentsSheetImport`.
WHAT: if `readPaymentsSheetStatus({dateKey}).ready` && today's review has
not run → fire `runLogicsActivityReviewBatch({ dateKey: today })` async +
run-once guard (runtime state or tiny collection).
VERIFY: upload second sheet → review fires once; third upload → no re-run;
day JSON exists with `statusChangeCounts`.

### 3.7 Non-sourceable alert → rectify → send (two-stage close)
FLOW (Mickey): "send me an alert email about non sourceable cases and ill
do my best to manually rectify and then it goes out."
WHAT: (a) alert email to Mickey only: window's unsourced deals
(`resolveDealSource` missing=true, AFTER the §3.5 rescue) + reconcile
`sourceConflicts`. (b) summary send WAITS: faceplate resolve action
triggers it, or deadline auto-send (`SIMPLE_NIGHTLY_SEND_DEADLINE`, e.g.
22:00) with an "N unsourced" line. A night is never silently skipped.
WHERE: `simpleNightlyEmailService` + a small route + faceplate button.

### 3.8 Saturday weekly loop
WHAT: Saturday run producing the SAME email over the Mon..Sat window
(summary is range-native; activities = sum of the week's day JSONs).
Subject "Weekly Close <from>..<to>". Close `activeWeekdays` currently
1–5 — add 6 under a weekly-mode flag in `nightlyCloseRuntime`, not a
second runtime.

### 3.9 Weekly DNC purge (cadence is contact-only)
WHAT: Saturday, after the weekly email: hard-delete DNC-retired rows older
than 7 days. JOIN SPEC (the trap, written out): `metadata.retiredReason:
"logics-dnc-status"` + `metadata.retiredAt < now-7d` live on
LEADDELIVERYITEMS (caseId STRING); cadence rows only carry `active:false`.
Select retired items → delete them → delete matching LeadCadence via the
MODEL with BOTH caseId forms (`$or: [{caseId: Number(id)}, {caseId:
String(id)}]`) — a collection-name-string write silently no-ops (proven
2026-07-24). Dry-run default; Mickey approves the first live run; counts
into the weekly email ("N DNC rows purged"). 7-day lag IS the undo window.

### 3.9b Dead-status retirement (ruling 6.5 — ships OFF, flips Aug 1)
Extend `leadQueueStatusRefreshService.js`: alongside the catalog-DNC check,
retire queue leads whose status resolves to the donezo set (WYNN 172 "No
Money", 171 "Amount Too Low", 57 "BAD/INACTIVE" — resolve via the CATALOG,
never hardcode; add a `dead` category or explicit id set per tenant).
Mechanics identical to `retireDncLead` but `metadata.retiredReason:
"dead-status"` and counted SEPARATELY from DNC everywhere (nightly email,
weekly purge respects the same 7-day undo lag). Env flag
`DEAD_STATUS_RETIREMENT_ENABLED` default false; flips with Wave C for
August 1.

### 3.10 CUSTOM REPORT GENERATOR — design APPROVED, all questions closed
Design: `CUSTOM_REPORT_GENERATOR_DESIGN_2026-07-27.md`. CSVs + emails
(never xlsx). Six indexes over the existing summary read; slice = LD vs
everything (domain secondary); recipient CHECKLIST roster; standing defs
"Financials" (full picture) + "LD sheet" (same granularity, LD slice);
CSVs ROI-style SUCCESS-only, bodies full-picture; profit honest-blank
until Logics CPLs. Build order = design §11: officer deal-count extension
→ table builder → CSV serializer → email composer → routes + faceplate
card → live proof ("July by source" + "July by officer") for Mickey's
eyeball before any real recipient list.

### 3.11 PhoneBurner calls into the hourly
"We had a functioning at one point — bake those into the hourly and sort
them." Census first: `scripts/reconcile-phoneburner-daily-dial-calllog.js`,
`dailyDialCallLogAuditService`/`ProjectionService`,
`reconcilePhoneBurnerCallsForNightly` in `nightlyCloseService`. Then
schedule the PB pull hourly inside the `callLogHygiene` lane; "sorting" =
classify into the LD/Aged call buckets the board uses. Also chase the PB
recording archive (all PB long-call rows read "recording pending") so
§3.14 links fill.

### 3.12 END-OF-JULY MATCHING TEST (acceptance gate)
Jul 31/Aug 1, FULL exports (recurring + failed) both domains:
  1. Dry per domain, record counts.
  2. Apply on Mickey's go.
  3. Completeness proof — add `--verify` to `month-end-reconcile.js`
     porting the csv-vs-ledger per-case audit: 0 missing cases, 0 amount
     mismatches except documented rulings, exceptions == operator review
     queue. Named acceptance cases: 394513 (+$500 by design — split
     tender, CSV under-reports), 415022 (the healed $11,050 API miss),
     336405 (Kye — June and only June), 365360/409586/381862 (the three
     reversals).
  4. Freeze July into memory + this order after sign-off.

### 3.13 Coach — verification only, no construction
- Real call end-to-end after restart (`LIVE_COACH_ENABLED = true` in
  `SalesTrainerWorkspace.tsx`).
- `anthropicClient.js` sampling-params guard: do not touch.

### 3.14 Call-recordings listening surface (front-end #2 — added in v2)
One faceplate card over the EXISTING `listLongCalls` (allow-list enforced):
date picker + agent filter + listen links; linkless rows show recording
status. No player — links open Drive. Content-blocked only by §3.11's PB
archive completing.

---

## 4. DEPLOY

4.1 COMMIT (Mickey's go): everything EXCEPT `*.orig`. One snapshot on
`cx-round-2`. Ride-along untracked files are EXPECTED commits: cx-chris-*
+ `analyze-ringcx-websocket-har.js` (SUSPECT investigation),
hiring-seminar tooling + test, `docs/*.md`, `.ai/context/*.md`,
`logicsSourceWriterService.js` + its CLI. Suggested subject:
`Metrics+coach patch: sheet-authoritative money, EOD activities, snapshot email, loop cleanup`.

4.2 `.env` edits — SAME on local and Linux. None of these keys exist in
`.env` today except `LOGICS_ACTIVITY_REVIEW_HOUR` (pinned to 7):
```
LOGICS_PAYMENTS_CSV_IMPORT_ENABLED=true      # upload route 404s without it
LEAD_DELIVERY_STATUS_MAX_AGE_HOURS=24        # arms freshness gate (holds ~25 = 0.3%)
LOGICS_ACTIVITY_REVIEW_HOUR=20               # EOD move (currently pinned 7)
# cutover evening only:
SIMPLE_NIGHTLY_EMAIL_ENABLED=true
NIGHTLY_CLOSE_SEND_EMAIL=false
SIMPLE_NIGHTLY_WYNN_RECIPIENTS=<list>
# stays absent/false until Wave C:
LEAD_SOURCE_BRANCH_ENABLED=false
```
Guard note: `sameDay` defaults from the run hour (≥12 → today) — a
forgotten HOUR=7 keeps yesterday-semantics; no broken window either way.

4.3 Restart order: control plane (Mickey, UAC) → first hourly sweep log →
20:00 review (JSON `runtime/logics-activity-review/logics-activity-review-ALL-<today>.json`
contains `statusChangeCounts`) → sheet upload → gate `ready=true` →
21:00 close.

4.4 Smoke: POST a sheet → response has `fingerprint`/`reconcile`/`gate`;
close result has `paymentsSheetGate`; narrative line 1 shows real counts
(not "unavailable").

---

## 5. VERIFICATION BATTERY (after every step; counts move up or with stated reason)

```
node --test tests/metrics/*.test.js tests/config/*.test.js            # 173
node --test tests/lead-delivery/leadDeliveryService.test.js \
  tests/lead-delivery/leadDeliveryCadenceSource.test.js \
  tests/lead-delivery/controlPlaneLeadDeliveryWire.test.js \
  tests/lead-delivery/phoneBurnerJulyPreloadScript.test.js            # 76
node --test tests/hiringSeminarPhoneBank.test.js                      # 11
cd apps/web-client && npm.cmd run typecheck                           # clean
```

Suite inventory (tests/metrics + tests/config, all green at v2):
activityStatusChangeRollup(7) · callrailDailyStatSync ·
cashVsAttributedAndByCompany(5) · chargebackSaleMonthAttribution(8) ·
dailyDial×3 · dncStatusCatalog(5) · firstInvoiceInstallments(7) ·
leadSourceBranch(9) · logicsPaymentsCsvImport(10) · nightlyNarrative(9) ·
paymentLedgerMetricsTreatment · paymentLedgerTwinAbsorption(4) ·
paymentMetricsReviewService · paymentsSheetGate(10) ·
paymentsSheetReconcile(9) · simpleDealMathService(7) ·
simpleMarketingReadService · simpleNightlyEmailMode ·
splitTenderNotAnException(5) · metricClose ·
phoneBurnerNightlyReconciliation · ldSpend×2 (die in B4).

---

## 6. RULINGS LEDGER

SETTLED (Mickey, quoted):
- 6.5 "once we are counting cpl on incoming leads we can phase it out so
  probably turning it off for august" — donezo-status retention phases out
  WITH the August CPL cutover: build dead-status retirement (WYNN
  172/171/57 → same mechanics as DNC retirement, separate reason
  `dead-status`, never mixed into DNC counts), ship it FLAG-OFF, flip for
  August 1 alongside Wave C. Once every incoming lead carries a real cost,
  holding written-off inventory is measurable waste.
- 6.3 "those can be part of the expanded test of spouse digging deep into
  call records etc like push the limits of the api look ups and see if we
  can find solutions" — the 90 both-generic cases are the §3.5 rescue's
  STRESS-TEST COHORT, not a labeling question. Deep-dig each: all six
  phones, activities, calllogs, CallRail per-call API — find sources where
  findable. The Aged-vs-Unattributed label applies only to whatever
  survives unsourced after the dig.
- 6.2 "we can run tests on everything with the last few days of july" —
  the preload (and everything else) STAYS through the July test window;
  its deletion decision folds into §3.12 step 4 (EOJ sign-off).
- 6.1 "ex is dangerous. so recordings are callrail or phoneburner only."
  → allow-list, implemented + tested.
- 6.4 "I'll pull both payment sheets at 6 pm and upload them" → TAG+WYNN
  daily; gate default stands; AMITY honestly unreconciled.
- Report generator: recipients checklist; "Financials"/"LD sheet" standing
  defs; "csvs should be thought of as roi style reports … email bodies can
  be full picture"; "LD lives on wynn so the split is LD only and
  everything"; CPL hand-entered in Logics (~3s).
- Tag column: "Payment Type Initial vs Recurring is the correct split."
- Forward-only: "im not updating ABC to ABC ST that would back change a
  ton of stuff." / "again forward looking" (re-contact capture rule).
- Kye/vintage: "recurring installments on the first invoice … are not new
  clients. Kye is June and only June."
- Chargebacks: "update June metrics and not tax July metrics."
- Deals: "34 not 32 — Terrence Young cancels himself out."
- Split tender: "he's a $1000 initial that paid maybe 2 cards."
- Architecture verdict: "metrics reported is tied to the payment sheet"
  (hourly keeps lead-contact/calls/profiles only).

- 6.6 "we need an inventory. its sorta arbitrary but basically for
  automated contact twice a month for a few months" — 120 days STAYS.
  The aged pool IS the inventory, sized for its purpose (~2 automated
  touches/month × a few months ≈ 8 touches ≈ 120 days). Compliance is
  enforced by the 30/60/90 registry checkpoints, NOT the lifetime — never
  "fix" 120 in the name of compliance.

- 6.7 "the service depends on the presence of the sheets to run so like an
  if its not uploaded by this time dont do it at this time kinda thing" —
  the scheduled tick WAITS for the sheets; it does not run a report on
  half a day's inputs. Concretely: no sheets at 20:00 → skip WITHOUT
  claiming the day, re-check every interval, so a 21:00 upload still gets
  a full loop. The earlier "20:00 fallback runs regardless" design was
  WRONG and is retired — it consumed the day's run before the inputs
  existed. One exception, from the standing money/safety split: after
  `LOGICS_ACTIVITY_REVIEW_SHEET_DEADLINE_HOUR` (default 23:00 PT) the pull
  runs anyway, flagged `ranWithoutSheets`, because DNC / post-date status
  changes are SAFETY work and the payments gate holds money only.
  Decision lives in `dailyLoopService.decideScheduledActivitiesRun` (pure,
  tested); the runtime only supplies the hour.

OPEN: none — all rulings settled 2026-07-27.

---

## 7. CANONICAL REFERENCE MAP

| Question | Look in |
|---|---|
| Money read (board/email/reports) | `simpleMarketingReadService.js` |
| Deal/attribution math | `simpleDealMathService.js` |
| Sheet import | `logicsPaymentsCsvImportService.js` |
| Gate/receipts/fingerprint | `paymentsSheetGateService.js` + `PaymentsSheetImport.js` |
| Profile truth-up | `paymentsSheetReconcileService.js` |
| Activities counting | `activityStatusChangeRollupService.js` (+ review-service wiring) |
| Nightly email | `simpleNightlyEmailService.js` + `templates/nightly/simple-close.hbs` |
| Logics thumbnail writes | `logicsSourceWriterService.js` (+ CLI script) |
| ST/FD branch | `leadSourceBranchService.js` (+ intake wiring) |
| Status catalog / DNC ids | `shared-config/src/statusMap.js` |
| Month-end | `scripts/month-end-reconcile.js` |
| Report generator design | `CUSTOM_REPORT_GENERATOR_DESIGN_2026-07-27.md` |
| Doctrine history + traps | auto-memory files listed in the header |
