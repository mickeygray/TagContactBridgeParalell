"use strict";

const mongoose = require("mongoose");

/**
 * Read-only view of the legacy app's RB_ContactActivity collection. The
 * old ringBridge writes one document per call/touch with Logics enrichment
 * and call scoring already attached. Until the Parallel-native attribution
 * pipeline is producing call rows at volume, we surface these directly so
 * the UI has data to render and we can verify the call-log table reads
 * against real traffic.
 *
 * IDENTIFIER SCOPE: the legacy collection is tenant-wide (single RC tenant)
 * and its `company` field is the source of per-domain filtering.
 */

function getLegacyDbName() {
  return String(process.env.LEGACY_APP_DB_NAME || "test").trim() || "test";
}

function getLegacyCollection() {
  // Mongoose default pluralization: `RB_ContactActivity` → `rb_contactactivities`.
  return mongoose.connection
    .useDb(getLegacyDbName(), { useCache: true })
    .collection("rb_contactactivities");
}

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

function buildLegacyContactActivityQuery({
  domain,
  direction,
  extensionId,
  sinceMs,
  from,
  to,
} = {}) {
  const query = {};

  const normalizedDomain = normalizeDomain(domain);
  if (normalizedDomain) {
    query.$or = [
      { company: normalizedDomain },
      { "caseMatch.domain": normalizedDomain },
    ];
  }

  if (direction) {
    const wanted = String(direction).toLowerCase();
    const mapped =
      wanted === "inbound"
        ? "Inbound"
        : wanted === "outbound"
          ? "Outbound"
          : wanted;
    query.direction = mapped;
  }

  if (extensionId) {
    query.extensionId = String(extensionId);
  }

  const fromDate = toDate(from);
  const toDateValue = toDate(to);
  if (fromDate || toDateValue) {
    query.callStartTime = {};
    if (fromDate) query.callStartTime.$gte = fromDate;
    if (toDateValue) query.callStartTime.$lte = toDateValue;
  } else if (sinceMs) {
    query.createdAt = { $gte: new Date(Date.now() - Number(sinceMs)) };
  }

  return query;
}

function mapActivityToCallLogRow(doc = {}) {
  const direction = String(doc.direction || "").toLowerCase();
  const caseMatch = doc.caseMatch || {};
  const attribution = {
    status:
      doc.enrichmentStatus === "matched"
        ? "resolved"
        : doc.enrichmentStatus === "unmatched"
          ? "none"
          : doc.enrichmentStatus || "pending",
    strategy: "legacy",
    confidence: doc.enrichmentStatus === "matched" ? "medium" : null,
    attempts: doc.enrichmentAttempts ?? null,
    caseId: caseMatch.caseId ?? null,
    caseDomain: caseMatch.domain || null,
    caseName: caseMatch.name || null,
    intakeSource: caseMatch.sourceChannel || null,
    reconcile: false,
  };

  const missed =
    doc.disposition === "bad" ||
    (Number(doc.durationSeconds) || 0) === 0;

  const source =
    caseMatch.sourceId || caseMatch.sourceName
      ? {
          matched: true,
          canonicalKey: caseMatch.sourceId ? String(caseMatch.sourceId) : null,
          name: caseMatch.sourceName || null,
          channel: caseMatch.sourceChannel || null,
          did: null,
        }
      : null;

  return {
    sessionId:
      doc.telephonySessionId ||
      doc.callSessionId ||
      String(doc._id || ""),
    extensionId: doc.extensionId || null,
    agentName: doc.agentName || null,
    agentCompany: doc.company || null,
    direction: direction || null,
    fromNumber: direction === "inbound" ? doc.phone || null : null,
    fromName: direction === "inbound" ? caseMatch.name || null : doc.agentName || null,
    toNumber: direction === "outbound" ? doc.phone || null : null,
    toName: direction === "outbound" ? caseMatch.name || null : null,
    startedAt: doc.callStartTime || doc.createdAt || null,
    endedAt: doc.callEndTime || null,
    durationSec: Number(doc.durationSeconds) || null,
    outcome: doc.disposition && doc.disposition !== "none" ? doc.disposition : null,
    missed,
    hasRecording: Boolean(doc.transcription?.recordingUri),
    source,
    attribution,
    stages: [],
    // Legacy extras — not on the Parallel-native schema but useful to keep:
    legacy: {
      recordId: String(doc._id || ""),
      contactMethod: doc.contactMethod || null,
      recordSource: doc.source || null,
      transcriptionStatus: doc.transcription?.status || null,
      callScoreOverall: doc.callScore?.overall ?? null,
    },
  };
}

