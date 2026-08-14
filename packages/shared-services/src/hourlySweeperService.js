"use strict";

const { HourlyJobEvent } = require("../../shared-models/src");
const {
  claimNextHourlyJobEvent,
  markHourlyJobCompleted,
  markHourlyJobFailed,
  runWithImmediateRetries,
} = require("./hourlyJobEventService");
const {
  dispatch: dispatchJob,
  UnknownHandlerError,
} = require("./hourlyJobHandlerRegistry");
const {
  runCheck: runResolutionCheck,
} = require("./hourlyJobResolutionCheckRegistry");
const {
  reconcilePaymentsForDomain,
} = require("./paymentReconcileService");
const {
  runPaymentFieldsSync,
} = require("./caseProfilePaymentSyncService");
const {
  runHourlyLeadCadenceEnforcement,
} = require("./hourlyLeadCadenceEnforcementService");
const {
  runHourlyCallLogHygiene,
} = require("./hourlyCallLogHygieneService");
const {
  recoverCxCallLogs,
} = require("./cxCallActivityBackfillService");
const {
  runCxTerminalRectification,
} = require("./cxTerminalRectificationService");
const {
  reconcileUnattributedSessions,
} = require("./ringcentralReconcileService");
const {
  sweepStaleNcoaBatches,
} = require("./ncoaUploadService");
const {
  runDncRecheckSweep,
} = require("./dncRecheckService");
const {
  runFillerPoolRefresh,
  runDailyAgedRefresh,
  runMonthlyGraduationSweep,
  isAtMonthlyRefreshBoundary,
  isFirstPacificBusinessDayOfMonth,
  isAtDailyAgedRefreshBoundary,
  isAgedRollingRefreshEnabled,
  hasFreshPoolForTag,
  defaultMonthTag,
} = require("./fillerPoolRefreshService");
const {
  runCallLogToCaseProfileBridge,
} = require("./callLogToCaseProfileBridgeService");
const {
  leadCadenceRepository,
} = require("../../shared-repositories/src");
const { sendPlainEmail } = require("./sendgridMailService");
const { getCompanyConfig, getInternalFromEmail } = require("../../shared-config/src");
const { getCompanyKeys } = require("../../shared-config/src/companyConfig");

const DEFAULT_BATCH_CAP = 50;
const DEFAULT_RESOLUTION_LOOKBACK_MS = 2 * 60 * 60 * 1000;
const RESOLUTION_NOTE_MARKER = "resolution-notified";
// Per-handler wall-clock cap. A hung handler (stuck on a slow API,
// unreachable DB, etc.) otherwise starves the rest of the batch.
// Kept generous enough for legitimate Logics retries and recording
// re-downloads, tight enough that one bad job can't wedge the sweep.
const DEFAULT_HANDLER_TIMEOUT_MS = 45_000;

function withTimeout(promise, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      const err = new Error(
        `${label || "handler"} exceeded ${timeoutMs}ms timeout`,
      );
      err.handlerTimedOut = true;
      reject(err);
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeoutHandle);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeoutHandle);
        reject(error);
      },
    );
  });
}

function normalizeDomain(domain) {
  return String(domain || "").trim().toUpperCase() || "TAG";
}

