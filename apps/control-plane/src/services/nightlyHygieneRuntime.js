"use strict";

// THE NIGHTLY SERVICE — one loop, a list of hygiene chores.
//
// Mickey 2026-07-28: "we need one nightly service that does this and then
// report generator that lets me automate what report gets sent out … and then
// basically we will prepackage the logic for certain reports and then have a
// report designer and thats it." Plus: "this thing is part time report
// generator part time database sanitizer."
//
// The saved ReportDefinition still owns report shape, recipients, and its
// durable per-day send claim. This runtime owns the NIGHT: it performs the
// upstream corrections and invokes reportScheduleRuntime as its final task.
// That makes 19:50 cleanup -> 20:00 email one resumable run instead of two
// timers racing over partially-corrected data.
//
// Tasks are a registry, not a hard-coded sequence, because the whole point is
// that the next chore is a few lines rather than a fourth runtime. Each task:
//   · is individually gated by its own env flag (default OFF)
//   · reports what it WOULD do when its write switch is off
//   · fails the close into a Mongo-independent emergency email rather than
//     allowing a partly-corrected report to masquerade as success
//
// Ordering rule: every correction precedes report delivery. If the corrections
// finish before 20:00, the final task waits for 20:00; if they finish later, it
// sends immediately from the corrected result.

const {
  applySourceSanitization, pacificKey, planSourceSanitization,
} = require("../../../../packages/shared-services/src/logicsSourceSanitizerService");
const { createPassRetryDrainTask } = require("./passRuntimeFactory");
const { DailyLoopRun } = require("../../../../packages/shared-models/src");
const {
  HISTORICAL_REPAIR_MAX_AGE_DAYS,
} = require("../../../../packages/shared-config/src/dailyReportContract");
const {
  nightlyLookbackDateKeys,
} = require("../../../../packages/shared-services/src/dailyDialNightlyLookbackService");
const {
  checkpointNeedsRecovery,
  launchEmergencyNightlyClose,
  markNightlyCloseCompleted,
  markNightlyCloseStarted,
  readCheckpoint: readEmergencyCloseCheckpoint,
  sendEmergencyNightlyClose,
} = require("../../../../packages/shared-services/src/nightlyEmergencyCloseService");

// 19:50 PT. Mickey 2026-07-28 described the night in order: "source the deals,
// gather the call urls, create the night report for spend, honor any custom
// reports, wait til 7:50 and have a good night."
//
// The ORDER is the requirement: attribution must be sourced before any report
// reads it, or the board reports the day with tonight's deals unattributed.
// Running at 19:50 gives the pipeline ten minutes before its nominal 20:00
// delivery step. That also means
// the target day is TODAY — the day that just finished selling — which is how
// the old board always worked.
const DEFAULT_HOUR = 19;
const DEFAULT_MINUTE = 50;
const DEFAULT_POLL_MS = 5 * 60 * 1000;
// Superseded by the one-document DailyReportFact written from the canonical
// email build. Keep the legacy task readable for recovery/backfill, but never
// let a stale QUEUE_ROLLUP_ENABLED value reactivate its separate writer.
const LEGACY_QUEUE_ROLLUP_WRITES_ENABLED = false;
const HYGIENE_CLAIM_LEASE_MS = 45 * 60 * 1000;

// The current close is handled normally. The seven dates before it are the
// bounded repair window, so mailbox discovery and spend derivation both need
// eight inclusive date keys. Historical snapshot repair still excludes the
// current date before it recomposes anything.
function nightlyInvoiceRepairDateKeys(dateKey) {
  return nightlyLookbackDateKeys(dateKey, HISTORICAL_REPAIR_MAX_AGE_DAYS + 1);
}

// Distinguishes "another pass took this day" from "this chore threw". They land
// in the same catch and need opposite answers: a lost cursor must abort, because
// continuing would let two passes write the same night; a failed chore must not,
// because that is the whole promise of a task registry.
const CURSOR_LOST = "durable-cursor-lost";
const cursorLost = () => Object.assign(
  new Error("nightly hygiene durable cursor was lost"), { code: CURSOR_LOST },
);

// One bound per phase. A timeout follows the same fail-closed route as a thrown
// error: stop this report run and launch the Mongo-independent emergency close.
const DEFAULT_TASK_TIMEOUT_MS = 20 * 60 * 1000;
const TASK_TIMEOUT = "nightly-task-timeout";

function withTimeout(work, timeoutMs, { taskKey, phase } = {}) {
  const boundedMs = Math.max(1000, Number(timeoutMs) || DEFAULT_TASK_TIMEOUT_MS);
  let timer = null;
  return Promise.race([
    Promise.resolve().then(work),
    new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`${taskKey || "nightly task"} ${phase || "work"} timed out`);
        error.code = TASK_TIMEOUT;
        error.taskKey = taskKey || null;
        reject(error);
      }, boundedMs);
      timer.unref?.();
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

// ── RECONCILIATION TRIO WINDOWS AND CAPS ───────────────────────────────────
//
// All five of these exist because the three services were written for a pass
// that ran every hour. Their defaults are hourly-shaped and none of them was
// forwarded from the Phase A call site, so moving the work to one nightly run
// without restating them is how a job keeps its name and loses its coverage.

// 26h, not 24h. The window must OVERLAP the previous night's, or a session that
// arrives between one pass finishing and the next starting falls in the seam.
// The service floors sinceMs at 5 minutes and imposes no ceiling
// (ringcentralReconcileService:40), so a day-wide window is legal.
const SESSION_LOOKBACK_MS = 26 * 60 * 60 * 1000;

// 166 is an RC-CALL BUDGET, not a truncation boundary — an earlier version of
// this comment claimed the latter and was wrong.
//
// The mechanics: the service fetches `min(max(limit,1),500) * 3` rows
// (ringcentralReconcileService:63), the repository clamps that to 500
// (workflowRecordRepository:35), and the scan loop then breaks on the RAW limit
// (:90). So limit=500 would fetch the same ~500 rows and examine up to 500
// sessions — three times the coverage, no pagination required. The ×3 is a
// de-dupe buffer for repeated stage rows per session.
//
// What actually binds is RingCentral. Each session costs up to two call-log
// GETs, unpaced, and `fetchCallRecordWithRetry` is invoked with maxRetries:1,
// which makes the 429 back-off branch unreachable (ringcentralAttributionService
// :319 tests `attempt < maxRetries`). The first 429 therefore throws AND opens a
// process-wide circuit in the shared client, which would fail the rest of this
// pass, not just this task. 166 caps one domain at ~332 GETs. Raising it to 500
// triples coverage and triples that exposure; make that trade deliberately, and
// give the retry a real back-off first.
// The repository clamp is shared by nine callers — do not widen it.
const SESSION_SCAN_LIMIT = 166;

// 26h so the window overlaps the previous night's; a 6h default run once a day
// sees a quarter of the day.
const FIELDS_SYNC_LOOKBACK_HOURS = 26;

// DELIBERATELY LARGE, and it started out small for a reason that turned out to
// be backwards.
//
// staleCheckMs drives the LAST clause of the candidate query
// (caseProfilePaymentSyncService:290): `paymentReconcile.lastCheckedAt < now -
// staleCheckMs`. Setting it BELOW the run interval — 20h for a nightly pass —
// makes that clause match every profile in the domain, because every profile was
// last stamped a night ago. Measured against the live cluster: 93,076 of 93,076
// TAG profiles, 20,229 of 20,229 WYNN.
//
// That is not a wider audit, it is a broken one. The candidates are a union of
// two `distinct()` results with NO sort and no cursor, and the service takes
// `candidateIds.slice(0, cap)` (:561) — so the same head-500 case ids are swept
// every night forever and the tail is never reached. Worse, every case it
// touches gets `paymentReconcile.lastCheckedAt` stamped (:397/:438) even on the
// no-drift path, which does no Logics call at all — and payment-reconcile
// SELECTS on that same field, oldest-first. A degenerate sweep therefore stamps
// "Logics has been asked" onto hundreds of cases Logics was never asked about,
// pushing them to the back of reconcile's wheel.
//
// So the nightly pass targets CHANGE, not audit: 30 days leaves the stale clause
// matching only genuinely-neglected cases, and the two real drift signals — a
// PaymentLedger row written in the last 26h, and a CaseProfile touched in the
// last 26h (which includes everything payment-reconcile just wrote) — select the
// candidates. Those are exactly the cases whose derived fields can have moved.
//
// STILL BROKEN, and blocking the arm of this task: the `lastCheckedAt: null`
// clause matches every never-stamped profile regardless of this value, so the
// first armed nights are degenerate no matter what. Fixing that needs an ordered
// cursor in the service, not a constant here.
const FIELDS_SYNC_STALE_CHECK_MS = 30 * 24 * 60 * 60 * 1000;

// 40m, up from a 10m default the service never extends — runLockRepository
// exposes extendRunLock but this service never calls it, so a run longer than
// its TTL loses mutual exclusion. A stale lock now outlives the runtime's whole
// retry budget (3 attempts × 5-minute poll), which is why a lock-busy sweep of
// EVERY domain is reported as a failure below rather than as a quiet skip.
const FIELDS_SYNC_LOCK_TTL_MS = 40 * 60 * 1000;

// Read at call time, never cached, so the cap can be raised on a running box
// after a cycle has been observed. Separate functions on purpose: Phase A fed
// ONE maxCasesPerDomain to both services (hourlySweeperService:1125 and :1136),
// which meant any widening for the reconciler silently widened the fields sync
// too — and its own default is 500, so inheriting 10,000 would have multiplied
// it twentyfold without anybody choosing that.
const nightlyPaymentReconcileMaxCases = () => Math.max(
  1, Number(process.env.NIGHTLY_PAYMENT_RECONCILE_MAX_CASES) || 500,
);
const nightlyPaymentFieldsSyncMaxCases = () => Math.max(
  1, Number(process.env.NIGHTLY_PAYMENT_FIELDS_SYNC_MAX_CASES) || 500,
);

// ── CALL LOG HYGIENE, EVENING HALF ─────────────────────────────────────────
//
// Noon Pacific, so the evening pass covers 12:00 → now and the built MD2
// task in middayPassRuntime covers the previous evening → midday.
const HYGIENE_EVENING_ANCHOR_HOUR = 12;

// The service's preview lane asks for `limitPerDomain` rows per direction and
// the REPOSITORY then clamps to 500 (callLogRepository:386), newest-first. That
// clamp is not raisable from here — MAX_LIMIT_PER_DOMAIN of 20,000 in the
// service is an invitation to a widening that changes the preview by nothing.
// Kept at the service's own 200 default deliberately: the preview's operations
// are consumed only inside the legacy-mirror loop, which is empty (see the task
// comment), so every row it previews costs external lookups for a result that
// is discarded. Raising it buys cost, not coverage.
const HYGIENE_EVENING_LIMIT_PER_DOMAIN = 200;
const HYGIENE_PREVIEW_ROW_CLAMP = 500;

