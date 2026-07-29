"use strict";

const {
  CaseProfile,
  PaymentLedger,
  ReviewQueueItem,
} = require("../../shared-models/src");
const {
  caseProfileRepository,
  masterProspectRepository,
  paymentLedgerRepository,
} = require("../../shared-repositories/src");
const {
  findCanonicalResolution,
} = require("./metricsAttributionReviewService");
const { listActiveSourceCanonicals } = require("./sourceCanonicalService");
const {
  attributePaymentsToSaleWindow,
  casePaymentKey,
  isInitialPayment,
  isMissingDealSource,
  isSuccessfulPayment,
  rawCsvDealSource,
  resolveDealSource,
} = require("./simpleDealMathService");

const REVIEW_WORKFLOW = "attribution-review";
const REVIEW_CATEGORY = "metrics-source";
const REVIEW_KIND = "payment-exception";
const REVIEW_SOURCE_SERVICE = "simple-payment-metrics";
const STATUS_OPEN = "open";
const STATUS_RESOLVED = "reviewed";
const ALLOWED_TREATMENTS = new Set([
  "count-one-deal",
  "chargeback-pair",
  "chargeback-reversal",
  "source-override",
]);
const ALLOWED_REPORTING_BUCKETS = new Set(["Aged"]);

function requiredTreatmentForReasons(reasons = []) {
  const normalized = [...new Set(
    (Array.isArray(reasons) ? reasons : [])
      .map((reason) => normalizeText(reason))
      .filter(Boolean),
  )];
  const substantive = normalized.filter((reason) => reason !== "missing_source");
  if (substantive.length === 0 && normalized.includes("missing_source")) {
    return "source-override";
  }
  if (substantive.length !== 1) return null;
  return {
    multiple_positive_initials: "count-one-deal",
    offsetting_initial_chargeback: "chargeback-pair",
    negative_initial_payment: "chargeback-reversal",
  }[substantive[0]] || null;
}

function normalizeDomain(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizeText(value) {
  return String(value || "").trim();
}

function amountToCents(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new TypeError("Payment amount must be finite");
  }
  return Math.round(number * 100);
}

function centsToAmount(value) {
  return Number((Number(value || 0) / 100).toFixed(2));
}

function paymentReviewKey(domain, caseId) {
  return `${REVIEW_KIND}|${casePaymentKey(domain, caseId)}`;
}

function profileMapKey(domain, caseId) {
  return casePaymentKey(domain, caseId);
}

function buildProfileMap(profiles = []) {
  return new Map(
    (Array.isArray(profiles) ? profiles : []).map((profile) => [
      profileMapKey(profile.domain, profile.caseId),
      profile,
    ]),
  );
}

function sameTreatment(rows = []) {
  if (rows.length === 0) return null;
  const treatments = rows.map((row) => row.metricsTreatment || null);
  if (treatments.some((value) => !value?.kind || !value?.groupKey)) return null;
  const first = treatments[0];
  const same = treatments.every(
    (value) =>
      value.kind === first.kind &&
      value.groupKey === first.groupKey &&
      (value.reportingBucket || null) === (first.reportingBucket || null),
  );
  return same ? first : null;
}