function summarizeHourlySweepResult(result = null) {
  if (!result || typeof result !== "object") return null;

  const paymentDomains = Array.isArray(result?.phaseA?.paymentReconcile)
    ? result.phaseA.paymentReconcile
    : [];
  const paymentSummary = paymentDomains.reduce(
    (accumulator, entry) => {
      if (entry?.error) {
        accumulator.errors += 1;
        return accumulator;
      }
      accumulator.domains += 1;
      accumulator.cases += Number(entry?.casesScanned || 0);
      accumulator.payments += Number(entry?.paymentsWritten || 0);
      accumulator.promotions += Number(entry?.promotions || 0);
      accumulator.ledgerWrites += Number(entry?.ledgerWrites || 0);
      return accumulator;
    },
    {
      domains: 0,
      cases: 0,
      payments: 0,
      promotions: 0,
      ledgerWrites: 0,
      errors: 0,
    },
  );

  return {
    startedAt: result.startedAt || null,
    finishedAt: result.finishedAt || null,
    durationMs: Number(result.durationMs || 0),
    scheduledPhase: Boolean(result.scheduledPhase),
    phaseA: result.phaseA
      ? {
          sessionReconcile: {
            unattributedResolved:
              Number(result.phaseA?.sessionReconcile?.totals?.resolved || 0),
            error: result.phaseA?.sessionReconcile?.error || null,
          },
          paymentReconcile: paymentSummary,
          paymentFieldsSync: result.phaseA?.paymentFieldsSync?.skipped
            ? {
                skipped: true,
                reason: result.phaseA.paymentFieldsSync.reason || null,
              }
            : (() => {
                const domains = Array.isArray(
                  result.phaseA?.paymentFieldsSync?.domains,
                )
                  ? result.phaseA.paymentFieldsSync.domains
                  : [];
                return domains.reduce(
                  (acc, entry) => {
                    if (entry?.error) {
                      acc.errors += 1;
                      return acc;
                    }
                    acc.domains += 1;
                    acc.casesScanned += Number(entry?.casesScanned || 0);
                    acc.casesWithDrift += Number(entry?.casesWithDrift || 0);
                    acc.casesUpdated += Number(entry?.casesUpdated || 0);
                    acc.fallbackUsed += Number(entry?.fallbackUsed || 0);
                    acc.totalDriftDollars +=
                      Number(entry?.totalDriftDollars || 0);
                    if (entry?.skipped) acc.skipped += 1;
                    return acc;
                  },
                  {
                    domains: 0,
                    casesScanned: 0,
                    casesWithDrift: 0,
                    casesUpdated: 0,
                    fallbackUsed: 0,
                    totalDriftDollars: 0,
                    skipped: 0,
                    errors: 0,
                  },
                );
              })(),
          callLogHygiene: result.phaseA?.callLogHygiene?.skipped
            ? { skipped: true, reason: result.phaseA.callLogHygiene.reason || null }
            : {
                nativeScanned: Number(result.phaseA?.callLogHygiene?.totals?.nativeScanned || 0),
                nativeProcessed: Number(result.phaseA?.callLogHygiene?.totals?.nativeProcessed || 0),
                nativeInserted: Number(result.phaseA?.callLogHygiene?.totals?.nativeInserted || 0),
                nativeErrors: Number(result.phaseA?.callLogHygiene?.totals?.nativeErrors || 0),
                mirrored: Number(result.phaseA?.callLogHygiene?.totals?.mirrored || 0),
                ledgerSynced: Number(result.phaseA?.callLogHygiene?.totals?.ledgerSynced || 0),
                caseRefreshes: Number(result.phaseA?.callLogHygiene?.totals?.caseRefreshes || 0),
                statusChanges: Number(result.phaseA?.callLogHygiene?.totals?.statusChanges || 0),
                metricsDates: Number(result.phaseA?.callLogHygiene?.totals?.metricsDates || 0),
                scoringProcessed: Number(result.phaseA?.callLogHygiene?.totals?.scoringProcessed || 0),
                scoringCompleted: Number(result.phaseA?.callLogHygiene?.totals?.scoringCompleted || 0),
                scoringFailed: Number(result.phaseA?.callLogHygiene?.totals?.scoringFailed || 0),
                archiveAttempted: Number(result.phaseA?.callLogHygiene?.totals?.archiveAttempted || 0),
                archiveQueued: Number(result.phaseA?.callLogHygiene?.totals?.archiveQueued || 0),
                archiveDeduped: Number(result.phaseA?.callLogHygiene?.totals?.archiveDeduped || 0),
                archiveFailed: Number(result.phaseA?.callLogHygiene?.totals?.archiveFailed || 0),
                errors:
                  Number(result.phaseA?.callLogHygiene?.totals?.promotionErrors || 0) +
                  Number(result.phaseA?.callLogHygiene?.totals?.caseRefreshErrors || 0) +
                  Number(result.phaseA?.callLogHygiene?.totals?.metricsErrors || 0) +
                  Number(result.phaseA?.callLogHygiene?.totals?.archiveFailed || 0),
              },
          cxCallActivityBackfill: result.phaseA?.cxCallActivityBackfill
            ? {
                scannedCallPlacedEvents:
                  Number(result.phaseA.cxCallActivityBackfill.scannedCallPlacedEvents || 0),
                preparedRows:
                  Number(result.phaseA.cxCallActivityBackfill.preparedRows || 0),
                existingRows:
                  Number(result.phaseA.cxCallActivityBackfill.existingRows || 0),
                upsertedRows:
                  Number(result.phaseA.cxCallActivityBackfill.upsertedRows || 0),
                ledgerSynced:
                  Number(result.phaseA.cxCallActivityBackfill.ledgerSynced || 0),
                ledgerErrors:
                  Number(result.phaseA.cxCallActivityBackfill.ledgerErrors || 0),
                errors: Array.isArray(result.phaseA.cxCallActivityBackfill.errors)
                  ? result.phaseA.cxCallActivityBackfill.errors.length
                  : 0,
              }
            : null,
          cxTerminalRectification: result.phaseA?.cxTerminalRectification
            ? {
                skipped: Boolean(result.phaseA.cxTerminalRectification.skipped),
                reason: result.phaseA.cxTerminalRectification.reason || null,
                dryRun: Boolean(result.phaseA.cxTerminalRectification.dryRun),
                scanned: Number(result.phaseA.cxTerminalRectification.scanned || 0),
                strong: Number(result.phaseA.cxTerminalRectification.strong || 0),
                medium: Number(result.phaseA.cxTerminalRectification.medium || 0),
                weak: Number(result.phaseA.cxTerminalRectification.weak || 0),
                ignored: Number(result.phaseA.cxTerminalRectification.ignored || 0),
                wouldInsert: Number(result.phaseA.cxTerminalRectification.wouldInsert || 0),
                inserted: Number(result.phaseA.cxTerminalRectification.inserted || 0),
                duplicates: Number(result.phaseA.cxTerminalRectification.duplicates || 0),
                errors: Array.isArray(result.phaseA.cxTerminalRectification.errors)
                  ? result.phaseA.cxTerminalRectification.errors.length
                  : 0,
                reasons: result.phaseA.cxTerminalRectification.reasons || {},
              }
            : null,
          metricsRefresh: result.phaseA?.metricsRefresh?.skipped
            ? { skipped: true, reason: result.phaseA.metricsRefresh.reason || null }
            : {
                callStatImports: Number(result.phaseA?.metricsRefresh?.totals?.callStatImports || 0),
                callStatUpserts: Number(result.phaseA?.metricsRefresh?.totals?.callStatUpserts || 0),
                snapshotsRebuilt: Number(result.phaseA?.metricsRefresh?.totals?.snapshotsRebuilt || 0),
                errors: Number(result.phaseA?.metricsRefresh?.totals?.errors || 0),
              },
          spendSync: result.phaseA?.spendSync
            ? {
                ok: result.phaseA.spendSync.ok !== false,
                totalUpserted: Number(result.phaseA.spendSync.totalUpserted || 0),
                totalSkipped: Number(result.phaseA.spendSync.totalSkipped || 0),
                error: result.phaseA.spendSync.error || null,
              }
            : null,
          leadCadenceEnforcement: result.phaseA?.leadCadenceEnforcement?.skipped
            ? { skipped: true, reason: result.phaseA.leadCadenceEnforcement.reason || null }
            : {
                dryRun: Boolean(result.phaseA?.leadCadenceEnforcement?.dryRun),
                scanned: Number(result.phaseA?.leadCadenceEnforcement?.totals?.scanned || 0),
                blocked: Number(result.phaseA?.leadCadenceEnforcement?.totals?.blocked || 0),
                enforced: Number(result.phaseA?.leadCadenceEnforcement?.totals?.enforced || 0),
                errors: Number(result.phaseA?.leadCadenceEnforcement?.totals?.errors || 0),
              },
          staleCadenceSweep: {
            modified: Number(result.phaseA?.staleCadenceSweep?.modified || 0),
            error: result.phaseA?.staleCadenceSweep?.error || null,
          },
          // ncoaMailbox dropped from the summary with its call. Leaving the
          // key would have printed `ncoaMailbox: null` on every tick forever,
          // which an operator reads as "it ran and found nothing" rather than
          // "the hourly sweep does not do this any more". Absent is honest.
          resolutionEmails: {
            candidates: Number(result.phaseA?.resolutionEmails?.candidates || 0),
            sent: Number(result.phaseA?.resolutionEmails?.sent || 0),
            failed: Number(result.phaseA?.resolutionEmails?.failed || 0),
            skipped: Number(result.phaseA?.resolutionEmails?.skipped || 0),
          },
        }
      : null,
    phaseB: {
      claimed: Number(result.phaseB?.claimed || 0),
      completed: Number(result.phaseB?.completed || 0),
      autoResolved: Number(result.phaseB?.autoResolved || 0),
      failed: Number(result.phaseB?.failed || 0),
      deadLettered: Number(result.phaseB?.deadLettered || 0),
      errorCount: Array.isArray(result.phaseB?.errors) ? result.phaseB.errors.length : 0,
    },
  };
}

