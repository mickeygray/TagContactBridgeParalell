"use strict";

// One-off status-first metrics rescue.
//
// Purpose:
//   Find newly minted clients that call-ledger-first metrics can miss.
//   Instead of starting from calls, pull the newest Logics cases in early
//   deal/client statuses, inspect their payments, then use Parallel's event
//   backlog as attribution evidence.
//
// Default mode is DRY. Use --write to create missing CaseProfile rows
// with $setOnInsert and run the production payment reconciler for eligible
// cases. Attribution writes are intentionally a separate --apply-attribution flag.
//
// Examples:
//   node scripts/status-payment-metrics-rescue.js
//   node scripts/status-payment-metrics-rescue.js --domain TAG --case-limit 200
//   node scripts/status-payment-metrics-rescue.js --write --domain TAG --statuses TAG:210,206
//   node scripts/status-payment-metrics-rescue.js --write --apply-attribution --case-limit 50
//   node scripts/status-payment-metrics-rescue.js --write --all-payment-history --case-limit 50

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const {
  CallLog,
  CaseProfile,
  HourlyJobEvent,
  LeadCadence,
  MasterProspectIndex,
  PaymentLedger,
} = require("../packages/shared-models/src");
const { createLogicsClient } = require("../packages/shared-integrations/src");
const {
  normalizePaymentRows,
  reconcilePaymentsForCase,
} = require("../packages/shared-services/src/paymentReconcileService");
const {
  resolveCanonicalSource,
} = require("../packages/shared-services/src/sourceCanonicalService");
const {
  createCaseProfileIfMissing,
  writeSourceAttribution,
} = require("../packages/shared-repositories/src/caseProfileRepository");

const DEFAULT_DB = process.env.PARALLEL_DB_NAME || process.env.MONGO_DB_NAME || "tagcontactbridge_parallel";
const DEFAULT_STATUS_TARGETS = Object.freeze({
  TAG: [210, 206],      // New Client, Tier 1
  WYNN: [10, 216],      // Services Not Started, Tier 1
});
const DEFAULT_LIMIT_PER_STATUS = 15000;
const DEFAULT_EVENT_LIMIT = 12;
const DEFAULT_CALL_LIMIT = 8;

function argValue(name, fallback = null) {
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value === undefined ? fallback : value;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function normalizeDomain(value) {
  return String(value || "").trim().toUpperCase();
}

function uniqNumbers(values = []) {
  return [...new Set(
    values
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value > 0),
  )];
}

function parseDomains() {
  return String(argValue("--domain", argValue("--domains", "TAG,WYNN")))
    .split(",")
    .map(normalizeDomain)
    .filter(Boolean);
}

function parseStatusTargets(domains) {
  const raw = argValue("--statuses", "");
  const defaults = Object.fromEntries(
    domains.map((domain) => [domain, [...(DEFAULT_STATUS_TARGETS[domain] || [])]]),
  );
  if (!raw) return defaults;

  // Formats:
  //   --statuses TAG:210,206;WYNN:10,216
  //   --statuses 210,206   (applies to every requested domain)
  const text = String(raw).trim();
  if (!text.includes(":")) {
    const ids = uniqNumbers(text.split(","));
    return Object.fromEntries(domains.map((domain) => [domain, ids]));
  }

  const next = { ...defaults };
  for (const part of text.split(/[;|]/)) {
    const [domainRaw, idsRaw] = part.split(":");
    const domain = normalizeDomain(domainRaw);
    if (!domain) continue;
    next[domain] = uniqNumbers(String(idsRaw || "").split(","));
  }
  return next;
}

function todayPacificKey() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function dateWindow(fromKey, toKey) {
  const from = String(fromKey || "2026-06-01");
  const to = String(toKey || todayPacificKey());
  return {
    from,
    to,
    // Pacific reporting day, stored as UTC.
    start: new Date(`${from}T07:00:00.000Z`),
    end: new Date(`${to}T06:59:59.999Z`).getTime() >= new Date(`${from}T07:00:00.000Z`).getTime()
      ? new Date(new Date(`${to}T07:00:00.000Z`).getTime() + 24 * 60 * 60 * 1000 - 1)
      : new Date(`${to}T23:59:59.999Z`),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseLogicsData(payload) {
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
      return raw;
    }
  }
  return raw;
}