function buildPaymentExceptionCandidates(payments = [], profiles = []) {
  const profilesByKey = buildProfileMap(profiles);
  const groups = new Map();

  for (const payment of Array.isArray(payments) ? payments : []) {
    if (String(payment.transactionStatus || "").trim().toUpperCase() !== "SUCCESS") {
      continue;
    }
    const domain = normalizeDomain(payment.domain);
    const caseId = Number(payment.caseId);
    const casePaymentId = Number(payment.casePaymentId);
    if (!domain || !Number.isFinite(caseId) || !Number.isFinite(casePaymentId)) {
      continue;
    }

    const key = casePaymentKey(domain, caseId);
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        domain,
        caseId,
        rows: [],
        totalCents: 0,
        initialCents: 0,
        positiveInitialCount: 0,
        negativeInitialCount: 0,
        positiveInitialDays: new Set(),
      });
    }
    const group = groups.get(key);
    const amountCents = amountToCents(payment.amount);
    group.rows.push(payment);
    group.totalCents += amountCents;
    if (String(payment.paymentType || "").trim().toLowerCase() === "initial") {
      group.initialCents += amountCents;
      if (amountCents > 0) {
        group.positiveInitialCount += 1;
        if (payment.paymentDateKey) {
          group.positiveInitialDays.add(String(payment.paymentDateKey));
        }
      }
      if (amountCents < 0) group.negativeInitialCount += 1;
    }
  }

  const candidates = [];
  for (const group of groups.values()) {
    const profile = profilesByKey.get(group.key) || null;
    const treatment = sameTreatment(group.rows);
    const treatmentBucket = normalizeText(treatment?.reportingBucket);
    const paymentSource = group.rows
      .map(rawCsvDealSource)
      .find((value) => !isMissingDealSource(value));
    const source = resolveDealSource({
      manualSource: treatmentBucket,
      profileSource: profile?.sourceName,
      paymentSource,
    });
    const reasons = [];
    // Same-day split tender (one initial across two cards) is normal and
    // must not become an operator task — see simpleDealMathService.
    // Suppress ONLY on proof of a single day; unknown dates still flag.
    if (group.positiveInitialCount > 1 && group.positiveInitialDays.size !== 1) {
      reasons.push("multiple_positive_initials");
    }
    if (group.positiveInitialCount > 0 && group.negativeInitialCount > 0) {
      reasons.push(
        group.initialCents === 0
          ? "offsetting_initial_chargeback"
          : "partial_initial_chargeback",
      );
    } else if (group.negativeInitialCount > 0) {
      reasons.push("negative_initial_payment");
    }
    // A fully offset chargeback contributes neither money nor a deal, so a
    // CallRail/source match is not required to report it accurately.
    if (source.missing && group.initialCents !== 0) {
      reasons.push("missing_source");
    }
    if (reasons.length === 0) continue;

    const paymentIds = group.rows
      .map((row) => Number(row.casePaymentId))
      .filter(Number.isFinite)
      .sort((left, right) => left - right);
    const requiredTreatment = requiredTreatmentForReasons(reasons);
    const treatmentCoversRows = Boolean(
      treatment &&
      treatment.groupKey === group.key &&
      requiredTreatment &&
      treatment.kind === requiredTreatment &&
      (!reasons.includes("missing_source") || !source.missing),
    );

    candidates.push({
      reviewKey: paymentReviewKey(group.domain, group.caseId),
      kind: REVIEW_KIND,
      domain: group.domain,
      caseId: group.caseId,
      paymentIds,
      reasons,
      positiveInitialCount: group.positiveInitialCount,
      negativeInitialCount: group.negativeInitialCount,
      initialAmount: centsToAmount(group.initialCents),
      totalAmount: centsToAmount(group.totalCents),
      sourceName: source.sourceName,
      sourceMissing: source.missing,
      currentTreatment: treatment?.kind || null,
      currentReportingBucket: treatment?.reportingBucket || null,
      treatmentCoversRows,
    });
  }

  return candidates.sort((left, right) => {
    const domainCompare = left.domain.localeCompare(right.domain);
    return domainCompare || left.caseId - right.caseId;
  });
}

function summarizeReasons(reasons = []) {
  const labels = {
    multiple_positive_initials: "multiple successful initial payments",
    offsetting_initial_chargeback: "fully offset initial chargeback",
    partial_initial_chargeback: "partial initial chargeback",
    negative_initial_payment: "negative initial payment",
    missing_source: "missing specific source",
  };
  return reasons.map((reason) => labels[reason] || reason).join(", ");
}