// ── Phase B: drain the retry queue ─────────────────────────────────────

/**
 * Pull jobs off the queue, dispatch to their registered handler, mark
 * completed or failed. Each iteration is atomic: claim → process →
 * complete/fail. Loops until the queue returns null or `batchCap`
 * iterations have run.
 *
 * `UnknownHandlerError` → dead-letter immediately (no retries). Any
 * other thrown error → markHourlyJobFailed, which decides retry vs
 * dead-letter based on attemptCount vs maxAttempts.
 */
async function drainHourlyJobQueue({
  workerName = "hourly-sweeper",
  lane = "hourly",
  batchCap = DEFAULT_BATCH_CAP,
  handlerKeys = null,
  excludedHandlerKeys = null,
  handlerTimeoutMs = DEFAULT_HANDLER_TIMEOUT_MS,
  inlineRetryAttempts = 2,
  inlineRetryDelayMs = 500,
  logger = null,
} = {}) {
  const summary = {
    claimed: 0,
    completed: 0,
    autoResolved: 0,
    failed: 0,
    deadLettered: 0,
    deferred: 0,
    inlineRetries: 0,
    errors: [],
  };

  for (let i = 0; i < batchCap; i += 1) {
    const job = await claimNextHourlyJobEvent(workerName, {
      lane,
      handlerKeys: Array.isArray(handlerKeys) ? handlerKeys : undefined,
      excludedHandlerKeys: Array.isArray(excludedHandlerKeys) ? excludedHandlerKeys : undefined,
    });
    if (!job) break;
    summary.claimed += 1;

    // Resolution-check short-circuit: if a cheap read says the problem
    // self-healed, mark completed without invoking the handler. Skip
    // entirely when `resolutionCheckKey` isn't set.
    const checkResult = await runResolutionCheck(job);
    if (checkResult?.resolved) {
      await markHourlyJobCompleted(job._id, workerName, {
        autoResolved: true,
        via: job.resolutionCheckKey,
        note: checkResult.note || null,
      });
      summary.autoResolved += 1;
      summary.completed += 1;
      logger?.info?.("hourly.job.auto_resolved", {
        jobId: String(job._id),
        handlerKey: job.handlerKey,
        resolutionCheckKey: job.resolutionCheckKey,
        note: checkResult.note,
      });
      continue;
    }

    const retryOutcome = await runWithImmediateRetries(
      () => withTimeout(
        Promise.resolve().then(() => dispatchJob(job)),
        handlerTimeoutMs,
        `handler "${job.handlerKey}"`,
      ),
      {
        immediateRetryAttempts: Math.min(
          2,
          Math.max(Number(inlineRetryAttempts) || 0, Number(job.immediateRetryAttempts) || 0),
        ),
        immediateRetryDelayMs: Math.min(
          5_000,
          Math.max(0, Number(job.immediateRetryDelayMs) || Number(inlineRetryDelayMs) || 0),
        ),
        shouldRetry: (error) => !(error instanceof UnknownHandlerError) && !error?.deadLetter,
      },
    );
    summary.inlineRetries += Number(retryOutcome.attemptsUsed) || 0;
    if (retryOutcome.attemptsUsed > 0) {
      await HourlyJobEvent.updateOne(
        { _id: job._id, status: "processing" },
        { $inc: { immediateRetryUsed: retryOutcome.attemptsUsed } },
      );
    }

    if (retryOutcome.ok) {
      await markHourlyJobCompleted(job._id, workerName, retryOutcome.result ?? null);
      summary.completed += 1;
      logger?.info?.("hourly.job.completed", {
        jobId: String(job._id),
        handlerKey: job.handlerKey,
        attempts: job.attemptCount,
      });
    } else {
      const error = retryOutcome.error;
      const isUnknownHandler = error instanceof UnknownHandlerError;
      const forceDeadLetter = Boolean(error?.deadLetter);
      const timedOut = Boolean(error?.handlerTimedOut);
      // Force immediate dead-letter by bumping attemptCount above max.
      // Timeouts get normal retry rules — a hung handler once can still
      // succeed on a later attempt when the downstream recovers.
      const failOptions = forceDeadLetter ? { maxAttempts: 0 } : {};
      if (!forceDeadLetter && error?.nextAttemptAt) {
        failOptions.nextAttemptAt = error.nextAttemptAt;
      }
      await markHourlyJobFailed(job._id, workerName, error, failOptions);
      if (forceDeadLetter) {
        summary.deadLettered += 1;
      } else {
        summary.failed += 1;
        summary.deferred += 1;
      }
      summary.errors.push({
        jobId: String(job._id),
        handlerKey: job.handlerKey,
        reason: isUnknownHandler
          ? "unknown-handler"
          : timedOut
            ? "handler-timed-out"
            : "handler-threw",
        error: error.message,
      });
      logger?.warn?.("hourly.job.failed", {
        jobId: String(job._id),
        handlerKey: job.handlerKey,
        deadLetter: forceDeadLetter,
        timedOut,
        error: error.message,
      });
    }
  }

  return summary;
}

// ── Phase A: scheduled hygiene ────────────────────────────────────────

async function runSessionReconcile({ logger } = {}) {
  try {
    const domains = getCompanyKeys().map(normalizeDomain).filter(Boolean);
    const domainsResult = [];
    const totals = {
      domains: domains.length,
      scanned: 0,
      alreadyAttributed: 0,
      resolved: 0,
      unmatched: 0,
      errors: 0,
    };

    for (const domain of domains) {
      try {
        const result = await reconcileUnattributedSessions({ domain, logger });
        totals.scanned += Number(result?.stats?.scanned || 0);
        totals.alreadyAttributed += Number(result?.stats?.alreadyAttributed || 0);
        totals.resolved += Number(result?.stats?.resolved || 0);
        totals.unmatched += Number(result?.stats?.unmatched || 0);
        totals.errors += Number(result?.stats?.errors || 0);
        domainsResult.push({
          domain,
          ok: true,
          result,
        });
      } catch (error) {
        totals.errors += 1;
        domainsResult.push({
          domain,
          ok: false,
          error: error.message,
        });
        logger?.warn?.("hourly.sessions.reconcile_domain_failed", {
          domain,
          error: error.message,
        });
      }
    }

    return {
      domains: domainsResult,
      totals,
    };
  } catch (error) {
    logger?.warn?.("hourly.sessions.reconcile_failed", { error: error.message });
    return { error: error.message };
  }
}

