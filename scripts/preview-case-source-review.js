"use strict";

require("dotenv").config();

const fs = require("fs");
const mongoose = require("mongoose");
const path = require("path");
const { connectMongo, disconnectMongo } = require("../packages/event-core/src");
const { SourceCanonical } = require("../packages/shared-models/src");
const { getSharedConfig } = require("../packages/shared-config/src");
const { createLogicsFacade } = require("../packages/shared-services/src/logicsFacadeService");
const { resolveCanonicalSource } = require("../packages/shared-services/src/sourceCanonicalService");
const { createCallrailClient } = require("../packages/shared-integrations/src/callrailClient");
const {
  caseProfileRepository,
  masterProspectRepository,
  reviewQueueRepository,
} = require("../packages/shared-repositories/src");

const MANUAL_SOURCE_OVERRIDES = {
  TAG: {
    121207: {
      sourceName: "Affordability Pink State",
    },
    261517: {
      sourceName: "Aged Data",
    },
  },
};

function readFlagValue(argv, name) {
  const prefixed = argv.find((arg) => arg.startsWith(`${name}=`));
  if (prefixed) return prefixed.slice(name.length + 1);
  const index = argv.indexOf(name);
  if (index >= 0 && index < argv.length - 1) {
    return argv[index + 1];
  }
  return null;
}

function normalizeDomain(domain) {
  return String(domain || "").trim().toUpperCase() || "TAG";
}

function hasFlag(argv, ...names) {
  return names.some((name) => argv.includes(name));
}

function normalizeDigits(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  return digits.length === 11 && digits.startsWith("1")
    ? digits.slice(1)
    : digits.slice(-10);
}

function parseCaseIds(argv) {
  const explicit = readFlagValue(argv, "--case-ids");
  const values = explicit
    ? explicit.split(",")
    : argv.filter((value) => /^\d+(,\d+)*$/.test(String(value || "").trim()));
  const ids = values
    .flatMap((value) => String(value || "").split(","))
    .map((value) => Number(String(value || "").trim()))
    .filter(Number.isFinite);
  return [...new Set(ids)];
}

function buildOutputPath(domain, caseIds, explicitPath) {
  if (explicitPath) return path.resolve(explicitPath);
  const joined = caseIds.join("-");
  return path.resolve(
    "ops",
    `case-source-review-${String(domain).toLowerCase()}-${joined}.json`,
  );
}

function getManualSourceOverride(domain, caseId) {
  const domainOverrides = MANUAL_SOURCE_OVERRIDES[String(domain || "").toUpperCase()] || {};
  return domainOverrides[Number(caseId)] || null;
}

function buildPhoneCandidates(caseInfo = {}) {
  const labels = [
    ["cellPhone", caseInfo.CellPhone || caseInfo.cellPhone],
    ["homePhone", caseInfo.HomePhone || caseInfo.homePhone],
    ["workPhone", caseInfo.WorkPhone || caseInfo.workPhone],
    ["phone", caseInfo.Phone || caseInfo.phone],
  ];

  const seen = new Set();
  const candidates = [];
  for (const [label, raw] of labels) {
    const normalized = normalizeDigits(raw);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    candidates.push({
      label,
      raw: raw || null,
      normalized,
      e164: `+1${normalized}`,
    });
  }
  return candidates;
}

