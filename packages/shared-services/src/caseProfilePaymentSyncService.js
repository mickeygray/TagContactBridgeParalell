"use strict";

/**
 * caseProfilePaymentSyncService
 *
 * Sweeps CaseProfile payment-derived fields (firstPaymentDate,
 * initialPayment, lastPaymentDate, lastPaymentAmount, totalPaid,
 * paymentsCount) and reconciles them against the PaymentLedger truth
 * set. Designed to run in the hourly sweeper Phase A AFTER
 * paymentReconcileService writes new ledger rows and BEFORE
 * metricsRefresh reads CP fields.
 *
 * Why this exists:
 *   `applyPaymentToCaseProfile` is correct but only fires per ledger
 *   write. When a manual/historical correction lands on the ledger
 *   (out-of-order paymentDate, status flips, mid-batch edits), the
 *   counters CAN drift. Rather than pile more guards onto the inline
 *   path, this service is the canonical reconciliation pass — every
 *   hour it picks up cases the ledger touched recently (or whose CP
 *   row hasn't been audited in a day) and recomputes the derived
 *   fields from scratch.
 *
 * Race-safety:
 *   - Acquires `runLockRepository` lock named "payment-fields-sync"
 *     with a 10-min TTL so two sweepers can't fight over the same
 *     candidate set.
 *   - Per-case writes go through CaseProfile.updateOne with $set;
 *     even if a paymentReconcile listener races the sync, the
 *     applyPaymentToCaseProfile out-of-order guards (filter on
 *     firstPaymentDate, lastPaymentDate) keep the result consistent
 *     once both writes settle.
 *
 * Initial-payment rule:
 *   1. SUCCESS row tagged paymentType="initial" wins (after the
 *      composite sort below picks the right one when there are ties).
 *   2. Fallback: oldest SUCCESS row by composite sort. Used when
 *      Logics mislabels (back-dated entries that race the auto-tag).
 *      Recorded on summary.fallbackUsed so ops sees the count.
 *
 * Composite sort tiebreakers (oldest → newest):
 *   paymentDate ASC → paymentType (initial first) ASC →
 *   casePaymentId ASC → _id ASC.
 *
 * Drift thresholds:
 *   - amount fields (initialPayment, lastPaymentAmount, totalPaid):
 *     |desired - current| > $0.005 (rounding-noise floor)
 *   - date fields (firstPaymentDate, lastPaymentDate): >= 1 day diff
 *   - paymentsCount: any mismatch
 *
 * Workflow notification:
 *   When the summed amount drift across an individual case exceeds
 *   $1, emits a `case-attribution-drift` workflow record (subtype
 *   `payment-fields`) with day-bucket dedupeKey so the same case
 *   doesn't re-notify within a single calendar day.
 *
 * Dry-run mode:
 *   `dryRun: true` performs all reads + drift detection but skips
 *   every write (no CaseProfile $set, no workflow record). Returns
 *   `wouldUpdate` count so the smoke script can preview impact.
 */

const {
  runLockRepository,
  workflowRecordRepository,
} = require("../../shared-repositories/src");
const { CaseProfile, PaymentLedger } = require("../../shared-models/src");

const LOCK_NAME = "payment-fields-sync";
const DEFAULT_LOCK_TTL_MS = 10 * 60 * 1000;
const DEFAULT_LOOKBACK_HOURS = 6;
const DEFAULT_STALE_CHECK_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_CASES = 500;
const DRIFT_AMOUNT_EPSILON = 0.005;
const DRIFT_DATE_DIFF_MS = 24 * 60 * 60 * 1000;
const DRIFT_NOTIFY_THRESHOLD_DOLLARS = 1;

const AMOUNT_DRIFT_FIELDS = new Set([
  "initialPayment",
  "lastPaymentAmount",
  "totalPaid",
]);

function normalizeDomain(domain) {
  return String(domain || "").trim().toUpperCase();
}

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function dateMs(value) {
  const date = toDate(value);
  return date ? date.getTime() : 0;
}

/**
 * Composite sort enforcing initial-first tie-break. The DB query
 * orders rows by paymentDate ASC, but ties on date can hide the real
 * initial row (two rows with the same date — one auto, one back-
 * dated by ops). This JS-side sort is the canonical ordering used by
 * `pickInitialPayment`, so the choice is deterministic regardless of
 * whichever row Mongo returned first.
 */