async function runStaleCadenceSweep({ logger, olderThanMs } = {}) {
  try {
    const result = await leadCadenceRepository.cancelStaleScheduledActions({
      olderThanMs,
      reason: "hourly-sweep",
    });
    if (result.modified > 0) {
      logger?.info?.("hourly.cadence.stale_swept", result);
    }
    return result;
  } catch (error) {
    logger?.warn?.("hourly.cadence.stale_sweep_failed", { error: error.message });
    return { error: error.message };
  }
}

async function runPaymentReconcileForAllDomains({
  logger,
  lane = "hourly",
  maxCasesPerDomain,
} = {}) {
  const results = [];
  for (const domain of getCompanyKeys()) {
    try {
      const result = await reconcilePaymentsForDomain({
        domain,
        maxCases: maxCasesPerDomain,
        lane,
        logger,
      });
      results.push(result);
    } catch (error) {
      logger?.warn?.("hourly.payment_reconcile.domain_failed", {
        domain,
        error: error.message,
      });
      results.push({ domain, error: error.message });
    }
  }
  return results;
}

/**
 * Sweep CaseProfile payment-derived fields against the PaymentLedger
 * truth set. Runs AFTER paymentReconcile (which writes the ledger) and
 * BEFORE metricsRefresh (which reads CP fields). Gated by
 * `PAYMENT_FIELD_SYNC_ENABLED` (default `false`) so we can ship the
 * wire-in dark and turn on per environment after the smoke runs.
 *
 * Single in-flight via the run-lock inside the service itself, so even
 * if a backfill script is already running this is safe to call.
 */
async function runPaymentFieldsSyncForAllDomains({
  logger,
  lookbackHours,
  staleCheckMs,
  maxCasesPerDomain,
} = {}) {
  if (
    String(process.env.PAYMENT_FIELD_SYNC_ENABLED || "false")
      .trim()
      .toLowerCase() !== "true"
  ) {
    return { skipped: true, reason: "disabled-via-env", domains: [] };
  }

  const results = [];
  for (const domain of getCompanyKeys()) {
    try {
      const result = await runPaymentFieldsSync({
        domain,
        lookbackHours,
        staleCheckMs,
        maxCases: maxCasesPerDomain,
        lockedBy: "hourly-sweep",
        logger,
      });
      results.push(result);
      if (result?.casesWithDrift > 0 || result?.errors > 0) {
        logger?.info?.("hourly.payment_field_sync", {
          domain,
          casesScanned: result.casesScanned,
          casesWithDrift: result.casesWithDrift,
          casesUpdated: result.casesUpdated,
          fallbackUsed: result.fallbackUsed,
          totalDriftDollars: result.totalDriftDollars,
          errors: result.errors,
        });
      }
    } catch (error) {
      logger?.warn?.("hourly.payment_field_sync.domain_failed", {
        domain,
        error: error.message,
      });
      results.push({ domain, error: error.message });
    }
  }
  return { skipped: false, domains: results };
}

async function runLeadCadenceEnforcement({
  logger,
  limitPerDomain,
  minStaleMs,
  dryRun = false,
} = {}) {
  try {
    const result = await runHourlyLeadCadenceEnforcement({
      logger,
      limitPerDomain,
      minStaleMs,
      dryRun,
      sourceService: "hourly-sweeper",
    });
    if (result.totals.blocked > 0 || result.totals.errors > 0) {
      logger?.info?.("hourly.cadence.enforcement", {
        dryRun: Boolean(dryRun),
        scanned: result.totals.scanned,
        blocked: result.totals.blocked,
        enforced: result.totals.enforced,
        errors: result.totals.errors,
      });
    }
    return result;
  } catch (error) {
    logger?.warn?.("hourly.cadence.enforcement_failed", { error: error.message });
    return { error: error.message };
  }
}

async function runCallLogHygiene({
  logger,
  lane = "hourly",
  domains,
  sinceMs,
  limitPerDomain,
  mirrorLegacyContactActivities = true,
  nativeSweepEnabled = true,
  nativeSweepLimit,
  nativeSweepMaxPages,
  nativeSweepDefaultDomain,
  minDurationSec,
  maxCaseRefreshesPerDomain,
  maxScoringPerDomain,
  maxArchivePerDomain,
  scorePendingCalls = false,
  archiveRecordings = false,
  syncMetricsDates = false,
  preferLegacyContactActivities = false,
} = {}) {
  try {
    const selectedDomains = (Array.isArray(domains) && domains.length > 0
      ? domains
      : getCompanyKeys()
    ).map(normalizeDomain).filter(Boolean);
    const result = await runHourlyCallLogHygiene({
      domains: selectedDomains,
      sinceMs,
      limitPerDomain,
      mirrorLegacyContactActivities,
      nativeSweepEnabled,
      nativeSweepLimit,
      nativeSweepMaxPages,
      nativeSweepDefaultDomain,
      minDurationSec,
      maxCaseRefreshesPerDomain,
      maxScoringPerDomain,
      maxArchivePerDomain,
      scorePendingCalls,
      archiveRecordings,
      syncMetricsDates,
      preferLegacyContactActivities,
      lane,
      logger,
    });
    if (
      result.totals.nativeProcessed > 0 ||
      result.totals.mirrored > 0 ||
      result.totals.caseRefreshes > 0 ||
      result.totals.scoringProcessed > 0 ||
      result.totals.archiveQueued > 0
    ) {
      logger?.info?.("hourly.call_log_hygiene", result.totals);
    }
    return result;
  } catch (error) {
    logger?.warn?.("hourly.call_log_hygiene_failed", { error: error.message });
    return { error: error.message };
  }
}

// ── Close-the-loop emails ─────────────────────────────────────────────

/**
 * Find jobs that flipped to `completed` or `dead-letter` in the last
 * `lookbackMs` AND whose emitter opted in via `payload.notifyOnResolution`
 * AND that haven't already been notified (marked via `notes`).
 *
 * Emits one follow-up email per job; the subject + body vary by outcome.
 * Marks the job as notified so a later tick doesn't re-send.
 */