async function claimNightlyHygiene(dateKey, at = new Date()) {
  const leaseCutoff = new Date(at.getTime() - HYGIENE_CLAIM_LEASE_MS);
  try {
    const claimed = await DailyLoopRun.findOneAndUpdate(
      {
        dateKey,
        $and: [
          { $or: [
            { nightlyHygieneCompletedAt: null },
            { nightlyHygieneCompletedAt: { $exists: false } },
          ] },
          { $or: [
            { nightlyHygieneClaimedAt: null },
            { nightlyHygieneClaimedAt: { $exists: false } },
            { nightlyHygieneClaimedAt: { $lt: leaseCutoff } },
          ] },
        ],
      },
      {
        $set: { nightlyHygieneClaimedAt: at },
        $setOnInsert: { dateKey },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );
    if (!claimed) return null;
    return {
      claimedAt: new Date(claimed.nightlyHygieneClaimedAt || at),
      nextTaskIndex: Math.max(0, Number(claimed.nightlyHygieneNextTaskIndex || 0)),
      taskResults: Array.isArray(claimed.nightlyHygieneTaskResults)
        ? claimed.nightlyHygieneTaskResults
        : [],
    };
  } catch (error) {
    if (Number(error?.code) === 11000) return null;
    throw error;
  }
}

async function advanceNightlyHygiene(
  dateKey,
  claimedAt,
  nextTaskIndex,
  counts,
  taskResults = [],
  at = new Date(),
) {
  const result = await DailyLoopRun.updateOne(
    { dateKey, nightlyHygieneClaimedAt: claimedAt, nightlyHygieneCompletedAt: null },
    { $set: {
      nightlyHygieneClaimedAt: at,
      nightlyHygieneNextTaskIndex: nextTaskIndex,
      nightlyHygieneCounts: counts,
      nightlyHygieneTaskResults: taskResults,
      nightlyHygieneLastErrorCode: null,
    } },
  );
  const matched = result?.matchedCount ?? result?.n;
  const ok = matched == null ? result?.acknowledged !== false : Number(matched) === 1;
  return ok ? at : null;
}

async function renewNightlyHygiene(dateKey, claimedAt, at = new Date()) {
  const result = await DailyLoopRun.updateOne(
    { dateKey, nightlyHygieneClaimedAt: claimedAt, nightlyHygieneCompletedAt: null },
    { $set: { nightlyHygieneClaimedAt: at } },
  );
  const matched = result?.matchedCount ?? result?.n;
  const ok = matched == null ? result?.acknowledged !== false : Number(matched) === 1;
  return ok ? at : null;
}

async function finishNightlyHygiene(
  dateKey,
  claimedAt,
  nextTaskIndex,
  counts,
  taskResults = [],
  at = new Date(),
) {
  const result = await DailyLoopRun.updateOne(
    { dateKey, nightlyHygieneClaimedAt: claimedAt, nightlyHygieneCompletedAt: null },
    { $set: {
      nightlyHygieneCompletedAt: at,
      nightlyHygieneNextTaskIndex: nextTaskIndex,
      nightlyHygieneCounts: counts,
      nightlyHygieneTaskResults: taskResults,
      nightlyHygieneLastErrorCode: null,
    } },
  );
  const matched = result?.matchedCount ?? result?.n;
  return matched == null ? result?.acknowledged !== false : Number(matched) === 1;
}

async function claimNightlyRunSummary(dateKey, at = new Date()) {
  const claimed = await DailyLoopRun.findOneAndUpdate(
    {
      dateKey,
      $or: [
        { nightlyHygieneSummarySentAt: null },
        { nightlyHygieneSummarySentAt: { $exists: false } },
      ],
    },
    { $set: { nightlyHygieneSummarySentAt: at } },
    { new: true },
  );
  return claimed ? at : null;
}

async function releaseNightlyRunSummary(dateKey, claimedAt) {
  await DailyLoopRun.updateOne(
    { dateKey, nightlyHygieneSummarySentAt: claimedAt },
    { $set: { nightlyHygieneSummarySentAt: null } },
  );
}

function durableTaskResults(results = []) {
  return (Array.isArray(results) ? results : []).map((row) => {
    const applied = row?.applied || {};
    const safeApplied = {
      written: Number(applied.written || 0),
      skipped: Number(applied.skipped || 0),
      failed: Number(applied.failed || 0),
      repaired: Number(applied.repaired || 0),
      held: Number(applied.held || 0),
      attention: Number(applied.attention || 0),
      ncoaProcessed: Number(applied.ncoaProcessed || 0),
      ncoaSkipped: Number(applied.ncoaSkipped || 0),
      ncoaFailed: Number(applied.ncoaFailed || 0),
      invoiceProcessed: Number(applied.invoiceProcessed || 0),
    };
    if (Array.isArray(applied.reports)) {
      safeApplied.reports = applied.reports.map((report) => ({
        name: String(report?.name || "").slice(0, 100),
        delivered: Boolean(report?.delivered),
        agedSourceWrite: report?.agedSourceWrite
          ? {
              status: String(report.agedSourceWrite.status || "").slice(0, 30),
              written: Number(report.agedSourceWrite.written || 0),
              failed: Number(report.agedSourceWrite.failed || 0),
              deferred: Number(report.agedSourceWrite.deferred || 0),
            }
          : null,
      }));
    }
    if (applied.leadHealth) {
      const health = applied.leadHealth;
      const inventory = health.inventory || {};
      const attempts = health.attempts || {};
      const alerts = health.alerts || {};
      safeApplied.leadHealth = {
        inventory: {
          total: Number(inventory.total || 0),
          zeroTouch: Number(inventory.zeroTouch || 0),
          lowTouch: Number(inventory.lowTouch || 0),
          highTouch: Number(inventory.highTouch || 0),
          phaseOut: Number(inventory.phaseOut || 0),
          zeroTouchOlderThanToday: Number(inventory.zeroTouchOlderThanToday || 0),
          zeroTouchProviderHeld: Number(inventory.zeroTouchProviderHeld || 0),
          review: Number(inventory.review || 0),
          due: {
            zeroTouch: Number(inventory.due?.zeroTouch || 0),
            lowTouch: Number(inventory.due?.lowTouch || 0),
            highTouch: Number(inventory.due?.highTouch || 0),
            phaseOut: Number(inventory.due?.phaseOut || 0),
          },
        },
        attempts: {
          total: Number(attempts.total || 0),
          firstTouches: Number(attempts.firstTouches || 0),
          lowTouch: Number(attempts.lowTouch || 0),
          highTouch: Number(attempts.highTouch || 0),
          phaseOut: Number(attempts.phaseOut || 0),
        },
        alerts: {
          staleZeroTouch: Boolean(alerts.staleZeroTouch),
          zeroTouchDue: Boolean(alerts.zeroTouchDue),
          lightWorkBacklog: Boolean(alerts.lightWorkBacklog),
          highTouchWhileLightDue: Boolean(alerts.highTouchWhileLightDue),
          noCallsWithOpenWork: Boolean(alerts.noCallsWithOpenWork),
          attention: Boolean(alerts.attention),
        },
        repair: {
          scanned: Number(health.repair?.scanned || 0),
          expiredReservationsReleased: Number(health.repair?.expiredReservationsReleased || 0),
          phaseOutDatesRepaired: Number(health.repair?.phaseOutDatesRepaired || 0),
          alreadyHealthy: Number(health.repair?.alreadyHealthy || 0),
          conflicts: Number(health.repair?.conflicts || 0),
          skippedContradictory: Number(health.repair?.skippedContradictory || 0),
          truncated: Boolean(health.repair?.truncated),
        },
      };
    }
    return {
      task: String(row?.task || "").slice(0, 80),
      label: String(row?.label || row?.task || "task").slice(0, 140),
      dryRun: Boolean(row?.dryRun),
      planned: Number(row?.planned || 0),
      ...(row?.error || row?.errorCode
        ? { errorCode: String(row.errorCode || "task-failed").slice(0, 80) }
        : {}),
      applied: safeApplied,
    };
  });
}

async function releaseNightlyHygiene(dateKey, claimedAt, errorCode = null) {
  await DailyLoopRun.updateOne(
    { dateKey, nightlyHygieneClaimedAt: claimedAt, nightlyHygieneCompletedAt: null },
    { $set: {
      nightlyHygieneClaimedAt: null,
      nightlyHygieneLastErrorCode: errorCode == null ? null : String(errorCode).slice(0, 120),
    } },
  );
}

/**
 * The completed business day this pass should persist.
 *
 * Offset 0 by default: the pass runs at 19:50 Pacific, so the current Pacific
 * date is the business day being closed. The explicit offset remains available
 * for a deliberately rescheduled early-hours pass.
 */
function persistTargetDay(at = new Date()) {
  // Offset 0 because the pass runs in the EVENING: at 19:50 the current
  // Pacific day IS the day that just finished, exactly as the 20:20 board
  // always assumed. (An early-hours run would need -1 — the offset stays
  // configurable so the day and the hour can never drift apart silently.)
  const offset = Number(process.env.NIGHT_PERSIST_DAY_OFFSET ?? 0);
  const key = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(at);
  return new Date(Date.parse(`${key}T00:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);
}

function pacificHourMinute(at = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(at);
  const get = (t) => Number(parts.find((x) => x.type === t)?.value);
  return { hour: get("hour") % 24, minute: get("minute") };
}

function pacificDateParts(at = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(at);
  const get = (type) => Number(parts.find((part) => part.type === type)?.value);
  return {
    year: get("year"), month: get("month"), day: get("day"),
    hour: get("hour") % 24, minute: get("minute"), second: get("second"),
  };
}

function addPacificCalendarDays(parts, days) {
  const cursor = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return {
    year: cursor.getUTCFullYear(),
    month: cursor.getUTCMonth() + 1,
    day: cursor.getUTCDate(),
  };
}

function pacificWallClockToUtc(parts) {
  const guessMs = Date.UTC(
    parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second || 0,
  );
  let resolvedMs = guessMs;
  // Two passes cover an offset change between the UTC guess and the resolved
  // instant. Our anchors (noon and 20:00) never occupy the transition gap.
  for (let pass = 0; pass < 2; pass += 1) {
    const observed = pacificDateParts(new Date(resolvedMs));
    const observedAsUtc = Date.UTC(
      observed.year, observed.month - 1, observed.day,
      observed.hour, observed.minute, observed.second,
    );
    resolvedMs = guessMs - (observedAsUtc - resolvedMs);
  }
  return new Date(resolvedMs);
}

/** The nominal 20:00 Pacific delivery point for the nightly run's day. */
function nightlyReportDueAt(at = new Date()) {
  const parts = pacificDateParts(at);
  return pacificWallClockToUtc({
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: 20,
    minute: 0,
    second: 0,
  });
}

async function waitUntil(at) {
  const delayMs = Math.max(0, new Date(at).getTime() - Date.now());
  if (!delayMs) return;
  await new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

/**
 * Milliseconds elapsed since the most recent Pacific wall-clock anchor.
 *
 * The call-log hygiene service takes no from/to — only `sinceMs` — so a window
 * anchored to a Pacific time has to be expressed as a duration. The anchor is
 * converted to its real UTC instant so a window crossing either DST transition
 * gains or loses the correct hour. This matters to the midday pass, whose
 * 20:00-yesterday anchor can straddle the 02:00 transition.
 *
 * Never returns less than a minute, so a run at exactly the anchor still asks
 * the service for a legal window rather than zero.
 */
function pacificMsSinceToday(hour, minute = 0, at = new Date()) {
  const now = new Date(at);
  const nowPt = pacificDateParts(now);
  let day = { year: nowPt.year, month: nowPt.month, day: nowPt.day };
  let anchor = pacificWallClockToUtc({ ...day, hour, minute, second: 0 });
  if (anchor.getTime() > now.getTime()) {
    day = addPacificCalendarDays(day, -1);
    anchor = pacificWallClockToUtc({ ...day, hour, minute, second: 0 });
  }
  return Math.max(now.getTime() - anchor.getTime(), 60 * 1000);
}

function isPacificBusinessDay(at = new Date()) {
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles", weekday: "short",
  }).format(at);
  return weekday !== "Sat" && weekday !== "Sun";
}

/**
 * Bind the recovery discovery service to real collections.
 *
 * The service itself is deliberately dependency-free so its verdicts can be
 * proved without a database. This is the ONE place the abstract proofs meet
 * real data, which keeps the qualification rules testable and keeps the query
 * shapes out of them.
 *
 * Returns null rather than throwing when a dependency is missing — a nightly
 * chore that cannot run must not take the other chores down with it.
 */
function buildCallRecoveryDiscoveryDeps({ windowFrom = null, windowTo = null } = {}) {
  let repository;
  let resolveRecoveryEpisodeTiming;
  let gatherMaterial;
  try {
    ({ callRecoveryLeadRepository: repository } = require("../../../../packages/shared-repositories/src"));
    ({ resolveRecoveryEpisodeTiming } = require("../../../../packages/shared-services/src/leadDeliveryService"));
    ({ gatherMaterial } = require("../../../../packages/shared-services/src/reportComposerService"));
  } catch { return null; }
  if (!repository || typeof resolveRecoveryEpisodeTiming !== "function" || typeof gatherMaterial !== "function") {
    return null;
  }

  // RECOVERY IS AN OFFSHOOT OF THE METRICS LOOP, NOT A PARALLEL PIPELINE.
  //
  // Mickey 2026-07-31: "none of these should be added before they loop through
  // the metrics and this should just be an offshoot of that by which you will
  // learn the agent who touched them first, then they will show up in pb as
  // well."
  //
  // The first version re-derived everything from raw CallRail plus its own
  // CallLog query, and it could never work: on an INBOUND leg `agentName` is
  // the CALLER's name and `providerAgentId`/`ringcx.agentId`/`connected` are
  // never populated (measured: 0 of 4,530 July legs). So the human-answer proof
  // resolved nobody and the funnel qualified zero.
  //
  // `callContext` in the report composer already solved exactly this — it
  // builds an extensionId -> AgentState roster and reads OUR side of the call
  // off that, because the extension is the only field that identifies us. That
  // is the same machinery that produces the "Calls worth hearing" agent column.
  //
  // So discovery now CONSUMES the metrics gather rather than competing with it:
  // one source of truth for who touched a call, one place that learns it, and a
  // candidate cannot be enrolled before the metrics pass has seen it.
  // ONE GATHER FOR THE WHOLE WINDOW — never one per day.
  //
  // The Logics ActivityReport is RANGE-NATIVE: one call per domain covers any
  // range. Gathering per day turns that into a call per domain PER DAY, and a
  // 61-day backfill therefore issued 183 ActivityReport requests where 3 would
  // do — each returning up to 50,000 rows. Measured: ~20 minutes of pointless
  // load on Logics before Mickey spotted it, for an answer identical either way.
  // `callsRange` compounds it: each gather also re-pulls a 45-day CallRail
  // window and throws away all but one day.
  //
  // The nightly task asks for a single day and is unaffected. A backfill passes
  // the whole window here, gathers once, and slices per day below — which is why
  // `windowFrom/windowTo` exist rather than the caller looping this function.
  const material = { loaded: false, value: null, from: null, to: null };
  const covers = (dateKey) => material.loaded
    && material.from <= dateKey && dateKey <= material.to;

  async function metricsMaterial(dateKey) {
    if (covers(dateKey)) return material.value;
    const from = windowFrom && windowFrom <= dateKey ? windowFrom : dateKey;
    const to = windowTo && windowTo >= dateKey ? windowTo : dateKey;
    material.value = await gatherMaterial({
      needs: ["callsRange", "callContext", "payments", "caseContacts"],
      from, to, domain: null, live: true,
    });
    material.loaded = true;
    material.from = from;
    material.to = to;
    return material.value;
  }

  return {
    // The metrics pass's OWN call list, not a second CallRail pull. It reaches
    // back 45 days for lag, so clip to the day being discovered.
    async listCallsForDay({ dateKey, limit }) {
      const m = await metricsMaterial(dateKey);
      return (m.callsRange || [])
        .filter((c) => String(c.dateKey || "").slice(0, 10) === dateKey)
        // callsRange is built from CallRail's INBOUND endpoint, so direction is
        // implicit in the source rather than stamped on the row. Make it
        // explicit so the pure qualifier can still assert §2.1(2) itself.
        .map((c) => ({ ...c, direction: "inbound" }))
        .slice(0, limit || 500);
    },
    // THE AGENT COMES FROM THE METRICS PASS, not from a second CallLog read.
    //
    // `callContext.byPhone[phone].agent` is a resolved STAFF NAME — the metrics
    // gather got it by mapping the leg's extensionId through the AgentState
    // roster, which is the only field on an inbound leg that identifies our
    // side of the call. If the metrics pass could not name somebody, neither
    // can we, and the episode holds rather than guessing.
    //
    // Shaped as a single synthetic "leg" so proveHumanAnswer's rules (one
    // non-shared internal answerer, no competing match) apply unchanged.
    async listInternalLegs({ fact }) {
      if (!fact?.customerPhone) return [];
      const m = await metricsMaterial(material.from);
      const ctx = m.callContext?.byPhone?.[fact.customerPhone];
      if (!ctx?.caseId) return [];
      const caseDomain = String(ctx.caseDomain || "TAG").toUpperCase();

      // THE SETTLEMENT OFFICER IS THE PERSON, and the RC leg is the fallback —
      // the same precedence the "Calls worth hearing" section uses.
      //
      // Getting this backwards is what made the first two dry runs report zero.
      // `byPhone.agent` comes from an answered RingCentral leg carrying our
      // extension, and on inbound that is almost never populated (measured: 0
      // resolved on 2026-07-30). The name the email actually prints comes from
      // `officerByCase` — the settlement officer read out of the activity
      // sweep — which resolved 6 of 8 long calls that same day.
      //
      // This is exactly what Mickey meant by learning the agent from the
      // metrics loop: the officer is who owns and worked the case, and it is
      // knowledge the nightly pass has already paid for.
      const officer = m.callContext?.officerByCase?.[`${caseDomain}:${ctx.caseId}`] || ctx.agent || null;
      if (!officer) return [];

      return [{
        _id: `callcontext:${fact.customerPhone}`,
        direction: "inbound",
        // A named owner on a 10-minute inbound call IS the human-answer
        // evidence — the metrics pass would not have a case bound to this
        // phone, nor an officer on that case, for a call nobody took.
        answered: true,
        agentId: officer,
        agentName: officer,
        extension: null,
        caseId: ctx.caseId,
        caseDomain,
        callStartTime: fact.startedAt,
      }];
    },
    // §13 — "did not close", read fresh. Discovery only needs to avoid
    // enrolling an obviously-converted case; admission re-proves all of this
    // before every provider claim, because a sale posted after this pass still
    // has to remove the case.
    // §13 at DISCOVERY time — status from the metrics pass's live Logics read,
    // payments from the same gather. Admission re-proves all of it before every
    // provider claim, because a sale posted after this pass still has to remove
    // the case.
    async readCaseState({ domain, caseId }) {
      const m = await metricsMaterial(material.from);
      const key = `${String(domain || "").toUpperCase()}:${caseId}`;
      const status = m.callContext?.statusByCase?.[key] || null;
      const name = m.callContext?.nameByCase?.[key] || null;
      // Any money on this case inside the gathered range is a sale signal.
      const paid = (m.payments || []).filter((p) => !p.isChargeback
        && String(p.domain || "").toUpperCase() === String(domain || "").toUpperCase()
        && String(p.caseId ?? "") === String(caseId ?? ""));
      const totalPaid = paid.reduce((s, p) => s + (Number(p.amount) || 0), 0);

      // LOGICS' OWN BRACKET GROUP IS THE CLASSIFIER, not a regex over the whole
      // string. Real values look like "[Active Prospect]-Opened",
      // "[TIER 1]-ACTIVE", "[Bad/Inactive]-DO NOT CALL", "[RESO ONLY]-RESO ONLY".
      //
      // The first version tested /\[tier|active|client|retained/ for "is this a
      // client", which matched the word ACTIVE inside "[Active Prospect]" — so
      // every live prospect was classified as a client and rejected. Measured:
      // 7, 6 and 5 false `not-a-prospect` rejections on three consecutive days,
      // which is most of the candidate pool.
      //
      // A TIER is a resolution-pursuit tier on an existing client, so it is
      // correctly excluded; the only group this program wants is a prospect who
      // has not converted.
      const { resolveCallRecoveryLogicsEligibility } = require(
        "../../../../packages/shared-services/src/leadDeliveryService");
      const recoveryLogics = resolveCallRecoveryLogicsEligibility({ domain, statusText: status });
      return {
        firstName: name?.firstName || null,
        lastName: name?.lastName || null,
        displayName: name?.displayName || null,
        convertedAt: null,
        paymentCount: paid.length,
        totalPaid,
        dnc: recoveryLogics.entityDnc === true,
        activeAppointment: false,
        // Null, never a guess — proveStillOpen holds on anything but an
        // explicit true, which is what we want when status is unreadable.
        allowedProspectStatus: recoveryLogics.allowedProspectStatus,
      };
    },
    resolveEpisodeTiming: (at) => resolveRecoveryEpisodeTiming(at),
    repository,
  };
}

/**
 * The chore list. Add a task here rather than adding a runtime.
 *
 * plan()  — read-only; always safe, always run, so `lastRun` shows the work
 *           even when the task may not write.
 * apply() — only called when the task's own write switch is armed.
 */
/**
 * Read the invoice mailbox.
 *
 * Mickey 2026-08-03: "its the same mail box as nco."
 *
 * SAME MAILBOX, BORROWED AUTH, NOTHING ELSE. Only `user` and `gmail` are read
 * by openMailbox, so those are the only two keys passed. The NCOA config is
 * deliberately NOT spread in: it carries `markRead` and `archiveProcessed`,
 * both defaulting true, which are NCOA loop-body behaviour and inert here.
 * Passing them would imply a coupling that does not exist and would invite
 * someone to honour them later — which, on a mailbox we share with NCOA, means
 * archiving the vendor's invoice email out of the inbox.
 *
 * `gmail` is passed BY REFERENCE, unmodified. The Gmail client keeps a
 * single-slot token cache keyed on the config it was built with, so narrowing
 * the scope here would re-key it and force a re-auth on every alternation
 * between this task and NCOA's.
 *
 * Related guard, in shared-config: NCOA's `acceptedExtensions` defaults to
 * .csv/.txt, and its archive is gated on having ACCEPTED an attachment — which
 * is the only reason NCOA does not already archive these PDF-only emails.
 * Adding .pdf there would break this reader.
 */
/**
 * Which documents this mailbox visit is looking for.
 *
 * ONE VISIT, TWO DOCUMENTS.
 *
 * Mickey 2026-08-06: "move the ncoa check up to this point so you get into the
 * mailbox once and then send the right email to invoice scraping and the right
 * csv to logics, instead of checking and blasting emails."
 *
 * runMailboxIngest opens the Gmail client once, outside its handler loop, so a
 * second handler costs a QUERY rather than a second connection and a second
 * schedule. The two cannot collide over a message: the invoice handler accepts
 * on PDF content, NCOA on .csv/.txt extension, and each brings its own query.
 *
 * Each handler is included per ITS OWN flag. NCOA's flag gated
 * runNcoaMailboxIngestIfDue before this fold and it gates inclusion here, so
 * moving the work between schedules cannot quietly turn NCOA on somewhere it
 * was off — nor off somewhere it was on.
 *
 * Separate from the task's arming (see `writesArmed`) on purpose: arming
 * decides whether the mailbox is opened at all, this decides what is read once
 * it is.
 */
function buildMailboxHandlers({
  invoiceEnabled = true,
  ncoaEnabled = false,
  targetDate = null,
  targetDates = null,
} = {}) {
  const {
    createMailInvoiceHandler,
  } = require("../../../../packages/shared-services/src/mailInvoiceMailboxHandler");
  const {
    createNcoaHandler,
  } = require("../../../../packages/shared-services/src/ncoaMailboxHandler");

  const handlers = [];
  if (invoiceEnabled) {
    handlers.push(createMailInvoiceHandler({
      targetDate: targetDate || persistTargetDay(),
      targetDates,
    }));
  }
  if (ncoaEnabled) handlers.push(createNcoaHandler());
  return handlers;
}

async function readMailInvoiceMailbox({ apply, logger, targetDate = null, targetDates = null }) {
  const {
    runMailboxIngest,
  } = require("../../../../packages/shared-services/src/mailboxIngestService");
  const { getSharedConfig } = require("../../../../packages/shared-config/src");

  const shared = getSharedConfig();
  const ncoaMailbox = shared.ncoaMailbox || {};
  const invoiceEnabled = String(process.env.MAIL_INVOICE_MAILBOX_ENABLED || "false").toLowerCase() === "true";
  const handlers = buildMailboxHandlers({
    invoiceEnabled,
    ncoaEnabled: ncoaMailbox.enabled,
    targetDate,
    targetDates,
  });
  if (!handlers.length) return { status: "disabled", handlers: {} };

  // The invoice for THIS day, identified by its subject — not simply the most
  // recent mail from the vendor. Those differ the moment they send a
  // correction or a statement, and the wrong invoice parses just as cleanly as
  // the right one, so recency would fail silently.
  return runMailboxIngest({
    apply,
    handlers,
    logger,
    maxMessages: 25,
    maxPages: 3,
    config: { user: ncoaMailbox.user, gmail: ncoaMailbox.gmail },
  });
}

const TASKS = [
  {
    // THE one that cannot be lost. nightPassService's per-domain loop is the
    // only code that writes officerAtSale/sourceAtSale, and a live re-pull
    // can never reconstruct it — Logics returns who owns the case TODAY, not
    // who closed it in July. The board it used to render is now a saved
    // ReportDefinition; this keeps the writes and drops nothing.
    key: "night-persist",
    label: "Persist activity events + payment truth (attribution snapshots)",
    // Reuses runNightPass verbatim with persistOnly, so the stamp-then-persist
    // ordering inside that loop is the SAME code the old board ran, not a
    // reimplementation that could drift.
    writesArmed: () => String(process.env.NIGHT_PERSIST_ENABLED || "false").toLowerCase() === "true",
    async plan({ domains, logger, at }) {
      const { runNightPass } = require("../../../../packages/shared-services/src/nightPassService");
      // The business day being closed. This service runs at 19:50, so offset 0
      // names the current Pacific day; an intentionally rescheduled early-hours
      // run can select yesterday through NIGHT_PERSIST_DAY_OFFSET.
      const dateKey = persistTargetDay(at);
      // apply:false reads and counts everything, writes nothing, and collects
      // the pending writes so apply() persists exactly THOSE.
      const { night } = await runNightPass({
        dateKey, domains, apply: false, persistOnly: true, logger,
      });
      return [{ dateKey, counters: night.counters, pending: night.pending, night }];
    },
    async apply(planned, { logger }) {
      // Persist what plan() ALREADY derived. Re-running the whole pass with
      // apply:true resolves attribution a second time, independently, so the
      // numbers written would not be the numbers reported - and a lookup that
      // succeeded during plan() but failed during apply() would persist a
      // weaker snapshot than the one just shown.
      const {
        insertActivityEvents,
      } = require("../../../../packages/shared-services/src/activityEventService");
      const {
        persistPaymentTruths,
      } = require("../../../../packages/shared-services/src/paymentTruthService");
      const pending = planned[0]?.pending || { events: [], truths: [] };
      const out = { written: 0, events: 0, payments: 0, resurfaced: 0, skipped: 0, failed: 0, errors: [] };
      if (pending.events.length) {
        try {
          const ins = await insertActivityEvents(pending.events);
          out.events = ins.inserted || 0;
          out.resurfaced = ins.resurfaced || 0;
        } catch (error) {
          out.failed += 1;
          out.errors.push(`events: ${String(error.message).slice(0, 160)}`);
        }
      }
      if (pending.truths.length) {
        try {
          const res = await persistPaymentTruths(pending.truths);
          out.payments = res.upserted || 0;
        } catch (error) {
          out.failed += 1;
          out.errors.push(`payments: ${String(error.message).slice(0, 160)}`);
        }
      }
      out.written = out.events + out.payments;
      logger?.info?.("night_persist.applied", {
        dateKey: planned[0]?.dateKey, events: out.events, payments: out.payments, failed: out.failed,
      });
      return out;
    },
    // Its plan is a counter snapshot, not a row list. Without its own count()
    // the runtime's default (plan.length) reads 0 and apply() never runs —
    // the task would look armed and silently write nothing.
    count(planned) {
      const p = planned[0]?.pending || { events: [], truths: [] };
      return p.events.length + p.truths.length;
    },
    describe(planned) {
      const c = planned[0]?.counters || {};
      const p = planned[0]?.pending || { events: [], truths: [] };
      // deals live on night.lanes.deals, NOT on counters - reading c.deals
      // made this line say "0 deal(s)" every single night.
      const deals = planned[0]?.night?.lanes?.deals?.length || 0;
      return `${planned[0]?.dateKey}: ${c.rows || 0} row(s) · ${deals} deal(s) · `
        + `${p.events.length} event(s) + ${p.truths.length} payment truth(s) to persist`;
    },
  },
  {
    // The vendor's daily mail invoice, read out of the mailbox.
    //
    // Mickey 2026-07-31: "the invoice check can run once at the 8 pm thing."
    //
    // It runs HERE, at 19:50, rather than in the 20:00 report — because the
    // report READS mail spend and this is what produces it. Ten minutes of
    // headroom is the same ordering rule the rest of this loop follows: fix
    // the data, then report it. Putting the ingest inside the report would
    // mean the first board of the day reported a cost it was still fetching.
    //
    // The CHECK half is the point as much as the ingest. A day with no email,
    // or an email with one attachment instead of two, has to be distinguishable
    // from a quiet day — see the funnel in `describe`, which is what reaches
    // the operator.
    key: "mail-invoice",
    label: "Read the shared mailbox — vendor invoice, and NCOA returns",
    // EITHER document arms the visit.
    //
    // The two ride the same mailbox but answer to different flags, and NCOA was
    // on its own hourly trigger until this task absorbed it. Arming on the
    // invoice flag alone would have stopped NCOA anywhere the invoice reader is
    // dark — which is exactly the silent outage the handover rule exists to
    // prevent. Each handler is still included per its own flag; this only
    // decides whether the mailbox is opened at all.
    writesArmed: () => {
      const invoice = String(process.env.MAIL_INVOICE_MAILBOX_ENABLED || "false").toLowerCase() === "true";
      const ncoa = String(process.env.NCOA_MAILBOX_ENABLED || "false").toLowerCase() === "true";
      return invoice || ncoa;
    },
    async plan({ logger, at }) {
      const targetDate = persistTargetDay(at);
      const result = await readMailInvoiceMailbox({
        apply: false,
        logger,
        targetDate,
        targetDates: nightlyInvoiceRepairDateKeys(targetDate),
      });
      // The invoice funnel is what `describe` reads; NCOA's is carried alongside
      // so a dry run shows both without the describe having to know about it.
      return [{ ...(result.handlers["mail-invoice"] || {}), ncoa: result.handlers.ncoa || null }];
    },
    async apply(planned, { logger, at }) {
      const targetDate = persistTargetDay(at);
      const result = await readMailInvoiceMailbox({
        apply: true,
        logger,
        targetDate,
        targetDates: nightlyInvoiceRepairDateKeys(targetDate),
      });
      const stat = result.handlers["mail-invoice"] || {};
      const ncoa = result.handlers.ncoa || {};
      const invoiceDocuments = Number(stat.documentsProcessed ?? stat.processed) || 0;
      return {
        written: invoiceDocuments + (ncoa.processed || 0),
        invoiceProcessed: invoiceDocuments,
        ncoaProcessed: ncoa.processed || 0,
        ncoaSkipped: (ncoa.skipped || 0) + (ncoa.alreadyHandled || 0),
        ncoaFailed: ncoa.errors || 0,
        skipped: (stat.skipped || 0) + (ncoa.skipped || 0),
        failed: (stat.errors || 0) + (ncoa.errors || 0),
      };
    },
    count(planned) {
      // BOTH documents count. This read only the invoice's accepted number, so
      // a night whose mailbox held an NCOA CSV but no invoice planned 0 — and a
      // plannedCount of 0 means apply() never runs, so the CSV sat unprocessed
      // while the task reported a quiet, successful night. The arming widened
      // to either flag for exactly this case; the count has to match it.
      const invoice = Number(planned[0]?.accepted) || 0;
      const ncoa = Number(planned[0]?.ncoa?.accepted) || 0;
      return invoice + ncoa;
    },
    describe(planned) {
      const p = planned[0] || {};
      // A mailbox we could not read is NOT an empty mailbox, and saying so is
      // the difference between "they sent nothing" and "we could not look".
      if (p.listFailed) return `COULD NOT READ THE MAILBOX — ${p.listFailed}`;
      if (!p.listed) return "no invoice email found for this window";
      const r = p.results?.[0] || {};
      if (r.reason === "no-invoice-attachment") {
        return `email found but NO INVOICE attached (${r.summary?.attachmentsSeen ?? 0} attachment(s))`;
      }
      // Vendor mail arrived, but none of it names today. Distinct from silence
      // on purpose: it says the vendor is emailing and today's invoice is the
      // thing that is missing, and it prints the subjects so a changed subject
      // format is diagnosable at a glance rather than after a code read.
      const mismatched = (p.results || []).filter((x) => x.reason === "subject-date-mismatch");
      if (mismatched.length && mismatched.length === (p.results || []).length) {
        return `${p.listed} vendor email(s) but NONE for ${mismatched[0].summary?.wantedDate}`
          + ` — subjects seen: ${mismatched.map((x) => JSON.stringify(x.summary?.subject || "")).join(", ")}`;
      }
      const s = r.summary || {};
      const invoiceDocuments = (p.results || []).reduce(
        (total, row) => total + (Number(row?.summary?.invoicesFound) || 0),
        0,
      );
      return `${p.listed} email(s) · ${invoiceDocuments || p.accepted} invoice attachment(s)`
        + (s.invoiceNumber ? ` · #${s.invoiceNumber} ${s.serviceDate} $${s.grandTotal} ${s.state}` : "")
        + (p.alreadyHandled ? ` · ${p.alreadyHandled} already ingested` : "");
    },
  },
  {
    // Turn reconciled invoices into mail spend the board can report.
    //
    // Separate task from the ingest on purpose, and separately armed. Reading
    // the mailbox and BELIEVING the number are different decisions: the first
    // is safe to run for weeks while nobody trusts the output yet, and only
    // the second changes what gets reported as money.
    //
    // Ordered directly after the ingest so a day's invoice can arrive and
    // become spend in the same 19:50 pass, ten minutes before the board reads
    // it.
    key: "mail-spend-derive",
    label: "Derive mail spend from reconciled invoices",
    writesArmed: () => String(process.env.MAIL_SPEND_DERIVE_ENABLED || "false").toLowerCase() === "true",
    async plan({ logger, at }) {
      const {
        deriveMailSpend,
      } = require("../../../../packages/shared-services/src/mailSpendDeriveService");
      const dateKey = persistTargetDay(at);
      const dateKeys = nightlyInvoiceRepairDateKeys(dateKey);
      const from = dateKeys[0];
      const to = dateKeys.at(-1);
      const result = await deriveMailSpend({ from, to, apply: false, logger });
      return [{ ...result, dateKey, from, to }];
    },
    async apply(planned, { logger }) {
      const {
        deriveMailSpend,
      } = require("../../../../packages/shared-services/src/mailSpendDeriveService");
      const { findSpendRepairDateKeys, repairDailySnapshots } = require(
        "../../../../packages/shared-services/src/dailySnapshotService"
      );
      const dateKey = planned[0]?.dateKey;
      const from = planned[0]?.from || dateKey;
      const to = planned[0]?.to || dateKey;
      const r = await deriveMailSpend({ from, to, apply: true, logger });
      // The current day is composed once by report-delivery later in this same
      // cursor. Only newly changed OLDER days need the explicit heavy repair.
      const pendingHistorical = await findSpendRepairDateKeys({
        from, to, currentDateKey: dateKey,
      });
      const historical = [...new Set([
        ...(r.changedDateKeys || []),
        ...pendingHistorical,
      ])].filter((key) => key && key !== dateKey).sort();
      const repair = historical.length
        ? await repairDailySnapshots({ dateKeys: historical, logger })
        : { status: "skipped", repaired: 0, failed: 0 };
      return {
        written: r.derived,
        skipped: r.skipped,
        retired: r.retired,
        held: r.held.length,
        repaired: repair.repaired || 0,
        failed: repair.failed || 0,
      };
    },
    count(planned) {
      return planned[0]?.derived || 0;
    },
    describe(planned) {
      const p = planned[0] || {};
      if (!p.considered) return "no invoice for this day";
      const parts = [`${p.considered} invoice(s)`];
      if (p.derived) parts.push(`${p.derived} to derive`);
      if (p.skipped) parts.push(`${p.skipped} already derived`);
      // A HELD invoice is the case worth reading. It is not an error and not a
      // quiet success — it is the deriver declining to report a number, and
      // the reason is the only thing that tells an operator what to do.
      if (p.held?.length) {
        parts.push(`HELD: ${p.held.map((h) => `#${h.invoiceNumber} ${h.reason}`).join(", ")}`);
      }
      return parts.join(" · ");
    },
  },
  {
    // "gather the call urls" — step two of the night, for real.
    //
    // Mickey 2026-07-29: "you have a pool of links and those are attached to
    // the call. so youre grabbing and organzing the link info for marketing
    // calls."
    //
    // CallRail hands out recording URLs ONE CALL AT A TIME, so a report that
    // wants listen links pays a round-trip per call every time it runs. A
    // finished call's URL never changes, so capturing it once turns that into
    // a Mongo read — and the link survives whether or not a report ever asks
    // for that day.
    //
    // MARKETING lines only. Servicing calls ("Client Contact - TAG") are real
    // calls but not marketing, and letting them into the pool is how a client
    // ringing support starts to look like a fresh response.
    //
    // PhoneBurner is NOT here: the service account cannot enumerate its dial
    // sessions (0 indexed on every day tried), so those URLs can only arrive
    // from the forward-looking capture path.
    key: "call-links",
    label: "Capture marketing call recording links",
    writesArmed: () => String(process.env.CALL_LINK_CAPTURE_ENABLED || "false").toLowerCase() === "true",
    async plan({ domains, logger, at }) {
      const { captureCallLinks } = require("../../../../packages/shared-services/src/marketingCallLinkService");
      const dateKey = persistTargetDay(at);
      const out = [];
      for (const domain of domains) {
        // CallRail is ONE tenant; asking per domain is the same account
        // answered three times.
        if (String(domain).toUpperCase() !== "TAG") continue;
        out.push(await captureCallLinks({ dateKey, domain, apply: false, logger }));
      }
      return out;
    },
    async apply(planned, { logger }) {
      const { captureCallLinks } = require("../../../../packages/shared-services/src/marketingCallLinkService");
      const out = { written: 0, skipped: 0, failed: 0, errors: [] };
      for (const p of planned) {
        const r = await captureCallLinks({ dateKey: p.dateKey, domain: p.domain, apply: true, logger });
        out.written += r.written || 0;
        out.skipped += r.alreadyHad || 0;
        out.failed += r.failed || 0;
        if (r.error) out.errors.push(r.error);
      }
      return out;
    },
    count(planned) {
      return planned.reduce((a, p) => a + (p.marketing || 0), 0);
    },
    describe(planned) {
      const p = planned[0] || {};
      if (!p.calls) return `${p.dateKey || "?"}: no calls`;
      return `${p.dateKey}: ${p.calls} call(s) · ${p.marketing} marketing · `
        + `${p.withRecording} with a recording · ${p.alreadyHad} already pooled`;
    },
  },
  {
    // CallRail long-call recovery discovery (work order CR-4).
    //
    // A TASK, not a runtime — §21 forbids a new process, and the completed-day
    // boundary this loop already computes is exactly the one discovery needs.
    // plan() is a full dry run: every read, every verdict, every counter, no
    // write. So the funnel printed on a dark box is what arming it would do.
    //
    // This produces EVIDENCE ONLY. Nothing here authorizes a dial — admission
    // re-proves status, sale and DNC at claim time, because a clean snapshot
    // captured during the evening pass cannot authorize a later call.
    key: "call-recovery-discovery",
    label: "Discover CallRail long-call recovery candidates",
    writesArmed: () => String(process.env.CALL_RECOVERY_DISCOVERY_ENABLED || "false").toLowerCase() === "true",
    async plan({ logger, at }) {
      const deps = buildCallRecoveryDiscoveryDeps();
      if (!deps) return [{ skipped: true, reason: "discovery-deps-unavailable" }];
      const { runCallRecoveryDiscovery } = require(
        "../../../../packages/shared-services/src/callRecoveryDiscoveryService");
      return [await runCallRecoveryDiscovery({
        dateKey: persistTargetDay(at), apply: false, logger, deps,
      })];
    },
    async apply(planned, { logger }) {
      const deps = buildCallRecoveryDiscoveryDeps();
      if (!deps) return { skipped: true, reason: "discovery-deps-unavailable" };
      const { runCallRecoveryDiscovery } = require(
        "../../../../packages/shared-services/src/callRecoveryDiscoveryService");
      // A failed read still gets one INCOMPLETE daily manifest. That is how a
      // missing day remains visible instead of being rounded down to zero.
      // Successful (including legitimately empty) days run apply exactly once.
      const r = planned[0]?.readFailed
        ? planned[0]
        : await runCallRecoveryDiscovery({
          dateKey: planned[0]?.dateKey, apply: true, logger, deps,
        });
      const { callRecoveryDailyCohortRepository } = require(
        "../../../../packages/shared-repositories/src");
      const cohort = await callRecoveryDailyCohortRepository.captureCompletedDay({
        dateKey: r.dateKey,
        discoveryResult: r,
        policyIds: {
          cadence: require("../../../../packages/shared-services/src/leadDeliveryService")
            .CALL_RECOVERY_CONTACT_POLICY_ID,
          dnc: require("../../../../packages/shared-services/src/leadDeliveryService")
            .CALL_RECOVERY_DNC_POLICY_ID,
          logics: require("../../../../packages/shared-services/src/leadDeliveryService")
            .CALL_RECOVERY_LOGICS_POLICY_ID,
        },
      });
      return {
        inserted: r.episodesInserted, updated: r.episodesUpdated,
        qualified: r.qualified, errors: r.errors,
        cohortCandidates: Number(cohort.cohort?.candidateCount || 0),
        cohortStatus: cohort.cohort?.status || "incomplete",
        cohortRevision: Number(cohort.cohort?.revision || 0),
      };
    },
    count(planned) {
      // One manifest per attempted completed day, even when zero calls qualify.
      return planned.length ? 1 : 0;
    },
    describe(planned) {
      const p = planned[0] || {};
      if (p.readFailed) return `${p.dateKey || "?"}: COULD NOT READ THE DAY — ${p.readFailed}`;
      const top = Object.entries(p.rejectedByReason || {})
        .filter(([k]) => k !== "would-qualify")
        .sort((a, b) => b[1] - a[1]).slice(0, 4)
        .map(([k, n]) => `${n} ${k}`).join(" · ");
      return `${p.dateKey}: ${p.factsRead} call(s) · ${p.qualified} qualify`
        + (top ? ` · ${top}` : "");
    },
  },
  {
    // CR-5 hygiene: lift only freshly proven DNC-clean episodes into the
    // recovery source, recheck day 30/60/90, and close expired episodes. This
    // is the existing nightly owner, not a new scheduler or process.
    key: "call-recovery-eligibility-hygiene",
    label: "Refresh recovery DNC/status eligibility",
    writesArmed: () => String(process.env.CALL_RECOVERY_DISCOVERY_ENABLED || "false").toLowerCase() === "true",
    async plan() {
      if (!isPacificBusinessDay(new Date())) return [{ skipped: true, reason: "non-business-day" }];
      return [{ ready: true }];
    },
    async apply(planned, { logger }) {
      if (planned[0]?.skipped) return { skipped: true, reason: planned[0].reason };
      const { callRecoveryLeadRepository: repository } = require(
        "../../../../packages/shared-repositories/src");
      const {
        runCallRecoveryDncSweep,
        runCallRecoveryLogicsDncCheck,
      } = require("../../../../packages/shared-services/src/callRecoveryDncSweepService");
      const { createLogicsClient } = require("../../../../packages/shared-integrations/src");
      const { resolveCallRecoveryLogicsEligibility } = require(
        "../../../../packages/shared-services/src/leadDeliveryService");
      const clients = new Map();
      const readCaseDnc = async ({ domain, caseId }) => {
        const dom = String(domain || "").trim().toUpperCase();
        if (!clients.has(dom)) clients.set(dom, createLogicsClient(dom));
        const payload = await clients.get(dom).getCaseInfo(Number(caseId));
        const raw = payload?.Data ?? payload?.data ?? payload;
        const data = Array.isArray(raw) ? (raw[0] || null) : raw;
        if (!data || typeof data !== "object") return null;
        const statusId = Number(data.StatusID ?? data.Status ?? NaN);
        return resolveCallRecoveryLogicsEligibility({
          domain: dom,
          statusId: Number.isFinite(statusId) ? statusId : null,
        }).entityDnc;
      };
      const dnc = await runCallRecoveryDncSweep({
        repository, now: new Date(), limit: 100, apply: true, mode: "all", logger,
      });
      const logics = await runCallRecoveryLogicsDncCheck({
        repository, readCaseDnc, now: new Date(), limit: 200, apply: true, logger,
      });
      const expiredRows = await repository.listExpiredEpisodes({ asOf: new Date(), limit: 200 });
      let expired = 0;
      for (const episode of expiredRows) {
        const moved = await repository.expireEpisode(episode.episodeId, {
          from: episode.state,
          expectedVersion: episode.version,
          reason: "program-expired",
        }).catch(() => ({ ok: false }));
        if (moved.ok) expired += 1;
      }
      return {
        checked: dnc.checked,
        clean: dnc.clean,
        dncHits: dnc.hit + logics.dnc,
        failed: dnc.failed + dnc.errors + logics.errors,
        terminated: dnc.terminated + logics.terminated,
        expired,
      };
    },
    count(planned) { return planned[0]?.ready === true ? 1 : 0; },
    describe(planned) {
      return planned[0]?.skipped ? "non-business day; no recovery eligibility work" : "bounded recovery eligibility pass";
    },
  },
  {
    // Freeze the day's queue activity so a RANGE never has to ask RingCentral.
    //
    // RC answers per day and rate-limits hard, which is why the work log
    // refused ranges over 7 days. CallLog cannot substitute: on inbound legs
    // extensionId is the QUEUE that rang, not the agent who answered (5 of 44
    // legs mapped on 2026-07-27). Once the day is over, who answered what
    // stops changing — so a stored copy can never go stale.
    key: "queue-rollup",
    label: "Legacy queue-only rollup (superseded by DailyReportFact)",
    writesArmed: () => LEGACY_QUEUE_ROLLUP_WRITES_ENABLED
      && String(process.env.QUEUE_ROLLUP_ENABLED || "false").toLowerCase() === "true",
    async plan({ logger, at }) {
      const { captureQueueDay } = require("../../../../packages/shared-services/src/queueRollupService");
      const dateKey = persistTargetDay(at);
      // Read-only: shapes the day without writing it.
      return [{ dateKey, ...(await captureQueueDay({ dateKey, logger })) }];
    },
    async apply(planned, { logger }) {
      const { persistQueueDay } = require("../../../../packages/shared-services/src/queueRollupService");
      // Persist the exact provider snapshot produced by plan(). Re-reading here
      // doubles provider traffic and can write different evidence than the row
      // the dry-run just described.
      const day = await persistQueueDay({ day: planned[0], logger });
      return {
        written: 1,
        skipped: 0,
        failed: day.partial || day.unavailable ? 1 : 0,
        errors: day.unavailable
          ? [`unavailable: ${day.unavailableReason}`]
          : (day.partial ? [`partial: ${day.partialReason}`] : []),
      };
    },
    count(planned) {
      // A clean zero-call day is still a fact. Persisting it is what lets a
      // range distinguish "quiet" from "the nightly capture never ran".
      return /^\d{4}-\d{2}-\d{2}$/.test(String(planned[0]?.dateKey || "")) ? 1 : 0;
    },
    describe(planned) {
      const r = planned[0] || {};
      const taken = (r.streams || []).reduce((a, x) => a + (x.connected || 0), 0);
      const made = (r.agents || []).reduce((a, x) => a + (x.made || 0), 0);
      return `${r.dateKey}: ${r.agents?.length || 0} agent(s) · ${taken} taken · ${made} made`
        + (r.unavailable ? ` — UNAVAILABLE (${r.unavailableReason})`
          : (r.partial ? ` — PARTIAL (${r.partialReason})` : ""));
    },
  },
  {
    key: "logics-source",
    label: "Write the mail piece onto the Logics case",
    // Two switches on purpose: the task may run (and show its plan) long
    // before it is allowed to write to live client records.
    writesArmed: () => String(process.env.LOGICS_SOURCE_WRITER_ENABLED || "false").toLowerCase() === "true",
    async plan({ domains, days, logger }) {
      const out = [];
      for (const domain of domains) {
        const planned = await planSourceSanitization({ domain, days, logger });
        out.push({ domain, ...planned });
      }
      return out;
    },
    async apply(planned, { logger }) {
      const rows = planned.flatMap((p) => p.plan || []);
      if (!rows.length) return { written: 0, skipped: 0, failed: 0 };
      return applySourceSanitization(rows, { logger });
    },
    describe(planned) {
      const n = planned.reduce((acc, p) => acc + (p.plan?.length || 0), 0);
      const callers = planned.reduce((acc, p) => acc + (p.stats?.callers || 0), 0);
      return `${callers} caller(s) on an active piece → ${n} case(s) to move off the catch-all`;
    },
  },
  {
    // COSTING. Was its own 19:45 timer; folded in here 2026-08-04 because it
    // is a data-layer build step, not a service — the spend it syncs is read
    // by the 20:00 email forty minutes later, and two clocks for one
    // dependency is how the email came to read a sheet the sync had not
    // finished writing.
    key: "spend-sync",
    label: "Sync marketing spend (costing)",
    // Its OWN flag, default off — deliberately NOT HOURLY_SPEND_SYNC_ENABLED,
    // which is already true. Reusing that one would arm this task the moment
    // the code deployed and sync spend TWICE a night: once from the 19:45
    // timer that still owns it, once from here. Arming this flag is the second
    // half of a two-step handover — turn the 19:45 timer off in the same
    // change, or the double-write is the whole cost of the consolidation.
    writesArmed: () => String(process.env.NIGHTLY_SPEND_SYNC_ENABLED || "false").toLowerCase() === "true",
    async plan({ logger, at }) {
      // No dry-run mode exists upstream: syncAll is an upsert-by-key against
      // the sheet. Reporting the intent is honest; claiming a count we did not
      // compute would not be.
      return [{ dateKey: persistTargetDay(at), mode: "upsert-by-key", logger: Boolean(logger) }];
    },
    async apply(planned, { logger, spendSyncRuntime = null }) {
      if (!spendSyncRuntime) {
        return { written: 0, skipped: 0, failed: 1, errors: ["spend-sync-runtime-unavailable"] };
      }
      const r = await spendSyncRuntime.syncAll({ scheduled: true, logger });
      return {
        written: Number(r?.totalUpserted || 0),
        skipped: Number(r?.totalSkipped || 0),
        failed: 0,
        sheets: Array.isArray(r?.sheets) ? r.sheets.length : 0,
      };
    },
    // Without a count() the runtime computes plannedCount 0 and NEVER calls
    // apply() — arming the flag would produce a silently successful no-op pass.
    // One unit of work: the sync either runs or it does not.
    count() { return 1; },
    describe(planned) {
      return `${planned[0]?.dateKey || "?"}: upsert spend rows from the configured sheets`;
    },
  },
  {
    // ACTIVITY REVIEW. Was a separate 20:00 runtime racing the email it feeds.
    // Moved here 2026-08-04 so the review lands BEFORE the snapshot that
    // reads it, rather than alongside it.
    key: "activity-review",
    label: "Review Logics activity for the completed day",
    // Its OWN flag, default off — deliberately NOT LOGICS_ACTIVITY_REVIEW_ENABLED.
    // shared-config defaults logicsActivityReview.enabled to TRUE, so that flag
    // already arms the standalone 20:00 runtime. Reusing it here would review
    // the same activity TWICE a night, at 19:50 and again at 20:00 — the same
    // trap spend-sync fell into. Arming this flag must, in the SAME change, stop
    // server.js starting the standalone runtime.
    writesArmed: () => String(process.env.NIGHTLY_ACTIVITY_REVIEW_ENABLED || "false").toLowerCase() === "true",
    async plan({ domains, logger, at }) {
      return [{ dateKey: persistTargetDay(at), domains: [...domains], logger: Boolean(logger) }];
    },
    async apply(planned, { logger, activityReviewRuntime = null }) {
      if (!activityReviewRuntime) {
        return { written: 0, skipped: 0, failed: 1, errors: ["activity-review-runtime-unavailable"] };
      }
      const r = await activityReviewRuntime.runActivityReview({ scheduled: true, logger });
      // READ THE SHAPE THE SERVICE ACTUALLY RETURNS.
      //
      // This used to read `r.written || r.reviewed`, neither of which exists on
      // it: runActivityReview hands back the raw service result, whose counts live
      // under `processed` (see logicsActivityReviewRuntime's lastResult mapping —
      // parsedRows / outputRows / suspendedOutputRows / aiReview.reviewedCases).
      // So a review that did a full night's work reported written: 0, and the
      // hygiene summary said nothing happened.
      const p = r?.processed || {};
      return {
        // What it WROTE: the notice and suspended rows it emitted.
        written: Number(p.outputRows || 0) + Number(p.suspendedOutputRows || 0),
        // What the AI looked at — reported separately because reviewing is not writing.
        reviewed: Number(p.aiReview?.reviewedCases || 0)
          + Number(p.suspendedAiReview?.reviewedCases || 0),
        rows: Number(p.parsedRows || 0),
        skipped: 0,
        failed: r ? 0 : 1,
      };
    },
    // See the note on spend-sync's count(): no count() means apply() never runs.
    count() { return 1; },
    describe(planned) {
      const p = planned[0] || {};
      return `${p.dateKey || "?"}: review activity across ${(p.domains || []).length} domain(s)`;
    },
  },
  // ── THE RECONCILIATION TRIO ────────────────────────────────────────────────
  //
  // These three ran in the hourly sweeper's Phase A. They do NOT run anywhere
  // today: server.js:703 hardcodes `scheduledPhaseLite = true`, which passes
  // through as `sessionReconcileEnabled: !scheduledPhaseLite` and friends, so
  // all three have been off since that line landed. This is therefore
  // "off → once a night", not "14× → 1×", and the risk to weigh is the burst
  // one night creates, not the coverage one night loses.
  //
  // WHY HERE AND NOT FIRST. The work order put them ahead of night-persist, on
  // the theory that payment-reconcile produces the rows night-persist stamps.
  // It does not: night-persist runs runNightPass → runMoneyLoop → pullCaseBilling,
  // a LIVE Logics pull (paymentTruthService:265), so it never reads a
  // PaymentLedger row this pass wrote. With no produce/consume edge, the two
  // stated ordering rules win instead — night-persist keeps index 0 because its
  // write is the one that cannot be recovered later, and call-recording-index
  // keeps the last slot because it wants the pass to have finished correcting
  // data. That also keeps the two longest serial Logics loops out of the front
  // of the pass, and shifts only ONE existing index (call-recording-index).
  //
  // THE CURSOR IS POSITIONAL. nightlyHygieneNextTaskIndex is an array index, not
  // a key, so a pass half-finished under the old array resumes at the wrong
  // chore under the new one. Deploy BETWEEN nights, not mid-pass.
  {
    // WHAT IT IS: RingCentral sessions that were logged but never attributed to
    // a source. The service re-asks RC for the call record and resolves it.
    //
    // ⚠ THIS TASK'S INPUT IS DEAD, AND THAT IS WHY IT REPORTS RATHER THAN ZEROES.
    //
    // Probed 2026-08-06 against the shared cluster: the newest
    // family:ringcentral / telephony-session workflow record is 2026-06-30, and
    // there have been zero `ringcentral.attribution.resolved` events since. The
    // writer is the ringcentral-cx app (ringcentralExService:773), which is
    // still ALIVE — it wrote family:cx cadence-queue rows today — so this is a
    // dead feed inside a live service, not a stopped service. The reconciler
    // itself ran hourly × 3 domains until 2026-08-03 14:00Z and returned
    // scanned=0 on every single run for 37 days.
    //
    // A task that wraps this and reports "0 sessions reconciled" would say
    // attribution is clean when it means the feed is gone. So plan() counts the
    // FEED, not the service, and describe() names a dead feed as dead. That also
    // keeps the standing dry-run cheap: plan() must run every night whether or
    // not this is armed, and the service cannot be dry-run safely — its
    // resolveInboundCallSource call sits OUTSIDE the dryRun guard
    // (ringcentralReconcileService:140) and would burn RC quota nightly on a
    // dark task.
    key: "session-reconcile",
    label: "Reconcile unattributed RingCentral sessions",
    writesArmed: () => String(process.env.NIGHTLY_SESSION_RECONCILE_ENABLED || "false").toLowerCase() === "true",
    async plan({ domains, logger }) {
      const { WorkflowRecord } = require("../../../../packages/shared-models/src");
      const cutoff = new Date(Date.now() - SESSION_LOOKBACK_MS);
      const out = [];
      for (const domain of domains) {
        const feed = {
          domain, family: "ringcentral", subtype: "call",
          stage: "completed", aggregateType: "telephony-session",
        };
        try {
          const [inWindow, newest] = await Promise.all([
            WorkflowRecord.countDocuments({ ...feed, happenedAt: { $gte: cutoff } }),
            WorkflowRecord.findOne(feed).sort({ happenedAt: -1 }).select({ happenedAt: 1 }).lean(),
          ]);
          out.push({
            domain,
            sessions: Number(inWindow) || 0,
            newestEver: newest?.happenedAt || null,
            examineCap: SESSION_SCAN_LIMIT,
          });
        } catch (error) {
          // A feed we could not COUNT is not an empty feed.
          logger?.warn?.(`session-reconcile plan failed for ${domain}: ${error.message}`);
          out.push({ domain, sessions: null, newestEver: null, error: String(error.message).slice(0, 160) });
        }
      }
      return out;
    },
    count(planned) {
      return planned.reduce((acc, p) => acc + (Number(p.sessions) || 0), 0);
    },
    async apply(planned, { logger, sessionReconcileImpl = null }) {
      const reconcile = sessionReconcileImpl
        || require("../../../../packages/shared-services/src/ringcentralReconcileService")
          .reconcileUnattributedSessions;
      const out = { written: 0, scanned: 0, unmatched: 0, truncated: 0, skipped: 0, failed: 0, errors: [] };
      for (const row of planned) {
        // A domain we could not COUNT is not a domain with nothing in it, and
        // it must not land in the same bucket. `skipped` means "asked, empty";
        // this is "never asked", and it is a failure.
        if (row.sessions === null) {
          out.failed += 1;
          out.errors.push(`${row.domain}: NOT EXAMINED — ${row.error || "feed count failed"}`);
          continue;
        }
        // Nothing to look at, and nothing to learn by asking RC.
        if (!row.sessions) { out.skipped += 1; continue; }
        try {
          const r = await reconcile({
            domain: row.domain,
            sinceMs: SESSION_LOOKBACK_MS,
            limit: SESSION_SCAN_LIMIT,
            logger,
          });
          const s = r?.stats || {};
          out.written += Number(s.resolved) || 0;
          out.scanned += Number(s.scanned) || 0;
          out.unmatched += Number(s.unmatched) || 0;
          out.failed += Number(s.errors) || 0;
          // The service stops at `limit` and says nothing about it. Anything
          // above the cap was never examined — count it so the summary can.
          if ((Number(s.scanned) || 0) >= SESSION_SCAN_LIMIT) {
            out.truncated += Math.max(0, (Number(row.sessions) || 0) - SESSION_SCAN_LIMIT);
          }
        } catch (error) {
          out.failed += 1;
          out.errors.push(`${row.domain}: ${String(error.message).slice(0, 160)}`);
        }
      }
      return out;
    },
    describe(planned) {
      const unreadable = planned.filter((p) => p.sessions === null);
      if (unreadable.length && unreadable.length === planned.length) {
        return `COULD NOT COUNT THE SESSION FEED — ${unreadable[0]?.error || "unknown"}`;
      }
      // A PARTIAL failure has to lead, not be folded into the count.
      //
      // The all-or-nothing guard above used to be the only one, so one domain's
      // Mongo hiccup rendered as "no unattributed sessions in the window" — or,
      // when the other domains were legitimately empty, as the confident
      // "THE SESSION FEED IS DEAD". Both are the exact could-not-look /
      // was-not-there conflation this task exists to avoid, and a dead-feed
      // banner is not a claim to make on partial evidence.
      const partial = unreadable.length
        ? `${unreadable.map((p) => p.domain).join(", ")} NOT COUNTED (${unreadable[0]?.error || "unknown"})`
        : "";
      const readable = planned.filter((p) => p.sessions !== null);
      const total = readable.reduce((acc, p) => acc + (Number(p.sessions) || 0), 0);
      if (partial) {
        return `${partial} — of the ${readable.length} domain(s) read, ${total} session(s)`;
      }
      if (!total) {
        // The whole reason this task describes rather than reports a number.
        const newest = planned
          .map((p) => p.newestEver).filter(Boolean)
          .sort((a, b) => new Date(b) - new Date(a))[0] || null;
        if (!newest) return "THE SESSION FEED IS DEAD — no telephony-session has EVER been recorded";
        const days = Math.floor((Date.now() - new Date(newest).getTime()) / 86400000);
        if (days >= 2) {
          // toISOString, NOT String(). plan() reads through .lean(), so
          // newestEver is a Date — and String(date).slice(0,10) renders
          // "Tue Jun 30", dropping the year from the one line whose whole job
          // is to say how long this feed has been dead.
          return `THE SESSION FEED IS DEAD — nothing written since ${new Date(newest).toISOString().slice(0, 10)}`
            + ` (${days} days). ringcentral-cx is still running; its telephony-session writer is not.`;
        }
        return "no unattributed sessions in the window";
      }
      const capped = readable.filter((p) => (Number(p.sessions) || 0) > SESSION_SCAN_LIMIT);
      return `${total} session(s) across ${readable.length} domain(s)`
        + (capped.length
          ? ` — CAP ${SESSION_SCAN_LIMIT}/domain, ${capped.map((p) => `${p.domain} leaves ${p.sessions - SESSION_SCAN_LIMIT} unexamined`).join(", ")}`
          : "");
    },
  },
  {
    // Pulls each case's billing from Logics and writes any ledger row we do not
    // already have. This is the money reconciler; payment-fields-sync below
    // reads what it writes, which is why it runs FIRST.
    //
    // THE CAP IS 500/DOMAIN, NOT 10,000. The work order proposed inheriting
    // nightlyCloseService:267's 10,000, on the reasoning that a nightly pass
    // needs a nightly-sized cap. Two problems. The loop is strictly serial and
    // unpaced (paymentReconcileService:600) at one Logics round-trip per case
    // plus one more per new SUCCESS row, and logicsClient has no rate limiter,
    // no concurrency cap and a 20s timeout (logicsClient:107) — so 10,000 ×
    // three domains is hours, against a 45-minute claim lease
    // (HYGIENE_CLAIM_LEASE_MS). And that 10,000 is dead code anyway:
    // nightlyCloseService:259 short-circuits to "retired-from-nightly-close"
    // before ever reaching it. 500 × 3 is ~1,500 serial calls, which fits the
    // lease with room for the timeout tail. Raise it deliberately, after a
    // cycle has been observed — that is what the env override is for.
    key: "payment-reconcile",
    label: "Reconcile payments against Logics (ledger truth)",
    writesArmed: () => String(process.env.NIGHTLY_PAYMENT_RECONCILE_ENABLED || "false").toLowerCase() === "true",
    async plan({ domains }) {
      // Deliberately does NOT enumerate candidates. The only honest count would
      // come from re-running the service's own candidate queries, which drifts
      // the moment the service changes its lanes — and the service has no
      // Logics-free dry run. One indivisible unit, per the spend-sync idiom.
      return [{ domains: [...domains], maxCases: nightlyPaymentReconcileMaxCases() }];
    },
    count() { return 1; },
    async apply(planned, { logger, paymentReconcileImpl = null }) {
      const reconcile = paymentReconcileImpl
        || require("../../../../packages/shared-services/src/paymentReconcileService")
          .reconcilePaymentsForDomain;
      const p = planned[0] || {};
      const out = {
        written: 0, casesScanned: 0, casesWithPayments: 0,
        flaggedFailures: 0, reversals: 0, capSaturated: 0, failed: 0, errors: [], domains: [],
      };
      for (const domain of p.domains || []) {
        try {
          const r = await reconcile({
            domain,
            maxCases: p.maxCases,
            // "hourly" is correct even from the nightly pass. Retry jobs are
            // claimed by drainHourlyJobQueue, which runs every 60s OUTSIDE the
            // dead scheduledPhase gate (hourlySweeperService:1281) — so an
            // hourly-lane job is picked up within the hour. The "nightly" lane
            // would hardcode 02:00 (hourlyJobEventService:26), which is not
            // when this pass fires and has no claimer.
            lane: "hourly",
            logger,
          });
          out.written += Number(r?.newLedgerRows) || 0;
          out.casesScanned += Number(r?.casesScanned) || 0;
          out.casesWithPayments += Number(r?.casesWithPayments) || 0;
          out.flaggedFailures += Number(r?.flaggedFailures) || 0;
          out.reversals += Number(r?.reversals) || 0;
          out.failed += Number(r?.errors) || 0;
          // SAY WHEN THE CAP BOUND. staleAfterMs stays at the service's 1-hour
          // default, so run once a night every profile is "due" and the due lane
          // fills to maxCases on any domain bigger than the cap — measured at
          // 93,076 profiles for TAG. A saturated night is a partial night, and
          // total/maxCases nights to complete one wheel, which the operator can
          // only weigh if the saturation is reported rather than inferred.
          const saturated = (Number(r?.due ?? r?.casesScanned) || 0) >= p.maxCases;
          if (saturated) out.capSaturated += 1;
          out.domains.push({
            domain, newLedgerRows: Number(r?.newLedgerRows) || 0, capSaturated: saturated,
          });
        } catch (error) {
          // One domain's Logics outage must not cost the other two.
          out.failed += 1;
          out.errors.push(`${domain}: ${String(error.message).slice(0, 160)}`);
          out.domains.push({ domain, error: true });
        }
      }
      return out;
    },
    describe(planned) {
      const p = planned[0] || {};
      return `up to ${p.maxCases} case(s) per domain across ${(p.domains || []).join(", ") || "no domains"}`
        + " — serial Logics pulls, ledger rows written only where Logics has one we do not";
    },
  },
  {
    // Recomputes the CaseProfile payment-derived fields from the ledger. Runs
    // AFTER payment-reconcile, and that order is load-bearing for a reason the
    // work order did not name: BOTH services stamp the same checkpoint,
    // `paymentReconcile.lastCheckedAt` (paymentReconcileService:485,
    // caseProfilePaymentSyncService:397/438), and reconcile SELECTS on it
    // (caseProfileRepository:852). Reversed, this task stamps the checkpoint to
    // now and suppresses reconcile's own candidate query for exactly the cases
    // it just touched. Nothing in the code enforces the order — only this
    // position and the test that pins it.
    //
    // THREE WINDOWS ARE WIDENED FOR NIGHTLY, all of which Phase A left at their
    // hourly defaults because it never forwarded them (hourlySweeperService:529):
    //   lookbackHours 6 → 26   a 6h window run once a day sees a quarter of it
    //   staleCheckMs  24h → 20h a case stamped at 20:45 is not `< 20:20` the next
    //                           night, so a 24h check silently becomes ~47h
    //   lockTtlMs   10m → 40m   the lock is never extended
    //                           (runLockRepository.extendRunLock is never called),
    //                           so a run longer than its TTL loses mutual exclusion
    key: "payment-fields-sync",
    label: "Sync CaseProfile payment fields from the ledger",
    writesArmed: () => String(process.env.NIGHTLY_PAYMENT_FIELDS_SYNC_ENABLED || "false").toLowerCase() === "true",
    async plan({ domains }) {
      // Same reasoning as payment-reconcile: listCandidateCaseIds is the
      // service's own query and re-running it here would drift.
      return [{
        domains: [...domains],
        maxCases: nightlyPaymentFieldsSyncMaxCases(),
        lookbackHours: FIELDS_SYNC_LOOKBACK_HOURS,
        staleCheckMs: FIELDS_SYNC_STALE_CHECK_MS,
      }];
    },
    count() { return 1; },
    async apply(planned, { logger, paymentFieldsSyncImpl = null }) {
      const sync = paymentFieldsSyncImpl
        || require("../../../../packages/shared-services/src/caseProfilePaymentSyncService")
          .runPaymentFieldsSync;
      const p = planned[0] || {};
      const out = {
        written: 0, casesScanned: 0, casesWithDrift: 0, driftDollars: 0,
        lockBusy: 0, failed: 0, errors: [],
      };
      for (const domain of p.domains || []) {
        try {
          const r = await sync({
            domain,
            lookbackHours: p.lookbackHours,
            staleCheckMs: p.staleCheckMs,
            maxCases: p.maxCases,
            lockTtlMs: FIELDS_SYNC_LOCK_TTL_MS,
            // Its own owner string. "hourly-sweep" is hardcoded at the Phase A
            // call site, and a lock held under that name from a nightly pass is
            // unattributable the one time somebody has to ask who holds it.
            lockedBy: "nightly-hygiene",
            logger,
          });
          // A skipped run is NOT a clean run — it did no work and must not
          // read as zero drift.
          if (r?.skipped) {
            if (r.reason === "lock-busy") out.lockBusy += 1;
            else out.errors.push(`${domain}: skipped — ${r.reason || "unknown"}`);
            continue;
          }
          out.written += Number(r?.casesUpdated) || 0;
          out.casesScanned += Number(r?.casesScanned) || 0;
          out.casesWithDrift += Number(r?.casesWithDrift) || 0;
          out.driftDollars += Number(r?.totalDriftDollars) || 0;
          out.failed += Number(r?.errors) || 0;
        } catch (error) {
          out.failed += 1;
          out.errors.push(`${domain}: ${String(error.message).slice(0, 160)}`);
        }
      }
      // A NIGHT THAT SWEPT NOTHING IS NOT A CLEAN NIGHT. The run lock is global
      // rather than per-domain, so one stale lock — a deploy that killed the
      // process before its `finally` released it — blocks every domain for the
      // full 40-minute TTL, which outlives the runtime's whole retry budget
      // (3 attempts x 5-minute poll). Reported as a skip that would render
      // `casesWithDrift: 0`, indistinguishable from a night with no drift.
      const domainCount = (p.domains || []).length;
      if (domainCount && out.lockBusy === domainCount) {
        out.failed += 1;
        out.errors.push(`every domain was lock-busy — no fields were synced tonight`);
      }
      return out;
    },
    describe(planned) {
      const p = planned[0] || {};
      return `up to ${p.maxCases} case(s) per domain across ${(p.domains || []).join(", ") || "no domains"}`
        + ` — ${p.lookbackHours}h lookback, ${Math.round(p.staleCheckMs / 86400000)}d stale check`;
    },
  },
  {
    // CALL LOG HYGIENE, EVENING HALF — 12:00 PT to now.
    //
    // Mickey 2026-08-06: "call log hygiene could be the thing thats split
    // between 1 and 7." This is the 7 o'clock half; MD2 is the midday half.
    //
    // THE WINDOW IS THE WHOLE POINT, not a scheduling detail. The service
    // filters on `callStartTime` with a 65-minute default, and the only feed
    // still producing — PhoneBurner, ~2,245 rows/day — is projected off a
    // CLOSED DailyDial date, so its rows are created an average of 5.4 hours
    // after the call started. A 65-minute callStartTime window can therefore
    // never see them: measured 2026-08-06, the outbound preview lane finds 0
    // rows in 65 minutes and 947 in 24 hours. Widening to a half-day is what
    // makes the live feed visible at all.
    //
    // WHAT THE PASS WILL AND WILL NOT SEE. Three of the four inputs are dead:
    // rb_contactactivities last wrote 2026-05-04 (and legacy mirroring is off
    // by env anyway, so the mirror → ledger-sync → promotion → case-refresh →
    // metrics-date chain is a structural no-op), CallLog platform "cx" last
    // wrote 2026-07-17, and platform "ex" last wrote 2026-08-03T14:04Z. That
    // last one is self-inflicted: "ex" rows are written BY this service's own
    // native sweep, so it stopped when Phase A went dark. Arming this task is
    // what restarts it.
    key: "call-log-hygiene-evening",
    label: "Call log hygiene — afternoon half (noon PT onward)",
    writesArmed: () => String(process.env.NIGHTLY_CALL_LOG_HYGIENE_ENABLED || "false").toLowerCase() === "true",
    async plan({ domains, logger }) {
      // COUNTS, NEVER CALLS THE SERVICE — the same rule session-reconcile
      // follows, for a stronger reason. plan() runs every night whether or not
      // this is armed, and runHourlyCallLogHygiene has no dryRun of any kind:
      // its read path upserts CallLog rows, syncs the ledger, promotes case
      // profiles, queues recording archives and bills Whisper and Claude. A
      // dark task that called it would write to five providers nightly, and an
      // armed one would pay the entire burst twice.
      const { CallLog } = require("../../../../packages/shared-models/src");
      const sinceMs = pacificMsSinceToday(HYGIENE_EVENING_ANCHOR_HOUR);
      const windowStart = new Date(Date.now() - sinceMs);
      const out = [];
      for (const domain of domains) {
        try {
          const [inbound, outbound] = await Promise.all([
            CallLog.countDocuments({ domain, direction: "inbound", callStartTime: { $gte: windowStart } }),
            CallLog.countDocuments({ domain, direction: "outbound", callStartTime: { $gte: windowStart } }),
          ]);
          out.push({
            domain, sinceMs, windowStart: windowStart.toISOString(),
            inbound: Number(inbound) || 0, outbound: Number(outbound) || 0,
          });
        } catch (error) {
          // Counted nothing is not "there was nothing".
          logger?.warn?.(`call-log-hygiene plan failed for ${domain}: ${error.message}`);
          out.push({
            domain, sinceMs, windowStart: windowStart.toISOString(),
            inbound: null, outbound: null, error: String(error.message).slice(0, 160),
          });
        }
      }
      return out;
    },
    count(planned) {
      return planned.reduce(
        (acc, p) => acc + (Number(p.inbound) || 0) + (Number(p.outbound) || 0), 0,
      );
    },
    async apply(planned, { logger, callLogHygieneImpl = null }) {
      const run = callLogHygieneImpl
        || require("../../../../packages/shared-services/src/hourlyCallLogHygieneService")
          .runHourlyCallLogHygiene;
      const readable = planned.filter((p) => p.inbound !== null);
      const unreadable = planned.filter((p) => p.inbound === null);
      const out = {
        written: 0, mirrored: 0, ledgerSynced: 0, scored: 0, archived: 0,
        nativeInserted: 0, failed: 0, errors: [], truncatedDomains: [],
      };
      for (const p of unreadable) {
        out.failed += 1;
        out.errors.push(`${p.domain}: NOT EXAMINED — ${p.error || "window count failed"}`);
      }
      if (!readable.length) return out;
      try {
        const r = await run({
          domains: readable.map((p) => p.domain),
          // ONE window end for every domain. Left unset, the service derives
          // `now` inside its per-domain body, so domain N's window starts N
          // domains' worth of runtime later than domain 0's — and a wall-clock
          // anchored sinceMs has none of the 5 minutes of slack the 65-minute
          // default carried against an hourly cadence.
          now: new Date(),
          sinceMs: readable[0].sinceMs,
          nativeSweepEnabled: true,
          // Recording evidence is provider-link metadata. The night pass may
          // reconcile call rows, but it must not download, archive, transcribe,
          // score, or enqueue future recording work.
          scorePendingCalls: false,
          archiveRecordings: false,
          limitPerDomain: HYGIENE_EVENING_LIMIT_PER_DOMAIN,
          lane: "hourly",
          logger,
        });
        const t = r?.totals || {};
        out.written = (Number(t.mirrored) || 0) + (Number(t.nativeInserted) || 0);
        out.mirrored = Number(t.mirrored) || 0;
        out.nativeInserted = Number(t.nativeInserted) || 0;
        out.scored = Number(t.scoringCompleted) || 0;
        out.archived = Number(t.archiveQueued) || 0;
        out.failed += (Number(t.nativeErrors) || 0) + (Number(t.metricsErrors) || 0)
          + (Number(t.promotionErrors) || 0) + (Number(t.caseRefreshErrors) || 0)
          + (Number(t.scoringFailed) || 0) + (Number(t.archiveFailed) || 0);
        // ledgerSynced is NOT in totals — the service accumulates it per domain
        // and never rolls it up, which is why Phase A's summarizer has always
        // printed ledgerSynced: 0. Sum it here rather than repeat that.
        for (const d of Array.isArray(r?.domains) ? r.domains : []) {
          out.ledgerSynced += Number(d?.result?.counts?.ledgerSynced) || 0;
          if (d?.ok === false) {
            out.failed += 1;
            out.errors.push(`${d.domain}: ${String(d.error || "domain failed").slice(0, 160)}`);
          }
        }
      } catch (error) {
        // The service fans out over every domain in one call, so a throw here
        // is the whole half-day, not one tenant.
        out.failed += 1;
        out.errors.push(`hygiene pass failed: ${String(error.message).slice(0, 200)}`);
      }
      // Say what the preview lane could not reach. The repository clamps its
      // query to 500 rows newest-first, so on a busy afternoon the OLDEST rows
      // in the window — the ones nearest the midday seam — are the ones dropped,
      // and nothing in the service's own output says so.
      for (const p of readable) {
        for (const dir of ["inbound", "outbound"]) {
          if ((Number(p[dir]) || 0) > HYGIENE_PREVIEW_ROW_CLAMP) {
            out.truncatedDomains.push(`${p.domain}/${dir} ${p[dir] - HYGIENE_PREVIEW_ROW_CLAMP} unpreviewed`);
          }
        }
      }
      return out;
    },
    describe(planned) {
      const unreadable = planned.filter((p) => p.inbound === null);
      if (unreadable.length && unreadable.length === planned.length) {
        return `COULD NOT COUNT THE CALL WINDOW — ${unreadable[0]?.error || "unknown"}`;
      }
      const readable = planned.filter((p) => p.inbound !== null);
      const hours = ((readable[0]?.sinceMs ?? planned[0]?.sinceMs ?? 0) / 3600000).toFixed(1);
      const start = String(readable[0]?.windowStart ?? planned[0]?.windowStart ?? "").slice(11, 16);
      const total = readable.reduce((a, p) => a + p.inbound + p.outbound, 0);
      const per = readable
        .map((p) => `${p.domain} ${p.inbound}in/${p.outbound}out`).join(" · ");
      const truncated = readable
        .filter((p) => p.inbound > HYGIENE_PREVIEW_ROW_CLAMP || p.outbound > HYGIENE_PREVIEW_ROW_CLAMP)
        .map((p) => p.domain);
      return `${hours}h since ${start}Z: ${total} call(s) [${per || "none"}]`
        + (unreadable.length ? ` · ${unreadable.map((p) => p.domain).join(", ")} NOT COUNTED` : "")
        + (truncated.length
          ? ` · PREVIEW CAPPED at ${HYGIENE_PREVIEW_ROW_CLAMP}/direction for ${truncated.join(", ")}`
          : "");
    },
  },
  {
    // EVERY PROVIDER'S RECORDING LINKS, INTO ONE COLLECTION.
    //
    // Metadata is ours, media stays with the vendor — this stores locators, not
    // audio. It is the successor to dumping recordings into Drive, which is the
    // storage we are getting away from.
    //
    // Runs here rather than as its own timer for the same reason as costing: it
    // is a data-layer build step that the morning's reads depend on, and a
    // second clock is a second thing to fail.
    key: "call-recording-index",
    label: "Index every provider's recording links",
    writesArmed: () => String(process.env.CALL_RECORDING_INDEX_ENABLED || "false").toLowerCase() === "true",
    async plan({ logger, at }) {
      const { gatherRecordingLinks } = require(
        "../../../../packages/shared-services/src/callRecordingIndexService");
      // plan() is a FULL dry run — every read, every verdict, no write. So the
      // funnel printed on a dark box is exactly what arming it would do.
      return [await gatherRecordingLinks({ dateKey: persistTargetDay(at), apply: false, logger })];
    },
    async apply(planned, { logger }) {
      const { gatherRecordingLinks } = require(
        "../../../../packages/shared-services/src/callRecordingIndexService");
      const p = planned[0] || {};
      const r = await gatherRecordingLinks({ dateKey: p.dateKey, apply: true, logger });
      return { written: r.written, skipped: r.kept - r.written, failed: r.errors.length, errors: r.errors.slice(0, 5) };
    },
    count(planned) {
      return Number(planned[0]?.kept || 0);
    },
    describe(planned) {
      const p = planned[0] || {};
      // A source that could not be READ reports null, not zero — "we could not
      // look" and "there was nothing" are different days.
      const src = Object.entries(p.bySource || {})
        .map(([k, v]) => `${k} ${v === null ? "UNREADABLE" : v}`).join(" · ");
      return `${p.dateKey || "?"}: ${p.kept || 0} link(s) [${src}]`
        + ` · ${p.significant || 0} significant · ${p.durable || 0} durable`
        + (p.mintOnly ? ` · ${p.mintOnly} mint-on-read` : "")
        + (p.unresolvedProvider ? ` · ${p.unresolvedProvider} UNRESOLVED PROVIDER` : "");
    },
  },
  {
    ...createPassRetryDrainTask({ passKey: "nightly" }),
    // A retry backlog belongs in the receipt, but may not suppress the
    // financial/vendor close. Unresolved jobs remain durable for next pass.
    continueOnFailure: true,
  },
  {
    // THE DATA EMAILS ARE THE LAST BUSINESS STEP OF THIS RUN, NOT A SECOND
    // SCHEDULER. A count-only operator receipt follows them and changes no
    // business data.
    //
    // ReportDefinition still owns recipient/range/shape policy and the durable
    // lastRunKey that prevents a retry from emailing a successful report twice.
    // reportScheduleRuntime's standalone timer surrenders when this nightly
    // pipeline is armed, leaving this shared cursor as the sole clock owner.
    key: "report-delivery",
    label: "Send scheduled nightly summary reports",
    // Unlike the earlier hygiene chores, this is not an optional writer. Once
    // this runtime owns the nightly close, completing the cursor without this
    // task would falsely record a successful night with no report. The loop
    // turns a disarmed required task into the same bounded emergency close used
    // for a timeout/crash instead of treating it as a standing dry run.
    requiredForClose: true,
    requiredDueAt: (planned) => planned[0]?.dueAt,
    writesArmed: () => String(process.env.REPORT_SCHEDULER_ENABLED || "false").toLowerCase() === "true",
    plan({ at }) {
      return [{ dueAt: nightlyReportDueAt(at) }];
    },
    async apply(planned, { reportScheduleRuntime }) {
      if (!reportScheduleRuntime || typeof reportScheduleRuntime.poll !== "function") {
        const error = new Error("nightly report delivery requires reportScheduleRuntime.poll");
        error.code = "REPORT_SCHEDULE_RUNTIME_MISSING";
        throw error;
      }
      const dueAt = new Date(planned[0]?.dueAt);
      if (Number.isNaN(dueAt.getTime())) {
        const error = new Error("nightly report delivery planned an invalid due time");
        error.code = "REPORT_DELIVERY_DUE_AT_INVALID";
        throw error;
      }
      await waitUntil(dueAt);
      const result = await reportScheduleRuntime.poll({ force: true, now: dueAt });
      if (result?.error) {
        const error = new Error(`nightly report scheduler failed: ${result.error}`);
        error.code = "REPORT_SCHEDULE_POLL_FAILED";
        throw error;
      }
      const failed = (result?.results || []).filter((row) => row?.error);
      if (failed.length) {
        const error = new Error(`${failed.length} scheduled nightly report(s) failed`);
        error.code = "REPORT_DELIVERY_FAILED";
        throw error;
      }
      const delivered = (result?.results || []).filter((row) => row?.delivered).length;
      if (delivered === 0) {
        const error = new Error("nightly report scheduler delivered no reports");
        error.code = "REPORT_DELIVERY_EMPTY";
        throw error;
      }
      return {
        written: delivered,
        skipped: Math.max(0, Number(result?.ran || 0) - delivered),
        failed: 0,
        ran: Number(result?.ran || 0),
        reports: (result?.results || []).map((row) => ({
          name: row?.name || null,
          delivered: Boolean(row?.delivered),
          agedSourceWrite: row?.agedSourceWrite || null,
        })),
      };
    },
    count() {
      // One orchestration step even when no ReportDefinition is due. The
      // executor decides due-ness from each definition's durable daily claim.
      return 1;
    },
    describe(planned) {
      const dueAt = planned[0]?.dueAt;
      return dueAt instanceof Date && !Number.isNaN(dueAt.getTime())
        ? `scheduled definitions due by ${dueAt.toISOString().slice(11, 16)}Z`
        : "scheduled nightly definitions";
    },
  },
  {
    // Repair prior stored days only AFTER the current financial/vendor boards
    // are safely claimed and sent. A late invoice or unresolved attribution
    // can therefore never delay or invalidate tonight's email. The plan is the
    // cheap indexed seven-day scan; apply recomposes only those exact dates.
    key: "historical-report-repair",
    label: "Repair unresolved report facts from the prior seven days",
    writesArmed: () => String(process.env.REPORT_SCHEDULER_ENABLED || "false").toLowerCase() === "true",
    continueOnFailure: true,
    async plan({ at, logger }) {
      const { findHistoricalDailyFactRepairs } = require(
        "../../../../packages/shared-services/src/dailySnapshotService"
      );
      const currentDateKey = persistTargetDay(at);
      const candidates = await findHistoricalDailyFactRepairs({
        currentDateKey,
        includeMailSheet: true,
        logger,
      });
      return [{ currentDateKey, candidates }];
    },
    async apply(planned, { logger }) {
      const { repairHistoricalDailyFacts } = require(
        "../../../../packages/shared-services/src/dailySnapshotService"
      );
      const row = planned[0] || {};
      const result = await repairHistoricalDailyFacts({
        currentDateKey: row.currentDateKey,
        candidates: row.candidates || [],
        logger,
      });
      return {
        written: Number(result.repaired || 0),
        skipped: 0,
        failed: 0,
        attention: Number(result.failed || 0),
      };
    },
    count(planned) {
      return Array.isArray(planned[0]?.candidates) ? planned[0].candidates.length : 0;
    },
    describe(planned) {
      return `${Array.isArray(planned[0]?.candidates) ? planned[0].candidates.length : 0} prior day(s) need repair`;
    },
  },
  {
    // One indexed operator check after the business reports. It may make only
    // the two bounded, CAS-protected repairs owned by the lead-delivery
    // runtime: release an expired reservation that never reached the provider,
    // or extend a legacy 15+ attempt retry date to the current phase-out floor.
    // It never selects, reserves, posts, or requalifies leads. The recount feeds
    // the run-summary receipt immediately below.
    key: "lead-health",
    label: "Measure nightly lead-delivery health",
    writesArmed: () => true,
    continueOnFailure: true,
    async plan({ at }) {
      const { gatherLeadDeliveryHealth } = require(
        "../../../../packages/shared-services/src/leadDeliveryHealthService"
      );
      return [await gatherLeadDeliveryHealth({ dateKey: persistTargetDay(at), at })];
    },
    async apply(planned, { at, leadDeliveryRuntime = null }) {
      if (!leadDeliveryRuntime
        || typeof leadDeliveryRuntime.repairNightlyLeadHealth !== "function") {
        const error = new Error("nightly lead-health repair runtime is unavailable");
        error.code = "LEAD_HEALTH_REPAIR_RUNTIME_MISSING";
        throw error;
      }
      const repair = await leadDeliveryRuntime.repairNightlyLeadHealth(at, { limit: 100 });
      const { gatherLeadDeliveryHealth } = require(
        "../../../../packages/shared-services/src/leadDeliveryHealthService"
      );
      const after = await gatherLeadDeliveryHealth({ dateKey: persistTargetDay(at), at });
      return {
        written: Number(repair.expiredReservationsReleased || 0)
          + Number(repair.phaseOutDatesRepaired || 0),
        skipped: 0,
        failed: 0,
        leadHealth: {
          ...after,
          before: planned[0],
          repair,
        },
      };
    },
    count() {
      return 1;
    },
    describe(planned) {
      const health = planned[0] || {};
      return `${Number(health.attempts?.total || 0)} call(s); `
        + `${Number(health.inventory?.zeroTouch || 0)} zero-touch open; `
        + `${Number(health.inventory?.due?.lowTouch || 0)} lightly worked due`;
    },
  },
  {
    // A receipt, not another reporting gather. It reads only the aggregate
    // task results already in memory and tells the operator what changed and
    // what still needs attention. Keeping it on its own durable cursor step
    // means a mail failure retries only this receipt, never the NCOA/source
    // writes or the already-claimed financial/vendor reports.
    key: "run-summary",
    label: "Email the nightly run summary",
    writesArmed: () => String(process.env.REPORT_SCHEDULER_ENABLED || "false").toLowerCase() === "true",
    plan() {
      return [{ planned: 1 }];
    },
    suppressEmergencyFallback: true,
    async apply(planned, { priorResults, at, runSummarySender = null }) {
      const sendNightlyRunSummary = runSummarySender || require(
        "../../../../packages/shared-services/src/nightlyRunSummaryService"
      ).sendNightlyRunSummary;
      const dateKey = persistTargetDay(at);
      const claimedAt = await claimNightlyRunSummary(dateKey, at);
      if (!claimedAt) return { written: 0, skipped: 1, failed: 0 };
      try {
        const sent = await sendNightlyRunSummary({
          dateKey,
          results: priorResults,
          recipients: ["mgray@taxadvocategroup.com"],
        });
        return { written: sent.sent ? 1 : 0, skipped: 0, failed: sent.sent ? 0 : 1 };
      } catch (error) {
        await releaseNightlyRunSummary(dateKey, claimedAt).catch(() => {});
        throw error;
      }
    },
    count() {
      return 1;
    },
    describe() {
      return "count-only completion and follow-up receipt";
    },
  },
];

// WHY THERE IS NO "cost-counts" TASK HERE.
//
// One was written on 2026-08-04 and removed the same day. It counted LD leads
// and BCD calls into SpendEntry rows — a second store for numbers the report
// already derives. Mickey's correction: "think of it, instead of making its own
// collection, it's making its section of the nightly snapshot that's just all
// the costs by source."
//
// The `spend` report block (reportBlocksService, id "spend") ALREADY computes
// exactly that — total, ld, ldLeads, mail, mailPieces, bcd, bcdCalls — from the
// one gather. The gap was never the counting; it was that the snapshot captured
// topline/source/ldcalls/status and dropped spend on the floor. So the fix is a
// line in dailyReportFactService, not a task here.

// WHY THERE IS NO "daily-snapshot" TASK HERE.
//
// One was added on 2026-08-04 and removed the same day, because a task in THIS
// registry is the wrong home for it and would have cost exactly what the
// consolidation was meant to save:
//
//  · A task receives no report. Its only possible body was a SECOND live
//    composeReport at 19:50 — a whole extra gather against Logics, CallRail and
//    RingCentral ten minutes before the email's own. Mickey's instruction was
//    the opposite: "do it in one shot and just branch ... so you don't have to
//    run the activities twice."
//  · The two gathers would not even describe the same day. persistTargetDay()
//    here is offset 0 (TODAY, still open at 19:50), while ReportDefinition
//    defaults range to "yesterday" — so the snapshot would write a DIFFERENT
//    dateKey, then be silently overwritten 24h later, because
//    persistDailyReportFact $sets the whole document against a unique dateKey.
//
// The branch Mickey asked for ALREADY EXISTS, one level up: reportDefinitionService
// composes the report ONCE and then calls captureDeliveredDailyFact with that
// same already-computed report. It simply runs AFTER sendMail today. Moving that
// call ahead of the send is the entire change — one gather, snapshot first,
// email second. See §5c of the work order.

function createNightlyHygieneRuntime({ config = {}, runtime = {} } = {}) {
  // Each runtime owns its OWN task list. TASKS is the shared default, and
  // handing the module-level array out directly meant any caller mutating it
  // (a test, a future config path) silently reconfigured every other
  // instance — including, in principle, the live one.
  const reportDeliveryEnabled = config.reportDeliveryEnabled === true
    || String(process.env.REPORT_SCHEDULER_ENABLED || "false").toLowerCase() === "true";
  const tasks = (Array.isArray(config.tasks) ? [...config.tasks] : [...TASKS])
    .map((task) => (["report-delivery", "historical-report-repair", "lead-health", "run-summary"].includes(task.key)
      ? { ...task, writesArmed: () => reportDeliveryEnabled }
      : task));

  // Collaborators the folded-in tasks need. They are INJECTED rather than
  // required at module load because each one is constructed by server.js with
  // live config — and because a task whose collaborator is missing must report
  // that plainly (failed + a named error) instead of throwing and taking the
  // rest of the pass down with it.
  const collaborators = {
    spendSyncRuntime: config.spendSyncRuntime || runtime.spendSyncRuntime || null,
    activityReviewRuntime: config.activityReviewRuntime || runtime.activityReviewRuntime || null,
    reportScheduleRuntime: config.reportScheduleRuntime || runtime.reportScheduleRuntime || null,
    leadDeliveryRuntime: config.leadDeliveryRuntime || runtime.leadDeliveryRuntime || null,
    runSummarySender: config.runSummarySender || runtime.runSummarySender || null,
  };

  // The emergency close is intentionally local-file + SMTP only. It is armed
  // by server.js only when the nightly pipeline owns report delivery; direct
  // unit instances remain side-effect free unless a test opts in explicitly.
  const emergencyCloseEnabled = config.emergencyCloseEnabled === true;
  const emergencyClose = {
    stateFile: config.emergencyClose?.stateFile,
    recipients: config.emergencyClose?.recipients || null,
    readCheckpoint: config.emergencyClose?.readCheckpoint || readEmergencyCloseCheckpoint,
    markStarted: config.emergencyClose?.markStarted || markNightlyCloseStarted,
    markCompleted: config.emergencyClose?.markCompleted || markNightlyCloseCompleted,
    launch: config.emergencyClose?.launch || launchEmergencyNightlyClose,
    send: config.emergencyClose?.send || sendEmergencyNightlyClose,
  };

  // Per-instance retry counter, keyed `${dateKey}:${taskIndex}`. Pruned to the
  // current day on each pass so it cannot grow unbounded across nights.
  const state = {
    enabled: config.enabled === true || String(process.env.NIGHTLY_HYGIENE_ENABLED) === "true",
    hour: Math.min(23, Math.max(0, Number(config.hour ?? process.env.NIGHTLY_HYGIENE_HOUR ?? DEFAULT_HOUR))),
    minute: Math.min(59, Math.max(0, Number(config.minute ?? process.env.NIGHTLY_HYGIENE_MINUTE ?? DEFAULT_MINUTE))),
    pollMs: Math.max(60000, Number(config.pollMs || process.env.NIGHTLY_HYGIENE_POLL_MS) || DEFAULT_POLL_MS),
    days: Math.max(1, Number(config.days || process.env.NIGHTLY_HYGIENE_DAYS) || 3),
    taskTimeoutMs: Math.max(
      1000,
      Number(config.taskTimeoutMs || process.env.NIGHTLY_HYGIENE_TASK_TIMEOUT_MS)
        || DEFAULT_TASK_TIMEOUT_MS,
    ),
    // ALL tenants by default, matching runNightPass. Defaulting to TAG meant
    // WYNN and AMITY activity events and payment truths were never written -
    // two thirds of the tenants silently dropped. A task that only applies to
    // one tenant (the source writer has a TAG-only registry) skips the rest
    // by itself.
    domains: (config.domains || String(process.env.NIGHTLY_HYGIENE_DOMAINS || "TAG,WYNN,AMITY"))
      .toString().split(",").map((d) => d.trim().toUpperCase()).filter(Boolean),
    running: false,
    timer: null,
    lastRunKey: null,          // Pacific day of the last COMPLETED pass
    lastRunAt: null,
    lastResult: null,
    lastError: null,
    activeDay: null,
    fallback: null,
    totals: { passes: 0, planned: 0, written: 0 },
  };

  const log = runtime.logger || null;
  const claimHeartbeatMs = Math.max(
    10,
    Number(config.claimHeartbeatMs) || Math.floor(HYGIENE_CLAIM_LEASE_MS / 3),
  );

  function emergencyArgs(dateKey, reasonCode, taskKey = null) {
    return {
      dateKey,
      reasonCode,
      taskKey,
      ...(emergencyClose.stateFile ? { stateFile: emergencyClose.stateFile } : {}),
      ...(emergencyClose.recipients ? { recipients: emergencyClose.recipients } : {}),
    };
  }

  async function triggerEmergencyClose(dateKey, reasonCode, taskKey = null, { detached = true } = {}) {
    if (!emergencyCloseEnabled) return { skipped: true, reason: "emergency-close-disabled" };
    try {
      const result = detached
        ? emergencyClose.launch(emergencyArgs(dateKey, reasonCode, taskKey))
        : await emergencyClose.send(emergencyArgs(dateKey, reasonCode, taskKey));
      state.fallback = {
        at: new Date().toISOString(),
        day: dateKey,
        reasonCode,
        task: taskKey,
        result,
      };
      return result;
    } catch (error) {
      state.fallback = {
        at: new Date().toISOString(),
        day: dateKey,
        reasonCode,
        task: taskKey,
        error: error?.code || error?.name || "fallback-failed",
      };
      log?.error?.("nightly_hygiene.emergency_close_failed", {
        day: dateKey,
        reasonCode,
        task: taskKey,
        error: String(error?.message || error).slice(0, 160),
      });
      return { sent: false, error: state.fallback.error };
    }
  }

  async function withClaimHeartbeat(dateKey, claim, work) {
    if (!claim) return work();
    let stopped = false;
    let timer = null;
    let inFlight = null;
    let lost = null;

    const beat = async () => {
      if (stopped || lost) return;
      inFlight = (async () => {
        try {
          const renewed = await renewNightlyHygiene(dateKey, claim.claimedAt, new Date());
          if (!renewed) lost = cursorLost();
          else claim.claimedAt = renewed;
        } catch {
          lost = cursorLost();
        }
      })();
      await inFlight;
      inFlight = null;
      if (!stopped && !lost) {
        timer = setTimeout(beat, claimHeartbeatMs);
        timer.unref?.();
      }
    };

    timer = setTimeout(beat, claimHeartbeatMs);
    timer.unref?.();
    let value;
    let workError = null;
    try {
      value = await work();
    } catch (error) {
      workError = error;
    } finally {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (inFlight) await inFlight;
    }
    if (lost) throw lost;
    if (workError) throw workError;
    return value;
  }

  /** One pass over every task. `force` ignores the clock and the once-a-day rule. */
  async function runOnce({ force = false, apply = null, at = new Date() } = {}) {
    // Guard FIRST — every early return below must be unable to skip its
    // release. A runtime on this box once wedged permanently because the
    // `finally` belonged to a different `try`.
    if (state.running) return { skipped: "already running" };
    if (!state.enabled && !force) return { skipped: "disabled" };
    const today = pacificKey(at);
    if (emergencyCloseEnabled && !force) {
      const checkpoint = emergencyClose.readCheckpoint(emergencyClose.stateFile);
      if (checkpoint?.dateKey === today && checkpoint.fallbackSentAt) {
        state.lastRunKey = today;
        return { skipped: "emergency close already sent" };
      }
      if (checkpoint?.dateKey === today
        && ["fallback-launched", "fallback-sending"].includes(checkpoint.status)) {
        const lastAttemptAt = new Date(
          checkpoint.fallbackStartedAt || checkpoint.fallbackLaunchedAt || 0,
        ).getTime();
        if (Number.isFinite(lastAttemptAt) && Date.now() - lastAttemptAt < 5 * 60 * 1000) {
          return { skipped: "emergency close in progress" };
        }
      }
      if (checkpoint?.dateKey === today && checkpointNeedsRecovery(checkpoint)) {
        await triggerEmergencyClose(today, "fallback-retry", checkpoint.taskKey || "runtime");
        return { skipped: "emergency close recovery launched" };
      }
    }
    let durableClaim = null;
    if (!force) {
      if (state.lastRunKey === today) return { skipped: "already ran today" };
      if (!isPacificBusinessDay(at)) return { skipped: "pacific-weekend" };
      const now = pacificHourMinute(at);
      if (now.hour * 60 + now.minute < state.hour * 60 + state.minute) {
        return { skipped: "before the scheduled time" };
      }
      // Compared against a stored day key, not a boolean, so a restart cannot
      // re-run the pass (or a second one) later the same night.
    }
    if (!force) {
      durableClaim = await claimNightlyHygiene(today, at);
      if (!durableClaim) return { skipped: "already claimed or completed" };
    }
    state.running = true;
    state.activeDay = today;
    state.lastError = null;
    const started = Date.now();
    try {
      if (emergencyCloseEnabled) {
        emergencyClose.markStarted({
          dateKey: today,
          at,
          ...(emergencyClose.stateFile ? { stateFile: emergencyClose.stateFile } : {}),
        });
      }
      // A resumed pass starts with the count-only receipts written alongside
      // its durable cursor. Without them, resuming directly at run-summary
      // would claim that the earlier NCOA/repair/source tasks did nothing.
      const results = force ? [] : [...(durableClaim.taskResults || [])];
      const startTaskIndex = force ? 0 : Math.min(durableClaim.nextTaskIndex, tasks.length);
      const durableCounts = () => ({
        tasks: results.filter((row) => !row.error && !row.errorCode).length,
        planned: results.reduce((sum, row) => sum + Number(row.planned || 0), 0),
        written: results.reduce((sum, row) => sum + Number(row.applied?.written || 0), 0),
        failed: results.filter((row) => Boolean(row.error || row.errorCode)).length,
      });
      for (let taskIndex = startTaskIndex; taskIndex < tasks.length; taskIndex += 1) {
        const task = tasks[taskIndex];
        const taskStarted = Date.now();
        try {
          const armed = apply === null ? task.writesArmed() : Boolean(apply);

          // THE STANDING DRY RUN. plan() runs for every task, armed or not.
          //
          // This branch used to skip plan() entirely when a task was unarmed and
          // report planned: 0 — while the contract above says "plan() — read-only;
          // always safe, always run, so `lastRun` shows the work even when the task
          // may not write." The code did the opposite of its own promise, and the
          // cost was not cosmetic: every task landed dark reported nothing, so the
          // "observe one cycle, then arm" discipline this chain depends on had no
          // evidence to observe. Arming was a guess.
          //
          // The price is real and accepted: eleven plan() calls a night whether or
          // not anything is armed, and some of them are not cheap — mail-invoice
          // opens a mailbox, call-recovery-discovery consumes a full gather. That
          // is what a standing dry run costs, and it fits inside the claim lease.
          const planned = await withClaimHeartbeat(today, durableClaim, () => withTimeout(
            () => task.plan({
              domains: state.domains,
              days: state.days,
              logger: log,
              at,
            }),
            task.timeoutMs || state.taskTimeoutMs,
            { taskKey: task.key, phase: "plan" },
          ));
          // Each task decides what "something to do" means; the row-list shape
          // is only the default, not an assumption the runtime may make.
          const plannedCount = typeof task.count === "function"
            ? Number(task.count(planned)) || 0
            : planned.reduce((acc, p) => acc + (p.plan?.length || 0), 0);
          state.totals.planned += plannedCount;
          const plannedFailures = planned.reduce((sum, row) => (
            sum
              + Number(row?.failed || 0)
              + (Array.isArray(row?.errors) ? row.errors.length : 0)
              + (row?.readFailed ? 1 : 0)
          ), 0);
          if (plannedFailures > 0) {
            const error = new Error(`${task.key} planning reported ${plannedFailures} failure(s)`);
            error.code = "task-reported-failure";
            throw error;
          }

          if (!armed && !force && task.requiredForClose) {
            // Preserve the public 20:00 delivery contract even for a bad flag
            // combination. The run begins at 19:50, but a configuration
            // fallback should not arrive ten minutes early and masquerade as
            // the ordinary report.
            const requiredDueAt = typeof task.requiredDueAt === "function"
              ? new Date(task.requiredDueAt(planned))
              : null;
            if (requiredDueAt && !Number.isNaN(requiredDueAt.getTime())) {
              await withTimeout(
                () => waitUntil(requiredDueAt),
                task.timeoutMs || state.taskTimeoutMs,
                { taskKey: task.key, phase: "required-gate" },
              );
            }
            const error = new Error(`${task.key} is required for the nightly close but is disarmed`);
            error.code = "NIGHTLY_REQUIRED_TASK_DISARMED";
            throw error;
          }

          if (!armed && !force) {
            results.push({
              task: task.key,
              label: task.label,
              dryRun: true,
              reason: "standing-dry-run",
              planned: plannedCount,
              summary: task.describe(planned),
              durationMs: Date.now() - taskStarted,
            });
            // cursorLost() rather than a bare Error: the catch discriminates on
            // `code`, and a plain Error reaches the abort only by bouncing through
            // the retry path, whose own durable write then fails too. Same outcome,
            // one indirection — say it directly.
            if (durableClaim) {
              const renewed = await advanceNightlyHygiene(
                today,
                durableClaim.claimedAt,
                taskIndex + 1,
                durableCounts(),
                durableTaskResults(results),
              );
              if (!renewed) throw cursorLost();
              durableClaim.claimedAt = renewed;
            }
            continue;
          }

          let applied = null;
          if (armed && plannedCount) {
            applied = await withClaimHeartbeat(today, durableClaim, () => withTimeout(
              () => task.apply(
                planned,
                { logger: log, at, priorResults: [...results], ...collaborators },
              ),
              task.timeoutMs || state.taskTimeoutMs,
              { taskKey: task.key, phase: "apply" },
            ));
            const reportedFailures = Number(applied?.failed || 0);
            const reportedErrors = Array.isArray(applied?.errors) ? applied.errors.length : 0;
            if (reportedFailures > 0 || reportedErrors > 0) {
              const error = new Error(`${task.key} reported ${Math.max(reportedFailures, reportedErrors)} failure(s)`);
              error.code = "task-reported-failure";
              throw error;
            }
            state.totals.written += applied.written || 0;
          }
          results.push({
            task: task.key, label: task.label, dryRun: !armed,
            planned: plannedCount, summary: task.describe(planned), applied,
            durationMs: Date.now() - taskStarted,
            sampleCount: planned.reduce((sum, p) => sum + Math.min((p.plan || []).length, 5), 0),
          });
          if (durableClaim) {
            const renewed = await advanceNightlyHygiene(
              today,
              durableClaim.claimedAt,
              taskIndex + 1,
              durableCounts(),
              durableTaskResults(results),
            );
            if (!renewed) throw cursorLost();
            durableClaim.claimedAt = renewed;
          }
          log?.info?.("nightly_hygiene.task", {
            task: task.key, planned: plannedCount, written: applied?.written ?? 0, dryRun: !armed,
          });
        } catch (error) {
          // One chore failure ends this close. The old retry/step-past behavior
          // could either miss 20:00 or mail a clean-looking report after an
          // upstream correction failed. The emergency path sends a deliberately
          // data-free degraded close and leaves the failed cursor retryable for
          // an operator instead.
          const failureCode = error?.code || error?.name || "task-failed";
          results.push({
            task: task.key,
            label: task.label,
            error: String(error.message).slice(0, 240),
            errorCode: failureCode,
          });
          log?.error?.("nightly_hygiene.task_failed", { task: task.key, error: String(error.message) });
          if (task.continueOnFailure) {
            if (durableClaim) {
              const renewed = await advanceNightlyHygiene(
                today,
                durableClaim.claimedAt,
                taskIndex + 1,
                durableCounts(),
                durableTaskResults(results),
              );
              if (!renewed) throw cursorLost();
              durableClaim.claimedAt = renewed;
            }
            log?.warn?.("nightly_hygiene.task_degraded", {
              task: task.key,
              errorCode: failureCode,
            });
            continue;
          }

          state.lastError = String(error.message).slice(0, 300);

          if (durableClaim) {
            await releaseNightlyHygiene(today, durableClaim.claimedAt, failureCode).catch(() => {});
          }
          const fallback = task.suppressEmergencyFallback
            ? { skipped: true, reason: "post-report-receipt-failed" }
            : await triggerEmergencyClose(today, failureCode, task.key);
          if (task.suppressEmergencyFallback && emergencyCloseEnabled) {
            // The business close and both data emails are already complete.
            // Mark the emergency checkpoint complete so a restart retries only
            // this cursor step instead of launching a misleading fallback.
            try {
              emergencyClose.markCompleted({
                dateKey: today,
                at: new Date(),
                ...(emergencyClose.stateFile ? { stateFile: emergencyClose.stateFile } : {}),
              });
            } catch (checkpointError) {
              log?.warn?.("nightly_hygiene.summary_checkpoint_failed", {
                errorCode: checkpointError?.code || checkpointError?.name || "checkpoint-failed",
              });
            }
          }
          state.lastRunAt = new Date().toISOString();
          state.lastResult = {
            at: state.lastRunAt,
            day: today,
            durationMs: Date.now() - started,
            incomplete: true,
            aborted: failureCode,
            nextTaskIndex: taskIndex,
            fallback,
            tasks: results,
          };
          return state.lastResult;
        }
      }
      state.totals.passes += 1;
      state.lastRunAt = new Date().toISOString();
      state.lastResult = { at: state.lastRunAt, day: today, durationMs: Date.now() - started, tasks: results };
      // Only a completed pass claims the day; a crash retries on the next poll.
      if (durableClaim) {
        const finished = await finishNightlyHygiene(
          today,
          durableClaim.claimedAt,
          tasks.length,
          durableCounts(),
          durableTaskResults(results),
          at,
        );
        if (!finished) throw new Error("nightly hygiene completion claim was lost");
      }
      if (emergencyCloseEnabled) {
        emergencyClose.markCompleted({
          dateKey: today,
          at: new Date(),
          ...(emergencyClose.stateFile ? { stateFile: emergencyClose.stateFile } : {}),
        });
      }
      state.lastRunKey = today;
      return state.lastResult;
    } catch (error) {
      state.lastError = String(error.message).slice(0, 300);
      log?.error?.("nightly_hygiene.failed", { error: String(error.message) });
      if (durableClaim) {
        await releaseNightlyHygiene(
          today, durableClaim.claimedAt, error?.code || error?.name || "runtime-failed",
        ).catch(() => {});
      }
      const failureCode = error?.code || error?.name || "runtime-failed";
      const fallback = await triggerEmergencyClose(today, failureCode, "runtime");
      return { error: state.lastError, fallback };
    } finally {
      state.running = false;
      state.activeDay = null;
    }
  }

  async function start() {
    if (emergencyCloseEnabled) {
      const checkpoint = emergencyClose.readCheckpoint(emergencyClose.stateFile);
      if (checkpointNeedsRecovery(checkpoint)) {
        await triggerEmergencyClose(
          checkpoint.dateKey,
          "process-restart-recovery",
          checkpoint.taskKey || "runtime",
        );
      }
    }
    if (!state.enabled) {
      log?.info?.("nightly_hygiene.disabled", {
        hint: "set NIGHTLY_HYGIENE_ENABLED=true to run; each task still needs its own write switch",
      });
      return;
    }
    if (state.timer) return;
    state.timer = setInterval(() => { runOnce().catch(() => {}); }, state.pollMs);
    if (state.timer.unref) state.timer.unref();
    log?.info?.("nightly_hygiene.started", {
      at: `${String(state.hour).padStart(2, "0")}:${String(state.minute).padStart(2, "0")} PT`,
      pollMs: state.pollMs, domains: state.domains, tasks: tasks.map((t) => t.key),
    });
    await runOnce();
  }

  async function stop() {
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
    if (emergencyCloseEnabled && state.running && state.activeDay) {
      await triggerEmergencyClose(
        state.activeDay,
        "process-shutdown",
        "runtime",
        { detached: false },
      );
    }
  }

  function getState() {
    const requiredTasks = tasks.filter((task) => task.requiredForClose);
    const disarmedRequiredTasks = state.enabled
      ? requiredTasks.filter((task) => !task.writesArmed()).map((task) => task.key)
      : [];
    const closeIssues = [
      ...disarmedRequiredTasks.map((key) => `required-task-disarmed:${key}`),
      ...(state.enabled && !emergencyCloseEnabled ? ["emergency-close-disabled"] : []),
    ];
    return {
      enabled: state.enabled,
      closeReady: !state.enabled || closeIssues.length === 0,
      closeIssues,
      emergencyCloseEnabled,
      hour: state.hour,
      minute: state.minute,
      at: `${String(state.hour).padStart(2, "0")}:${String(state.minute).padStart(2, "0")} PT`,
      pollMs: state.pollMs,
      targetDay: persistTargetDay(),
      domains: state.domains,
      days: state.days,
      taskTimeoutMs: state.taskTimeoutMs,
      running: state.running,
      today: pacificKey(),
      lastRunKey: state.lastRunKey,
      lastRunAt: state.lastRunAt,
      lastError: state.lastError,
      fallback: state.fallback,
      totals: { ...state.totals },
      tasks: tasks.map((t) => ({
        key: t.key, label: t.label,
        writesArmed: t.writesArmed(),
        monitor: Boolean(t.monitor),
        mode: !state.enabled ? "off"
          : t.monitor ? "monitor (never writes)"
            : (t.writesArmed() ? "writing" : "standing dry-run"),
      })),
      lastResult: state.lastResult,
    };
  }

  return { TASKS: tasks, getState, runOnce, start, stop };
}

module.exports = {
  TASK_TIMEOUT,
  advanceNightlyHygiene,
  buildMailboxHandlers,
  pacificMsSinceToday,
  claimNightlyHygiene,
  createNightlyHygieneRuntime,
  finishNightlyHygiene,
  nightlyReportDueAt,
  persistTargetDay,
  buildCallRecoveryDiscoveryDeps,
  isPacificBusinessDay,
  nightlyInvoiceRepairDateKeys,
  renewNightlyHygiene,
  withTimeout,
};
