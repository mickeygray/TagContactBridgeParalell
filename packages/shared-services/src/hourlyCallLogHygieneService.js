"use strict";

const { getSharedConfig } = require("../../shared-config/src");
const { resolveStatus } = require("../../shared-config/src/statusMap");
const {
  CallLog,
} = require("../../shared-models/src");
const {
  callLogRepository,
  caseProfileRepository,
} = require("../../shared-repositories/src");
const {
  promoteOrUpdateFromResolution,
} = require("./caseProfilePromotionService");
const {
  listLegacyContactActivityDocs,
} = require("./legacyContactActivityService");
const {
  createLogicsFacade,
} = require("./logicsFacadeService");
const {
  syncHourlyMetricsForDomain,
} = require("./metricsBackfillService");
const {
  reconcilePaymentsForCase,
} = require("./paymentReconcileService");
const {
  previewCallLedgerForDomain,
} = require("./hourlyCallLedgerPreviewService");
const {
  processCallLogRecording,
  scoreCallLogTranscript,
} = require("./transcriptionScoringService");
const {
  isRecordingArchiveConfigured,
  isTerminalArchiveStatus,
  queueCallRecordingArchiveJob,
} = require("./recordingArchiveService");
const {
  runRingCentralCallLogSweep,
} = require("./ringcentralCallLogSweepService");
const { syncCaseCallRollup } = require("./caseCallRollupService");
const { syncCallLedgerFromCallLog } = require("./callLedgerService");

const DEFAULT_SINCE_MS = 65 * 60 * 1000;
const DEFAULT_LIMIT_PER_DOMAIN = 200;
const DEFAULT_MIN_DURATION_SEC = 180;
const DEFAULT_MAX_CASE_REFRESHES_PER_DOMAIN = 20;
const DEFAULT_MAX_SCORING_PER_DOMAIN = 4;
const DEFAULT_MAX_ARCHIVE_PER_DOMAIN = 50;
const MAX_LIMIT_PER_DOMAIN = 20000;

const TERMINAL_TRANSCRIPTION_STATUSES = new Set(["skipped", "abandoned"]);
const COMPLETED_TRANSCRIPTION_STATUSES = new Set(["completed", "no_transcript"]);
const TRANSCRIPTION_STATUSES = new Set([
  "pending",
  "processing",
  "completed",
  "no_recording",
  "no_transcript",
  "skipped",
  "transcription_failed",
  "download_failed",
  "retrying",
  "abandoned",
  "error",
]);

function normalizeDomain(domain) {
  return String(domain || "").trim().toUpperCase();
}

function normalizeDigits(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  return digits.length === 11 && digits.startsWith("1")
    ? digits.slice(1)
    : digits.slice(-10);
}

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function numberOrDefault(value, fallback) {
  const numeric = toNumber(value);
  return numeric == null ? fallback : numeric;
}

function normalizeDirection(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "inbound" || normalized === "outbound") {
    return normalized;
  }
  return "unknown";
}

