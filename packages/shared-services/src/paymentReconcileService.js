"use strict";

const { createLogicsClient } = require("../../shared-integrations/src");
const {
  caseProfileRepository,
  paymentLedgerRepository,
  reviewQueueRepository,
} = require("../../shared-repositories/src");
const { emitHourlyJobEvent } = require("./hourlyJobEventService");
const marketingMoneyService = require("./marketingMoneyService");

// Sensible defaults — overridable per call.
const DEFAULT_STALE_AFTER_MS = 60 * 60 * 1000; // re-check after 1 hour
const DEFAULT_MAX_CASES_PER_RUN = 250;

function normalizeDomain(domain) {
  return String(domain || "").trim().toUpperCase();
}

function buildPaymentDateKey(rawPaidDate, paidDate) {
  const raw = String(rawPaidDate || "").trim();
  if (raw.length >= 10) return raw.slice(0, 10);
  return paidDate.toISOString().slice(0, 10);
}

function extractPayloadData(payload) {
  const raw =
    payload?.data !== undefined && payload?.data !== null
      ? payload.data
      : payload?.Data !== undefined && payload?.Data !== null
        ? payload.Data
        : payload;

  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  return raw && typeof raw === "object" ? raw : null;
}

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 11 && digits.startsWith("1")) {
    return digits.slice(1);
  }
  return digits.length >= 10 ? digits.slice(-10) : null;
}

function buildCaseProfileSeedFromLogics(data = {}, payment = null) {
  const firstName = data.FirstName || null;
  const lastName = data.LastName || null;
  const name =
    [firstName, lastName].filter(Boolean).join(" ").trim() ||
    data.FullName ||
    data.Name ||
    null;
  const normalizedPhones = [
    data.CellPhone,
    data.HomePhone,
    data.WorkPhone,
  ]
    .map((value) => normalizePhone(value))
    .filter(Boolean);
  const caseCreatedDate = data.CreatedDate ? new Date(data.CreatedDate) : null;
  const convertedAt = data.SaleDate
    ? new Date(data.SaleDate)
    : payment?.paymentDate || null;

  return {
    firstName,
    lastName,
    name,
    email: data.Email || null,
    primaryPhone: data.CellPhone || data.HomePhone || data.WorkPhone || null,
    normalizedPhones,
    sourceName: data.SourceName || data.sourceName || null,
    notes: data.Notes || data.notes || null,
    statusId:
      data.StatusID != null
        ? Number(data.StatusID)
        : data.Status != null
          ? Number(data.Status)
          : null,
    lastStatusCheckAt: new Date(),
    statusCategory: "client",
    convertedAt,
    caseCreatedDate:
      caseCreatedDate instanceof Date && !Number.isNaN(caseCreatedDate.getTime())
        ? caseCreatedDate
        : null,
  };
}

async function ensureCurrentCaseProfileForPayment({
  client,
  domain,
  caseId,
  payment = null,
  logger = null,
} = {}) {
  let payload = null;
  try {
    payload = await client.getCaseInfo(caseId);
  } catch (error) {
    logger?.warn?.("payment.reconcile.caseinfo_failed", {
      domain,
      caseId,
      error: error.message,
    });
  }

  const seed = buildCaseProfileSeedFromLogics(extractPayloadData(payload) || {}, payment);
  return caseProfileRepository.createCaseProfileIfMissing(domain, caseId, seed);
}

function comparePaymentRows(left, right) {
  const leftDateKey = buildPaymentDateKey(left?.PaidDate, new Date(0));
  const rightDateKey = buildPaymentDateKey(right?.PaidDate, new Date(0));
  if (leftDateKey !== rightDateKey) {
    return leftDateKey < rightDateKey ? -1 : 1;
  }
  return (Number(left?.CasePaymentID) || 0) - (Number(right?.CasePaymentID) || 0);
}

function inferPaymentType(raw, paymentTypeHint = null) {
  if (paymentTypeHint === "initial" || paymentTypeHint === "recurring") {
    return paymentTypeHint;
  }

  const paymentTypeRaw = String(
    raw?.PaymentType || raw?.PaymentTypeName || raw?.Type || "",
  ).toLowerCase();
  if (paymentTypeRaw.includes("initial") || paymentTypeRaw.includes("first")) {
    return "initial";
  }
  if (
    paymentTypeRaw.includes("recurring") ||
    paymentTypeRaw.includes("monthly")
  ) {
    return "recurring";
  }
  return "unknown";
}