function buildCaseSummary(caseInfo = {}) {
  return {
    caseId: Number(caseInfo.CaseID || caseInfo.caseId || 0) || null,
    firstName: caseInfo.FirstName || caseInfo.firstName || null,
    lastName: caseInfo.LastName || caseInfo.lastName || null,
    name:
      caseInfo.Name ||
      caseInfo.FullName ||
      [caseInfo.FirstName, caseInfo.LastName].filter(Boolean).join(" ").trim() ||
      null,
    email: caseInfo.Email || caseInfo.email || null,
    cellPhone: caseInfo.CellPhone || caseInfo.cellPhone || null,
    homePhone: caseInfo.HomePhone || caseInfo.homePhone || null,
    workPhone: caseInfo.WorkPhone || caseInfo.workPhone || null,
    address1: caseInfo.Address1 || caseInfo.address1 || null,
    address2: caseInfo.Address2 || caseInfo.address2 || null,
    city: caseInfo.City || caseInfo.city || null,
    state: caseInfo.State || caseInfo.state || null,
    zip: caseInfo.Zip || caseInfo.PostalCode || caseInfo.zip || null,
    statusId: caseInfo.StatusID ?? caseInfo.statusId ?? null,
    sourceId: caseInfo.SourceID ?? caseInfo.sourceId ?? null,
    sourceName: caseInfo.SourceName || caseInfo.sourceName || null,
    createdDate: caseInfo.CreatedDate || caseInfo.createdDate || null,
    saleDate: caseInfo.SaleDate || caseInfo.saleDate || null,
    settlementOfficer:
      caseInfo.SettlementOfficer ||
      caseInfo.SettlementOfficerName ||
      caseInfo.AssignedTo ||
      null,
  };
}

function toIsoOrNull(value) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function deriveStatusCategory(caseSummary, payments = []) {
  if (payments.length > 0) return "client";
  if (caseSummary?.saleDate) return "client";
  return "prospect";
}

function pickNotes(caseInfo = {}) {
  const candidates = [
    caseInfo.Notes,
    caseInfo.notes,
    caseInfo.Note,
    caseInfo.note,
  ];
  for (const value of candidates) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return null;
}

function summarizeActivities(rows = []) {
  return rows.slice(0, 8).map((row) => ({
    activityId: Number(row?.ActivityID) || null,
    activityType: row?.ActivityType || null,
    subject: row?.Subject || null,
    comment: row?.Comment || null,
    createdDate: row?.CreatedDate || null,
    createdBy: row?.CreatedBy || null,
  }));
}

function buildSyntheticContactActivities(
  domain,
  caseId,
  caseSummary,
  callrailMatches = [],
  sourceMeta = {},
) {
  const seen = new Set();
  const rows = [];

  for (const match of callrailMatches) {
    for (const bucket of [match.thisMonth, match.lastMonth]) {
      for (const call of bucket.calls || []) {
        const syntheticId = `callrail:${call.id || `${match.normalized}:${call.startTime || "unknown"}`}`;
        if (seen.has(syntheticId)) continue;
        seen.add(syntheticId);
        rows.push({
          syntheticId,
          provider: "callrail",
          domain,
          caseId,
          telephonySessionId: syntheticId,
          callStartTime: call.startTime || null,
          callEndTime: null,
          durationSec: Number(call.durationSeconds || 0),
          missed: false,
          direction: String(call.direction || "inbound").toLowerCase(),
          phone: match.raw || call.customerPhoneNumber || null,
          normalizedPhone: match.normalized || normalizeDigits(call.customerPhoneNumber),
          contactName: caseSummary.name || null,
          agentName: null,
          sourceCanonicalId: sourceMeta?.sourceCanonicalId || null,
          sourceName: sourceMeta?.sourceName || call.sourceName || null,
          sourceChannel: sourceMeta?.channel || "mail",
          strategy: "callrail",
          confidence: sourceMeta?.sourceCanonicalId ? "high" : "medium",
          status: "resolved",
          resolverActor: "manual",
          resolvedAt: new Date().toISOString(),
          attempts: {
            callrail: call,
          },
        });
      }
    }
  }

  return rows;
}

async function findExistingCallLogActivityIds(domain, phones = []) {
  const digits = phones
    .map((phone) => normalizeDigits(phone?.normalized || phone?.raw || phone))
    .filter(Boolean);
  if (digits.length === 0) return [];

  const patterns = digits.map((digitsValue) => new RegExp(digitsValue));
  const rows = await mongoose.connection
    .collection("controlplanecalllogs")
    .find({
      domain,
      $or: [
        { customerPhoneNormalized: { $in: digits } },
        { customerPhone: { $in: patterns } },
        { dialedNumberNormalized: { $in: digits } },
        { dialedNumber: { $in: patterns } },
        { fromNumberNormalized: { $in: digits } },
        { fromNumber: { $in: patterns } },
        { toNumberNormalized: { $in: digits } },
        { toNumber: { $in: patterns } },
      ],
    })
    .project({ _id: 1 })
    .limit(25)
    .toArray();

  return [...new Set(rows.map((row) => String(row._id)).filter(Boolean))];
}