function buildPacificDateKey(value) {
  const date = toDate(value);
  if (!date) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function resolveDomains(options = {}) {
  const requested = []
    .concat(options.domain || [])
    .concat(options.domains || [])
    .map(normalizeDomain)
    .filter(Boolean);
  return [...new Set(requested)];
}

function mergePreviewOperations(operations = []) {
  const merged = new Map();
  for (const operation of operations) {
    const sessionId = String(
      operation?.filter?.telephonySessionId ||
        operation?.update?.$set?.telephonySessionId ||
        "",
    ).trim();
    if (!sessionId) continue;

    if (!merged.has(sessionId)) {
      merged.set(sessionId, {
        collection: "CallLog",
        filter: {
          domain: normalizeDomain(operation?.filter?.domain),
          telephonySessionId: sessionId,
        },
        update: { $set: {} },
        meta: {},
      });
    }

    const entry = merged.get(sessionId);
    entry.filter.domain =
      normalizeDomain(operation?.filter?.domain) || entry.filter.domain;
    entry.update.$set = {
      ...entry.update.$set,
      ...(operation?.update?.$set || {}),
    };
    entry.meta = {
      ...entry.meta,
      ...(operation?.meta || {}),
    };
  }
  return merged;
}

function normalizeLegacyTranscriptionStatus(row = {}) {
  const raw = String(row?.transcription?.status || "").trim().toLowerCase();
  if (TRANSCRIPTION_STATUSES.has(raw)) return raw;
  if (String(row?.transcription?.text || "").trim()) return "completed";
  if (String(row?.transcription?.recordingUri || "").trim()) return "completed";
  return null;
}

function cloneCallScore(callScore = null) {
  if (!callScore || typeof callScore !== "object") return null;
  return {
    overall:
      callScore.overall != null ? Number(callScore.overall) : null,
    dimensions: callScore.dimensions || {},
    lead_verdict: callScore.lead_verdict || null,
    summary: callScore.summary || null,
    red_flags: Array.isArray(callScore.red_flags) ? callScore.red_flags : [],
    key_details: callScore.key_details || {},
    scoredAt: callScore.scoredAt ? new Date(callScore.scoredAt) : null,
    scoreError: callScore.scoreError || null,
  };
}

function buildLegacyTranscription(row = {}, existing = null) {
  const existingStatus = String(existing?.status || "").trim().toLowerCase();
  if (existingStatus === "completed" || existing?.text) {
    return existing;
  }

  const status = normalizeLegacyTranscriptionStatus(row);
  if (!status) return existing || null;

  return {
    status,
    text: row?.transcription?.text || null,
    recordingUri: row?.transcription?.recordingUri || null,
    recordingDuration:
      toNumber(row?.transcription?.recordingDuration) ??
      toNumber(row?.durationSeconds),
    transcribedAt:
      toDate(row?.transcription?.transcribedAt) ||
      toDate(row?.updatedAt) ||
      null,
    error: row?.transcription?.error || null,
    source: row?.transcription?.source || "legacy",
    attempts:
      toNumber(existing?.attempts) ??
      toNumber(row?.transcription?.attempts) ??
      0,
  };
}

function buildLegacyCallScore(row = {}, existing = null) {
  if (existing?.overall != null) return existing;
  return cloneCallScore(row?.callScore || null);
}

function deriveLegacyResolution(row = {}) {
  const caseMatch = row.caseMatch || {};
  const caseId = toNumber(row.caseId) ?? toNumber(caseMatch.caseId);
  const caseDomain = normalizeDomain(row.caseDomain || caseMatch.domain || row.company);
  const sourceName = row.sourceName || caseMatch.sourceName || null;
  const sourceChannel = row.sourceChannel || caseMatch.sourceChannel || null;
  const matched =
    String(row.enrichmentStatus || "").trim().toLowerCase() === "matched" ||
    (caseId != null && Boolean(sourceName || sourceChannel));

  return {
    caseId,
    caseDomain: caseDomain || null,
    sourceName,
    sourceChannel,
    confidence: matched ? "medium" : "none",
    status: matched ? "resolved" : "pending-retry",
  };
}

function buildMirroredCallLogPayload({
  domain,
  row,
  patch = null,
  existing = null,
  now = new Date(),
} = {}) {
  const sessionId = String(row?.telephonySessionId || row?.callSessionId || "").trim();
  if (!sessionId) return null;

  const legacyResolution = deriveLegacyResolution(row);
  const updatePatch = patch?.update?.$set || {};
  const startAt = toDate(row.callStartTime || row.createdAt);
  const durationSec = toNumber(row.durationSeconds);
  const endAt =
    toDate(row.callEndTime) ||
    (startAt && durationSec != null
      ? new Date(startAt.getTime() + durationSec * 1000)
      : null);
  const direction = normalizeDirection(row.direction);
  const missed =
    String(row.disposition || "").trim().toLowerCase() === "bad" ||
    durationSec === 0;
  const normalizedPhone = normalizeDigits(row.normalizedPhone || row.phone);
  const transcription = buildLegacyTranscription(row, existing?.transcription || null);
  const callScore = buildLegacyCallScore(row, existing?.callScore || null);
  const resolvedCaseId =
    updatePatch.caseId ??
    existing?.caseId ??
    legacyResolution.caseId ??
    null;
  const resolvedCaseDomain = normalizeDomain(
    updatePatch.caseDomain ||
      existing?.caseDomain ||
      legacyResolution.caseDomain ||
      "",
  );

  const payload = {
    domain: normalizeDomain(domain),
    telephonySessionId: sessionId,
    callSessionId: row.callSessionId ? String(row.callSessionId) : null,
    callStartTime: startAt,
    callEndTime: endAt,
    durationSec,
    missed,
    direction,
    phone: row.phone || null,
    normalizedPhone: normalizedPhone || null,
    contactName: row.contactName || row.caseMatch?.name || null,
    extensionId: row.extensionId ? String(row.extensionId) : null,
    agentName: row.agentName || null,
    caseId: resolvedCaseId,
    caseDomain:
      resolvedCaseId != null
        ? resolvedCaseDomain || normalizeDomain(domain)
        : resolvedCaseDomain || null,
    sourceCanonicalId:
      updatePatch.sourceCanonicalId ||
      existing?.sourceCanonicalId ||
      null,
    sourceName:
      updatePatch.sourceName ||
      existing?.sourceName ||
      legacyResolution.sourceName ||
      null,
    sourceChannel:
      updatePatch.sourceChannel ||
      existing?.sourceChannel ||
      legacyResolution.sourceChannel ||
      null,
    mailPieceKey:
      updatePatch.mailPieceKey ||
      existing?.mailPieceKey ||
      null,
    strategy:
      updatePatch.strategy ||
      existing?.strategy ||
      (legacyResolution.caseId != null ? "legacy" : "none"),
    confidence:
      updatePatch.confidence ||
      existing?.confidence ||
      legacyResolution.confidence,
    status:
      updatePatch.status ||
      existing?.status ||
      legacyResolution.status,
    retryAttempts: toNumber(existing?.retryAttempts) ?? 0,
    lastRetryAt: existing?.lastRetryAt || null,
    resolvedAt:
      updatePatch.resolvedAt ||
      existing?.resolvedAt ||
      (legacyResolution.status === "resolved" ? now : null),
    resolverActor:
      updatePatch.resolverActor ||
      existing?.resolverActor ||
      "import",
    attempts: existing?.attempts || null,
    legsSnapshot:
      Array.isArray(existing?.legsSnapshot) && existing.legsSnapshot.length > 0
        ? existing.legsSnapshot
        : Array.isArray(row.legsSnapshot)
          ? row.legsSnapshot
          : null,
  };

  if (transcription) {
    payload.transcription = transcription;
  }
  if (callScore) {
    payload.callScore = callScore;
  }

  return payload;
}

function summarizeInvoices(invoices = []) {
  const totalAmount = invoices.reduce((sum, invoice) => {
    const unitPrice = Number(invoice.UnitPrice || 0);
    const quantity = Number(invoice.Quantity || 1);
    return sum + unitPrice * quantity;
  }, 0);

  return {
    total: invoices.length,
    totalAmount,
    sample: invoices.slice(0, 5).map((invoice) => ({
      caseInvoiceId: invoice.CaseInvoiceID || null,
      invoiceTypeId: invoice.InvoiceTypeID || null,
      description: invoice.Description || "",
      date: invoice.Date || null,
      unitPrice: Number(invoice.UnitPrice || 0),
      quantity: Number(invoice.Quantity || 1),
    })),
  };
}

function summarizeBillingSummary(summary) {
  if (!summary || typeof summary !== "object") return null;
  return {
    totalFees: Number(summary.TotalFees || 0),
    paidAmount: Number(summary.PaidAmount || 0),
    balance: Number(summary.Balance || 0),
    amountDue: Number(summary.AmountDue || 0),
    dueDate: summary.DueDate || null,
    pastDue: Number(summary.PastDue || 0),
  };
}

function summarizeActivities(activities = []) {
  const sample = activities.slice(0, 5).map((activity) => ({
    activityId: activity.ActivityID || null,
    subject: activity.Subject || "",
    activityType: activity.ActivityType || "",
    createdDate: activity.CreatedDate || activity.ModifiedDate || null,
  }));

  return {
    total: activities.length,
    sample,
  };
}

function summarizePayments(payments = []) {
  const successful = payments
    .map((payment) => ({
      raw: payment,
      amount: Number(payment.Amount || payment.PaymentAmount || 0),
      paymentType: String(payment.PaymentType || payment.Type || "").toLowerCase(),
      paidAt: toDate(payment.PaymentDate || payment.Date),
    }))
    .filter((payment) => Number.isFinite(payment.amount) && payment.amount > 0)
    .sort((left, right) => {
      const leftTime = left.paidAt ? left.paidAt.getTime() : 0;
      const rightTime = right.paidAt ? right.paidAt.getTime() : 0;
      return leftTime - rightTime;
    });

  const initialPayments = successful.filter((payment) =>
    payment.paymentType.includes("initial") || payment.paymentType.includes("first"),
  );
  const firstPayment = successful[0] || null;
  const lastPayment = successful[successful.length - 1] || null;

  return {
    total: payments.length,
    successfulCount: successful.length,
    totalAmount: successful.reduce((sum, payment) => sum + payment.amount, 0),
    initialCount: initialPayments.length,
    initialAmount: initialPayments.reduce((sum, payment) => sum + payment.amount, 0),
    firstPaymentDate: firstPayment?.paidAt || null,
    latestPaymentDate: lastPayment?.paidAt || null,
    lastPaymentAmount: lastPayment?.amount || 0,
  };
}

function buildCaseProfileSeedFromCaseInfo(domain, data = {}, paymentSummary = null) {
  const firstName = String(data.FirstName || "").trim() || null;
  const lastName = String(data.LastName || "").trim() || null;
  const normalizedPhones = [
    normalizeDigits(data.CellPhone),
    normalizeDigits(data.HomePhone),
    normalizeDigits(data.WorkPhone),
  ].filter(Boolean);
  const statusId =
    data.StatusID != null
      ? Number(data.StatusID)
      : data.Status != null
        ? Number(data.Status)
        : null;
  const statusInfo = resolveStatus(domain, statusId);
  const createdDate = toDate(data.CreatedDate);
  const convertedAt = toDate(data.SaleDate) || paymentSummary?.firstPaymentDate || null;

  return {
    firstName,
    lastName,
    name:
      [firstName, lastName].filter(Boolean).join(" ").trim() ||
      String(data.FullName || data.Name || "").trim() ||
      null,
    email: String(data.Email || "").trim() || null,
    primaryPhone:
      String(data.CellPhone || data.HomePhone || data.WorkPhone || "").trim() || null,
    normalizedPhones,
    sourceName: String(data.SourceName || "").trim() || null,
    notes: String(data.Notes || "").trim() || null,
    statusId: Number.isFinite(statusId) ? statusId : null,
    lastStatusCheckAt: new Date(),
    statusCategory:
      statusInfo?.category ||
      (paymentSummary?.successfulCount > 0 ? "client" : "other"),
    caseCreatedDate: createdDate,
    convertedAt,
    totalPaid: paymentSummary?.totalAmount || 0,
    paymentsCount: paymentSummary?.successfulCount || 0,
    initialPayment: paymentSummary?.initialAmount || 0,
    firstPaymentDate: paymentSummary?.firstPaymentDate || null,
    lastPaymentDate: paymentSummary?.latestPaymentDate || null,
    lastPaymentAmount: paymentSummary?.lastPaymentAmount || 0,
  };
}

async function loadCaseProfileSnapshot(domain, caseId) {
  const profiles = await caseProfileRepository.listCaseProfilesByCaseIds(domain, [caseId]);
  return profiles[0] || null;
}

async function refreshTouchedCase({
  domain,
  caseId,
  createProfileFromCaseInfo = false,
  logger = null,
} = {}) {
  const normalizedDomain = normalizeDomain(domain);
  const numericCaseId = Number(caseId);
  const facade = createLogicsFacade(normalizedDomain);
  const paymentResult = await reconcilePaymentsForCase({
    domain: normalizedDomain,
    caseId: numericCaseId,
    logger,
  });

  const summary = {
    domain: normalizedDomain,
    caseId: numericCaseId,
    paymentResult,
    statusRefreshed: false,
    statusChanged: false,
    scrubUpdated: false,
    activitiesUpdated: false,
    paymentsUpdated: false,
    createdProfileFromPayments: false,
    skippedProfileUpdate: false,
    callRollupUpdated: false,
    callRollupError: null,
    previousStatusCategory: null,
    nextStatusCategory: null,
  };

  const [caseInfoResult, activitiesResult, paymentsResult, billingSummaryResult, invoicesResult] =
    await Promise.allSettled([
    facade.fetchCaseInfo(numericCaseId),
    facade.fetchActivities(numericCaseId),
    facade.fetchPayments(numericCaseId),
    facade.fetchBillingSummary(numericCaseId),
    facade.fetchInvoices(numericCaseId),
    ]);

  const caseInfoData =
    caseInfoResult.status === "fulfilled" && caseInfoResult.value?.ok
      ? (caseInfoResult.value.data || {})
      : null;
  const activities =
    activitiesResult.status === "fulfilled"
      ? summarizeActivities(activitiesResult.value)
      : null;
  const paymentSummary =
    paymentsResult.status === "fulfilled"
      ? summarizePayments(paymentsResult.value)
      : null;
  const billingSummary =
    billingSummaryResult.status === "fulfilled"
      ? summarizeBillingSummary(billingSummaryResult.value)
      : null;
  const invoices =
    invoicesResult.status === "fulfilled"
      ? summarizeInvoices(invoicesResult.value)
      : null;

  let existingProfile = await loadCaseProfileSnapshot(normalizedDomain, numericCaseId);
  if (
    !existingProfile &&
    (paymentSummary?.successfulCount > 0 || (createProfileFromCaseInfo && caseInfoData))
  ) {
    const seed = buildCaseProfileSeedFromCaseInfo(
      normalizedDomain,
      caseInfoData || {},
      paymentSummary,
    );
    if (createProfileFromCaseInfo) {
      seed.statusLastChangedAt = new Date();
      seed.lastStatusCheckAt = new Date();
    }
    const seededProfile = await caseProfileRepository.createCaseProfileIfMissing(
      normalizedDomain,
      numericCaseId,
      seed,
    );
    if (seededProfile?._id) {
      summary.createdProfileFromPayments = true;
      existingProfile = seededProfile.toObject ? seededProfile.toObject() : seededProfile;
    }
  }

  if (!existingProfile) {
    summary.skippedProfileUpdate = true;
    return summary;
  }

  const update = {
    lastStatusCheckAt: new Date(),
  };

  if (caseInfoResult.status === "fulfilled" && caseInfoResult.value?.ok) {
    const data = caseInfoData || {};
    const statusId =
      data.StatusID != null
        ? Number(data.StatusID)
        : data.Status != null
          ? Number(data.Status)
          : null;
    const statusInfo = resolveStatus(normalizedDomain, statusId);
    const nextStatusId = Number.isFinite(statusId) ? statusId : null;
    const nextStatusCategory =
      statusInfo?.category || existingProfile.statusCategory || "other";
    update.statusId = nextStatusId;
    update.statusCategory = nextStatusCategory;
    if (String(data.SourceName || "").trim()) {
      update.sourceName = String(data.SourceName).trim();
    }
    if (String(data.Notes || "").trim()) {
      update.notes = String(data.Notes).trim();
    }
    if (data.CreatedDate) {
      const createdDate = toDate(data.CreatedDate);
      if (createdDate) update.caseCreatedDate = createdDate;
    }
    if (data.SaleDate) {
      const convertedAt = toDate(data.SaleDate);
      if (convertedAt) update.convertedAt = convertedAt;
    }
    const previousStatusId =
      existingProfile.statusId != null ? Number(existingProfile.statusId) : null;
    const previousStatusCategory =
      String(existingProfile.statusCategory || "").trim() || null;
    if (previousStatusId !== nextStatusId || previousStatusCategory !== nextStatusCategory) {
      update.previousStatusId = previousStatusId;
      update.previousStatusCategory = previousStatusCategory;
      update.statusLastChangedAt = new Date();
      summary.statusChanged = true;
      summary.previousStatusCategory = previousStatusCategory;
    }
    summary.nextStatusCategory = nextStatusCategory;
    summary.statusRefreshed = true;
  }

  if (paymentSummary) {
    update.totalPaid = paymentSummary.totalAmount || 0;
    update.paymentsCount = paymentSummary.successfulCount || 0;
    update.initialPayment = paymentSummary.initialAmount || 0;
    update.firstPaymentDate = paymentSummary.firstPaymentDate || null;
    update.lastPaymentDate = paymentSummary.latestPaymentDate || null;
    update.lastPaymentAmount = paymentSummary.lastPaymentAmount || 0;
    if (!update.convertedAt && paymentSummary.firstPaymentDate) {
      update.convertedAt = paymentSummary.firstPaymentDate;
    }
    summary.paymentsUpdated = true;
  }

  if (activities || paymentSummary || billingSummary || invoices) {
    const existingScrub = existingProfile.scrubSummary || {};
    update.scrubSummary = {
      ...existingScrub,
      status: existingScrub.status || "completed",
      reviewedAt: new Date(),
      providers: {
        ...(existingScrub.providers || {}),
        activities: activities || existingScrub.providers?.activities || null,
        payments: paymentSummary || existingScrub.providers?.payments || null,
        billingSummary: billingSummary || existingScrub.providers?.billingSummary || null,
        invoices: invoices || existingScrub.providers?.invoices || null,
      },
    };
    summary.activitiesUpdated = Boolean(activities);
    summary.scrubUpdated = true;
  }

  await caseProfileRepository.upsertCaseProfile(
    normalizedDomain,
    numericCaseId,
    update,
  );

  const rollupResult = await syncCaseCallRollup(normalizedDomain, numericCaseId, {
    recentLimit: 5,
  }).catch((error) => ({
    error: error.message,
  }));
  if (!rollupResult?.error && !rollupResult?.skipped) {
    summary.callRollupUpdated = true;
  } else if (rollupResult?.error) {
    summary.callRollupError = rollupResult.error;
  }

  return summary;
}

async function runScoringPassForDomain({
  domain,
  from,
  to,
  minDurationSec = DEFAULT_MIN_DURATION_SEC,
  maxScoringPerDomain = DEFAULT_MAX_SCORING_PER_DOMAIN,
  lane = "hourly",
  logger = null,
} = {}) {
  const normalizedDomain = normalizeDomain(domain);
  const durationFloor = Math.max(numberOrDefault(minDurationSec, DEFAULT_MIN_DURATION_SEC), 0);
  const maxScoring = Math.max(
    numberOrDefault(maxScoringPerDomain, DEFAULT_MAX_SCORING_PER_DOMAIN),
    0,
  );
  const summary = {
    considered: 0,
    processed: 0,
    scoredFromTranscript: 0,
    recordingPipelineCompleted: 0,
    noTranscript: 0,
    noRecording: 0,
    tooEarly: 0,
    skipped: 0,
    failed: 0,
    abandoned: 0,
  };

  const candidates = await CallLog.find({
    domain: normalizedDomain,
    direction: "outbound",
    durationSec: { $gte: durationFloor },
    callStartTime: {
      ...(from ? { $gte: from } : {}),
      ...(to ? { $lte: to } : {}),
    },
  })
    .sort({ callStartTime: -1, createdAt: -1 })
    .limit(Math.max(maxScoring, 1) * 4)
    .lean();

  for (const candidate of candidates) {
    if (summary.processed >= maxScoring) break;
    summary.considered += 1;

    if (candidate?.callScore?.overall != null) {
      summary.skipped += 1;
      continue;
    }

    const transcriptionStatus = String(candidate?.transcription?.status || "").trim().toLowerCase();
    if (TERMINAL_TRANSCRIPTION_STATUSES.has(transcriptionStatus)) {
      summary.skipped += 1;
      continue;
    }

    let result = null;
    try {
      if (String(candidate?.transcription?.text || "").trim()) {
        result = await scoreCallLogTranscript({
          domain: normalizedDomain,
          telephonySessionId: candidate.telephonySessionId,
          logger,
        });
        summary.processed += 1;
        if (result.status === "completed") {
          summary.scoredFromTranscript += 1;
        } else if (result.status === "no_transcript") {
          summary.noTranscript += 1;
        } else {
          summary.skipped += 1;
        }
        continue;
      }

      if (
        transcriptionStatus &&
        COMPLETED_TRANSCRIPTION_STATUSES.has(transcriptionStatus)
      ) {
        summary.skipped += 1;
        continue;
      }

      result = await processCallLogRecording({
        domain: normalizedDomain,
        telephonySessionId: candidate.telephonySessionId,
        lane,
        logger,
      });
      summary.processed += 1;

      switch (result.status) {
        case "completed":
          summary.recordingPipelineCompleted += 1;
          break;
        case "no_recording":
          summary.noRecording += 1;
          break;
        case "no_transcript":
          summary.noTranscript += 1;
          break;
        case "too_early":
          summary.tooEarly += 1;
          break;
        case "abandoned":
          summary.abandoned += 1;
          break;
        case "skipped":
          summary.skipped += 1;
          break;
        default:
          summary.failed += 1;
          break;
      }
    } catch (error) {
      logger?.warn?.("hourly.call_log_hygiene.scoring_failed", {
        domain: normalizedDomain,
        telephonySessionId: candidate.telephonySessionId,
        error: error.message,
      });
      summary.processed += 1;
      summary.failed += 1;
    }
  }

  return summary;
}

async function runArchivePassForDomain({
  domain,
  from,
  to,
  maxArchivePerDomain = DEFAULT_MAX_ARCHIVE_PER_DOMAIN,
  lane = "hourly",
  logger = null,
} = {}) {
  const normalizedDomain = normalizeDomain(domain);
  const maxArchive = Math.max(
    numberOrDefault(maxArchivePerDomain, DEFAULT_MAX_ARCHIVE_PER_DOMAIN),
    0,
  );
  const summary = {
    considered: 0,
    attempted: 0,
    queued: 0,
    deduped: 0,
    skipped: 0,
    failed: 0,
    skipReasons: {},
  };

  if (maxArchive <= 0) {
    return {
      ...summary,
      disabled: true,
      reason: "max-archive-zero",
    };
  }

  if (!isRecordingArchiveConfigured()) {
    return {
      ...summary,
      disabled: true,
      reason: "archive-not-configured",
    };
  }

  const archiveConfig = getSharedConfig().recordingArchive || {};
  const archiveDurationFloor = Math.max(
    numberOrDefault(archiveConfig.minDurationSec, 0),
    0,
  );
  const candidates = await CallLog.find({
    domain: normalizedDomain,
    telephonySessionId: { $nin: [null, ""] },
    missed: { $ne: true },
    durationSec: { $gte: archiveDurationFloor },
    callStartTime: {
      ...(from ? { $gte: from } : {}),
      ...(to ? { $lte: to } : {}),
    },
    "recordingArchive.status": {
      $nin: [
        "completed",
        "no_group_match",
        "skipped",
        "abandoned",
        "pending",
        "processing",
      ],
    },
  })
    .sort({ callStartTime: -1, createdAt: -1 })
    .limit(Math.max(maxArchive, 1) * 4)
    .lean();

  for (const candidate of candidates) {
    if (summary.attempted >= maxArchive) break;
    summary.considered += 1;

    if (isTerminalArchiveStatus(candidate?.recordingArchive?.status)) {
      summary.skipped += 1;
      summary.skipReasons.terminal =
        Number(summary.skipReasons.terminal || 0) + 1;
      continue;
    }

    try {
      const result = await queueCallRecordingArchiveJob(candidate, { lane });
      summary.attempted += 1;
      if (result?.queued) {
        summary.queued += 1;
        if (result.deduped) summary.deduped += 1;
        continue;
      }

      summary.skipped += 1;
      const reason = result?.reason || "not-queued";
      summary.skipReasons[reason] =
        Number(summary.skipReasons[reason] || 0) + 1;
    } catch (error) {
      logger?.warn?.("hourly.call_log_hygiene.archive_queue_failed", {
        domain: normalizedDomain,
        telephonySessionId: candidate.telephonySessionId,
        error: error.message,
      });
      summary.attempted += 1;
      summary.failed += 1;
    }
  }

  return summary;
}

async function runHourlyCallLogHygieneForDomain(domain, options = {}) {
  const normalizedDomain = normalizeDomain(domain);
  const now = options.now ? new Date(options.now) : new Date();
  const sinceMs = Math.max(
    numberOrDefault(options.sinceMs, DEFAULT_SINCE_MS),
    5 * 60 * 1000,
  );
  const limitPerDomain = Math.min(
    Math.max(numberOrDefault(options.limitPerDomain, DEFAULT_LIMIT_PER_DOMAIN), 1),
    MAX_LIMIT_PER_DOMAIN,
  );
  const minDurationSec = Math.max(
    numberOrDefault(options.minDurationSec, DEFAULT_MIN_DURATION_SEC),
    0,
  );
  const maxCaseRefreshesPerDomain = Math.max(
    numberOrDefault(
      options.maxCaseRefreshesPerDomain,
      DEFAULT_MAX_CASE_REFRESHES_PER_DOMAIN,
    ),
    0,
  );
  const maxScoringPerDomain = Math.max(
    numberOrDefault(options.maxScoringPerDomain, DEFAULT_MAX_SCORING_PER_DOMAIN),
    0,
  );
  const maxArchivePerDomain = Math.max(
    numberOrDefault(options.maxArchivePerDomain, DEFAULT_MAX_ARCHIVE_PER_DOMAIN),
    0,
  );
  const syncMetricsDates = options.syncMetricsDates !== false;
  const scorePendingCalls = options.scorePendingCalls !== false;
  const archiveRecordings = options.archiveRecordings !== false;
  const mirrorLegacyContactActivities =
    options.mirrorLegacyContactActivities === true;
  const lane = String(options.lane || "hourly").toLowerCase() === "nightly"
    ? "nightly"
    : "hourly";
  const preferLegacyContactActivities =
    options.preferLegacyContactActivities === true;
  const from = new Date(now.getTime() - sinceMs);

  const summary = {
    domain: normalizedDomain,
    window: {
      from: from.toISOString(),
      to: now.toISOString(),
      sinceMs,
    },
    counts: {
      legacyMirrorEnabled: mirrorLegacyContactActivities,
      legacyRows: 0,
      mirrored: 0,
      patched: 0,
      ledgerSynced: 0,
      ledgerErrors: 0,
      promotions: 0,
      promotionErrors: 0,
      caseRefreshes: 0,
      caseRefreshErrors: 0,
      statusChanges: 0,
      metricsDates: 0,
      metricsErrors: 0,
    },
    previews: {
      inbound: null,
      outbound: null,
    },
    scoring: null,
    archive: null,
    touchedCases: [],
    metrics: [],
    errors: [],
  };

  const [legacyRows, inboundPreview, outboundPreview] = await Promise.all([
    mirrorLegacyContactActivities
      ? listLegacyContactActivityDocs({
          domain: normalizedDomain,
          limit: limitPerDomain,
          from,
          to: now,
        })
      : Promise.resolve([]),
    previewCallLedgerForDomain(normalizedDomain, {
      from,
      to: now,
      limit: limitPerDomain,
      includePending: true,
      direction: "inbound",
    }),
    previewCallLedgerForDomain(normalizedDomain, {
      from,
      to: now,
      limit: limitPerDomain,
      includePending: true,
      direction: "outbound",
    }),
  ]);

  summary.counts.legacyRows = legacyRows.length;
  summary.previews.inbound = inboundPreview.scan;
  summary.previews.outbound = outboundPreview.scan;

  const operationsBySession = mergePreviewOperations([
    ...(Array.isArray(inboundPreview.operations) ? inboundPreview.operations : []),
    ...(Array.isArray(outboundPreview.operations) ? outboundPreview.operations : []),
  ]);

  const sessionIds = legacyRows
    .map((row) => String(row.telephonySessionId || row.callSessionId || "").trim())
    .filter(Boolean);
  const existingDocs = sessionIds.length
    ? await CallLog.find({
        domain: normalizedDomain,
        telephonySessionId: { $in: sessionIds },
      }).lean()
    : [];
  const existingBySession = new Map(
    existingDocs.map((doc) => [String(doc.telephonySessionId), doc]),
  );

  const touchedCases = new Map();
  const metricDates = new Set();

  for (const row of legacyRows) {
    const sessionId = String(row.telephonySessionId || row.callSessionId || "").trim();
    if (!sessionId) continue;
    const patch = operationsBySession.get(sessionId) || null;
    const existing = existingBySession.get(sessionId) || null;
    const payload = buildMirroredCallLogPayload({
      domain: normalizedDomain,
      row,
      patch,
      existing,
      now,
    });
    if (!payload) continue;

    // Stamp platform="ex" only on insert — RC native call sweep is the
    // default-EX source. If a CX disposition has already stamped this
    // row "cx" (via cxWorkspaceService.upsertCallLog), $setOnInsert
    // won't fire and the "cx" value is preserved.
    const upserted = await callLogRepository.upsertCallLog({
      ...payload,
      setOnInsert: { platform: "ex" },
    });
    existingBySession.set(sessionId, upserted);
    summary.counts.mirrored += 1;
    if (patch) summary.counts.patched += 1;
    try {
      const ledgerResult = await syncCallLedgerFromCallLog(upserted, { syncedAt: now });
      if (!ledgerResult?.skipped) {
        summary.counts.ledgerSynced += 1;
      }
    } catch (error) {
      summary.counts.ledgerErrors += 1;
      summary.errors.push({
        type: "ledger",
        telephonySessionId: sessionId,
        error: error.message,
      });
    }

    if (upserted?.caseId != null && upserted?.sourceCanonicalId) {
      try {
        const promotion = await promoteOrUpdateFromResolution({
          domain: normalizeDomain(upserted.caseDomain || normalizedDomain),
          caseId: Number(upserted.caseId),
          caseDomain: normalizeDomain(upserted.caseDomain || normalizedDomain),
          telephonySessionId: upserted.telephonySessionId,
          callLogId: upserted._id,
          sourceCanonicalId: upserted.sourceCanonicalId,
          strategy: upserted.strategy || null,
          confidence: upserted.confidence || null,
          customerPhone: upserted.phone || null,
          contactName: upserted.contactName || null,
          caseCreatedDate: upserted.caseCreatedDateAtResolve || null,
          logger: options.logger || null,
        });
        if (!promotion?.skipped) {
          summary.counts.promotions += 1;
        }
      } catch (error) {
        summary.counts.promotionErrors += 1;
        summary.errors.push({
          type: "promotion",
          telephonySessionId: sessionId,
          error: error.message,
        });
      }
    }

    const touchedDate = buildPacificDateKey(row.callStartTime || row.createdAt);
    if (touchedDate) metricDates.add(touchedDate);

    const caseDomain = normalizeDomain(upserted?.caseDomain || payload.caseDomain || normalizedDomain);
    const caseId = Number(upserted?.caseId ?? payload.caseId);
    const durationSec = Number(upserted?.durationSec ?? payload.durationSec ?? 0);
    if (Number.isFinite(caseId) && caseId > 0 && durationSec >= minDurationSec) {
      touchedCases.set(`${caseDomain}:${caseId}`, {
        domain: caseDomain,
        caseId,
        telephonySessionId: sessionId,
      });
    }
  }

  const casesToRefresh = [...touchedCases.values()].slice(0, maxCaseRefreshesPerDomain);
  for (const item of casesToRefresh) {
    try {
      const result = await refreshTouchedCase({
        domain: item.domain,
        caseId: item.caseId,
        logger: options.logger || null,
      });
      summary.touchedCases.push(result);
      summary.counts.caseRefreshes += 1;
      if (result?.statusChanged) {
        summary.counts.statusChanges += 1;
      }
    } catch (error) {
      summary.counts.caseRefreshErrors += 1;
      summary.errors.push({
        type: "case-refresh",
        domain: item.domain,
        caseId: item.caseId,
        error: error.message,
      });
    }
  }

  if (syncMetricsDates) {
    for (const dateKey of [...metricDates].sort()) {
      try {
        const result = await syncHourlyMetricsForDomain({
          domain: normalizedDomain,
          date: dateKey,
          preferLegacyContactActivities,
        });
        summary.metrics.push({
          date: dateKey,
          ok: true,
          result,
        });
        summary.counts.metricsDates += 1;
      } catch (error) {
        summary.metrics.push({
          date: dateKey,
          ok: false,
          error: error.message,
        });
        summary.counts.metricsErrors += 1;
      }
    }
  }

  if (scorePendingCalls && maxScoringPerDomain > 0) {
    summary.scoring = await runScoringPassForDomain({
      domain: normalizedDomain,
      from,
      to: now,
      minDurationSec,
      maxScoringPerDomain,
      lane,
      logger: options.logger || null,
    });
  } else {
    summary.scoring = {
      considered: 0,
      processed: 0,
      skipped: 0,
      disabled: true,
    };
  }

  if (archiveRecordings) {
    summary.archive = await runArchivePassForDomain({
      domain: normalizedDomain,
      from,
      to: now,
      maxArchivePerDomain,
      lane,
      logger: options.logger || null,
    });
  } else {
    summary.archive = {
      considered: 0,
      attempted: 0,
      queued: 0,
      skipped: 0,
      failed: 0,
      disabled: true,
      reason: "disabled",
    };
  }

  return summary;
}

async function runHourlyCallLogHygiene(options = {}) {
  const domains = resolveDomains(options);
  const results = [];
  const nativeSweepEnabled = options.nativeSweepEnabled !== false;
  let nativeSweep = {
    enabled: false,
    skipped: true,
    reason: "disabled",
  };
  const totals = {
    domains: domains.length,
    nativeScanned: 0,
    nativeProcessed: 0,
    nativeInserted: 0,
    nativeResolved: 0,
    nativeSkipped: 0,
    nativeErrors: 0,
    legacyRows: 0,
    mirrored: 0,
    patched: 0,
    promotions: 0,
    promotionErrors: 0,
    caseRefreshes: 0,
    caseRefreshErrors: 0,
    statusChanges: 0,
    metricsDates: 0,
    metricsErrors: 0,
    scoringProcessed: 0,
    scoringCompleted: 0,
    scoringFailed: 0,
    archiveAttempted: 0,
    archiveQueued: 0,
    archiveDeduped: 0,
    archiveSkipped: 0,
    archiveFailed: 0,
  };

  if (nativeSweepEnabled) {
    nativeSweep = await runRingCentralCallLogSweep({
      sinceMs: options.sinceMs,
      limit:
        options.nativeSweepLimit ||
        Math.min(Math.max(Number(options.limitPerDomain) || DEFAULT_LIMIT_PER_DOMAIN, 1) * Math.max(domains.length, 1), 2000),
      maxPages: options.nativeSweepMaxPages,
      defaultDomain: options.nativeSweepDefaultDomain,
      resolverActor: options.lane === "nightly" ? "reconcile" : "reconcile",
      logger: options.logger || null,
    });
    totals.nativeScanned = Number(nativeSweep.scanned || 0);
    totals.nativeProcessed = Number(nativeSweep.processed || 0);
    totals.nativeInserted = Number(nativeSweep.inserted || 0);
    totals.nativeResolved = Number(nativeSweep.resolved || 0);
    totals.nativeSkipped = Number(nativeSweep.skipped || 0);
    totals.nativeErrors = Number(nativeSweep.errors || 0);
  }

  for (const domain of domains) {
    try {
      const result = await runHourlyCallLogHygieneForDomain(domain, options);
      totals.legacyRows += Number(result.counts.legacyRows || 0);
      totals.mirrored += Number(result.counts.mirrored || 0);
      totals.patched += Number(result.counts.patched || 0);
      totals.promotions += Number(result.counts.promotions || 0);
      totals.promotionErrors += Number(result.counts.promotionErrors || 0);
      totals.caseRefreshes += Number(result.counts.caseRefreshes || 0);
      totals.caseRefreshErrors += Number(result.counts.caseRefreshErrors || 0);
      totals.statusChanges += Number(result.counts.statusChanges || 0);
      totals.metricsDates += Number(result.counts.metricsDates || 0);
      totals.metricsErrors += Number(result.counts.metricsErrors || 0);
      totals.scoringProcessed += Number(result.scoring?.processed || 0);
      totals.scoringCompleted +=
        Number(result.scoring?.recordingPipelineCompleted || 0) +
        Number(result.scoring?.scoredFromTranscript || 0);
      totals.scoringFailed += Number(result.scoring?.failed || 0);
      totals.archiveAttempted += Number(result.archive?.attempted || 0);
      totals.archiveQueued += Number(result.archive?.queued || 0);
      totals.archiveDeduped += Number(result.archive?.deduped || 0);
      totals.archiveSkipped += Number(result.archive?.skipped || 0);
      totals.archiveFailed += Number(result.archive?.failed || 0);
      results.push({
        domain,
        ok: true,
        result,
      });
    } catch (error) {
      results.push({
        domain,
        ok: false,
        error: error.message,
      });
    }
  }

  return {
    ranAt: new Date().toISOString(),
    nativeSweep,
    domains: results,
    totals,
  };
}

module.exports = {
  refreshTouchedCase,
  runHourlyCallLogHygiene,
  runHourlyCallLogHygieneForDomain,
};