async function sendResolutionEmails({
  lookbackMs = DEFAULT_RESOLUTION_LOOKBACK_MS,
  logger = null,
} = {}) {
  const cutoff = new Date(Date.now() - Number(lookbackMs));
  const jobs = await HourlyJobEvent.find({
    status: { $in: ["completed", "dead-letter"] },
    completedAt: { $gte: cutoff },
    "payload.notifyOnResolution": true,
    $or: [{ notes: null }, { notes: { $ne: RESOLUTION_NOTE_MARKER } }],
  })
    .limit(100)
    .lean();

  const summary = {
    candidates: jobs.length,
    sent: 0,
    failed: 0,
    skipped: 0,
  };

  for (const job of jobs) {
    const domain = normalizeDomain(job.domain);
    const resolved = job.status === "completed";
    const recipient =
      job.payload?.notifyOnResolutionRecipient ||
      getCompanyConfig(domain)?.alertEmail ||
      null;

    if (!recipient) {
      summary.skipped += 1;
      continue;
    }

    const subject = resolved
      ? `[${domain}] Retry resolved: ${job.eventType}`
      : `[${domain}] Retry gave up: ${job.eventType}`;

    const body = [
      resolved
        ? `Follow-up on a previously flagged retry — it succeeded.`
        : `Follow-up on a previously flagged retry — it exhausted all ${job.maxAttempts} attempts and was dead-lettered.`,
      "",
      `Handler: ${job.handlerKey}`,
      `Aggregate: ${job.aggregateType}:${job.aggregateId}`,
      `Case ID: ${job.caseId != null ? job.caseId : "n/a"}`,
      `Attempts used: ${job.attemptCount}/${job.maxAttempts}`,
      resolved
        ? `Completed at: ${job.completedAt ? new Date(job.completedAt).toISOString() : "n/a"}`
        : `Last error: ${job.lastError || job.firstError || "n/a"}`,
      resolved && job.result
        ? `Result summary: ${typeof job.result === "string" ? job.result : JSON.stringify(job.result).slice(0, 240)}`
        : null,
    ]
      .filter(Boolean)
      .join("\n");

    // Internal sweeper alert — send from the Parallel-internal sender
    // (mgray@) regardless of brand. The `${domain} Parallel` display
    // name still shows which brand's sweeper fired.
    try {
      await sendPlainEmail(domain, {
        personalizations: [{ to: [{ email: recipient }] }],
        from: { email: getInternalFromEmail(), name: `${domain} Parallel` },
        subject,
        content: [{ type: "text/plain", value: body }],
      });
      // Mark so we don't resend on the next tick.
      await HourlyJobEvent.updateOne(
        { _id: job._id },
        { $set: { notes: RESOLUTION_NOTE_MARKER } },
      );
      summary.sent += 1;
    } catch (error) {
      logger?.warn?.("hourly.resolution_email_failed", {
        jobId: String(job._id),
        error: error.message,
      });
      summary.failed += 1;
    }
  }

  return summary;
}

// ── Top-level orchestration ──────────────────────────────────────────

/**
 * Run one hourly-sweeper tick.
 *
 * - `scheduledPhase: true` runs Phase A (session reconcile + payment
 *   reconcile + resolution emails). Default true. The minute-granularity
 *   retry drain can pass false to skip Phase A and just drain the queue.
 * - `batchCap` bounds Phase B's retry drain.
 * - `logger` is optional; falls through to silent if omitted.
 */
// Monthly filler-pool refresh boundary check + idempotency guard.
// Returns one of:
//   { skipped: true, reason: "not-at-monthly-boundary" }
//   { skipped: true, reason: "pool-already-built", tag }
//   { ok: true, ...refreshResult }
//   { error: <message> }  (caught upstream)
//
// The hourly sweeper calls this every tick; it short-circuits to a
// skipped result outside the first-business-day 05:00 PT window, and after
// the refresh has already produced rows for the current tag.
async function runMonthlyFillerPoolRefreshIfDue({ logger, now = new Date(), requireHour = true } = {}) {
  // requireHour:false is for a caller that owns its own once-per-day guarantee
  // (the morning pass's durable claim). The hourly floor must keep the hour
  // check or it would fire this every tick on the boundary day.
  if (!isAtMonthlyRefreshBoundary(now, { requireHour })) {
    return { skipped: true, reason: "not-at-monthly-boundary" };
  }
  const tag = defaultMonthTag(now);
  if (await hasFreshPoolForTag(tag)) {
    return { skipped: true, reason: "pool-already-built", tag };
  }
  logger?.info?.("hourly-sweep.filler-pool-refresh.starting", { tag });
  const result = await runFillerPoolRefresh({ tag, dryRun: false, logger });
  logger?.info?.("hourly-sweep.filler-pool-refresh.completed", {
    tag,
    poolCount: result?.verify?.poolCount,
    durationMs: result?.durationMs,
  });
  return result;
}

// ── Rolling aged-pool refresh (replaces monthly burst) ───────────────
//
// Daily 06:00 PT — runDailyAgedRefresh sweeps LeadCadence rows whose
// dncCheckpoints.nextAt has passed and runs them through the 30/60/90
// day re-scrub ladder. The first business day of each month also fires the
// graduation sweep (8+ qualifying CX connects in trailing 4 months →
// drop from red). Both report by email via sendAgedRefreshReportEmail.
//
// Gated behind AGED_ROLLING_REFRESH_ENABLED so the legacy monthly burst
// can keep running until cutover is verified.

async function runAgedRollingRefreshIfDue({
  logger,
  now = new Date(),
  requireHour = true,
  limitPerDomain,
} = {}) {
  if (!isAgedRollingRefreshEnabled()) {
    return { skipped: true, reason: "disabled" };
  }
  if (!isAtDailyAgedRefreshBoundary(now, { requireHour })) {
    return { skipped: true, reason: "not-at-daily-boundary" };
  }

  // The first business day also fires graduation. Graduation runs FIRST so freed pool
  // slots are available before promotions land.
  let monthlySummary = null;
  if (isFirstPacificBusinessDayOfMonth(now)) {
    try {
      logger?.info?.("aged-rolling-refresh.graduation.starting");
      monthlySummary = await runMonthlyGraduationSweep({ now, logger });
      logger?.info?.("aged-rolling-refresh.graduation.completed", {
        graduated: monthlySummary?.graduated,
      });
    } catch (error) {
      logger?.warn?.("aged-rolling-refresh.graduation.failed", {
        error: error.message,
      });
    }
  }

  let dailySummary = null;
  try {
    logger?.info?.("aged-rolling-refresh.daily.starting");
    dailySummary = await runDailyAgedRefresh({ now, logger, limitPerDomain });
    try {
      const { recordAgedRefreshBatch } = require("./nightlyOperationalReceiptService");
      await recordAgedRefreshBatch(dailySummary, { at: dailySummary?.finishedAt || now });
    } catch (error) {
      // The refresh remains authoritative even when its count-only receipt
      // cannot be written. The nightly email will surface a missing receipt.
      logger?.warn?.("aged-rolling-refresh.receipt.failed", {
        error: error.message,
      });
    }
    logger?.info?.("aged-rolling-refresh.daily.completed", {
      checked: dailySummary?.checked,
      promoted: dailySummary?.promoted,
      evicted: (dailySummary?.evicted || 0) + (dailySummary?.droppedAtIntake || 0),
      expiredRetired: dailySummary?.expiredRetirement?.retired || 0,
    });
  } catch (error) {
    logger?.warn?.("aged-rolling-refresh.daily.failed", {
      error: error.message,
    });
    return { ok: false, error: error.message };
  }

  // Email report. Skip if nothing was checked AND no graduation
  // happened — keeps duplicate-tick noise out of inboxes.
  const expiredRetired = Number(dailySummary?.expiredRetirement?.retired || 0) || 0;
  const skipEmail =
    (!dailySummary || (dailySummary.checked === 0 && expiredRetired === 0)) &&
    (!monthlySummary || monthlySummary.graduated === 0);
  let emailResult = null;
  const immediateEmailEnabled = String(
    process.env.AGED_REFRESH_IMMEDIATE_EMAIL_ENABLED || "false",
  ).trim().toLowerCase() === "true";
  if (!skipEmail && immediateEmailEnabled) {
    try {
      // Lazy require to avoid the hourlySweeper ↔ nightlyClose require
      // cycle (nightlyClose imports runHourlySweep from this module).
      const { sendAgedRefreshReportEmail } = require("./nightlyCloseService");
      emailResult = await sendAgedRefreshReportEmail({
        dailySummary,
        monthlySummary,
      });
    } catch (error) {
      logger?.warn?.("aged-rolling-refresh.email.failed", {
        error: error.message,
      });
      emailResult = { ok: false, error: error.message };
    }
  } else {
    emailResult = {
      skipped: true,
      reason: skipEmail ? "no-activity" : "consolidated-nightly-summary",
    };
  }

  return {
    ok: true,
    daily: dailySummary,
    monthly: monthlySummary,
    email: emailResult,
  };
}

