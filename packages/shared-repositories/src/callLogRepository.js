"use strict";

const mongoose = require("mongoose");
const { CallLog } = require("../../shared-models/src");
const { legacyReadDb } = require("./legacyReadDb");

// ── Legacy-collection fallback path ──────────────────────────────────
//
// Runtime call reads now prefer ControlPlaneCallLog. The old
// `rb_contactactivities` collection is kept behind explicit fallback flags
// while we verify cutover/backfill coverage. Field deltas vs. our parallel
// CallLog schema:
//   • tenant key:   `company` (legacy) vs `domain` (parallel)
//   • direction:    "Outbound"/"Inbound" (capitalized) vs lowercase
//   • status:       not present — legacy uses `enrichmentStatus`
//                   ("matched"/"unmatched"/"pending"). Parallel
//                   resolver fields (status, confidence, sourceCanonicalId,
//                   resolvedAt) are missing on legacy rows.
//
// We swap CX-facing reads (case history + recent calls). Resolver-loop
// queries (findLatestResolvedByPhone, listPendingRetries) keep reading
// from parallel — they need fields legacy doesn't carry.
function legacyContactActivitiesCollection() {
  return legacyReadDb(mongoose).collection("rb_contactactivities");
}

function boolFromEnv(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function legacyReadsEnabledByDefault() {
  return boolFromEnv(process.env.CALL_LOG_LEGACY_READS_ENABLED, false);
}

function includeLegacyReads(filters = {}) {
  if (filters.includeLegacy !== undefined) return Boolean(filters.includeLegacy);
  return legacyReadsEnabledByDefault();
}

function normalizeLegacyContactActivity(doc) {
  if (!doc) return null;
  const company = doc.company || doc.domain || null;
  const phone = doc.phone || doc.phoneFormatted || null;
  const digits = phone ? String(phone).replace(/\D/g, "") : "";
  const normalized = digits.length >= 10 ? digits.slice(-10) : null;
  const direction = doc.direction
    ? String(doc.direction).toLowerCase()
    : null;
  return {
    ...doc,
    domain: company ? String(company).toUpperCase() : null,
    direction,
    normalizedPhone: doc.normalizedPhone || normalized,
  };
}

function normalizeCurrentCallLog(doc, legacyDoc = null) {
  if (!doc && !legacyDoc) return null;
  const merged = {
    ...(legacyDoc || {}),
    ...(doc || {}),
  };
  const direction = merged.direction
    ? String(merged.direction).toLowerCase()
    : null;
  const phone = merged.phone || merged.fromNumber || merged.toNumber || null;
  const normalized = phone ? normalizeDigits(phone) : "";
  const normalizedDoc = {
    ...merged,
    domain: normalizeDomain(merged.domain || merged.company),
    direction,
    normalizedPhone: merged.normalizedPhone || normalized || null,
  };

  if (!normalizedDoc.fromNumber && direction === "inbound" && phone) {
    normalizedDoc.fromNumber = phone;
  }
  if (!normalizedDoc.toNumber && direction === "outbound" && phone) {
    normalizedDoc.toNumber = phone;
  }

  return normalizedDoc;
}

function normalizeDomain(domain) {
  return String(domain || "").toUpperCase();
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

/**
 * Upsert by (domain, telephonySessionId). Resolver may re-run against the
 * same session (live → retry sweep → end-of-day recheck), and we want a
 * single row that accumulates attribution rather than fanning out duplicates.
 */
async function upsertCallLog({ domain, telephonySessionId, setOnInsert, ...rest }) {
  if (!telephonySessionId) {
    throw new Error("telephonySessionId is required");
  }
  const normalizedDomain = normalizeDomain(domain);
  const set = { ...rest };
  if (rest.phone && !rest.normalizedPhone) {
    set.normalizedPhone = normalizeDigits(rest.phone);
  }

  // `setOnInsert` lets callers add fields that should ONLY be written
  // when the row is first created — useful for stamps like `platform`
  // where a later writer (e.g. CX disposition path stamping "cx") must
  // not be overwritten by an earlier writer (e.g. hourly RC sweep
  // stamping "ex"). Pass `{ platform: "ex" }` here and `platform` will
  // appear on creation but won't trample a prior `$set`-written value.
  const insertOnly = {
    domain: normalizedDomain,
    telephonySessionId: String(telephonySessionId),
    ...(setOnInsert && typeof setOnInsert === "object" ? setOnInsert : {}),
  };

  return CallLog.findOneAndUpdate(
    {
      domain: normalizedDomain,
      telephonySessionId: String(telephonySessionId),
    },
    {
      $set: set,
      $setOnInsert: insertOnly,
    },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );
}

async function findCallLog(domain, telephonySessionId) {
  return CallLog.findOne({
    domain: normalizeDomain(domain),
    telephonySessionId: String(telephonySessionId),
  }).lean();
}

async function findCallLogBySessionId(telephonySessionId, { domain } = {}) {
  if (!telephonySessionId) return null;
  const query = {
    telephonySessionId: String(telephonySessionId),
  };
  if (domain) query.domain = normalizeDomain(domain);
  return CallLog.findOne(query)
    .sort({ updatedAt: -1, createdAt: -1 })
    .lean();
}

/**
 * Back-link a CallLog to its CaseProfile after promotion. Kept as a
 * dedicated method because we do it *after* the main resolver write
 * (so the CallLog row already exists) and we don't want a full upsert
 * to clobber anything else that's been set on the row since.
 */
async function linkCaseProfileId(domain, telephonySessionId, caseProfileId) {
  if (!caseProfileId) return null;
  return CallLog.findOneAndUpdate(
    {
      domain: normalizeDomain(domain),
      telephonySessionId: String(telephonySessionId),
    },
    { $set: { caseProfileId } },
    { new: true },
  );
}

/**
 * "Has this phone called before, with a good attribution?" — used by the
 * resolver to reuse prior decisions rather than re-resolving each time a
 * repeat caller lands. Returns the most recent resolved row for the phone.
 */
async function findLatestResolvedByPhone(domain, phone, { minConfidence = "medium" } = {}) {
  const tenDigit = normalizeDigits(phone);
  if (!tenDigit) return null;

  const confidenceRank = { high: 3, medium: 2, low: 1, none: 0 };
  const allowedConfidences = Object.entries(confidenceRank)
    .filter(([, rank]) => rank >= (confidenceRank[minConfidence] || 0))
    .map(([key]) => key);

  return CallLog.findOne({
    domain: normalizeDomain(domain),
    normalizedPhone: tenDigit,
    status: "resolved",
    confidence: { $in: allowedConfidences },
    sourceCanonicalId: { $ne: null },
  })
    .sort({ callStartTime: -1, resolvedAt: -1 })
    .lean();
}

/**
 * "Give me every call tied to this case" — powers CaseProfile contact
 * history and attribution recomputation.
 */
async function listCallLogsByCaseId(domain, caseId, { limit = 100, includeLegacy } = {}) {
  const normalizedDomain = normalizeDomain(domain);
  const numericCaseId = Number(caseId);
  const clampedLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const includeLegacyRows =
    includeLegacy !== undefined ? Boolean(includeLegacy) : legacyReadsEnabledByDefault();

  const currentDocs = await CallLog.find({
    domain: normalizedDomain,
    caseId: numericCaseId,
  })
    .sort({ callStartTime: -1, createdAt: -1 })
    .limit(clampedLimit)
    .lean();

  if (!includeLegacyRows) {
    return currentDocs.map((doc) => normalizeCurrentCallLog(doc, null));
  }

  const legacyDocs = await legacyContactActivitiesCollection()
    .find({
      company: normalizedDomain,
      $or: [
        { caseId: numericCaseId },
        { "caseMatch.caseId": numericCaseId },
      ],
    })
    .sort({ callStartTime: -1, createdAt: -1 })
    .limit(clampedLimit)
    .toArray();

  const currentBySession = new Map(
    currentDocs.map((doc) => [String(doc.telephonySessionId || ""), doc]),
  );
  const merged = [];

  for (const legacyDoc of legacyDocs) {
    const normalizedLegacy = normalizeLegacyContactActivity(legacyDoc);
    const sessionId = String(
      normalizedLegacy?.telephonySessionId || normalizedLegacy?.callSessionId || "",
    );
    const currentDoc = currentBySession.get(sessionId) || null;
    if (sessionId) currentBySession.delete(sessionId);
    merged.push(normalizeCurrentCallLog(currentDoc, normalizedLegacy));
  }

  for (const currentDoc of currentBySession.values()) {
    merged.push(normalizeCurrentCallLog(currentDoc, null));
  }

  return merged
    .filter(Boolean)
    .sort((left, right) => {
      const leftTime =
        toDate(left.callStartTime)?.getTime() ||
        toDate(left.createdAt)?.getTime() ||
        0;
      const rightTime =
        toDate(right.callStartTime)?.getTime() ||
        toDate(right.createdAt)?.getTime() ||
        0;
      return rightTime - leftTime;
    })
    .slice(0, clampedLimit);
}

/**
 * Hourly retry sweeper query. Finds rows that still need attribution and
 * haven't been beaten on too many times yet. Caller advances
 * `retryAttempts` after each pass.
 */
async function listPendingRetries({
  domain,
  maxAttempts = 6,
  sinceMs = 24 * 60 * 60 * 1000,
  limit = 100,
} = {}) {
  const query = {
    status: "pending-retry",
    retryAttempts: { $lt: maxAttempts },
    createdAt: { $gte: new Date(Date.now() - sinceMs) },
  };
  if (domain) query.domain = normalizeDomain(domain);

  return CallLog.find(query)
    .sort({ createdAt: 1 })
    .limit(Math.min(Math.max(Number(limit) || 100, 1), 500))
    .lean();
}

async function listLegacyCallLogsDeprecated(domain, filters = {}) {
  const query = {
    company: normalizeDomain(domain),
  };
  if (filters.direction) {
    // Legacy stores direction capitalized ("Outbound"/"Inbound"). Match
    // case-insensitively so callers can keep passing lowercase.
    const dir = String(filters.direction).trim();
    query.direction = new RegExp(`^${dir}$`, "i");
  }
  // Status fields don't exist on legacy rows — skip status/statuses
  // filters when reading from legacy rather than returning empty.
  if (filters.extensionId) query.extensionId = String(filters.extensionId);
  if (filters.caseId != null) query.caseId = Number(filters.caseId);
  if (filters.sinceMs) {
    query.createdAt = { $gte: new Date(Date.now() - Number(filters.sinceMs)) };
  }
  const callStartFrom = toDate(filters.callStartFrom);
  const callStartTo = toDate(filters.callStartTo);
  if (callStartFrom || callStartTo) {
    query.callStartTime = {};
    if (callStartFrom) query.callStartTime.$gte = callStartFrom;
    if (callStartTo) query.callStartTime.$lte = callStartTo;
  }

  const limit = Math.min(Math.max(Number(filters.limit) || 50, 1), 500);
  const docs = await legacyContactActivitiesCollection()
    .find(query)
    .sort({ callStartTime: -1, createdAt: -1 })
    .limit(limit)
    .toArray();
  return docs.map(normalizeLegacyContactActivity);
}

async function listCallLogs(domain, filters = {}) {
  const normalizedDomain = normalizeDomain(domain);
  const query = {
    domain: normalizedDomain,
  };
  const legacyQuery = {
    company: normalizedDomain,
  };

  if (filters.direction) {
    const direction = String(filters.direction).trim().toLowerCase();
    query.direction = direction;
    legacyQuery.direction = new RegExp(`^${direction}$`, "i");
  }
  if (filters.status) query.status = filters.status;
  if (Array.isArray(filters.statuses) && filters.statuses.length > 0) {
    query.status = { $in: filters.statuses };
  }
  if (filters.extensionId) {
    query.extensionId = String(filters.extensionId);
    legacyQuery.extensionId = String(filters.extensionId);
  }
  if (filters.caseId != null) {
    query.caseId = Number(filters.caseId);
    legacyQuery.$or = [
      { caseId: Number(filters.caseId) },
      { "caseMatch.caseId": Number(filters.caseId) },
    ];
  }
  if (filters.sinceMs) {
    const since = new Date(Date.now() - Number(filters.sinceMs));
    query.createdAt = { $gte: since };
    legacyQuery.createdAt = { $gte: since };
  }

  const callStartFrom = toDate(filters.callStartFrom);
  const callStartTo = toDate(filters.callStartTo);
  if (callStartFrom || callStartTo) {
    query.callStartTime = {};
    legacyQuery.callStartTime = {};
    if (callStartFrom) {
      query.callStartTime.$gte = callStartFrom;
      legacyQuery.callStartTime.$gte = callStartFrom;
    }
    if (callStartTo) {
      query.callStartTime.$lte = callStartTo;
      legacyQuery.callStartTime.$lte = callStartTo;
    }
  }

  const limit = Math.min(Math.max(Number(filters.limit) || 50, 1), 500);
  const currentDocs = await CallLog.find(query)
    .sort({ callStartTime: -1, createdAt: -1 })
    .limit(limit)
    .lean();

  if (!includeLegacyReads(filters)) {
    return currentDocs.map((doc) => normalizeCurrentCallLog(doc, null));
  }

  const legacyDocs = await legacyContactActivitiesCollection()
    .find(legacyQuery)
    .sort({ callStartTime: -1, createdAt: -1 })
    .limit(limit)
    .toArray();

  const currentBySession = new Map(
    currentDocs.map((doc) => [String(doc.telephonySessionId || ""), doc]),
  );
  const merged = [];
  for (const legacyDoc of legacyDocs) {
    const normalizedLegacy = normalizeLegacyContactActivity(legacyDoc);
    const sessionId = String(
      normalizedLegacy?.telephonySessionId || normalizedLegacy?.callSessionId || "",
    );
    const currentDoc = currentBySession.get(sessionId) || null;
    if (sessionId) currentBySession.delete(sessionId);
    merged.push(normalizeCurrentCallLog(currentDoc, normalizedLegacy));
  }
  for (const currentDoc of currentBySession.values()) {
    merged.push(normalizeCurrentCallLog(currentDoc, null));
  }

  return merged
    .filter(Boolean)
    .sort((left, right) => {
      const leftTime =
        toDate(left.callStartTime)?.getTime() ||
        toDate(left.createdAt)?.getTime() ||
        0;
      const rightTime =
        toDate(right.callStartTime)?.getTime() ||
        toDate(right.createdAt)?.getTime() ||
        0;
      return rightTime - leftTime;
    })
    .slice(0, limit);
}

async function countCallLogs(domain, filters = {}) {
  const query = {
    domain: normalizeDomain(domain),
  };
  if (filters.status) query.status = filters.status;
  if (filters.direction) query.direction = String(filters.direction).toLowerCase();
  return CallLog.countDocuments(query);
}

/**
 * Atomically bump retry counters + update fields as the sweeper re-runs.
 */
async function markRetryOutcome(domain, telephonySessionId, update = {}) {
  return CallLog.findOneAndUpdate(
    {
      domain: normalizeDomain(domain),
      telephonySessionId: String(telephonySessionId),
    },
    {
      $set: {
        ...update,
        lastRetryAt: new Date(),
      },
      $inc: { retryAttempts: 1 },
    },
    { new: true },
  );
}

module.exports = {
  countCallLogs,
  findCallLog,
  findCallLogBySessionId,
  findLatestResolvedByPhone,
  linkCaseProfileId,
  listCallLogs,
  listCallLogsByCaseId,
  listPendingRetries,
  markRetryOutcome,
  upsertCallLog,
};