function unwrapCaseIds(payload) {
  const data = parseLogicsData(payload);
  const rows = Array.isArray(data) ? data : data ? [data] : [];
  return uniqNumbers(rows.map((value) => {
    if (Number.isFinite(Number(value))) return Number(value);
    if (value && typeof value === "object") {
      return (
        value.CaseID ??
        value.caseId ??
        value.caseID ??
        value.ID ??
        value.Id ??
        value.id
      );
    }
    return null;
  }));
}

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  return digits.length === 11 && digits.startsWith("1")
    ? digits.slice(1)
    : digits.length >= 10
      ? digits.slice(-10)
      : null;
}

function collectPhones(...values) {
  const phones = new Set();
  const visit = (value) => {
    if (!value) return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const phone = normalizePhone(value);
    if (phone) phones.add(phone);
  };
  values.forEach(visit);
  return [...phones];
}

function collectCasePhones(caseInfoData = {}, profile = {}, cadence = {}, prospect = {}) {
  const caseInfo = caseInfoData || {};
  const profileDoc = profile || {};
  const cadenceDoc = cadence || {};
  const prospectDoc = prospect || {};
  return collectPhones(
    caseInfo.CellPhone,
    caseInfo.HomePhone,
    caseInfo.WorkPhone,
    caseInfo.Phone,
    caseInfo.PrimaryPhone,
    caseInfo.ContactPhone,
    profileDoc.primaryPhone,
    profileDoc.homePhone,
    profileDoc.normalizedPhones,
    profileDoc.spouse?.cellPhone,
    profileDoc.spouse?.homePhone,
    cadenceDoc.phone,
    cadenceDoc.primaryPhone,
    cadenceDoc.normalizedPhone,
    prospectDoc.cellPhone,
    prospectDoc.homePhone,
    prospectDoc.workPhone,
    prospectDoc.normalizedPhones,
  );
}

function firstValue(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return value;
    }
  }
  return null;
}

function compact(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(compact);
  if (value && typeof value.toHexString === "function") return value.toHexString();
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, child]) => [key, compact(child)])
      .filter(([, child]) => {
        if (child === null || child === undefined || child === "") return false;
        if (Array.isArray(child) && child.length === 0) return false;
        if (typeof child === "object" && !Array.isArray(child) && Object.keys(child).length === 0) return false;
        return true;
      }),
  );
}

function sourceSignalFromRow(row = {}) {
  const payload = row.payload && typeof row.payload === "object" ? row.payload : {};
  const result = row.result && typeof row.result === "object" ? row.result : {};
  const attempts = row.attempts && typeof row.attempts === "object" ? row.attempts : {};
  const raw = row.raw && typeof row.raw === "object" ? row.raw : {};
  const payloadSnapshot = row.payloadSnapshot && typeof row.payloadSnapshot === "object" ? row.payloadSnapshot : {};
  const sourceName = firstValue(
    row.sourceName,
    row.source,
    payload.sourceName,
    payload.logicsSourceName,
    payload.SourceName,
    payloadSnapshot.sourceName,
    payloadSnapshot.SourceName,
    result.sourceName,
    attempts.sourceName,
    raw.sourceName,
  );
  const sourceId = firstValue(
    row.sourceId,
    row.SourceID,
    row.SourceCampaignID,
    payload.sourceId,
    payload.SourceID,
    payload.sourceID,
    payload.SourceCampaignID,
    payloadSnapshot.sourceId,
    payloadSnapshot.SourceID,
    result.sourceId,
    attempts.sourceId,
  );
  const routeCampaignKey = firstValue(
    row.routeCampaignKey,
    payload.routeCampaignKey,
    payloadSnapshot.routeCampaignKey,
    result.routeCampaignKey,
  );
  const sourceChannel = firstValue(
    row.sourceChannel,
    row.channel,
    payload.sourceChannel,
    payload.channel,
    result.sourceChannel,
  );
  const sourceCanonicalId = firstValue(
    row.sourceCanonicalId,
    payload.sourceCanonicalId,
    result.sourceCanonicalId,
  );
  return {
    sourceName: sourceName || null,
    sourceId: sourceId != null ? Number(sourceId) : null,
    sourceChannel: sourceChannel || null,
    routeCampaignKey: routeCampaignKey || null,
    sourceCanonicalId: sourceCanonicalId ? String(sourceCanonicalId) : null,
  };
}