async function resolveSourceMeta(domain, sourceHints = {}, phones = [], payments = [], manualOverride = null) {
  const preferredSource = String(
    manualOverride?.sourceName ||
    sourceHints?.preferredSource ||
    "",
  ).trim();
  const phoneDigits = phones.map((phone) => phone.normalized).filter(Boolean);
  const trackingNumbers = [];
  for (const match of sourceHints.callrailMatches || []) {
    for (const bucket of [match.thisMonth, match.lastMonth]) {
      for (const call of bucket.calls || []) {
        const tracking = normalizeDigits(call.trackingPhoneNumber);
        if (tracking && !trackingNumbers.includes(tracking)) {
          trackingNumbers.push(tracking);
        }
      }
    }
  }

  const activeMatch =
    (preferredSource
      ? await resolveCanonicalSource({
          domain,
          rawName: preferredSource,
          sourceName: preferredSource,
          internalName: preferredSource,
          trackerName: preferredSource,
          queueName: preferredSource,
          trackingNumber: trackingNumbers[0] || null,
          phone: phoneDigits[0] || null,
        })
      : null) ||
    (trackingNumbers[0]
      ? await resolveCanonicalSource({
          domain,
          trackingNumber: trackingNumbers[0],
        })
      : null);

  let inactiveCandidate = null;
  if (!activeMatch && (preferredSource || trackingNumbers[0])) {
    const orConditions = [];
    if (preferredSource) {
      orConditions.push(
        { internalName: preferredSource },
        { aliases: preferredSource },
      );
    }
    if (trackingNumbers[0]) {
      orConditions.push({ trackingNumbers: trackingNumbers[0] });
    }
    if (orConditions.length > 0) {
      inactiveCandidate = await SourceCanonical.findOne({ $or: orConditions })
        .lean()
        .catch(() => null);
    }
  }

  const firstPayment = payments.find((payment) => payment.paymentType === "initial") || payments[0] || null;
  return {
    sourceName:
      manualOverride?.sourceName ||
      activeMatch?.internalName ||
      preferredSource ||
      sourceHints?.logicsSourceName ||
      null,
    sourceCanonicalId: activeMatch?.doc?._id ? String(activeMatch.doc._id) : null,
    channel:
      activeMatch?.channel ||
      inactiveCandidate?.channel ||
      null,
    matchedBy: activeMatch?.matchedBy || null,
    inactiveCandidate: inactiveCandidate
      ? {
          sourceCanonicalId: String(inactiveCandidate._id),
          internalName: inactiveCandidate.internalName || null,
          active: Boolean(inactiveCandidate.active),
          trackingNumbers: inactiveCandidate.trackingNumbers || [],
        }
      : null,
    needsManualLookup:
      !manualOverride &&
      !activeMatch &&
      Boolean(preferredSource || trackingNumbers[0]),
    manualOverrideApplied: Boolean(manualOverride?.sourceName),
    convertedAt: toIsoOrNull(firstPayment?.paymentDate || firstPayment?.paymentDateKey),
  };
}