function buildReviewPayload(candidate, existingPayload = null, window = {}) {
  return {
    reviewKey: candidate.reviewKey,
    kind: REVIEW_KIND,
    raw: {
      source: candidate.sourceName || "Unknown",
      channel: null,
      caseId: candidate.caseId,
      casePaymentId: candidate.paymentIds[0] || null,
    },
    observed: {
      totalCollected: candidate.totalAmount,
      initialPayments: candidate.initialAmount,
      initialPaymentCount: candidate.positiveInitialCount,
    },
    paymentException: {
      from: normalizeText(window.from) || null,
      to: normalizeText(window.to) || null,
      reasons: candidate.reasons,
      paymentIds: candidate.paymentIds,
      positiveInitialCount: candidate.positiveInitialCount,
      negativeInitialCount: candidate.negativeInitialCount,
      initialAmount: candidate.initialAmount,
      totalAmount: candidate.totalAmount,
      currentTreatment: candidate.currentTreatment,
      currentReportingBucket: candidate.currentReportingBucket,
    },
    resolution: existingPayload?.resolution || null,
    lastSeenAt: new Date().toISOString(),
  };
}

function countReasons(candidates = []) {
  const byReason = {};
  for (const candidate of candidates) {
    for (const reason of candidate.reasons) {
      byReason[reason] = Number(byReason[reason] || 0) + 1;
    }
  }
  return byReason;
}