function isDncRecheckEnabled() {
  return String(process.env.DNC_RECHECK_SWEEP_ENABLED || "false").trim().toLowerCase() === "true";
}

async function runDncRecheckSweepIfEnabled({ limit } = {}) {
  if (!isDncRecheckEnabled()) {
    return {
      skipped: true,
      reason: "disabled",
      detail: "RealValidation DNC checks are limited to intake and the monthly filler refresh.",
    };
  }
  return runDncRecheckSweep({ limit });
}

/**
 * THE FLOOR — the four jobs that run whatever else is retired.
 *
 * These used to live inside Phase A. That was survivable while Phase A ran, and
 * became a silent outage when `runScheduledPhase` went hardcoded-false in the
 * control plane: the caller still passes `dncRecheckEnabled: true`, and nothing
 * reads it. DNC rechecking stopping is the specific failure this codebase has
 * already paid for once, so the floor now runs on its own footing and cannot be
 * switched off by a decision about reconciliation scans.
 *
 * Every entry keeps the gate it already had — an env flag, a monthly boundary, a
 * 06:00-PT window, a pool-freshness check — so calling this on every tick cannot
 * make any of them run more often than they intend to.
 *
 * Each entry also keeps its own `.catch()`. A floor that fails all-or-nothing
 * would be worse than the bug it replaces.
 *
 * @param {Object} [impls] test injection. Null uses the real implementations.
 */
async function runFloorServices({
  dncRecheckEnabled = true,
  fillerPoolRefreshEnabled = true,
  agedRollingRefreshEnabled = true,
  dncRecheckLimit,
  agedRefreshLimitPerDomain,
  // The 05:00 (monthly filler) and 06:00 (aged ladder) gates exist to make an
  // HOURLY caller fire once. A pass runtime already fires once per day under a
  // durable claim, and it does not run at 05:00 or 06:00 — so with the hour
  // still required, folding the floor into the morning pass would mean the
  // monthly refresh and the aged ladder simply never run again. Default true:
  // the hourly hoist is byte-identical.
  requireHour = true,
  logger = null,
  impls = null,
} = {}) {
  const dncSweep = impls?.runDncRecheckSweepIfEnabled || runDncRecheckSweepIfEnabled;
  const fillerRefresh = impls?.runMonthlyFillerPoolRefreshIfDue || runMonthlyFillerPoolRefreshIfDue;
  const agedRefresh = impls?.runAgedRollingRefreshIfDue || runAgedRollingRefreshIfDue;

  return {
    // CallRail → DailyCallStat: the declared response-call feeder
    // (marker-stamped rows; see callrailDailyStatSyncService). Syncs
    // yesterday+today each pass — full-day recompute, idempotent, one
    // CallRail API pull. Env-gated HERE rather than via caller params, so no
    // caller's phase split can silently starve it.
    callrailStatSync:
      String(process.env.CALLRAIL_STAT_SYNC_ENABLED ?? "false") === "true"
        ? await (async () => {
            try {
              const syncCallrailDailyStats = impls?.syncCallrailDailyStats
                || require("./callrailDailyStatSyncService").syncCallrailDailyStats;
              const dayMs = 24 * 60 * 60 * 1000;
              const laDay = (offsetDays) =>
                new Intl.DateTimeFormat("en-CA", {
                  timeZone: "America/Los_Angeles",
                  year: "numeric",
                  month: "2-digit",
                  day: "2-digit",
                }).format(new Date(Date.now() - offsetDays * dayMs));
              return await syncCallrailDailyStats({ from: laDay(1), to: laDay(0) });
            } catch (error) {
              logger?.warn?.("callrail.stat_sync.failed", { error: error.message });
              return { error: error.message };
            }
          })()
        : { skipped: true, reason: "disabled" },

    dncRecheck: dncRecheckEnabled
      ? await dncSweep({ limit: dncRecheckLimit }).catch((error) => ({
          error: error.message,
        }))
      : { skipped: true, reason: "floor-service-disabled" },

    // Monthly filler-pool refresh — fires once a month on the first Pacific
    // business day at 5am PT. Pulls fresh status=2 candidates from Logics for both tenants,
    // DNC-scrubs them, atomic-ish swaps the prior month's pool tag, GCs MPI
    // rows whose case is no longer status=2. Idempotent across multiple ticks
    // in the 5am window via `hasFreshPoolForTag`.
    //
    // Will be retired after AGED_ROLLING_REFRESH_ENABLED is on for both
    // tenants and the rolling sweep is verified to maintain the pool
    // steady-state. Until then both run — the daily sweep adds 30-day-old
    // leads incrementally while the monthly burst rebuilds from Logics.
    fillerPoolRefresh: fillerPoolRefreshEnabled
      ? await fillerRefresh({ logger, requireHour }).catch((error) => ({
          error: error.message,
        }))
      : { skipped: true, reason: "floor-service-disabled" },

    // Rolling aged-pool refresh — fires daily at 06:00 PT (and the graduation
    // sweep additionally on day-1), behind AGED_ROLLING_REFRESH_ENABLED.
    // Returns { skipped, reason } outside the window or when the flag is off.
    agedRollingRefresh: agedRollingRefreshEnabled
      ? await agedRefresh({
          logger,
          requireHour,
          limitPerDomain: agedRefreshLimitPerDomain,
        }).catch((error) => ({
          error: error.message,
        }))
      : { skipped: true, reason: "floor-service-disabled" },
  };
}