function buildDraftCaseProfile({
  domain,
  caseId,
  caseSummary,
  caseInfo,
  existingCaseProfile,
  masterProspect,
  phones,
  payments,
  paymentSummary,
  sourceMeta,
  activityIds,
}) {
  const initialPayment = payments.find((payment) => payment.paymentType === "initial") || null;
  const lastPayment = payments[payments.length - 1] || null;
  const statusCategory = deriveStatusCategory(caseSummary, payments);
  const needsReview = Boolean(sourceMeta?.needsManualLookup || (!sourceMeta?.sourceCanonicalId && sourceMeta?.sourceName));
  const manualLocked = Boolean(sourceMeta?.manualOverrideApplied);

  return {
    domain,
    caseId,
    masterProspectId: masterProspect?._id ? String(masterProspect._id) : existingCaseProfile?.masterProspectId ? String(existingCaseProfile.masterProspectId) : null,
    sourceCanonicalId: sourceMeta?.sourceCanonicalId || existingCaseProfile?.sourceCanonicalId ? String(sourceMeta?.sourceCanonicalId || existingCaseProfile?.sourceCanonicalId || "") : null,
    firstName: caseSummary.firstName || null,
    lastName: caseSummary.lastName || null,
    name: caseSummary.name || null,
    email: caseSummary.email || null,
    primaryPhone: phones[0]?.raw || null,
    normalizedPhones: phones.map((phone) => phone.normalized),
    sourceName: sourceMeta?.sourceName || caseSummary.sourceName || null,
    notes: pickNotes(caseInfo),
    statusId: caseSummary.statusId ?? null,
    lastStatusCheckAt: new Date().toISOString(),
    statusCategory,
    convertedAt:
      sourceMeta?.convertedAt ||
      toIsoOrNull(caseSummary.saleDate) ||
      null,
    caseCreatedDate: toIsoOrNull(caseSummary.createdDate),
    firstPaymentDate: toIsoOrNull(initialPayment?.paymentDate || initialPayment?.paymentDateKey),
    initialPayment: Number(paymentSummary.initialAmount || 0),
    totalPaid: Number(paymentSummary.totalAmount || 0),
    paymentsCount: Number(paymentSummary.totalCount || 0),
    lastPaymentDate: toIsoOrNull(lastPayment?.paymentDate || lastPayment?.paymentDateKey),
    lastPaymentAmount: Number(lastPayment?.amount || 0),
    paymentIds: Array.isArray(existingCaseProfile?.paymentIds)
      ? existingCaseProfile.paymentIds.map((value) => String(value))
      : [],
    contactActivityIds: [
      ...new Set([
        ...(Array.isArray(existingCaseProfile?.contactActivityIds)
          ? existingCaseProfile.contactActivityIds.map((value) => String(value))
          : []),
        ...activityIds,
      ]),
    ],
    attribution: {
      matchedBy:
        sourceMeta?.matchedBy ||
        (manualLocked ? "manual-review" : sourceMeta?.sourceName ? "callrail-review" : null),
      confidence: manualLocked || sourceMeta?.sourceCanonicalId ? "high" : sourceMeta?.sourceName ? "medium" : null,
      lockedManual: manualLocked,
      needsReview: manualLocked ? false : needsReview,
      reviewReason: manualLocked ? null : needsReview ? "source-canonical-review" : null,
      lastResolvedAt: sourceMeta?.sourceName ? new Date().toISOString() : null,
    },
  };
}

function buildPaymentDateKey(rawPaidDate) {
  const raw = String(rawPaidDate || "").trim();
  if (raw.length >= 10) return raw.slice(0, 10);
  const parsed = raw ? new Date(raw) : null;
  return parsed && !Number.isNaN(parsed.getTime())
    ? parsed.toISOString().slice(0, 10)
    : "";
}

function comparePaymentRows(left, right) {
  const leftDate = buildPaymentDateKey(left?.PaidDate);
  const rightDate = buildPaymentDateKey(right?.PaidDate);
  if (leftDate !== rightDate) return leftDate < rightDate ? -1 : 1;
  return (Number(left?.CasePaymentID) || 0) - (Number(right?.CasePaymentID) || 0);
}