async function scanPaymentMetricsExceptions({
  domains = [],
  from,
  to,
  dryRun = false,
} = {}) {
  const normalizedDomains = [...new Set(
    (Array.isArray(domains) ? domains : [domains])
      .map(normalizeDomain)
      .filter(Boolean),
  )];
  if (normalizedDomains.length === 0) {
    throw new Error("scanPaymentMetricsExceptions requires at least one domain");
  }
  if (!from || !to) {
    throw new Error("scanPaymentMetricsExceptions requires from and to date keys");
  }

  /**
   * Re-window the scan by chargeback attribution: drop reversals belonging to
   * an earlier month, and pull in later reversals of deals sold in this one.
   */
  async function attributeScanWindow({ windowPayments, domains, from: windowFrom, to: windowTo }) {
    const laterInitials = await PaymentLedger.find({
      domain: { $in: domains },
      paymentDateKey: { $gt: windowTo },
      transactionStatus: "SUCCESS",
      paymentType: "initial",
    })
      .select(PAYMENT_FIELDS)
      .lean();

    const initialRows = [
      ...windowPayments.filter(
        (row) => isSuccessfulPayment(row) && isInitialPayment(row),
      ),
      ...laterInitials,
    ];
    if (initialRows.length === 0) return windowPayments;

    const firstInitials = await PaymentLedger.find({
      $or: [...new Map(
        initialRows.map((row) => [
          casePaymentKey(row.domain, row.caseId),
          { domain: normalizeDomain(row.domain), caseId: Number(row.caseId) },
        ]),
      ).values()],
      transactionStatus: "SUCCESS",
      paymentType: "initial",
      amount: { $gt: 0 },
    })
      .select("domain caseId paymentDateKey")
      .lean();

    const firstInitialDateByCase = new Map();
    for (const row of firstInitials) {
      const key = casePaymentKey(row.domain, row.caseId);
      const current = firstInitialDateByCase.get(key);
      if (!current || String(row.paymentDateKey) < current) {
        firstInitialDateByCase.set(key, String(row.paymentDateKey));
      }
    }
    return attributePaymentsToSaleWindow({
      rows: [...windowPayments, ...laterInitials],
      firstInitialDateByCase,
      from: windowFrom,
      to: windowTo,
    }).rows;
  }

  const PAYMENT_FIELDS =
    "domain caseId casePaymentId paymentDate paymentDateKey amount paymentType " +
    "transactionStatus raw metricsTreatment";

  const windowPayments = await PaymentLedger.find({
    domain: { $in: normalizedDomains },
    paymentDateKey: { $gte: String(from), $lte: String(to) },
    transactionStatus: "SUCCESS",
  })
    .select(PAYMENT_FIELDS)
    .lean();

  // The scanner must window payments the same way the board does, or it
  // raises reviews the metrics already answered. Chargebacks attribute to
  // the month of the SALE (see simpleDealMathService), so a reversal of an
  // earlier month's deal is NOT this window's exception — it is scanned and
  // resolved in the month that booked the deal, where it sits beside its
  // original and reads as a clean offsetting pair needing no source.
  const payments = await attributeScanWindow({
    windowPayments,
    domains: normalizedDomains,
    from: String(from),
    to: String(to),
  });

  const casePairs = [...new Set(
    payments.map((row) => `${normalizeDomain(row.domain)}:${Number(row.caseId)}`),
  )].map((value) => {
    const separator = value.indexOf(":");
    return {
      domain: value.slice(0, separator),
      caseId: Number(value.slice(separator + 1)),
    };
  });
  const profiles = casePairs.length > 0
    ? await CaseProfile.find({ $or: casePairs })
      .select("domain caseId sourceName sourceChannel sourceCanonicalId")
      .lean()
    : [];
  const candidates = buildPaymentExceptionCandidates(payments, profiles);
  const summary = {
    dryRun: Boolean(dryRun),
    from: String(from),
    to: String(to),
    domains: normalizedDomains,
    scannedPayments: payments.length,
    exceptionCases: candidates.length,
    alreadyTreated: candidates.filter((row) => row.treatmentCoversRows).length,
    byReason: countReasons(candidates),
    queued: 0,
    reopened: 0,
    retainedResolved: 0,
  };
  if (dryRun || candidates.length === 0) return summary;

  const reviewKeys = candidates.map((candidate) => candidate.reviewKey);
  const existing = await ReviewQueueItem.find({
    workflow: REVIEW_WORKFLOW,
    category: REVIEW_CATEGORY,
    "payload.reviewKey": { $in: reviewKeys },
  }).lean();
  const existingByKey = new Map(
    existing.map((doc) => [String(doc.payload?.reviewKey || ""), doc]),
  );
  const operations = [];

  for (const candidate of candidates) {
    const existingDoc = existingByKey.get(candidate.reviewKey) || null;
    const payload = buildReviewPayload(candidate, existingDoc?.payload, { from, to });
    const update = {
      $set: {
        title: `Payment metrics review · Case ${candidate.caseId}`,
        summary: `${summarizeReasons(candidate.reasons)} · review treatment and reporting source`,
        sourceName: candidate.sourceName || "Unknown",
        sourceChannel: null,
        caseId: candidate.caseId,
        happenedAt: new Date(`${to}T12:00:00.000Z`),
        payload,
        tags: ["metrics", "payments", "attribution", REVIEW_KIND],
      },
      $setOnInsert: {
        domain: candidate.domain,
        sourceService: REVIEW_SOURCE_SERVICE,
        workflow: REVIEW_WORKFLOW,
        category: REVIEW_CATEGORY,
        severity: "warning",
        status: STATUS_OPEN,
      },
    };
    if (existingDoc?.status === STATUS_RESOLVED && !candidate.treatmentCoversRows) {
      payload.resolution = null;
      update.$set.status = STATUS_OPEN;
      update.$set.resolvedAt = null;
      update.$set.resolutionNote = null;
      summary.reopened += 1;
    } else if (existingDoc?.status === STATUS_RESOLVED) {
      summary.retainedResolved += 1;
    } else {
      summary.queued += 1;
    }
    operations.push({
      updateOne: {
        filter: {
          domain: candidate.domain,
          workflow: REVIEW_WORKFLOW,
          category: REVIEW_CATEGORY,
          "payload.reviewKey": candidate.reviewKey,
        },
        update,
        upsert: true,
      },
    });
  }

  await ReviewQueueItem.bulkWrite(operations, { ordered: false });
  return summary;
}