function comparePaymentLedgerRows(a, b) {
  const aDate = dateMs(a?.paymentDate);
  const bDate = dateMs(b?.paymentDate);
  if (aDate !== bDate) return aDate - bDate;

  const aIsInitial = String(a?.paymentType || "").toLowerCase() === "initial" ? 0 : 1;
  const bIsInitial = String(b?.paymentType || "").toLowerCase() === "initial" ? 0 : 1;
  if (aIsInitial !== bIsInitial) return aIsInitial - bIsInitial;

  const aCpId = Number(a?.casePaymentId) || 0;
  const bCpId = Number(b?.casePaymentId) || 0;
  if (aCpId !== bCpId) return aCpId - bCpId;

  return String(a?._id || "").localeCompare(String(b?._id || ""));
}

function pickInitialPayment(successfulSorted = []) {
  if (successfulSorted.length === 0) {
    return { row: null, fallbackUsed: false };
  }
  const initial = successfulSorted.find(
    (row) => String(row.paymentType || "").toLowerCase() === "initial",
  );
  if (initial) return { row: initial, fallbackUsed: false };
  return { row: successfulSorted[0], fallbackUsed: true };
}

function computeDesiredFields(ledgerRows = []) {
  const successful = ledgerRows
    .filter(
      (row) =>
        String(row?.transactionStatus || "").toUpperCase() === "SUCCESS",
    )
    .slice()
    .sort(comparePaymentLedgerRows);

  const { row: initialRow, fallbackUsed } = pickInitialPayment(successful);

  const totalPaid = successful.reduce(
    (sum, row) => sum + (Number(row.amount) || 0),
    0,
  );

  // Last = most recent SUCCESS by paymentDate. Sort the same array
  // descending (cheap on hundreds of rows max per case).
  const byDateDesc = successful
    .slice()
    .sort((a, b) => dateMs(b.paymentDate) - dateMs(a.paymentDate));
  const lastRow = byDateDesc[0] || null;

  return {
    firstPaymentDate: initialRow ? toDate(initialRow.paymentDate) : null,
    initialPayment: initialRow ? Number(initialRow.amount) || 0 : 0,
    lastPaymentDate: lastRow ? toDate(lastRow.paymentDate) : null,
    lastPaymentAmount: lastRow ? Number(lastRow.amount) || 0 : 0,
    totalPaid,
    paymentsCount: successful.length,
    initialFallbackUsed: fallbackUsed,
  };
}

function detectDrift(current = {}, desired = {}) {
  const drifts = [];

  const firstDiff = Math.abs(
    dateMs(current.firstPaymentDate) - dateMs(desired.firstPaymentDate),
  );
  if (firstDiff >= DRIFT_DATE_DIFF_MS) {
    drifts.push({
      field: "firstPaymentDate",
      current: current.firstPaymentDate || null,
      desired: desired.firstPaymentDate || null,
    });
  }

  const initialDiff = Math.abs(
    (Number(current.initialPayment) || 0) - desired.initialPayment,
  );
  if (initialDiff > DRIFT_AMOUNT_EPSILON) {
    drifts.push({
      field: "initialPayment",
      current: Number(current.initialPayment) || 0,
      desired: desired.initialPayment,
    });
  }

  const lastDateDiff = Math.abs(
    dateMs(current.lastPaymentDate) - dateMs(desired.lastPaymentDate),
  );
  if (lastDateDiff >= DRIFT_DATE_DIFF_MS) {
    drifts.push({
      field: "lastPaymentDate",
      current: current.lastPaymentDate || null,
      desired: desired.lastPaymentDate || null,
    });
  }

  const lastAmountDiff = Math.abs(
    (Number(current.lastPaymentAmount) || 0) - desired.lastPaymentAmount,
  );
  if (lastAmountDiff > DRIFT_AMOUNT_EPSILON) {
    drifts.push({
      field: "lastPaymentAmount",
      current: Number(current.lastPaymentAmount) || 0,
      desired: desired.lastPaymentAmount,
    });
  }

  const totalDiff = Math.abs(
    (Number(current.totalPaid) || 0) - desired.totalPaid,
  );
  if (totalDiff > DRIFT_AMOUNT_EPSILON) {
    drifts.push({
      field: "totalPaid",
      current: Number(current.totalPaid) || 0,
      desired: desired.totalPaid,
    });
  }

  if ((Number(current.paymentsCount) || 0) !== desired.paymentsCount) {
    drifts.push({
      field: "paymentsCount",
      current: Number(current.paymentsCount) || 0,
      desired: desired.paymentsCount,
    });
  }

  return drifts;
}