function normalizePaymentRows(rows = [], domain) {
  const successful = rows
    .filter(
      (row) =>
        String(row?.TransactionStatus || "").trim().toUpperCase() === "SUCCESS" &&
        row?.PaidDate,
    )
    .sort(comparePaymentRows);

  const paymentTypeById = new Map();
  successful.forEach((row, index) => {
    const id = Number(row?.CasePaymentID);
    if (!Number.isFinite(id) || id <= 0) return;
    paymentTypeById.set(id, index === 0 ? "initial" : "recurring");
  });

  return rows
    .map((row) => {
      const casePaymentId = Number(row?.CasePaymentID);
      if (!Number.isFinite(casePaymentId) || casePaymentId <= 0) return null;
      return {
        domain,
        caseId: Number(row?.CaseID) || null,
        casePaymentId,
        amount: Number(row?.Amount || 0),
        paymentDate: row?.PaidDate || null,
        paymentDateKey: buildPaymentDateKey(row?.PaidDate),
        transactionStatus: row?.TransactionStatus || null,
        paymentType: paymentTypeById.get(casePaymentId) || "unknown",
        comment: row?.Comment || null,
        transactionId: row?.TransactionID || null,
        authorizationCode: row?.AuthorizationCode || null,
        accountUsed: row?.AccountUsed || null,
        createdByUserFullName: row?.CreatedByUserFullName || null,
        raw: row,
      };
    })
    .filter(Boolean);
}

function summarizePayments(payments = []) {
  return payments.reduce(
    (summary, payment) => {
      const amount = Number(payment.amount || 0);
      summary.totalCount += 1;
      summary.totalAmount += amount;
      if (payment.paymentType === "initial") {
        summary.initialCount += 1;
        summary.initialAmount += amount;
      } else if (payment.paymentType === "recurring") {
        summary.recurringCount += 1;
        summary.recurringAmount += amount;
      }
      return summary;
    },
    {
      initialCount: 0,
      initialAmount: 0,
      recurringCount: 0,
      recurringAmount: 0,
      totalCount: 0,
      totalAmount: 0,
    },
  );
}

function mapCallrailCall(call) {
  if (!call) return null;
  return {
    id: call.id || null,
    customerPhoneNumber: call.customer_phone_number || null,
    trackingPhoneNumber:
      call.formatted_tracking_phone_number ||
      call.tracking_phone_number ||
      null,
    sourceName: call.source_name || call.source || null,
    startTime: call.start_time || null,
    durationSeconds: Number(call.duration || 0),
    direction: call.direction || null,
  };
}

async function lookupCallrailByPhone(client, phone) {
  const [thisMonth, lastMonth] = await Promise.all([
    client.lookupInboundCallByPhone(phone, {
      dateRange: "this_month",
      perPage: 5,
    }).catch((error) => ({
      error: error.message,
      calls: [],
      total_records: 0,
    })),
    client.lookupInboundCallByPhone(phone, {
      dateRange: "last_month",
      perPage: 5,
    }).catch((error) => ({
      error: error.message,
      calls: [],
      total_records: 0,
    })),
  ]);

  const thisMonthCalls = Array.isArray(thisMonth.calls) ? thisMonth.calls : [];
  const lastMonthCalls = Array.isArray(lastMonth.calls) ? lastMonth.calls : [];

  return {
    thisMonth: {
      error: thisMonth.error || null,
      totalMatches: Number(thisMonth.total_records || thisMonthCalls.length || 0),
      calls: thisMonthCalls.map(mapCallrailCall),
    },
    lastMonth: {
      error: lastMonth.error || null,
      totalMatches: Number(lastMonth.total_records || lastMonthCalls.length || 0),
      calls: lastMonthCalls.map(mapCallrailCall),
    },
  };
}

function deriveSourceHints(caseSummary, callrailMatches = []) {
  const callrailSources = [];
  for (const match of callrailMatches) {
    for (const bucket of [match.thisMonth, match.lastMonth]) {
      for (const call of bucket.calls || []) {
        const sourceName = String(call.sourceName || "").trim();
        if (sourceName && !callrailSources.includes(sourceName)) {
          callrailSources.push(sourceName);
        }
      }
    }
  }

  return {
    logicsSourceName: caseSummary.sourceName || null,
    callrailSources,
    preferredSource:
      callrailSources[0] ||
      caseSummary.sourceName ||
      null,
  };
}