function paymentSummary(payments = [], window) {
  const success = payments
    .filter((row) => String(row.transactionStatus || "").toUpperCase() === "SUCCESS")
    .sort((left, right) => (
      new Date(left.paymentDate).getTime() - new Date(right.paymentDate).getTime() ||
      Number(left.casePaymentId) - Number(right.casePaymentId)
    ));
  const first = success[0] || null;
  const windowSuccess = success.filter((row) => {
    const time = new Date(row.paymentDate).getTime();
    return time >= window.start.getTime() && time <= window.end.getTime();
  });
  return {
    totalRows: payments.length,
    successRows: success.length,
    windowSuccessRows: windowSuccess.length,
    firstPayment: first
      ? {
          casePaymentId: first.casePaymentId,
          amount: first.amount,
          paymentDate: compact(first.paymentDate),
          paymentDateKey: first.paymentDateKey,
          paymentType: first.paymentType,
        }
      : null,
    windowTotal: windowSuccess.reduce((sum, row) => sum + Number(row.amount || 0), 0),
    windowInitial:
      first && new Date(first.paymentDate).getTime() >= window.start.getTime() &&
      new Date(first.paymentDate).getTime() <= window.end.getTime()
        ? Number(first.amount || 0)
        : 0,
  };
}

function buildCaseProfileSeedFromLogics(caseInfoData = {}, payments = [], statusId = null) {
  const success = payments
    .filter((row) => String(row.transactionStatus || "").toUpperCase() === "SUCCESS")
    .sort((left, right) => (
      new Date(left.paymentDate).getTime() - new Date(right.paymentDate).getTime() ||
      Number(left.casePaymentId) - Number(right.casePaymentId)
    ));
  const firstPayment = success[0] || null;
  const caseCreatedDate = caseInfoData.CreatedDate ? new Date(caseInfoData.CreatedDate) : null;
  const convertedAt = caseInfoData.SaleDate
    ? new Date(caseInfoData.SaleDate)
    : firstPayment?.paymentDate || null;
  const normalizedPhones = collectPhones(
    caseInfoData.CellPhone,
    caseInfoData.HomePhone,
    caseInfoData.WorkPhone,
    caseInfoData.Phone,
    caseInfoData.PrimaryPhone,
    caseInfoData.ContactPhone,
  );
  const firstName = caseInfoData.FirstName || null;
  const lastName = caseInfoData.LastName || null;
  const name =
    [firstName, lastName].filter(Boolean).join(" ").trim() ||
    caseInfoData.FullName ||
    caseInfoData.Name ||
    null;

  return {
    firstName,
    lastName,
    name,
    email: caseInfoData.Email || caseInfoData.EmailAddress || null,
    primaryPhone:
      caseInfoData.CellPhone ||
      caseInfoData.HomePhone ||
      caseInfoData.WorkPhone ||
      caseInfoData.Phone ||
      caseInfoData.PrimaryPhone ||
      null,
    normalizedPhones,
    sourceName: caseInfoData.SourceName || caseInfoData.sourceName || null,
    sourceChannel: caseInfoData.SourceChannel || caseInfoData.sourceChannel || null,
    notes: caseInfoData.Notes || caseInfoData.notes || null,
    statusId:
      caseInfoData.StatusID != null
        ? Number(caseInfoData.StatusID)
        : caseInfoData.Status != null
          ? Number(caseInfoData.Status)
          : statusId != null
            ? Number(statusId)
            : null,
    lastStatusCheckAt: new Date(),
    statusCategory: "client",
    convertedAt:
      convertedAt instanceof Date && !Number.isNaN(convertedAt.getTime())
        ? convertedAt
        : null,
    caseCreatedDate:
      caseCreatedDate instanceof Date && !Number.isNaN(caseCreatedDate.getTime())
        ? caseCreatedDate
        : null,
  };
}

function compareLedger(payments, ledgers) {
  const byPaymentId = new Map(ledgers.map((row) => [Number(row.casePaymentId), row]));
  const inserts = [];
  const updates = [];
  for (const payment of payments) {
    const existing = byPaymentId.get(Number(payment.casePaymentId));
    if (!existing) {
      inserts.push(payment.casePaymentId);
      continue;
    }
    const diffs = [];
    if (Math.abs(Number(existing.amount || 0) - Number(payment.amount || 0)) > 0.004) {
      diffs.push("amount");
    }
    if (String(existing.transactionStatus || "") !== String(payment.transactionStatus || "")) {
      diffs.push("status");
    }
    if (String(existing.paymentType || "") !== String(payment.paymentType || "")) {
      diffs.push("type");
    }
    if (String(existing.paymentDateKey || "") !== String(payment.paymentDateKey || "")) {
      diffs.push("date");
    }
    if (diffs.length) updates.push({ casePaymentId: payment.casePaymentId, diffs });
  }
  return {
    missingLedgerRows: inserts,
    driftedLedgerRows: updates,
  };
}

