"use strict";

const mongoose = require("mongoose");
const {
  sourceCanonicalRepository,
} = require("../../shared-repositories/src");
const {
  CallLedger,
  CallLog,
  CaseProfile,
  DailyCallStat,
  LeadCadence,
  MasterProspectIndex,
  MetricsSnapshot,
  PaymentLedger,
  SourceCanonical,
  SpendEntry,
} = require("../../shared-models/src");
const { createCallFireClient, createCallrailClient } = require("../../shared-integrations/src");
const { summarizeLegacyContactActivitiesBySource } = require("./legacyContactActivityService");
const { getManualLeadOverlayTotal } = require("./metricsManualOverlayService");
const { resolveCanonicalSource } = require("./sourceCanonicalService");
const { buildTimezoneDateWindow } = require("./timezoneDateWindowService");

function normalizeDomain(domain) {
  return String(domain || "").trim().toUpperCase();
}

function buildDateRangeMatch(from, to) {
  const match = {};
  if (from || to) {
    match.date = {};
    if (from) match.date.$gte = String(from);
    if (to) match.date.$lte = String(to);
  }
  return match;
}

function buildDateKeys(from, to) {
  const keys = [];
  const cursor = new Date(`${String(from)}T00:00:00.000Z`);
  const end = new Date(`${String(to)}T00:00:00.000Z`);
  while (cursor.getTime() <= end.getTime()) {
    keys.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return keys;
}

function getMirrorDb() {
  return mongoose.connection.db;
}

function toDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function inferPaymentType(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "initial") return "initial";
  if (normalized === "recurring") return "recurring";
  return "unknown";
}

function normalizeDigits(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  return digits.length === 11 && digits.startsWith("1")
    ? digits.slice(1)
    : digits.slice(-10);
}