function validatePaymentTreatment(input, facts) {
  const treatmentKind = normalizeText(input?.treatmentKind);
  if (!ALLOWED_TREATMENTS.has(treatmentKind)) {
    const error = new Error("A valid payment metrics treatment is required");
    error.status = 400;
    throw error;
  }
  const requiredTreatment = requiredTreatmentForReasons(facts?.reasons);
  if (!requiredTreatment) {
    const error = new Error("This payment exception shape requires a new review scan");
    error.status = 409;
    throw error;
  }
  if (treatmentKind !== requiredTreatment) {
    const error = new Error(
      `This payment exception requires the ${requiredTreatment} treatment`,
    );
    error.status = 400;
    throw error;
  }
  const reportingBucket = normalizeText(input?.reportingBucket) || null;
  if (reportingBucket && !ALLOWED_REPORTING_BUCKETS.has(reportingBucket)) {
    const error = new Error("Unsupported reporting bucket");
    error.status = 400;
    throw error;
  }
  const resolvedSource = normalizeText(input?.resolvedSource) || null;
  if (reportingBucket && resolvedSource) {
    const error = new Error("Choose either a canonical source or a reporting bucket");
    error.status = 400;
    throw error;
  }
  if (treatmentKind === "count-one-deal" && facts.positiveInitialCount < 2) {
    const error = new Error("Count-one-deal requires multiple positive initial payments");
    error.status = 400;
    throw error;
  }
  if (
    treatmentKind === "chargeback-pair" &&
    !(
      facts.positiveInitialCount > 0 &&
      facts.negativeInitialCount > 0 &&
      facts.initialCents === 0
    )
  ) {
    const error = new Error("Chargeback-pair requires fully offset positive and negative initials");
    error.status = 400;
    throw error;
  }
  if (
    treatmentKind === "chargeback-reversal" &&
    !(facts.negativeInitialCount > 0 && facts.initialCents < 0)
  ) {
    const error = new Error(
      "Chargeback-reversal requires at least one net-negative initial payment",
    );
    error.status = 400;
    throw error;
  }
  if (treatmentKind === "source-override" && !reportingBucket && !resolvedSource) {
    const error = new Error("Source-override requires a canonical source or reporting bucket");
    error.status = 400;
    throw error;
  }
  if (
    facts.reasons.includes("missing_source") &&
    treatmentKind !== "chargeback-pair" &&
    !reportingBucket &&
    !resolvedSource
  ) {
    const error = new Error("This payment exception also requires a reporting source");
    error.status = 400;
    throw error;
  }
  return { treatmentKind, reportingBucket, resolvedSource };
}