async function runCxCallActivityBackfill({
  logger,
  domains,
  sinceMs,
  now = new Date(),
} = {}) {
  const end = now instanceof Date ? now : new Date(now);
  const windowMs = Math.max(Number(sinceMs) || 65 * 60 * 1000, 5 * 60 * 1000);
  const start = new Date(end.getTime() - windowMs);
  try {
    return await recoverCxCallLogs({
      start,
      end,
      domains,
      limit: 25000,
      dryRun: false,
      logger,
    });
  } catch (error) {
    logger?.warn?.("hourly.cx_call_activity_backfill_failed", {
      error: error.message,
    });
    return {
      error: error.message,
      start: start.toISOString(),
      end: end.toISOString(),
    };
  }
}

async function runCxTerminalRectificationStep({
  logger,
  domains,
  sinceMs,
  minAgeMs,
  limit,
  dryRun = true,
  now = new Date(),
} = {}) {
  try {
    const result = await runCxTerminalRectification({
      domains,
      sinceMs,
      minAgeMs,
      limit,
      dryRun,
      now,
    });
    logger?.info?.("hourly.cx_terminal_rectification", {
      dryRun: result.dryRun,
      scanned: result.scanned,
      strong: result.strong,
      wouldInsert: result.wouldInsert,
      inserted: result.inserted,
      errors: Array.isArray(result.errors) ? result.errors.length : 0,
      reasons: result.reasons,
    });
    return result;
  } catch (error) {
    logger?.warn?.("hourly.cx_terminal_rectification_failed", {
      error: error.message,
    });
    return {
      error: error.message,
      dryRun,
      skipped: false,
    };
  }
}