function mapCanonicalChannel(canonical = null, sourceName = "") {
  const channel = String(canonical?.channel || "").toLowerCase();
  const name = String(canonical?.internalName || sourceName || "").toLowerCase();

  if (channel === "mailer" || channel === "mail") return "mail";
  if (channel === "dialer") return "dialer";
  if (channel === "bcd" || (channel === "vendor" && name.includes("bcd"))) return "bcd";
  if (channel === "affiliate" || name.includes("affiliate")) return "affiliate";
  if (channel === "ld-posting" || channel === "ld" || name.includes("lead data") || name.includes("a+ leads")) return "ld";
  if (name.includes("callfire") || name.includes("rvm transfer")) return "dialer";
  if (name.includes("bcd")) return "bcd";
  if (name.includes("affiliate")) return "affiliate";
  if (name.includes("lead")) return "ld";
  return channel || "mail";
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

function todayPacificKey(now = new Date()) {
  return buildPacificDateKey(now) || new Date(now).toISOString().slice(0, 10);
}

async function buildSourceCanonicalMaps() {
  const docs = await SourceCanonical.find({ active: true }).lean();
  const byId = new Map();
  const byKey = new Map();
  const byName = new Map();

  for (const doc of docs) {
    if (doc._id) {
      byId.set(String(doc._id), doc);
    }
    if (doc.canonicalKey) {
      byKey.set(String(doc.canonicalKey), doc);
    }
    if (doc.internalName) {
      byName.set(String(doc.internalName).trim().toLowerCase(), doc);
    }
  }

  return { byId, byKey, byName };
}

function resolveSourceCanonicalId(row, sourceMaps) {
  const byId = sourceMaps.byId;
  const byKey = sourceMaps.byKey;
  const byName = sourceMaps.byName;
  const id = row.sourceCanonicalId ? byId.get(String(row.sourceCanonicalId)) : null;
  if (id?._id) return id._id;
  const key = row.canonicalKey ? byKey.get(String(row.canonicalKey)) : null;
  if (key?._id) return key._id;

  const sourceName = row.source || row.sourceName || row.piece || row.internalName;
  if (!sourceName) return null;
  const byInternalName = byName.get(String(sourceName).trim().toLowerCase());
  return byInternalName?._id || null;
}

async function buildCaseSourceMaps(domain, caseIds = [], sourceMaps) {
  const numericCaseIds = [...new Set(caseIds.map((value) => Number(value)).filter(Number.isFinite))];
  if (!numericCaseIds.length) return new Map();

  const normalizedDomain = normalizeDomain(domain);
  const [caseProfiles, prospects, cadences] = await Promise.all([
    CaseProfile.find({ domain: normalizedDomain, caseId: { $in: numericCaseIds } }).lean(),
    MasterProspectIndex.find({ domain: normalizedDomain, caseId: { $in: numericCaseIds } }).lean(),
    LeadCadence.find({ domain: normalizedDomain, caseId: { $in: numericCaseIds } }).lean(),
  ]);

  const byCaseId = new Map();
  for (const caseId of numericCaseIds) {
    byCaseId.set(caseId, {
      caseProfile: null,
      prospect: null,
      cadence: null,
    });
  }
  for (const row of caseProfiles) byCaseId.get(Number(row.caseId)).caseProfile = row;
  for (const row of prospects) byCaseId.get(Number(row.caseId)).prospect = row;
  for (const row of cadences) byCaseId.get(Number(row.caseId)).cadence = row;

  const resolved = new Map();
  for (const [caseId, entry] of byCaseId.entries()) {
    const canonicalId =
      entry.caseProfile?.sourceCanonicalId ||
      entry.prospect?.sourceCanonicalId ||
      null;
    const canonicalDoc = canonicalId ? sourceMaps.byId.get(String(canonicalId)) : null;

    let resolvedCanonical = canonicalDoc
      ? {
          internalName: canonicalDoc.internalName,
          channel: canonicalDoc.channel,
          sourceCanonicalId: canonicalDoc._id,
        }
      : null;

    if (!resolvedCanonical && entry.prospect?.sourceId != null) {
      const canonical = await resolveCanonicalSource({
        domain: normalizedDomain,
        sourceId: entry.prospect.sourceId,
      });
      if (canonical?.doc?._id) {
        resolvedCanonical = {
          internalName: canonical.internalName,
          channel: canonical.channel,
          sourceCanonicalId: canonical.doc._id,
        };
      }
    }

    resolved.set(caseId, {
      ...resolvedCanonical,
      intakeSource: entry.cadence?.intakeSource || entry.prospect?.metadata?.intakeSource || null,
      sourceName: entry.cadence?.sourceName || null,
      sourceChannel: entry.cadence?.sourceChannel || null,
      sourceId: entry.prospect?.sourceId ?? null,
    });
  }

  return resolved;
}

function inferPaymentSourceFromCase(caseId, caseSourceMaps) {
  const entry = caseSourceMaps.get(Number(caseId));
  if (!entry) return null;
  return {
    sourceCanonicalId: entry.sourceCanonicalId || null,
    sourceName: entry.internalName || entry.sourceName || entry.intakeSource || null,
    sourceChannel: entry.channel || entry.sourceChannel || null,
    sourceId: entry.sourceId ?? null,
  };
}

function inferCallrailSourceByName(sourceName = "") {
  const normalized = String(sourceName || "").trim().toLowerCase();
  if (!normalized) return null;

  if (normalized.includes("bcd")) {
    return { piece: "BCD", channel: "bcd" };
  }
  if (
    normalized.includes("callfire") ||
    normalized.includes("hand dialer") ||
    normalized.includes("dialer lead") ||
    normalized.includes("aged data")
  ) {
    return { piece: "CallFire", channel: "dialer" };
  }
  if (normalized.includes("rvm transfer") || normalized.includes("rvm callback")) {
    return { piece: "RVM Callback", channel: "ld" };
  }
  if (normalized.includes("affiliate")) {
    return { piece: "Affiliate", channel: "affiliate" };
  }
  if (
    normalized.includes("lead data") ||
    normalized.includes("a+ leads") ||
    normalized === "ld"
  ) {
    return { piece: "Lead Data", channel: "ld" };
  }
  return null;
}

function mergeCallStatEntry(grouped, row) {
  const key = `${row.date}::${row.piece}`;

  if (!grouped.has(key)) {
    grouped.set(key, {
      date: row.date,
      piece: row.piece,
      tollFree: row.tollFree || null,
      trackingNumber: row.trackingNumber || null,
      channel: row.channel || "unknown",
      totalCalls: 0,
      callsOver5: 0,
      callsOver2: 0,
      totalDuration: 0,
      uniqueCallers: new Set(),
      firstCallTime: null,
      lastCallTime: null,
      canonicalKey: row.canonicalKey || null,
      sourceCanonicalId: row.sourceCanonicalId || null,
      raw: [],
    });
  }

  const entry = grouped.get(key);
  entry.tollFree = entry.tollFree || row.tollFree || null;
  entry.trackingNumber = entry.trackingNumber || row.trackingNumber || null;
  entry.channel = row.channel || entry.channel;
  entry.totalCalls += Number(row.totalCalls || 0);
  entry.callsOver5 += Number(row.callsOver5 || 0);
  entry.callsOver2 += Number(row.callsOver2 || 0);
  entry.totalDuration += Number(row.totalDuration || 0);
  entry.canonicalKey = entry.canonicalKey || row.canonicalKey || null;
  entry.sourceCanonicalId = entry.sourceCanonicalId || row.sourceCanonicalId || null;

  if (row.uniqueCallers instanceof Set) {
    for (const caller of row.uniqueCallers) {
      if (caller) entry.uniqueCallers.add(caller);
    }
  } else if (Number.isFinite(Number(row.uniqueCallers)) && Number(row.uniqueCallers) > 0) {
    for (let index = 0; index < Number(row.uniqueCallers); index += 1) {
      entry.uniqueCallers.add(`synthetic-${row.piece}-${row.date}-${entry.uniqueCallers.size + 1}`);
    }
  }

  if (row.firstCallTime) {
    entry.firstCallTime =
      !entry.firstCallTime || new Date(row.firstCallTime).getTime() < new Date(entry.firstCallTime).getTime()
        ? row.firstCallTime
        : entry.firstCallTime;
  }
  if (row.lastCallTime) {
    entry.lastCallTime =
      !entry.lastCallTime || new Date(row.lastCallTime).getTime() > new Date(entry.lastCallTime).getTime()
        ? row.lastCallTime
        : entry.lastCallTime;
  }

  if (row.raw) {
    entry.raw.push(row.raw);
  }
}

async function addCallFireBroadcasts(grouped, callFireBroadcasts = [], sourceMaps) {
  for (const broadcast of callFireBroadcasts) {
    const canonical = await resolveCanonicalSource({
      domain: "TAG",
      sourceName: "CallFire",
      rawName: broadcast.name || "CallFire",
    });
    const iso = new Date(Number(broadcast.lastModified || Date.now())).toISOString();
    const stats = broadcast.stats || {};

    mergeCallStatEntry(grouped, {
      date: String(broadcast.date),
      piece: "CallFire",
      tollFree: broadcast.fromNumber || null,
      trackingNumber: broadcast.fromNumber || null,
      channel: "dialer",
      totalCalls: Number(
        stats.totalOutboundCount || stats.totalCount || stats.dialedCount || stats.callsAttempted || 0,
      ),
      callsOver5: 0,
      callsOver2: 0,
      totalDuration: Number(stats.callsDuration || 0),
      uniqueCallers: Number(stats.totalCount || stats.totalOutboundCount || stats.dialedCount || 0),
      firstCallTime: iso,
      lastCallTime: iso,
      canonicalKey: canonical?.canonicalKey || null,
      sourceCanonicalId: canonical?.doc?._id || resolveSourceCanonicalId({ source: "CallFire" }, sourceMaps),
      raw: {
        provider: "callfire",
        id: broadcast.id,
        name: broadcast.name,
        fromNumber: broadcast.fromNumber || null,
        lastModified: broadcast.lastModified || null,
        stats,
      },
    });
  }
}

function buildPacificRangeWindow(from, to) {
  const startWindow = buildTimezoneDateWindow(String(from), "America/Los_Angeles");
  const endWindow = buildTimezoneDateWindow(String(to), "America/Los_Angeles");
  return {
    start: startWindow.start,
    end: endWindow.end,
  };
}

async function buildDailyCallStatsFromCallLogs(
  domain,
  from,
  to,
  sourceMaps,
  callFireBroadcasts = [],
  options = {},
) {
  const normalizedDomain = normalizeDomain(domain || "TAG");
  const { start, end } = buildPacificRangeWindow(from, to);
  const maxRows = Math.min(
    Math.max(Number(options.maxRows || process.env.CALL_LOG_DAILY_STATS_MAX_ROWS || 20000), 1),
    100000,
  );
  const direction = String(options.direction || "inbound").trim().toLowerCase();

  const rows = await CallLog.find({
    domain: normalizedDomain,
    direction,
    status: { $ne: "skipped" },
    callStartTime: { $gte: start, $lte: end },
  })
    .sort({ callStartTime: 1, createdAt: 1 })
    .limit(maxRows)
    .lean();

  if (rows.length <= 0 && callFireBroadcasts.length <= 0) return null;

  const grouped = new Map();
  for (const row of rows) {
    const canonical = row.sourceCanonicalId
      ? sourceMaps.byId.get(String(row.sourceCanonicalId))
      : null;
    const piece =
      canonical?.internalName ||
      row.sourceName ||
      row.mailPieceKey ||
      "Unknown";
    const channel =
      canonical?.channel ||
      row.sourceChannel ||
      mapCanonicalChannel(canonical, piece);
    const duration = Number(row.durationSec || 0);
    const callDate = buildPacificDateKey(row.callStartTime || row.createdAt) || String(from);

    mergeCallStatEntry(grouped, {
      date: callDate,
      piece,
      tollFree: null,
      trackingNumber: null,
      channel,
      totalCalls: 1,
      callsOver5: duration >= 300 ? 1 : 0,
      callsOver2: duration >= 120 ? 1 : 0,
      totalDuration: duration,
      uniqueCallers: row.normalizedPhone
        ? new Set([String(row.normalizedPhone)])
        : row.phone
          ? new Set([normalizeDigits(row.phone)])
          : new Set(),
      firstCallTime: row.callStartTime || row.createdAt || null,
      lastCallTime: row.callStartTime || row.createdAt || null,
      canonicalKey: row.mailPieceKey || canonical?.canonicalKey || null,
      sourceCanonicalId:
        row.sourceCanonicalId ||
        canonical?._id ||
        resolveSourceCanonicalId({ source: piece }, sourceMaps),
      raw: {
        provider: "control-plane-calllog",
        telephonySessionId: row.telephonySessionId || null,
        caseId: Number.isFinite(Number(row.caseId)) ? Number(row.caseId) : null,
        status: row.status || null,
        strategy: row.strategy || null,
        confidence: row.confidence || null,
      },
    });
  }

  await addCallFireBroadcasts(grouped, callFireBroadcasts, sourceMaps);
  const { operations, result } = await writeGroupedCallStats(grouped);

  return {
    imported: operations.length,
    upserted: Number(result.upsertedCount || 0),
    modified: Number(result.modifiedCount || 0),
    scanned: rows.length,
    source:
      rows.length > 0 && callFireBroadcasts.length > 0
        ? "control-plane-calllog+callfire"
        : rows.length > 0
          ? "control-plane-calllog"
          : "callfire",
  };
}

async function writeGroupedCallStats(grouped) {
  const operations = [...grouped.values()].map((entry) => ({
    updateOne: {
      filter: {
        date: entry.date,
        piece: entry.piece,
      },
      update: {
        $set: {
          date: entry.date,
          piece: entry.piece,
          tollFree: entry.tollFree,
          trackingNumber: entry.trackingNumber,
          channel: entry.channel,
          totalCalls: entry.totalCalls,
          callsOver5: entry.callsOver5,
          callsOver2: entry.callsOver2,
          totalDuration: entry.totalDuration,
          avgDuration: entry.totalCalls > 0 ? entry.totalDuration / entry.totalCalls : 0,
          uniqueCallers: entry.uniqueCallers.size,
          firstCallTime: entry.firstCallTime,
          lastCallTime: entry.lastCallTime,
          syncedAt: new Date(),
          canonicalKey: entry.canonicalKey,
          sourceCanonicalId: entry.sourceCanonicalId || null,
          raw: entry.raw,
        },
      },
      upsert: true,
    },
  }));

  const result = operations.length
    ? await DailyCallStat.bulkWrite(operations, { ordered: false })
    : { upsertedCount: 0, modifiedCount: 0 };

  return {
    operations,
    result,
  };
}

async function backfillSpendEntries(domain, from, to, sourceMaps) {
  const normalizedDomain = normalizeDomain(domain);
  const mirrorDb = getMirrorDb();
  const rows = await mirrorDb.collection("legacy_dailyspends").find({
    domain: normalizedDomain,
    ...buildDateRangeMatch(from, to),
  }).toArray();

  if (!rows.length) return { imported: 0 };

  const operations = rows.map((row) => {
    const next = {
      date: String(row.date),
      domain: normalizedDomain,
      channel: row.channel || "unknown",
      source: row.source || "Unknown",
      sheetId: row.sheetId || null,
      sourceCanonicalId: resolveSourceCanonicalId(row, sourceMaps),
      spend: Number(row.spend || 0),
      postage: Number(row.postage || 0),
      cost: Number(row.cost || 0),
      pieces: Number(row.pieces || 0),
      impressions: Number(row.impressions || 0),
      clicks: Number(row.clicks || 0),
      leadsReported: Number(row.leadsReported || 0),
      jobNumber: row.jobNumber || null,
      jobName: row.jobName || null,
      phone: row.phone || null,
      form: row.form || null,
      stream: row.stream || null,
      reach: Number(row.reach || 0),
      allClicks: Number(row.allClicks || 0),
      resultType: row.resultType || null,
      landingPageViews: Number(row.landingPageViews || 0),
      campaign: row.campaign || null,
      platform: row.platform || null,
      adSet: row.adSet || null,
      adName: row.adName || null,
      leadsAccepted: Number(row.leadsAccepted || 0),
      costPerLead: Number(row.costPerLead || 0),
      metaCampaignId: row.metaCampaignId || null,
      metaAdsetId: row.metaAdsetId || null,
      metaAdId: row.metaAdId || null,
      broadcastId: row.broadcastId || null,
      broadcastName: row.broadcastName || null,
      syncedAt: new Date(),
      raw: row.raw || row,
    };

    const filter = {
      date: next.date,
      domain: next.domain,
      channel: next.channel,
      sheetId: next.sheetId,
    };

    if (next.broadcastId) filter.broadcastId = next.broadcastId;
    else if (next.jobNumber) filter.jobNumber = next.jobNumber;
    else if (next.campaign) filter.campaign = next.campaign;
    else if (next.adName) filter.adName = next.adName;
    else filter.source = next.source;

    return {
      updateOne: {
        filter,
        update: { $set: next },
        upsert: true,
      },
    };
  });

  const result = await SpendEntry.bulkWrite(operations, { ordered: false });
  return {
    imported: rows.length,
    upserted: Number(result.upsertedCount || 0),
    modified: Number(result.modifiedCount || 0),
  };
}

async function backfillDailyCallStats(domain, from, to, sourceMaps, options = {}) {
  const normalizedDomain = normalizeDomain(domain || "TAG");
  const callFireClient = createCallFireClient();
  const callFireBroadcasts = await callFireClient.listBroadcastsWithStatsForRange({
    from,
    to,
    maxPages: 25,
  });
  const preferCallLedger =
    options.preferCallLedger === true ||
    String(process.env.CALL_LEDGER_DAILY_STATS_ENABLED || "").trim().toLowerCase() === "true";
  const preferLegacyContactActivities = options.preferLegacyContactActivities === true;
  let triedControlPlaneCallLogs = false;
  const tryControlPlaneCallLogs = async () => {
    triedControlPlaneCallLogs = true;
    return buildDailyCallStatsFromCallLogs(
      normalizedDomain,
      from,
      to,
      sourceMaps,
      callFireBroadcasts,
    );
  };

  if (preferCallLedger) {
    const ledgerRows = await CallLedger.find({
      domain: normalizedDomain,
      ...buildDateRangeMatch(from, to),
    }).lean();

    if (ledgerRows.length > 0 || callFireBroadcasts.length > 0) {
      const grouped = new Map();

      for (const row of ledgerRows) {
        mergeCallStatEntry(grouped, {
          date: String(row.date),
          piece: row.sourceName || "Unknown",
          tollFree: null,
          trackingNumber: null,
          channel: row.sourceChannel || "unknown",
          totalCalls: 1,
          callsOver5: Number(row.durationSec || 0) >= 300 ? 1 : 0,
          callsOver2: Number(row.durationSec || 0) >= 120 ? 1 : 0,
          totalDuration: Number(row.durationSec || 0),
          uniqueCallers: row.normalizedPhone
            ? new Set([String(row.normalizedPhone)])
            : row.phone
              ? new Set([String(row.phone)])
              : new Set(),
          firstCallTime: row.callStartTime || row.createdAt || null,
          lastCallTime: row.callStartTime || row.createdAt || null,
          canonicalKey: row.mailPieceKey || null,
          sourceCanonicalId: row.sourceCanonicalId || null,
          raw: {
            provider: "call-ledger",
            telephonySessionId: row.telephonySessionId || null,
            caseId: Number.isFinite(Number(row.caseId)) ? Number(row.caseId) : null,
            scoreOverall: Number.isFinite(Number(row.scoreOverall))
              ? Number(row.scoreOverall)
              : null,
            scoreVerdict: row.scoreVerdict || null,
          },
        });
      }

      await addCallFireBroadcasts(grouped, callFireBroadcasts, sourceMaps);
      const { operations, result } = await writeGroupedCallStats(grouped);

      return {
        imported: operations.length,
        upserted: Number(result.upsertedCount || 0),
        modified: Number(result.modifiedCount || 0),
        source:
          ledgerRows.length > 0 && callFireBroadcasts.length > 0
            ? "call-ledger+callfire"
            : ledgerRows.length > 0
              ? "call-ledger"
              : "callfire",
      };
    }
  }

  if (!preferLegacyContactActivities) {
    const callLogResult = await tryControlPlaneCallLogs();
    if (callLogResult) return callLogResult;
  }

  if (preferLegacyContactActivities) {
    const legacyRows = await summarizeLegacyContactActivitiesBySource({
      domain: normalizedDomain,
      direction: "inbound",
      from: `${String(from)}T00:00:00.000Z`,
      to: `${String(to)}T23:59:59.999Z`,
    });

    if (legacyRows.length > 0 || callFireBroadcasts.length > 0) {
      const grouped = new Map();

      for (const row of legacyRows) {
        const canonical = await resolveCanonicalSource({
          domain: normalizedDomain,
          sourceId: row.sourceId != null ? Number(row.sourceId) : null,
          sourceName: row.sourceName,
          rawName: row.sourceName,
        });
        const piece = canonical?.internalName || row.sourceName || "Unknown";
        const channel =
          canonical?.channel ||
          mapCanonicalChannel({ channel: row.sourceChannel }, piece);

        mergeCallStatEntry(grouped, {
          date: String(row.date),
          piece,
          tollFree: null,
          trackingNumber: null,
          channel,
          totalCalls: Number(row.totalCalls || 0),
          callsOver5: Number(row.callsOver5 || 0),
          callsOver2: Number(row.callsOver2 || 0),
          totalDuration: Number(row.totalDuration || 0),
          uniqueCallers: Number(row.uniqueCallers || 0),
          firstCallTime: row.firstCallTime || null,
          lastCallTime: row.lastCallTime || null,
          canonicalKey: canonical?.canonicalKey || null,
          sourceCanonicalId:
            canonical?.doc?._id ||
            resolveSourceCanonicalId({ source: piece }, sourceMaps),
          raw: {
            provider: "legacy-contactactivities",
            sourceId: row.sourceId != null ? row.sourceId : null,
            sampleCaseIds: Array.isArray(row.caseIds) ? row.caseIds.slice(0, 25) : [],
            sampleRecordIds: Array.isArray(row.sampleRecordIds) ? row.sampleRecordIds : [],
          },
        });
      }

      await addCallFireBroadcasts(grouped, callFireBroadcasts, sourceMaps);
      const { operations, result } = await writeGroupedCallStats(grouped);

      return {
        imported: operations.length,
        upserted: Number(result.upsertedCount || 0),
        modified: Number(result.modifiedCount || 0),
        source:
          legacyRows.length > 0 && callFireBroadcasts.length > 0
            ? "legacy-contactactivities+callfire"
            : legacyRows.length > 0
              ? "legacy-contactactivities"
              : "callfire",
      };
    }
  }

  if (!triedControlPlaneCallLogs) {
    const callLogResult = await tryControlPlaneCallLogs();
    if (callLogResult) return callLogResult;
  }

  const client = createCallrailClient("TAG");
  const payload = await client.listInboundCallsForRange({
    startDate: from,
    endDate: to,
    perPage: 250,
    maxPages: 100,
  });
  const calls = Array.isArray(payload?.calls) ? payload.calls : [];

  if (calls.length > 0 || callFireBroadcasts.length > 0) {
    const grouped = new Map();

    for (const call of calls) {
      const date = buildPacificDateKey(call.start_time);
      if (!date) continue;
      const inferred = inferCallrailSourceByName(call.source_name || call.source);

      const canonical = await resolveCanonicalSource({
        domain: "TAG",
        sourceName: inferred?.piece || call.source_name || call.source,
        rawName: call.source_name || call.source,
        trackingNumber: call.tracking_phone_number || call.formatted_tracking_phone_number,
        phone: call.tracking_phone_number,
      });

      const piece = canonical?.internalName || inferred?.piece || call.source_name || call.source || "Unknown";
      const channel = inferred?.channel || mapCanonicalChannel(canonical, piece);
      const key = `${date}::${piece}`;
      const duration = Number(call.duration || 0);
      const caller = normalizeDigits(call.customer_phone_number);

      mergeCallStatEntry(grouped, {
        date,
        piece,
        tollFree: call.formatted_tracking_phone_number || call.tracking_phone_number || null,
        trackingNumber: call.tracking_phone_number || null,
        channel,
        totalCalls: 1,
        callsOver5: duration >= 300 ? 1 : 0,
        callsOver2: duration >= 120 ? 1 : 0,
        totalDuration: duration,
        uniqueCallers: caller ? new Set([caller]) : new Set(),
        firstCallTime: call.start_time,
        lastCallTime: call.start_time,
        canonicalKey: canonical?.canonicalKey || null,
        sourceCanonicalId: canonical?.doc?._id || resolveSourceCanonicalId({ source: piece }, sourceMaps),
      });
    }

    await addCallFireBroadcasts(grouped, callFireBroadcasts, sourceMaps);
    const { operations, result } = await writeGroupedCallStats(grouped);

    return {
      imported: operations.length,
      upserted: Number(result.upsertedCount || 0),
      modified: Number(result.modifiedCount || 0),
      source: calls.length > 0 ? "callrail-raw+callfire" : "callfire",
    };
  }

  const mirrorDb = getMirrorDb();
  const rows = await mirrorDb.collection("legacy_rb_dailycallstats").find(
    buildDateRangeMatch(from, to),
  ).toArray();

  if (!rows.length) return { imported: 0 };

  const operations = rows.map((row) => {
    const canonical = resolveSourceCanonicalId(row, sourceMaps);
    const piece = row.piece || row.internalName || "Unknown";
    return {
      updateOne: {
        filter: {
          date: String(row.date),
          piece: piece,
        },
        update: {
          $set: {
            date: String(row.date),
            piece,
            tollFree: row.tollFree || null,
            trackingNumber: row.trackingNumber || null,
            channel: row.channel || "mailer",
            totalCalls: Number(row.totalCalls || 0),
            callsOver5: Number(row.callsOver5 || 0),
            callsOver2: Number(row.callsOver2 || 0),
            totalDuration: Number(row.totalDuration || 0),
            avgDuration: Number(row.avgDuration || 0),
            uniqueCallers: Number(row.uniqueCallers || 0),
            firstCallTime: row.firstCallTime || null,
            lastCallTime: row.lastCallTime || null,
            syncedAt: new Date(),
            canonicalKey: row.canonicalKey || null,
            sourceCanonicalId: canonical,
          },
        },
        upsert: true,
      },
    };
  });

  const result = await DailyCallStat.bulkWrite(operations, { ordered: false });
  return {
    imported: rows.length,
    upserted: Number(result.upsertedCount || 0),
    modified: Number(result.modifiedCount || 0),
    source: "legacy-rb_dailycallstats",
  };
}

async function backfillPaymentLedger(domain, from, to, sourceMaps) {
  const normalizedDomain = normalizeDomain(domain);
  const mirrorDb = getMirrorDb();
  const rows = await mirrorDb.collection("legacy_dailypaymentsummaries").find({
    domain: normalizedDomain,
    ...buildDateRangeMatch(from, to),
  }).toArray();

  if (!rows.length) return { imported: 0 };

  const caseSourceMaps = await buildCaseSourceMaps(
    normalizedDomain,
    rows.map((row) => row.caseId),
    sourceMaps,
  );

  const operations = rows
    .filter((row) => Number.isFinite(Number(row.casePaymentId)))
    .map((row) => {
      const inferred = inferPaymentSourceFromCase(row.caseId, caseSourceMaps);
      const resolvedSourceCanonicalId =
        resolveSourceCanonicalId(row, sourceMaps) ||
        inferred?.sourceCanonicalId ||
        null;
      const raw = {
        ...row,
        sourceName: row.sourceName || inferred?.sourceName || null,
        sourceChannel: row.sourceChannel || inferred?.sourceChannel || null,
        sourceId: row.sourceId ?? inferred?.sourceId ?? null,
      };

      return {
        updateOne: {
          filter: { casePaymentId: Number(row.casePaymentId) },
          update: {
            $set: {
              domain: normalizedDomain,
              caseId: Number(row.caseId),
              casePaymentId: Number(row.casePaymentId),
              paymentDate: toDate(`${String(row.date)}T00:00:00.000Z`) || new Date(`${String(row.date)}T00:00:00.000Z`),
              paymentDateKey: String(row.date),
              amount: Number(row.amount || 0),
              paymentType: inferPaymentType(row.type),
              transactionStatus: row.transactionStatus || null,
              sourceCanonicalId: resolvedSourceCanonicalId,
              needsSourceReview: Boolean(row.needsSourceReview && !resolvedSourceCanonicalId),
              reviewReason:
                row.needsSourceReview && !resolvedSourceCanonicalId
                  ? "legacy-payment-needs-source-review"
                  : null,
              recordedAt: toDate(row.recordedAt) || new Date(),
              raw,
            },
          },
          upsert: true,
        },
      };
    });

  const result = await PaymentLedger.bulkWrite(operations, { ordered: false });
  return {
    imported: operations.length,
    upserted: Number(result.upsertedCount || 0),
    modified: Number(result.modifiedCount || 0),
  };
}

async function rebuildMetricSnapshots(domain, from, to) {
  const normalizedDomain = normalizeDomain(domain);
  const dates = buildDateKeys(from, to);
  const excludePieces = await sourceCanonicalRepository
    .listPiecesAssignedToOtherDomains(normalizedDomain)
    .catch(() => []);
  let rebuilt = 0;

  for (const date of dates) {
    const dailyCallMatch = { date };
    if (excludePieces.length > 0) {
      dailyCallMatch.piece = { $nin: excludePieces };
    }
    const [spendAgg, paymentAgg, callAgg, mailLeadAgg] = await Promise.all([
      SpendEntry.aggregate([
        { $match: { domain: normalizedDomain, date } },
        {
          $group: {
            _id: null,
            spend: { $sum: "$spend" },
            leadsReported: { $sum: "$leadsReported" },
          },
        },
      ]),
      PaymentLedger.aggregate([
        { $match: { domain: normalizedDomain, paymentDateKey: date } },
        {
          $group: {
            _id: null,
            revenue: { $sum: "$amount" },
          },
        },
      ]),
      DailyCallStat.aggregate([
        { $match: dailyCallMatch },
        {
          $group: {
            _id: null,
            calls: { $sum: "$totalCalls" },
          },
        },
      ]),
      DailyCallStat.aggregate([
        {
          $match: {
            ...dailyCallMatch,
            channel: { $in: ["mail", "mailer"] },
          },
        },
        {
          $group: {
            _id: null,
            leads: { $sum: { $ifNull: ["$uniqueCallers", 0] } },
          },
        },
      ]),
    ]);

    const spend = Number(spendAgg[0]?.spend || 0);
    const revenue = Number(paymentAgg[0]?.revenue || 0);
    const calls = Number(callAgg[0]?.calls || 0);
    const leads =
      Number(spendAgg[0]?.leadsReported || 0) +
      Number(mailLeadAgg[0]?.leads || 0) +
      Number(getManualLeadOverlayTotal(normalizedDomain, date) || 0);

    await MetricsSnapshot.findOneAndUpdate(
      {
        domain: normalizedDomain,
        bucketType: "daily",
        bucketKey: date,
      },
      {
        $set: {
          domain: normalizedDomain,
          bucketType: "daily",
          bucketKey: date,
          bucketDate: new Date(`${date}T00:00:00.000Z`),
          counters: {
            leads,
            calls,
            spend,
            revenue,
          },
          sourceCounters: {},
          recentEvents: [],
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    rebuilt += 1;
  }

  const manualLifetimeLeads = dates.reduce(
    (sum, date) => sum + Number(getManualLeadOverlayTotal(normalizedDomain, date) || 0),
    0,
  );
  const lifetimeCallMatch = {};
  if (excludePieces.length > 0) {
    lifetimeCallMatch.piece = { $nin: excludePieces };
  }
  const [lifetimeSpendAgg, lifetimePaymentAgg, lifetimeCallAgg, lifetimeMailLeadAgg] = await Promise.all([
    SpendEntry.aggregate([
      { $match: { domain: normalizedDomain } },
      {
        $group: {
          _id: null,
          spend: { $sum: "$spend" },
          leadsReported: { $sum: "$leadsReported" },
        },
      },
    ]),
    PaymentLedger.aggregate([
      { $match: { domain: normalizedDomain } },
      { $group: { _id: null, revenue: { $sum: "$amount" } } },
    ]),
    DailyCallStat.aggregate([
      { $match: lifetimeCallMatch },
      { $group: { _id: null, calls: { $sum: "$totalCalls" } } },
    ]),
    DailyCallStat.aggregate([
      {
        $match: {
          ...lifetimeCallMatch,
          channel: { $in: ["mail", "mailer"] },
        },
      },
      {
        $group: {
          _id: null,
          leads: { $sum: { $ifNull: ["$uniqueCallers", 0] } },
        },
      },
    ]),
  ]);

  await MetricsSnapshot.findOneAndUpdate(
    {
      domain: normalizedDomain,
      bucketType: "lifetime",
      bucketKey: "all-time",
    },
    {
      $set: {
        domain: normalizedDomain,
        bucketType: "lifetime",
        bucketKey: "all-time",
        bucketDate: null,
        counters: {
          leads:
            Number(lifetimeSpendAgg[0]?.leadsReported || 0) +
            Number(lifetimeMailLeadAgg[0]?.leads || 0) +
            manualLifetimeLeads,
          calls: Number(lifetimeCallAgg[0]?.calls || 0),
          spend: Number(lifetimeSpendAgg[0]?.spend || 0),
          revenue: Number(lifetimePaymentAgg[0]?.revenue || 0),
        },
        sourceCounters: {},
        recentEvents: [],
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  return { rebuilt };
}

async function syncDailyCallStatsForDate({
  domain = "TAG",
  date = null,
  preferLegacyContactActivities = false,
  preferCallLedger = false,
} = {}) {
  const normalizedDomain = normalizeDomain(domain);
  const dateKey = String(date || todayPacificKey()).trim();
  if (!dateKey) {
    throw new Error("date is required");
  }

  const sourceMaps = await buildSourceCanonicalMaps();
  const calls = await backfillDailyCallStats(
    normalizedDomain,
    dateKey,
    dateKey,
    sourceMaps,
    { preferLegacyContactActivities, preferCallLedger },
  );

  return {
    domain: normalizedDomain,
    date: dateKey,
    ...calls,
  };
}

async function refreshMetricsSnapshotsForDate({
  domain = "TAG",
  date = null,
} = {}) {
  const normalizedDomain = normalizeDomain(domain);
  const dateKey = String(date || todayPacificKey()).trim();
  if (!dateKey) {
    throw new Error("date is required");
  }

  const snapshots = await rebuildMetricSnapshots(normalizedDomain, dateKey, dateKey);
  return {
    domain: normalizedDomain,
    date: dateKey,
    ...snapshots,
  };
}

async function syncHourlyMetricsForDomain({
  domain = "TAG",
  date = null,
  preferLegacyContactActivities = false,
  preferCallLedger = false,
} = {}) {
  const normalizedDomain = normalizeDomain(domain);
  const dateKey = String(date || todayPacificKey()).trim();
  if (!dateKey) {
    throw new Error("date is required");
  }

  const calls = await syncDailyCallStatsForDate({
    domain: normalizedDomain,
    date: dateKey,
    preferLegacyContactActivities,
    preferCallLedger,
  });
  const snapshots = await refreshMetricsSnapshotsForDate({
    domain: normalizedDomain,
    date: dateKey,
  });

  return {
    domain: normalizedDomain,
    date: dateKey,
    calls,
    snapshots,
  };
}

async function backfillLegacyMetricsRange({ domain = "TAG", from, to }) {
  const normalizedDomain = normalizeDomain(domain);
  if (!from || !to) {
    throw new Error("from and to are required");
  }

  const sourceMaps = await buildSourceCanonicalMaps();

  const [spend, calls, payments] = await Promise.all([
    backfillSpendEntries(normalizedDomain, from, to, sourceMaps),
    backfillDailyCallStats(normalizedDomain, from, to, sourceMaps, {
      preferLegacyContactActivities: true,
    }),
    backfillPaymentLedger(normalizedDomain, from, to, sourceMaps),
  ]);

  const snapshots = await rebuildMetricSnapshots(normalizedDomain, from, to);

  return {
    domain: normalizedDomain,
    from,
    to,
    spend,
    calls,
    payments,
    snapshots,
    completedAt: new Date().toISOString(),
  };
}

module.exports = {
  backfillLegacyMetricsRange,
  refreshMetricsSnapshotsForDate,
  syncDailyCallStatsForDate,
  syncHourlyMetricsForDomain,
};