function profileNeedsPaymentRepair(profile, summary) {
  if (!summary.firstPayment) return false;
  if (!profile) return true;
  if (Number(profile.paymentsCount || 0) < summary.successRows) return true;
  if (Math.abs(Number(profile.initialPayment || 0) - Number(summary.firstPayment.amount || 0)) > 0.004) {
    return true;
  }
  if (!profile.firstPaymentDate) return true;
  const profileKey = new Date(profile.firstPaymentDate).toISOString().slice(0, 10);
  return profileKey !== String(summary.firstPayment.paymentDateKey || "").slice(0, 10);
}

async function fetchStatusCaseIds(domain, statusIds, limitPerStatus) {
  const client = createLogicsClient(domain);
  const byStatus = {};
  const errors = [];
  const ordered = [];
  const seen = new Set();

  for (const statusId of statusIds) {
    let payload = null;
    try {
      payload = await client.getCasesByStatus(statusId);
    } catch (error) {
      const status = error?.details?.responseStatus || null;
      const entry = {
        statusId: Number(statusId),
        status,
        error: error.message,
      };
      byStatus[statusId] = { count: 0, error: entry };
      errors.push(entry);
      console.warn(`[${domain}] status ${statusId} fetch failed: ${error.message}`);
      continue;
    }
    const ids = unwrapCaseIds(payload).slice(0, limitPerStatus);
    byStatus[statusId] = { count: ids.length };
    for (const caseId of ids) {
      if (seen.has(caseId)) continue;
      seen.add(caseId);
      ordered.push({
        domain,
        caseId,
        statusId: Number(statusId),
        statusSource: "logics-get-cases-by-status",
      });
    }
  }
  return { ordered, byStatus, errors };
}

async function collectEvidence(domain, caseId, caseInfoData, window) {
  const normalizedDomain = normalizeDomain(domain);
  const numericCaseId = Number(caseId);
  const dateFilter = {
    $or: [
      { callStartTime: { $gte: window.start, $lte: window.end } },
      { createdAt: { $gte: window.start, $lte: window.end } },
    ],
  };
  const [profile, cadence, prospect, ledgers, caseCalls, events] = await Promise.all([
    CaseProfile.findOne({ domain: normalizedDomain, caseId: numericCaseId }).lean(),
    LeadCadence.findOne({ domain: normalizedDomain, caseId: numericCaseId }).lean(),
    MasterProspectIndex.findOne({ domain: normalizedDomain, caseId: numericCaseId }).lean(),
    PaymentLedger.find({ domain: normalizedDomain, caseId: numericCaseId }).sort({ paymentDate: 1 }).lean(),
    CallLog.find({
      $and: [
        {
          $or: [
            { domain: normalizedDomain, caseId: numericCaseId },
            { caseDomain: normalizedDomain, caseId: numericCaseId },
          ],
        },
        dateFilter,
      ],
    })
      .sort({ callStartTime: -1, createdAt: -1 })
      .limit(DEFAULT_CALL_LIMIT)
      .lean(),
    HourlyJobEvent.find({
      domain: normalizedDomain,
      caseId: numericCaseId,
      createdAt: { $gte: window.start, $lte: window.end },
    })
      .sort({ createdAt: -1 })
      .limit(DEFAULT_EVENT_LIMIT)
      .lean(),
  ]);

  const phoneCandidates = collectCasePhones(caseInfoData, profile, cadence, prospect);
  const phoneCalls = phoneCandidates.length
    ? await CallLog.find({
        domain: normalizedDomain,
        normalizedPhone: { $in: phoneCandidates },
        ...dateFilter,
      })
        .sort({ callStartTime: -1, createdAt: -1 })
        .limit(DEFAULT_CALL_LIMIT)
        .lean()
    : [];

  const callById = new Map();
  for (const call of caseCalls) {
    callById.set(String(call._id), { ...call, evidenceMatch: "case" });
  }
  for (const call of phoneCalls) {
    const key = String(call._id);
    if (callById.has(key)) continue;
    callById.set(key, { ...call, evidenceMatch: "phone" });
  }
  const calls = [...callById.values()];

  const signals = [];
  const pushSignal = (source, row) => {
    const signal = sourceSignalFromRow(row || {});
    if (
      !signal.sourceCanonicalId &&
      !signal.sourceId &&
      !signal.sourceName &&
      !signal.sourceChannel &&
      !signal.routeCampaignKey
    ) {
      return;
    }
    signals.push({ source, ...signal });
  };

  pushSignal("logics.caseInfo", {
    sourceId:
      caseInfoData?.SourceCampaignID ||
      caseInfoData?.CampaignSourceID ||
      caseInfoData?.CampaignID ||
      caseInfoData?.SourceID ||
      caseInfoData?.SourceId,
    sourceName: caseInfoData?.SourceName,
    sourceChannel: caseInfoData?.SourceChannel,
  });
  pushSignal("caseProfile", profile || {});
  pushSignal("leadCadence", cadence || {});
  pushSignal("masterProspect", prospect || {});
  for (const call of calls) {
    pushSignal(`callLog:${call.evidenceMatch || "unknown"}:${call.telephonySessionId || call._id}`, call);
  }
  for (const event of events) pushSignal(`event:${event.eventType || event.handlerKey || event._id}`, event);

  return {
    profile,
    cadence,
    prospect,
    ledgers,
    calls,
    phoneMatchedCalls: phoneCalls.length,
    events,
    signals,
  };
}