function sumAmountDriftDollars(drifts = []) {
  return drifts
    .filter((d) => AMOUNT_DRIFT_FIELDS.has(d.field))
    .reduce(
      (sum, d) =>
        sum + Math.abs((Number(d.desired) || 0) - (Number(d.current) || 0)),
      0,
    );
}

/**
 * 4-signal candidate query. Returns the union of caseIds touched by:
 *   1. PaymentLedger.paymentDate >= cutoff (a new payment landed)
 *   2. PaymentLedger.updatedAt >= cutoff   (an existing row flipped status)
 *   3. CaseProfile.updatedAt >= cutoff     (a CP write happened)
 *   4. CaseProfile.paymentReconcile.lastCheckedAt < staleCutoff
 *      (the CP hasn't been audited in `staleCheckMs`)
 *
 * Signals 1 + 2 cover ledger-side drift triggers. Signals 3 + 4 cover
 * CP-side rot — particularly important during the first hour after
 * deploy when no ledger writes have happened yet.
 */
async function listCandidateCaseIds(normalizedDomain, options = {}) {
  const lookbackHours =
    Number(options.lookbackHours) > 0
      ? Number(options.lookbackHours)
      : DEFAULT_LOOKBACK_HOURS;
  const staleCheckMs =
    Number(options.staleCheckMs) > 0
      ? Number(options.staleCheckMs)
      : DEFAULT_STALE_CHECK_MS;

  const lookbackMs = Math.max(lookbackHours * 60 * 60 * 1000, 60 * 60 * 1000);
  const cutoff = new Date(Date.now() - lookbackMs);
  const staleCutoff = new Date(Date.now() - Math.max(staleCheckMs, 60 * 60 * 1000));

  const [ledgerCaseIds, caseProfileCaseIds] = await Promise.all([
    PaymentLedger.distinct("caseId", {
      domain: normalizedDomain,
      $or: [
        { paymentDate: { $gte: cutoff } },
        { updatedAt: { $gte: cutoff } },
      ],
    }),
    CaseProfile.distinct("caseId", {
      domain: normalizedDomain,
      caseId: { $ne: null },
      $or: [
        { updatedAt: { $gte: cutoff } },
        { "paymentReconcile.lastCheckedAt": null },
        { "paymentReconcile.lastCheckedAt": { $exists: false } },
        { "paymentReconcile.lastCheckedAt": { $lt: staleCutoff } },
      ],
    }),
  ]);

  const seen = new Set();
  for (const id of ledgerCaseIds) {
    const num = Number(id);
    if (Number.isFinite(num)) seen.add(num);
  }
  for (const id of caseProfileCaseIds) {
    const num = Number(id);
    if (Number.isFinite(num)) seen.add(num);
  }
  return [...seen];
}

async function emitDriftWorkflow({
  normalizedDomain,
  caseId,
  drifts,
  desired,
  current,
  totalDriftDollars,
}) {
  if (totalDriftDollars < DRIFT_NOTIFY_THRESHOLD_DOLLARS) return null;

  // Day-bucket dedupe so the same case doesn't re-notify within 24h
  // even if the hourly sweep re-detects the same drift before a manual
  // fix lands. Partial unique index on dedupeKey enforces this at the
  // collection level.
  const dayBucket = new Date().toISOString().slice(0, 10);
  const dedupeKey = `${normalizedDomain}:case-attribution-drift:payment-fields:${caseId}:${dayBucket}`;

  try {
    return await workflowRecordRepository.createWorkflowRecord({
      domain: normalizedDomain,
      family: "case-attribution-drift",
      subtype: "payment-fields",
      stage: "observed",
      aggregateType: "case-profile",
      aggregateId: String(caseId),
      caseId: Number(caseId),
      sourceService: "case-profile-payment-sync",
      workerName: "runPaymentFieldsSync",
      status: "ok",
      title: `Case ${caseId} payment-field drift`,
      summary: `Drift on ${drifts.map((d) => d.field).join(", ")} (Δ$${totalDriftDollars.toFixed(2)})`,
      payload: {
        drifts,
        desired: {
          firstPaymentDate: desired.firstPaymentDate || null,
          initialPayment: desired.initialPayment,
          lastPaymentDate: desired.lastPaymentDate || null,
          lastPaymentAmount: desired.lastPaymentAmount,
          totalPaid: desired.totalPaid,
          paymentsCount: desired.paymentsCount,
        },
        current: {
          firstPaymentDate: current.firstPaymentDate || null,
          initialPayment: Number(current.initialPayment) || 0,
          lastPaymentDate: current.lastPaymentDate || null,
          lastPaymentAmount: Number(current.lastPaymentAmount) || 0,
          totalPaid: Number(current.totalPaid) || 0,
          paymentsCount: Number(current.paymentsCount) || 0,
        },
        totalDriftDollars: Number(totalDriftDollars.toFixed(4)),
      },
      dedupeKey,
      happenedAt: new Date(),
    });
  } catch (err) {
    if (err && err.code === 11000) return null; // already notified today
    throw err;
  }
}