function extractPaymentRows(rawPayments) {
  const payload =
    rawPayments?.data !== undefined && rawPayments?.data !== null
      ? rawPayments.data
      : rawPayments?.Data !== undefined && rawPayments?.Data !== null
        ? rawPayments.Data
        : rawPayments;

  if (typeof payload === "string") {
    try {
      const parsed = JSON.parse(payload);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  return Array.isArray(payload) ? payload : [];
}

function normalizePaymentRow(raw, domain, paymentTypeHint = null) {
  const casePaymentId = Number(raw?.CasePaymentID);
  if (!Number.isFinite(casePaymentId) || casePaymentId <= 0) return null;
  const caseId = Number(raw?.CaseID);
  const amount = parseFloat(raw?.Amount);
  const paidDate = raw?.PaidDate ? new Date(raw.PaidDate) : null;
  if (!Number.isFinite(caseId) || !Number.isFinite(amount) || !paidDate) return null;

  const statusRaw = String(raw?.TransactionStatus || "").trim();
  // Logics uses ALL-CAPS status strings ("SUCCESS", "FAILED", "PENDING", etc.).
  const transactionStatus = statusRaw || null;
  const paymentType = inferPaymentType(raw, paymentTypeHint);
  const paymentDateKey = buildPaymentDateKey(raw?.PaidDate, paidDate);

  return {
    casePaymentId,
    caseId,
    domain: normalizeDomain(domain),
    amount,
    paymentDate: paidDate,
    paymentDateKey,
    paymentType,
    transactionStatus,
    raw,
  };
}

function normalizePaymentRows(rawPayments, domain) {
  const rows = extractPaymentRows(rawPayments);
  const successful = rows
    .filter(
      (row) =>
        String(row?.TransactionStatus || "").trim().toUpperCase() === "SUCCESS" &&
        row?.PaidDate,
    )
    .sort(comparePaymentRows);

  // Type precedence (fixed 2026-07-24 — the old first=initial/rest=recurring
  // positional guess OVERRODE Logics' own PaymentType field, mistyping
  // chargebacks and declined-then-retried initials as "recurring"):
  //   1. Logics' PaymentType field, when it says initial/recurring.
  //   2. Negative amounts are REVERSALS: inherit the type of the matching
  //      positive success (same |amount|) — a charged-back initial must
  //      reverse under initials, never haunt recurring.
  //   3. Positional fallback: first POSITIVE success = initial, rest
  //      recurring.
  const paymentTypeById = new Map();
  const positiveSuccesses = successful.filter((row) => parseFloat(row?.Amount) > 0);
  positiveSuccesses.forEach((row, index) => {
    const casePaymentId = Number(row?.CasePaymentID);
    if (!Number.isFinite(casePaymentId) || casePaymentId <= 0) return;
    const fieldType = inferPaymentType(row);
    paymentTypeById.set(
      casePaymentId,
      fieldType !== "unknown" ? fieldType : index === 0 ? "initial" : "recurring",
    );
  });
  for (const row of successful) {
    const casePaymentId = Number(row?.CasePaymentID);
    if (!Number.isFinite(casePaymentId) || casePaymentId <= 0) continue;
    const amount = parseFloat(row?.Amount);
    if (!(amount < 0)) continue;
    const fieldType = inferPaymentType(row);
    if (fieldType !== "unknown") {
      paymentTypeById.set(casePaymentId, fieldType);
      continue;
    }
    const reversed = positiveSuccesses.find(
      (candidate) => parseFloat(candidate?.Amount) === -amount,
    );
    const reversedType = reversed
      ? paymentTypeById.get(Number(reversed?.CasePaymentID))
      : null;
    paymentTypeById.set(casePaymentId, reversedType || "unknown");
  }

  return rows
    .map((row) =>
      normalizePaymentRow(
        row,
        domain,
        paymentTypeById.get(Number(row?.CasePaymentID)) || null,
      ),
    )
    .filter(Boolean);
}

/**
 * For a single case: pull Logics payments, upsert each row into the
 * PaymentLedger, update CaseProfile counters, and emit a review item
 * on failed transactions.
 *
 * Idempotent:
 *  - PaymentLedger uses `casePaymentId` as the unique key.
 *  - CaseProfile.applyPaymentToCaseProfile guards on `paymentIds`
 *    set membership so re-running doesn't double-count.
 *
 * Returns `{ caseId, payments, newLedgerRows, flaggedFailures, error }`.
 */
async function reconcilePaymentsForCase({
  domain,
  caseId,
  lane = "hourly",
  logger = null,
} = {}) {
  const normalizedDomain = normalizeDomain(domain);
  const client = createLogicsClient(normalizedDomain);

  let rawPayments;
  try {
    rawPayments = await client.getCasePayments(caseId);
  } catch (error) {
    // Logics returns 404 on `billing/casepayment?CaseID=<x>` when the
    // case simply has no billing records — not when the case is
    // missing. Cases in early status, prospects that never converted,
    // or client cases that haven't been billed yet all land here.
    // Treat as "no payments" and proceed to the normal empty-list
    // path so we stamp the checkpoint and move on.
    const status = error?.details?.responseStatus;
    if (status === 404) {
      rawPayments = [];
      logger?.info?.("payment.reconcile.no_payments_on_case", {
        domain: normalizedDomain,
        caseId,
      });
    } else {
      await emitHourlyJobEvent({
        lane: String(lane || "hourly").toLowerCase() === "nightly" ? "nightly" : "hourly",
        domain: normalizedDomain,
        eventType: "payments.case.reconcile",
        targetService: "control-plane",
        handlerKey: "reconcileCasePayments",
        aggregateType: "case-profile",
        aggregateId: String(caseId),
        caseId: Number(caseId),
        payload: {
          domain: normalizedDomain,
          caseId: Number(caseId),
        },
        resolutionCheckKey: "payment-ledger-fresh",
        resolutionContext: {
          caseId: Number(caseId),
        },
        dedupeKey: `${normalizedDomain}:payments:${Number(caseId)}`,
        emittedBy: "control-plane",
        priority: 55,
        severity: "warning",
        immediateRetryAttempts: 1,
        immediateRetryDelayMs: 1000,
        provideSummary: false,
        firstError: error.message,
        notify: false,
      }).catch(() => null);
      logger?.warn?.("payment.reconcile.logics_error", {
        domain: normalizedDomain,
        caseId,
        error: error.message,
      });
      return {
        caseId,
        payments: 0,
        newLedgerRows: 0,
        flaggedFailures: 0,
        error: error.message,
      };
    }
  }

  const normalized = normalizePaymentRows(rawPayments, normalizedDomain);

  let newLedgerRows = 0;
  let flaggedFailures = 0;
  let reversals = 0;

  // Snapshot ledger rows ONCE per case so we can detect status flips
  // (SUCCESS → FAILED = chargeback) without re-querying per payment.
  const priorLedgerRows = await paymentLedgerRepository.listPayments(
    normalizedDomain,
    { caseId, limit: 500 },
  );
  const priorById = new Map(
    priorLedgerRows.map((row) => [Number(row.casePaymentId), row]),
  );

  for (const payment of normalized) {
    const prior = priorById.get(payment.casePaymentId);
    const alreadyPresent = Boolean(prior);
    const priorStatus = String(prior?.transactionStatus || "").toUpperCase();
    const newStatus = String(payment.transactionStatus || "").toUpperCase();

    const ledgerRow = await marketingMoneyService.reconcilePayment(payment.casePaymentId, {
      domain: normalizedDomain,
      caseId: payment.caseId,
      casePaymentId: payment.casePaymentId,
      paymentDate: payment.paymentDate,
      paymentDateKey: payment.paymentDateKey,
      amount: payment.amount,
      paymentType: payment.paymentType,
      transactionStatus: payment.transactionStatus,
      raw: payment.raw,
    });

    if (!alreadyPresent) {
      newLedgerRows += 1;
      // Also update the CaseProfile counters. Only run on SUCCESS
      // transactions — failed/pending don't count toward totalPaid.
      if (newStatus === "SUCCESS") {
        await ensureCurrentCaseProfileForPayment({
          client,
          domain: normalizedDomain,
          caseId: payment.caseId,
          payment,
          logger,
        });
        await caseProfileRepository.applyPaymentToCaseProfile(
          normalizedDomain,
          payment.caseId,
          {
            paymentId: ledgerRow?._id || prior?._id || null,
            amount: payment.amount,
            paidAt: payment.paymentDate,
          },
        );
      }
    } else if (priorStatus === "SUCCESS" && newStatus !== "SUCCESS") {
      // Chargeback / refund / retry-failed: previously-applied payment
      // flipped to non-SUCCESS. Reverse the CaseProfile counters so
      // totalPaid / paymentsCount stay honest for ROI metrics.
      await caseProfileRepository.reversePaymentOnCaseProfile(
        normalizedDomain,
        payment.caseId,
        {
          paymentId: prior?._id || ledgerRow?._id || null,
          amount: Number(prior.amount) || payment.amount,
        },
      );
      reversals += 1;
      logger?.warn?.("payment.reconcile.chargeback_detected", {
        domain: normalizedDomain,
        caseId: payment.caseId,
        casePaymentId: payment.casePaymentId,
        priorStatus,
        newStatus,
        amount: prior.amount,
      });
      // Emit a review item so ops sees the ROI reversal without
      // digging through logs.
      try {
        await reviewQueueRepository.createReviewQueueItem({
          domain: normalizedDomain,
          caseId: payment.caseId,
          sourceService: "payment-reconcile",
          workflow: "hourly-sweep",
          category: "payment-chargeback",
          severity: "warning",
          title: `Payment reversed on case ${payment.caseId}`,
          summary: `$${(Number(prior.amount) || 0).toFixed(2)} flipped from ${priorStatus} to ${newStatus} (CasePaymentID ${payment.casePaymentId})`,
          happenedAt: new Date(),
          payload: {
            casePaymentId: payment.casePaymentId,
            priorStatus,
            newStatus,
            amount: Number(prior.amount) || 0,
            paymentType: payment.paymentType,
          },
          tags: ["payment", "chargeback", "hourly-sweep"],
        });
      } catch (error) {
        logger?.warn?.("payment.reconcile.chargeback_review_failed", {
          domain: normalizedDomain,
          error: error.message,
        });
      }
    }

    // Always flag failures (new or re-observed — carrier re-runs can flip
    // a successful payment to failed on chargeback; we want eyes on that).
    if (
      payment.transactionStatus &&
      payment.transactionStatus.toUpperCase() !== "SUCCESS" &&
      payment.transactionStatus.toUpperCase() !== "PENDING"
    ) {
      flaggedFailures += 1;
      try {
        await reviewQueueRepository.createReviewQueueItem({
          domain: normalizedDomain,
          caseId: payment.caseId,
          sourceService: "payment-reconcile",
          workflow: "hourly-sweep",
          category: "payment-failure",
          severity: "warning",
          title: `Payment ${payment.transactionStatus} on case ${payment.caseId}`,
          summary: `Amount $${payment.amount.toFixed(2)} on ${payment.paymentDateKey} (CasePaymentID ${payment.casePaymentId})`,
          happenedAt: payment.paymentDate,
          payload: {
            casePaymentId: payment.casePaymentId,
            transactionStatus: payment.transactionStatus,
            paymentType: payment.paymentType,
            amount: payment.amount,
          },
          tags: ["payment", "hourly-sweep", payment.transactionStatus.toLowerCase()],
        });
      } catch (error) {
        logger?.warn?.("payment.reconcile.review_item_failed", {
          domain: normalizedDomain,
          caseId: payment.caseId,
          error: error.message,
        });
      }
    }
  }

  // Stamp the checkpoint on the CaseProfile so the round-robin skips
  // this case until the stale cutoff. Done last so a Logics error
  // doesn't freeze the case out (error path returns early above).
  await caseProfileRepository.updateCaseProfile(normalizedDomain, caseId, {
    paymentReconcile: {
      lastCheckedAt: new Date(),
      lastResult: normalized.length > 0 ? "ok" : "no-payments",
    },
  });

  return {
    caseId,
    payments: normalized.length,
    newLedgerRows,
    flaggedFailures,
    reversals,
    error: null,
  };
}

/**
 * Unknown-type healer: ledger rows can arrive through the event-driven
 * writer with `paymentType: "unknown"` and — if their case's round-robin
 * slot never comes up soon — sit unclassified forever, counted in "paid"
 * but never in initials (found live: a $3,200 June initial). The heal is
 * exactly one production reconcile for that case: getCasePayments re-runs
 * the classifier and the upsert $set rewrites the row's type.
 *
 * Returns the caseIds to PREPEND to the round-robin batch. Throttled two
 * ways: capped per run, and only cases whose reconcile checkpoint is >6h
 * old (so a case whose payments are all PENDING — legitimately unknown —
 * doesn't burn a Logics call every hour).
 */
async function findUnknownTypeCaseIds(domain, { limit = 15 } = {}) {
  const { PaymentLedger } = require("../../shared-models/src");
  const normalizedDomain = normalizeDomain(domain);
  const caseIds = await PaymentLedger.distinct("caseId", {
    domain: normalizedDomain,
    $and: [
      { $or: [{ paymentType: "unknown" }, { paymentType: null }] },
      // Only unknowns that LOOK consequential: a success-ish status (any
      // casing — the event writer doesn't normalize) or no status at all.
      // Non-SUCCESS rows (pending/failed/post-dates) are CORRECTLY
      // unclassified — ~1,900 of them live in the ledger and chasing them
      // would burn ~360 Logics calls/day reclassifying nothing.
      { $or: [{ transactionStatus: /^success$/i }, { transactionStatus: null }] },
    ],
  });
  if (!caseIds.length) return [];
  const staleBefore = new Date(Date.now() - 6 * 60 * 60 * 1000);
  const profiles = await caseProfileRepository.listCaseProfilesByCaseIds(
    normalizedDomain,
    caseIds.map(Number).filter(Number.isFinite),
  );
  return profiles
    .filter((p) => {
      const checked = p?.paymentReconcile?.lastCheckedAt;
      return !checked || new Date(checked) < staleBefore;
    })
    .map((p) => Number(p.caseId))
    .slice(0, Math.max(1, limit));
}

/**
 * Round-robin reconcile across one domain. Caller controls cap via
 * `maxCases`; `staleAfterMs` defines how long since last check to
 * consider a case due. Catches per-case errors and continues with the
 * rest of the batch. Unknown-type ledger rows jump the queue (see
 * findUnknownTypeCaseIds above).
 */
async function reconcilePaymentsForDomain({
  domain,
  maxCases = DEFAULT_MAX_CASES_PER_RUN,
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
  lane = "hourly",
  logger = null,
} = {}) {
  const normalizedDomain = normalizeDomain(domain);
  const due = await caseProfileRepository.findCaseProfilesDueForPaymentReconcile(
    normalizedDomain,
    staleAfterMs,
    maxCases,
  );

  // Fresh-case lane: recently created cases re-check every ~2h regardless
  // of the round-robin — new deals close on new cases, and waiting for
  // the wheel meant a same-day payment could go days unseen (2026-07-24).
  const recent = await caseProfileRepository
    .findRecentCaseProfilesForPaymentReconcile(normalizedDomain)
    .catch(() => []);

  // Unknown-type rows first — dedup against the other lanes.
  const unknownCaseIds = await findUnknownTypeCaseIds(normalizedDomain)
    .catch(() => []);
  const dueCaseIds = new Set(due.map((p) => Number(p.caseId)));
  const recentLane = recent.filter((p) => !dueCaseIds.has(Number(p.caseId)));
  for (const p of recentLane) dueCaseIds.add(Number(p.caseId));
  const healCaseIds = unknownCaseIds.filter((id) => !dueCaseIds.has(id));

  const summary = {
    domain: normalizedDomain,
    casesScanned: due.length + recentLane.length + healCaseIds.length,
    recentCaseLane: recentLane.length,
    unknownTypeHeals: healCaseIds.length,
    casesWithPayments: 0,
    newLedgerRows: 0,
    flaggedFailures: 0,
    reversals: 0,
    errors: 0,
    errorDetails: [],
  };
  if (healCaseIds.length) {
    logger?.info?.("payment.reconcile.unknown_type_heal", {
      domain: normalizedDomain,
      caseIds: healCaseIds,
    });
  }

  for (const profile of [...healCaseIds.map((caseId) => ({ caseId })), ...recentLane, ...due]) {
    const caseId = Number(profile.caseId);
    if (!Number.isFinite(caseId)) continue;
    const result = await reconcilePaymentsForCase({
      domain: normalizedDomain,
      caseId,
      lane,
      logger,
    });
    if (result.error) {
      summary.errors += 1;
      summary.errorDetails.push({ caseId, error: result.error });
      continue;
    }
    if (result.payments > 0) summary.casesWithPayments += 1;
    summary.newLedgerRows += result.newLedgerRows;
    summary.flaggedFailures += result.flaggedFailures;
    summary.reversals += result.reversals || 0;
  }

  return summary;
}

module.exports = {
  DEFAULT_MAX_CASES_PER_RUN,
  DEFAULT_STALE_AFTER_MS,
  extractPaymentRows,
  findUnknownTypeCaseIds,
  normalizePaymentRow,
  normalizePaymentRows,
  reconcilePaymentsForCase,
  reconcilePaymentsForDomain,
};