async function rankAttributionCandidate(domain, evidence) {
  const currentId = evidence.profile?.sourceCanonicalId
    ? String(evidence.profile.sourceCanonicalId)
    : null;
  if (currentId) {
    return {
      action: "keep-existing",
      confidence: "existing",
      sourceCanonicalId: currentId,
      reason: "CaseProfile already has sourceCanonicalId",
    };
  }

  const rankedSignals = [];
  for (const signal of evidence.signals) {
    let resolved = null;
    if (signal.sourceCanonicalId) {
      resolved = { doc: { _id: signal.sourceCanonicalId }, internalName: signal.sourceName || null, channel: signal.sourceChannel || null, matchedBy: "sourceCanonicalId" };
    } else if (Number.isFinite(Number(signal.sourceId))) {
      resolved = await resolveCanonicalSource({
        domain,
        sourceId: Number(signal.sourceId),
      }).catch(() => null);
    } else if (signal.sourceName) {
      resolved = await resolveCanonicalSource({
        domain,
        sourceName: signal.sourceName,
        rawName: signal.sourceName,
      }).catch(() => null);
    } else if (signal.routeCampaignKey) {
      resolved = await resolveCanonicalSource({
        domain,
        sourceName: signal.routeCampaignKey,
        rawName: signal.routeCampaignKey,
      }).catch(() => null);
    }

    if (!resolved?.doc?._id) continue;
    const priority =
      signal.source === "logics.caseInfo" && Number.isFinite(Number(signal.sourceId)) ? 1 :
        signal.source === "masterProspect" ? 2 :
          signal.source === "leadCadence" ? 3 :
            String(signal.source || "").startsWith("callLog") ? 4 :
              String(signal.source || "").startsWith("event") ? 5 :
                9;
    rankedSignals.push({
      priority,
      signal,
      sourceCanonicalId: String(resolved.doc._id),
      internalName: resolved.internalName || resolved.doc.internalName || signal.sourceName || null,
      channel: resolved.channel || resolved.doc.channel || signal.sourceChannel || null,
      matchedBy: resolved.matchedBy || "unknown",
    });
  }

  if (!rankedSignals.length) {
    return {
      action: "needs-review",
      confidence: "none",
      reason: "No source canonical match from Logics/cadence/calls/events",
      signals: evidence.signals,
    };
  }

  rankedSignals.sort((left, right) => left.priority - right.priority);
  const best = rankedSignals[0];
  const competing = rankedSignals.filter((entry) => entry.sourceCanonicalId !== best.sourceCanonicalId);
  return {
    action: competing.length ? "review-competing-signals" : "candidate",
    confidence: best.priority <= 2 && competing.length === 0 ? "high" : competing.length ? "medium" : "medium",
    reason: competing.length ? "Multiple source candidates found" : "Best available source candidate",
    selected: best,
    competing: competing.slice(0, 5),
    signals: evidence.signals.slice(0, 12),
  };
}