async function runHourlySweep({
  workerName = "hourly-sweeper",
  lane = "hourly",
  scheduledPhase = true,
  sessionReconcileEnabled = true,
  paymentReconcileEnabled = true,
  paymentFieldsSyncEnabled = true,
  batchCap = DEFAULT_BATCH_CAP,
  maxCasesPerDomain,
  leadCadenceEnforcementEnabled = false,
  leadCadenceEnforcementLimitPerDomain,
  leadCadenceEnforcementMinStaleMs,
  leadCadenceEnforcementDryRun = false,
  callLogHygieneEnabled = false,
  callLogHygieneSinceMs,
  callLogHygieneLimitPerDomain,
  callLogHygieneMirrorLegacyContactActivities = true,
  callLogHygieneNativeSweepEnabled = true,
  callLogHygieneNativeSweepLimit,
  callLogHygieneNativeSweepMaxPages,
  callLogHygieneNativeSweepDefaultDomain,
  callLogHygieneMinDurationSec,
  callLogHygieneMaxCaseRefreshesPerDomain,
  callLogHygieneMaxScoringPerDomain,
  callLogHygieneMaxArchivePerDomain,
  callLogHygieneScorePendingCalls = true,
  callLogHygieneArchiveRecordings = true,
  cxCallActivityBackfillEnabled = true,
  cxTerminalRectificationEnabled = false,
  cxTerminalRectificationDryRun = true,
  cxTerminalRectificationSinceMs,
  cxTerminalRectificationMinAgeMs,
  cxTerminalRectificationLimit,
  calllogBridgeEnabled = true,
  staleCadenceSweepEnabled = true,
  staleNcoaSweepEnabled = true,
  dncRecheckEnabled = true,
  fillerPoolRefreshEnabled = true,
  agedRollingRefreshEnabled = true,
  floorServicesEnabled = true,
  // Test injection for the floor services only. Production passes nothing.
  floorImpls = null,
  resolutionEmailsEnabled = true,
  metricsRefreshEnabled = true,
  metricsRefreshPreferLegacyContactActivities = false,
  domains = null,
  handlerKeys = null,
  logger = null,
} = {}) {
  const startedAt = new Date();
  const summary = {
    startedAt,
    lane,
    workerName,
    scheduledPhase,
    phaseA: null,
    phaseB: null,
  };

  if (scheduledPhase) {
    summary.phaseA = {
      sessionReconcile: sessionReconcileEnabled
        ? await runSessionReconcile({ logger })
        : { skipped: true, reason: "business-hours-lite" },
      paymentReconcile: paymentReconcileEnabled
        ? await runPaymentReconcileForAllDomains({
            logger,
            lane,
            maxCasesPerDomain,
          })
        : { skipped: true, reason: "business-hours-lite" },
      // Reconcile CaseProfile payment-derived fields against the
      // PaymentLedger truth set BEFORE metricsRefresh reads them.
      // Gated by PAYMENT_FIELD_SYNC_ENABLED — when off, this is a
      // cheap skip so the order stays correct for the day we flip it
      // on. See caseProfilePaymentSyncService for the design notes.
      paymentFieldsSync: paymentFieldsSyncEnabled
        ? await runPaymentFieldsSyncForAllDomains({
            logger,
            maxCasesPerDomain,
          })
        : { skipped: true, reason: "business-hours-lite" },
      callLogHygiene: callLogHygieneEnabled
        ? await runCallLogHygiene({
            logger,
            lane,
            domains,
            sinceMs: callLogHygieneSinceMs,
            limitPerDomain: callLogHygieneLimitPerDomain,
            mirrorLegacyContactActivities:
              callLogHygieneMirrorLegacyContactActivities,
            nativeSweepEnabled: callLogHygieneNativeSweepEnabled,
            nativeSweepLimit: callLogHygieneNativeSweepLimit,
            nativeSweepMaxPages: callLogHygieneNativeSweepMaxPages,
            nativeSweepDefaultDomain: callLogHygieneNativeSweepDefaultDomain,
            minDurationSec: callLogHygieneMinDurationSec,
            maxCaseRefreshesPerDomain: callLogHygieneMaxCaseRefreshesPerDomain,
            maxScoringPerDomain: callLogHygieneMaxScoringPerDomain,
            maxArchivePerDomain: callLogHygieneMaxArchivePerDomain,
            scorePendingCalls: callLogHygieneScorePendingCalls,
            archiveRecordings: callLogHygieneArchiveRecordings,
            // Keep touched dates fresh across the midnight boundary.
            // The broad metrics refresh below targets the current LA day,
            // while the call-log pass can still touch late prior-day rows.
            syncMetricsDates: true,
            preferLegacyContactActivities:
              metricsRefreshPreferLegacyContactActivities,
          })
        : { skipped: true, reason: "disabled" },
      // CX's campaign publish path emits `cx.call.placed` events before
      // RingCX gives us a real UII. The vendor email reads CallLedger,
      // so this backfills deterministic synthetic CallLog/CallLedger rows
      // from those events during the day instead of waiting on a manual
      // EOD script.
      cxCallActivityBackfill: cxCallActivityBackfillEnabled
        ? await runCxCallActivityBackfill({
            logger,
            domains,
            sinceMs: callLogHygieneSinceMs,
          })
        : { skipped: true, reason: "business-hours-lite" },
      cxTerminalRectification: cxTerminalRectificationEnabled
        ? await runCxTerminalRectificationStep({
            logger,
            domains,
            sinceMs: cxTerminalRectificationSinceMs || callLogHygieneSinceMs,
            minAgeMs: cxTerminalRectificationMinAgeMs,
            limit: cxTerminalRectificationLimit,
            dryRun: cxTerminalRectificationDryRun,
          })
        : { skipped: true, reason: "disabled" },
      // Legacy hourly metrics recompute RETIRED 2026-07-27: the board and
      // emails read the payment sheet, not callStat/snapshot rollups.
      metricsRefresh: { skipped: true, reason: "retired" },
      // callrailStatSync MOVED to runFloorServices — it is a floor service and
      // must not depend on Phase A running. See the note there.
      // cxRecordingHourly DELETED 2026-08-06 with its worker. The cx lane it
      // read stopped producing on 2026-07-16, so the pull could only ever
      // return no-eligible-rows.
      //
      // This entry was NOT dead code. POST /api/hygiene/hourly-sweep/run
      // defaults scheduledPhase TRUE and never passes cxRecordingHourlyEnabled,
      // so the param fell to its `= true` default and an admin hitting that
      // route ran the RingCX pull today. Removing the entry and the param
      // together is what closes that, per the two-step handover rule.
      leadCadenceEnforcement: leadCadenceEnforcementEnabled
        ? await runLeadCadenceEnforcement({
            logger,
            limitPerDomain: leadCadenceEnforcementLimitPerDomain,
            minStaleMs: leadCadenceEnforcementMinStaleMs,
            dryRun: leadCadenceEnforcementDryRun,
          })
        : { skipped: true, reason: "disabled" },
      staleCadenceSweep: staleCadenceSweepEnabled
        ? await runStaleCadenceSweep({ logger })
        : { skipped: true, reason: "business-hours-lite" },
      // Catch NCOA upload batches whose process died mid-flight before
      // the in-process try/finally could write a terminal envelope.
      // Idempotent — only closes batches that have a `requested`
      // stage, no `completed`/`failed`, and no row activity in 30m+.
      staleNcoaSweep: staleNcoaSweepEnabled
        ? await sweepStaleNcoaBatches({}).catch((error) => ({
            error: error.message,
          }))
        : { skipped: true, reason: "business-hours-lite" },
      // ncoaMailbox MOVED to the nightly mailbox task. It read documents@ for
      // unread CSV/TXT attachments and self-skipped once a day's file landed —
      // which meant it was a DAILY job wearing an hourly trigger, and it was
      // the second such trigger (server.js had its own hour slot). Both are
      // gone: the nightly task opens that mailbox once and reads the vendor
      // invoice and the NCOA returns on the same visit.
      //
      // Deleted rather than gated. A dark duplicate of a live job is the thing
      // that comes back when someone re-arms Phase A and cannot tell that the
      // work already has an owner.
      // Disabled by default: RealValidation spending is limited to
      // intake-time validation plus the once-monthly filler rebuild.
      // dncRecheck MOVED to runFloorServices. It is the floor service this
      // whole extraction exists for: it stopped when Phase A did.
      // CallLog → CaseProfile bridge — self-healing sweep for cases
      // where a call landed (CallLog row written, caseId resolved)
      // but the CaseProfile promotion never produced a row. Without
      // this, payment reconcile / metrics rollups / CX queue render
      // can't see the case. Idempotent: existing-profile rows just
      // get back-linked and skipped on the next pass.
      calllogBridge: calllogBridgeEnabled
        ? await runCallLogToCaseProfileBridge({ logger }).catch((error) => ({
            error: error.message,
          }))
        : { skipped: true, reason: "business-hours-lite" },
      // fillerPoolRefresh and agedRollingRefresh MOVED to runFloorServices —
      // the pool must keep being rebuilt and advanced whatever else retires.
      resolutionEmails: resolutionEmailsEnabled
        ? await sendResolutionEmails({ logger })
        : { skipped: true, reason: "business-hours-lite" },
    };
  }

  // THE FLOOR — outside `if (scheduledPhase)` on purpose.
  //
  // These four ran inside Phase A until the control plane hardcoded
  // `runScheduledPhase = false`, at which point they silently stopped while the
  // caller went on passing `dncRecheckEnabled: true`. DNC rechecking must never
  // be gated on a decision about reconciliation scans again.
  //
  // Every entry keeps its own internal gate, so running this on every tick
  // cannot make any of them fire more often than it intends to.
  summary.floor = floorServicesEnabled
    ? await runFloorServices({
        dncRecheckEnabled,
        fillerPoolRefreshEnabled,
        agedRollingRefreshEnabled,
        logger,
        impls: floorImpls,
      })
    : {
        skipped: true,
        reason: "owned-by-morning-pass",
      };

  summary.phaseB = await drainHourlyJobQueue({
    workerName,
    lane,
    batchCap,
    handlerKeys,
    logger,
  });

  summary.finishedAt = new Date();
  summary.durationMs = summary.finishedAt - startedAt;
  return summary;
}

module.exports = {
  DEFAULT_BATCH_CAP,
  DEFAULT_RESOLUTION_LOOKBACK_MS,
  RESOLUTION_NOTE_MARKER,
  drainHourlyJobQueue,
  // Exported for the morning pass, which registers the same four services as
  // tasks. The pass calls runFloorServices whole rather than re-implementing
  // its four members: two of them (runMonthlyFillerPoolRefreshIfDue,
  // runAgedRollingRefreshIfDue) were module-private, and callrailStatSync is
  // not a function at all but an inline body with its own day helper. A second
  // copy of any of that is the drift this repo has already paid for twice.
  runFloorServices,
  runHourlySweep,
  sendResolutionEmails,
  summarizeHourlySweepResult,
};