async function buildCaseReview(domain, caseId, logicsFacade, callrailClient) {
  const [
    caseInfoResult,
    paymentsResult,
    billingSummaryResult,
    activitiesResult,
    caseProfile,
    masterProspect,
  ] = await Promise.all([
    logicsFacade.fetchCaseInfo(caseId),
    logicsFacade.fetchPayments(caseId).catch((error) => ({ error: error.message })),
    logicsFacade.fetchBillingSummary(caseId).catch((error) => ({ error: error.message })),
    logicsFacade.fetchActivities(caseId).catch((error) => ({ error: error.message })),
    caseProfileRepository.findCaseProfile(domain, caseId).catch(() => null),
    masterProspectRepository.findMasterProspect(domain, caseId).catch(() => null),
  ]);

  const caseInfo = caseInfoResult?.ok ? caseInfoResult.data : null;
  const caseSummary = buildCaseSummary(caseInfo || { CaseID: caseId });
  const phones = buildPhoneCandidates(caseInfo || {});
  const payments = Array.isArray(paymentsResult)
    ? normalizePaymentRows(paymentsResult, domain)
    : [];
  const paymentSummary = summarizePayments(payments);
  const activities = Array.isArray(activitiesResult) ? activitiesResult : [];

  const callrailMatches = [];
  for (const phone of phones) {
    callrailMatches.push({
      ...phone,
      ...(await lookupCallrailByPhone(callrailClient, phone.normalized)),
    });
  }

  const sourceHints = deriveSourceHints(caseSummary, callrailMatches);
  const manualSourceOverride = getManualSourceOverride(domain, caseId);
  const activityIds = await findExistingCallLogActivityIds(domain, phones);
  const sourceMeta = await resolveSourceMeta(
    domain,
    { ...sourceHints, callrailMatches },
    phones,
    payments,
    manualSourceOverride,
  );
  const syntheticContactActivities = buildSyntheticContactActivities(
    domain,
    caseId,
    caseSummary,
    callrailMatches,
    sourceMeta,
  );
  const draftCaseProfile = buildDraftCaseProfile({
    domain,
    caseId,
    caseSummary,
    caseInfo,
    existingCaseProfile: caseProfile,
    masterProspect,
    phones,
    payments,
    paymentSummary,
    sourceMeta,
    activityIds,
  });

  return {
    caseId,
    presence: {
      legacyCaseProfile: Boolean(caseProfile),
      masterProspect: Boolean(masterProspect),
    },
    caseSummary,
    phones,
    paymentSummary,
    sourceHints,
    sourceResolution: sourceMeta,
    callrailMatches,
    syntheticContactActivities,
    activitiesPreview: summarizeActivities(activities),
    proposedUpsert: {
      caseProfile: draftCaseProfile,
      paymentLedger: payments.map((payment) => ({
        casePaymentId: payment.casePaymentId,
        caseId: payment.caseId,
        domain: payment.domain,
        amount: payment.amount,
        paymentDateKey: payment.paymentDateKey,
        paymentType: payment.paymentType,
        transactionStatus: payment.transactionStatus,
      })),
      contactActivities: syntheticContactActivities,
      sourceHint: sourceHints.preferredSource,
    },
    raw: {
      caseInfo,
      caseInfoError: caseInfoResult?.ok ? null : caseInfoResult?.error || null,
      payments: Array.isArray(paymentsResult) ? paymentsResult : [],
      paymentsError: Array.isArray(paymentsResult) ? null : paymentsResult?.error || null,
      activities,
      activitiesError: Array.isArray(activitiesResult) ? null : activitiesResult?.error || null,
      billingSummary:
        billingSummaryResult && !billingSummaryResult.error
          ? billingSummaryResult
          : null,
      billingSummaryError:
        billingSummaryResult && billingSummaryResult.error
          ? billingSummaryResult.error
          : null,
    },
  };
}

function requiresManualLookup(caseReview = {}) {
  const sourceMeta = caseReview.sourceResolution || {};
  if (sourceMeta.needsManualLookup) return true;
  return !String(sourceMeta.sourceCanonicalId || "").trim() &&
    !String(sourceMeta.sourceName || "").trim();
}