async function maybeWriteMissingCaseProfile({
  domain,
  caseId,
  statusId,
  caseInfoData,
  payments,
  evidence,
  paymentSummary: summary,
  hasEligiblePaymentScope,
  includeAllPaymentHistory,
  write,
}) {
  if (evidence.profile) {
    return {
      skipped: true,
      reason: "already-present",
      caseProfileId: String(evidence.profile._id),
    };
  }

  if ((summary?.successRows || 0) <= 0) {
    return {
      skipped: true,
      reason: "no-successful-payments",
    };
  }

  if (!hasEligiblePaymentScope) {
    return {
      skipped: true,
      reason: "outside-window-payment-history",
      wouldCreateIfAllPaymentHistory: !includeAllPaymentHistory,
    };
  }

  const seed = buildCaseProfileSeedFromLogics(caseInfoData || {}, payments, statusId);
  const seedSummary = compact({
    statusId: seed.statusId,
    sourceName: seed.sourceName,
    sourceChannel: seed.sourceChannel,
    convertedAt: seed.convertedAt,
    caseCreatedDate: seed.caseCreatedDate,
    normalizedPhoneCount: Array.isArray(seed.normalizedPhones) ? seed.normalizedPhones.length : 0,
    hasEmail: Boolean(seed.email),
    hasName: Boolean(seed.name || seed.firstName || seed.lastName),
  });

  if (!write) {
    return {
      skipped: true,
      reason: "dry-run",
      wouldCreate: true,
      seedSummary,
    };
  }

  try {
    const doc = await createCaseProfileIfMissing(domain, caseId, seed);
    return {
      skipped: false,
      created: true,
      caseProfileId: doc?._id ? String(doc._id) : null,
      seedSummary,
    };
  } catch (error) {
    if (error?.code === 11000) {
      const existing = await CaseProfile.findOne({
        domain: normalizeDomain(domain),
        caseId: Number(caseId),
      }).lean();
      return {
        skipped: true,
        reason: "already-present-race",
        caseProfileId: existing?._id ? String(existing._id) : null,
      };
    }
    return {
      skipped: false,
      created: false,
      error: error.message,
      seedSummary,
    };
  }
}

