"use strict";

const { PaymentLedger, SourceCanonical } = require("../../shared-models/src");

function buildPaymentDateRangeQuery(filters = {}) {
  if (filters.date) {
    return { paymentDateKey: String(filters.date) };
  }

  const range = {};
  if (filters.from) range.$gte = String(filters.from);
  if (filters.to) range.$lte = String(filters.to);
  return Object.keys(range).length > 0 ? { paymentDateKey: range } : {};
}

async function upsertPaymentLedger(casePaymentId, update = {}) {
  return reconcilePaymentLedger(casePaymentId, update);
}

async function reconcilePaymentLedger(casePaymentId, update = {}) {
  return PaymentLedger.findOneAndUpdate(
    { casePaymentId: Number(casePaymentId) },
    { $set: {
      ...update,
      authoritativeSource: "logics-reconcile",
      authoritativeAt: new Date(),
    } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );
}

async function observePaymentLedger(casePaymentId, observation = {}) {
  const now = new Date();
  return PaymentLedger.findOneAndUpdate(
    { casePaymentId: Number(casePaymentId) },
    {
      $set: { lastObservedAt: now },
      $setOnInsert: {
        ...observation,
        casePaymentId: Number(casePaymentId),
        transactionStatus: observation.transactionStatus || null,
        authoritativeSource: "event-observation",
        authoritativeAt: null,
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );
}

async function listPaymentsForCase(domain, caseId) {
  return PaymentLedger.find({
    domain: String(domain || "").toUpperCase(),
    caseId: Number(caseId),
  })
    .sort({ paymentDate: 1, casePaymentId: 1 })
    .lean();
}

async function listPayments(domain, filters = {}) {
  const query = {
    domain: String(domain || "").toUpperCase(),
  };

  if (filters.caseId != null) query.caseId = Number(filters.caseId);
  if (filters.transactionStatus) query.transactionStatus = filters.transactionStatus;
  if (filters.sourceCanonicalId) query.sourceCanonicalId = filters.sourceCanonicalId;

  const limit = Math.min(Number(filters.limit) || 50, 200);
  return PaymentLedger.find(query)
    .sort({ paymentDate: -1, casePaymentId: -1 })
    .limit(limit)
    .lean();
}

async function listPaymentsByDateRange(domain, filters = {}) {
  const query = {
    domain: String(domain || "").toUpperCase(),
    ...buildPaymentDateRangeQuery(filters),
  };

  if (filters.caseId != null) query.caseId = Number(filters.caseId);
  if (filters.transactionStatus) query.transactionStatus = filters.transactionStatus;
  if (filters.sourceCanonicalId) query.sourceCanonicalId = filters.sourceCanonicalId;

  const limit = Math.min(Number(filters.limit) || 10000, 20000);
  return PaymentLedger.find(query)
    .sort({ paymentDate: -1, casePaymentId: -1 })
    .limit(limit)
    .lean();
}

async function countPayments(domain, filters = {}) {
  const query = {
    domain: String(domain || "").toUpperCase(),
  };

  if (filters.caseId != null) query.caseId = Number(filters.caseId);
  if (filters.transactionStatus) query.transactionStatus = filters.transactionStatus;
  if (filters.sourceCanonicalId) query.sourceCanonicalId = filters.sourceCanonicalId;

  return PaymentLedger.countDocuments(query);
}

/**
 * Propagate a CaseProfile attribution change to every PaymentLedger row
 * for the same case. Called from the canonical writer
 * (`caseProfileRepository.writeSourceAttribution`) when sourceCanonicalId
 * changes.
 *
 * Without this sync, ROI aggregators that read `PaymentLedger.sourceCanonicalId`
 * directly (e.g. `summarizeSuccessfulPaymentsBySource` above, line ~91 with the
 * $lookup on sourceCanonicalId) keep reading the case's prior attribution even
 * after a rescue / manual change. Symptom: metrics show right "Paid" via
 * one path and stale "Initials" via another — the divergence we hit when
 * mail catch-alls were re-attributed via CallRail tracker rescue.
 *
 * Behavior:
 *   - Idempotent: a $set with the same value is a no-op write.
 *   - Atomic per row, but not transactional across rows. If new payments
 *     for the case land mid-update, they pick up the latest sourceCanonicalId
 *     anyway when they're written by paymentReconcileService.
 *   - Doesn't touch any other field. Channel caching on PaymentLedger
 *     deliberately deferred — aggregators that need channel can $lookup
 *     SourceCanonical the same way `summarizeSuccessfulPaymentsBySource`
 *     does today.
 *   - Gated by env. Default ON; set
 *     SOURCE_ATTRIBUTION_LEDGER_SYNC_ENABLED=false for emergency rollback.
 *
 * Returns `{ matched, modified, skipped }`. `skipped` is true when the
 * env gate is off — caller should treat that as "fine, do nothing."
 */
/**
 * Extract a usable canonical id from whatever the caller passed. The
 * writer in caseProfileRepository hands us the full canonical doc
 * (lean object with `_id`), while the smoke script and other callers
 * pass a bare string/ObjectId. Both are valid — normalize here.
 *
 * Returns `null` to signal "clear attribution" (caller passed null
 * explicitly).
 */
function resolveSourceCanonicalId(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  // ObjectId or anything with a stringifying _id — Mongoose ObjectIds
  // stringify to their hex via toString(); plain objects fall through
  // to the _id check below.
  if (typeof value === "object") {
    if (value._id !== undefined && value._id !== null) {
      return String(value._id);
    }
    if (typeof value.toHexString === "function") {
      return value.toHexString();
    }
    // Last resort — coerce to string. Avoids "[object Object]" by
    // checking for that case explicitly.
    const coerced = String(value);
    return coerced && coerced !== "[object Object]" ? coerced : null;
  }
  return String(value);
}

async function syncPaymentLedgerSourceForCase(domain, caseId, sourceCanonicalIdOrDoc, options = {}) {
  if (
    String(process.env.SOURCE_ATTRIBUTION_LEDGER_SYNC_ENABLED || "true")
      .trim()
      .toLowerCase() === "false"
  ) {
    return { matched: 0, modified: 0, skipped: true };
  }

  const normalizedDomain = String(domain || "").trim().toUpperCase();
  const numericCaseId = Number(caseId);
  if (!normalizedDomain || !Number.isFinite(numericCaseId)) {
    return { matched: 0, modified: 0, skipped: true, reason: "invalid-key" };
  }

  const sourceCanonicalId = resolveSourceCanonicalId(sourceCanonicalIdOrDoc);

  // Filter intentionally excludes rows already on the target canonical so
  // `modified` reflects only actual writes — useful for telemetry and the
  // dry-run smoke script. The (domain, caseId, paymentDate) compound index
  // (PaymentLedger.js line 50) makes this prefix-bound.
  const filter = {
    domain: normalizedDomain,
    caseId: numericCaseId,
  };
  if (sourceCanonicalId) {
    filter.$or = [
      { sourceCanonicalId: { $exists: false } },
      { sourceCanonicalId: null },
      { sourceCanonicalId: { $ne: sourceCanonicalId } },
    ];
  } else {
    // Caller is clearing attribution. Only touch rows currently having a
    // value to set; rows already null stay null.
    filter.sourceCanonicalId = { $exists: true, $ne: null };
  }

  const update = sourceCanonicalId
    ? { $set: { sourceCanonicalId } }
    : { $set: { sourceCanonicalId: null } };

  const result = await PaymentLedger.updateMany(filter, update);
  return {
    matched: Number(result.matchedCount || 0),
    modified: Number(result.modifiedCount || 0),
    skipped: false,
  };
}

async function summarizeSuccessfulPaymentsBySource(domain, filters = {}) {
  const normalizedDomain = String(domain || "").toUpperCase();
  const query = {
    domain: normalizedDomain,
    transactionStatus: "SUCCESS",
    ...buildPaymentDateRangeQuery(filters),
  };

  return PaymentLedger.aggregate([
    { $match: query },
    {
      $lookup: {
        from: SourceCanonical.collection.name,
        localField: "sourceCanonicalId",
        foreignField: "_id",
        as: "sourceCanonical",
      },
    },
    {
      $unwind: {
        path: "$sourceCanonical",
        preserveNullAndEmptyArrays: true,
      },
    },
    {
      $addFields: {
        metricSourceName: {
          $ifNull: [
            "$sourceCanonical.internalName",
            {
              $ifNull: [
                "$raw.sourceName",
                {
                  $ifNull: ["$raw.internalName", "Unknown"],
                },
              ],
            },
          ],
        },
        metricSourceChannel: {
          $ifNull: [
            "$sourceCanonical.channel",
            {
              $ifNull: ["$raw.sourceChannel", null],
            },
          ],
        },
      },
    },
    {
      $group: {
        _id: {
          source: "$metricSourceName",
          channel: "$metricSourceChannel",
        },
        payments: { $sum: { $ifNull: ["$amount", 0] } },
        initialPayments: {
          $sum: {
            $cond: [{ $eq: ["$paymentType", "initial"] }, { $ifNull: ["$amount", 0] }, 0],
          },
        },
        initialPaymentCount: {
          $sum: {
            $cond: [{ $eq: ["$paymentType", "initial"] }, 1, 0],
          },
        },
        latestPaymentDate: { $max: "$paymentDate" },
      },
    },
    {
      $addFields: {
        paymentCount: "$initialPaymentCount",
      },
    },
    {
      $sort: {
        payments: -1,
        "_id.source": 1,
      },
    },
  ]);
}

module.exports = {
  countPayments,
  observePaymentLedger,
  reconcilePaymentLedger,
  listPayments,
  listPaymentsByDateRange,
  listPaymentsForCase,
  summarizeSuccessfulPaymentsBySource,
  syncPaymentLedgerSourceForCase,
  upsertPaymentLedger,
};