async function queueManualLookupReviewItem(caseReview = {}) {
  const sourceMeta = caseReview.sourceResolution || {};
  const caseSummary = caseReview.caseSummary || {};
  const phones = Array.isArray(caseReview.phones) ? caseReview.phones : [];
  const phoneSummary = phones
    .map((phone) => `${phone.label}:${phone.raw || phone.normalized || "unknown"}`)
    .join(", ");
  const callrailMatchCount = (Array.isArray(caseReview.callrailMatches) ? caseReview.callrailMatches : [])
    .reduce(
      (sum, match) =>
        sum +
        Number(match?.thisMonth?.totalMatches || 0) +
        Number(match?.lastMonth?.totalMatches || 0),
      0,
    );

  const existing = await reviewQueueRepository.listReviewQueueItems(caseReview.domain, {
    status: "open",
    workflow: "source-backfill",
    category: "source-attribution-manual-lookup",
    caseId: caseReview.caseId,
    limit: 10,
  });
  if (existing.length > 0) {
    return existing[0];
  }

  return reviewQueueRepository.createReviewQueueItem({
    domain: caseReview.domain,
    caseId: Number(caseReview.caseId),
    sourceService: "preview-case-source-review",
    workflow: "source-backfill",
    category: "source-attribution-manual-lookup",
    severity: "warning",
    title: `Manual source lookup needed for case ${caseReview.caseId}`,
    summary:
      sourceMeta.sourceName
        ? `Source hint "${sourceMeta.sourceName}" could not be confidently resolved after checking all Logics phone slots.`
        : "No source could be resolved after checking all Logics phone slots.",
    customerName: caseSummary.name || null,
    primaryPhone: phones[0]?.raw || null,
    sourceName: sourceMeta.sourceName || caseSummary.sourceName || null,
    sourceChannel: sourceMeta.channel || null,
    happenedAt: new Date(),
    tags: ["source-backfill", "manual-lookup"],
    payload: {
      phones,
      phoneSummary,
      callrailMatchCount,
      sourceHints: caseReview.sourceHints || null,
      sourceResolution: sourceMeta,
      callrailMatches: caseReview.callrailMatches || [],
    },
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const domain = normalizeDomain(readFlagValue(argv, "--domain") || "TAG");
  const caseIds = parseCaseIds(argv);
  const out = buildOutputPath(domain, caseIds, readFlagValue(argv, "--out"));
  const queueReviewItems = hasFlag(argv, "--queue-review-items");

  if (caseIds.length === 0) {
    throw new Error("Provide case ids via --case-ids 1,2,3");
  }

  const state = await connectMongo(getSharedConfig());
  if (!state.connected) {
    throw new Error(`Mongo not connected: ${JSON.stringify(state)}`);
  }

  const logicsFacade = createLogicsFacade(domain);
  const callrailClient = createCallrailClient(domain);

  const cases = [];
  for (const caseId of caseIds) {
    cases.push(await buildCaseReview(domain, caseId, logicsFacade, callrailClient));
  }

  const queuedReviewItems = [];
  if (queueReviewItems) {
    for (const caseReview of cases) {
      if (!requiresManualLookup(caseReview)) continue;
      queuedReviewItems.push(await queueManualLookupReviewItem(caseReview));
    }
  }

  const result = {
    domain,
    caseIds,
    generatedAt: new Date().toISOString(),
    cases,
    queuedReviewItems: queuedReviewItems.map((item) => ({
      id: item?._id ? String(item._id) : null,
      caseId: item?.caseId != null ? Number(item.caseId) : null,
      category: item?.category || null,
      title: item?.title || null,
    })),
  };

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(result, null, 2), "utf8");
  console.log(JSON.stringify({
    out,
    caseCount: cases.length,
    queuedReviewItemCount: queuedReviewItems.length,
  }, null, 2));
  await disconnectMongo();
}

main().catch(async (error) => {
  console.error("preview-case-source-review failed:", error.message);
  try {
    await disconnectMongo();
  } catch {
    // best effort
  }
  process.exit(1);
});