async function resolveMetricsPaymentReviewItem(id, input = {}, actor = {}) {
  const doc = await ReviewQueueItem.findById(id);
  if (!doc || doc.payload?.kind !== REVIEW_KIND) {
    const error = new Error("Payment metrics review item not found");
    error.status = 404;
    throw error;
  }
  const paymentIds = [...new Set(
    (doc.payload?.paymentException?.paymentIds || [])
      .map(Number)
      .filter(Number.isFinite),
  )].sort((left, right) => left - right);
  const domain = normalizeDomain(doc.domain);
  const caseId = Number(doc.payload?.raw?.caseId ?? doc.caseId);
  const reviewFrom = normalizeText(doc.payload?.paymentException?.from);
  const reviewTo = normalizeText(doc.payload?.paymentException?.to);
  const validWindow = /^\d{4}-\d{2}-\d{2}$/.test(reviewFrom) &&
    /^\d{4}-\d{2}-\d{2}$/.test(reviewTo) &&
    reviewFrom <= reviewTo;
  if (
    paymentIds.length === 0 || !domain || !Number.isFinite(caseId) || !validWindow
  ) {
    const error = new Error("Payment metrics review item has no exact ledger identity");
    error.status = 409;
    throw error;
  }
  const rows = await PaymentLedger.find({
    domain,
    caseId,
    paymentDateKey: { $gte: reviewFrom, $lte: reviewTo },
    transactionStatus: "SUCCESS",
  })
    .select("casePaymentId amount paymentType")
    .lean();
  const currentPaymentIds = [...new Set(
    rows.map((row) => Number(row.casePaymentId)).filter(Number.isFinite),
  )].sort((left, right) => left - right);
  const identityChanged = currentPaymentIds.length !== paymentIds.length ||
    currentPaymentIds.some((value, index) => value !== paymentIds[index]);
  if (identityChanged) {
    const error = new Error("Payment ledger changed; rescan this review item");
    error.status = 409;
    throw error;
  }

  const facts = rows.reduce(
    (sum, row) => {
      if (String(row.paymentType || "").toLowerCase() !== "initial") return sum;
      const cents = amountToCents(row.amount);
      sum.initialCents += cents;
      if (cents > 0) sum.positiveInitialCount += 1;
      if (cents < 0) sum.negativeInitialCount += 1;
      return sum;
    },
    {
      positiveInitialCount: 0,
      negativeInitialCount: 0,
      initialCents: 0,
      reasons: doc.payload?.paymentException?.reasons || [],
    },
  );
  const treatment = validatePaymentTreatment(input, facts);

  let canonical = null;
  if (treatment.resolvedSource) {
    canonical = findCanonicalResolution(
      await listActiveSourceCanonicals(domain),
      treatment.resolvedSource,
      input.resolvedChannel || null,
    );
    if (!canonical?._id) {
      const error = new Error("Resolved source must match one active canonical source");
      error.status = 400;
      throw error;
    }
    await Promise.all([
      caseProfileRepository.writeSourceAttribution(domain, caseId, {
        sourceCanonicalId: canonical._id,
        matchedBy: "metrics-payment-review",
        confidence: "manual",
        lockedManual: true,
        allowOverwriteLocked: true,
        forceMirrorSourceName: true,
      }),
      masterProspectRepository.upsertMasterProspect(domain, caseId, {
        sourceCanonicalId: canonical._id,
        needsSourceRefresh: false,
      }),
    ]);
  }

  const resolvedAt = new Date();
  const note = normalizeText(input.note) || null;
  const metricsTreatment = {
    kind: treatment.treatmentKind,
    groupKey: casePaymentKey(domain, caseId),
    reportingBucket: treatment.reportingBucket,
    resolvedAt,
    resolvedBy: normalizeText(actor.email) || null,
    note,
  };
  const treatmentWrites = await Promise.all(
    paymentIds.map((casePaymentId) =>
      paymentLedgerRepository.setPaymentLedgerMetricsTreatment(
        casePaymentId,
        metricsTreatment,
      ),
    ),
  );
  if (treatmentWrites.some((row) => !row)) {
    const error = new Error("Payment treatment did not match every reviewed ledger row");
    error.status = 409;
    throw error;
  }

  const payload = {
    ...(doc.payload || {}),
    resolution: {
      treatmentKind: treatment.treatmentKind,
      source: canonical?.internalName || treatment.resolvedSource,
      channel: canonical?.channel || input.resolvedChannel || null,
      reportingBucket: treatment.reportingBucket,
      note,
      resolvedByEmail: normalizeText(actor.email) || null,
      resolvedAt: resolvedAt.toISOString(),
    },
  };
  const updated = await ReviewQueueItem.findByIdAndUpdate(
    id,
    {
      $set: {
        status: STATUS_RESOLVED,
        resolvedAt,
        resolutionNote: note,
        payload,
      },
    },
    { new: true },
  ).lean();

  return {
    id: String(updated._id),
    status: updated.status,
    treatedPayments: paymentIds.length,
    treatment: payload.resolution,
  };
}

module.exports = {
  ALLOWED_REPORTING_BUCKETS,
  ALLOWED_TREATMENTS,
  REVIEW_KIND,
  buildPaymentExceptionCandidates,
  paymentReviewKey,
  resolveMetricsPaymentReviewItem,
  scanPaymentMetricsExceptions,
  validatePaymentTreatment,
};