/**
 * Pick the "most complete" row when multiple ContactActivity docs share a
 * telephonySessionId. The old app writes one row per webhook stage so a
 * single call can show up 2-5 times; the final one has callEndTime +
 * duration populated while earlier snapshots have nulls.
 */
function preferBetter(a, b) {
  if (!a) return b;
  if (!b) return a;
  const aDuration = Number(a.durationSeconds) || 0;
  const bDuration = Number(b.durationSeconds) || 0;
  if (aDuration !== bDuration) return aDuration > bDuration ? a : b;
  const aEnd = a.callEndTime ? new Date(a.callEndTime).getTime() : 0;
  const bEnd = b.callEndTime ? new Date(b.callEndTime).getTime() : 0;
  if (aEnd !== bEnd) return aEnd > bEnd ? a : b;
  const aUpd = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
  const bUpd = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
  return aUpd >= bUpd ? a : b;
}

async function listLegacyContactActivities({
  domain,
  limit = 50,
  direction,
  extensionId,
  sinceMs,
  from,
  to,
} = {}) {
  const collection = getLegacyCollection();
  const query = buildLegacyContactActivityQuery({
    domain,
    direction,
    extensionId,
    sinceMs,
    from,
    to,
  });

  const cap = Math.min(Math.max(Number(limit) || 50, 1), 500);
  // Overfetch so that after dedupe we still have at least `cap` rows.
  const overfetch = Math.min(cap * 4, 1000);
  const docs = await collection
    .find(query)
    .sort({ callStartTime: -1, createdAt: -1 })
    .limit(overfetch)
    .toArray();

  const bestBySession = new Map();
  const bestByRecord = new Map();
  for (const doc of docs) {
    const sessionKey =
      String(doc.telephonySessionId || "").trim() ||
      String(doc.callSessionId || "").trim();
    if (sessionKey) {
      bestBySession.set(sessionKey, preferBetter(bestBySession.get(sessionKey), doc));
    } else {
      // No session id — keep the row as-is, keyed by _id.
      bestByRecord.set(String(doc._id), doc);
    }
  }

  const deduped = [...bestBySession.values(), ...bestByRecord.values()];
  deduped.sort((a, b) => {
    const at = new Date(a.callStartTime || a.createdAt || 0).getTime();
    const bt = new Date(b.callStartTime || b.createdAt || 0).getTime();
    return bt - at;
  });

  return deduped.slice(0, cap).map(mapActivityToCallLogRow);
}

async function listLegacyContactActivityDocs({
  domain,
  limit = 1000,
  direction,
  extensionId,
  sinceMs,
  from,
  to,
} = {}) {
  const collection = getLegacyCollection();
  const query = buildLegacyContactActivityQuery({
    domain,
    direction,
    extensionId,
    sinceMs,
    from,
    to,
  });

  const cap = Math.min(Math.max(Number(limit) || 1000, 1), 20000);
  const overfetch = Math.min(cap * 4, 50000);
  const docs = await collection
    .find(query)
    .sort({ callStartTime: -1, createdAt: -1 })
    .limit(overfetch)
    .toArray();

  const bestBySession = new Map();
  const bestByRecord = new Map();
  for (const doc of docs) {
    const sessionKey =
      String(doc.telephonySessionId || "").trim() ||
      String(doc.callSessionId || "").trim();
    if (sessionKey) {
      bestBySession.set(sessionKey, preferBetter(bestBySession.get(sessionKey), doc));
    } else {
      bestByRecord.set(String(doc._id), doc);
    }
  }

  const deduped = [...bestBySession.values(), ...bestByRecord.values()];
  deduped.sort((a, b) => {
    const at = new Date(a.callStartTime || a.createdAt || 0).getTime();
    const bt = new Date(b.callStartTime || b.createdAt || 0).getTime();
    return bt - at;
  });

  return deduped.slice(0, cap);
}