async function inspectCase({
  domain,
  caseId,
  statusId,
  window,
  write,
  applyAttribution,
  includeAllPaymentHistory,
  paceMs,
}) {
  const client = createLogicsClient(domain);
  const row = {
    domain,
    caseId,
    statusId,
    inspectedAt: new Date().toISOString(),
    logics: { ok: false },
    payments: null,
    ledgerDiff: null,
    profileNeedsRepair: false,
    caseProfileWrite: null,
    paymentReconcile: null,
    attribution: null,
    evidenceCounts: null,
    errors: [],
  };

  let caseInfoData = null;
  try {
    const caseInfoPayload = await client.getCaseInfo(caseId);
    caseInfoData = parseLogicsData(caseInfoPayload);
    row.logics = {
      ok: true,
      statusId:
        caseInfoData?.StatusID != null
          ? Number(caseInfoData.StatusID)
          : caseInfoData?.Status != null
            ? Number(caseInfoData.Status)
            : statusId,
      sourceId: firstValue(
        caseInfoData?.SourceCampaignID,
        caseInfoData?.CampaignSourceID,
        caseInfoData?.CampaignID,
        caseInfoData?.SourceID,
        caseInfoData?.SourceId,
      ),
      sourceName: caseInfoData?.SourceName || null,
      saleDate: caseInfoData?.SaleDate || null,
      createdDate: caseInfoData?.CreatedDate || null,
      modifiedDate: caseInfoData?.ModifiedDate || caseInfoData?.LastModifiedDate || null,
    };
  } catch (error) {
    row.errors.push({ step: "caseInfo", error: error.message });
  }

  let payments = [];
  try {
    payments = normalizePaymentRows(await client.getCasePayments(caseId), domain);
    row.payments = paymentSummary(payments, window);
  } catch (error) {
    const status = error?.details?.responseStatus;
    if (status === 404) {
      row.payments = paymentSummary([], window);
    } else {
      row.errors.push({ step: "payments", error: error.message });
      row.payments = paymentSummary([], window);
    }
  }

  const evidence = await collectEvidence(domain, caseId, caseInfoData || {}, window);
  row.evidenceCounts = {
    calls: evidence.calls.length,
    phoneMatchedCalls: evidence.phoneMatchedCalls || 0,
    events: evidence.events.length,
    signals: evidence.signals.length,
    hasCaseProfile: Boolean(evidence.profile),
    hasLeadCadence: Boolean(evidence.cadence),
    hasMasterProspect: Boolean(evidence.prospect),
  };
  row.ledgerDiff = compareLedger(payments, evidence.ledgers || []);
  row.profileNeedsRepair = profileNeedsPaymentRepair(evidence.profile, row.payments);
  row.attribution = await rankAttributionCandidate(domain, evidence);

  const wouldRepairAnyPaymentHistory =
    payments.length > 0 &&
    (
      row.profileNeedsRepair ||
      row.ledgerDiff.missingLedgerRows.length > 0 ||
      row.ledgerDiff.driftedLedgerRows.length > 0
    );
  const hasWindowPayment = (row.payments?.windowSuccessRows || 0) > 0;
  const hasEligiblePaymentScope = includeAllPaymentHistory || hasWindowPayment;
  const shouldReconcile = wouldRepairAnyPaymentHistory && hasEligiblePaymentScope;

  row.caseProfileWrite = await maybeWriteMissingCaseProfile({
    domain,
    caseId,
    statusId,
    caseInfoData,
    payments,
    evidence,
    paymentSummary: row.payments,
    hasEligiblePaymentScope,
    includeAllPaymentHistory,
    write,
  });

  if (write && shouldReconcile) {
    row.paymentReconcile = await reconcilePaymentsForCase({
      domain,
      caseId,
      lane: "nightly",
      logger: console,
    });
  } else {
    row.paymentReconcile = {
      skipped: true,
      reason: !write
        ? "dry-run"
        : !wouldRepairAnyPaymentHistory
          ? "no-payment-repair-needed"
          : "outside-window-payment-history",
      wouldRun: shouldReconcile,
      wouldRunIfAllPaymentHistory:
        !includeAllPaymentHistory && wouldRepairAnyPaymentHistory && !hasWindowPayment,
    };
  }

  if (
    applyAttribution &&
    row.attribution?.selected?.sourceCanonicalId &&
    ["high", "medium"].includes(row.attribution.confidence) &&
    row.attribution.action === "candidate"
  ) {
    row.attribution.write = await writeSourceAttribution(domain, caseId, {
      sourceCanonicalId: row.attribution.selected.sourceCanonicalId,
      matchedBy: `status-payment-metrics-rescue:${row.attribution.selected.signal.source}`,
      confidence: row.attribution.confidence,
      forceMirrorSourceName: true,
    }).catch((error) => ({ ok: false, error: error.message }));
  } else if (applyAttribution) {
    row.attribution.write = {
      skipped: true,
      reason: "not-single-clean-candidate",
    };
  }

  if (paceMs > 0) await sleep(paceMs);
  return row;
}