async function processCandidateCase({
  normalizedDomain,
  caseId,
  dryRun = false,
  logger = null,
}) {
  const profile = await CaseProfile.findOne({
    domain: normalizedDomain,
    caseId,
  }).lean();
  if (!profile) {
    return { caseId, skipped: true, reason: "no-case-profile" };
  }

  const ledgerRows = await PaymentLedger.find({
    domain: normalizedDomain,
    caseId,
  })
    .sort({ paymentDate: 1, casePaymentId: 1 })
    .lean();

  const desired = computeDesiredFields(ledgerRows);
  const drifts = detectDrift(profile, desired);

  if (drifts.length === 0) {
    if (!dryRun) {
      await CaseProfile.updateOne(
        { domain: normalizedDomain, caseId },
        {
          $set: {
            "paymentReconcile.lastCheckedAt": new Date(),
          },
        },
      );
    }
    return {
      caseId,
      drifted: false,
      drifts: [],
      desired,
      fallbackUsed: desired.initialFallbackUsed,
      ledgerRowCount: ledgerRows.length,
    };
  }

  const totalDriftDollars = sumAmountDriftDollars(drifts);

  if (dryRun) {
    return {
      caseId,
      drifted: true,
      wouldUpdate: true,
      drifts,
      desired,
      fallbackUsed: desired.initialFallbackUsed,
      totalDriftDollars,
      ledgerRowCount: ledgerRows.length,
    };
  }

  const now = new Date();
  await CaseProfile.updateOne(
    { domain: normalizedDomain, caseId },
    {
      $set: {
        firstPaymentDate: desired.firstPaymentDate,
        initialPayment: desired.initialPayment,
        lastPaymentDate: desired.lastPaymentDate,
        lastPaymentAmount: desired.lastPaymentAmount,
        totalPaid: desired.totalPaid,
        paymentsCount: desired.paymentsCount,
        "paymentReconcile.lastCheckedAt": now,
        "paymentReconcile.lastDriftedAt": now,
        "paymentReconcile.lastResult": "drift-corrected",
      },
    },
  );

  await emitDriftWorkflow({
    normalizedDomain,
    caseId,
    drifts,
    desired,
    current: profile,
    totalDriftDollars,
  }).catch((err) => {
    logger?.warn?.("payment-field-sync.workflow_emit_failed", {
      domain: normalizedDomain,
      caseId,
      error: err?.message || String(err),
    });
  });

  return {
    caseId,
    drifted: true,
    wouldUpdate: true,
    drifts,
    desired,
    fallbackUsed: desired.initialFallbackUsed,
    totalDriftDollars,
    ledgerRowCount: ledgerRows.length,
  };
}

/**
 * Sweep CaseProfile payment-derived fields and reconcile against the
 * PaymentLedger truth set. See the file header for full design notes.
 *
 * Args:
 *   - domain (required)
 *   - lookbackHours (default 6)        — Signals 1-3 cutoff window
 *   - staleCheckMs (default 24h)       — Signal 4 cutoff
 *   - maxCases    (default 500)        — per-run cap
 *   - dryRun      (default false)      — read-only mode for smoke tests
 *   - lockTtlMs   (default 10min)      — run-lock TTL
 *   - lockedBy    (default "hourly-sweep")
 *   - logger      (optional)           — pino-shaped logger
 *
 * Returns a summary `{ skipped, reason?, casesScanned, casesWithDrift,
 * casesUpdated, fallbackUsed, totalDriftDollars, wouldUpdate, errors,
 * errorDetails }`.
 *
 * The hourly sweep wire-in (NOT this function) is the one gated by
 * `PAYMENT_FIELD_SYNC_ENABLED`. Calling this directly (e.g. from the
 * smoke script) always runs.
 */