async function summarizeLegacyContactActivitiesBySource({
  domain,
  direction = "inbound",
  from,
  to,
  limit = 10000,
} = {}) {
  const docs = await listLegacyContactActivityDocs({
    domain,
    direction,
    from,
    to,
    limit,
  });

  const grouped = new Map();
  for (const doc of docs) {
    const caseMatch = doc.caseMatch || {};
    const sourceName = String(caseMatch.sourceName || "").trim();
    const sourceChannel = String(caseMatch.sourceChannel || "").trim().toLowerCase() || null;
    const sourceId = caseMatch.sourceId != null ? Number(caseMatch.sourceId) : null;
    if (!sourceName && !Number.isFinite(sourceId)) {
      continue;
    }

    const date = buildPacificDateKey(doc.callStartTime || doc.createdAt);
    if (!date) continue;

    const key = [
      date,
      sourceName.toLowerCase(),
      sourceChannel || "",
      Number.isFinite(sourceId) ? String(sourceId) : "",
    ].join("::");

    if (!grouped.has(key)) {
      grouped.set(key, {
        date,
        sourceName: sourceName || null,
        sourceChannel,
        sourceId: Number.isFinite(sourceId) ? sourceId : null,
        totalCalls: 0,
        callsOver5: 0,
        callsOver2: 0,
        totalDuration: 0,
        uniqueCallers: new Set(),
        firstCallTime: null,
        lastCallTime: null,
        caseIds: new Set(),
        sampleRecordIds: [],
      });
    }

    const entry = grouped.get(key);
    const duration = Number(doc.durationSeconds || 0);
    const caller = normalizeDigits(doc.phone || null);
    const caseId = Number(caseMatch.caseId);
    const callStartedAt = doc.callStartTime || doc.createdAt || null;

    entry.totalCalls += 1;
    entry.callsOver5 += duration >= 300 ? 1 : 0;
    entry.callsOver2 += duration >= 120 ? 1 : 0;
    entry.totalDuration += duration;
    if (caller) entry.uniqueCallers.add(caller);
    if (Number.isFinite(caseId)) entry.caseIds.add(caseId);
    if (callStartedAt) {
      if (
        !entry.firstCallTime ||
        new Date(callStartedAt).getTime() < new Date(entry.firstCallTime).getTime()
      ) {
        entry.firstCallTime = callStartedAt;
      }
      if (
        !entry.lastCallTime ||
        new Date(callStartedAt).getTime() > new Date(entry.lastCallTime).getTime()
      ) {
        entry.lastCallTime = callStartedAt;
      }
    }
    if (entry.sampleRecordIds.length < 10) {
      entry.sampleRecordIds.push(String(doc._id || ""));
    }
  }

  return [...grouped.values()]
    .map((entry) => ({
      date: entry.date,
      sourceName: entry.sourceName,
      sourceChannel: entry.sourceChannel,
      sourceId: entry.sourceId,
      totalCalls: entry.totalCalls,
      callsOver5: entry.callsOver5,
      callsOver2: entry.callsOver2,
      totalDuration: entry.totalDuration,
      uniqueCallers: entry.uniqueCallers.size,
      firstCallTime: entry.firstCallTime,
      lastCallTime: entry.lastCallTime,
      caseIds: [...entry.caseIds],
      sampleRecordIds: entry.sampleRecordIds,
    }))
    .sort((left, right) => {
      if (left.date !== right.date) return String(left.date).localeCompare(String(right.date));
      if (left.totalCalls !== right.totalCalls) return right.totalCalls - left.totalCalls;
      return String(left.sourceName || "").localeCompare(String(right.sourceName || ""));
    });
}

async function countLegacyContactActivities(domain) {
  const collection = getLegacyCollection();
  const normalizedDomain = normalizeDomain(domain);
  const query = normalizedDomain
    ? {
        $or: [
          { company: normalizedDomain },
          { "caseMatch.domain": normalizedDomain },
        ],
      }
    : {};
  return collection.countDocuments(query);
}

module.exports = {
  buildLegacyContactActivityQuery,
  countLegacyContactActivities,
  listLegacyContactActivityDocs,
  listLegacyContactActivities,
  mapActivityToCallLogRow,
  summarizeLegacyContactActivitiesBySource,
};