async function main() {
  const domains = parseDomains();
  const statusTargets = parseStatusTargets(domains);
  const write = hasFlag("--write") || hasFlag("--apply");
  const applyAttribution = hasFlag("--apply-attribution");
  const includeAllPaymentHistory = hasFlag("--all-payment-history");
  const limitPerStatus = Math.max(1, Number(argValue("--limit-per-status", DEFAULT_LIMIT_PER_STATUS)) || DEFAULT_LIMIT_PER_STATUS);
  const caseLimit = Math.max(0, Number(argValue("--case-limit", "0")) || 0);
  const paceMs = Math.max(0, Number(argValue("--pace-ms", "250")) || 0);
  const window = dateWindow(argValue("--from", "2026-06-01"), argValue("--to", todayPacificKey()));
  const outDir = path.resolve(argValue("--out-dir", path.join(__dirname, "..", "runtime", "metric-reconcile")));

  if (!process.env.MONGO_URI) {
    throw new Error("MONGO_URI is required");
  }
  fs.mkdirSync(outDir, { recursive: true });

  await mongoose.connect(process.env.MONGO_URI, { dbName: DEFAULT_DB });

  const report = {
    runId: new Date().toISOString().replace(/[:.]/g, "-"),
    mode: write ? "write" : "dry-run",
    applyAttribution,
    includeAllPaymentHistory,
    window: compact(window),
    statusTargets,
    limitPerStatus,
    caseLimit,
    domains: {},
    summary: {
      casesPulled: 0,
      casesInspected: 0,
      casesWithPayments: 0,
      casesWithWindowPayments: 0,
      paymentReconcileWouldRun: 0,
      paymentReconcileRan: 0,
      nonWindowPaymentRepairCandidates: 0,
      caseProfilesWouldCreate: 0,
      caseProfilesCreated: 0,
      caseProfilesAlreadyPresent: 0,
      caseProfilesSkippedOutsideWindow: 0,
      caseProfileWriteErrors: 0,
      missingProfilesWithPayments: 0,
      attributionCandidates: 0,
      attributionNeedsReview: 0,
      errors: 0,
      statusFetchErrors: 0,
    },
    rows: [],
  };

  for (const domain of domains) {
    const statusIds = statusTargets[domain] || [];
    if (!statusIds.length) {
      report.domains[domain] = { skipped: true, reason: "no-status-targets" };
      continue;
    }

    console.log(`\n=== ${domain} statuses ${statusIds.join(",")} ===`);
    const pulled = await fetchStatusCaseIds(domain, statusIds, limitPerStatus);
    let candidates = pulled.ordered;
    if (caseLimit > 0) candidates = candidates.slice(0, caseLimit);

    report.domains[domain] = {
      byStatus: pulled.byStatus,
      statusErrors: pulled.errors,
      uniqueCaseIds: pulled.ordered.length,
      inspected: candidates.length,
    };
    report.summary.casesPulled += pulled.ordered.length;
    report.summary.statusFetchErrors += pulled.errors.length;

    let index = 0;
    for (const candidate of candidates) {
      index += 1;
      if (index === 1 || index % 25 === 0 || index === candidates.length) {
        console.log(`  [${domain}] inspecting ${index}/${candidates.length}`);
      }
      const row = await inspectCase({
        ...candidate,
        window,
        write,
        applyAttribution,
        includeAllPaymentHistory,
        paceMs,
      });
      report.rows.push(row);
      report.summary.casesInspected += 1;
      if ((row.payments?.successRows || 0) > 0) report.summary.casesWithPayments += 1;
      if ((row.payments?.windowSuccessRows || 0) > 0) report.summary.casesWithWindowPayments += 1;
      if (row.paymentReconcile?.wouldRun) report.summary.paymentReconcileWouldRun += 1;
      if (row.paymentReconcile?.wouldRunIfAllPaymentHistory) {
        report.summary.nonWindowPaymentRepairCandidates += 1;
      }
      if (row.paymentReconcile && !row.paymentReconcile.skipped) report.summary.paymentReconcileRan += 1;
      if (row.caseProfileWrite?.wouldCreate) report.summary.caseProfilesWouldCreate += 1;
      if (row.caseProfileWrite?.created) report.summary.caseProfilesCreated += 1;
      if (["already-present", "already-present-race"].includes(row.caseProfileWrite?.reason)) {
        report.summary.caseProfilesAlreadyPresent += 1;
      }
      if (row.caseProfileWrite?.reason === "outside-window-payment-history") {
        report.summary.caseProfilesSkippedOutsideWindow += 1;
      }
      if (row.caseProfileWrite?.error) report.summary.caseProfileWriteErrors += 1;
      if (row.evidenceCounts?.hasCaseProfile === false && (row.payments?.successRows || 0) > 0) {
        report.summary.missingProfilesWithPayments += 1;
      }
      if (row.attribution?.action === "candidate") report.summary.attributionCandidates += 1;
      if (["needs-review", "review-competing-signals"].includes(row.attribution?.action)) {
        report.summary.attributionNeedsReview += 1;
      }
      report.summary.errors += row.errors.length;
    }
  }

  const reportPath = path.join(outDir, `status-payment-metrics-rescue-${report.runId}.json`);
  fs.writeFileSync(reportPath, `${JSON.stringify(compact(report), null, 2)}\n`);
  console.log("\n=== summary ===");
  console.log(JSON.stringify(report.summary, null, 2));
  console.log(`report: ${reportPath}`);
  if (!write) console.log("DRY RUN - re-run with --write to run payment reconciliation.");
  if (!applyAttribution) console.log("Attribution writes skipped - add --apply-attribution only after reviewing candidates.");

  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error(error.stack || error.message);
  try {
    await mongoose.disconnect();
  } catch {
    // ignore
  }
  process.exit(1);
});