async function runPaymentFieldsSync({
  domain,
  lookbackHours = DEFAULT_LOOKBACK_HOURS,
  staleCheckMs = DEFAULT_STALE_CHECK_MS,
  maxCases = DEFAULT_MAX_CASES,
  dryRun = false,
  lockTtlMs = DEFAULT_LOCK_TTL_MS,
  lockedBy = "hourly-sweep",
  logger = null,
} = {}) {
  const normalizedDomain = normalizeDomain(domain);
  if (!normalizedDomain) {
    return {
      skipped: true,
      reason: "missing-domain",
      casesScanned: 0,
      casesWithDrift: 0,
      casesUpdated: 0,
      fallbackUsed: 0,
      totalDriftDollars: 0,
      wouldUpdate: 0,
      errors: 0,
      errorDetails: [],
    };
  }

  const lockHandle = await runLockRepository.acquireRunLock(
    LOCK_NAME,
    lockTtlMs,
    lockedBy,
  );
  if (!lockHandle) {
    return {
      skipped: true,
      reason: "lock-busy",
      domain: normalizedDomain,
      casesScanned: 0,
      casesWithDrift: 0,
      casesUpdated: 0,
      fallbackUsed: 0,
      totalDriftDollars: 0,
      wouldUpdate: 0,
      errors: 0,
      errorDetails: [],
    };
  }

  const summary = {
    skipped: false,
    domain: normalizedDomain,
    casesScanned: 0,
    casesWithDrift: 0,
    casesUpdated: 0,
    fallbackUsed: 0,
    totalDriftDollars: 0,
    wouldUpdate: 0,
    errors: 0,
    errorDetails: [],
    sample: [],
  };

  try {
    const candidateIds = await listCandidateCaseIds(normalizedDomain, {
      lookbackHours,
      staleCheckMs,
    });

    const cap = Math.max(Number(maxCases) || 0, 0);
    const limited = cap > 0 ? candidateIds.slice(0, cap) : candidateIds;
    summary.casesScanned = limited.length;

    for (const caseId of limited) {
      try {
        const result = await processCandidateCase({
          normalizedDomain,
          caseId,
          dryRun,
          logger,
        });
        if (result?.skipped) continue;
        if (result?.fallbackUsed) summary.fallbackUsed += 1;
        if (result?.drifted) {
          summary.casesWithDrift += 1;
          if (dryRun) {
            summary.wouldUpdate += 1;
          } else {
            summary.casesUpdated += 1;
          }
          summary.totalDriftDollars += Number(result.totalDriftDollars || 0);
          if (summary.sample.length < 25) {
            summary.sample.push({
              caseId: result.caseId,
              fields: result.drifts.map((d) => d.field),
              totalDriftDollars: Number(
                (result.totalDriftDollars || 0).toFixed(2),
              ),
              fallbackUsed: Boolean(result.fallbackUsed),
              ledgerRowCount: result.ledgerRowCount,
            });
          }
        }
      } catch (error) {
        summary.errors += 1;
        summary.errorDetails.push({
          caseId,
          error: error?.message || String(error),
        });
        logger?.warn?.("payment-field-sync.case_failed", {
          domain: normalizedDomain,
          caseId,
          error: error?.message || String(error),
        });
      }
    }
  } finally {
    await runLockRepository
      .releaseRunLock(LOCK_NAME, lockHandle.token)
      .catch(() => null);
  }

  summary.totalDriftDollars = Number(summary.totalDriftDollars.toFixed(2));
  return summary;
}

module.exports = {
  LOCK_NAME,
  DEFAULT_LOCK_TTL_MS,
  DEFAULT_LOOKBACK_HOURS,
  DEFAULT_STALE_CHECK_MS,
  DEFAULT_MAX_CASES,
  DRIFT_AMOUNT_EPSILON,
  DRIFT_DATE_DIFF_MS,
  DRIFT_NOTIFY_THRESHOLD_DOLLARS,
  comparePaymentLedgerRows,
  computeDesiredFields,
  detectDrift,
  listCandidateCaseIds,
  pickInitialPayment,
  processCandidateCase,
  runPaymentFieldsSync,
  sumAmountDriftDollars,
};
